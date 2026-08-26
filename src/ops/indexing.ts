import { type Anchor, type State, SCHEMA_VERSION } from "../schema.js";
import { indexRepo, indexCommit } from "../repo.js";
import { collidingAnchors } from "../indexer.js";
import { headCommit, currentBranch, isDirty, revParse, submoduleDrift } from "../git.js";
import { computeStaleness } from "../stale.js";
import { readAnchorStore, readState, writeState, writeStore, loadNodes, readBugs, writeLocalBugs, readAnnotations, writeAnnotations, readReviews, writeSnapshot, readSnapshot, listSnapshots, writeReviews, remapNodeCitations, readLocalTriage as triageRead, replaceLocalTriage as triageWrite, staleSchemeSnapshots, liveDerivationDrift, retainOrphans, releaseRecoveredOrphans, referencedAnchorIds } from "../store.js";
import { GRAMMAR_VERSIONS } from "../grammar-versions.js";
import { remapOverloadIds, applyRemap } from "../migrate-overloads.js";
import { refreshAnalyzers } from "../analyzers/run.js";
import { applyIndexUpdate } from "../sync.js";
import { anchorBrief, loadNodesShared} from "./shared.js";

/**
 * Full re-baseline: re-index the whole repo at the current HEAD and replace the
 * live (`@work`) anchor set, advancing the baseline commit + branch. Non-
 * destructive to the map — nodes, edges, reviews, coverage, bugs, and
 * annotations are separate stores and are untouched; only anchors + state move.
 * Also caches the commit as a diff snapshot. This is `init` re-run on demand.
 */
export async function reindex(root: string) {
  // Read BEFORE the scan: a worktree scan indexes what is on disk, so a submodule
  // sitting on a commit the parent does not pin puts anchors into `@work` — and
  // into the snapshot written for HEAD below — that this commit does not ship.
  // Reported rather than refused: `reindex` also runs automatically on a branch
  // change, and wedging that is worse than a loud warning.
  const submodules = submoduleDrift(root);
  const anchors = await indexRepo(root);
  const commit = headCommit(root);
  const branch = currentBranch(root);
  for (const a of anchors) a.lastVerifiedCommit = commit;

  // An overload's anchor id used to encode its ORDINAL rather than its signature.
  // Re-indexing mints the new ids, which would leave every review, triage mark,
  // annotation and citation on an overloaded callable pointing at an id that no
  // longer exists. Carry them across BEFORE the store is overwritten — the old rows
  // are the only record of what the old ids meant.
  const remapped = await migrateOverloads(root, anchors);

  // Anything somebody's work still points at, that this index no longer produces,
  // is kept before the store is overwritten. Reindex replaces `@work` wholesale, so
  // without this an annotation's target is simply deleted — which has already
  // destroyed a batch of findings once, and needs no PR or branch mismatch to
  // happen: a rename, a checkout, or a signature change on an overload is enough.
  const retained = await retainReferencedAnchors(root, anchors);

  const state: State = { schemaVersion: SCHEMA_VERSION, lastVerifiedCommit: commit, branch, grammarVersions: GRAMMAR_VERSIONS };
  await writeStore(root, anchors, state);
  // After the write, because it reads the new index: anything retained earlier that
  // this index produces again is live code, not a ghost.
  const recovered = releaseRecoveredOrphans(root);
  // `isDirty` here, and NOT on `snapshotAt` below: this indexes the working TREE, so
  // on a dirty checkout the row is the branch's uncommitted work wearing the commit's
  // name. `snapshotAt` reads git objects and is truthful by construction.
  const dirty = isDirty(root);
  if (commit) await writeSnapshot(root, commit, branch, anchors, new Date().toISOString(), { dirty });
  const files = new Set(anchors.map((a) => a.file)).size;
  // Two symbols on one id. The store is keyed `(ref, id)` and written
  // `INSERT OR REPLACE`, so the loser has just silently ceased to exist for the
  // whole map — reported rather than refused, because wedging an index over a
  // pattern measured at 0 in 18,761 anchors is worse than the loss it names. See
  // `collidingAnchors`.
  const collisions = collidingAnchors(anchors);
  return {
    ok: true, anchors: anchors.length, files, commit, branch,
    // Reported, not just recorded. A snapshot taken from a dirty tree is labelled
    // with the bare sha and is not that commit, and until this was surfaced nothing
    // above the store could say so — `isDirty` existed and had exactly one caller.
    ...(commit && dirty ? { dirtySnapshot: true } : {}),
    ...(collisions.size ? {
      idCollisions: [...collisions].map(([id, list]) => ({
        id, file: list[0]!.file, symbols: list.map((a) => a.symbolPath.join(" › ")),
      })),
    } : {}),
    ...(submodules.drift.length ? { submodules: submodules.drift } : {}),
    ...(submodules.error ? { submoduleError: submodules.error } : {}),
    ...(remapped ? { remapped } : {}),
    ...(retained || recovered ? { orphans: { retained, recovered } } : {}),
  };
}

/**
 * Retain the referenced anchors this index is about to drop. Must run BEFORE the
 * store is overwritten — the old rows are the only record of what those ids meant.
 *
 * The other half, releasing anchors this index brings back, is
 * `releaseRecoveredOrphans` and runs after the write.
 */
async function retainReferencedAnchors(root: string, fresh: Anchor[]): Promise<number> {
  let stored: Anchor[];
  try { stored = (await readAnchorStore(root)).anchors; } catch { return 0; }   // first run
  const referenced = await referencedAnchorIds(root);
  if (!referenced.size) return 0;

  const freshIds = new Set(fresh.map((a) => a.id));
  return retainOrphans(root, stored.filter((a) => referenced.has(a.id) && !freshIds.has(a.id)));
}

/** See migrate-overloads.ts. Returns null when there is nothing from the old scheme. */
async function migrateOverloads(root: string, fresh: Anchor[]) {
  let stored: Anchor[];
  try { stored = (await readAnchorStore(root)).anchors; } catch { return null; }   // first run
  const map = remapOverloadIds(stored, fresh);

  // Cached commit snapshots hold the OLD ids, and a diff is a set operation over ids
  // between two of them, so a snapshot from one derivation cannot be compared with
  // one from another. Counted here for the reindex report; the snapshots themselves
  // are rebuilt LAZILY by `ensureSnapshot` when something reads them, which is both
  // cheaper and self-healing — the previous eager sweep sniffed for numeric
  // disambiguators and so caught only the one scheme change it was written for.
  const droppedSnapshots = staleSchemeSnapshots(root).length;
  if (!map.size) return droppedSnapshots ? { anchors: 0, reviews: 0, triage: 0, annotations: 0, citations: 0, bugs: 0, droppedSnapshots } : null;

  // LOCAL triage, deliberately. Remapping an id is this build re-deriving its OWN index;
  // a teammate's mark names ids in THEIR claim, published from their machine, and
  // rewriting those here would silently edit somebody else's record of what they marked.
  // They remap on their own machine and republish; `whereWas` says where an id went.
  const [reviewStore, triageStore, annStore, bugStore] = await Promise.all([
    readReviews(root), triageRead(root), readAnnotations(root), readBugs(root),
  ]);
  // Local bugs only, for the reason the comment above gives about triage: a teammate's
  // bug names ids in THEIR claim, and the fold would overwrite anything written here.
  const localBugs = bugStore.bugs.filter((b) => !b.origin);
  const counts = applyRemap(map, {
    reviews: reviewStore.reviews, triage: triageStore.triage, annotations: annStore.annotations,
    bugs: localBugs, citations: [],
  });
  counts.citations = remapNodeCitations(root, map);
  await Promise.all([
    writeReviews(root, reviewStore.reviews),
    triageWrite(root, triageStore.triage),
    writeAnnotations(root, annStore.annotations),
    writeLocalBugs(root, localBugs),
  ]);
  return { ...counts, droppedSnapshots };
}

/**
 * First-run entry point: build the anchor index for a repo that has no map yet.
 * Mechanically the same full re-baseline as `reindex` — the difference is what
 * the caller is told. Every read op throws "not initialized" until this runs, and
 * an agent that hits that error should call this rather than start reading the
 * codebase by hand, so the result reports whether it created the map or
 * re-baselined an existing one, and what to do next.
 */
export async function init(root: string) {
  let existing = false;
  try {
    await readState(root);
    existing = true;
  } catch {
    /* no map here yet — the normal first-run path */
  }
  const r = await reindex(root);
  return {
    ...r,
    created: !existing,
    note: existing
      ? "already initialized — re-baselined at HEAD; docs, edges, reviews, coverage and bugs are untouched"
      : "initialized — the anchor index is built; the map itself (docs/edges/bugs) starts empty",
    next: existing ? "check_stale to see what drifted" : "outline to orient, find_gaps for the work queue",
  };
}

/**
 * Is the anchor index baselined on the code that is checked out right now?
 *
 * READ-ONLY and cheap — `git symbolic-ref`, `git rev-parse`, and one state row.
 * That is the whole point: a reviewer switching between pull requests changes the
 * meaning of every doc verdict, review witness and finding placement on the page,
 * because all of them resolve against `@work`. The machinery to notice has existed
 * since `maybeReindexOnBranchChange`, but it lives inside `checkStale`, which
 * re-indexes and writes — so nothing that merely RENDERS could afford to ask.
 * This can, which is what lets a surface say "this is baselined on another branch"
 * instead of quietly answering from it.
 *
 * A moved COMMIT is reported and is deliberately not `moved`. Committing on the
 * branch you are reviewing is the normal state of working, and a banner that is
 * always on is a banner nobody reads; a branch switch is the discontinuity that
 * makes the whole page describe different code. Same rule `maybeReindexOnBranchChange`
 * already applies, so the offer a surface makes matches what the act would do.
 */
export async function indexFreshness(root: string): Promise<{
  branch: string | null; baselinedOn: string | null; moved: boolean;
  head: string | null; baselinedAt: string | null; commitMoved: boolean;
  initialized: boolean;
}> {
  let state: State | null = null;
  try { state = await readState(root); } catch { /* not initialized */ }
  const branch = currentBranch(root);
  const head = headCommit(root);
  const baselinedOn = state?.branch ?? null;
  const baselinedAt = state?.lastVerifiedCommit ?? null;
  return {
    branch, baselinedOn, head, baselinedAt,
    initialized: !!state,
    // Null on either side is "nothing to compare" — a detached HEAD, a gitless
    // universe, or an index from before the field existed. Never `moved`: the
    // fallback has to be silence, or every such universe grows a permanent banner
    // it can do nothing about.
    moved: !!state && !!branch && !!baselinedOn && branch !== baselinedOn,
    commitMoved: !!state && !!head && !!baselinedAt && head !== baselinedAt,
  };
}

/**
 * If the checked-out branch differs from the one the index was baselined on,
 * re-init to the new branch's HEAD and return a note. First-ever call just
 * records the current branch (older indexes predate the field) without the
 * expensive re-index. Returns null when nothing was done. Caller must hold the
 * write lock (this can write).
 */
async function maybeReindexOnBranchChange(root: string) {
  let state: State;
  try {
    state = await readState(root);
  } catch {
    return null; // not initialized
  }
  const cur = currentBranch(root);
  if (cur == null) return null; // detached / no git — nothing to track
  if (state.branch === undefined || state.branch === null) {
    await writeState(root, { ...state, branch: cur }); // start tracking, no re-index
    return null;
  }
  if (cur !== state.branch) {
    const r = await reindex(root);
    return { rebaselined: true, from: state.branch, to: cur, anchors: r.anchors, commit: r.commit };
  }
  return null;
}

/** Run the staleness pass — which docs are flagged by changed/lost code. */
export async function checkStale(root: string) {
  // A branch switch means "different code now" — re-baseline before checking.
  const rebaseline = await maybeReindexOnBranchChange(root);
  const [store, nodes] = await Promise.all([readAnchorStore(root), loadNodesShared(root)]);
  let commit: string | null = null;
  try {
    commit = (await readState(root)).lastVerifiedCommit;
  } catch {
    /* not initialized */
  }
  const r = await computeStaleness(root, store, nodes, commit);
  const byId = new Map(store.anchors.map((a) => [a.id, a]));
  const changed = r.checks.length > 0 || r.addedAnchorIds.length > 0;
  // Dangling citations: nodes citing anchors ABSENT from the current index (code
  // deleted/renamed so the anchor never made it into @work). computeStaleness
  // only inspects anchors that ARE in @work, so these otherwise stay hidden —
  // the doc looks "clean" while pointing at code that no longer exists.
  // Through the same resolution `evalVersion` uses, not raw id membership. "Points
  // at code that no longer exists" is a claim, and an id this index could not have
  // minted does not support it — reporting it here while `loadNodes` reports the
  // same doc as `unverifiable` is two surfaces disagreeing about one doc.
  const danglingDocs = nodes
    .map((n) => ({ n, missing: n.danglingAnchors ?? [] }))
    .filter((x) => x.missing.length > 0)
    .map(({ n, missing }) => ({ node: n.id, title: n.title, missingAnchors: missing }));
  // Bring the anchor store up to date (new anchors resolve; moved locs refreshed),
  // then keep any analyzer-covered graph current.
  const indexUpdate = await applyIndexUpdate(root);
  const refreshed = await refreshAnalyzers(root, { changed });
  // Said, not acted on. Reindexing is what would turn a grammar change into a
  // store-wide false-staleness event, so this reports and stops.
  const drift = liveDerivationDrift(root);
  return {
    scope: r.scope,
    ok: r.okCount,
    // Symbols present in the tree and not yet in the store. Distinct from
    // `indexUpdate.added`, which is what the update that follows actually wrote:
    // this is measured BEFORE it, and `codemap check` has always printed it.
    added: r.addedAnchorIds.length,
    stale: r.checks.map((c) => ({ ...c, anchor: byId.get(c.anchorId) ? anchorBrief(byId.get(c.anchorId)!) : undefined })),
    flaggedDocs: r.flaggedNodes.map((f) => ({
      node: f.node.id,
      title: f.node.title,
      reasons: f.reasons,
    })),
    ...(indexUpdate.added || indexUpdate.movedLoc ? { indexUpdate } : {}),
    ...(refreshed.length ? { refreshedAnalyzers: refreshed } : {}),
    ...(rebaseline ? { rebaselined: rebaseline } : {}),
    ...(danglingDocs.length ? { danglingDocs } : {}),
    ...(drift.stale ? {
      derivationDrift: {
        note: "this index was built with a different grammar or tree-sitter build than the one running now. "
          + "Symbols indexed from here on will hash differently from the ones already stored, and a FULL REINDEX "
          + "would make every existing review mark and doc citation read as stale — none of which would mean the "
          + "code changed. Nothing is broken as it stands; re-witness deliberately if you reindex.",
        tagged: drift.tagged,
        untagged: drift.untagged,
      },
    } : {}),
  };
}

/**
 * Cache the current commit's anchors as an immutable snapshot (the branch-diff
 * cache). Does a fresh full index so the snapshot reflects what's checked out.
 * Call this on a branch before switching away, so it can be diffed later without
 * a checkout. `init` snapshots automatically; this is the manual/agent trigger.
 */
export async function snapshot(root: string) {
  const commit = headCommit(root);
  if (!commit) return { error: "no git commit to snapshot (not a git repo, or no HEAD)" };
  const anchors = await indexRepo(root);
  const dirty = isDirty(root);
  await writeSnapshot(root, commit, currentBranch(root), anchors, new Date().toISOString(), { dirty });
  return { ok: true, ref: commit, branch: currentBranch(root), anchors: anchors.length, dirty };
}

/**
 * Cache a snapshot of *any* commit, indexed straight from git objects — no
 * checkout. `snapshot` can only ever capture the commit that happens to be on
 * disk, which is the wrong shape for reviewing a pull request: its base is the
 * merge-base of head and the target branch, and nobody has that checked out.
 * Already-cached shas are left alone unless `force` (snapshots are immutable).
 */
export async function snapshotAt(root: string, ref: string, opts: { force?: boolean; label?: string } = {}) {
  const sha = revParse(root, ref);
  if (!sha) return { error: `cannot resolve ref "${ref}" in this repo` };
  const existing = opts.force ? null : await readSnapshot(root, sha);
  if (existing) return { ok: true, ref: sha, cached: true, anchors: existing.length };
  const anchors = await indexCommit(root, sha);
  if (!anchors) return { error: `could not read tree for ${sha.slice(0, 12)} (fetch it first?)` };
  await writeSnapshot(root, sha, opts.label ?? (ref === sha ? null : ref), anchors, new Date().toISOString());
  return { ok: true, ref: sha, cached: false, anchors: anchors.length };
}

/** List cached commit snapshots available to diff. */
export async function snapshots(root: string) {
  return { snapshots: await listSnapshots(root) };
}

