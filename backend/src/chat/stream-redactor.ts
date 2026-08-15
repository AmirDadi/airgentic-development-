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

  const BEGIN = "-----BEGIN";
  const endMarker = /-----END [^\n]*KEY-----/;

  /** Longest suffix of `raw` that is a prefix of the PEM BEGIN marker. */
  function danglingBeginPrefix(): number {
    for (let k = Math.min(raw.length, BEGIN.length); k > 0; k--) {
      if (raw.slice(raw.length - k) === BEGIN.slice(0, k)) return k;
    }
    return 0;
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

    // The one secret with internal whitespace is a PEM private key: its very
    // marker ("-----BEGIN RSA PRIVATE KEY-----") contains spaces, so the
    // whitespace boundary alone would commit the start of a key before it is
    // recognizable — and redaction, needing both markers, would then let the
    // body through. Hold the whole block until its END marker is complete.
    const begin = raw.indexOf(BEGIN);
    if (begin !== -1) {
      const closed = endMarker.test(raw.slice(begin));
      if (!closed || begin < boundary) {
        // Not yet closed, or closed but the block starts before the boundary:
        // in both cases only commit past it once the full block is redactable.
        const end = endMarker.exec(raw.slice(begin));
        const blockEnd = end ? begin + end.index + end[0].length : raw.length;
        if (begin < boundary && blockEnd > boundary) boundary = begin;
        if (!closed) boundary = Math.min(boundary, begin);
      }
    } else {
      // No full BEGIN yet, but a trailing run could be one forming — hold it.
      boundary = Math.min(boundary, raw.length - danglingBeginPrefix());
    }
    return boundary;
  }

  return {
    push(chunk: string): string {
      raw += chunk;
      const committed = redact(raw.slice(0, committedBoundary()));
      // committed is a stable prefix of the eventual full redaction, so we
      // only ever append the part we have not sent yet.
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
