# Implementation Plan — P4 (Web chat)

Companion to [`PRD.md`](PRD.md) and [`SPIKE-R2.md`](SPIKE-R2.md).

Goal: a human types in the browser, a `web-lead` agent answers with a streamed
reply, and that agent can coordinate the rest of the team like any other
session.

## Mechanics, all verified before designing

Three probes on this machine (see also `SPIKE-R2.md`):

| Mechanic | Verdict | Evidence |
|---|---|---|
| Headless session is addressable | works | binds its own inbox socket; `SendMessage` delivery confirmed by receipt |
| Multi-turn continuity | works | `--continue` in a dedicated cwd recalled a codeword set in the previous turn |
| Incremental streaming | works | `--output-format stream-json --include-partial-messages` emits `stream_event/content_block_delta` |

**Continuity is also what makes it cheap.** Turn 1 in a fresh directory
reported ~$0.050 of usage; the resumed turn 2 reported **$0.0117** — roughly
4× less, because it resumes rather than reloading context. This decides the
design: the bridge gets its **own working directory** and every turn after the
first uses `--continue`.

(Usage figures are list-price valuations. Under subscription auth they consume
plan limits rather than billing per token — see `SPIKE-R2.md`.)

## Design

```
browser ──POST /chat──▶ turn queue ──▶ claude -p --continue (own cwd)
   ▲                                        │ stream-json
   └────────── SSE "chat" ◀── deltas ◀──────┘
```

**One session, own directory.** `WEB_LEAD_DIR` (default `./web-lead`). The
`--continue` scope is per-directory, so this isolates the bridge's history
from the dashboard repo and keeps its context small.

**Turns are serialized** (PRD R3). Two humans typing at once must not
interleave inside one agent's context. A queue runs one turn at a time and
each prompt is name-tagged (`Amirreza: …`) so the lead knows who is talking.

**Delivery is best-effort, and that is a design constraint, not a caveat.**
There is no `sendMessage()` API — messaging is a tool the model *chooses* to
call. The bridge must never report "sent to payments" on the model's say-so;
it reports what the model said and surfaces failures.

**Lifecycle is ours.** A session's socket lives only as long as its process,
so a turn that dies takes the address with it. Every turn is a fresh process
that resumes stored history, which makes crash recovery the normal path rather
than a special case.

## Units

| # | Unit | Kind | Test focus |
|---|------|------|------------|
| 1 | `chat/stream-parser.ts` — classify stream-json lines | **pure** | delta/text/result/error; unknown → ignored, never thrown; malformed JSON; partial line |
| 2 | `chat/bridge.ts` — run one turn | adapter | injected spawner; first turn omits `--continue`, later turns include it; deltas emitted in order; non-zero exit, `is_error`, timeout, and no-result all surface as errors; never throws |
| 3 | `chat/queue.ts` — serialize turns | **pure-ish** | one at a time; FIFO; a failing turn does not stall the queue; queue depth reported |
| 4 | `POST /chat` + `GET /chat/history` | adapter | `app.inject()`; validation (empty text → 400); 202 with a turn id; history oldest-first |
| 5 | SSE `chat` channel | adapter | delta / done / error frames carry the turn id; one broken subscriber cannot break others |
| 6 | persistence | adapter | both sides stored in `messages` with `channel:"human_web"`; **bodies redacted before storage (R4)**; appear in `/threads` |
| 7 | `ChatDrawer` | component | open from any view; streams deltas; shows sender; error state; XSS-safe; 390px |

## Security

- Prompt text is user input that becomes an argument to a spawned process:
  **pass it on stdin or as a single argv element, never through a shell.**
  A test must prove a prompt containing `$(...)`, backticks and `;` reaches
  the agent as literal text.
- Chat bodies pass through `redact()` before storage, like every other body.
- The bridge runs with the dashboard's own credentials. It is *not* exposed
  to unauthenticated users — the exposure decision (PRD Q2) still gates
  anything public.

## Exit criterion

Type a message in the browser, watch the reply stream in token by token, and
have the follow-up message land in the same conversation with context intact.

## Deferred

Stop/control (P5), auth (Q2), per-user lead sessions (revisit only if R3's
serialization proves insufficient), retention of chat history (P6).
