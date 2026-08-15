/**
 * The scheduler that actually makes the dashboard live.
 *
 * The collectors are pure-ish adapters that each do ONE poll cycle; nothing in
 * the HTTP layer calls them. This module owns the clock: it runs each collector
 * on its own interval, and after every pass pushes the CURRENT state onto the
 * SSE hub so connected UIs update without polling.
 *
 * Design notes:
 *   - Every side-effecting dependency (tmux exec, git, PR lookup, clock,
 *     timers) is INJECTED, with a real default. Tests inject fakes and never
 *     shell out; production gets the real thing for free.
 *   - `tick()` is the whole collection pass, exposed so tests drive time
 *     explicitly instead of waiting on real timers.
 *   - Nothing here is allowed to throw. A collector that blows up must not take
 *     down its siblings, the scheduler, or the process.
 */

import { execFile } from "node:child_process";
import type Database from "better-sqlite3";
import {
  entryStamps,
  listAgents,
  listEntries,
  listFeatures,
  listMessages,
} from "./db.js";
import { groupIntoThreads } from "./threads.js";
import type { SseHub } from "./sse.js";
import { collectLiveness, type CommandRunner } from "./collectors/liveness.js";
import { collectPipeline, type PrInfo } from "./collectors/pipeline.js";
import { createGithubPrSource } from "./github.js";
import {
  collectTranscripts,
  createTranscriptState,
  type TranscriptCollectorState,
  type TranscriptSource,
} from "./collectors/transcript.js";

export interface RuntimeOptions {
  hub: SseHub;
  /** tmux session to watch. */
  session: string;
  /** Directory holding spec gate artifacts. */
  specsDir: string;
  /** Transcript sources to tail. */
  sources?: TranscriptSource[];
  intervalMs?: { liveness?: number; pipeline?: number; transcript?: number };
  /** Injected for tests. */
  runner?: CommandRunner;
  listBranches?: () => Promise<string[]>;
  listPrs?: () => Promise<Record<string, PrInfo>>;
  now?: () => number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export interface Runtime {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
}

/**
 * Poll cadences. Liveness and transcripts are what the board feels "live" on,
 * so they run fast; the pipeline needs a directory scan plus git, so it runs
 * an order of magnitude slower.
 */
const DEFAULT_INTERVALS = {
  liveness: 2_000,
  pipeline: 10_000,
  // Measured: an idle poll pass costs ~0.18ms per source, so 400ms is ~0.07%
  // of a core at 10 agents. Halving mean latency to ~200ms costs one line of
  // config, where inotify would cost a second code path (see
  // docs/IMPLEMENTATION-P3.md).
  transcript: 400,
} as const;

/** Max stdout we accept from an injected command; a runaway must not eat RAM. */
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;

/**
 * Default executor: runs the argv directly via execFile — NO shell, so a
 * session name can never be interpreted as shell syntax.
 */
export const defaultRunner: CommandRunner = (argv) =>
  new Promise((resolve, reject) => {
    const [command, ...args] = argv;
    if (command === undefined) {
      reject(new Error("empty command"));
      return;
    }
    execFile(
      command,
      args,
      { maxBuffer: MAX_STDOUT_BYTES, encoding: "utf8" },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });

/** Local branch names, e.g. `feat/checkout`. Empty when git isn't available. */
export function defaultListBranches(
  runner: CommandRunner = defaultRunner,
): () => Promise<string[]> {
  return async () => {
    const stdout = await runner([
      "git",
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
    ]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  };
}

/**
 * PR lookup, from the GitHub REST API.
 *
 * Configuration (env, both optional):
 *   GITHUB_REPO   "owner/repo" to poll for PRs. UNSET = no PR lookup at all,
 *                  which is the supported zero-config mode: the stage machine
 *                  degrades to the artifact/branch signals and the dashboard
 *                  still boots on a machine with no forge access.
 *   GITHUB_TOKEN  PAT used for the API. Omit for a public repo; without it the
 *                  poll shares the 60 req/hr anonymous rate limit.
 *
 * Read once at module load, on purpose: the poll cadence must not re-read env
 * (and re-build the client) every ten seconds. The source itself never throws
 * and returns its last known good snapshot on failure — see `github.ts`.
 */
export const defaultListPrs: () => Promise<Record<string, PrInfo>> = (() => {
  const repo = process.env.GITHUB_REPO?.trim();
  if (repo === undefined || repo.length === 0) {
    return async (): Promise<Record<string, PrInfo>> => ({});
  }
  const token = process.env.GITHUB_TOKEN?.trim();
  return createGithubPrSource({
    repo,
    token: token !== undefined && token.length > 0 ? token : undefined,
    // Polls every 10s, so log the FIRST failure and then only when the reason
    // changes: a bad token must be visible, but must not fill the log.
    onError: (() => {
      let last = "";
      return (err: { status?: number; message: string }): void => {
        const key = `${err.status ?? ""}:${err.message}`;
        if (key === last) return;
        last = key;
        console.warn(
          `[dashboard] GitHub PR lookup for ${repo} failed: ${err.message}. ` +
            `Pipeline stages in_review/merge_ready/merged will not appear ` +
            `until this is fixed.`,
        );
      };
    })(),
  });
})();

/** Channels the frontend subscribes to. Renaming one silently breaks the UI. */
const CHANNEL_AGENTS = "agents";
const CHANNEL_FEATURES = "features";
const CHANNEL_MESSAGES = "messages";
const CHANNEL_ENTRIES = "entries";

/**
 * How many of an agent's newest entries ride on one `entries` broadcast.
 *
 * Bounded well below the retention cap on purpose: the payload goes out on
 * every change, to every connected client, and shipping a 500-entry blob at
 * the poll rate would flood the stream. A client that wants the full history
 * asks `GET /agents/:name/entries` once and then follows the channel.
 */
const ENTRIES_BROADCAST_LIMIT = 200;

export function createRuntime(
  db: Database.Database,
  opts: RuntimeOptions,
): Runtime {
  const runner = opts.runner ?? defaultRunner;
  const listBranches = opts.listBranches ?? defaultListBranches(runner);
  const listPrs = opts.listPrs ?? defaultListPrs;
  const now = opts.now ?? Date.now;
  const sources = opts.sources ?? [];
  const setIntervalFn = opts.setIntervalFn ?? setInterval;
  const clearIntervalFn = opts.clearIntervalFn ?? clearInterval;

  const intervals = {
    liveness: opts.intervalMs?.liveness ?? DEFAULT_INTERVALS.liveness,
    pipeline: opts.intervalMs?.pipeline ?? DEFAULT_INTERVALS.pipeline,
    transcript: opts.intervalMs?.transcript ?? DEFAULT_INTERVALS.transcript,
  };

  // Byte offsets per transcript, so a long session is tailed, not re-parsed.
  const transcriptState: TranscriptCollectorState = createTranscriptState();

  // Last payload we pushed per channel, serialised. Polling means most passes
  // change nothing; without this every connected client gets spammed at the
  // poll rate. `undefined` = never broadcast, which is distinct from "[]".
  const lastSent = new Map<string, string>();

  let timers: ReturnType<typeof setInterval>[] = [];

  /**
   * Pushes `data` on `channel`, but only when `signature` differs from the one
   * we last pushed there.
   *
   * `signature` is separate from `data` on purpose: every pass restamps
   * `features.updated_at` and `agents.last_seen` with the poll clock, so a
   * whole-row diff would report a change on EVERY poll and we would be back to
   * spamming clients at the poll rate. The signature strips those poll
   * timestamps; anything a user can actually see change (stage, branch, pr_url,
   * alive, current_activity, membership) still fires.
   */
  function broadcast(
    channel: string,
    data: unknown,
    signature: unknown,
    /**
     * Dedupe key, when several payloads share one channel name. The `entries`
     * channel carries one agent per message, so each agent needs its own
     * "last sent" slot or a busy agent would suppress a quiet one's update.
     */
    key: string = channel,
  ): void {
    try {
      const serialised = JSON.stringify(signature);
      if (lastSent.get(key) === serialised) return;
      lastSent.set(key, serialised);
      opts.hub.broadcast(channel, data);
    } catch {
      // A hub with a broken sink, or data that won't serialise, is not worth
      // failing a collection pass over.
    }
  }

  /** Reads the current state back out and pushes whatever actually changed. */
  function publish(): void {
    try {
      const agents = listAgents(db);
      broadcast(
        CHANNEL_AGENTS,
        agents,
        // last_seen moves on every poll for a live agent; it only becomes
        // meaningful when `alive` flips, and that flip is itself a change.
        agents.map(({ last_seen: _ignored, ...rest }) => rest),
      );
    } catch {
      /* a failed read is a skipped update, not a crash */
    }
    try {
      const features = listFeatures(db);
      broadcast(
        CHANNEL_FEATURES,
        features,
        features.map(({ updated_at: _ignored, ...rest }) => rest),
      );
    } catch {
      /* ditto */
    }
    try {
      // Messages are immutable once stored, so the threads themselves are the
      // signature — no clock churn to strip.
      const threads = groupIntoThreads(listMessages(db, {}));
      broadcast(CHANNEL_MESSAGES, threads, threads);
    } catch {
      /* ditto */
    }
    try {
      // Per-agent, not one global blob: entries are the highest-volume thing
      // the dashboard holds, and only the agent that actually moved needs to
      // be re-sent. The stamp is an aggregate, so an unchanged agent costs no
      // row reads at all — which is what makes a 400ms poll affordable.
      for (const [agent, stamp] of entryStamps(db)) {
        const key = `${CHANNEL_ENTRIES}:${agent}`;
        if (lastSent.get(key) === JSON.stringify(stamp)) continue;
        const entries = listEntries(db, {
          agent,
          limit: ENTRIES_BROADCAST_LIMIT,
        });
        broadcast(CHANNEL_ENTRIES, { agent, entries }, stamp, key);
      }
    } catch {
      /* ditto */
    }
  }

  /** Runs one collector in isolation: a throw here stops nothing else. */
  async function safely(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch {
      // Collector-level failures are expected (no tmux, no git, no specs dir).
      // They are already the collectors' normal degraded path; anything that
      // escapes is contained here so siblings and the scheduler survive.
    }
  }

  const runLiveness = (): Promise<void> =>
    safely(() => collectLiveness(db, { session: opts.session, runner, now }));

  const runPipeline = (): Promise<void> =>
    safely(() =>
      collectPipeline(db, {
        specsDir: opts.specsDir,
        listBranches,
        listPrs,
        now,
      }),
    );

  const runTranscripts = (): Promise<void> =>
    safely(() => collectTranscripts(db, sources, transcriptState));

  /** One collector + a publish, for the scheduled path. Never rejects. */
  async function step(run: () => Promise<void>): Promise<void> {
    await run();
    publish();
  }

  /** One full pass over every collector, then a publish. Never rejects. */
  async function tick(): Promise<void> {
    // Sequential, not parallel: they share one SQLite handle, and liveness
    // must create the agent rows the transcript collector attaches activity
    // to within the same pass.
    await runLiveness();
    await runPipeline();
    await runTranscripts();
    publish();
  }

  return {
    tick,

    start(): void {
      if (timers.length > 0) return; // already running; don't double-schedule.

      const schedule = (run: () => Promise<void>, ms: number): void => {
        const timer = setIntervalFn(() => {
          // The callback is sync from the timer's point of view; swallow the
          // rejection so a bad pass can never become an unhandled rejection
          // and kill the process.
          void step(run).catch(() => undefined);
        }, ms);
        // Never hold the event loop open: the HTTP server decides process life.
        (timer as { unref?: () => unknown }).unref?.();
        timers.push(timer);
      };

      schedule(runLiveness, intervals.liveness);
      schedule(runPipeline, intervals.pipeline);
      schedule(runTranscripts, intervals.transcript);

      // Kick-off pass: without it the board stays empty until the SLOWEST
      // interval elapses (ten seconds of "no features" right after boot).
      void tick().catch(() => undefined);
    },

    stop(): void {
      for (const timer of timers) clearIntervalFn(timer);
      timers = [];
    },
  };
}
