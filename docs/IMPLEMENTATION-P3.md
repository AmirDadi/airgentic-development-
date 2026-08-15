# Implementation Plan — P3 (Live activity)

Companion to [`PRD.md`](PRD.md). This plan **deviates from the PRD's stated P3
approach**, on measured evidence. The deviation is argued below; the user-
visible goal is unchanged and, in fact, better served.

## What the PRD asked for

> **P3 — Live activity**: switch transcript watching from polling to
> low-latency file tailing (e.g. inotify via chokidar) so an agent's
> in-progress response streams into the Team board / agent detail view as it's
> written, not just on the next poll tick.
> *Exit: open an agent's detail view while it's mid-turn and watch its output
> appear incrementally, with sub-few-second lag.*

Carrying risk **R6**: "low-latency live tailing is more invasive than the
30s-poll design … raises the collector's file-descriptor and CPU footprint …
cap concurrent watched sessions, fall back to polling for idle agents."

## What measurement says

Two facts, both measured on this codebase rather than assumed:

**1. The transcript collector already polls at 1s, not 30s.** R6 was written
against the original 30s design. The exit criterion "sub-few-second lag" is
therefore *already met*: a 1s poll gives a mean latency of ~500ms and a worst
case of ~1000ms.

**2. Idle polling is cheap.** Steady-state cost of one full poll pass with no
new bytes, measured over 10 passes each:

| sources | ms per idle pass | ms per source |
|--------:|-----------------:|--------------:|
| 1       | 0.64             | 0.639         |
| 10      | 1.40             | 0.140         |
| 50      | 8.44             | 0.169         |
| 200     | 35.67            | 0.178         |

At a 1s interval that is **0.14% of one core for 10 agents** and 3.6% for 200 —
for a team that "keeps the team on one box" (design doc §6), the cost is noise.

**Conclusion: R6's premise is inverted.** Polling is not the expensive option;
inotify watches would *add* file-descriptor pressure and a second code path
(watch + debounce + rescan-on-miss, plus a polling fallback for the misses
inotify is known for on some filesystems) to buy at most ~500ms of mean
latency that the exit criterion does not require. That is a poor trade.

## What is actually missing

The P3 *user story* — "open an agent's detail view and watch its output appear
incrementally" — cannot be satisfied today, but not because of latency:

- **There is no agent detail view.** The Team board shows one derived line
  (`current_activity`) per agent. Nothing shows the response itself.
- **Nothing persists transcript entries.** `collectTranscripts` extracts
  `send_message` into `messages` and derives a one-line activity; every other
  entry — the assistant text, the tool calls, the results — is parsed and then
  discarded. There is nothing for a detail view to render.

So the bottleneck is *what we keep and show*, not *how fast we notice*. This is
the same class of finding as P2.5: the mechanism was fine, the data wasn't
there.

## Plan of record

**Keep polling.** Drop the transcript interval 1000ms → 400ms (still ~0.07% of
a core at 10 agents by the table above), which halves mean latency to ~200ms
for one line of config and no new failure modes. Revisit inotify only if a
real deployment shows the poll cost mattering — and record that in R6.

Build the two things that are actually missing:

| # | Unit | Kind | Test focus |
|---|------|------|------------|
| 1 | `entries` table + `insertEntries`/`listEntries` | adapter | round-trip every `TranscriptEntry` kind, per-agent cap, ordering, idempotent re-insert |
| 2 | transcript collector persists entries | adapter | entries stored with stable ids; **bodies redacted (R4)**; retention cap enforced |
| 3 | `GET /agents/:name/entries?limit=` | adapter | `app.inject()`, shape, unknown agent, limit validation |
| 4 | `entries` SSE channel on change | adapter | broadcast only for the agent that changed |
| 5 | `AgentDetail` view | component | renders each kind distinctly, streams updates, mid-turn state, empty state, XSS-safe |
| 6 | Team board → detail navigation | component | selecting an agent opens its detail; back returns |

**Exit criterion (restated, testable):** open an agent's detail view while its
transcript is being appended to, and see new entries appear without a manual
refresh, at sub-second lag.

## Retention

Entries are far higher-volume than messages (the real corpus is ~2000 entries
for one session). Cap per agent — keep the most recent N (default 500) and
delete older on write. Without this, P6's retention problem arrives early and
SQLite grows without bound. This is a hard requirement of unit 1, not a
follow-up.

## Deferred

inotify tailing (revisit with deployment evidence), the chat bridge (P4),
Stop/control (P5), auth (Q2).
