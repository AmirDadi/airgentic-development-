import { describe, it, expect } from "vitest";
import type { Message } from "../src/types";
import { groupIntoThreads, type Thread } from "../src/threads";

/** Build a Message with sensible defaults; override anything you care about. */
function msg(over: Partial<Message> & { id: string }): Message {
  return {
    ts: 1000,
    from_agent: "lead",
    to_agent: "payments",
    channel: "inter_agent",
    body: "hello",
    session_id: null,
    ...over,
  };
}

/** Shallow snapshot of an array, for mutation assertions. */
function idsOf(messages: Message[]): string[] {
  return messages.map((m) => m.id);
}

describe("groupIntoThreads", () => {
  it("returns [] for empty input", () => {
    expect(groupIntoThreads([])).toEqual([]);
  });

  it("groups a single message into one thread", () => {
    const m = msg({ id: "m1", ts: 5, from_agent: "lead", to_agent: "payments", body: "hi" });
    const threads = groupIntoThreads([m]);
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe("lead|payments");
    expect(threads[0].participants).toEqual(["lead", "payments"]);
    expect(idsOf(threads[0].messages)).toEqual(["m1"]);
    expect(threads[0].last_ts).toBe(5);
    expect(threads[0].last_body).toBe("hi");
  });

  it("treats A->B and B->A as the SAME thread", () => {
    const threads = groupIntoThreads([
      msg({ id: "m1", ts: 1, from_agent: "lead", to_agent: "payments" }),
      msg({ id: "m2", ts: 2, from_agent: "payments", to_agent: "lead" }),
      msg({ id: "m3", ts: 3, from_agent: "lead", to_agent: "payments" }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe("lead|payments");
    expect(idsOf(threads[0].messages)).toEqual(["m1", "m2", "m3"]);
  });

  it("produces the same id and participants regardless of who spoke first", () => {
    const leadFirst = groupIntoThreads([
      msg({ id: "a", ts: 1, from_agent: "lead", to_agent: "payments" }),
      msg({ id: "b", ts: 2, from_agent: "payments", to_agent: "lead" }),
    ]);
    const paymentsFirst = groupIntoThreads([
      msg({ id: "a", ts: 1, from_agent: "payments", to_agent: "lead" }),
      msg({ id: "b", ts: 2, from_agent: "lead", to_agent: "payments" }),
    ]);
    expect(leadFirst[0].id).toBe(paymentsFirst[0].id);
    expect(leadFirst[0].participants).toEqual(paymentsFirst[0].participants);
    expect(leadFirst[0].participants).toEqual(["lead", "payments"]);
  });

  it("sorts participants lexicographically", () => {
    const threads = groupIntoThreads([
      msg({ id: "m1", from_agent: "zeta", to_agent: "alpha" }),
    ]);
    expect(threads[0].participants).toEqual(["alpha", "zeta"]);
    expect(threads[0].id).toBe("alpha|zeta");
  });

  it("sorts messages within a thread oldest-first by ts", () => {
    const threads = groupIntoThreads([
      msg({ id: "c", ts: 30 }),
      msg({ id: "a", ts: 10 }),
      msg({ id: "b", ts: 20 }),
    ]);
    expect(idsOf(threads[0].messages)).toEqual(["a", "b", "c"]);
    expect(threads[0].messages.map((m) => m.ts)).toEqual([10, 20, 30]);
  });

  it("exposes last_ts and last_body from the most recent message", () => {
    const threads = groupIntoThreads([
      msg({ id: "a", ts: 10, body: "first" }),
      msg({ id: "c", ts: 30, body: "latest" }),
      msg({ id: "b", ts: 20, body: "middle" }),
    ]);
    expect(threads[0].last_ts).toBe(30);
    expect(threads[0].last_body).toBe("latest");
  });

  it("partitions multiple independent pairs into separate threads", () => {
    const threads = groupIntoThreads([
      msg({ id: "m1", ts: 1, from_agent: "lead", to_agent: "payments" }),
      msg({ id: "m2", ts: 2, from_agent: "lead", to_agent: "search" }),
      msg({ id: "m3", ts: 3, from_agent: "search", to_agent: "payments" }),
      msg({ id: "m4", ts: 4, from_agent: "payments", to_agent: "lead" }),
    ]);
    expect(threads).toHaveLength(3);
    const byId = new Map(threads.map((t) => [t.id, t]));
    expect([...byId.keys()].sort()).toEqual([
      "lead|payments",
      "lead|search",
      "payments|search",
    ]);
    expect(idsOf(byId.get("lead|payments")!.messages)).toEqual(["m1", "m4"]);
    expect(idsOf(byId.get("lead|search")!.messages)).toEqual(["m2"]);
    expect(idsOf(byId.get("payments|search")!.messages)).toEqual(["m3"]);
  });

  it("orders threads by last_ts DESCENDING (most recently active first)", () => {
    const threads = groupIntoThreads([
      msg({ id: "m1", ts: 10, from_agent: "lead", to_agent: "payments" }),
      msg({ id: "m2", ts: 50, from_agent: "lead", to_agent: "search" }),
      msg({ id: "m3", ts: 30, from_agent: "search", to_agent: "payments" }),
    ]);
    expect(threads.map((t) => t.id)).toEqual([
      "lead|search",
      "payments|search",
      "lead|payments",
    ]);
    expect(threads.map((t) => t.last_ts)).toEqual([50, 30, 10]);
  });

  it("excludes self-messages entirely", () => {
    const threads = groupIntoThreads([
      msg({ id: "self1", ts: 99, from_agent: "lead", to_agent: "lead" }),
      msg({ id: "m1", ts: 1, from_agent: "lead", to_agent: "payments" }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe("lead|payments");
    expect(idsOf(threads[0].messages)).toEqual(["m1"]);
  });

  it("returns [] when every message is a self-message", () => {
    const threads = groupIntoThreads([
      msg({ id: "s1", from_agent: "lead", to_agent: "lead" }),
      msg({ id: "s2", from_agent: "payments", to_agent: "payments" }),
    ]);
    expect(threads).toEqual([]);
  });

  it("keeps both channels in the same thread when between the same pair", () => {
    const threads = groupIntoThreads([
      msg({ id: "m1", ts: 1, channel: "inter_agent", from_agent: "lead", to_agent: "payments" }),
      msg({ id: "m2", ts: 2, channel: "human_web", from_agent: "payments", to_agent: "lead" }),
      msg({ id: "m3", ts: 3, channel: "human_web", from_agent: "lead", to_agent: "payments" }),
    ]);
    expect(threads).toHaveLength(1);
    expect(idsOf(threads[0].messages)).toEqual(["m1", "m2", "m3"]);
    expect(threads[0].messages.map((m) => m.channel)).toEqual([
      "inter_agent",
      "human_web",
      "human_web",
    ]);
  });

  it("breaks ts ties within a thread deterministically by message id", () => {
    const threads = groupIntoThreads([
      msg({ id: "c", ts: 5 }),
      msg({ id: "a", ts: 5 }),
      msg({ id: "b", ts: 5 }),
    ]);
    expect(idsOf(threads[0].messages)).toEqual(["a", "b", "c"]);
    // last_* come from the tiebroken tail, so they are stable too.
    expect(threads[0].last_ts).toBe(5);
  });

  it("gives the same message order for ties regardless of input order", () => {
    const one = groupIntoThreads([msg({ id: "b", ts: 5 }), msg({ id: "a", ts: 5 })]);
    const two = groupIntoThreads([msg({ id: "a", ts: 5 }), msg({ id: "b", ts: 5 })]);
    expect(idsOf(one[0].messages)).toEqual(idsOf(two[0].messages));
  });

  it("breaks last_ts ties between threads deterministically by thread id", () => {
    const threads = groupIntoThreads([
      msg({ id: "m1", ts: 7, from_agent: "lead", to_agent: "search" }),
      msg({ id: "m2", ts: 7, from_agent: "lead", to_agent: "payments" }),
      msg({ id: "m3", ts: 7, from_agent: "search", to_agent: "payments" }),
    ]);
    expect(threads.map((t) => t.id)).toEqual([
      "lead|payments",
      "lead|search",
      "payments|search",
    ]);
  });

  it("gives the same thread order for last_ts ties regardless of input order", () => {
    const input: Message[] = [
      msg({ id: "m1", ts: 7, from_agent: "lead", to_agent: "search" }),
      msg({ id: "m2", ts: 7, from_agent: "lead", to_agent: "payments" }),
      msg({ id: "m3", ts: 7, from_agent: "search", to_agent: "payments" }),
    ];
    const forward = groupIntoThreads(input).map((t) => t.id);
    const reversed = groupIntoThreads([...input].reverse()).map((t) => t.id);
    expect(reversed).toEqual(forward);
  });

  it("does not mutate the input array or its order", () => {
    const input: Message[] = [
      msg({ id: "c", ts: 30 }),
      msg({ id: "a", ts: 10, from_agent: "lead", to_agent: "search" }),
      msg({ id: "b", ts: 20 }),
    ];
    const before = idsOf(input);
    const snapshot = input.map((m) => ({ ...m }));
    groupIntoThreads(input);
    expect(idsOf(input)).toEqual(before);
    expect(input).toHaveLength(3);
    expect(input).toEqual(snapshot);
  });

  it("returns thread objects matching the Thread shape", () => {
    const threads: Thread[] = groupIntoThreads([msg({ id: "m1", ts: 1 })]);
    const t = threads[0];
    expect(Object.keys(t).sort()).toEqual([
      "id",
      "last_body",
      "last_ts",
      "messages",
      "participants",
    ]);
    expect(t.participants).toHaveLength(2);
  });
});
