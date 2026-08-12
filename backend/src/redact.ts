/**
 * Secret redaction for agent transcript text (PRD risk R4).
 *
 * This runs on every message body *before* it is written to SQLite: a secret
 * that never lands in the DB cannot leak from it. Consequently the bias here
 * is deliberate — a false positive (over-redacted prose) is cheap, a false
 * negative (a leaked credential) is not.
 *
 * Design constraints:
 *   - Pure. No I/O, no dependencies, no module state, never throws.
 *   - ReDoS-safe. Every pattern below is a flat sequence of bounded or
 *     single-level character-class quantifiers — no nested quantifiers, no
 *     alternation inside a repetition. Matching is linear in input length.
 *   - Idempotent. The replacement marker is inert: no rule can match a
 *     `[REDACTED:...]` marker, and the loose rules (assignments, bearer
 *     headers) carry an explicit negative lookahead for it.
 */

/** The inert marker written in place of a secret. */
const MARKER_PREFIX = "[REDACTED:";

function marker(name: string): string {
  return `${MARKER_PREFIX}${name}]`;
}

/**
 * A rule is a global regex plus the replacement it produces. `replace` is
 * given the standard `String.replace` arguments so rules can preserve the
 * non-secret parts of a match (an assignment's key, a header's `Bearer `).
 */
interface Rule {
  readonly name: string;
  readonly re: RegExp;
  readonly replace: (...args: string[]) => string;
}

/** Guard that stops a loose rule from matching an already-emitted marker. */
const NOT_MARKER = String.raw`(?!\[REDACTED:)`;

/**
 * Order matters: the most specific shapes run first so that their hits are
 * reported under their own name rather than being swallowed by the generic
 * assignment rule that runs last.
 */
const RULES: readonly Rule[] = [
  // Whole PEM private key blocks, header through footer.
  {
    name: "private-key-block",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: () => marker("private-key-block"),
  },

  // Anthropic-style keys. Runs before the generic `sk-` rule.
  {
    name: "anthropic-key",
    re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
    replace: () => marker("anthropic-key"),
  },

  // OpenAI-style: `sk-` followed by 20+ base62 characters.
  {
    name: "openai-key",
    re: /\bsk-[A-Za-z0-9]{20,}\b/g,
    replace: () => marker("openai-key"),
  },

  // GitHub personal/OAuth/user/server/refresh tokens and fine-grained PATs.
  {
    name: "github-token",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,})\b/g,
    replace: () => marker("github-token"),
  },

  // AWS access key IDs.
  {
    name: "aws-access-key-id",
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: () => marker("aws-access-key-id"),
  },

  // AWS secret access key assignments (env-var or JSON style).
  {
    name: "aws-secret-access-key",
    re: new RegExp(
      String.raw`\b(aws[_-]?secret[_-]?access[_-]?key)(["']?\s*[:=]\s*)(["']?)` +
        NOT_MARKER +
        String.raw`([^\s"',;]{8,})\3`,
      "gi",
    ),
    replace: (_m, key, sep, quote) =>
      `${key}${sep}${quote}${marker("aws-secret-access-key")}${quote}`,
  },

  // Slack bot/app/user/refresh/legacy tokens.
  {
    name: "slack-token",
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    replace: () => marker("slack-token"),
  },

  // Google API keys.
  {
    name: "google-api-key",
    re: /\bAIza[A-Za-z0-9_-]{35,}/g,
    replace: () => marker("google-api-key"),
  },

  // JWTs. Two rules under one name: the `eyJ`-anchored form (a JWT header is
  // always JSON starting `{"`, so it always base64url-encodes to `eyJ`), plus
  // a length-gated three-segment form for non-standard headers. The lookbehind
  // on the second keeps matching linear by refusing to restart mid-segment.
  {
    name: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
    replace: () => marker("jwt"),
  },
  {
    name: "jwt",
    re: /(?<![A-Za-z0-9_.-])[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_.-])/g,
    replace: () => marker("jwt"),
  },

  // `Authorization: Bearer <token>` — and bare `Bearer <token>`, which is how
  // transcripts usually quote them. The 16-char floor keeps English prose
  // ("Bearer of bad news") out.
  {
    name: "bearer-token",
    // Case-insensitive: curl -H, Go and Python HTTP clients all emit a
    // lowercase `bearer`, and a case-sensitive rule leaked those tokens
    // verbatim into storage. The 16-char floor still keeps prose out.
    re: new RegExp(
      String.raw`\b(Bearer\s+)` + NOT_MARKER + String.raw`[A-Za-z0-9._~+/=-]{16,}`,
      "gi",
    ),
    replace: (_m, prefix) => `${prefix}${marker("bearer-token")}`,
  },

  // Generic credential-ish assignments: `API_KEY=`, `SECRET=`, `TOKEN=`,
  // `PASSWORD=` (and embellished variants) in env-var or JSON style. The
  // 6-char value floor is what keeps prose like `token = the thing` intact.
  {
    name: "generic-assignment",
    re: new RegExp(
      String.raw`\b([A-Za-z0-9_]{0,32}(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE)[A-Za-z0-9_]{0,32})(["']?\s*[:=]\s*)(["']?)` +
        NOT_MARKER +
        String.raw`([^\s"',;]{6,})\3`,
      "gi",
    ),
    replace: (_m, key, sep, quote) =>
      `${key}${sep}${quote}${marker("generic-assignment")}${quote}`,
  },
];

/**
 * Replaces likely secrets with a stable marker. Pure, never throws.
 */
export function redact(text: string): string {
  return redactWithReport(text).text;
}

/**
 * Exposed for testing/telemetry: which patterns matched.
 *
 * `hits` holds each matching pattern's name at most once, in rule order.
 */
export function redactWithReport(text: string): {
  text: string;
  hits: string[];
} {
  if (typeof text !== "string" || text.length === 0) {
    return { text: typeof text === "string" ? text : "", hits: [] };
  }

  let out = text;
  const hits: string[] = [];

  try {
    for (const rule of RULES) {
      // Rule regexes are global and therefore stateful; reset defensively so a
      // prior throw can never leave a stale lastIndex behind.
      rule.re.lastIndex = 0;
      let matched = false;
      const next = out.replace(rule.re, (...args: unknown[]) => {
        matched = true;
        return rule.replace(...(args as string[]));
      });
      if (matched) {
        out = next;
        if (!hits.includes(rule.name)) hits.push(rule.name);
      }
    }
  } catch {
    // Unreachable for string input, but the contract is "never throws" and a
    // partially-redacted result is strictly safer than propagating.
    return { text: out, hits };
  }

  return { text: out, hits };
}
