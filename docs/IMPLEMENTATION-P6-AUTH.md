# Implementation Plan — Auth (PRD Q2)

Closes the gap left open through P1–P5: the dashboard has **no app-layer
authentication**, while `POST /chat` spawns an agent process, `POST
/agents/:name/stop` interrupts a running agent, and the read endpoints expose
transcript content. Q2 ("Tailscale-only vs Caddy basic auth") was deferred as
a deployment concern; this adds a small app-layer guard so the dashboard is not
defenceless if it is ever reachable.

## Constraint that decides the design

**`EventSource` cannot set request headers.** The live channel (`GET /live`) is
an `EventSource`, so a bearer-token-only scheme would authenticate every route
except the one streaming agent activity. The UI is served from the same origin
as the API (Fastify serves `frontend/dist`), so a **cookie** is sent
automatically on the SSE request. Cookie it is — with `Authorization: Bearer`
also accepted, for hooks and `curl` (`POST /ingest` is called by shell hooks
that cannot hold a cookie jar).

## Shape

- **`DASHBOARD_TOKEN` unset ⇒ auth disabled**, exactly as today, so existing
  deployments and all current tests are unaffected. The server logs a warning,
  and a LOUDER one when `ENABLE_STOP` is also on — an unauthenticated Stop
  endpoint lets anyone interrupt the team's agents.
- **`DASHBOARD_TOKEN` set ⇒ everything requires auth**, except:
  - `GET /health` — liveness probes,
  - `POST /auth/login`, `GET /auth/status` — needed to authenticate at all,
  - the static UI assets — the login page must load before anyone can log in.
    The bundle is not secret; the data behind it is.
- **Session**: `POST /auth/login {token}` compares **timing-safely**, then sets
  an `httpOnly`, `SameSite=Strict`, `Path=/` cookie holding a random session id
  (not the token itself). Sessions live in memory: a restart logs everyone out,
  which is an acceptable trade for having no session store. `POST /auth/logout`
  clears it.
- Failure is **401 with a JSON body**, never a redirect — the API's clients are
  `fetch` and `EventSource`, not browsers following redirects.

## Units

| # | Unit | Kind | Test focus |
|---|------|------|------------|
| 1 | `auth.ts` — token compare + session store | **pure-ish** | timing-safe compare (equal- and unequal-length, wrong token, right token); session create/verify/revoke; unknown/expired id rejected |
| 2 | cookie parse/serialize | **pure** | parses a header with several cookies, missing cookie, malformed; serialized cookie carries HttpOnly/SameSite/Path |
| 3 | `buildApp` auth guard | adapter | with no token configured every route behaves as today; with a token, protected routes 401, exempt routes 200; a valid cookie passes; a valid `Bearer` passes; a wrong token 401 |
| 4 | `/auth/login`, `/auth/logout`, `/auth/status` | adapter | login sets the cookie and 200s; wrong token 401 and sets nothing; status reports `{authRequired, authenticated}` without leaking whether a token exists beyond that boolean |
| 5 | `index.ts` wiring | adapter | reads `DASHBOARD_TOKEN`; warns when unset; warns harder when Stop is enabled without it |
| 6 | Frontend login gate | component | a 401 from any call shows a login form; submitting calls `login(token)`; a failed login shows an error; after success the dashboard loads; logout returns to the form |

## Explicitly NOT in scope

Multiple users/accounts, roles, or per-user permissions — this is one shared
token for a small trusted team, matching the design doc's "2 users". It is a
lock on the door, not an identity system; the chat drawer's per-user name tags
remain self-declared and are **not** authenticated identities. Network-level
exposure (Tailscale/Caddy/TLS) remains a deployment decision, and this guard
does not replace it: over plain HTTP a token is still sent in the clear.
