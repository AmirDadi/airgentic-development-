/**
 * A serial work queue: one job at a time, in submission order (PRD R3).
 *
 * Two humans typing at once must not interleave inside one agent's context, so
 * every turn waits for the previous one to settle. The queue is deliberately
 * ignorant of what a "turn" is — it takes any async thunk — which keeps it
 * pure logic and testable without a process in sight.
 *
 * A failing job must not stall the queue: a rejection is forwarded to that
 * job's own caller and the chain continues with the next one.
 */
export interface TurnQueue {
  /** Enqueues work; resolves/rejects with that job's own outcome. */
  push<T>(work: () => Promise<T>): Promise<T>;
  /** Jobs queued and not yet settled, including the one currently running. */
  depth(): number;
}

export function createTurnQueue(): TurnQueue {
  // The tail of the chain. Every job appends to it, so ordering is FIFO by
  // construction and there is no array to keep in sync.
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;

  return {
    push<T>(work: () => Promise<T>): Promise<T> {
      pending++;
      const run = tail.then(
        // Both arms run the job: the previous job's outcome — success OR
        // failure — must never decide whether this one gets to run.
        async (): Promise<T> => {
          try {
            return await work();
          } finally {
            pending--;
          }
        },
      );

      // The chain continues on a swallowed copy, so one rejection cannot
      // poison every job queued behind it (and cannot surface as an unhandled
      // rejection when nobody awaits `push`).
      tail = run.then(
        () => undefined,
        () => undefined,
      );

      return run;
    },

    depth() {
      return pending;
    },
  };
}
