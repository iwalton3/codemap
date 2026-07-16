/**
 * Marten event-graph emission — turns the extracted model into first-class
 * codemap nodes + typed edges, so "capture a hold" is one navigable wiring unit
 * (event → folds → aggregate; event → projects → projection) instead of loose
 * anchors. Everything written carries `generatedBy: "marten"`, so re-running
 * refreshes the generated graph while human-authored nodes/edges are untouched.
 */

import { type Anchor, type LogicalNode, type Edge } from "../schema.js";
import {
  loadNodes, readGraph, writeGraph, writeNode, deleteNode, slug,
} from "../store.js";
import { indexRepo } from "../repo.js";
import { buildMartenModel } from "./marten.js";

const GEN = "marten";

function anchorAt(anchors: Anchor[], file: string, line: number): Anchor | null {
  let best: Anchor | null = null;
  for (const a of anchors) {
    if (a.file !== file || !a.loc) continue;
    if (a.loc.startLine <= line && line <= a.loc.endLine) {
      if (!best || a.loc.endLine - a.loc.startLine < best.loc!.endLine - best.loc!.startLine) best = a;
    }
  }
  return best;
}

function anchorByLeaf(anchors: Anchor[], name: string, kinds?: string[]): Anchor | null {
  return anchors.find((a) => a.symbolPath[a.symbolPath.length - 1] === name && (!kinds || kinds.includes(a.kind))) ?? null;
}

const TYPE_KINDS = ["class", "record", "struct"];

export async function emitMartenGraph(root: string): Promise<{ events: number; aggregates: number; projections: number; commands: number; handlers: number; edges: number; skipped: number }> {
  const model = await buildMartenModel(root);
  // Index current code (not the possibly-stale anchors.json) so a refresh reflects
  // reality; anchor ids are deterministic, so citations still match the store.
  const anchors = await indexRepo(root);

  // Clear previously-generated marten nodes/edges; keep human-authored ones.
  for (const n of await loadNodes(root)) if (n.generatedBy === GEN) await deleteNode(root, n.id);
  const graph = await readGraph(root);
  graph.edges = graph.edges.filter((e) => e.generatedBy !== GEN);

  const evId = (n: string) => "mev-" + slug(n);
  const aggId = (n: string) => "magg-" + slug(n);
  const projId = (n: string) => "mproj-" + slug(n);
  const cmdId = (n: string) => "mcmd-" + slug(n);
  const uniq = (xs: string[]) => [...new Set(xs)];

  const nodes: LogicalNode[] = [];
  const edges: Edge[] = [];
  let skipped = 0;

  // Aggregate nodes: the type shell + its Apply/Create anchors.
  const aggWritten = new Set<string>();
  for (const [name] of model.aggregateDecls) {
    const ids: string[] = [];
    const shell = anchorByLeaf(anchors, name, TYPE_KINDS);
    if (shell) ids.push(shell.id);
    let folds = 0;
    for (const [, f] of model.folded) if (f.aggregate === name) { folds++; const a = anchorAt(anchors, f.file, f.line); if (a) ids.push(a.id); }
    if (!ids.length) { skipped++; continue; }
    aggWritten.add(name);
    nodes.push({ id: aggId(name), type: "aggregate", title: name, summary: `Aggregate \`${name}\` — folds ${folds} event(s).`, anchors: uniq(ids), body: "", generatedBy: GEN });
  }

  // Projection nodes.
  const projWritten = new Set<string>();
  for (const [name] of model.projectionDecls) {
    const ids: string[] = [];
    const shell = anchorByLeaf(anchors, name, TYPE_KINDS);
    if (shell) ids.push(shell.id);
    let n = 0;
    for (const [, p] of model.projected) if (p.projection === name) { n++; const a = anchorAt(anchors, p.file, p.line); if (a) ids.push(a.id); }
    if (!ids.length) { skipped++; continue; }
    projWritten.add(name);
    nodes.push({ id: projId(name), type: "projection", title: name, summary: `Projection \`${name}\` — transforms ${n} event(s).`, anchors: uniq(ids), body: "", generatedBy: GEN });
  }

  // Event-family nodes: the record + fold + projection + emit anchors, one unit.
  let eventCount = 0;
  const evWritten = new Set<string>();
  for (const ev of model.events) {
    const ids: string[] = [];
    const rec = model.records.get(ev);
    const recAnchor = (rec && anchorAt(anchors, rec.file, rec.line)) || anchorByLeaf(anchors, ev, TYPE_KINDS);
    if (recAnchor) ids.push(recAnchor.id);
    const fold = model.folded.get(ev);
    if (fold) { const a = anchorAt(anchors, fold.file, fold.line); if (a) ids.push(a.id); }
    const proj = model.projected.get(ev);
    if (proj) { const a = anchorAt(anchors, proj.file, proj.line); if (a) ids.push(a.id); }
    const app = model.appended.get(ev);
    if (app) { const a = anchorAt(anchors, app.file, app.line); if (a) ids.push(a.id); }
    if (!ids.length) { skipped++; continue; }

    const parts: string[] = [];
    if (app) parts.push("emitted by a handler");
    if (fold) parts.push(`folds into \`${fold.aggregate}\``);
    if (proj) parts.push(`projected by \`${proj.projection}\``);
    nodes.push({ id: evId(ev), type: "event_family", title: ev, summary: `Event \`${ev}\` — ${parts.join("; ") || "declared"}.`, anchors: uniq(ids), body: "", generatedBy: GEN });
    evWritten.add(ev);
    eventCount++;

    if (fold && aggWritten.has(fold.aggregate)) edges.push({ from: evId(ev), to: aggId(fold.aggregate), type: "folds", generatedBy: GEN });
    if (proj && projWritten.has(proj.projection)) edges.push({ from: evId(ev), to: projId(proj.projection), type: "projects", generatedBy: GEN });
  }

  // Command nodes.
  const cmdWritten = new Set<string>();
  for (const [name, decl] of model.commands) {
    const rec = (anchorAt(anchors, decl.file, decl.line)) || anchorByLeaf(anchors, name, TYPE_KINDS);
    if (!rec) { skipped++; continue; }
    cmdWritten.add(name);
    nodes.push({ id: cmdId(name), type: "command", title: name, summary: `Command \`${name}\`.`, anchors: [rec.id], body: "", generatedBy: GEN });
  }

  // Handler nodes + handles/emits edges (only handlers that touch a known command/event).
  const usedHandlerIds = new Set<string>();
  let handlerCount = 0;
  for (const [, h] of model.handlers) {
    const handles = h.params.filter((p) => cmdWritten.has(p));
    const emits = uniq(h.emits.filter((e) => evWritten.has(e)));
    if (!handles.length && !emits.length) continue;
    const anchor = anchorAt(anchors, h.file, h.line);
    if (!anchor) { skipped++; continue; }
    let id = "mh-" + slug(h.name);
    for (let i = 2; usedHandlerIds.has(id); i++) id = "mh-" + slug(h.name) + "-" + i;
    usedHandlerIds.add(id);
    handlerCount++;
    nodes.push({ id, type: "handler", title: h.name, summary: `Handler \`${h.name}\` — handles ${handles.join(", ") || "—"}; emits ${emits.join(", ") || "—"}.`, anchors: [anchor.id], body: "", generatedBy: GEN });
    for (const c of handles) edges.push({ from: id, to: cmdId(c), type: "handles", generatedBy: GEN });
    for (const e of emits) edges.push({ from: id, to: evId(e), type: "emits", generatedBy: GEN });
  }

  for (const n of nodes) await writeNode(root, n);
  graph.edges.push(...edges);
  await writeGraph(root, graph);
  return { events: eventCount, aggregates: aggWritten.size, projections: projWritten.size, commands: cmdWritten.size, handlers: handlerCount, edges: edges.length, skipped };
}
