import type { PrWalkthrough } from "./walkthrough.js";
/**
 * The codemap store — now backed by a per-universe SQLite DB (`src/db.ts`)
 * instead of JSON sidecar files. The public API is unchanged (same async
 * signatures the ops/CLI/MCP/serve layers already call), so this is a drop-in
 * swap: the storage moves out of git (no merge conflicts, no branch-switch
 * contamination) and concurrent writers serialize via SQLite's WAL locking
 * rather than the file lock.
 *
 * Anchors live under the `@work` ref (the live/working index). Commit-keyed
 * snapshots for branch-diff are a separate ref namespace (Phase 2).
 *
 * "Not initialized" is signalled the same way the JSON store signalled a
 * missing anchors.json: `readAnchorStore`/`readState` throw when no `state`
 * row exists yet, so `status`/`listUniverses`'s catch-based detection still works.
 */

import type { DatabaseSync } from "node:sqlite";
import type { DerivationTag } from "./schema.js";
import { derivationTag, GRAMMAR_NAMES } from "./grammars.js";
import { derivationFingerprint, derivationMark } from "./normalize.js";
import { anchorIndex, derivationsOf, legacyIndex, type AnchorIndex, resolveAnchor} from "./anchor-resolve.js";
import { randomBytes } from "node:crypto";
import { db, WORK_REF, ORPHAN_REF } from "./db.js";
import { resolveActor } from "./identity.js";
import { ABSENT_FIELD } from "./shared-triage.js";
import { needsHumanAck, type SharedBug } from "./shared-bugs.js";
// Aliased: `shared-bugs` exports the same name for the same rule over the same
// `Ratcheted` shape, and importing both unaliased is a redeclaration.
import { needsHumanAck as findingNeedsAck, type SharedFinding } from "./shared-findings.js";
import type { SharedNote, NoteKind } from "./shared-notes.js";
import { IMPORTANCE_RANK, COMPLEXITY_RANK } from "./triage-rules.js";
import { headCommit, currentBranch } from "./git.js";
import { evalVersion, selectWinner, resolveNode, winningVersionAt } from "./doc-version.js";
export { winningVersionAt } from "./doc-version.js";
import {
  type Anchor, type AnchorStore, type State, type LogicalNode, type LogicalNodeType,
  type NodeVersion, type NodeCitation, type NodeStatus,
  type Graph, type Edge, type Annotation, type AnnotationStore,
  type CoverageRule, type CoverageStore, type AnalyzerConfig, type Review, type ReviewStore, type Triage, type TriageStore,
  type BugWitness, type Importance, type Complexity, type TriageSource,
  type Requirement, type RequirementStore, type Spec, type Operation, type Acknowledgement, type Audit, type Problem, type ProposalWitness,
  type AcceptanceCriterion, type VacuityCheck, type EvidenceKind, type Pointer, type PopulationPredicate, type ScrubPolicy,
  SCHEMA_VERSION, ANCHOR_SCHEME, HASH_SCHEME,
} from "./schema.js";

// --- meta key/value helpers (small structured stores kept as JSON blobs) -----

function getMeta<T>(d: DatabaseSync, key: string): T | undefined {
  const row = d.prepare("SELECT v FROM meta WHERE k = ?").get(key) as { v: string } | undefined;
  return row ? (JSON.parse(row.v) as T) : undefined;
}

function setMeta(d: DatabaseSync, key: string, val: unknown): void {
  d.prepare("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .run(key, JSON.stringify(val));
}

/**
 * WHICH sidecar this store has been folding from — its oldest root commit.
 *
 * The key lives here, with the accessors, because both the read path (`materialize.ts`,
 * which must not fold a stranger's log over this store's rows) and the transport
 * (`ops-shared.ts`, which refuses the repoint) ask the same question, and two spellings
 * of one key is how they would come to disagree.
 */
export const SIDECAR_LINEAGE = "sidecar_lineage";

/**
 * What is under that key: the identity, and where it was last seen.
 *
 * The PATH is not the identity — it moves — but it is the only thing that makes the
 * recovery actionable, so it is carried beside it: "the rows came from the sidecar that
 * was at X" is what somebody needs in order to point back at it.
 */
export interface SidecarMark { lineage: string; path: string }

/**
 * A small scalar this store remembers about ITSELF, rather than about the code.
 *
 * Through the seam like everything else: `ops-shared` records which sidecar this store
 * has been folding from, and a raw `db()` query up there is how storage details start
 * leaking into the layer that is supposed to be protected from them.
 */
export const readStoreMeta = <T>(root: string, key: string): T | undefined => getMeta<T>(db(root), key);
export const writeStoreMeta = (root: string, key: string, val: unknown): void => setMeta(db(root), key, val);

/**
 * Has this store ever folded anything from a sidecar?
 *
 * `shared_scope` is the broadest answer — it has a row per scope this store has folded,
 * whatever kind — which is what the question needs: "is there anything here that came
 * from a sidecar, and would therefore be stranded". Broader than `foldedScopes`, which
 * only looks at the two record kinds a person loses.
 */
export function hasFoldedFromSidecar(root: string): boolean {
  try {
    return ((db(root).prepare("SELECT COUNT(*) AS n FROM shared_scope").get() as { n: number }).n) > 0;
  } catch { return false; }   // no table yet — nothing has ever been folded here
}

/**
 * Every sidecar scope the canonical tables hold rows from.
 *
 * `source_scope` says where the fold read a row, so this is the set of scopes this store
 * has ever folded — and comparing it against what is on disk is how a repoint is
 * measured. Findings and bugs only: those are the kinds a person loses when the answer
 * is wrong, and they are enough to say whether anything is at stake.
 */
export function foldedScopes(root: string): string[] {
  try {
    const rows = db(root).prepare(
      "SELECT DISTINCT source_scope AS s FROM findings WHERE source_scope IS NOT NULL "
      + "UNION SELECT DISTINCT source_scope FROM bugs WHERE source_scope IS NOT NULL",
    ).all() as { s: string }[];
    return rows.map((r) => r.s).sort();
  } catch { return []; }
}

// --- anchor row <-> object mapping -------------------------------------------

interface AnchorRow {
  id: string; file: string; symbol_path: string; kind: string; disambiguator: string | null;
  body_hash: string; last_commit: string | null; derivation: number | null;
  start_byte: number | null; end_byte: number | null; start_line: number | null; end_line: number | null;
}

/**
 * Intern a derivation tag, and read them back.
 *
 * Anchors round-trip through `Anchor[]` on every incremental update —
 * `replaceAnchors` deletes the ref and re-inserts from objects — so provenance
 * that lives only in a column would be erased by the first `check`. It has to
 * travel on the object, and these two functions are the only place it is
 * flattened.
 */
/** One canonical string per tag — fixed field order, so identical tags key identically. */
const tagKey = (t: DerivationTag): string =>
  JSON.stringify([t.anchorScheme, t.hashScheme, t.parserIntegrity, t.grammarDigest]);

/**
 * What a derivation fingerprint stood for, if this store has ever seen it.
 *
 * The fingerprint is one-way, so a reader can tell that two values were derived
 * differently but not WHAT differed. This turns that back into an explanation for
 * every derivation the machine has itself used — which is most of them in practice,
 * since the interesting comparison is usually against something it indexed.
 *
 * PLURAL, and that is not a detail. The fingerprint excludes `anchorScheme`, so two
 * retained tags can share one — and returning "the first" would make a comparability
 * answer depend on SELECT order. Every candidate is returned and the caller takes
 * the permissive reading, which is the safe direction and keeps `anchorScheme` where
 * it already is: gated out of band by `checkManifest`, `readSnapshot` and
 * `migrateOverloads`.
 *
 * Deliberately NOT the registry `PROPOSAL-provenance.md` §9 cut. That one was a
 * PUBLISHED registry with its own ordering constraint and its own reader states for
 * an incomplete one. This is local and derived: a miss costs precision — the caller
 * falls back to matching fingerprints — never an answer.
 */
export function derivationLookup(root: string): (fingerprint: string) => DerivationTag[] {
  let byMark: Map<string, DerivationTag[]> | null = null;
  return (fingerprint) => {
    // Built once per index, LAZILY. Per-call it was a full table read, a JSON parse
    // and a SHA-256 per row — for every unresolved anchor in a pass, which on a
    // store with real content is thousands of scans of a handful of rows.
    if (!byMark) {
      byMark = new Map();
      for (const t of derivationsById(db(root)).values()) {
        const fp = derivationFingerprint(t);
        (byMark.get(fp) ?? byMark.set(fp, []).get(fp)!).push(t);
      }
    }
    return byMark.get(fingerprint) ?? [];
  };
}

function internDerivation(d: DatabaseSync, tag: DerivationTag | undefined): number | null {
  if (!tag) return null;
  const json = tagKey(tag);
  const hit = d.prepare("SELECT id FROM derivations WHERE tag = ?").get(json) as { id: number } | undefined;
  if (hit) return hit.id;
  d.prepare("INSERT INTO derivations(tag) VALUES(?)").run(json);
  return (d.prepare("SELECT id FROM derivations WHERE tag = ?").get(json) as { id: number }).id;
}

/** Every interned tag, by id. A handful of rows — one per grammar per build this
 *  store has seen, retained across upgrades — so it is read whole. */
function derivationsById(d: DatabaseSync): Map<number, DerivationTag> {
  const out = new Map<number, DerivationTag>();
  for (const r of d.prepare("SELECT id, tag FROM derivations").all() as unknown as { id: number; tag: string }[]) {
    try {
      const [anchorScheme, hashScheme, parserIntegrity, grammarDigest] = JSON.parse(r.tag);
      out.set(r.id, { anchorScheme, hashScheme, parserIntegrity, grammarDigest });
    } catch { /* a row nothing can read is the same as no row */ }
  }
  return out;
}

function rowToAnchor(r: AnchorRow, tags?: Map<number, DerivationTag>): Anchor {
  return {
    id: r.id,
    file: r.file,
    symbolPath: JSON.parse(r.symbol_path),
    kind: r.kind as Anchor["kind"],
    ...(r.disambiguator != null ? { disambiguator: r.disambiguator } : {}),
    bodyHash: r.body_hash,
    ...(r.derivation != null && tags?.has(r.derivation) ? { derivation: tags.get(r.derivation)! } : {}),
    lastVerifiedCommit: r.last_commit,
    ...(r.start_byte != null
      ? { loc: { startByte: r.start_byte, endByte: r.end_byte!, startLine: r.start_line!, endLine: r.end_line! } }
      : {}),
  };
}

/** Replace all anchors under a ref in one transaction. */
function replaceAnchors(d: DatabaseSync, ref: string, anchors: Anchor[]): void {
  const ins = d.prepare(
    "INSERT OR REPLACE INTO anchors(ref,id,file,symbol_path,kind,disambiguator,body_hash,last_commit,derivation,start_byte,end_byte,start_line,end_line) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  // Interned before the transaction: identical tags are the norm, so this is a
  // handful of lookups even for a full reindex.
  const tagId = new Map<Anchor, number | null>();
  for (const a of anchors) tagId.set(a, internDerivation(d, a.derivation));
  d.exec("BEGIN");
  try {
    d.prepare("DELETE FROM anchors WHERE ref = ?").run(ref);
    for (const a of anchors) {
      ins.run(ref, a.id, a.file, JSON.stringify(a.symbolPath), a.kind, a.disambiguator ?? null,
        a.bodyHash, a.lastVerifiedCommit ?? null, tagId.get(a) ?? null,
        a.loc?.startByte ?? null, a.loc?.endByte ?? null, a.loc?.startLine ?? null, a.loc?.endLine ?? null);
    }
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

function anchorsUnder(d: DatabaseSync, ref: string): Anchor[] {
  const tags = derivationsById(d);
  const rows = d.prepare("SELECT * FROM anchors WHERE ref = ?").all(ref) as unknown as AnchorRow[];
  return rows.map((r) => rowToAnchor(r, tags));
}

// --- anchors + state ---------------------------------------------------------

export async function writeStore(root: string, anchors: Anchor[], state: State): Promise<void> {
  const d = db(root);
  replaceAnchors(d, WORK_REF, anchors);
  setMeta(d, "state", state);
}

/**
 * The one message every front-end shows for an unmapped repo. It names the fix in
 * both vocabularies on purpose: an agent that only has the MCP tools was reading
 * the codebase by hand when the text said "run `codemap init`".
 */
const notInitialized = (root: string) =>
  `codemap not initialized at ${root} — build the anchor index first ` +
  `(MCP: call the \`init\` tool; CLI: \`codemap init ${root}\`)`;

export async function readAnchorStore(root: string): Promise<AnchorStore> {
  const d = db(root);
  if (!getMeta(d, "state")) throw new Error(notInitialized(root));
  return { schemaVersion: SCHEMA_VERSION, anchors: anchorsUnder(d, WORK_REF) };
}

/** Replace just the working anchors (leaves state/graph untouched — incremental updates). */
export async function writeAnchorStore(root: string, anchors: Anchor[]): Promise<void> {
  replaceAnchors(db(root), WORK_REF, anchors);
}

// --- commit-keyed anchor snapshots (the branch-diff cache) -------------------

export interface SnapshotInfo {
  ref: string; // full commit sha
  branch: string | null;
  at: string; // ISO timestamp captured
  count: number;
  /** Indexed from a working tree with uncommitted changes — not faithful to `ref`. */
  dirty?: boolean;
}

/**
 * Was the cached snapshot for `ref` taken from a dirty tree?
 *
 * Separate from `readSnapshot`, which deliberately answers null for a snapshot it
 * cannot USE. A dirty one is perfectly usable and simply lies about which commit it
 * describes, so the caller needs to say something specific rather than "not cached" —
 * that message tells you to run `init`, which is what produced it.
 */
export function snapshotIsDirty(root: string, ref: string): boolean {
  const r = db(root).prepare("SELECT dirty FROM snapshots WHERE ref = ?").get(ref) as { dirty: number | null } | undefined;
  return !!r?.dirty;
}

/**
 * Cache a full anchor set under a commit sha (immutable snapshot). Re-snapshotting
 * the same sha overwrites it — the latest full index of that commit wins. `@work`
 * is reserved for the live index and is never used as a snapshot ref.
 */
export async function writeSnapshot(
  root: string, ref: string, branch: string | null, anchors: Anchor[], at: string,
  /**
   * The working tree had uncommitted changes when this was indexed, so the row is
   * NOT a faithful picture of the commit it is named after. Callers that build from
   * git objects (`snapshotAt`) are never dirty and leave it false; the ones that
   * index the working tree (`init`, `snapshot`) must pass `isDirty(root)`.
   */
  opts: { dirty?: boolean } = {},
): Promise<void> {
  if (ref === WORK_REF) throw new Error("cannot snapshot the reserved @work ref");
  const d = db(root);
  replaceAnchors(d, ref, anchors);
  d.prepare("INSERT INTO snapshots(ref,branch,at,count,scheme,hash_scheme,dirty) VALUES(?,?,?,?,?,?,?) ON CONFLICT(ref) DO UPDATE SET branch=excluded.branch, at=excluded.at, count=excluded.count, scheme=excluded.scheme, hash_scheme=excluded.hash_scheme, dirty=excluded.dirty")
    .run(ref, branch, at, anchors.length, ANCHOR_SCHEME, HASH_SCHEME, opts.dirty ? 1 : 0);
}

/**
 * Snapshots minted under a different anchor-id derivation than the one in force.
 *
 * A diff is a set operation over ids between two snapshots, so pairing one scheme
 * against another reports every affected symbol as removed-and-added. NULL scheme
 * means "written before this was recorded", which cannot be distinguished from an
 * older derivation and so counts as stale.
 */
/** Every anchor stored under a ref, scheme-check bypassed — the raw rows. */
export function anchorsUnderRef(root: string, ref: string): Anchor[] {
  return anchorsUnder(db(root), ref);
}

export function staleSchemeSnapshots(root: string): string[] {
  return (db(root).prepare(
    "SELECT ref FROM snapshots WHERE scheme IS NULL OR scheme <> ? OR hash_scheme IS NULL OR hash_scheme <> ?",
  ).all(ANCHOR_SCHEME, HASH_SCHEME) as { ref: string }[])
    .map((r) => r.ref);
}

/**
 * Forget one cached snapshot. It rebuilds from the commit's own objects on next use.
 *
 * The reserved refs are refused for the same reason `writeSnapshot` refuses
 * `@work`: this deletes anchors BY REF, so passing one would drop the live index
 * or the orphan retention — neither of which rebuilds from a commit, because
 * neither came from one. `@orphan` in particular is unrecoverable: it holds the
 * last state of anchors that have already left the tree.
 */
export function dropSnapshot(root: string, ref: string): void {
  if (ref === WORK_REF || ref === ORPHAN_REF) {
    throw new Error(`${ref} is not a snapshot — dropping it would delete the live index, not a cache`);
  }
  const d = db(root);
  d.exec("BEGIN");
  try {
    d.prepare("DELETE FROM anchors WHERE ref = ?").run(ref);
    d.prepare("DELETE FROM snapshots WHERE ref = ?").run(ref);
    d.exec("COMMIT");
  } catch (e) { d.exec("ROLLBACK"); throw e; }
}

/** Read a cached snapshot's anchors, or null when that commit was never indexed. */
/**
 * Locate anchors that are NOT in `@work`, in the newest cached commit snapshot
 * that holds them.
 *
 * A finding ingested against a pull request is deliberately written against the
 * PR HEAD's anchors, so a finding on a symbol the branch ADDS has no `@work` row at
 * all — the review queue then handed an agent an item with no file, no symbol and
 * no source, which is exactly the hunting the tool description promises it will not
 * have to do.
 */
/**
 * Every anchor id any stored work points at — annotations, bugs, reviews, triage and
 * node citations. The set a reindex or a snapshot rebuild must not silently drop.
 *
 * Lives here rather than in ops because `pr.ts` needs it and sits below ops: this
 * reads nothing but the store.
 */
export async function referencedAnchorIds(root: string): Promise<Set<string>> {
  const [annStore, bugStore, reviewStore, triageStore, nodes] = await Promise.all([
    readAnnotations(root), readBugs(root), readReviews(root), readTriage(root), loadNodes(root),
  ]);
  const ids = new Set<string>();
  for (const a of annStore.annotations) if (a.target.kind === "anchor") ids.add(a.target.id);
  // Removed citations count too: a bug's history is evidence, and an anchor dropped
  // from a live bug is still the code somebody was looking at when they filed it.
  for (const b of bugStore.bugs) for (const a of b.anchors) ids.add(a.anchorId);
  for (const r of reviewStore.reviews) if (r.target.kind === "anchor") ids.add(r.target.id);
  for (const t of triageStore.triage) if (t.target.kind === "anchor") ids.add(t.target.id);
  for (const n of nodes) for (const id of n.anchors) ids.add(id);
  return ids;
}

/**
 * Keep anchors that are leaving the tree but that somebody's work still cites.
 *
 * Reindex replaces `@work` wholesale, so an anchor the new index does not produce
 * is deleted — and every annotation, bug, review and citation aimed at it dangles
 * with no record of what it ever meant. That is not hypothetical: it has already
 * destroyed a batch of findings once.
 *
 * Retained rows are additive and never overwrite an existing one — the FIRST
 * eviction holds the last state the anchor was actually seen in, and a later
 * reindex must not replace it with something staler or re-derived.
 */
export function retainOrphans(root: string, anchors: Anchor[]): number {
  if (!anchors.length) return 0;
  const d = db(root);
  const ins = d.prepare(
    "INSERT OR IGNORE INTO anchors(ref,id,file,symbol_path,kind,disambiguator,body_hash,last_commit,derivation,start_byte,end_byte,start_line,end_line) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  // An orphan keeps the derivation it was EVICTED under, which is the whole point
  // of `INSERT OR IGNORE` here: the first eviction holds the last state the anchor
  // was really seen in, and re-deriving it later would be a claim nobody can check.
  const tagId = new Map<Anchor, number | null>();
  for (const a of anchors) tagId.set(a, internDerivation(d, a.derivation));
  let n = 0;
  d.exec("BEGIN");
  try {
    for (const a of anchors) {
      ins.run(ORPHAN_REF, a.id, a.file, JSON.stringify(a.symbolPath), a.kind, a.disambiguator ?? null,
        a.bodyHash, a.lastVerifiedCommit ?? null, tagId.get(a) ?? null,
        a.loc?.startByte ?? null, a.loc?.endByte ?? null, a.loc?.startLine ?? null, a.loc?.endLine ?? null);
      n++;
    }
    d.exec("COMMIT");
  } catch (e) { d.exec("ROLLBACK"); throw e; }
  return n;
}

/** Retained anchors, by id. The last known state of code the tree no longer has. */
export function readOrphans(root: string, ids?: string[]): Map<string, Anchor> {
  const d = db(root);
  const rows = (ids?.length
    ? d.prepare(`SELECT * FROM anchors WHERE ref = ? AND id IN (${ids.map(() => "?").join(",")})`).all(ORPHAN_REF, ...ids)
    : d.prepare("SELECT * FROM anchors WHERE ref = ?").all(ORPHAN_REF)) as unknown as AnchorRow[];
  const tags = derivationsById(d);
  return new Map(rows.map((r) => [r.id, rowToAnchor(r, tags)]));
}

/**
 * Forget retained copies of anchors the live index has again.
 *
 * A symbol that comes back — a branch checked out, a revert, a rename undone — is
 * live code once more, and leaving a stale copy beside it would give two answers to
 * "what does this id mean".
 *
 * Set-based on purpose. Listing the ids meant one SQL parameter per referenced
 * anchor, and a universe with a few thousand review marks is already most of the
 * way to SQLite's ~32k parameter ceiling — a limit that would have been hit by
 * growth rather than by anything going wrong. Must be called AFTER the new index is
 * written, since it reads it.
 */
export function releaseRecoveredOrphans(root: string): number {
  const r = db(root).prepare(
    "DELETE FROM anchors WHERE ref = ? AND id IN (SELECT id FROM anchors WHERE ref = ?)",
  ).run(ORPHAN_REF, WORK_REF);
  return Number(r.changes ?? 0);
}

/**
 * `@work` hashes for JUST these ids, as an index.
 *
 * The point of the query is what it does NOT do: `liveHashes` and
 * `classifyCitations` each built a structure over EVERY anchor in the universe to
 * answer about a handful, and `sharedDocs` called both — two full table scans per
 * call, ~150ms on a 10k-anchor repo before folding anything.
 *
 * The derivations are a SEPARATE query over the whole ref on purpose, and this is
 * the trap: taking them from the matched rows would mean an id that matched nothing
 * yields an empty tag set, and an index with no tags rules nothing out — so every
 * absence would read `incomparable` exactly when it is most likely to be a real
 * deletion. There is a handful of distinct derivations, so the DISTINCT is cheap.
 */
export function workIndexFor(root: string, ids: Iterable<string>): AnchorIndex {
  const d = requireIndex(root);
  const want = [...new Set(ids)];
  const hashes = new Map<string, string>();
  // Chunked: SQLite caps host parameters per statement, and a catalogue view asks
  // about every citation of every doc — the dry run had a thousand.
  for (let i = 0; i < want.length; i += 400) {
    const chunk = want.slice(i, i + 400);
    const q = `SELECT id, body_hash FROM anchors WHERE ref = ? AND id IN (${chunk.map(() => "?").join(",")})`;
    for (const r of d.prepare(q).all(WORK_REF, ...chunk) as unknown as { id: string; body_hash: string }[]) {
      hashes.set(r.id, r.body_hash);
    }
  }
  return anchorIndex(hashes, workDerivations(d), derivationLookup(root));
}

/**
 * The DB, but only if this universe has actually been indexed.
 *
 * `db()` CREATES an empty store on demand, so a query against an uninitialized
 * universe succeeds and returns nothing — which would classify every shared
 * citation as `lost`, i.e. "the code is gone", to somebody who has merely pulled
 * the sidecar and not run `init` yet. `readAnchorStore` has always thrown here for
 * that reason and callers handle it; these lookups replaced it and must keep the
 * guard, or the answer degrades from "cannot say" to a confident lie.
 */
function requireIndex(root: string): DatabaseSync {
  const d = db(root);
  if (!getMeta(d, "state")) throw new Error(notInitialized(root));
  return d;
}

/** Every derivation `@work` holds, and whether any row predates provenance. */
function workDerivations(d: DatabaseSync): { tags: DerivationTag[]; anyUntagged: boolean } {
  const tags = derivationsById(d);
  const out: DerivationTag[] = [];
  let anyUntagged = false;
  for (const r of d.prepare("SELECT DISTINCT derivation FROM anchors WHERE ref = ?").all(WORK_REF) as unknown as
    { derivation: number | null }[]) {
    if (r.derivation == null) { anyUntagged = true; continue; }
    const t = tags.get(r.derivation);
    if (t) out.push(t); else anyUntagged = true;   // unreadable row: rules nothing out
  }
  return { tags: out, anyUntagged };
}

/** Which of these ids `@work` actually holds — membership without materializing it. */
/**
 * Which of these ids this store has a record of, at `ref` (the live index by default).
 *
 * The `ref` parameter is not a convenience. Its caller in `reviews.ts` witnesses code at
 * `input.ref` and asked this at `@work`, so the two halves of one check spoke about
 * different trees: reviewing at a base ref a symbol the BRANCH adds left `known` non-empty
 * — the working tree has it — and the "nothing was witnessed" guard never fired, which is
 * exactly the `/diff` case it was written for. The error message even named the snapshot
 * it had not consulted.
 */
export function workHas(root: string, ids: string[], ref: string = WORK_REF): Set<string> {
  const d = requireIndex(root);
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const q = `SELECT id FROM anchors WHERE ref = ? AND id IN (${chunk.map(() => "?").join(",")})`;
    for (const r of d.prepare(q).all(ref, ...chunk) as unknown as { id: string }[]) out.add(r.id);
  }
  return out;
}

/**
 * The files `@work` holds these anchors in — membership plus the one field a caller
 * usually wants next, without materializing every anchor to get it.
 *
 * Exists because `ServedPointer.rank` asks "is this anchor in a `[tests]` path" once per
 * pointer, and answering it by loading the whole anchor store made an audit queue O(n)
 * full scans.
 */
export function workFiles(root: string, ids: string[]): Map<string, string> {
  const d = requireIndex(root);
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const q = `SELECT id, file FROM anchors WHERE ref = ? AND id IN (${chunk.map(() => "?").join(",")})`;
    for (const r of d.prepare(q).all(WORK_REF, ...chunk) as unknown as { id: string; file: string }[]) out.set(r.id, r.file);
  }
  return out;
}

export function findAnchorsOutsideWork(root: string, ids: string[]): Map<string, { ref: string; anchor: Anchor }> {
  const out = new Map<string, { ref: string; anchor: Anchor }>();
  if (!ids.length) return out;
  const q = `SELECT a.*, s.at AS snap_at FROM anchors a JOIN snapshots s ON s.ref = a.ref
             WHERE a.ref <> '@work' AND a.id IN (${ids.map(() => "?").join(",")})
             ORDER BY s.at DESC`;
  const d = db(root);
  const tags = derivationsById(d);
  for (const r of d.prepare(q).all(...ids) as unknown as (AnchorRow & { ref: string })[]) {
    if (!out.has(r.id)) out.set(r.id, { ref: r.ref, anchor: rowToAnchor(r, tags) });   // newest wins
  }
  return out;
}

/**
 * One anchor's body hash under one ref — a primary-key point lookup.
 *
 * `readSnapshot` materialises every anchor under the ref (thousands, on a real
 * universe), which is the wrong shape for witnessing a single finding: an ingest of
 * a hundred findings would load the whole snapshot a hundred times.
 */
export function bodyHashAt(root: string, ref: string, anchorId: string): string | null {
  const row = db(root).prepare("SELECT body_hash FROM anchors WHERE ref = ? AND id = ?").get(ref, anchorId) as
    { body_hash?: string } | undefined;
  return row?.body_hash ?? null;
}

/**
 * Why a cached snapshot for `ref` is not usable AS THAT COMMIT, or null if it is.
 *
 * ONE predicate and ONE explanation, because this rule diffused. `diff` refused a
 * dirty base snapshot (COD-3) and the witnessing path did not check at all — so a
 * `reindex` on a dirty tree re-cached HEAD from the working tree and a later
 * `review(ref: head)` recorded the working tree's body under that sha, defeating
 * the very thing `ref` exists for. Two shapes of one rule, each locally correct.
 * The other nine `readSnapshot` callers had no check either.
 *
 * The message is here rather than at the call sites because a wrong one traps the
 * reader: "not cached — run `init`" is what `diff` used to say, and `init` is the
 * command that PRODUCED the dirty snapshot. `codemap snapshot --ref` reads git objects
 * and needs no clean checkout, so it is the exit in every case.
 */
export function snapshotRefusal(
  root: string, ref: string,
): { reason: "absent" | "derivation" | "dirty"; message: string } | null {
  const d = db(root);
  const short = ref.slice(0, 12);
  const meta = d.prepare("SELECT scheme, hash_scheme FROM snapshots WHERE ref = ?").get(ref) as
    { scheme: number | null; hash_scheme: number | null } | undefined;
  if (!meta) return { reason: "absent", message: `no cached snapshot for ${short}. Cache it with \`codemap snapshot --ref ${short}\`.` };
  // Both derivations must match. The ids decide WHICH symbols pair up; the hashes
  // decide which of those pairs count as changed — so a snapshot carrying the right
  // ids and another scheme's hashes reports the whole commit as rewritten.
  //
  // And the same question the scheme numbers cannot ask: a re-vendored grammar or a
  // rebuilt parser moves every body hash without touching either number. A snapshot
  // is minted atomically by one build, so unlike `@work` it HAS a truthful
  // derivation, and the right answer is the one this codebase already gives for a
  // stale cache — rebuild it, which takes seconds. Reporting the mismatch downstream
  // instead would leave a repairable cache in place and flood the diff.
  if (meta.scheme !== ANCHOR_SCHEME || meta.hash_scheme !== HASH_SCHEME || staleDerivation(d, ref)) {
    return { reason: "derivation", message: `the cached snapshot for ${short} was built by a different anchor/hash derivation than this one, so its ids and bodies cannot be compared with today's. Re-cache it with \`codemap snapshot --ref ${short}\`.` };
  }
  if (snapshotIsDirty(root, ref)) {
    return { reason: "dirty", message: `the cached snapshot for ${short} was indexed from a working tree with uncommitted changes, so it is NOT that commit. Re-cache it from git objects with \`codemap snapshot --ref ${short}\`, which needs no clean checkout. (Plain \`codemap snapshot\` re-indexes the WORKING TREE and would reproduce this.)` };
  }
  return null;
}

/**
 * Read a cached snapshot's anchors, or null when it is not usable as that commit —
 * never indexed, indexed under a DIFFERENT derivation, or indexed from a dirty tree.
 *
 * All three read as "not cached" on purpose, and callers already handle that:
 * `ensureSnapshot` and `snapshotAt` rebuild (which REPAIRS the cache), `diff` and
 * `liveHashes` explain with `snapshotRefusal`. A silently wrong answer has no
 * handler at all — a diff against a dirty base compares the branch's uncommitted
 * work with itself and reports nothing changed.
 *
 * Pass `allowDirty` only where the snapshot is wanted as a record of what some
 * build produced rather than as the commit. Nothing does today.
 *
 * Deliberately NOT applied to the raw by-ref lookups (`findAnchorsOutsideWork`,
 * `bodyHashAt`): those resolve an id somebody already holds, and an id from an old
 * snapshot is exactly what needs finding there.
 */
export async function readSnapshot(
  root: string, ref: string, opts: { allowDirty?: boolean } = {},
): Promise<Anchor[] | null> {
  const refusal = snapshotRefusal(root, ref);
  if (refusal && !(opts.allowDirty && refusal.reason === "dirty")) return null;
  return anchorsUnder(db(root), ref);
}

/**
 * Whether the live index was built by a different grammar or parser than this one.
 *
 * A DETECTOR, not a repair, and deliberately so. A snapshot can simply be rebuilt;
 * `@work` cannot, because reindexing it is exactly what turns a grammar change into
 * a store-wide staleness event — every review witness and doc citation holds an
 * old-derivation hash, and the live ones no longer match. Since hashes carry a
 * derivation fingerprint, annotated witnesses read as `unverifiable` rather than as
 * false drift; the ones minted before emission cannot, and they are the older half.
 * Either way the honest response is to say so and let a person decide, not to act.
 *
 * The vendored grammar blobs have been committed exactly once in this repository's
 * life, so this is sized for something that has never happened: one query, on
 * demand, and a sentence when it fires.
 */
export function liveDerivationDrift(root: string): { stale: boolean; tagged: number; untagged: number } {
  const d = db(root);
  const rows = d.prepare(
    "SELECT derivation, count(*) AS n FROM anchors WHERE ref = ? GROUP BY derivation",
  ).all(WORK_REF) as unknown as { derivation: number | null; n: number }[];
  const tags = derivationsById(d);
  const current = new Set(GRAMMAR_NAMES.map((g) => tagKey(derivationTag(g))));
  let tagged = 0, untagged = 0, stale = false;
  for (const r of rows) {
    if (r.derivation == null) { untagged += r.n; continue; }
    tagged += r.n;
    const t = tags.get(r.derivation);
    if (!t || !current.has(tagKey(t))) stale = true;
  }
  return { stale, tagged, untagged };
}

/**
 * Does this ref hold anchors derived by a build that is not this one?
 *
 * Untagged rows do NOT count. Every snapshot cached before tags existed is
 * untagged, and treating those as stale would rebuild every cache on upgrade for a
 * question they cannot answer — the same reasoning `comparableHashDerivation` uses, and
 * two different answers to "what does untagged mean" would be worse than either.
 * The residue is honest and recorded: a pre-tag snapshot taken under an older
 * grammar stays usable, exactly as it is today, until something re-snapshots it.
 */
function staleDerivation(d: DatabaseSync, ref: string): boolean {
  const rows = d.prepare("SELECT DISTINCT derivation FROM anchors WHERE ref = ? AND derivation IS NOT NULL")
    .all(ref) as unknown as { derivation: number }[];
  if (!rows.length) return false;
  const tags = derivationsById(d);
  const current = new Set(GRAMMAR_NAMES.map((g) => tagKey(derivationTag(g))));
  return rows.some((r) => {
    const t = tags.get(r.derivation);
    return !t || !current.has(tagKey(t));
  });
}


/** The label a commit's snapshot was cached under (a branch or PR head ref), if any. */
export function snapshotBranch(root: string, ref: string): string | null {
  const r = db(root).prepare("SELECT branch FROM snapshots WHERE ref = ?").get(ref) as { branch: string | null } | undefined;
  return r?.branch ?? null;
}

export async function listSnapshots(root: string): Promise<SnapshotInfo[]> {
  const rows = db(root).prepare("SELECT ref, branch, at, count, dirty FROM snapshots ORDER BY at DESC").all() as unknown as SnapshotInfo[];
  return rows;
}

export async function readState(root: string): Promise<State> {
  const s = getMeta<State>(db(root), "state");
  if (!s) throw new Error(notInitialized(root));
  return s;
}

/** Update just the state record (leaves anchors untouched). */
export async function writeState(root: string, state: State): Promise<void> {
  setMeta(db(root), "state", state);
}

// --- logical nodes (versioned — see docs/doc-versioning.md) -------------------

interface VersionRow {
  version_id: string; node_id: string; type: string; title: string; summary: string; body: string;
  generated_by: string | null; created_commit: string | null; created_branch: string | null;
  created_at: string; citations: string; removed: number | null;
  origin: string | null; source_scope: string | null; publication_state: string | null;
  ord: number | null; author: string | null;
}

function rowToVersion(r: VersionRow): NodeVersion {
  return {
    versionId: r.version_id, nodeId: r.node_id, type: (r.type ?? "module") as LogicalNodeType,
    title: r.title ?? "", summary: r.summary ?? "", body: r.body ?? "",
    citations: JSON.parse(r.citations ?? "[]"),
    ...(r.generated_by ? { generatedBy: r.generated_by } : {}),
    ...(r.removed ? { removed: true } : {}),
    // The SCOPE, not the marker: "which teammate's scope owns this" is the useful
    // fact, and `source_scope` is what the suppression rule keys on.
    ...(r.origin ? { origin: r.source_scope ?? r.origin } : {}),
    ...(r.author ? { author: (JSON.parse(r.author) as { principal?: string }).principal } : {}),
    createdCommit: r.created_commit, createdBranch: r.created_branch, createdAt: r.created_at,
  };
}

/**
 * The version pool a resolver should actually see.
 *
 * (f) MECHANISM 2, and it exists because the gate in `ackHole` cannot cover the
 * ordering race: a local tombstone written legitimately, while the node was purely
 * local, followed by a teammate publishing a doc under the same node id. The ack was
 * honest when it was made and stops being honest the moment the node is no longer
 * only this user's.
 *
 * So: a LOCAL tombstone is dropped whenever the pool holds a fold-owned content
 * version. The teammate's doc then resolves normally — as `dangling` where its code
 * is absent here, which is the honest answer and the one a reviewer wants.
 *
 * A FOLD-OWNED tombstone is untouched: it entered the log through
 * `retireSharedDoc`'s person-only gate and participates like any other version.
 *
 * Deliberately NOT inside `selectWinner`. That function is pure, is shared verbatim
 * with the sidecar fold path via `winningVersionAt`, and `NodeVersion` carries no
 * origin there by design. This is the store's rule about its own rows.
 */
export function resolvable(versions: NodeVersion[]): NodeVersion[] {
  const teamContent = versions.some((v) => v.origin && !v.removed);
  return teamContent ? versions.filter((v) => v.origin || !v.removed) : versions;
}

/**
 * The ownership rule, as one clause every local write goes through.
 *
 * > A fold-owned row (`origin IS NOT NULL`) is written only by the fold. Every local
 * > mutation is either an `origin IS NULL` operation or an event append.
 *
 * A review of the first unification plan found ten defects, nine of them consequences
 * of this rule being absent: five existing write paths would each have mutated
 * projection rows the moment docs unified. The failures are quiet in a specific way —
 * nothing about a local mutation moves the scope fingerprint, so the cache keeps
 * serving the corrupted rows indefinitely, and a missing row does not raise
 * `CorruptProjection` either, so that escape hatch never fires.
 *
 * Appending the clause by hand at each site is what the plan asked for and it is not
 * enough on its own: the next write path added simply forgets. Every local statement
 * against `node_versions` is built here instead, so there is ONE place to read to
 * know the rule holds.
 *
 * It is a convention, not enforcement — raw SQL compiles perfectly well, and a test
 * in this repo already writes some. `src/doc-ownership.test.ts` is what actually
 * checks the rule; if a stronger fence is ever wanted, it is a SQLite trigger that
 * raises unless a fold is active, which is zero-dependency and turns every one of
 * these into a loud error.
 */
const LOCAL_ONLY = "origin IS NULL";

/** A local UPDATE/DELETE, fenced so it can never reach a fold-owned row. */
const localWrite = (sql: string): string =>
  sql.includes(" WHERE ") ? `${sql} AND ${LOCAL_ONLY}` : `${sql} WHERE ${LOCAL_ONLY}`;

/**
 * Version rows for one node, in the one canonical order.
 *
 * Fold rows first in the log's order, then local rows in insertion order. There was
 * no ORDER BY at all, so this was rowid order — which a re-fold (DELETE + reinsert
 * puts rows at the end) and interleaved local writes both perturb, while
 * `selectWinner`'s recency tiebreak is a strict `>` and therefore resolves equal
 * timestamps by iteration order.
 *
 * On a local-only store `(origin IS NULL)` is constant and `ord` is NULL throughout,
 * so this degenerates to `rowid` and reproduces exactly today's de facto order. Note
 * that today's SQL guarantees no order at all: this turns an empirical behaviour into
 * a contract.
 */
const VERSION_ORDER = "ORDER BY (origin IS NULL), ord, rowid";

function versionsOf(d: DatabaseSync, nodeId: string): NodeVersion[] {
  return (d.prepare(`SELECT * FROM node_versions WHERE node_id = ? ${VERSION_ORDER}`).all(nodeId) as unknown as VersionRow[]).map(rowToVersion);
}

/**
 * `@work`'s hashes, with what its rows say about the build(s) that minted them.
 *
 * The rows' OWN derivations, not this build's: `@work` is stored, so an id had to
 * be minted by whatever indexed it to appear here — and after an upgrade that is
 * legitimately not the running build. (Contrast `liveHashes` with no ref, which
 * re-parses in process and is therefore this build's output.)
 */
function workHashes(d: DatabaseSync, root: string): AnchorIndex {
  const m = new Map<string, string>();
  const tags = derivationsById(d);
  const seen: { derivation?: DerivationTag }[] = [];
  for (const r of d.prepare("SELECT id, body_hash, derivation FROM anchors WHERE ref = ?").all(WORK_REF) as any[]) {
    m.set(r.id, r.body_hash);
    seen.push({ derivation: r.derivation == null ? undefined : tags.get(r.derivation) });
  }
  return anchorIndex(m, derivationsOf(seen), derivationLookup(root));
}

/**
 * Every live node, local and folded, resolved together.
 *
 * `excludeScopes` is the ONE place gap suppression can be turned off, and it exists
 * because "show the rows" and "let the rows decide" are different permissions. A
 * blocked scope may SHOW what the team wrote — hiding it makes an agent re-document
 * over a colleague and manufactures the very contest the design exists to surface —
 * and it may NOT decide there is no work here, because suppressing a gap is an
 * authoritative act whose harm is invisible: it is what is missing from a list.
 *
 * So callers that DISPLAY pass nothing; callers that DECIDE (the work queue, and
 * coverage feeding it) pass the blocked scopes. See `docsVerdict` in ops-shared.
 */
export async function loadNodes(root: string, excludeScopes?: ReadonlySet<string>): Promise<LogicalNode[]> {
  return loadNodesAt(root, workHashes(db(root), root), excludeScopes);
}

/**
 * The same, resolved against a GIVEN index rather than the working tree.
 *
 * Which version of a doc wins depends on which code is in front of you, so "the docs
 * affected by this change" is a question about the refs being diffed — not about
 * whatever branch happens to be checked out. Resolving against `@work` meant a doc
 * retired on your current branch vanished from a pull request's impact for two other
 * refs, and `computeDiff` takes explicit cached refs precisely so it does not depend
 * on the checkout.
 */
export async function loadNodesAt(root: string, work: AnchorIndex, excludeScopes?: ReadonlySet<string>): Promise<LogicalNode[]> {
  const d = db(root);
  const byNode = new Map<string, NodeVersion[]>();
  for (const r of d.prepare(`SELECT * FROM node_versions ${VERSION_ORDER}`).all() as unknown as VersionRow[]) {
    if (excludeScopes?.size && r.source_scope && excludeScopes.has(r.source_scope)) continue;
    const v = rowToVersion(r);
    (byNode.get(v.nodeId) ?? byNode.set(v.nodeId, []).get(v.nodeId)!).push(v);
  }
  // Tombstoned-here nodes are not live docs on this branch — exclude them (they
  // still win/show on branches where their content version matches).
  return [...byNode.values()].map((vs) => resolveNode(resolvable(vs), work, vs)).filter((n) => n.status !== "removed");
}

/** All versions of one node (for the version-aware UI / confirm / fork ops). */
export async function loadNodeVersions(root: string, nodeId: string): Promise<NodeVersion[]> {
  return versionsOf(db(root), nodeId);
}

/**
 * Node ids with at least one version a publish would actually send.
 *
 * One indexed pass rather than `loadNodeVersions` per node, because `sharedHub` runs
 * every dry run on every page load and this answers for the whole store at once.
 *
 * It exists so the COUNT and the PUBLISH can share a predicate. They did not:
 * `publishLocalDocs` counted nodes the sidecar had not seen and then published only
 * versions `notPublishable` allowed, so on a store whose unshared docs are all
 * analyzer output the hub advertised 746 and the button appended nothing — for ever,
 * with no reason on screen. Mirrors `notPublishable`, which refuses `generatedBy`.
 */
export async function nodeIdsWithPublishableVersions(root: string): Promise<Set<string>> {
  const rows = db(root).prepare("SELECT DISTINCT node_id FROM node_versions WHERE generated_by IS NULL")
    .all() as unknown as { node_id: string }[];
  return new Set(rows.map((r) => r.node_id));
}

// A conservative id-safe slug (kept: node ids are still human-facing).
export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "node";
}

/**
 * Rewrite anchor ids across every node version's citations — the migration path for
 * the one-time overload-id change. Returns how many citations moved.
 */
export function remapNodeCitations(root: string, map: Map<string, string>): number {
  if (!map.size) return 0;
  const d = db(root);
  // (g) — a local remap must not rewrite a teammate's citations with THIS build's
  // anchor mapping. Their row is the fold's to write.
  //
  // Filtered in the SELECT, not only fenced in the UPDATE. Fencing alone left the
  // returned COUNT wrong: it tallies citations it intended to move, so a fold row's
  // citations were counted and then silently not written. The fence stays as the
  // second line of defence.
  const rows = d.prepare(`SELECT version_id, citations FROM node_versions WHERE ${LOCAL_ONLY}`)
    .all() as { version_id: string; citations: string }[];
  const upd = d.prepare(localWrite("UPDATE node_versions SET citations=? WHERE version_id=?"));
  let moved = 0;
  d.exec("BEGIN");
  try {
    for (const r of rows) {
      let cites: { anchorId: string }[];
      try { cites = JSON.parse(r.citations ?? "[]"); } catch { continue; }
      let touched = false;
      for (const c of cites) {
        const to = map.get(c.anchorId);
        if (to) { c.anchorId = to; touched = true; moved++; }
      }
      if (touched) upd.run(JSON.stringify(cites), r.version_id);
    }
    d.exec("COMMIT");
  } catch (e) { d.exec("ROLLBACK"); throw e; }
  return moved;
}

const INS_VERSION = "INSERT INTO node_versions(version_id,node_id,type,title,summary,body,generated_by,created_commit,created_branch,created_at,citations) VALUES(?,?,?,?,?,?,?,?,?,?,?)";
const vid = () => "nv_" + randomBytes(6).toString("hex");
const nowISO = () => new Date().toISOString();

/**
 * Upsert a logical node, applying the versioning rules:
 * - generated (analyzer) nodes: one un-versioned record, replaced idempotently.
 * - human nodes: if the winning version is FRESH, edit it in place and merge the
 *   current @work hashes into its citations (a confirm); if it's STALE/DANGLING
 *   (you're editing against drifted/removed code), FORK a new version so the old
 *   branch's version is preserved.
 */
/**
 * `opts.hashes` overrides the hash source used to capture accepted hashes and to
 * pick the winning version. Documenting a pull request needs it: the symbols
 * being described may exist only on that branch, so capturing from @work would
 * record an empty accepted set and the version could never match anything.
 */
export async function writeNode(
  root: string,
  node: LogicalNode,
  opts: { hashes?: AnchorIndex; commit?: string | null; branch?: string | null } = {},
): Promise<void> {
  const d = db(root);
  const all = versionsOf(d, node.id);
  // (b) The generated branch sees only LOCAL rows. `existing.length === 1` is the
  // idempotence check that keeps an unchanged analyzer re-emit from churning, and a
  // teammate's row on the same node id makes it permanently false — so every `check`
  // would delete and re-insert the local row with a fresh random `version_id`: id
  // churn, rowid churn, and a dirty-looking store on every refresh.
  const existing = node.generatedBy ? all.filter((v) => !v.origin) : all;

  if (node.generatedBy) {
    const cites: NodeCitation[] = node.anchors.map((id) => ({ anchorId: id, acceptedHashes: [] }));
    if (existing.length === 1 && existing[0]!.title === node.title && existing[0]!.summary === node.summary &&
        existing[0]!.body === node.body && JSON.stringify(existing[0]!.citations.map((c) => c.anchorId)) === JSON.stringify(node.anchors)) {
      return; // identical re-emit — reuse (no churn)
    }
    d.exec("BEGIN");
    try {
      d.prepare(localWrite("DELETE FROM node_versions WHERE node_id = ?")).run(node.id);
      d.prepare(INS_VERSION).run(vid(), node.id, node.type, node.title, node.summary, node.body, node.generatedBy, null, null, nowISO(), JSON.stringify(cites));
      d.exec("COMMIT");
    } catch (e) { d.exec("ROLLBACK"); throw e; }
    return;
  }

  const work = opts.hashes ?? workHashes(d, root);
  const commit = opts.commit !== undefined ? opts.commit : headCommit(root);
  const branch = opts.branch !== undefined ? opts.branch : currentBranch(root);
  const capture = (ids: string[]): NodeCitation[] => ids.map((id) => ({ anchorId: id, acceptedHashes: work.has(id) ? [work.get(id)!] : [] }));
  const insert = (cites: NodeCitation[]) =>
    d.prepare(INS_VERSION).run(vid(), node.id, node.type, node.title, node.summary, node.body, null, commit, branch, nowISO(), JSON.stringify(cites));

  if (!existing.length) { insert(capture(node.anchors)); return; }

  const { v: winner, e } = selectWinner(resolvable(existing), work);
  // (d) — you cannot edit a teammate's version IN PLACE, so don't try. The fence on
  // the UPDATE below already makes that safe, but safe and silent: it would match
  // zero rows and the caller would be told the edit succeeded. Forking is the honest
  // answer and is what the drifted path already does — your prose becomes your own
  // version and theirs stays theirs. Write-through turns this into a shared write
  // where that is what the caller wanted; until then it is a local fork.
  if (e.status === "fresh" && !winner.origin) {
    // Edit in place + confirm: merge current @work hashes into the citation sets.
    const prev = new Map(winner.citations.map((c) => [c.anchorId, new Set(c.acceptedHashes)]));
    const cites: NodeCitation[] = node.anchors.map((id) => {
      const set = prev.get(id) ?? new Set<string>();
      if (work.has(id)) set.add(work.get(id)!);
      return { anchorId: id, acceptedHashes: [...set] };
    });
    d.prepare(localWrite("UPDATE node_versions SET type=?,title=?,summary=?,body=?,citations=? WHERE version_id=?"))
      .run(node.type, node.title, node.summary, node.body, JSON.stringify(cites), winner.versionId);
  } else {
    // Editing against drifted/removed code → fork; the old version stays for its branch.
    insert(capture(node.anchors));
  }
}

export async function deleteNode(root: string, id: string): Promise<void> {
  db(root).prepare(localWrite("DELETE FROM node_versions WHERE node_id = ?")).run(id);
}

const INS_VERSION_T = "INSERT INTO node_versions(version_id,node_id,type,title,summary,body,generated_by,created_commit,created_branch,created_at,citations,removed) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)";

/**
 * Confirm the winning version is still accurate at the current code WITHOUT
 * forking or editing: merge the current @work hashes into its citations, so a
 * stale doc becomes fresh (and stays valid on the other branches whose hashes are
 * still accepted). Dangling citations can't be confirmed (no live hash) — those
 * need a rewrite or ack-hole.
 */
export async function confirmNode(root: string, id: string): Promise<{ ok?: true; status?: NodeStatus; unconfirmable?: string[]; error?: string }> {
  const d = db(root);
  const versions = versionsOf(d, id);
  if (!versions.length) return { error: `no node "${id}"` };
  const work = workHashes(d, root);
  const { v } = selectWinner(resolvable(versions), work);
  // A fold-owned version is confirmed by an EVENT, not by an in-place UPDATE the
  // ownership fence would silently drop. Refused loudly rather than returning `ok`
  // for a write of zero rows — write-through routes this to `confirmSharedDoc`.
  if (v.origin) {
    return { error: `the version that wins here is a teammate's, and accepting hashes into it `
      + `locally would be reverted by the next fold. Confirm it on the shared copy instead.` };
  }
  if (v.generatedBy) return { error: "generated node — regenerated, not confirmable" };
  if (v.removed) return { error: "node is tombstoned here" };
  // "Nothing to confirm" and "cannot confirm" are different answers. A citation
  // whose id this build cannot derive has no live hash to add, so confirming is a
  // no-op on it forever — and the caller was told only a status. Named, because the
  // UI offers this as the button that clears `unverifiable`, and for this cause it
  // does not. See docs/anchor-id-provenance.md §6.
  const unconfirmable: string[] = [];
  const cites: NodeCitation[] = v.citations.map((c) => {
    const set = new Set(c.acceptedHashes);
    const live = work.get(c.anchorId);
    if (live) set.add(live);
    else if (resolveAnchor(c.anchorId, c.acceptedHashes, work).at === "incomparable") unconfirmable.push(c.anchorId);
    return { anchorId: c.anchorId, acceptedHashes: [...set] };
  });
  // (c) — a confirm on a fold-owned row is `confirmSharedDoc`, an event, not an
  // in-place UPDATE that the next fold silently reverts. Fenced here; routed in the
  // write-through step.
  d.prepare(localWrite("UPDATE node_versions SET citations=? WHERE version_id=?")).run(JSON.stringify(cites), v.versionId);
  return {
    ok: true, status: evalVersion({ ...v, citations: cites }, work).status,
    ...(unconfirmable.length ? { unconfirmable } : {}),
  };
}

/**
 * Ack a hole: the winning version is dangling (cited code removed here) and the
 * removal is correct → write a TOMBSTONE version that wins where those anchors are
 * absent, so the doc disappears from this branch's map while its content version
 * still wins on branches where the code exists.
 */
export interface UnplaceableCitation {
  anchorId: string;
  /** The derivations its accepted hashes were minted under — what this index does not have. */
  marks: string[];
  /** Where a snapshot or the retained set last saw it, when either does. */
  file?: string;
  symbol?: string;
}

export interface AckHoleResult {
  ok?: true;
  removedAnchors?: string[];
  on?: string | null;
  error?: string;
  /** The winning version's status when this refused — the caller's reason to branch. */
  status?: NodeStatus;
  /** Set with `status: "unverifiable"`: what could not be placed, and its address. */
  unplaceable?: UnplaceableCitation[];
  createdCommit?: string | null;
  versionId?: string;
}

export async function ackHole(root: string, id: string): Promise<AckHoleResult> {
  const d = db(root);
  const versions = versionsOf(d, id);
  if (!versions.length) return { error: `no node "${id}"` };
  // (f) THE GATE. `ackHole` does not mutate a fold-owned row — it INSERTs a new local
  // tombstone, which is `origin IS NULL` by construction and so passes the ownership
  // guard entirely. And a tombstone citing absent anchors scores badness 0 while a
  // teammate's content version whose code is absent here scores 1 or more, so it WINS,
  // and `loadNodes` then filters the node out of every surface. An agent thereby
  // achieves locally what `retireSharedDoc`'s person-only rule and `shareDoc`'s
  // refusal of `removed: true` both exist to prevent.
  //
  // Gated on the POOL, not the winner: gating only a fold-owned WINNER still lets the
  // tombstone land while a local version happens to win here, and it would then
  // suppress the teammate's version on every other branch.
  if (versions.some((x) => x.origin && !x.removed)) {
    return {
      error: `node "${id}" carries a teammate's doc, so it is not yours to tombstone here. `
        + `If the subject is gone everywhere, a person retires it with \`retire_shared_doc\`. `
        + `If it is gone only on this branch, leaving it listed as dangling is the honest `
        + `answer — a branch that deletes documented behaviour is exactly the context a raw `
        + `diff hides.`,
    };
  }
  const work = workHashes(d, root);
  const { v, e } = selectWinner(resolvable(versions), work);
  // The guard is on the FACTS, not on the headline status. `evalVersion` ranks
  // dangling over stale over unverifiable, so a version with one absent citation and
  // one incomparable one reads `dangling` — and the tombstone is built from
  // `e.dangling` alone, silently dropping the citation nobody could place. That
  // retires the whole doc on the strength of the comparable subset while the code
  // behind the foreign ids may be sitting right there. No tombstone while ANY
  // citation is unplaceable.
  const ids = e.unverifiable ?? [];
  if (ids.length) {
    // A live citation means the doc still has a subject, whether it matches or has
    // drifted. Refused the way `retireSharedDoc` refuses it, and NOT queued: the
    // answer is a new version, not an investigation.
    const here = v.citations.filter((c) => resolveAnchor(c.anchorId, c.acceptedHashes, work).at === "found");
    if (here.length) {
      return {
        error: `node "${id}" is not a hole here — ${here.length} of ${v.citations.length} cited symbols are still in this checkout, and ${ids.length} cannot be placed by this build at all. That is not a removed subject; write a new version.`,
        status: e.status,
      };
    }
    // Nobody can say whether any of this code is there. The evidence goes back with
    // the refusal so the caller can file the question rather than re-derive it — see
    // docs/anchor-id-provenance.md § "Clearing a doc nobody can place".
    const off = findAnchorsOutsideWork(root, ids);
    const kept = readOrphans(root, ids);
    const accepted = new Map(v.citations.map((c) => [c.anchorId, c.acceptedHashes]));
    return {
      error: `node "${id}" is not a hole here — ${ids.length} of its ${v.citations.length} citations cannot be placed by this build at all (status: ${e.status})`,
      status: e.status,
      versionId: v.versionId,
      createdCommit: v.createdCommit,
      unplaceable: ids.map((aid) => {
        const a = off.get(aid)?.anchor ?? kept.get(aid);
        return {
          anchorId: aid,
          marks: [...new Set((accepted.get(aid) ?? []).map(derivationMark).filter((m): m is string => m !== null))],
          ...(a ? { file: a.file, symbol: a.symbolPath.join(" › ") } : {}),
        };
      }),
    };
  }
  if (e.status !== "dangling") return { error: `node "${id}" is not a hole here (status: ${e.status})`, status: e.status };
  // Carry each dangling citation's accepted hashes onto the tombstone. Same reason
  // as the shared path (`retireSharedDoc`): the removal claim is an inference from
  // absence, and only the derivation these hashes carry says whether this index
  // could have resolved the id in the first place. See docs/anchor-id-provenance.md §6.
  const prior = new Map(v.citations.map((c) => [c.anchorId, c.acceptedHashes]));
  const cites: NodeCitation[] = e.dangling.map((aid) => ({ anchorId: aid, acceptedHashes: [...(prior.get(aid) ?? [])] }));
  const branch = currentBranch(root);
  d.prepare(INS_VERSION_T).run(vid(), id, v.type, v.title, v.summary, v.body, null, headCommit(root), branch, nowISO(), JSON.stringify(cites), 1);
  return { ok: true, removedAnchors: e.dangling, on: branch };
}

// --- graph (edges) -----------------------------------------------------------

interface EdgeRow { from_id: string; to_id: string; type: string; ord: number | null; generated_by: string | null; source_scope?: string | null; }

function rowToEdge(r: EdgeRow): Edge {
  return {
    from: r.from_id,
    to: r.to_id,
    type: r.type as Edge["type"],
    ...(r.ord != null ? { order: r.ord } : {}),
    ...(r.generated_by ? { generatedBy: r.generated_by } : {}),
  };
}

/**
 * Every edge this store answers with: this clone's own, plus the team's.
 *
 * The union, not a merge, and the reason is that an edge has no value to weigh — it
 * exists or it does not. Two people wiring the same node differently is settled by the
 * FOLD before these rows are written (see `shared-graph.ts`), so by the time a reader
 * gets here there is one shared answer per node and this clone's own edges beside it.
 *
 * Deduped on (from, to, type): the same edge drawn by two people is one edge, and
 * without this a shared row and an identical local one would double every count the
 * catalog and matrix show.
 */
export async function readGraph(root: string): Promise<Graph> {
  const rows = db(root).prepare("SELECT from_id,to_id,type,ord,generated_by,source_scope FROM edges")
    .all() as unknown as EdgeRow[];
  const seen = new Set<string>();
  const out: Edge[] = [];
  for (const r of rows) {
    const k = `${r.from_id}\0${r.to_id}\0${r.type}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(rowToEdge(r));
  }
  return { edges: out };
}

/**
 * Replace this clone's own edges FROM these nodes, leaving every other node alone.
 *
 * Per node rather than whole-list, because the unit of a wiring act is one node's
 * outgoing set — and because `writeGraph` rewrites the entire local partition, which is
 * the wrong grain once a publish only covers the nodes you touched.
 */
export async function replaceLocalNodeEdges(root: string, nodeIds: string[], edges: Edge[]): Promise<void> {
  if (!nodeIds.length) return;
  const d = db(root);
  const del = d.prepare("DELETE FROM edges WHERE source_scope IS NULL AND from_id = ?");
  const ins = d.prepare("INSERT INTO edges(from_id,to_id,type,ord,generated_by) VALUES(?,?,?,?,?)");
  d.exec("BEGIN");
  try {
    for (const id of nodeIds) del.run(id);
    for (const e of edges) {
      if (!nodeIds.includes(e.from)) continue;
      ins.run(e.from, e.to, e.type, e.order ?? null, e.generatedBy ?? null);
    }
    d.exec("COMMIT");
  } catch (e) { d.exec("ROLLBACK"); throw e; }
}

/**
 * Drop this clone's own edges from these nodes — the log owns them now.
 *
 * Called after a successful publish, and it is what makes a REMOVAL propagate. Left
 * behind, the publisher's local copy keeps answering on their machine after the shared
 * answer has dropped it, so "I decided the wiring is X" resolves for everybody except
 * the person who decided. Exactly the rule `publishLocalTriage` follows: with a sidecar,
 * the wiring lives in the log and the local partition holds only what has not been
 * published yet.
 */
export async function clearLocalNodeEdges(root: string, nodeIds: string[]): Promise<void> {
  if (!nodeIds.length) return;
  const d = db(root);
  const del = d.prepare("DELETE FROM edges WHERE source_scope IS NULL AND from_id = ?");
  d.exec("BEGIN");
  try { for (const id of nodeIds) del.run(id); d.exec("COMMIT"); }
  catch (e) { d.exec("ROLLBACK"); throw e; }
}

/**
 * The fold's answer for this scope's wiring, from ROWS.
 *
 * Not through the cache. `readTriage` and every ordinary read answer from the table, and
 * so must anything asking the same question — COMPLETENESS is the rule that an ordinary
 * read never folds, and a queue pass that folded would also discard any answer the
 * fingerprint does not currently describe. The fold's job was to have written these.
 *
 * `null` when the scope has no stored verdict or is not `complete`: a blocked scope may
 * not drive writes, because filing from one invents work and resolving from one closes a
 * real divergence that a scope nobody may read simply stopped reporting.
 */
export async function readSharedWiring(root: string, scope: string): Promise<{ nodeId: string; body: string }[] | null> {
  const d = db(root);
  const row = d.prepare("SELECT status FROM shared_scope WHERE scope = ?").get(scope) as { status: string } | undefined;
  if (!row || row.status !== "complete") return null;
  return d.prepare("SELECT node_id AS nodeId, body FROM shared_wiring WHERE scope = ? ORDER BY rowid")
    .all(scope) as unknown as { nodeId: string; body: string }[];
}

/**
 * Every scope whose last fold did NOT reach `complete`, with the reason.
 *
 * Read from the STORED verdict rather than by re-reading shards: materialization writes
 * the status it reached, so this is a table scan instead of a walk over every event byte
 * in the sidecar on every page load. A scope with no row has never been folded here,
 * which is not the same as blocked and is correctly absent.
 */
export async function readBlockedScopes(root: string): Promise<{ scope: string; reason: string }[]> {
  const rows = db(root).prepare("SELECT scope, status, diagnostic FROM shared_scope WHERE status != 'complete'")
    .all() as unknown as { scope: string; status: string; diagnostic: string | null }[];
  return rows.map((r) => {
    let reason = r.status;
    try { reason = r.diagnostic ? (JSON.parse(r.diagnostic).detail ?? r.status) : r.status; } catch { /* keep the status */ }
    return { scope: r.scope, reason };
  });
}

/**
 * Findings per pull request, counted in SQL.
 *
 * One grouped query rather than a fold per scope: the table IS the projection, it holds
 * local rows as well as the team's, and counting only the scopes on disk would miss a
 * finding filed on a machine with no sidecar.
 */
export async function findingCountsByPr(root: string): Promise<{ pr: string; total: number; waiting: number; unshared: number }[]> {
  return (db(root).prepare(
    "SELECT pr, COUNT(*) AS total, SUM(needs_ack) AS waiting, "
    + "SUM(CASE WHEN source_scope IS NULL THEN 1 ELSE 0 END) AS mine "
    + "FROM findings GROUP BY pr",
  ).all() as unknown as { pr: string; total: number; waiting: number; mine: number }[])
    .map((r) => ({ pr: r.pr, total: Number(r.total), waiting: Number(r.waiting), unshared: Number(r.mine) }));
}

/**
 * Walkthroughs written HERE and not yet published — what `publishLocalWalkthroughs` sends.
 *
 * `total` is every local row and `ready` only the ones that parse, and the CALLER REPORTS
 * BOTH. The gap between them is the only signal that a row is unreadable: an unreadable
 * one is counted rather than made fatal, so collapsing these to one number would make a
 * corrupt walkthrough silently indistinguishable from one that was never written.
 */
export async function readUnpublishedWalkthroughs(root: string): Promise<{ total: number; ready: { pr: string; walkthrough: PrWalkthrough }[] }> {
  const rows = db(root).prepare(
    "SELECT pr, body FROM walkthroughs WHERE source_scope IS NULL ORDER BY pr",
  ).all() as unknown as { pr: string; body: string }[];
  const ready: { pr: string; walkthrough: PrWalkthrough }[] = [];
  for (const r of rows) {
    try {
      const env = JSON.parse(r.body) as { walkthrough?: PrWalkthrough };
      if (env?.walkthrough) ready.push({ pr: r.pr, walkthrough: env.walkthrough });
    } catch { /* counted in `total`, not published */ }
  }
  return { total: rows.length, ready };
}

/** This clone's OWN edges. What every WRITER must read before it writes. */
export async function readLocalGraph(root: string): Promise<Graph> {
  const rows = db(root).prepare("SELECT from_id,to_id,type,ord,generated_by FROM edges WHERE source_scope IS NULL")
    .all() as unknown as EdgeRow[];
  return { edges: rows.map(rowToEdge) };
}

/**
 * Replace this clone's OWN edges. NEVER a teammate's.
 *
 * `WHERE source_scope IS NULL` is the whole point, and this function is exactly the
 * shape that bit triage: a whole-list rewrite that was correct while every row was
 * local and destructive the moment one is not. A bare `DELETE FROM edges` would take
 * rows only the fold may own, with no event recording it, and the next fold would put
 * them back — so the damage appears and disappears depending on when you look.
 */
export async function writeGraph(root: string, graph: Graph): Promise<void> {
  const d = db(root);
  const ins = d.prepare("INSERT INTO edges(from_id,to_id,type,ord,generated_by) VALUES(?,?,?,?,?)");
  d.exec("BEGIN");
  try {
    d.prepare("DELETE FROM edges WHERE source_scope IS NULL").run();
    for (const e of graph.edges) ins.run(e.from, e.to, e.type, e.order ?? null, e.generatedBy ?? null);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

// --- bugs ------------------------------------------------------------------
//
// One canonical table, so a teammate's bug and this machine's are the same row shape
// and every surface above reads them together. `origin` is what separates them, and
// the ownership rule (docs/sidecar-architecture.md) is stated on it: a row with one is
// written ONLY by the fold.

export interface BugStore {
  schemaVersion: number;
  bugs: SharedBug[];
}

/** Every bug this store holds — this machine's and the team's, in one list. */
export async function readBugs(root: string): Promise<BugStore> {
  const rows = db(root).prepare("SELECT body, source_scope FROM bugs ORDER BY created_at, id")
    .all() as unknown as { body: string; source_scope: string | null }[];
  const bugs: SharedBug[] = [];
  for (const r of rows) {
    try {
      const b = JSON.parse(r.body) as SharedBug;
      // Set by the STORE and never by the fold, exactly as a shared doc carries it:
      // the fold's output describes the bug, not where this machine's copy came from.
      if (r.source_scope) b.origin = { scope: r.source_scope };
      bugs.push(b);
    } catch { /* a row this build cannot parse is not a reason to fail every bug read */ }
  }
  return { schemaVersion: SCHEMA_VERSION, bugs };
}

/** One bug by id, without deserializing the rest. */
export async function readBug(root: string, id: string): Promise<SharedBug | null> {
  const row = db(root).prepare("SELECT body, source_scope FROM bugs WHERE id = ?").get(id) as
    { body: string; source_scope: string | null } | undefined;
  if (!row) return null;
  try {
    const b = JSON.parse(row.body) as SharedBug;
    if (row.source_scope) b.origin = { scope: row.source_scope };
    return b;
  } catch { return null; }
}

const bugRow = (b: SharedBug): unknown[] => [
  b.id, b.title, b.state, b.severity, b.author.principal, b.createdAt,
  needsHumanAck(b) ? 1 : 0, b.contested?.length ? 1 : 0, b.tracking.length ? 1 : 0,
  // `origin` is never written from here — this path only ever writes local rows.
  JSON.stringify({ ...b, origin: undefined }),
];

/**
 * Write one LOCAL bug. Refuses a fold-owned row.
 *
 * The refusal is the ownership rule made mechanical rather than remembered. A local
 * mutation of a projection row is quiet in a specific way: nothing about it moves the
 * scope fingerprint, so the cache keeps serving the corrupted row until something else
 * forces a re-fold, and then the change vanishes. An error at the call site is the only
 * version of that anybody can debug.
 */
export async function writeLocalBug(root: string, bug: SharedBug): Promise<void> {
  const d = db(root);
  const owner = d.prepare("SELECT source_scope FROM bugs WHERE id = ?").get(bug.id) as { source_scope: string | null } | undefined;
  if (owner?.source_scope) {
    throw new Error(
      `${bug.id} is owned by the sidecar fold (${owner.source_scope}) — write an event, not a row. `
      + `Local edits to a folded bug are erased by the next sync and invisible until then.`,
    );
  }
  d.prepare(
    "INSERT OR REPLACE INTO bugs(id,title,state,severity,author,created_at,needs_ack,contested,tracked,body) "
    + "VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run(...bugRow(bug) as any);
}

/**
 * Replace this clone's own bugs. NEVER a teammate's.
 *
 * `WHERE source_scope IS NULL` for the reason `replaceLocalTriage` gives: a bare
 * `DELETE FROM bugs` would take rows only the fold may own, with no event recording it,
 * and the next fold would put them back — so the damage appears and disappears
 * depending on when you look.
 */
export async function writeLocalBugs(root: string, bugs: SharedBug[]): Promise<void> {
  const d = db(root);
  const ins = d.prepare(
    "INSERT INTO bugs(id,title,state,severity,author,created_at,needs_ack,contested,tracked,body) "
    + "VALUES(?,?,?,?,?,?,?,?,?,?)",
  );
  d.exec("BEGIN");
  try {
    d.prepare("DELETE FROM bugs WHERE source_scope IS NULL").run();
    for (const b of bugs) ins.run(...bugRow(b) as any);
    d.exec("COMMIT");
  } catch (e) { d.exec("ROLLBACK"); throw e; }
}

// --- findings, the canonical table -------------------------------------------

export interface FindingStore {
  schemaVersion: number;
  findings: SharedFinding[];
}

/**
 * Set the two fields the STORE owns and the fold never produces.
 *
 * `pr` and `origin` are row facts: the fold's output describes the finding, not this
 * clone's provenance for it or which scope carries it. Writing them into the JSON
 * would make `read(write(x))` return a value the fold never emitted, which is the
 * projection round-trip contract `materialize.test.ts` asserts.
 */
const hydrate = (body: string, pr: string, sourceScope: string | null): SharedFinding | null => {
  try {
    const f = JSON.parse(body) as SharedFinding;
    f.pr = pr;
    if (sourceScope) f.origin = { scope: sourceScope };
    return f;
  } catch { return null; }
};

/**
 * Every finding this store holds — this machine's and the team's, in one list.
 *
 * The whole point of the canonical table: no caller has to know whether a finding came
 * from the sidecar or was filed here with none configured, and none of them needs a
 * bridge to see both. `pr` narrows without deserializing the rest, because it is a
 * column rather than something inferred from a worklist.
 */
export async function readFindings(root: string, opts: { pr?: number | string } = {}): Promise<FindingStore> {
  const where = opts.pr === undefined ? "" : " WHERE pr = ?";
  const args = opts.pr === undefined ? [] : [String(opts.pr)];
  const rows = db(root).prepare(
    `SELECT pr, body, source_scope FROM findings${where} ORDER BY created_at, id`,
  ).all(...args as []) as unknown as { pr: string; body: string; source_scope: string | null }[];
  const findings: SharedFinding[] = [];
  for (const r of rows) {
    const f = hydrate(r.body, r.pr, r.source_scope);
    // A row this build cannot parse is not a reason to fail every finding read.
    if (f) findings.push(f);
  }
  return { schemaVersion: SCHEMA_VERSION, findings };
}

/**
 * One finding, without deserializing the rest.
 *
 * `pr` is part of the identity, not an optional narrowing: `ix_findings_identity` is
 * UNIQUE on `(pr, id)` precisely because one id can exist in two pull requests, and a
 * test in `materialize.test.ts` exists to keep that true. So an id alone can be
 * ambiguous, and an unordered pick among the matches is the shape that returns one
 * caller's finding to another. Omitting `pr` is allowed for a caller that genuinely
 * has only an id, and REFUSED rather than guessed when it turns out not to be unique.
 */
/**
 * Ids that START with this prefix, across findings and bugs.
 *
 * A finding renders as `f_00mt8zvn7m-cc017f2546` and the prefix alone is the natural
 * thing to copy — it is the distinctive half, and the suffix looks like a checksum. It
 * failed as `no finding or annotation "f_00mt8zvn7m"`, which says the record does not
 * exist. It does; the id is half of one. Cost an agent four failed calls before it
 * spotted the pattern (`docs/mcp-complaints.md` § workflow-issues §3).
 *
 * Returns the matches rather than resolving, because a prefix that matches two records
 * must not silently pick one — the caller says "did you mean", which is the answer that
 * is useful whether it matched one or several.
 *
 * Capped: a one-character prefix matches everything, and a suggestion listing 200 ids is
 * not a suggestion.
 */
export function idsStartingWith(root: string, prefix: string, limit = 5): string[] {
  if (prefix.length < 6) return [];        // shorter than this is not a truncated id
  const like = prefix.replace(/[%_\\]/g, "\\$&") + "%";
  const d = db(root);
  const rows = [
    ...d.prepare("SELECT id FROM findings WHERE id LIKE ? ESCAPE '\\' LIMIT ?").all(like, limit + 1),
    ...d.prepare("SELECT id FROM bugs WHERE id LIKE ? ESCAPE '\\' LIMIT ?").all(like, limit + 1),
  ] as unknown as { id: string }[];
  return [...new Set(rows.map((r) => r.id))].slice(0, limit);
}

export async function readFinding(
  root: string, id: string, opts: { pr?: number | string } = {},
): Promise<SharedFinding | null> {
  const d = db(root);
  if (opts.pr !== undefined) {
    const row = d.prepare("SELECT pr, body, source_scope FROM findings WHERE pr = ? AND id = ?")
      .get(String(opts.pr), id) as { pr: string; body: string; source_scope: string | null } | undefined;
    return row ? hydrate(row.body, row.pr, row.source_scope) : null;
  }
  const rows = d.prepare("SELECT pr, body, source_scope FROM findings WHERE id = ?").all(id) as unknown as
    { pr: string; body: string; source_scope: string | null }[];
  if (!rows.length) return null;
  if (rows.length > 1) {
    throw new Error(
      `${id} is a finding on more than one pull request (${rows.map((r) => r.pr).join(", ")}) — pass \`pr\` to say which`,
    );
  }
  return hydrate(rows[0]!.body, rows[0]!.pr, rows[0]!.source_scope);
}

/**
 * The team's notes, across every bucket of one universe.
 *
 * Reads the PROJECTION, never the log. `notesForTarget` folds one bucket because a
 * write path needs the freshest state at the moment it appends; a query path must not,
 * and folding all 256 buckets to answer "what questions are open" is exactly the
 * NDJSON-on-a-read that `sharedSync`'s materialization exists to have ended.
 *
 * Rows can therefore be behind a log nobody has synced. That is the same contract every
 * other canonical read has, and the honest one: a note nobody pulled is a note this
 * machine has not been told about.
 */
export async function readSharedNotes(
  root: string, universe: string, opts: { kind?: NoteKind; targetId?: string; id?: string } = {},
): Promise<SharedNote[]> {
  // The scope prefix is the universe filter. `notes/<universe>/<bucket>` — anchored with
  // the trailing slash so `acme/api` cannot match `acme/api-legacy`.
  const args: unknown[] = [`notes/${universe}/%`];
  let sql = "SELECT body FROM shared_note WHERE scope LIKE ?";
  if (opts.kind) { sql += " AND kind = ?"; args.push(opts.kind); }
  if (opts.targetId) { sql += " AND target_id = ?"; args.push(opts.targetId); }
  // For a single-id lookup: without it, resolving one note hydrates every note blob in
  // the universe to find it.
  if (opts.id) { sql += " AND id = ?"; args.push(opts.id); }
  const out: SharedNote[] = [];
  for (const r of db(root).prepare(sql + " ORDER BY created_at, id").all(...args as []) as unknown as { body: string }[]) {
    // A row this build cannot parse is not a reason to fail every note read — the
    // rule `readFindings` follows, for the same reason.
    try { out.push(JSON.parse(r.body) as SharedNote); } catch { /* skip */ }
  }
  return out;
}

const findingRow = (f: SharedFinding, pr: string): unknown[] => [
  f.id, pr, f.target.kind, f.target.id, f.state,
  f.severity ?? null, f.category ?? null, f.line ?? null,
  f.author.principal, f.createdAt,
  findingNeedsAck(f) ? 1 : 0, f.contested?.length ? 1 : 0,
  // Never written from here — this path only ever writes local rows.
  JSON.stringify({ ...f, origin: undefined, pr: undefined }),
];

/**
 * Write one LOCAL finding — what filing with no sidecar configured leaves behind.
 *
 * Refuses a fold-owned row, and the refusal is the ownership rule made mechanical
 * rather than remembered. A local mutation of a projection row is quiet in a specific
 * way: nothing about it moves the scope fingerprint, so the cache keeps serving the
 * corrupted row until something else forces a re-fold, and then the change vanishes.
 * An error at the call site is the only version of that anybody can debug.
 */
export async function writeLocalFinding(root: string, f: SharedFinding, pr: number | string): Promise<void> {
  const d = db(root);
  const owner = d.prepare("SELECT source_scope FROM findings WHERE id = ? AND source_scope IS NOT NULL")
    .get(f.id) as { source_scope: string } | undefined;
  if (owner) {
    throw new Error(
      `${f.id} is owned by the sidecar fold (${owner.source_scope}) — write an event, not a row. `
      + `Local edits to a folded finding are erased by the next sync and invisible until then.`,
    );
  }
  d.prepare(
    "INSERT OR REPLACE INTO findings(id,pr,target_kind,target_id,state,severity,category,line,"
    + "author,created_at,needs_ack,contested,body) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(...findingRow(f, String(pr)) as any);
}

// --- small JSON-blob stores (annotations / coverage / analyzers / reviews) ---

export async function readAnnotations(root: string): Promise<AnnotationStore> {
  return getMeta<AnnotationStore>(db(root), "annotations") ?? { schemaVersion: SCHEMA_VERSION, annotations: [] };
}

export async function writeAnnotations(root: string, annotations: Annotation[]): Promise<void> {
  setMeta(db(root), "annotations", { schemaVersion: SCHEMA_VERSION, annotations });
}

export async function readCoverage(root: string): Promise<CoverageStore> {
  return getMeta<CoverageStore>(db(root), "coverage") ?? { schemaVersion: SCHEMA_VERSION, rules: [] };
}

export async function writeCoverage(root: string, rules: CoverageRule[]): Promise<void> {
  setMeta(db(root), "coverage", { schemaVersion: SCHEMA_VERSION, rules });
}

export async function readAnalyzers(root: string): Promise<AnalyzerConfig> {
  return getMeta<AnalyzerConfig>(db(root), "analyzers") ?? { schemaVersion: SCHEMA_VERSION, enabled: [], lastEmit: {} };
}

export async function writeAnalyzers(root: string, config: AnalyzerConfig): Promise<void> {
  setMeta(db(root), "analyzers", config);
}

export async function readReviews(root: string): Promise<ReviewStore> {
  return getMeta<ReviewStore>(db(root), "reviews") ?? { schemaVersion: SCHEMA_VERSION, reviews: [] };
}

export async function writeReviews(root: string, reviews: Review[]): Promise<void> {
  setMeta(db(root), "reviews", { schemaVersion: SCHEMA_VERSION, reviews });
}

// --- triage: one canonical table, one row per (target, field) ----------------------
//
// `docs/shared-triage.md` is normative. The shape here is the part that has to be right
// before anything is shared: a teammate's stakes are an ordinary row carrying an
// `origin`, and a LOCAL WRITE MAY NEVER REACH ONE. That is why the reader and the
// writers are different functions rather than one pair — every existing write path is a
// read-modify-write of the whole list, so handing them the merged view and letting them
// write it back would copy a teammate's row into the local partition, where the next
// fold would produce it again alongside.

interface TriageRow {
  target_kind: string; target_id: string; field: string; value: string;
  source: string; likely: number; generated_by: string | null; reason: string | null;
  at: string; actor: string | null; asserted_commit: string | null; witnesses: string;
  origin: string | null; source_scope: string | null;
}

const TRIAGE_COLS = "target_kind,target_id,field,value,source,likely,generated_by,reason,at,"
  + "actor,asserted_commit,witnesses,origin,source_scope";

/**
 * Per-field rows back into the `Triage` records callers expect.
 *
 * The record-level `source`, `likely`, `reason` and `at` come from the IMPORTANCE row.
 * That is the documented alias, not an accident: a record whose importance is a human's
 * and whose complexity is an agent's has no single truthful value for any of them, and
 * importance is the field the rest refine. Anything needing the real provenance of a
 * given field reads the rows.
 */
/**
 * `likely` — true when any EFFECTIVE field is agent-supplied.
 *
 * One function because there were two readers computing it differently: `triageOf`
 * derived it and `triageFromRows` took the importance row's flag, so a human mark whose
 * complexity an agent raised read as `likely` through one path and confirmed through
 * the other.
 */
export const likelyOf = (rows: ({ likely: number | boolean } | undefined)[]): boolean =>
  rows.some((r) => !!r?.likely);

/**
 * The worse of two values for a field — higher stakes, deeper verification, armed.
 *
 * An unknown field or value answers with the team's, because inventing an order for
 * something this build does not understand is how a merge rule starts making things up.
 */
function pessimistic(field: string, theirs: string, yours: string): string {
  if (field === "tripwire") return theirs === "1" || yours === "1" ? "1" : "0";
  const rank = field === "importance" ? IMPORTANCE_RANK : field === "complexity" ? COMPLEXITY_RANK : null;
  if (!rank) return theirs;
  const a = (rank as Record<string, number>)[theirs], b = (rank as Record<string, number>)[yours];
  if (a === undefined || b === undefined) return theirs;
  return b > a ? yours : theirs;
}

function triageFromRows(rows: TriageRow[]): Triage[] {
  const byTarget = new Map<string, TriageRow[]>();
  for (const r of rows) {
    const k = `${r.target_kind}\0${r.target_id}`;
    const acc = byTarget.get(k); if (acc) acc.push(r); else byTarget.set(k, [r]);
  }
  const out: Triage[] = [];
  for (const group of byTarget.values()) {
    const imp = group.find((r) => r.field === "importance");
    // No importance is not a mark. Nothing else can stand in for it: `complexity` alone
    // has no stakes to weigh, which is exactly what the ratchet refuses to invent.
    if (!imp) continue;
    const cx = group.find((r) => r.field === "complexity");
    const tw = group.find((r) => r.field === "tripwire");
    const wit = (r: TriageRow | undefined): BugWitness[] => {
      try { return JSON.parse(r?.witnesses || "[]") as BugWitness[]; } catch { return []; /* keep the mark */ }
    };
    const witnesses = wit(imp);
    out.push({
      target: { kind: imp.target_kind as "node" | "anchor", id: imp.target_id },
      importance: imp.value as Importance,
      ...(cx ? { complexity: cx.value as Complexity } : {}),
      // DERIVED, exactly as `triageOf` derives it: true when ANY effective field is
      // agent-supplied. Taken off the importance row alone, a human's stakes refined by
      // an agent's complexity read as a confirmed human mark. One rule, two readers, and
      // they must not disagree — `likelyOf` is the rule.
      likely: likelyOf([imp, cx]),
      ...(tw ? { tripwire: tw.value === "1" } : {}),
      source: imp.source as TriageSource,
      ...(imp.generated_by ? { generatedBy: imp.generated_by } : {}),
      ...(imp.reason ? { reason: imp.reason } : {}),
      at: imp.at,
      witnesses,
      // PER FIELD. `witnesses` above is the importance receipt's, kept as the alias the
      // compatibility surface documents — but a tripwire armed against one body and an
      // importance witnessed against another are two facts, and asking a record-wide
      // question of one field's array is the compound-value bug this table exists to
      // end. `triageDrift`, `tripwires` and `deriveTriage` read these.
      axes: {
        importance: { source: imp.source as TriageSource, likely: !!imp.likely, witnesses, at: imp.at },
        ...(cx ? { complexity: { source: cx.source as TriageSource, likely: !!cx.likely, witnesses: wit(cx), at: cx.at } } : {}),
        ...(tw ? { tripwire: { source: tw.source as TriageSource, likely: !!tw.likely, witnesses: wit(tw), at: tw.at } } : {}),
      },
    });
  }
  return out;
}

/** One `Triage` as its per-field rows, all sharing the record's receipt. */
function triageToRows(t: Triage): [string, string, string, string, string, number, string | null, string | null, string, string][] {
  const receipt = [
    t.source, t.likely ? 1 : 0, t.generatedBy ?? null, t.reason ?? null,
    t.at, JSON.stringify(t.witnesses ?? []),
  ] as const;
  const rows: any[] = [[t.target.kind, t.target.id, "importance", String(t.importance), ...receipt]];
  if (t.complexity) rows.push([t.target.kind, t.target.id, "complexity", String(t.complexity), ...receipt]);
  // Only when SET — `undefined` means nobody has said, and an invented `false` is an
  // alarm silently turned off.
  if (t.tripwire !== undefined) rows.push([t.target.kind, t.target.id, "tripwire", t.tripwire ? "1" : "0", ...receipt]);
  return rows;
}

/**
 * Every mark this store answers with: the team's, and this clone's where the team has
 * nothing to say.
 *
 * What every READER wants. Nothing folds a log here — these are rows, so `COMPLETENESS`
 * still holds; the fold's job is to have written the shared rows at sync time.
 *
 * **Coverage is per TARGET, and where the log covers a target it is the whole answer.**
 *
 * Per target, not per field, and the difference is not academic. Merging per field lets
 * a local `{low, deep}` meet a shared `{business-critical}` and produce shared
 * importance beside local complexity — a pair NEITHER party ever asserted, assembled by
 * the reader. A mark is one act; a target the log covers is answered by the log.
 *
 * The log wins because it is authoritative. Your own published marks are events, so the
 * fold has already weighed them against everyone else's — including a teammate lowering
 * something you raised, having SEEN it. A local row outranking that would silently
 * reinstate the value they superseded, on your machine only.
 *
 * **Covered means the fold had something ADMISSIBLE to say** — a mark, or an absence a
 * person asserted (the `@absent` tombstone). Not merely "the log mentions this target":
 * a complexity-only agent claim is refused by the ratchet precisely because an agent may
 * not invent stakes, and letting that refused event count as coverage would suppress a
 * human's local `business-critical` — the same lowering, by the back door.
 *
 * **Where both have something to say, merge PESSIMISTICALLY and flag it.** Taking the
 * log's answer wholesale hid a local `deep` that the team's importance-only mark never
 * contradicted, and consumers then fell back to `standard` — a review bar quietly
 * lowered by a merge rule. Taking the higher of each field is the same asymmetry the
 * fold already applies to concurrent divergence, so the system has one rule and not two:
 * over-reviewing costs minutes, under-reviewing costs the thing this exists to prevent.
 *
 * The flag is what keeps that honest. The merged record is the SAFE reading rather than
 * anybody's assertion, so `divergence` names every field where the two disagree and the
 * surfaces show it. Publishing yours, or adopting theirs, is what ends it.
 *
 * What is left is the honest gap: a target the log has no admissible answer for, which
 * a local row fills. `publishLocalTriage` is how it stops being a gap — an explicit
 * attributed act, as `publishLocalDocs` is, because a legacy `Triage` carries a `source`
 * but no `Actor` and publishing it automatically would attribute every historical
 * judgment to whoever upgraded first.
 */
export async function readTriage(root: string): Promise<TriageStore> {
  const rows = db(root).prepare(`SELECT ${TRIAGE_COLS} FROM triage`).all() as unknown as TriageRow[];
  const covered = new Set(rows.filter((r) => r.source_scope !== null)
    .map((r) => `${r.target_kind}\0${r.target_id}`));
  const merged: TriageRow[] = [];
  /** target -> the fields where this clone and the team disagree. */
  const diverged = new Map<string, NonNullable<Triage["divergence"]>>();

  const byTarget = new Map<string, TriageRow[]>();
  for (const r of rows) {
    const k = `${r.target_kind}\0${r.target_id}`;
    const acc = byTarget.get(k); if (acc) acc.push(r); else byTarget.set(k, [r]);
  }
  for (const [k, group] of byTarget) {
    if (!covered.has(k)) { merged.push(...group); continue; }   // the log has nothing to say
    const shared = group.filter((r) => r.source_scope !== null);
    const local = new Map(group.filter((r) => r.source_scope === null).map((r) => [r.field, r]));
    if (!local.size) { merged.push(...shared); continue; }      // nothing of this clone's to weigh
    const sharedFields = new Set(shared.map((r) => r.field));
    for (const r of shared) {
      const mine = local.get(r.field);
      if (!mine) { merged.push(r); continue; }
      const worse = pessimistic(r.field, r.value, mine.value);
      if (worse !== r.value) {
        // Keep the team's RECEIPT with this clone's value: the row is the safe reading,
        // and `divergence` says so rather than dressing it up as somebody's assertion.
        merged.push({ ...r, value: worse });
      } else merged.push(r);
      if (r.value !== mine.value) {
        const d = diverged.get(k) ?? [];
        d.push({ field: r.field as "importance" | "complexity" | "tripwire", yours: mine.value, theirs: r.value });
        diverged.set(k, d);
      }
    }
    // A field only this clone has said anything about. Nothing contradicts it.
    for (const [field, r] of local) if (!sharedFields.has(field) && field !== ABSENT_FIELD) merged.push(r);
  }

  const triage = triageFromRows(merged);
  for (const t of triage) {
    const d = diverged.get(`${t.target.kind}\0${t.target.id}`);
    if (d?.length) t.divergence = d;
  }
  return { schemaVersion: SCHEMA_VERSION, triage };
}

/**
 * Every target the LOG answers, as `kind\0id` — a mark or an asserted absence.
 *
 * Rows, not a fold. `readTriage` answers from the table and so must anything asking the
 * same question, or the two disagree about what is covered; and `COMPLETENESS` is the
 * rule that an ordinary read never folds. The fold's job was to have written these at
 * sync time.
 */
export async function coveredTriageTargets(root: string): Promise<Map<string, string>> {
  const rows = db(root).prepare(
    "SELECT target_kind, target_id, field, value FROM triage WHERE source_scope IS NOT NULL",
  ).all() as unknown as { target_kind: string; target_id: string; field: string; value: string }[];
  const out = new Map<string, string>();
  for (const r of rows) {
    const k = `${r.target_kind}\0${r.target_id}`;
    if (r.field === "importance") out.set(k, r.value);
    else if (!out.has(k)) out.set(k, r.field === ABSENT_FIELD ? "cleared by the team" : r.value);
  }
  return out;
}

/** This clone's OWN marks. What every WRITER must read before it writes. */
export async function readLocalTriage(root: string): Promise<TriageStore> {
  const rows = db(root).prepare(`SELECT ${TRIAGE_COLS} FROM triage WHERE source_scope IS NULL`)
    .all() as unknown as TriageRow[];
  return { schemaVersion: SCHEMA_VERSION, triage: triageFromRows(rows) };
}

/**
 * Replace this clone's own marks. NEVER a teammate's.
 *
 * `WHERE source_scope IS NULL` is the whole point: a bare `DELETE FROM triage` would
 * take rows only the fold may own, with no event recording it, and the next fold would
 * put them back — so the damage appears and disappears depending on when you look.
 */
export async function replaceLocalTriage(root: string, triage: Triage[]): Promise<void> {
  const d = db(root);
  const ins = d.prepare(
    "INSERT OR REPLACE INTO triage(target_kind,target_id,field,value,source,likely,generated_by,"
    + "reason,at,witnesses) VALUES(?,?,?,?,?,?,?,?,?,?)",
  );
  d.exec("BEGIN");
  try {
    d.prepare("DELETE FROM triage WHERE source_scope IS NULL").run();
    for (const t of triage) for (const row of triageToRows(t)) ins.run(...row as any);
    d.exec("COMMIT");
  } catch (e) { d.exec("ROLLBACK"); throw e; }
}

/**
 * Kept as the old name, and it is the LOCAL writer.
 *
 * Every existing caller means "my own marks" — there were no others when they were
 * written. Keeping the name means the 18 call sites do not all move in the same change
 * that moves the storage, which is how the JSON→SQLite migration stayed reviewable.
 */
export const writeTriage = replaceLocalTriage;

/**
 * Replace only the local GRAPH rows, leaving human and agent marks alone.
 *
 * `deriveTriage` regenerates graph output by dropping and rebuilding it, which is safe
 * while everything is local and destructive the moment it is not: the whole-list rewrite
 * it does today would write a teammate's human mark back as a local row. Graph output is
 * also the one kind that never travels, precisely because it is regenerated per machine.
 */
export async function replaceLocalGraphTriage(root: string, triage: Triage[]): Promise<void> {
  const d = db(root);
  const ins = d.prepare(
    "INSERT OR REPLACE INTO triage(target_kind,target_id,field,value,source,likely,generated_by,"
    + "reason,at,witnesses) VALUES(?,?,?,?,?,?,?,?,?,?)",
  );
  d.exec("BEGIN");
  try {
    d.prepare("DELETE FROM triage WHERE source_scope IS NULL AND source = 'graph'").run();
    for (const t of triage) {
      if (t.source !== "graph") continue;
      for (const row of triageToRows(t)) ins.run(...row as any);
    }
    d.exec("COMMIT");
  } catch (e) { d.exec("ROLLBACK"); throw e; }
}

/** One target's local mark, replacing whatever was there for it. */
export async function upsertLocalTriage(root: string, t: Triage): Promise<void> {
  const d = db(root);
  const ins = d.prepare(
    "INSERT OR REPLACE INTO triage(target_kind,target_id,field,value,source,likely,generated_by,"
    + "reason,at,witnesses) VALUES(?,?,?,?,?,?,?,?,?,?)",
  );
  d.exec("BEGIN");
  try {
    // By TARGET, not by field: a mark that loses its complexity must lose the row, or the
    // old value survives under a receipt that no longer mentions it.
    d.prepare("DELETE FROM triage WHERE source_scope IS NULL AND target_kind = ? AND target_id = ?")
      .run(t.target.kind, t.target.id);
    for (const row of triageToRows(t)) ins.run(...row as any);
    d.exec("COMMIT");
  } catch (e) { d.exec("ROLLBACK"); throw e; }
}

/**
 * What has already been published to a pull request, keyed by PR number.
 *
 * A comment posted to GitHub cannot be un-posted cheaply, and re-running a push
 * would otherwise duplicate every finding on the PR. Kept as a meta blob (like
 * triage) rather than a column on Annotation: it is a record of an outward
 * action, not a property of the claim.
 */
export interface PushRecord { annotationIds: string[]; viewedPaths: string[]; at: string; reviewUrl?: string }
export type PushStore = { schemaVersion: number; pushes: Record<string, PushRecord> };

export async function readPushes(root: string): Promise<PushStore> {
  return getMeta<PushStore>(db(root), "pr_push") ?? { schemaVersion: SCHEMA_VERSION, pushes: {} };
}

/**
 * Walkthroughs of one pull request — this store's own and the team's, one row each.
 *
 * ONE canonical table, so a teammate's reading is an ordinary row with an `origin`
 * rather than something a surface has to go and look for somewhere else. It used to be
 * two stores: a `meta` blob keyed by pull request (yours) and `shared_walkthrough`
 * (theirs), and every surface read the first — so a walkthrough that had travelled,
 * folded and landed in the reader's own database was invisible on the page that renders
 * one. `docs/sidecar-architecture.md` gives the rule; this is it applied.
 *
 * `mine` is by PRINCIPAL, not by `origin`: publishing your own walkthrough sets an
 * origin on your row (the fold adopts it), so origin means "came via the log" and never
 * "somebody else's".
 */
export interface StoredWalkthrough {
  walkthrough: PrWalkthrough;
  /** The principal who wrote it. Empty on a row migrated from the legacy blob. */
  author: string;
  /** When it entered the record — the event's time for a folded row. */
  at: string;
  /** Where this machine's copy came from. Absent means written here and not published. */
  origin?: { scope: string };
}

export async function readWalkthroughsFor(root: string, pr: number | string): Promise<StoredWalkthrough[]> {
  const rows = db(root).prepare(
    "SELECT author, source_scope, body FROM walkthroughs WHERE pr = ? ORDER BY ord, rowid",
  ).all(String(pr)) as unknown as { author: string; source_scope: string | null; body: string }[];
  const out: StoredWalkthrough[] = [];
  for (const r of rows) {
    // A row this build cannot parse is skipped rather than fatal, the rule the fold
    // uses: a walkthrough list that will not load is worse than one missing a reading.
    let env: { walkthrough?: PrWalkthrough; at?: string } | null = null;
    try { env = JSON.parse(r.body) as { walkthrough?: PrWalkthrough; at?: string }; } catch { continue; }
    if (!env?.walkthrough) continue;
    out.push({
      walkthrough: env.walkthrough,
      author: r.author,
      at: env.at ?? env.walkthrough.at,
      ...(r.source_scope ? { origin: { scope: r.source_scope } } : {}),
    });
  }
  return out;
}

/**
 * Record this store's own walkthrough of a pull request.
 *
 * One local row per pull request, which is exactly what the blob enforced by being a
 * `Record<pr, …>` — re-walking replaces your reading, it does not accumulate one per
 * attempt. Rows the FOLD owns are never touched: they may only change by an event.
 *
 * `author` is resolved but not required. Writing a walkthrough is not a write that
 * carries attribution — a store with no identity can still map its own pull requests —
 * and the empty principal is the sentinel a legacy row already uses. What it cannot do
 * is publish, which is what makes an unattributed row safe: nothing can adopt it.
 */
export async function writeLocalWalkthrough(
  root: string, pr: string, w: PrWalkthrough,
): Promise<{ ok: true } | { error: string }> {
  const actor = resolveActor(root);
  const author = actor?.principal ?? "";
  // A reading you have PUBLISHED is the fold's row, and a fold-owned row may only be
  // changed by an event. Re-walking it is therefore a publication, not a local write —
  // which is also the honest product answer: a re-walk that stayed local would leave the
  // team reading the version the submitter's push already invalidated. Refused here, in
  // words, because the alternative was a raw `UNIQUE constraint failed` reaching the
  // caller on the third step of the only lifecycle a walkthrough has.
  if (author && foldOwnsWalkthrough(root, pr, author)) {
    return {
      error: `PR #${pr}'s walkthrough is already published, so re-walking it is a publication rather than a local write. `
        + "Publish the new reading — `pr_walkthrough` does that as it writes.",
    };
  }
  const d = db(root);
  d.exec("BEGIN");
  try {
    d.prepare("DELETE FROM walkthroughs WHERE pr = ? AND source_scope IS NULL").run(String(pr));
    d.prepare("INSERT INTO walkthroughs(pr,author,body) VALUES(?,?,?)").run(
      String(pr), author,
      JSON.stringify({ walkthrough: w, actor: actor ?? { principal: "" }, eventId: "", at: w.at }),
    );
    d.exec("COMMIT");
    return { ok: true };
  } catch (e) { d.exec("ROLLBACK"); throw e; }
}

/** Has this store PUBLISHED its reading of `pr` — i.e. is the row the fold's now? */
export function foldOwnsWalkthrough(root: string, pr: string, principal: string): boolean {
  if (!principal) return false;
  return !!db(root).prepare(
    "SELECT 1 FROM walkthroughs WHERE pr = ? AND author = ? AND source_scope IS NOT NULL",
  ).get(String(pr), principal);
}

/**
 * Attribute this store's unattributed local walkthrough, at the moment publishing makes
 * the author known.
 *
 * A row migrated from the legacy blob has no principal, and a `PrWalkthrough`'s
 * free-text `by` is not one. Publishing is the first act that knows — and it has to
 * happen before the fold comes back, or the folded row cannot adopt the local one and
 * the author's own reading appears twice, once as theirs and once as a stranger's.
 */
export async function attributeLocalWalkthrough(root: string, pr: string, principal: string): Promise<void> {
  if (!principal) return;
  const d = db(root);
  const row = d.prepare("SELECT body FROM walkthroughs WHERE pr = ? AND author = '' AND source_scope IS NULL")
    .get(String(pr)) as { body: string } | undefined;
  if (!row) return;
  // Already published under this principal, so the unattributed row is this store's own
  // pre-publication copy of the SAME reading — the fold never writes an empty author, so
  // it can have come from nowhere else. Renaming it onto the published one violates the
  // index; the published copy is the authoritative one, so the duplicate goes.
  //
  // Reachable on any store that published before the blob migration existed: the fold's
  // row and the migrated row are one reading wearing two names, and nothing could pair
  // them because adoption matches the author exactly.
  if (foldOwnsWalkthrough(root, pr, principal)) {
    d.prepare("DELETE FROM walkthroughs WHERE pr = ? AND author = '' AND source_scope IS NULL").run(String(pr));
    return;
  }
  let env: Record<string, unknown>;
  try { env = JSON.parse(row.body) as Record<string, unknown>; } catch { return; }
  env.actor = { principal };
  d.prepare("UPDATE walkthroughs SET author = ?, body = ? WHERE pr = ? AND author = '' AND source_scope IS NULL")
    .run(principal, JSON.stringify(env), String(pr));
}

/**
 * When this store's local findings were unified onto the sidecar, or null.
 *
 * Recorded so "already unified" is distinguishable from "never had any" — the gate has
 * to be able to tell a clean store from one that has simply not been looked at, and a
 * count of zero says both.
 */
export const findingsUnifiedAt = (root: string): string | null =>
  getMeta<{ at: string }>(db(root), "findings_unified")?.at ?? null;

export const markFindingsUnified = (root: string, count: number): void =>
  setMeta(db(root), "findings_unified", { at: nowISO(), count });

/** Which PRs have already had their GitHub viewed-ticks imported, so a bulk run resumes. */
export type ViewedImportStore = { schemaVersion: number; imported: Record<string, { at: string; marked: number }> };

export async function readViewedImports(root: string): Promise<ViewedImportStore> {
  return getMeta<ViewedImportStore>(db(root), "viewed_import") ?? { schemaVersion: SCHEMA_VERSION, imported: {} };
}

export async function writeViewedImport(root: string, pr: string, marked: number): Promise<void> {
  const store = await readViewedImports(root);
  store.imported[pr] = { at: nowISO(), marked };
  setMeta(db(root), "viewed_import", store);
}

export async function writePush(root: string, pr: string, rec: PushRecord): Promise<void> {
  const store = await readPushes(root);
  const prev = store.pushes[pr];
  store.pushes[pr] = prev
    ? {
      ...prev, ...rec,
      annotationIds: [...new Set([...prev.annotationIds, ...rec.annotationIds])],
      viewedPaths: [...new Set([...prev.viewedPaths, ...rec.viewedPaths])],
      // The arrays union; a scalar must not be erased by a later write that has none.
      // Publishing viewed state alone carries no review url, and spreading `rec` over
      // `prev` dropped the link to the review posted earlier.
      reviewUrl: rec.reviewUrl ?? prev.reviewUrl,
    }
    : rec;
  setMeta(db(root), "pr_push", store);
}

// --- requirements, specs & operations (COD-29) ------------------------------
//
// Deliberately NOT reachable from any node path. `loadNodes` does not see these
// tables and nothing here touches `nodes`/`node_versions`, which is the structural
// half of "a requirement has no stale state": it cannot acquire one, because the
// code that computes one is never handed a requirement. `requirements.test.ts`
// holds that true.

const hydrateRequirement = (body: string, origin: string | null): Requirement | null => {
  try {
    const r = JSON.parse(body) as Requirement;
    return origin ? { ...r, origin } : r;
  } catch { return null; }
};

const requirementRow = (r: Requirement): unknown[] => [
  r.id, r.status, r.title, r.section, r.provenance, r.createdAt, r.ratifiedAt ?? null,
  r.origin ?? null, null, JSON.stringify(r),
];

export async function readRequirements(
  root: string,
  opts: { status?: Requirement["status"]; section?: string } = {},
): Promise<RequirementStore> {
  const clauses: string[] = [];
  const args: string[] = [];
  if (opts.status) { clauses.push("status = ?"); args.push(opts.status); }
  // Prefix match, so asking for "Credit" answers with "Credit/Limits" too — a section
  // is a path and the useful question about one is almost always "and everything under".
  // ESCAPE is not optional: SQLite's LIKE has NO default escape character, so the
  // backslash this inserts is a literal without it and a section path containing `_` or
  // `%` loses its whole subtree from the listing.
  if (opts.section) { clauses.push("(section = ? OR section LIKE ? ESCAPE '\\')"); args.push(opts.section, opts.section.replace(/[%_\\]/g, "\\$&") + "/%"); }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const rows = db(root).prepare(
    `SELECT body, origin FROM requirements${where} ORDER BY section, created_at, id`,
  ).all(...args as []) as unknown as { body: string; origin: string | null }[];
  const requirements: Requirement[] = [];
  // A row this build cannot parse is not a reason to fail every requirement read —
  // the same rule `readFindings` follows, for the same reason.
  for (const row of rows) { const r = hydrateRequirement(row.body, row.origin); if (r) requirements.push(r); }
  return { schemaVersion: SCHEMA_VERSION, requirements };
}

export async function readRequirement(root: string, id: string): Promise<Requirement | null> {
  const row = db(root).prepare("SELECT body, origin FROM requirements WHERE id = ?")
    .get(id) as { body: string; origin: string | null } | undefined;
  return row ? hydrateRequirement(row.body, row.origin) : null;
}

/**
 * Write a requirement this machine owns.
 *
 * Refuses a row the fold owns, for the reason `writeLocalFinding` refuses one: a local
 * edit to folded state is erased by the next sync and invisible until then, so it reads
 * as having worked. The right move on a shared record is to write an event.
 */
export async function writeLocalRequirement(root: string, r: Requirement): Promise<void> {
  const d = db(root);
  const owner = d.prepare("SELECT source_scope FROM requirements WHERE id = ? AND source_scope IS NOT NULL")
    .get(r.id) as { source_scope: string } | undefined;
  if (owner) {
    throw new Error(
      `${r.id} is owned by the sidecar fold (${owner.source_scope}) — write an event, not a row.`,
    );
  }
  d.prepare(
    "INSERT OR REPLACE INTO requirements(id,status,title,section,provenance,created_at,ratified_at,origin,source_scope,body)"
    + " VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run(...requirementRow(r) as any);
}



const hydrateSpec = (body: string, origin: string | null): Spec | null => {
  try {
    const sp = JSON.parse(body) as Spec;
    return origin ? { ...sp, origin } : sp;
  } catch { return null; }
};

export async function readSpecs(root: string, opts: { status?: Spec["status"] } = {}): Promise<Spec[]> {
  const where = opts.status ? " WHERE status = ?" : "";
  const args = opts.status ? [opts.status] : [];
  const rows = db(root).prepare(
    `SELECT body, origin FROM specs${where} ORDER BY created_at, id`,
  ).all(...args as []) as unknown as { body: string; origin: string | null }[];
  const out: Spec[] = [];
  for (const r of rows) { const sp = hydrateSpec(r.body, r.origin); if (sp) out.push(sp); }
  return out;
}

export async function readSpec(root: string, id: string): Promise<Spec | null> {
  const row = db(root).prepare("SELECT body, origin FROM specs WHERE id = ?")
    .get(id) as { body: string; origin: string | null } | undefined;
  return row ? hydrateSpec(row.body, row.origin) : null;
}

export async function writeLocalSpec(root: string, sp: Spec): Promise<void> {
  const d = db(root);
  const owner = d.prepare("SELECT source_scope FROM specs WHERE id = ? AND source_scope IS NOT NULL")
    .get(sp.id) as { source_scope: string } | undefined;
  if (owner) throw new Error(`${sp.id} is owned by the sidecar fold (${owner.source_scope}) — write an event, not a row.`);
  d.prepare(
    "INSERT OR REPLACE INTO specs(id,status,title,created_at,ratified_at,origin,source_scope,body)"
    + " VALUES(?,?,?,?,?,?,?,?)",
  ).run(sp.id, sp.status, sp.title, sp.createdAt, sp.ratifiedAt ?? null, sp.origin ?? null, null, JSON.stringify(sp));
}

const hydrateOperation = (body: string, origin: string | null): Operation | null => {
  try {
    const op = JSON.parse(body) as Operation;
    return origin ? { ...op, origin } : op;
  } catch { return null; }
};

/** One operation by id — the lookup a comment needs to know what it is talking about. */
export async function readOperation(root: string, id: string): Promise<Operation | null> {
  const row = db(root).prepare("SELECT body, origin FROM operations WHERE id = ?").get(id) as
    { body: string; origin: string | null } | undefined;
  if (!row) return null;
  try {
    const op = JSON.parse(row.body) as Operation;
    return row.origin ? { ...op, origin: row.origin } : op;
  } catch { return null; }
}

/**
 * A spec's operations, with removed ones filtered out by DEFAULT.
 *
 * Removal is a tombstone (`Operation.removed`) so `ord` stays stable, and the default has
 * to be the safe one: every operative caller — ratification, reliance, the gap binding, the
 * rendering, the queue counts — must never see an operation the author pulled. Only a
 * surface that is showing HISTORY passes `includeRemoved`, and `addOperation` passes it to
 * pick the next `ord`, because a tombstone still occupies its position.
 */
export async function readOperations(
  root: string, opts: { specId?: string; requirementId?: string; includeRemoved?: boolean } = {},
): Promise<Operation[]> {
  const clauses: string[] = [];
  const args: string[] = [];
  if (opts.specId) { clauses.push("spec_id = ?"); args.push(opts.specId); }
  if (opts.requirementId) { clauses.push("requirement_id = ?"); args.push(opts.requirementId); }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const rows = db(root).prepare(
    `SELECT body, origin FROM operations${where} ORDER BY spec_id, ord`,
  ).all(...args as []) as unknown as { body: string; origin: string | null }[];
  const out: Operation[] = [];
  for (const r of rows) {
    const op = hydrateOperation(r.body, r.origin);
    if (op && (opts.includeRemoved || !op.removed)) out.push(op);
  }
  return out;
}

export async function writeLocalOperation(root: string, op: Operation): Promise<void> {
  const d = db(root);
  const owner = d.prepare("SELECT source_scope FROM operations WHERE id = ? AND source_scope IS NOT NULL")
    .get(op.id) as { source_scope: string } | undefined;
  if (owner) throw new Error(`${op.id} is owned by the sidecar fold (${owner.source_scope}) — write an event, not a row.`);
  d.prepare(
    "INSERT OR REPLACE INTO operations(id,spec_id,kind,requirement_id,ord,origin,source_scope,body)"
    + " VALUES(?,?,?,?,?,?,?,?)",
  ).run(op.id, op.specId, op.kind, op.requirementId ?? null, op.ord, op.origin ?? null, null, JSON.stringify(op));
}

const hydrateWitness = (body: string, origin: string | null): ProposalWitness | null => {
  try {
    const w = JSON.parse(body) as ProposalWitness;
    return origin ? { ...w, origin } : w;
  } catch { return null; }
};

/**
 * Sign-offs on a proposal. One row per reviewer per subject — a later sign-off REPLACES
 * the earlier, because a ratification asks what you last read, not how often you looked.
 *
 * `operationId: null` selects the FRAMING witness (title and narrative) and is passed
 * explicitly rather than by omitting the option, so "the framing" and "everything" cannot
 * be confused at a call site.
 */
export async function readProposalWitnesses(
  root: string, opts: { specId?: string; operationId?: string | null; reviewer?: string } = {},
): Promise<ProposalWitness[]> {
  const clauses: string[] = [];
  const args: string[] = [];
  if (opts.specId) { clauses.push("spec_id = ?"); args.push(opts.specId); }
  if (opts.operationId === null) clauses.push("operation_id IS NULL");
  else if (opts.operationId) { clauses.push("operation_id = ?"); args.push(opts.operationId); }
  if (opts.reviewer) { clauses.push("reviewer = ?"); args.push(opts.reviewer); }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const rows = db(root).prepare(
    `SELECT body, origin FROM proposal_witnesses${where} ORDER BY at, id`,
  ).all(...args as []) as unknown as { body: string; origin: string | null }[];
  const out: ProposalWitness[] = [];
  for (const r of rows) { const w = hydrateWitness(r.body, r.origin); if (w) out.push(w); }
  return out;
}

export async function writeLocalProposalWitness(root: string, w: ProposalWitness): Promise<void> {
  const d = db(root);
  const owner = d.prepare("SELECT source_scope FROM proposal_witnesses WHERE id = ? AND source_scope IS NOT NULL")
    .get(w.id) as { source_scope: string } | undefined;
  if (owner) throw new Error(`${w.id} is owned by the sidecar fold (${owner.source_scope}) — write an event, not a row.`);
  // Replace this reviewer's PREVIOUS witness of the same subject. Keeping both would make
  // "have you read the current text" a search rather than a lookup, and the older row can
  // only ever answer the question wrongly.
  if (w.operationId) {
    d.prepare(
      "DELETE FROM proposal_witnesses WHERE spec_id = ? AND reviewer = ? AND operation_id = ? AND source_scope IS NULL",
    ).run(w.specId, w.reviewer.principal, w.operationId);
  } else {
    d.prepare(
      "DELETE FROM proposal_witnesses WHERE spec_id = ? AND reviewer = ? AND operation_id IS NULL AND source_scope IS NULL",
    ).run(w.specId, w.reviewer.principal);
  }
  d.prepare(
    "INSERT INTO proposal_witnesses(id,spec_id,operation_id,reviewer,at,origin,source_scope,body)"
    + " VALUES(?,?,?,?,?,?,?,?)",
  ).run(w.id, w.specId, w.operationId ?? null, w.reviewer.principal, w.at, w.origin ?? null, null, JSON.stringify(w));
}

/** Section -> how many requirements file under it. The index a flat list cannot be. */
export async function requirementSectionCounts(root: string): Promise<{ section: string; count: number }[]> {
  return db(root).prepare(
    "SELECT section, COUNT(*) AS count FROM requirements GROUP BY section ORDER BY section",
  ).all() as unknown as { section: string; count: number }[];
}

const hydrateAck = (body: string, origin: string | null): Acknowledgement | null => {
  try {
    const a = JSON.parse(body) as Acknowledgement;
    return origin ? { ...a, origin } : a;
  } catch { return null; }
};

export async function readAcknowledgements(
  root: string,
  opts: { requirementId?: string; operationId?: string; state?: Acknowledgement["state"] } = {},
): Promise<Acknowledgement[]> {
  const clauses: string[] = [];
  const args: string[] = [];
  if (opts.requirementId) { clauses.push("requirement_id = ?"); args.push(opts.requirementId); }
  if (opts.operationId) { clauses.push("operation_id = ?"); args.push(opts.operationId); }
  if (opts.state) { clauses.push("state = ?"); args.push(opts.state); }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const rows = db(root).prepare(
    `SELECT body, origin FROM acknowledgements${where} ORDER BY revalidate_by, granted_at, id`,
  ).all(...args as []) as unknown as { body: string; origin: string | null }[];
  const out: Acknowledgement[] = [];
  for (const r of rows) { const a = hydrateAck(r.body, r.origin); if (a) out.push(a); }
  return out;
}

export async function readAcknowledgement(root: string, id: string): Promise<Acknowledgement | null> {
  const row = db(root).prepare("SELECT body, origin FROM acknowledgements WHERE id = ?")
    .get(id) as { body: string; origin: string | null } | undefined;
  return row ? hydrateAck(row.body, row.origin) : null;
}

export async function writeLocalAcknowledgement(root: string, a: Acknowledgement): Promise<void> {
  const d = db(root);
  const owner = d.prepare("SELECT source_scope FROM acknowledgements WHERE id = ? AND source_scope IS NOT NULL")
    .get(a.id) as { source_scope: string } | undefined;
  if (owner) throw new Error(`${a.id} is owned by the sidecar fold (${owner.source_scope}) — write an event, not a row.`);
  d.prepare(
    "INSERT OR REPLACE INTO acknowledgements(id,basis,state,operation_id,requirement_id,priority,"
    + "revalidate_by,granted_at,origin,source_scope,body) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  ).run(a.id, a.basis, a.state, a.operationId ?? null, a.requirementId ?? null, a.priority,
        a.revalidateBy, a.grantedAt, a.origin ?? null, null, JSON.stringify(a));
}

const hydrateAudit = (body: string, origin: string | null): Audit | null => {
  try {
    const a = JSON.parse(body) as Audit;
    return origin ? { ...a, origin } : a;
  } catch { return null; }
};

export async function readAudits(
  root: string, opts: { requirementId?: string } = {},
): Promise<Audit[]> {
  const where = opts.requirementId ? " WHERE requirement_id = ?" : "";
  const args = opts.requirementId ? [opts.requirementId] : [];
  const rows = db(root).prepare(
    `SELECT body, origin FROM audits${where} ORDER BY at, id`,
  ).all(...args as []) as unknown as { body: string; origin: string | null }[];
  const out: Audit[] = [];
  for (const r of rows) { const a = hydrateAudit(r.body, r.origin); if (a) out.push(a); }
  return out;
}

export async function writeLocalAudit(root: string, a: Audit): Promise<void> {
  const d = db(root);
  const owner = d.prepare("SELECT source_scope FROM audits WHERE id = ? AND source_scope IS NOT NULL")
    .get(a.id) as { source_scope: string } | undefined;
  if (owner) throw new Error(`${a.id} is owned by the sidecar fold (${owner.source_scope}) — write an event, not a row.`);
  d.prepare(
    "INSERT OR REPLACE INTO audits(id,requirement_id,outcome,at,origin,source_scope,body)"
    + " VALUES(?,?,?,?,?,?,?)",
  ).run(a.id, a.requirementId, a.outcome, a.at, a.origin ?? null, null, JSON.stringify(a));
}

const hydrateCriterion = (body: string, origin: string | null): AcceptanceCriterion | null => {
  try {
    const c = JSON.parse(body) as AcceptanceCriterion;
    return origin ? { ...c, origin } : c;
  } catch { return null; }
};

export async function readCriteria(
  root: string, opts: { requirementId?: string; evidenceKind?: EvidenceKind } = {},
): Promise<AcceptanceCriterion[]> {
  const clauses: string[] = [];
  const args: string[] = [];
  if (opts.requirementId) { clauses.push("requirement_id = ?"); args.push(opts.requirementId); }
  if (opts.evidenceKind) { clauses.push("evidence_kind = ?"); args.push(opts.evidenceKind); }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const rows = db(root).prepare(
    `SELECT body, origin FROM criteria${where} ORDER BY created_at, id`,
  ).all(...args as []) as unknown as { body: string; origin: string | null }[];
  const out: AcceptanceCriterion[] = [];
  for (const r of rows) { const c = hydrateCriterion(r.body, r.origin); if (c) out.push(c); }
  return out;
}

export async function readCriterion(root: string, id: string): Promise<AcceptanceCriterion | null> {
  const row = db(root).prepare("SELECT body, origin FROM criteria WHERE id = ?")
    .get(id) as { body: string; origin: string | null } | undefined;
  return row ? hydrateCriterion(row.body, row.origin) : null;
}

export async function writeLocalCriterion(root: string, c: AcceptanceCriterion): Promise<void> {
  const d = db(root);
  const owner = d.prepare("SELECT source_scope FROM criteria WHERE id = ? AND source_scope IS NOT NULL")
    .get(c.id) as { source_scope: string } | undefined;
  if (owner) throw new Error(`${c.id} is owned by the sidecar fold (${owner.source_scope}) — write an event, not a row.`);
  d.prepare(
    "INSERT OR REPLACE INTO criteria(id,requirement_id,evidence_kind,created_at,origin,source_scope,body)"
    + " VALUES(?,?,?,?,?,?,?)",
  ).run(c.id, c.requirementId, c.evidenceKind, c.createdAt, c.origin ?? null, null, JSON.stringify(c));
}

const hydrateVacuityCheck = (body: string, origin: string | null): VacuityCheck | null => {
  try {
    const v = JSON.parse(body) as VacuityCheck;
    return origin ? { ...v, origin } : v;
  } catch { return null; }
};

export async function readVacuityChecks(
  root: string, opts: { criterionId?: string } = {},
): Promise<VacuityCheck[]> {
  const where = opts.criterionId ? " WHERE criterion_id = ?" : "";
  const args = opts.criterionId ? [opts.criterionId] : [];
  const rows = db(root).prepare(
    `SELECT body, origin FROM vacuity_checks${where} ORDER BY at, id`,
  ).all(...args as []) as unknown as { body: string; origin: string | null }[];
  const out: VacuityCheck[] = [];
  for (const r of rows) { const v = hydrateVacuityCheck(r.body, r.origin); if (v) out.push(v); }
  return out;
}

export async function writeLocalVacuityCheck(root: string, v: VacuityCheck): Promise<void> {
  const d = db(root);
  const owner = d.prepare("SELECT source_scope FROM vacuity_checks WHERE id = ? AND source_scope IS NOT NULL")
    .get(v.id) as { source_scope: string } | undefined;
  if (owner) throw new Error(`${v.id} is owned by the sidecar fold (${owner.source_scope}) — write an event, not a row.`);
  d.prepare(
    "INSERT OR REPLACE INTO vacuity_checks(id,criterion_id,verdict,at,origin,source_scope,body)"
    + " VALUES(?,?,?,?,?,?,?)",
  ).run(v.id, v.criterionId, v.verdict, v.at, v.origin ?? null, null, JSON.stringify(v));
}

/**
 * The scrub policy is a SINGLETON — a policy is a decision, and two of them is no policy.
 * One fixed id, so the fold and a local write contend for the same row rather than
 * accumulating one per writer.
 */
export const SCRUB_POLICY_ID = "pol_standard";

const hydrateScrub = <T>(body: string, origin: string | null): T | null => {
  try {
    const x = JSON.parse(body) as T;
    return origin ? { ...x, origin } : x;
  } catch { return null; }
};

export async function readScrubPolicy(root: string): Promise<ScrubPolicy | null> {
  const row = db(root).prepare("SELECT body, origin FROM scrub_policy WHERE id = ?")
    .get(SCRUB_POLICY_ID) as { body: string; origin: string | null } | undefined;
  return row ? hydrateScrub<ScrubPolicy>(row.body, row.origin) : null;
}

export async function writeLocalScrubPolicy(root: string, p: ScrubPolicy): Promise<void> {
  const d = db(root);
  const owner = d.prepare("SELECT source_scope FROM scrub_policy WHERE id = ? AND source_scope IS NOT NULL")
    .get(SCRUB_POLICY_ID) as { source_scope: string } | undefined;
  if (owner) throw new Error(`the scrub policy is owned by the sidecar fold (${owner.source_scope}) — write an event, not a row.`);
  d.prepare("INSERT OR REPLACE INTO scrub_policy(id,set_at,origin,source_scope,body) VALUES(?,?,?,?,?)")
    .run(SCRUB_POLICY_ID, p.setAt, p.origin ?? null, null, JSON.stringify(p));
}

const hydratePopulation = (body: string, origin: string | null): PopulationPredicate | null => {
  try {
    const p = JSON.parse(body) as PopulationPredicate;
    return origin ? { ...p, origin } : p;
  } catch { return null; }
};

export async function readPopulations(
  root: string, opts: { requirementId?: string; state?: PopulationPredicate["state"] } = {},
): Promise<PopulationPredicate[]> {
  const clauses: string[] = [];
  const args: string[] = [];
  if (opts.requirementId) { clauses.push("requirement_id = ?"); args.push(opts.requirementId); }
  if (opts.state) { clauses.push("state = ?"); args.push(opts.state); }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const rows = db(root).prepare(
    `SELECT body, origin FROM populations${where} ORDER BY pinned_at, id`,
  ).all(...args as []) as unknown as { body: string; origin: string | null }[];
  const out: PopulationPredicate[] = [];
  for (const r of rows) { const p = hydratePopulation(r.body, r.origin); if (p) out.push(p); }
  return out;
}

export async function writeLocalPopulation(root: string, p: PopulationPredicate): Promise<void> {
  const d = db(root);
  const owner = d.prepare("SELECT source_scope FROM populations WHERE id = ? AND source_scope IS NOT NULL")
    .get(p.id) as { source_scope: string } | undefined;
  if (owner) throw new Error(`${p.id} is owned by the sidecar fold (${owner.source_scope}) — write an event, not a row.`);
  d.prepare(
    "INSERT OR REPLACE INTO populations(id,requirement_id,basis,state,pinned_at,origin,source_scope,body)"
    + " VALUES(?,?,?,?,?,?,?,?)",
  ).run(p.id, p.requirementId, p.basis, p.state, p.pinnedAt, p.origin ?? null, null, JSON.stringify(p));
}

const hydratePointer = (body: string, origin: string | null): Pointer | null => {
  try {
    const p = JSON.parse(body) as Pointer;
    return origin ? { ...p, origin } : p;
  } catch { return null; }
};

export async function readPointers(
  root: string,
  opts: {
    requirementId?: string; state?: Pointer["state"]; target?: { kind: string; id: string };
    /**
     * DETECTOR pointers for one criterion, or — with `null` — only SUBJECT pointers.
     *
     * Filtered after the query rather than in SQL: `criterion_id` is not a column, it rides
     * in `body`, and a rule's pointers are a handful. A column would need a migration for
     * an index nothing is hot on.
     */
    criterionId?: string | null;
  } = {},
): Promise<Pointer[]> {
  const clauses: string[] = [];
  const args: string[] = [];
  if (opts.requirementId) { clauses.push("requirement_id = ?"); args.push(opts.requirementId); }
  if (opts.state) { clauses.push("state = ?"); args.push(opts.state); }
  if (opts.target) { clauses.push("target_kind = ? AND target_id = ?"); args.push(opts.target.kind, opts.target.id); }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const rows = db(root).prepare(
    `SELECT body, origin FROM pointers${where} ORDER BY declared_at, id`,
  ).all(...args as []) as unknown as { body: string; origin: string | null }[];
  const out: Pointer[] = [];
  for (const r of rows) {
    const p = hydratePointer(r.body, r.origin);
    if (!p) continue;
    if (opts.criterionId === null && p.criterionId) continue;
    if (typeof opts.criterionId === "string" && p.criterionId !== opts.criterionId) continue;
    out.push(p);
  }
  return out;
}

export async function readPointer(root: string, id: string): Promise<Pointer | null> {
  const row = db(root).prepare("SELECT body, origin FROM pointers WHERE id = ?")
    .get(id) as { body: string; origin: string | null } | undefined;
  return row ? hydratePointer(row.body, row.origin) : null;
}

export async function writeLocalPointer(root: string, p: Pointer): Promise<void> {
  const d = db(root);
  const owner = d.prepare("SELECT source_scope FROM pointers WHERE id = ? AND source_scope IS NOT NULL")
    .get(p.id) as { source_scope: string } | undefined;
  if (owner) throw new Error(`${p.id} is owned by the sidecar fold (${owner.source_scope}) — write an event, not a row.`);
  d.prepare(
    "INSERT OR REPLACE INTO pointers(id,requirement_id,target_kind,target_id,state,declared_at,origin,source_scope,body)"
    + " VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(p.id, p.requirementId, p.target.kind, p.target.id, p.state, p.declaredAt, p.origin ?? null, null, JSON.stringify(p));
}

const hydrateProblem = (body: string, origin: string | null): Problem | null => {
  try {
    const p = JSON.parse(body) as Problem;
    return origin ? { ...p, origin } : p;
  } catch { return null; }
};

export async function readProblems(
  root: string, opts: { requirementId?: string; unadjudicated?: boolean } = {},
): Promise<Problem[]> {
  const clauses: string[] = [];
  const args: string[] = [];
  if (opts.requirementId) { clauses.push("requirement_id = ?"); args.push(opts.requirementId); }
  if (opts.unadjudicated) clauses.push("disposition IS NULL");
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const rows = db(root).prepare(
    `SELECT body, origin FROM problems${where} ORDER BY raised_at, id`,
  ).all(...args as []) as unknown as { body: string; origin: string | null }[];
  const out: Problem[] = [];
  for (const r of rows) { const p = hydrateProblem(r.body, r.origin); if (p) out.push(p); }
  return out;
}

export async function readProblem(root: string, id: string): Promise<Problem | null> {
  const row = db(root).prepare("SELECT body, origin FROM problems WHERE id = ?")
    .get(id) as { body: string; origin: string | null } | undefined;
  return row ? hydrateProblem(row.body, row.origin) : null;
}

export async function writeLocalProblem(root: string, p: Problem): Promise<void> {
  const d = db(root);
  const owner = d.prepare("SELECT source_scope FROM problems WHERE id = ? AND source_scope IS NOT NULL")
    .get(p.id) as { source_scope: string } | undefined;
  if (owner) throw new Error(`${p.id} is owned by the sidecar fold (${owner.source_scope}) — write an event, not a row.`);
  d.prepare(
    "INSERT OR REPLACE INTO problems(id,requirement_id,audit_id,disposition,raised_at,adjudicated_at,"
    + "origin,source_scope,body) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(p.id, p.requirementId, p.auditId, p.disposition ?? null, p.raisedAt, p.adjudicatedAt ?? null,
        p.origin ?? null, null, JSON.stringify(p));
}
