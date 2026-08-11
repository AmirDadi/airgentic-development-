import type Database from "better-sqlite3";
import type { Agent, Event, Feature, Message, Stage } from "./types.js";

/**
 * Creates the schema. Safe to run on every boot — every statement is
 * IF NOT EXISTS, so this doubles as the (currently trivial) migration path.
 */
export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      name             TEXT PRIMARY KEY,
      kind             TEXT NOT NULL,
      workdir          TEXT NOT NULL,
      alive            INTEGER NOT NULL,
      last_seen        INTEGER,
      current_activity TEXT
    );

    CREATE TABLE IF NOT EXISTS features (
      name       TEXT PRIMARY KEY,
      owner      TEXT,
      stage      TEXT NOT NULL,
      branch     TEXT,
      pr_url     TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id         TEXT PRIMARY KEY,
      ts         INTEGER NOT NULL,
      from_agent TEXT NOT NULL,
      to_agent   TEXT NOT NULL,
      channel    TEXT NOT NULL,
      body       TEXT NOT NULL,
      session_id TEXT
    );
    CREATE INDEX IF NOT EXISTS messages_ts ON messages (ts);
    CREATE INDEX IF NOT EXISTS messages_pair ON messages (from_agent, to_agent);

    CREATE TABLE IF NOT EXISTS events (
      id      TEXT PRIMARY KEY,
      ts      INTEGER NOT NULL,
      agent   TEXT,
      type    TEXT NOT NULL,
      payload TEXT
    );
    CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
  `);
}

export function upsertAgent(db: Database.Database, a: Agent): void {
  db.prepare(
    `INSERT INTO agents (name, kind, workdir, alive, last_seen, current_activity)
     VALUES (@name, @kind, @workdir, @alive, @last_seen, @current_activity)
     ON CONFLICT(name) DO UPDATE SET
       kind = excluded.kind,
       workdir = excluded.workdir,
       alive = excluded.alive,
       last_seen = excluded.last_seen,
       current_activity = excluded.current_activity`,
  ).run({ ...a, alive: a.alive ? 1 : 0 });
}

interface AgentRow extends Omit<Agent, "alive"> {
  alive: number;
}

export function listAgents(db: Database.Database): Agent[] {
  const rows = db
    .prepare(`SELECT * FROM agents ORDER BY name`)
    .all() as AgentRow[];
  // SQLite stores booleans as 0/1; callers should never see that.
  return rows.map((r) => ({ ...r, alive: Boolean(r.alive) }));
}

export function upsertFeature(db: Database.Database, f: Feature): void {
  db.prepare(
    `INSERT INTO features (name, owner, stage, branch, pr_url, updated_at)
     VALUES (@name, @owner, @stage, @branch, @pr_url, @updated_at)
     ON CONFLICT(name) DO UPDATE SET
       owner = excluded.owner,
       stage = excluded.stage,
       branch = excluded.branch,
       pr_url = excluded.pr_url,
       updated_at = excluded.updated_at`,
  ).run(f);
}

export function listFeatures(db: Database.Database): Feature[] {
  return db.prepare(`SELECT * FROM features ORDER BY name`).all() as Feature[];
}

export function insertMessage(db: Database.Database, m: Message): void {
  // Re-reading a transcript replays messages we already have; ignore dupes.
  db.prepare(
    `INSERT INTO messages (id, ts, from_agent, to_agent, channel, body, session_id)
     VALUES (@id, @ts, @from_agent, @to_agent, @channel, @body, @session_id)
     ON CONFLICT(id) DO NOTHING`,
  ).run(m);
}

export interface MessageQuery {
  /** Together with `b`, restricts to the conversation between a pair. */
  a?: string;
  b?: string;
  /** Keeps the newest N, still returned oldest-first. */
  limit?: number;
}

export function listMessages(
  db: Database.Database,
  q: MessageQuery,
): Message[] {
  const params: Record<string, unknown> = {};
  let where = "";
  if (q.a && q.b) {
    // Either direction between the pair.
    where = `WHERE (from_agent = @a AND to_agent = @b)
                OR (from_agent = @b AND to_agent = @a)`;
    params.a = q.a;
    params.b = q.b;
  } else if (q.a || q.b) {
    // One agent named: everything they sent or received. Previously this fell
    // through to no filter at all, silently returning the whole table.
    const only = q.a ?? q.b;
    where = `WHERE from_agent = @only OR to_agent = @only`;
    params.only = only;
  }

  if (q.limit === undefined) {
    return db
      .prepare(`SELECT * FROM messages ${where} ORDER BY ts ASC, id ASC`)
      .all(params) as Message[];
  }

  // Take the newest N, then flip back to oldest-first for display.
  const newest = db
    .prepare(
      `SELECT * FROM messages ${where} ORDER BY ts DESC, id DESC LIMIT @limit`,
    )
    .all({ ...params, limit: q.limit }) as Message[];
  return newest.reverse();
}

export function insertEvent(db: Database.Database, e: Event): void {
  db.prepare(
    `INSERT INTO events (id, ts, agent, type, payload)
     VALUES (@id, @ts, @agent, @type, @payload)
     ON CONFLICT(id) DO NOTHING`,
  ).run({ ...e, payload: JSON.stringify(e.payload ?? null) });
}

export interface EventQuery {
  /** Exclusive lower bound on ts, for the `?since=` feed. */
  since?: number;
  limit?: number;
}

interface EventRow extends Omit<Event, "payload"> {
  payload: string | null;
}

export function listEvents(db: Database.Database, q: EventQuery): Event[] {
  const rows = db
    .prepare(
      `SELECT * FROM events
       ${q.since === undefined ? "" : "WHERE ts > @since"}
       ORDER BY ts DESC, id DESC
       ${q.limit === undefined ? "" : "LIMIT @limit"}`,
    )
    .all({ since: q.since, limit: q.limit }) as EventRow[];

  return rows.map((r) => ({
    ...r,
    // A payload that somehow isn't valid JSON must not break the feed.
    payload: r.payload === null ? null : safeParse(r.payload),
  }));
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Re-exported so callers get the stage vocabulary from one place. */
export type { Stage };
