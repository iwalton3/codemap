/**
 * Bugs on the sidecar: the bind, the cache, and publishing a local one.
 *
 * Its own module for the structural reason `triage-publish.ts` gives, not a tidiness
 * one. `ops/bugs.ts` has to write to the log, and `ops-shared.ts` reaches down into
 * `shared-projections.ts` — so a call the other way closes an import cycle by several
 * routes, and an ES-module cycle here fails with a blank page and an empty console.
 * `src/import-cycles.test.ts` refuses them outright.
 *
 * Everything below sits UNDER `ops-shared.ts`: fold, projection and sidecar directly,
 * never the op surface.
 */

import { resolveSidecar, sidecarIdentity, type SidecarConfig } from "./sidecar-config.js";
import { requireActor } from "./identity.js";
import { ensureSidecar } from "./sidecar.js";
import { readCached } from "./materialize.js";
import { bugsProjection } from "./shared-projections.js";
import type { Actor } from "./schema.js";
import {
  backlogBugEvent, bugScope, commentOnBug, fileBug, foldBugs, type SharedBug,
} from "./shared-bugs.js";

/** One universe's bugs, through the cache. */
export const cachedBugs = (root: string, cfg: { path: string; universe: string }) =>
  readCached(root, cfg.path, bugScope(cfg.universe), sidecarIdentity(cfg), foldBugs, bugsProjection);

/**
 * Fold this universe's bugs scope into rows, now.
 *
 * Write-through, for the reason triage, findings and docs all materialize on write:
 * without it a bug is in the log and in nobody's table until the next sync, so the tool
 * that just filed it reads back nothing.
 *
 * Failure here is NOT failure of the write: the event is appended and durable, and the
 * next read or sync folds it. Reported, never thrown past the caller.
 */
export async function materializeBugs(root: string, cfg: SidecarConfig): Promise<boolean> {
  try {
    await cachedBugs(root, cfg);
    return true;
  } catch { return false; }
}

export interface BugLog { cfg: SidecarConfig; actor: Actor }

/**
 * The sidecar and the actor, or why there is neither.
 *
 * `null` means no sidecar is configured, which is not an error anywhere — it is what
 * codemap has always been, and every bug op falls back to a local row. An `error` means
 * there IS one and this machine cannot write to it, which callers must not paper over
 * with a local write: a claim that never entered the log cannot be retrofitted with a
 * causal position later, because `after` is captured at append time.
 */
export function bugLog(root: string): BugLog | null | { error: string } {
  const cfg = resolveSidecar(root);
  if (!cfg) return null;
  const actor = requireActor(root);
  if ("error" in actor) return actor;
  return { cfg, actor };
}

/** Run `fn` against the log and fold the result back into rows. */
export async function onBugLog<T>(
  b: BugLog, root: string, fn: (logRoot: string, universe: string, actor: Actor) => Promise<T>,
): Promise<T> {
  await ensureSidecar(b.cfg.path, b.actor);
  const out = await fn(b.cfg.path, b.cfg.universe, b.actor);
  await materializeBugs(root, b.cfg);
  return out;
}

/**
 * Send a local bug to the team, id and all.
 *
 * The id is preserved because this is a republication of history rather than a new bug:
 * everything already pointing at it — a finding's `promotedToBug`, a link somebody
 * pasted — keeps resolving, and the fold ADOPTS the local row instead of colliding with
 * it (see `bugsProjection`).
 *
 * The thread goes too, one `bug.commented` per entry. Those are the migrated `history`
 * strings, and they are the only record of what happened to a bug filed before the team
 * had a sidecar; adoption overwrites the local row with the fold's answer, so a publish
 * that sent only `bug.filed` would quietly destroy them.
 */
export async function publishBug(b: BugLog, root: string, bug: SharedBug): Promise<string> {
  return onBugLog(b, root, async (logRoot, universe, actor) => {
    const id = await fileBug(logRoot, universe, actor, {
      id: bug.id,
      title: bug.title,
      text: bug.text,
      severity: bug.severity,
      category: bug.category,
      anchors: bug.anchors.map((a) => ({ anchorId: a.anchorId, bodyHash: a.bodyHash })),
      createdCommit: bug.createdCommit,
      // What the local row said, carried as the publisher's claim. See `SharedBug.filedAt`.
      filedAt: bug.filedAt ?? bug.createdAt,
      from: bug.from,
    });
    for (const c of bug.thread) await commentOnBug(logRoot, universe, actor, id, c.body);
    // Carried, because publishing must not silently undo a decision. A local bug that
    // was backlogged and lost the record on the way to the team would come straight back
    // into everybody's working queue with no trace of why it had left this one.
    //
    // The fold is still what decides: it drops an agent's, which is correct here too — an
    // agent publishing a person's deferral would be minting one on their behalf. The
    // publisher is who is accountable for the publication, and this is the one act in it
    // that a person has to be behind.
    if (bug.backlogged) {
      await backlogBugEvent(logRoot, universe, actor, id, {
        until: bug.backlogged.until,
        reason: bug.backlogged.reason,
        witnesses: bug.backlogged.witnesses,
        ...(bug.backlogged.ref?.system ? { ref: { system: bug.backlogged.ref.system, key: bug.backlogged.ref.key, url: bug.backlogged.ref.url } } : {}),
      });
    }
    return id;
  });
}
