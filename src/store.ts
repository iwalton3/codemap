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
import { randomBytes } from "node:crypto";
import { db, WORK_REF } from "./db.js";
import { headCommit, currentBranch } from "./git.js";
import {
  type Anchor, type AnchorStore, type State, type LogicalNode, type LogicalNodeType,
  type NodeVersion, type NodeCitation, type NodeStatus,
  type Graph, type Edge, type Bug, type BugStore, type Annotation, type AnnotationStore,
  type CoverageRule, type CoverageStore, type AnalyzerConfig, type Review, type ReviewStore, type Triage, type TriageStore,
  SCHEMA_VERSION,
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
  body_hash: string; last_commit: string | null;
  start_byte: number | null; end_byte: number | null; start_line: number | null; end_line: number | null;
}

function rowToAnchor(r: AnchorRow): Anchor {
  return {
    id: r.id,
    file: r.file,
    symbolPath: JSON.parse(r.symbol_path),
    kind: r.kind as Anchor["kind"],
    ...(r.disambiguator != null ? { disambiguator: r.disambiguator } : {}),
    bodyHash: r.body_hash,
    lastVerifiedCommit: r.last_commit,
    ...(r.start_byte != null
      ? { loc: { startByte: r.start_byte, endByte: r.end_byte!, startLine: r.start_line!, endLine: r.end_line! } }
      : {}),
  };
}

/** Replace all anchors under a ref in one transaction. */
function replaceAnchors(d: DatabaseSync, ref: string, anchors: Anchor[]): void {
  const ins = d.prepare(
    "INSERT OR REPLACE INTO anchors(ref,id,file,symbol_path,kind,disambiguator,body_hash,last_commit,start_byte,end_byte,start_line,end_line) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  d.exec("BEGIN");
  try {
    d.prepare("DELETE FROM anchors WHERE ref = ?").run(ref);
    for (const a of anchors) {
      ins.run(ref, a.id, a.file, JSON.stringify(a.symbolPath), a.kind, a.disambiguator ?? null,
        a.bodyHash, a.lastVerifiedCommit ?? null,
        a.loc?.startByte ?? null, a.loc?.endByte ?? null, a.loc?.startLine ?? null, a.loc?.endLine ?? null);
    }
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

function anchorsUnder(d: DatabaseSync, ref: string): Anchor[] {
  const rows = d.prepare("SELECT * FROM anchors WHERE ref = ?").all(ref) as unknown as AnchorRow[];
  return rows.map(rowToAnchor);
}

// --- anchors + state ---------------------------------------------------------

export async function writeStore(root: string, anchors: Anchor[], state: State): Promise<void> {
  const d = db(root);
  replaceAnchors(d, WORK_REF, anchors);
  setMeta(d, "state", state);
}

export async function readAnchorStore(root: string): Promise<AnchorStore> {
  const d = db(root);
  if (!getMeta(d, "state")) throw new Error(`codemap not initialized at ${root} (run \`codemap init\`)`);
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
  d.prepare("INSERT INTO snapshots(ref,branch,at,count) VALUES(?,?,?,?) ON CONFLICT(ref) DO UPDATE SET branch=excluded.branch, at=excluded.at, count=excluded.count")
    .run(ref, branch, at, anchors.length);
}

/** Read a cached snapshot's anchors, or null when that commit was never indexed. */
export async function readSnapshot(root: string, ref: string): Promise<Anchor[] | null> {
  const d = db(root);
  const meta = d.prepare("SELECT 1 FROM snapshots WHERE ref = ?").get(ref);
  if (!meta) return null;
  return anchorsUnder(d, ref);
}

export async function listSnapshots(root: string): Promise<SnapshotInfo[]> {
  const rows = db(root).prepare("SELECT ref, branch, at, count FROM snapshots ORDER BY at DESC").all() as unknown as SnapshotInfo[];
  return rows;
}

export async function readState(root: string): Promise<State> {
  const s = getMeta<State>(db(root), "state");
  if (!s) throw new Error(`codemap not initialized at ${root}`);
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

/** Status of a version against the live @work anchors (fresh / stale / dangling / removed). */
function evalVersion(v: NodeVersion, work: Map<string, string>) {
  if (v.generatedBy) return { status: "generated" as NodeStatus, stale: [] as string[], dangling: [] as string[], badness: 0 };
  if (v.removed) {
    // A tombstone is fresh where its cited anchors are ABSENT (the removal holds);
    // if any still exist here, the code came back → it doesn't apply (badness).
    const present = v.citations.filter((c) => work.has(c.anchorId)).map((c) => c.anchorId);
    return { status: "removed" as NodeStatus, stale: present, dangling: [] as string[], badness: present.length };
  }
  const stale: string[] = [], dangling: string[] = [];
  for (const c of v.citations) {
    const live = work.get(c.anchorId);
    if (live === undefined) dangling.push(c.anchorId);
    else if (!c.acceptedHashes.includes(live)) stale.push(c.anchorId);
  }
  const status: NodeStatus = dangling.length ? "dangling" : stale.length ? "stale" : "fresh";
  return { status, stale, dangling, badness: stale.length + dangling.length };
}

/** The version that best fits the current branch: fewest problems, then most recent. */
function selectWinner(versions: NodeVersion[], work: Map<string, string>): { v: NodeVersion; e: ReturnType<typeof evalVersion> } {
  let best = versions[0]!, bestE = evalVersion(best, work);
  for (const v of versions.slice(1)) {
    const e = evalVersion(v, work);
    // TODO: git-aware tiebreak (created_commit ancestry) — rare; most-recent for now.
    if (e.badness < bestE.badness || (e.badness === bestE.badness && v.createdAt > best.createdAt)) { best = v; bestE = e; }
  }
  return { v: best, e: bestE };
}

function resolve(versions: NodeVersion[], work: Map<string, string>): LogicalNode {
  const { v, e } = selectWinner(versions, work);
  return {
    id: v.nodeId, type: v.type, title: v.title, summary: v.summary, body: v.body,
    anchors: v.citations.map((c) => c.anchorId),
    ...(v.generatedBy ? { generatedBy: v.generatedBy } : {}),
    versionId: v.versionId, status: e.status, staleAnchors: e.stale, danglingAnchors: e.dangling,
    versionCount: versions.length,
  };
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
  return [...byNode.values()].map((vs) => resolve(vs, work)).filter((n) => n.status !== "removed");
}

/** All versions of one node (for the version-aware UI / confirm / fork ops). */
export async function loadNodeVersions(root: string, nodeId: string): Promise<NodeVersion[]> {
  return versionsOf(db(root), nodeId);
}

/** The version that wins against a given anchor-hash map (e.g. a base/head snapshot). */
export function winningVersionAt(versions: NodeVersion[], hashes: Map<string, string>): NodeVersion | undefined {
  return versions.length ? selectWinner(versions, hashes).v : undefined;
}

// A conservative id-safe slug (kept: node ids are still human-facing).
export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "node";
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
export async function writeNode(root: string, node: LogicalNode): Promise<void> {
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

  const work = workHashes(d);
  const commit = headCommit(root), branch = currentBranch(root);
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
