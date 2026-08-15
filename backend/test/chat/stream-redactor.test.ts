import { describe, it, expect } from "vitest";
import { createStreamRedactor } from "../../src/chat/stream-redactor.js";
import { redact } from "../../src/redact.js";

// A fake secret whose recognizable form only completes after several chars.
const KEY = "sk-ant-api03-FAKEfake0000FAKEfake1111FAKEfake2222AA";

/** Feed a whole string one character at a time; return everything emitted. */
function drip(text: string): string {
  const r = createStreamRedactor();
  let out = "";
  for (const ch of text) out += r.push(ch);
  out += r.flush();
  return out;
}

describe("createStreamRedactor", () => {
  it("passes ordinary prose through unchanged, whatever the chunking", () => {
    const text = "the build is green, shipping now\nall tests pass\n";
    expect(drip(text)).toBe(text);
  });

  it("never emits a secret that is split across delta boundaries", () => {
    // The whole point: the key arrives one char at a time, so no single
    // push() ever contains it — a naive per-delta redact would miss it.
    const streamed = drip(`token ${KEY} end\n`);
    expect(streamed).not.toContain(KEY);
    expect(streamed).toContain("[REDACTED:anthropic-key]");
  });

  it("holds back an in-progress final line until the turn ends, then redacts it", () => {
    const r = createStreamRedactor();
    // A secret with no trailing whitespace: nothing may be emitted mid-secret.
    let emitted = "";
    for (const ch of `leaking ${KEY}`) emitted += r.push(ch);
    expect(emitted).not.toContain(KEY);
    // flush() completes the line and redacts it.
    const finalOut = emitted + r.flush();
    expect(finalOut).not.toContain(KEY);
    expect(finalOut).toContain("[REDACTED:anthropic-key]");
  });

  it("holds back a whole PEM block (which spans newlines) until END arrives", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\n" +
      "MIIFAKEfakeNOTAREALKEYBODY0000000000000000\n" +
      "AAAAsecondline1111111111111111111111111111\n" +
      "-----END RSA PRIVATE KEY-----";
    const r = createStreamRedactor();
    let emitted = "";
    // Feed everything up to just before END, line by line.
    const upToEnd = pem.slice(0, pem.lastIndexOf("-----END"));
    for (const ch of upToEnd) emitted += r.push(ch);
    // The key body must NOT have leaked even though its lines are "complete".
    expect(emitted).not.toContain("MIIFAKEfakeNOTAREALKEYBODY");
    expect(emitted).not.toContain("AAAAsecondline");
    // Now the END marker + flush.
    let rest = "";
    for (const ch of pem.slice(pem.lastIndexOf("-----END"))) rest += r.push(ch);
    const full = emitted + rest + r.flush();
    expect(full).not.toContain("MIIFAKEfakeNOTAREALKEYBODY");
    expect(full).toContain("[REDACTED:private-key-block]");
  });

  it("holds back the SECOND of two back-to-back PEM blocks", () => {
    // Regression: the guard tracked the FIRST BEGIN marker, so once it closed,
    // a second block's body streamed raw before its own END arrived.
    const two =
      "-----BEGIN EC PRIVATE KEY-----\nAAAAbodyone1111\n-----END EC PRIVATE KEY-----\n" +
      "-----BEGIN RSA PRIVATE KEY-----\nBBBBbodytwo2222\n-----END RSA PRIVATE KEY-----";
    const r = createStreamRedactor();
    let streamed = "";
    for (const ch of two) streamed += r.push(ch);
    expect(streamed).not.toContain("BBBBbodytwo2222");
    expect(streamed).not.toContain("AAAAbodyone1111");
    const full = streamed + r.flush();
    expect(full).toBe(redact(two));
    expect(full.match(/\[REDACTED:private-key-block\]/g)).toHaveLength(2);
  });

  it("does not leak a key body between a decoy BEGIN and a later real END", () => {
    // The hard case: an earlier `-----BEGIN` with no key of its own. redact()'s
    // non-greedy pairing collapses everything from that decoy to the NEXT END,
    // so the real key body in between must be held until that END arrives —
    // tracking only the most recent BEGIN missed the decoy and streamed it raw.
    const body =
      "MIIEvQIBADANBgkqhkiFAKEBODY0000111122223333444455556666777788889999";
    const text =
      "-----BEGIN RSA PRIVATE KEY----- decoy, no key here\n" +
      body +
      "\nunrelated chatter that keeps going so a naive streamer commits it\n" +
      "-----BEGIN RSA PRIVATE KEY-----\nAAAAsecond1111\n" +
      "-----END RSA PRIVATE KEY-----\nthe end\n";

    for (const size of [1, 3, 17]) {
      const r = createStreamRedactor();
      let streamed = "";
      for (let i = 0; i < text.length; i += size) {
        streamed += r.push(text.slice(i, i + size));
      }
      expect(streamed, `size ${size}`).not.toContain(body);
      expect(streamed + r.flush(), `size ${size}`).toBe(redact(text));
    }
  });

  it("emits committed prose incrementally rather than only at the end", () => {
    const r = createStreamRedactor();
    // A completed line should be available before the turn ends.
    let out = "";
    for (const ch of "first line done\n") out += r.push(ch);
    expect(out).toContain("first line done");
  });

  it("the concatenation of all output equals a single redact() of the whole text", () => {
    for (const text of [
      "plain text no secrets at all",
      `a ${KEY} b`,
      `${KEY}\nsecond ghp_FAKEfake0123456789ABCDefghij0123AB line\n`,
      "trailing secret with no newline sk-FAKEfake0123456789ABCDEF",
      "",
    ]) {
      expect(drip(text)).toBe(redact(text));
    }
  });

  it("is safe when fed in arbitrary chunk sizes, not just per-char", () => {
    const text = `x ${KEY} y ghp_FAKEfake0123456789ABCDefghij0123AB z`;
    for (const size of [1, 2, 3, 7, 13, 100]) {
      const r = createStreamRedactor();
      let out = "";
      for (let i = 0; i < text.length; i += size) {
        out += r.push(text.slice(i, i + size));
      }
      out += r.flush();
      expect(out, `chunk size ${size}`).toBe(redact(text));
      expect(out).not.toContain(KEY);
    }
  });
});
