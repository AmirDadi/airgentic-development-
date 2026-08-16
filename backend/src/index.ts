/**
 * Process entry point: open the DB, build the HTTP app, start the collector
 * runtime, listen.
 *
 * The hub is created HERE and handed to both `buildApp` and `createRuntime`,
 * so the runtime's broadcasts land on the same fan-out the `/live` route
 * subscribes to. Two hubs would look fine and deliver nothing.
 *
 * Configuration (all env, all optional):
 *   DB_PATH             SQLite file. Default "dashboard.db".
 *   PORT                HTTP port. Default 8787.
 *   HOST                Bind address. Default "0.0.0.0".
 *   TMUX_SESSION        tmux session whose windows are the agents. Default "agents".
 *   ENABLE_STOP         Set truthy to enable the Stop control (POST
 *                       /agents/:name/stop sends C-c to the agent's tmux
 *                       window). OFF by default: Stop writes into an agent's
 *                       runtime, so a deployment must opt in. Unset = 503, and
 *                       it MUST sit behind the deployment's own access control.
 *   DASHBOARD_TOKEN     Shared secret for app-layer auth. UNSET = auth is
 *                       disabled and every endpoint is open, exactly as before
 *                       (the server warns, and warns harder when ENABLE_STOP
 *                       is on: an open Stop endpoint lets anyone interrupt the
 *                       team's agents). Set = everything needs a credential
 *                       except GET /health, POST /auth/login, GET /auth/status
 *                       and the static UI assets. Clients log in at
 *                       POST /auth/login {token} and get an httpOnly cookie
 *                       holding a random session id; hooks and curl may send
 *                       `Authorization: Bearer <token>` instead. Sessions are
 *                       IN MEMORY, so a restart logs everyone out. Over plain
 *                       HTTP the token still travels in the clear: this is a
 *                       lock on the door, not a replacement for TLS/Tailscale.
 *   GITHUB_REPO         "owner/repo" of the PROJECT repo. When set, ALL THREE
 *                       pipeline signals come from it: gate artifacts via the
 *                       contents API, branches via the branches API, PRs via
 *                       the pulls API. Unset = local fallback mode (SPECS_DIR
 *                       scan + local git, no PR signal).
 *   GITHUB_TOKEN        PAT for the GitHub API. Omit for a public repo.
 *   SPECS_REPO_PATH     Directory INSIDE the GitHub repo holding the gate
 *                       artifacts. Default "specs". Only used with GITHUB_REPO.
 *   SPECS_REF           Branch/ref the gate artifacts are read from. Default
 *                       "main" — set it when the repo's default branch is
 *                       anything else. Only used with GITHUB_REPO.
 *   SPECS_DIR           LOCAL fallback directory scanned for
 *                       `<feature>.{spec,interfaces,plan}.md` when GITHUB_REPO
 *                       is unset. Default "specs". Ignored when GITHUB_REPO is
 *                       set — the repo is then the source of truth for specs.
 *   TRANSCRIPT_SOURCES  JSON array of {agent, path, sessionId} transcripts to
 *                       tail. Default none — the board still shows agents and
 *                       features without it. Invalid JSON is ignored (logged).
 *   WEB_LEAD_DIR        Working directory for the web-lead chat session. Set
 *                       to enable the chat drawer; UNSET = chat disabled and
 *                       POST /chat answers 503, with the rest of the dashboard
 *                       unaffected. Give it its OWN directory: `--continue`
 *                       scope is per-directory, so this both isolates the
 *                       lead's history and keeps its context (and usage) small.
 *   WEB_LEAD_TIMEOUT_MS Per-turn timeout. Default 120000.
 *   UI_DIR              Directory of the built frontend to serve from this
 *                       same origin. Defaults to ../frontend/dist when that
 *                       exists, so `npm run build` in both workspaces gives a
 *                       single URL that serves the dashboard AND its API.
 *                       The UI fetches same-origin relative paths, so without
 *                       this there is no URL that serves a working dashboard.
 *   POLL_LIVENESS_MS    Liveness poll interval.
 *   POLL_PIPELINE_MS    Pipeline poll interval.
 *   POLL_TRANSCRIPT_MS  Transcript poll interval.
 *                       All three default in runtime.ts (DEFAULT_INTERVALS).
 *                       Deliberately NOT repeated here: when this file also
 *                       named a default it passed it on every boot, so the
 *                       runtime default was dead code and tuning it changed
 *                       nothing in production.
 */

import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { buildApp } from "./app.js";
import { migrate } from "./db.js";
import { createSseHub } from "./sse.js";
import { createRuntime, defaultRunner } from "./runtime.js";
import { createBridge } from "./chat/bridge.js";
import type { TranscriptSource } from "./collectors/transcript.js";

function envNumber(name: string, fallback: number): number {
  return envNumberOpt(name) ?? fallback;
}

/** Undefined when unset or invalid, so the callee's own default applies. */
function envNumberOpt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Parses TRANSCRIPT_SOURCES; bad config must not stop the server booting. */
function parseSources(raw: string | undefined): {
  sources: TranscriptSource[];
  error: string | null;
} {
  if (raw === undefined || raw.trim() === "") return { sources: [], error: null };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { sources: [], error: "not an array" };
    const sources = parsed.filter(
      (s): s is TranscriptSource =>
        typeof s === "object" &&
        s !== null &&
        typeof (s as TranscriptSource).agent === "string" &&
        typeof (s as TranscriptSource).path === "string" &&
        typeof (s as TranscriptSource).sessionId === "string",
    );
    return { sources, error: null };
  } catch {
    return { sources: [], error: "invalid JSON" };
  }
}

const dbPath = process.env.DB_PATH ?? "dashboard.db";
const db = new Database(dbPath);
migrate(db);

// One hub, shared by the HTTP fan-out and the collector runtime.
const hub = createSseHub();

const defaultUiDir = fileURLToPath(new URL("../../frontend/dist", import.meta.url));
const uiDir =
  process.env.UI_DIR ?? (existsSync(defaultUiDir) ? defaultUiDir : undefined);

// The chat bridge spawns a real `claude` process per turn, so it is only
// constructed when a directory is configured. Without one the dashboard runs
// exactly as before and POST /chat answers 503.
const webLeadDir = process.env.WEB_LEAD_DIR?.trim();
const chat =
  webLeadDir === undefined || webLeadDir === ""
    ? undefined
    : createBridge({
        cwd: webLeadDir,
        timeoutMs: envNumberOpt("WEB_LEAD_TIMEOUT_MS"),
      });

const tmuxSession = process.env.TMUX_SESSION ?? "agents";
// Stop is a write into an agent's runtime, so it is opt-in: off unless
// ENABLE_STOP is explicitly set. DASHBOARD_TOKEN now puts an app-layer lock in
// front of it, but that is not a substitute for the deployment's own access
// control: over plain HTTP the token travels in the clear.
const stopEnabled = /^(1|true|yes|on)$/i.test(process.env.ENABLE_STOP ?? "");
const stop = stopEnabled
  ? { session: tmuxSession, runner: defaultRunner }
  : undefined;

// A blank or whitespace-only token is treated as unset: it would otherwise
// configure a guard whose secret is "" — worse than no guard, because it looks
// like one. `auth` is left undefined so buildApp registers no hook at all.
const dashboardToken = process.env.DASHBOARD_TOKEN?.trim();
const auth =
  dashboardToken === undefined || dashboardToken === ""
    ? undefined
    : { token: dashboardToken };

const app = buildApp(db, { hub, logger: true, uiDir, chat, stop, auth });
if (auth === undefined) {
  if (stop !== undefined) {
    // The dangerous combination: an open write path into running agents.
    app.log.error(
      "SECURITY: no DASHBOARD_TOKEN and ENABLE_STOP is on — the dashboard is " +
        "unauthenticated AND anyone who can reach it can interrupt your " +
        "agents (POST /agents/:name/stop). Set DASHBOARD_TOKEN, or keep this " +
        "server off any reachable network.",
    );
  } else {
    app.log.warn(
      "no DASHBOARD_TOKEN; the dashboard is unauthenticated — every endpoint " +
        "is open to anyone who can reach this port. Set DASHBOARD_TOKEN to " +
        "require a login.",
    );
  }
} else {
  app.log.info(
    "DASHBOARD_TOKEN set; auth required (sessions are in memory, so a " +
      "restart logs everyone out).",
  );
}
if (stop === undefined) {
  app.log.info("ENABLE_STOP not set; Stop disabled (POST /agents/:name/stop -> 503).");
} else {
  app.log.warn(
    `Stop control ENABLED for tmux session "${tmuxSession}" — a write path; ` +
      "ensure this dashboard is behind access control.",
  );
}
if (chat === undefined) {
  app.log.info("WEB_LEAD_DIR not set; web chat disabled (POST /chat -> 503).");
} else {
  mkdirSync(webLeadDir as string, { recursive: true });
  app.log.info(`web-lead chat enabled, session dir ${webLeadDir}`);
}
if (uiDir === undefined) {
  app.log.warn(
    "No built frontend found; serving the API only. Run `npm run build` in " +
      "frontend/, or set UI_DIR, to serve the dashboard itself.",
  );
}

const { sources, error: sourcesError } = parseSources(
  process.env.TRANSCRIPT_SOURCES,
);
if (sourcesError !== null) {
  app.log.warn(`TRANSCRIPT_SOURCES ignored: ${sourcesError}`);
}

const runtime = createRuntime(db, {
  hub,
  session: tmuxSession,
  specsDir: process.env.SPECS_DIR ?? "specs",
  sources,
  // Left undefined when unset so runtime.ts owns the cadence in one place.
  intervalMs: {
    liveness: envNumberOpt("POLL_LIVENESS_MS"),
    pipeline: envNumberOpt("POLL_PIPELINE_MS"),
    transcript: envNumberOpt("POLL_TRANSCRIPT_MS"),
  },
});

runtime.start();

const port = envNumber("PORT", 8787);
const host = process.env.HOST ?? "0.0.0.0";

// Timers are unref'd, so the listener alone keeps the process alive; on a
// signal we tear the scheduler down explicitly rather than leaving a poll
// mid-flight against a closing database.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    runtime.stop();
    void app.close().finally(() => {
      db.close();
      process.exit(0);
    });
  });
}

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  runtime.stop();
  process.exit(1);
});
