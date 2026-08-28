/**
 * Publishing the standard, and folding it back into rows.
 *
 * Its own module for the structural reason `triage-publish.ts` gives: the record modules
 * have to publish, and `ops-shared.ts` reaches down into `shared-projections.ts`, so a
 * publish call from `requirements.ts` up to the op surface would close a cycle. Everything
 * here sits UNDER the ops: it imports the fold, the projection and the sidecar directly
 * and never the op surface.
 *
 * The rule every writer below follows, which is `mirrorTriage`'s and is not negotiable:
 *
 *   configured: false            → no sidecar. Keep the local row; that is the whole story.
 *   configured: true, shared: true  → the act is in the log. Do NOT write a local row —
 *                                     the fold writes it, and a local one would be erased
 *                                     by the next sync and invisible until then.
 *   configured: true, shared: false → a FAILED APPEND. The caller must fail. A local row
 *                                     here fabricates causality that no clone can see.
 */

import type { Acknowledgement, Actor, Audit, BugWitness, Operation, Problem, Spec } from "./schema.js";
import { resolveSidecar, sidecarIdentity, type SidecarConfig } from "./sidecar-config.js";
import { requireActor } from "./identity.js";
import { ensureSidecar } from "./sidecar.js";
import { readCached } from "./materialize.js";
import { standardProjection } from "./shared-projections.js";
import {
  foldStandard, standardScope, publishSpecDrafted, publishOperation, publishSpecRatified,
  publishAckGranted, publishAckReleased, publishAudit, publishProblemRaised, publishAdjudication,
} from "./shared-standard.js";

/** One universe's standard, through the cache. */
export const cachedStandard = (root: string, cfg: { path: string; universe: string }) =>
  readCached(root, cfg.path, standardScope(cfg.universe), sidecarIdentity(cfg), foldStandard, standardProjection);

/**
 * Fold this universe's standard into rows, now.
 *
 * Write-through. Without it a ratification is in the log and in nobody's table until the
 * next sync, so the call that made it reads back the old standard.
 *
 * Failure here is NOT failure of the write: the event is appended and durable, and the
 * next read or sync folds it. Reported, never thrown past the caller.
 */
export async function materializeStandard(root: string, cfg: SidecarConfig): Promise<boolean> {
  try { await cachedStandard(root, cfg); return true; } catch { return false; }
}

export interface Shared { shared: boolean; configured: boolean; folded?: boolean; error?: string }

/** Not shared, and nothing is wrong with that — there is no sidecar. */
export const localOnly: Shared = { shared: false, configured: false };

async function share(
  root: string, emit: (logRoot: string, scope: string, actor: Actor) => Promise<unknown>,
): Promise<Shared> {
  const cfg = resolveSidecar(root);
  if (!cfg) return localOnly;
  const actor = requireActor(root);
  if ("error" in actor) return { shared: false, configured: true, error: actor.error };
  try {
    await ensureSidecar(cfg.path, actor);
    await emit(cfg.path, standardScope(cfg.universe), actor);
  } catch (e: any) {
    return { shared: false, configured: true, error: `sidecar append failed: ${e?.message ?? e}` };
  }
  return { shared: true, configured: true, folded: await materializeStandard(root, cfg) };
}

export const shareSpecDrafted = (root: string, spec: Spec): Promise<Shared> =>
  share(root, (l, s, a) => publishSpecDrafted(l, s, a, spec));

export const shareOperation = (root: string, op: Operation): Promise<Shared> =>
  share(root, (l, s, a) => publishOperation(l, s, a, op));

export const shareSpecRatified = (
  root: string, specId: string, at: string, witnesses: Record<string, BugWitness[]>,
): Promise<Shared> => share(root, (l, s, a) => publishSpecRatified(l, s, a, specId, at, witnesses));

export const shareAckGranted = (root: string, ack: Acknowledgement): Promise<Shared> =>
  share(root, (l, s, a) => publishAckGranted(l, s, a, ack));

export const shareAckReleased = (root: string, id: string, at: string, reason: string): Promise<Shared> =>
  share(root, (l, s, a) => publishAckReleased(l, s, a, id, at, reason));

/**
 * An audit travels only if it is about THE CODEBASE.
 *
 * A provisional audit — taken off the default branch — stays local however the sidecar is
 * configured. Broadcasting it would announce a non-conformance on somebody's work in
 * progress as though it were the team's problem, and the branch may be fixed or abandoned
 * before it ever merges.
 */
export const shareAudit = (root: string, audit: Audit): Promise<Shared> =>
  audit.provisional ? Promise.resolve(localOnly) : share(root, (l, s, a) => publishAudit(l, s, a, audit));

/** Same rule: a problem raised from a provisional audit is this branch's, not the team's. */
export const shareProblemRaised = (root: string, problem: Problem): Promise<Shared> =>
  problem.provisional ? Promise.resolve(localOnly) : share(root, (l, s, a) => publishProblemRaised(l, s, a, problem));

/**
 * An adjudication travels only if the problem it decides did.
 *
 * Deciding which side moves on a branch-local non-conformance is a real act and stays with
 * the problem it is about — publishing it alone would arrive at a clone that has no such
 * problem to attach it to.
 */
export const shareAdjudication = (
  root: string, problem: Problem, disposition: string, reason: string, at: string,
): Promise<Shared> =>
  problem.provisional
    ? Promise.resolve(localOnly)
    : share(root, (l, s, a) => publishAdjudication(l, s, a, problem.id, disposition, reason, at));

/**
 * What a caller must do with a `Shared` before writing anything locally.
 *
 * Returns an error when the append failed with a sidecar configured — the one case where
 * the caller has to abandon the write entirely — and `local: true` when there is nothing
 * to publish to and the row is the whole story.
 */
export function disposition(s: Shared): { error: string } | { local: boolean } {
  if (s.configured && !s.shared) {
    return {
      error: s.error
        ?? "the sidecar is configured but the act could not be appended — refusing to write a local row, "
          + "which would be erased by the next sync and invisible until then",
    };
  }
  return { local: !s.configured };
}
