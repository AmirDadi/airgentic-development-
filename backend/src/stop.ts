/**
 * The Stop control (P5): interrupt a running agent's current turn.
 *
 * This is the FIRST path that WRITES into an agent's runtime, so it is
 * deliberately narrow and heavily guarded (PRD R5):
 *
 *   - **Interrupt, NEVER kill.** Stopping an agent is `send-keys … C-c` to its
 *     tmux window. That interrupts the current turn and leaves the agent alive
 *     at its prompt. There is NO code path in this module that can produce a
 *     `kill-window`/`kill-session`/`kill-server`/`kill-pane` — the verb is a
 *     hardcoded literal (`send-keys`). A test asserts that.
 *   - **Injection-safe.** The whole `session:window` target is ONE argv element
 *     to a `shell:false` exec (the injected runner), exactly like the read-only
 *     tmux command and the chat bridge. A crafted agent/window name can never
 *     become a separate tmux flag or shell token.
 *   - **Audited, always.** A known agent's Stop writes exactly one `events`
 *     row before returning; a failed attempt writes a clearly-distinct failure
 *     row. Nothing is silent.
 *
 * Like the collectors, this module performs NO I/O of its own: the executor is
 * INJECTED (`CommandRunner`), so it is testable with zero tmux dependency.
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { insertEvent, listAgents } from "./db.js";
import type { CommandRunner } from "./collectors/liveness.js";
import type { Event } from "./types.js";

/**
 * Builds the interrupt command we shell out to (via a `shell:false` runner).
 *
 * Returns an argv array — never a shell string — so the `session:window`
 * target is passed as a SINGLE argument. A window/session name is never
 * interpreted by a shell and can never split into extra tmux flags, no matter
 * what characters it contains.
 *
 * The verb is the literal `send-keys` and the key is the literal `C-c`. This
 * function has, by construction, no way to emit any `kill-*` verb: interrupt,
 * never kill (PRD R5). The agent stays alive at its prompt.
 */
export function buildStopCommand(session: string, window: string): string[] {
  return ["tmux", "send-keys", "-t", `${session}:${window}`, "C-c"];
}

export interface StopOptions {
  /** Who requested the Stop, recorded for the audit trail. Defaults to "web". */
  actor?: string;
  /** tmux session the agents live in. */
  session: string;
  /** Injected executor — tests drive a fake, production supplies real tmux. */
  runner: CommandRunner;
  /** Injected clock, for a deterministic server timestamp. */
  now?: () => number;
}

export interface StopResult {
  ok: boolean;
  /** Human-readable reason when `ok` is false. */
  error?: string;
  /**
   * Why it failed, for the HTTP layer to map to a status code:
   *   "unknown"      — no such agent (→ 404); nothing ran, nothing audited.
   *   "exec_failed"  — the interrupt command failed, e.g. tmux is down (→ 502).
   */
  reason?: "unknown" | "exec_failed";
  /**
   * The audit row that was written (success OR failure), so the caller can
   * broadcast it live. Absent only on the unknown-agent path, which writes
   * nothing.
   */
  event?: Event;
}

/** Speaker recorded when the caller supplies no actor. Matches chat's default. */
const DEFAULT_ACTOR = "web";

/**
 * Interrupts one agent's current turn and audits the attempt.
 *
 * Guarantees:
 *   - An UNKNOWN agent (not in the `agents` table) is refused up front: the
 *     runner is never called and NO event row is written. A Stop must target an
 *     agent the dashboard actually knows.
 *   - A KNOWN agent (alive or not — see below) runs `buildStopCommand` via the
 *     injected runner, then writes exactly one `agent_stopped` audit row with
 *     the actor and a server `ts`, and returns `{ok:true, event}`.
 *   - A runner that THROWS (tmux not running, session gone) never throws out of
 *     here: it returns `{ok:false, reason:"exec_failed", error}` and writes a
 *     clearly-distinct `agent_stop_failed` row — never one claiming success.
 *
 * Known-but-not-alive agents are ALLOWED. `alive:false` only means the last
 * liveness poll did not see the window; it can be stale, and `C-c` at an idle
 * prompt is harmless (it clears the current line). Refusing would risk blocking
 * a legitimate Stop of an agent that is genuinely running but whose poll lagged.
 */
export async function stopAgent(
  db: Database.Database,
  name: string,
  opts: StopOptions,
): Promise<StopResult> {
  const known = listAgents(db).some((a) => a.name === name);
  if (!known) {
    // Refuse before doing anything: no command, no audit row.
    return { ok: false, reason: "unknown", error: `unknown agent: ${name}` };
  }

  const now = opts.now ?? Date.now;
  const actor = opts.actor ?? DEFAULT_ACTOR;

  try {
    // The argv comes from the pure builder — never hand-rolled here.
    await opts.runner(buildStopCommand(opts.session, name));
  } catch (err) {
    // tmux is down / the window is gone. Record the attempt, but as a failure
    // type that can never be mistaken for a successful interrupt.
    const failEvent: Event = {
      id: randomUUID(),
      ts: now(),
      agent: name,
      type: "agent_stop_failed",
      payload: { actor, error: err instanceof Error ? err.message : String(err) },
    };
    insertEvent(db, failEvent);
    return {
      ok: false,
      reason: "exec_failed",
      error: err instanceof Error ? err.message : String(err),
      event: failEvent,
    };
  }

  // Success: exactly one audit row, written only after the interrupt was sent.
  const event: Event = {
    id: randomUUID(),
    ts: now(),
    agent: name,
    type: "agent_stopped",
    payload: { actor },
  };
  insertEvent(db, event);
  return { ok: true, event };
}
