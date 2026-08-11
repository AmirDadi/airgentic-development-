import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp, rm, writeFile, appendFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, listMessages, listAgents, upsertAgent } from "../../src/db";
import {
  collectTranscripts,
  createTranscriptState,
  type TranscriptSource,
} from "../../src/collectors/transcript";
import type { Agent } from "../../src/types";

/** A credential that must never survive the redaction pass (PRD R4). */
const SECRET = "sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";

let dir: string;
let db: Database.Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "transcript-collector-"));
  db = new Database(":memory:");
  migrate(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

/** One assistant `tool_use: SendMessage` line — an OUTBOUND message. */
function sentLine(recipient: string, message: string, ts: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_x", name: "SendMessage", input: { recipient, message } },
      ],
    },
  });
}

/** One `tool_result` line carrying an INBOUND message from a peer. */
function receivedLine(from: string, message: string, ts: string): string {
  return JSON.stringify({
    type: "user",
    timestamp: ts,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_y",
          content: [{ type: "text", text: `[message from ${from}] ${message}` }],
        },
      ],
    },
  });
}

/** A plain assistant text line — no message, but it does drive activity. */
function textLine(text: string, ts: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function file(name: string): string {
  return join(dir, name);
}

async function writeLines(path: string, lines: string[]): Promise<void> {
  await writeFile(path, lines.map((l) => l + "\n").join(""), "utf8");
}

async function appendLines(path: string, lines: string[]): Promise<void> {
  await appendFile(path, lines.map((l) => l + "\n").join(""), "utf8");
}

function source(path: string, agent = "backend-dev", sessionId = "sess-1"): TranscriptSource {
  return { agent, path, sessionId };
}

function agentRow(name: string, overrides: Partial<Agent> = {}): Agent {
  return {
    name,
    kind: "claude",
    workdir: "/work",
    alive: true,
    last_seen: 1000,
    current_activity: null,
    ...overrides,
  };
}

describe("collectTranscripts", () => {
  describe("message extraction", () => {
    it("stores one row per SendMessage with both directions attributed", async () => {
      const path = file("a.jsonl");
      await writeLines(path, [
        sentLine("frontend-lead", "Interfaces are frozen.", "2026-08-11T10:00:00.000Z"),
        receivedLine("qa-bot", "Tests are green.", "2026-08-11T10:01:00.000Z"),
      ]);

      const state = createTranscriptState();
      await collectTranscripts(db, [source(path)], state);

      const rows = listMessages(db, {});
      expect(rows).toHaveLength(2);

      const sent = rows.find((r) => r.body.includes("Interfaces are frozen"));
      expect(sent).toBeDefined();
      expect(sent!.from_agent).toBe("backend-dev");
      expect(sent!.to_agent).toBe("frontend-lead");
      expect(sent!.session_id).toBe("sess-1");
      expect(sent!.ts).toBe(Date.parse("2026-08-11T10:00:00.000Z"));
      expect(sent!.channel).toBe("inter_agent");

      const received = rows.find((r) => r.body.includes("Tests are green"));
      expect(received).toBeDefined();
      expect(received!.from_agent).toBe("qa-bot");
      expect(received!.to_agent).toBe("backend-dev");
      expect(received!.session_id).toBe("sess-1");
      expect(received!.ts).toBe(Date.parse("2026-08-11T10:01:00.000Z"));
    });

    it("stores bodies REDACTED — a credential never reaches the DB (PRD R4)", async () => {
      const path = file("secret.jsonl");
      await writeLines(path, [
        sentLine("frontend-lead", `deploy with ${SECRET} please`, "2026-08-11T10:00:00.000Z"),
        receivedLine("qa-bot", `mine is ${SECRET} too`, "2026-08-11T10:00:10.000Z"),
      ]);

      await collectTranscripts(db, [source(path)], createTranscriptState());

      const rows = listMessages(db, {});
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.body).not.toContain(SECRET);
        expect(row.body).toContain("[REDACTED:");
      }

      // Nothing anywhere in the table carries the raw secret.
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain(SECRET);
    });

    it("redacts the derived activity too", async () => {
      const path = file("secret-activity.jsonl");
      await writeLines(path, [textLine(`token is ${SECRET}`, "2026-08-11T10:00:00.000Z")]);
      upsertAgent(db, agentRow("backend-dev"));

      await collectTranscripts(db, [source(path)], createTranscriptState());

      const activity = listAgents(db)[0].current_activity ?? "";
      expect(activity).not.toContain(SECRET);
    });

    it("an empty file yields no messages and does not throw", async () => {
      const path = file("empty.jsonl");
      await writeFile(path, "", "utf8");

      const state = createTranscriptState();
      await expect(collectTranscripts(db, [source(path)], state)).resolves.toBeUndefined();
      expect(listMessages(db, {})).toHaveLength(0);
    });
  });

  describe("stable ids", () => {
    it("re-reading the same file from a fresh state produces identical rows", async () => {
      const path = file("stable.jsonl");
      await writeLines(path, [
        sentLine("frontend-lead", "one", "2026-08-11T10:00:00.000Z"),
        receivedLine("qa-bot", "two", "2026-08-11T10:00:05.000Z"),
      ]);

      await collectTranscripts(db, [source(path)], createTranscriptState());
      const first = listMessages(db, {});
      expect(first).toHaveLength(2);

      // Fresh state ⇒ the whole file is parsed again from offset 0.
      await collectTranscripts(db, [source(path)], createTranscriptState());
      const second = listMessages(db, {});

      expect(second).toEqual(first);
      expect(second).toHaveLength(2);
    });

    it("ids are not random or clock-derived — repeated runs collide by design", async () => {
      const path = file("stable2.jsonl");
      await writeLines(path, [sentLine("frontend-lead", "hello", "2026-08-11T10:00:00.000Z")]);

      await collectTranscripts(db, [source(path)], createTranscriptState());
      const idA = listMessages(db, {})[0].id;

      const other = new Database(":memory:");
      migrate(other);
      await collectTranscripts(other, [source(path)], createTranscriptState());
      const idB = listMessages(other, {})[0].id;
      other.close();

      expect(idB).toBe(idA);
      expect(idA).not.toBe("");
    });

    it("running twice with the SAME state adds nothing the second time", async () => {
      const path = file("stable3.jsonl");
      await writeLines(path, [sentLine("frontend-lead", "hello", "2026-08-11T10:00:00.000Z")]);

      const state = createTranscriptState();
      await collectTranscripts(db, [source(path)], state);
      const before = listMessages(db, {});
      await collectTranscripts(db, [source(path)], state);

      expect(listMessages(db, {})).toEqual(before);
    });
  });

  describe("backfill and incremental resume", () => {
    it("backfills the whole pre-existing history on the first sighting", async () => {
      const path = file("history.jsonl");
      const lines: string[] = [];
      for (let i = 0; i < 5; i++) {
        lines.push(sentLine("frontend-lead", `msg-${i}`, `2026-08-11T10:0${i}:00.000Z`));
      }
      await writeLines(path, lines);

      const state = createTranscriptState();
      await collectTranscripts(db, [source(path)], state);

      const rows = listMessages(db, {});
      expect(rows).toHaveLength(5);
      expect(rows.map((r) => r.body.trim())).toEqual([
        "msg-0",
        "msg-1",
        "msg-2",
        "msg-3",
        "msg-4",
      ]);
      expect(state.offsets.get(path)).toBe((await stat(path)).size);
    });

    it("resumes at the recorded offset — only new lines are added", async () => {
      const path = file("growing.jsonl");
      await writeLines(path, [sentLine("frontend-lead", "first", "2026-08-11T10:00:00.000Z")]);

      const state = createTranscriptState();
      await collectTranscripts(db, [source(path)], state);
      const afterFirst = state.offsets.get(path);
      expect(listMessages(db, {})).toHaveLength(1);

      await appendLines(path, [
        sentLine("frontend-lead", "second", "2026-08-11T10:01:00.000Z"),
        receivedLine("qa-bot", "third", "2026-08-11T10:02:00.000Z"),
      ]);
      await collectTranscripts(db, [source(path)], state);

      const rows = listMessages(db, {});
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.body.trim())).toEqual(["first", "second", "third"]);
      // No duplication of the already-consumed line.
      expect(rows.filter((r) => r.body.trim() === "first")).toHaveLength(1);
      expect(state.offsets.get(path)!).toBeGreaterThan(afterFirst!);
      expect(state.offsets.get(path)).toBe((await stat(path)).size);
    });

    it("a poll that adds no bytes changes nothing", async () => {
      const path = file("quiet.jsonl");
      await writeLines(path, [sentLine("frontend-lead", "only", "2026-08-11T10:00:00.000Z")]);

      const state = createTranscriptState();
      await collectTranscripts(db, [source(path)], state);
      const offset = state.offsets.get(path);
      await collectTranscripts(db, [source(path)], state);

      expect(listMessages(db, {})).toHaveLength(1);
      expect(state.offsets.get(path)).toBe(offset);
    });
  });

  describe("truncation / rotation", () => {
    it("restarts from 0 when the file SHRANK, instead of reading past EOF", async () => {
      const path = file("rotated.jsonl");
      await writeLines(path, [
        sentLine("frontend-lead", "old-one", "2026-08-11T10:00:00.000Z"),
        sentLine("frontend-lead", "old-two", "2026-08-11T10:01:00.000Z"),
        sentLine("frontend-lead", "old-three", "2026-08-11T10:02:00.000Z"),
      ]);

      const state = createTranscriptState();
      await collectTranscripts(db, [source(path)], state);
      const bigOffset = state.offsets.get(path)!;
      expect(listMessages(db, {})).toHaveLength(3);

      // Rotated: the file is replaced by a much shorter one.
      await writeLines(path, [sentLine("frontend-lead", "fresh", "2026-08-11T11:00:00.000Z")]);
      const newSize = (await stat(path)).size;
      expect(newSize).toBeLessThan(bigOffset);

      await collectTranscripts(db, [source(path)], state);

      const bodies = listMessages(db, {}).map((r) => r.body.trim());
      expect(bodies).toContain("fresh");
      expect(state.offsets.get(path)).toBe(newSize);
    });

    it("keeps working for messages written after a truncation", async () => {
      const path = file("rotated2.jsonl");
      await writeLines(path, [
        sentLine("frontend-lead", "a", "2026-08-11T10:00:00.000Z"),
        sentLine("frontend-lead", "b", "2026-08-11T10:01:00.000Z"),
        sentLine("frontend-lead", "c", "2026-08-11T10:02:00.000Z"),
      ]);
      const state = createTranscriptState();
      await collectTranscripts(db, [source(path)], state);

      await writeFile(path, "", "utf8"); // truncated to nothing
      await collectTranscripts(db, [source(path)], state);
      expect(state.offsets.get(path)).toBe(0);

      await appendLines(path, [sentLine("frontend-lead", "after", "2026-08-11T12:00:00.000Z")]);
      await collectTranscripts(db, [source(path)], state);

      expect(listMessages(db, {}).map((r) => r.body.trim())).toContain("after");
    });
  });

  describe("activity", () => {
    it("updates current_activity on an agent that already exists", async () => {
      upsertAgent(db, agentRow("backend-dev", { current_activity: "stale" }));
      const path = file("activity.jsonl");
      await writeLines(path, [
        textLine("Refactoring the collector", "2026-08-11T10:00:00.000Z"),
        sentLine("frontend-lead", "Heads up", "2026-08-11T10:01:00.000Z"),
      ]);

      await collectTranscripts(db, [source(path)], createTranscriptState());

      const agent = listAgents(db).find((a) => a.name === "backend-dev");
      expect(agent).toBeDefined();
      expect(agent!.current_activity).not.toBe("stale");
      expect(agent!.current_activity).toContain("frontend-lead");
    });

    it("does not clobber the rest of the agent row", async () => {
      upsertAgent(db, agentRow("backend-dev", { kind: "claude", workdir: "/repo", last_seen: 42 }));
      const path = file("activity2.jsonl");
      await writeLines(path, [textLine("Doing a thing", "2026-08-11T10:00:00.000Z")]);

      await collectTranscripts(db, [source(path)], createTranscriptState());

      const agent = listAgents(db)[0];
      expect(agent.kind).toBe("claude");
      expect(agent.workdir).toBe("/repo");
      expect(agent.last_seen).toBe(42);
      expect(agent.alive).toBe(true);
    });

    it("SKIPS unknown agents — row creation belongs to the liveness collector", async () => {
      const path = file("ghost.jsonl");
      await writeLines(path, [
        sentLine("frontend-lead", "from a ghost", "2026-08-11T10:00:00.000Z"),
      ]);

      await collectTranscripts(db, [source(path, "not-in-db")], createTranscriptState());

      expect(listAgents(db)).toHaveLength(0);
      // The message is still captured — only the activity write is skipped.
      expect(listMessages(db, {})).toHaveLength(1);
    });

    it("leaves activity alone when a poll reads no new entries", async () => {
      upsertAgent(db, agentRow("backend-dev", { current_activity: "kept" }));
      const path = file("noop.jsonl");
      await writeFile(path, "", "utf8");

      await collectTranscripts(db, [source(path)], createTranscriptState());

      expect(listAgents(db)[0].current_activity).toBe("kept");
    });
  });

  describe("tolerance (PRD R1)", () => {
    it("a missing file does not throw and leaves state uncorrupted", async () => {
      const path = file("nope.jsonl");
      const state = createTranscriptState();

      await expect(collectTranscripts(db, [source(path)], state)).resolves.toBeUndefined();
      expect(listMessages(db, {})).toHaveLength(0);
      expect(state.offsets.get(path) ?? 0).toBe(0);
    });

    it("a file that appears LATER is read in full", async () => {
      const path = file("late.jsonl");
      const state = createTranscriptState();

      await collectTranscripts(db, [source(path)], state);
      expect(listMessages(db, {})).toHaveLength(0);

      await writeLines(path, [
        sentLine("frontend-lead", "late-one", "2026-08-11T10:00:00.000Z"),
        receivedLine("qa-bot", "late-two", "2026-08-11T10:00:05.000Z"),
      ]);
      await collectTranscripts(db, [source(path)], state);

      expect(listMessages(db, {}).map((r) => r.body.trim())).toEqual(["late-one", "late-two"]);
    });

    it("garbage lines do not abort the read — surrounding messages survive", async () => {
      const path = file("garbage.jsonl");
      await writeLines(path, [
        sentLine("frontend-lead", "before", "2026-08-11T10:00:00.000Z"),
        "{not json at all",
        "",
        "12345",
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"wat"}]}}',
        receivedLine("qa-bot", "after", "2026-08-11T10:02:00.000Z"),
      ]);

      await collectTranscripts(db, [source(path)], createTranscriptState());

      const bodies = listMessages(db, {}).map((r) => r.body.trim());
      expect(bodies).toContain("before");
      expect(bodies).toContain("after");
      expect(bodies).toHaveLength(2);
    });

    it("a directory in place of a transcript does not throw", async () => {
      const state = createTranscriptState();
      await expect(collectTranscripts(db, [source(dir)], state)).resolves.toBeUndefined();
    });
  });

  describe("multiple sources", () => {
    it("processes every source in one call", async () => {
      const a = file("s-a.jsonl");
      const b = file("s-b.jsonl");
      await writeLines(a, [sentLine("frontend-lead", "from-a", "2026-08-11T10:00:00.000Z")]);
      await writeLines(b, [sentLine("backend-dev", "from-b", "2026-08-11T10:00:01.000Z")]);

      const state = createTranscriptState();
      await collectTranscripts(
        db,
        [source(a, "backend-dev", "sess-a"), source(b, "frontend-lead", "sess-b")],
        state,
      );

      const rows = listMessages(db, {});
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.body.trim() === "from-a")!.session_id).toBe("sess-a");
      expect(rows.find((r) => r.body.trim() === "from-b")!.session_id).toBe("sess-b");
      expect(state.offsets.get(a)).toBeGreaterThan(0);
      expect(state.offsets.get(b)).toBeGreaterThan(0);
    });

    it("one failing source does not stop the others", async () => {
      const missing = file("gone.jsonl");
      const good = file("good.jsonl");
      await writeLines(good, [sentLine("frontend-lead", "survived", "2026-08-11T10:00:00.000Z")]);

      const state = createTranscriptState();
      await collectTranscripts(
        db,
        [
          source(missing, "ghost-a", "sess-x"),
          source(dir, "ghost-b", "sess-y"),
          source(good, "backend-dev", "sess-z"),
        ],
        state,
      );

      const rows = listMessages(db, {});
      expect(rows).toHaveLength(1);
      expect(rows[0].body.trim()).toBe("survived");
      expect(rows[0].session_id).toBe("sess-z");
    });

    it("an empty source list is a no-op", async () => {
      await expect(
        collectTranscripts(db, [], createTranscriptState()),
      ).resolves.toBeUndefined();
      expect(listMessages(db, {})).toHaveLength(0);
    });
  });
});
