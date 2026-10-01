/**
 * The queue of staged shared writes: one per sidecar CLONE, so one per machine
 * (docs/PROPOSAL-online-only-sync.md, D3). Every session on the machine — each MCP
 * process, each web tab, each CLI call — stages here, and a sync consumes only its own.
 *
 * **Append and drop only.** The owner: "Anything more complicated than that is bringing back
 * all the conflict resolution logic in miniature." Nothing exported edits an op's payload or
 * moves it; an op leaves the queue by landing, or by being dropped by its session. The state
 * transitions are the sync engine's, and they change `state` alone.
 *
 * In the sidecar's GIT DIRECTORY, beside `codemap-writer`, because it must never be committed:
 * the sync is `git add -A`. A sidecar with no git directory has no transport either, and its
 * queue lives for the process only, the way `writerFor` treats it.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { StagedEvent } from "./eventlog.js";

/**
 * `staged`: waiting for its session's sync. `inflight`: a sync attempt holds it — replayed and
 * possibly pushed; a crash here is resolved by looking for its id on the remote, never by
 * pushing it again. `landed`: on the remote. `conflict`: its session was gone when it was
 * attempted and it was refused; shown on the next open until someone dismisses it.
 */
/**
 * `inflight`: a sync holds it. `unknown`: its push failed and the remote could not be reached to
 * see whether it landed (review C7) — replayed or settled by the next sync, droppable, and a drop
 * says it may already have landed.
 */
export type QueueState = "staged" | "inflight" | "unknown" | "landed" | "conflict";

/** What a session reads on top of the log (plan C7: an unconfirmed push is "shown on the overlay"). */
export const onOverlay = (s: QueueState): boolean => s === "staged" || s === "unknown";

export interface QueuedOp {
  /** Queue position. Replay order within a session, and never rewritten. */
  pos: number;
  session: string;
  scope: string;
  event: StagedEvent;
  state: QueueState;
  /** Why it was refused, for a `conflict`. */
  why?: string;
  stagedAt: string;
}

export interface SessionRow {
  session: string;
  kind: SessionKind;
  pid: number;
  /** Last call or poll, ISO. */
  seen: string;
  /** A transaction is open: acts stage instead of syncing. */
  tx: boolean;
}

export type SessionKind = "mcp" | "web" | "cli";

const handles = new Map<string, { d: DatabaseSync; file: boolean }>();

function gitDirOf(root: string): string | null {
  const dot = join(root, ".git");
  try {
    if (statSync(dot).isDirectory()) return dot;
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"));
    return m ? resolve(root, m[1]!.trim()) : null;
  } catch { return null; }
}

function open(logRoot: string): DatabaseSync {
  const hit = handles.get(logRoot);
  if (hit?.file) return hit.d;
  const dir = gitDirOf(logRoot);
  if (hit && !dir) return hit.d;
  const d = new DatabaseSync(dir ? join(dir, "codemap-queue.db") : ":memory:");
  d.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  d.exec(`
    CREATE TABLE IF NOT EXISTS queue(
      pos INTEGER PRIMARY KEY AUTOINCREMENT,
      session TEXT NOT NULL,
      scope TEXT NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      event TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('staged','inflight','unknown','landed','conflict')),
      why TEXT,
      staged_at TEXT NOT NULL,
      landed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS queue_session ON queue(session, state);
    CREATE TABLE IF NOT EXISTS sessions(
      session TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      pid INTEGER NOT NULL,
      seen TEXT NOT NULL,
      tx INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  // A queue from before `unknown` (review C7): SQLite cannot widen a CHECK, so rebuild the table.
  const sql = (d.prepare("SELECT sql FROM sqlite_master WHERE name = 'queue'").get() as { sql: string } | undefined)?.sql ?? "";
  if (!sql.includes("'unknown'")) {
    d.exec(`BEGIN IMMEDIATE;
      ALTER TABLE queue RENAME TO queue_old;
      CREATE TABLE queue(pos INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, scope TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE, event TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('staged','inflight','unknown','landed','conflict')),
        why TEXT, staged_at TEXT NOT NULL, landed_at TEXT);
      INSERT INTO queue SELECT * FROM queue_old;
      DROP TABLE queue_old;
      CREATE INDEX IF NOT EXISTS queue_session ON queue(session, state);
      COMMIT;`);
  }
  // Opened in memory before the sidecar became a repository: carry what it holds over.
  if (hit) {
    for (const table of ["queue", "sessions", "meta"]) {
      for (const row of hit.d.prepare(`SELECT * FROM ${table}`).all() as Record<string, string | number | null>[]) {
        const cols = Object.keys(row);
        d.prepare(`INSERT OR IGNORE INTO ${table}(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`).run(...cols.map((c) => row[c]!));
      }
    }
    hit.d.close();
  }
  handles.set(logRoot, { d, file: !!dir });
  return d;
}

/** Close every handle. Test-only: a disposed temp sidecar must not keep its file open. */
export function closeQueues(): void {
  for (const { d } of handles.values()) { try { d.close(); } catch { /* already */ } }
  handles.clear();
}

type Row = { pos: number; session: string; scope: string; event: string; state: QueueState; why: string | null; staged_at: string };
const toOp = (r: Row): QueuedOp => ({
  pos: r.pos, session: r.session, scope: r.scope, event: JSON.parse(r.event) as StagedEvent,
  state: r.state, ...(r.why ? { why: r.why } : {}), stagedAt: r.staged_at,
});

/** Append one op to the end of its session's queue. */
export function stage(logRoot: string, session: string, scope: string, event: StagedEvent): QueuedOp {
  const d = open(logRoot);
  const at = new Date().toISOString();
  const r = d.prepare("INSERT INTO queue(session, scope, event_id, event, state, staged_at) VALUES(?,?,?,?, 'staged', ?)")
    .run(session, scope, event.id, JSON.stringify(event), at);
  return { pos: Number(r.lastInsertRowid), session, scope, event, state: "staged", stagedAt: at };
}

/** A session's ops still to land — `staged`, `inflight` and `unknown` — in queue order. */
export function pending(logRoot: string, session: string): QueuedOp[] {
  return (open(logRoot).prepare("SELECT * FROM queue WHERE session = ? AND state IN ('staged','inflight','unknown') ORDER BY pos")
    .all(session) as Row[]).map(toOp);
}

/** Every session holding ops still to land. */
export function sessionsWithPending(logRoot: string): string[] {
  return (open(logRoot).prepare("SELECT DISTINCT session FROM queue WHERE state IN ('staged','inflight','unknown') ORDER BY session")
    .all() as { session: string }[]).map((r) => r.session);
}

/** Ops refused after their session was gone, on this machine — one session's, or all. */
export function conflicts(logRoot: string, session?: string): QueuedOp[] {
  const d = open(logRoot);
  return (session === undefined
    ? d.prepare("SELECT * FROM queue WHERE state = 'conflict' ORDER BY pos").all()
    : d.prepare("SELECT * FROM queue WHERE state = 'conflict' AND session = ? ORDER BY pos").all(session) as Row[]).map((r) => toOp(r as Row));
}

/** Every session holding a conflict, on this machine. */
export function sessionsWithConflicts(logRoot: string): string[] {
  return (open(logRoot).prepare("SELECT DISTINCT session FROM queue WHERE state = 'conflict' ORDER BY session")
    .all() as { session: string }[]).map((r) => r.session);
}

/**
 * Hand a gone session's unfinished items to the session that adopts them (review C10; owner:
 * "Allow the owner change"). The one change besides `state` the queue allows: content and
 * position never move. A batch's session is gone the moment `syncBatch` returns; its adopter is
 * the session that called it (owner, round 2 C2.1: "Hand over at failure").
 */
export function reassign(logRoot: string, from: string, to: string): number {
  return Number(open(logRoot).prepare("UPDATE queue SET session = ? WHERE session = ? AND state IN ('staged','unknown','conflict')")
    .run(to, from).changes);
}

/**
 * Drop a session's op, by event id: `staged`, a `conflict` being dismissed, or an `unknown` one
 * (C7) — which may already have landed, and says so. An `inflight` op belongs to a sync in
 * progress, and a `landed` one is history. Answers what was dropped, or false.
 */
export function drop(logRoot: string, session: string | null, eventId: string): false | { mayHaveLanded: boolean } {
  const d = open(logRoot);
  const row = (session === null
    ? d.prepare("SELECT state FROM queue WHERE event_id = ? AND state = 'conflict'").get(eventId)
    : d.prepare("SELECT state FROM queue WHERE event_id = ? AND session = ? AND state IN ('staged','conflict','unknown')").get(eventId, session)) as
    { state: QueueState } | undefined;
  if (!row) return false;
  d.prepare("DELETE FROM queue WHERE event_id = ? AND state = ?").run(eventId, row.state);
  return { mayHaveLanded: row.state === "unknown" };
}

// ---- The sync engine's transitions. `state` alone; nothing else about an op moves. ----

const inTx = (d: DatabaseSync, fn: () => void): void => {
  d.exec("BEGIN IMMEDIATE");
  try { fn(); d.exec("COMMIT"); } catch (e) { d.exec("ROLLBACK"); throw e; }
};

function transition(logRoot: string, ids: string[], from: QueueState[], to: QueueState, why?: string): void {
  if (!ids.length) return;
  const d = open(logRoot);
  const st = d.prepare(`UPDATE queue SET state = ?, why = ?, landed_at = ? WHERE event_id = ? AND state IN (${from.map(() => "?").join(",")})`);
  const at = to === "landed" ? new Date().toISOString() : null;
  inTx(d, () => { for (const id of ids) st.run(to, why ?? null, at, id, ...from); });
}

export const markInflight = (l: string, ids: string[]): void => transition(l, ids, ["staged", "inflight", "unknown"], "inflight");
export const markLanded = (l: string, ids: string[]): void => transition(l, ids, ["staged", "inflight", "unknown"], "landed");
export const markStaged = (l: string, ids: string[]): void => transition(l, ids, ["inflight", "unknown"], "staged");
export const markUnknown = (l: string, ids: string[]): void => transition(l, ids, ["inflight"], "unknown");
/** Only the refused ops become conflicts (review C10): the valid ones stay staged for whoever adopts them. */
export function markConflict(logRoot: string, refusals: { id: string; why: string }[]): void {
  const d = open(logRoot);
  const st = d.prepare("UPDATE queue SET state = 'conflict', why = ? WHERE event_id = ? AND state IN ('staged','inflight','unknown')");
  inTx(d, () => { for (const r of refusals) st.run(r.why, r.id); });
}

/** Why a staged op was last refused, kept with it so the session can read what to redo (O10). */
export function noteRefusal(logRoot: string, refusals: { id: string; why: string }[]): void {
  const d = open(logRoot);
  const st = d.prepare("UPDATE queue SET why = ? WHERE event_id = ? AND state = 'staged'");
  inTx(d, () => { for (const r of refusals) st.run(r.why, r.id); });
}

/** Landed rows older than this are pruned; they exist only so a crash can be reasoned about. */
const LANDED_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;
export function pruneLanded(logRoot: string, now = Date.now()): void {
  open(logRoot).prepare("DELETE FROM queue WHERE state = 'landed' AND landed_at < ?")
    .run(new Date(now - LANDED_RETENTION_MS).toISOString());
}

// ---- Sessions ----

export function touchSession(logRoot: string, session: string, kind: SessionKind, pid = process.pid): void {
  open(logRoot).prepare("INSERT INTO sessions(session, kind, pid, seen) VALUES(?,?,?,?) "
    + "ON CONFLICT(session) DO UPDATE SET seen = excluded.seen, pid = excluded.pid")
    .run(session, kind, pid, new Date().toISOString());
}

export function sessionRow(logRoot: string, session: string): SessionRow | null {
  const r = open(logRoot).prepare("SELECT * FROM sessions WHERE session = ?").get(session) as
    { session: string; kind: SessionKind; pid: number; seen: string; tx: number } | undefined;
  return r ? { session: r.session, kind: r.kind, pid: r.pid, seen: r.seen, tx: !!r.tx } : null;
}

export function setTx(logRoot: string, session: string, kind: SessionKind, open_: boolean): void {
  touchSession(logRoot, session, kind);
  open(logRoot).prepare("UPDATE sessions SET tx = ? WHERE session = ?").run(open_ ? 1 : 0, session);
}

export function forgetSession(logRoot: string, session: string): void {
  open(logRoot).prepare("DELETE FROM sessions WHERE session = ?").run(session);
}

// ---- Engine bookkeeping ----

export function getMeta(logRoot: string, key: string): string | null {
  return (open(logRoot).prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
}
export function setMeta(logRoot: string, key: string, value: string | null): void {
  const d = open(logRoot);
  if (value === null) d.prepare("DELETE FROM meta WHERE key = ?").run(key);
  else d.prepare("INSERT INTO meta(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

/** Every event id the queue holds, in any state: what a sync may find locally and not destroy. */
export function allQueuedIds(logRoot: string): string[] {
  return (open(logRoot).prepare("SELECT event_id FROM queue").all() as { event_id: string }[]).map((r) => r.event_id);
}
