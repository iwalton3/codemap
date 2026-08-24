import { type Annotation } from "../schema.js";
import { originSlug } from "../git.js";
import { readAnchorStore, loadNodes, readAnnotations, findAnchorsOutsideWork, readWalkthroughs, writeWalkthrough, readOrphans } from "../store.js";
import { prTriage, listOpenPrs, prPacket, prStory, prAnchorCode, prPromotionPlan, derivePrTriage, prContainment, offStoryReason, type OffStoryReason } from "../pr.js";
import { promotionOwns } from "../pr-promote.js";
import { validateWalkthrough, buildWalkthrough, walkCoverage, staleChapters, type WalkInput } from "../walkthrough.js";
import { LANE_POLICY } from "../lanes.js";
import { parseAgentLines, ingestAgentReview } from "../pr-ingest.js";
import { planPrPush, executePrPush, pullViewedFromGitHub, fetchReviewThreads, planResolveSync, pushResolvedToGitHub, pullResolvedFromGitHub, ghViewer, type PushPlan, type ReviewEvent, type ResolveSyncPlan } from "../pr-push.js";
import { bulkPullViewed } from "../pr-bulk.js";
import { markReviewedBatch, unmarkReviewed, unmarkCovered, type Attestation } from "../reviews.js";
import { snapshotHashes, loadNodesShared} from "./shared.js";
import { annotate, resolveAnnotation, reviewQueue } from "./annotations.js";
import { document } from "./docs.js";
import { anchorMark } from "./triage.js";

/**
 * Triage a pull request: resolve its merge-base, snapshot both sides without a
 * checkout, and return the lane breakdown plus a ranked worklist.
 */
export async function pr(root: string, input: string, opts: { fetch?: boolean } = {}) {
  return prTriage(root, input, opts);
}

/** The agent's work packet for a PR: ranked items with before/after source, plus the specs it ships. */
export async function prPacketFor(root: string, input: string, opts: { limit?: number; offset?: number; fetch?: boolean } = {}) {
  return prPacket(root, input, opts);
}

/**
 * Fold a first-pass agent review (JSONL) into the map as durable annotations and
 * `likely` triage proposals. Findings are written against the PR head, so they
 * can land on symbols that exist only on the branch.
 */
export async function prIngest(root: string, input: string, texts: string[], opts: { author?: string; dryRun?: boolean } = {}) {
  const t = await prTriage(root, input, { fetch: false });
  if ("error" in t) return { error: t.error };
  const lines = [], bad = [];
  for (const text of texts) {
    const p = parseAgentLines(text);
    lines.push(...p.lines); bad.push(...p.bad);
  }
  const existing = (await readAnnotations(root)).annotations.map((a) => ({ targetId: a.target.id, line: a.line, kind: a.kind, text: a.text, author: a.author }));
  const r = await ingestAgentReview(root, lines, { annotate, existing }, { headRef: t.refs.head, author: opts.author, dryRun: opts.dryRun });
  return { ...r, malformed: bad, pr: t.pr.number, head: t.refs.head };
}

/**
 * Store an agent's walkthrough of a pull request.
 *
 * Validated before anything lands: a chapter may not cite code the PR does not
 * touch, no symbol may be claimed by two chapters, and a chapter with no symbol in
 * it is not a chapter. Those are what make the walkthrough trustworthy enough to
 * review FROM rather than alongside — and what makes the coverage number mean
 * something, since anything left uncovered is what the reviewer ends up reading on
 * GitHub instead.
 */
export async function prWalkthroughSet(
  root: string, input: string,
  features: WalkInput[],
  opts: { by?: string; dryRun?: boolean } = {},
) {
  const t = await prTriage(root, input, { fetch: false });
  if ("error" in t) return { error: t.error };

  const queue = new Set(t.worklist.filter((w) => LANE_POLICY[w.lane].review === "queue").map((w) => w.id));
  const inPr = new Set(t.worklist.map((w) => w.id));
  const v = validateWalkthrough(features, inPr);
  if (!v.ok) {
    return {
      error: "the walkthrough does not describe this pull request",
      notInPr: v.notInPr,
      claimedTwice: v.claimedTwice,
      emptyChapters: v.emptyChapters,
    };
  }

  // Witness against the PR HEAD's bodies, not the working tree's — a walkthrough is
  // a claim about the branch, and the working tree is usually on another one.
  const live = await snapshotHashes(root, t.refs.head);
  const built = buildWalkthrough(
    { pr: t.pr.number, head: t.refs.head, by: opts.by || "agent", at: new Date().toISOString(), features },
    (id) => live.get(id),
  );
  const coverage = walkCoverage(features, queue, t.worklist.length - queue.size);
  if (!opts.dryRun) await writeWalkthrough(root, String(t.pr.number), built);
  return {
    ok: true, pr: t.pr.number, head: t.refs.head,
    features: built.features.length,
    chapters: built.features.reduce((n, f) => n + f.chapters.length, 0),
    coverage,
    dryRun: !!opts.dryRun,
  };
}

/** The stored walkthrough for a PR, with the chapters whose code has since moved. */
export async function prWalkthroughGet(root: string, input: string) {
  const t = await prTriage(root, input, { fetch: false });
  if ("error" in t) return { error: t.error };
  const w = (await readWalkthroughs(root)).walkthroughs[String(t.pr.number)];
  if (!w) return { pr: t.pr.number, walkthrough: null };
  const live = await snapshotHashes(root, t.refs.head);
  return {
    pr: t.pr.number,
    walkthrough: w,
    /** Written against another commit entirely — every chapter is suspect. */
    headMoved: w.head !== t.refs.head,
    stale: staleChapters(w, live),
  };
}

/**
 * The PR page's data: the ranked symbols and spec-derived grouping as before, plus
 * the agent-written walkthrough when one exists.
 *
 * The walkthrough supplies STRUCTURE and the story supplies the STEPS, so every
 * symbol keeps its diff, review state and findings whichever way it is grouped —
 * and a PR nobody has walked yet still renders exactly as it did.
 */
export async function prStoryFor(root: string, input: string, opts: { fetch?: boolean } = {}) {
  const story = await prStory(root, input, opts);
  if ("error" in story) return story;

  const stored = (await readWalkthroughs(root)).walkthroughs[String(story.pr.number)];
  if (!stored) return { ...story, walkthrough: null };

  const live = await snapshotHashes(root, story.refs.head);
  const queue = new Set(story.chapters.flatMap((c) => c.steps).map((s) => s.anchorId));
  return {
    ...story,
    walkthrough: {
      ...stored,
      headMoved: stored.head !== story.refs.head,
      stale: staleChapters(stored, live),
      coverage: walkCoverage(stored.features, queue, story.totals.steps - queue.size),
    },
  };
}

/**
 * The findings a pull request owns that sit on none of its symbols — already posted
 * to it, aimed at a file it changes, or on the symbol it just renamed away.
 *
 * `offStoryReason` is the rule, and why it is a rule is in the comment there.
 *
 * `stranded` is the residue, counted so it does not go quiet: findings whose target
 * this build cannot place, which nobody has posted anywhere and nobody has settled.
 * It is NOT "everything the rule excluded" — a finding posted to another pull
 * request is that one's, and a resolved one is nobody's. `orphanedWork` answers them.
 */
export async function prOffStoryFindings(root: string, input: string, opts: { fetch?: boolean } = {}) {
  const t = await prTriage(root, input, { fetch: opts.fetch });
  if ("error" in t) return { error: t.error };

  // What the walkthrough can show — its steps are the code lane, so a finding on
  // anything else this pull request touches is off-story by construction.
  const onStory = new Set(t.worklist.filter((w) => w.lane === "code").map((w) => w.id));
  const changed = new Set(t.files.map((f) => f.path));
  const anns = (await readAnnotations(root)).annotations
    .filter((a) => a.kind === "finding" || a.kind === "question")
    .filter((a) => !(a.target.kind === "anchor" && onStory.has(a.target.id)));

  // Raw id membership, and it is the right test here: the question is whether the
  // id can be PLACED on this diff, not whether the code still exists — which is
  // `resolveAnchor`'s question and does not change the answer to this one.
  const live = new Set((await readAnchorStore(root)).anchors.map((a) => a.id));
  const unplaceable = (a: Annotation) => a.target.kind === "anchor" && !live.has(a.target.id);
  const gone = [...new Set(anns.filter(unplaceable).map((a) => a.target.id))];
  const offTree = findAnchorsOutsideWork(root, gone);
  const kept = readOrphans(root, gone);
  const lastFile = (id: string) => offTree.get(id)?.anchor.file ?? kept.get(id)?.file;

  const why = new Map<string, OffStoryReason>();
  let stranded = 0;
  for (const a of anns) {
    const missing = unplaceable(a);
    const r = offStoryReason(a, {
      pr: t.pr.number, head: t.refs.head, changed,
      unplaceable: missing, file: missing ? lastFile(a.target.id) : undefined,
    });
    if (r) why.set(a.id, r);
    else if (missing && !a.postedRef && !a.resolved && !a.withdrawn) stranded++;
  }

  // Full form, not brief: these rows are the ONLY ones that know their own file and
  // symbol, because there is no step beside them to read it off — and `text` itself
  // is `textPreview` under brief.
  const q = await reviewQueue(root, { assignedOnly: false, includeResolved: true, brief: false, ids: [...why.keys()] });
  return {
    pr: t.pr.number,
    stranded,
    findings: q.queue.map((f) => ({ ...f, why: why.get(f.id)! })),
  };
}

/**
 * Sign (or view) one symbol on the walkthrough, and with it every symbol this pull
 * request touches INSIDE it.
 *
 * A pull request that adds a class puts the class and each of its methods on the
 * worklist separately, and the class's pane is the whole class: the reviewer who
 * signed it has already read every member, and being asked to sign each one again
 * is asking them to read the same lines twice. The cover writes the ordinary
 * per-member marks underneath — each witnessing its OWN hash — so a later edit to
 * one method stales that method alone, and nothing about staleness changes.
 *
 * Deliberately a PR route rather than a flag on `/api/review`: the cover is bounded
 * by what this pull request touches, which only a PR context can answer.
 */
export async function prStepMark(
  root: string, input: string, id: string,
  opts: { attestation: Attestation; unmark?: boolean; reviewer?: string },
) {
  const c = await prContainment(root, input, [id]);
  if ("error" in c) return { error: c.error };
  const inside = c.contained.get(id) ?? [];

  let cleared: string[] = [];
  if (opts.unmark) {
    await unmarkReviewed(root, { targetKind: "anchor", targetId: id, level: "code", attestation: opts.attestation });
    cleared = (await unmarkCovered(root, id, { level: "code", attestation: opts.attestation })).removed;
  } else {
    const mark = { level: "code" as const, actor: "human" as const, attestation: opts.attestation, reviewer: opts.reviewer, ref: c.head };
    await markReviewedBatch(root, [id], mark);
    await markReviewedBatch(root, inside, { ...mark, coveredBy: id });
  }
  // Every symbol whose state may have moved — the one clicked, what it covers, and
  // (on a withdrawal) whatever the cover had written, in case the two disagree.
  const affected = [id, ...new Set([...inside, ...cleared])];
  const marks: Record<string, unknown> = {};
  for (const a of affected) marks[a] = await anchorMark(root, a, { ref: c.head });
  return { ok: true, anchor: id, covered: inside.length, marks };
}

/**
 * Apply one mark to every symbol in a chapter — the shortcut that turns 541
 * decisions into 20.
 *
 * Deliberately a shortcut and not a new granularity: this writes the ordinary
 * per-anchor marks, witnessed per anchor, so staleness, acceptance and per-symbol
 * sign-off all keep working exactly as they did. A reviewer who wants to sign three
 * symbols and leave the rest still can.
 */
export async function prChapterMark(
  root: string, input: string,
  chapterId: string,
  opts: { attestation: Attestation; unmark?: boolean; reviewer?: string },
) {
  const t = await prTriage(root, input, { fetch: false });
  if ("error" in t) return { error: t.error };
  const stored = (await readWalkthroughs(root)).walkthroughs[String(t.pr.number)];
  if (!stored) return { error: `PR #${t.pr.number} has no walkthrough` };
  const chapter = stored.features.flatMap((f) => f.chapters).find((c) => c.id === chapterId);
  if (!chapter) return { error: `no chapter "${chapterId}" in that walkthrough` };

  const ids = chapter.blocks.filter((b) => b.kind === "symbol").map((b) => (b as { anchorId: string }).anchorId);
  if (!ids.length) return { error: "that chapter walks no symbols" };

  // A chapter's symbols carry the same cover as a single one: members of a class
  // the chapter walks are often chapters away, so signing per chapter alone leaves
  // the reviewer chasing the same code across the walkthrough.
  const c = await prContainment(root, input, ids);
  if ("error" in c) return { error: c.error };

  const cleared: string[] = [];
  if (opts.unmark) {
    for (const id of ids) {
      await unmarkReviewed(root, { targetKind: "anchor", targetId: id, level: "code", attestation: opts.attestation });
      cleared.push(...(await unmarkCovered(root, id, { level: "code", attestation: opts.attestation })).removed);
    }
  } else {
    const mark = { level: "code" as const, actor: "human" as const, attestation: opts.attestation, reviewer: opts.reviewer, ref: t.refs.head };
    // The chapter's own symbols first: a member that is itself a step here is signed
    // in its own right, and a cover must not displace that.
    await markReviewedBatch(root, ids, mark);
    for (const id of ids) await markReviewedBatch(root, c.contained.get(id) ?? [], { ...mark, coveredBy: id });
  }
  // The resulting marks, so the page updates in place rather than re-deriving the
  // whole pull request to learn what its own click did.
  const affected = [...new Set([...ids, ...[...c.contained.values()].flat(), ...cleared])];
  const marks: Record<string, unknown> = {};
  for (const id of affected) marks[id] = await anchorMark(root, id, { ref: t.refs.head });
  return { ok: true, chapter: chapterId, anchors: ids.length, covered: affected.length - ids.length, marks };
}

/**
 * Derive stakes + complexity for the symbols a PR touches. The graph-wide
 * derivation cannot see symbols the branch adds, so without this a feature PR
 * ranks as an undifferentiated wall of `untriaged`.
 */
export async function prTriageDerive(root: string, input: string) {
  return derivePrTriage(root, input);
}

/** What promoting a walkthrough chapter into the map would write. */
/**
 * A node the promotion would land on. `ours` means this same spec section wrote
 * it, so promoting again updates it — the intended re-promote. Anything else is a
 * different chapter, or somebody's hand-written node, and `prPromote` refuses.
 */
async function nodeAtPromotionId(root: string, id: string, promotedFrom: string | undefined) {
  const node = (await loadNodesShared(root)).find((n) => n.id === id);
  if (!node) return undefined;
  return { id: node.id, title: node.title, type: node.type, ours: promotionOwns(node, promotedFrom) };
}

export async function prPromotePlan(root: string, input: string, chapterId: string) {
  const plan = await prPromotionPlan(root, input, chapterId);
  if ("error" in plan) return plan;
  // Surfaced with the plan so a collision is something the human sees *before*
  // confirming, rather than an error after they have committed to the idea.
  return { ...plan, existing: await nodeAtPromotionId(root, plan.promotion.id, plan.promotion.promotedFrom) };
}

/**
 * Promote a chapter into a real node (a flow when it spans layers). Documenting
 * against the PR head, so the doc describes the code as that branch leaves it and
 * its citations are accepted at those hashes.
 */
export async function prPromote(root: string, input: string, chapterId: string, over: { id?: string; title?: string; summary?: string; type?: "process" | "module" } = {}) {
  const plan = await prPromotionPlan(root, input, chapterId);
  if ("error" in plan) return plan;
  const p = plan.promotion;
  // `document()` upserts, and a node's body, citations and accepted hashes are not
  // recoverable once rewritten. A promotion may land only on a node this same spec
  // section wrote; anything else is refused rather than merged, including when the
  // caller names the id itself — an id typed into the form is not evidence that
  // the human knew what was already sitting there.
  const at = await nodeAtPromotionId(root, over.id ?? p.id, p.promotedFrom);
  if (at && !at.ours) {
    return { error: `node "${at.id}" ("${at.title}") already exists and was not promoted from this section — promoting would rewrite it. Choose an unused id to promote alongside it, or edit that node directly.` };
  }
  const type = over.type ?? p.type;
  const r = await document(root, {
    id: over.id ?? p.id,
    type,
    title: over.title ?? p.title,
    summary: over.summary ?? p.summary,
    body: p.body,
    anchors: p.anchors,
    steps: type === "process" ? p.steps : undefined,
    ref: plan.ref,
  });
  return { ...r, promoted: over.id ?? p.id, shape: type, rationale: p.rationale };
}

/**
 * Import GitHub's per-file viewed ticks as codemap `viewed` marks — never
 * `signed`. Useful as a baseline on older pull requests, where the ticks are the
 * only surviving record that anyone looked.
 */
export async function prPullViewed(root: string, input: string, opts: { dryRun?: boolean; reviewer?: string } = {}) {
  return pullViewedFromGitHub(root, input, { triage: prTriage, markBatch: markReviewedBatch }, opts);
}

/**
 * Import viewed ticks across a repo's whole back catalogue. Snapshot-free and
 * resumable: a year of pull requests is worth importing, but not at ~2MB of
 * cached snapshot per side per PR.
 */
export async function prPullViewedAll(root: string, opts: { force?: boolean; limit?: number; maxPrs?: number; dryRun?: boolean; onProgress?: (m: string) => void } = {}) {
  const slug = originSlug(root);
  if (!slug) return { error: "this universe has no github origin remote" };
  return bulkPullViewed(root, `${slug.owner}/${slug.repo}`, opts);
}

/** What a push to GitHub would contain — inspect before anything leaves the machine. */
export async function prPushPlan(
  root: string, input: string,
  filter: {
    electedOnly?: boolean; minSeverity?: "low" | "medium" | "high" | "critical";
    ids?: string[]; summary?: string; event?: ReviewEvent;
  } = {},
) {
  return planPrPush(root, input, filter);
}

/**
 * Compare what codemap considers settled against the pull request's own threads.
 *
 * Read-only and inspectable, like the push plan: both directions are shown before
 * either is acted on.
 */
export async function prResolvePlan(root: string, input: string) {
  const t = await prTriage(root, input, { fetch: false });
  if ("error" in t) return { error: t.error };
  const threads = fetchReviewThreads(`${t.pr.owner}/${t.pr.repo}`, t.pr.number);
  if ("error" in threads) return threads;
  const anns = (await readAnnotations(root)).annotations;
  return { ...planResolveSync(anns, threads, t.pr.number), slug: `${t.pr.owner}/${t.pr.repo}`, url: t.pr.url };
}

/** Close settled conversations on the pull request. Outward-facing; never implicit. */
export async function prResolvePush(root: string, plan: ResolveSyncPlan & { slug: string }) {
  return pushResolvedToGitHub(root, plan, plan.slug);
}

/** Take GitHub's resolutions into the map. See `pullResolvedFromGitHub` for the asymmetry. */
export async function prResolvePull(
  root: string, plan: ResolveSyncPlan, opts: { anyone?: boolean; dryRun?: boolean } = {},
) {
  return pullResolvedFromGitHub(root, plan, { resolveAnnotation: (r, id, v) => resolveAnnotation(r, id, v) }, {
    viewer: ghViewer(), anyone: opts.anyone, dryRun: opts.dryRun,
  });
}

/**
 * Publish a plan that was already inspected — the ONLY way to publish.
 *
 * There is deliberately no `prPush(root, input)` that plans and posts in one call:
 * it re-derived the plan after the operator had approved the printed one, so what
 * went to the PR was never provably what they read (annotations and review marks
 * can move in between, and the PR head can advance). Comments on someone else's
 * pull request notify people and are not meaningfully undoable.
 */
export async function prPushExecute(root: string, plan: PushPlan, opts: { markViewed?: boolean; comments?: boolean } = {}) {
  return { plan, result: await executePrPush(root, plan, opts) };
}

/** One anchor's source as the PR leaves it — the walkthrough's code pane. */
export async function prCode(root: string, input: string, id: string) {
  return prAnchorCode(root, input, id);
}

/** Open PRs for the universe's own origin remote — the inbox, without having to know the slug. */
export function prsFor(root: string) {
  const slug = originSlug(root);
  if (!slug) return { error: "this universe has no github origin remote" };
  return listOpenPrs(`${slug.owner}/${slug.repo}`);
}

/** Open PRs for a repo slug (`owner/repo`) — the inbox. */
export function prs(repoSlug: string) {
  return listOpenPrs(repoSlug);
}

