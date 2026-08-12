import { describe, it, expect } from "vitest";
import type { TranscriptEntry } from "../src/types";
import { deriveActivity } from "../src/activity";

/** Longest activity line the UI will accept (contract, not impl detail). */
const ACTIVITY_MAX = 120;

const TS = Date.parse("2026-08-11T10:00:00.000Z");

const text = (t: string, ts: number | null = TS): TranscriptEntry => ({
  kind: "assistant_text",
  ts,
  text: t,
});
const call = (
  tool: string,
  summary: string,
  ts: number | null = TS,
  id: string | null = null,
): TranscriptEntry => ({
  kind: "tool_call",
  ts,
  tool,
  summary,
  id,
});
const userText = (t: string, ts: number | null = TS): TranscriptEntry => ({
  kind: "user_text",
  ts,
  text: t,
});
const thinking = (t: string, ts: number | null = TS): TranscriptEntry => ({
  kind: "thinking",
  ts,
  text: t,
});
const result = (
  summary: string,
  ok = true,
  tool_use_id: string | null = null,
  ts: number | null = TS,
): TranscriptEntry => ({ kind: "tool_result", ts, tool_use_id, ok, summary });
const systemEvent = (event: string, detail = "", ts: number | null = TS): TranscriptEntry => ({
  kind: "system_event",
  ts,
  event,
  detail,
});
const sent = (peer: string, body: string, ts: number | null = TS): TranscriptEntry => ({
  kind: "send_message",
  ts,
  direction: "sent",
  peer,
  body,
});
const received = (peer: string, body: string, ts: number | null = TS): TranscriptEntry => ({
  kind: "send_message",
  ts,
  direction: "received",
  peer,
  body,
});
const turnEnd = (ts: number | null = TS): TranscriptEntry => ({ kind: "turn_end", ts });
const unknown = (raw = "{garbage", ts: number | null = null): TranscriptEntry => ({
  kind: "unknown",
  ts,
  raw,
});

describe("deriveActivity — reads the tail of the transcript", () => {
  it("describes the latest tool_call, naming the tool", () => {
    const out = deriveActivity([text("thinking"), call("Bash", "npx vitest run")]);
    expect(out).toContain("Bash");
    expect(out).toContain("npx vitest run");
    expect(out.toLowerCase()).toContain("running");
  });

  it("describes a file edit as editing that file", () => {
    const out = deriveActivity([call("Edit", "backend/src/activity.ts")]);
    expect(out).toContain("Edit");
    expect(out).toContain("backend/src/activity.ts");
    expect(out.toLowerCase()).toContain("editing");
  });

  it("describes a file read as reading that file", () => {
    const out = deriveActivity([call("Read", "backend/src/types.ts")]);
    expect(out.toLowerCase()).toContain("reading");
    expect(out).toContain("backend/src/types.ts");
  });

  it("describes an unfamiliar tool generically but still names it", () => {
    const out = deriveActivity([call("WebSearch", "vitest concurrency")]);
    expect(out).toContain("WebSearch");
    expect(out).toContain("vitest concurrency");
  });

  it("uses the LAST entry, not the first", () => {
    const out = deriveActivity([
      call("Bash", "npm install"),
      call("Edit", "backend/src/transcript-parser.ts"),
    ]);
    expect(out).toContain("backend/src/transcript-parser.ts");
    expect(out).not.toContain("npm install");
  });

  it("gives a one-line version of the latest assistant_text", () => {
    const out = deriveActivity([call("Bash", "ls"), text("Refactoring the parser fallbacks.")]);
    expect(out).toContain("Refactoring the parser fallbacks.");
    expect(out).not.toContain("\n");
  });

  it("indicates messaging the peer for a sent message", () => {
    const out = deriveActivity([sent("frontend-lead", "Types are stable now.")]);
    expect(out).toContain("frontend-lead");
    expect(out.toLowerCase()).toMatch(/messag/);
  });

  it("indicates an inbound message from the peer", () => {
    const out = deriveActivity([received("qa-bot", "Tests are green.")]);
    expect(out).toContain("qa-bot");
    expect(out.toLowerCase()).toMatch(/messag|from/);
  });
});

describe("deriveActivity — the kinds the real schema produces", () => {
  it("describes a thinking block as thinking, with the reasoning", () => {
    const out = deriveActivity([call("Bash", "ls"), thinking("The loader is the suspect.")]);
    expect(out.toLowerCase()).toContain("thinking");
    expect(out).toContain("The loader is the suspect.");
  });

  it("names the tool a tool_result belongs to by pairing on tool_use_id", () => {
    const out = deriveActivity([
      call("Bash", "npm run widgets:check", TS, "toolu_1"),
      result("12 widgets ok", true, "toolu_1"),
    ]);
    expect(out).toContain("Bash");
    expect(out).toContain("12 widgets ok");
  });

  it("says a tool failed when the result is an error", () => {
    const out = deriveActivity([
      call("Bash", "npm run widgets:check", TS, "toolu_1"),
      result("loader exploded", false, "toolu_1"),
    ]);
    expect(out).toContain("Bash");
    expect(out.toLowerCase()).toContain("fail");
  });

  it("still describes an unpaired tool_result generically", () => {
    const out = deriveActivity([result("some output", true, "toolu_missing")]);
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toBe("activity unknown");
    expect(out).toContain("some output");
  });

  it("describes a fresh user instruction", () => {
    const out = deriveActivity([userText("Please add a widget colour picker.")]);
    expect(out).toContain("Please add a widget colour picker.");
    expect(out).not.toBe("activity unknown");
  });

  it("steps over bookkeeping system_events to the last real action", () => {
    const out = deriveActivity([
      call("Bash", "npm run widgets:check"),
      systemEvent("attachment", "task_reminder"),
      systemEvent("queue-operation", "enqueue"),
    ]);
    expect(out).toContain("npm run widgets:check");
  });

  it("reports 'activity unknown' when only system_events are present", () => {
    expect(deriveActivity([systemEvent("mode", "normal")])).toBe("activity unknown");
  });
});

describe("deriveActivity — idle and degraded paths", () => {
  it("reports idle/waiting when the last entry is turn_end, not the stale previous activity", () => {
    const out = deriveActivity([call("Bash", "npx vitest run"), turnEnd()]);
    expect(out.toLowerCase()).toMatch(/idle|waiting/);
    expect(out).not.toContain("npx vitest run");
    expect(out).not.toContain("Bash");
  });

  it("returns 'activity unknown' for an empty array", () => {
    expect(deriveActivity([])).toBe("activity unknown");
  });

  it("R1: returns 'activity unknown' when every entry is unknown", () => {
    expect(deriveActivity([unknown(), unknown("{"), unknown("[]")])).toBe("activity unknown");
  });

  it("R1: skips trailing unknown entries and reports the last entry it understood", () => {
    const out = deriveActivity([call("Bash", "npx vitest run"), unknown(), unknown()]);
    expect(out).toContain("npx vitest run");
  });

  it("never throws on odd but well-typed values", () => {
    const odd: TranscriptEntry[] = [
      text(""),
      call("", ""),
      sent("", ""),
      received("", ""),
      turnEnd(null),
      userText(""),
      thinking(""),
      result("", true, null, null),
      systemEvent("", ""),
    ];
    for (let i = 1; i <= odd.length; i++) {
      expect(() => deriveActivity(odd.slice(0, i))).not.toThrow();
      expect(typeof deriveActivity(odd.slice(0, i))).toBe("string");
      expect(deriveActivity(odd.slice(0, i)).length).toBeGreaterThan(0);
    }
  });

  it("falls back to 'activity unknown' when the entry carries no describable content", () => {
    expect(deriveActivity([text("   ")])).toBe("activity unknown");
  });
});

describe("deriveActivity — output shape is always safe to render", () => {
  const longMultiline = [
    "Okay, here is my plan for the transcript parser work:",
    "1. Write the fixtures capturing the current JSONL shape.",
    "2. Write failing tests for every recognised entry kind.",
    "3. Implement classification with an unknown fallback per PRD R1.",
    "4. Make sure nothing in the module ever throws, under any input at all.",
  ].join("\n");

  it("collapses a multi-line, very long assistant message into one bounded line", () => {
    const out = deriveActivity([text(longMultiline)]);
    expect(out).not.toContain("\n");
    expect(out).not.toContain("\r");
    expect(out.length).toBeLessThanOrEqual(ACTIVITY_MAX);
    expect(out).toContain("Okay, here is my plan");
  });

  it("bounds every kind of output", () => {
    const long = "y".repeat(4000);
    const cases: TranscriptEntry[][] = [
      [text(long)],
      [call("Bash", long)],
      [call(long, long)],
      [sent(long, long)],
      [received(long, long)],
      [turnEnd()],
      [userText(long)],
      [thinking(long)],
      [result(long, true, "toolu_1"), result(long, false, "toolu_1")],
      [call(long, long, TS, "toolu_1"), result(long, false, "toolu_1")],
      [systemEvent(long, long)],
      [],
    ];
    for (const entries of cases) {
      const out = deriveActivity(entries);
      expect(out.length, out.slice(0, 40)).toBeLessThanOrEqual(ACTIVITY_MAX);
      expect(out).not.toMatch(/[\r\n\t]/);
    }
  });

  it("is pure — same input, same output", () => {
    const entries = [text("a"), call("Bash", "b"), sent("c", "d")];
    expect(deriveActivity(entries)).toBe(deriveActivity(entries));
    expect(entries).toHaveLength(3);
  });
});
