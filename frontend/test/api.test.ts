import { describe, it, expect, vi } from "vitest";
import { createApi, ApiError } from "../src/api";

function fakeFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("createApi", () => {
  it("requests the agents endpoint and returns the parsed body", async () => {
    const f = fakeFetch([{ name: "payments" }]);
    const api = createApi({ baseUrl: "http://dash", fetch: f });

    await expect(api.agents()).resolves.toEqual([{ name: "payments" }]);
    expect(f).toHaveBeenCalledWith("http://dash/agents", expect.anything());
  });

  it("requests features and threads from their own endpoints", async () => {
    const f = fakeFetch([]);
    const api = createApi({ baseUrl: "http://dash", fetch: f });

    await api.features();
    expect(f).toHaveBeenLastCalledWith("http://dash/features", expect.anything());

    await api.threads();
    expect(f).toHaveBeenLastCalledWith("http://dash/threads", expect.anything());
  });

  it("passes `since` as a query param only when provided", async () => {
    const f = fakeFetch([]);
    const api = createApi({ baseUrl: "http://dash", fetch: f });

    await api.events();
    expect(f).toHaveBeenLastCalledWith("http://dash/events", expect.anything());

    await api.events(1234);
    expect(f).toHaveBeenLastCalledWith(
      "http://dash/events?since=1234",
      expect.anything(),
    );
  });

  it("defaults to a relative base so it works when served by the backend", async () => {
    const f = fakeFetch([]);
    await createApi({ fetch: f }).agents();
    expect(f).toHaveBeenCalledWith("/agents", expect.anything());
  });

  it("strips a trailing slash from baseUrl rather than producing a double slash", async () => {
    const f = fakeFetch([]);
    await createApi({ baseUrl: "http://dash/", fetch: f }).agents();
    expect(f).toHaveBeenCalledWith("http://dash/agents", expect.anything());
  });

  it("throws ApiError carrying the status on a non-OK response", async () => {
    const f = fakeFetch({ error: "nope" }, { ok: false, status: 503 });
    const api = createApi({ fetch: f });

    await expect(api.agents()).rejects.toBeInstanceOf(ApiError);
    await expect(api.agents()).rejects.toMatchObject({ status: 503 });
  });

  it("surfaces a network failure as ApiError rather than a raw TypeError", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    await expect(createApi({ fetch: f }).agents()).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it("surfaces a malformed JSON body as ApiError", async () => {
    const f = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    })) as unknown as typeof fetch;

    await expect(createApi({ fetch: f }).agents()).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});
