# PRD: Agent Team Dashboard

## 1. Summary

A web app running on the VPS that gives Amirreza and the team a single,
truthful, real-time view of the agent team: who's alive, what each agent is
doing right now, where every feature sits in the delivery pipeline, the full
history of agent↔agent conversations, and a browser chat panel to talk
directly to the lead agent. The dashboard is a **reader**, not a controller:
it observes existing session transcripts, hook events, specs, and git/PR
state on disk — it never blocks, interrupts, or drives agent sessions (the
one deliberate exception being the human↔lead chat bridge).

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

### Non-goals (explicitly out of scope for this project)

- Controlling agents from the UI (pause/kill/reassign buttons).
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
  reading its state (verified: dashboard uptime/restarts have zero observed
  impact on agent turn latency).

## 5. Users

- **Amirreza** — primary user, checks in from desktop and phone, wants
  low-latency truth over polish.
- **Teammates** (small number) — same views; chat drawer needs to tag
  messages by sender so the lead knows who's talking.

## 6. Scope by phase

Phases are the plan of record from the design doc (`agentdashboardplan.md`);
each is a shippable increment with its own exit criterion.

- **P1 — Read-only MVP**: liveness + pipeline collectors, SQLite, REST + SSE,
  Team board + Pipeline views, Tailscale-vs-Caddy decision.
  *Exit: open the page, see truthfully who's alive and every feature's stage
  without touching tmux.*
- **P2 — Conversations**: transcript watcher incl. SendMessage extraction,
  messages table, threads UI, backfill of existing transcripts.
  *Exit: read the full payments↔search interface negotiation in the
  browser.*
- **P3 — Web chat**: Agent SDK `web-lead` bridge, chat drawer, per-user
  identity tagging.
  *Exit: assign a new feature from the phone browser end-to-end.*
- **P4 — Hardening**: retention/rotation, stalled-agent alerts, cost/metrics
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

## 9. Open questions

- Q1: Surface human↔agent tmux conversations too, or agent-web-chat only?
  (Default: off, revisit post-P1.)
- Q2: Tailscale-only vs. Caddy + basic auth for exposure? (Leaning
  Tailscale for P1; revisit if a non-Tailscale teammate needs access.)

## 10. Reference

Full technical plan (backend components, data model, API shape, frontend
views, chat-bridge design options): `docs/agentdashboardplan.md`.
