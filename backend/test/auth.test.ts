import { describe, it, expect } from "vitest";
import {
  tokensMatch,
  createSessionStore,
  parseCookies,
  serializeCookie,
} from "../src/auth.js";

describe("tokensMatch", () => {
  it("accepts two identical tokens", () => {
    expect(tokensMatch("s3cret-token", "s3cret-token")).toBe(true);
  });

  it("rejects different tokens of the same length", () => {
    expect(tokensMatch("aaaaaaaa", "aaaaaaab")).toBe(false);
  });

  it("rejects tokens of different lengths without throwing", () => {
    // crypto.timingSafeEqual throws on a length mismatch, so the naive
    // implementation turns "guess the length" into a crash-vs-401 oracle.
    expect(() => tokensMatch("short", "a-much-longer-token")).not.toThrow();
    expect(tokensMatch("short", "a-much-longer-token")).toBe(false);
    expect(tokensMatch("a-much-longer-token", "short")).toBe(false);
    // A prefix must not pass: the comparison is over the whole value.
    expect(tokensMatch("secret", "secretsecret")).toBe(false);
  });

  it("never authenticates an empty token, even against another empty one", () => {
    expect(tokensMatch("", "")).toBe(false);
    expect(tokensMatch("", "secret")).toBe(false);
    expect(tokensMatch("secret", "")).toBe(false);
  });

  it("compares multi-byte values by content, not by byte length", () => {
    expect(tokensMatch("pässwörd", "pässwörd")).toBe(true);
    expect(tokensMatch("pässwörd", "passsword")).toBe(false);
  });
});

describe("createSessionStore", () => {
  it("issues a different id every time", () => {
    const store = createSessionStore();
    const a = store.create();
    const b = store.create();
    expect(a).not.toBe(b);
  });

  it("issues ids long enough to be unguessable", () => {
    const store = createSessionStore();
    const id = store.create();
    // 128 bits of entropy at minimum; hex/base64url of 16+ random bytes.
    expect(id.length).toBeGreaterThanOrEqual(32);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("verifies an id it issued", () => {
    const store = createSessionStore();
    expect(store.verify(store.create())).toBe(true);
  });

  it("rejects undefined, an unknown id, and an empty string", () => {
    const store = createSessionStore();
    store.create();
    expect(store.verify(undefined)).toBe(false);
    expect(store.verify("")).toBe(false);
    expect(store.verify("not-a-session-id")).toBe(false);
  });

  it("rejects a revoked id and leaves other sessions alone", () => {
    const store = createSessionStore();
    const a = store.create();
    const b = store.create();
    store.revoke(a);
    expect(store.verify(a)).toBe(false);
    expect(store.verify(b)).toBe(true);
  });

  it("tolerates revoking undefined or an unknown id", () => {
    const store = createSessionStore();
    expect(() => store.revoke(undefined)).not.toThrow();
    expect(() => store.revoke("nope")).not.toThrow();
  });

  it("expires a session once its TTL has elapsed", () => {
    let now = 1_000;
    const store = createSessionStore({ now: () => now, ttlMs: 10_000 });
    const id = store.create();

    now = 10_999;
    expect(store.verify(id)).toBe(true);

    now = 11_001;
    expect(store.verify(id)).toBe(false);
  });

  it("does not resurrect an expired session on a later check", () => {
    let now = 0;
    const store = createSessionStore({ now: () => now, ttlMs: 100 });
    const id = store.create();
    now = 1_000;
    expect(store.verify(id)).toBe(false);
    now = 1_001;
    expect(store.verify(id)).toBe(false);
  });
});

describe("parseCookies", () => {
  it("parses several cookies", () => {
    expect(parseCookies("a=1; b=2; c=3")).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("keeps '=' inside a value", () => {
    // base64 padding is the common case, and splitting on every '=' loses it.
    expect(parseCookies("t=YWJj==; x=1")).toEqual({ t: "YWJj==", x: "1" });
  });

  it("tolerates sloppy whitespace and separators", () => {
    expect(parseCookies("  a = 1 ;;  b=2  ")).toEqual({ a: "1", b: "2" });
  });

  it("returns {} for a missing or empty header", () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("")).toEqual({});
    expect(parseCookies("   ")).toEqual({});
  });

  it("never throws on malformed input", () => {
    expect(() => parseCookies("garbage")).not.toThrow();
    expect(parseCookies("garbage")).toEqual({});
    expect(parseCookies("=novalue; =; a=1")).toEqual({ a: "1" });
    expect(() => parseCookies("bad=%E0%A4%A; ok=2")).not.toThrow();
    expect(parseCookies("bad=%E0%A4%A; ok=2").ok).toBe("2");
  });

  it("decodes percent-encoded values", () => {
    expect(parseCookies("a=one%20two")).toEqual({ a: "one two" });
  });

  it("lets the first occurrence of a name win", () => {
    // A later duplicate must not be able to overwrite the real session id.
    expect(parseCookies("s=real; s=injected").s).toBe("real");
  });
});

describe("serializeCookie", () => {
  it("carries HttpOnly, SameSite=Strict and Path=/ by default", () => {
    const header = serializeCookie("dash_session", "abc123");
    expect(header.startsWith("dash_session=abc123")).toBe(true);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Path=/");
  });

  it("encodes a value that needs it", () => {
    expect(serializeCookie("k", "a b;c")).toContain("k=a%20b%3Bc");
  });

  it("emits Max-Age when asked", () => {
    expect(serializeCookie("k", "v", { maxAge: 60 })).toContain("Max-Age=60");
  });

  it("clears with Max-Age=0", () => {
    const header = serializeCookie("dash_session", "", { maxAge: 0 });
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("Path=/");
    expect(header).toContain("HttpOnly");
  });

  it("adds Secure only when asked", () => {
    expect(serializeCookie("k", "v")).not.toContain("Secure");
    expect(serializeCookie("k", "v", { secure: true })).toContain("Secure");
  });
});
