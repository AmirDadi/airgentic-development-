import type { Stage } from "./types.js";

/**
 * On-disk signals for one feature. Everything here is a fact we observed
 * (a file exists, a ref exists, a PR is open); no interpretation yet.
 */
export interface StageSignals {
  /** Which gate artifacts exist for this feature. */
  artifacts: { spec: boolean; interfaces: boolean; plan: boolean };
  /** Feature branch name if one exists, else null. */
  branch: string | null;
  /** PR state, null when no PR exists. */
  pr: { url: string; state: "open" | "merged" | "closed"; approved: boolean } | null;
}

/**
 * Derive a feature's pipeline stage from its signals.
 *
 * PRECEDENCE — signals routinely disagree (a stale `spec.md` sits next to a
 * merged PR forever). The strongest *downstream* evidence wins, because
 * downstream evidence can only exist if the upstream work actually happened
 * at some point, while upstream artifacts say nothing about what came after:
 *
 *   1. merged PR   → `merged`, unconditionally. The work shipped; nothing
 *                    upstream can contradict that.
 *   2. open PR     → `merge_ready` if approved, else `in_review`. Outranks
 *                    branch and artifacts even when they are absent — a PR
 *                    that exists is proof the code exists.
 *   3. closed PR   → *no* evidence. A closed-unmerged PR is abandoned work,
 *                    not finished work, so we fall through to the
 *                    branch/artifact reading below rather than advancing.
 *   4. branch      → `implementing`, but only once the artifact gates are
 *                    fully cleared (see below). A branch next to a half-done
 *                    ladder means someone started early, not that the gates
 *                    are satisfied, so it does not promote past them.
 *   5. artifacts   → the highest *contiguous* gate reached.
 *
 * CONTIGUITY — artifacts can appear out of order (a `plan.md` with no
 * `spec.md`). We count only the unbroken prefix spec → interfaces → plan, so
 * plan-without-spec reads as `not_started`, not `plan`. A gate is meaningful
 * only if the gates it depends on were also passed; rewarding a lone
 * downstream file would let one stray artifact fake an entire pipeline.
 *
 * Pure: no I/O, no mutation of the input, no clock.
 */
export function deriveStage(signals: StageSignals): Stage {
  const { pr } = signals;

  if (pr !== null && pr.state === "merged") return "merged";
  if (pr !== null && pr.state === "open") return pr.approved ? "merge_ready" : "in_review";
  // pr === null, or a closed-unmerged PR: fall through to local evidence.

  const gate = contiguousGateStage(signals.artifacts);
  const hasBranch = typeof signals.branch === "string" && signals.branch.length > 0;

  if (gate === "plan" && hasBranch) return "implementing";
  return gate;
}

/** Highest gate reached walking spec → interfaces → plan without a gap. */
function contiguousGateStage(artifacts: StageSignals["artifacts"]): Stage {
  if (!artifacts.spec) return "not_started";
  if (!artifacts.interfaces) return "spec";
  if (!artifacts.plan) return "interfaces";
  return "plan";
}
