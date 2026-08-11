import type { Message } from "./types.js";

export interface Thread {
  /** Stable, order-independent id for the pair, e.g. "lead|payments". */
  id: string;
  /** The two participants, sorted lexicographically for stability. */
  participants: [string, string];
  /** Messages in this thread, oldest first. */
  messages: Message[];
  /** Convenience: ts of the most recent message. */
  last_ts: number;
  /** Convenience: body of the most recent message. */
  last_body: string;
}

/** Order-independent pair key: participants sorted, joined with "|". */
function pairOf(message: Message): [string, string] {
  const { from_agent, to_agent } = message;
  return from_agent <= to_agent ? [from_agent, to_agent] : [to_agent, from_agent];
}

/**
 * Groups messages into threads, most-recently-active thread FIRST.
 *
 * A thread is the conversation between one PAIR of participants; A->B and
 * B->A belong to the same thread. Self-messages are excluded. Ordering is
 * fully deterministic: messages ascend by `ts` then `id`, threads descend by
 * `last_ts` and tie-break ascending by thread `id`. The input array is never
 * mutated.
 */
export function groupIntoThreads(messages: Message[]): Thread[] {
  const groups = new Map<string, Message[]>();

  for (const message of messages) {
    if (message.from_agent === message.to_agent) continue;
    const [a, b] = pairOf(message);
    const id = `${a}|${b}`;
    const bucket = groups.get(id);
    if (bucket) bucket.push(message);
    else groups.set(id, [message]);
  }

  const threads: Thread[] = [];
  for (const [id, bucket] of groups) {
    const sorted = [...bucket].sort(
      (x, y) => x.ts - y.ts || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
    );
    const last = sorted[sorted.length - 1];
    const [a, b] = pairOf(last);
    threads.push({
      id,
      participants: [a, b],
      messages: sorted,
      last_ts: last.ts,
      last_body: last.body,
    });
  }

  return threads.sort(
    (x, y) => y.last_ts - x.last_ts || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
  );
}
