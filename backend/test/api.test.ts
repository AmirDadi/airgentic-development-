import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import {
  migrate,
  insertEvent,
  insertMessage,
  upsertAgent,
  upsertFeature,
  insertEntries,
  listMessages,
  type StoredEntry,
} from "../src/db.js";
import type { Event, Message } from "../src/types.js";
import { buildApp } from "../src/app.js";
import { createSseHub, type SseHub } from "../src/sse.js";
import type { TurnResult } from "../src/chat/bridge.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function makeApp(opts?: { hub?: SseHub }): {
  app: FastifyInstance;
  db: Database.Database;
} {
  const db = makeDb();
  return { app: buildApp(db, opts), db };
}

function msg(over: Partial<Message> & Pick<Message, "id" | "ts">): Message {
  return {
    from_agent: "lead",
    to_agent: "payments",
    channel: "inter_agent",
    body: "hello",
    session_id: null,
    ...over,
  };
}

function evt(over: Partial<Event> & Pick<Event, "id" | "ts">): Event {
  return { agent: "lead", type: "hook", payload: null, ...over };
}

describe("GET /health", () => {
  it("returns ok", async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("GET /agents", () => {
  it("returns an empty array when there are no agents", async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: "GET", url: "/agents" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("returns agents with alive as a real boolean", async () => {
    const { app, db } = makeApp();
    upsertAgent(db, {
      name: "lead",
      kind: "claude",
      workdir: "/w/lead",
      alive: true,
      last_seen: 100,
      current_activity: "reviewing",
    });
    upsertAgent(db, {
      name: "payments",
      kind: "claude",
      workdir: "/w/pay",
      alive: false,
      last_seen: null,
      current_activity: null,
    });

    const res = await app.inject({ method: "GET", url: "/agents" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(2);
    expect(body[0]).toEqual({
      name: "lead",
      kind: "claude",
      workdir: "/w/lead",
      alive: true,
      last_seen: 100,
      current_activity: "reviewing",
    });
    expect(body[1].alive).toBe(false);
    expect(body[1].last_seen).toBeNull();
  });
});

describe("GET /features", () => {
  it("returns an empty array when there are no features", async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: "GET", url: "/features" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("returns stored features", async () => {
    const { app, db } = makeApp();
    upsertFeature(db, {
      name: "checkout",
      owner: "payments",
      stage: "implementing",
      branch: "feat/checkout",
      pr_url: null,
      updated_at: 42,
    });

    const res = await app.inject({ method: "GET", url: "/features" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        name: "checkout",
        owner: "payments",
        stage: "implementing",
        branch: "feat/checkout",
        pr_url: null,
        updated_at: 42,
      },
    ]);
  });
});

describe("GET /events", () => {
  function seed(db: Database.Database): void {
    insertEvent(db, evt({ id: "e10", ts: 10, type: "a" }));
    insertEvent(db, evt({ id: "e20", ts: 20, type: "b" }));
    insertEvent(db, evt({ id: "e30", ts: 30, type: "c", payload: { n: 1 } }));
  }

  it("returns all events newest-first", async () => {
    const { app, db } = makeApp();
    seed(db);

    const res = await app.inject({ method: "GET", url: "/events" });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((e: Event) => e.id)).toEqual(["e30", "e20", "e10"]);
  });

  it("round-trips a JSON payload", async () => {
    const { app, db } = makeApp();
    seed(db);
    const res = await app.inject({ method: "GET", url: "/events" });
    expect(res.json()[0].payload).toEqual({ n: 1 });
    expect(res.json()[1].payload).toBeNull();
  });

  it("treats ?since= as an exclusive lower bound", async () => {
    const { app, db } = makeApp();
    seed(db);

    const res = await app.inject({ method: "GET", url: "/events?since=20" });
    expect(res.statusCode).toBe(200);
    // ts=20 itself is excluded; only strictly newer events come back.
    expect(res.json().map((e: Event) => e.id)).toEqual(["e30"]);
  });

  it("coerces the string ?since= rather than ignoring it", async () => {
    const { app, db } = makeApp();
    seed(db);
    const res = await app.inject({ method: "GET", url: "/events?since=0" });
    expect(res.json()).toHaveLength(3);
  });

  it("applies ?limit= to the newest events", async () => {
    const { app, db } = makeApp();
    seed(db);

    const res = await app.inject({ method: "GET", url: "/events?limit=2" });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((e: Event) => e.id)).toEqual(["e30", "e20"]);
  });

  it("combines ?since= and ?limit=", async () => {
    const { app, db } = makeApp();
    seed(db);

    const res = await app.inject({
      method: "GET",
      url: "/events?since=5&limit=1",
    });
    expect(res.json().map((e: Event) => e.id)).toEqual(["e30"]);
  });

  it("rejects a non-numeric ?since= with 400", async () => {
    const { app, db } = makeApp();
    seed(db);

    const res = await app.inject({ method: "GET", url: "/events?since=abc" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a non-numeric ?limit= with 400", async () => {
    const { app, db } = makeApp();
    seed(db);

    const res = await app.inject({ method: "GET", url: "/events?limit=many" });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /messages", () => {
  function seed(db: Database.Database): void {
    insertMessage(db, msg({ id: "m1", ts: 1, body: "one" }));
    insertMessage(
      db,
      msg({ id: "m2", ts: 2, from_agent: "payments", to_agent: "lead", body: "two" }),
    );
    insertMessage(db, msg({ id: "m3", ts: 3, body: "three" }));
    insertMessage(
      db,
      msg({ id: "m4", ts: 4, from_agent: "lead", to_agent: "search", body: "other pair" }),
    );
  }

  it("returns the pair conversation oldest-first, both directions", async () => {
    const { app, db } = makeApp();
    seed(db);

    const res = await app.inject({
      method: "GET",
      url: "/messages?a=lead&b=payments",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((m: Message) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("is order-independent in a and b", async () => {
    const { app, db } = makeApp();
    seed(db);

    const res = await app.inject({
      method: "GET",
      url: "/messages?a=payments&b=lead",
    });
    expect(res.json().map((m: Message) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("keeps the newest N when ?limit= is given, still oldest-first", async () => {
    const { app, db } = makeApp();
    seed(db);

    const res = await app.inject({
      method: "GET",
      url: "/messages?a=lead&b=payments&limit=2",
    });
    expect(res.json().map((m: Message) => m.id)).toEqual(["m2", "m3"]);
  });

  it("returns every message when no pair is given", async () => {
    const { app, db } = makeApp();
    seed(db);

    const res = await app.inject({ method: "GET", url: "/messages" });
    expect(res.json()).toHaveLength(4);
  });

  it("returns an empty array for a pair with no history", async () => {
    const { app, db } = makeApp();
    seed(db);

    const res = await app.inject({
      method: "GET",
      url: "/messages?a=nobody&b=nowhere",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("rejects a non-numeric ?limit= with 400", async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/messages?a=lead&b=payments&limit=lots",
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /threads", () => {
  it("returns an empty array with no messages", async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: "GET", url: "/threads" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("groups messages into pairwise threads, most recent first", async () => {
    const { app, db } = makeApp();
    insertMessage(db, msg({ id: "m1", ts: 1, body: "one" }));
    insertMessage(
      db,
      msg({ id: "m2", ts: 5, from_agent: "payments", to_agent: "lead", body: "latest pay" }),
    );
    insertMessage(
      db,
      msg({ id: "m3", ts: 9, from_agent: "lead", to_agent: "search", body: "latest search" }),
    );

    const res = await app.inject({ method: "GET", url: "/threads" });
    expect(res.statusCode).toBe(200);
    const threads = res.json();
    expect(threads.map((t: { id: string }) => t.id)).toEqual([
      "lead|search",
      "lead|payments",
    ]);
    expect(threads[0].participants).toEqual(["lead", "search"]);
    expect(threads[0].last_ts).toBe(9);
    expect(threads[0].last_body).toBe("latest search");
    expect(threads[1].messages.map((m: Message) => m.id)).toEqual(["m1", "m2"]);
  });
});

describe("POST /ingest redaction", () => {
  // PRD R4: hook payloads are transcript-derived, so a secret an agent saw can
  // ride in on one. Previously payloads were stored and served verbatim.
  it("redacts secrets nested anywhere in the payload before storing", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = buildApp(db);

    const secret = "ghp_FAKEfake0123456789ABCDefghij0123AB";
    await app.inject({
      method: "POST",
      url: "/ingest",
      payload: {
        agent: "payments",
        type: "tool_call",
        payload: { cmd: `curl -H "authorization: bearer ${secret}"`, deep: { note: secret } },
      },
    });

    const raw = JSON.stringify(await app.inject({ method: "GET", url: "/events" }).then((r) => r.json()));
    expect(raw).not.toContain(secret);
    expect(raw).toContain("[REDACTED:");
  });

  it("leaves non-string payload values structurally intact", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = buildApp(db);

    await app.inject({
      method: "POST",
      url: "/ingest",
      payload: { type: "metrics", payload: { count: 42, ok: true, items: ["a", "b"], none: null } },
    });

    const [event] = await app.inject({ method: "GET", url: "/events" }).then((r) => r.json());
    expect(event.payload).toEqual({ count: 42, ok: true, items: ["a", "b"], none: null });
  });
});

describe("POST /ingest", () => {
  it("persists a valid event and returns 201 with it", async () => {
    const { app } = makeApp();

    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      payload: { agent: "lead", type: "tool_use", payload: { tool: "Bash" } },
    });

    expect(res.statusCode).toBe(201);
    const created = res.json();
    expect(created.agent).toBe("lead");
    expect(created.type).toBe("tool_use");
    expect(created.payload).toEqual({ tool: "Bash" });
    expect(typeof created.id).toBe("string");
    expect(created.id.length).toBeGreaterThan(0);
    expect(typeof created.ts).toBe("number");
  });

  it("makes the ingested event readable back via GET /events", async () => {
    const { app } = makeApp();
    const created = (
      await app.inject({
        method: "POST",
        url: "/ingest",
        payload: { agent: "payments", type: "stop", payload: { ok: true } },
      })
    ).json();

    const res = await app.inject({ method: "GET", url: "/events" });
    expect(res.statusCode).toBe(200);
    const events = res.json();
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(created.id);
    expect(events[0].ts).toBe(created.ts);
    expect(events[0].type).toBe("stop");
    expect(events[0].payload).toEqual({ ok: true });
  });

  it("generates a distinct id per event", async () => {
    const { app } = makeApp();
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        payload: { type: "hook" },
      });
      ids.add(res.json().id);
    }
    expect(ids.size).toBe(5);
  });

  it("accepts a null/absent agent", async () => {
    const { app } = makeApp();

    const withNull = await app.inject({
      method: "POST",
      url: "/ingest",
      payload: { agent: null, type: "hook" },
    });
    expect(withNull.statusCode).toBe(201);
    expect(withNull.json().agent).toBeNull();

    const without = await app.inject({
      method: "POST",
      url: "/ingest",
      payload: { type: "hook" },
    });
    expect(without.statusCode).toBe(201);
    expect(without.json().agent).toBeNull();
  });

  it("defaults a missing payload to null", async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      payload: { type: "hook" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().payload).toBeNull();
  });

  it("broadcasts the created event on the SSE hub", async () => {
    const hub = createSseHub();
    const send = vi.fn();
    hub.subscribe(send);
    const { app } = makeApp({ hub });

    const created = (
      await app.inject({
        method: "POST",
        url: "/ingest",
        payload: { agent: "lead", type: "notify" },
      })
    ).json();

    expect(send).toHaveBeenCalledTimes(1);
    const [name, data] = send.mock.calls[0] as [string, { id: string }];
    // Must match frontend useLive.ts CHANNELS; "event" singular meant the
    // browser's addEventListener("events", …) never fired.
    expect(name).toBe("events");
    expect(data.id).toBe(created.id);
  });

  it("rejects a missing type with 400", async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      payload: { agent: "lead", payload: { a: 1 } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a non-string type with 400", async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      payload: { type: 42 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an empty-string type with 400", async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      payload: { type: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a non-object body with 400", async () => {
    const { app } = makeApp();

    const asString = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify("just a string"),
    });
    expect(asString.statusCode).toBe(400);

    const asArray = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify([{ type: "hook" }]),
    });
    expect(asArray.statusCode).toBe(400);
  });

  it("rejects malformed JSON with 400", async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: { "content-type": "application/json" },
      payload: "{ not json",
    });
    expect(res.statusCode).toBe(400);
  });

  it("stores nothing when the body is rejected", async () => {
    const { app } = makeApp();
    await app.inject({ method: "POST", url: "/ingest", payload: { type: "" } });

    const res = await app.inject({ method: "GET", url: "/events" });
    expect(res.json()).toEqual([]);
  });
});

describe("GET /live", () => {
  it("streams with SSE headers and registers a subscriber", async () => {
    const hub = createSseHub();
    const { app } = makeApp({ hub });
    expect(hub.subscriberCount()).toBe(0);

    // payloadAsStream resolves as soon as the headers are flushed, so this
    // never blocks on the (deliberately infinite) event stream.
    const res = await app.inject({
      method: "GET",
      url: "/live",
      payloadAsStream: true,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["cache-control"]).toContain("no-cache");
    expect(res.headers["connection"]).toBe("keep-alive");
    expect(hub.subscriberCount()).toBe(1);

    res.raw.res.destroy();
  });

  it("unsubscribes when the client disconnects", async () => {
    const hub = createSseHub();
    const { app } = makeApp({ hub });

    const res = await app.inject({
      method: "GET",
      url: "/live",
      payloadAsStream: true,
    });
    expect(hub.subscriberCount()).toBe(1);

    res.raw.res.destroy();
    // 'close' is emitted on the next tick by the injected response.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(hub.subscriberCount()).toBe(0);
  });

  it("uses its own hub when none is injected", async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/live",
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    res.raw.res.destroy();
  });
});

describe("unknown routes", () => {
  it("404s", async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
  });
});

function entry(over: Partial<StoredEntry> & Pick<StoredEntry, "id" | "ts">): StoredEntry {
  return {
    agent: "lead",
    kind: "assistant_text",
    entry: { kind: "assistant_text", ts: over.ts, text: "hello" },
    session_id: "s1",
    ...over,
  };
}

describe("GET /agents/:name/entries", () => {
  it("returns that agent's entries oldest-first", async () => {
    const { app, db } = makeApp();
    insertEntries(db, [
      entry({ id: "e2", ts: 20 }),
      entry({ id: "e1", ts: 10 }),
      entry({ id: "e3", ts: 30 }),
      entry({ id: "x1", ts: 15, agent: "payments" }),
    ]);

    const res = await app.inject({ method: "GET", url: "/agents/lead/entries" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.map((e: StoredEntry) => e.id)).toEqual(["e1", "e2", "e3"]);
    expect(body[0]).toEqual({
      id: "e1",
      agent: "lead",
      ts: 10,
      kind: "assistant_text",
      entry: { kind: "assistant_text", ts: 10, text: "hello" },
      session_id: "s1",
    });
  });

  it("returns 200 and [] for an agent with no transcript yet", async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: "GET", url: "/agents/nobody/entries" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("keeps the NEWEST N when ?limit= is given, still oldest-first", async () => {
    const { app, db } = makeApp();
    insertEntries(db, [
      entry({ id: "e1", ts: 10 }),
      entry({ id: "e2", ts: 20 }),
      entry({ id: "e3", ts: 30 }),
    ]);

    const res = await app.inject({ method: "GET", url: "/agents/lead/entries?limit=2" });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((e: StoredEntry) => e.id)).toEqual(["e2", "e3"]);
  });

  it("rejects a non-numeric ?limit= with 400", async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: "GET", url: "/agents/lead/entries?limit=lots" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a zero or negative ?limit= with 400", async () => {
    const { app } = makeApp();
    expect(
      (await app.inject({ method: "GET", url: "/agents/lead/entries?limit=0" })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: "/agents/lead/entries?limit=-1" })).statusCode,
    ).toBe(400);
  });

  it("ignores an unknown query parameter, as the other feeds do", async () => {
    const { app, db } = makeApp();
    insertEntries(db, [entry({ id: "e1", ts: 10 })]);
    // ajv strips what the schema does not declare, so a stray `agent=` cannot
    // be used to widen the query beyond the agent named in the path.
    const res = await app.inject({
      method: "GET",
      url: "/agents/payments/entries?agent=lead",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("treats a traversal-ish name as a plain (unknown) agent name", async () => {
    const { app, db } = makeApp();
    insertEntries(db, [entry({ id: "e1", ts: 10 })]);

    for (const name of ["..", "%2e%2e", "%2e%2e%2f%2e%2e", "a%2Fb", "%00", "*", "lead%20"]) {
      const res = await app.inject({
        method: "GET",
        url: `/agents/${name}/entries`,
      });
      // The name is a bound SQL parameter matched for exact equality, so the
      // worst a traversal attempt can do is name an agent that does not exist:
      // either the router never matches the route (404), or we answer with an
      // empty list. Never a 5xx, and never another agent's entries.
      expect([200, 404], name).toContain(res.statusCode);
      if (res.statusCode === 200) expect(res.json(), name).toEqual([]);
    }
  });

  it("matches the agent name exactly — no SQL wildcard behaviour", async () => {
    const { app, db } = makeApp();
    insertEntries(db, [entry({ id: "e1", ts: 10, agent: "lead" })]);

    const res = await app.inject({ method: "GET", url: "/agents/lea%25/entries" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

describe("serving the dashboard UI", () => {
  // The design doc specifies the UI is "served by the same Fastify". It never
  // was, so there was no URL that served the dashboard at all: in dev the
  // browser's relative fetch("/agents") hit Vite's SPA fallback and got
  // index.html with a 200, which fails JSON parsing and renders the
  // "backend unreachable" banner forever.
  it("serves index.html at / when a UI directory is configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Dash</title>");

    const db = makeDb();
    const app = buildApp(db, { uiDir: dir });
    const res = await app.inject({ method: "GET", url: "/" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Dash");
    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to index.html for a client-side route, not 404", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Dash</title>");

    const db = makeDb();
    const app = buildApp(db, { uiDir: dir });
    const res = await app.inject({ method: "GET", url: "/some/deep/route" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Dash");
    rmSync(dir, { recursive: true, force: true });
  });

  it("never lets the SPA fallback shadow an API route", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Dash</title>");

    const db = makeDb();
    const app = buildApp(db, { uiDir: dir });

    // This is the exact failure the UI hit against Vite: HTML where JSON was
    // expected. The API must still win.
    const res = await app.inject({ method: "GET", url: "/agents" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json()).toEqual([]);

    // An unknown API-shaped path must 404 as JSON, not silently return HTML.
    const missing = await app.inject({ method: "GET", url: "/agents/x/nope" });
    expect(missing.body).not.toContain("Dash");
    rmSync(dir, { recursive: true, force: true });
  });

  it("still runs with no UI directory configured (API-only mode)", async () => {
    const db = makeDb();
    const app = buildApp(db);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// P4 — web chat bridge. The bridge is always injected: no test may ever spawn
// a real `claude` process.
// ---------------------------------------------------------------------------

interface FakeBridge {
  runTurn(prompt: string, onDelta: (text: string) => void): Promise<TurnResult>;
  prompts: string[];
  concurrent: number;
  maxConcurrent: number;
}

/**
 * A bridge stand-in. `respond` decides what one turn does; it is handed the
 * prompt and the delta sink so a test can drive streaming precisely.
 */
function fakeBridge(
  respond: (
    prompt: string,
    onDelta: (text: string) => void,
  ) => Promise<TurnResult> = async () => ({ ok: true, text: "pong", usage: 0.01 }),
): FakeBridge {
  const b: FakeBridge = {
    prompts: [],
    concurrent: 0,
    maxConcurrent: 0,
    async runTurn(prompt, onDelta) {
      b.prompts.push(prompt);
      b.concurrent++;
      b.maxConcurrent = Math.max(b.maxConcurrent, b.concurrent);
      try {
        return await respond(prompt, onDelta);
      } finally {
        b.concurrent--;
      }
    },
  };
  return b;
}

function makeChatApp(bridge?: FakeBridge, hub?: SseHub): {
  app: FastifyInstance;
  db: Database.Database;
} {
  const db = makeDb();
  return { app: buildApp(db, { chat: bridge, hub }), db };
}

describe("POST /chat", () => {
  it("accepts a message with 202 and a turn id", async () => {
    const { app } = makeChatApp(fakeBridge());
    const res = await app.inject({ method: "POST", url: "/chat", payload: { text: "hi" } });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(typeof body.turnId).toBe("string");
    expect(body.turnId.length).toBeGreaterThan(0);
  });

  it("generates a distinct turn id per message", async () => {
    const { app } = makeChatApp(fakeBridge());
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: "POST", url: "/chat", payload: { text: `m${i}` } });
      ids.add(res.json().turnId);
    }
    expect(ids.size).toBe(3);
  });

  it("rejects an empty or whitespace-only text with 400", async () => {
    const { app } = makeChatApp(fakeBridge());
    for (const text of ["", "   ", "\n\t "]) {
      const res = await app.inject({ method: "POST", url: "/chat", payload: { text } });
      expect(res.statusCode, JSON.stringify(text)).toBe(400);
    }
  });

  it("rejects a missing or non-string text with 400", async () => {
    const { app } = makeChatApp(fakeBridge());
    for (const payload of [{}, { text: 42 }, { text: null }, { text: ["hi"] }, { text: { a: 1 } }]) {
      const res = await app.inject({ method: "POST", url: "/chat", payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("rejects a non-string user with 400", async () => {
    const { app } = makeChatApp(fakeBridge());
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { text: "hi", user: 7 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a non-object body with 400", async () => {
    const { app } = makeChatApp(fakeBridge());
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify("hi"),
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 503 with a JSON error when no bridge is configured", async () => {
    const { app } = makeChatApp();
    const res = await app.inject({ method: "POST", url: "/chat", payload: { text: "hi" } });
    expect(res.statusCode).toBe(503);
    expect(typeof res.json().error).toBe("string");
    expect(res.json().error.length).toBeGreaterThan(0);
  });

  it("leaves the rest of the dashboard working with no bridge configured", async () => {
    const { app } = makeChatApp();
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/agents" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/chat/history" })).statusCode).toBe(200);
  });

  it("name-tags the prompt so the lead knows who is speaking", async () => {
    const bridge = fakeBridge();
    const { app } = makeChatApp(bridge);

    await app.inject({ method: "POST", url: "/chat", payload: { text: "ship it", user: "Amirreza" } });
    await vi.waitFor(() => expect(bridge.prompts).toHaveLength(1));
    expect(bridge.prompts[0]).toBe("Amirreza: ship it");
  });

  it("defaults the speaker to 'web'", async () => {
    const bridge = fakeBridge();
    const { app } = makeChatApp(bridge);

    await app.inject({ method: "POST", url: "/chat", payload: { text: "hello" } });
    await vi.waitFor(() => expect(bridge.prompts).toHaveLength(1));
    expect(bridge.prompts[0]).toBe("web: hello");
  });

  it("serialises turns — two overlapping messages never run at once (R3)", async () => {
    let release: (() => void) | undefined;
    const bridge = fakeBridge(async (prompt) => {
      if (prompt.includes("first")) {
        await new Promise<void>((res) => {
          release = res;
        });
      }
      return { ok: true, text: `re: ${prompt}`, usage: null };
    });
    const { app } = makeChatApp(bridge);

    await app.inject({ method: "POST", url: "/chat", payload: { text: "first" } });
    await app.inject({ method: "POST", url: "/chat", payload: { text: "second" } });

    await vi.waitFor(() => expect(release).toBeDefined());
    expect(bridge.prompts).toHaveLength(1);

    release?.();
    await vi.waitFor(() => expect(bridge.prompts).toHaveLength(2));
    expect(bridge.maxConcurrent).toBe(1);
    expect(bridge.prompts).toEqual(["web: first", "web: second"]);
  });
});

describe("chat SSE frames", () => {
  it("emits one redacted final frame when the turn completes", async () => {
    const hub = createSseHub();
    const send = vi.fn();
    hub.subscribe(send);
    const bridge = fakeBridge(async () => ({
      ok: true,
      text: "the build is green",
      usage: 0.01,
    }));
    const { app } = makeChatApp(bridge, hub);

    const { turnId } = (
      await app.inject({ method: "POST", url: "/chat", payload: { text: "hi" } })
    ).json();

    await vi.waitFor(() =>
      expect(
        send.mock.calls.some((c) => (c[1] as { kind?: string }).kind === "final"),
      ).toBe(true),
    );
    const frames = (send.mock.calls as [string, Record<string, unknown>][]).map(
      (f) => f[1],
    );
    expect(send.mock.calls.every((c) => c[0] === "chat")).toBe(true);
    expect(frames.every((f) => f.turnId === turnId)).toBe(true);
    // The reply is delivered in one frame, not streamed token by token.
    expect(frames.filter((f) => f.kind === "delta")).toHaveLength(0);
    expect(frames.find((f) => f.kind === "final")?.text).toBe("the build is green");
  });

  it("never broadcasts a secret from the agent's reply (R4 over the live stream)", async () => {
    // Regression: the reply frame once carried result.text raw while only
    // storage was redacted, so a planted key reached every browser verbatim.
    const hub = createSseHub();
    const send = vi.fn();
    hub.subscribe(send);
    const KEY = "sk-ant-api03-FAKEfake0000FAKEfake1111FAKEfake2222AA";
    const bridge = fakeBridge(async () => ({
      ok: true,
      text: `here is the key ${KEY} guard it`,
      usage: null,
    }));
    const { app } = makeChatApp(bridge, hub);

    await app.inject({ method: "POST", url: "/chat", payload: { text: "leak?" } });

    await vi.waitFor(() =>
      expect(
        send.mock.calls.some((c) => (c[1] as { kind?: string }).kind === "final"),
      ).toBe(true),
    );
    const allBroadcast = JSON.stringify(send.mock.calls.map((c) => c[1]));
    expect(allBroadcast).not.toContain(KEY);
    expect(allBroadcast).toContain("[REDACTED:anthropic-key]");
  });

  it("broadcasts an error frame when the turn fails", async () => {
    const hub = createSseHub();
    const send = vi.fn();
    hub.subscribe(send);
    const bridge = fakeBridge(async () => ({
      ok: false,
      text: "",
      error: "claude exited with code 1",
      usage: null,
    }));
    const { app } = makeChatApp(bridge, hub);

    const { turnId } = (
      await app.inject({ method: "POST", url: "/chat", payload: { text: "hi" } })
    ).json();

    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    const last = send.mock.calls.at(-1) as [string, Record<string, unknown>];
    expect(last[0]).toBe("chat");
    expect(last[1]).toEqual({
      turnId,
      kind: "error",
      message: "claude exited with code 1",
    });
  });

  it("broadcasts an error frame when the bridge itself throws", async () => {
    const hub = createSseHub();
    const send = vi.fn();
    hub.subscribe(send);
    const bridge = fakeBridge(async () => {
      throw new Error("bridge exploded");
    });
    const { app } = makeChatApp(bridge, hub);

    const res = await app.inject({ method: "POST", url: "/chat", payload: { text: "hi" } });
    expect(res.statusCode).toBe(202);

    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    const last = send.mock.calls.at(-1) as [string, { kind: string; message: string }];
    expect(last[1].kind).toBe("error");
    expect(last[1].message).toMatch(/bridge exploded/);
  });

  it("one broken subscriber cannot stop another from receiving chat frames", async () => {
    const hub = createSseHub();
    hub.subscribe(() => {
      throw new Error("dead client");
    });
    const good = vi.fn();
    hub.subscribe(good);
    const { app } = makeChatApp(fakeBridge(), hub);

    await app.inject({ method: "POST", url: "/chat", payload: { text: "hi" } });
    await vi.waitFor(() => expect(good).toHaveBeenCalled());
    expect(good.mock.calls.at(-1)?.[0]).toBe("chat");
  });
});

describe("chat persistence", () => {
  it("stores both sides of the exchange on the human_web channel", async () => {
    const bridge = fakeBridge(async () => ({ ok: true, text: "pong", usage: null }));
    const { app } = makeChatApp(bridge);

    await app.inject({
      method: "POST",
      url: "/chat",
      payload: { text: "ping", user: "Amirreza" },
    });

    await vi.waitFor(async () => {
      const rows = (await app.inject({ method: "GET", url: "/chat/history" })).json();
      expect(rows).toHaveLength(2);
    });

    const rows = (await app.inject({ method: "GET", url: "/chat/history" })).json() as Message[];
    expect(rows[0]).toMatchObject({
      from_agent: "Amirreza",
      to_agent: "web-lead",
      channel: "human_web",
      body: "ping",
    });
    expect(rows[1]).toMatchObject({
      from_agent: "web-lead",
      to_agent: "Amirreza",
      channel: "human_web",
      body: "pong",
    });
    for (const row of rows) {
      expect(typeof row.id).toBe("string");
      expect(row.id.length).toBeGreaterThan(0);
      expect(typeof row.ts).toBe("number");
    }
    expect(rows[0]!.id).not.toBe(rows[1]!.id);
  });

  it("redacts both sides before storage (R4)", async () => {
    const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz0123456789";
    const bridge = fakeBridge(async () => ({
      ok: true,
      text: `I used ghp_${"a".repeat(30)} to authenticate`,
      usage: null,
    }));
    const { app, db } = makeChatApp(bridge);

    await app.inject({
      method: "POST",
      url: "/chat",
      payload: { text: `here is my key ${secret}, use it` },
    });

    await vi.waitFor(() => {
      expect(listMessages(db, {})).toHaveLength(2);
    });

    // Check the raw table, not just the API: the requirement is that the
    // credential never lands in SQLite at all.
    const bodies = listMessages(db, {}).map((m) => m.body).join("\n");
    expect(bodies).not.toContain(secret);
    expect(bodies).not.toContain(`ghp_${"a".repeat(30)}`);
    expect(bodies).toContain("[REDACTED:anthropic-key]");
    expect(bodies).toContain("[REDACTED:github-token]");
    // The surrounding prose survives.
    expect(bodies).toContain("here is my key");
  });

  it("stores the human turn even when the reply fails", async () => {
    const bridge = fakeBridge(async () => ({
      ok: false,
      text: "",
      error: "timed out",
      usage: null,
    }));
    const { app } = makeChatApp(bridge);

    await app.inject({ method: "POST", url: "/chat", payload: { text: "anyone there?" } });

    await vi.waitFor(async () => {
      const rows = (await app.inject({ method: "GET", url: "/chat/history" })).json();
      expect(rows).toHaveLength(1);
    });
    const rows = (await app.inject({ method: "GET", url: "/chat/history" })).json() as Message[];
    expect(rows[0]).toMatchObject({ from_agent: "web", body: "anyone there?" });
  });

  it("makes chat turns visible to /threads alongside agent messages", async () => {
    const { app } = makeChatApp(fakeBridge());
    await app.inject({ method: "POST", url: "/chat", payload: { text: "hi" } });
    await vi.waitFor(async () => {
      const rows = (await app.inject({ method: "GET", url: "/chat/history" })).json();
      expect(rows).toHaveLength(2);
    });

    const threads = (await app.inject({ method: "GET", url: "/threads" })).json();
    expect(Array.isArray(threads)).toBe(true);
    expect(JSON.stringify(threads)).toContain("web-lead");
  });
});

describe("GET /chat/history", () => {
  it("returns [] when nothing has been said", async () => {
    const { app } = makeChatApp(fakeBridge());
    const res = await app.inject({ method: "GET", url: "/chat/history" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("returns human_web messages oldest-first and excludes inter-agent traffic", async () => {
    const { app, db } = makeChatApp(fakeBridge());
    insertMessage(db, msg({ id: "agent-1", ts: 5, channel: "inter_agent" }));
    insertMessage(db, {
      id: "c2",
      ts: 30,
      from_agent: "web-lead",
      to_agent: "web",
      channel: "human_web",
      body: "later",
      session_id: null,
    });
    insertMessage(db, {
      id: "c1",
      ts: 20,
      from_agent: "web",
      to_agent: "web-lead",
      channel: "human_web",
      body: "earlier",
      session_id: null,
    });

    const rows = (await app.inject({ method: "GET", url: "/chat/history" })).json() as Message[];
    expect(rows.map((r) => r.id)).toEqual(["c1", "c2"]);
  });

  it("is available even with no bridge configured", async () => {
    const { app, db } = makeChatApp();
    insertMessage(db, {
      id: "c1",
      ts: 20,
      from_agent: "web",
      to_agent: "web-lead",
      channel: "human_web",
      body: "hi",
      session_id: null,
    });
    const res = await app.inject({ method: "GET", url: "/chat/history" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });
});
