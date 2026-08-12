/**
 * GitHub PR state, keyed by FEATURE NAME.
 *
 * This is the missing half of the stage machine. `deriveStage` already knows
 * how to read `in_review` / `merge_ready` / `merged`, but those three stages
 * are unreachable in a running dashboard until something actually supplies PR
 * state — that something is this module, injected as `listPrs` in `runtime.ts`.
 *
 * Design notes:
 *   - `fetch` is INJECTED, so every test runs offline. Nothing here ever
 *     touches the network in a test.
 *   - NEVER THROWS. It runs on a poll loop; a rate limit or a flaky DNS lookup
 *     must degrade the board, not break it. On any failure the source resolves
 *     to the LAST KNOWN GOOD snapshot (or `{}` before the first success), so a
 *     transient 403 doesn't blank the board and flap every feature's stage back
 *     down to its local-artifact reading.
 *   - It is also SILENT. A poll loop that logs on failure logs every ten
 *     seconds forever; there is no console output on any path.
 */

import type { PrInfo } from "./collectors/pipeline.js";

export interface GithubOptions {
  /** "owner/repo". */
  repo: string;
  /**
   * Called when a poll fails. Failures resolve to the last-known snapshot so
   * the board never flaps, but a bad token or typo'd repo would otherwise be
   * indistinguishable from "this repo has no PRs" — every feature would sit at
   * its artifact stage forever with no operator signal. This is the signal.
   */
  onError?: (err: { status?: number; message: string }) => void;
  token?: string;
  /** Injected for tests — never hit the network in a test. */
  fetch?: typeof fetch;
  /** Maps a PR to a feature name; defaults to the branch-convention rule. */
  featureNameFor?: (pr: { headRef: string; title: string }) => string | null;
}

const API_ROOT = "https://api.github.com";
const PER_PAGE = 100;
const USER_AGENT = "airgentic-dashboard";

/** Same convention `collectors/pipeline.ts` uses; keep the two in step. */
const FEAT_PREFIX = "feat/";

/** Max reviews requests in flight at once. 50 open PRs must not be 50 sockets. */
const REVIEW_CONCURRENCY = 5;

/** Ranking for the duplicate-PR tiebreak: strongest evidence first. */
const STATE_RANK: Record<PrInfo["state"], number> = {
  merged: 3,
  open: 2,
  closed: 1,
};

/** One PR, already normalised out of the raw API shape. */
interface Pull {
  number: number;
  url: string;
  state: PrInfo["state"];
  feature: string;
}

/**
 * Default feature-name rule: `feat/<name>` → `<name>`, everything else → null.
 *
 * Deliberately conservative. The keys this source returns CREATE features in
 * `collectPipeline`, so a permissive rule would invent a "main" feature out of
 * every release PR. A bare head ref that happens to equal a real feature name
 * is still handled — just downstream, by `matchBranch`, which has the feature
 * list this module does not. Callers who do know the feature list can pass
 * `featureNameFor` to resolve bare refs here.
 */
function defaultFeatureNameFor(pr: { headRef: string; title: string }): string | null {
  const { headRef } = pr;
  if (!headRef.startsWith(FEAT_PREFIX)) return null;
  const name = headRef.slice(FEAT_PREFIX.length).trim();
  return name.length > 0 ? name : null;
}

/**
 * Lists open + recently-closed PRs keyed by feature name.
 *
 * The returned function is the `listPrs` seam: call it once per poll. It never
 * rejects and never throws.
 */
export function createGithubPrSource(
  opts: GithubOptions,
): () => Promise<Record<string, PrInfo>> {
  const doFetch = opts.fetch ?? fetch;
  const featureNameFor = opts.featureNameFor ?? defaultFeatureNameFor;

  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": USER_AGENT,
  };
  // Only send credentials when we have them: an empty Bearer is a 401, and
  // anonymous reads work fine on a public repo.
  if (typeof opts.token === "string" && opts.token.length > 0) {
    headers.authorization = `Bearer ${opts.token}`;
  }

  // Last successful snapshot, returned verbatim whenever a poll fails.
  let lastGood: Record<string, PrInfo> = {};

  /** Reports a failure without ever letting the sink break the poll. */
  function report(err: { status?: number; message: string }): void {
    try {
      opts.onError?.(err);
    } catch {
      /* a broken error sink is not worth failing a poll over */
    }
  }

  /** GETs `url` and parses JSON. Returns null for ANY failure mode. */
  async function getJson(url: string): Promise<unknown> {
    try {
      const res = await doFetch(url, { headers });
      // Covers rate limits (403/429), auth (401), typos (404), outages (5xx).
      if (!res.ok) {
        report({ status: res.status, message: `GitHub returned ${res.status}` });
        return null;
      }
      return (await res.json()) as unknown;
    } catch (e) {
      // Network error, aborted socket, or a body that isn't JSON.
      report({ message: (e as Error)?.message ?? "request failed" });
      return null;
    }
  }

  async function listPrs(): Promise<Record<string, PrInfo>> {
    const raw = await getJson(
      `${API_ROOT}/repos/${opts.repo}/pulls?state=all&per_page=${PER_PAGE}`,
    );
    // A non-array body means an error envelope ({"message": ...}) or garbage.
    if (!Array.isArray(raw)) return lastGood;

    const winners = new Map<string, Pull>();
    for (const entry of raw) {
      const pull = normalise(entry, featureNameFor);
      if (pull === null) continue;
      const current = winners.get(pull.feature);
      if (current === undefined || beats(pull, current)) {
        winners.set(pull.feature, pull);
      }
    }

    const result: Record<string, PrInfo> = {};
    for (const [feature, pull] of winners) {
      result[feature] = { url: pull.url, state: pull.state, approved: false };
    }

    // `approved` only changes a stage for an OPEN PR (`merge_ready` vs
    // `in_review`), so merged and closed PRs never cost a reviews request.
    const open = [...winners.values()].filter((p) => p.state === "open");
    await forEachLimited(open, REVIEW_CONCURRENCY, async (pull) => {
      const reviews = await getJson(
        `${API_ROOT}/repos/${opts.repo}/pulls/${pull.number}/reviews?per_page=${PER_PAGE}`,
      );
      // A failed reviews call downgrades ONE PR to `approved: false`; the
      // other PRs in the pass keep their data.
      if (!Array.isArray(reviews)) return;
      result[pull.feature]!.approved = isApproved(reviews);
    });

    lastGood = result;
    return result;
  }

  return async () => {
    try {
      return await listPrs();
    } catch {
      // Belt and braces: the contract is "never throws", full stop.
      return lastGood;
    }
  };
}

/**
 * Raw API entry → `Pull`, or null when it isn't a usable feature PR.
 *
 * THE MERGED/CLOSED TRAP: GitHub reports a merged PR as `state: "closed"` with
 * a non-null `merged_at`. Reading `state` alone would file every shipped
 * feature under "abandoned", so `merged_at` is checked FIRST.
 */
function normalise(
  entry: unknown,
  featureNameFor: (pr: { headRef: string; title: string }) => string | null,
): Pull | null {
  if (typeof entry !== "object" || entry === null) return null;
  const pr = entry as {
    number?: unknown;
    state?: unknown;
    merged_at?: unknown;
    html_url?: unknown;
    title?: unknown;
    head?: { ref?: unknown } | null;
  };

  if (typeof pr.number !== "number") return null;
  const headRef = typeof pr.head?.ref === "string" ? pr.head.ref : "";
  const title = typeof pr.title === "string" ? pr.title : "";

  let feature: string | null;
  try {
    feature = featureNameFor({ headRef, title });
  } catch {
    return null; // an injected mapper must not be able to kill the poll
  }
  if (typeof feature !== "string" || feature.length === 0) return null;

  const merged = typeof pr.merged_at === "string" && pr.merged_at.length > 0;
  const state: PrInfo["state"] = merged
    ? "merged"
    : pr.state === "open"
      ? "open"
      : "closed";

  const url =
    typeof pr.html_url === "string" && pr.html_url.length > 0 ? pr.html_url : "";

  return { number: pr.number, url, state, feature };
}

/**
 * Deterministic winner when several PRs map to one feature: strongest state
 * first, then the highest PR number. Without a total order the board would
 * flap between two PRs on every poll as the API's ordering shifted.
 */
function beats(candidate: Pull, incumbent: Pull): boolean {
  const a = STATE_RANK[candidate.state];
  const b = STATE_RANK[incumbent.state];
  if (a !== b) return a > b;
  return candidate.number > incumbent.number;
}

/**
 * Approval, read the way a human reads the Files-changed header: take each
 * reviewer's LATEST decisive review (reviews arrive oldest-first), ignoring
 * `COMMENTED`/`PENDING`/`DISMISSED` which express no position. Approved means
 * at least one reviewer landed on APPROVED and nobody is currently blocking.
 */
function isApproved(reviews: unknown[]): boolean {
  const latest = new Map<string, "APPROVED" | "CHANGES_REQUESTED">();

  for (const entry of reviews) {
    if (typeof entry !== "object" || entry === null) continue;
    const review = entry as { state?: unknown; user?: { login?: unknown } | null };
    const state = review.state;
    if (state !== "APPROVED" && state !== "CHANGES_REQUESTED") continue;
    const login = typeof review.user?.login === "string" ? review.user.login : "";
    if (login.length === 0) continue;
    latest.set(login, state); // later entries overwrite earlier ones
  }

  const decisions = [...latest.values()];
  if (decisions.includes("CHANGES_REQUESTED")) return false;
  return decisions.includes("APPROVED");
}

/**
 * Runs `task` over `items` with at most `limit` in flight.
 *
 * `Promise.all` over 50 PRs would open 50 sockets at once and trip secondary
 * rate limits; a serial loop would make a poll take 50 round trips. This is a
 * fixed pool of workers pulling from a shared cursor. A rejecting task is
 * swallowed so one bad PR can't lose the rest of the pass.
 */
async function forEachLimited<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const item = items[cursor++]!;
      try {
        await task(item);
      } catch {
        /* one PR's failure is not the pass's failure */
      }
    }
  };
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
}
