/**
 * The operations behind the MCP tools — a plain async API over a `.codemap/`
 * repo. Kept free of any protocol concern so it can be driven from tests, a
 * CLI, or the MCP server identically.
 *
 * Every operation that writes a claim (document / report_bug / annotate)
 * validates that the anchors it references actually exist — the "no floating
 * claims" invariant, enforced mechanically.
 */

import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  type Anchor, type LogicalNode, type LogicalNodeType, type EdgeType, type State,
  type Bug, type BugStatus, type BugSeverity, type Annotation,
  type AnchorSelector, type CoverageMark, type CoverageState, type Edge,
  SCHEMA_VERSION,
} from "./schema.js";
import { indexFile, indexRepo } from "./repo.js";
import { headCommit, currentBranch, isDirty } from "./git.js";
import { computeStaleness } from "./stale.js";
import {
  readAnchorStore, readState, writeState, writeStore, loadNodes, readGraph, writeGraph, writeNode, slug,
  readBugs, writeBugs, readAnnotations, writeAnnotations, readCoverage, writeCoverage, readReviews,
  writeSnapshot, listSnapshots,
} from "./store.js";
import { GRAMMAR_VERSIONS } from "./grammar-versions.js";
import { computeDiff, anchorCodeDiff } from "./diff.js";
import { resolveCoverage, selectAnchors, docPct as computeDocPct, type CoverageResult } from "./coverage.js";
import { resolveAnchorRefs } from "./refs.js";
import { refreshAnalyzers } from "./analyzers/run.js";
import { applyIndexUpdate } from "./sync.js";
import { grammarForPath } from "./grammars.js";
import { reviewStatus, reviewStatesFor, anchorReviewMap } from "./reviews.js";

const HL_LANG: Record<string, string> = { c_sharp: "csharp", python: "python", javascript: "javascript", typescript: "typescript", tsx: "typescript" };
const langFor = (file: string) => HL_LANG[grammarForPath(file) ?? ""] ?? "plaintext";

function genId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

/** Re-index the given files and return current anchors by id (source of truth for "now"). */
async function liveAnchors(root: string, files: Iterable<string>): Promise<Map<string, Anchor>> {
  const map = new Map<string, Anchor>();
  for (const f of new Set(files)) {
    try {
      for (const a of await indexFile(join(root, f), f)) map.set(a.id, a);
    } catch {
      /* unreadable / unparseable — treat as no anchors */
    }
  }
  return map;
}

function anchorBrief(a: Anchor) {
  return {
    id: a.id,
    file: a.file,
    symbol: a.symbolPath.join(" › "),
    kind: a.kind,
    lines: a.loc ? `${a.loc.startLine}-${a.loc.endLine}` : undefined,
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Effective coverage state per anchor, from citation + stored rules. */
async function coverageFor(root: string): Promise<{ store: Awaited<ReturnType<typeof readAnchorStore>>; nodes: LogicalNode[]; result: CoverageResult }> {
  const [store, nodes, cov] = await Promise.all([readAnchorStore(root), loadNodes(root), readCoverage(root)]);
  const cited = new Set(nodes.flatMap((n) => n.anchors));
  return { store, nodes, result: resolveCoverage(store.anchors, cited, cov.rules) };
}

export async function status(root: string) {
  const [{ store, nodes, result }, graph, bugStore, annStore] = await Promise.all([
    coverageFor(root), readGraph(root), readBugs(root), readAnnotations(root),
  ]);
  let baselineCommit: string | null = null;
  try {
    baselineCommit = (await readState(root)).lastVerifiedCommit;
  } catch {
    /* not initialized */
  }
  const nodesByType: Record<string, number> = {};
  for (const n of nodes) nodesByType[n.type] = (nodesByType[n.type] ?? 0) + 1;
  const bugsByStatus: Record<string, number> = {};
  for (const b of bugStore.bugs) bugsByStatus[b.status] = (bugsByStatus[b.status] ?? 0) + 1;
  return {
    anchors: store.anchors.length,
    coverage: result.breakdown, // open / cited / covered / trivial / deferred / owned
    docPct: computeDocPct(result.breakdown),
    open: result.breakdown.open, // the real work queue size
    nodes: nodes.length,
    nodesByType,
    edges: graph.edges.length,
    bugs: bugStore.bugs.length,
    bugsByStatus,
    annotations: annStore.annotations.length,
    baselineCommit,
  };
}

/** The documentation work queue: only `open` anchors, ranked by likely value. */
export async function findGaps(
  root: string,
  opts: { pathPrefix?: string; kind?: string; limit?: number } = {},
) {
  const { store, result } = await coverageFor(root);
  let open = store.anchors.filter((a) => result.state.get(a.id) === "open");
  if (opts.pathPrefix) open = open.filter((a) => a.file.startsWith(opts.pathPrefix!));
  if (opts.kind) open = open.filter((a) => a.kind === opts.kind);
  // Rank: type shells first (documenting a type organizes its members), then
  // callables by size (more lines ≈ more logic worth capturing).
  const size = (a: Anchor) => (a.loc ? a.loc.endLine - a.loc.startLine : 0);
  const isType = (a: Anchor) => ["class", "interface", "struct", "record", "enum"].includes(a.kind);
  open.sort((x, y) => Number(isType(y)) - Number(isType(x)) || size(y) - size(x));
  const limit = opts.limit ?? 50;
  return {
    openCount: open.length,
    showing: Math.min(limit, open.length),
    open: open.slice(0, limit).map(anchorBrief),
  };
}

/** Add a coverage/scope rule (P0.2/P0.3): mark selected anchors covered/trivial/deferred/owned. */
export async function cover(
  root: string,
  input: { as: CoverageMark; node?: string; owner?: string; select: AnchorSelector },
) {
  if (input.as === "owned" && !input.owner) return { error: "`owned` requires `owner` (the universe that owns the doc)" };
  if (input.as === "covered" && input.node) {
    const nodes = await loadNodes(root);
    if (!nodes.some((n) => n.id === input.node)) return { error: `unknown node "${input.node}"` };
  }
  const store = await readAnchorStore(root);
  const matched = selectAnchors(store.anchors, input.select);
  if (!matched.length) return { error: "selector matched 0 anchors — check pathPrefix/file/kind/symbol" };
  const cov = await readCoverage(root);
  cov.rules.push({ id: genId("rule"), as: input.as, node: input.node, owner: input.owner, select: input.select });
  await writeCoverage(root, cov.rules);
  return { ok: true, as: input.as, matched: matched.length, sample: matched.slice(0, 5).map((a) => a.symbolPath.join(".")) };
}

/**
 * Full re-baseline: re-index the whole repo at the current HEAD and replace the
 * live (`@work`) anchor set, advancing the baseline commit + branch. Non-
 * destructive to the map — nodes, edges, reviews, coverage, bugs, and
 * annotations are separate stores and are untouched; only anchors + state move.
 * Also caches the commit as a diff snapshot. This is `init` re-run on demand.
 */
export async function reindex(root: string) {
  const anchors = await indexRepo(root);
  const commit = headCommit(root);
  const branch = currentBranch(root);
  for (const a of anchors) a.lastVerifiedCommit = commit;
  const state: State = { schemaVersion: SCHEMA_VERSION, lastVerifiedCommit: commit, branch, grammarVersions: GRAMMAR_VERSIONS };
  await writeStore(root, anchors, state);
  if (commit) await writeSnapshot(root, commit, branch, anchors, new Date().toISOString());
  const files = new Set(anchors.map((a) => a.file)).size;
  return { ok: true, anchors: anchors.length, files, commit, branch };
}

/**
 * If the checked-out branch differs from the one the index was baselined on,
 * re-init to the new branch's HEAD and return a note. First-ever call just
 * records the current branch (older indexes predate the field) without the
 * expensive re-index. Returns null when nothing was done. Caller must hold the
 * write lock (this can write).
 */
async function maybeReindexOnBranchChange(root: string) {
  let state: State;
  try {
    state = await readState(root);
  } catch {
    return null; // not initialized
  }
  const cur = currentBranch(root);
  if (cur == null) return null; // detached / no git — nothing to track
  if (state.branch === undefined || state.branch === null) {
    await writeState(root, { ...state, branch: cur }); // start tracking, no re-index
    return null;
  }
  if (cur !== state.branch) {
    const r = await reindex(root);
    return { rebaselined: true, from: state.branch, to: cur, anchors: r.anchors, commit: r.commit };
  }
  return null;
}

/** Run the staleness pass — which docs are flagged by changed/lost code. */
export async function checkStale(root: string) {
  // A branch switch means "different code now" — re-baseline before checking.
  const rebaseline = await maybeReindexOnBranchChange(root);
  const [store, nodes] = await Promise.all([readAnchorStore(root), loadNodes(root)]);
  let commit: string | null = null;
  try {
    commit = (await readState(root)).lastVerifiedCommit;
  } catch {
    /* not initialized */
  }
  const r = await computeStaleness(root, store, nodes, commit);
  const byId = new Map(store.anchors.map((a) => [a.id, a]));
  const changed = r.checks.length > 0 || r.addedAnchorIds.length > 0;
  // Bring the anchor store up to date (new anchors resolve; moved locs refreshed),
  // then keep any analyzer-covered graph current.
  const indexUpdate = await applyIndexUpdate(root);
  const refreshed = await refreshAnalyzers(root, { changed });
  return {
    scope: r.scope,
    ok: r.okCount,
    stale: r.checks.map((c) => ({ ...c, anchor: byId.get(c.anchorId) ? anchorBrief(byId.get(c.anchorId)!) : undefined })),
    flaggedDocs: r.flaggedNodes.map((f) => ({
      node: f.node.id,
      title: f.node.title,
      reasons: f.reasons,
    })),
    ...(indexUpdate.added || indexUpdate.movedLoc ? { indexUpdate } : {}),
    ...(refreshed.length ? { refreshedAnalyzers: refreshed } : {}),
    ...(rebaseline ? { rebaselined: rebaseline } : {}),
  };
}

/**
 * Cache the current commit's anchors as an immutable snapshot (the branch-diff
 * cache). Does a fresh full index so the snapshot reflects what's checked out.
 * Call this on a branch before switching away, so it can be diffed later without
 * a checkout. `init` snapshots automatically; this is the manual/agent trigger.
 */
export async function snapshot(root: string) {
  const commit = headCommit(root);
  if (!commit) return { error: "no git commit to snapshot (not a git repo, or no HEAD)" };
  const anchors = await indexRepo(root);
  await writeSnapshot(root, commit, currentBranch(root), anchors, new Date().toISOString());
  return { ok: true, ref: commit, branch: currentBranch(root), anchors: anchors.length, dirty: isDirty(root) };
}

/** List cached commit snapshots available to diff. */
export async function snapshots(root: string) {
  return { snapshots: await listSnapshots(root) };
}

/**
 * Diff two anchor snapshots — added/removed/changed symbols plus the impact on
 * the nodes, flows, and reviews that cite them. `base` is a cached snapshot; omit
 * `head` to diff against a fresh index of the current working tree (the PR-review
 * path), or pass a second cached ref for a pure historical set-op.
 */
export async function diff(root: string, base: string, head?: string) {
  return computeDiff(root, base, head);
}

/** Before/after source for one anchor between two refs (the code drill-down) + its review state. */
export async function diffCode(root: string, base: string, head: string | undefined, id: string, file: string) {
  const code = await anchorCodeDiff(root, base, head, id, file);
  let rp: { logical: { state: string }; code: { state: string } } | undefined;
  try {
    rp = (await reviewStatesFor(root, [{ kind: "anchor", id }])).get(`anchor:${id}`);
  } catch { /* review state best-effort */ }
  return { ...code, review: { logical: rp?.logical.state ?? "unreviewed", code: rp?.code.state ?? "unreviewed" } };
}

/** Collapse a namespace to a browsable domain (e.g. Acme.Settlement.Cards.Handlers → Settlement.Cards). */
function domainOf(ns: string | undefined): string {
  if (!ns) return "(none)";
  const p = ns.split(".");
  if (p[0] === "Acme" && p[1] && p[2]) return `${p[1]}.${p[2]}`;
  return p.slice(0, 2).join(".") || ns;
}

/** The dominant namespace among a node's cited anchors (for domain grouping). */
function topNamespace(anchorIds: string[], nsById: Map<string, string | undefined>): string | undefined {
  const tally = new Map<string, number>();
  for (const id of anchorIds) {
    const ns = nsById.get(id);
    if (ns) tally.set(ns, (tally.get(ns) ?? 0) + 1);
  }
  return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * The node catalog: every logical node with its domain, edge degree, provenance,
 * and review state — the node-first surface (browse/filter/mark-reviewed) that
 * complements the flow-first and file-first views. Review state is batched
 * (reviewStatesFor re-indexes only files with reviewed anchors, so it's cheap).
 */
export async function nodeCatalog(root: string) {
  const [nodes, graph, store] = await Promise.all([loadNodes(root), readGraph(root), readAnchorStore(root)]);
  const nsById = new Map(store.anchors.map((a) => [a.id, a.symbolPath[0]]));
  const inC = new Map<string, number>();
  const outC = new Map<string, number>();
  for (const e of graph.edges) {
    outC.set(e.from, (outC.get(e.from) ?? 0) + 1);
    inC.set(e.to, (inC.get(e.to) ?? 0) + 1);
  }
  const reviews = await reviewStatesFor(root, nodes.map((n) => ({ kind: "node" as const, id: n.id })));
  const out = nodes.map((n) => {
    const topNs = topNamespace(n.anchors, nsById);
    const rp = reviews.get(`node:${n.id}`);
    return {
      id: n.id,
      type: n.type,
      title: n.title,
      summary: n.summary,
      domain: domainOf(topNs),
      namespace: topNs ?? null,
      anchors: n.anchors.length,
      edgesIn: inC.get(n.id) ?? 0,
      edgesOut: outC.get(n.id) ?? 0,
      degree: (inC.get(n.id) ?? 0) + (outC.get(n.id) ?? 0),
      generatedBy: n.generatedBy ?? null,
      review: { logical: rp?.logical.state ?? "unreviewed", code: rp?.code.state ?? "unreviewed" },
    };
  });
  const tally = (arr: typeof out, k: "type" | "domain") =>
    arr.reduce<Record<string, number>>((m, x) => ((m[x[k] ?? "(none)"] = (m[x[k] ?? "(none)"] ?? 0) + 1), m), {});
  const reviewed = out.filter((n) => n.review.logical !== "unreviewed" || n.review.code !== "unreviewed").length;
  return {
    total: out.length,
    reviewed,
    byType: tally(out, "type"),
    byDomain: tally(out, "domain"),
    nodes: out,
  };
}

/**
 * Event wiring matrix — events as rows, the aggregates/projections they feed as
 * columns, cells = folds (into an aggregate) or projects (to a projection). This
 * is the audit view for an event-sourced graph: a high-degree sink (e.g. a
 * projection that consumes every event) is one dense column instead of a 50-spoke
 * wheel, and an **orphan** event (folded/projected by nothing) is a blank row.
 * Per-row it also carries the emitter count (handlers that raise it) and review
 * state, so events can be reviewed straight from the matrix.
 */
export async function eventMatrix(root: string) {
  const [nodes, graph, store] = await Promise.all([loadNodes(root), readGraph(root), readAnchorStore(root)]);
  const nsById = new Map(store.anchors.map((a) => [a.id, a.symbolPath[0]]));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const events = nodes.filter((n) => n.type === "event_family");

  const foldProject = graph.edges.filter((e) => (e.type === "folds" || e.type === "projects") && byId.get(e.from)?.type === "event_family");
  // Columns = the aggregates/projections events actually feed. Aggregates first.
  const sinkIds = [...new Set(foldProject.map((e) => e.to))].filter((id) => byId.has(id));
  const sinks = sinkIds
    .map((id) => ({ id, title: byId.get(id)!.title, type: byId.get(id)!.type }))
    .sort((a, b) => (a.type === b.type ? a.title.localeCompare(b.title) : a.type === "aggregate" ? -1 : 1));

  const emitsInto = new Map<string, number>();
  for (const e of graph.edges) if (e.type === "emits") emitsInto.set(e.to, (emitsInto.get(e.to) ?? 0) + 1);

  const cellsByEvent = new Map<string, Record<string, string>>();
  for (const e of foldProject) {
    let m = cellsByEvent.get(e.from);
    if (!m) { m = {}; cellsByEvent.set(e.from, m); }
    m[e.to] = e.type; // "folds" | "projects"
  }

  const reviews = await reviewStatesFor(root, events.map((n) => ({ kind: "node" as const, id: n.id })));
  const rows = events
    .map((n) => {
      const cells = cellsByEvent.get(n.id) ?? {};
      const folds = Object.values(cells).filter((v) => v === "folds").length;
      const projects = Object.values(cells).filter((v) => v === "projects").length;
      const rp = reviews.get(`node:${n.id}`);
      return {
        id: n.id,
        title: n.title,
        domain: domainOf(topNamespace(n.anchors, nsById)),
        emitters: emitsInto.get(n.id) ?? 0,
        cells,
        folds,
        projects,
        orphan: folds === 0 && projects === 0,
        review: { logical: rp?.logical.state ?? "unreviewed", code: rp?.code.state ?? "unreviewed" },
      };
    })
    .sort((a, b) => a.domain.localeCompare(b.domain) || a.title.localeCompare(b.title));

  return {
    sinks,
    events: rows,
    stats: {
      events: rows.length,
      orphans: rows.filter((r) => r.orphan).length,
      aggregates: sinks.filter((s) => s.type === "aggregate").length,
      projections: sinks.filter((s) => s.type === "projection").length,
    },
  };
}

/**
 * Drill-down navigation over the structural tree that already lives in the
 * anchor paths — the primitive for understanding a large codebase top-down.
 * A directory prefix returns its immediate children (dirs/files) with anchor
 * counts, documentation coverage, and node/bug rollups; a file prefix returns
 * its symbols. You never list everything — you expand one level at a time.
 */
export async function outline(root: string, prefix = "") {
  const [{ store, nodes, result }, bugStore, reviewStore] = await Promise.all([coverageFor(root), readBugs(root), readReviews(root)]);
  const byId = new Map(store.anchors.map((a) => [a.id, a]));
  const state = (id: string) => result.state.get(id) ?? "open";
  const reviews = await anchorReviewMap(root, store.anchors, nodes, reviewStore.reviews);
  const rv = (id: string) => reviews.get(id) ?? { code: "unreviewed" as const, logical: "unreviewed" as const };
  const inScope = (id: string) => { const s = state(id); return s === "open" || s === "cited" || s === "covered"; };

  // A file prefix → list that file's symbols.
  const fileAnchors = store.anchors.filter((a) => a.file === prefix);
  if (fileAnchors.length) {
    return {
      prefix,
      kind: "file" as const,
      symbols: fileAnchors
        .sort((a, b) => (a.loc?.startLine ?? 0) - (b.loc?.startLine ?? 0))
        .map((a) => ({
          ...anchorBrief(a),
          coverage: state(a.id),
          review: rv(a.id),
          nodes: nodes.filter((n) => n.anchors.includes(a.id)).map((n) => n.id),
        })),
    };
  }

  // Otherwise a directory prefix → group by the next path segment, rolling up
  // the coverage state breakdown so docPct/open counts are honest.
  const p = prefix ? (prefix.endsWith("/") ? prefix : prefix + "/") : "";
  type Grp = { anchors: number; b: Record<CoverageState, number>; isFile: boolean; rDenom: number; rc: number; rcStale: number; rl: number; rlStale: number };
  const groups = new Map<string, Grp>();
  for (const a of store.anchors) {
    if (!a.file.startsWith(p)) continue;
    const rest = a.file.slice(p.length);
    const slash = rest.indexOf("/");
    const seg = slash === -1 ? rest : rest.slice(0, slash);
    let g = groups.get(seg);
    if (!g) groups.set(seg, (g = { anchors: 0, b: { open: 0, cited: 0, covered: 0, trivial: 0, deferred: 0, owned: 0 }, isFile: slash === -1, rDenom: 0, rc: 0, rcStale: 0, rl: 0, rlStale: 0 }));
    g.anchors++;
    g.b[state(a.id)]++;
    if (inScope(a.id)) { // review % over documentable anchors only
      g.rDenom++;
      const r = rv(a.id);
      if (r.code === "reviewed") g.rc++; else if (r.code === "stale") g.rcStale++;
      if (r.logical === "reviewed") g.rl++; else if (r.logical === "stale") g.rlStale++;
    }
  }
  const underPath = (nodeAnchorIds: string[], childPath: string) =>
    nodeAnchorIds.some((id) => {
      const a = byId.get(id);
      return a && (a.file === childPath || a.file.startsWith(childPath + "/"));
    });
  const children = [...groups.entries()]
    .map(([name, g]) => {
      const path = p + name;
      const denom = g.b.open + g.b.cited + g.b.covered;
      return {
        name,
        path,
        kind: g.isFile ? ("file" as const) : ("dir" as const),
        anchors: g.anchors,
        open: g.b.open, // in-scope, undocumented — the real work here
        docPct: denom ? Math.round((100 * (g.b.cited + g.b.covered)) / denom) : 0,
        review: { total: g.rDenom, logical: g.rl, logicalStale: g.rlStale, code: g.rc, codeStale: g.rcStale },
        nodes: nodes.filter((n) => underPath(n.anchors, path)).length,
        bugs: bugStore.bugs.filter((b) => underPath(b.anchors, path)).length,
      };
    })
    .sort((x, y) => y.anchors - x.anchors);
  return { prefix: p, kind: "dir" as const, childrenCount: children.length, children };
}

// ---------------------------------------------------------------------------
// Reading the graph & code
// ---------------------------------------------------------------------------

export async function search(root: string, query: string, limit = 30) {
  const q = query.toLowerCase();
  const [store, nodes] = await Promise.all([readAnchorStore(root), loadNodes(root)]);
  const anchors = store.anchors
    .filter((a) => a.symbolPath.join(".").toLowerCase().includes(q) || a.file.toLowerCase().includes(q))
    .slice(0, limit)
    .map(anchorBrief);
  const nodeHits = nodes
    .filter((n) =>
      n.id.toLowerCase().includes(q) ||
      n.title.toLowerCase().includes(q) ||
      n.summary.toLowerCase().includes(q) ||
      n.body.toLowerCase().includes(q),
    )
    .slice(0, limit)
    .map((n) => ({ id: n.id, type: n.type, title: n.title, summary: n.summary }));
  return { anchors, nodes: nodeHits };
}

export async function getNode(root: string, id: string) {
  const [nodes, graph, store, annStore] = await Promise.all([
    loadNodes(root), readGraph(root), readAnchorStore(root), readAnnotations(root),
  ]);
  const node = nodes.find((n) => n.id === id);
  if (!node) return { error: `no node "${id}"` };
  const byId = new Map(store.anchors.map((a) => [a.id, a]));
  return {
    ...node,
    resolvedAnchors: node.anchors.map((aid) => (byId.get(aid) ? anchorBrief(byId.get(aid)!) : { id: aid, missing: true })),
    edges: graph.edges.filter((e) => e.from === id || e.to === id),
    annotations: annStore.annotations.filter((a) => a.target.kind === "node" && a.target.id === id),
    review: await reviewStatus(root, { kind: "node", id }),
  };
}

/** A node's immediate graph neighborhood (for the graph viewer). Same-universe only. */
export async function neighborhood(root: string, id: string) {
  const [nodes, graph] = await Promise.all([loadNodes(root), readGraph(root)]);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const node = byId.get(id);
  if (!node) return { error: `no node "${id}"` };
  const seen = new Map<string, { id: string; title: string; type: string; edges: { edgeType: string; dir: "in" | "out" }[] }>();
  for (const e of graph.edges) {
    let nbrId: string | null = null;
    let dir: "in" | "out" = "out";
    if (e.from === id) { nbrId = e.to; dir = "out"; }
    else if (e.to === id) { nbrId = e.from; dir = "in"; }
    if (!nbrId || nbrId.includes("::")) continue; // cross-universe handled elsewhere
    const nb = byId.get(nbrId);
    const cur = seen.get(nbrId) ?? { id: nbrId, title: nb?.title ?? nbrId, type: nb?.type ?? "unknown", edges: [] };
    cur.edges.push({ edgeType: e.type, dir });
    seen.set(nbrId, cur);
  }
  return { id, title: node.title, type: node.type, neighbors: [...seen.values()] };
}

/**
 * Induced subgraph for the force-directed explorer: the nodes in `ids`, plus (if
 * `expand` is given) the neighbors of that one node, with every edge among the
 * resulting set. Each node carries its full-graph degree vs how much is shown, so
 * the UI can flag which nodes still have hidden neighbors to expand into. This is
 * the incremental-exploration primitive — grow the view one node at a time
 * instead of dumping a whole neighborhood at once.
 */
export async function subgraph(root: string, ids: string[], expand?: string) {
  const [nodes, graph] = await Promise.all([loadNodes(root), readGraph(root)]);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const set = new Set(ids.filter((id) => byId.has(id)));
  if (expand && byId.has(expand)) {
    set.add(expand);
    for (const e of graph.edges) {
      if (e.from === expand && byId.has(e.to)) set.add(e.to);
      if (e.to === expand && byId.has(e.from)) set.add(e.from);
    }
  }
  const totalDeg = new Map<string, number>();
  for (const e of graph.edges) {
    if (byId.has(e.from)) totalDeg.set(e.from, (totalDeg.get(e.from) ?? 0) + 1);
    if (byId.has(e.to)) totalDeg.set(e.to, (totalDeg.get(e.to) ?? 0) + 1);
  }
  const edges = graph.edges.filter((e) => set.has(e.from) && set.has(e.to)).map((e) => ({ from: e.from, to: e.to, type: e.type }));
  const shownDeg = new Map<string, number>();
  for (const e of edges) { shownDeg.set(e.from, (shownDeg.get(e.from) ?? 0) + 1); shownDeg.set(e.to, (shownDeg.get(e.to) ?? 0) + 1); }
  const reviews = await reviewStatesFor(root, [...set].map((id) => ({ kind: "node" as const, id })));
  const outNodes = [...set].map((id) => {
    const n = byId.get(id)!;
    const rp = reviews.get(`node:${id}`);
    return {
      id, title: n.title, type: n.type,
      degree: totalDeg.get(id) ?? 0,
      hidden: (totalDeg.get(id) ?? 0) - (shownDeg.get(id) ?? 0),
      review: { logical: rp?.logical.state ?? "unreviewed", code: rp?.code.state ?? "unreviewed" },
    };
  });
  return {
    nodes: outNodes,
    edges,
    edgeTypes: [...new Set(edges.map((e) => e.type))].sort(),
    nodeTypes: [...new Set(outNodes.map((n) => n.type))].sort(),
    seed: expand ?? ids[0] ?? null,
  };
}

/** All process nodes (flows) with step counts + review rollup — the bird's-eye view. */
export async function flows(root: string) {
  const [nodes, graph] = await Promise.all([loadNodes(root), readGraph(root)]);
  const processes = nodes.filter((n) => n.type === "process");
  const stepsByProc = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.type !== "step_of") continue;
    (stepsByProc.get(e.to) ?? stepsByProc.set(e.to, []).get(e.to)!).push(e.from);
  }
  const targets: { kind: "node"; id: string }[] = [];
  for (const p of processes) {
    targets.push({ kind: "node", id: p.id });
    for (const sid of stepsByProc.get(p.id) ?? []) targets.push({ kind: "node", id: sid });
  }
  const rev = await reviewStatesFor(root, targets);
  const rollup = (ids: string[]) => {
    let logical = 0, code = 0, stale = 0;
    for (const id of ids) {
      const r = rev.get("node:" + id);
      if (r?.logical.state === "reviewed") logical++;
      if (r?.code.state === "reviewed") code++;
      if (r?.logical.state === "stale" || r?.code.state === "stale") stale++;
    }
    return { logical, code, stale, total: ids.length };
  };
  return {
    flows: processes.map((p) => ({
      id: p.id, title: p.title, summary: p.summary,
      steps: (stepsByProc.get(p.id) ?? []).length,
      review: rev.get("node:" + p.id),
      stepReview: rollup(stepsByProc.get(p.id) ?? []),
    })),
  };
}

/**
 * Layered event-pipeline graph: the Marten chain command → handler → event →
 * aggregate → projection laid out left-to-right, one column per role. Nodes are
 * ordered within each column by barycenter (a couple of Sugiyama sweeps) to pull
 * connected chains together and cut edge crossings. The whole-application graph
 * view — the client just maps layer→x and row→y; the ordering is done here.
 * Optional `domain` narrows the left columns to one subsystem (aggregates /
 * projections its events feed are kept so chains stay whole).
 */
const PIPELINE_LAYER: Record<string, number> = { command: 0, handler: 1, event_family: 2, aggregate: 3, projection: 4 };

export async function pipelineGraph(root: string, opts: { domain?: string } = {}) {
  const [nodes, graph, store] = await Promise.all([loadNodes(root), readGraph(root), readAnchorStore(root)]);
  const nsById = new Map(store.anchors.map((a) => [a.id, a.symbolPath[0]]));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const inLayer = (n: LogicalNode) => PIPELINE_LAYER[n.type] !== undefined;
  const domOf = (n: LogicalNode) => domainOf(topNamespace(n.anchors, nsById));

  const relTypes = new Set(["handles", "emits", "folds", "projects"]);
  const rel = graph.edges.filter((e) => relTypes.has(e.type) && byId.has(e.from) && byId.has(e.to));

  // Which nodes are in scope (optionally narrowed to a domain, keeping sinks).
  let sel: Set<string>;
  if (opts.domain) {
    sel = new Set(nodes.filter((n) => inLayer(n) && PIPELINE_LAYER[n.type]! <= 2 && domOf(n) === opts.domain).map((n) => n.id));
    for (const e of rel) if ((e.type === "folds" || e.type === "projects") && sel.has(e.from)) sel.add(e.to);
  } else {
    sel = new Set(nodes.filter(inLayer).map((n) => n.id));
  }
  const edges = rel.filter((e) => sel.has(e.from) && sel.has(e.to));

  const layers: LogicalNode[][] = [[], [], [], [], []];
  for (const id of sel) { const n = byId.get(id)!; layers[PIPELINE_LAYER[n.type]!]!.push(n); }
  for (const L of layers) L.sort((a, b) => domOf(a).localeCompare(domOf(b)) || a.title.localeCompare(b.title));

  // Barycenter ordering over the undirected adjacency in adjacent layers.
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => { let l = adj.get(a); if (!l) { l = []; adj.set(a, l); } l.push(b); };
  for (const e of edges) { link(e.from, e.to); link(e.to, e.from); }
  const layerIndex = new Map<string, number>();
  layers.forEach((L, li) => L.forEach((n) => layerIndex.set(n.id, li)));
  const pos = new Map<string, number>();
  const setPos = () => layers.forEach((L) => L.forEach((n, i) => pos.set(n.id, i)));
  setPos();
  const sweep = (order: number[]) => {
    for (const li of order) {
      const L = layers[li]!;
      const bary = new Map<string, number>();
      for (const n of L) {
        const neigh = (adj.get(n.id) ?? []).filter((m) => Math.abs(layerIndex.get(m)! - li) === 1);
        bary.set(n.id, neigh.length ? neigh.reduce((s, m) => s + pos.get(m)!, 0) / neigh.length : pos.get(n.id)!);
      }
      L.sort((a, b) => bary.get(a.id)! - bary.get(b.id)!);
      setPos();
    }
  };
  for (let k = 0; k < 4; k++) { sweep([1, 2, 3, 4]); sweep([3, 2, 1, 0]); }

  const reviews = await reviewStatesFor(root, [...sel].map((id) => ({ kind: "node" as const, id })));
  const outNodes: any[] = [];
  layers.forEach((L, li) =>
    L.forEach((n, row) => {
      const rp = reviews.get(`node:${n.id}`);
      outNodes.push({
        id: n.id, title: n.title, type: n.type, domain: domOf(n), layer: li, row,
        degree: (adj.get(n.id) ?? []).length,
        review: { logical: rp?.logical.state ?? "unreviewed", code: rp?.code.state ?? "unreviewed" },
      });
    }),
  );
  const domains = [...new Set(nodes.filter((n) => inLayer(n) && PIPELINE_LAYER[n.type]! <= 2).map(domOf))].sort();
  return {
    layerNames: ["command", "handler", "event", "aggregate", "projection"],
    layerCounts: layers.map((L) => L.length),
    nodes: outNodes,
    edges: edges.map((e) => ({ from: e.from, to: e.to, type: e.type })),
    domains,
    domain: opts.domain ?? null,
  };
}

/** One flow: its ordered steps, each with touched modules + the live source of its anchors. */
export async function flow(root: string, id: string) {
  const [nodes, graph, store] = await Promise.all([loadNodes(root), readGraph(root), readAnchorStore(root)]);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const anchorById = new Map(store.anchors.map((a) => [a.id, a]));
  const proc = byId.get(id);
  if (!proc) return { error: `no flow "${id}"` };

  const stepNodes = graph.edges
    .filter((e) => e.type === "step_of" && e.to === id)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((e) => byId.get(e.from))
    .filter((n): n is LogicalNode => Boolean(n));

  const allAnchorIds = [...new Set(stepNodes.flatMap((s) => s.anchors))];
  const rev = await reviewStatesFor(root, [
    { kind: "node", id },
    ...stepNodes.map((s) => ({ kind: "node" as const, id: s.id })),
    ...allAnchorIds.map((aid) => ({ kind: "anchor" as const, id: aid })),
  ]);
  const touchesByStep = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.type !== "touches") continue;
    (touchesByStep.get(e.from) ?? touchesByStep.set(e.from, []).get(e.from)!).push(e.to);
  }

  // Cache live-indexed files so a step's several anchors in one file re-index once.
  // Slice the Buffer (loc are byte offsets — string.slice misaligns multi-byte files).
  const fileCache = new Map<string, { src: Buffer; byId: Map<string, Anchor> }>();
  const codeFor = async (a: Anchor): Promise<string | null> => {
    let fc = fileCache.get(a.file);
    if (!fc) {
      try {
        const src = await readFile(join(root, a.file));
        fc = { src, byId: new Map((await indexFile(join(root, a.file), a.file)).map((x) => [x.id, x])) };
      } catch {
        fc = { src: Buffer.alloc(0), byId: new Map() };
      }
      fileCache.set(a.file, fc);
    }
    const live = fc.byId.get(a.id);
    return live?.loc ? fc.src.subarray(live.loc.startByte, live.loc.endByte).toString("utf8") : null;
  };

  const steps = [];
  let order = 0;
  for (const s of stepNodes) {
    const anchors = [];
    for (const aid of s.anchors) {
      const a = anchorById.get(aid);
      if (!a) { anchors.push({ id: aid, missing: true }); continue; }
      anchors.push({ id: a.id, symbol: a.symbolPath.join(" › "), file: a.file, lines: a.loc ? `${a.loc.startLine}-${a.loc.endLine}` : undefined, kind: a.kind, lang: langFor(a.file), code: await codeFor(a), review: rev.get("anchor:" + a.id) });
    }
    steps.push({
      id: s.id, title: s.title, summary: s.summary, body: s.body, order: order++,
      review: rev.get("node:" + s.id),
      touches: (touchesByStep.get(s.id) ?? []).map((tid) => ({ id: tid, title: byId.get(tid)?.title ?? tid })),
      anchors,
    });
  }
  return { id, title: proc.title, summary: proc.summary, body: proc.body, review: rev.get("node:" + id), steps };
}

export async function getAnchor(root: string, id: string) {
  const [store, nodes, bugStore, annStore] = await Promise.all([
    readAnchorStore(root), loadNodes(root), readBugs(root), readAnnotations(root),
  ]);
  const anchor = store.anchors.find((a) => a.id === id);
  if (!anchor) return { error: `no anchor "${id}"` };
  // Resolve current code live so it is always exact.
  let code: string | null = null;
  let present = false;
  try {
    const src = await readFile(join(root, anchor.file)); // Buffer — loc are byte offsets
    const fresh = await indexFile(join(root, anchor.file), anchor.file);
    const live = fresh.find((a) => a.id === id);
    if (live?.loc) {
      code = src.subarray(live.loc.startByte, live.loc.endByte).toString("utf8");
      present = true;
    }
  } catch {
    /* file gone */
  }
  return {
    ...anchorBrief(anchor),
    present,
    code,
    citedBy: nodes.filter((n) => n.anchors.includes(id)).map((n) => ({ id: n.id, title: n.title })),
    bugs: bugStore.bugs.filter((b) => b.anchors.includes(id)).map((b) => ({ id: b.id, title: b.title, status: b.status })),
    annotations: annStore.annotations.filter((a) => a.target.kind === "anchor" && a.target.id === id),
    lang: langFor(anchor.file),
    review: await reviewStatus(root, { kind: "anchor", id }),
  };
}

// ---------------------------------------------------------------------------
// Documenting
// ---------------------------------------------------------------------------

/** Resolve human-friendly anchor refs (file#Symbol, file:line, or raw id) → ids. */
async function resolveRefs(root: string, refs: string[]): Promise<{ ids?: string[]; error?: string }> {
  const store = await readAnchorStore(root);
  const { ids, errors } = resolveAnchorRefs(store.anchors, refs);
  if (errors.length) return { error: errors.join("; ") };
  return { ids };
}

// --- shared helpers for authoring ---
const LINK_RE = /\[\[([^\]]+)\]\]/g;
function extractLinks(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(text)) !== null) out.push(m[1]!.trim());
  return out;
}
function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}
function addEdge(graph: { edges: Edge[] }, e: Edge): boolean {
  if (graph.edges.some((x) => x.from === e.from && x.to === e.to && x.type === e.type)) return false;
  graph.edges.push(e);
  return true;
}

interface StepInput { id?: string; title: string; summary: string; anchors: string[]; touches?: string[]; body?: string }

export async function document(
  root: string,
  input: { id?: string; type: LogicalNodeType; title: string; summary: string; anchors: string[]; body?: string; steps?: StepInput[] },
) {
  const r = await resolveRefs(root, input.anchors);
  if (r.error) return { error: r.error };
  const id = input.id ?? slug(input.title);
  const body = input.body ?? "";
  await writeNode(root, { id, type: input.type, title: input.title, summary: input.summary, anchors: r.ids!, body });

  const result: Record<string, unknown> = { ok: true, id, anchors: r.ids!.length };

  // P1.2 — inline ordered steps materialize step nodes + step_of + touches edges.
  if (input.type === "process" && input.steps?.length) {
    const graph = await readGraph(root);
    const taken = new Set((await loadNodes(root)).map((n) => n.id)); // includes the process just written
    const created: string[] = [];
    const warnings: string[] = [];
    let i = 0;
    for (const step of input.steps) {
      const sr = await resolveRefs(root, step.anchors);
      if (sr.error) return { error: `step "${step.title}": ${sr.error}` };
      const stepId = step.id ?? uniqueSlug(slug(step.title), taken);
      taken.add(stepId);
      await writeNode(root, { id: stepId, type: "step", title: step.title, summary: step.summary, anchors: sr.ids!, body: step.body ?? "" });
      created.push(stepId);
      addEdge(graph, { from: stepId, to: id, type: "step_of", order: i });
      for (const t of step.touches ?? []) {
        if (taken.has(t)) addEdge(graph, { from: stepId, to: t, type: "touches" });
        else warnings.push(`step "${step.title}" touches unknown node "${t}"`);
      }
      i++;
    }
    await writeGraph(root, graph);
    result.steps = created;
    if (warnings.length) result.warnings = warnings;
  }

  // P1.4 — flag [[links]] that don't resolve to a node (target may come later).
  const known = new Set((await loadNodes(root)).map((n) => n.id));
  const dangling = [...new Set(extractLinks(input.summary + "\n" + body))].filter((l) => !known.has(l));
  if (dangling.length) result.danglingLinks = dangling;
  return result;
}

/** P1.3 — add one edge or many in a single call (same-universe; use `link` for cross). */
export async function connect(
  root: string,
  input: { from?: string; to?: string; type?: EdgeType; order?: number; edges?: { from: string; to: string; type: EdgeType; order?: number }[] },
) {
  const list = input.edges ?? (input.from && input.to && input.type ? [{ from: input.from, to: input.to, type: input.type, order: input.order }] : []);
  if (!list.length) return { error: "provide an edge (from/to/type) or edges[]" };
  const nodeIds = new Set((await loadNodes(root)).map((n) => n.id));
  const graph = await readGraph(root);
  let added = 0;
  const errors: string[] = [];
  for (const e of list) {
    const missing = [e.from, e.to].filter((x) => !nodeIds.has(x));
    if (missing.length) {
      errors.push(`unknown node(s): ${missing.join(", ")}`);
      continue;
    }
    if (addEdge(graph, { from: e.from, to: e.to, type: e.type, order: e.order })) added++;
  }
  await writeGraph(root, graph);
  return { ok: true, added, edges: graph.edges.length, ...(errors.length ? { errors } : {}) };
}

/** P1.3 — patch a node without resending the whole body. */
export async function updateNode(
  root: string,
  input: { id: string; setTitle?: string; setSummary?: string; setBody?: string; addAnchors?: string[]; removeAnchors?: string[] },
) {
  const nodes = await loadNodes(root);
  const node = nodes.find((n) => n.id === input.id);
  if (!node) return { error: `no node "${input.id}"` };
  if (input.setTitle !== undefined) node.title = input.setTitle;
  if (input.setSummary !== undefined) node.summary = input.setSummary;
  if (input.setBody !== undefined) node.body = input.setBody;
  if (input.addAnchors?.length) {
    const r = await resolveRefs(root, input.addAnchors);
    if (r.error) return { error: r.error };
    for (const a of r.ids!) if (!node.anchors.includes(a)) node.anchors.push(a);
  }
  if (input.removeAnchors?.length) {
    const r = await resolveRefs(root, input.removeAnchors);
    if (r.error) return { error: r.error };
    const rm = new Set(r.ids!);
    node.anchors = node.anchors.filter((a) => !rm.has(a));
  }
  if (!node.anchors.length) return { error: "a node must keep ≥1 anchor (no floating claims)" };
  await writeNode(root, node);
  const known = new Set(nodes.map((n) => n.id));
  const dangling = [...new Set(extractLinks(node.summary + "\n" + node.body))].filter((l) => !known.has(l));
  return { ok: true, id: node.id, anchors: node.anchors.length, ...(dangling.length ? { danglingLinks: dangling } : {}) };
}

/** P1.4 — every dangling [[link]] across the universe. */
export async function linksReport(root: string) {
  const nodes = await loadNodes(root);
  const known = new Set(nodes.map((n) => n.id));
  const dangling: { node: string; danglingLinks: string[] }[] = [];
  for (const n of nodes) {
    const bad = [...new Set(extractLinks(n.summary + "\n" + n.body))].filter((l) => !known.has(l));
    if (bad.length) dangling.push({ node: n.id, danglingLinks: bad });
  }
  return { danglingCount: dangling.reduce((s, d) => s + d.danglingLinks.length, 0), nodes: dangling };
}

// ---------------------------------------------------------------------------
// Bugs
// ---------------------------------------------------------------------------

export async function reportBug(
  root: string,
  input: { title: string; description: string; anchors: string[]; severity?: BugSeverity },
) {
  const r = await resolveRefs(root, input.anchors);
  if (r.error) return { error: r.error };
  const anchorIds = r.ids!;
  const store = await readAnchorStore(root);
  const files = anchorIds.map((id) => store.anchors.find((a) => a.id === id)!.file);
  const live = await liveAnchors(root, files);
  const witnesses = anchorIds.map((id) => ({ anchorId: id, bodyHash: live.get(id)?.bodyHash ?? "sha256:absent" }));
  const bug: Bug = {
    id: genId("bug"),
    title: input.title,
    status: "open",
    severity: input.severity ?? "medium",
    description: input.description,
    anchors: anchorIds,
    witnesses,
    createdCommit: headCommit(root),
    history: ["opened"],
  };
  const bugStore = await readBugs(root);
  bugStore.bugs.push(bug);
  await writeBugs(root, bugStore.bugs);
  return { ok: true, id: bug.id };
}

/** List bugs, flagging those whose anchored code changed since filing ("possibly fixed"). */
export async function listBugs(root: string, opts: { status?: BugStatus } = {}) {
  const [bugStore, store] = await Promise.all([readBugs(root), readAnchorStore(root)]);
  let bugs = bugStore.bugs;
  if (opts.status) bugs = bugs.filter((b) => b.status === opts.status);
  const files = new Set<string>();
  for (const b of bugs) for (const id of b.anchors) {
    const a = store.anchors.find((x) => x.id === id);
    if (a) files.add(a.file);
  }
  const live = await liveAnchors(root, files);
  return {
    bugs: bugs.map((b) => {
      const changed = b.witnesses.filter((w) => live.get(w.anchorId)?.bodyHash !== w.bodyHash).map((w) => w.anchorId);
      return {
        id: b.id, title: b.title, status: b.status, severity: b.severity,
        anchors: b.anchors,
        possiblyFixed: b.status === "open" && changed.length > 0,
        changedAnchors: changed,
      };
    }),
  };
}

export async function updateBug(
  root: string,
  input: { id: string; status?: BugStatus; note?: string; addAnchors?: string[]; refreshWitnesses?: boolean },
) {
  const bugStore = await readBugs(root);
  const bug = bugStore.bugs.find((b) => b.id === input.id);
  if (!bug) return { error: `no bug "${input.id}"` };
  if (input.addAnchors?.length) {
    const r = await resolveRefs(root, input.addAnchors);
    if (r.error) return { error: r.error };
    for (const a of r.ids!) if (!bug.anchors.includes(a)) bug.anchors.push(a);
  }
  if (input.status && input.status !== bug.status) {
    bug.history.push(`status: ${bug.status} → ${input.status}`);
    bug.status = input.status;
  }
  if (input.note) bug.history.push(input.note);
  if (input.refreshWitnesses || input.status === "fixed") {
    const store = await readAnchorStore(root);
    const files = bug.anchors.map((id) => store.anchors.find((a) => a.id === id)?.file).filter(Boolean) as string[];
    const live = await liveAnchors(root, files);
    bug.witnesses = bug.anchors.map((id) => ({ anchorId: id, bodyHash: live.get(id)?.bodyHash ?? "sha256:absent" }));
    bug.history.push("witnesses refreshed");
  }
  await writeBugs(root, bugStore.bugs);
  return { ok: true, id: bug.id, status: bug.status };
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

export async function annotate(
  root: string,
  input: { targetKind: "anchor" | "node"; targetId: string; text: string; author?: string },
) {
  // Validate the target exists (anchor targets accept file#Symbol refs too).
  let targetId = input.targetId;
  if (input.targetKind === "anchor") {
    const r = await resolveRefs(root, [input.targetId]);
    if (r.error) return { error: r.error };
    targetId = r.ids![0]!;
  } else {
    const nodes = await loadNodes(root);
    if (!nodes.some((n) => n.id === input.targetId)) return { error: `unknown node "${input.targetId}"` };
  }
  const ann: Annotation = {
    id: genId("note"),
    target: { kind: input.targetKind, id: targetId },
    text: input.text,
    author: input.author ?? "agent",
    createdCommit: headCommit(root),
  };
  const annStore = await readAnnotations(root);
  annStore.annotations.push(ann);
  await writeAnnotations(root, annStore.annotations);
  return { ok: true, id: ann.id };
}
