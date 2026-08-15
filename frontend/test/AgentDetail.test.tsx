import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentDetail } from "../src/components/AgentDetail";
import type { Agent, StoredEntry, TranscriptEntry } from "../src/types";

const NOW = 1_700_000_000_000;

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    name: "payments",
    kind: "worker",
    workdir: "/srv/agents/payments",
    alive: true,
    last_seen: NOW,
    current_activity: "running tests",
    ...overrides,
  };
}

let seq = 0;
function stored(entry: TranscriptEntry, overrides: Partial<StoredEntry> = {}): StoredEntry {
  seq += 1;
  return {
    id: `e${seq}`,
    agent: "payments",
    ts: NOW + seq,
    kind: entry.kind,
    entry,
    session_id: "s1",
    ...overrides,
  };
}

const turnEnd = (): StoredEntry => stored({ kind: "turn_end", ts: NOW });

describe("AgentDetail", () => {
  it("names the agent it is showing", () => {
    render(<AgentDetail agent={agent()} entries={[]} />);
    expect(screen.getByRole("heading", { name: /payments/ })).toBeInTheDocument();
  });

  it("renders a clear empty state naming the agent when there are no entries", () => {
    render(<AgentDetail agent={agent()} entries={[]} />);

    const empty = screen.getByText(/no output/i);
    expect(empty).toBeInTheDocument();
    expect(empty).toHaveTextContent(/payments/);
  });

  it("calls onBack when the back control is activated", async () => {
    const onBack = vi.fn();
    render(<AgentDetail agent={agent()} entries={[]} onBack={onBack} />);

    const back = screen.getByRole("button", { name: /back/i });
    expect(back.tagName).toBe("BUTTON");
    await userEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("does not crash when no onBack is supplied", async () => {
    render(<AgentDetail agent={agent()} entries={[]} />);
    await userEvent.click(screen.getByRole("button", { name: /back/i }));
  });

  it("renders assistant text", () => {
    render(
      <AgentDetail
        agent={agent()}
        entries={[stored({ kind: "assistant_text", ts: NOW, text: "I will run the tests" })]}
      />,
    );
    expect(screen.getByText("I will run the tests")).toBeInTheDocument();
    expect(screen.getByText(/assistant/i)).toBeInTheDocument();
  });

  it("renders user text distinctly from assistant text", () => {
    render(
      <AgentDetail
        agent={agent()}
        entries={[
          stored({ kind: "assistant_text", ts: NOW, text: "assistant says this" }),
          stored({ kind: "user_text", ts: NOW, text: "user says that" }),
        ]}
      />,
    );

    const assistant = screen.getByText("assistant says this").closest("li")!;
    const user = screen.getByText("user says that").closest("li")!;
    expect(assistant).not.toBe(user);
    expect(assistant.getAttribute("data-kind")).toBe("assistant_text");
    expect(user.getAttribute("data-kind")).toBe("user_text");
  });

  it("renders thinking text, present but de-emphasised", () => {
    render(
      <AgentDetail
        agent={agent()}
        entries={[stored({ kind: "thinking", ts: NOW, text: "maybe check the config" })]}
      />,
    );

    const text = screen.getByText("maybe check the config");
    expect(text).toBeInTheDocument();
    // De-emphasised, not hidden: still in the accessibility tree.
    expect(text.closest("li")).toHaveAttribute("data-kind", "thinking");
    expect(text.closest("li")).not.toHaveAttribute("aria-hidden");
    expect(screen.getByText(/thinking/i)).toBeInTheDocument();
  });

  it("renders a tool call with its tool name and summary", () => {
    render(
      <AgentDetail
        agent={agent()}
        entries={[
          stored({
            kind: "tool_call",
            ts: NOW,
            tool: "Bash",
            summary: "npm test -- handlers",
            id: "tu_1",
          }),
        ]}
      />,
    );

    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("npm test -- handlers")).toBeInTheDocument();
  });

  it("renders a successful tool result and labels its outcome accessibly", () => {
    render(
      <AgentDetail
        agent={agent()}
        entries={[
          stored({
            kind: "tool_result",
            ts: NOW,
            tool_use_id: "tu_1",
            ok: true,
            summary: "12 tests passed",
          }),
        ]}
      />,
    );

    expect(screen.getByText("12 tests passed")).toBeInTheDocument();
    const badge = screen.getByLabelText(/tool result: succeeded/i);
    expect(badge).toBeInTheDocument();
    // Not colour alone: the outcome is spelled out in text too.
    expect(badge).toHaveTextContent(/ok|succeeded/i);
  });

  it("renders a failed tool result and labels its outcome accessibly", () => {
    render(
      <AgentDetail
        agent={agent()}
        entries={[
          stored({
            kind: "tool_result",
            ts: NOW,
            tool_use_id: "tu_1",
            ok: false,
            summary: "exit code 1",
          }),
        ]}
      />,
    );

    expect(screen.getByText("exit code 1")).toBeInTheDocument();
    const badge = screen.getByLabelText(/tool result: failed/i);
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent(/fail/i);
    expect(screen.queryByLabelText(/tool result: succeeded/i)).not.toBeInTheDocument();
  });

  it("renders a sent message with its direction and peer", () => {
    render(
      <AgentDetail
        agent={agent()}
        entries={[
          stored({
            kind: "send_message",
            ts: NOW,
            direction: "sent",
            peer: "lead",
            body: "spec is ready",
          }),
        ]}
      />,
    );

    expect(screen.getByText(/sent to/i)).toBeInTheDocument();
    expect(screen.getByText("lead")).toBeInTheDocument();
    expect(screen.getByText("spec is ready")).toBeInTheDocument();
  });

  it("renders a received message with its direction and peer", () => {
    render(
      <AgentDetail
        agent={agent()}
        entries={[
          stored({
            kind: "send_message",
            ts: NOW,
            direction: "received",
            peer: "search",
            body: "please review",
          }),
        ]}
      />,
    );

    expect(screen.getByText(/received from/i)).toBeInTheDocument();
    expect(screen.getByText("search")).toBeInTheDocument();
    expect(screen.getByText("please review")).toBeInTheDocument();
  });

  it("renders a system event as a minor line", () => {
    render(
      <AgentDetail
        agent={agent()}
        entries={[
          stored({ kind: "system_event", ts: NOW, event: "compaction", detail: "context trimmed" }),
        ]}
      />,
    );

    expect(screen.getByText("compaction")).toBeInTheDocument();
    expect(screen.getByText("context trimmed")).toBeInTheDocument();
  });

  it("renders turn_end as a clear boundary marker", () => {
    render(<AgentDetail agent={agent()} entries={[turnEnd()]} />);

    const marker = screen.getByText(/turn ended/i);
    expect(marker).toBeInTheDocument();
    expect(marker.closest("li")).toHaveAttribute("data-kind", "turn_end");
  });

  it("renders an unrecognised entry explicitly rather than blank", () => {
    render(
      <AgentDetail
        agent={agent()}
        entries={[stored({ kind: "unknown", ts: NOW, raw: '{"weird":true}' })]}
      />,
    );

    expect(screen.getByText(/unrecognised entry/i)).toBeInTheDocument();
    expect(screen.getByText('{"weird":true}')).toBeInTheDocument();
  });

  it("renders every kind at once without dropping any", () => {
    render(
      <AgentDetail
        agent={agent()}
        entries={[
          stored({ kind: "user_text", ts: NOW, text: "go" }),
          stored({ kind: "thinking", ts: NOW, text: "hmm" }),
          stored({ kind: "assistant_text", ts: NOW, text: "on it" }),
          stored({ kind: "tool_call", ts: NOW, tool: "Read", summary: "src/app.ts", id: "t1" }),
          stored({ kind: "tool_result", ts: NOW, tool_use_id: "t1", ok: true, summary: "read 40 lines" }),
          stored({ kind: "send_message", ts: NOW, direction: "sent", peer: "lead", body: "done" }),
          stored({ kind: "system_event", ts: NOW, event: "hook", detail: "pre-commit" }),
          stored({ kind: "unknown", ts: NOW, raw: "??" }),
          turnEnd(),
        ]}
      />,
    );

    expect(screen.getAllByRole("listitem")).toHaveLength(9);
  });

  it("renders entries oldest first, like a terminal", () => {
    render(
      <AgentDetail
        agent={agent()}
        entries={[
          stored({ kind: "assistant_text", ts: NOW, text: "first line" }),
          stored({ kind: "assistant_text", ts: NOW + 1, text: "second line" }),
          stored({ kind: "assistant_text", ts: NOW + 2, text: "third line" }),
        ]}
      />,
    );

    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("first line");
    expect(items[2]).toHaveTextContent("third line");
  });

  it("shows a working indicator when the last entry is not turn_end", () => {
    render(
      <AgentDetail
        agent={agent()}
        entries={[
          turnEnd(),
          stored({ kind: "assistant_text", ts: NOW, text: "still going" }),
        ]}
      />,
    );

    const status = screen.getByRole("status", { name: /payments is working/i });
    expect(status).toHaveTextContent(/working/i);
    expect(screen.queryByRole("status", { name: /payments is idle/i })).not.toBeInTheDocument();
  });

  it("shows an idle indicator when the last entry is turn_end", () => {
    render(
      <AgentDetail
        agent={agent()}
        entries={[stored({ kind: "assistant_text", ts: NOW, text: "all done" }), turnEnd()]}
      />,
    );

    const status = screen.getByRole("status", { name: /payments is idle/i });
    expect(status).toHaveTextContent(/idle/i);
    expect(screen.queryByRole("status", { name: /payments is working/i })).not.toBeInTheDocument();
  });

  it("treats an agent with no entries at all as idle, not working", () => {
    render(<AgentDetail agent={agent()} entries={[]} />);

    expect(screen.getByRole("status", { name: /payments is idle/i })).toBeInTheDocument();
  });

  it("renders script-looking text as literal text and creates no script element", () => {
    const payload = "<script>alert(1)</script>";
    const { container } = render(
      <AgentDetail
        agent={agent()}
        entries={[stored({ kind: "assistant_text", ts: NOW, text: payload })]}
      />,
    );

    expect(screen.getByText(payload)).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect(
      [...document.querySelectorAll("script")].some((s) =>
        s.textContent?.includes("alert(1)"),
      ),
    ).toBe(false);
    expect(container.innerHTML).not.toContain("<script>");
  });

  it("escapes markup in every text-bearing kind", () => {
    const payload = "<img src=x onerror=alert(1)>";
    const { container } = render(
      <AgentDetail
        agent={agent()}
        entries={[
          stored({ kind: "user_text", ts: NOW, text: payload }),
          stored({ kind: "thinking", ts: NOW, text: payload }),
          stored({ kind: "tool_call", ts: NOW, tool: payload, summary: payload, id: null }),
          stored({ kind: "tool_result", ts: NOW, tool_use_id: null, ok: false, summary: payload }),
          stored({ kind: "send_message", ts: NOW, direction: "sent", peer: payload, body: payload }),
          stored({ kind: "system_event", ts: NOW, event: payload, detail: payload }),
          stored({ kind: "unknown", ts: NOW, raw: payload }),
        ]}
      />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getAllByText(payload).length).toBeGreaterThan(0);
  });

  it("renders a redaction marker verbatim", () => {
    render(
      <AgentDetail
        agent={agent()}
        entries={[
          stored({
            kind: "send_message",
            ts: NOW,
            direction: "sent",
            peer: "lead",
            body: "token is [REDACTED:github-token] now",
          }),
        ]}
      />,
    );

    expect(screen.getByText("token is [REDACTED:github-token] now")).toBeInTheDocument();
  });

  it("wraps long unbroken strings so they cannot break the 390px layout", () => {
    const long = "a".repeat(400);
    render(
      <AgentDetail
        agent={agent()}
        entries={[stored({ kind: "assistant_text", ts: NOW, text: long })]}
      />,
    );

    expect(screen.getByText(long).className).toMatch(/break-(words|all)/);
  });
});
