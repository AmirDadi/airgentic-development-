import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import type { AddressInfo } from "node:net";
import { createSseHub } from "../src/sse.js";
import { buildApp } from "../src/app.js";
import { migrate } from "../src/db.js";

describe("createSseHub", () => {
  it("delivers a broadcast to a single subscriber", () => {
    const hub = createSseHub();
    const send = vi.fn();
    hub.subscribe(send);

    hub.broadcast("event", { id: "e1" });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("event", { id: "e1" });
  });

  it("delivers a broadcast to every subscriber", () => {
    const hub = createSseHub();
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    hub.subscribe(a);
    hub.subscribe(b);
    hub.subscribe(c);

    hub.broadcast("ping", 1);

    for (const fn of [a, b, c]) {
      expect(fn).toHaveBeenCalledWith("ping", 1);
    }
  });

  it("stops delivering after unsubscribe", () => {
    const hub = createSseHub();
    const stays = vi.fn();
    const leaves = vi.fn();
    hub.subscribe(stays);
    const off = hub.subscribe(leaves);

    off();
    hub.broadcast("event", "x");

    expect(leaves).not.toHaveBeenCalled();
    expect(stays).toHaveBeenCalledTimes(1);
  });

  it("tolerates unsubscribing twice", () => {
    const hub = createSseHub();
    const off = hub.subscribe(vi.fn());

    off();
    expect(() => off()).not.toThrow();
    expect(hub.subscriberCount()).toBe(0);
  });

  it("tracks subscriberCount accurately", () => {
    const hub = createSseHub();
    expect(hub.subscriberCount()).toBe(0);

    const off1 = hub.subscribe(vi.fn());
    expect(hub.subscriberCount()).toBe(1);

    const off2 = hub.subscribe(vi.fn());
    expect(hub.subscriberCount()).toBe(2);

    off1();
    expect(hub.subscriberCount()).toBe(1);

    off2();
    expect(hub.subscriberCount()).toBe(0);
  });

  it("registers the same function twice as two subscribers", () => {
    const hub = createSseHub();
    const send = vi.fn();
    const off1 = hub.subscribe(send);
    hub.subscribe(send);

    expect(hub.subscriberCount()).toBe(2);
    hub.broadcast("event", null);
    expect(send).toHaveBeenCalledTimes(2);

    // Unsubscribing one handle must not remove the other registration.
    off1();
    expect(hub.subscriberCount()).toBe(1);
  });

  it("is a no-op to broadcast with no subscribers", () => {
    const hub = createSseHub();
    expect(() => hub.broadcast("event", { a: 1 })).not.toThrow();
    expect(hub.subscriberCount()).toBe(0);
  });

  it("keeps delivering to healthy subscribers when one throws", () => {
    const hub = createSseHub();
    const before = vi.fn();
    const broken = vi.fn(() => {
      throw new Error("client socket exploded");
    });
    const after = vi.fn();
    hub.subscribe(before);
    hub.subscribe(broken);
    hub.subscribe(after);

    expect(() => hub.broadcast("event", { id: "e1" })).not.toThrow();

    expect(before).toHaveBeenCalledWith("event", { id: "e1" });
    expect(broken).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledWith("event", { id: "e1" });
  });

  it("keeps a throwing subscriber isolated across repeated broadcasts", () => {
    const hub = createSseHub();
    const broken = vi.fn(() => {
      throw new Error("boom");
    });
    const healthy = vi.fn();
    hub.subscribe(broken);
    hub.subscribe(healthy);

    hub.broadcast("event", 1);
    hub.broadcast("event", 2);

    expect(healthy).toHaveBeenCalledTimes(2);
    expect(healthy).toHaveBeenLastCalledWith("event", 2);
  });

  it("keeps hubs independent of one another", () => {
    const one = createSseHub();
    const two = createSseHub();
    const send = vi.fn();
    one.subscribe(send);

    two.broadcast("event", "nope");

    expect(send).not.toHaveBeenCalled();
    expect(two.subscriberCount()).toBe(0);
  });
});

describe("GET /live over a real socket", () => {
  // app.inject() resolves as soon as headers are queued, so it cannot catch a
  // response whose headers are never flushed to the wire. This boots a real
  // listener: before flushHeaders() was added, a client saw zero bytes until
  // the 30s heartbeat.
  it("flushes headers and an opening frame immediately on connect", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const app = buildApp(db);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;

    try {
      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/live`, {
        signal: controller.signal,
      });

      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const reader = res.body!.getReader();
      const first = await Promise.race([
        reader.read().then((r) => new TextDecoder().decode(r.value)),
        new Promise<string>((_, rej) =>
          setTimeout(() => rej(new Error("no bytes within 2s")), 2000),
        ),
      ]);
      expect(first).toContain(":");

      controller.abort();
    } finally {
      await app.close();
    }
  });
});
