import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TeamBoard } from "../src/components/TeamBoard";
import type { Agent } from "../src/types";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    name: "payments",
    kind: "worker",
    workdir: "/srv/agents/payments",
    alive: true,
    last_seen: NOW - MINUTE,
    current_activity: "running tests in api/handlers_test.go",
    ...overrides,
  };
}

/** The accessible health signal: a per-agent status element labelled with the state. */
function health(name: string): HTMLElement {
  return screen.getByTestId(`agent-health-${name}`);
}

describe("TeamBoard", () => {
  it("renders a card per agent with its name and current activity", () => {
    render(
      <TeamBoard
        now={NOW}
        agents={[
          agent({ name: "payments", current_activity: "writing the spec" }),
          agent({ name: "search", current_activity: "opening a PR" }),
        ]}
      />,
    );

    expect(screen.getByText("payments")).toBeInTheDocument();
    expect(screen.getByText("writing the spec")).toBeInTheDocument();
    expect(screen.getByText("search")).toBeInTheDocument();
    expect(screen.getByText("opening a PR")).toBeInTheDocument();
  });

  it("marks an alive, recently-seen agent as healthy", () => {
    render(<TeamBoard now={NOW} agents={[agent({ last_seen: NOW - MINUTE })]} />);

    const badge = health("payments");
    expect(badge).toHaveAttribute("aria-label", "payments is healthy");
    expect(badge).toHaveTextContent(/healthy/i);
    expect(screen.getByLabelText("payments is healthy")).toBeInTheDocument();
  });

  it("marks an alive but long-silent agent as stalled using the default 10 minute threshold", () => {
    render(<TeamBoard now={NOW} agents={[agent({ last_seen: NOW - 11 * MINUTE })]} />);

    const badge = health("payments");
    expect(badge).toHaveAttribute("aria-label", "payments is stalled");
    expect(badge).toHaveTextContent(/stalled/i);
  });

  it("stays healthy just inside the default threshold", () => {
    render(<TeamBoard now={NOW} agents={[agent({ last_seen: NOW - 9 * MINUTE })]} />);

    expect(health("payments")).toHaveAttribute("aria-label", "payments is healthy");
  });

  it("honours an injected stalledAfterMs threshold", () => {
    render(
      <TeamBoard
        now={NOW}
        stalledAfterMs={30_000}
        agents={[agent({ last_seen: NOW - MINUTE })]}
      />,
    );

    expect(health("payments")).toHaveAttribute("aria-label", "payments is stalled");
  });

  it("marks a not-alive agent as dead regardless of how recently it was seen", () => {
    render(
      <TeamBoard now={NOW} agents={[agent({ alive: false, last_seen: NOW - 1_000 })]} />,
    );

    const badge = health("payments");
    expect(badge).toHaveAttribute("aria-label", "payments is dead");
    expect(badge).toHaveTextContent(/dead/i);
  });

  it("does not crash on a null last_seen and does not report it as freshly active", () => {
    render(<TeamBoard now={NOW} agents={[agent({ alive: true, last_seen: null })]} />);

    const badge = health("payments");
    expect(badge).not.toHaveAttribute("aria-label", "payments is healthy");
    expect(badge).toHaveTextContent(/stalled/i);
  });

  it("renders a fallback instead of an empty card or the literal null for a null activity", () => {
    render(<TeamBoard now={NOW} agents={[agent({ current_activity: null })]} />);

    expect(screen.getByText(/activity unknown/i)).toBeInTheDocument();
    expect(screen.queryByText("null")).not.toBeInTheDocument();
  });

  it("renders a clear empty state when there are no agents", () => {
    render(<TeamBoard now={NOW} agents={[]} />);

    expect(screen.getByText(/no agents/i)).toBeInTheDocument();
  });

  it("makes each agent name a button that reports the selection when onSelectAgent is given", async () => {
    const onSelectAgent = vi.fn();
    render(
      <TeamBoard
        now={NOW}
        onSelectAgent={onSelectAgent}
        agents={[agent({ name: "payments" }), agent({ name: "search" })]}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "search" }));
    expect(onSelectAgent).toHaveBeenCalledWith("search");
  });

  it("renders no agent buttons when onSelectAgent is not given", () => {
    render(<TeamBoard now={NOW} agents={[agent({ name: "payments" })]} />);

    expect(screen.queryByRole("button", { name: "payments" })).not.toBeInTheDocument();
    expect(screen.getByText("payments")).toBeInTheDocument();
  });

  it("renders every agent when several are present, each with its own health signal", () => {
    render(
      <TeamBoard
        now={NOW}
        agents={[
          agent({ name: "lead" }),
          agent({ name: "payments", last_seen: NOW - 60 * MINUTE }),
          agent({ name: "search", alive: false }),
        ]}
      />,
    );

    expect(health("lead")).toHaveAttribute("aria-label", "lead is healthy");
    expect(health("payments")).toHaveAttribute("aria-label", "payments is stalled");
    expect(health("search")).toHaveAttribute("aria-label", "search is dead");
  });
});
