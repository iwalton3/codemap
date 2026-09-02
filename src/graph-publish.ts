/**
 * Publishing a node's wiring, and folding it back into rows.
 *
 * A LEAF, for the same structural reason `triage-publish.ts` is one: `ops/docs.ts` owns
 * `connect` and has to publish, and `ops-shared.ts` reaches down into the projections —
 * so a call the other way closes an import cycle. See the note at the top of
 * `triage-publish.ts`.
 */

import { resolveSidecar, sidecarWriteDoor, sidecarIdentity, type SidecarConfig } from "./sidecar-config.js";
import { requireActor } from "./identity.js";
import { ensureSidecar } from "./sidecar.js";
import { readCached } from "./materialize.js";
import { graphProjection } from "./shared-projections.js";
import { foldGraph, graphScope, publishWiring } from "./shared-graph.js";
import { readLocalGraph } from "./store.js";
import { headCommit } from "./git.js";

/** One universe's shared wiring, through the cache. */
export const cachedGraph = (root: string, cfg: { path: string; universe: string }) =>
  readCached(root, cfg.path, graphScope(cfg.universe), sidecarIdentity(cfg), foldGraph, graphProjection);

/**
 * Fold this universe's graph scope into rows, now.
 *
 * Write-through, so a `connect` is visible to the surface that just made it rather than
 * at the next sync. A failure here is NOT a failure of the write: the event is appended
 * and durable, and the next read or sync folds it.
 */
async function materializeGraph(root: string, cfg: SidecarConfig): Promise<boolean> {
  try { await cachedGraph(root, cfg); return true; } catch { return false; }
}

/**
 * Publish the wiring of every node this write touched.
 *
 * By SOURCE NODE and not by edge, because the unit of the design is one node's outgoing
 * set: a flow's cardinality is a property of the whole `step_of` set, and per-edge
 * events would let two clones hold a half-reordered flow neither person authored.
 *
 * `shared: false` with `configured: false` means no sidecar, and the caller keeps its
 * local rows exactly as before. `configured: true` with `shared: false` is a failed
 * append — the caller reports it rather than papering over it, the same rule
 * `setTriage` follows and for the same reason: a row published later would be given a
 * causal position it never had.
 */
export async function mirrorWiring(
  root: string, nodeIds: string[],
): Promise<{ shared: boolean; configured: boolean; error?: string }> {
  if (!nodeIds.length) return { shared: false, configured: !!resolveSidecar(root) };
  const door = sidecarWriteDoor(root);
  if (!door.cfg) return { shared: false, configured: door.configured, ...(door.error ? { error: door.error } : {}) };
  const cfg = door.cfg;
  const actor = requireActor(root);
  if ("error" in actor) return { shared: false, configured: true, error: actor.error };
  try {
    await ensureSidecar(cfg.path, actor);
    // This clone's OWN edges — never the merged view. Publishing the merged set would
    // republish a teammate's wiring under this actor, which is the same false
    // attribution the docs and triage publish paths refuse.
    const mine = (await readLocalGraph(root)).edges;
    const commit = headCommit(root) ?? null;
    for (const nodeId of [...new Set(nodeIds)]) {
      await publishWiring(cfg.path, graphScope(cfg.universe), actor, {
        nodeId, commit, edges: mine.filter((e) => e.from === nodeId),
      });
    }
    await materializeGraph(root, cfg);
    return { shared: true, configured: true };
  } catch (e: any) {
    return { shared: false, configured: true, error: e?.message ?? String(e) };
  }
}
