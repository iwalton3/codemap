/**
 * Workspace-level operations — the cross-universe layer over the single-root
 * `ops`. Links are stored in the SOURCE universe's graph with a qualified target
 * (e.g. `api::handler`); a target universe's inbound links are discovered by
 * scanning every universe's graph at query time.
 */

import { type EdgeType } from "./schema.js";
import { type Workspace, parseRef, qualify } from "./workspace.js";
import { loadNodes, readGraph, writeGraph } from "./store.js";
import * as ops from "./ops.js";
import { resolveSidecar } from "./sidecar-config.js";

export async function listUniverses(ws: Workspace) {
  const universes = [];
  for (const u of ws.universes) {
    let s: Awaited<ReturnType<typeof ops.status>> | null = null;
    try {
      s = await ops.status(u.path);
    } catch {
      /* not initialized yet */
    }
    universes.push({
      id: u.id,
      path: u.path,
      primary: u.primary,
      initialized: s !== null,
      // Whether this universe has a sidecar at all, so the chrome can offer a pull
      // button only where pulling means something. Config and a `git remote get-url`,
      // never the network — the log stays pull/push, and this is not a pull.
      sidecar: resolveSidecar(u.path) !== null,
      views: s?.views, // which event-graph views have data here (nav gating)
      anchors: s?.anchors,
      nodes: s?.nodes,
      open: s?.open,
      docPct: s?.docPct,
      bugs: s?.bugs,
    });
  }
  return { primary: ws.primary.id, universes };
}

/** Create a cross-universe (or same-universe) edge, stored in the source graph. */
export async function link(
  ws: Workspace,
  input: { fromUniverse: string; from: string; toUniverse: string; to: string; type?: EdgeType; order?: number },
) {
  const fromU = ws.byId.get(input.fromUniverse);
  const toU = ws.byId.get(input.toUniverse);
  if (!fromU) return { error: `unknown universe "${input.fromUniverse}"` };
  if (!toU) return { error: `unknown universe "${input.toUniverse}"` };

  const fromNodes = await loadNodes(fromU.path);
  if (!fromNodes.some((n) => n.id === input.from)) return { error: `no node "${input.from}" in universe "${fromU.id}"` };
  const toNodes = await loadNodes(toU.path);
  if (!toNodes.some((n) => n.id === input.to)) return { error: `no node "${input.to}" in universe "${toU.id}"` };

  const type: EdgeType = input.type ?? "calls_api";
  const target = fromU.id === toU.id ? input.to : qualify(toU.id, input.to);
  const graph = await readGraph(fromU.path);
  if (graph.edges.some((e) => e.from === input.from && e.to === target && e.type === type)) {
    return { ok: true, note: "edge already existed" };
  }
  graph.edges.push({ from: input.from, to: target, type, order: input.order });
  await writeGraph(fromU.path, graph);
  return { ok: true, from: qualify(fromU.id, input.from), to: qualify(toU.id, input.to), type };
}

/** Cross-universe edges from other universes that target (universeId, nodeId). */
export async function inboundLinks(ws: Workspace, universeId: string, nodeId: string) {
  const inbound = [];
  for (const u of ws.universes) {
    if (u.id === universeId) continue;
    const graph = await readGraph(u.path);
    for (const e of graph.edges) {
      const t = parseRef(e.to);
      if (t.universe === universeId && t.id === nodeId) {
        inbound.push({ fromUniverse: u.id, from: e.from, type: e.type });
      }
    }
  }
  return inbound;
}

/** get_node, plus resolution of qualified edge endpoints and inbound cross-links. */
export async function getNodeEnriched(ws: Workspace, universeId: string, nodeId: string) {
  const u = ws.byId.get(universeId);
  if (!u) return { error: `unknown universe "${universeId}"` };
  const base: any = await ops.getNode(u.path, nodeId);
  if (base.error) return base;

  const resolveEnd = async (ref: string) => {
    const r = parseRef(ref);
    if (!r.universe || r.universe === universeId) return undefined;
    const tu = ws.byId.get(r.universe);
    let title: string | undefined;
    if (tu) title = (await loadNodes(tu.path)).find((n) => n.id === r.id)?.title;
    return { universe: r.universe, id: r.id, title };
  };
  const edges = await Promise.all(
    base.edges.map(async (e: any) => ({
      ...e,
      fromRef: await resolveEnd(e.from),
      toRef: await resolveEnd(e.to),
    })),
  );

  return {
    ...base,
    universe: universeId,
    edges,
    inboundCrossUniverse: await inboundLinks(ws, universeId, nodeId),
  };
}

export async function searchAll(ws: Workspace, query: string, limit?: number) {
  const results = [];
  for (const u of ws.universes) {
    try {
      results.push({ universe: u.id, ...(await ops.search(u.path, query, limit)) });
    } catch {
      /* not initialized */
    }
  }
  return { results };
}
