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

  it("requests an agent's entries from its own endpoint", async () => {
    const f = fakeFetch([]);
    const api = createApi({ baseUrl: "http://dash", fetch: f });

    await api.agentEntries("payments");
    expect(f).toHaveBeenLastCalledWith(
      "http://dash/agents/payments/entries",
      expect.anything(),
    );
  });

  it("passes `limit` as a query param only when provided", async () => {
    const f = fakeFetch([]);
    const api = createApi({ baseUrl: "http://dash", fetch: f });

    await api.agentEntries("payments", 50);
    expect(f).toHaveBeenLastCalledWith(
      "http://dash/agents/payments/entries?limit=50",
      expect.anything(),
    );
  });

  it("encodes an agent name that would otherwise break the path", async () => {
    const f = fakeFetch([]);
    const api = createApi({ baseUrl: "http://dash", fetch: f });

    await api.agentEntries("team/lead");
    expect(f).toHaveBeenLastCalledWith(
      "http://dash/agents/team%2Flead/entries",
      expect.anything(),
    );
  });

  it("returns the parsed entries body", async () => {
    const entry = {
      id: "e1",
      agent: "payments",
      ts: 5,
      kind: "assistant_text",
      entry: { kind: "assistant_text", ts: 5, text: "hi" },
      session_id: "s1",
    };
    const api = createApi({ fetch: fakeFetch([entry]) });
    await expect(api.agentEntries("payments")).resolves.toEqual([entry]);
  });

  it("surfaces an entries failure as ApiError carrying the status", async () => {
    const f = fakeFetch({ error: "no such agent" }, { ok: false, status: 404 });
    await expect(
      createApi({ fetch: f }).agentEntries("ghost"),
    ).rejects.toMatchObject({ status: 404 });
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

  it("posts chat text and returns the turn id", async () => {
    const f = fakeFetch({ turnId: "turn-1" }, { status: 202 });
    const api = createApi({ baseUrl: "http://dash", fetch: f });

    await expect(api.sendChat("ship it")).resolves.toEqual({ turnId: "turn-1" });
    expect(f).toHaveBeenLastCalledWith(
      "http://dash/chat",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ text: "ship it" }),
      }),
    );
  });

  it("includes the user in the chat body only when provided", async () => {
    const f = fakeFetch({ turnId: "t2" }, { status: 202 });
    const api = createApi({ baseUrl: "http://dash", fetch: f });

    await api.sendChat("hi", "Amirreza");
    expect(f).toHaveBeenLastCalledWith(
      "http://dash/chat",
      expect.objectContaining({
        body: JSON.stringify({ text: "hi", user: "Amirreza" }),
      }),
    );
  });

  it("sends the chat body as JSON", async () => {
    const f = fakeFetch({ turnId: "t3" }, { status: 202 });
    await createApi({ baseUrl: "http://dash", fetch: f }).sendChat("hi");

    const init = (f as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toMatch(/application\/json/);
  });

  it("surfaces a chat rejection as ApiError carrying the status", async () => {
    const f = fakeFetch({ error: "empty text" }, { ok: false, status: 400 });
    await expect(
      createApi({ fetch: f }).sendChat(""),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("surfaces a missing lead as ApiError carrying 503", async () => {
    const f = fakeFetch({ error: "no lead" }, { ok: false, status: 503 });
    const rejected = createApi({ fetch: f }).sendChat("hi");
    await expect(rejected).rejects.toBeInstanceOf(ApiError);
    await expect(createApi({ fetch: f }).sendChat("hi")).rejects.toMatchObject({
      status: 503,
    });
  });

  it("requests chat history from its own endpoint and returns it", async () => {
    const message = {
      id: "m1",
      ts: 1,
      from_agent: "Amirreza",
      to_agent: "lead",
      channel: "human_web",
      body: "hi",
      session_id: null,
    };
    const f = fakeFetch([message]);
    const api = createApi({ baseUrl: "http://dash", fetch: f });

    await expect(api.chatHistory()).resolves.toEqual([message]);
    expect(f).toHaveBeenLastCalledWith(
      "http://dash/chat/history",
      expect.anything(),
    );
  });

  it("surfaces a chat history failure as ApiError", async () => {
    const f = fakeFetch({ error: "nope" }, { ok: false, status: 500 });
    await expect(createApi({ fetch: f }).chatHistory()).rejects.toBeInstanceOf(
      ApiError,
    );
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
