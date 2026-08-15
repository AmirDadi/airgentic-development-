import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoginGate } from "../src/components/LoginGate";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The token field, found by its LABEL — a placeholder is not a label. */
function tokenField(): HTMLElement {
  return screen.getByLabelText(/token/i);
}

describe("LoginGate", () => {
  it("explains what it is, so a team member knows why they are being asked", () => {
    render(<LoginGate onSubmit={() => {}} />);

    // Not a bare box: it says which thing is locked and what is wanted.
    expect(screen.getAllByText(/dashboard/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/shared access token/i)).toBeInTheDocument();
  });

  it("renders a real form with a labelled password-type token input", () => {
    const { container } = render(<LoginGate onSubmit={() => {}} />);

    const field = tokenField();
    // A visible <label>, not a placeholder — placeholders vanish on typing and
    // are not reliably announced.
    expect(field.tagName).toBe("INPUT");
    // The token must not be shoulder-surfable on a shared screen.
    expect(field).toHaveAttribute("type", "password");
    expect(container.querySelector("form")).not.toBeNull();
    expect(screen.getByRole("button", { name: /sign in|log in/i })).toHaveAttribute(
      "type",
      "submit",
    );
  });

  it("submits the token via the form, so Enter works and not only the button", async () => {
    const onSubmit = vi.fn();
    render(<LoginGate onSubmit={onSubmit} />);

    await userEvent.type(tokenField(), "s3cret{Enter}");

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("s3cret");
  });

  it("submits the token when the button is clicked", async () => {
    const onSubmit = vi.fn();
    render(<LoginGate onSubmit={onSubmit} />);

    await userEvent.type(tokenField(), "s3cret");
    await userEvent.click(screen.getByRole("button", { name: /sign in|log in/i }));

    expect(onSubmit).toHaveBeenCalledWith("s3cret");
  });

  it("trims surrounding whitespace off a pasted token", async () => {
    const onSubmit = vi.fn();
    render(<LoginGate onSubmit={onSubmit} />);

    await userEvent.type(tokenField(), "  s3cret  {Enter}");

    expect(onSubmit).toHaveBeenCalledWith("s3cret");
  });

  it("does not submit an empty token", async () => {
    const onSubmit = vi.fn();
    render(<LoginGate onSubmit={onSubmit} />);

    await userEvent.click(screen.getByRole("button", { name: /sign in|log in/i }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit a whitespace-only token", async () => {
    const onSubmit = vi.fn();
    render(<LoginGate onSubmit={onSubmit} />);

    await userEvent.type(tokenField(), "   {Enter}");

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows an error in an alert so it is announced, not only coloured", () => {
    render(
      <LoginGate onSubmit={() => {}} error="That token was not accepted." />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "That token was not accepted.",
    );
  });

  it("shows no alert when there is no error", () => {
    render(<LoginGate onSubmit={() => {}} />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("disables the control and announces progress while busy", () => {
    render(<LoginGate onSubmit={() => {}} busy={true} />);

    expect(tokenField()).toBeDisabled();
    expect(screen.getByRole("button", { name: /sign in|log in|signing/i })).toBeDisabled();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("does not submit again while a login is already in flight", async () => {
    const onSubmit = vi.fn();
    render(<LoginGate onSubmit={onSubmit} busy={true} />);

    await userEvent.click(
      screen.getByRole("button", { name: /sign in|log in|signing/i }),
    );

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("renders a script-looking error as literal text and creates no element", () => {
    const payload = "<script>alert(1)</script>";
    const { container } = render(<LoginGate onSubmit={() => {}} error={payload} />);

    expect(container.querySelector("script")).toBeNull();
    expect(
      [...document.querySelectorAll("script")].some((s) =>
        s.textContent?.includes("alert(1)"),
      ),
    ).toBe(false);
    expect(screen.getByText(new RegExp(escapeRegExp(payload)))).toBeInTheDocument();
    // Escaped body text, never live markup.
    expect(container.innerHTML).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
