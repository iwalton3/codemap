/**
 * Incremental index update — run on `check` so the anchor store tracks reality
 * (new anchors resolve, moved anchors get accurate locations) without a full
 * re-init.
 *
 * Deliberately conservative about the staleness signal: it ADDS new anchors and
 * refreshes locations, but never re-hashes an existing anchor (that would clear a
 * candidate_stale flag before the doc was actually reviewed) and never removes a
 * vanished anchor (that would drop the `lost` signal and the citing node's link).
 * `init` remains the "re-baseline everything" reset.
 */

import { access } from "node:fs/promises";
import { join } from "node:path";
import { readAnchorStore, readState, writeAnchorStore } from "./store.js";
import { changedFilesSince, headCommit } from "./git.js";
import { indexFile } from "./repo.js";
import { grammarForPath } from "./grammars.js";
import { loadIgnore } from "./ignore.js";

export async function applyIndexUpdate(root: string): Promise<{ added: number; movedLoc: number }> {
  const store = await readAnchorStore(root);
  let baseline: string | null = null;
  try {
    baseline = (await readState(root)).lastVerifiedCommit;
  } catch {
    /* not initialized */
  }

  const changed = changedFilesSince(root, baseline);
  const ignore = await loadIgnore(root);
  const files = (changed ?? [...new Set(store.anchors.map((a) => a.file))]).filter(
    (f) => grammarForPath(f) && !ignore.ignores(f, false),
  );

  const byId = new Map(store.anchors.map((a) => [a.id, a]));
  const head = headCommit(root);
  let added = 0;
  let movedLoc = 0;

  for (const file of files) {
    const abs = join(root, file);
    try {
      await access(abs);
    } catch {
      continue; // file gone — keep its anchors so `lost` persists
    }
    let fresh;
    try {
      fresh = await indexFile(abs, file);
    } catch {
      continue;
    }
    for (const a of fresh) {
      const existing = byId.get(a.id);
      if (existing) {
        // Refresh location only; preserve bodyHash/lastVerifiedCommit (the baseline).
        if (existing.loc?.startByte !== a.loc?.startByte || existing.loc?.endByte !== a.loc?.endByte) {
          existing.loc = a.loc;
          movedLoc++;
        }
      } else {
        a.lastVerifiedCommit = head; // new anchor: its own baseline is now
        byId.set(a.id, a);
        added++;
      }
    }
  }

  if (added || movedLoc) await writeAnchorStore(root, [...byId.values()]);
  return { added, movedLoc };
}
