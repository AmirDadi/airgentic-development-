# Agent Team Dashboard — Plan (no code yet)

A web app on the VPS that shows, live: which agents exist and what each is doing
right now, where every feature sits in the pipeline (implemented / ongoing /
not started), the full history of agent↔agent conversations, and a chat panel
where Amirreza's team talks to the lead agent from the browser.

---

## 1. Core insight: everything is already on disk

No agent instrumentation is needed. The dashboard is mostly a *reader*:

| Data we want                  | Where it already lives                                      |
|-------------------------------|-------------------------------------------------------------|
| Agent roster + liveness       | Session registration files + `tmux list-windows`            |
| What an agent is doing now    | Its session transcript (JSONL under `~/.claude/projects/`)  |
| Pipeline stage per feature    | `specs/<f>.spec.md / .interfaces.md / .plan.md` + git branch/PR state |
| Inter-agent chats             | SendMessage entries inside session transcripts              |
| Turn-finished / push events   | Our existing Stop / PostToolUse hooks                       |
| Human↔agent web chat          | New: dashboard backend ↔ lead agent bridge                  |

Design rule: **agents are never blocked or queried by the dashboard.** We watch
files; we don't interrupt sessions. The one exception is the deliberate chat
channel in §4.

---

## 2. Backend (Node + Fastify, single service on the VPS)

### 2.1 Components

1. **Collectors** (in-process watchers, chokidar):
   - *Transcript watcher* — tails each session's JSONL; classifies new entries
     into: assistant text, tool call (which tool, short summary), SendMessage
     sent/received, turn end. This yields both "current activity" and the
     message history.
   - *Pipeline watcher* — watches `specs/` and runs a cheap `git for-each-ref`
     + `gh pr list` poll (30s) per worktree. Derives stage per feature:
     `not_started → spec → interfaces → plan → implementing → in_review → merge_ready → merged`.
     Gate files + branch existence + PR state give the stage deterministically.
   - *Liveness poller* — `tmux list-windows -t air-team` every 10s; marks
     agents alive/dead; records uptime.
2. **Hook ingestor** — extend `notify-telegram.sh` pattern with
   `notify-dashboard.sh`: hooks POST small JSON events to
   `http://127.0.0.1:8787/ingest` (turn finished, branch pushed). Gives
   instant events between transcript-poll ticks.
3. **Store** — SQLite (one file, zero ops). Tables:
   - `agents(name, kind, workdir, alive, last_seen, current_activity)`
   - `features(name, owner, stage, branch, pr_url, updated_at)`
   - `messages(id, ts, from_agent, to_agent, channel, body, session_id)`
     — `channel` ∈ {inter_agent, human_web, human_tmux?}
   - `events(id, ts, agent, type, payload)` — the timeline feed
4. **API**
   - REST: `GET /agents`, `GET /features`, `GET /messages?a=payments&b=lead`,
     `GET /events?since=`
   - **SSE stream** `GET /live` — one channel pushing all deltas (SSE over
     WebSocket: simpler, proxies well, one-directional fits our read-heavy case;
     chat send is a plain POST).
5. **Auth & exposure** — Caddy in front for TLS + basic auth (2 users). Better:
   keep it on Tailscale only and skip public exposure entirely. Decide in P1.

### 2.2 The chat bridge (human → lead agent)

Two candidate designs:

- **Option A — tmux injection**: backend does `tmux send-keys` into the lead
  window and tails the lead transcript for the reply. Pro: one single lead,
  same agent whether you talk via terminal, WhatsApp, or web. Con: fragile
  (typing into a live TUI), replies must be diffed out of the transcript,
  interleaves badly if two humans type at once.
- **Option B — Agent SDK session (recommended)**: backend runs a persistent
  headless "web-lead" session via the Claude Agent SDK, same workdir, same
  CHARTER.md, same skills, registered with a name so it appears in ListAgents
  and can SendMessage the owners like any other session. Pro: clean
  request/response API, streaming replies, multi-user safe (queue per turn).
  Con: it's a second coordinator — mitigate by making `web-lead` *the* lead
  and demoting the tmux lead to optional.

Plan of record: **Option B**, with Option A kept as a fallback spike if SDK
session registration for cross-session messaging turns out not to work
headlessly (risk R2 below).

---

## 3. Frontend (React + Tailwind, Vite, served by the same Fastify)

Four views, one shared SSE subscription:

1. **Team board** (default) — a card per agent: name, feature, alive dot,
   stage progress (1–5 gates), and a one-line "now: running tests in
   api/handlers_test.go" derived from the latest transcript entry. Dead or
   stalled (>N min silent) cards turn amber.
2. **Pipeline** — kanban columns = stages; cards = features; click a card to
   see its artifacts rendered (spec, interfaces, plan markdown) and PR link.
   This is the "implemented / ongoing / not started" answer at a glance.
3. **Conversations** — left: list of threads (lead↔payments, payments↔search,
   me↔lead...); right: the thread, chat-bubble style, with jump-to-artifact
   links when messages reference file paths. Filter by agent, search by text.
4. **Timeline** — reverse-chron event feed (turn finished, gate passed, PR
   opened, escalation raised), filterable. Doubles as audit trail.

Plus the **chat drawer**: available from every view, talks to `web-lead`
(POST /chat, streamed reply over the SSE channel). History persisted in
`messages` with `channel=human_web` so it shows up in Conversations too.

Mobile matters (you'll check from your phone): board and chat drawer must work
at 390px width; kanban collapses to accordion.

---

## 4. Phases

**P1 — Read-only MVP (build first, ~1 short week of agent-team dogfooding)**
- Liveness + pipeline collectors, SQLite, REST + SSE
- Team board + Pipeline views
- Caddy/Tailscale decision
- *Exit criterion: open the page, see truthfully who's alive and every
  feature's stage without touching tmux.*

**P2 — Conversations**
- Transcript watcher incl. SendMessage extraction, messages table, threads UI
- Backfill: parse existing transcripts so history predates the dashboard
- *Exit: read the full payments↔search interface negotiation in the browser.*

**P3 — Web chat**
- Agent SDK `web-lead` bridge, chat drawer, per-user identity tags
  ("Amirreza:", teammate name) prefixed into prompts so the lead knows who's
  talking
- *Exit: assign a new feature from the phone browser end-to-end.*

**P4 — Hardening**
- Retention/rotation for messages+events, stalled-agent alerts (reuse the
  Telegram hook), simple metrics strip (tokens/cost per agent if OTEL is
  enabled), dark mode because obviously.

---

## 5. Risks & open questions

- **R1 — Transcript format is internal and undocumented.** JSONL schema can
  change with Claude Code releases. Mitigation: isolate all parsing in one
  `transcript-parser.ts` with tolerant parsing + contract tests against
  captured fixtures; on unknown entries, degrade to "activity unknown", never
  crash.
- **R2 — Headless/SDK sessions and cross-session messaging.** Messaging
  requires attended sessions; whether an SDK-driven session counts as
  "attended" needs a 1-hour spike before committing to Option B. If it fails,
  fall back to Option A (tmux injection) for P3.
- **R3 — Two humans, one lead.** Concurrent web chats interleave in the lead's
  context. Mitigation: serialize turns in the backend queue + name-tag each
  message; revisit per-user lead sessions only if it actually hurts.
- **R4 — Secrets in transcripts.** Transcripts may contain tokens/keys agents
  saw. The conversations view must run a redaction pass (regexes for common
  key shapes) before storing message bodies.
- **Q1** — Show human tmux conversations with agents too? (Possible from the
  same transcripts; adds noise. Default: off, toggle later.)
- **Q2** — Auth: Tailscale-only (no public URL, zero auth code) vs Caddy basic
  auth (shareable). Leaning Tailscale for P1.

---

## 6. Deliberately out of scope (for now)

- Controlling agents from the UI beyond chat (pause/kill buttons) — dangerous
  to build before trust in the read-only layer.
- Multi-VPS support — cross-machine messaging is reply-only today; keep the
  team on one box.
- Persisting to anything heavier than SQLite.
