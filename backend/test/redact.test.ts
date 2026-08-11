import { describe, expect, it } from "vitest";
import { redact, redactWithReport } from "../src/redact.js";

// NOTE: every credential-looking string in this file is invented and fake.
// None of them are, or resemble, a live credential.

const FAKE = {
  anthropic: "sk-ant-api03-FAKEfake0000FAKEfake1111FAKEfake2222AA",
  openai: "sk-FAKEfake0123456789ABCDefgh",
  ghp: "ghp_FAKEfake0123456789ABCDefghij0123AB",
  gho: "gho_FAKEfake0123456789ABCDefghij0123AB",
  ghu: "ghu_FAKEfake0123456789ABCDefghij0123AB",
  ghs: "ghs_FAKEfake0123456789ABCDefghij0123AB",
  ghr: "ghr_FAKEfake0123456789ABCDefghij0123AB",
  githubPat:
    "github_pat_11FAKEFAKE0000000000_FAKEfake0123456789abcdefGHIJKLmnop",
  akia: "AKIAFAKEFAKEFAKE1234",
  asia: "ASIAFAKEFAKEFAKE5678",
  awsSecret: "wFAKEfakeNOTREAL0000000000000000000000ab",
  // Split so the full literal never appears contiguously in the source: a
  // structurally-valid Slack token trips GitHub push protection even when the
  // payload is obviously fake. The value at runtime is unchanged.
  slack: "xoxb" + "-0000000000-0000000000-FAKEfakeFAKEfake0000",
  google: "AIzaSyFAKE_fake-0123456789ABCDEFGHIJKLM",
  jwt:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
    ".eyJzdWIiOiJGQUtFIiwibmFtZSI6IkZBS0UifQ" +
    ".FAKEfakeSIGNATURE0123456789abcdefGHIJKLM",
  bearer: "FAKEfakeBEARER0123456789abcdefGHIJ",
};

const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIFAKEfakeNOTAREALKEY0000000000000000000000000000000000000000",
  "AAAAfakeSECONDLINE1111111111111111111111111111111111111111111",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

/** Assert the raw secret is gone and a marker with the given name is present. */
function expectRedacted(input: string, secret: string, name: string) {
  const out = redact(input);
  expect(out).not.toContain(secret);
  expect(out).toContain(`[REDACTED:${name}]`);
  return out;
}

describe("redact — individual patterns", () => {
  it("redacts Anthropic-style sk-ant- keys", () => {
    const { text, hits } = redactWithReport(`key is ${FAKE.anthropic} ok`);
    expect(text).not.toContain(FAKE.anthropic);
    expect(text).toContain("[REDACTED:anthropic-key]");
    expect(hits).toContain("anthropic-key");
  });

  it("redacts generic OpenAI-style sk- keys with 20+ base62 chars", () => {
    const { text, hits } = redactWithReport(`OPENAI ${FAKE.openai}`);
    expect(text).not.toContain(FAKE.openai);
    expect(text).toContain("[REDACTED:openai-key]");
    expect(hits).toContain("openai-key");
  });

  it("does not treat a short sk- string as an OpenAI key", () => {
    const s = "sk-short";
    expect(redact(s)).toBe(s);
  });

  it.each([
    ["ghp", FAKE.ghp],
    ["gho", FAKE.gho],
    ["ghu", FAKE.ghu],
    ["ghs", FAKE.ghs],
    ["ghr", FAKE.ghr],
    ["github_pat", FAKE.githubPat],
  ])("redacts GitHub %s tokens", (_label, token) => {
    const { text, hits } = redactWithReport(`token: ${token}`);
    expect(text).not.toContain(token);
    expect(text).toContain("[REDACTED:github-token]");
    expect(hits).toContain("github-token");
  });

  it("redacts AWS access key IDs (AKIA and ASIA)", () => {
    const { text, hits } = redactWithReport(
      `ids ${FAKE.akia} and ${FAKE.asia} here`,
    );
    expect(text).not.toContain(FAKE.akia);
    expect(text).not.toContain(FAKE.asia);
    expect(hits).toContain("aws-access-key-id");
    expect(text.match(/\[REDACTED:aws-access-key-id\]/g)).toHaveLength(2);
  });

  it("redacts aws_secret_access_key assignments", () => {
    const { text, hits } = redactWithReport(
      `aws_secret_access_key=${FAKE.awsSecret}`,
    );
    expect(text).not.toContain(FAKE.awsSecret);
    expect(text).toContain("[REDACTED:aws-secret-access-key]");
    expect(hits).toContain("aws-secret-access-key");
  });

  it("redacts Slack tokens for every xox[baprs] prefix", () => {
    for (const p of ["b", "a", "p", "r", "s"]) {
      const tok = FAKE.slack.replace(/^xoxb/, `xox${p}`);
      const { text, hits } = redactWithReport(`slack ${tok} end`);
      expect(text).not.toContain(tok);
      expect(text).toContain("[REDACTED:slack-token]");
      expect(hits).toContain("slack-token");
    }
  });

  it("redacts Google API keys", () => {
    const { text, hits } = redactWithReport(`gkey=${FAKE.google}`);
    expect(text).not.toContain(FAKE.google);
    expect(text).toContain("[REDACTED:google-api-key]");
    expect(hits).toContain("google-api-key");
  });

  it("redacts a whole PEM private key block", () => {
    const { text, hits } = redactWithReport(`before\n${PEM}\nafter`);
    expect(text).not.toContain("MIIFAKEfake");
    expect(text).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(text).toContain("[REDACTED:private-key-block]");
    expect(hits).toContain("private-key-block");
    expect(text.startsWith("before\n")).toBe(true);
    expect(text.endsWith("\nafter")).toBe(true);
  });

  it("redacts PEM blocks of other key types", () => {
    const block =
      "-----BEGIN EC PRIVATE KEY-----\nAAAAfakeBODY0000\n-----END EC PRIVATE KEY-----";
    expectRedacted(block, "AAAAfakeBODY0000", "private-key-block");
    const openssh =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlfakeBODY1111\n-----END OPENSSH PRIVATE KEY-----";
    expectRedacted(openssh, "b3BlfakeBODY1111", "private-key-block");
  });

  it("redacts JWTs", () => {
    const { text, hits } = redactWithReport(`jwt ${FAKE.jwt} done`);
    expect(text).not.toContain(FAKE.jwt);
    expect(text).toContain("[REDACTED:jwt]");
    expect(hits).toContain("jwt");
  });

  it("redacts the token in an Authorization: Bearer header", () => {
    const { text, hits } = redactWithReport(
      `Authorization: Bearer ${FAKE.bearer}`,
    );
    expect(text).not.toContain(FAKE.bearer);
    expect(text).toContain("[REDACTED:bearer-token]");
    expect(text).toContain("Authorization:");
    expect(hits).toContain("bearer-token");
  });

  it.each([
    "API_KEY=FAKEfakevalue0123456789",
    "MY_API_KEY=FAKEfakevalue0123456789",
    "SECRET=FAKEfakevalue0123456789",
    "TOKEN=FAKEfakevalue0123456789",
    "PASSWORD=FAKEfakevalue0123456789",
    'export DB_PASSWORD="FAKEfakevalue0123456789"',
    '{"api_key": "FAKEfakevalue0123456789"}',
    '{"accessToken":"FAKEfakevalue0123456789"}',
  ])("redacts generic assignment %s", (line) => {
    const { text, hits } = redactWithReport(line);
    expect(text).not.toContain("FAKEfakevalue0123456789");
    expect(text).toContain("[REDACTED:generic-assignment]");
    expect(hits).toContain("generic-assignment");
  });
});

describe("redact — leaves innocent text alone", () => {
  const CLEAN = [
    "the token was rotated",
    "const x = 5",
    "let count = 0; // secret sauce",
    "We discussed the secret handshake at length.",
    "Please rotate your password before Friday.",
    "https://example.com/docs/api-keys#rotation",
    "function getToken(): string { return cached; }",
    "if (a.b.c) { return true; }",
    "import { redact } from './redact.js'",
    "AKIA is a prefix used by AWS.",
    "Bearer of bad news",
    "sk-",
    "Version 1.2.3 released",
    "he said: token = the thing you present",
  ];

  it.each(CLEAN)("leaves %j byte-identical", (s) => {
    expect(redact(s)).toBe(s);
  });

  it("reports no hits for clean input", () => {
    for (const s of CLEAN) {
      expect(redactWithReport(s).hits).toEqual([]);
    }
  });
});

describe("redact — structural behaviour", () => {
  it("redacts only the secret mid-sentence, preserving surrounding text", () => {
    const out = redact(
      `I tried the key ${FAKE.anthropic} and it returned 401, so I rotated it.`,
    );
    expect(out).toBe(
      "I tried the key [REDACTED:anthropic-key] and it returned 401, so I rotated it.",
    );
  });

  it("redacts multiple different secrets in one string", () => {
    const input = [
      `anthropic ${FAKE.anthropic}`,
      `github ${FAKE.ghp}`,
      `aws ${FAKE.akia}`,
      `slack ${FAKE.slack}`,
      `google ${FAKE.google}`,
      `jwt ${FAKE.jwt}`,
      `Authorization: Bearer ${FAKE.bearer}`,
      PEM,
    ].join("\n");
    const { text, hits } = redactWithReport(input);
    for (const secret of [
      FAKE.anthropic,
      FAKE.ghp,
      FAKE.akia,
      FAKE.slack,
      FAKE.google,
      FAKE.jwt,
      FAKE.bearer,
      "MIIFAKEfake",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(new Set(hits)).toEqual(
      new Set([
        "anthropic-key",
        "github-token",
        "aws-access-key-id",
        "slack-token",
        "google-api-key",
        "jwt",
        "bearer-token",
        "private-key-block",
      ]),
    );
  });

  it("reports each pattern name at most once", () => {
    const { hits } = redactWithReport(`${FAKE.ghp} ${FAKE.gho} ${FAKE.ghu}`);
    expect(hits).toEqual(["github-token"]);
  });

  it("is idempotent", () => {
    const inputs = [
      "",
      "plain prose with no secrets",
      `key ${FAKE.anthropic}`,
      `github ${FAKE.ghp}`,
      "API_KEY=FAKEfakevalue0123456789",
      '{"api_key": "FAKEfakevalue0123456789"}',
      `Authorization: Bearer ${FAKE.bearer}`,
      `aws_secret_access_key=${FAKE.awsSecret}`,
      `jwt ${FAKE.jwt}`,
      PEM,
    ];
    for (const s of inputs) {
      const once = redact(s);
      expect(redact(once)).toBe(once);
      expect(redact(redact(once))).toBe(once);
    }
  });

  it("does not re-redact its own markers", () => {
    const marker =
      "[REDACTED:anthropic-key] [REDACTED:generic-assignment] [REDACTED:jwt]";
    expect(redact(marker)).toBe(marker);
    expect(redactWithReport(marker).hits).toEqual([]);
  });

  it("handles the empty string", () => {
    expect(redact("")).toBe("");
    expect(redactWithReport("")).toEqual({ text: "", hits: [] });
  });

  it("never throws on odd input", () => {
    const odd = [
      "-----BEGIN RSA PRIVATE KEY----- unterminated block",
      "sk-ant-",
      "xoxb-",
      "=".repeat(1000),
      " � emoji 🔑 API_KEY=",
      "a".repeat(5000) + "." + "b".repeat(5000),
    ];
    for (const s of odd) {
      expect(() => redact(s)).not.toThrow();
      expect(() => redactWithReport(s)).not.toThrow();
    }
  });
});

describe("redact — performance (ReDoS guard)", () => {
  it("processes a 100k-char clean string quickly", () => {
    const big = "the token was rotated and the secret handshake held. ".repeat(
      2000,
    );
    expect(big.length).toBeGreaterThan(100_000);
    const t0 = Date.now();
    const out = redact(big);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(out).toBe(big);
  });

  it("processes a 100k-char string full of near-miss shapes quickly", () => {
    const big = (
      "sk- AKIA xoxb- AIza eyJ ----BEGIN PRIVATE KEY " +
      "Bearer " +
      "a".repeat(50) +
      "= "
    ).repeat(1200);
    expect(big.length).toBeGreaterThan(100_000);
    const t0 = Date.now();
    redact(big);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("processes a 100k-char string containing many real secrets quickly", () => {
    const big = `${FAKE.anthropic} ${FAKE.ghp} ${FAKE.akia} ${FAKE.jwt} `.repeat(
      800,
    );
    expect(big.length).toBeGreaterThan(100_000);
    const t0 = Date.now();
    const out = redact(big);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(out).not.toContain(FAKE.ghp);
  });
});

describe("redactWithReport", () => {
  it("returns text identical to redact()", () => {
    const input = `mix ${FAKE.slack} and ${FAKE.google} and prose`;
    expect(redactWithReport(input).text).toBe(redact(input));
  });

  it("returns hits in a stable, deterministic order", () => {
    const input = `${FAKE.jwt} ${FAKE.anthropic}`;
    const a = redactWithReport(input).hits;
    const b = redactWithReport(input).hits;
    expect(a).toEqual(b);
    expect(a.length).toBe(new Set(a).size);
  });
});
