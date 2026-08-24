/**
 * Publishing triage, and folding it back into rows.
 *
 * This exists as its own module for a structural reason, not a tidiness one.
 * `triage.ts` has to publish a mark, and `ops-shared.ts` reaches down into
 * `shared-projections.ts` — so a publish call from `triage.ts` to `ops-shared.ts`
 * closes a cycle by several routes at once (`ops-shared -> pr-push -> pr -> diff ->
 * triage -> ops-shared` was the second one the guard found). An ES-module cycle here
 * fails with a blank page and an empty console, so `src/import-cycles.test.ts` refuses
 * them outright.
 *
 * Everything below sits UNDER `ops-shared.ts`: it imports the fold, the projection and
 * the sidecar directly and never the op surface. `ops-shared.ts` imports it in turn,
 * for the read surfaces a front end needs.
 */

import { resolveSidecar, sidecarIdentity, type SidecarConfig } from "./sidecar-config.js";
import { requireActor, isAgentActor } from "./identity.js";
import { ensureSidecar } from "./sidecar.js";
import { readCached } from "./materialize.js";
import { triageProjection } from "./shared-projections.js";
import {
  assertTriage, assertTriageBatch, clearSharedTriage, foldTriage, triageScope,
  type TriageAssertion,
} from "./shared-triage.js";

/** One universe's triage, through the cache. */
export const cachedTriage = (root: string, cfg: { path: string; universe: string }) =>
  readCached(root, cfg.path, triageScope(cfg.universe), sidecarIdentity(cfg), foldTriage, triageProjection);

/**
 * Fold this universe's triage scope into rows, now.
 *
 * Write-through. Without it a mark is in the log and in nobody's table until the next
 * sync, so the button that set it reads back the old value — the same reason findings
 * and docs materialize on write.
 *
 * Failure here is NOT failure of the write: the event is appended and durable, and the
 * next read or sync folds it. Reported, never thrown past the caller.
 */
export async function materializeTriage(root: string, cfg: SidecarConfig): Promise<boolean> {
  try {
    await cachedTriage(root, cfg);
    return true;
  } catch { return false; }
}

/**
 * Publish one triage assertion, if there is anywhere to publish it to.
 *
 * A no-op when no sidecar is configured — `setTriage` then keeps its local row, which
 * is what codemap did for its whole life before there was a sidecar. `shared: false`
 * is the signal to do that, and it covers a misconfigured sidecar too: a mark must
 * never be lost because a shared repo is missing.
 */
export async function mirrorTriage(root: string, a: TriageAssertion): Promise<{ shared: boolean; folded?: boolean }> {
  const cfg = resolveSidecar(root);
  if (!cfg) return { shared: false };
  const actor = requireActor(root);
  if ("error" in actor) return { shared: false };
  await ensureSidecar(cfg.path, actor);
  await assertTriage(cfg.path, triageScope(cfg.universe), actor, a);
  return { shared: true, folded: await materializeTriage(root, cfg) };
}

/** Many assertions, one append and ONE fold. See `assertTriageBatch`. */
export async function mirrorTriageBatch(root: string, items: TriageAssertion[]): Promise<{ shared: boolean; folded?: boolean }> {
  if (!items.length) return { shared: false };
  const cfg = resolveSidecar(root);
  if (!cfg) return { shared: false };
  const actor = requireActor(root);
  if ("error" in actor) return { shared: false };
  await ensureSidecar(cfg.path, actor);
  await assertTriageBatch(cfg.path, triageScope(cfg.universe), actor, items);
  return { shared: true, folded: await materializeTriage(root, cfg) };
}

/**
 * Publish "no stakes here".
 *
 * Human-only, and the FOLD is what enforces that — this refusal exists to give a good
 * error rather than a silently dropped event.
 */
export async function mirrorTriageClear(
  root: string, t: { targetKind: "node" | "anchor"; targetId: string },
): Promise<{ shared: boolean; folded?: boolean; error?: string }> {
  const cfg = resolveSidecar(root);
  if (!cfg) return { shared: false };
  const actor = requireActor(root);
  if ("error" in actor) return { shared: false };
  if (isAgentActor(actor)) return { shared: false, error: "clearing stakes is a person's call — an agent may only raise" };
  await ensureSidecar(cfg.path, actor);
  await clearSharedTriage(cfg.path, triageScope(cfg.universe), actor, t);
  return { shared: true, folded: await materializeTriage(root, cfg) };
}

