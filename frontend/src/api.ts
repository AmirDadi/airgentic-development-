import type { Agent, Feature, StoredEntry } from "./types";

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

export interface ApiClient {
  agents(): Promise<Agent[]>;
  features(): Promise<Feature[]>;
  threads(): Promise<unknown[]>;
  events(since?: number): Promise<unknown[]>;
  /** Oldest-first transcript entries for one agent. */
  agentEntries(name: string, limit?: number): Promise<StoredEntry[]>;
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
  };
}
