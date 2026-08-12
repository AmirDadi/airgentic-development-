import { describe, it, expect } from "vitest";
import type { Stage } from "../src/types";
import { STAGES } from "../src/types";
import { deriveStage, type StageSignals } from "../src/stage";

/** Build a signals object; every field defaults to "nothing exists yet". */
function signals(over: Partial<StageSignals> = {}): StageSignals {
  return {
    artifacts: { spec: false, interfaces: false, plan: false, ...over.artifacts },
    branch: over.branch !== undefined ? over.branch : null,
    pr: over.pr !== undefined ? over.pr : null,
  };
}

const openPr = { url: "https://gh/pr/1", state: "open" as const, approved: false };
const approvedPr = { url: "https://gh/pr/1", state: "open" as const, approved: true };
const mergedPr = { url: "https://gh/pr/1", state: "merged" as const, approved: true };
const mergedUnapprovedPr = { url: "https://gh/pr/1", state: "merged" as const, approved: false };
const closedPr = { url: "https://gh/pr/1", state: "closed" as const, approved: false };

const allGates = { spec: true, interfaces: true, plan: true };

describe("deriveStage — the happy ladder", () => {
  it.each<[string, StageSignals, Stage]>([
    ["nothing at all", signals(), "not_started"],
    ["spec only", signals({ artifacts: { spec: true, interfaces: false, plan: false } }), "spec"],
    [
      "spec + interfaces",
      signals({ artifacts: { spec: true, interfaces: true, plan: false } }),
      "interfaces",
    ],
    ["all three gates, no branch", signals({ artifacts: allGates }), "plan"],
    ["gates done + branch, no PR", signals({ artifacts: allGates, branch: "feat/x" }), "implementing"],
    [
      "gates done + branch + open PR",
      signals({ artifacts: allGates, branch: "feat/x", pr: openPr }),
      "in_review",
    ],
    [
      "gates done + branch + approved open PR",
      signals({ artifacts: allGates, branch: "feat/x", pr: approvedPr }),
      "merge_ready",
    ],
    [
      "gates done + branch + merged PR",
      signals({ artifacts: allGates, branch: "feat/x", pr: mergedPr }),
      "merged",
    ],
  ])("%s → %s", (_name, input, expected) => {
    expect(deriveStage(input)).toBe(expected);
  });

  it("covers every stage in STAGES across the ladder cases", () => {
    const reached = new Set<Stage>([
      deriveStage(signals()),
      deriveStage(signals({ artifacts: { spec: true, interfaces: false, plan: false } })),
      deriveStage(signals({ artifacts: { spec: true, interfaces: true, plan: false } })),
      deriveStage(signals({ artifacts: allGates })),
      deriveStage(signals({ artifacts: allGates, branch: "b" })),
      deriveStage(signals({ artifacts: allGates, branch: "b", pr: openPr })),
      deriveStage(signals({ artifacts: allGates, branch: "b", pr: approvedPr })),
      deriveStage(signals({ artifacts: allGates, branch: "b", pr: mergedPr })),
    ]);
    expect([...reached].sort()).toEqual([...STAGES].sort());
  });
});

describe("deriveStage — always returns a valid Stage", () => {
  it.each<[string, StageSignals]>([
    ["empty", signals()],
    ["plan without spec", signals({ artifacts: { spec: false, interfaces: false, plan: true } })],
    ["branch only", signals({ branch: "feat/x" })],
    ["pr only", signals({ pr: openPr })],
    ["closed pr only", signals({ pr: closedPr })],
  ])("%s yields a member of STAGES", (_name, input) => {
    expect(STAGES).toContain(deriveStage(input));
  });
});

describe("precedence: merged PR beats every other signal", () => {
  it.each<[string, StageSignals]>([
    ["no artifacts, no branch", signals({ pr: mergedPr })],
    ["stale spec only, no branch", signals({ artifacts: { spec: true, interfaces: false, plan: false }, pr: mergedPr })],
    ["all gates + branch", signals({ artifacts: allGates, branch: "feat/x", pr: mergedPr })],
    ["merged but never approved", signals({ artifacts: allGates, branch: "feat/x", pr: mergedUnapprovedPr })],
    ["out-of-order artifacts", signals({ artifacts: { spec: false, interfaces: false, plan: true }, pr: mergedPr })],
  ])("%s → merged", (_name, input) => {
    expect(deriveStage(input)).toBe("merged");
  });
});

describe("precedence: an open PR outranks branch and artifacts", () => {
  it("open PR with zero artifacts and no branch is still in_review", () => {
    expect(deriveStage(signals({ pr: openPr }))).toBe("in_review");
  });

  it("open approved PR with zero artifacts is still merge_ready", () => {
    expect(deriveStage(signals({ pr: approvedPr }))).toBe("merge_ready");
  });

  it("open PR does not regress to plan just because gates are complete", () => {
    expect(deriveStage(signals({ artifacts: allGates, pr: openPr }))).toBe("in_review");
  });

  it("approval promotes in_review to merge_ready", () => {
    const base = signals({ artifacts: allGates, branch: "feat/x" });
    expect(deriveStage({ ...base, pr: openPr })).toBe("in_review");
    expect(deriveStage({ ...base, pr: approvedPr })).toBe("merge_ready");
  });
});

describe("precedence: a closed-unmerged PR is abandoned work, not progress", () => {
  it.each<[string, StageSignals, Stage]>([
    ["closed PR, nothing else", signals({ pr: closedPr }), "not_started"],
    [
      "closed PR + gates + branch falls back to implementing",
      signals({ artifacts: allGates, branch: "feat/x", pr: closedPr }),
      "implementing",
    ],
    [
      "closed PR + gates, branch gone falls back to plan",
      signals({ artifacts: allGates, pr: closedPr }),
      "plan",
    ],
    [
      "closed PR + spec only falls back to spec",
      signals({ artifacts: { spec: true, interfaces: false, plan: false }, pr: closedPr }),
      "spec",
    ],
  ])("%s", (_name, input, expected) => {
    expect(deriveStage(input)).toBe(expected);
  });

  it("an approved-but-closed PR does not count as merge_ready", () => {
    const input = signals({
      artifacts: allGates,
      branch: "feat/x",
      pr: { url: "https://gh/pr/1", state: "closed", approved: true },
    });
    expect(deriveStage(input)).toBe("implementing");
  });
});

describe("precedence: branch only promotes work whose gates are complete", () => {
  it("branch with no artifacts at all stays not_started", () => {
    expect(deriveStage(signals({ branch: "feat/x" }))).toBe("not_started");
  });

  it.each<[string, StageSignals, Stage]>([
    [
      "branch + spec only",
      signals({ artifacts: { spec: true, interfaces: false, plan: false }, branch: "feat/x" }),
      "spec",
    ],
    [
      "branch + spec + interfaces",
      signals({ artifacts: { spec: true, interfaces: true, plan: false }, branch: "feat/x" }),
      "interfaces",
    ],
    ["branch + all gates", signals({ artifacts: allGates, branch: "feat/x" }), "implementing"],
  ])("%s → %s", (_name, input, expected) => {
    expect(deriveStage(input)).toBe(expected);
  });

  it("treats an empty-string branch as no branch", () => {
    expect(deriveStage(signals({ artifacts: allGates, branch: "" }))).toBe("plan");
  });
});

describe("out-of-order artifacts use the highest contiguous gate", () => {
  it.each<[string, StageSignals["artifacts"], Stage]>([
    ["plan without spec or interfaces", { spec: false, interfaces: false, plan: true }, "not_started"],
    ["interfaces without spec", { spec: false, interfaces: true, plan: false }, "not_started"],
    ["interfaces + plan without spec", { spec: false, interfaces: true, plan: true }, "not_started"],
    ["spec + plan, interfaces missing", { spec: true, interfaces: false, plan: true }, "spec"],
    ["spec + interfaces, plan missing", { spec: true, interfaces: true, plan: false }, "interfaces"],
  ])("%s → %s", (_name, artifacts, expected) => {
    expect(deriveStage(signals({ artifacts }))).toBe(expected);
  });

  it("a gap in the ladder blocks 'implementing' even with a branch", () => {
    const input = signals({
      artifacts: { spec: true, interfaces: false, plan: true },
      branch: "feat/x",
    });
    expect(deriveStage(input)).toBe("spec");
  });

  it("does not throw on any of the 8 artifact combinations", () => {
    for (const spec of [false, true]) {
      for (const interfaces of [false, true]) {
        for (const plan of [false, true]) {
          expect(() => deriveStage(signals({ artifacts: { spec, interfaces, plan } }))).not.toThrow();
        }
      }
    }
  });
});

describe("purity", () => {
  it("does not mutate its input", () => {
    const input = signals({ artifacts: allGates, branch: "feat/x", pr: openPr });
    const snapshot = JSON.parse(JSON.stringify(input));
    deriveStage(input);
    expect(input).toEqual(snapshot);
  });

  it("is deterministic across repeated calls", () => {
    const input = signals({ artifacts: allGates, branch: "feat/x", pr: approvedPr });
    expect(deriveStage(input)).toBe(deriveStage(input));
  });
});
