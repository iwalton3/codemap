/**
 * Resolving a live body against what a review has accepted.
 *
 * A sign-off is a statement about (anchor, body): it holds wherever that body
 * appears, which is what lets a review survive a rebase, a cherry-pick, or
 * walking down a stack of dependent branches.
 *
 * The part that needs care is a body you approved *earlier* showing up again.
 * Two very different things look identical by content:
 *
 *   - you switched refs, and this branch legitimately holds the older body —
 *     navigation, and re-reviewing it would be busywork;
 *   - a new commit on this ref's own history moved the code back to it —
 *     someone undid work, which is exactly when a reviewer wants interrupting.
 *
 * Ancestry tells them apart, so this never has to guess.
 */

import type { AcceptedEntry, AcceptanceVia } from "./schema.js";

export interface Acceptance {
  via: AcceptanceVia;
  /** The entry that explains the verdict — what to show the reviewer. */
  entry?: AcceptedEntry;
  /** For `reverted`: the newer acceptance on this ancestry that this body went back from. */
  supersededBy?: AcceptedEntry;
}

/**
 * `onAncestry(commit)` answers "is this commit in the viewed ref's history?".
 * Injected so this stays pure and testable; callers back it with `git merge-base
 * --is-ancestor`, memoised per commit.
 */
export function resolveAcceptance(
  entries: AcceptedEntry[],
  liveHash: string | undefined,
  onAncestry: (commit: string | null) => boolean,
): Acceptance {
  if (!liveHash || !entries.length) return { via: "none" };

  const matches = entries.filter((e) => e.bodyHash === liveHash);
  if (!matches.length) return { via: "none" };

  // Entries on this ref's own history, oldest first (input order is chronological).
  const lineage = entries.filter((e) => onAncestry(e.commit));
  const newestOnLineage = lineage.length ? lineage[lineage.length - 1] : undefined;

  if (newestOnLineage && newestOnLineage.bodyHash === liveHash) return { via: "direct", entry: newestOnLineage };

  // Approved on this ancestry, but something newer here approved a different body:
  // the code has moved back. That is a revert, not navigation.
  const onLineageMatch = [...lineage].reverse().find((e) => e.bodyHash === liveHash);
  if (onLineageMatch && newestOnLineage) {
    return { via: "reverted", entry: onLineageMatch, supersededBy: newestOnLineage };
  }

  // Approved somewhere this ref does not descend from — a branch switch.
  return { via: "replayed", entry: matches[matches.length - 1] };
}

/** Add a body to an accepted set, keeping it chronological, deduped and bounded. */
export function recordAcceptance(entries: AcceptedEntry[], next: AcceptedEntry, cap: number): AcceptedEntry[] {
  // Re-approving the same body on the same commit is a no-op rather than a new row.
  const kept = entries.filter((e) => !(e.bodyHash === next.bodyHash && e.commit === next.commit));
  const out = [...kept, next];
  return out.length > cap ? out.slice(out.length - cap) : out;
}
