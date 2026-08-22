/**
 * Staleness: compare the stored anchors against reality and route the fallout
 * to the logical nodes that cited the affected code.
 *
 * A hash mismatch is `candidate_stale` — a signal to review, never a claim that
 * the doc IS wrong. Only a human/agent decides that. A vanished symbol is
 * `lost` (v1 stops here; fuzzy re-anchoring is a later phase).
 */

import { access } from "node:fs/promises";
import { join } from "node:path";
import {
  type AnchorStore, type LogicalNode, type AnchorCheck, type StalenessStatus,
} from "./schema.js";
import { indexFile } from "./repo.js";
import { changedFilesSince } from "./git.js";
import { loadIgnore } from "./ignore.js";
import { grammarForPath, } from "./grammars.js";
import { sameBody } from "./normalize.js";

export interface StalenessResult {
  scope: "git-diff" | "full-scan";
  okCount: number;
  checks: AnchorCheck[]; // non-ok only (candidate_stale, lost)
  addedAnchorIds: string[]; // symbols present now but not in the store
  flaggedNodes: { node: LogicalNode; reasons: AnchorCheck[] }[];
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function computeStaleness(
  root: string,
  store: AnchorStore,
  nodes: LogicalNode[],
  lastVerifiedCommit: string | null,
): Promise<StalenessResult> {
  // Which files to re-check: git diff when possible, else everything.
  const changed = changedFilesSince(root, lastVerifiedCommit);
  const byFile = new Map<string, typeof store.anchors>();
  for (const a of store.anchors) {
    let list = byFile.get(a.file);
    if (!list) byFile.set(a.file, (list = []));
    list.push(a);
  }
  // git-diff mode: check exactly the changed files (incl. new/deleted ones).
  // full-scan mode (no git / no baseline commit): re-check every indexed file.
  // Either way, drop unsupported and ignored (vendored) paths.
  const ignore = await loadIgnore(root);
  const filesToCheck = (changed ?? [...byFile.keys()]).filter(
    (f) => grammarForPath(f) && !ignore.ignores(f, false),
  );
  const scope: StalenessResult["scope"] = changed ? "git-diff" : "full-scan";

  const checks: AnchorCheck[] = [];
  const addedAnchorIds: string[] = [];
  const statusById = new Map<string, StalenessStatus>();
  let okCount = 0;

  // Restrict to files we actually have anchors for OR that still exist & are
  // supported; re-index each and diff against stored anchors for that file.
  const checkSet = new Set(filesToCheck);
  for (const file of checkSet) {
    const stored = byFile.get(file) ?? [];
    const abs = join(root, file);
    const present = await fileExists(abs);
    const fresh = present ? await indexFile(abs, file) : [];
    const freshById = new Map(fresh.map((a) => [a.id, a]));
    const storedIds = new Set(stored.map((a) => a.id));

    for (const a of stored) {
      const now = freshById.get(a.id);
      if (!now) {
        checks.push({ anchorId: a.id, status: "lost" });
        statusById.set(a.id, "lost");
      } else if (!sameBody(now.bodyHash, a.bodyHash)) {
        checks.push({ anchorId: a.id, status: "candidate_stale", newHash: now.bodyHash });
        statusById.set(a.id, "candidate_stale");
      } else {
        okCount++;
      }
    }
    for (const a of fresh) {
      if (!storedIds.has(a.id)) addedAnchorIds.push(a.id);
    }
  }
  // Anchors in files we didn't re-check are assumed ok (unchanged per git).
  okCount += store.anchors.filter((a) => !checkSet.has(a.file)).length;

  const flaggedNodes: StalenessResult["flaggedNodes"] = [];
  for (const node of nodes) {
    const reasons = node.anchors
      .filter((id) => statusById.has(id))
      .map((id) => ({ anchorId: id, status: statusById.get(id)! }));
    if (reasons.length) flaggedNodes.push({ node, reasons });
  }

  return { scope, okCount, checks, addedAnchorIds, flaggedNodes };
}
