/**
 * A transport-agnostic pub/sub hub for the `GET /live` stream.
 *
 * Subscribers are plain `send(event, data)` callbacks, so the hub is unit
 * testable with no HTTP involved and the SSE framing stays in the route.
 */
export interface SseHub {
  /** Registers a sink. Returns an idempotent unsubscribe function. */
  subscribe(send: (event: string, data: unknown) => void): () => void;
  /** Fans out to every current subscriber. Never throws. */
  broadcast(event: string, data: unknown): void;
  subscriberCount(): number;
}

interface Subscriber {
  send: (event: string, data: unknown) => void;
}

export function createSseHub(): SseHub {
  // A Set of wrapper objects rather than of the functions themselves: the same
  // callback may legitimately subscribe twice, and each handle must unsubscribe
  // only its own registration.
  const subscribers = new Set<Subscriber>();

  return {
    subscribe(send) {
      const sub: Subscriber = { send };
      subscribers.add(sub);
      return () => {
        subscribers.delete(sub);
      };
    },

    broadcast(event, data) {
      // Snapshot first: a sink that unsubscribes itself mid-fanout (a dropped
      // client) must not perturb this iteration.
      for (const sub of [...subscribers]) {
        try {
          sub.send(event, data);
        } catch {
          // One broken client cannot take down the stream for everyone else,
          // and cannot fail the write path that triggered the broadcast.
        }
      }
    },

    subscriberCount() {
      return subscribers.size;
    },
  };
}
