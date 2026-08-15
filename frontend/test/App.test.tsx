import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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
    sendChat: vi.fn(async () => ({ turnId: "turn-1" })),
    chatHistory: vi.fn(async () => []),
    stopAgent: vi.fn(async () => ({
      id: "ev1",
      type: "agent_stopped",
      agent: "payments",
      ts: 1,
    })),
    ...over,
  };
}

/** Captures the callback for one SSE channel so a test can emit frames. */
function channelFactory(channel: string) {
  const box: { emit?: (e: { data: string }) => void } = {};
  const factory = () => ({
    addEventListener(type: string, cb: (e: { data: string }) => void) {
      if (type === channel) box.emit = cb;
    },
    close() {},
  });
  return { factory, box };
}

const chatToggle = () => screen.getByRole("button", { name: /^chat$/i });

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

describe("App stop control", () => {
  it("stops an agent from the team board only after a confirmation naming it", async () => {
    const api = fakeApi();
    renderApp(api);
    await screen.findByText("payments");

    // A single click opens the confirmation; it must NOT call the endpoint yet.
    await userEvent.click(screen.getByRole("button", { name: /stop payments/i }));
    expect(api.stopAgent).not.toHaveBeenCalled();

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleName(/payments/i);

    await userEvent.click(within(dialog).getByRole("button", { name: /confirm/i }));
    await waitFor(() => expect(api.stopAgent).toHaveBeenCalledWith("payments"));
  });

  it("does not call the endpoint when the confirmation is cancelled", async () => {
    const api = fakeApi();
    renderApp(api);
    await screen.findByText("payments");

    await userEvent.click(screen.getByRole("button", { name: /stop payments/i }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /cancel/i }),
    );

    expect(api.stopAgent).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("disables further stops with a standing reason when the server answers 503", async () => {
    const api = fakeApi({
      stopAgent: vi.fn(async () => {
        throw new ApiError("stop not configured", 503);
      }),
    });
    renderApp(api);
    await screen.findByText("payments");

    await userEvent.click(screen.getByRole("button", { name: /stop payments/i }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /confirm/i }),
    );

    // The reason is surfaced and the control is disabled, but the app is intact.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /stop payments/i })).toBeDisabled(),
    );
    expect(screen.getByText(/not configured/i)).toBeInTheDocument();
    expect(screen.getByText("running tests")).toBeInTheDocument();
  });

  it("keeps the dashboard usable when a stop fails for another reason", async () => {
    const api = fakeApi({
      stopAgent: vi.fn(async () => {
        throw new ApiError("boom", 500);
      }),
    });
    renderApp(api);
    await screen.findByText("payments");

    await userEvent.click(screen.getByRole("button", { name: /stop payments/i }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /confirm/i }),
    );

    await waitFor(() => expect(api.stopAgent).toHaveBeenCalled());
    // The board still shows the agent — no blank page.
    expect(screen.getByText("running tests")).toBeInTheDocument();
  });
});

describe("App chat drawer", () => {
  it("offers the chat drawer from every view", async () => {
    renderApp();
    await screen.findByText("payments");

    expect(chatToggle()).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: /pipeline/i }));
    expect(chatToggle()).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: /conversations/i }));
    expect(chatToggle()).toBeInTheDocument();
  });

  it("stays available inside an agent's detail view", async () => {
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "payments" }));
    await screen.findByText("first chunk of output");

    expect(chatToggle()).toBeInTheDocument();
  });

  it("opens and closes the drawer", async () => {
    renderApp();
    await screen.findByText("payments");

    expect(screen.queryByRole("log")).not.toBeInTheDocument();
    await userEvent.click(chatToggle());
    expect(screen.getByRole("log")).toBeInTheDocument();

    await userEvent.click(chatToggle());
    expect(screen.queryByRole("log")).not.toBeInTheDocument();
  });

  it("loads chat history on mount and shows it as completed turns", async () => {
    const api = fakeApi({
      chatHistory: vi.fn(async () => [
        {
          id: "t1:in",
          ts: 1,
          from_agent: "Amirreza",
          to_agent: "web-lead",
          channel: "human_web" as const,
          body: "how is checkout?",
          session_id: null,
        },
        {
          id: "t1:out",
          ts: 2,
          from_agent: "web-lead",
          to_agent: "Amirreza",
          channel: "human_web" as const,
          body: "spec is merged",
          session_id: null,
        },
      ]),
    });
    renderApp(api);
    await screen.findByText("payments");

    await userEvent.click(chatToggle());

    expect(await screen.findByText("how is checkout?")).toBeInTheDocument();
    expect(screen.getByText("spec is merged")).toBeInTheDocument();
    expect(screen.getByText("Amirreza")).toBeInTheDocument();
    expect(
      screen.queryByRole("status", { name: /reply in progress/i }),
    ).not.toBeInTheDocument();
  });

  it("pairs history by turn id, not by position, so interleaved users don't cross", async () => {
    // Two people share one lead. Even serialized, a failed turn (prompt with no
    // reply) or any interleaving breaks strict-alternation pairing — Bob's
    // prompt would be shown as the answer to Alice. Pairing by the turn id in
    // the message id keeps each turn intact.
    const api = fakeApi({
      chatHistory: vi.fn(async () => [
        { id: "tA:in", ts: 1, from_agent: "Alice", to_agent: "web-lead", channel: "human_web" as const, body: "alice asks", session_id: null },
        { id: "tB:in", ts: 2, from_agent: "Bob", to_agent: "web-lead", channel: "human_web" as const, body: "bob asks", session_id: null },
        { id: "tA:out", ts: 3, from_agent: "web-lead", to_agent: "Alice", channel: "human_web" as const, body: "answer for alice", session_id: null },
        { id: "tB:out", ts: 4, from_agent: "web-lead", to_agent: "Bob", channel: "human_web" as const, body: "answer for bob", session_id: null },
      ]),
    });
    renderApp(api);
    await screen.findByText("payments");
    await userEvent.click(chatToggle());

    // Alice's turn shows Alice's prompt paired with Alice's answer — not Bob's.
    const alicePrompt = await screen.findByText("alice asks");
    const aliceTurn = alicePrompt.closest("li") ?? alicePrompt.parentElement!;
    expect(aliceTurn).toHaveTextContent("answer for alice");
    expect(aliceTurn).not.toHaveTextContent("bob asks");
    expect(aliceTurn).not.toHaveTextContent("answer for bob");
  });

  it("keeps the dashboard usable when chat history fails to load", async () => {
    const api = fakeApi({
      chatHistory: vi.fn(async () => {
        throw new ApiError("boom", 500);
      }),
    });
    renderApp(api);

    expect(await screen.findByText("payments")).toBeInTheDocument();
    await userEvent.click(chatToggle());
    expect(screen.getByRole("log")).toBeInTheDocument();
  });

  it("sends a message and shows it as a streaming turn", async () => {
    const api = fakeApi();
    renderApp(api);
    await screen.findByText("payments");
    await userEvent.click(chatToggle());

    await userEvent.type(screen.getByRole("textbox"), "status please{Enter}");

    expect(api.sendChat).toHaveBeenCalledWith("status please");
    expect(await screen.findByText("status please")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: /reply in progress/i }),
      ).toBeInTheDocument(),
    );
  });

  it("appends successive deltas to the reply in arrival order", async () => {
    const { factory, box } = channelFactory("chat");
    const api = fakeApi();
    render(<App api={api} liveFactory={factory} now={2_000} />);
    await screen.findByText("payments");
    await userEvent.click(chatToggle());

    await userEvent.type(screen.getByRole("textbox"), "hello{Enter}");
    await waitFor(() => expect(api.sendChat).toHaveBeenCalled());

    box.emit!({
      data: JSON.stringify({ turnId: "turn-1", kind: "delta", text: "look" }),
    });
    box.emit!({
      data: JSON.stringify({ turnId: "turn-1", kind: "delta", text: "ing at it" }),
    });

    await waitFor(() =>
      expect(screen.getByText("looking at it")).toBeInTheDocument(),
    );
  });

  it("replaces the reply and clears the indicator on a final frame", async () => {
    const { factory, box } = channelFactory("chat");
    const api = fakeApi();
    render(<App api={api} liveFactory={factory} now={2_000} />);
    await screen.findByText("payments");
    await userEvent.click(chatToggle());

    await userEvent.type(screen.getByRole("textbox"), "hello{Enter}");
    await waitFor(() => expect(api.sendChat).toHaveBeenCalled());

    box.emit!({
      data: JSON.stringify({ turnId: "turn-1", kind: "delta", text: "par" }),
    });
    box.emit!({
      data: JSON.stringify({
        turnId: "turn-1",
        kind: "final",
        text: "the complete reply",
      }),
    });

    await waitFor(() =>
      expect(screen.getByText("the complete reply")).toBeInTheDocument(),
    );
    expect(screen.queryByText("par")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("status", { name: /reply in progress/i }),
    ).not.toBeInTheDocument();
  });

  it("marks a turn as failed on an error frame", async () => {
    const { factory, box } = channelFactory("chat");
    const api = fakeApi();
    render(<App api={api} liveFactory={factory} now={2_000} />);
    await screen.findByText("payments");
    await userEvent.click(chatToggle());

    await userEvent.type(screen.getByRole("textbox"), "hello{Enter}");
    await waitFor(() => expect(api.sendChat).toHaveBeenCalled());

    box.emit!({
      data: JSON.stringify({
        turnId: "turn-1",
        kind: "error",
        message: "lead timed out",
      }),
    });

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("lead timed out"),
    );
  });

  it("ignores a chat frame for an unknown turn instead of crashing", async () => {
    const { factory, box } = channelFactory("chat");
    const api = fakeApi();
    render(<App api={api} liveFactory={factory} now={2_000} />);
    await screen.findByText("payments");
    await userEvent.click(chatToggle());

    await userEvent.type(screen.getByRole("textbox"), "hello{Enter}");
    await waitFor(() => expect(api.sendChat).toHaveBeenCalled());

    box.emit!({
      data: JSON.stringify({ turnId: "nope", kind: "delta", text: "stray" }),
    });

    await waitFor(() => expect(screen.getByText("hello")).toBeInTheDocument());
    expect(screen.queryByText("stray")).not.toBeInTheDocument();
  });

  it("disables the composer with a reason when no lead is configured", async () => {
    const api = fakeApi({
      sendChat: vi.fn(async () => {
        throw new ApiError("no lead", 503);
      }),
    });
    renderApp(api);
    await screen.findByText("payments");
    await userEvent.click(chatToggle());

    await userEvent.type(screen.getByRole("textbox"), "anyone home?{Enter}");

    await waitFor(() => expect(screen.getByRole("textbox")).toBeDisabled());
    expect(screen.getByText(/no lead/i)).toBeInTheDocument();
    // The dashboard itself keeps working.
    expect(screen.getByText("running tests")).toBeInTheDocument();
  });
});
