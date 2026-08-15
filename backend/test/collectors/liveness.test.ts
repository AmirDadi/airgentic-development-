import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { migrate, listAgents, upsertAgent } from "../../src/db";
import { buildListWindowsCommand, TMUX_WINDOW_FORMAT, FIELD_SEP } from "../../src/tmux";
import {
  collectLiveness,
  type CommandRunner,
} from "../../src/collectors/liveness";
import type { Agent } from "../../src/types";

const SESSION = "air-team";

/** Builds one line of `tmux list-windows -F TMUX_WINDOW_FORMAT` output. */
function line(
  index: number,
  name: string,
  active = false,
  command = "node",
): string {
  return [index, name, active ? 1 : 0, command].join(FIELD_SEP);
}

/** A runner that always succeeds with the given stdout, recording its argv. */
function okRunner(stdout: string): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (argv: string[]) => {
    calls.push(argv);
    return stdout;
  }) as CommandRunner & { calls: string[][] };
  run.calls = calls;
  return run;
}

/** A runner that always rejects, as tmux would when it isn't installed. */
function failingRunner(
  message = "tmux: command not found",
): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (argv: string[]) => {
    calls.push(argv);
    throw new Error(message);
  }) as CommandRunner & { calls: string[][] };
  run.calls = calls;
  return run;
}

/** A clock we can wind forward by hand. */
function clock(start = 1_000): { now: () => number; set: (t: number) => void } {
  let t = start;
  return { now: () => t, set: (next: number) => (t = next) };
}

function byName(db: Database.Database, name: string): Agent | undefined {
  return listAgents(db).find((a) => a.name === name);
}

describe("collectLiveness", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
  });

  describe("command invocation", () => {
    it("calls the runner with exactly the argv from buildListWindowsCommand", async () => {
      const runner = okRunner("");
      await collectLiveness(db, { session: SESSION, runner, now: () => 1 });

      expect(runner.calls).toHaveLength(1);
      expect(runner.calls[0]).toEqual(buildListWindowsCommand(SESSION));
      // Sanity: it really is the read-only tmux listing, with our format.
      expect(runner.calls[0]).toContain(TMUX_WINDOW_FORMAT);
    });

    it("passes the configured session through", async () => {
      const runner = okRunner("");
      await collectLiveness(db, {
        session: "other-session",
        runner,
        now: () => 1,
      });
      expect(runner.calls[0]).toEqual(buildListWindowsCommand("other-session"));
    });

    it("polls tmux exactly once per cycle", async () => {
      const runner = okRunner(line(0, "payments"));
      await collectLiveness(db, { session: SESSION, runner, now: () => 1 });
      await collectLiveness(db, { session: SESSION, runner, now: () => 2 });
      expect(runner.calls).toHaveLength(2);
    });
  });

  describe("windows present in tmux", () => {
    it("upserts each window as an alive agent with last_seen = now()", async () => {
      const runner = okRunner(
        [line(0, "payments", true), line(1, "search")].join("\n"),
      );
      await collectLiveness(db, { session: SESSION, runner, now: () => 5_000 });

      const agents = listAgents(db);
      expect(agents.map((a) => a.name)).toEqual(["payments", "search"]);
      for (const a of agents) {
        expect(a.alive).toBe(true);
        expect(a.last_seen).toBe(5_000);
      }
    });

    it("uses the window name as the agent name", async () => {
      const runner = okRunner(line(3, "web-lead"));
      await collectLiveness(db, { session: SESSION, runner, now: () => 1 });
      expect(byName(db, "web-lead")).toBeDefined();
    });

    it("leaves current_activity null for agents it discovers", async () => {
      const runner = okRunner(line(0, "payments"));
      await collectLiveness(db, { session: SESSION, runner, now: () => 1 });
      expect(byName(db, "payments")?.current_activity).toBeNull();
    });
  });

  describe("agents that disappear from tmux", () => {
    it("marks a known agent dead when it is no longer listed", async () => {
      const c = clock(1_000);
      await collectLiveness(db, {
        session: SESSION,
        runner: okRunner(line(0, "payments")),
        now: c.now,
      });
      expect(byName(db, "payments")?.alive).toBe(true);

      c.set(9_999);
      await collectLiveness(db, {
        session: SESSION,
        runner: okRunner(line(0, "search")),
        now: c.now,
      });

      expect(byName(db, "payments")?.alive).toBe(false);
      expect(byName(db, "search")?.alive).toBe(true);
    });

    it("PRESERVES last_seen for a dead agent (that is the 'dead since' stamp)", async () => {
      const c = clock(1_000);
      await collectLiveness(db, {
        session: SESSION,
        runner: okRunner(line(0, "payments")),
        now: c.now,
      });

      c.set(9_999);
      await collectLiveness(db, {
        session: SESSION,
        runner: okRunner(""),
        now: c.now,
      });

      expect(byName(db, "payments")?.last_seen).toBe(1_000);
    });

    it("does not bump last_seen on repeated polls while an agent stays dead", async () => {
      const c = clock(1_000);
      await collectLiveness(db, {
        session: SESSION,
        runner: okRunner(line(0, "payments")),
        now: c.now,
      });
      c.set(2_000);
      await collectLiveness(db, {
        session: SESSION,
        runner: okRunner(""),
        now: c.now,
      });
      c.set(3_000);
      await collectLiveness(db, {
        session: SESSION,
        runner: okRunner(""),
        now: c.now,
      });

      const a = byName(db, "payments");
      expect(a?.alive).toBe(false);
      expect(a?.last_seen).toBe(1_000);
    });

    it("brings a reappearing agent back alive with a fresh last_seen", async () => {
      const c = clock(1_000);
      await collectLiveness(db, {
        session: SESSION,
        runner: okRunner(line(0, "payments")),
        now: c.now,
      });
      c.set(2_000);
      await collectLiveness(db, {
        session: SESSION,
        runner: okRunner(""),
        now: c.now,
      });
      expect(byName(db, "payments")?.alive).toBe(false);

      c.set(7_500);
      await collectLiveness(db, {
        session: SESSION,
        runner: okRunner(line(0, "payments")),
        now: c.now,
      });

      const a = byName(db, "payments");
      expect(a?.alive).toBe(true);
      expect(a?.last_seen).toBe(7_500);
    });
  });

  describe("repeated polls with unchanged output", () => {
    it("never creates duplicate rows", async () => {
      const stdout = [line(0, "payments"), line(1, "search")].join("\n");
      const c = clock(1_000);
      for (const t of [1_000, 2_000, 3_000]) {
        c.set(t);
        await collectLiveness(db, {
          session: SESSION,
          runner: okRunner(stdout),
          now: c.now,
        });
      }

      const agents = listAgents(db);
      expect(agents).toHaveLength(2);
      expect(agents.map((a) => a.name)).toEqual(["payments", "search"]);
    });

    it("advances last_seen for agents that stay live", async () => {
      const stdout = line(0, "payments");
      const c = clock(1_000);
      await collectLiveness(db, {
        session: SESSION,
        runner: okRunner(stdout),
        now: c.now,
      });
      c.set(4_000);
      await collectLiveness(db, {
        session: SESSION,
        runner: okRunner(stdout),
        now: c.now,
      });

      expect(byName(db, "payments")?.last_seen).toBe(4_000);
    });
  });

  describe("a FAILED poll (runner throws)", () => {
    it("does not throw out of collectLiveness", async () => {
      await expect(
        collectLiveness(db, {
          session: SESSION,
          runner: failingRunner(),
          now: () => 1,
        }),
      ).resolves.toBeUndefined();
    });

    it("leaves existing rows completely untouched — a live agent stays live", async () => {
      const c = clock(1_000);
      await collectLiveness(db, {
        session: SESSION,
        runner: okRunner(line(0, "payments")),
        now: c.now,
      });

      c.set(9_999);
      await collectLiveness(db, {
        session: SESSION,
        runner: failingRunner("no server running on /tmp/tmux-0/default"),
        now: c.now,
      });

      const a = byName(db, "payments");
      expect(a?.alive).toBe(true);
      // Neither marked dead nor refreshed: a failed poll carries no evidence.
      expect(a?.last_seen).toBe(1_000);
    });

    it("does not resurrect an already-dead agent", async () => {
      const c = clock(1_000);
      await collectLiveness(db, {
        session: SESSION,
        runner: okRunner(line(0, "payments")),
        now: c.now,
      });
      c.set(2_000);
      await collectLiveness(db, {
        session: SESSION,
        runner: okRunner(""),
        now: c.now,
      });
      c.set(3_000);
      await collectLiveness(db, {
        session: SESSION,
        runner: failingRunner(),
        now: c.now,
      });

      const a = byName(db, "payments");
      expect(a?.alive).toBe(false);
      expect(a?.last_seen).toBe(1_000);
    });

    it("creates no rows at all when the very first poll fails", async () => {
      await collectLiveness(db, {
        session: SESSION,
        runner: failingRunner(),
        now: () => 1,
      });
      expect(listAgents(db)).toEqual([]);
    });

    it("survives a runner that rejects with a non-Error value", async () => {
      const runner: CommandRunner = async () => {
        throw "boom";
      };
      await expect(
        collectLiveness(db, { session: SESSION, runner, now: () => 1 }),
      ).resolves.toBeUndefined();
    });

    it("recovers on the next successful poll", async () => {
      const c = clock(1_000);
      await collectLiveness(db, {
        session: SESSION,
        runner: failingRunner(),
        now: c.now,
      });
      c.set(2_000);
      await collectLiveness(db, {
        session: SESSION,
        runner: okRunner(line(0, "payments")),
        now: c.now,
      });

      const a = byName(db, "payments");
      expect(a?.alive).toBe(true);
      expect(a?.last_seen).toBe(2_000);
    });
  });

  describe("an EMPTY poll (success, zero windows) differs from a failed poll", () => {
    it("marks every known agent dead", async () => {
      const c = clock(1_000);
      await collectLiveness(db, {
        session: SESSION,
        runner: okRunner([line(0, "payments"), line(1, "search")].join("\n")),
        now: c.now,
      });

      c.set(2_000);
      await collectLiveness(db, {
        session: SESSION,
        runner: okRunner(""),
        now: c.now,
      });

      const agents = listAgents(db);
      expect(agents).toHaveLength(2);
      expect(agents.every((a) => a.alive === false)).toBe(true);
      expect(agents.every((a) => a.last_seen === 1_000)).toBe(true);
    });

    it("treats whitespace-only stdout as an empty (successful) poll", async () => {
      const c = clock(1_000);
      await collectLiveness(db, {
        session: SESSION,
        runner: okRunner(line(0, "payments")),
        now: c.now,
      });
      c.set(2_000);
      await collectLiveness(db, {
        session: SESSION,
        runner: okRunner("\n  \n"),
        now: c.now,
      });

      expect(byName(db, "payments")?.alive).toBe(false);
    });

    it("empty poll kills, failed poll does not — same DB, same clock", async () => {
      const setup = () => {
        const fresh = new Database(":memory:");
        migrate(fresh);
        return fresh;
      };

      const dbEmpty = setup();
      const dbFailed = setup();
      for (const target of [dbEmpty, dbFailed]) {
        await collectLiveness(target, {
          session: SESSION,
          runner: okRunner(line(0, "payments")),
          now: () => 1_000,
        });
      }

      await collectLiveness(dbEmpty, {
        session: SESSION,
        runner: okRunner(""),
        now: () => 2_000,
      });
      await collectLiveness(dbFailed, {
        session: SESSION,
        runner: failingRunner(),
        now: () => 2_000,
      });

      expect(byName(dbEmpty, "payments")?.alive).toBe(false);
      expect(byName(dbFailed, "payments")?.alive).toBe(true);
    });

    it("creates no rows when tmux reports no windows and we know nobody", async () => {
      await collectLiveness(db, {
        session: SESSION,
        runner: okRunner(""),
        now: () => 1,
      });
      expect(listAgents(db)).toEqual([]);
    });
  });

  describe("fields owned by other collectors", () => {
    it("does not clobber a current_activity set by another collector", async () => {
      upsertAgent(db, {
        name: "payments",
        kind: "claude",
        workdir: "/work/payments",
        alive: false,
        last_seen: 500,
        current_activity: "editing src/pay.ts",
      });

      await collectLiveness(db, {
        session: SESSION,
        runner: okRunner(line(0, "payments")),
        now: () => 6_000,
      });

      const a = byName(db, "payments");
      expect(a?.current_activity).toBe("editing src/pay.ts");
      expect(a?.alive).toBe(true);
      expect(a?.last_seen).toBe(6_000);
    });

    it("preserves current_activity when marking an agent dead", async () => {
      upsertAgent(db, {
        name: "payments",
        kind: "claude",
        workdir: "/work/payments",
        alive: true,
        last_seen: 500,
        current_activity: "waiting on review",
      });

      await collectLiveness(db, {
        session: SESSION,
        runner: okRunner(""),
        now: () => 6_000,
      });

      const a = byName(db, "payments");
      expect(a?.current_activity).toBe("waiting on review");
      expect(a?.alive).toBe(false);
      expect(a?.last_seen).toBe(500);
    });

    it("does not overwrite a previously-known non-empty workdir", async () => {
      upsertAgent(db, {
        name: "payments",
        kind: "claude",
        workdir: "/work/payments",
        alive: false,
        last_seen: 500,
        current_activity: null,
      });

      await collectLiveness(db, {
        session: SESSION,
        runner: okRunner(line(0, "payments")),
        now: () => 6_000,
      });

      expect(byName(db, "payments")?.workdir).toBe("/work/payments");
    });

    it("uses a stable placeholder workdir for agents it discovers first", async () => {
      const runner = okRunner(line(0, "payments"));
      await collectLiveness(db, { session: SESSION, runner, now: () => 1 });
      const first = byName(db, "payments")?.workdir;
      expect(typeof first).toBe("string");

      await collectLiveness(db, {
        session: SESSION,
        runner: okRunner(line(0, "payments")),
        now: () => 2,
      });
      // Stable across polls — it must not flap between values.
      expect(byName(db, "payments")?.workdir).toBe(first);
    });

    it("records a non-empty kind for a discovered agent", async () => {
      await collectLiveness(db, {
        session: SESSION,
        runner: okRunner(line(0, "payments", true, "claude")),
        now: () => 1,
      });
      expect(byName(db, "payments")?.kind).toBeTruthy();
    });

    it("does not overwrite a known kind when tmux reports no pane command", async () => {
      upsertAgent(db, {
        name: "payments",
        kind: "claude",
        workdir: "/work/payments",
        alive: false,
        last_seen: 500,
        current_activity: null,
      });

      // Format still emits the tab-separated fields; the command field is empty.
      await collectLiveness(db, {
        session: SESSION,
        runner: okRunner(["0","payments","1",""].join(FIELD_SEP)),
        now: () => 6_000,
      });

      expect(byName(db, "payments")?.kind).toBe("claude");
    });
  });

  describe("tolerance of odd tmux output", () => {
    it("skips malformed lines but keeps the good ones", async () => {
      const runner = okRunner(
        ["this is not a window", line(1, "search"), ""].join("\n"),
      );
      await collectLiveness(db, { session: SESSION, runner, now: () => 1 });

      expect(listAgents(db).map((a) => a.name)).toEqual(["search"]);
    });

    it("handles a window listed twice without duplicating rows", async () => {
      const runner = okRunner([line(0, "payments"), line(1, "payments")].join("\n"));
      await collectLiveness(db, { session: SESSION, runner, now: () => 1 });
      expect(listAgents(db)).toHaveLength(1);
    });
  });
});
