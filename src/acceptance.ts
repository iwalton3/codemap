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
 * The two git questions this needs, injected so it stays pure and testable.
 * Callers back both with `git merge-base --is-ancestor`, memoised.
 *
 * A `null` commit is a legacy mark, written before acceptances recorded one: it
 * counts as on-ref (there is nothing better to assume) but stands in no ancestor
 * relation to anything, so it can neither supersede nor be superseded. A legacy
 * acceptance therefore never raises a revert on its own — the conservative read,
 * since we cannot tell whether it predates the commits around it.
 */
export interface Ancestry {
  /** Is `commit` in the viewed ref's history? */
  onRef(commit: string | null): boolean;
  /** Is `a` a STRICT ancestor of `b`? Same commit is false — see `supersededBy` below. */
  precedes(a: string | null, b: string | null): boolean;
}

/**
 * Pick the newest of `pool` by ancestry: an entry no other entry descends from.
 * Concurrent commits (either side of a merge) are both maximal and neither is
 * "newer"; the timestamp tie-break only decides which one is displayed.
 */
function newest(pool: AcceptedEntry[], anc: Ancestry): AcceptedEntry | undefined {
  const maximal = pool.filter((e) => !pool.some((o) => o !== e && anc.precedes(e.commit, o.commit)));
  return (maximal.length ? maximal : pool).reduce<AcceptedEntry | undefined>(
    (best, e) => (best && best.at >= e.at ? best : e),
    undefined,
  );
}

export function resolveAcceptance(entries: AcceptedEntry[], liveHash: string | undefined, anc: Ancestry): Acceptance {
  if (!liveHash || !entries.length) return { via: "none" };
  if (!entries.some((e) => e.bodyHash === liveHash)) return { via: "none" };

  const lineage = entries.filter((e) => anc.onRef(e.commit));
  const mine = lineage.filter((e) => e.bodyHash === liveHash);

  // An acceptance is superseded only by a *descendant* acceptance of a different
  // body: that is a commit on this history which knowingly moved past it. Position
  // in `entries` is the order marks were WRITTEN, which is not commit order — a
  // stack walk signs the tip before its base, and after a merge two concurrent
  // commits are both ancestors of the head while neither follows the other. Reading
  // the array as a timeline calls both of those a revert.
  const supersedersOf = (e: AcceptedEntry) =>
    lineage.filter((o) => o.bodyHash !== liveHash && anc.precedes(e.commit, o.commit));

  const standing = mine.filter((e) => !supersedersOf(e).length);
  if (standing.length) return { via: "direct", entry: newest(standing, anc) };

  if (mine.length) {
    // Every acceptance of this body on this history has been left behind, yet the
    // code is that body again: someone undid the work the newer one covered.
    const entry = newest(mine, anc);
    const supersededBy = newest(mine.flatMap(supersedersOf), anc);
    if (entry && supersededBy) return { via: "reverted", entry, supersededBy };
  }

  // Approved somewhere this ref does not descend from — a branch switch.
  return { via: "replayed", entry: newest(entries.filter((e) => e.bodyHash === liveHash), anc) };
}

/** Add a body to an accepted set, keeping it chronological, deduped and bounded. */
export function recordAcceptance(entries: AcceptedEntry[], next: AcceptedEntry, cap: number): AcceptedEntry[] {
  // Re-approving the same body on the same commit is a no-op rather than a new row.
  const kept = entries.filter((e) => !(e.bodyHash === next.bodyHash && e.commit === next.commit));
  const out = [...kept, next];
  return out.length > cap ? out.slice(out.length - cap) : out;
}
