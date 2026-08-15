import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type Database from "better-sqlite3";
import {
  listAgents,
  listEvents,
  listFeatures,
  listMessages,
  listEntries,
  insertEvent,
  insertMessage,
} from "./db.js";
import { groupIntoThreads } from "./threads.js";
import type { Event } from "./types.js";
import { createSseHub, type SseHub } from "./sse.js";
import { redact } from "./redact.js";
import type { Bridge } from "./chat/bridge.js";
import { createTurnQueue } from "./chat/queue.js";
import { stopAgent } from "./stop.js";
import type { CommandRunner } from "./collectors/liveness.js";
import {
  createSessionStore,
  parseCookies,
  serializeCookie,
  tokensMatch,
  DEFAULT_SESSION_TTL_MS,
} from "./auth.js";
import fastifyStatic from "@fastify/static";

/**
 * Redacts every string inside an arbitrary hook payload, preserving structure.
 * Hook payloads are transcript-derived, so a credential an agent saw can ride
 * in on one; PRD R4 requires it never reaches storage in the clear.
 */
function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        redactDeep(v),
      ]),
    );
  }
  return value;
}

export interface BuildAppOptions {
  /** Injectable so tests can observe fan-out without opening a socket. */
  hub?: SseHub;
  /** Passed through to Fastify; off by default so tests stay quiet. */
  logger?: FastifyServerOptions["logger"];
  /**
   * Directory of the built frontend. When set, the dashboard is served from
   * this same origin, which is what makes the UI's relative `fetch("/agents")`
   * work at all. Omitted = API-only mode (what every test uses).
   */
  uiDir?: string;
  /**
   * The web-lead chat bridge. INJECTED, always: tests drive a fake and no
   * `claude` process is ever spawned by the app itself. Omitted = chat is not
   * configured, and `POST /chat` answers 503 while the rest of the dashboard
   * runs normally.
   */
  chat?: Bridge;
  /**
   * The Stop control capability. INJECTED, always: tests drive a fake runner
   * and no real tmux is ever touched by the app. Omitted = Stop is not
   * configured, and `POST /agents/:name/stop` answers 503 while the rest of the
   * dashboard runs normally (exactly like `POST /chat` without a bridge).
   *
   * `index.ts` supplies the real `defaultRunner` and `TMUX_SESSION` here.
   */
  stop?: {
    /** tmux session the agents live in. */
    session: string;
    /** Executor for the interrupt command; `shell:false` under the hood. */
    runner: CommandRunner;
  };
  /**
   * The shared dashboard token. INJECTED, always: `index.ts` supplies it from
   * `DASHBOARD_TOKEN`, tests supply their own.
   *
   * OMITTED = NO GUARD IS REGISTERED AT ALL and the app behaves exactly as it
   * did before auth existed. That is the whole reason auth is an option rather
   * than a mode flag: "disabled" is the absence of the hook, not a branch
   * inside it that could be got wrong.
   */
  auth?: {
    /** Compared timing-safely against a presented token. */
    token: string;
  };
}

/** Who the lead answers as, in stored chat messages. */
export const WEB_LEAD = "web-lead";
/** Speaker name used when the client does not send one. */
const DEFAULT_CHAT_USER = "web";

// ajv type coercion is switched off app-wide (see buildApp) so that a body
// like `{type: 42}` is rejected rather than silently stringified. Query params
// therefore arrive as strings and are validated by pattern, then converted.
const SINCE = { type: "string", pattern: "^[0-9]+$" } as const;
const LIMIT = { type: "string", pattern: "^[1-9][0-9]*$" } as const;

const feedQuerySchema = {
  type: "object",
  properties: { since: SINCE, limit: LIMIT },
  additionalProperties: false,
} as const;

const messagesQuerySchema = {
  type: "object",
  properties: { a: { type: "string" }, b: { type: "string" }, limit: LIMIT },
  additionalProperties: false,
} as const;

const entriesQuerySchema = {
  type: "object",
  properties: { limit: LIMIT },
  additionalProperties: false,
} as const;

/** Every path the API owns. The SPA fallback must never claim one. */
const API_PREFIXES = [
  "/health",
  "/agents",
  "/features",
  "/events",
  "/messages",
  "/threads",
  "/ingest",
  "/live",
  "/chat",
  // Without this the SPA fallback would answer GET /auth/... with index.html,
  // and the login flow would be shadowed by the page that needs it.
  "/auth",
] as const;

/** The path half of a request URL, with the query string dropped. */
function pathOf(url: string): string {
  return url.split("?")[0] ?? "";
}

/**
 * True when a path belongs to the API rather than to the static UI.
 *
 * Checked against BOTH the raw and the percent-decoded path: the auth guard
 * exempts static assets by "not an API path", so `/%61gents` matching a route
 * but not this test would be an exemption that hands out `/agents` unguarded.
 */
function isApiPath(path: string): boolean {
  const candidates = [path];
  try {
    const decoded = decodeURIComponent(path);
    if (decoded !== path) candidates.push(decoded);
  } catch {
    // Malformed encoding: the raw form is all we have, and it will not route.
  }
  return candidates.some((c) =>
    API_PREFIXES.some((p) => c === p || c.startsWith(`${p}/`)),
  );
}

/** Cookie carrying the session id — never the token itself. */
const SESSION_COOKIE = "dash_session";

/**
 * Requests that must work with no credential when a token IS configured:
 *
 *   GET  /health       — liveness probes run before anyone logs in.
 *   GET  /auth/status  — the UI has to learn that it must show a login form.
 *   POST /auth/login   — the only way to obtain a credential.
 *   POST /auth/logout  — clearing a dead session must never itself 401.
 *
 * Plus, when a UI directory is served, any GET/HEAD that is NOT an API path:
 * the login page and its bundle must load. The bundle is not secret; the data
 * behind it is, and every API path stays guarded by the `isApiPath` test.
 */
function isExemptFromAuth(
  method: string,
  path: string,
  servesUi: boolean,
): boolean {
  const isRead = method === "GET" || method === "HEAD";
  if (isRead && path === "/health") return true;
  if (isRead && path === "/auth/status") return true;
  if (method === "POST" && (path === "/auth/login" || path === "/auth/logout")) {
    return true;
  }
  return isRead && servesUi && !isApiPath(path);
}

function num(v: string | undefined): number | undefined {
  return v === undefined ? undefined : Number(v);
}

const ingestBodySchema = {
  type: "object",
  required: ["type"],
  properties: {
    agent: { type: ["string", "null"] },
    // minLength keeps `""` — a hook that fired with no type — out of the store.
    type: { type: "string", minLength: 1 },
    payload: {},
  },
} as const;

interface FeedQuery {
  since?: string;
  limit?: string;
}

interface MessagesQuery {
  a?: string;
  b?: string;
  limit?: string;
}

interface EntriesQuery {
  limit?: string;
}

interface AgentParams {
  name: string;
}

interface IngestBody {
  agent?: string | null;
  type: string;
  payload?: unknown;
}

const chatBodySchema = {
  type: "object",
  required: ["text"],
  properties: {
    // minLength here rejects `""`; whitespace-only is checked in the handler,
    // where the trimmed value is available.
    text: { type: "string", minLength: 1 },
    user: { type: "string", minLength: 1 },
  },
} as const;

interface ChatBody {
  text: string;
  user?: string;
}

const stopBodySchema = {
  type: "object",
  properties: {
    // Optional; when present it must be a non-empty string (who requested the
    // Stop, for the audit trail). Absent = defaulted to "web" in the handler.
    actor: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
} as const;

interface StopBody {
  actor?: string;
}

/**
 * Builds the HTTP app around an already-migrated DB handle. Deliberately does
 * not listen: tests drive it with `app.inject()`, `index.ts` owns the socket.
 */
export function buildApp(
  db: Database.Database,
  opts: BuildAppOptions = {},
): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
    ajv: { customOptions: { coerceTypes: false } },
  });
  const hub = opts.hub ?? createSseHub();

  // ---- auth (PRD Q2) -------------------------------------------------------
  // Sessions are per-app and in memory: a restart logs everyone out, which is
  // the accepted trade for having no session store at all.
  const auth = opts.auth;
  const sessions = createSessionStore();

  /** The bearer token presented, if the header is a well-formed non-empty one. */
  function bearerOf(header: string | undefined): string | undefined {
    if (typeof header !== "string") return undefined;
    const match = /^Bearer[ \t]+(\S.*)$/.exec(header.trim());
    return match?.[1];
  }

  function sessionIdOf(cookieHeader: string | undefined): string | undefined {
    return parseCookies(cookieHeader)[SESSION_COOKIE];
  }

  /**
   * Either credential authenticates: the cookie (which `EventSource` sends
   * automatically, and which is the only thing that can guard `GET /live`), or
   * `Authorization: Bearer` (for the shell hooks that POST to `/ingest` and
   * cannot hold a cookie jar).
   */
  function isAuthenticated(req: {
    headers: { cookie?: string; authorization?: string };
  }): boolean {
    if (auth === undefined) return false;
    if (sessions.verify(sessionIdOf(req.headers.cookie))) return true;
    const bearer = bearerOf(req.headers.authorization);
    return bearer !== undefined && tokensMatch(bearer, auth.token);
  }

  if (auth !== undefined) {
    const servesUi = opts.uiDir !== undefined;
    app.addHook("onRequest", async (req, reply) => {
      if (isExemptFromAuth(req.method, pathOf(req.url), servesUi)) return;
      if (isAuthenticated(req)) return;
      // 401 + JSON, never a redirect: the clients are `fetch` and
      // `EventSource`, which would follow a redirect into a parse failure
      // instead of surfacing "you need to log in".
      return reply.code(401).send({ error: "authentication required" });
    });
  }

  const loginBodySchema = {
    type: "object",
    required: ["token"],
    properties: { token: { type: "string", minLength: 1 } },
    additionalProperties: false,
  } as const;

  /**
   * Exchanges the shared token for a session cookie. The cookie holds a random
   * session id, NOT the token: a leaked cookie is revocable and expires, a
   * leaked token is the key to the building.
   */
  app.post<{ Body: { token: string } }>(
    "/auth/login",
    { schema: { body: loginBodySchema } },
    async (req, reply) => {
      // Same 401 as a wrong token when no token is configured: logging in is
      // meaningless without one, and the answer must not depend on the secret.
      if (auth === undefined || !tokensMatch(req.body.token, auth.token)) {
        return reply.code(401).send({ error: "invalid token" });
      }
      return reply
        .header(
          "set-cookie",
          serializeCookie(SESSION_COOKIE, sessions.create(), {
            maxAge: Math.floor(DEFAULT_SESSION_TTL_MS / 1000),
          }),
        )
        .code(200)
        .send({ ok: true });
    },
  );

  /**
   * Revokes the session server-side AND clears the cookie. Exempt from the
   * guard: logging out with an already-dead session must clear the browser's
   * stale cookie rather than 401, or the UI can get stuck showing a session it
   * cannot use and cannot drop.
   */
  app.post("/auth/logout", async (req, reply) => {
    sessions.revoke(sessionIdOf(req.headers.cookie));
    return reply
      .header("set-cookie", serializeCookie(SESSION_COOKIE, "", { maxAge: 0 }))
      .code(200)
      .send({ ok: true });
  });

  /**
   * What the UI needs to decide between the login form and the dashboard.
   * Reachable unauthenticated by design; it discloses only whether a token is
   * configured, which any 401 already reveals.
   */
  app.get("/auth/status", async (req) => ({
    authRequired: auth !== undefined,
    authenticated: isAuthenticated(req),
  }));

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/agents", async () => listAgents(db));

  app.get("/features", async () => listFeatures(db));

  app.get<{ Querystring: FeedQuery }>(
    "/events",
    { schema: { querystring: feedQuerySchema } },
    async (req) =>
      listEvents(db, { since: num(req.query.since), limit: num(req.query.limit) }),
  );

  app.get<{ Querystring: MessagesQuery }>(
    "/messages",
    { schema: { querystring: messagesQuerySchema } },
    async (req) =>
      listMessages(db, { a: req.query.a, b: req.query.b, limit: num(req.query.limit) }),
  );

  /**
   * The agent detail view's feed: every kept transcript entry for one agent,
   * oldest-first, `?limit=` keeping the newest N.
   *
   * `:name` is data, never a path: it is bound as a SQL parameter and used for
   * an exact-equality lookup, so `..`, a slash or a `%` wildcard are just
   * agent names that match nothing. An agent we hold no entries for is `200`
   * with `[]` — having no transcript yet is normal, not an error, and a 404
   * would make the UI show a failure for a perfectly healthy agent.
   */
  app.get<{ Params: AgentParams; Querystring: EntriesQuery }>(
    "/agents/:name/entries",
    { schema: { querystring: entriesQuerySchema } },
    async (req) =>
      listEntries(db, {
        agent: req.params.name,
        limit: num(req.query.limit),
      }),
  );

  app.get("/threads", async () => groupIntoThreads(listMessages(db, {})));

  /**
   * Stop (interrupt) one agent's current turn. The first write into an agent's
   * runtime, so it is guarded (PRD R5): interrupt-only, audited, injection-safe.
   *
   * `:name` is DATA — a path param handed straight to `stopAgent`, which looks
   * it up by exact equality against the `agents` table and, if it matches,
   * passes it to the pure argv builder as a single element. It is never
   * interpolated into a shell. A traversal-ish or wildcard name simply matches
   * no known agent and 404s.
   *
   * Status map: unknown agent → 404; tmux/exec failure → 502; success → 200
   * with the created audit event. When Stop is not configured → 503, like
   * `POST /chat` without a bridge — the rest of the dashboard runs regardless.
   */
  app.post<{ Params: AgentParams; Body: StopBody }>(
    "/agents/:name/stop",
    { schema: { body: stopBodySchema } },
    async (req, reply) => {
      const stop = opts.stop;
      if (stop === undefined) {
        return reply
          .code(503)
          .send({ error: "stop control not configured" });
      }

      const result = await stopAgent(db, req.params.name, {
        actor: req.body?.actor,
        session: stop.session,
        runner: stop.runner,
      });

      // Any real invocation wrote an audit row (success OR failure); the
      // unknown-agent path wrote nothing and has no event. Broadcast whatever
      // was written on the channel the timeline follows, so it shows up live.
      if (result.event !== undefined) hub.broadcast("events", result.event);

      if (result.ok) {
        return reply.code(200).send(result.event);
      }

      if (result.reason === "unknown") {
        // A Stop that targeted nobody: never ran, never audited.
        return reply.code(404).send({ error: result.error ?? "unknown agent" });
      }

      // The interrupt failed (tmux down / window gone). The attempt is already
      // audited as a failure inside stopAgent; report an upstream error.
      return reply
        .code(502)
        .send({ error: result.error ?? "stop command failed" });
    },
  );

  app.post<{ Body: IngestBody }>(
    "/ingest",
    { schema: { body: ingestBodySchema } },
    async (req, reply) => {
      // id and ts are server-side: hooks are untrusted and must not be able to
      // choose a primary key or backdate the feed.
      const event: Event = {
        id: randomUUID(),
        ts: Date.now(),
        agent: req.body.agent ?? null,
        type: req.body.type,
        payload: redactDeep(req.body.payload ?? null),
      };

      insertEvent(db, event);
      // Event name must match what the frontend subscribes to (see
      // useLive.ts CHANNELS) — "event" singular was never received.
      hub.broadcast("events", event);

      return reply.code(201).send(event);
    },
  );

  /**
   * The web chat's history: both sides of every human↔lead exchange,
   * oldest-first. Served whether or not a bridge is configured — past
   * conversation is readable even when the lead is down.
   */
  app.get("/chat/history", async () =>
    listMessages(db, {}).filter((m) => m.channel === "human_web"),
  );

  // One queue per app: turns are serialised so two humans typing at once
  // cannot interleave inside the lead's context (PRD R3).
  const chatQueue = createTurnQueue();

  /**
   * Accepts one human turn. Returns 202 immediately with a turn id — the
   * reply arrives over the SSE `chat` channel, tagged with that id, because a
   * turn takes tens of seconds and must not hold an HTTP request open.
   */
  app.post<{ Body: ChatBody }>(
    "/chat",
    { schema: { body: chatBodySchema } },
    async (req, reply) => {
      const bridge = opts.chat;
      if (bridge === undefined) {
        // The dashboard is useful without a lead; say so plainly rather than
        // failing as a 500 or pretending the message was accepted.
        return reply
          .code(503)
          .send({ error: "chat bridge not configured" });
      }

      const text = req.body.text.trim();
      if (text.length === 0) {
        return reply.code(400).send({ error: "text must not be empty" });
      }
      const user = req.body.user?.trim() || DEFAULT_CHAT_USER;

      const turnId = randomUUID();

      // Name-tagged so the lead knows who is speaking; the raw text goes to
      // the agent (redaction is a storage concern, not a delivery one).
      const prompt = `${user}: ${text}`;

      // Deliberately not awaited: the response is 202 and the work continues
      // on the queue. Every failure path inside ends in a `chat` error frame.
      void chatQueue.push(async () => {
        // The human message is stored INSIDE the serialized turn, not in the
        // handler: storing it in the handler let two overlapping users land as
        // in,in,out,out in the DB, and the history pairing then crossed one
        // person's prompt with another's reply. Serialized, each turn's two
        // rows stay adjacent. Redacted first (PRD R4).
        insertMessage(db, {
          id: `${turnId}:in`,
          ts: Date.now(),
          from_agent: user,
          to_agent: WEB_LEAD,
          channel: "human_web",
          body: redact(text),
          session_id: null,
        });

        try {
          // The reply is delivered in ONE redacted frame when the turn
          // completes, not streamed token by token. Incrementally redacting a
          // live stream is deceptively hard — a secret split across tokens, or
          // a multi-line PEM key, has to be held until it is whole — and the
          // per-turn delay is acceptable, so we buffer, redact once, and emit
          // once. Nothing partial ever reaches a browser (PRD R4). The onDelta
          // hook is required by the bridge but intentionally ignored.
          const result = await bridge.runTurn(prompt, () => {});

          if (!result.ok) {
            hub.broadcast("chat", {
              turnId,
              kind: "error",
              message: result.error ?? "turn failed",
            });
            return;
          }

          insertMessage(db, {
            id: `${turnId}:out`,
            ts: Date.now(),
            from_agent: WEB_LEAD,
            to_agent: user,
            channel: "human_web",
            body: redact(result.text),
            session_id: null,
          });
          // The one reply frame: the whole redacted text, matching what was
          // just stored.
          hub.broadcast("chat", {
            turnId,
            kind: "final",
            text: redact(result.text),
          });
        } catch (err) {
          // A bridge that throws is a bug in the bridge, not a reason for the
          // browser to wait forever on a turn that will never finish.
          hub.broadcast("chat", {
            turnId,
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });

      return reply.code(202).send({ turnId });
    },
  );

  app.get("/live", (req, reply) => {
    // Take the socket off Fastify's reply lifecycle: this response never ends
    // on its own, so Fastify must not try to serialise or close it.
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    // writeHead only queues the headers — without this a real client sees
    // nothing at all until the first write, i.e. until the 30s heartbeat.
    // Send an opening comment too, so proxies that buffer until first body
    // byte release the response immediately.
    reply.raw.flushHeaders();
    reply.raw.write(": connected\n\n");

    const unsubscribe = hub.subscribe((event, data) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    });

    // Comment line: flushes headers through any proxy and proves liveness.
    const heartbeat = setInterval(() => {
      reply.raw.write(": ping\n\n");
    }, 30_000);
    heartbeat.unref?.();

    // Idempotent, because 'close' can fire on both halves of the connection.
    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };

    req.raw.on("close", cleanup);
    req.raw.on("error", cleanup);
    reply.raw.on("close", cleanup);
    reply.raw.on("error", cleanup);
  });

  // Registered LAST so no API route can be shadowed by the SPA fallback. The
  // UI fetches same-origin relative paths, so if `/agents` ever resolved to
  // index.html the client would parse HTML as JSON and report the backend as
  // unreachable — which is exactly what happened when the UI was served by a
  // separate dev server with no proxy.
  if (opts.uiDir !== undefined) {
    void app.register(fastifyStatic, { root: opts.uiDir, wildcard: false });

    app.setNotFoundHandler((req, reply) => {
      // Only client-side routes fall back to the app shell. Anything under an
      // API prefix must still 404 as JSON, so a typo'd or removed endpoint
      // surfaces as an error instead of silently returning a web page that the
      // caller then fails to parse as JSON.
      //
      // Matched on the PATH, not the accept header: a header-based rule only
      // holds for clients that happen to send one, and the failure it guards
      // against is precisely a client receiving HTML it did not expect.
      if (req.method !== "GET" || isApiPath(pathOf(req.url))) {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
