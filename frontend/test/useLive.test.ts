import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLive, type EventSourceLike } from "../src/useLive";

/** Minimal stand-in for EventSource — jsdom does not implement it. */
class FakeSource implements EventSourceLike {
  listeners = new Map<string, ((e: { data: string }) => void)[]>();
  closed = false;
  static last: FakeSource | null = null;

  constructor(readonly url: string) {
    FakeSource.last = this;
  }
  addEventListener(type: string, cb: (e: { data: string }) => void) {
    const l = this.listeners.get(type) ?? [];
    l.push(cb);
    this.listeners.set(type, l);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: string) {
    for (const cb of this.listeners.get(type) ?? []) cb({ data });
  }
}

const factory = (url: string) => new FakeSource(url);

describe("useLive", () => {
  it("opens a connection to the live endpoint on mount", () => {
    renderHook(() => useLive({ onEvent: vi.fn(), factory, url: "/live" }));
    expect(FakeSource.last?.url).toBe("/live");
  });

  it("delivers a parsed JSON payload to onEvent", () => {
    const onEvent = vi.fn();
    renderHook(() => useLive({ onEvent, factory }));

    act(() => {
      FakeSource.last!.emit("agents", JSON.stringify([{ name: "payments" }]));
    });

    expect(onEvent).toHaveBeenCalledWith("agents", [{ name: "payments" }]);
  });

  it("closes the connection on unmount so refreshes do not leak sockets", () => {
    const { unmount } = renderHook(() => useLive({ onEvent: vi.fn(), factory }));
    const src = FakeSource.last!;
    expect(src.closed).toBe(false);

    unmount();
    expect(src.closed).toBe(true);
  });

  it("survives a malformed payload without throwing or killing the stream", () => {
    const onEvent = vi.fn();
    renderHook(() => useLive({ onEvent, factory }));

    expect(() => {
      act(() => FakeSource.last!.emit("agents", "{not json"));
    }).not.toThrow();
    // The bad frame is dropped, not forwarded as a broken value...
    expect(onEvent).not.toHaveBeenCalled();

    // ...and the connection still delivers the next good frame.
    act(() => FakeSource.last!.emit("agents", "[]"));
    expect(onEvent).toHaveBeenCalledWith("agents", []);
  });

  it("reports connection state, flipping to false on error", () => {
    const { result } = renderHook(() =>
      useLive({ onEvent: vi.fn(), factory }),
    );

    act(() => FakeSource.last!.emit("open", ""));
    expect(result.current.connected).toBe(true);

    act(() => FakeSource.last!.emit("error", ""));
    expect(result.current.connected).toBe(false);
  });

  it("does not reopen the connection on unrelated re-renders", () => {
    const spy = vi.fn(factory);
    const { rerender } = renderHook(
      ({ n }: { n: number }) => {
        void n;
        return useLive({ onEvent: vi.fn(), factory: spy });
      },
      { initialProps: { n: 1 } },
    );

    rerender({ n: 2 });
    rerender({ n: 3 });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
