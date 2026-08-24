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

import { resolveSidecar } from "./sidecar-config.js";
import { requireActor } from "./identity.js";
import { ensureSidecar } from "./sidecar.js";
import { createNote, type NewNote } from "./shared-notes.js";

/**
 * Put a note on the sidecar, if there is one.
 *
 * Called from `annotate` AFTER the local write and never in place of it: codemap
 * worked without a sidecar for its whole life, and a note must not be lost because a
 * shared repo was misconfigured. A no-op when there is nothing to mirror to.
 */
export async function mirrorNote(root: string, n: NewNote): Promise<{ shared: boolean }> {
  const cfg = resolveSidecar(root);
  if (!cfg) return { shared: false };
  const actor = requireActor(root);
  if ("error" in actor) return { shared: false };
  await ensureSidecar(cfg.path, actor);
  await createNote(cfg.path, cfg.universe, actor, n);
  return { shared: true };
}
