# Spike R2 — can a headless session take part in cross-session messaging?

**Status: RESOLVED — yes, on all three counts. Option B is viable; build it.**

This was the blocking risk on P4 (the web chat bridge). The PRD said:

> **R2** — Headless/SDK sessions and cross-session messaging. Messaging
> requires attended sessions; whether an SDK-driven session counts as
> "attended" needs a 1-hour spike before committing to Option B. If it fails,
> fall back to Option A (tmux injection) for P3.

## The mechanism (confirmed on this machine, not just from docs)

Same-machine agent messaging is a **Unix domain socket** per session — not
Anthropic infrastructure. A live session exports:

```
CLAUDE_CODE_SESSION_ID=<uuid>
CLAUDE_CODE_MESSAGING_SOCKET=/tmp/cc-socks/<n>.sock
CLAUDE_CODE_MESSAGING_TOKEN=<token>
```

and the socket exists on disk with owner-only permissions:

```
srw------- 1 root root 0 /tmp/cc-socks/514.sock
```

"Attended" concretely means **a session has bound an inbox socket**. It does
not mean a human is watching.

## Experiment

A first attempt was confounded: `claude -p` launched with the ambient
environment **inherited `CLAUDE_CODE_SESSION_ID`** and attached to the calling
session instead of starting an independent one — no new socket, and the
result reported the caller's own `session_id`. Re-run with those variables
explicitly unset:

```bash
env -u CLAUDE_CODE_SESSION_ID \
    -u CLAUDE_CODE_MESSAGING_SOCKET \
    -u CLAUDE_CODE_MESSAGING_TOKEN \
  claude -p "<prompt>" --output-format json
```

while polling `/tmp/cc-socks/` at 200ms.

### 1. Does a headless session bind an inbox socket? — YES

```
baseline sockets: 509.sock
NEW SOCKET APPEARED at ~1200ms: 2202.sock
sockets after exit: 509.sock
```

A headless session binds its own socket ~1.2s after launch and releases it on
exit. It is addressable for exactly as long as it lives.

### 2. Can it discover peers (`ListAgents`)? — YES

Asked to list agents it could message, the headless session returned:

```
1 agent found: airgentic-development-e4
```

i.e. it discovered the interactive session by name.

### 3. Can it send (`SendMessage`)? — YES, verified by receipt

The headless session was asked to send a probe string. Its own report:

```json
{"success":true,
 "message":"… → airgentic-development-e4 (another Claude session on this machine)",
 "msg_id":"d8507634-c96d-4964-9a96-0473c02cff17"}
```

and — the part that makes this conclusive rather than self-reported — **the
receiving session actually got it**:

```
<cross-session-message from="uds:/tmp/cc-socks/4017.sock"
                       from-name="airgentic-development-9a">
R2-SPIKE-PROBE-OK
</cross-session-message>
```

Delivered verbatim. Note the sender has its **own** name and **own** socket,
which also resolves the confusion in the first attempt: the `session_id` field
in the JSON output was misleading, but the messaging identity was genuinely
separate.

## Consequences for P4

- **Option B (a persistent headless "web-lead" session) is viable.** Build it.
- **Option A (tmux `send-keys` into a live TUI) is not needed** and should not
  be built. It was the fallback for a risk that did not materialise.
- Messaging is **model-invoked**, not an API: there is no `sendMessage()`
  function in the SDK. The lead agent *decides* to call the tool. The bridge
  must therefore treat delivery as best-effort and surface failures, rather
  than assuming a call happened.
- The socket is **per-session and lives only as long as the process**, so the
  bridge owns that session's lifecycle: if it dies, its address disappears and
  the dashboard must restart it and re-advertise.

## Cost and caveats

The full spike cost **~$0.56** across three probes. The first two were
expensive (~$0.24 each) because a session attaching to an existing project
loads its context; the clean, well-scoped third probe cost **$0.09**.

Measured on **one machine, one Claude Code version**, with subscription auth.
Not verified: behaviour under `--bare` (documented to skip socket binding),
long-lived multi-turn headless sessions held open for hours, or two humans
driving one lead concurrently (PRD R3).
