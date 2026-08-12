import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import {
  migrate,
  insertEvent,
  insertMessage,
  upsertAgent,
  upsertFeature,
  insertEntries,
  type StoredEntry,
} from "../src/db.js";
import type { Event, Message } from "../src/types.js";
import { buildApp } from "../src/app.js";
import { createSseHub, type SseHub } from "../src/sse.js";

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
