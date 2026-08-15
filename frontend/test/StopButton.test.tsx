import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StopButton } from "../src/components/StopButton";

/** The dialog that guards the interrupt. Queried by its agent-naming name. */
function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

describe("StopButton", () => {
  it("renders a Stop control naming the agent", () => {
    render(<StopButton agent="payments" alive={true} onStop={() => {}} />);

    const trigger = screen.getByRole("button", { name: /stop payments/i });
    expect(trigger.tagName).toBe("BUTTON");
    // No dialog until the user asks for one.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not call onStop on the first click — it opens a confirmation naming the agent", async () => {
    const onStop = vi.fn();
    render(<StopButton agent="payments" alive={true} onStop={onStop} />);

    await userEvent.click(screen.getByRole("button", { name: /stop payments/i }));

    // A mis-click cannot fire the interrupt; a confirmation is required first.
    expect(onStop).not.toHaveBeenCalled();
    const d = dialog();
    expect(d).toHaveAttribute("aria-modal", "true");
    // A screen-reader user must know which agent they are about to stop.
    expect(d).toHaveAccessibleName(/payments/i);
    expect(d).toHaveTextContent(/payments/);
    expect(d).toHaveTextContent(/interrupt/i);
  });

  it("calls onStop exactly once with the agent name when the user confirms", async () => {
    const onStop = vi.fn();
    render(<StopButton agent="payments" alive={true} onStop={onStop} />);

    await userEvent.click(screen.getByRole("button", { name: /stop payments/i }));
    await userEvent.click(
      within(dialog()).getByRole("button", { name: /confirm/i }),
    );

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledWith("payments");
    // The dialog closes once the decision is made.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not call onStop when the user cancels, and closes the dialog", async () => {
    const onStop = vi.fn();
    render(<StopButton agent="payments" alive={true} onStop={onStop} />);

    await userEvent.click(screen.getByRole("button", { name: /stop payments/i }));
    await userEvent.click(
      within(dialog()).getByRole("button", { name: /cancel/i }),
    );

    expect(onStop).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("reopens the dialog after a cancel — Stop, Cancel, Stop again", async () => {
    const onStop = vi.fn();
    render(<StopButton agent="payments" alive={true} onStop={onStop} />);

    await userEvent.click(screen.getByRole("button", { name: /stop payments/i }));
    await userEvent.click(within(dialog()).getByRole("button", { name: /cancel/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /stop payments/i }));
    expect(dialog()).toBeInTheDocument();

    await userEvent.click(within(dialog()).getByRole("button", { name: /confirm/i }));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledWith("payments");
  });

  it("disables Stop for a dead agent with an accessible reason and cannot fire", async () => {
    const onStop = vi.fn();
    render(<StopButton agent="payments" alive={false} onStop={onStop} />);

    const trigger = screen.getByRole("button", { name: /stop payments/i });
    expect(trigger).toBeDisabled();
    // The reason nothing can be interrupted is spelled out, not left implicit.
    expect(trigger).toHaveAccessibleName(/not running|nothing to interrupt/i);

    await userEvent.click(trigger);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onStop).not.toHaveBeenCalled();
  });

  it("shows an in-progress status while a stop is in flight and cannot be double-fired", async () => {
    const onStop = vi.fn();
    render(<StopButton agent="payments" alive={true} busy={true} onStop={onStop} />);

    const status = screen.getByRole("status", { name: /stopping payments/i });
    expect(status).toBeInTheDocument();

    // No live trigger to click while a stop is already running.
    expect(screen.queryByRole("button", { name: /^stop payments$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onStop).not.toHaveBeenCalled();
  });

  it("disables Stop with the supplied reason when one is given", async () => {
    const onStop = vi.fn();
    render(
      <StopButton
        agent="payments"
        alive={true}
        onStop={onStop}
        disabledReason="Stop is not configured on this server."
      />,
    );

    const trigger = screen.getByRole("button", { name: /stop payments/i });
    expect(trigger).toBeDisabled();
    expect(screen.getByText(/not configured/i)).toBeInTheDocument();

    await userEvent.click(trigger);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onStop).not.toHaveBeenCalled();
  });

  it("renders a script-looking agent name as literal text and creates no element", async () => {
    const payload = "<script>alert(1)</script>";
    const { container } = render(
      <StopButton agent={payload} alive={true} onStop={() => {}} />,
    );

    // Open the dialog so the name is rendered in both the trigger and the dialog.
    await userEvent.click(screen.getByRole("button", { name: /stop/i }));

    expect(container.querySelector("script")).toBeNull();
    expect(
      [...document.querySelectorAll("script")].some((s) =>
        s.textContent?.includes("alert(1)"),
      ),
    ).toBe(false);
    expect(screen.getAllByText(new RegExp(escapeRegExp(payload))).length).toBeGreaterThan(0);
    // Rendered as escaped body text, never as live markup. (The name also
    // appears inside an aria-label attribute, which the browser never parses
    // as HTML, so the meaningful guarantee is "no element + escaped text".)
    expect(container.innerHTML).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

/** So the raw payload can be matched literally by getAllByText. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
