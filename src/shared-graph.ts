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
 *    granularity a repair queue can act on.
 *
 * 4. **Fast-forward, or queue it.** See `divergedNodes`.
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
  /** The receipt that WON. Wall-clock order, per the owner's rule. */
  winner: WiringReceipt;
  /**
   * Set when wall-clock order and canonical order disagree about the winner.
   *
   * Not "these two wrote concurrently" — that is a judgement about causality and would
   * fire on ordinary parallel work. This is narrower and decidable: the ORDERING
   * MATTERED. See `divergedNodes`.
   */
  reordered?: { causal: WiringReceipt };
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

/**
 * Newest wall-clock wins, tie-broken by event id.
 *
 * The tie-break is not decoration: `at` alone is not a total order, and two clones
 * holding events that share a timestamp would otherwise pick differently — which breaks
 * CONVERGENCE, the property every other rule here is in service of.
 */
const laterByClock = (a: WiringReceipt, b: WiringReceipt): WiringReceipt =>
  b.at > a.at || (b.at === a.at && b.eventId > a.eventId) ? b : a;

/**
 * Every node's wiring, and whether the ordering mattered.
 *
 * **Fast-forward, or queue it** — git's distinction, and it makes the detector decidable
 * rather than a judgement about causality. Per node, fold the publications twice: once
 * in wall-clock order (W, which is served) and once in canonical `sortEvents` order (C,
 * which is causal). If W and C agree, the interleave changed nothing and there is
 * nothing for anyone to look at. If they disagree — a causally later publication
 * carrying an earlier clock, or concurrent writes whose tie broke the other way — the
 * ordering was load-bearing and the reorder is queued.
 *
 * That comparison is also what keeps the repair model fed. A silent last-write-wins
 * leaves nothing to queue: the loser vanishes and nobody learns the ordering mattered.
 */
export function foldGraphReport(events: LogEvent[]): { value: Map<string, SharedWiring>; refused: Refusal[] } {
  const { refused, refuse } = collector();
  const byNode = new Map<string, WiringReceipt[]>();
  // Canonical order first, so `C` is a fold over the causal sequence rather than over
  // whatever order the shards happened to be read in.
  for (const e of sortEvents(events)) {
    if (e.kind !== "graph.published") continue;
    const r = receiptOf(e, refuse);
    if (!r) continue;
    const acc = byNode.get(r.nodeId);
    if (acc) acc.push(r); else byNode.set(r.nodeId, [r]);
  }

  const out = new Map<string, SharedWiring>();
  for (const [nodeId, receipts] of byNode) {
    // C: the last one in canonical order. W: the latest by clock.
    const causal = receipts[receipts.length - 1]!;
    const winner = receipts.reduce(laterByClock);
    out.set(nodeId, {
      nodeId, winner,
      ...(winner.eventId !== causal.eventId ? { reordered: { causal } } : {}),
    });
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

/** The nodes whose wiring a person or an agent should look at. See `foldGraph`. */
export function divergedNodes(folded: Map<string, SharedWiring>): SharedWiring[] {
  return [...folded.values()].filter((w) => w.reordered);
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
