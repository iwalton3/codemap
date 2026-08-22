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
import { comparableHashes, sameBody, bodyKey } from "./normalize.js";

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
  /**
   * Does this commit still exist in the repository at all?
   *
   * "Not on this history" and "gone" are different answers, and only the first is
   * a branch switch. A squash- or rebase-merge — GitHub's default — REWRITES the
   * pull request's commits, so the head a sign-off was witnessed against is not an
   * ancestor of the mainline and never will be. Read as a branch switch, every
   * acceptance ever made on a PR surface badges `replayed` forever, and `reverted`
   * can never fire for one. An absent commit cannot be placed, so it is treated
   * like a legacy (null) one: on-ref, but unable to supersede anything.
   *
   * An entry whose commit was REWRITTEN is still superseded by a different body
   * approved at a commit that is on this history — see `supersedersOf`. Without
   * that, a force-push followed by a genuine revert reported `direct`. A LEGACY
   * entry (no commit ever recorded) keeps its documented conservatism instead.
   *
   * The limit that remains, stated rather than papered over: two acceptances BOTH
   * made on branches that were squashed away cannot be ordered against each other,
   * and report the benign verdict. Guessing from write order instead is what used
   * to read 1,148 of 3,724 marks back as reverts.
   */
  known(commit: string): boolean;
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
  if (!entries.some((e) => sameBody(e.bodyHash, liveHash))) {
    // Nothing matches — but "the code changed" and "we cannot tell" are different
    // answers, and only one of them should turn a green check red. If not one entry
    // is even COMPARABLE with the live hash, every stored hash predates a
    // HASH_SCHEME bump and the mismatch is the derivation, not the body.
    //
    // Some comparable and none equal IS drift: a legacy entry alongside a current
    // one that genuinely moved must still read stale.
    if (!entries.some((e) => comparableHashes(e.bodyHash, liveHash))) return { via: "unverifiable" };
    return { via: "none" };
  }

  // An entry whose commit is gone cannot be placed on or off this history, so it
  // counts as on-ref — the same conservative reading a legacy `null` commit gets.
  const placeable = (e: AcceptedEntry) => e.commit !== null && anc.known(e.commit);
  // Recorded a commit, and that commit is GONE — force-pushed, amended, squashed.
  // Distinct from a LEGACY entry (`commit === null`), which never recorded one and
  // is documented to stay conservative: it can neither supersede nor be superseded.
  const rewritten = (e: AcceptedEntry) => e.commit !== null && !anc.known(e.commit);
  const lineage = entries.filter((e) => !placeable(e) || anc.onRef(e.commit));
  const mine = lineage.filter((e) => sameBody(e.bodyHash, liveHash));

  // An acceptance is superseded only by a *descendant* acceptance of a different
  // body: that is a commit on this history which knowingly moved past it. Position
  // in `entries` is the order marks were WRITTEN, which is not commit order — a
  // stack walk signs the tip before its base, and after a merge two concurrent
  // commits are both ancestors of the head while neither follows the other. Reading
  // the array as a timeline calls both of those a revert.
  const supersedersOf = (e: AcceptedEntry) =>
    lineage.filter((o) => !sameBody(o.bodyHash, liveHash) && (
      anc.precedes(e.commit, o.commit)
      // `e`'s commit is gone (force-push, amend, squash), so NOTHING can be ordered
      // against it by ancestry — and without this it came out `standing`, i.e. a full
      // green check on code somebody had since moved past. A different body approved
      // at a commit that IS on this history is evidence the work moved on, and a
      // verdict we cannot support must never be the strongest one.
      || (rewritten(e) && placeable(o))
    ));

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
  return { via: "replayed", entry: newest(entries.filter((e) => sameBody(e.bodyHash, liveHash)), anc) };
}

/**
 * Add a body to an accepted set, keeping it chronological, deduped and bounded.
 *
 * The trim is BODY-AWARE. Dropping the oldest entries outright silently changed the
 * verdict rather than just bounding storage: a body you did sign, whose only entry
 * had been evicted, read as `none` — the mark went stale with no record it was ever
 * approved — and when the on-lineage copy of a body went while an off-lineage copy
 * survived, a genuine `reverted` downgraded to the benign `replayed`. That is the
 * loud case being lost precisely on the hottest symbols, which are the ones most
 * likely to be reverted.
 *
 * So eviction prefers a DUPLICATE of a body that still has another entry: no body
 * is forgotten while a second trace of some other body remains. The residual, since
 * a bound is a bound: once every body is down to one entry, the oldest body does
 * go. It now takes `cap` DISTINCT bodies to lose one rather than `cap` re-marks.
 */
export function recordAcceptance(entries: AcceptedEntry[], next: AcceptedEntry, cap: number): AcceptedEntry[] {
  // Re-approving the same body on the same commit is a no-op rather than a new row.
  const kept = entries.filter((e) => !(sameBody(e.bodyHash, next.bodyHash) && e.commit === next.commit));
  const out = [...kept, next];
  while (out.length > cap) {
    const counts = new Map<string, number>();
    // Keyed by (scheme, digest), not by the raw string and not by the digest alone.
    // Two annotated spellings of one body must land on one key or the count of
    // distinct bodies is wrong; but the DIGEST alone merges two schemes, and a
    // scheme-1 body is not the same body as a scheme-2 one — it is an older
    // derivation of possibly-different code. Merging them evicts the wrong entry.
    for (const e of out) { const k = bodyKey(e.bodyHash); counts.set(k, (counts.get(k) ?? 0) + 1); }
    const dup = out.findIndex((e) => (counts.get(bodyKey(e.bodyHash)) ?? 0) > 1);   // oldest-first
    out.splice(dup >= 0 ? dup : 0, 1);
  }
  return out;
}
