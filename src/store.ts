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
import { randomBytes } from "node:crypto";
import { db, WORK_REF, ORPHAN_REF } from "./db.js";
import { headCommit, currentBranch } from "./git.js";
import { evalVersion, selectWinner, resolveNode, winningVersionAt } from "./doc-version.js";
export { winningVersionAt } from "./doc-version.js";
import {
  type Anchor, type AnchorStore, type State, type LogicalNode, type LogicalNodeType,
  type NodeVersion, type NodeCitation, type NodeStatus,
  type Graph, type Edge, type Bug, type BugStore, type Annotation, type AnnotationStore,
  type CoverageRule, type CoverageStore, type AnalyzerConfig, type Review, type ReviewStore, type Triage, type TriageStore,
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
function internDerivation(d: DatabaseSync, tag: DerivationTag | undefined): number | null {
  if (!tag) return null;
  // Key order is fixed by construction here, so identical tags intern identically.
  const json = JSON.stringify([tag.anchorScheme, tag.hashScheme, tag.parserIntegrity, tag.grammarDigest]);
  const hit = d.prepare("SELECT id FROM derivations WHERE tag = ?").get(json) as { id: number } | undefined;
  if (hit) return hit.id;
  d.prepare("INSERT INTO derivations(tag) VALUES(?)").run(json);
  return (d.prepare("SELECT id FROM derivations WHERE tag = ?").get(json) as { id: number }).id;
}

/** Every interned tag, by id. Five rows at most, so it is read whole. */
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
}

/**
 * Cache a full anchor set under a commit sha (immutable snapshot). Re-snapshotting
 * the same sha overwrites it — the latest full index of that commit wins. `@work`
 * is reserved for the live index and is never used as a snapshot ref.
 */
export async function writeSnapshot(root: string, ref: string, branch: string | null, anchors: Anchor[], at: string): Promise<void> {
  if (ref === WORK_REF) throw new Error("cannot snapshot the reserved @work ref");
  const d = db(root);
  replaceAnchors(d, ref, anchors);
  d.prepare("INSERT INTO snapshots(ref,branch,at,count,scheme,hash_scheme) VALUES(?,?,?,?,?,?) ON CONFLICT(ref) DO UPDATE SET branch=excluded.branch, at=excluded.at, count=excluded.count, scheme=excluded.scheme, hash_scheme=excluded.hash_scheme")
    .run(ref, branch, at, anchors.length, ANCHOR_SCHEME, HASH_SCHEME);
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
  for (const b of bugStore.bugs) {
    for (const id of b.anchors) ids.add(id);
    for (const w of b.witnesses ?? []) ids.add(w.anchorId);
  }
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
 * Read a cached snapshot's anchors, or null when that commit was never indexed —
 * or was indexed under a DIFFERENT anchor-id derivation.
 *
 * The second case reads as "not cached" on purpose. Such a snapshot cannot be
 * compared with a current one: a diff is a set operation over ids, so every symbol
 * whose id derivation changed comes out removed-and-added. Callers already handle
 * "not cached" — `ensureSnapshot` rebuilds, and `diff` says to run `codemap
 * snapshot` — whereas a silently wrong answer has no handler at all.
 *
 * Deliberately NOT applied to the raw by-ref lookups (`findAnchorsOutsideWork`,
 * `bodyHashAt`): those resolve an id somebody already holds, and an id from an old
 * snapshot is exactly what needs finding there.
 */
export async function readSnapshot(root: string, ref: string): Promise<Anchor[] | null> {
  const d = db(root);
  const meta = d.prepare("SELECT scheme, hash_scheme FROM snapshots WHERE ref = ?").get(ref) as
    { scheme: number | null; hash_scheme: number | null } | undefined;
  // Both derivations must match. The ids decide WHICH symbols pair up; the hashes
  // decide which of those pairs count as changed — so a snapshot carrying the right
  // ids and another scheme's hashes reports the whole commit as rewritten.
  if (!meta || meta.scheme !== ANCHOR_SCHEME || meta.hash_scheme !== HASH_SCHEME) return null;
  return anchorsUnder(d, ref);
}


/** The label a commit's snapshot was cached under (a branch or PR head ref), if any. */
export function snapshotBranch(root: string, ref: string): string | null {
  const r = db(root).prepare("SELECT branch FROM snapshots WHERE ref = ?").get(ref) as { branch: string | null } | undefined;
  return r?.branch ?? null;
}

export async function listSnapshots(root: string): Promise<SnapshotInfo[]> {
  const rows = db(root).prepare("SELECT ref, branch, at, count FROM snapshots ORDER BY at DESC").all() as unknown as SnapshotInfo[];
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
}

function rowToVersion(r: VersionRow): NodeVersion {
  return {
    versionId: r.version_id, nodeId: r.node_id, type: (r.type ?? "module") as LogicalNodeType,
    title: r.title ?? "", summary: r.summary ?? "", body: r.body ?? "",
    citations: JSON.parse(r.citations ?? "[]"),
    ...(r.generated_by ? { generatedBy: r.generated_by } : {}),
    ...(r.removed ? { removed: true } : {}),
    createdCommit: r.created_commit, createdBranch: r.created_branch, createdAt: r.created_at,
  };
}

function versionsOf(d: DatabaseSync, nodeId: string): NodeVersion[] {
  return (d.prepare("SELECT * FROM node_versions WHERE node_id = ?").all(nodeId) as unknown as VersionRow[]).map(rowToVersion);
}

function workHashes(d: DatabaseSync): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of d.prepare("SELECT id, body_hash FROM anchors WHERE ref = ?").all(WORK_REF) as any[]) m.set(r.id, r.body_hash);
  return m;
}

export async function loadNodes(root: string): Promise<LogicalNode[]> {
  const d = db(root);
  const work = workHashes(d);
  const byNode = new Map<string, NodeVersion[]>();
  for (const r of d.prepare("SELECT * FROM node_versions").all() as unknown as VersionRow[]) {
    const v = rowToVersion(r);
    (byNode.get(v.nodeId) ?? byNode.set(v.nodeId, []).get(v.nodeId)!).push(v);
  }
  // Tombstoned-here nodes are not live docs on this branch — exclude them (they
  // still win/show on branches where their content version matches).
  return [...byNode.values()].map((vs) => resolveNode(vs, work)).filter((n) => n.status !== "removed");
}

/** All versions of one node (for the version-aware UI / confirm / fork ops). */
export async function loadNodeVersions(root: string, nodeId: string): Promise<NodeVersion[]> {
  return versionsOf(db(root), nodeId);
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
  const rows = d.prepare("SELECT version_id, citations FROM node_versions").all() as { version_id: string; citations: string }[];
  const upd = d.prepare("UPDATE node_versions SET citations=? WHERE version_id=?");
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
  opts: { hashes?: Map<string, string>; commit?: string | null; branch?: string | null } = {},
): Promise<void> {
  const d = db(root);
  const existing = versionsOf(d, node.id);

  if (node.generatedBy) {
    const cites: NodeCitation[] = node.anchors.map((id) => ({ anchorId: id, acceptedHashes: [] }));
    if (existing.length === 1 && existing[0]!.title === node.title && existing[0]!.summary === node.summary &&
        existing[0]!.body === node.body && JSON.stringify(existing[0]!.citations.map((c) => c.anchorId)) === JSON.stringify(node.anchors)) {
      return; // identical re-emit — reuse (no churn)
    }
    d.exec("BEGIN");
    try {
      d.prepare("DELETE FROM node_versions WHERE node_id = ?").run(node.id);
      d.prepare(INS_VERSION).run(vid(), node.id, node.type, node.title, node.summary, node.body, node.generatedBy, null, null, nowISO(), JSON.stringify(cites));
      d.exec("COMMIT");
    } catch (e) { d.exec("ROLLBACK"); throw e; }
    return;
  }

  const work = opts.hashes ?? workHashes(d);
  const commit = opts.commit !== undefined ? opts.commit : headCommit(root);
  const branch = opts.branch !== undefined ? opts.branch : currentBranch(root);
  const capture = (ids: string[]): NodeCitation[] => ids.map((id) => ({ anchorId: id, acceptedHashes: work.has(id) ? [work.get(id)!] : [] }));
  const insert = (cites: NodeCitation[]) =>
    d.prepare(INS_VERSION).run(vid(), node.id, node.type, node.title, node.summary, node.body, null, commit, branch, nowISO(), JSON.stringify(cites));

  if (!existing.length) { insert(capture(node.anchors)); return; }

  const { v: winner, e } = selectWinner(existing, work);
  if (e.status === "fresh") {
    // Edit in place + confirm: merge current @work hashes into the citation sets.
    const prev = new Map(winner.citations.map((c) => [c.anchorId, new Set(c.acceptedHashes)]));
    const cites: NodeCitation[] = node.anchors.map((id) => {
      const set = prev.get(id) ?? new Set<string>();
      if (work.has(id)) set.add(work.get(id)!);
      return { anchorId: id, acceptedHashes: [...set] };
    });
    d.prepare("UPDATE node_versions SET type=?,title=?,summary=?,body=?,citations=? WHERE version_id=?")
      .run(node.type, node.title, node.summary, node.body, JSON.stringify(cites), winner.versionId);
  } else {
    // Editing against drifted/removed code → fork; the old version stays for its branch.
    insert(capture(node.anchors));
  }
}

export async function deleteNode(root: string, id: string): Promise<void> {
  db(root).prepare("DELETE FROM node_versions WHERE node_id = ?").run(id);
}

const INS_VERSION_T = "INSERT INTO node_versions(version_id,node_id,type,title,summary,body,generated_by,created_commit,created_branch,created_at,citations,removed) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)";

/**
 * Confirm the winning version is still accurate at the current code WITHOUT
 * forking or editing: merge the current @work hashes into its citations, so a
 * stale doc becomes fresh (and stays valid on the other branches whose hashes are
 * still accepted). Dangling citations can't be confirmed (no live hash) — those
 * need a rewrite or ack-hole.
 */
export async function confirmNode(root: string, id: string): Promise<{ ok?: true; status?: NodeStatus; error?: string }> {
  const d = db(root);
  const versions = versionsOf(d, id);
  if (!versions.length) return { error: `no node "${id}"` };
  const work = workHashes(d);
  const { v } = selectWinner(versions, work);
  if (v.generatedBy) return { error: "generated node — regenerated, not confirmable" };
  if (v.removed) return { error: "node is tombstoned here" };
  const cites: NodeCitation[] = v.citations.map((c) => {
    const set = new Set(c.acceptedHashes);
    const live = work.get(c.anchorId);
    if (live) set.add(live);
    return { anchorId: c.anchorId, acceptedHashes: [...set] };
  });
  d.prepare("UPDATE node_versions SET citations=? WHERE version_id=?").run(JSON.stringify(cites), v.versionId);
  return { ok: true, status: evalVersion({ ...v, citations: cites }, work).status };
}

/**
 * Ack a hole: the winning version is dangling (cited code removed here) and the
 * removal is correct → write a TOMBSTONE version that wins where those anchors are
 * absent, so the doc disappears from this branch's map while its content version
 * still wins on branches where the code exists.
 */
export async function ackHole(root: string, id: string): Promise<{ ok?: true; removedAnchors?: string[]; on?: string | null; error?: string }> {
  const d = db(root);
  const versions = versionsOf(d, id);
  if (!versions.length) return { error: `no node "${id}"` };
  const work = workHashes(d);
  const { v, e } = selectWinner(versions, work);
  if (e.status !== "dangling") return { error: `node "${id}" is not a hole here (status: ${e.status})` };
  const cites: NodeCitation[] = e.dangling.map((aid) => ({ anchorId: aid, acceptedHashes: [] }));
  const branch = currentBranch(root);
  d.prepare(INS_VERSION_T).run(vid(), id, v.type, v.title, v.summary, v.body, null, headCommit(root), branch, nowISO(), JSON.stringify(cites), 1);
  return { ok: true, removedAnchors: e.dangling, on: branch };
}

// --- graph (edges) -----------------------------------------------------------

interface EdgeRow { from_id: string; to_id: string; type: string; ord: number | null; generated_by: string | null; }

function rowToEdge(r: EdgeRow): Edge {
  return {
    from: r.from_id,
    to: r.to_id,
    type: r.type as Edge["type"],
    ...(r.ord != null ? { order: r.ord } : {}),
    ...(r.generated_by ? { generatedBy: r.generated_by } : {}),
  };
}

export async function readGraph(root: string): Promise<Graph> {
  const rows = db(root).prepare("SELECT from_id,to_id,type,ord,generated_by FROM edges").all() as unknown as EdgeRow[];
  return { edges: rows.map(rowToEdge) };
}

export async function writeGraph(root: string, graph: Graph): Promise<void> {
  const d = db(root);
  const ins = d.prepare("INSERT INTO edges(from_id,to_id,type,ord,generated_by) VALUES(?,?,?,?,?)");
  d.exec("BEGIN");
  try {
    d.prepare("DELETE FROM edges").run();
    for (const e of graph.edges) ins.run(e.from, e.to, e.type, e.order ?? null, e.generatedBy ?? null);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

// --- small JSON-blob stores (bugs / annotations / coverage / analyzers / reviews) ---

export async function readBugs(root: string): Promise<BugStore> {
  return getMeta<BugStore>(db(root), "bugs") ?? { schemaVersion: SCHEMA_VERSION, bugs: [] };
}

export async function writeBugs(root: string, bugs: Bug[]): Promise<void> {
  setMeta(db(root), "bugs", { schemaVersion: SCHEMA_VERSION, bugs });
}

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

export async function readTriage(root: string): Promise<TriageStore> {
  return getMeta<TriageStore>(db(root), "triage") ?? { schemaVersion: SCHEMA_VERSION, triage: [] };
}

export async function writeTriage(root: string, triage: Triage[]): Promise<void> {
  setMeta(db(root), "triage", { schemaVersion: SCHEMA_VERSION, triage });
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
 * Agent-written walkthroughs, one per pull request. Keyed by PR number and carrying
 * the head it was written against, so a walkthrough is never silently read as being
 * about a commit it has not seen.
 */
export type WalkthroughStore = { schemaVersion: number; walkthroughs: Record<string, PrWalkthrough> };

export async function readWalkthroughs(root: string): Promise<WalkthroughStore> {
  return getMeta<WalkthroughStore>(db(root), "pr_walkthrough") ?? { schemaVersion: SCHEMA_VERSION, walkthroughs: {} };
}

export async function writeWalkthrough(root: string, pr: string, w: PrWalkthrough): Promise<void> {
  const store = await readWalkthroughs(root);
  store.walkthroughs[pr] = w;
  setMeta(db(root), "pr_walkthrough", store);
}

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
