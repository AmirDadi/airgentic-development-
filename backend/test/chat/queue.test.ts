import { describe, it, expect } from "vitest";
import { createTurnQueue } from "../../src/chat/queue.js";

/** A promise plus its resolvers, so a test can decide when work finishes. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets already-queued microtasks run. */
const tick = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("createTurnQueue", () => {
  it("runs one job at a time", async () => {
    const queue = createTurnQueue();
    const a = deferred<string>();
    const b = deferred<string>();
    let started = 0;

    const pa = queue.push(async () => {
      started++;
      return a.promise;
    });
    const pb = queue.push(async () => {
      started++;
      return b.promise;
    });

    await tick();
    expect(started).toBe(1);

    a.resolve("a");
    await pa;
    await tick();
    expect(started).toBe(2);

    b.resolve("b");
    expect(await pb).toBe("b");
  });

  it("runs jobs in FIFO order regardless of how long each takes", async () => {
    const queue = createTurnQueue();
    const order: string[] = [];
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];

    const promises = ["first", "second", "third"].map((name, i) =>
      queue.push(async () => {
        order.push(`start:${name}`);
        await gates[i]!.promise;
        order.push(`end:${name}`);
        return name;
      }),
    );

    // Resolve the gates out of order — the queue must still serialise.
    await tick();
    gates[0]!.resolve();
    await tick();
    gates[2]!.resolve();
    gates[1]!.resolve();

    expect(await Promise.all(promises)).toEqual(["first", "second", "third"]);
    expect(order).toEqual([
      "start:first",
      "end:first",
      "start:second",
      "end:second",
      "start:third",
      "end:third",
    ]);
  });

  it("returns each job's own resolved value to its own caller", async () => {
    const queue = createTurnQueue();
    const values = await Promise.all([
      queue.push(async () => 1),
      queue.push(async () => 2),
      queue.push(async () => 3),
    ]);
    expect(values).toEqual([1, 2, 3]);
  });

  it("does not stall when a job rejects", async () => {
    const queue = createTurnQueue();
    const failed = queue.push(async () => {
      throw new Error("turn blew up");
    });
    const after = queue.push(async () => "still running");

    await expect(failed).rejects.toThrow("turn blew up");
    expect(await after).toBe("still running");
    expect(queue.depth()).toBe(0);
  });

  it("does not stall when a job throws synchronously", async () => {
    const queue = createTurnQueue();
    const failed = queue.push((): Promise<string> => {
      throw new Error("sync boom");
    });
    const after = queue.push(async () => "next");

    await expect(failed).rejects.toThrow("sync boom");
    expect(await after).toBe("next");
    expect(queue.depth()).toBe(0);
  });

  it("survives several consecutive failures", async () => {
    const queue = createTurnQueue();
    const results = await Promise.allSettled([
      queue.push(async () => {
        throw new Error("one");
      }),
      queue.push(async () => {
        throw new Error("two");
      }),
      queue.push(async () => "three"),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected", "fulfilled"]);
  });

  it("reports depth as everything queued and not yet settled", async () => {
    const queue = createTurnQueue();
    expect(queue.depth()).toBe(0);

    const gate = deferred<void>();
    const first = queue.push(() => gate.promise);
    const second = queue.push(async () => {});
    expect(queue.depth()).toBe(2);

    gate.resolve();
    await first;
    await second;
    expect(queue.depth()).toBe(0);
  });

  it("keeps accepting work after draining completely", async () => {
    const queue = createTurnQueue();
    expect(await queue.push(async () => "a")).toBe("a");
    expect(queue.depth()).toBe(0);
    expect(await queue.push(async () => "b")).toBe("b");
    expect(queue.depth()).toBe(0);
  });

  it("never runs a later job before an earlier one has settled, even on failure", async () => {
    const queue = createTurnQueue();
    const order: string[] = [];
    const gate = deferred<void>();

    const failing = queue.push(async () => {
      order.push("start:failing");
      await gate.promise;
      order.push("end:failing");
      throw new Error("nope");
    });
    void queue.push(async () => {
      order.push("start:next");
    });

    await tick();
    expect(order).toEqual(["start:failing"]);

    gate.resolve();
    await expect(failing).rejects.toThrow("nope");
    await tick();
    expect(order).toEqual(["start:failing", "end:failing", "start:next"]);
  });
});
