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
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { db } from "./db.js";
import { SIDECAR_LINEAGE, type SidecarMark } from "./store.js";
import { isSameSidecar, peersAhead } from "./sidecar.js";
import { withPeersAhead } from "./validation.js";
import { isLegacyShard, overlayActive, readScopeChecked, sortEvents, SHARD_EXT, type LogEvent, type ScopeDiagnostic, type ScopeStatus } from "./eventlog.js";
import { isLogDamage } from "./log-damage.js";
import { assertNotLockedOut, LockedOut, locate, recordLockout } from "./lockout.js";

/**
 * A fold that meets damage LOCKS this sidecar and says so, rather than carrying on (plan 1.2).
 * Every read of shared state comes through here, so a damaged entry found by any read stops
 * every other read and op too — including ones that never fold the scope it is in.
 */
function locking<A extends unknown[], T>(logRoot: string, scopes: string[], fold: (...args: A) => T): (...args: A) => T {
  return (...args) => {
    try { return fold(...args); } catch (e) {
      if (!isLogDamage(e)) throw e;
      throw new LockedOut(recordLockout(logRoot, locate(logRoot, scopes, e.entry)));
    }
  };
}

export { MATERIALIZER_VERSION } from "./materializer-version.js";
import { MATERIALIZER_VERSION } from "./materializer-version.js";

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
 * Merging is safe because `sortEvents` orders by `seq`, the sidecar-wide position the remote
 * accepted each event at: the union of two scopes yields the same order on every clone.
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
  assertNotLockedOut([logRoot]);
  fold = locking(logRoot, scopes, fold);
  const d = db(root);
  let checked: ScopeDiagnostic | null | undefined;
  const unusable = () => (checked !== undefined ? checked : (checked = logRootMissing(logRoot) ?? unmigrated(logRoot) ?? wrongSidecar(root, logRoot)));
  const decline = (gone: ScopeDiagnostic) => {
    try { return { value: proj.read(d, key), fresh: false, folded: false, status: "blocked" as const, diagnostic: gone }; }
    catch { return { value: fold([], { readable: new Set() }), fresh: false, folded: false, status: "blocked" as const, diagnostic: gone }; }
  };
  const fingerprint = async () =>
    (await Promise.all(scopes.map((sc) => scopeFingerprint(logRoot, sc, identity)))).join("|");

  // A session with staged acts reads them on top of the log; that is not the log, so it is
  // folded fresh and never stored.
  const staged = scopes.some((sc) => overlayActive(logRoot, sc));
  for (let attempt = 0; attempt < (staged ? 0 : 3); attempt++) {
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

    const gone = unusable();
    if (gone) return decline(gone);

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
    const value = withPeersAhead(await peersAhead(logRoot), () => fold(events, { readable }));
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
  const lastCheck = unusable();
  if (lastCheck) return decline(lastCheck);
  const reads = await Promise.all(scopes.map(async (sc) => ({ sc, ...await readScopeChecked(logRoot, sc) })));
  const events = sortEvents(reads.flatMap((r) => r.events));
  const readable = new Set(reads.filter((r) => r.status !== "blocked").map((r) => r.sc));
  const blocked = reads.find((r) => r.status === "blocked");
  foldsRun++;
  const value = withPeersAhead(await peersAhead(logRoot), () => fold(events, { readable }));
  const status: ScopeStatus = blocked
    ? { status: "blocked", ...(blocked.diagnostic ? { diagnostic: blocked.diagnostic } : {}) } : { status: "complete" };
  if (staged) writeStaged(d, key, value, proj, events.length, status);
  return { value, fresh: staged, folded: true, ...status };
}

/**
 * Rows folded with the calling session's staged acts: written, so a read that QUERIES the
 * projection sees them too, under a fingerprint no shard set can produce — the next read
 * without them misses and re-folds from the log alone.
 */
function writeStaged<T>(d: ReturnType<typeof db>, key: string, value: T, proj: Projection<T>, events: number, status: ScopeStatus): void {
  d.exec("BEGIN");
  try {
    proj.write(d, key, value);
    d.prepare("INSERT INTO shared_scope(scope,fingerprint,folded_at,events,status,diagnostic) VALUES(?,?,?,?,?,?) "
      + "ON CONFLICT(scope) DO UPDATE SET fingerprint=excluded.fingerprint, folded_at=excluded.folded_at, "
      + "events=excluded.events, status=excluded.status, diagnostic=excluded.diagnostic")
      .run(key, `staged:${Math.random()}`, new Date().toISOString(), events,
        status.status, status.diagnostic ? JSON.stringify(status.diagnostic) : null);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
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
 * Is this the sidecar this store has been folding from?
 *
 * The other half of `logRootMissing`, and it destroys in exactly the same way. A fold is
 * TOTAL, so folding a different sidecar's (empty) copy of `bugs/acme/api` over the rows
 * this store folded from the old one replaces them with nothing — the repoint wipes the
 * table on the next read, without the path ever being absent.
 *
 * `isSameSidecar` is ancestry, so a sidecar that moved, was re-cloned, or has since merged
 * the team's unrelated history all pass. Only a genuinely different repository fails, and
 * `checkSidecarBinding` refuses the transport and every write for the same reason, with a
 * sentence about what to do; this half just declines to fold.
 *
 * Nothing recorded means nothing to disagree with — every store predating this is in that
 * state, and refusing them all on upgrade would be the migration equivalent of the bug.
 *
 * **A known residual, accepted rather than closed.** This is asked only when the caller is
 * about to fold, so a cache HIT answers `complete` without consulting the sidecar at all.
 * The scope fingerprint contains the sidecar's realpath, so a repoint always misses and is
 * always checked — the escape is replacing the history at the SAME path with an identical
 * tree (`git commit-tree`), which keeps the fingerprint. The rows served then are still
 * this store's own, so nothing is wrong with the ANSWER; only the status is optimistic,
 * and `sharedStatus`, every write and the transport all refuse in that state, so any
 * action finds out immediately. Closing it means a `git merge-base` on every read of every
 * scope, which is the work the materializer exists to avoid.
 */
function wrongSidecar(root: string, logRoot: string): ScopeDiagnostic | null {
  let mark: SidecarMark | undefined;
  try {
    const row = db(root).prepare("SELECT v FROM meta WHERE k = ?").get(SIDECAR_LINEAGE) as { v: string } | undefined;
    mark = row ? JSON.parse(row.v) as SidecarMark : undefined;
  } catch { return null; }
  if (!mark?.lineage || isSameSidecar(logRoot, mark.lineage)) return null;
  return {
    reason: "sidecar-mismatch",
    detail: `${logRoot} is a different sidecar from the one this store folded its rows from `
      + `(${mark.lineage.slice(0, 12)}, last seen at ${mark.path}). Nothing was folded and nothing was `
      + `discarded — folding this one over those rows would replace them with its own, which is empty `
      + `of them. Fix the path, or run \`codemap sidecar adopt\` if the move is deliberate.`,
    evidence: [logRoot, mark.lineage],
  };
}

/**
 * Is the configured sidecar actually there?
 *
 * **An absent log root is NOT an empty log, and folding it as one destroys rows.** The
 * fold is total — it computes the whole projection from the whole scope — so folding
 * zero events over a scope that has rows writes the empty result and every surface then
 * agrees the team has nothing. Reproduced: point `.codemap/sidecar` at a path that is
 * not there (a typo, an unmounted drive, a sidecar this machine has not cloned yet), read
 * once, and the bugs are gone from the table. It is recoverable — the log is authoritative
 * and restoring the path restores them — but it is silently wrong meanwhile, which is the
 * same failure a corrupt shard used to produce one layer down.
 *
 * The directory EXISTING is the whole test, deliberately. A `.git` check would also be
 * true of a broken sidecar, but it is false of a legitimate one that has been configured
 * and not yet initialised — a state the write path creates on purpose — so it would refuse
 * reads that are fine today.
 */
/**
 * A sidecar from before the linear log (plan 7.2b): this build cannot order its per-writer
 * shards, so it folds nothing and serves what the store already holds, non-authoritatively,
 * until the sidecar is migrated. A directory walk, so remembered briefly per process.
 */
const unmigratedSeen = new Map<string, { at: number; shard: string | null }>();
function unmigrated(logRoot: string): ScopeDiagnostic | null {
  const hit = unmigratedSeen.get(logRoot);
  let shard = hit && Date.now() - hit.at < 10_000 ? hit.shard : undefined;
  if (shard === undefined) {
    shard = null;
    const walk = (rel: string): void => {
      let entries: Dirent[] = [];
      try { entries = readdirSync(join(logRoot, rel), { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (shard) return;
        const path = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (e.name !== ".git") walk(path); }
        else if (isLegacyShard(path)) shard = path;
      }
    };
    walk("");
    unmigratedSeen.set(logRoot, { at: Date.now(), shard });
  }
  return shard ? {
    reason: "unmigrated",
    detail: `this sidecar holds per-writer shards from before the linear log (first: ${shard}), which this build cannot `
      + `order. Nothing was folded; the rows this store already holds are served as non-authoritative until the sidecar `
      + `is migrated (docs/sidecar-migration.md).`,
    evidence: [shard],
  } : null;
}

function logRootMissing(logRoot: string): ScopeDiagnostic | null {
  if (existsSync(logRoot)) return null;
  return {
    reason: "sidecar-missing",
    detail: `the configured sidecar is not at ${logRoot} — a typo in .codemap/sidecar, a drive `
      + `that is not mounted, or a sidecar this machine has not cloned yet. Nothing was folded `
      + `and nothing was discarded: the rows this store already holds are still here and are `
      + `served as non-authoritative until the path resolves again.`,
    evidence: [logRoot],
  };
}


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
  assertNotLockedOut([logRoot]);
  fold = locking(logRoot, [scope], fold);
  const d = db(root);
  // Checked lazily, and only on the path that is about to FOLD. A cache hit serves rows
  // and touches no sidecar, so asking there cost a `git merge-base` on every read of
  // every scope — which is precisely the work the materializer exists to avoid. Memoised
  // per call because the retry loop below can come round again.
  let checked: ScopeDiagnostic | null | undefined;
  const unusable = () => (checked !== undefined ? checked : (checked = logRootMissing(logRoot) ?? unmigrated(logRoot) ?? wrongSidecar(root, logRoot)));
  /** Serve what is stored, fold nothing, discard nothing. See `logRootMissing`. */
  const decline = (gone: ScopeDiagnostic): Cached<T> => {
    try { return { value: proj.read(d, scope), status: "blocked", diagnostic: gone }; }
    // No rows to serve either. `fold([])` is the empty value, and the point is that it
    // is NOT written — nothing is discarded and nothing claims to describe the log.
    catch { return { value: fold([]), status: "blocked", diagnostic: gone }; }
  };
  for (let attempt = 0; attempt < (overlayActive(logRoot, scope) ? 0 : 3); attempt++) {
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

    const gone = unusable();
    if (gone) return decline(gone);

    const { events, ...status } = await readScopeChecked(logRoot, scope);
    foldsRun++;
    const value = withPeersAhead(await peersAhead(logRoot), () => fold(events));
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
  const lastCheck = unusable();
  if (lastCheck) return decline(lastCheck);
  const { events, ...status } = await readScopeChecked(logRoot, scope);
  foldsRun++;
  const value = withPeersAhead(await peersAhead(logRoot), () => fold(events));
  if (overlayActive(logRoot, scope)) writeStaged(d, scope, value, proj, events.length, status);
  return { value, ...status };
}

/**
 * The stored verdict, read back.
 *
 * A row whose `diagnostic` will not parse is treated as blocked WITHOUT one rather
 * than as complete: the column is only ever written when the status is blocked, so
 * the damage is to the explanation, not to the judgement.
 */
/**
 * Whether a scope's stored rows still describe its log, answered WITHOUT folding it — for a
 * read that serves a scope it must not fold (a pull request's linked branches). `behind`
 * when the shards moved since the fold, or a scope with shards was never folded here; the
 * fingerprint is a `stat` per shard, so no event is read.
 */
export async function scopeCurrency(
  root: string, logRoot: string, scope: string, identity: string,
): Promise<ScopeStatus | { status: "behind" }> {
  const row = db(root).prepare("SELECT fingerprint, status, diagnostic FROM shared_scope WHERE scope = ?").get(scope) as
    { fingerprint: string; status: string; diagnostic: string | null } | undefined;
  if (row) {
    const stored = storedStatus(row);
    if (stored.status === "blocked") return stored;
    return row.fingerprint === await scopeFingerprint(logRoot, scope, identity) ? stored : { status: "behind" };
  }
  const shards = await readdir(join(logRoot, scope)).then((ns) => ns.some((n) => n.endsWith(SHARD_EXT))).catch(() => false);
  return shards ? { status: "behind" } : { status: "complete" };
}

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
  assertNotLockedOut([logRoot]);
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
  // Only now, on the path that would fold. `fresh: false` is the honest answer and callers
  // already handle it as "the rows are behind the log"; nothing is folded, so nothing is
  // discarded. Asking before the cache hit above put a `git merge-base` on every read.
  const gone = logRootMissing(logRoot) ?? unmigrated(logRoot) ?? wrongSidecar(root, logRoot);
  if (gone) return { fresh: false, folded: false, status: "blocked", diagnostic: gone };
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
