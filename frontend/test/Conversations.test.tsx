import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { Conversations } from "../src/components/Conversations";
import type { Message, Thread } from "../src/types";

const T0 = 1_700_000_000_000;

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "m1",
    ts: T0,
    from_agent: "payments",
    to_agent: "search",
    channel: "inter_agent",
    body: "here is the interface I need",
    session_id: "sess-1",
    ...overrides,
  };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  const messages = overrides.messages ?? [message()];
  return {
    id: "payments|search",
    participants: ["payments", "search"],
    last_ts: T0,
    last_body: "here is the interface I need",
    ...overrides,
    messages,
  };
}

/** The accessible channel signal: a per-message element labelled with the channel. */
function channelBadge(messageId: string): HTMLElement {
  return screen.getByTestId(`message-channel-${messageId}`);
}

describe("Conversations", () => {
  it("renders one entry per thread with both participants and a last_body preview", () => {
    render(
      <Conversations
        threads={[
          thread({
            id: "payments|search",
            participants: ["payments", "search"],
            last_body: "agreed on the schema",
          }),
          thread({
            id: "lead|payments",
            participants: ["lead", "payments"],
            last_body: "please pick up billing",
          }),
        ]}
      />,
    );

    const list = screen.getByRole("list", { name: /conversations/i });
    const entries = within(list).getAllByRole("button");
    expect(entries).toHaveLength(2);

    expect(entries[0]).toHaveTextContent(/payments/);
    expect(entries[0]).toHaveTextContent(/search/);
    expect(entries[0]).toHaveTextContent(/agreed on the schema/);
    expect(entries[1]).toHaveTextContent(/lead/);
    expect(entries[1]).toHaveTextContent(/please pick up billing/);
  });

  it("keeps the thread order it is given and does not re-sort by last_ts", () => {
    render(
      <Conversations
        threads={[
          thread({ id: "a|b", participants: ["a", "b"], last_ts: T0 - 90_000 }),
          thread({ id: "c|d", participants: ["c", "d"], last_ts: T0 }),
        ]}
      />,
    );

    const entries = screen.getAllByRole("button");
    expect(entries[0]).toHaveTextContent(/a/);
    expect(entries[0]).toHaveTextContent(/b/);
    expect(entries[1]).toHaveTextContent(/c/);
    expect(entries[1]).toHaveTextContent(/d/);
  });

  it("calls onSelectThread with the thread id when an entry is clicked", () => {
    const onSelectThread = vi.fn();
    render(
      <Conversations
        threads={[
          thread({ id: "payments|search", participants: ["payments", "search"] }),
          thread({ id: "lead|payments", participants: ["lead", "payments"] }),
        ]}
        onSelectThread={onSelectThread}
      />,
    );

    fireEvent.click(screen.getAllByRole("button")[1]);

    expect(onSelectThread).toHaveBeenCalledTimes(1);
    expect(onSelectThread).toHaveBeenCalledWith("lead|payments");
  });

  it("does not crash when clicked without an onSelectThread handler", () => {
    render(<Conversations threads={[thread()]} />);

    expect(() => fireEvent.click(screen.getAllByRole("button")[0])).not.toThrow();
  });

  it("marks the selected entry accessibly with aria-current and leaves others unmarked", () => {
    render(
      <Conversations
        threads={[
          thread({ id: "payments|search", participants: ["payments", "search"] }),
          thread({ id: "lead|payments", participants: ["lead", "payments"] }),
        ]}
        selectedThreadId="lead|payments"
      />,
    );

    const entries = screen.getAllByRole("button");
    expect(entries[1]).toHaveAttribute("aria-current", "true");
    expect(entries[0]).not.toHaveAttribute("aria-current", "true");
  });

  it("shows only the selected thread's messages", () => {
    render(
      <Conversations
        threads={[
          thread({
            id: "payments|search",
            participants: ["payments", "search"],
            messages: [message({ id: "m1", body: "only in payments thread" })],
          }),
          thread({
            id: "lead|payments",
            participants: ["lead", "payments"],
            messages: [message({ id: "m2", body: "only in lead thread" })],
          }),
        ]}
        selectedThreadId="lead|payments"
      />,
    );

    expect(screen.getByText("only in lead thread")).toBeInTheDocument();
    expect(screen.queryByText("only in payments thread")).not.toBeInTheDocument();
  });

  it("prompts to select a conversation when selectedThreadId is undefined", () => {
    render(
      <Conversations
        threads={[
          thread({
            last_body: "agreed on the schema",
            messages: [message({ id: "m1", body: "a body only in the transcript" })],
          }),
        ]}
      />,
    );

    expect(screen.getByText(/select a conversation/i)).toBeInTheDocument();
    // The preview is still listed, but no message bubbles are rendered.
    expect(screen.queryByText("a body only in the transcript")).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: /messages/i })).not.toBeInTheDocument();
  });

  it("prompts gracefully instead of crashing when selectedThreadId matches no thread", () => {
    render(<Conversations threads={[thread()]} selectedThreadId="does-not-exist" />);

    expect(screen.getByText(/select a conversation/i)).toBeInTheDocument();
  });

  it("renders messages in the given order, each attributed to its sender", () => {
    render(
      <Conversations
        selectedThreadId="payments|search"
        threads={[
          thread({
            messages: [
              message({ id: "m1", from_agent: "payments", body: "first thing" }),
              message({
                id: "m2",
                from_agent: "search",
                to_agent: "payments",
                body: "second thing",
              }),
              message({ id: "m3", from_agent: "payments", body: "third thing" }),
            ],
          }),
        ]}
      />,
    );

    const bubbles = within(
      screen.getByRole("list", { name: /messages/i }),
    ).getAllByRole("listitem");

    expect(bubbles).toHaveLength(3);
    expect(bubbles[0]).toHaveTextContent(/payments/);
    expect(bubbles[0]).toHaveTextContent("first thing");
    expect(bubbles[1]).toHaveTextContent(/search/);
    expect(bubbles[1]).toHaveTextContent("second thing");
    expect(bubbles[2]).toHaveTextContent("third thing");
  });

  it("distinguishes the two channels with accessible labels, not styling alone", () => {
    render(
      <Conversations
        selectedThreadId="payments|search"
        threads={[
          thread({
            messages: [
              message({ id: "m1", channel: "inter_agent" }),
              message({ id: "m2", channel: "human_web" }),
            ],
          }),
        ]}
      />,
    );

    const agentBadge = channelBadge("m1");
    const humanBadge = channelBadge("m2");

    expect(agentBadge).toHaveAttribute("aria-label", "Agent to agent message");
    expect(humanBadge).toHaveAttribute("aria-label", "Human via web message");
    expect(agentBadge.getAttribute("aria-label")).not.toEqual(
      humanBadge.getAttribute("aria-label"),
    );
    expect(screen.getByLabelText("Human via web message")).toBeInTheDocument();
  });

  it("renders a redaction marker in a body as literal visible text", () => {
    const body = "the key is [REDACTED:github-token] so use the env var";
    render(
      <Conversations
        selectedThreadId="payments|search"
        threads={[thread({ messages: [message({ id: "m1", body })] })]}
      />,
    );

    expect(screen.getByText(body)).toBeInTheDocument();
    expect(screen.getByText(/\[REDACTED:github-token\]/)).toBeInTheDocument();
  });

  it("renders message bodies as plain text and never as HTML", () => {
    const body = '<script>alert(1)</script><img src=x onerror="alert(2)">';
    const { container } = render(
      <Conversations
        selectedThreadId="payments|search"
        threads={[thread({ messages: [message({ id: "m1", body })] })]}
      />,
    );

    expect(screen.getByText(body)).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders a long unbroken body without dropping it, using word-breaking classes", () => {
    const body = "x".repeat(500);
    render(
      <Conversations
        selectedThreadId="payments|search"
        threads={[thread({ messages: [message({ id: "m1", body })] })]}
      />,
    );

    const rendered = screen.getByText(body);
    expect(rendered).toBeInTheDocument();
    expect(rendered.className).toMatch(/break-(words|all)/);
  });

  it("renders a clear empty state when there are no threads", () => {
    render(<Conversations threads={[]} />);

    expect(screen.getByText(/no conversations/i)).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("does not crash on a selected thread with zero messages", () => {
    render(
      <Conversations
        selectedThreadId="payments|search"
        threads={[thread({ messages: [], last_body: "" })]}
      />,
    );

    expect(screen.getByText(/no messages/i)).toBeInTheDocument();
  });
});
