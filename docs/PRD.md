# PRD: Agent Team Dashboard

## 1. Summary

A web app running on the VPS that gives Amirreza and the team a single,
truthful, real-time view of the agent team: who's alive, what each agent is
doing right now, where every feature sits in the delivery pipeline, the full
history of agent↔agent conversations, and a browser chat panel to talk
directly to the lead agent. The dashboard starts as a **reader** — it
observes existing session transcripts, hook events, specs, and git/PR state
on disk without blocking or interrupting agent sessions — and, once that
read-only layer is trusted, adds a small, explicit set of **control**
actions: watching an agent's response stream in near-live as it's generated,
and stopping/interrupting a specific agent's current turn from the UI.
Control is opt-in per action, confirmed, and audited — the dashboard is
never silently driving agents.

## 2. Problem

Right now the only way to know what the agent team is doing is to attach to
tmux windows or grep transcripts by hand. That doesn't scale past a couple of
agents, doesn't work from a phone, and makes it hard to answer basic
questions quickly: Is anything stuck? What did payments and search agree on
in their interface negotiation? Is feature X actually done or just "in
review" three days ago?

## 3. Goal

**Primary goal:** Give a truthful, at-a-glance answer — from a browser, in
under 10 seconds, on desktop or phone — to three questions at any moment:

1. Who is alive and what are they doing right now?
2. Where does every feature sit in the pipeline?
3. What have the agents said to each other, and what did the lead just say to
   me?

**Secondary goal:** Let a human send a message to the lead agent from the
browser and get a streamed reply, without needing terminal/tmux access.

**Third goal (control):** Let a human watch any agent's current response
appear in the UI near-live (not just a last-line snapshot), and stop or
interrupt a specific agent's in-flight turn from the browser — with a
confirmation step and a recorded audit entry — without needing terminal/tmux
access.

### Non-goals (explicitly out of scope for this project)

- Arbitrary remote-control of agents (running shell commands, editing files,
  reassigning work) from the UI — control is limited to: watch live, stop /
  interrupt. Anything beyond that stays a terminal/tmux operation.
- Multi-VPS / cross-machine agent support.
- Any datastore heavier than SQLite.
- Replacing tmux or the terminal workflow — the dashboard is additive.

## 4. Success criteria (exit bar for the project as a whole)

- Amirreza can open the dashboard from his phone and correctly state, for
  every active feature, its pipeline stage and its owning agent's current
  activity — without touching tmux — and it matches reality.
- The full payments↔search (or equivalent) interface negotiation is readable
  end-to-end in the Conversations view, sourced from existing transcripts
  with no agent-side instrumentation added.
- A new feature can be assigned to the lead agent from the phone browser,
  end-to-end, via the chat drawer.
- No agent session is ever blocked, delayed, or interrupted by the dashboard
  *reading* its state (verified: dashboard uptime/restarts have zero
  observed impact on agent turn latency) — interruption only ever happens
  when a human deliberately triggers Stop.
- Watching any agent from the Team board shows its response appearing
  incrementally (near-live), not just a snapshot that updates every poll
  cycle.
- Clicking Stop on a running agent reliably halts its current turn, is
  reflected in the UI within a few seconds, and leaves an audit trail entry
  (who, which agent, when).

## 5. Users

- **Amirreza** — primary user, checks in from desktop and phone, wants
  low-latency truth over polish.
- **Teammates** (small number) — same views; chat drawer needs to tag
  messages by sender so the lead knows who's talking.

## 6. Scope by phase

Phases build on the design doc (`agentdashboardplan.md`); P1–P2 and the chat
part of P3/P4 are as originally planned. P3 (live tailing) and P5 (Stop
control) are new, added because the read-only-first / control-comes-later
constraint from the original doc has been superseded: the team explicitly
wants near-live viewing and the ability to stop an agent, not just observe
after the fact. Each phase is still a shippable increment with its own exit
criterion, and control (P5) still lands after the read-only and live-view
layers (P1–P4) are proven, per the risk this carries (see R5 below).

- **P0 — Project structure**: scaffold the repo — `backend/` (Fastify +
  TypeScript service, SQLite via `better-sqlite3`), `frontend/` (Vite +
  React + Tailwind), shared lint/format config, `.gitignore`, root README
  describing layout and how to run both services locally. No features yet;
  this just gives every later phase a place to land code.
  *Exit: `backend` boots an empty Fastify server and `frontend` boots an
  empty Vite dev server, both from a fresh clone with one install command
  each.*
- **P1 — Read-only MVP**: liveness + pipeline collectors, SQLite, REST + SSE,
  Team board + Pipeline views, Tailscale-vs-Caddy decision.
  *Exit: open the page, see truthfully who's alive and every feature's stage
  without touching tmux.*
- **P2 — Conversations**: transcript watcher incl. SendMessage extraction,
  messages table, threads UI, backfill of existing transcripts.
  *Exit: read the full payments↔search interface negotiation in the
  browser.*
- **P3 — Live activity**: switch transcript watching from polling to
  low-latency file tailing (e.g. inotify via chokidar) so an agent's
  in-progress response streams into the Team board / agent detail view as
  it's written, not just on the next poll tick.
  *Exit: open an agent's detail view while it's mid-turn and watch its
  output appear incrementally, with sub-few-second lag.*
- **P4 — Web chat**: Agent SDK `web-lead` bridge, chat drawer, per-user
  identity tagging, streamed replies using the P3 live-tail pipeline.
  *Exit: assign a new feature from the phone browser end-to-end.*
- **P5 — Control (Stop)**: a Stop/Interrupt action per agent in the UI —
  confirmation dialog, restricted to authenticated users, backed by a
  documented interrupt mechanism (see `agentdashboardplan.md` chat-bridge
  options for the underlying session-control approach), every use logged to
  the `events` table.
  *Exit: stop a genuinely running agent from the UI and see it reflected as
  dead/idle within a few seconds, with an audit entry recorded.*
- **P6 — Hardening**: retention/rotation, stalled-agent alerts, cost/metrics
  strip, dark mode.

## 7. Requirements

### 7.1 Functional

- Show every registered agent, alive/dead state, and a one-line current
  activity derived from its latest transcript entry.
- Show every feature's pipeline stage (`not_started → spec → interfaces →
  plan → implementing → in_review → merge_ready → merged`), derived
  deterministically from spec gate files, branch existence, and PR state.
- Show full inter-agent and human↔agent conversation history, threaded,
  searchable, filterable by agent.
- Show a reverse-chronological event timeline (turn finished, gate passed,
  PR opened, escalation raised) as an audit trail.
- Provide a chat drawer, available from any view, to message the lead agent
  and receive a streamed reply.
- Stream an agent's in-progress response into the UI near-live (file-tail
  latency, not fixed poll interval) for both the Team board and the chat
  drawer.
- Provide a per-agent Stop/Interrupt control, gated behind a confirmation
  dialog, that halts the agent's current turn; every invocation is written
  to the `events` table with actor, target agent, and timestamp.
- Redact likely secrets (API keys, tokens) from transcript-derived content
  before it is stored or displayed.
- Work usably at 390px viewport width (phone).

### 7.2 Non-functional

- Dashboard reads must never block or delay an agent session's turn.
- Transcript parsing must degrade gracefully ("activity unknown") on unknown
  entry shapes rather than crash, since the JSONL schema is internal and
  can change across Claude Code releases.
- Single Node/Fastify service, SQLite storage, no additional ops burden.
- Access is private by default (Tailscale-only, or Caddy + basic auth if a
  shareable URL is needed) — decided in P1, not before.
- Control actions (Stop) are the *only* write path the dashboard has into an
  agent's runtime, must be behind auth, must always ask for confirmation in
  the UI before executing, and must always be logged — no silent or
  automatic use of Stop by the dashboard itself.
- Live-tail latency target: an agent's new output should be visible in the
  UI within a few seconds of being written to its transcript.

## 8. Key risks (carried from the design doc, tracked through delivery)

- **R1** — Transcript JSONL format is internal/undocumented → isolate
  parsing behind a tested `transcript-parser` module with fixture-based
  contract tests.
- **R2** — Unknown whether an Agent-SDK-driven session counts as "attended"
  for cross-session messaging → spike before committing to the chat-bridge
  design; fallback is tmux `send-keys` injection.
- **R3** — Concurrent web chats interleaving in one lead's context →
  serialize turns server-side, name-tag messages.
- **R4** — Secrets leaking from transcripts into the UI → mandatory
  redaction pass before storage.
- **R5** — Stop is a hard-to-reverse action: interrupting an agent mid-turn
  can leave a branch, worktree, or negotiation half-finished, and a
  mis-clicked Stop on the wrong agent card is easy in a busy team board →
  require an explicit confirmation naming the target agent, restrict Stop to
  authenticated users, log every use, and ship it only after P1–P4 (the
  read-only and live-view layers) have run long enough to be trusted.
- **R6** — Low-latency live tailing (P3) is more invasive than the original
  30s-poll design: it needs per-session file watches instead of periodic
  scans, which raises the collector's file-descriptor and CPU footprint as
  the number of concurrent agents grows → cap concurrent watched sessions,
  fall back to polling for idle/background agents and reserve live-tail for
  the agent currently in view.

## 9. Open questions

- Q1: Surface human↔agent tmux conversations too, or agent-web-chat only?
  (Default: off, revisit post-P1.)
- Q2: Tailscale-only vs. Caddy + basic auth for exposure? (Leaning
  Tailscale for P1; revisit if a non-Tailscale teammate needs access.)
- Q3: What is "Stop" mechanically — a tmux `C-c`/`send-keys` interrupt into
  the agent's window, or a native interrupt through the Agent SDK session
  used for `web-lead` (per R2 in the design doc)? tmux interrupt is simpler
  and works for any agent today; an SDK-native interrupt is cleaner but only
  covers SDK-driven sessions. Needs a short spike in P5 before committing.

## 10. Reference

Full technical plan (backend components, data model, API shape, frontend
views, chat-bridge design options): `docs/agentdashboardplan.md`.
