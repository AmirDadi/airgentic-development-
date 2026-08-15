/**
 * App-layer auth primitives: a timing-safe token comparison, an in-memory
 * session store, and cookie parse/serialize.
 *
 * Deliberately dependency-free and free of any Fastify types — `app.ts` owns
 * the wiring, this file owns the security-relevant mechanics and is tested in
 * isolation. Cookies are hand-rolled rather than pulled in as a plugin: two
 * small pure functions with tests beat a dependency for one cookie.
 *
 * SESSIONS LIVE IN MEMORY ONLY. A server restart therefore logs everyone out —
 * an accepted trade (see docs/IMPLEMENTATION-P6-AUTH.md): there is one shared
 * token for a small team, and losing sessions costs one re-login, whereas a
 * persistent session store costs a schema, migrations and a revocation story.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Sessions last a week unless the caller says otherwise. Exported so the
 * cookie's `Max-Age` and the server-side expiry can be set from ONE number:
 * a cookie that outlives its session is a login that silently stops working.
 */
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 32 bytes = 256 bits of entropy; base64url so it needs no cookie escaping. */
const SESSION_ID_BYTES = 32;

/**
 * Constant-time-ish equality for secrets.
 *
 * `crypto.timingSafeEqual` THROWS when the two buffers differ in length, so
 * comparing raw tokens would leak the secret's length through a 500-vs-401
 * difference (and crash the route). Both sides are therefore hashed to a
 * fixed-width SHA-256 digest first: the digests are always 32 bytes, so the
 * comparison is a single fixed-length timing-safe pass regardless of the input
 * lengths, and the digest of a wrong guess reveals nothing about the token.
 *
 * An empty string never matches ANYTHING, including another empty string: an
 * unset or blank token must not become a credential that authenticates.
 */
export function tokensMatch(a: string, b: string): boolean {
  if (a === "" || b === "") return false;
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export interface SessionStore {
  /** Mints and stores a new random session id. */
  create(): string;
  /** True only for a live, unexpired, unrevoked id. Safe on `undefined`. */
  verify(id: string | undefined): boolean;
  /** Drops a session. A no-op for unknown ids, so logout is always safe. */
  revoke(id: string | undefined): void;
}

export interface SessionStoreOptions {
  /** Injectable clock, so TTL expiry is testable without waiting. */
  now?: () => number;
  /** Session lifetime in ms. Default one week. */
  ttlMs?: number;
}

export function createSessionStore(opts: SessionStoreOptions = {}): SessionStore {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  /** id -> absolute expiry timestamp. */
  const sessions = new Map<string, number>();

  return {
    create(): string {
      const id = randomBytes(SESSION_ID_BYTES).toString("base64url");
      sessions.set(id, now() + ttlMs);
      return id;
    },
    verify(id: string | undefined): boolean {
      if (id === undefined || id === "") return false;
      const expiresAt = sessions.get(id);
      if (expiresAt === undefined) return false;
      if (now() > expiresAt) {
        // Drop it here rather than sweeping on a timer: the store is only ever
        // touched on a request, so an expired entry costs nothing until then.
        sessions.delete(id);
        return false;
      }
      return true;
    },
    revoke(id: string | undefined): void {
      if (id === undefined || id === "") return;
      sessions.delete(id);
    },
  };
}

/**
 * Parses a `Cookie:` request header. Never throws — a malformed header is a
 * client problem and must not become a 500 on an unauthenticated route.
 *
 * The FIRST occurrence of a name wins, so a duplicate appended by an attacker
 * cannot displace the real session id.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === undefined) return out;

  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue; // no '=' at all: not a cookie pair
    const name = part.slice(0, eq).trim();
    if (name === "") continue;
    if (Object.prototype.hasOwnProperty.call(out, name)) continue; // first wins
    const raw = part.slice(eq + 1).trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      // Invalid percent-encoding: keep the raw bytes rather than dropping the
      // request. It will simply fail to match any session id.
    }
    out[name] = value;
  }
  return out;
}

export interface SerializeCookieOptions {
  /** Seconds. `0` clears the cookie. Omitted = a session cookie. */
  maxAge?: number;
  /** Default `/` so the cookie is sent to the API and the SSE channel alike. */
  path?: string;
  /** Default true: JS must not be able to read the session id. */
  httpOnly?: boolean;
  /** Default `Strict`: nothing cross-site should carry this credential. */
  sameSite?: "Strict" | "Lax" | "None";
  /**
   * Default false. The dashboard is commonly reached over plain HTTP on a
   * private network, and a `Secure` cookie would be silently dropped there,
   * making login appear to succeed and then fail on the next request.
   */
  secure?: boolean;
}

export function serializeCookie(
  name: string,
  value: string,
  opts: SerializeCookieOptions = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? "/"}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.trunc(opts.maxAge)}`);
  if (opts.httpOnly ?? true) parts.push("HttpOnly");
  parts.push(`SameSite=${opts.sameSite ?? "Strict"}`);
  if (opts.secure === true) parts.push("Secure");
  return parts.join("; ");
}
