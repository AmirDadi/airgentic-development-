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
import { createStreamRedactor } from "./chat/stream-redactor.js";
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
] as const;

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

        // The delta frames go to browsers before the reply is complete, so a
        // secret split across deltas would reach the DOM raw. Redact the
        // stream incrementally — never emitting a fragment that could still be
        // part of a secret (PRD R4). Storage is redacted separately below.
        const streamRedactor = createStreamRedactor();
        try {
          const result = await bridge.runTurn(prompt, (delta) => {
            const safe = streamRedactor.push(delta);
            if (safe.length > 0) {
              hub.broadcast("chat", { turnId, kind: "delta", text: safe });
            }
          });

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
          // The final frame REPLACES the streamed reply in the UI, so it
          // carries the whole redacted text. Previously it sent result.text
          // raw — the R4 leak this closes.
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
      const path = req.url.split("?")[0] ?? "";
      const isApi = API_PREFIXES.some(
        (p) => path === p || path.startsWith(`${p}/`),
      );
      if (req.method !== "GET" || isApi) {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
