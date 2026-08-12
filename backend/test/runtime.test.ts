import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate, listAgents, listFeatures, listMessages } from "../src/db";
import { createSseHub } from "../src/sse";
import { buildApp } from "../src/app";
import { createRuntime } from "../src/runtime";
import type { RuntimeOptions } from "../src/runtime";

let db: Database.Database;
let dir: string;

beforeEach(async () => {
  db = new Database(":memory:");
  migrate(db);
  dir = await mkdtemp(join(tmpdir(), "runtime-test-"));
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

interface Broadcast {
  event: string;
  data: unknown;
}

/** Records every broadcast; no sockets, no real hub semantics needed. */
function fakeHub(): { hub: RuntimeOptions["hub"]; sent: Broadcast[] } {
  const sent: Broadcast[] = [];
  return {
    sent,
    hub: {
      subscribe: () => () => undefined,
      broadcast: (event, data) => {
        sent.push({ event, data });
      },
      subscriberCount: () => 0,
    },
  };
}

interface FakeTimer {
  id: number;
  ms: number;
  fn: () => void;
  unrefCalls: number;
  cleared: boolean;
}

/** setInterval/clearInterval stand-ins: nothing is ever really scheduled. */
function fakeTimers(): {
  timers: FakeTimer[];
  setIntervalFn: typeof setInterval;
  clearIntervalFn: typeof clearInterval;
} {
  const timers: FakeTimer[] = [];
  let next = 1;

  const setIntervalFn = ((fn: () => void, ms: number) => {
    const timer: FakeTimer = {
      id: next++,
      ms,
      fn,
      unrefCalls: 0,
      cleared: false,
    };
    timers.push(timer);
    return {
      unref() {
        timer.unrefCalls += 1;
        return this;
      },
      __timer: timer,
    };
  }) as unknown as typeof setInterval;

  const clearIntervalFn = ((handle: { __timer?: FakeTimer }) => {
    if (handle?.__timer) handle.__timer.cleared = true;
  }) as unknown as typeof clearInterval;

  return { timers, setIntervalFn, clearIntervalFn };
}

/** tmux stdout for one window per agent name. */
function tmuxOutput(names: string[]): string {
  return names.map((n, i) => `${i}\t${n}\t${i === 0 ? 1 : 0}\tnode`).join("\n");
}

/** One assistant `tool_use: SendMessage` line — an OUTBOUND message. */
function sentLine(recipient: string, message: string, ts: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_x",
          name: "SendMessage",
          input: { recipient, message },
        },
      ],
    },
  });
}

/** Fully injected options: no tmux, no git, no real timers, no clock. */
function baseOptions(
  hub: RuntimeOptions["hub"],
  overrides: Partial<RuntimeOptions> = {},
): RuntimeOptions {
  return {
    hub,
    session: "agents",
    specsDir: dir,
    runner: async () => tmuxOutput(["lead"]),
    listBranches: async () => [],
    listPrs: async () => ({}),
    now: () => 1_000,
    ...overrides,
  };
}

describe("createRuntime", () => {
  describe("tick", () => {
    it("runs all three collectors and writes their rows", async () => {
      const { hub } = fakeHub();
      const transcript = join(dir, "lead.jsonl");
      await writeFile(
        transcript,
        sentLine("payments", "ship it", "2024-01-01T00:00:00.000Z") + "\n",
        "utf8",
      );
      await writeFile(join(dir, "checkout.spec.md"), "# checkout\n");

      const runtime = createRuntime(
        db,
        baseOptions(hub, {
          sources: [{ agent: "lead", path: transcript, sessionId: "s1" }],
        }),
      );

      await runtime.tick();

      // liveness
      const agents = listAgents(db);
      expect(agents.map((a) => a.name)).toEqual(["lead"]);
      expect(agents[0].alive).toBe(true);
      expect(agents[0].last_seen).toBe(1_000);
      // pipeline
      expect(listFeatures(db).map((f) => f.name)).toEqual(["checkout"]);
      // transcript
      const messages = listMessages(db, {});
      expect(messages).toHaveLength(1);
      expect(messages[0].from_agent).toBe("lead");
      expect(messages[0].to_agent).toBe("payments");
    });

    it("broadcasts on the agents/features/messages channels", async () => {
      const { hub, sent } = fakeHub();
      await writeFile(join(dir, "checkout.spec.md"), "# checkout\n");

      const runtime = createRuntime(db, baseOptions(hub));
      await runtime.tick();

      expect(sent.map((b) => b.event).sort()).toEqual([
        "agents",
        "features",
        "messages",
      ]);

      const agentsPayload = sent.find((b) => b.event === "agents")?.data;
      expect(agentsPayload).toEqual(listAgents(db));

      const featuresPayload = sent.find((b) => b.event === "features")?.data;
      expect(featuresPayload).toEqual(listFeatures(db));
    });

    it("broadcasts threads (not raw rows) on the messages channel", async () => {
      const { hub, sent } = fakeHub();
      const transcript = join(dir, "lead.jsonl");
      await writeFile(
        transcript,
        sentLine("payments", "hello", "2024-01-01T00:00:00.000Z") + "\n",
        "utf8",
      );

      const runtime = createRuntime(
        db,
        baseOptions(hub, {
          sources: [{ agent: "lead", path: transcript, sessionId: "s1" }],
        }),
      );
      await runtime.tick();

      const threads = sent.find((b) => b.event === "messages")?.data as Array<{
        id: string;
        participants: [string, string];
      }>;
      expect(threads).toHaveLength(1);
      expect(threads[0].id).toBe("lead|payments");
      expect(threads[0].participants).toEqual(["lead", "payments"]);
    });

    it("does not re-broadcast a channel whose data has not changed", async () => {
      const { hub, sent } = fakeHub();
      await writeFile(join(dir, "checkout.spec.md"), "# checkout\n");

      const runtime = createRuntime(db, baseOptions(hub));
      await runtime.tick();
      await runtime.tick();

      const counts = sent.reduce<Record<string, number>>((acc, b) => {
        acc[b.event] = (acc[b.event] ?? 0) + 1;
        return acc;
      }, {});
      expect(counts).toEqual({ agents: 1, features: 1, messages: 1 });
    });

    it("ignores poll-clock churn: a moving updated_at/last_seen is not a change", async () => {
      const { hub, sent } = fakeHub();
      await writeFile(join(dir, "checkout.spec.md"), "# checkout\n");

      // Every collector pass stamps now() into features.updated_at and
      // agents.last_seen, so a naive whole-row diff would fire every poll.
      let clock = 1_000;
      const runtime = createRuntime(
        db,
        baseOptions(hub, {
          now: () => {
            clock += 1_000;
            return clock;
          },
        }),
      );
      await runtime.tick();
      await runtime.tick();
      await runtime.tick();

      expect(sent.filter((b) => b.event === "features")).toHaveLength(1);
      expect(sent.filter((b) => b.event === "agents")).toHaveLength(1);
    });

    it("broadcasts again once the data really changes", async () => {
      const { hub, sent } = fakeHub();
      let windows = ["lead"];

      const runtime = createRuntime(
        db,
        baseOptions(hub, { runner: async () => tmuxOutput(windows) }),
      );
      await runtime.tick();
      windows = ["lead", "payments"];
      await runtime.tick();

      const agentBroadcasts = sent.filter((b) => b.event === "agents");
      expect(agentBroadcasts).toHaveLength(2);
      expect((agentBroadcasts[1].data as Array<{ name: string }>).map((a) => a.name))
        .toEqual(["lead", "payments"]);
    });

    it("keeps going when one collector throws", async () => {
      const { hub, sent } = fakeHub();
      await writeFile(join(dir, "checkout.spec.md"), "# checkout\n");

      const runtime = createRuntime(
        db,
        baseOptions(hub, {
          // liveness swallows runner failures itself, so break pipeline instead.
          listBranches: async () => {
            throw new Error("git exploded");
          },
        }),
      );

      await expect(runtime.tick()).resolves.toBeUndefined();

      // pipeline died, but liveness still reconciled the roster.
      expect(listAgents(db).map((a) => a.name)).toEqual(["lead"]);
      expect(listFeatures(db)).toEqual([]);
      expect(sent.some((b) => b.event === "agents")).toBe(true);
    });

    it("never rejects when the hub itself throws", async () => {
      const runtime = createRuntime(
        db,
        baseOptions({
          subscribe: () => () => undefined,
          broadcast: () => {
            throw new Error("bad sink");
          },
          subscriberCount: () => 0,
        }),
      );

      await expect(runtime.tick()).resolves.toBeUndefined();
    });
  });

  describe("start/stop", () => {
    it("schedules one unref'd timer per collector", () => {
      const { hub } = fakeHub();
      const { timers, setIntervalFn, clearIntervalFn } = fakeTimers();

      const runtime = createRuntime(
        db,
        baseOptions(hub, {
          intervalMs: { liveness: 11, pipeline: 22, transcript: 33 },
          setIntervalFn,
          clearIntervalFn,
        }),
      );
      runtime.start();

      expect(timers.map((t) => t.ms).sort((a, b) => a - b)).toEqual([11, 22, 33]);
      expect(timers.every((t) => t.unrefCalls === 1)).toBe(true);
    });

    it("runs an immediate pass so the board is not empty until the first interval", async () => {
      const { hub, sent } = fakeHub();
      const { setIntervalFn, clearIntervalFn } = fakeTimers();
      await writeFile(join(dir, "checkout.spec.md"), "# checkout\n");

      const runtime = createRuntime(
        db,
        baseOptions(hub, { setIntervalFn, clearIntervalFn }),
      );
      runtime.start();

      // No fake timer is ever fired here: only the kick-off pass can do this.
      await vi.waitFor(() => {
        expect(listFeatures(db).map((f) => f.name)).toEqual(["checkout"]);
        expect(listAgents(db).map((a) => a.name)).toEqual(["lead"]);
        expect(sent.some((b) => b.event === "features")).toBe(true);
      });
      runtime.stop();
    });

    it("stop() clears every timer", () => {
      const { hub } = fakeHub();
      const { timers, setIntervalFn, clearIntervalFn } = fakeTimers();

      const runtime = createRuntime(
        db,
        baseOptions(hub, { setIntervalFn, clearIntervalFn }),
      );
      runtime.start();
      runtime.stop();

      expect(timers).toHaveLength(3);
      expect(timers.every((t) => t.cleared)).toBe(true);
    });

    it("start() is idempotent and stop() is safe before start", () => {
      const { hub } = fakeHub();
      const { timers, setIntervalFn, clearIntervalFn } = fakeTimers();

      const runtime = createRuntime(
        db,
        baseOptions(hub, { setIntervalFn, clearIntervalFn }),
      );
      expect(() => runtime.stop()).not.toThrow();
      runtime.start();
      runtime.start();
      expect(timers).toHaveLength(3);
      runtime.stop();
    });

    it("a scheduled tick that throws does not stop the scheduler", async () => {
      const { hub } = fakeHub();
      const { timers, setIntervalFn, clearIntervalFn } = fakeTimers();

      const runtime = createRuntime(
        db,
        baseOptions(hub, {
          runner: async () => {
            throw new Error("no tmux");
          },
          listBranches: async () => {
            throw new Error("no git");
          },
          setIntervalFn,
          clearIntervalFn,
        }),
      );
      runtime.start();

      for (const timer of timers) expect(() => timer.fn()).not.toThrow();
      await vi.waitFor(() => {
        expect(timers.every((t) => !t.cleared)).toBe(true);
      });
    });
  });

  describe("wiring", () => {
    it("delivers runtime broadcasts to subscribers of a hub shared with buildApp", async () => {
      const hub = createSseHub();
      const app = buildApp(db, { hub });
      const seen: Broadcast[] = [];
      hub.subscribe((event, data) => seen.push({ event, data }));

      const runtime = createRuntime(db, baseOptions(hub));
      await runtime.tick();

      expect(seen.map((b) => b.event)).toContain("agents");

      // and the same DB the app serves from now has the collected rows.
      const res = await app.inject({ method: "GET", url: "/agents" });
      expect(res.json()).toEqual([expect.objectContaining({ name: "lead" })]);
      await app.close();
    });
  });
});
