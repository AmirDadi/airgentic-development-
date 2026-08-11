import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  migrate,
  upsertAgent,
  listAgents,
  upsertFeature,
  listFeatures,
  insertMessage,
  listMessages,
  insertEvent,
  listEvents,
} from "../src/db";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
});

describe("migrate", () => {
  it("creates all four tables", () => {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(names).toEqual(
      expect.arrayContaining(["agents", "features", "messages", "events"]),
    );
  });

  it("is idempotent — running twice does not throw or duplicate", () => {
    expect(() => migrate(db)).not.toThrow();
    upsertAgent(db, agent());
    migrate(db);
    expect(listAgents(db)).toHaveLength(1);
  });
});

function agent(over: Partial<Parameters<typeof upsertAgent>[1]> = {}) {
  return {
    name: "payments",
    kind: "worker",
    workdir: "/srv/payments",
    alive: true,
    last_seen: 1000,
    current_activity: "running tests",
    ...over,
  };
}

describe("agents", () => {
  it("round-trips an agent, preserving the boolean", () => {
    upsertAgent(db, agent());
    const [row] = listAgents(db);
    expect(row).toEqual(agent());
    // SQLite has no bool type; make sure we don't leak 1/0 to callers.
    expect(typeof row.alive).toBe("boolean");
  });

  it("upserts by name rather than duplicating", () => {
    upsertAgent(db, agent());
    upsertAgent(db, agent({ alive: false, current_activity: "idle" }));
    const rows = listAgents(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].alive).toBe(false);
    expect(rows[0].current_activity).toBe("idle");
  });

  it("accepts null last_seen and activity for an agent we know nothing about", () => {
    upsertAgent(db, agent({ last_seen: null, current_activity: null }));
    const [row] = listAgents(db);
    expect(row.last_seen).toBeNull();
    expect(row.current_activity).toBeNull();
  });
});

function feature(over: Partial<Parameters<typeof upsertFeature>[1]> = {}) {
  return {
    name: "checkout",
    owner: "payments",
    stage: "implementing" as const,
    branch: "feat/checkout",
    pr_url: null,
    updated_at: 2000,
    ...over,
  };
}

describe("features", () => {
  it("round-trips a feature", () => {
    upsertFeature(db, feature());
    expect(listFeatures(db)).toEqual([feature()]);
  });

  it("upserts by name, advancing the stage in place", () => {
    upsertFeature(db, feature());
    upsertFeature(db, feature({ stage: "in_review", pr_url: "http://pr/1" }));
    const rows = listFeatures(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].stage).toBe("in_review");
    expect(rows[0].pr_url).toBe("http://pr/1");
  });
});

function message(over: Partial<Parameters<typeof insertMessage>[1]> = {}) {
  return {
    id: "m1",
    ts: 10,
    from_agent: "lead",
    to_agent: "payments",
    channel: "inter_agent" as const,
    body: "start the spec",
    session_id: "s1",
    ...over,
  };
}

describe("messages", () => {
  it("round-trips a message", () => {
    insertMessage(db, message());
    expect(listMessages(db, {})).toEqual([message()]);
  });

  it("is idempotent on re-insert of the same id (re-reading a transcript)", () => {
    insertMessage(db, message());
    insertMessage(db, message());
    expect(listMessages(db, {})).toHaveLength(1);
  });

  it("filters to the conversation between a pair, in either direction", () => {
    insertMessage(db, message({ id: "m1", from_agent: "lead", to_agent: "payments" }));
    insertMessage(db, message({ id: "m2", from_agent: "payments", to_agent: "lead" }));
    insertMessage(db, message({ id: "m3", from_agent: "lead", to_agent: "search" }));

    const pair = listMessages(db, { a: "lead", b: "payments" });
    expect(pair.map((m) => m.id).sort()).toEqual(["m1", "m2"]);
  });

  it("filters to one agent's messages when only `a` is given", () => {
    // Regression: the pair filter required BOTH a and b, so `?a=lead` alone
    // silently returned every message in the table rather than that agent's.
    insertMessage(db, message({ id: "m1", from_agent: "lead", to_agent: "payments" }));
    insertMessage(db, message({ id: "m2", from_agent: "payments", to_agent: "lead" }));
    insertMessage(db, message({ id: "m3", from_agent: "search", to_agent: "docs" }));

    const mine = listMessages(db, { a: "lead" });
    expect(mine.map((m) => m.id).sort()).toEqual(["m1", "m2"]);
  });

  it("returns messages oldest-first and honours a limit", () => {
    insertMessage(db, message({ id: "m1", ts: 30 }));
    insertMessage(db, message({ id: "m2", ts: 10 }));
    insertMessage(db, message({ id: "m3", ts: 20 }));

    expect(listMessages(db, {}).map((m) => m.id)).toEqual(["m2", "m3", "m1"]);
    // A limit keeps the NEWEST messages, still returned oldest-first.
    expect(listMessages(db, { limit: 2 }).map((m) => m.id)).toEqual(["m3", "m1"]);
  });
});

describe("events", () => {
  it("round-trips an event, preserving the payload through JSON", () => {
    insertEvent(db, {
      id: "e1",
      ts: 5,
      agent: "payments",
      type: "turn_finished",
      payload: { tokens: 42, nested: { ok: true } },
    });
    const [row] = listEvents(db, {});
    expect(row.payload).toEqual({ tokens: 42, nested: { ok: true } });
  });

  it("tolerates a null agent (system-level events)", () => {
    insertEvent(db, { id: "e1", ts: 5, agent: null, type: "boot", payload: null });
    expect(listEvents(db, {})[0].agent).toBeNull();
  });

  it("returns newest-first and filters by since (exclusive)", () => {
    insertEvent(db, { id: "e1", ts: 10, agent: null, type: "a", payload: null });
    insertEvent(db, { id: "e2", ts: 20, agent: null, type: "b", payload: null });
    insertEvent(db, { id: "e3", ts: 30, agent: null, type: "c", payload: null });

    expect(listEvents(db, {}).map((e) => e.id)).toEqual(["e3", "e2", "e1"]);
    expect(listEvents(db, { since: 20 }).map((e) => e.id)).toEqual(["e3"]);
  });
});
