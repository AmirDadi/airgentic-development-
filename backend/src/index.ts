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
 *   SPECS_DIR           Directory scanned for `<feature>.{spec,interfaces,plan}.md`.
 *                       Default "specs".
 *   TRANSCRIPT_SOURCES  JSON array of {agent, path, sessionId} transcripts to
 *                       tail. Default none — the board still shows agents and
 *                       features without it. Invalid JSON is ignored (logged).
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

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { buildApp } from "./app.js";
import { migrate } from "./db.js";
import { createSseHub } from "./sse.js";
import { createRuntime } from "./runtime.js";
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

const app = buildApp(db, { hub, logger: true, uiDir });
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
  session: process.env.TMUX_SESSION ?? "agents",
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
