import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../src/App";
import type { ApiClient } from "../src/api";
import { ApiError } from "../src/api";
import type { Agent, Feature, StoredEntry, Thread } from "../src/types";

const agent: Agent = {
  name: "payments",
  kind: "node",
  workdir: "/srv/payments",
  alive: true,
  last_seen: 1_000,
  current_activity: "running tests",
};

const feature: Feature = {
  name: "checkout",
  owner: "payments",
  stage: "implementing",
  branch: "feat/checkout",
  pr_url: null,
  updated_at: 1_000,
};

const thread: Thread = {
  id: "lead|payments",
  participants: ["lead", "payments"],
  messages: [
    {
      id: "m1",
      ts: 5,
      from_agent: "lead",
      to_agent: "payments",
      channel: "inter_agent",
      body: "start the spec",
      session_id: "s1",
    },
  ],
  last_ts: 5,
  last_body: "start the spec",
};

function storedEntry(over: Partial<StoredEntry> = {}): StoredEntry {
  return {
    id: "e1",
    agent: "payments",
    ts: 10,
    kind: "assistant_text",
    entry: { kind: "assistant_text", ts: 10, text: "first chunk of output" },
    session_id: "s1",
    ...over,
  };
}

function fakeApi(over: Partial<ApiClient> = {}): ApiClient {
  return {
    agents: vi.fn(async () => [agent]),
    features: vi.fn(async () => [feature]),
    threads: vi.fn(async () => [thread]),
    events: vi.fn(async () => []),
    agentEntries: vi.fn(async () => [storedEntry()]),
    ...over,
  };
}

/** Never connects; App must still render from the REST snapshot. */
const noLive = () => ({ addEventListener() {}, close() {} });

function renderApp(api: ApiClient = fakeApi()) {
  return render(<App api={api} liveFactory={noLive} now={2_000} />);
}

describe("App", () => {
  it("loads the roster and shows the team board first", async () => {
    renderApp();
    expect(await screen.findByText("payments")).toBeInTheDocument();
    expect(screen.getByText("running tests")).toBeInTheDocument();
  });

  it("switches to the pipeline view and shows features", async () => {
    renderApp();
    await screen.findByText("payments");

    await userEvent.click(screen.getByRole("tab", { name: /pipeline/i }));
    expect(await screen.findByText("checkout")).toBeInTheDocument();
  });

  it("switches to the conversations view and shows threads", async () => {
    renderApp();
    await screen.findByText("payments");

    await userEvent.click(screen.getByRole("tab", { name: /conversations/i }));

    // The thread is listed by its participants...
    expect(await screen.findByText(/lead.*payments/)).toBeInTheDocument();
    // ...and the body appears twice by design: once as the list preview and
    // once as the message bubble in the opened thread.
    expect(screen.getAllByText(/start the spec/)).toHaveLength(2);
  });

  it("marks only the active tab as selected", async () => {
    renderApp();
    await screen.findByText("payments");

    expect(screen.getByRole("tab", { name: /team/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.click(screen.getByRole("tab", { name: /pipeline/i }));
    expect(screen.getByRole("tab", { name: /pipeline/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: /team/i })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("surfaces a backend failure instead of rendering a blank page", async () => {
    const api = fakeApi({
      agents: vi.fn(async () => {
        throw new ApiError("boom", 503);
      }),
    });
    renderApp(api);

    expect(await screen.findByRole("alert")).toHaveTextContent(/unreachable|error/i);
  });

  it("applies a live agents update over the initial snapshot", async () => {
    let emit: ((e: { data: string }) => void) | undefined;
    const factory = () => ({
      addEventListener(type: string, cb: (e: { data: string }) => void) {
        if (type === "agents") emit = cb;
      },
      close() {},
    });

    render(<App api={fakeApi()} liveFactory={factory} now={2_000} />);
    await screen.findByText("running tests");

    emit!({
      data: JSON.stringify([{ ...agent, current_activity: "opening a PR" }]),
    });

    await waitFor(() =>
      expect(screen.getByText("opening a PR")).toBeInTheDocument(),
    );
  });

  it("shows the team board, not a detail view, before an agent is selected", async () => {
    renderApp();
    await screen.findByText("running tests");

    expect(screen.queryByRole("button", { name: /back to team/i })).not.toBeInTheDocument();
  });

  it("opens an agent's detail view and loads its entries when selected", async () => {
    const api = fakeApi();
    renderApp(api);

    await userEvent.click(await screen.findByRole("button", { name: "payments" }));

    expect(await screen.findByText("first chunk of output")).toBeInTheDocument();
    expect(api.agentEntries).toHaveBeenCalledWith("payments");
  });

  it("returns to the team board from the detail view", async () => {
    renderApp();

    await userEvent.click(await screen.findByRole("button", { name: "payments" }));
    await screen.findByText("first chunk of output");

    await userEvent.click(screen.getByRole("button", { name: /back to team/i }));

    expect(await screen.findByText("running tests")).toBeInTheDocument();
    expect(screen.queryByText("first chunk of output")).not.toBeInTheDocument();
  });

  it("applies a live entries event for the open agent without refetching", async () => {
    let emit: ((e: { data: string }) => void) | undefined;
    const factory = () => ({
      addEventListener(type: string, cb: (e: { data: string }) => void) {
        if (type === "entries") emit = cb;
      },
      close() {},
    });

    const api = fakeApi();
    render(<App api={api} liveFactory={factory} now={2_000} />);

    await userEvent.click(await screen.findByRole("button", { name: "payments" }));
    await screen.findByText("first chunk of output");
    expect(api.agentEntries).toHaveBeenCalledTimes(1);

    emit!({
      data: JSON.stringify({
        agent: "payments",
        entries: [
          storedEntry(),
          storedEntry({
            id: "e2",
            ts: 11,
            entry: { kind: "assistant_text", ts: 11, text: "second chunk of output" },
          }),
        ],
      }),
    });

    await waitFor(() =>
      expect(screen.getByText("second chunk of output")).toBeInTheDocument(),
    );
    expect(api.agentEntries).toHaveBeenCalledTimes(1);
  });

  it("ignores a live entries event for an agent that is not open", async () => {
    let emit: ((e: { data: string }) => void) | undefined;
    const factory = () => ({
      addEventListener(type: string, cb: (e: { data: string }) => void) {
        if (type === "entries") emit = cb;
      },
      close() {},
    });

    render(<App api={fakeApi()} liveFactory={factory} now={2_000} />);

    await userEvent.click(await screen.findByRole("button", { name: "payments" }));
    await screen.findByText("first chunk of output");

    emit!({
      data: JSON.stringify({
        agent: "search",
        entries: [
          storedEntry({
            id: "x1",
            agent: "search",
            entry: { kind: "assistant_text", ts: 12, text: "someone else's output" },
          }),
        ],
      }),
    });

    await waitFor(() =>
      expect(screen.getByText("first chunk of output")).toBeInTheDocument(),
    );
    expect(screen.queryByText("someone else's output")).not.toBeInTheDocument();
  });
});
