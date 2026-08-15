import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrate, listAgents, upsertAgent, listEvents } from "../src/db.js";
import { buildStopCommand, stopAgent } from "../src/stop.js";
import type { CommandRunner } from "../src/collectors/liveness.js";
import type { Agent } from "../src/types.js";

const SESSION = "air-team";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function agent(over: Partial<Agent> & Pick<Agent, "name">): Agent {
  return {
    kind: "claude",
    workdir: "/w",
    alive: true,
    last_seen: 100,
    current_activity: null,
    ...over,
  };
}

/** A runner that always succeeds, recording every argv it was handed. */
function okRunner(): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (argv: string[]) => {
    calls.push(argv);
    return "";
  }) as CommandRunner & { calls: string[][] };
  run.calls = calls;
  return run;
}

/** A runner that always throws, as tmux would when its server is not running. */
function failingRunner(
  message = "no server running on /tmp/tmux-1000/default",
): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (argv: string[]) => {
    calls.push(argv);
    throw new Error(message);
  }) as CommandRunner & { calls: string[][] };
  run.calls = calls;
  return run;
}

/** A runner that must never be invoked; any call fails the test loudly. */
function forbiddenRunner(): CommandRunner {
  return (async () => {
    throw new Error("runner must not be called");
  }) as CommandRunner;
}

const KILL_VERBS = ["kill-window", "kill-session", "kill-server", "kill-pane"];

// ---------------------------------------------------------------------------
// Unit 1 — buildStopCommand (PURE)
// ---------------------------------------------------------------------------

describe("buildStopCommand", () => {
  it("returns exactly the send-keys C-c interrupt argv", () => {
    expect(buildStopCommand(SESSION, "payments")).toEqual([
      "tmux",
      "send-keys",
      "-t",
      "air-team:payments",
      "C-c",
    ]);
  });

  it("is a 5-element argv array of strings", () => {
    const argv = buildStopCommand(SESSION, "payments");
    expect(Array.isArray(argv)).toBe(true);
    expect(argv).toHaveLength(5);
    for (const part of argv) expect(typeof part).toBe("string");
    expect(argv[0]).toBe("tmux");
    expect(argv[1]).toBe("send-keys");
  });

  it("NEVER contains a kill verb (interrupt, never kill)", () => {
    // Try a spread of session/window names, including ones that literally
    // spell a kill verb: the verb is a hardcoded literal, so nothing a caller
    // passes can turn this into a destructive command.
    const names = [
      "payments",
      "kill-window",
      "kill-session",
      "kill-server",
      "kill-pane",
      "; tmux kill-server",
    ];
    for (const session of names) {
      for (const window of names) {
        const argv = buildStopCommand(session, window);
        // The verb slot is send-keys and only send-keys.
        expect(argv[1]).toBe("send-keys");
        // A kill verb only ever appears embedded INSIDE the single target
        // element, never as its own argv element that tmux would execute.
        for (const verb of KILL_VERBS) {
          expect(argv).not.toContain(verb);
        }
      }
    }
  });

  it("packs the target session:window into a SINGLE argv element", () => {
    // Odd characters — spaces, a semicolon, tmux-flag-looking text — must not
    // split into extra argv elements a shell or tmux could reinterpret.
    const hostile = "-t x; rm -rf / --now";
    const argv = buildStopCommand(SESSION, hostile);
    expect(argv).toHaveLength(5);
    expect(argv[3]).toBe(`air-team:${hostile}`);
    // The hostile text is exactly one element; no element equals a bare flag
    // that was split out of it.
    expect(argv.filter((p) => p === "-t")).toHaveLength(1); // only our own -t
    expect(argv[2]).toBe("-t");
  });

  it("produces a well-formed 5-element argv for empty or odd names", () => {
    for (const [s, w] of [
      ["", ""],
      ["", "payments"],
      ["air-team", ""],
      ["a b", "c d"],
      ["s\t", "w\n"],
    ]) {
      const argv = buildStopCommand(s, w);
      expect(argv).toHaveLength(5);
      expect(argv[0]).toBe("tmux");
      expect(argv[1]).toBe("send-keys");
      expect(argv[2]).toBe("-t");
      expect(argv[3]).toBe(`${s}:${w}`);
      expect(argv[4]).toBe("C-c");
    }
  });
});

// ---------------------------------------------------------------------------
// Unit 2 — stopAgent (adapter, runner INJECTED)
// ---------------------------------------------------------------------------

describe("stopAgent", () => {
  it("refuses an unknown agent: no runner call, no event written", async () => {
    const db = makeDb();
    const runner = okRunner();

    const res = await stopAgent(db, "ghost", {
      session: SESSION,
      runner,
      now: () => 1_234,
    });

    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe("string");
    expect(res.error!.length).toBeGreaterThan(0);
    // A Stop must target a known agent — nothing ran, nothing was audited.
    expect(runner.calls).toHaveLength(0);
    expect(listEvents(db, {})).toHaveLength(0);
  });

  it("does not even build a command for an unknown agent", async () => {
    const db = makeDb();
    // A runner that would fail the test if touched.
    const res = await stopAgent(db, "ghost", {
      session: SESSION,
      runner: forbiddenRunner(),
      now: () => 1,
    });
    expect(res.ok).toBe(false);
  });

  it("interrupts a known agent with the exact argv and audits once", async () => {
    const db = makeDb();
    upsertAgent(db, agent({ name: "payments" }));
    const runner = okRunner();

    const res = await stopAgent(db, "payments", {
      actor: "Amirreza",
      session: SESSION,
      runner,
      now: () => 4_242,
    });

    expect(res.ok).toBe(true);
    // Exactly the interrupt command from the pure builder — never hand-rolled.
    expect(runner.calls).toEqual([buildStopCommand(SESSION, "payments")]);
    expect(runner.calls[0]).toEqual([
      "tmux",
      "send-keys",
      "-t",
      "air-team:payments",
      "C-c",
    ]);

    // Exactly one audit row, of the success type, with actor + server ts.
    const events = listEvents(db, {});
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e.type).toBe("agent_stopped");
    expect(e.agent).toBe("payments");
    expect(e.ts).toBe(4_242);
    expect(e.payload).toMatchObject({ actor: "Amirreza" });
    expect(typeof e.id).toBe("string");
    expect(e.id.length).toBeGreaterThan(0);
  });

  it("defaults the actor to 'web' when none is supplied", async () => {
    const db = makeDb();
    upsertAgent(db, agent({ name: "payments" }));

    await stopAgent(db, "payments", {
      session: SESSION,
      runner: okRunner(),
      now: () => 1,
    });

    const [e] = listEvents(db, {});
    expect(e.payload).toMatchObject({ actor: "web" });
  });

  it("returns the created audit event so the route can broadcast it", async () => {
    const db = makeDb();
    upsertAgent(db, agent({ name: "payments" }));

    const res = await stopAgent(db, "payments", {
      session: SESSION,
      runner: okRunner(),
      now: () => 7,
    });

    expect(res.ok).toBe(true);
    expect(res.event).toBeDefined();
    expect(res.event!.type).toBe("agent_stopped");
    expect(res.event!.agent).toBe("payments");
    // The returned event is the very row that was persisted.
    const [stored] = listEvents(db, {});
    expect(res.event!.id).toBe(stored.id);
  });

  it("allows interrupting a known-but-not-alive agent", async () => {
    // Decision: ALLOW. `alive:false` only means the last liveness poll did not
    // see the window — it may be stale, and C-c at an idle prompt is harmless
    // (it just clears the current line). Refusing could block a legitimate
    // Stop of an agent that is actually running but whose poll lagged.
    const db = makeDb();
    upsertAgent(db, agent({ name: "payments", alive: false }));
    const runner = okRunner();

    const res = await stopAgent(db, "payments", {
      session: SESSION,
      runner,
      now: () => 9,
    });

    expect(res.ok).toBe(true);
    expect(runner.calls).toEqual([buildStopCommand(SESSION, "payments")]);
    const [e] = listEvents(db, {});
    expect(e.type).toBe("agent_stopped");
  });

  it("a runner that throws does NOT throw out, returns an error, writes no success row", async () => {
    const db = makeDb();
    upsertAgent(db, agent({ name: "payments" }));
    const runner = failingRunner();

    // Must not reject.
    const res = await stopAgent(db, "payments", {
      session: SESSION,
      runner,
      now: () => 5,
    });

    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe("string");
    expect(res.error!.length).toBeGreaterThan(0);

    // No row may claim the stop succeeded.
    const events = listEvents(db, {});
    for (const e of events) {
      expect(e.type).not.toBe("agent_stopped");
    }
  });

  it("records the failed attempt as a clearly-failure event, never 'agent_stopped'", async () => {
    // Decision: we DO audit a failed attempt (someone tried to Stop while tmux
    // was down is worth recording) — but under a distinct failure type so it
    // can never be mistaken for a successful interrupt.
    const db = makeDb();
    upsertAgent(db, agent({ name: "payments" }));

    await stopAgent(db, "payments", {
      actor: "Amirreza",
      session: SESSION,
      runner: failingRunner(),
      now: () => 6,
    });

    const events = listEvents(db, {});
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e.type).toBe("agent_stop_failed");
    expect(e.agent).toBe("payments");
    expect(e.ts).toBe(6);
    expect(e.payload).toMatchObject({ actor: "Amirreza" });
  });

  it("writes exactly one audit row per successful call and none on the unknown path", async () => {
    const db = makeDb();
    upsertAgent(db, agent({ name: "payments" }));

    await stopAgent(db, "payments", { session: SESSION, runner: okRunner(), now: () => 1 });
    await stopAgent(db, "payments", { session: SESSION, runner: okRunner(), now: () => 2 });
    await stopAgent(db, "ghost", { session: SESSION, runner: okRunner(), now: () => 3 });

    const stopped = listEvents(db, {}).filter((e) => e.type === "agent_stopped");
    expect(stopped).toHaveLength(2);
  });
});
