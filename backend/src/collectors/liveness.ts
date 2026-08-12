/**
 * Liveness collector: one poll cycle reads `tmux list-windows` and reconciles
 * the `agents` table.
 *
 * The command executor is INJECTED (`CommandRunner`), so this adapter is
 * testable with zero tmux dependency — the argv itself comes from the pure
 * builder in `tmux.ts` and is never hand-rolled here.
 *
 * Ownership: this collector owns `name`, `alive` and `last_seen` only. It
 * deliberately never writes `current_activity` (the transcript collector owns
 * that) and never overwrites an already-known `workdir`/`kind`.
 */

import type Database from "better-sqlite3";
import { listAgents, upsertAgent } from "../db.js";
import { buildListWindowsCommand, parseTmuxWindows } from "../tmux.js";
import type { Agent } from "../types.js";

/** Injected executor. Returns stdout. Rejects/throws if the command fails. */
export type CommandRunner = (argv: string[]) => Promise<string>;

export interface LivenessOptions {
  session: string;
  runner: CommandRunner;
  /** Injected clock for deterministic tests. */
  now: () => number;
}

/**
 * Placeholder `workdir` for an agent we learn about from tmux alone.
 *
 * tmux's window list does not tell us where an agent is working, and this
 * collector must not guess. The empty string is a stable, obviously-unknown
 * value that another collector can fill in later; once a non-empty workdir is
 * known we never write over it.
 */
const UNKNOWN_WORKDIR = "";

/**
 * Fallback `kind` for a window whose pane command tmux didn't report. When
 * tmux does report one (e.g. "claude", "node") we use it, since that is the
 * best available signal for what sort of agent this is — but, like workdir, a
 * kind we already know is never replaced by the fallback.
 */
const UNKNOWN_KIND = "unknown";

/** One poll cycle: read tmux, reconcile the agents table. */
export async function collectLiveness(
  db: Database.Database,
  opts: LivenessOptions,
): Promise<void> {
  let stdout: string;
  try {
    stdout = await opts.runner(buildListWindowsCommand(opts.session));
  } catch {
    // A FAILED poll (tmux missing, no server, session gone, transient error)
    // carries no evidence about anybody. We leave every existing row exactly
    // as it is rather than blanking the board on one bad poll. Contrast with
    // a SUCCESSFUL poll returning no windows below, which really does mean
    // "nobody is running" and marks the roster dead.
    return;
  }

  const windows = parseTmuxWindows(stdout);
  const now = opts.now();

  const known = new Map<string, Agent>();
  for (const a of listAgents(db)) known.set(a.name, a);

  const seen = new Set<string>();
  for (const w of windows) {
    // The window name IS the agent name, by convention (see tmux.ts).
    if (seen.has(w.name)) continue; // two windows, one name: one agent.
    seen.add(w.name);

    const prev = known.get(w.name);
    upsertAgent(db, {
      name: w.name,
      kind: w.command ?? prev?.kind ?? UNKNOWN_KIND,
      workdir: prev?.workdir ? prev.workdir : UNKNOWN_WORKDIR,
      alive: true,
      last_seen: now,
      // Not ours to set — preserve whatever another collector wrote.
      current_activity: prev?.current_activity ?? null,
    });
  }

  for (const [name, prev] of known) {
    if (seen.has(name)) continue;
    if (!prev.alive) continue; // already dead; don't rewrite the row.
    upsertAgent(db, {
      ...prev,
      alive: false,
      // last_seen is PRESERVED: it is the "dead since" timestamp the UI shows.
    });
  }
}
