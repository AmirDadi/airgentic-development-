import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatDrawer, type ChatTurn } from "../src/components/ChatDrawer";

let seq = 0;
function turn(over: Partial<ChatTurn> = {}): ChatTurn {
  seq += 1;
  return {
    id: `t${seq}`,
    user: "Amirreza",
    text: "how is checkout going?",
    reply: "",
    status: "done",
    ...over,
  };
}

/** The toggle is the only control guaranteed present in both states. */
function toggle() {
  return screen.getByRole("button", { name: /chat/i });
}

describe("ChatDrawer", () => {
  it("shows a toggle control but no transcript when closed", () => {
    render(
      <ChatDrawer open={false} turns={[]} onSend={vi.fn()} onToggle={vi.fn()} />,
    );

    expect(toggle()).toBeInTheDocument();
    expect(screen.queryByRole("log")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("shows the transcript when open", () => {
    render(
      <ChatDrawer
        open
        turns={[turn({ text: "status please", reply: "all green" })]}
        onSend={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByRole("log")).toBeInTheDocument();
    expect(screen.getByText("status please")).toBeInTheDocument();
    expect(screen.getByText("all green")).toBeInTheDocument();
  });

  it("calls onToggle when the toggle is activated", async () => {
    const onToggle = vi.fn();
    render(
      <ChatDrawer open={false} turns={[]} onSend={vi.fn()} onToggle={onToggle} />,
    );

    await userEvent.click(toggle());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("reports its open state to assistive technology", () => {
    const { rerender } = render(
      <ChatDrawer open={false} turns={[]} onSend={vi.fn()} onToggle={vi.fn()} />,
    );
    expect(toggle()).toHaveAttribute("aria-expanded", "false");

    rerender(
      <ChatDrawer open turns={[]} onSend={vi.fn()} onToggle={vi.fn()} />,
    );
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
  });

  it("renders a clear empty state when there are no turns", () => {
    render(<ChatDrawer open turns={[]} onSend={vi.fn()} onToggle={vi.fn()} />);
    expect(screen.getByText(/no messages yet/i)).toBeInTheDocument();
  });

  it("sends the typed text and clears the input", async () => {
    const onSend = vi.fn();
    render(<ChatDrawer open turns={[]} onSend={onSend} onToggle={vi.fn()} />);

    const input = screen.getByRole("textbox");
    await userEvent.type(input, "ship it");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(onSend).toHaveBeenCalledWith("ship it");
    expect(input).toHaveValue("");
  });

  it("submits from the form itself, so Enter in the input works", async () => {
    const onSend = vi.fn();
    render(<ChatDrawer open turns={[]} onSend={onSend} onToggle={vi.fn()} />);

    await userEvent.type(screen.getByRole("textbox"), "enter works{Enter}");

    expect(onSend).toHaveBeenCalledWith("enter works");
  });

  it("does not send empty or whitespace-only text", async () => {
    const onSend = vi.fn();
    render(<ChatDrawer open turns={[]} onSend={onSend} onToggle={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(onSend).not.toHaveBeenCalled();

    await userEvent.type(screen.getByRole("textbox"), "   {Enter}");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("names who sent each turn, since several people share one lead", () => {
    render(
      <ChatDrawer
        open
        turns={[
          turn({ user: "Amirreza", text: "one" }),
          turn({ user: "Sara", text: "two" }),
        ]}
        onSend={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByText("Amirreza")).toBeInTheDocument();
    expect(screen.getByText("Sara")).toBeInTheDocument();
  });

  it("shows a streaming turn's partial reply with an accessible in-progress indicator", () => {
    render(
      <ChatDrawer
        open
        turns={[turn({ reply: "looking at the br", status: "streaming" })]}
        onSend={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByText("looking at the br")).toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: /reply in progress/i }),
    ).toBeInTheDocument();
  });

  it("shows a completed reply with no in-progress indicator", () => {
    render(
      <ChatDrawer
        open
        turns={[turn({ reply: "all merged", status: "done" })]}
        onSend={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByText("all merged")).toBeInTheDocument();
    expect(
      screen.queryByRole("status", { name: /reply in progress/i }),
    ).not.toBeInTheDocument();
  });

  it("announces a failed turn's error in an alert", () => {
    render(
      <ChatDrawer
        open
        turns={[turn({ status: "error", error: "lead exited with code 1" })]}
        onSend={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("lead exited with code 1");
    expect(
      screen.queryByRole("status", { name: /reply in progress/i }),
    ).not.toBeInTheDocument();
  });

  it("disables input and submit and explains why when no lead is configured", async () => {
    const onSend = vi.fn();
    render(
      <ChatDrawer
        open
        turns={[]}
        onSend={onSend}
        onToggle={vi.fn()}
        disabled
        disabledReason="No lead agent configured."
      />,
    );

    const input = screen.getByRole("textbox");
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
    expect(screen.getByText("No lead agent configured.")).toBeInTheDocument();

    await userEvent.type(input, "hello{Enter}");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("renders markup in a reply as literal text and creates no such elements", () => {
    const hostile = '<script>alert(1)</script><img src=x onerror=alert(1)>';
    const { container } = render(
      <ChatDrawer
        open
        turns={[turn({ text: hostile, reply: hostile })]}
        onSend={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    // No element was created from the payload...
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    // ...and it is visible to the reader exactly as sent.
    expect(screen.getAllByText(hostile).length).toBeGreaterThanOrEqual(2);
  });

  it("renders a redaction marker verbatim", () => {
    render(
      <ChatDrawer
        open
        turns={[turn({ reply: "token is [REDACTED:github-token] now" })]}
        onSend={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    expect(
      screen.getByText("token is [REDACTED:github-token] now"),
    ).toBeInTheDocument();
  });

  it("wraps long unbroken text so it cannot widen the 390px page", () => {
    const long = "a".repeat(400);
    render(
      <ChatDrawer
        open
        turns={[turn({ text: long, reply: long })]}
        onSend={vi.fn()}
        onToggle={vi.fn()}
      />,
    );

    for (const node of screen.getAllByText(long)) {
      expect(node.className).toMatch(/break-words/);
    }
  });
});
