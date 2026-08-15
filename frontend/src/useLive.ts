import { useEffect, useRef, useState } from "react";

/**
 * The slice of EventSource we use. Injected so tests (and jsdom, which has no
 * EventSource at all) can supply a fake.
 */
export interface EventSourceLike {
  addEventListener(type: string, cb: (e: { data: string }) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

/** Event names the backend broadcasts on the SSE channel. */
const CHANNELS = ["agents", "features", "messages", "events", "entries", "chat"] as const;

export interface UseLiveOptions {
  onEvent: (type: string, data: unknown) => void;
  url?: string;
  factory?: EventSourceFactory;
}

/**
 * Subscribes to the backend's single SSE channel for the lifetime of the
 * component. One connection serves every view (PRD §3: "one shared SSE
 * subscription").
 */
export function useLive(opts: UseLiveOptions): { connected: boolean } {
  const { url = "/live", factory } = opts;
  const [connected, setConnected] = useState(false);

  // Kept in a ref so a changing callback identity never tears down and
  // reopens the connection — reconnect churn would drop events.
  const onEvent = useRef(opts.onEvent);
  onEvent.current = opts.onEvent;

  const factoryRef = useRef(factory);

  useEffect(() => {
    const create = factoryRef.current;

    // No injected factory and no EventSource in this environment (jsdom, SSR,
    // an old browser): render from the REST snapshot rather than throwing.
    if (!create && typeof EventSource === "undefined") return;

    const source = create
      ? create(url)
      : (new EventSource(url) as unknown as EventSourceLike);

    source.addEventListener("open", () => setConnected(true));
    source.addEventListener("error", () => setConnected(false));

    for (const channel of CHANNELS) {
      source.addEventListener(channel, (e) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(e.data);
        } catch {
          // A malformed frame is dropped rather than forwarded as a broken
          // value or thrown — one bad frame must not kill the stream.
          return;
        }
        onEvent.current(channel, parsed);
      });
    }

    return () => source.close();
  }, [url]);

  return { connected };
}
