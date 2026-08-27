/**
 * Human review state — marking nodes/anchors as logically or code reviewed, with
 * the same witness mechanism as bugs: a review captures the covered code's hashes,
 * and goes `stale` when that code later changes (so a green check never lies).
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { type Anchor, type Review, type ReviewLevel, type ReviewState, type BugWitness } from "./schema.js";
import { readReviews, writeReviews, readAnchorStore, loadNodes, readSnapshot, snapshotIsDirty, snapshotBranch, derivationLookup } from "./store.js";
import { resolveAcceptance, recordAcceptance, type Ancestry } from "./acceptance.js";
import { ACCEPTED_CAP, type AcceptedCitation, type AcceptedEntry, type AcceptanceVia } from "./schema.js";
import { isAncestor, isGitRepo, currentBranch as gitBranch, hasObject } from "./git.js";
import { ABSENT_HASH, comparableHashes, sameBody } from "./normalize.js";
import { resolveActor, actorLabel } from "./identity.js";
import { indexFile } from "./repo.js";
import { currentDerivations } from "./grammars.js";
import { anchorIndex, derivationsOf, resolveAnchor, type AnchorIndex } from "./anchor-resolve.js";
import { headCommit } from "./git.js";

/** The human review acts: exposure (`viewed`) vs liability-bearing sign-off (`signed`). */
export type Attestation = "viewed" | "signed";

/**
 * What a review row effectively attests, resolving the two legacy defaults:
 * an agent review with no `attestation` reads as `checked`; a legacy human review
 * (actor human, no attestation) reads as `signed` — it predates the viewed/signed split.
 */
export function effectiveAttestation(r: Review): Attestation | "checked" {
  if (r.attestation) return r.attestation;
  return (r.actor ?? "agent") === "human" ? "signed" : "checked";
}

/** A `viewed` row records exposure only; every other row is a vouch (`signed`/`checked`). */
const isViewedRow = (r: Review) => r.attestation === "viewed";

export interface ReviewInfo {
  state: ReviewState;
  by?: string;
  /**
   * Set when this mark was earned by signing the symbol that CONTAINS this one —
   * a class over its methods. A borrowed tick is not the same claim as one made
   * here, so the surface has to be able to say which it is (see `via`).
   */
  coveredBy?: string;
  /** "human" (verified) or "agent" (checked); absent legacy reviews are treated as human. */
  actor?: "human" | "agent";
  at?: string;
  /**
   * How the mark still applies: `direct` (approved here), `replayed` (approved on
   * another lineage — a branch switch), `reverted` (approved earlier on THIS
   * lineage and the code has moved back to it). Replay-green and just-signed-green
   * are different claims, so the surface can say which it is.
   */
  via?: AcceptanceVia;
  /** Where the acceptance being relied on happened, for `replayed` / `reverted`. */
  acceptedAt?: { branch: string | null; commit: string | null; at: string };
  /** For `reverted`: the newer body on this lineage that the code went back from. */
  revertedFrom?: { branch: string | null; commit: string | null; at: string };
}
export interface ReviewPair {
  logical: ReviewInfo;
  code: ReviewInfo;
}

export type Target = { kind: "node" | "anchor"; id: string };
const key = (t: Target) => `${t.kind}:${t.id}`;

async function coveredAnchorIds(root: string, target: Target, nodeAnchors?: Map<string, string[]>): Promise<string[]> {
  if (target.kind === "anchor") return [target.id];
  if (nodeAnchors) return nodeAnchors.get(target.id) ?? [];
  const nodes = await loadNodes(root);
  return nodes.find((n) => n.id === target.id)?.anchors ?? [];
}

/**
 * Hashes for a set of anchor ids — from the working tree by default, or from a
 * cached commit snapshot when `ref` is given.
 *
 * `ref` is what makes reviewing a pull request honest. The working tree is on
 * some other branch, so witnessing a PR sign-off against it records the hash of
 * code the reviewer never saw: `sha256:absent` for a symbol the branch adds, and
 * the *pre-change* hash for one it modifies. Either way the mark claims a vouch
 * for something else — the exact lie witness hashes exist to prevent.
 *
 * THROWS when `ref` names a commit with no cached snapshot. Returning an empty map
 * wrote every witness as `sha256:absent` and reported success, so the mark read as
 * permanently drifted and no caller could tell that from code genuinely having
 * moved. A caller that wants working-tree hashes passes no `ref`; one that names a
 * commit is asserting it has been indexed.
 */
export async function liveHashes(root: string, anchorIds: Iterable<string>, ref?: string): Promise<AnchorIndex> {
  const knownTags = derivationLookup(root);
  if (ref) {
    const snap = await readSnapshot(root, ref);
    if (!snap) throw new Error(`no cached snapshot for ${ref.slice(0, 12)} — index that commit before witnessing against it`);
    // Refused for the reason `diff` refuses the same snapshot (diff.ts, COD-3), and
    // it bites harder here: `ref` exists SO THAT a pull-request sign-off witnesses
    // the head rather than whatever is checked out, and a snapshot `reindex` cached
    // from a dirty tree is the working tree wearing the commit's name. Witnessing
    // against it records exactly the body the caller passed `ref` to avoid, and the
    // resulting mark reads as a review of code nobody looked at. `snapshotAt` reads
    // git objects and is never dirty, so the honest path is unaffected.
    if (snapshotIsDirty(root, ref)) {
      throw new Error(`the cached snapshot for ${ref.slice(0, 12)} was indexed from a working tree with uncommitted changes, `
        + `so it is not that commit — witnessing against it would record the working tree's body under that sha. `
        + `Re-cache it from git objects with \`codemap snapshot ${ref.slice(0, 12)}\`, which needs no clean checkout.`);
    }
    const want = new Set(anchorIds);
    const out = new Map<string, string>();
    for (const a of snap) if (want.has(a.id)) out.set(a.id, a.bodyHash);
    // The SNAPSHOT's rows, not this build's: a cached commit was minted by whatever
    // build cached it, and that is the index an id had to come from to appear here.
    return anchorIndex(out, derivationsOf(snap), knownTags);
  }
  const store = await readAnchorStore(root);
  const byId = new Map(store.anchors.map((a) => [a.id, a]));
  const files = new Set<string>();
  for (const id of anchorIds) {
    const f = byId.get(id)?.file;
    if (f) files.add(f);
  }
  const live = new Map<string, string>();
  for (const f of files) {
    try {
      for (const a of await indexFile(join(root, f), f)) live.set(a.id, a.bodyHash);
    } catch {
      /* file gone */
    }
  }
  // THIS build's tags, not the store's rows'. These anchors were just minted in
  // process by `indexFile`, so the index being searched is this build's output —
  // and taking it from whatever survived the loop would call a genuinely deleted
  // file's symbols undecidable, since nothing would have been indexed at all.
  return anchorIndex(live, currentDerivations(), knownTags);
}

/** Witnesses (anchor id + current live hash) covering a target — the staleness snapshot. */
export async function witnessesFor(root: string, target: Target, ref?: string): Promise<BugWitness[]> {
  const anchorIds = await coveredAnchorIds(root, target);
  const live = await liveHashes(root, anchorIds, ref);
  return anchorIds.map((id) => ({ anchorId: id, bodyHash: live.get(id) ?? "sha256:absent" }));
}

/**
 * The commit a mark is ABOUT, and the branch that commit belongs to.
 *
 * A PR sign-off is made against the pull request's head, not against whatever the
 * working tree happens to be checked out to. Stamping `headCommit(root)` made the
 * mark claim it happened at the local HEAD while its witnesses came from the PR
 * head. The branch had the same split: it was the working tree's, so a year of
 * imported acceptances all carry whichever branch the importer happened to be on.
 *
 * This fixes what a mark RECORDS. What a reader compares it against is a separate
 * question — `changedSince` takes its own `ref` for that, and a caller asking about
 * a PR must pass one, or it is answered against the working tree.
 */
function markedAt(root: string, ref: string | undefined): { commit: string | null; branch: string | null } {
  if (ref) return { commit: ref, branch: snapshotBranch(root, ref) };
  return { commit: headCommit(root), branch: isGitRepo(root) ? gitBranch(root) : null };
}

/**
 * The anchors whose code sits INSIDE another's, within one consistent index.
 *
 * A review pane shows a symbol's whole span, so a class's pane is a superset of
 * each of its methods' — and on a changed symbol so is its diff. Reviewing the
 * class therefore *is* reading the members; asking for a separate sign-off on
 * each one asks the reviewer to read the same lines twice.
 *
 * `symbolPath` alone does not establish containment: two same-named types in one
 * file are told apart by a disambiguator and their members share a path prefix,
 * so the byte span decides. A symbol with no recorded span yields nothing rather
 * than a guess — an unprovable cover must not become a sign-off.
 *
 * Pass ONE commit's anchors at a time; spans from two commits are not comparable.
 * A caller that wants both sides of a diff unions the two results.
 */
export function containedAnchorIds(anchors: Anchor[], containerId: string): string[] {
  const container = anchors.find((a) => a.id === containerId);
  const span = container?.loc;
  if (!container || !span) return [];
  const path = container.symbolPath;
  const out: string[] = [];
  for (const a of anchors) {
    if (a.id === containerId || a.file !== container.file || !a.loc) continue;
    if (a.symbolPath.length <= path.length || !path.every((seg, i) => a.symbolPath[i] === seg)) continue;
    if (a.loc.startByte >= span.startByte && a.loc.endByte <= span.endByte) out.push(a.id);
  }
  return out;
}

export async function markReviewed(
  root: string,
  input: { targetKind: "node" | "anchor"; targetId: string; level: ReviewLevel; reviewer?: string; actor?: "human" | "agent"; attestation?: Attestation; ref?: string },
) {
  const target: Target = { kind: input.targetKind, id: input.targetId };
  const anchorIds = await coveredAnchorIds(root, target);
  // Witness the code that was actually read: on a PR surface that is the head
  // commit, not whatever the working tree happens to hold.
  const live = await liveHashes(root, anchorIds, input.ref);
  const witnesses = anchorIds.map((id) => ({ anchorId: id, bodyHash: live.get(id) ?? "sha256:absent" }));

  // Default to "agent": only an explicit human action (the web UI) grants a human
  // review. A human act with no attestation is a `signed` sign-off (the old `verified`).
  const actor = input.actor ?? "agent";
  // The existing human/agent binary decides WHETHER this was an agent; `resolveActor`
  // supplies WHO it was on behalf of. The two are not redundant — the binary is the
  // caller's assertion about the act, the principal is the machine's about the person.
  const by = resolveActor(root, { agent: actor === "agent" });
  const attestation: Attestation | undefined = input.attestation ?? (actor === "human" ? "signed" : undefined);
  const viewed = attestation === "viewed";

  const rs = await readReviews(root);
  const sameMark = (r: Review) =>
    r.target.kind === target.kind && r.target.id === target.id && r.level === input.level && isViewedRow(r) === viewed;

  // Carry forward what this mark has already approved. The row is replaced below,
  // so without this every earlier acceptance is dropped — and the same symbol
  // signed on two branches of a stack would keep only the last one.
  const prior = rs.reviews.find(sameMark);
  const priorAccepted = new Map((prior ? acceptedOf(prior) : []).map((c) => [c.anchorId, c.entries]));
  const { commit, branch } = markedAt(root, input.ref);
  const stamp = new Date().toISOString();
  const accepted: AcceptedCitation[] = anchorIds.map((id) => {
    const hash = live.get(id);
    const entries = priorAccepted.get(id) ?? [];
    return {
      anchorId: id,
      entries: hash ? recordAcceptance(entries, { bodyHash: hash, commit, branch, at: stamp }, ACCEPTED_CAP) : entries,
    };
  });

  // `viewed` and vouches (`signed`/`checked`) are independent marks: a new vouch
  // replaces the prior vouch at this level (human `signed` supersedes agent `checked`,
  // as before), while a new `viewed` replaces only the prior `viewed` — never a sign-off.
  rs.reviews = rs.reviews.filter((r) => !sameMark(r));
  rs.reviews.push({
    id: "rev_" + randomBytes(6).toString("hex"),
    target,
    level: input.level,
    reviewer: input.reviewer || (by ? actorLabel(by) : "me"),
    ...(by ? { by } : {}),
    actor,
    attestation,
    at: new Date().toISOString(),
    reviewedCommit: commit,
    witnesses,
    accepted,
  });
  await writeReviews(root, rs.reviews);
  return { ok: true, level: input.level, attestation: attestation ?? "checked", anchors: anchorIds.length };
}

export async function unmarkReviewed(
  root: string,
  input: { targetKind: "node" | "anchor"; targetId: string; level: ReviewLevel; attestation?: Attestation },
) {
  const rs = await readReviews(root);
  const before = rs.reviews.length;
  // No attestation → clear the whole level (both marks). `viewed` → drop only the
  // exposure row; `signed` → drop only the vouch, leaving any `viewed` intact.
  const dropViewed = input.attestation === undefined || input.attestation === "viewed";
  const dropVouch = input.attestation === undefined || input.attestation === "signed";
  rs.reviews = rs.reviews.filter(
    (r) =>
      !(
        r.target.kind === input.targetKind &&
        r.target.id === input.targetId &&
        r.level === input.level &&
        (isViewedRow(r) ? dropViewed : dropVouch)
      ),
  );
  await writeReviews(root, rs.reviews);
  return { ok: true, removed: before - rs.reviews.length };
}

/**
 * Withdraw the marks a container's sign-off wrote, and only those.
 *
 * The symmetry matters: signing a class writes a mark on every member the change
 * touches, so taking that sign-off back has to take them with it — otherwise the
 * class reads unsigned while everything in it stays green. Marks made about a
 * member directly survive; they were never this container's to withdraw.
 */
export async function unmarkCovered(
  root: string,
  containerId: string,
  input: { level: ReviewLevel; attestation?: Attestation },
): Promise<{ removed: string[] }> {
  const rs = await readReviews(root);
  const dropViewed = input.attestation === undefined || input.attestation === "viewed";
  const dropVouch = input.attestation === undefined || input.attestation === "signed";
  const doomed = (r: Review) =>
    r.coveredBy === containerId && r.level === input.level && (isViewedRow(r) ? dropViewed : dropVouch);
  const removed = rs.reviews.filter(doomed).map((r) => r.target.id);
  if (!removed.length) return { removed };
  rs.reviews = rs.reviews.filter((r) => !doomed(r));
  await writeReviews(root, rs.reviews);
  return { removed };
}

/**
 * The ancestry probe `resolveAcceptance` needs, backed by `merge-base --is-ancestor`
 * and memoised per (commit, commit) pair. One probe is built per batch and shared
 * across every anchor in it: marks are made against a handful of commits, so a run
 * over thousands of anchors costs a few git calls rather than one per anchor.
 *
 * Outside git (or with no resolvable ref) every acceptance reads as on-ref and
 * unrelated to every other — acceptances stand and nothing is reported reverted,
 * which is the right default when there is no history to appeal to.
 */
function ancestryProbe(root: string, viewRef: string | null): Ancestry {
  const gitHere = isGitRepo(root);
  const cache = new Map<string, boolean>();
  const ancestor = (a: string, b: string): boolean => {
    const k = `${a}\0${b}`;
    let v = cache.get(k);
    if (v === undefined) { v = isAncestor(root, a, b); cache.set(k, v); }
    return v;
  };
  const existsCache = new Map<string, boolean>();
  return {
    onRef: (c) => !c || !gitHere || !viewRef || c === viewRef || ancestor(c, viewRef),
    precedes: (a, b) => !!a && !!b && a !== b && gitHere && ancestor(a, b),
    known: (c) => {
      if (!gitHere) return false;                 // nothing can be placed without git
      const hit = existsCache.get(c);
      if (hit !== undefined) return hit;
      const v = hasObject(root, c);
      existsCache.set(c, v);
      return v;
    },
  };
}

/**
 * Review state for many targets at once — batches the live re-index over all covered
 * files. By default reflects the *vouch* (`signed`/`checked`); pass `{ viewed: true }`
 * to read the `viewed` exposure marks instead (same shape, so callers render either).
 */
export async function reviewStatesFor(
  root: string,
  targets: Target[],
  opts?: { viewed?: boolean; ref?: string },
): Promise<Map<string, ReviewPair>> {
  const rs = await readReviews(root);
  const nodes = await loadNodes(root);
  const nodeAnchors = new Map(nodes.map((n) => [n.id, n.anchors]));
  const all = new Set<string>();
  const covers = new Map<string, string[]>();
  for (const t of targets) {
    const ids = await coveredAnchorIds(root, t, nodeAnchors);
    covers.set(key(t), ids);
    ids.forEach((id) => all.add(id));
  }
  // Judge staleness against the same ref the surface is showing. A mark made on a
  // PR reads fresh there and stale on the base branch until the change lands —
  // which is right: the vouch covers the branch's code, and it activates on merge.
  const live = await liveHashes(root, all, opts?.ref);
  const out = new Map<string, ReviewPair>();
  const wantViewed = opts?.viewed ?? false;

  // Ancestry is what separates "this branch holds the older body" from "someone
  // committed a move back to it".
  const ancestry = ancestryProbe(root, opts?.ref ?? headCommit(root));

  const forLevel = (t: Target, level: ReviewLevel): ReviewInfo => {
    // Default: only vouches (`signed`/`checked`) set the reviewed state — a `viewed`
    // row is exposure, not a blessing. With `{viewed:true}` we read exactly those rows.
    const r = rs.reviews.find((x) => x.target.kind === t.kind && x.target.id === t.id && x.level === level && isViewedRow(x) === wantViewed);
    if (!r) return { state: "unreviewed" };
    const base = { by: r.reviewer, actor: r.actor ?? "agent", at: r.at, coveredBy: r.coveredBy } as const;

    const cites = acceptedOf(r);
    const resolved = cites.map((c) => {
      // The same rule as everywhere else, on the surface this product leads with:
      // a green check must go stale when the code it covered changes, and must NOT
      // go stale because a teammate's build spells the id differently. `live.get`
      // alone returns undefined for both, and `resolveAcceptance` reads undefined as
      // `none`, which is the red tick. See docs/anchor-id-provenance.md §6.
      const at = resolveAnchor(c.anchorId, c.entries.map((e) => e.bodyHash), live);
      if (at.at === "incomparable") return { via: "unverifiable" as const };
      return resolveAcceptance(c.entries, at.at === "found" ? at.hash : undefined, ancestry);
    });
    if (!resolved.length) return { state: "reviewed", ...base, via: "direct" };
    // A mark covers several anchors; the weakest one decides, so a single drifted
    // segment cannot hide behind the others.
    if (resolved.some((x) => x.via === "none")) return { state: "stale", ...base };

    const reverted = resolved.find((x) => x.via === "reverted");
    // Checked after `reverted` and before the benign verdicts: a revert is the one
    // thing a reviewer wants interrupting for, and it is established by a hash that
    // DID match, so it outranks "cannot tell". Below it, an unverifiable segment
    // must not be dressed up as a clean direct sign-off.
    if (!reverted && resolved.some((x) => x.via === "unverifiable")) {
      return { state: "reviewed", ...base, via: "unverifiable" };
    }
    if (reverted) {
      return {
        state: "reviewed", ...base, via: "reverted",
        acceptedAt: entryStamp(reverted.entry),
        revertedFrom: entryStamp(reverted.supersededBy),
      };
    }
    const replayed = resolved.find((x) => x.via === "replayed");
    if (replayed) return { state: "reviewed", ...base, via: "replayed", acceptedAt: entryStamp(replayed.entry) };
    return { state: "reviewed", ...base, via: "direct" };
  };
  for (const t of targets) out.set(key(t), { logical: forLevel(t, "logical"), code: forLevel(t, "code") });
  return out;
}

export async function reviewStatus(root: string, target: Target, opts?: { viewed?: boolean }): Promise<ReviewPair> {
  return (await reviewStatesFor(root, [target], opts)).get(key(target))!;
}

/**
 * A row's accepted sets, seeding from `witnesses` for marks written before
 * accepted sets existed — a legacy sign-off accepted exactly the body it witnessed.
 */
const entryStamp = (e?: AcceptedEntry) => (e ? { branch: e.branch, commit: e.commit, at: e.at } : undefined);

export function acceptedOf(r: Review): AcceptedCitation[] {
  if (r.accepted?.length) return r.accepted;
  return r.witnesses.map((w) => ({
    anchorId: w.anchorId,
    entries: [{ bodyHash: w.bodyHash, commit: r.reviewedCommit, branch: null, at: r.at }],
  }));
}

export interface DerivedCodeReview {
  state: ReviewState;
  actor: "human" | "agent" | null;
  signed: number;
  total: number;
  stale: number;
  /** Segments whose approval is borrowed from another lineage (↻). */
  replayed: number;
  /** Segments approved before the code moved BACK to that body on this history (⟲). */
  reverted: number;
  /**
   * Segments whose witness was hashed by another build, so the approval cannot be
   * checked against this one (?). Counted, not folded into `stale`: nothing drifted.
   * A rollup that omitted it read `signed === total` and drew a plain green tick
   * over segments its own buttons were drawing in the warning colour.
   */
  unverifiable: number;
}

/**
 * A node's code-review state is *derived* from the code reviews of the anchors it
 * cites — never a single "I signed the node" click that would silently vouch for
 * code you never opened. Every referenced segment must be signed (at live hashes)
 * before the node reads code-reviewed; any stale segment poisons it to `stale`;
 * anything short is `unreviewed` (with `signed/total` so the UI can show progress).
 * `actor` is `human` when a person signed at least one segment (so trust can reach
 * `verified`), else `agent` — matching the human/agent split used elsewhere.
 */
export function deriveCodeReview(anchorCode: ReviewInfo[]): DerivedCodeReview {
  const total = anchorCode.length;
  const signed = anchorCode.filter((a) => a.state === "reviewed").length;
  const stale = anchorCode.filter((a) => a.state === "stale").length;
  const state: ReviewState = total === 0 ? "unreviewed" : stale > 0 ? "stale" : signed === total ? "reviewed" : "unreviewed";
  const actor: "human" | "agent" | null =
    state === "reviewed" ? (anchorCode.some((a) => a.state === "reviewed" && a.actor === "human") ? "human" : "agent") : null;
  // Carried up so a rollup cannot present a borrowed or revert-sitting approval as
  // an ordinary one — the whole point of tracking `via` is lost if it stops at the
  // per-anchor button and every summary above it shows a plain tick.
  const replayed = anchorCode.filter((a) => a.state === "reviewed" && a.via === "replayed").length;
  const reverted = anchorCode.filter((a) => a.state === "reviewed" && a.via === "reverted").length;
  const unverifiable = anchorCode.filter((a) => a.state === "reviewed" && a.via === "unverifiable").length;
  return { state, actor, signed, total, stale, replayed, reverted, unverifiable };
}

export interface AnchorChange {
  anchorId: string;
  was: string;
  now: string;
  /**
   * The two hashes were minted under different HASH_SCHEMEs, so their inequality
   * says nothing about the code. Reported rather than dropped — the mark does need
   * re-witnessing — but it is NOT drift, and callers that escalate on drift must
   * filter it out. Re-indexing under the current scheme is what clears it.
   */
  unverifiable?: boolean;
}

/** Which of a mark's frozen witnesses no longer match the current live hashes. */
export function witnessDrift(witnesses: BugWitness[], live: AnchorIndex): AnchorChange[] {
  const out: AnchorChange[] = [];
  for (const w of witnesses) {
    const r = resolveAnchor(w.anchorId, [w.bodyHash], live);
    // An id this index could not have minted is not a symbol that went away. Before
    // this, the missing id became ABSENT_HASH — which is comparable to everything on
    // purpose — so a witness from another build read as confident drift to "no code
    // here". See docs/anchor-id-provenance.md §6.
    if (r.at === "incomparable") {
      out.push({ anchorId: w.anchorId, was: w.bodyHash, now: ABSENT_HASH, unverifiable: true });
      continue;
    }
    const now = r.at === "found" ? r.hash : ABSENT_HASH;
    if (sameBody(now, w.bodyHash)) continue;
    // Scheme first: an old-scheme witness differs from a live hash for a reason that
    // has nothing to do with the code, and calling that drift re-opens every review
    // in the store the moment normalization changes.
    if (!comparableHashes(now, w.bodyHash)) {
      out.push({ anchorId: w.anchorId, was: w.bodyHash, now, unverifiable: true });
      continue;
    }
    out.push({ anchorId: w.anchorId, was: w.bodyHash, now });
  }
  return out;
}

/** Witnesses that actually moved — drift proper, with the unverifiable ones removed. */
export function realDrift(changes: AnchorChange[]): AnchorChange[] {
  return changes.filter((c) => !c.unverifiable);
}

/**
 * Targeted diff — which anchors covered by `target` have moved since the human last
 * `viewed` / `signed` it. Powers "what changed since I last looked?" so a re-review of
 * a big change reads only the delta under the last mark, never the whole flow again.
 * `found:false` = no such mark yet (never viewed / never signed).
 */
export async function changedSince(
  root: string,
  target: Target,
  /**
   * `ref` is what "now" means. Without it this compares a mark's witnesses against
   * the WORKING TREE, which for a pull-request sign-off is some other branch
   * entirely — so a mark whose code has not moved at the PR head still reports the
   * whole thing as drifted. The caller knows which "now" it is asking about.
   */
  opts: { level: ReviewLevel; attestation: Attestation; ref?: string },
): Promise<{ found: boolean; at?: string; reviewedCommit?: string | null; changed: AnchorChange[] }> {
  const rs = await readReviews(root);
  const r = rs.reviews.find(
    (x) =>
      x.target.kind === target.kind &&
      x.target.id === target.id &&
      x.level === opts.level &&
      effectiveAttestation(x) === opts.attestation,
  );
  if (!r) return { found: false, changed: [] };
  const live = await liveHashes(root, r.witnesses.map((w) => w.anchorId), opts.ref);
  return { found: true, at: r.at, reviewedCommit: r.reviewedCommit, changed: witnessDrift(r.witnesses, live) };
}

/**
 * Per-anchor review state for the whole store. Staleness is judged against LIVE
 * hashes, but only the files that actually contain reviewed anchors are
 * re-indexed (reviews are few) — so it's both correct and cheap enough for the
 * outline heatmap. A node review propagates to the anchors it cites. Precedence:
 * reviewed > stale > unreviewed.
 */
export interface AnchorReview {
  code: ReviewState; logical: ReviewState;
  codeActor: "human" | "agent" | null; logicalActor: "human" | "agent" | null;
  codeVia?: AcceptanceVia; logicalVia?: AcceptanceVia;
}

export async function anchorReviewMap(
  root: string,
  anchors: { id: string }[],
  nodes: { id: string; anchors: string[] }[],
  reviews: Review[],
): Promise<Map<string, AnchorReview>> {
  const nodeAnchors = new Map(nodes.map((n) => [n.id, n.anchors]));
  const reviewedAnchorIds = new Set<string>();
  for (const r of reviews) {
    if (r.target.kind === "anchor") reviewedAnchorIds.add(r.target.id);
    else for (const aid of nodeAnchors.get(r.target.id) ?? []) reviewedAnchorIds.add(aid);
  }
  const live = await liveHashes(root, reviewedAnchorIds);
  // Judge through the accepted set, exactly as reviewStatesFor does. Comparing the
  // single legacy `witnesses` hash here instead would make this surface disagree
  // with the node and anchor pages the moment an approval is replayed or reverted.
  const ancestry = ancestryProbe(root, headCommit(root));
  const verdict = (r: Review): { state: ReviewState; via: AcceptanceVia } => {
    const cites = acceptedOf(r);
    if (!cites.length) return { state: "reviewed", via: "direct" };
    const each = cites.map((c) => resolveAcceptance(c.entries, live.get(c.anchorId), ancestry));
    if (each.some((x) => x.via === "none")) return { state: "stale", via: "none" };
    if (each.some((x) => x.via === "reverted")) return { state: "reviewed", via: "reverted" };
    if (each.some((x) => x.via === "replayed")) return { state: "reviewed", via: "replayed" };
    return { state: "reviewed", via: "direct" };
  };
  type Cell = { state: ReviewState; actor: "human" | "agent"; via: AcceptanceVia };
  const rank: Record<ReviewState, number> = { reviewed: 2, stale: 1, unreviewed: 0 };
  const code = new Map<string, Cell>();
  const logical = new Map<string, Cell>();
  // Higher-precedence state wins (reviewed > stale); among reviewed, a human review
  // beats an agent one (verified > checked), so the anchor reads at the best trust.
  // `via` rides along with the state it belongs to; a weaker tick never overwrites
  // a stronger one, but a `reverted` among equals is kept — it is the loud case.
  const VIA_RANK: Record<AcceptanceVia, number> = { reverted: 4, unverifiable: 3, replayed: 2, direct: 1, none: 0 };
  const bump = (m: Map<string, Cell>, id: string, state: ReviewState, actor: "human" | "agent", via: AcceptanceVia) => {
    const c = m.get(id);
    if (!c) { m.set(id, { state, actor, via }); return; }
    if (rank[state] > rank[c.state]) { c.state = state; c.actor = actor; c.via = via; }
    else if (state === c.state && state === "reviewed") {
      if (actor === "human") c.actor = "human";
      if (VIA_RANK[via] > VIA_RANK[c.via]) c.via = via;
    }
  };
  for (const r of reviews) {
    const { state, via } = verdict(r);
    const actor = r.actor ?? "agent"; // migration: legacy reviews read as agent-checked
    const m = r.level === "code" ? code : logical;
    if (r.target.kind === "anchor") bump(m, r.target.id, state, actor, via);
    else for (const aid of nodeAnchors.get(r.target.id) ?? []) bump(m, aid, state, actor, via);
  }
  const out = new Map<string, AnchorReview>();
  for (const a of anchors) {
    const c = code.get(a.id), l = logical.get(a.id);
    out.set(a.id, {
      code: c?.state ?? "unreviewed", logical: l?.state ?? "unreviewed",
      codeActor: c?.state === "reviewed" ? c.actor : null, logicalActor: l?.state === "reviewed" ? l.actor : null,
      codeVia: c?.state === "reviewed" ? c.via : undefined, logicalVia: l?.state === "reviewed" ? l.via : undefined,
    });
  }
  return out;
}

export interface RevertedMark {
  target: { kind: "node" | "anchor"; id: string };
  level: ReviewLevel;
  anchorId: string;
  reviewer: string;
  /**
   * Which kind of mark this is. A `viewed` tick is exposure, not a vouch, and the
   * dashboard presents these as "approvals sitting on top of a revert" — so a
   * consumer that means APPROVALS has to be able to tell them apart.
   */
  attestation: Attestation | "checked";
  /** Where the body was originally approved, and the newer body it has moved back from. */
  approvedAt: { branch: string | null; commit: string | null; at: string };
  supersededBy: { branch: string | null; commit: string | null; at: string };
}

/**
 * Marks whose code has moved *back* to a body approved earlier on this same
 * history — someone undid work that had since been superseded.
 *
 * Distinct from staleness, and louder: a stale mark says the code moved on and
 * needs another look; this says the code returned to something you signed before
 * it was replaced, so the tick is technically honest and probably misleading.
 * Navigating to a branch that legitimately holds the older body is NOT this.
 */
export async function revertedMarks(root: string, opts: { ref?: string; includeViewed?: boolean } = {}): Promise<RevertedMark[]> {
  const rs = await readReviews(root);
  const all = new Set<string>();
  for (const r of rs.reviews) for (const c of acceptedOf(r)) all.add(c.anchorId);
  const live = await liveHashes(root, all, opts.ref);

  const ancestry = ancestryProbe(root, opts.ref ?? headCommit(root));

  const out: RevertedMark[] = [];
  for (const r of rs.reviews) {
    // A bulk import writes thousands of `viewed` rows (reviewer "github-import")
    // that are explicitly NOT vouches. Every one of them could raise a revert alarm
    // the dashboard renders as an approval, and the same target appeared twice —
    // once viewed, once signed — with nothing to tell them apart. `reviewStatesFor`
    // already excludes viewed rows from the vouch state; this now says which it is,
    // and skips them by default.
    const attestation = effectiveAttestation(r);
    if (!opts.includeViewed && attestation === "viewed") continue;
    for (const c of acceptedOf(r)) {
      const a = resolveAcceptance(c.entries, live.get(c.anchorId), ancestry);
      if (a.via !== "reverted" || !a.entry || !a.supersededBy) continue;
      out.push({
        target: r.target, level: r.level, anchorId: c.anchorId, reviewer: r.reviewer, attestation,
        approvedAt: { branch: a.entry.branch, commit: a.entry.commit, at: a.entry.at },
        supersededBy: { branch: a.supersededBy.branch, commit: a.supersededBy.commit, at: a.supersededBy.at },
      });
    }
  }
  return out;
}

/**
 * Mark many ANCHOR targets at once, sharing one read/write of the review store.
 *
 * `markReviewed` re-reads and rewrites the whole store per call — fine for a
 * button, quadratic when importing a 500-file pull request's viewed state. The
 * acceptance bookkeeping is identical; only the I/O is hoisted.
 */
export async function markReviewedBatch(
  root: string,
  anchorIds: string[],
  input: {
    level: ReviewLevel; reviewer?: string; actor?: "human" | "agent"; attestation?: Attestation; ref?: string;
    /**
     * Stamp these as cover rows for the container named here (see `Review.coveredBy`).
     * An id that already carries a mark made about IT — rather than one written by
     * some other container — is skipped: a cover never overwrites a direct act, or
     * withdrawing the container would take a sign-off the reviewer made themselves.
     */
    coveredBy?: string;
    /**
     * Hashes supplied by the caller, skipping the snapshot lookup entirely. A bulk
     * historical import parses only the files a PR touched; caching a full-tree
     * snapshot per side just to look those up would cost gigabytes across a year
     * of pull requests.
     */
    hashes?: Map<string, string>;
  },
): Promise<{ marked: number }> {
  if (!anchorIds.length) return { marked: 0 };
  const live = input.hashes ?? await liveHashes(root, anchorIds, input.ref);
  const actor = input.actor ?? "agent";
  // The existing human/agent binary decides WHETHER this was an agent; `resolveActor`
  // supplies WHO it was on behalf of. The two are not redundant — the binary is the
  // caller's assertion about the act, the principal is the machine's about the person.
  const by = resolveActor(root, { agent: actor === "agent" });
  const attestation: Attestation | undefined = input.attestation ?? (actor === "human" ? "signed" : undefined);
  const viewed = attestation === "viewed";

  const rs = await readReviews(root);
  const { commit, branch } = markedAt(root, input.ref);
  const stamp = new Date().toISOString();

  // A repeated id would mint two independent rows for one (target, level,
  // attestation), and every reader — `reviewStatesFor`, `forLevel`, `changedSince`
  // — uses `.find` and assumes there is one.
  anchorIds = [...new Set(anchorIds)];
  const wanted = new Set(anchorIds);
  const priorFor = new Map<string, Review>();
  for (const r of rs.reviews) {
    if (r.target.kind === "anchor" && wanted.has(r.target.id) && r.level === input.level && isViewedRow(r) === viewed) {
      priorFor.set(r.target.id, r);
    }
  }

  // A cover may replace another cover (the inner container is the more specific
  // claim) but never a mark made about the symbol itself.
  if (input.coveredBy) anchorIds = anchorIds.filter((id) => priorFor.get(id)?.coveredBy !== undefined || !priorFor.has(id));

  const fresh: Review[] = anchorIds.map((id) => {
    const prior = priorFor.get(id);
    const entries = prior ? (acceptedOf(prior).find((c) => c.anchorId === id)?.entries ?? []) : [];
    const hash = live.get(id);
    return {
      id: "rev_" + randomBytes(6).toString("hex"),
      target: { kind: "anchor" as const, id },
      level: input.level,
      reviewer: input.reviewer || (by ? actorLabel(by) : "me"),
    ...(by ? { by } : {}),
      actor,
      attestation,
      coveredBy: input.coveredBy,
      at: stamp,
      reviewedCommit: commit,
      witnesses: [{ anchorId: id, bodyHash: hash ?? "sha256:absent" }],
      accepted: [{
        anchorId: id,
        entries: hash ? recordAcceptance(entries, { bodyHash: hash, commit, branch, at: stamp }, ACCEPTED_CAP) : entries,
      }],
    };
  });

  const replaced = new Set(fresh.map((r) => r.target.id));
  rs.reviews = rs.reviews.filter(
    (r) => !(r.target.kind === "anchor" && replaced.has(r.target.id) && r.level === input.level && isViewedRow(r) === viewed),
  ).concat(fresh);
  await writeReviews(root, rs.reviews);
  return { marked: fresh.length };
}
