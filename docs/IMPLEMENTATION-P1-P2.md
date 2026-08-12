# Implementation Plan — P1 (Read-only MVP) & P2 (Conversations)

Companion to [`PRD.md`](PRD.md) and [`agentdashboardplan.md`](agentdashboardplan.md).
This is the build-order and testing plan for the first two phases.

## Guiding constraints

1. **Read-only.** Nothing in P1/P2 writes to an agent's runtime. Collectors
   read files and run read-only shell commands (`tmux list-windows`,
   `git for-each-ref`). Control (Stop) is P5 and deliberately absent here.
2. **Tolerant parsing (PRD R1).** The transcript JSONL schema is internal and
   undocumented. All parsing is isolated in `transcript-parser.ts`, driven by
   captured fixtures, and degrades to `activity unknown` instead of throwing.
3. **Redact before store (PRD R4).** Message bodies pass through `redact()`
   before they reach SQLite — not on the way out to the UI. A secret that
   never lands in the DB can't leak from it.
4. **Pure core, thin shell.** Every non-trivial decision (stage derivation,
   entry classification, activity summarisation, redaction, thread grouping)
   is a pure function taking data and returning data. Shell-outs and file
   watching are thin adapters around them. This is what makes TDD viable
   with no live agent team in the test environment.

## Testing strategy (TDD)

Tests are written before implementation, per unit. Runner: **Vitest** in both
workspaces (same config shape, jsdom for frontend).

- **Pure units** (the bulk): table-driven tests over fixtures. No filesystem,
  no tmux, no git.
- **Fixtures**: `backend/test/fixtures/` holds captured-shape JSONL
  transcripts, `tmux list-windows` output, and `git for-each-ref` output.
  Contract tests assert we survive *unknown* shapes, not just known ones.
- **Adapters**: tested against temp dirs (real files, no mocks of `fs`) and
  injected fake command-runners for `tmux`/`git` — the command *builder* is
  pure and tested; the executor is injected.
- **API**: Fastify `app.inject()` — real routing, no network.
- **Frontend**: Vitest + Testing Library on pure render/state logic.

CI already runs `npm ci && npm run build` per workspace; this plan adds
`npm test` to that workflow.

## Shared contracts (built first, before fan-out)

`backend/src/types.ts` and the SQLite schema in `backend/src/db.ts` are the
contract every other module codes against, so they land first:

```
agents(name PK, kind, workdir, alive, last_seen, current_activity)
features(name PK, owner, stage, branch, pr_url, updated_at)
messages(id PK, ts, from_agent, to_agent, channel, body, session_id)
events(id PK, ts, agent, type, payload)
```

`Stage = not_started | spec | interfaces | plan | implementing | in_review |
merge_ready | merged`

## P1 — Read-only MVP

| # | Unit | Kind | Test focus |
|---|------|------|------------|
| 1 | `db.ts` — schema, migrations, typed queries | adapter | opens in-memory DB, idempotent migration, round-trips each table |
| 2 | `stage.ts` — `deriveStage(artifacts, branch, pr)` | **pure** | every stage transition; precedence when signals disagree; unknown → `not_started` |
| 3 | `tmux.ts` — `parseTmuxWindows(stdout)` | **pure** | normal output, empty session, missing session, malformed line |
| 4 | `collectors/liveness.ts` | adapter | injected runner; marks alive/dead; records `last_seen` |
| 5 | `collectors/pipeline.ts` | adapter | temp `specs/` dir + fake git/PR data → rows in `features` |
| 6 | `api/routes.ts` — `GET /agents`, `/features`, `/events` | adapter | `app.inject()`, shapes + filters (`?since=`) |
| 7 | `sse.ts` — `GET /live` broadcast hub | adapter | subscribe/broadcast/unsubscribe, no leak on disconnect |
| 8 | `POST /ingest` — hook events | adapter | valid payload persists; malformed rejected 400 |
| 9 | Frontend: Team board + Pipeline views | component | renders roster/stages from fixture props; stalled + dead states |

**Exit (from PRD):** open the page, see truthfully who's alive and every
feature's stage without touching tmux.

## P2 — Conversations

| # | Unit | Kind | Test focus |
|---|------|------|------------|
| 10 | `redact.ts` — `redact(text)` | **pure** | common key shapes; leaves prose intact; idempotent |
| 11 | `transcript-parser.ts` — `parseEntry(line)` | **pure** | assistant text, tool call, SendMessage sent/received, turn end, **unknown → degraded not thrown**, malformed JSON |
| 12 | `activity.ts` — `deriveActivity(entries)` | **pure** | one-line summary; unknown → `activity unknown` |
| 13 | `collectors/transcript.ts` — tail + backfill | adapter | temp JSONL; resumes at offset; backfill parses pre-existing history |
| 14 | `threads.ts` — `groupIntoThreads(messages)` | **pure** | pairwise grouping, ordering, self-messages excluded |
| 15 | `GET /messages?a=&b=` | adapter | `app.inject()`, filtering + pagination |
| 16 | Frontend: Conversations view | component | thread list + bubbles from fixture props |

**Exit (from PRD):** read a full inter-agent interface negotiation in the
browser, sourced from existing transcripts with no agent-side
instrumentation.

## Build order

Contracts (types + db) → P1 pure units (2, 3) in parallel with P2 pure units
(10, 11, 12, 14) → adapters that depend on them → API → frontend views.
Pure units have no interdependencies and are built concurrently.

## Explicitly deferred

Live tailing at sub-second latency (P3), the `web-lead` chat bridge (P4),
Stop/control (P5), auth and exposure decision (PRD Q2), retention (P6).
