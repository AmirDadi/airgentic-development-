# Implementation Plan — P5 (Control: Stop)

Companion to [`PRD.md`](PRD.md). This is the first phase that WRITES into an
agent's runtime, so it is deliberately narrow and heavily guarded.

## Goal (from the PRD)

> **P5 — Control (Stop)**: a Stop/Interrupt action per agent in the UI —
> confirmation dialog, restricted to authenticated users, backed by a
> documented interrupt mechanism, every use logged to the `events` table.
> *Exit: stop a genuinely running agent from the UI and see it reflected as
> dead/idle within a few seconds, with an audit entry recorded.*

## Mechanism (spiked, confirmed on this machine)

Stop = **`tmux send-keys -t <session>:<window> C-c`**. Verified: sending `C-c`
to a named tmux window interrupts the process running there, and the window is
addressed by exactly the `session:window-name` the liveness collector already
uses (`tmux.ts`). The agent's `name` in the DB **is** its window name.

Decisions this fixes (PRD Q3 asked tmux-interrupt vs. SDK-native):
- **tmux interrupt**, because it works for ANY agent the dashboard can already
  see, needs no cooperation from the agent, and is exactly the "interrupt the
  current turn" semantics we want.
- **Interrupt, never kill.** `send-keys C-c` interrupts the current turn and
  leaves the session at its prompt — the agent stays alive and idle, which is
  the PRD's "reflected as dead/idle." The command builder is a pure function
  that emits ONLY `send-keys … C-c`; it has no code path that can produce
  `kill-window`/`kill-session`. A test asserts that.

## Safety posture (PRD R5 — Stop is hard to reverse)

- **Confirmation naming the target.** The UI requires an explicit confirm that
  names the agent; a mis-click on a busy board cannot fire a Stop.
- **Audited, always.** Every invocation writes an `events` row
  (`type: "agent_stopped"`, `agent`, `payload: {actor}`, server `ts`) before
  returning, and broadcasts it. No silent or automatic Stop — the dashboard
  never calls Stop itself.
- **Injection-safe.** The target is one argv element to a `shell:false` exec,
  like the chat bridge; a crafted agent/window name cannot become tmux flags.
- **Ships after P1–P4**, which it does — the read-only and live layers are
  proven first.

### Auth is a deployment concern, stated plainly

The PRD says "restricted to authenticated users," but network auth (PRD Q2,
Tailscale/Caddy) is deferred and NOT built here. This phase does not implement
user authentication. It records the `actor` the client supplies for the audit
trail, and the endpoint is a write path that a deployment MUST place behind its
access control (as it must for `POST /chat`). This is documented, not silently
assumed — do not claim Stop is access-controlled at the app layer.

## Units

| # | Unit | Kind | Test focus |
|---|------|------|------------|
| 1 | `stop.ts` — `buildStopCommand(session, window)` | **pure** | emits exactly `tmux send-keys -t <session>:<name> C-c`; window/session are single argv elements; NO kill verb is reachable; empty/odd names still produce a safe argv |
| 2 | `stopAgent(db, name, {actor, session, runner, now})` | adapter | injected runner; unknown agent → not-found result, no command run; known agent → runs the interrupt, writes an `events` audit row, returns ok; a runner that throws (tmux down) → error result, NO audit row claiming success, never throws |
| 3 | `POST /agents/:name/stop` | adapter | `app.inject()`; body `{actor?}`; 404 unknown agent; 200 + audit event on success; 503 when tmux control is not configured; `:name` bound as data, path-traversal-ish names just miss |
| 4 | audit broadcast | adapter | the `events` row is broadcast so the timeline updates live; only on real invocation |
| 5 | `StopButton` + confirm dialog | component | button per agent; clicking opens a confirm dialog NAMING the agent; confirm calls `onStop`, cancel does not; disabled/`aria`-correct; result + error surfaced |
| 6 | wire into Team board / AgentDetail | component | Stop reachable per agent; a dead agent's Stop is disabled (nothing to interrupt) |

## Exit criterion (restated, testable)

Start a real interruptible process in a tmux window, Stop it from the API, and
observe: the process receives the interrupt, an `events` audit row exists with
the actor and timestamp, and the next liveness poll shows the agent idle.

## Deferred

Network auth / exposure (PRD Q2) — a deployment concern. Any control beyond
interrupt (pause, kill, reassign) stays out of scope (PRD non-goals). Kill (as
opposed to interrupt) is deliberately NOT built.
