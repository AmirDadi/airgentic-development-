import { redact } from "../redact.js";

/**
 * Streaming-safe redaction for the live chat channel.
 *
 * The delta frames are broadcast to browsers token by token, before the reply
 * is complete — so redacting each fragment on its own is useless: a secret
 * split across two deltas (`sk-` then `ant-…`) would slip through, and the raw
 * value would reach the DOM. That is exactly the R4 leak this closes.
 *
 * The rule: never emit a character that could still turn out to be part of a
 * secret. A secret is a single non-whitespace token, so anything before the
 * last newline in the accumulated text is safe to commit once redacted — with
 * one exception. A PEM private-key block spans newlines, so an unterminated
 * `-----BEGIN … PRIVATE KEY-----` holds back everything from that marker until
 * its `-----END` arrives (or the turn ends).
 *
 * `push` returns only the newly-committed, redacted text to APPEND; `flush`
 * redacts and returns whatever was held back. The concatenation of every
 * `push` plus the final `flush` is byte-identical to a single `redact()` of
 * the whole reply — proven by the contract test.
 */
export function createStreamRedactor(): {
  push(chunk: string): string;
  flush(): string;
} {
  let raw = ""; // everything seen so far
  let emittedLen = 0; // length of redacted output already returned

  const BEGIN_LITERAL = "-----BEGIN";
  // Mirror redact.ts EXACTLY so the streamer pairs markers the same way redact
  // does: any looseness here could commit text redact would later collapse.
  const beginMarker = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g;
  const endMarker = /-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

  /** Longest suffix of `raw` that is a prefix of the PEM BEGIN marker. */
  function danglingBeginPrefix(): number {
    for (let k = Math.min(raw.length, BEGIN_LITERAL.length); k > 0; k--) {
      if (raw.slice(raw.length - k) === BEGIN_LITERAL.slice(0, k)) return k;
    }
    return 0;
  }

  /**
   * Start index of the first `-----BEGIN` that is NOT part of a PEM block fully
   * closed at or before `limit`, or -1 if none.
   *
   * Two subtleties, each of which leaked a key in an earlier version:
   *  - The literal `-----BEGIN` is matched, not the full marker regex, so a
   *    still-forming marker line (`-----BEGIN RSA PRIVATE`) is held rather than
   *    committed word by word before it is recognizable.
   *  - Blocks pair as redact()'s non-greedy global regex pairs them — each
   *    BEGIN with the NEXT END, resuming after it — so a decoy `-----BEGIN`
   *    with no key still swallows a later END, and the real key body between
   *    them is held until that END arrives.
   * Over-holding (a stray `-----BEGIN` in prose that never forms a key) only
   * delays streaming until flush; it never leaks. Under-holding leaks.
   */
  function unclosedBlockStart(limit: number): number {
    let i = 0;
    while (i < limit) {
      const p = raw.indexOf(BEGIN_LITERAL, i);
      if (p === -1 || p >= limit) return -1;

      beginMarker.lastIndex = p;
      const b = beginMarker.exec(raw);
      if (b !== null && b.index === p) {
        endMarker.lastIndex = p + b[0].length;
        const e = endMarker.exec(raw);
        if (e !== null && e.index + e[0].length <= limit) {
          i = e.index + e[0].length; // block closed within limit; scan onward
          continue;
        }
      }
      // Marker still forming, or its END not yet committed: hold from here.
      return p;
    }
    return -1;
  }

  /** Index up to which no in-progress secret can exist. */
  function committedBoundary(): number {
    // Commit up to the last whitespace: every single-line secret shape is one
    // whitespace-free token (sk-…, ghp_…, AKIA…, a JWT, a Bearer token value),
    // so a trailing partial token is held until whitespace completes it. This
    // streams word by word, unlike a line-only boundary which would make a
    // short single-line reply appear only at the very end.
    const lastWs = Math.max(
      raw.lastIndexOf(" "),
      raw.lastIndexOf("\n"),
      raw.lastIndexOf("\t"),
      raw.lastIndexOf("\r"),
    );
    let boundary = lastWs === -1 ? 0 : lastWs + 1;

    // Hold from the first PEM block that isn't fully closed before the
    // boundary: a private key spans newlines and its markers carry spaces, so
    // the whitespace boundary alone would commit key material redact can only
    // collapse once BOTH markers are present.
    const open = unclosedBlockStart(boundary);
    if (open !== -1) boundary = Math.min(boundary, open);

    // A trailing run that is only a *prefix* of "-----BEGIN" (still forming).
    const dangling = danglingBeginPrefix();
    if (dangling > 0) boundary = Math.min(boundary, raw.length - dangling);

    return boundary;
  }

  return {
    push(chunk: string): string {
      raw += chunk;
      const committed = redact(raw.slice(0, committedBoundary()));
      // committed is a stable prefix of the eventual full redaction. If it ever
      // shrank (it must not, given the hold-back above) we emit nothing rather
      // than a rewound slice — a raw byte already sent can never be unsent, so
      // never bet on being able to repair one.
      if (committed.length <= emittedLen) return "";
      const next = committed.slice(emittedLen);
      emittedLen = committed.length;
      return next;
    },
    flush(): string {
      const full = redact(raw);
      const rest = full.slice(emittedLen);
      emittedLen = full.length;
      return rest;
    },
  };
}
