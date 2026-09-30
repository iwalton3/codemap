/**
 * The node graph on the event log — a teammate's wiring, not just their prose.
 *
 * `docs/plan-sharing-the-rest.md` §0 is the design. Four things decide the shape, and
 * each replaced something more complicated:
 *
 * 1. **A flow is a node with forced cardinality.** A `process` is an ordinary
 *    `node_versions` row; what makes it a flow is that its `step_of` edges are ORDERED.
 *    So there is no flow entity — sync the graph and flows arrive with it. An earlier
 *    draft designed an immutable per-(flow, commit) itinerary snapshot; it is gone.
 *
 * 2. **What stays home is what is DETERMINISTICALLY REGENERABLE**, not what a machine
 *    wrote. An agent's doc and an agent's flow are authored work that cost real reading
 *    time; they travel. Analyzer output does not, because every clone reproduces it
 *    exactly from the code — `generatedBy` is that marker and means precisely "the
 *    analyzer that generated this" (`schema.ts`), never "an agent wrote it".
 *
 * 3. **The unit is one node's OUTGOING wiring at a commit**, not one edge. A flow's
 *    cardinality is a property of the whole `step_of` set, and per-edge events would let
 *    two clones hold a half-reordered flow neither person authored. It is also the
 *    granularity a repair acts on.
 *
 * 4. **Push order decides.** The last publication of a node's wiring in log order is
 *    served (owner, Q6: "Correct push order is what matters").
 */

import type { Actor, Edge, EdgeType } from "./schema.js";
import { type LogEvent, registerDoor, sortEvents } from "./eventlog.js";
import { emitEvent } from "./write.js";
import { collector, foldJudged, registerReport, type RefusalClass, type Refusal } from "./validation.js";
import { isAnalyzerNodeId } from "./analyzers/node-ids.js";

/** One universe's wiring. Not per PR: a graph outlives every branch that touches it. */
export const graphScope = (universe: string): string => `graph/${universe}`;

/** What one writer published about one node's outgoing edges. */
export interface WiringReceipt {
  nodeId: string;
  /** The commit it was authored against — what makes a repair authoritative for a ref. */
  commit: string | null;
  edges: { to: string; type: EdgeType; order?: number }[];
  actor: Actor;
  at: string;
  eventId: string;
}

export interface SharedWiring {
  nodeId: string;
  /** The receipt that WON: the last in log order. */
  winner: WiringReceipt;
}

const str = (d: Record<string, unknown>, k: string): string | undefined =>
  typeof d[k] === "string" ? (d[k] as string) : undefined;

type Refuse = (e: LogEvent, cls: RefusalClass, why: string) => void;

/** An event's payload as a receipt, or null if it is not a publication the fold applies. */
function receiptOf(e: LogEvent, refuse: Refuse): WiringReceipt | null {
  const d = (e.data ?? {}) as Record<string, unknown>;
  const nodeId = str(d, "nodeId");
  if (!nodeId || e.subject !== nodeId) { refuse(e, "shape", "a wiring publication names its node in the envelope and the payload alike"); return null; }
  if (!Array.isArray(d.edges)) { refuse(e, "shape", "a wiring publication carries its edges"); return null; }
  // Analyzer nodes are not published (owner, Q2), so neither is their wiring — even edges a
  // person drew from one. Not applied on read either: the owner ruled the historical ones dropped.
  if (isAnalyzerNodeId(nodeId)) { refuse(e, "state", `${nodeId} is an analyzer node, and analyzer nodes are not published`); return null; }
  const edges: WiringReceipt["edges"] = [];
  for (const raw of d.edges as Record<string, unknown>[]) {
    const to = typeof raw?.to === "string" ? raw.to : undefined;
    const type = typeof raw?.type === "string" ? raw.type : undefined;
    // A bad edge is refused, but the rest of a merge-era event still applies, as it always did.
    if (!to || !type) { refuse(e, "shape", "an edge needs a target and a type"); continue; }
    // Analyzer output is refused at the FOLD as well as at the publish surface, the same
    // both-ends rule `source: "graph"` triage obeys: remote events come from builds this
    // one did not write, so a write-time check protects the honest writer and nobody else.
    if (raw.generatedBy) { refuse(e, "state", "analyzer-generated edges are not published"); continue; }
    edges.push({ to, type: type as EdgeType, ...(typeof raw.order === "number" ? { order: raw.order } : {}) });
  }
  return {
    nodeId, commit: str(d, "commit") ?? null, edges,
    actor: e.actor, at: e.at, eventId: e.id,
  };
}

/** Every node's wiring: the last publication of each, in log order. */
export function foldGraphReport(events: LogEvent[]): { value: Map<string, SharedWiring>; refused: Refusal[] } {
  const { refused, refuse } = collector();
  const out = new Map<string, SharedWiring>();
  // Sorted, so the answer never depends on the order the files happened to be read in.
  for (const e of sortEvents(events)) {
    if (e.kind !== "graph.published") continue;
    const r = receiptOf(e, refuse);
    if (r) out.set(r.nodeId, { nodeId: r.nodeId, winner: r });
  }
  return { value: out, refused };
}

// A publication REPLACES its node's outgoing set and stands on no prior receipt, so there is
// no precondition to move. Node ids are not foreign keys: an unpublished node is not missing
// (owner, Q2), and an analyzer node is refused by the fold itself.
registerReport((scope) => scope.startsWith("graph/"), foldGraphReport);
registerDoor((scope) => scope.startsWith("graph/"), () => (events) => foldGraphReport(events));

/** The fold for a READ: a refused linear event is damage or newer; see `validation.ts`. */
export function foldGraph(events: LogEvent[]): Map<string, SharedWiring> {
  return foldJudged(events, foldGraphReport).value;
}

/**
 * Publish one node's outgoing wiring.
 *
 * A REPLACE for that node's shareable edges. Analyzer-generated ones are filtered here
 * and again at the fold; they are regenerated per machine and shipping a copy buys
 * nothing and costs one that can never be refreshed.
 */
export async function publishWiring(
  logRoot: string, scope: string, actor: Actor,
  input: { nodeId: string; commit: string | null; edges: Edge[] },
): Promise<LogEvent> {
  if (isAnalyzerNodeId(input.nodeId)) throw new Error(`${input.nodeId} is an analyzer node, and analyzer nodes are not published`);
  return emitEvent(logRoot, scope, actor, "graph.published", input.nodeId, {
    nodeId: input.nodeId,
    ...(input.commit ? { commit: input.commit } : {}),
    edges: input.edges
      .filter((e) => !e.generatedBy)
      .map((e) => ({ to: e.to, type: e.type, ...(e.order !== undefined ? { order: e.order } : {}) })),
  });
}
