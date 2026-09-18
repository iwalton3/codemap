/**
 * The snapshot read callers use: a commit's anchors, built from git objects on the first
 * read that finds none usable. Above the store because the indexer is (`repo.ts` reaches
 * `sidecar-config`, which imports the store), so the store's own read only serves cache.
 */
import type { Anchor } from "./schema.js";
import { indexCommit } from "./repo.js";
import { revParse } from "./git.js";
import {
  anchorsUnderRef, readCachedSnapshot, referencedAnchorIds, retainOrphans, snapshotKey, writeSnapshot,
} from "./store.js";
import { db } from "./db.js";

/**
 * Null only when git cannot read the commit here; `snapshotRefusal` then says why. Every
 * other miss (never cached, a dirty row an older build wrote, another derivation) is
 * rebuilt, so no caller has to tell "not cached" from "empty".
 */
export async function readSnapshot(
  root: string, ref: string, opts: { allowDirty?: boolean } = {},
): Promise<Anchor[] | null> {
  const sha = snapshotKey(root, ref);
  return (await readCachedSnapshot(root, sha, opts)) ?? buildSnapshot(root, sha);
}

/**
 * Index a commit from git objects and cache it, replacing whatever row it had. Null when
 * `sha` is not a commit this repository can read.
 *
 * Referenced anchors only the old row held are retained first: an `offTree` finding is
 * reachable precisely BECAUSE a snapshot still holds its anchor, and a rebuild under
 * another derivation mints different ids.
 */
export async function buildSnapshot(root: string, sha: string, label?: string | null): Promise<Anchor[] | null> {
  if (revParse(root, sha) !== sha) return null;
  const anchors = await indexCommit(root, sha);
  if (!anchors) return null;
  const previous = anchorsUnderRef(root, sha);
  if (previous.length) {
    const fresh = new Set(anchors.map((a) => a.id));
    const referenced = await referencedAnchorIds(root);
    retainOrphans(root, previous.filter((a) => referenced.has(a.id) && !fresh.has(a.id)));
  }
  const kept = (db(root).prepare("SELECT branch FROM snapshots WHERE ref = ?").get(sha) as { branch: string | null } | undefined)?.branch;
  await writeSnapshot(root, sha, label ?? kept ?? null, anchors, new Date().toISOString());
  return anchors;
}
