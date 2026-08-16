import { readdir } from "node:fs/promises";
import type Database from "better-sqlite3";
import { upsertFeature } from "../db.js";
import { deriveStage, type StageSignals } from "../stage.js";

export interface PrInfo {
  url: string;
  state: "open" | "merged" | "closed";
  approved: boolean;
}

export interface PipelineOptions {
  /**
   * Directory containing the gate artifacts. UNUSED when `listArtifacts` is
   * provided — the injected source then owns the artifact signal entirely.
   */
  specsDir: string;
  /**
   * Injected: gate artifacts per feature name, e.g. from the project's GitHub
   * repo. When present it REPLACES the local `specsDir` scan; when absent the
   * local scan runs exactly as before.
   */
  listArtifacts?: () => Promise<
    Record<string, { spec: boolean; interfaces: boolean; plan: boolean }>
  >;
  /** Injected: branch names that exist, e.g. from `git for-each-ref`. */
  listBranches: () => Promise<string[]>;
  /** Injected: PR state per feature name. */
  listPrs: () => Promise<Record<string, PrInfo>>;
  /** Injected: owning agent per feature, if known. */
  owners?: Record<string, string>;
  now: () => number;
}

/** `<feature>.spec.md` / `.interfaces.md` / `.plan.md` — anything else is noise. */
const GATE_FILE = /^(.+)\.(spec|interfaces|plan)\.md$/;

/** The branch naming convention this project uses for feature work. */
const FEAT_PREFIX = "feat/";

type Gate = "spec" | "interfaces" | "plan";

/**
 * Scan `specsDir` for gate artifacts, combine them with injected git/PR state,
 * and write one `features` row per discovered feature.
 *
 * All git and forge access is INJECTED (`listBranches`, `listPrs`); this module
 * never shells out, which is what makes it testable against a temp directory.
 *
 * DISCOVERY — a feature is discovered from any of:
 *   - any one of its three gate artifacts (a lone `plan.md` still surfaces the
 *     feature; `deriveStage` decides that it hasn't cleared any gate);
 *   - a key in `listPrs()` — those keys ARE feature names, so a PR with no
 *     local artifacts is unambiguous evidence of a feature and we surface it
 *     rather than hiding shipped work from the board;
 *   - a `feat/<name>` branch — the prefix is a deliberate declaration of intent,
 *     so the name is trustworthy.
 * A *bare* branch name (`main`, `develop`, `checkout`) never creates a feature:
 * every repo has branches that aren't features, and inventing rows from them
 * would fill the board with garbage. Bare names still *attach* to a feature
 * discovered by one of the routes above (see below).
 *
 * BRANCH MATCHING — a branch belongs to feature `<f>` when it is exactly
 * `feat/<f>` or exactly `<f>`. Matching is exact, never a prefix/substring
 * test, so `feat/checkout-v2` stays a separate feature from `checkout`.
 * `feat/<f>` wins when both exist, since it is the explicit convention.
 *
 * Never throws on a missing `specsDir`: the dashboard has to boot on a machine
 * that has no `specs/` yet, and it does so silently — no stdout noise.
 */
export async function collectPipeline(
  db: Database.Database,
  opts: PipelineOptions,
): Promise<void> {
  // An injected artifact source (the project's GitHub repo) REPLACES the local
  // scan outright — two sources of truth would disagree and flap stages.
  const artifacts =
    opts.listArtifacts !== undefined
      ? toGateMap(await opts.listArtifacts())
      : await scanArtifacts(opts.specsDir);
  const [branches, prs] = await Promise.all([opts.listBranches(), opts.listPrs()]);

  const names = new Set<string>([
    ...artifacts.keys(),
    ...Object.keys(prs),
    ...branches
      .filter((b) => b.startsWith(FEAT_PREFIX) && b.length > FEAT_PREFIX.length)
      .map((b) => b.slice(FEAT_PREFIX.length)),
  ]);

  const branchSet = new Set(branches);
  const updated_at = opts.now();

  for (const name of names) {
    const gates = artifacts.get(name) ?? new Set<Gate>();
    const branch = matchBranch(branchSet, name);
    const pr = prs[name] ?? null;

    const signals: StageSignals = {
      artifacts: {
        spec: gates.has("spec"),
        interfaces: gates.has("interfaces"),
        plan: gates.has("plan"),
      },
      branch,
      pr,
    };

    upsertFeature(db, {
      name,
      owner: opts.owners?.[name] ?? null,
      stage: deriveStage(signals),
      branch,
      pr_url: pr === null ? null : pr.url,
      updated_at,
    });
  }
}

/** Injected flags → the same Map/Set shape the local scan produces. */
function toGateMap(
  flags: Record<string, { spec: boolean; interfaces: boolean; plan: boolean }>,
): Map<string, Set<Gate>> {
  const found = new Map<string, Set<Gate>>();
  for (const [name, gates] of Object.entries(flags)) {
    const set = new Set<Gate>();
    if (gates.spec) set.add("spec");
    if (gates.interfaces) set.add("interfaces");
    if (gates.plan) set.add("plan");
    found.set(name, set);
  }
  return found;
}

/** Feature name → the set of gate artifacts present for it. */
async function scanArtifacts(specsDir: string): Promise<Map<string, Set<Gate>>> {
  const found = new Map<string, Set<Gate>>();

  let entries;
  try {
    entries = await readdir(specsDir, { withFileTypes: true });
  } catch {
    // No specs/ dir (or it isn't readable) is a normal first-boot state, not
    // an error: report zero features and stay quiet.
    return found;
  }

  for (const entry of entries) {
    // Directories named like an artifact are not artifacts.
    if (!entry.isFile()) continue;
    const m = GATE_FILE.exec(entry.name);
    if (m === null) continue;
    const [, name, gate] = m;
    let gates = found.get(name);
    if (gates === undefined) {
      gates = new Set<Gate>();
      found.set(name, gates);
    }
    gates.add(gate as Gate);
  }

  return found;
}

function matchBranch(branches: Set<string>, name: string): string | null {
  const conventional = `${FEAT_PREFIX}${name}`;
  if (branches.has(conventional)) return conventional;
  if (branches.has(name)) return name;
  return null;
}
