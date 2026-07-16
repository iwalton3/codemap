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
import { db, WORK_REF } from "./db.js";
import {
  type Anchor, type AnchorStore, type State, type LogicalNode, type LogicalNodeType,
  type Graph, type Edge, type Bug, type BugStore, type Annotation, type AnnotationStore,
  type CoverageRule, type CoverageStore, type AnalyzerConfig, type Review, type ReviewStore,
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

// --- logical nodes -----------------------------------------------------------

interface NodeRow {
  id: string; type: string; title: string; summary: string; body: string;
  anchors: string; generated_by: string | null;
}

function rowToNode(r: NodeRow): LogicalNode {
  return {
    id: r.id,
    type: (r.type ?? "module") as LogicalNodeType,
    title: r.title ?? "",
    summary: r.summary ?? "",
    anchors: JSON.parse(r.anchors ?? "[]"),
    body: r.body ?? "",
    ...(r.generated_by ? { generatedBy: r.generated_by } : {}),
  };
}

export async function loadNodes(root: string): Promise<LogicalNode[]> {
  const rows = db(root).prepare("SELECT * FROM nodes").all() as unknown as NodeRow[];
  return rows.map(rowToNode);
}

// A conservative id-safe slug (kept: node ids are still human-facing).
export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "node";
}

/** Upsert one logical node. */
export async function writeNode(root: string, node: LogicalNode): Promise<void> {
  db(root).prepare(
    "INSERT OR REPLACE INTO nodes(id,type,title,summary,body,anchors,generated_by) VALUES(?,?,?,?,?,?,?)",
  ).run(node.id, node.type, node.title, node.summary, node.body, JSON.stringify(node.anchors), node.generatedBy ?? null);
}

export async function deleteNode(root: string, id: string): Promise<void> {
  db(root).prepare("DELETE FROM nodes WHERE id = ?").run(id);
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
