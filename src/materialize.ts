/**
 * The sidecar fold, cached in SQLite.
 *
 * The events stay the source of truth. What is wrong without this is not where
 * they live — it is that every read re-reads every shard in a scope and re-folds
 * from zero, so `sharedDocs` pays for the whole history on each call. See
 * `PROPOSAL-sidecar-materialization.md`.
 *
 * The fold arrives as a PARAMETER rather than an import, and that is structural:
 * this module owns SQLite for the projection, and the folds live in the
 * `shared-*.ts` modules that also own reading and writing the log. Importing them
 * here would close the same storage/fold cycle `doc-version.ts` was split out to
 * prevent — and this repo's import cycles fail with no diagnostic at all.
 */

import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { db } from "./db.js";
import { readScope, SHARD_EXT, type LogEvent } from "./eventlog.js";

/**
 * Bumped whenever the FOLD or the PROJECTION changes shape.
 *
 * Not the schema numbers. `ANCHOR_SCHEME` and `HASH_SCHEME` are deliberately absent
 * from the key: the projection copies anchor ids and accepted hashes verbatim out
 * of events and joins to the anchors table at READ time, so a scheme bump changes
 * the join's answer and cannot change a stored row. Re-folding after one produces
 * byte-identical output, so invalidating on it buys a rebuild and nothing else.
 *
 * That holds only while nothing derived from the anchors table is stored. See the
 * guard comment on the tables in `db.ts`.
 */
export const MATERIALIZER_VERSION = 2;

/**
 * What the events in a scope are, cheaply.
 *
 * A change SIGNAL, not a content address: it does not identify the input set, it
 * detects that the input set moved. One `stat` per teammate's shard — microseconds
 * — and correct across processes, which matters because the sidecar has no
 * cross-process lock: the HTTP path takes none, MCP locks the universe rather than
 * the sidecar, and CLI sync takes none. A git-sha watermark would miss another
 * process's uncommitted append; file identity does not.
 *
 * Residual risk, accepted rather than mitigated: a union merge producing a
 * byte-identical size AND a same-nanosecond mtime reads as unchanged. Appends only
 * grow a file and move its mtime, so this needs a same-nanosecond rewrite to the
 * same length. Every build system takes this bet.
 */
export async function scopeFingerprint(logRoot: string, scope: string, identity: string): Promise<string> {
  const dir = join(logRoot, scope);
  const h = createHash("sha256");
  h.update(`v${MATERIALIZER_VERSION}\0${identity}\0${scope}\0`);
  let names: string[] = [];
  try { names = (await readdir(dir)).filter((n) => n.endsWith(SHARD_EXT)).sort(); } catch { /* no scope yet */ }
  for (const n of names) {
    // `bigint: true` for NANOSECOND mtime. Millisecond resolution collapses two
    // appends inside one tick into one fingerprint, which is exactly the window a
    // fold-then-refingerprint check exists to catch.
    const st = await stat(join(dir, n), { bigint: true }).catch(() => null);
    if (!st) continue;
    h.update(`${n}\0${st.size}\0${st.mtimeNs}\0`);
  }
  return h.digest("hex");
}

/** A projection's storage: how to write a folded value, and how to read it back. */
export interface Projection<T> {
  /** Replace every row for this scope. Runs INSIDE the transaction. */
  write(d: DatabaseSync, scope: string, value: T): void;
  /**
   * Rebuild the value from rows.
   *
   * THROW `CorruptProjection` rather than skipping a row you cannot read. The
   * fingerprint is over the sidecar's SHARDS, so nothing about a damaged row moves
   * it — a projection that quietly drops what it cannot parse serves an incomplete
   * answer on every subsequent hit, indefinitely, and looks like a cache hit while
   * doing it. `readCached` turns the throw into a miss and re-folds.
   *
   * Equal to what `fold` produced UP TO JSON: the projection stores JSON, so a
   * property whose value is `undefined` comes back absent rather than present-and-
   * undefined. Anything JSON cannot carry at all — a `Map`, a `Date`, insertion
   * order that a caller depends on — needs a column instead. See
   * `SharedDoc.authors` in `shared-projections.ts` for the one that bit.
   */
  read(d: DatabaseSync, scope: string): T;
}

/** A stored row that cannot be read back. Not fatal: it means re-fold. */
export class CorruptProjection extends Error {}

/**
 * Read a scope through the cache, re-folding on a miss.
 *
 * Fingerprint, fold, fingerprint AGAIN, and retry if it moved — that closes the
 * ordinary append-during-fold race without a lock. The rows and the fingerprint
 * commit in ONE transaction, so a reader never sees rows described by a stale key.
 *
 * Two processes re-folding one scope concurrently is benign rather than a race to
 * prevent: the fold is deterministic, so they compute identical rows and
 * last-writer-wins inside a transaction is correct. That is why this tolerates the
 * sidecar having no cross-process lock — a real gap this does not fix and does not
 * need to.
 */
export async function readCached<T>(
  root: string,
  logRoot: string,
  scope: string,
  identity: string,
  fold: (events: LogEvent[]) => T,
  proj: Projection<T>,
): Promise<T> {
  const d = db(root);
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await scopeFingerprint(logRoot, scope, identity);
    const row = d.prepare("SELECT fingerprint FROM shared_scope WHERE scope = ?").get(scope) as
      { fingerprint: string } | undefined;
    if (row?.fingerprint === before) {
      try {
        return proj.read(d, scope);
      } catch (e) {
        if (!(e instanceof CorruptProjection)) throw e;
        // Damaged rows. Drop the key so this pass re-folds and replaces them —
        // otherwise the damage is permanent, because only the shards move the
        // fingerprint and they have not.
        d.prepare("DELETE FROM shared_scope WHERE scope = ?").run(scope);
      }
    }

    const events = await readScope(logRoot, scope);
    const value = fold(events);
    const after = await scopeFingerprint(logRoot, scope, identity);
    // Moved under us. Do NOT store: the rows describe an input set that no longer
    // exists, and storing them under `after` would claim they describe the new one.
    if (after !== before) continue;

    d.exec("BEGIN");
    try {
      proj.write(d, scope, value);
      d.prepare("INSERT INTO shared_scope(scope,fingerprint,folded_at,events) VALUES(?,?,?,?) "
        + "ON CONFLICT(scope) DO UPDATE SET fingerprint=excluded.fingerprint, folded_at=excluded.folded_at, events=excluded.events")
        .run(scope, after, new Date().toISOString(), events.length);
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
    return value;
  }
  // Somebody is appending faster than we can fold. Answer from the log directly
  // rather than failing or caching something we know is already behind.
  return fold(await readScope(logRoot, scope));
}

/**
 * Bring a scope's rows up to date, and say only whether that worked.
 *
 * `readCached` hands back the folded value, which means deserializing every row in
 * the scope. That is the right shape for "give me the catalogue" and the wrong one
 * for "which rows mention this id", where the answer is an indexed lookup and the
 * deserialization is exactly the cost being avoided. On a hit this reads one row;
 * on a miss it pays the fold that was owed anyway and throws away a value it
 * already had in memory.
 *
 * `false` means the rows could NOT be brought up to date — someone is appending
 * faster than the fold converges, and `readCached` answers from the log without
 * storing. A caller that then queried the tables would get a complete-looking
 * answer computed from rows it has been told are behind, so it must fall back.
 */
export async function ensureMaterialized<T>(
  root: string,
  logRoot: string,
  scope: string,
  identity: string,
  fold: (events: LogEvent[]) => T,
  proj: Projection<T>,
): Promise<boolean> {
  const current = async () => {
    const before = await scopeFingerprint(logRoot, scope, identity);
    const row = db(root).prepare("SELECT fingerprint FROM shared_scope WHERE scope = ?").get(scope) as
      { fingerprint: string } | undefined;
    return row?.fingerprint === before;
  };
  if (await current()) return true;
  await readCached(root, logRoot, scope, identity, fold, proj);
  // Asked again rather than assumed: `readCached` gives up after three attempts and
  // answers from the log, and its return value cannot tell you which happened.
  return current();
}
