import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { PipelineBoard } from "../src/components/PipelineBoard";
import { STAGES } from "../src/types";
import type { Feature } from "../src/types";

const COLUMN_LABELS = [
  "Not started",
  "Spec",
  "Interfaces",
  "Plan",
  "Implementing",
  "In review",
  "Merge ready",
  "Merged",
];

function feature(overrides: Partial<Feature> = {}): Feature {
  return {
    name: "checkout",
    owner: "payments",
    stage: "implementing",
    branch: "feat/checkout",
    pr_url: null,
    updated_at: 1_700_000_000_000,
    ...overrides,
  };
}

/** Columns are landmarks labelled by their readable stage name. */
function column(label: string): HTMLElement {
  return screen.getByRole("region", { name: label });
}

describe("PipelineBoard", () => {
  it("renders one readably-labelled column per stage", () => {
    render(<PipelineBoard features={[]} />);

    expect(STAGES).toHaveLength(COLUMN_LABELS.length);
    for (const label of COLUMN_LABELS) {
      expect(column(label)).toBeInTheDocument();
    }
    expect(screen.queryByText("in_review")).not.toBeInTheDocument();
    expect(screen.queryByText("not_started")).not.toBeInTheDocument();
  });

  it("places each feature card in the column matching its stage", () => {
    render(
      <PipelineBoard
        features={[
          feature({ name: "checkout", stage: "implementing" }),
          feature({ name: "search-ranking", stage: "in_review" }),
          feature({ name: "audit-log", stage: "merged" }),
        ]}
      />,
    );

    expect(within(column("Implementing")).getByText("checkout")).toBeInTheDocument();
    expect(within(column("In review")).getByText("search-ranking")).toBeInTheDocument();
    expect(within(column("Merged")).getByText("audit-log")).toBeInTheDocument();

    expect(within(column("Spec")).queryByText("checkout")).not.toBeInTheDocument();
  });

  it("renders all features that share a stage", () => {
    render(
      <PipelineBoard
        features={[
          feature({ name: "checkout", stage: "spec" }),
          feature({ name: "refunds", stage: "spec" }),
          feature({ name: "payouts", stage: "spec" }),
        ]}
      />,
    );

    const spec = within(column("Spec"));
    expect(spec.getByText("checkout")).toBeInTheDocument();
    expect(spec.getByText("refunds")).toBeInTheDocument();
    expect(spec.getByText("payouts")).toBeInTheDocument();
  });

  it("renders a link for a feature with a pr_url", () => {
    render(
      <PipelineBoard
        features={[
          feature({
            name: "checkout",
            stage: "in_review",
            pr_url: "https://github.com/acme/repo/pull/42",
          }),
        ]}
      />,
    );

    const link = screen.getByRole("link", { name: /checkout/i });
    expect(link).toHaveAttribute("href", "https://github.com/acme/repo/pull/42");
  });

  it("renders no link for a feature without a pr_url", () => {
    render(<PipelineBoard features={[feature({ name: "checkout", pr_url: null })]} />);

    expect(screen.getByText("checkout")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("shows the owner when present", () => {
    render(<PipelineBoard features={[feature({ name: "checkout", owner: "payments" })]} />);

    expect(screen.getByText(/payments/)).toBeInTheDocument();
  });

  it("handles a null owner gracefully without rendering the literal null", () => {
    render(<PipelineBoard features={[feature({ name: "checkout", owner: null })]} />);

    expect(screen.getByText("checkout")).toBeInTheDocument();
    expect(screen.queryByText("null")).not.toBeInTheDocument();
    expect(screen.getByText(/unassigned/i)).toBeInTheDocument();
  });

  it("still renders every column plus a clear empty state when there are no features", () => {
    render(<PipelineBoard features={[]} />);

    for (const label of COLUMN_LABELS) {
      expect(column(label)).toBeInTheDocument();
    }
    expect(screen.getByText(/no features/i)).toBeInTheDocument();
  });
});
