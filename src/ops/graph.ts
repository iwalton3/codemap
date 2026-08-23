import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Anchor, type LogicalNode, type Edge } from "../schema.js";
import { indexFile } from "../repo.js";
import { readAnchorStore, loadNodes, readGraph, readAnnotations } from "../store.js";
import { reviewStatesFor, deriveCodeReview, type ReviewPair, type DerivedCodeReview } from "../reviews.js";
import { reviewTriageFor, coverageFor as triageCoverageFor, rollupCoverage } from "../triage.js";
import { langFor, anchorBrief, trustOf } from "./shared.js";

/**
 * Derived code review per node — a node reads code-reviewed only when every code
 * segment it cites is signed (see deriveCodeReview). One batched anchor query for
 * the whole set; missing anchors are excluded from the rollup (a lost anchor is a
 * `dangling` status, not an un-completable review). Used by every node-list surface
 * (catalog, matrix) so they agree with the node page. The single-flow op derives
 * inline instead, since it already fetches its anchors' reviews.
 */
async function nodeCodeReviews(
  root: string,
  nodes: { id: string; anchors: string[] }[],
  presentIds: Set<string>,
): Promise<Map<string, DerivedCodeReview>> {
  const anchorRev = await reviewStatesFor(root, [...new Set(nodes.flatMap((n) => n.anchors))].map((id) => ({ kind: "anchor" as const, id })));
  const out = new Map<string, DerivedCodeReview>();
  for (const n of nodes) {
    out.set(n.id, deriveCodeReview(n.anchors.filter((aid) => presentIds.has(aid)).map((aid) => anchorRev.get(`anchor:${aid}`)!.code)));
  }
  return out;
}
/**
 * The corpus-wide org prefix, if any: enterprise codebases root every namespace
 * under one company segment (`Corp.Settlement.Cards.Handlers`), which carries no
 * information as a grouping key. Detected rather than configured — the leading
 * segment counts as an org prefix only when it dominates the whole corpus, so a
 * repo whose top-level segments are real domains is left alone.
 */
function orgPrefixOf(nsById: Map<string, string | undefined>): string | undefined {
  const heads = new Map<string, number>();
  let total = 0;
  for (const ns of new Set(nsById.values())) {
    const p = ns?.split(".");
    if (!p || p.length < 2 || !p[0]) continue;
    total++;
    heads.set(p[0], (heads.get(p[0]) ?? 0) + 1);
  }
  if (total < 5) return undefined; // too small a corpus to call it
  const [head, n] = [...heads.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  return head && n! / total >= 0.8 ? head : undefined;
}

/** Collapse a namespace to a browsable domain (e.g. Corp.Settlement.Cards.Handlers → Settlement.Cards). */
function domainOf(ns: string | undefined, org?: string): string {
  if (!ns) return "(none)";
  const p = ns.split(".");
  if (org && p[0] === org && p[1] && p[2]) return `${p[1]}.${p[2]}`;
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
  const org = orgPrefixOf(nsById);
  const inC = new Map<string, number>();
  const outC = new Map<string, number>();
  for (const e of graph.edges) {
    outC.set(e.from, (outC.get(e.from) ?? 0) + 1);
    inC.set(e.to, (inC.get(e.to) ?? 0) + 1);
  }
  const rt = await reviewTriageFor(root, nodes.map((n) => ({ kind: "node" as const, id: n.id })));
  // Node code review is derived from each cited segment's own code review (see
  // nodeCodeReviews) so this list agrees with the node page.
  const codeReviews = await nodeCodeReviews(root, nodes, new Set(store.anchors.map((a) => a.id)));
  const out = nodes.map((n) => {
    const topNs = topNamespace(n.anchors, nsById);
    const e = rt.get(`node:${n.id}`);
    const rp = e?.review;
    const codeReview = codeReviews.get(n.id)!;
    const review = { logical: rp?.logical ?? { state: "unreviewed" as const }, code: { state: codeReview.state, actor: codeReview.actor ?? undefined } };
    return {
      id: n.id,
      type: n.type,
      title: n.title,
      summary: n.summary,
      domain: domainOf(topNs, org),
      namespace: topNs ?? null,
      anchors: n.anchors.length,
      edgesIn: inC.get(n.id) ?? 0,
      edgesOut: outC.get(n.id) ?? 0,
      degree: (inC.get(n.id) ?? 0) + (outC.get(n.id) ?? 0),
      generatedBy: n.generatedBy ?? null,
      status: n.status ?? "fresh",
      versionCount: n.versionCount ?? 1,
      review: { logical: review.logical.state, code: review.code.state },
      reviewBy: { logical: rp?.logical.actor ?? null, code: codeReview.actor },
      codeReview,
      viewed: { logical: e?.viewed.logical.state ?? "unreviewed", code: e?.viewed.code.state ?? "unreviewed" },
      trust: trustOf(n.status, review),
      triage: e?.triage,
      severity: e?.triage.severity ?? "untriaged",
    };
  });
  // Fold state-map enrichment pairs: a generated transition skeleton `mtr-x` and
  // its authored enrichment `tr-x` are ONE logical transition. Keep the enrichment
  // row (the reviewable, trust-bearing doc), merge in the skeleton's connectivity,
  // and drop the skeleton so the catalog doesn't double-count machines.
  const rowById = new Map(out.map((n) => [n.id, n]));
  const isSkeletonWithTwin = (n: (typeof out)[number]) => {
    if (!n.generatedBy || n.type !== "transition" || !n.id.startsWith("mtr-")) return false;
    const twin = rowById.get(n.id.slice(1));
    return !!twin && twin.type === "transition" && !twin.generatedBy;
  };
  const folded = out
    .filter((n) => !isSkeletonWithTwin(n))
    .map((n) => {
      if (n.type === "transition" && !n.generatedBy) {
        const sk = rowById.get("m" + n.id);
        if (sk && isSkeletonWithTwin(sk)) {
          return { ...n, edgesIn: n.edgesIn + sk.edgesIn, edgesOut: n.edgesOut + sk.edgesOut, degree: n.degree + sk.degree, skeleton: sk.id };
        }
      }
      return n;
    });
  const tally = (arr: typeof folded, k: "type" | "domain" | "status" | "severity") =>
    arr.reduce<Record<string, number>>((m, x) => ((m[x[k] ?? "(none)"] = (m[x[k] ?? "(none)"] ?? 0) + 1), m), {});
  const reviewed = folded.filter((n) => n.review.logical !== "unreviewed" || n.review.code !== "unreviewed").length;
  return {
    total: folded.length,
    reviewed,
    byType: tally(folded, "type"),
    byDomain: tally(folded, "domain"),
    byStatus: tally(folded, "status"),
    bySeverity: tally(folded, "severity"),
    coverage: rollupCoverage([...rt.values()].map((v) => v.triage)),
    nodes: folded,
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
  const org = orgPrefixOf(nsById);
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
  // Code review derives from each event's cited segments (see nodeCodeReviews) so
  // the matrix agrees with the node page — the code cell is a read-only rollup.
  const codeReviews = await nodeCodeReviews(root, events, new Set(store.anchors.map((a) => a.id)));
  const rows = events
    .map((n) => {
      const cells = cellsByEvent.get(n.id) ?? {};
      const folds = Object.values(cells).filter((v) => v === "folds").length;
      const projects = Object.values(cells).filter((v) => v === "projects").length;
      const rp = reviews.get(`node:${n.id}`);
      const codeReview = codeReviews.get(n.id)!;
      return {
        id: n.id,
        title: n.title,
        domain: domainOf(topNamespace(n.anchors, nsById), org),
        emitters: emitsInto.get(n.id) ?? 0,
        cells,
        folds,
        projects,
        orphan: folds === 0 && projects === 0,
        review: { logical: rp?.logical.state ?? "unreviewed", code: codeReview.state },
        reviewBy: { logical: rp?.logical.actor ?? null, code: codeReview.actor },
        codeReview,
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

export async function getNode(root: string, id: string) {
  const [nodes, graph, store, annStore] = await Promise.all([
    loadNodes(root), readGraph(root), readAnchorStore(root), readAnnotations(root),
  ]);
  const node = nodes.find((n) => n.id === id);
  if (!node) return { error: `no node "${id}"` };
  const byId = new Map(store.anchors.map((a) => [a.id, a]));
  // One batch for the node and all its anchors → review (vouch) + viewed + severity.
  const rt = await reviewTriageFor(root, [
    { kind: "node", id },
    ...node.anchors.map((aid) => ({ kind: "anchor" as const, id: aid })),
  ]);
  const nodeRt = rt.get(`node:${id}`)!;
  const resolvedAnchors = node.anchors.map((aid) => {
    const e = rt.get(`anchor:${aid}`);
    const brief = byId.get(aid) ? anchorBrief(byId.get(aid)!) : { id: aid, missing: true };
    return { ...brief, review: e?.review, viewed: e?.viewed, severity: e?.triage.severity ?? "untriaged", triage: e?.triage, annotations: annStore.annotations.filter((a) => a.target.kind === "anchor" && a.target.id === aid) };
  });
  // A node's code review is *derived* from the code reviews of the segments it
  // cites — signing the node vouches for the doc (logical), never for code you
  // haven't opened. Missing anchors are excluded from the denominator (a lost
  // anchor shows up as `dangling` status, not an un-completable review).
  const codeReview = deriveCodeReview(
    resolvedAnchors.filter((a) => a.review && !("missing" in a && a.missing)).map((a) => a.review!.code),
  );
  const review = { logical: nodeRt.review.logical, code: { state: codeReview.state, actor: codeReview.actor ?? undefined } };
  return {
    ...node,
    resolvedAnchors,
    edges: graph.edges.filter((e) => e.from === id || e.to === id),
    annotations: annStore.annotations.filter((a) => a.target.kind === "node" && a.target.id === id),
    review,
    codeReview,
    viewed: nodeRt.viewed,
    triage: nodeRt.triage,
    severity: nodeRt.triage.severity,
    trust: trustOf(node.status, review),
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
      reviewBy: { logical: rp?.logical.actor ?? null, code: rp?.code.actor ?? null },
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
  const [nodes, graph, store] = await Promise.all([loadNodes(root), readGraph(root), readAnchorStore(root)]);
  const byId = new Map(nodes.map((n) => [n.id, n]));
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
  // Code review is derived from each node's cited segments (matches flow detail +
  // node page), so the rollup counts real per-segment progress, not a node-code click.
  const involved = [...new Set(targets.map((t) => t.id))].map((id) => byId.get(id)).filter((n): n is LogicalNode => Boolean(n));
  const codeReviews = await nodeCodeReviews(root, involved, new Set(store.anchors.map((a) => a.id)));
  const codeState = (id: string) => codeReviews.get(id)?.state ?? "unreviewed";
  const rollup = (ids: string[]) => {
    let logical = 0, code = 0, stale = 0;
    for (const id of ids) {
      const r = rev.get("node:" + id);
      const cs = codeState(id);
      if (r?.logical.state === "reviewed") logical++;
      if (cs === "reviewed") code++;
      if (r?.logical.state === "stale" || cs === "stale") stale++;
    }
    return { logical, code, stale, total: ids.length };
  };
  return {
    flows: processes.map((p) => ({
      id: p.id, title: p.title, summary: p.summary,
      steps: (stepsByProc.get(p.id) ?? []).length,
      review: { logical: rev.get("node:" + p.id)?.logical ?? { state: "unreviewed" as const }, code: { state: codeState(p.id), actor: codeReviews.get(p.id)?.actor ?? undefined } },
      codeReview: codeReviews.get(p.id),
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
  const org = orgPrefixOf(nsById);
  const domOf = (n: LogicalNode) => domainOf(topNamespace(n.anchors, nsById), org);

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
        reviewBy: { logical: rp?.logical.actor ?? null, code: rp?.code.actor ?? null },
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

/**
 * Per-aggregate state machines: states (enum members) + transitions, both nodes
 * emitted by the Marten analyzer. A transition skeleton `mtr-…` is joined by id
 * convention to its authored enrichment `tr-…` (source states / guards, written
 * via document + from_state connect edges — analyzer re-emits never touch them).
 * `unenriched` is the agent work queue: transitions with no enrichment node or
 * whose enrichment went stale/dangling (drifted claims re-enter the queue).
 * Layout: BFS layers from the initial states over sources→targets; targets of
 * source-less transitions surface at layer 1 (the UI feeds them from a "?"
 * gutter); states the graph never reaches land in a final layer.
 */
export async function stateMap(root: string, opts: { aggregate?: string } = {}) {
  const [nodes, graph] = await Promise.all([loadNodes(root), readGraph(root)]);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const present = (e: Edge) => byId.has(e.from) && byId.has(e.to);

  const stateOf = graph.edges.filter((e) => e.type === "state_of" && present(e));
  const trOf = graph.edges.filter((e) => e.type === "transition_of" && present(e));
  const aggIds = [...new Set(stateOf.map((e) => e.to))].sort((a, b) => byId.get(a)!.title.localeCompare(byId.get(b)!.title));
  const aggregates = aggIds.map((id) => ({ id, title: byId.get(id)!.title }));

  const q = opts.aggregate?.toLowerCase();
  const sel = q ? aggIds.filter((id) => id === opts.aggregate || byId.get(id)!.title.toLowerCase() === q) : aggIds;

  // One batched review query for everything this response touches.
  const trIdOf = (mtrId: string) => "tr-" + mtrId.slice(4);
  const involved = new Set<string>();
  for (const e of stateOf) if (sel.includes(e.to)) involved.add(e.from);
  for (const e of trOf) if (sel.includes(e.to)) { involved.add(e.from); if (byId.has(trIdOf(e.from))) involved.add(trIdOf(e.from)); }
  const reviews = await reviewStatesFor(root, [...involved].map((id) => ({ kind: "node" as const, id })));
  const reviewOf = (id: string) => {
    const rp = reviews.get(`node:${id}`);
    return { logical: rp?.logical.state ?? "unreviewed", code: rp?.code.state ?? "unreviewed" };
  };

  const machines = sel.map((aggId) => {
    const agg = byId.get(aggId)!;
    const stateIds = stateOf.filter((e) => e.to === aggId).map((e) => e.from);
    const stateSet = new Set(stateIds);
    const initial = new Set(graph.edges.filter((e) => e.type === "initial_state" && e.from === aggId && stateSet.has(e.to)).map((e) => e.to));

    const transitions = trOf.filter((e) => e.to === aggId).map((e) => e.from).map((tid) => {
      const n = byId.get(tid)!;
      const ev = graph.edges.find((x) => x.type === "on_event" && x.from === tid && byId.has(x.to));
      const targets = [...new Set(graph.edges.filter((x) => x.type === "transitions_to" && x.from === tid && stateSet.has(x.to)).map((x) => x.to))];
      const sources = [...new Set(graph.edges.filter((x) => x.type === "from_state" && x.to === tid && stateSet.has(x.from)).map((x) => x.from))];
      // A generated skeleton pairs with its authored `tr-` node by id convention;
      // a fully-AUTHORED transition (no generatedBy) is its own enrichment.
      const en = n.generatedBy ? byId.get(trIdOf(tid)) : n;
      const enrichment = en && en.type === "transition" && !en.generatedBy
        ? { id: en.id, title: en.title, summary: en.summary, status: en.status, review: reviewOf(en.id), trust: trustOf(en.status, reviews.get(`node:${en.id}`)) }
        : null;
      return {
        id: tid, title: n.title, summary: n.summary,
        event: ev ? { id: ev.to, title: byId.get(ev.to)!.title } : null,
        targets, sources,
        dynamic: targets.length === 0, // no statically-known target
        enrichment,
        enriched: !!enrichment && enrichment.status !== "stale" && enrichment.status !== "dangling",
      };
    });

    // Layers: sourced BFS first ("first reached through real sources" wins), then
    // seed still-unplaced targets of source-less transitions at 1, repeat.
    const layerOf = new Map<string, number>();
    for (const s of initial) layerOf.set(s, 0);
    const propagate = () => {
      for (let moved = true; moved; ) {
        moved = false;
        for (const t of transitions) {
          if (!t.sources.length) continue;
          const from = t.sources.filter((s) => layerOf.has(s));
          if (!from.length) continue;
          const base = Math.min(...from.map((s) => layerOf.get(s)!)) + 1;
          for (const tg of t.targets) if (!layerOf.has(tg)) { layerOf.set(tg, base); moved = true; }
        }
      }
    };
    propagate();
    for (let seeded = true; seeded; ) {
      seeded = false;
      for (const t of transitions) {
        if (t.sources.length) continue;
        for (const tg of t.targets) if (!layerOf.has(tg)) { layerOf.set(tg, 1); seeded = true; }
      }
      if (seeded) propagate();
    }
    const maxLayer = layerOf.size ? Math.max(...layerOf.values()) : 0;
    for (const s of stateIds) if (!layerOf.has(s)) layerOf.set(s, maxLayer + 1);

    // Rows: alphabetical, then two barycenter sweeps over source↔target adjacency.
    const layers: string[][] = [];
    for (const [sid, li] of layerOf) (layers[li] ??= []).push(sid);
    for (let i = 0; i < layers.length; i++) layers[i] ??= [];
    const adj = new Map<string, string[]>();
    const link = (a: string, b: string) => { let l = adj.get(a); if (!l) { l = []; adj.set(a, l); } l.push(b); };
    for (const t of transitions) for (const s of t.sources) for (const tg of t.targets) { link(s, tg); link(tg, s); }
    for (const L of layers) L.sort((a, b) => byId.get(a)!.title.localeCompare(byId.get(b)!.title));
    const pos = new Map<string, number>();
    const setPos = () => layers.forEach((L) => L.forEach((s, i) => pos.set(s, i)));
    setPos();
    const idxs = layers.map((_, i) => i);
    for (const order of [idxs.slice(1), idxs.slice(0, -1).reverse()]) {
      for (const li of order) {
        const bary = (x: string) => {
          const neigh = (adj.get(x) ?? []).filter((m) => Math.abs(layerOf.get(m)! - li) === 1);
          return neigh.length ? neigh.reduce((s, m) => s + (pos.get(m) ?? 0), 0) / neigh.length : (pos.get(x) ?? 0);
        };
        layers[li]!.sort((a, b) => bary(a) - bary(b));
        setPos();
      }
    }

    const targeted = new Set(transitions.flatMap((t) => t.targets));
    const ids = new Set([...stateIds, ...transitions.map((t) => t.id), aggId]);
    return {
      aggregate: { id: aggId, title: agg.title },
      states: stateIds.map((sid) => {
        const n = byId.get(sid)!;
        return {
          id: sid, member: n.title.split("·").pop()!.trim(), title: n.title,
          initial: initial.has(sid), layer: layerOf.get(sid)!, row: pos.get(sid) ?? 0,
          review: reviewOf(sid), trust: trustOf(n.status, reviews.get(`node:${sid}`)),
        };
      }),
      transitions,
      edges: graph.edges
        .filter((e) => (ids.has(e.from) || ids.has(e.to)) && present(e) &&
          ["state_of", "transition_of", "transitions_to", "on_event", "initial_state", "from_state"].includes(e.type))
        .map((e) => ({ from: e.from, to: e.to, type: e.type })),
      unenriched: transitions.filter((t) => !t.enriched).map((t) => t.id),
      unreachable: stateIds.filter((sid) => !targeted.has(sid) && !initial.has(sid)),
      hasDynamic: transitions.some((t) => t.dynamic),
    };
  });

  return { aggregates, aggregate: opts.aggregate ?? null, machines };
}

/** One flow: its ordered steps, each with touched modules + the live source of its anchors. */
export async function flow(root: string, id: string) {
  const [nodes, graph, store, annStore] = await Promise.all([loadNodes(root), readGraph(root), readAnchorStore(root), readAnnotations(root)]);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const anchorById = new Map(store.anchors.map((a) => [a.id, a]));
  const annFor = (aid: string) => annStore.annotations.filter((a) => a.target.kind === "anchor" && a.target.id === aid);
  const proc = byId.get(id);
  if (!proc) return { error: `no flow "${id}"` };

  const stepNodes = graph.edges
    .filter((e) => e.type === "step_of" && e.to === id)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((e) => byId.get(e.from))
    .filter((n): n is LogicalNode => Boolean(n));

  const allAnchorIds = [...new Set(stepNodes.flatMap((s) => s.anchors))];
  // Include the process node's own anchors so its code review derives too (rare —
  // most process nodes cite steps, not code — but keeps the flow node consistent).
  const revAnchorIds = [...new Set([...proc.anchors, ...allAnchorIds])];
  const revTargets = [
    { kind: "node" as const, id },
    ...stepNodes.map((s) => ({ kind: "node" as const, id: s.id })),
    ...revAnchorIds.map((aid) => ({ kind: "anchor" as const, id: aid })),
  ];
  // Two passes: the vouch (`signed`/`checked`) and the `viewed` exposure marks. The
  // flow-level targeted diff is the roll-up of *stale* marks — steps you'd reviewed
  // whose code has since drifted (never-reviewed steps are a first-look bucket, not
  // "changed since you looked"), so a re-review targets only the delta.
  const [rev, revView] = await Promise.all([
    reviewStatesFor(root, revTargets),
    reviewStatesFor(root, revTargets, { viewed: true }),
  ]);
  const isStale = (p?: ReviewPair) => Boolean(p && (p.code.state === "stale" || p.logical.state === "stale"));
  // A node's code review is derived from its cited segments (see deriveCodeReview),
  // never a one-click node-code sign — the per-anchor code buttons below are the
  // real controls. Reads from the anchor reviews already fetched above.
  const deriveNodeCode = (anchorIds: string[]) =>
    deriveCodeReview(anchorIds.filter((aid) => anchorById.has(aid)).map((aid) => rev.get("anchor:" + aid)!.code));
  const withDerivedCode = (nodeId: string, anchorIds: string[]) => {
    const codeReview = deriveNodeCode(anchorIds);
    const rp = rev.get("node:" + nodeId);
    return { review: { logical: rp?.logical ?? { state: "unreviewed" as const }, code: { state: codeReview.state, actor: codeReview.actor ?? undefined } }, codeReview };
  };
  const touchesByStep = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.type !== "touches") continue;
    (touchesByStep.get(e.from) ?? touchesByStep.set(e.from, []).get(e.from)!).push(e.to);
  }

  // Cache live-indexed files so a step's several anchors in one file re-index once.
  // loc offsets index the parsed source STRING — web-tree-sitter returns UTF-16
  // code-unit indices (matching node.text), NOT UTF-8 byte offsets. Slice the
  // decoded string; slicing the raw buffer shifts the window left by the extra
  // UTF-8 bytes of any multi-byte char (em dash, §, …) before the anchor.
  const fileCache = new Map<string, { src: string; byId: Map<string, Anchor> }>();
  const codeFor = async (a: Anchor): Promise<string | null> => {
    let fc = fileCache.get(a.file);
    if (!fc) {
      try {
        const src = await readFile(join(root, a.file), "utf8");
        fc = { src, byId: new Map((await indexFile(join(root, a.file), a.file)).map((x) => [x.id, x])) };
      } catch {
        fc = { src: "", byId: new Map() };
      }
      fileCache.set(a.file, fc);
    }
    const live = fc.byId.get(a.id);
    return live?.loc ? fc.src.slice(live.loc.startByte, live.loc.endByte) : null;
  };

  const steps = [];
  const changedSigned: string[] = [];
  const changedViewed: string[] = [];
  let order = 0;
  for (const s of stepNodes) {
    const anchors = [];
    for (const aid of s.anchors) {
      const a = anchorById.get(aid);
      if (!a) { anchors.push({ id: aid, missing: true }); continue; }
      anchors.push({ id: a.id, symbol: a.symbolPath.join(" › "), file: a.file, lines: a.loc ? `${a.loc.startLine}-${a.loc.endLine}` : undefined, startLine: a.loc?.startLine, kind: a.kind, lang: langFor(a.file), code: await codeFor(a), review: rev.get("anchor:" + a.id), viewed: revView.get("anchor:" + a.id), annotations: annFor(a.id) });
    }
    // A step "changed since signed/viewed" iff its own mark or any of its anchors'
    // marks went stale under that attestation.
    const stepSigned = isStale(rev.get("node:" + s.id)) || anchors.some((a) => isStale((a as { review?: ReviewPair }).review));
    const stepViewed = isStale(revView.get("node:" + s.id)) || anchors.some((a) => isStale((a as { viewed?: ReviewPair }).viewed));
    if (stepSigned) changedSigned.push(s.id);
    if (stepViewed) changedViewed.push(s.id);
    steps.push({
      id: s.id, title: s.title, summary: s.summary, body: s.body, order: order++,
      ...withDerivedCode(s.id, s.anchors), viewed: revView.get("node:" + s.id),
      changed: { signed: stepSigned, viewed: stepViewed },
      touches: (touchesByStep.get(s.id) ?? []).map((tid) => ({ id: tid, title: byId.get(tid)?.title ?? tid })),
      anchors,
    });
  }
  return {
    id, title: proc.title, summary: proc.summary, body: proc.body,
    ...withDerivedCode(id, proc.anchors), viewed: revView.get("node:" + id),
    // The targeted diff: step ids that have drifted under each mark since you reviewed.
    changed: { signed: changedSigned, viewed: changedViewed },
    // Review-complete rollup over the flow's step anchors ("am I done with this flow?").
    coverage: await triageCoverageFor(root, allAnchorIds.map((aid) => ({ kind: "anchor" as const, id: aid }))),
    steps,
  };
}

