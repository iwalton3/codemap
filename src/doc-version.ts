/**
 * Which version of a doc describes THIS checkout, and how well.
 *
 * Pure: `(versions, anchor hashes) -> a verdict`. It touches no database and no
 * filesystem, which is the point — `store.ts` folds SQLite rows through it and
 * `shared-docs.ts` folds sidecar events through it, and both must reach the same
 * answer from the same inputs or a doc means one thing locally and another on the
 * team's copy.
 *
 * It used to live in `store.ts`, which made `shared-docs.ts` import the storage
 * layer for a calculation that has nothing to do with storage. Harmless in that
 * direction and fatal in the other: once `store.ts` materializes the sidecar folds
 * it would import `shared-docs.ts` back, and this repo's import cycles fail with
 * no diagnostic at all — a blank page and an empty log. Keeping the pure half
 * below both makes the cycle unrepresentable rather than merely absent.
 */

import type { NodeVersion, NodeStatus, LogicalNode } from "./schema.js";
import { comparableHashes, sameBody } from "./normalize.js";
import { resolveAnchor, type AnchorIndex } from "./anchor-resolve.js";

/** Status of a version against the live @work anchors (fresh / stale / dangling / removed). */
export function evalVersion(v: NodeVersion, work: AnchorIndex) {
  if (v.generatedBy) return { status: "generated" as NodeStatus, stale: [] as string[], dangling: [] as string[], badness: 0 };
  if (v.removed) {
    // A tombstone is fresh where its cited anchors are ABSENT (the removal holds);
    // if any still exist here, the code came back → it doesn't apply (badness).
    // A tombstone INVERTS the polarity, so an undecidable citation counts AGAINST it
    // rather than being excluded like everywhere else in this function. Its claim is
    // "these are gone", inferred from absence — and an id this index could not have
    // minted is not evidence of absence. Letting it win on that would HIDE a doc
    // whose code may be sitting right there, and hiding is the direction with no
    // recovery. See docs/anchor-id-provenance.md §6.
    const present: string[] = [], undecided: string[] = [];
    for (const c of v.citations) {
      const at = resolveAnchor(c.anchorId, c.acceptedHashes, work).at;
      if (at === "found") present.push(c.anchorId);
      // `undetermined` joins `incomparable` here and that is the whole point of the
      // distinction: an index with no derivation tags produces absence for free, so
      // reading it as proof of removal lets a tombstone win on nothing and hide a
      // doc whose code may be right there. Only a POSITIVELY established absence
      // (`absent`) is evidence the removal holds.
      else if (at === "incomparable" || at === "undetermined") undecided.push(c.anchorId);
    }
    // Both count against the tombstone, but they are NOT the same thing to a reader:
    // `stale` on a removed version means "the code came back", and reporting an
    // undecidable citation there says the symbol is present when nobody established
    // that. Same badness, different sentence.
    return {
      status: "removed" as NodeStatus, stale: present, dangling: [] as string[],
      unverifiable: undecided, badness: present.length + undecided.length,
    };
  }
  const stale: string[] = [], dangling: string[] = [], unverifiable: string[] = [];
  for (const c of v.citations) {
    const r = resolveAnchor(c.anchorId, c.acceptedHashes, work);
    // An id no build behind this index could have minted is not a hole in the doc.
    // `dangling` scores in `badness`, which picks which version wins and decides
    // whether `documentNode` edits in place or forks — so this used to make a
    // derivation change take a durable write.
    if (r.at === "incomparable") { unverifiable.push(c.anchorId); continue; }
    // `undetermined` is dangling here, exactly as it was when it WAS `absent`. A
    // content version's question is "is the code here", and the answer is still no;
    // only the tombstone above needed the two absences told apart.
    if (r.at === "absent" || r.at === "undetermined") { dangling.push(c.anchorId); continue; }
    const live = r.hash;
    if (c.acceptedHashes.some((h) => sameBody(h, live))) continue;
    // Mismatched — but a hash minted under an older HASH_SCHEME cannot be compared
    // to this one at all, so its inequality says the derivation changed, not the
    // code. Counting that as drift makes a scheme bump flag EVERY doc in the store
    // on the first reindex; `ops-shared` already draws this line for the sidecar's
    // copy (985 of 985 on a real repo), and this is the same judgement locally.
    if (!c.acceptedHashes.some((h) => comparableHashes(h, live))) unverifiable.push(c.anchorId);
    else stale.push(c.anchorId);
  }
  // Order is worst-first, and `unverifiable` sits below the two we can prove: it is
  // "nobody can say", which must not outrank a hole or real drift, and must not be
  // laundered into `fresh` either.
  const status: NodeStatus = dangling.length ? "dangling" : stale.length ? "stale" : unverifiable.length ? "unverifiable" : "fresh";
  // NOT in `badness`: badness picks which version fits this branch, and a scheme
  // bump makes every version equally unverifiable — letting it score would shuffle
  // the winner for a reason that has nothing to do with the branch.
  return { status, stale, dangling, unverifiable, badness: stale.length + dangling.length };
}

/**
 * The version that best fits the current branch: fewest problems, then SHOWN over
 * hidden, then most recent.
 *
 * The middle rule is deliberate and it is the whole of blocker 4. A tombstone and a
 * content version citing the same code tie at equal badness whenever the index
 * cannot establish the absence — and recency then decided it, normally for the
 * tombstone, because a removal is written after the thing it removes. So a doc
 * disappeared on a tie, and nobody goes looking for a doc they cannot see.
 *
 * Hiding has to be strictly better, never merely equal. This cannot suppress a
 * legitimate removal: a tombstone whose citations this index resolved as gone
 * scores 0 against the content version's dangling, and wins on badness before
 * reaching here.
 */
export function selectWinner(versions: NodeVersion[], work: AnchorIndex): { v: NodeVersion; e: ReturnType<typeof evalVersion> } {
  let best = versions[0]!, bestE = evalVersion(best, work);
  for (const v of versions.slice(1)) {
    const e = evalVersion(v, work);
    // TODO: git-aware tiebreak (created_commit ancestry) — rare; most-recent for now.
    const better = e.badness !== bestE.badness ? e.badness < bestE.badness
      : !!best.removed !== !!v.removed ? !v.removed
      // A person's prose beats a machine synopsis at equal badness. NOT a tidiness
      // rule and NOT inert: both score 0, so recency decided — and a generated row's
      // `created_at` refreshes on every re-emit, so after any code change the
      // analyzer's summary silently outranked a human doc on every surface. This
      // changes resolution on a local-only store too, wherever a human version has
      // forked onto a generated node id.
      //
      // Badness still comes first, which is the right reading in the other direction:
      // a DRIFTED human doc loses to a current machine synopsis, and `versionCount`
      // still shows it exists.
      : !!best.generatedBy !== !!v.generatedBy ? !v.generatedBy
      : v.createdAt > best.createdAt;
    if (better) { best = v; bestE = e; }
  }
  return { v: best, e: bestE };
}

export function resolveNode(versions: NodeVersion[], work: AnchorIndex, allVersions = versions): LogicalNode {
  const { v, e } = selectWinner(versions, work);
  return {
    id: v.nodeId, type: v.type, title: v.title, summary: v.summary, body: v.body,
    anchors: v.citations.map((c) => c.anchorId),
    ...(v.generatedBy ? { generatedBy: v.generatedBy } : {}),
    ...(v.origin ? { origin: v.origin } : {}),
    ...(v.author ? { author: v.author } : {}),
    versionId: v.versionId, status: e.status, staleAnchors: e.stale, danglingAnchors: e.dangling,
    // The UNFILTERED count. A caller may hand `versions` a narrowed pool — the store
    // drops local tombstones from a node a teammate has documented — and counting
    // that pool made a node with three versions report two, disagreeing with the
    // version-history UI, which lists them all.
    versionCount: allVersions.length,
  };
}

/** The version that wins against a given anchor-hash map (e.g. a base/head snapshot). */
export function winningVersionAt(versions: NodeVersion[], hashes: AnchorIndex): NodeVersion | undefined {
  return versions.length ? selectWinner(versions, hashes).v : undefined;
}

