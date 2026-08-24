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
import { emitEvent, type LogEvent, sortEvents } from "./eventlog.js";

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

/** An event's payload as a receipt, or null if it is not a well-formed publication. */
function receiptOf(e: LogEvent): WiringReceipt | null {
  const d = (e.data ?? {}) as Record<string, unknown>;
  const nodeId = str(d, "nodeId");
  if (!nodeId || e.subject !== nodeId) return null;   // envelope and payload must agree
  if (!Array.isArray(d.edges)) return null;
  const edges: WiringReceipt["edges"] = [];
  for (const raw of d.edges as Record<string, unknown>[]) {
    const to = typeof raw?.to === "string" ? raw.to : undefined;
    const type = typeof raw?.type === "string" ? raw.type : undefined;
    if (!to || !type) continue;                        // a malformed edge, not a malformed event
    // Analyzer output is refused at the FOLD as well as at the publish surface, the same
    // both-ends rule `source: "graph"` triage obeys: remote events come from builds this
    // one did not write, so a write-time check protects the honest writer and nobody else.
    if (raw.generatedBy) continue;
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
export function foldGraph(events: LogEvent[]): Map<string, SharedWiring> {
  const byNode = new Map<string, WiringReceipt[]>();
  // Canonical order first, so `C` is a fold over the causal sequence rather than over
  // whatever order the shards happened to be read in.
  for (const e of sortEvents(events)) {
    if (e.kind !== "graph.published") continue;
    const r = receiptOf(e);
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
  return out;
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
  return emitEvent(logRoot, scope, actor, "graph.published", input.nodeId, {
    nodeId: input.nodeId,
    ...(input.commit ? { commit: input.commit } : {}),
    edges: input.edges
      .filter((e) => !e.generatedBy)
      .map((e) => ({ to: e.to, type: e.type, ...(e.order !== undefined ? { order: e.order } : {}) })),
  });
}
