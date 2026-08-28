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
import { readScopeChecked, sortEvents, SHARD_EXT, type LogEvent, type ScopeStatus } from "./eventlog.js";

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
 *
 * 2 -> 3: the folds changed what they PRODUCE, not merely how it is stored.
 * Contest suppression keys on the writer rather than the principal, so a scope
 * with one person's two machines in it folds to a different contested set; and
 * corroboration keys on (principal, model), so a scope where somebody ran two
 * models folds to a different verdict list. Rows folded under 2 are answers to a
 * question this build no longer asks.
 *
 * 3 -> 4: the causal vector is derived from the `writerPrev` chain instead of fold
 * order, and `contest.ts` lost its `sameWriter` short-circuit. A scope holding a
 * forked writer now folds to a DIFFERENT contested set — the disagreement between
 * two branches is raised where it used to be silently suppressed — and `scopeStatus`
 * gained a `chain-cycle` verdict. See docs/fork-repair.md.
 *
 * 4 -> 5: `foldDocs` drops analyzer-generated versions and `process`/`step` docs. A
 * docs scope that already carried any of them folds to a smaller map now.
 *
 * 5 -> 6: the docs projection writes `node_versions` instead of the `shared_doc*`
 * family. The SHAPE changed, not just the content — a cache written under 5 points at
 * tables the new reader does not read, so without this the fingerprint matches, the
 * reader returns an empty map, and the canonical fold never happens until the sidecar
 * itself changes.
 *
 * 6 -> 7: `foldDocs` stopped refusing `process`/`step` versions, because edges travel
 * now and a flow is a node whose `step_of` set is ordered. A RULE change with no shape
 * change, and it needs the bump for the same reason: the fingerprint is over the
 * SHARDS, which do not move when the fold's mind changes, so every existing store would
 * keep serving rows that were folded under the old rule and a flow published before the
 * bump would never appear. Found by walking a real two-clone flow — the events arrived,
 * the fold was fixed, and the reader still answered from a cache hit.
 *
 * 7 -> 8: findings moved from `shared_finding` to the canonical `findings` table. The
 * same SHAPE change as 5 -> 6 and it needs the bump for the same reason — a cache
 * written under 7 points at a table the new reader does not read, so the fingerprint
 * matches, the reader returns an empty map, and every shared finding a store already
 * held vanishes until that scope's shards happen to move. On a real universe that is
 * 26 findings across three pull requests disappearing on upgrade.
 *
 * 8 -> 9: walkthroughs moved from `shared_walkthrough` to the canonical `walkthroughs`
 * table. The same SHAPE change as 7 -> 8, needing the bump for the same reason, and it
 * is also what makes the migration free on the shared half: those rows are a projection
 * of the log, so invalidating the scope re-folds them into the new table and no row has
 * to be copied across.
 *
 * 9 -> 10: the agent ratchet keys on CONFIRMATION rather than on filing state, so
 * `mayTransition` and the new `mayRevise` accept events both folds previously dropped —
 * an agent closing or sharpening a finding nobody has stood behind. A RULE change with
 * no shape change, needing the bump for the reason 6 -> 7 gives: the fingerprint is over
 * the SHARDS, which do not move when the fold's mind changes, so every existing store
 * would keep serving rows folded under the old rule and the events it used to ignore
 * would stay ignored for ever.
 *
 * 11 -> 12 adds `errorIndependent` to every corroboration — a SHAPE change, and the
 * bump is what makes it visible. The field is derived in the fold from actors the log
 * already carries, so nothing migrates and no event changes; but the projection is
 * CACHED on the shards plus this number, and the shards do not move when a fold starts
 * emitting a new field. Without the bump every store that had already folded a scope
 * would serve corroborations without it, for ever, while new stores had it.
 *
 * 12 -> 13 adds the `standard/<universe>` scope — specs, operations, requirements,
 * acknowledgements, audits and problems. A NEW scope needs no bump of its own (nothing
 * has folded it before), but the fold also began deriving requirements from ratified
 * specs, and every store that had already cached any scope would keep serving under the
 * old number. Bumped for the reason 6 -> 7 gives: the fingerprint is over the shards,
 * which do not move when the fold's mind changes.
 *
 * 13 -> 14 adds six projected tables to that same scope — criteria, vacuity checks,
 * pointers, populations, scrubs and the scrub policy — and `foldStandard` now derives
 * criteria from ratified `add_criterion` operations. Exactly the 12 -> 13 case: the scope
 * is not new, so every store that has already folded it keeps its cached rows, and the
 * shards do not move when the fold's mind changes. Without the bump such a store serves a
 * standard with none of the new records in it FOR EVER — and worse than at 12 -> 13,
 * because `served()` now reports that answer as authoritative.
 *
 * 14 -> 15 folds the scrub INTO the audit: `scrubs` stops being projected (a scrub is an
 * audit with a covering trigger, so it was the same row twice) and `audit.recorded` now
 * carries the trigger and the pointer observations. Same rule again — the scope is not new
 * and the shards do not move when the fold's mind changes.
 */
// 15 -> 16: the standard folds from TWO scopes (law + evidence). A store that folded the
// old single scope holds rows whose input set is now different, and only the shards move a
// fingerprint — so without this bump it would serve that standard for ever and `served()`
// would call it authoritative. See `materialize.ts` 12 -> 13 for the same rule stated first.
export const MATERIALIZER_VERSION = 16;

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
/**
 * One projection folded from SEVERAL scopes.
 *
 * The standard needs it: the law (requirements, specs, operations, criteria, gaps) is
 * workspace-scoped while the evidence (audits, pointers, populations, problems, debt) stays
 * per-universe, and `foldStandard` cannot be split to match — `spec.withdrawn` consults
 * evidence to decide whether a law act is permitted. So the two streams are folded together.
 *
 * Merging is safe because `sortEvents` is a deterministic topological sort that treats a
 * parent outside the input set as already satisfied: the union of two scopes yields the same
 * order on every clone, with no new ordering machinery.
 *
 * The rows are stored under ONE key (`key`), which is the universe's own standard scope —
 * a store belongs to exactly one universe, nothing downstream asks which scope a row arrived
 * on, and keeping the existing key means `source_scope` and every ownership guard built on it
 * are untouched. The FINGERPRINT covers every scope, so an append to either re-folds.
 *
 * The status is the WORST of them, which is the fail-closed reading §7 requires: a standard
 * whose evidence half cannot be read as settled is not settled, whatever the law half says.
 */
export async function readCachedMerged<T>(
  root: string,
  logRoot: string,
  scopes: string[],
  key: string,
  identity: string,
  fold: (events: LogEvent[], opts: { readable: Set<string> }) => T,
  proj: Projection<T>,
): Promise<Cached<T> & { fresh: boolean; folded: boolean }> {
  const d = db(root);
  const fingerprint = async () =>
    (await Promise.all(scopes.map((sc) => scopeFingerprint(logRoot, sc, identity)))).join("|");

  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await fingerprint();
    const row = d.prepare("SELECT fingerprint, status, diagnostic FROM shared_scope WHERE scope = ?").get(key) as
      { fingerprint: string; status: string; diagnostic: string | null } | undefined;
    if (row?.fingerprint === before) {
      try {
        // A cache hit did no work — `folded` and `fresh` are different questions, and a
        // caller that counts folds must not count this one.
        return { value: proj.read(d, key), fresh: true, folded: false, ...storedStatus(row) };
      } catch (e) {
        if (!(e instanceof CorruptProjection)) throw e;
        d.prepare("DELETE FROM shared_scope WHERE scope = ?").run(key);
      }
    }

    const reads = await Promise.all(scopes.map(async (sc) => ({ sc, ...await readScopeChecked(logRoot, sc) })));
    const events = sortEvents(reads.flatMap((r) => r.events));
    // Which halves may be treated as settled. The fold needs this, not just the caller:
    // deciding a withdrawal against evidence it could not read would answer WRONG rather
    // than incompletely — no reliance found, so the withdrawal proceeds.
    const readable = new Set(reads.filter((r) => r.status !== "blocked").map((r) => r.sc));
    const blocked = reads.find((r) => r.status === "blocked");
    const status: ScopeStatus = blocked
      ? { status: "blocked", ...(blocked.diagnostic ? { diagnostic: blocked.diagnostic } : {}) }
      : { status: "complete" };
    foldsRun++;
    const value = fold(events, { readable });
    const after = await fingerprint();
    if (after !== before) continue;

    d.exec("BEGIN");
    try {
      proj.write(d, key, value);
      d.prepare("INSERT INTO shared_scope(scope,fingerprint,folded_at,events,status,diagnostic) VALUES(?,?,?,?,?,?) "
        + "ON CONFLICT(scope) DO UPDATE SET fingerprint=excluded.fingerprint, folded_at=excluded.folded_at, "
        + "events=excluded.events, status=excluded.status, diagnostic=excluded.diagnostic")
        .run(key, after, new Date().toISOString(), events.length,
          status.status, status.diagnostic ? JSON.stringify(status.diagnostic) : null);
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
    return { value, fresh: true, folded: true, ...status };
  }
  // Given up after three attempts: somebody is appending faster than the fold. Answer from
  // the log rather than caching something already behind — and say the rows are not fresh,
  // because a caller that queried them anyway would get a complete-looking answer.
  const reads = await Promise.all(scopes.map(async (sc) => ({ sc, ...await readScopeChecked(logRoot, sc) })));
  const events = sortEvents(reads.flatMap((r) => r.events));
  const readable = new Set(reads.filter((r) => r.status !== "blocked").map((r) => r.sc));
  const blocked = reads.find((r) => r.status === "blocked");
  foldsRun++;
  return {
    value: fold(events, { readable }), fresh: false, folded: true,
    ...(blocked ? { status: "blocked" as const, ...(blocked.diagnostic ? { diagnostic: blocked.diagnostic } : {}) } : { status: "complete" as const }),
  };
}

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
let foldsRun = 0;

/**
 * How many times the log has been folded in this process.
 *
 * The instrument for one of the architecture's load-bearing claims: after a sync,
 * an ordinary read is answered from rows and never folds. That is not observable
 * from a return value — a fold and a cache hit produce the same answer, just at
 * different cost — so without a counter the claim can only be argued. A test reads
 * this either side of a query and asserts it did not move.
 */
export const foldCount = (): number => foldsRun;

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
 * A folded scope and whether it may be answered from.
 *
 * The status rides WITH the value rather than beside it, so a caller cannot take
 * the rows and forget to ask. §7 is a fail-closed rule and the one way it fails in
 * practice is a surface that never looked.
 */
export interface Cached<T> extends ScopeStatus { value: T }

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
): Promise<Cached<T>> {
  const d = db(root);
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await scopeFingerprint(logRoot, scope, identity);
    const row = d.prepare("SELECT fingerprint, status, diagnostic FROM shared_scope WHERE scope = ?").get(scope) as
      { fingerprint: string; status: string; diagnostic: string | null } | undefined;
    if (row?.fingerprint === before) {
      try {
        return { value: proj.read(d, scope), ...storedStatus(row) };
      } catch (e) {
        if (!(e instanceof CorruptProjection)) throw e;
        // Damaged rows. Drop the key so this pass re-folds and replaces them —
        // otherwise the damage is permanent, because only the shards move the
        // fingerprint and they have not.
        d.prepare("DELETE FROM shared_scope WHERE scope = ?").run(scope);
      }
    }

    const { events, ...status } = await readScopeChecked(logRoot, scope);
    foldsRun++;
    const value = fold(events);
    const after = await scopeFingerprint(logRoot, scope, identity);
    // Moved under us. Do NOT store: the rows describe an input set that no longer
    // exists, and storing them under `after` would claim they describe the new one.
    if (after !== before) continue;

    d.exec("BEGIN");
    try {
      proj.write(d, scope, value);
      d.prepare("INSERT INTO shared_scope(scope,fingerprint,folded_at,events,status,diagnostic) VALUES(?,?,?,?,?,?) "
        + "ON CONFLICT(scope) DO UPDATE SET fingerprint=excluded.fingerprint, folded_at=excluded.folded_at, "
        + "events=excluded.events, status=excluded.status, diagnostic=excluded.diagnostic")
        .run(scope, after, new Date().toISOString(), events.length,
          status.status, status.diagnostic ? JSON.stringify(status.diagnostic) : null);
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
    return { value, ...status };
  }
  // Somebody is appending faster than we can fold. Answer from the log directly
  // rather than failing or caching something we know is already behind.
  const { events, ...status } = await readScopeChecked(logRoot, scope);
  foldsRun++;
  return { value: fold(events), ...status };
}

/**
 * The stored verdict, read back.
 *
 * A row whose `diagnostic` will not parse is treated as blocked WITHOUT one rather
 * than as complete: the column is only ever written when the status is blocked, so
 * the damage is to the explanation, not to the judgement.
 */
function storedStatus(row: { status: string; diagnostic: string | null }): ScopeStatus {
  // Only the exact string is complete. A value this build does not recognise is a
  // row some other version wrote, and §7 is a fail-CLOSED rule: reading an unknown
  // verdict as "fine" is the one interpretation the rule forbids.
  if (row.status === "complete") return { status: "complete" };
  try {
    return row.diagnostic ? { status: "blocked", diagnostic: JSON.parse(row.diagnostic) } : { status: "blocked" };
  } catch { return { status: "blocked" }; }
}

/**
 * `readCached` without the read — for a caller that is going to QUERY the rows, so
 * deserializing the scope to hand it a value is the cost being avoided.
 *
 * `false` means the rows are behind: `readCached` gives up after three attempts and
 * answers from the log without storing. A caller that queried anyway would get a
 * complete-looking answer from an input set it has been told is stale.
 */
export async function ensureMaterialized<T>(
  root: string,
  logRoot: string,
  scope: string,
  identity: string,
  fold: (events: LogEvent[]) => T,
  proj: Projection<T>,
): Promise<{ fresh: boolean; folded: boolean } & ScopeStatus> {
  /** The stored verdict, or null if the row does not describe the shards on disk. */
  const current = async (): Promise<ScopeStatus | null> => {
    const before = await scopeFingerprint(logRoot, scope, identity);
    const row = db(root).prepare("SELECT fingerprint, status, diagnostic FROM shared_scope WHERE scope = ?").get(scope) as
      { fingerprint: string; status: string; diagnostic: string | null } | undefined;
    return row?.fingerprint === before ? storedStatus(row) : null;
  };
  const hit = await current();
  // `folded` and `fresh` are different questions and were conflated by a caller once:
  // `fresh` is "the rows are up to date", which is true both on a cache hit and right
  // after a fold. Only this branch did no work.
  if (hit) return { fresh: true, folded: false, ...hit };
  // The status comes back even when the rows do not: `readCached` folds the log
  // directly on its give-up path, and that fold saw the scope. Returning
  // `fresh: false` with no verdict would make a blocked scope indistinguishable
  // from a healthy one exactly when the caller is about to query rows anyway.
  const { value: _rows, ...status } = await readCached(root, logRoot, scope, identity, fold, proj);
  // Asked again rather than assumed: `readCached` gives up after three attempts and
  // answers from the log, and its return value cannot tell you which happened.
  const after = await current();
  return after ? { fresh: true, folded: true, ...after } : { fresh: false, folded: true, ...status };
}
