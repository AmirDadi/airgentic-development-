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
} from "./db.js";
import { groupIntoThreads } from "./threads.js";
import type { Event } from "./types.js";
import { createSseHub, type SseHub } from "./sse.js";
import { redact } from "./redact.js";

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
}

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

  return app;
}
