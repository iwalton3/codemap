/**
 * Publishing a note — the leaf half, for the same structural reason `triage-publish.ts`
 * exists.
 *
 * `annotate` mirrors every annotation onto the sidecar, and reaching `ops-shared.ts`
 * from `ops/annotations.ts` to do it made that module a hub: anything `ops-shared`
 * imported closed a cycle through it, which is what happened the moment the contest
 * reconciliation moved into `sharedSync`. An ES-module cycle here fails with a blank
 * page and an empty console, so `src/import-cycles.test.ts` refuses them outright.
 *
 * Everything here sits UNDER `ops-shared.ts`: sidecar config, identity, transport and
 * the note writer, and never the op surface.
 */

import { resolveSidecar, sidecarWriteDoor, sidecarIdentity } from "./sidecar-config.js";
import { requireActor } from "./identity.js";
import { ensureSidecar } from "./sidecar.js";
import { readCached } from "./materialize.js";
import { notesProjection } from "./shared-projections.js";
import { createNote, resolveNote, foldNotes, noteScope, bucketFor, type NewNote } from "./shared-notes.js";

/**
 * Fold the target's note bucket into rows, now.
 *
 * WRITE-THROUGH — the rule `docs/sidecar-architecture.md` lists among the consequences
 * that are decided, not open. Notes were the last kind that skipped it: `mirrorNote`
 * appended and returned, so the row appeared only when something else happened to fold,
 * and every canonical reader (`readSharedNotes`, and so `questions` and `get_anchor`)
 * queries SQLite and never folds. A question closed for the team read back as open.
 *
 * Failure here is NOT failure of the write: the event is appended and durable, and the
 * next read or sync folds it. Never thrown past the caller, for the reason
 * `materializeFindings` gives — a write that succeeded must not be reported as failed.
 */
async function materializeNotes(
  root: string, cfg: { path: string; universe: string }, targetId: string,
): Promise<void> {
  try {
    await readCached(root, cfg.path, noteScope(cfg.universe, bucketFor(targetId)), sidecarIdentity(cfg), foldNotes, notesProjection);
  } catch { /* the log has it; the next read or sync folds it */ }
}

/**
 * Put a note on the sidecar, if there is one.
 *
 * Called from `annotate` AFTER the local write and never in place of it: codemap
 * worked without a sidecar for its whole life, and a note must not be lost because a
 * shared repo was misconfigured. A no-op when there is nothing to mirror to.
 */
export async function mirrorNote(root: string, n: NewNote): Promise<{ shared: boolean; error?: string }> {
  const door = sidecarWriteDoor(root);
  if (!door.cfg) return { shared: false, ...(door.error ? { error: door.error } : {}) };
  const cfg = door.cfg;
  const actor = requireActor(root);
  if ("error" in actor) return { shared: false };
  await ensureSidecar(cfg.path, actor);
  await createNote(cfg.path, cfg.universe, actor, n);
  await materializeNotes(root, cfg, n.targetId);
  return { shared: true };
}

/**
 * Carry a local resolution onto the note's shared twin.
 *
 * `annotate` mirrors every note it writes, so a question a teammate can see has a local
 * annotation AND a `shared_note` row under the same id. Closing it locally wrote one of
 * them: the team's copy stayed open forever, and `questions` on their machine kept
 * listing an answered question with no way to tell.
 *
 * Best-effort, like `mirrorNote` and for the same reason — the local write has already
 * succeeded and must not be reported as failed because a shared repo is unreachable.
 * The caller says so in its answer rather than throwing.
 */
export async function mirrorNoteResolved(
  root: string, targetId: string, id: string, resolved: boolean, reason?: string,
): Promise<{ shared: boolean; error?: string }> {
  const door = sidecarWriteDoor(root);
  if (!door.cfg) return { shared: false, ...(door.error ? { error: door.error } : {}) };
  const cfg = door.cfg;
  const actor = requireActor(root);
  if ("error" in actor) return { shared: false };
  await ensureSidecar(cfg.path, actor);
  await resolveNote(cfg.path, cfg.universe, targetId, actor, id, resolved, reason);
  await materializeNotes(root, cfg, targetId);
  return { shared: true };
}
