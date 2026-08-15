import type { Agent, Feature, Message, StoredEntry } from "./types";

/**
 * Every failure the client can produce — HTTP, network, or malformed body —
 * arrives as this one type, so callers have a single thing to catch. A raw
 * TypeError from `fetch` leaking into a render path is how a dashboard ends
 * up blank instead of showing "backend unreachable".
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiOptions {
  /** Defaults to a relative base, for when Fastify serves the built UI. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

async function get<T>(
  path: string,
  opts: Required<Pick<ApiOptions, "baseUrl">> & { fetch: typeof fetch },
): Promise<T> {
  const url = `${opts.baseUrl}${path}`;

  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await opts.fetch(url, { headers: { accept: "application/json" } });
  } catch (cause) {
    throw new ApiError(`Request to ${url} failed`, null, cause);
  }

  if (!res.ok) {
    throw new ApiError(`Request to ${url} failed`, res.status);
  }

  try {
    return (await res.json()) as T;
  } catch (cause) {
    throw new ApiError(`Malformed JSON from ${url}`, res.status, cause);
  }
}

async function post<T>(
  path: string,
  body: unknown,
  opts: Required<Pick<ApiOptions, "baseUrl">> & { fetch: typeof fetch },
): Promise<T> {
  const url = `${opts.baseUrl}${path}`;

  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await opts.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new ApiError(`Request to ${url} failed`, null, cause);
  }

  // 202 is the success case for /chat, and `ok` already covers it. A 503 here
  // means "no lead configured" — the caller reads `status` rather than the
  // message, so it keeps its own wording.
  if (!res.ok) {
    throw new ApiError(`Request to ${url} failed`, res.status);
  }

  try {
    return (await res.json()) as T;
  } catch (cause) {
    throw new ApiError(`Malformed JSON from ${url}`, res.status, cause);
  }
}

/** The backend's answer to an accepted chat turn. */
export interface ChatAccepted {
  turnId: string;
}

/** The audit event the backend returns after interrupting an agent. */
export interface StopAccepted {
  id: string;
  type: string;
  agent: string;
  ts: number;
}

export interface ApiClient {
  agents(): Promise<Agent[]>;
  features(): Promise<Feature[]>;
  threads(): Promise<unknown[]>;
  events(since?: number): Promise<unknown[]>;
  /** Oldest-first transcript entries for one agent. */
  agentEntries(name: string, limit?: number): Promise<StoredEntry[]>;
  /** Queues one chat turn for the web lead. Rejects with 503 if none is configured. */
  sendChat(text: string, user?: string): Promise<ChatAccepted>;
  /**
   * Interrupts one agent's current turn. Resolves with the audit event on
   * success; rejects with 404 for an unknown agent and 503 when Stop is not
   * configured on the server.
   */
  stopAgent(name: string, actor?: string): Promise<StopAccepted>;
  /** Oldest-first `human_web` messages, both sides of the conversation. */
  chatHistory(): Promise<Message[]>;
}

export function createApi(opts: ApiOptions = {}): ApiClient {
  // A trailing slash would produce "http://dash//agents".
  const baseUrl = (opts.baseUrl ?? "").replace(/\/$/, "");
  const f = opts.fetch ?? globalThis.fetch;
  const cfg = { baseUrl, fetch: f };

  return {
    agents: () => get<Agent[]>("/agents", cfg),
    features: () => get<Feature[]>("/features", cfg),
    threads: () => get<unknown[]>("/threads", cfg),
    events: (since?: number) =>
      get<unknown[]>(
        since === undefined ? "/events" : `/events?since=${since}`,
        cfg,
      ),
    // The name is a path segment, so it is encoded — a name containing "/"
    // would otherwise silently address a different route.
    agentEntries: (name: string, limit?: number) =>
      get<StoredEntry[]>(
        `/agents/${encodeURIComponent(name)}/entries` +
          (limit === undefined ? "" : `?limit=${limit}`),
        cfg,
      ),
    // `user` is omitted rather than sent as undefined/null, so the backend's
    // own default naming applies when the browser has nobody to name.
    sendChat: (text: string, user?: string) =>
      post<ChatAccepted>(
        "/chat",
        user === undefined ? { text } : { text, user },
        cfg,
      ),
    chatHistory: () => get<Message[]>("/chat/history", cfg),
    // The name is a path segment, so it is encoded — a crafted name cannot
    // silently address a different route. `actor` is omitted rather than sent
    // as undefined so the backend applies its own default when the browser has
    // nobody to name for the audit trail.
    stopAgent: (name: string, actor?: string) =>
      post<StopAccepted>(
        `/agents/${encodeURIComponent(name)}/stop`,
        actor === undefined ? {} : { actor },
        cfg,
      ),
  };
}
