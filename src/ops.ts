/**
 * The operations behind the MCP tools — a plain async API over a `.codemap/`
 * repo. Kept free of any protocol concern so it can be driven from tests, a
 * CLI, or the MCP server identically.
 *
 * Every operation that writes a claim (document / report_bug / annotate)
 * validates that the anchors it references actually exist — the "no floating
 * claims" invariant, enforced mechanically.
 */

import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, resolve, sep } from "node:path";
import {
  type Anchor, type LogicalNode, type LogicalNodeType, type EdgeType, type State,
  type Bug, type BugStatus, type BugSeverity, type Annotation,
  type AnchorSelector, type CoverageMark, type CoverageState, type Edge, type ReviewLevel, type Importance, type Complexity, type TriageSource,
  type Disposition, DISPOSITIONS, COMMENT_MAX,
  SCHEMA_VERSION,
} from "./schema.js";
import { indexFile, indexBlob, indexRepo, indexCommit } from "./repo.js";
import { headCommit, currentBranch, isDirty, revParse, mergeBase, originSlug, readBlobs, submoduleDrift } from "./git.js";
import { computeStaleness } from "./stale.js";
import {
  readAnchorStore, readState, writeState, writeStore, loadNodes, readGraph, writeGraph, writeNode, slug,
  readBugs, writeBugs, readAnnotations, writeAnnotations, readCoverage, writeCoverage, readReviews,
  writeSnapshot, readSnapshot, listSnapshots, deleteNode as storeDeleteNode, confirmNode, ackHole as storeAckHole, loadNodeVersions,
  writeReviews, remapNodeCitations, readTriage as triageRead, writeTriage as triageWrite, staleSchemeSnapshots, findAnchorsOutsideWork,
  liveDerivationDrift,
  readWalkthroughs, writeWalkthrough, readPushes, bodyHashAt, snapshotBranch, retainOrphans, readOrphans, releaseRecoveredOrphans, referencedAnchorIds, derivationLookup } from "./store.js";
import { GRAMMAR_VERSIONS } from "./grammar-versions.js";
import { resolveActor, requireActor, isAgentActor, actorLabel } from "./identity.js";
import { computeDiff, anchorCodeDiff, docDiff as computeDocDiff } from "./diff.js";
import { prTriage, listOpenPrs, prPacket, prStory, prAnchorCode, prPromotionPlan, derivePrTriage, prContainment, offStoryReason, type OffStoryReason } from "./pr.js";
import { promotionOwns } from "./pr-promote.js";
import { validateWalkthrough, buildWalkthrough, walkCoverage, staleChapters, type WalkInput } from "./walkthrough.js";
import { LANE_POLICY } from "./lanes.js";
import { remapOverloadIds, applyRemap } from "./migrate-overloads.js";
import { parseAgentLines, ingestAgentReview } from "./pr-ingest.js";
import {
  planPrPush, executePrPush, pullViewedFromGitHub, isAgentAuthored, publishStateOf,
  fetchReviewThreads, planResolveSync, pushResolvedToGitHub, pullResolvedFromGitHub, ghViewer,
  type PushPlan, type PublishState, type ReviewEvent, type ResolveSyncPlan,
} from "./pr-push.js";
import { bulkPullViewed } from "./pr-bulk.js";
import { resolveCoverage, selectAnchors, docPct as computeDocPct, citedPct as computeCitedPct, type CoverageResult } from "./coverage.js";
import { resolveAnchorRefs } from "./refs.js";
import { refreshAnalyzers } from "./analyzers/run.js";
import { applyIndexUpdate } from "./sync.js";
import { evalVersion } from "./doc-version.js";
import { grammarForPath } from "./grammars.js";
import { reviewStatus, reviewStatesFor, anchorReviewMap, changedSince as reviewsChangedSince, deriveCodeReview, revertedMarks, markReviewedBatch, unmarkReviewed, unmarkCovered, type Attestation, type ReviewPair, type DerivedCodeReview, witnessDrift, realDrift} from "./reviews.js";
import { setTriage as triageSet, clearTriage as triageClear, triageStatus, reviewTriageFor, deriveTriage as triageDerive, coverageFor as triageCoverageFor, rollupCoverage, tripwires as triageTripwires, triageDrift } from "./triage.js";
import { anchorIndex, legacyIndex, derivationsOf, type AnchorIndex } from "./anchor-resolve.js";
import { currentDerivations } from "./grammars.js";

const HL_LANG: Record<string, string> = { c_sharp: "csharp", python: "python", javascript: "javascript", typescript: "typescript", tsx: "typescript" };
const langFor = (file: string) => HL_LANG[grammarForPath(file) ?? ""] ?? "plaintext";

function genId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

/** Re-index the given files and return current anchors by id (source of truth for "now"). */
/**
 * The hash index behind a `liveAnchors` map.
 *
 * `currentDerivations()`, not the tags on the anchors in the map: those were minted
 * in process by THIS build, so this build's tags are what an id must have been
 * minted under to appear here — and reading them off the map instead would call a
 * genuinely deleted file's symbols undecidable, because an empty map has no tags to
 * read. See docs/anchor-id-provenance.md §6.
 */
function liveIndex(root: string, live: Map<string, Anchor>): AnchorIndex {
  return anchorIndex(
    new Map([...live].map(([id, a]) => [id, a.bodyHash])),
    currentDerivations(),
    derivationLookup(root),
  );
}

async function liveAnchors(root: string, files: Iterable<string>): Promise<Map<string, Anchor>> {
  const map = new Map<string, Anchor>();
  for (const f of new Set(files)) {
    try {
      for (const a of await indexFile(join(root, f), f)) map.set(a.id, a);
    } catch {
      /* unreadable / unparseable — treat as no anchors */
    }
  }
  return map;
}

function anchorBrief(a: Anchor) {
  return {
    id: a.id,
    file: a.file,
    symbol: a.symbolPath.join(" › "),
    kind: a.kind,
    lines: a.loc ? `${a.loc.startLine}-${a.loc.endLine}` : undefined,
  };
}

type ReviewLite = { state: string; actor?: "human" | "agent" };
export type Trust = "verified" | "checked" | "unverified" | "stale" | "generated";

/**
 * The trust ladder a codemap-aware agent should key on, from freshness (does the
 * cited code still match) × who confirmed the claim. Three tiers:
 *   verified   — fresh AND a HUMAN reviewed it → rely on it.
 *   checked    — fresh AND an AGENT read the code and confirmed the claims hold
 *                (a corroborating read, not a human blessing) → solid; spot-check
 *                if critical.
 *   unverified — fresh but nobody has confirmed it (just authored) → a hypothesis;
 *                use, but verify against live code before depending on it.
 *   stale      — code drifted or was removed → re-derive, then confirm/refork.
 *   generated  — analyzer-emitted graph; structural, not a prose claim.
 * (fresh ≠ correct: freshness only proves the code hasn't changed, not that the
 * doc read it right — hence the review dimension.)
 */
function trustOf(status: string | undefined, review?: { logical: ReviewLite; code: ReviewLite }): Trust {
  if (status === "generated") return "generated";
  if (status === "stale" || status === "dangling" || status === "removed") return "stale";
  // `unverifiable` is deliberately NOT here: it is not a claim that anything drifted.
  if (!review) return "unverified";
  const { logical: L, code: C } = review;
  if (L.state === "stale" || C.state === "stale") return "stale";
  const humanOK = (L.state === "reviewed" && L.actor === "human") || (C.state === "reviewed" && C.actor === "human");
  if (humanOK) return "verified";
  if (L.state === "reviewed" || C.state === "reviewed") return "checked"; // agent-confirmed
  return "unverified";
}

/**
 * Derived code review per node — a node reads code-reviewed only when every code
 * segment it cites is signed (see deriveCodeReview). One batched anchor query for
 * the whole set; missing anchors are excluded from the rollup (a lost anchor is a
 * `dangling` status, not an un-completable review). Used by every node-list surface
 * (catalog, matrix) so they agree with the node page. The single-flow op derives
 * inline instead, since it already fetches its anchors' reviews.
 */
async function nodeCodeReviews(
  root: string,
  nodes: { id: string; anchors: string[] }[],
  presentIds: Set<string>,
): Promise<Map<string, DerivedCodeReview>> {
  const anchorRev = await reviewStatesFor(root, [...new Set(nodes.flatMap((n) => n.anchors))].map((id) => ({ kind: "anchor" as const, id })));
  const out = new Map<string, DerivedCodeReview>();
  for (const n of nodes) {
    out.set(n.id, deriveCodeReview(n.anchors.filter((aid) => presentIds.has(aid)).map((aid) => anchorRev.get(`anchor:${aid}`)!.code)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Effective coverage state per anchor, from citation + stored rules. */
async function coverageFor(root: string): Promise<{ store: Awaited<ReturnType<typeof readAnchorStore>>; nodes: LogicalNode[]; result: CoverageResult }> {
  const [store, nodes, cov] = await Promise.all([readAnchorStore(root), loadNodes(root), readCoverage(root)]);
  const cited = new Set(nodes.flatMap((n) => n.anchors));
  return { store, nodes, result: resolveCoverage(store.anchors, cited, cov.rules) };
}

/**
 * Which of the event-sourcing views have anything behind them. The event matrix,
 * the layered pipeline and the state map all read an event graph; on a repo that
 * has none they render empty scaffolding, so the front-ends hide them instead of
 * offering dead links. Keyed on node types PRESENT, not on whether an analyzer
 * ran — a hand-authored event graph counts exactly the same.
 */
export function availableViews(nodesByType: Record<string, number>, opts: { prs?: boolean } = {}) {
  const n = (t: string) => nodesByType[t] ?? 0;
  return {
    matrix: n("event_family") > 0, // events are the matrix's rows
    pipeline: n("command") + n("handler") + n("event_family") + n("aggregate") + n("projection") > 0,
    states: n("state") + n("transition") > 0,
    // Not a node-shape question like the others: the PR views need a github remote
    // to talk to, so a repo without one hides the link rather than offering a
    // page that can only ever error.
    prs: opts.prs ?? false,
  };
}

/** Node-type tally — the input to `availableViews`, and a headline count itself. */
function tallyTypes(nodes: LogicalNode[]): Record<string, number> {
  const byType: Record<string, number> = {};
  for (const n of nodes) byType[n.type] = (byType[n.type] ?? 0) + 1;
  return byType;
}

export async function status(root: string) {
  const [{ store, nodes, result }, graph, bugStore, annStore] = await Promise.all([
    coverageFor(root), readGraph(root), readBugs(root), readAnnotations(root),
  ]);
  let baselineCommit: string | null = null;
  try {
    baselineCommit = (await readState(root)).lastVerifiedCommit;
  } catch {
    /* not initialized */
  }
  const nodesByType = tallyTypes(nodes);
  const bugsByStatus: Record<string, number> = {};
  for (const b of bugStore.bugs) bugsByStatus[b.status] = (bugsByStatus[b.status] ?? 0) + 1;
  return {
    anchors: store.anchors.length,
    coverage: result.breakdown, // open / cited / covered / trivial / deferred / owned
    docPct: computeDocPct(result.breakdown), // cited OR selector-covered
    citedPct: computeCitedPct(result.breakdown), // the stricter claim: cited by a doc
    open: result.breakdown.open, // the real work queue size
    nodes: nodes.length,
    nodesByType,
    views: availableViews(nodesByType, { prs: !!originSlug(root) }),
    edges: graph.edges.length,
    bugs: bugStore.bugs.length,
    bugsByStatus,
    annotations: annStore.annotations.length,
    baselineCommit,
  };
}

/**
 * "Needs attention" rollup for the universe landing page. Composes the cheap,
 * side-effect-free signals the whole system computes — coverage, doc-version
 * status (stored on the node, so no check_stale run here), and bug re-validation
 * — into one work-queue summary. `attention` is the count a human should clear.
 */
export async function dashboard(root: string) {
  const [{ store, nodes, result }, graph, bugStore, annStore] = await Promise.all([
    coverageFor(root), readGraph(root), readBugs(root), readAnnotations(root),
  ]);
  let commit: string | null = null;
  try { commit = (await readState(root)).lastVerifiedCommit; } catch { /* not initialized */ }

  // Doc staleness via the SAME read-only engine check_stale uses, so the banner
  // agrees with the MCP tool (applyIndexUpdate freezes @work hashes, so a stored
  // node.status wouldn't reflect an un-reindexed code change — this does).
  const stale = await computeStaleness(root, store, nodes, commit);
  // Approvals sitting on top of a revert: the code went back to a body signed
  // before it was superseded here, so the tick reads fine and probably should not.
  const reverted = await revertedMarks(root).catch(() => []);
  const anchorIds = new Set(store.anchors.map((a) => a.id));
  const danglingIds = new Set(nodes.filter((n) => n.anchors.some((a) => !anchorIds.has(a))).map((n) => n.id));
  const staleIds = new Set(stale.flaggedNodes.map((f) => f.node.id));
  const danglingDocs = danglingIds.size;
  const staleDocs = [...staleIds].filter((id) => !danglingIds.has(id)).length;

  // Bug re-validation: live re-index of bug-cited files vs each bug's witness.
  const bugFiles = new Set<string>();
  for (const b of bugStore.bugs) for (const id of b.anchors) { const a = store.anchors.find((x) => x.id === id); if (a) bugFiles.add(a.file); }
  const live = await liveAnchors(root, bugFiles);
  const bugIndex = liveIndex(root, live);
  const bugCounts: Record<string, number> = {};
  let openBugs = 0, possiblyFixed = 0, unverifiableBugs = 0;
  for (const b of bugStore.bugs) {
    bugCounts[b.status] = (bugCounts[b.status] ?? 0) + 1;
    // Through `witnessDrift` rather than an inline `sameBody`, which also fixes a
    // second conflation this line had: a witness from another HASH_SCHEME counted as
    // possibly-fixed too. `realDrift` is what separates "the code moved" from
    // "nobody can say", and this rollup is a count people act on.
    if (b.status === "open") {
      openBugs++;
      const changes = witnessDrift(b.witnesses, bugIndex);
      // Counted apart, not dropped. `realDrift` is right to keep an undecidable
      // witness out of "possibly fixed" — it is not evidence the code moved — but
      // dropping it entirely let the dashboard say everything was current with the
      // code while some of it could not be checked at all.
      if (realDrift(changes).length) possiblyFixed++;
      else if (changes.length) unverifiableBugs++;
    }
  }

  const openQuestions = annStore.annotations.filter((a) => a.kind === "question" && !a.resolved).length;

  // Fired tripwires: business-critical code someone is watching that has since moved.
  let tw: Awaited<ReturnType<typeof triageTripwires>> = { fired: [], armedCount: 0 };
  try { tw = await triageTripwires(root); } catch { /* best-effort */ }

  return {
    coverage: { docPct: computeDocPct(result.breakdown), citedPct: computeCitedPct(result.breakdown), open: result.breakdown.open, anchors: store.anchors.length, nodes: nodes.length, edges: graph.edges.length, breakdown: result.breakdown },
    views: availableViews(tallyTypes(nodes), { prs: !!originSlug(root) }), // which extra views this map can offer
    docs: { total: nodes.length, stale: staleDocs, dangling: danglingDocs, fresh: nodes.length - staleDocs - danglingDocs },
    bugs: { total: bugStore.bugs.length, open: openBugs, possiblyFixed, unverifiable: unverifiableBugs, byStatus: bugCounts },
    annotations: annStore.annotations.length,
    openQuestions,
    tripwires: { fired: tw.fired.map((f) => ({ kind: f.target.kind, id: f.target.id, importance: f.importance, reason: f.reason })), armed: tw.armedCount },
    baselineCommit: commit,
    // The single number a reviewer/agent should drive to zero.
    reverted: reverted.length,
    attention: staleDocs + danglingDocs + possiblyFixed + openQuestions + tw.fired.length + reverted.length,
  };
}

// Absolutes in a summary are universal claims (highest blast radius, least re-read);
// a qualifier in the body means the exception is documented but the headline
// over-reached — the classic "precise body, over-broad summary" drift.
const SUMMARY_ABSOLUTE = /\b(only|all|always|never|every|no|none|any|entirely|exclusively)\b/i;
const BODY_QUALIFIER = /(\bexcept\b|\bunless\b|\bbut\b|\bhowever\b|\balone\b|only when|other than|aside from|as long as|provided that)/i;

/**
 * Zero-cost summary lint (no code read): flag nodes whose SUMMARY makes an absolute
 * claim (only/all/always/never/…) while the BODY carries a qualifier (except/unless/…)
 * — a summary/body self-contradiction that's the most common documentation drift.
 * Returns REVIEW CANDIDATES to verify (like analyzer findings), never auto-filed.
 */
export async function lintSummaries(root: string) {
  const nodes = await loadNodes(root);
  const candidates = [] as { id: string; title: string; absolute: string; qualifier: string; summary: string }[];
  for (const n of nodes) {
    if (n.generatedBy) continue; // analyzer prose isn't hand-authored
    const abs = SUMMARY_ABSOLUTE.exec(n.summary || "");
    if (!abs) continue;
    const qual = BODY_QUALIFIER.exec(n.body || "");
    if (!qual) continue;
    candidates.push({ id: n.id, title: n.title, absolute: abs[0].toLowerCase(), qualifier: qual[0].toLowerCase(), summary: n.summary });
  }
  return { count: candidates.length, candidates };
}

/** The documentation work queue: only `open` anchors, ranked by likely value. */
export async function findGaps(
  root: string,
  opts: { pathPrefix?: string; kind?: string; limit?: number } = {},
) {
  const { store, result } = await coverageFor(root);
  let open = store.anchors.filter((a) => result.state.get(a.id) === "open");
  if (opts.pathPrefix) open = open.filter((a) => a.file.startsWith(opts.pathPrefix!));
  if (opts.kind) open = open.filter((a) => a.kind === opts.kind);
  // Rank: type shells first (documenting a type organizes its members), then
  // callables by size (more lines ≈ more logic worth capturing).
  const size = (a: Anchor) => (a.loc ? a.loc.endLine - a.loc.startLine : 0);
  const isType = (a: Anchor) => ["class", "interface", "struct", "record", "enum"].includes(a.kind);
  open.sort((x, y) => Number(isType(y)) - Number(isType(x)) || size(y) - size(x));
  const limit = opts.limit ?? 50;
  return {
    openCount: open.length,
    showing: Math.min(limit, open.length),
    open: open.slice(0, limit).map(anchorBrief),
  };
}

/** Add a coverage/scope rule (P0.2/P0.3): mark selected anchors covered/trivial/deferred/owned. */
export async function cover(
  root: string,
  input: { as: CoverageMark; node?: string; owner?: string; select: AnchorSelector },
) {
  if (input.as === "owned" && !input.owner) return { error: "`owned` requires `owner` (the universe that owns the doc)" };
  if (input.as === "covered" && input.node) {
    const nodes = await loadNodes(root);
    if (!nodes.some((n) => n.id === input.node)) return { error: `unknown node "${input.node}"` };
  }
  const store = await readAnchorStore(root);
  const matched = selectAnchors(store.anchors, input.select);
  if (!matched.length) return { error: "selector matched 0 anchors — check pathPrefix/file/kind/symbol" };
  const cov = await readCoverage(root);
  cov.rules.push({ id: genId("rule"), as: input.as, node: input.node, owner: input.owner, select: input.select });
  await writeCoverage(root, cov.rules);
  return { ok: true, as: input.as, matched: matched.length, sample: matched.slice(0, 5).map((a) => a.symbolPath.join(".")) };
}

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
  if (commit) await writeSnapshot(root, commit, branch, anchors, new Date().toISOString());
  const files = new Set(anchors.map((a) => a.file)).size;
  return {
    ok: true, anchors: anchors.length, files, commit, branch,
    ...(submodules.drift.length ? { submodules: submodules.drift } : {}),
    ...(submodules.error ? { submoduleError: submodules.error } : {}),
    ...(remapped ? { remapped } : {}),
    ...(retained || recovered ? { orphans: { retained, recovered } } : {}),
  };
}

/**
 * What is pointing at code the working tree no longer has — "what did that refactor
 * break?", which there was previously no way to ask.
 *
 * Three outcomes, and the difference is the whole point of asking:
 *   `offTree`   the symbol exists in a cached commit snapshot — a PR branch, most
 *               likely. Nothing is lost; the tree is just on a different branch.
 *   `retained`  gone from the tree and from every snapshot, but its last known
 *               state was kept because work pointed at it. Readable, re-anchorable.
 *   `lost`      no record anywhere. Filed before retention existed, or the record
 *               was evicted. This is the irrecoverable bucket.
 */
export async function orphanedWork(root: string) {
  const [annStore, bugStore, reviewStore, store] = await Promise.all([
    readAnnotations(root), readBugs(root), readReviews(root), readAnchorStore(root),
  ]);
  const live = new Set(store.anchors.map((a) => a.id));

  const refs: { id: string; kind: "annotation" | "bug" | "review"; ref: string; label: string; posted?: Annotation["postedRef"] }[] = [];
  for (const a of annStore.annotations) {
    if (a.target.kind !== "anchor" || live.has(a.target.id)) continue;
    refs.push({
      id: a.target.id, kind: "annotation", ref: a.id,
      label: (a.comment || a.text || "").split("\n")[0]?.slice(0, 120) ?? "",
      ...(a.postedRef ? { posted: a.postedRef } : {}),
    });
  }
  for (const b of bugStore.bugs) {
    for (const id of b.anchors) if (!live.has(id)) refs.push({ id, kind: "bug", ref: b.id, label: b.title });
  }
  // Reviews too: a stranded sign-off is a lost attestation, and retention protects
  // them, so leaving them out of the sweep would report less than was kept.
  for (const r of reviewStore.reviews) {
    if (r.target.kind !== "anchor" || live.has(r.target.id)) continue;
    refs.push({
      id: r.target.id, kind: "review", ref: r.target.id,
      label: `${r.level} ${r.attestation ?? (r.actor === "agent" ? "checked" : "signed")} by ${r.reviewer || r.actor || "?"}`,
    });
  }
  if (!refs.length) return { total: 0, offTree: [] as any[], retained: [] as any[], lost: [] as any[], byKind: {} as Record<string, { offTree: number; retained: number; lost: number }> };

  const ids = [...new Set(refs.map((r) => r.id))];
  const inSnapshots = findAnchorsOutsideWork(root, ids);
  const kept = readOrphans(root, ids);

  const where = (id: string) => {
    const s = inSnapshots.get(id);
    if (s) return { bucket: "offTree" as const, at: s.ref, anchor: s.anchor };
    const k = kept.get(id);
    if (k) return { bucket: "retained" as const, at: "@orphan", anchor: k };
    return { bucket: "lost" as const, at: null, anchor: null };
  };

  const out = {
    total: refs.length,
    offTree: [] as any[], retained: [] as any[], lost: [] as any[],
    /**
     * Counts per bucket per kind, because the buckets do not mean the same thing for
     * every kind. A stranded FINDING is work somebody did that is now unreachable. A
     * stranded historical `viewed` mark is the expected residue of importing years of
     * pull requests — code gets deleted and renamed, and those marks were true when
     * they were made. Reporting one total would bury six real losses under nine
     * hundred routine ones.
     */
    byKind: {} as Record<string, { offTree: number; retained: number; lost: number }>,
  };
  for (const r of refs) {
    const w = where(r.id);
    out[w.bucket].push({
      ...r, at: w.at,
      ...(w.anchor ? { file: w.anchor.file, symbol: w.anchor.symbolPath.join(" › "), line: w.anchor.loc?.startLine } : {}),
    });
    const k = (out.byKind[r.kind] ??= { offTree: 0, retained: 0, lost: 0 });
    k[w.bucket]++;
  }
  return out;
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

  const [reviewStore, triageStore, annStore, bugStore] = await Promise.all([
    readReviews(root), triageRead(root), readAnnotations(root), readBugs(root),
  ]);
  const counts = applyRemap(map, {
    reviews: reviewStore.reviews, triage: triageStore.triage, annotations: annStore.annotations,
    bugs: bugStore.bugs, citations: [],
  });
  counts.citations = remapNodeCitations(root, map);
  await Promise.all([
    writeReviews(root, reviewStore.reviews),
    triageWrite(root, triageStore.triage),
    writeAnnotations(root, annStore.annotations),
    writeBugs(root, bugStore.bugs),
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
  const [store, nodes] = await Promise.all([readAnchorStore(root), loadNodes(root)]);
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
  await writeSnapshot(root, commit, currentBranch(root), anchors, new Date().toISOString());
  return { ok: true, ref: commit, branch: currentBranch(root), anchors: anchors.length, dirty: isDirty(root) };
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

/**
 * Diff two anchor snapshots — added/removed/changed symbols plus the impact on
 * the nodes, flows, and reviews that cite them. `base` is a cached snapshot; omit
 * `head` to diff against a fresh index of the current working tree (the PR-review
 * path), or pass a second cached ref for a pure historical set-op.
 */
export async function diff(root: string, base: string, head?: string) {
  return computeDiff(root, base, head);
}

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
  const node = (await loadNodes(root)).find((n) => n.id === id);
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

/** Diff a doc's prose between the versions that win on base vs head (grounds the code diff). */
export async function docDiff(root: string, base: string, head: string | undefined, id: string) {
  return computeDocDiff(root, base, head, id);
}

/** Anchor→hash map for a cached commit — the hash source when documenting a branch. */
async function snapshotHashes(root: string, ref: string): Promise<AnchorIndex> {
  const snap = await readSnapshot(root, ref);
  // No cached snapshot: nothing is on record about which build would have minted
  // these ids, so every absence falls back to today's answer rather than to
  // "cannot tell" — the same legacy rule the rest of this design uses.
  if (!snap) return legacyIndex(new Map());
  // The SNAPSHOT's own rows: a cached commit was minted by whatever build cached it,
  // and that is the index an id had to come from to appear here.
  return anchorIndex(
    new Map(snap.map((a) => [a.id, a.bodyHash])),
    derivationsOf(snap),
    derivationLookup(root),
  );
}

/** Before/after source for one anchor between two refs (the code drill-down) + its review state. */
export async function diffCode(root: string, base: string, head: string | undefined, id: string, file: string) {
  const code = await anchorCodeDiff(root, base, head, id, file);
  let e: Awaited<ReturnType<typeof reviewTriageFor>> extends Map<string, infer V> ? V | undefined : never;
  try {
    e = (await reviewTriageFor(root, [{ kind: "anchor", id }])).get(`anchor:${id}`);
  } catch { /* review state best-effort */ }
  const rp = e?.review;
  return {
    ...code,
    review: { logical: rp?.logical.state ?? "unreviewed", code: rp?.code.state ?? "unreviewed" },
    reviewBy: { logical: rp?.logical.actor ?? null, code: rp?.code.actor ?? null },
    viewed: { logical: e?.viewed.logical.state ?? "unreviewed", code: e?.viewed.code.state ?? "unreviewed" },
    triage: e?.triage,
    severity: e?.triage.severity ?? "untriaged",
  };
}

/**
 * The corpus-wide org prefix, if any: enterprise codebases root every namespace
 * under one company segment (`Corp.Settlement.Cards.Handlers`), which carries no
 * information as a grouping key. Detected rather than configured — the leading
 * segment counts as an org prefix only when it dominates the whole corpus, so a
 * repo whose top-level segments are real domains is left alone.
 */
function orgPrefixOf(nsById: Map<string, string | undefined>): string | undefined {
  const heads = new Map<string, number>();
  let total = 0;
  for (const ns of new Set(nsById.values())) {
    const p = ns?.split(".");
    if (!p || p.length < 2 || !p[0]) continue;
    total++;
    heads.set(p[0], (heads.get(p[0]) ?? 0) + 1);
  }
  if (total < 5) return undefined; // too small a corpus to call it
  const [head, n] = [...heads.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  return head && n! / total >= 0.8 ? head : undefined;
}

/** Collapse a namespace to a browsable domain (e.g. Corp.Settlement.Cards.Handlers → Settlement.Cards). */
function domainOf(ns: string | undefined, org?: string): string {
  if (!ns) return "(none)";
  const p = ns.split(".");
  if (org && p[0] === org && p[1] && p[2]) return `${p[1]}.${p[2]}`;
  return p.slice(0, 2).join(".") || ns;
}

/** The dominant namespace among a node's cited anchors (for domain grouping). */
function topNamespace(anchorIds: string[], nsById: Map<string, string | undefined>): string | undefined {
  const tally = new Map<string, number>();
  for (const id of anchorIds) {
    const ns = nsById.get(id);
    if (ns) tally.set(ns, (tally.get(ns) ?? 0) + 1);
  }
  return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * The node catalog: every logical node with its domain, edge degree, provenance,
 * and review state — the node-first surface (browse/filter/mark-reviewed) that
 * complements the flow-first and file-first views. Review state is batched
 * (reviewStatesFor re-indexes only files with reviewed anchors, so it's cheap).
 */
export async function nodeCatalog(root: string) {
  const [nodes, graph, store] = await Promise.all([loadNodes(root), readGraph(root), readAnchorStore(root)]);
  const nsById = new Map(store.anchors.map((a) => [a.id, a.symbolPath[0]]));
  const org = orgPrefixOf(nsById);
  const inC = new Map<string, number>();
  const outC = new Map<string, number>();
  for (const e of graph.edges) {
    outC.set(e.from, (outC.get(e.from) ?? 0) + 1);
    inC.set(e.to, (inC.get(e.to) ?? 0) + 1);
  }
  const rt = await reviewTriageFor(root, nodes.map((n) => ({ kind: "node" as const, id: n.id })));
  // Node code review is derived from each cited segment's own code review (see
  // nodeCodeReviews) so this list agrees with the node page.
  const codeReviews = await nodeCodeReviews(root, nodes, new Set(store.anchors.map((a) => a.id)));
  const out = nodes.map((n) => {
    const topNs = topNamespace(n.anchors, nsById);
    const e = rt.get(`node:${n.id}`);
    const rp = e?.review;
    const codeReview = codeReviews.get(n.id)!;
    const review = { logical: rp?.logical ?? { state: "unreviewed" as const }, code: { state: codeReview.state, actor: codeReview.actor ?? undefined } };
    return {
      id: n.id,
      type: n.type,
      title: n.title,
      summary: n.summary,
      domain: domainOf(topNs, org),
      namespace: topNs ?? null,
      anchors: n.anchors.length,
      edgesIn: inC.get(n.id) ?? 0,
      edgesOut: outC.get(n.id) ?? 0,
      degree: (inC.get(n.id) ?? 0) + (outC.get(n.id) ?? 0),
      generatedBy: n.generatedBy ?? null,
      status: n.status ?? "fresh",
      versionCount: n.versionCount ?? 1,
      review: { logical: review.logical.state, code: review.code.state },
      reviewBy: { logical: rp?.logical.actor ?? null, code: codeReview.actor },
      codeReview,
      viewed: { logical: e?.viewed.logical.state ?? "unreviewed", code: e?.viewed.code.state ?? "unreviewed" },
      trust: trustOf(n.status, review),
      triage: e?.triage,
      severity: e?.triage.severity ?? "untriaged",
    };
  });
  // Fold state-map enrichment pairs: a generated transition skeleton `mtr-x` and
  // its authored enrichment `tr-x` are ONE logical transition. Keep the enrichment
  // row (the reviewable, trust-bearing doc), merge in the skeleton's connectivity,
  // and drop the skeleton so the catalog doesn't double-count machines.
  const rowById = new Map(out.map((n) => [n.id, n]));
  const isSkeletonWithTwin = (n: (typeof out)[number]) => {
    if (!n.generatedBy || n.type !== "transition" || !n.id.startsWith("mtr-")) return false;
    const twin = rowById.get(n.id.slice(1));
    return !!twin && twin.type === "transition" && !twin.generatedBy;
  };
  const folded = out
    .filter((n) => !isSkeletonWithTwin(n))
    .map((n) => {
      if (n.type === "transition" && !n.generatedBy) {
        const sk = rowById.get("m" + n.id);
        if (sk && isSkeletonWithTwin(sk)) {
          return { ...n, edgesIn: n.edgesIn + sk.edgesIn, edgesOut: n.edgesOut + sk.edgesOut, degree: n.degree + sk.degree, skeleton: sk.id };
        }
      }
      return n;
    });
  const tally = (arr: typeof folded, k: "type" | "domain" | "status" | "severity") =>
    arr.reduce<Record<string, number>>((m, x) => ((m[x[k] ?? "(none)"] = (m[x[k] ?? "(none)"] ?? 0) + 1), m), {});
  const reviewed = folded.filter((n) => n.review.logical !== "unreviewed" || n.review.code !== "unreviewed").length;
  return {
    total: folded.length,
    reviewed,
    byType: tally(folded, "type"),
    byDomain: tally(folded, "domain"),
    byStatus: tally(folded, "status"),
    bySeverity: tally(folded, "severity"),
    coverage: rollupCoverage([...rt.values()].map((v) => v.triage)),
    nodes: folded,
  };
}

/**
 * Event wiring matrix — events as rows, the aggregates/projections they feed as
 * columns, cells = folds (into an aggregate) or projects (to a projection). This
 * is the audit view for an event-sourced graph: a high-degree sink (e.g. a
 * projection that consumes every event) is one dense column instead of a 50-spoke
 * wheel, and an **orphan** event (folded/projected by nothing) is a blank row.
 * Per-row it also carries the emitter count (handlers that raise it) and review
 * state, so events can be reviewed straight from the matrix.
 */
export async function eventMatrix(root: string) {
  const [nodes, graph, store] = await Promise.all([loadNodes(root), readGraph(root), readAnchorStore(root)]);
  const nsById = new Map(store.anchors.map((a) => [a.id, a.symbolPath[0]]));
  const org = orgPrefixOf(nsById);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const events = nodes.filter((n) => n.type === "event_family");

  const foldProject = graph.edges.filter((e) => (e.type === "folds" || e.type === "projects") && byId.get(e.from)?.type === "event_family");
  // Columns = the aggregates/projections events actually feed. Aggregates first.
  const sinkIds = [...new Set(foldProject.map((e) => e.to))].filter((id) => byId.has(id));
  const sinks = sinkIds
    .map((id) => ({ id, title: byId.get(id)!.title, type: byId.get(id)!.type }))
    .sort((a, b) => (a.type === b.type ? a.title.localeCompare(b.title) : a.type === "aggregate" ? -1 : 1));

  const emitsInto = new Map<string, number>();
  for (const e of graph.edges) if (e.type === "emits") emitsInto.set(e.to, (emitsInto.get(e.to) ?? 0) + 1);

  const cellsByEvent = new Map<string, Record<string, string>>();
  for (const e of foldProject) {
    let m = cellsByEvent.get(e.from);
    if (!m) { m = {}; cellsByEvent.set(e.from, m); }
    m[e.to] = e.type; // "folds" | "projects"
  }

  const reviews = await reviewStatesFor(root, events.map((n) => ({ kind: "node" as const, id: n.id })));
  // Code review derives from each event's cited segments (see nodeCodeReviews) so
  // the matrix agrees with the node page — the code cell is a read-only rollup.
  const codeReviews = await nodeCodeReviews(root, events, new Set(store.anchors.map((a) => a.id)));
  const rows = events
    .map((n) => {
      const cells = cellsByEvent.get(n.id) ?? {};
      const folds = Object.values(cells).filter((v) => v === "folds").length;
      const projects = Object.values(cells).filter((v) => v === "projects").length;
      const rp = reviews.get(`node:${n.id}`);
      const codeReview = codeReviews.get(n.id)!;
      return {
        id: n.id,
        title: n.title,
        domain: domainOf(topNamespace(n.anchors, nsById), org),
        emitters: emitsInto.get(n.id) ?? 0,
        cells,
        folds,
        projects,
        orphan: folds === 0 && projects === 0,
        review: { logical: rp?.logical.state ?? "unreviewed", code: codeReview.state },
        reviewBy: { logical: rp?.logical.actor ?? null, code: codeReview.actor },
        codeReview,
      };
    })
    .sort((a, b) => a.domain.localeCompare(b.domain) || a.title.localeCompare(b.title));

  return {
    sinks,
    events: rows,
    stats: {
      events: rows.length,
      orphans: rows.filter((r) => r.orphan).length,
      aggregates: sinks.filter((s) => s.type === "aggregate").length,
      projections: sinks.filter((s) => s.type === "projection").length,
    },
  };
}

/**
 * Drill-down navigation over the structural tree that already lives in the
 * anchor paths — the primitive for understanding a large codebase top-down.
 * A directory prefix returns its immediate children (dirs/files) with anchor
 * counts, documentation coverage, and node/bug rollups; a file prefix returns
 * its symbols. You never list everything — you expand one level at a time.
 */
export async function outline(root: string, prefix = "", opts: { compact?: boolean } = {}) {
  const [{ store, nodes, result }, bugStore, reviewStore] = await Promise.all([coverageFor(root), readBugs(root), readReviews(root)]);
  const byId = new Map(store.anchors.map((a) => [a.id, a]));
  const state = (id: string) => result.state.get(id) ?? "open";
  const reviews = await anchorReviewMap(root, store.anchors, nodes, reviewStore.reviews);
  const rv = (id: string) => reviews.get(id) ?? { code: "unreviewed" as const, logical: "unreviewed" as const, codeActor: null, logicalActor: null, codeVia: undefined, logicalVia: undefined };
  const inScope = (id: string) => { const s = state(id); return s === "open" || s === "cited" || s === "covered"; };

  // A file prefix → list that file's symbols.
  const fileAnchors = store.anchors.filter((a) => a.file === prefix);
  if (fileAnchors.length) {
    const byLine = [...fileAnchors].sort((a, b) => (a.loc?.startLine ?? 0) - (b.loc?.startLine ?? 0));
    // `compact` is the cheap symbol listing: id, symbol, kind, lines and nothing
    // else. A big C# file's full listing (coverage + per-anchor review + citing
    // node ids) runs to tens of KB, which pushed callers to grep the file instead.
    if (opts.compact) {
      return {
        prefix,
        kind: "file" as const,
        compact: true,
        symbols: byLine.map((a) => ({ id: a.id, symbol: a.symbolPath.join(" › "), kind: a.kind, lines: a.loc ? `${a.loc.startLine}-${a.loc.endLine}` : undefined })),
      };
    }
    return {
      prefix,
      kind: "file" as const,
      symbols: byLine
        .map((a) => ({
          ...anchorBrief(a),
          coverage: state(a.id),
          review: rv(a.id),
          nodes: nodes.filter((n) => n.anchors.includes(a.id)).map((n) => n.id),
        })),
    };
  }

  // Otherwise a directory prefix → group by the next path segment, rolling up
  // the coverage state breakdown so docPct/open counts are honest.
  const p = prefix ? (prefix.endsWith("/") ? prefix : prefix + "/") : "";
  type Grp = { anchors: number; b: Record<CoverageState, number>; isFile: boolean; rDenom: number; rc: number; rcStale: number; rcReverted: number; rl: number; rlStale: number };
  const groups = new Map<string, Grp>();
  for (const a of store.anchors) {
    if (!a.file.startsWith(p)) continue;
    const rest = a.file.slice(p.length);
    const slash = rest.indexOf("/");
    const seg = slash === -1 ? rest : rest.slice(0, slash);
    let g = groups.get(seg);
    if (!g) groups.set(seg, (g = { anchors: 0, b: { open: 0, cited: 0, covered: 0, trivial: 0, deferred: 0, owned: 0 }, isFile: slash === -1, rDenom: 0, rc: 0, rcStale: 0, rcReverted: 0, rl: 0, rlStale: 0 }));
    g.anchors++;
    g.b[state(a.id)]++;
    if (inScope(a.id)) { // review % over documentable anchors only
      g.rDenom++;
      const r = rv(a.id);
      if (r.code === "reviewed") { g.rc++; if (r.codeVia === "reverted") g.rcReverted++; } else if (r.code === "stale") g.rcStale++;
      if (r.logical === "reviewed") g.rl++; else if (r.logical === "stale") g.rlStale++;
    }
  }
  const underPath = (nodeAnchorIds: string[], childPath: string) =>
    nodeAnchorIds.some((id) => {
      const a = byId.get(id);
      return a && (a.file === childPath || a.file.startsWith(childPath + "/"));
    });
  const children = [...groups.entries()]
    .map(([name, g]) => {
      const path = p + name;
      const denom = g.b.open + g.b.cited + g.b.covered;
      return {
        name,
        path,
        kind: g.isFile ? ("file" as const) : ("dir" as const),
        anchors: g.anchors,
        open: g.b.open, // in-scope, undocumented — the real work here
        docPct: denom ? Math.round((100 * (g.b.cited + g.b.covered)) / denom) : 0,
        // The stronger claim: cited BY a doc, not just swept in by a `cover`
        // selector. docPct counts both, so it can read 100% on a map where almost
        // nothing is actually described — report them apart.
        citedPct: denom ? Math.round((100 * g.b.cited) / denom) : 0,
        cited: g.b.cited,
        covered: g.b.covered,
        review: { total: g.rDenom, logical: g.rl, logicalStale: g.rlStale, code: g.rc, codeStale: g.rcStale, codeReverted: g.rcReverted },
        nodes: nodes.filter((n) => underPath(n.anchors, path)).length,
        bugs: bugStore.bugs.filter((b) => underPath(b.anchors, path)).length,
      };
    })
    .sort((x, y) => y.anchors - x.anchors);
  return { prefix: p, kind: "dir" as const, childrenCount: children.length, children };
}

// ---------------------------------------------------------------------------
// Reading the graph & code
// ---------------------------------------------------------------------------

export async function search(root: string, query: string, limit = 30) {
  const q = query.toLowerCase();
  const [store, nodes] = await Promise.all([readAnchorStore(root), loadNodes(root)]);
  const anchors = store.anchors
    .filter((a) => a.symbolPath.join(".").toLowerCase().includes(q) || a.file.toLowerCase().includes(q))
    .slice(0, limit)
    .map(anchorBrief);
  const matched = nodes
    .filter((n) =>
      n.id.toLowerCase().includes(q) ||
      n.title.toLowerCase().includes(q) ||
      n.summary.toLowerCase().includes(q) ||
      n.body.toLowerCase().includes(q),
    )
    .slice(0, limit);
  // Surface the trust ladder inline so a searching agent can tell a trusted answer
  // from a stale guess without a second round-trip.
  const reviews = await reviewStatesFor(root, matched.map((n) => ({ kind: "node" as const, id: n.id })));
  const nodeHits = matched.map((n) => {
    const rp = reviews.get(`node:${n.id}`);
    const review = { logical: rp?.logical.state ?? "unreviewed", code: rp?.code.state ?? "unreviewed" };
    return { id: n.id, type: n.type, title: n.title, summary: n.summary, status: n.status ?? "fresh", review, trust: trustOf(n.status, rp) };
  });
  return { anchors, nodes: nodeHits };
}

/**
 * "What does codemap already know about this code, and can I trust it?" — the
 * answer-first entry point for a codemap-aware Explore agent. Given refs (files,
 * dirs, `file#Symbol`, `file:line`, or anchor ids), returns the covering docs with
 * their trust level, the flows/bugs on that code, and the still-undocumented
 * anchors (the gaps to fill). Lets the agent skip re-exploration when a trusted
 * doc already answers, and focus its reading on the gaps when it doesn't.
 */
export async function context(root: string, refs: string[]) {
  const { store, nodes, result } = await coverageFor(root);
  const [graph, bugStore] = await Promise.all([readGraph(root), readBugs(root)]);
  const anchorsById = new Map(store.anchors.map((a) => [a.id, a]));

  // Resolve each ref → anchor ids. Precise refs (id / file#Symbol / file:line) go
  // through resolveAnchorRefs; a bare path is treated as a file or directory scope.
  const scope = new Set<string>();
  const errors: string[] = [];
  for (const ref of refs) {
    if (anchorsById.has(ref)) { scope.add(ref); continue; }
    if (ref.includes("#") || /:\d+$/.test(ref)) {
      const r = resolveAnchorRefs(store.anchors, [ref]);
      r.ids.forEach((id) => scope.add(id));
      errors.push(...r.errors);
      continue;
    }
    const pref = ref.replace(/\/+$/, "");
    const hits = store.anchors.filter((a) => a.file === pref || a.file.startsWith(pref + "/") || a.file.endsWith("/" + pref));
    if (hits.length) hits.forEach((a) => scope.add(a.id));
    else errors.push(`no anchors for "${ref}"`);
  }
  const scopeIds = [...scope];

  const fileOf = (id: string) => anchorsById.get(id)?.file;
  const scopeFiles = new Set(scopeIds.map((id) => fileOf(id)).filter(Boolean) as string[]);

  // A doc "covers" the scope if it cites any anchor in a SCOPE FILE — file-level, so a
  // module doc for the file surfaces even when it doesn't cite the exact member asked
  // about (the dry-run's RatingProfile.cs case). Exact-anchor overlap still ranks first.
  const covering = nodes.filter((n) => n.anchors.some((id) => scopeFiles.has(fileOf(id) ?? "")));

  // Flows whose OWN anchors or any of their STEPS' anchors touch the scope — a raw
  // `type === 'process'` filter missed the flow that actually answers the question,
  // because a process node cites its steps by edge, not the code directly.
  const stepsOf = new Map<string, string[]>();
  for (const e of graph.edges) if (e.type === "step_of") { const a = stepsOf.get(e.to) ?? []; a.push(e.from); stepsOf.set(e.to, a); }
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const flowNodes = nodes.filter((n) => n.type === "process" &&
    (n.anchors.some((id) => scope.has(id)) || (stepsOf.get(n.id) ?? []).some((sid) => (nodeById.get(sid)?.anchors ?? []).some((id) => scope.has(id)))));

  const rank: Record<Trust, number> = { verified: 0, checked: 1, unverified: 2, stale: 3, generated: 4 };
  const reviewed = await reviewStatesFor(root, [...covering, ...flowNodes].map((n) => ({ kind: "node" as const, id: n.id })));
  const view = (n: LogicalNode) => {
    const rp = reviewed.get(`node:${n.id}`);
    return { id: n.id, title: n.title, type: n.type, summary: n.summary, status: n.status ?? "fresh",
      review: { logical: rp?.logical.state ?? "unreviewed", code: rp?.code.state ?? "unreviewed" }, trust: trustOf(n.status, rp) };
  };
  const docs = covering.map((n) => ({ ...view(n), coversInScope: n.anchors.filter((id) => scope.has(id)).length }))
    .sort((a, b) => (rank[a.trust] - rank[b.trust]) || b.coversInScope - a.coversInScope);
  const flows = flowNodes.map((n) => ({ ...view(n), steps: (stepsOf.get(n.id) ?? []).length }));

  // Files that DO have a readable doc (some node cites an anchor in them).
  const docFiles = new Set(covering.flatMap((n) => n.anchors.map(fileOf)).filter(Boolean) as string[]);
  // Gaps = scope anchors with no readable doc that aren't intentionally excluded:
  // `open`, or `covered`-by-a-rule but no doc actually cites anything in the file.
  // (`cited`/`trivial`/`deferred`/`owned` are not gaps.)
  const gaps = scopeIds.filter((id) => {
    const st = result.state.get(id);
    return st === "open" || (st === "covered" && !docFiles.has(fileOf(id) ?? ""));
  }).map((id) => anchorBrief(anchorsById.get(id)!));
  const withDoc = scopeIds.filter((id) => covering.some((n) => n.anchors.includes(id))).length;

  const bugs = bugStore.bugs
    .filter((b) => b.status === "open" && b.anchors.some((id) => scope.has(id)))
    .map((b) => ({ id: b.id, title: b.title, severity: b.severity }));

  return {
    scopeAnchors: scopeIds.length,
    withDoc,           // scope anchors a doc directly cites
    gaps,              // scope anchors with no readable doc (the explore-then-document list)
    docs,
    flows,
    bugs,
    // A one-line read for the agent: is this area answered by something, and how much to trust it?
    verdict: !scopeIds.length ? "empty scope"
      : docs.some((d) => d.trust === "verified") ? "covered — human-verified docs exist; rely on them"
      : docs.some((d) => d.trust === "checked") ? "covered — agent-checked docs exist; solid, spot-check if critical"
      : docs.some((d) => d.trust === "unverified") ? "partial — docs exist but unchecked; use as hypotheses, verify against code (and sanity_check what holds)"
      : docs.some((d) => d.trust === "stale") ? "stale — docs here need re-validation against current code"
      : gaps.length ? "gap — no docs cover this code; explore, then document the reusable claims"
      : "no docs and no open gaps (this code may be intentionally deferred/trivial)",
    ...(errors.length ? { errors } : {}),
  };
}

export async function getNode(root: string, id: string) {
  const [nodes, graph, store, annStore] = await Promise.all([
    loadNodes(root), readGraph(root), readAnchorStore(root), readAnnotations(root),
  ]);
  const node = nodes.find((n) => n.id === id);
  if (!node) return { error: `no node "${id}"` };
  const byId = new Map(store.anchors.map((a) => [a.id, a]));
  // One batch for the node and all its anchors → review (vouch) + viewed + severity.
  const rt = await reviewTriageFor(root, [
    { kind: "node", id },
    ...node.anchors.map((aid) => ({ kind: "anchor" as const, id: aid })),
  ]);
  const nodeRt = rt.get(`node:${id}`)!;
  const resolvedAnchors = node.anchors.map((aid) => {
    const e = rt.get(`anchor:${aid}`);
    const brief = byId.get(aid) ? anchorBrief(byId.get(aid)!) : { id: aid, missing: true };
    return { ...brief, review: e?.review, viewed: e?.viewed, severity: e?.triage.severity ?? "untriaged", triage: e?.triage, annotations: annStore.annotations.filter((a) => a.target.kind === "anchor" && a.target.id === aid) };
  });
  // A node's code review is *derived* from the code reviews of the segments it
  // cites — signing the node vouches for the doc (logical), never for code you
  // haven't opened. Missing anchors are excluded from the denominator (a lost
  // anchor shows up as `dangling` status, not an un-completable review).
  const codeReview = deriveCodeReview(
    resolvedAnchors.filter((a) => a.review && !("missing" in a && a.missing)).map((a) => a.review!.code),
  );
  const review = { logical: nodeRt.review.logical, code: { state: codeReview.state, actor: codeReview.actor ?? undefined } };
  return {
    ...node,
    resolvedAnchors,
    edges: graph.edges.filter((e) => e.from === id || e.to === id),
    annotations: annStore.annotations.filter((a) => a.target.kind === "node" && a.target.id === id),
    review,
    codeReview,
    viewed: nodeRt.viewed,
    triage: nodeRt.triage,
    severity: nodeRt.triage.severity,
    trust: trustOf(node.status, review),
  };
}

/** A node's immediate graph neighborhood (for the graph viewer). Same-universe only. */
export async function neighborhood(root: string, id: string) {
  const [nodes, graph] = await Promise.all([loadNodes(root), readGraph(root)]);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const node = byId.get(id);
  if (!node) return { error: `no node "${id}"` };
  const seen = new Map<string, { id: string; title: string; type: string; edges: { edgeType: string; dir: "in" | "out" }[] }>();
  for (const e of graph.edges) {
    let nbrId: string | null = null;
    let dir: "in" | "out" = "out";
    if (e.from === id) { nbrId = e.to; dir = "out"; }
    else if (e.to === id) { nbrId = e.from; dir = "in"; }
    if (!nbrId || nbrId.includes("::")) continue; // cross-universe handled elsewhere
    const nb = byId.get(nbrId);
    const cur = seen.get(nbrId) ?? { id: nbrId, title: nb?.title ?? nbrId, type: nb?.type ?? "unknown", edges: [] };
    cur.edges.push({ edgeType: e.type, dir });
    seen.set(nbrId, cur);
  }
  return { id, title: node.title, type: node.type, neighbors: [...seen.values()] };
}

/**
 * Induced subgraph for the force-directed explorer: the nodes in `ids`, plus (if
 * `expand` is given) the neighbors of that one node, with every edge among the
 * resulting set. Each node carries its full-graph degree vs how much is shown, so
 * the UI can flag which nodes still have hidden neighbors to expand into. This is
 * the incremental-exploration primitive — grow the view one node at a time
 * instead of dumping a whole neighborhood at once.
 */
export async function subgraph(root: string, ids: string[], expand?: string) {
  const [nodes, graph] = await Promise.all([loadNodes(root), readGraph(root)]);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const set = new Set(ids.filter((id) => byId.has(id)));
  if (expand && byId.has(expand)) {
    set.add(expand);
    for (const e of graph.edges) {
      if (e.from === expand && byId.has(e.to)) set.add(e.to);
      if (e.to === expand && byId.has(e.from)) set.add(e.from);
    }
  }
  const totalDeg = new Map<string, number>();
  for (const e of graph.edges) {
    if (byId.has(e.from)) totalDeg.set(e.from, (totalDeg.get(e.from) ?? 0) + 1);
    if (byId.has(e.to)) totalDeg.set(e.to, (totalDeg.get(e.to) ?? 0) + 1);
  }
  const edges = graph.edges.filter((e) => set.has(e.from) && set.has(e.to)).map((e) => ({ from: e.from, to: e.to, type: e.type }));
  const shownDeg = new Map<string, number>();
  for (const e of edges) { shownDeg.set(e.from, (shownDeg.get(e.from) ?? 0) + 1); shownDeg.set(e.to, (shownDeg.get(e.to) ?? 0) + 1); }
  const reviews = await reviewStatesFor(root, [...set].map((id) => ({ kind: "node" as const, id })));
  const outNodes = [...set].map((id) => {
    const n = byId.get(id)!;
    const rp = reviews.get(`node:${id}`);
    return {
      id, title: n.title, type: n.type,
      degree: totalDeg.get(id) ?? 0,
      hidden: (totalDeg.get(id) ?? 0) - (shownDeg.get(id) ?? 0),
      review: { logical: rp?.logical.state ?? "unreviewed", code: rp?.code.state ?? "unreviewed" },
      reviewBy: { logical: rp?.logical.actor ?? null, code: rp?.code.actor ?? null },
    };
  });
  return {
    nodes: outNodes,
    edges,
    edgeTypes: [...new Set(edges.map((e) => e.type))].sort(),
    nodeTypes: [...new Set(outNodes.map((n) => n.type))].sort(),
    seed: expand ?? ids[0] ?? null,
  };
}

/** All process nodes (flows) with step counts + review rollup — the bird's-eye view. */
export async function flows(root: string) {
  const [nodes, graph, store] = await Promise.all([loadNodes(root), readGraph(root), readAnchorStore(root)]);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const processes = nodes.filter((n) => n.type === "process");
  const stepsByProc = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.type !== "step_of") continue;
    (stepsByProc.get(e.to) ?? stepsByProc.set(e.to, []).get(e.to)!).push(e.from);
  }
  const targets: { kind: "node"; id: string }[] = [];
  for (const p of processes) {
    targets.push({ kind: "node", id: p.id });
    for (const sid of stepsByProc.get(p.id) ?? []) targets.push({ kind: "node", id: sid });
  }
  const rev = await reviewStatesFor(root, targets);
  // Code review is derived from each node's cited segments (matches flow detail +
  // node page), so the rollup counts real per-segment progress, not a node-code click.
  const involved = [...new Set(targets.map((t) => t.id))].map((id) => byId.get(id)).filter((n): n is LogicalNode => Boolean(n));
  const codeReviews = await nodeCodeReviews(root, involved, new Set(store.anchors.map((a) => a.id)));
  const codeState = (id: string) => codeReviews.get(id)?.state ?? "unreviewed";
  const rollup = (ids: string[]) => {
    let logical = 0, code = 0, stale = 0;
    for (const id of ids) {
      const r = rev.get("node:" + id);
      const cs = codeState(id);
      if (r?.logical.state === "reviewed") logical++;
      if (cs === "reviewed") code++;
      if (r?.logical.state === "stale" || cs === "stale") stale++;
    }
    return { logical, code, stale, total: ids.length };
  };
  return {
    flows: processes.map((p) => ({
      id: p.id, title: p.title, summary: p.summary,
      steps: (stepsByProc.get(p.id) ?? []).length,
      review: { logical: rev.get("node:" + p.id)?.logical ?? { state: "unreviewed" as const }, code: { state: codeState(p.id), actor: codeReviews.get(p.id)?.actor ?? undefined } },
      codeReview: codeReviews.get(p.id),
      stepReview: rollup(stepsByProc.get(p.id) ?? []),
    })),
  };
}

/**
 * Layered event-pipeline graph: the Marten chain command → handler → event →
 * aggregate → projection laid out left-to-right, one column per role. Nodes are
 * ordered within each column by barycenter (a couple of Sugiyama sweeps) to pull
 * connected chains together and cut edge crossings. The whole-application graph
 * view — the client just maps layer→x and row→y; the ordering is done here.
 * Optional `domain` narrows the left columns to one subsystem (aggregates /
 * projections its events feed are kept so chains stay whole).
 */
const PIPELINE_LAYER: Record<string, number> = { command: 0, handler: 1, event_family: 2, aggregate: 3, projection: 4 };

export async function pipelineGraph(root: string, opts: { domain?: string } = {}) {
  const [nodes, graph, store] = await Promise.all([loadNodes(root), readGraph(root), readAnchorStore(root)]);
  const nsById = new Map(store.anchors.map((a) => [a.id, a.symbolPath[0]]));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const inLayer = (n: LogicalNode) => PIPELINE_LAYER[n.type] !== undefined;
  const org = orgPrefixOf(nsById);
  const domOf = (n: LogicalNode) => domainOf(topNamespace(n.anchors, nsById), org);

  const relTypes = new Set(["handles", "emits", "folds", "projects"]);
  const rel = graph.edges.filter((e) => relTypes.has(e.type) && byId.has(e.from) && byId.has(e.to));

  // Which nodes are in scope (optionally narrowed to a domain, keeping sinks).
  let sel: Set<string>;
  if (opts.domain) {
    sel = new Set(nodes.filter((n) => inLayer(n) && PIPELINE_LAYER[n.type]! <= 2 && domOf(n) === opts.domain).map((n) => n.id));
    for (const e of rel) if ((e.type === "folds" || e.type === "projects") && sel.has(e.from)) sel.add(e.to);
  } else {
    sel = new Set(nodes.filter(inLayer).map((n) => n.id));
  }
  const edges = rel.filter((e) => sel.has(e.from) && sel.has(e.to));

  const layers: LogicalNode[][] = [[], [], [], [], []];
  for (const id of sel) { const n = byId.get(id)!; layers[PIPELINE_LAYER[n.type]!]!.push(n); }
  for (const L of layers) L.sort((a, b) => domOf(a).localeCompare(domOf(b)) || a.title.localeCompare(b.title));

  // Barycenter ordering over the undirected adjacency in adjacent layers.
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => { let l = adj.get(a); if (!l) { l = []; adj.set(a, l); } l.push(b); };
  for (const e of edges) { link(e.from, e.to); link(e.to, e.from); }
  const layerIndex = new Map<string, number>();
  layers.forEach((L, li) => L.forEach((n) => layerIndex.set(n.id, li)));
  const pos = new Map<string, number>();
  const setPos = () => layers.forEach((L) => L.forEach((n, i) => pos.set(n.id, i)));
  setPos();
  const sweep = (order: number[]) => {
    for (const li of order) {
      const L = layers[li]!;
      const bary = new Map<string, number>();
      for (const n of L) {
        const neigh = (adj.get(n.id) ?? []).filter((m) => Math.abs(layerIndex.get(m)! - li) === 1);
        bary.set(n.id, neigh.length ? neigh.reduce((s, m) => s + pos.get(m)!, 0) / neigh.length : pos.get(n.id)!);
      }
      L.sort((a, b) => bary.get(a.id)! - bary.get(b.id)!);
      setPos();
    }
  };
  for (let k = 0; k < 4; k++) { sweep([1, 2, 3, 4]); sweep([3, 2, 1, 0]); }

  const reviews = await reviewStatesFor(root, [...sel].map((id) => ({ kind: "node" as const, id })));
  const outNodes: any[] = [];
  layers.forEach((L, li) =>
    L.forEach((n, row) => {
      const rp = reviews.get(`node:${n.id}`);
      outNodes.push({
        id: n.id, title: n.title, type: n.type, domain: domOf(n), layer: li, row,
        degree: (adj.get(n.id) ?? []).length,
        review: { logical: rp?.logical.state ?? "unreviewed", code: rp?.code.state ?? "unreviewed" },
        reviewBy: { logical: rp?.logical.actor ?? null, code: rp?.code.actor ?? null },
      });
    }),
  );
  const domains = [...new Set(nodes.filter((n) => inLayer(n) && PIPELINE_LAYER[n.type]! <= 2).map(domOf))].sort();
  return {
    layerNames: ["command", "handler", "event", "aggregate", "projection"],
    layerCounts: layers.map((L) => L.length),
    nodes: outNodes,
    edges: edges.map((e) => ({ from: e.from, to: e.to, type: e.type })),
    domains,
    domain: opts.domain ?? null,
  };
}

/**
 * Per-aggregate state machines: states (enum members) + transitions, both nodes
 * emitted by the Marten analyzer. A transition skeleton `mtr-…` is joined by id
 * convention to its authored enrichment `tr-…` (source states / guards, written
 * via document + from_state connect edges — analyzer re-emits never touch them).
 * `unenriched` is the agent work queue: transitions with no enrichment node or
 * whose enrichment went stale/dangling (drifted claims re-enter the queue).
 * Layout: BFS layers from the initial states over sources→targets; targets of
 * source-less transitions surface at layer 1 (the UI feeds them from a "?"
 * gutter); states the graph never reaches land in a final layer.
 */
export async function stateMap(root: string, opts: { aggregate?: string } = {}) {
  const [nodes, graph] = await Promise.all([loadNodes(root), readGraph(root)]);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const present = (e: Edge) => byId.has(e.from) && byId.has(e.to);

  const stateOf = graph.edges.filter((e) => e.type === "state_of" && present(e));
  const trOf = graph.edges.filter((e) => e.type === "transition_of" && present(e));
  const aggIds = [...new Set(stateOf.map((e) => e.to))].sort((a, b) => byId.get(a)!.title.localeCompare(byId.get(b)!.title));
  const aggregates = aggIds.map((id) => ({ id, title: byId.get(id)!.title }));

  const q = opts.aggregate?.toLowerCase();
  const sel = q ? aggIds.filter((id) => id === opts.aggregate || byId.get(id)!.title.toLowerCase() === q) : aggIds;

  // One batched review query for everything this response touches.
  const trIdOf = (mtrId: string) => "tr-" + mtrId.slice(4);
  const involved = new Set<string>();
  for (const e of stateOf) if (sel.includes(e.to)) involved.add(e.from);
  for (const e of trOf) if (sel.includes(e.to)) { involved.add(e.from); if (byId.has(trIdOf(e.from))) involved.add(trIdOf(e.from)); }
  const reviews = await reviewStatesFor(root, [...involved].map((id) => ({ kind: "node" as const, id })));
  const reviewOf = (id: string) => {
    const rp = reviews.get(`node:${id}`);
    return { logical: rp?.logical.state ?? "unreviewed", code: rp?.code.state ?? "unreviewed" };
  };

  const machines = sel.map((aggId) => {
    const agg = byId.get(aggId)!;
    const stateIds = stateOf.filter((e) => e.to === aggId).map((e) => e.from);
    const stateSet = new Set(stateIds);
    const initial = new Set(graph.edges.filter((e) => e.type === "initial_state" && e.from === aggId && stateSet.has(e.to)).map((e) => e.to));

    const transitions = trOf.filter((e) => e.to === aggId).map((e) => e.from).map((tid) => {
      const n = byId.get(tid)!;
      const ev = graph.edges.find((x) => x.type === "on_event" && x.from === tid && byId.has(x.to));
      const targets = [...new Set(graph.edges.filter((x) => x.type === "transitions_to" && x.from === tid && stateSet.has(x.to)).map((x) => x.to))];
      const sources = [...new Set(graph.edges.filter((x) => x.type === "from_state" && x.to === tid && stateSet.has(x.from)).map((x) => x.from))];
      // A generated skeleton pairs with its authored `tr-` node by id convention;
      // a fully-AUTHORED transition (no generatedBy) is its own enrichment.
      const en = n.generatedBy ? byId.get(trIdOf(tid)) : n;
      const enrichment = en && en.type === "transition" && !en.generatedBy
        ? { id: en.id, title: en.title, summary: en.summary, status: en.status, review: reviewOf(en.id), trust: trustOf(en.status, reviews.get(`node:${en.id}`)) }
        : null;
      return {
        id: tid, title: n.title, summary: n.summary,
        event: ev ? { id: ev.to, title: byId.get(ev.to)!.title } : null,
        targets, sources,
        dynamic: targets.length === 0, // no statically-known target
        enrichment,
        enriched: !!enrichment && enrichment.status !== "stale" && enrichment.status !== "dangling",
      };
    });

    // Layers: sourced BFS first ("first reached through real sources" wins), then
    // seed still-unplaced targets of source-less transitions at 1, repeat.
    const layerOf = new Map<string, number>();
    for (const s of initial) layerOf.set(s, 0);
    const propagate = () => {
      for (let moved = true; moved; ) {
        moved = false;
        for (const t of transitions) {
          if (!t.sources.length) continue;
          const from = t.sources.filter((s) => layerOf.has(s));
          if (!from.length) continue;
          const base = Math.min(...from.map((s) => layerOf.get(s)!)) + 1;
          for (const tg of t.targets) if (!layerOf.has(tg)) { layerOf.set(tg, base); moved = true; }
        }
      }
    };
    propagate();
    for (let seeded = true; seeded; ) {
      seeded = false;
      for (const t of transitions) {
        if (t.sources.length) continue;
        for (const tg of t.targets) if (!layerOf.has(tg)) { layerOf.set(tg, 1); seeded = true; }
      }
      if (seeded) propagate();
    }
    const maxLayer = layerOf.size ? Math.max(...layerOf.values()) : 0;
    for (const s of stateIds) if (!layerOf.has(s)) layerOf.set(s, maxLayer + 1);

    // Rows: alphabetical, then two barycenter sweeps over source↔target adjacency.
    const layers: string[][] = [];
    for (const [sid, li] of layerOf) (layers[li] ??= []).push(sid);
    for (let i = 0; i < layers.length; i++) layers[i] ??= [];
    const adj = new Map<string, string[]>();
    const link = (a: string, b: string) => { let l = adj.get(a); if (!l) { l = []; adj.set(a, l); } l.push(b); };
    for (const t of transitions) for (const s of t.sources) for (const tg of t.targets) { link(s, tg); link(tg, s); }
    for (const L of layers) L.sort((a, b) => byId.get(a)!.title.localeCompare(byId.get(b)!.title));
    const pos = new Map<string, number>();
    const setPos = () => layers.forEach((L) => L.forEach((s, i) => pos.set(s, i)));
    setPos();
    const idxs = layers.map((_, i) => i);
    for (const order of [idxs.slice(1), idxs.slice(0, -1).reverse()]) {
      for (const li of order) {
        const bary = (x: string) => {
          const neigh = (adj.get(x) ?? []).filter((m) => Math.abs(layerOf.get(m)! - li) === 1);
          return neigh.length ? neigh.reduce((s, m) => s + (pos.get(m) ?? 0), 0) / neigh.length : (pos.get(x) ?? 0);
        };
        layers[li]!.sort((a, b) => bary(a) - bary(b));
        setPos();
      }
    }

    const targeted = new Set(transitions.flatMap((t) => t.targets));
    const ids = new Set([...stateIds, ...transitions.map((t) => t.id), aggId]);
    return {
      aggregate: { id: aggId, title: agg.title },
      states: stateIds.map((sid) => {
        const n = byId.get(sid)!;
        return {
          id: sid, member: n.title.split("·").pop()!.trim(), title: n.title,
          initial: initial.has(sid), layer: layerOf.get(sid)!, row: pos.get(sid) ?? 0,
          review: reviewOf(sid), trust: trustOf(n.status, reviews.get(`node:${sid}`)),
        };
      }),
      transitions,
      edges: graph.edges
        .filter((e) => (ids.has(e.from) || ids.has(e.to)) && present(e) &&
          ["state_of", "transition_of", "transitions_to", "on_event", "initial_state", "from_state"].includes(e.type))
        .map((e) => ({ from: e.from, to: e.to, type: e.type })),
      unenriched: transitions.filter((t) => !t.enriched).map((t) => t.id),
      unreachable: stateIds.filter((sid) => !targeted.has(sid) && !initial.has(sid)),
      hasDynamic: transitions.some((t) => t.dynamic),
    };
  });

  return { aggregates, aggregate: opts.aggregate ?? null, machines };
}

/** One flow: its ordered steps, each with touched modules + the live source of its anchors. */
export async function flow(root: string, id: string) {
  const [nodes, graph, store, annStore] = await Promise.all([loadNodes(root), readGraph(root), readAnchorStore(root), readAnnotations(root)]);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const anchorById = new Map(store.anchors.map((a) => [a.id, a]));
  const annFor = (aid: string) => annStore.annotations.filter((a) => a.target.kind === "anchor" && a.target.id === aid);
  const proc = byId.get(id);
  if (!proc) return { error: `no flow "${id}"` };

  const stepNodes = graph.edges
    .filter((e) => e.type === "step_of" && e.to === id)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((e) => byId.get(e.from))
    .filter((n): n is LogicalNode => Boolean(n));

  const allAnchorIds = [...new Set(stepNodes.flatMap((s) => s.anchors))];
  // Include the process node's own anchors so its code review derives too (rare —
  // most process nodes cite steps, not code — but keeps the flow node consistent).
  const revAnchorIds = [...new Set([...proc.anchors, ...allAnchorIds])];
  const revTargets = [
    { kind: "node" as const, id },
    ...stepNodes.map((s) => ({ kind: "node" as const, id: s.id })),
    ...revAnchorIds.map((aid) => ({ kind: "anchor" as const, id: aid })),
  ];
  // Two passes: the vouch (`signed`/`checked`) and the `viewed` exposure marks. The
  // flow-level targeted diff is the roll-up of *stale* marks — steps you'd reviewed
  // whose code has since drifted (never-reviewed steps are a first-look bucket, not
  // "changed since you looked"), so a re-review targets only the delta.
  const [rev, revView] = await Promise.all([
    reviewStatesFor(root, revTargets),
    reviewStatesFor(root, revTargets, { viewed: true }),
  ]);
  const isStale = (p?: ReviewPair) => Boolean(p && (p.code.state === "stale" || p.logical.state === "stale"));
  // A node's code review is derived from its cited segments (see deriveCodeReview),
  // never a one-click node-code sign — the per-anchor code buttons below are the
  // real controls. Reads from the anchor reviews already fetched above.
  const deriveNodeCode = (anchorIds: string[]) =>
    deriveCodeReview(anchorIds.filter((aid) => anchorById.has(aid)).map((aid) => rev.get("anchor:" + aid)!.code));
  const withDerivedCode = (nodeId: string, anchorIds: string[]) => {
    const codeReview = deriveNodeCode(anchorIds);
    const rp = rev.get("node:" + nodeId);
    return { review: { logical: rp?.logical ?? { state: "unreviewed" as const }, code: { state: codeReview.state, actor: codeReview.actor ?? undefined } }, codeReview };
  };
  const touchesByStep = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.type !== "touches") continue;
    (touchesByStep.get(e.from) ?? touchesByStep.set(e.from, []).get(e.from)!).push(e.to);
  }

  // Cache live-indexed files so a step's several anchors in one file re-index once.
  // loc offsets index the parsed source STRING — web-tree-sitter returns UTF-16
  // code-unit indices (matching node.text), NOT UTF-8 byte offsets. Slice the
  // decoded string; slicing the raw buffer shifts the window left by the extra
  // UTF-8 bytes of any multi-byte char (em dash, §, …) before the anchor.
  const fileCache = new Map<string, { src: string; byId: Map<string, Anchor> }>();
  const codeFor = async (a: Anchor): Promise<string | null> => {
    let fc = fileCache.get(a.file);
    if (!fc) {
      try {
        const src = await readFile(join(root, a.file), "utf8");
        fc = { src, byId: new Map((await indexFile(join(root, a.file), a.file)).map((x) => [x.id, x])) };
      } catch {
        fc = { src: "", byId: new Map() };
      }
      fileCache.set(a.file, fc);
    }
    const live = fc.byId.get(a.id);
    return live?.loc ? fc.src.slice(live.loc.startByte, live.loc.endByte) : null;
  };

  const steps = [];
  const changedSigned: string[] = [];
  const changedViewed: string[] = [];
  let order = 0;
  for (const s of stepNodes) {
    const anchors = [];
    for (const aid of s.anchors) {
      const a = anchorById.get(aid);
      if (!a) { anchors.push({ id: aid, missing: true }); continue; }
      anchors.push({ id: a.id, symbol: a.symbolPath.join(" › "), file: a.file, lines: a.loc ? `${a.loc.startLine}-${a.loc.endLine}` : undefined, startLine: a.loc?.startLine, kind: a.kind, lang: langFor(a.file), code: await codeFor(a), review: rev.get("anchor:" + a.id), viewed: revView.get("anchor:" + a.id), annotations: annFor(a.id) });
    }
    // A step "changed since signed/viewed" iff its own mark or any of its anchors'
    // marks went stale under that attestation.
    const stepSigned = isStale(rev.get("node:" + s.id)) || anchors.some((a) => isStale((a as { review?: ReviewPair }).review));
    const stepViewed = isStale(revView.get("node:" + s.id)) || anchors.some((a) => isStale((a as { viewed?: ReviewPair }).viewed));
    if (stepSigned) changedSigned.push(s.id);
    if (stepViewed) changedViewed.push(s.id);
    steps.push({
      id: s.id, title: s.title, summary: s.summary, body: s.body, order: order++,
      ...withDerivedCode(s.id, s.anchors), viewed: revView.get("node:" + s.id),
      changed: { signed: stepSigned, viewed: stepViewed },
      touches: (touchesByStep.get(s.id) ?? []).map((tid) => ({ id: tid, title: byId.get(tid)?.title ?? tid })),
      anchors,
    });
  }
  return {
    id, title: proc.title, summary: proc.summary, body: proc.body,
    ...withDerivedCode(id, proc.anchors), viewed: revView.get("node:" + id),
    // The targeted diff: step ids that have drifted under each mark since you reviewed.
    changed: { signed: changedSigned, viewed: changedViewed },
    // Review-complete rollup over the flow's step anchors ("am I done with this flow?").
    coverage: await triageCoverageFor(root, allAnchorIds.map((aid) => ({ kind: "anchor" as const, id: aid }))),
    steps,
  };
}

export async function getAnchor(root: string, id: string) {
  const [store, nodes, bugStore, annStore] = await Promise.all([
    readAnchorStore(root), loadNodes(root), readBugs(root), readAnnotations(root),
  ]);
  let anchor = store.anchors.find((a) => a.id === id);
  // Three places to look, and WHICH one answered is part of the answer.
  //
  // The working tree first. Then any cached commit snapshot — during a pull-request
  // review that is where the files the branch ADDS live, and this is the read path a
  // reviewer reaches for first, so refusing them here while `annotate` accepts them
  // is the tool disagreeing with itself. Then retained anchors, whose code is gone
  // everywhere but whose last known state is still worth returning: the finding on
  // it is real, and the reader needs to learn the CODE went, not that the id is wrong.
  const off = anchor ? undefined : findAnchorsOutsideWork(root, [id]).get(id);
  if (!anchor && off) anchor = off.anchor;
  const orphaned = !anchor;
  if (!anchor) anchor = readOrphans(root, [id]).get(id);
  if (!anchor) return { error: `no anchor "${id}"` };

  // Resolve the code live so it is always exact — from the commit that holds it when
  // the working tree does not.
  let code: string | null = null;
  let present = false;
  try {
    if (off) {
      const src = readBlobs(root, off.ref, [anchor.file]).get(anchor.file);
      const live = src ? (await indexBlob(src, anchor.file)).find((a) => a.id === id) : undefined;
      if (src && live?.loc) { code = src.slice(live.loc.startByte, live.loc.endByte); present = true; }
    } else {
    const src = await readFile(join(root, anchor.file), "utf8"); // loc index the parsed string, not raw bytes
    const fresh = await indexFile(join(root, anchor.file), anchor.file);
    const live = fresh.find((a) => a.id === id);
    if (live?.loc) {
      code = src.slice(live.loc.startByte, live.loc.endByte);
      present = true;
    }
    }
  } catch {
    /* file gone */
  }
  const citing = nodes.filter((n) => n.anchors.includes(id));
  const citeReviews = await reviewStatesFor(root, citing.map((n) => ({ kind: "node" as const, id: n.id })));
  // Dynamic, like `mirrorNote`: the agnostic core does not depend on the sidecar,
  // and a shared store that is missing or unreadable must not fail a local read
  // that worked before shared docs existed.
  const sharedCites = await import("./ops-shared.js")
    .then((m) => m.sharedDocsCiting(root, [id]))
    .catch(() => null);
  return {
    ...anchorBrief(anchor),
    present,
    code,
    // WHICH version this is. The working tree is a third thing during a PR review —
    // neither the PR under review nor whatever branch the reader last had in mind —
    // and a response that just says "current" invites all three to be conflated.
    sourceRef: orphaned ? "@orphan" : off ? off.ref : "@work",
    sourceCommit: off ? off.ref : headCommit(root),
    ...(off ? {
      offTree: true,
      offTreeNote: `${anchor.file} is not in the working tree — this is the body at ${off.ref.slice(0, 12)}${snapshotBranch(root, off.ref) ? ` (${snapshotBranch(root, off.ref)})` : ""}, which is where the code actually lives. The tree is on another branch.`,
    } : {}),
    ...(orphaned ? {
      orphaned: true,
      orphanedNote: `this symbol is no longer in the working tree — ${anchor.file} › ${anchor.symbolPath.join(" › ")} was retained because findings or reviews point at it. \`code\` is null; the last known body hash is ${anchor.bodyHash}. It may exist on a branch: check a PR head before concluding it was deleted.`,
    } : {}),
    // citedBy carries the trust ladder so "what documents this code, and can I
    // trust it?" is answerable from the anchor alone.
    citedBy: citing.map((n) => {
      const rp = citeReviews.get(`node:${n.id}`);
      return { id: n.id, title: n.title, status: n.status ?? "fresh", trust: trustOf(n.status, rp) };
    }),
    // Separate from `citedBy` rather than merged: one is this machine's store and
    // the other is the sidecar's, and merging them makes "who says so"
    // unanswerable from the reply.
    ...(sharedCites?.length ? { sharedDocs: sharedCites } : {}),
    bugs: bugStore.bugs.filter((b) => b.anchors.includes(id)).map((b) => ({ id: b.id, title: b.title, status: b.status })),
    annotations: annStore.annotations.filter((a) => a.target.kind === "anchor" && a.target.id === id),
    lang: langFor(anchor.file),
    review: await reviewStatus(root, { kind: "anchor", id }),
    // The `viewed` exposure marks, separate from the vouch above, so the UI can show
    // "looked at" distinctly from "signed off" (and each with its own staleness).
    viewed: await reviewStatus(root, { kind: "anchor", id }, { viewed: true }),
    // Stakes + resulting severity (stakes × attestation gap). See docs/triage.md.
    triage: await triageStatus(root, { kind: "anchor", id }),
  };
}

/**
 * A node's referenced code segments as a review queue — each cited anchor with its
 * live source, code review + viewed marks, ordered by file then position (reading
 * order). Powers the dedicated code-review page, where you read & sign each segment
 * in one place instead of hopping to a per-anchor page. `codeReview` is the derived
 * rollup; `files` lists the distinct files touched (for the file modal).
 */
export async function nodeReview(root: string, id: string) {
  const [nodes, store, annStore] = await Promise.all([loadNodes(root), readAnchorStore(root), readAnnotations(root)]);
  const node = nodes.find((n) => n.id === id);
  if (!node) return { error: `no node "${id}"` };
  const byId = new Map(store.anchors.map((a) => [a.id, a]));
  const annFor = (aid: string) => annStore.annotations.filter((a) => a.target.kind === "anchor" && a.target.id === aid);
  const targets = node.anchors.map((aid) => ({ kind: "anchor" as const, id: aid }));
  const [rev, revView] = await Promise.all([reviewStatesFor(root, targets), reviewStatesFor(root, targets, { viewed: true })]);
  // Cache live-indexed files so several anchors in one file re-index once. loc
  // offsets index the parsed source string (UTF-16 units), so slice the string.
  const fileCache = new Map<string, { src: string; byId: Map<string, Anchor> }>();
  const load = async (file: string) => {
    let fc = fileCache.get(file);
    if (!fc) {
      try { const src = await readFile(join(root, file), "utf8"); fc = { src, byId: new Map((await indexFile(join(root, file), file)).map((x) => [x.id, x])) }; }
      catch { fc = { src: "", byId: new Map() }; }
      fileCache.set(file, fc);
    }
    return fc;
  };
  const segments = [];
  for (const aid of node.anchors) {
    const a = byId.get(aid);
    if (!a) { segments.push({ id: aid, missing: true as const }); continue; }
    const fc = await load(a.file);
    const live = fc.byId.get(aid);
    segments.push({
      id: a.id, symbol: a.symbolPath.join(" › "), file: a.file, kind: a.kind, lang: langFor(a.file),
      startLine: a.loc?.startLine ?? 0, lines: a.loc ? `${a.loc.startLine}-${a.loc.endLine}` : undefined,
      present: Boolean(live?.loc), code: live?.loc ? fc.src.slice(live.loc.startByte, live.loc.endByte) : null,
      review: rev.get("anchor:" + aid), viewed: revView.get("anchor:" + aid),
      annotations: annFor(aid), // line-pinned findings + segment notes
    });
  }
  segments.sort((x, y) => ((x as { file?: string }).file ?? "").localeCompare((y as { file?: string }).file ?? "") || ((x as { startLine?: number }).startLine ?? 0) - ((y as { startLine?: number }).startLine ?? 0));
  const codeReview = deriveCodeReview(segments.filter((s) => !("missing" in s) && s.review).map((s) => (s as { review: ReviewPair }).review.code));
  const files = [...new Set(segments.filter((s) => !("missing" in s)).map((s) => (s as { file: string }).file))];
  const openFindings = annStore.annotations.filter((a) => a.target.kind === "anchor" && node.anchors.includes(a.target.id) && !a.resolved && (a.kind === "finding" || a.kind === "question")).length;
  return { id, title: node.title, type: node.type, summary: node.summary, files, segments, codeReview, openFindings };
}

/**
 * Whole-file source + the stored anchors within it (line ranges + code review /
 * viewed marks) — for the review page's file modal, so a segment can be read in
 * full-file context and signed there.
 */
export async function fileSource(root: string, file: string) {
  // `file` arrives from a query string. `join` happily resolves `../` out of the
  // repo, so without this the endpoint reads any file the server user can — it
  // served /etc/hostname. Resolve and require containment; the static handler
  // guards its own paths, this one did not.
  const abs = resolve(root, file);
  const base = resolve(root);
  if (abs !== base && !abs.startsWith(base + sep)) return { error: `"${file}" is outside this universe` };

  const [store, annStore] = await Promise.all([readAnchorStore(root), readAnnotations(root)]);
  const inFile = store.anchors.filter((a) => a.file === file);
  let code: string;
  try { code = await readFile(abs, "utf8"); } catch { return { error: `cannot read "${file}"` }; }
  const live = new Map((await indexFile(join(root, file), file)).map((x) => [x.id, x]));
  const targets = inFile.map((a) => ({ kind: "anchor" as const, id: a.id }));
  const [rev, revView] = await Promise.all([reviewStatesFor(root, targets), reviewStatesFor(root, targets, { viewed: true })]);
  const anchors = inFile.map((a) => {
    const lv = live.get(a.id);
    return {
      id: a.id, symbol: a.symbolPath.join(" › "), kind: a.kind,
      startLine: lv?.loc?.startLine ?? a.loc?.startLine ?? null,
      endLine: lv?.loc?.endLine ?? a.loc?.endLine ?? null,
      present: Boolean(lv?.loc),
      review: rev.get("anchor:" + a.id), viewed: revView.get("anchor:" + a.id),
      annotations: annStore.annotations.filter((an) => an.target.kind === "anchor" && an.target.id === a.id),
    };
  }).sort((x, y) => (x.startLine ?? 0) - (y.startLine ?? 0));
  return { file, lang: langFor(file), code, anchors };
}

/** Set/raise stakes on a target (ratchet-enforced). See docs/triage.md. */
export async function setTriage(
  root: string,
  input: { targetKind: "node" | "anchor"; targetId: string; importance?: Importance; complexity?: Complexity; source: TriageSource; reason?: string; tripwire?: boolean },
) {
  return triageSet(root, input);
}

/**
 * Every annotation on one anchor, as the walkthrough renders them.
 *
 * Returned alongside every annotation write so a caller can refresh the one symbol
 * that changed. Raising, handing a finding to an agent, resolving one or raising it
 * to the maintainer all used to reload the whole PR story, which on a large pull
 * request is seconds of work to learn what happened to a single anchor.
 */
export async function anchorAnnotations(root: string, anchorId: string) {
  const anns = (await readAnnotations(root)).annotations;
  return anns.filter((a) => a.target.kind === "anchor" && a.target.id === anchorId);
}

/**
 * One anchor's review/viewed marks and severity, exactly as the walkthrough
 * renders them. Returned by the review write so a sign-off can update the symbol
 * in place — re-deriving the whole PR story to learn one symbol's new state was
 * what made signing feel slow on a large pull request.
 */
export async function anchorMark(root: string, id: string, opts: { ref?: string } = {}) {
  const rt = await reviewTriageFor(root, [{ kind: "anchor", id }], { ref: opts.ref });
  const e = rt.get(`anchor:${id}`);
  return {
    id,
    severity: e?.triage.severity ?? "untriaged",
    reviewed: e?.review.code.state === "reviewed",
    viewed: e?.viewed.code.state === "reviewed",
    review: e?.review.code,
    viewedMark: e?.viewed.code,
  };
}

/** Clear a target's stakes (back to untriaged). */
export async function clearTriage(root: string, input: { targetKind: "node" | "anchor"; targetId: string }) {
  return triageClear(root, input);
}

/** Graph-derive `likely` stakes across the whole map (regenerable). See docs/triage.md Phase 2. */
export async function deriveTriage(root: string) {
  return triageDerive(root);
}

/** Tripwires: armed watch-marks whose code has moved (`fired`) + the armed count. */
export async function tripwires(root: string) {
  return triageTripwires(root);
}

/** Triage marks whose witnessed code drifted — re-triage candidates. */
export async function triageDriftList(root: string) {
  return triageDrift(root);
}

/**
 * Targeted diff — which anchors covered by a target have moved since the human last
 * `viewed` / `signed` it. The read behind "what changed since I last looked?".
 */
export async function changedSince(
  root: string,
  /** `ref` says what "now" is — pass the PR head when asking about a PR sign-off. */
  input: { targetKind: "node" | "anchor"; targetId: string; level: ReviewLevel; attestation: Attestation; ref?: string },
) {
  return reviewsChangedSince(root, { kind: input.targetKind, id: input.targetId }, { level: input.level, attestation: input.attestation, ref: input.ref });
}

// ---------------------------------------------------------------------------
// Documenting
// ---------------------------------------------------------------------------

/**
 * Resolve human-friendly anchor refs (file#Symbol, file#Symbol(*), file:line, or
 * raw id) → ids, keeping the failures alongside what resolved.
 *
 * Write ops PARTIALLY ACCEPT: a doc is saved with the anchors that resolved and
 * the rejects come back as `rejectedAnchors`, because the alternative — the whole
 * call discarded over one ambiguous overload — cost the caller a re-send of the
 * entire body. The "no floating claims" invariant is unchanged: a node still can
 * not exist with zero anchors, so a call where NOTHING resolves is still an error.
 */
async function resolveRefs(
  root: string, refs: string[], scopeRef?: string,
  opts: { includeOrphans?: boolean } = {},
): Promise<{ ids: string[]; errors: string[] }> {
  const store = await readAnchorStore(root);
  let anchors = store.anchors;
  if (opts.includeOrphans) {
    // Code the working tree does not have, that somebody's work still points at.
    // Resolvable so a filed finding can still be read and revised — one that cannot
    // even be addressed is indistinguishable from one that was deleted.
    //
    // Two sources, and both are needed. `@orphan` is code gone from everywhere; a
    // commit SNAPSHOT holds code that exists on a branch, which during a PR review
    // is most of what is worth annotating — the files the branch ADDS are not in the
    // working tree at all, so requiring the caller to name the ref made the common
    // case the one that failed.
    const byId = new Map(anchors.map((a) => [a.id, a]));
    const missing = refs.filter((r) => /^a_[0-9a-f]+$/.test(r) && !byId.has(r));
    if (missing.length) {
      for (const [id, hit] of findAnchorsOutsideWork(root, missing)) if (!byId.has(id)) byId.set(id, hit.anchor);
      for (const [id, a] of readOrphans(root, missing)) if (!byId.has(id)) byId.set(id, a);
      anchors = [...byId.values()];
    }
  }
  if (scopeRef) {
    // A symbol that exists only on a PR's head is not a floating claim — it is in
    // this store, under that commit's ref. Union those anchors in so a finding can
    // be raised on code that has not merged yet. The invariant holds: the citation
    // still has to resolve against anchors the store actually holds, and an id that
    // is in neither @work nor `scopeRef` is still rejected.
    const snap = await readSnapshot(root, scopeRef);
    if (snap) {
      const byId = new Map(anchors.map((a) => [a.id, a]));
      for (const a of snap) if (!byId.has(a.id)) byId.set(a.id, a);
      anchors = [...byId.values()];
    }
  }
  return resolveAnchorRefs(anchors, refs);
}

/** `rejectedAnchors: […]` for a result, or nothing when every ref resolved. */
const rejected = (errors: string[]) => (errors.length ? { rejectedAnchors: errors } : {});

// --- shared helpers for authoring ---
const LINK_RE = /\[\[([^\]]+)\]\]/g;
function extractLinks(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(text)) !== null) out.push(m[1]!.trim());
  return out;
}
function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}
function addEdge(graph: { edges: Edge[] }, e: Edge): boolean {
  if (graph.edges.some((x) => x.from === e.from && x.to === e.to && x.type === e.type)) return false;
  graph.edges.push(e);
  return true;
}

interface StepInput { id?: string; title: string; summary: string; anchors: string[]; touches?: string[]; body?: string }

export async function document(
  root: string,
  input: { id?: string; type: LogicalNodeType; title: string; summary: string; anchors: string[]; body?: string; steps?: StepInput[]; ref?: string },
) {
  // `ref` documents code as a branch leaves it: anchors resolve against that
  // commit's snapshot as well as @work, and the version's accepted hashes are
  // captured there — otherwise a doc written while reviewing a PR would cite
  // symbols the working tree has never seen and match nothing.
  const r = await resolveRefs(root, input.anchors, input.ref);
  const wopts = input.ref ? { hashes: await snapshotHashes(root, input.ref), commit: input.ref, branch: null } : {};
  // Partial acceptance — but a node with no anchors is a floating claim, so a call
  // where nothing resolved is still rejected outright.
  if (!r.ids.length) return { error: r.errors.join("; ") || "no anchors given" };
  const id = input.id ?? slug(input.title);
  const body = input.body ?? "";
  await writeNode(root, { id, type: input.type, title: input.title, summary: input.summary, anchors: r.ids, body }, wopts);

  const result: Record<string, unknown> = { ok: true, id, anchors: r.ids.length, ...rejected(r.errors) };

  // P1.2 — inline ordered steps materialize step nodes + step_of + touches edges.
  if (input.type === "process" && input.steps?.length) {
    const graph = await readGraph(root);
    const allNodes = await loadNodes(root);
    const taken = new Set(allNodes.map((n) => n.id)); // includes the process just written
    // Re-documenting a process must UPDATE its steps, not mint a second set. Ids came
    // from `uniqueSlug` against every existing node, so a second promotion of the same
    // chapter produced `command-2`, `handler-2`, … and a second run of `step_of`
    // edges — the flow-walker then rendered the same flow twice. The promotion guard
    // explicitly permits re-promoting a section, and the UI advertises it, so this is
    // a path the product invites.
    const existingSteps = new Map(
      graph.edges.filter((e) => e.type === "step_of" && e.to === id)
        .map((e) => [allNodes.find((n) => n.id === e.from)?.title, e.from] as const)
        .filter((x): x is readonly [string, string] => typeof x[0] === "string"),
    );
    const created: string[] = [];
    const warnings: string[] = [];
    let i = 0;
    for (const step of input.steps) {
      const sr = await resolveRefs(root, step.anchors, input.ref);
      // A step with nothing resolved is SKIPPED, not fatal: the process node and
      // its other steps are already written, so aborting here would leave the map
      // half-built and the caller re-sending everything.
      if (!sr.ids.length) { warnings.push(`step "${step.title}" skipped — no anchor resolved: ${sr.errors.join("; ")}`); i++; continue; }
      for (const e of sr.errors) warnings.push(`step "${step.title}": ${e}`);
      const stepId = step.id ?? existingSteps.get(step.title) ?? uniqueSlug(slug(step.title), taken);
      taken.add(stepId);
      await writeNode(root, { id: stepId, type: "step", title: step.title, summary: step.summary, anchors: sr.ids, body: step.body ?? "" }, wopts);
      created.push(stepId);
      addEdge(graph, { from: stepId, to: id, type: "step_of", order: i });
      for (const t of step.touches ?? []) {
        if (taken.has(t)) addEdge(graph, { from: stepId, to: t, type: "touches" });
        else warnings.push(`step "${step.title}" touches unknown node "${t}"`);
      }
      i++;
    }
    await writeGraph(root, graph);
    result.steps = created;
    if (warnings.length) result.warnings = warnings;
  }

  // P1.4 — flag [[links]] that don't resolve to a node (target may come later).
  const known = new Set((await loadNodes(root)).map((n) => n.id));
  const dangling = [...new Set(extractLinks(input.summary + "\n" + body))].filter((l) => !known.has(l));
  if (dangling.length) result.danglingLinks = dangling;
  return result;
}

/** P1.3 — add one edge or many in a single call (same-universe; use `link` for cross). */
export async function connect(
  root: string,
  input: { from?: string; to?: string; type?: EdgeType; order?: number; edges?: { from: string; to: string; type: EdgeType; order?: number }[] },
) {
  const list = input.edges ?? (input.from && input.to && input.type ? [{ from: input.from, to: input.to, type: input.type, order: input.order }] : []);
  if (!list.length) return { error: "provide an edge (from/to/type) or edges[]" };
  const nodeIds = new Set((await loadNodes(root)).map((n) => n.id));
  const graph = await readGraph(root);
  let added = 0;
  const errors: string[] = [];
  for (const e of list) {
    const missing = [e.from, e.to].filter((x) => !nodeIds.has(x));
    if (missing.length) {
      errors.push(`unknown node(s): ${missing.join(", ")}`);
      continue;
    }
    if (addEdge(graph, { from: e.from, to: e.to, type: e.type, order: e.order })) added++;
  }
  await writeGraph(root, graph);
  return { ok: true, added, edges: graph.edges.length, ...(errors.length ? { errors } : {}) };
}

/** P1.3 — patch a node without resending the whole body. */
export async function updateNode(
  root: string,
  input: { id: string; setTitle?: string; setSummary?: string; setBody?: string; addAnchors?: string[]; removeAnchors?: string[] },
) {
  const nodes = await loadNodes(root);
  const node = nodes.find((n) => n.id === input.id);
  if (!node) return { error: `no node "${input.id}"` };
  if (input.setTitle !== undefined) node.title = input.setTitle;
  if (input.setSummary !== undefined) node.summary = input.setSummary;
  if (input.setBody !== undefined) node.body = input.setBody;
  const rejects: string[] = [];
  if (input.addAnchors?.length) {
    const r = await resolveRefs(root, input.addAnchors);
    rejects.push(...r.errors); // partial: add what resolved, report the rest
    for (const a of r.ids) if (!node.anchors.includes(a)) node.anchors.push(a);
  }
  if (input.removeAnchors?.length) {
    // Raw ids (a_…) are removed literally so a vanished/orphaned anchor ref can be
    // dropped even when it no longer resolves; other refs are resolved normally.
    const rm = new Set(input.removeAnchors.filter((r) => /^a_[0-9a-f]+$/.test(r)));
    const refs = input.removeAnchors.filter((r) => !/^a_[0-9a-f]+$/.test(r));
    if (refs.length) {
      const r = await resolveRefs(root, refs);
      rejects.push(...r.errors);
      r.ids.forEach((id) => rm.add(id));
    }
    node.anchors = node.anchors.filter((a) => !rm.has(a));
  }
  if (!node.anchors.length) return { error: "a node must keep ≥1 anchor (no floating claims)" };
  await writeNode(root, node);
  const known = new Set(nodes.map((n) => n.id));
  const dangling = [...new Set(extractLinks(node.summary + "\n" + node.body))].filter((l) => !known.has(l));
  return { ok: true, id: node.id, anchors: node.anchors.length, ...rejected(rejects), ...(dangling.length ? { danglingLinks: dangling } : {}) };
}

/**
 * Confirm the winning doc version is still accurate at the current code (no edit,
 * no fork) — clears `stale` by accepting the current hashes. The right move when a
 * change touched the code a doc cites but the doc's claims still hold.
 */
export async function confirm(root: string, id: string) {
  return confirmNode(root, id);
}

/** Marks a queued question as one of these, so a second `ackHole` finds it. */
export const UNPLACEABLE_CATEGORY = "unplaceable-doc";

/**
 * Ack a hole: the doc's cited code was removed here and that's correct → tombstone
 * it on this branch (disappears from this branch's map; still live on branches
 * where the code exists). Only valid when the doc is `dangling`.
 *
 * A doc whose citations this build cannot place at all is a different answer and
 * gets a different one: the removal is refused — an incomparable absence is not
 * evidence of absence, and hiding is the direction with no recovery — and the
 * attempt is FILED as work instead of returned as an error. See
 * docs/anchor-id-provenance.md § "Clearing a doc nobody can place".
 *
 * Entered by the ACT, never by the state. A `HASH_SCHEME` bump made 985 of 985 docs
 * unverifiable at once, so queueing every such doc would deliver that store's whole
 * catalogue as a work list; queueing one person's attempt to clear one doc is
 * bounded by attempts.
 */
export async function ackHole(root: string, id: string) {
  const r = await storeAckHole(root, id);
  // On the evidence, not the headline status — the store refuses a tombstone
  // whenever anything is unplaceable, and a version with one gone citation and one
  // foreign one reads `dangling`.
  if (!r.unplaceable?.length) return r;

  const open = (await readAnnotations(root)).annotations.find((a) =>
    a.target.kind === "node" && a.target.id === id && a.category === UNPLACEABLE_CATEGORY && !a.resolved);
  if (open) {
    // Filing and assigning are two writes, so an item can exist unassigned — and the
    // dedupe would then keep answering `alreadyQueued` about something no queue
    // shows. Repair it rather than file a second.
    if (!open.assignment) await assignAnnotation(root, { id: open.id, kind: "investigate", by: "ack_hole" });
    return { ...r, queued: open.id, alreadyQueued: true };
  }

  const where = (c: { anchorId: string; file?: string; symbol?: string; marks: string[] }) =>
    `  ${c.anchorId}${c.file ? ` — last seen at ${c.file} › ${c.symbol}` : " — no record of it anywhere"}`
    + `${c.marks.length ? `, minted under ${c.marks.join(", ")}` : ""}`;
  // `annotate` mirrors to the sidecar, and that is wanted here rather than tolerated:
  // "this build cannot place these ids" is a fact about ONE build, and a teammate
  // whose build minted them can answer it outright. A question only the asker can
  // see is the one shape this is least useful in.
  const filed = await annotate(root, {
    targetKind: "node", targetId: id, kind: "question", category: UNPLACEABLE_CATEGORY,
    author: "ack_hole",
    text: [
      `This doc cannot be retired: its citations were minted by a build whose anchor derivation this one cannot reproduce, so "the code is gone" is not something anybody here can establish.`,
      ``,
      `Version ${r.versionId}, written at ${r.createdCommit ?? "an unrecorded commit"}.`,
      ``,
      `Cannot be placed:`,
      ...r.unplaceable.map(where),
      ...(r.alsoGone?.length
        ? [``, `Also cited, resolved, and gone from this tree: ${r.alsoGone.join(", ")}. Those are decidable; the ones above are what block retiring it.`]
        : []),
      ``,
      `Work out where that code went — index the commit above and read the symbol path off your own snapshot of it, then let git say what happened to the file since. Re-cite the doc against ids THIS build mints and it becomes an ordinary doc again. If the subject is genuinely gone, report that: retiring is a person's act.`,
    ].join("\n"),
  }) as { id?: string; error?: string };
  // Said, not swallowed: the caller asked for this doc to be dealt with, and a
  // refusal that also failed to file the work is a different answer from one that
  // filed it.
  if (!filed.id) return { ...r, queueError: filed.error ?? "could not file the question" };
  const handed = await assignAnnotation(root, { id: filed.id, kind: "investigate", by: "ack_hole" }) as { error?: string };
  if (handed.error) return { ...r, queued: filed.id, queueError: handed.error };
  return { ...r, queued: filed.id };
}

/** All versions of a node, each with its per-branch status (for the version UI). */
export async function nodeVersions(root: string, id: string) {
  const versions = await loadNodeVersions(root, id);
  const store = await readAnchorStore(root);
  // `evalVersion`, not a second copy of it. This function used to reimplement the
  // rule with raw `work.has` / `sameBody` — which is why it was the one surface the
  // provenance work did NOT reach when the type of the index changed: a duplicate
  // implementation is invisible to a typed seam. Two copies of a status rule is how
  // the version UI and the version selection start disagreeing about one doc.
  const work = anchorIndex(
    new Map(store.anchors.map((a) => [a.id, a.bodyHash])),
    derivationsOf(store.anchors),
    derivationLookup(root),
  );
  return {
    id,
    versions: versions.map((v) => {
      const e = evalVersion(v, work);
      return {
        versionId: v.versionId, title: v.title, summary: v.summary, removed: !!v.removed,
        createdCommit: v.createdCommit, createdBranch: v.createdBranch, createdAt: v.createdAt,
        anchors: v.citations.map((c) => c.anchorId),
        status: v.generatedBy ? "generated" : e.status,
        staleAnchors: e.stale, danglingAnchors: e.dangling,
        unverifiableAnchors: e.unverifiable ?? [],
      };
    }),
  };
}

/** Delete a logical node outright (and any edges touching it) — for obsolete/tombstoned docs. */
export async function removeNode(root: string, id: string) {
  const nodes = await loadNodes(root);
  if (!nodes.some((n) => n.id === id)) return { error: `no node "${id}"` };
  await storeDeleteNode(root, id);
  const graph = await readGraph(root);
  const kept = graph.edges.filter((e) => e.from !== id && e.to !== id);
  if (kept.length !== graph.edges.length) await writeGraph(root, { edges: kept });
  return { ok: true, deleted: id, removedEdges: graph.edges.length - kept.length };
}

/** P1.4 — every dangling [[link]] across the universe. */
export async function linksReport(root: string) {
  const nodes = await loadNodes(root);
  const known = new Set(nodes.map((n) => n.id));
  const dangling: { node: string; danglingLinks: string[] }[] = [];
  for (const n of nodes) {
    const bad = [...new Set(extractLinks(n.summary + "\n" + n.body))].filter((l) => !known.has(l));
    if (bad.length) dangling.push({ node: n.id, danglingLinks: bad });
  }
  return { danglingCount: dangling.reduce((s, d) => s + d.danglingLinks.length, 0), nodes: dangling };
}

// ---------------------------------------------------------------------------
// Bugs
// ---------------------------------------------------------------------------

export async function reportBug(
  root: string,
  input: { title: string; description: string; anchors: string[]; severity?: BugSeverity },
) {
  const r = await resolveRefs(root, input.anchors);
  // Partial acceptance (see resolveRefs) — a bug still needs somewhere to point.
  if (!r.ids.length) return { error: r.errors.join("; ") || "no anchors given" };
  const anchorIds = r.ids;
  const store = await readAnchorStore(root);
  const files = anchorIds.map((id) => store.anchors.find((a) => a.id === id)!.file);
  const live = await liveAnchors(root, files);
  const witnesses = anchorIds.map((id) => ({ anchorId: id, bodyHash: live.get(id)?.bodyHash ?? "sha256:absent" }));
  const bug: Bug = {
    id: genId("bug"),
    title: input.title,
    status: "open",
    severity: input.severity ?? "medium",
    description: input.description,
    anchors: anchorIds,
    witnesses,
    createdCommit: headCommit(root),
    history: ["opened"],
  };
  const bugStore = await readBugs(root);
  bugStore.bugs.push(bug);
  await writeBugs(root, bugStore.bugs);
  return { ok: true, id: bug.id };
}

/** List bugs, flagging those whose anchored code changed since filing ("possibly fixed"). */
export async function listBugs(root: string, opts: { status?: BugStatus } = {}) {
  const [bugStore, store] = await Promise.all([readBugs(root), readAnchorStore(root)]);
  let bugs = bugStore.bugs;
  if (opts.status) bugs = bugs.filter((b) => b.status === opts.status);
  const files = new Set<string>();
  for (const b of bugs) for (const id of b.anchors) {
    const a = store.anchors.find((x) => x.id === id);
    if (a) files.add(a.file);
  }
  const live = await liveAnchors(root, files);
  const idx = liveIndex(root, live);
  return {
    counts: bugStore.bugs.reduce((m, b) => ((m[b.status] = (m[b.status] ?? 0) + 1), m), {} as Record<string, number>),
    bugs: bugs.map((b) => {
      const changed = realDrift(witnessDrift(b.witnesses, idx)).map((c) => c.anchorId);
      return {
        id: b.id, title: b.title, status: b.status, severity: b.severity,
        anchors: b.anchors,
        possiblyFixed: b.status === "open" && changed.length > 0,
        // Code moved under the bug regardless of status (a closed bug whose code
        // changed may warrant a fresh look); `possiblyFixed` narrows this to open.
        codeChanged: changed.length > 0,
        changedAnchors: changed,
      };
    }),
  };
}

/**
 * Full detail for one bug: prose, history, and each cited anchor resolved to its
 * live symbol/file/lines with a `stale` flag (the anchor's code changed since the
 * bug's witness was taken — same witness-hash mechanism as doc/review staleness).
 */
export async function bugDetail(root: string, id: string) {
  const [bugStore, store] = await Promise.all([readBugs(root), readAnchorStore(root)]);
  const bug = bugStore.bugs.find((b) => b.id === id);
  if (!bug) return { error: `no bug "${id}"` };
  const byId = new Map(store.anchors.map((a) => [a.id, a]));
  const files = new Set<string>();
  for (const aid of bug.anchors) { const a = byId.get(aid); if (a) files.add(a.file); }
  const live = await liveAnchors(root, files);
  const idx = liveIndex(root, live);
  const witness = new Map(bug.witnesses.map((w) => [w.anchorId, w.bodyHash]));
  const anchors = bug.anchors.map((aid) => {
    const a = byId.get(aid);
    const liveA = live.get(aid);
    const witHash = witness.get(aid);
    const loc = liveA?.loc ?? a?.loc;
    const w = witHash === undefined ? [] : [{ anchorId: aid, bodyHash: witHash }];
    return {
      id: aid,
      symbol: a ? a.symbolPath.join(" › ") : aid.slice(0, 12),
      file: a?.file ?? null,
      lines: loc ? `${loc.startLine}-${loc.endLine}` : null,
      present: !!liveA,
      // Stale when we have a witness and the live code no longer matches it — but
      // an id this build could not have minted is not a body that moved, and saying
      // so needs the resolution rather than `?? ABSENT_HASH`.
      stale: witHash !== undefined && realDrift(witnessDrift(w, idx)).length > 0,
      // And `present: false` alone would move the confident claim rather than remove
      // it: absent + not-stale renders as "renamed or removed, and the bug is
      // unaffected". This says which of the two absences it is.
      unverifiable: witHash !== undefined && !liveA
        && witnessDrift(w, idx).some((c) => c.unverifiable),
    };
  });
  const changed = anchors.filter((a) => a.stale).length;
  return {
    id: bug.id, title: bug.title, status: bug.status, severity: bug.severity,
    description: bug.description, createdCommit: bug.createdCommit, history: bug.history,
    anchors, staleAnchors: changed, possiblyFixed: bug.status === "open" && changed > 0,
  };
}

export async function updateBug(
  root: string,
  input: { id: string; status?: BugStatus; note?: string; addAnchors?: string[]; refreshWitnesses?: boolean },
) {
  const bugStore = await readBugs(root);
  const bug = bugStore.bugs.find((b) => b.id === input.id);
  if (!bug) return { error: `no bug "${input.id}"` };
  const rejects: string[] = [];
  if (input.addAnchors?.length) {
    const r = await resolveRefs(root, input.addAnchors);
    rejects.push(...r.errors); // partial: add what resolved, report the rest
    for (const a of r.ids) if (!bug.anchors.includes(a)) bug.anchors.push(a);
  }
  if (input.status && input.status !== bug.status) {
    bug.history.push(`status: ${bug.status} → ${input.status}`);
    bug.status = input.status;
  }
  if (input.note) bug.history.push(input.note);
  if (input.refreshWitnesses || input.status === "fixed") {
    const store = await readAnchorStore(root);
    const files = bug.anchors.map((id) => store.anchors.find((a) => a.id === id)?.file).filter(Boolean) as string[];
    const live = await liveAnchors(root, files);
    bug.witnesses = bug.anchors.map((id) => ({ anchorId: id, bodyHash: live.get(id)?.bodyHash ?? "sha256:absent" }));
    bug.history.push("witnesses refreshed");
  }
  await writeBugs(root, bugStore.bugs);
  return { ok: true, id: bug.id, status: bug.status, ...rejected(rejects) };
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

// What has to follow a lead word for it to be a verdict rather than a subject. A
// bare "-" counts only when SPACED, so "Partial-write recovery drops the second
// half" opens on a hyphenated word, not on a grade.
const leadTail = (follows: string) =>
  String.raw`(?=[:;,.!]|\s*[\u2014\u2013]|\s+-\s|\s+(?:${follows})\b|\s*$)`;

/**
 * Openings that grade the FINDING instead of describing the code.
 *
 * `comment` is the whole of what reaches the submitter — never the filing, the
 * `text`, the `disposition`, or the earlier revisions (see `renderAnnotation` in
 * pr-push.ts) — so "Confirmed and wider than filed" cites a document they cannot
 * read. Saying so in the tool description did not hold: agents wrote relative copy
 * twice more after reading it, while the length cap, which REFUSES, was obeyed
 * every time. So this refuses too.
 *
 * Deliberately narrow. The lead word only counts when what follows it is
 * verdict-shaped punctuation or a conjunction, which leaves a defect sentence that
 * happens to open on the same word alone: "Partial writes are not rolled back",
 * "Withdrawn tickets still bill". Missing a bad comment costs a re-read; refusing a
 * good one costs the trust that makes the check work at all.
 */
const VERDICT_LEAD = new RegExp(
  String.raw`^(?:confirmed|part(?:ly|ially) confirmed|partial|re-?rated|real|as filed|as reported|still open|false positive|not a (?:bug|defect|finding)|(?:much )?(?:wider|narrower|broader|smaller|bigger|worse|less bad) than (?:filed|reported|stated|described))`
  + leadTail("and|but"), "i");

/**
 * The withdrawal shape, which is legitimate for exactly one disposition — see
 * PUBLISHABLE: `refuted` goes out only where the human already raised the concern
 * on the pull request, so there the reader does share the baseline a retraction
 * needs. On anything still real it reads as "never mind" over a live defect.
 */
const WITHDRAWAL_LEAD = new RegExp(
  String.raw`^(?:withdraw(?:ing|n)|retract(?:ing|ed)|refuted|disregard|never mind|my mistake)`
  + leadTail("this|my|the"), "i");

/**
 * Validate the submitter-facing half of a finding.
 *
 * Over-length is refused rather than truncated, and the error names the cap and the
 * overage: a comment silently cut at 800 characters loses its last sentence, which
 * by the contract in the tool description is the ASK — the one part the person
 * fixing it actually needs.
 */
function checkComment(
  comment: string | undefined, disposition?: string,
): { comment?: string } | { error: string } {
  const c = comment?.trim();
  if (!c) return {};
  if (c.length > COMMENT_MAX) {
    return { error: `comment is ${c.length} characters; the cap is ${COMMENT_MAX}. Cut the investigation — what was checked and what was ruled out belong in \`text\`. Keep: what is broken, file:line proving it, and the ask.` };
  }
  // Emphasis and quoting are not the sentence: "**Confirmed** — ..." opens exactly
  // as "Confirmed — ..." does, and the bolding is the tell, not a defence.
  const bare = c.replace(/[*_]/g, "").replace(/^[\s>#`]+/, "");
  const verdict = VERDICT_LEAD.exec(bare);
  if (verdict) {
    return { error: `comment opens with "${verdict[0]}", which is a verdict on the FINDING. The submitter never sees the finding — not as filed, not the \`text\`, not the \`disposition\` — so an opening that grades it describes a document they cannot read. Open with the defect itself, stated as a fact about the code, then the file:line, then the ask. The verdict goes in \`disposition\`, where it can be filtered on.` };
  }
  const withdrawal = WITHDRAWAL_LEAD.exec(bare);
  if (withdrawal && disposition !== "refuted") {
    return { error: `comment opens with "${withdrawal[0]}" but the disposition is \`${disposition ?? "unset"}\`. A retraction is only readable where the submitter already saw the concern, which is why it is the \`refuted\` shape — published by hand onto a thread that has it. Anything still real leads with what is STILL broken, written as if filed fresh; if this one really is a false positive, set disposition \`refuted\`.` };
  }
  return { comment: c };
}

const checkDisposition = (d: string | undefined): Disposition | undefined =>
  d && (DISPOSITIONS as readonly string[]).includes(d) ? (d as Disposition) : undefined;

/**
 * The body an annotation is being written against, and the ref that body came from.
 *
 * `ref` is a cached commit snapshot (a PR head); without one this is the live index,
 * which during a PR review is the WORKING TREE — a third version of the file that is
 * neither the PR under review nor the branch the reader may have been looking at.
 * Recording which one it was is what makes that confusion detectable later.
 */
async function witnessAt(
  root: string, anchorId: string, ref?: string,
): Promise<{ witness?: { anchorId: string; bodyHash: string }; sourceRef: string }> {
  if (ref) {
    const hash = bodyHashAt(root, ref, anchorId);
    if (hash) return { witness: { anchorId, bodyHash: hash }, sourceRef: ref };
  }
  const stored = (await readAnchorStore(root)).anchors.find((a) => a.id === anchorId);
  if (stored) {
    // Re-index rather than trusting the stored hash: an edit since the last index
    // would witness a body nobody has read.
    const live = (await liveAnchors(root, [stored.file])).get(anchorId);
    if (live) return { witness: { anchorId, bodyHash: live.bodyHash }, sourceRef: "@work" };
  }
  // Not in the working tree. Resolution reaches snapshots and retained anchors, so
  // witnessing has to as well — otherwise a finding on a symbol the branch ADDS gets
  // no witness and claims `@work`, which is both false and exactly the record the
  // cross-branch gate reads.
  const off = findAnchorsOutsideWork(root, [anchorId]).get(anchorId);
  if (off) return { witness: { anchorId, bodyHash: off.anchor.bodyHash }, sourceRef: off.ref };
  const orphan = readOrphans(root, [anchorId]).get(anchorId);
  if (orphan) return { witness: { anchorId, bodyHash: orphan.bodyHash }, sourceRef: "@orphan" };
  return { sourceRef: ref ?? "@work" };
}

export async function annotate(
  root: string,
  input: { targetKind: "anchor" | "node"; targetId: string; text: string; author?: string; kind?: Annotation["kind"]; severity?: BugSeverity; category?: string; line?: number; ref?: string; comment?: string; disposition?: Disposition; publishPath?: string; publishLine?: number; agent?: boolean; model?: string; harness?: string },
) {
  // Validate the target exists (anchor targets accept file#Symbol refs too).
  let targetId = input.targetId;
  let witness: { anchorId: string; bodyHash: string } | undefined;
  let sourceRef: string | undefined;
  if (input.targetKind === "anchor") {
    // A single-target ref is strict: there is nothing partial to accept, and the
    // ambiguity error now carries the candidates' ids and line ranges.
    // Orphans included: re-filing against code the tree no longer has is exactly what
    // someone needs when a reindex has stranded a finding, and refusing it leaves the
    // work unreachable rather than safe.
    const r = await resolveRefs(root, [input.targetId], input.ref, { includeOrphans: true });
    if (!r.ids.length) return { error: r.errors.join("; ") };
    targetId = r.ids[0]!;
    const w = await witnessAt(root, targetId, input.ref);
    witness = w.witness;
    sourceRef = w.sourceRef;
  } else {
    const nodes = await loadNodes(root);
    if (!nodes.some((n) => n.id === input.targetId)) return { error: `unknown node "${input.targetId}"` };
  }
  const line = Number.isFinite(input.line) && (input.line as number) > 0 ? Math.floor(input.line as number) : undefined;
  const KINDS = ["note", "question", "finding", "pointer"] as const;
  const kind = (KINDS as readonly string[]).includes(input.kind ?? "") ? input.kind : "note";
  const SEV = ["low", "medium", "high", "critical"];
  const severity = input.severity && SEV.includes(input.severity) ? input.severity : undefined;
  const category = input.category?.trim() || undefined;
  const c = checkComment(input.comment, input.disposition);
  if ("error" in c) return c;
  // `agent` falls back to the author-string sniff — the very heuristic this replaces —
  // because until every caller passes the flag, dropping it would silently DEFAULT
  // agent findings to `confirmed`, i.e. publishable with nobody vouching. `|| undefined`
  // rather than the bare boolean so a false sniff still lets the env vars decide.
  const looksAgent = (input.author ?? "agent").startsWith("agent");
  const resolved = requireActor(root, {
    agent: input.agent ?? (looksAgent || undefined),
    model: input.model,
    harness: input.harness,
  });
  if ("error" in resolved) return resolved;
  const actor = resolved;
  // Required on findings, not merely encouraged. Twelve findings in the session that
  // motivated this were filed with rich evidence and no short form — because none
  // was asked for — and all twelve were then rewritten by hand for GitHub. An
  // optional field is skipped every time; the round-trip is the thing being removed.
  if (kind === "finding" && !c.comment) {
    return { error: "a finding needs `comment`: what is broken, the file:line that proves it, and the ask — in at most " + COMMENT_MAX + " characters, for the person who has to fix it. The evidence goes in `text`." };
  }
  const ann: Annotation = {
    id: genId(kind || "note"),
    target: { kind: input.targetKind, id: targetId },
    text: input.text,
    kind,
    ...(severity ? { severity } : {}),
    ...(category ? { category } : {}),
    ...(c.comment ? { comment: c.comment } : {}),
    // Every kind carries one, so triage can promote any of them — a `pointer` that
    // investigation confirms is a finding in all but the field it was filed under.
    //
    // The default follows authorship, exactly as `isElected` does: a human writing
    // it IS the assertion, so `confirmed`; an agent's is a proposal awaiting triage,
    // so `open`. Anything else would either make the human re-affirm their own
    // finding before it could be sent, or let an unreviewed agent claim through.
    //
    // Decided from the structured actor, not from the author STRING. The old
    // `author.startsWith("agent")` made the answer depend on a name: a person
    // called "agentina" filed proposals, and an agent labelled anything else filed
    // findings that were publishable without anyone vouching for them. Falls back
    // to the string only for callers that pass no actor at all.
    disposition: checkDisposition(input.disposition)
      ?? (actor ? (isAgentActor(actor) ? "open" : "confirmed")
        : (input.author ?? "agent").startsWith("agent") ? "open" : "confirmed"),
    ...(input.publishPath?.trim() ? { publishPath: input.publishPath.trim() } : {}),
    ...(Number.isFinite(input.publishLine) ? { publishLine: Math.floor(input.publishLine as number) } : {}),
    resolved: false,
    ...(line !== undefined ? { line } : {}),
    ...(witness ? { witness } : {}),
    ...(sourceRef ? { sourceRef } : {}),
    // Both, for now. `author` stays because every existing record has one and the
    // UI reads it; `actor` is what a shared store needs and what the rules check.
    author: input.author ?? (actor ? actorLabel(actor) : "agent"),
    ...(actor ? { actor } : {}),
    createdCommit: headCommit(root),
  };
  const annStore = await readAnnotations(root);
  annStore.annotations.push(ann);
  await writeAnnotations(root, annStore.annotations);
  // Mirrored onto the sidecar when one is configured, because an annotation is
  // codebase knowledge that cost somebody real reading time — leaving it in one
  // person's SQLite means the next person pays for it again.
  //
  // AFTER the local write and never in place of it: codemap worked without a
  // sidecar for its whole life, and a note must not be lost because a shared repo
  // was misconfigured. `mirrorNote` is a no-op when there is nothing to mirror to,
  // and a throw here must not fail a write that has already succeeded locally.
  const { mirrorNote } = await import("./ops-shared.js");
  const mirrored = await mirrorNote(root, {
    id: ann.id, targetKind: input.targetKind, targetId,
    kind: kind ?? "note", text: input.text,
    severity, category, line,
  }).catch(() => ({ shared: false }));
  return { ok: true, id: ann.id, target: ann.target, ...(mirrored.shared ? { shared: true } : {}) };
}

/**
 * Resolve (or re-open) an annotation.
 *
 * `actor: "agent"` may only close a QUESTION — the thing it was asked and has now
 * answered. Closing a finding is the human's act: `closeAssignment` refuses to do it
 * for exactly this reason ("reporting and agreeing it is closed are different
 * acts"), and an agent that could reach the same state through this door would have
 * that guarantee for nothing. It is not only about self-vouching — `resolved` also
 * stops a finding ever reaching the pull request, so it is a way to silently
 * suppress one.
 */
export async function resolveAnnotation(
  root: string, id: string, resolved = true,
  opts: { actor?: "human" | "agent" } = {},
) {
  const annStore = await readAnnotations(root);
  const ann = annStore.annotations.find((a) => a.id === id);
  if (!ann) return { error: `no annotation "${id}"` };
  if (opts.actor === "agent" && (ann.kind ?? "note") !== "question") {
    return { error: `\`${id}\` is a ${ann.kind ?? "note"}, not a question — reporting on it and agreeing it is closed are different acts. Use \`close_finding\` to say what you did; the human closes it after reading.` };
  }
  ann.resolved = resolved;
  await writeAnnotations(root, annStore.annotations);
  return { ok: true, id, resolved, target: ann.target };
}

/**
 * Raise an agent's finding to the pull request's maintainer — or take it back.
 *
 * The one act that makes an agent's proposal publishable. It is deliberately
 * separate from `resolve` and from signing the symbol: reading a finding, agreeing
 * with it, and being willing to put your name on it in front of the author are
 * three different things, and only the third should notify anybody.
 *
 * A human-authored finding needs no flag — writing it was the act — so electing one
 * is refused rather than silently recorded as something it is not.
 */
export async function escalateAnnotation(root: string, input: { id: string; escalate?: boolean; by?: string }) {
  const annStore = await readAnnotations(root);
  const ann = annStore.annotations.find((a) => a.id === input.id);
  if (!ann) return { error: `no annotation "${input.id}"` };
  if (!isAgentAuthored(ann)) return { error: "you wrote this one — it is already yours to publish" };
  if (ann.resolved) return { error: "that finding is resolved; reopen it first if it should go to the maintainer" };
  const escalate = input.escalate !== false;
  ann.escalated = escalate ? { at: new Date().toISOString(), by: input.by || "human" } : undefined;
  await writeAnnotations(root, annStore.annotations);
  return { ok: true, id: ann.id, escalated: escalate, target: ann.target };
}

/**
 * Every annotation already published, across every pull request.
 *
 * The queue is not PR-scoped, so `posted` here means "went out somewhere" — which
 * is the question being asked. Per-PR dedupe stays in `planPrPush`, where the PR
 * is known.
 */
async function pushedAnnotationIds(root: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const rec of Object.values((await readPushes(root)).pushes)) for (const id of rec.annotationIds ?? []) ids.add(id);
  return ids;
}

/**
 * Amend a finding, keeping what it used to say.
 *
 * Findings are filed before they are understood. A report goes in, investigation
 * shows it was overstated or aimed at the wrong line, and the correction has to be
 * visible AS a correction — which is exactly the case where you most want to see
 * what changed and who changed it. Revisions append; nothing is destroyed.
 *
 * Callable by either party: an agent revising its own overstatement is the loop
 * working, and the human sharpening an agent's wording is the normal path to a
 * publishable comment.
 */
export async function reviseAnnotation(
  root: string,
  input: {
    id: string; by?: string; allowPostEdit?: boolean;
    text?: string; comment?: string; disposition?: Disposition; severity?: BugSeverity;
    publishPath?: string; publishLine?: number; publishAttribution?: "agent" | "human";
    /** Where in the anchor's own file this points — the normal way to say it. */
    line?: number;
    /**
     * Re-witness against this ref. Revising after re-reading the code is exactly how
     * a finding blocked as written-against-a-different-body gets cleared, so the
     * re-read has to be recordable — otherwise the only way past the gate would be
     * to ignore it.
     */
    ref?: string;
  },
) {
  const store = await readAnnotations(root);
  const ann = store.annotations.find((a) => a.id === input.id);
  if (!ann) return { error: `no annotation "${input.id}"` };
  // Editing what the submitter can already see, without editing it there too, makes
  // the map and the pull request disagree about what was said — and the pull request
  // is the copy the other person is acting on.
  if (ann.postedRef && !input.allowPostEdit) {
    return { error: `that finding is already posted to PR #${ann.postedRef.pr}${ann.postedRef.url ? ` (${ann.postedRef.url})` : ""}. Revising it here would diverge from what the submitter can see — reply on the pull request instead, or pass allowPostEdit to change the map anyway (which does NOT edit the posted comment).` };
  }

  const c = checkComment(input.comment, input.disposition ?? ann.disposition);
  if ("error" in c) return c;
  const disposition = input.disposition === undefined ? undefined : checkDisposition(input.disposition);
  if (input.disposition !== undefined && !disposition) {
    return { error: `unknown disposition "${input.disposition}" — expected one of ${DISPOSITIONS.join(", ")}` };
  }
  const SEV = ["low", "medium", "high", "critical"];
  if (input.severity !== undefined && !SEV.includes(input.severity)) {
    return { error: `unknown severity "${input.severity}" — expected one of ${SEV.join(", ")}` };
  }

  const was: NonNullable<Annotation["revisions"]>[number]["was"] = {};
  const changed: string[] = [];
  /**
   * `provided` is separate from the value on purpose: a field the caller did not
   * mention must not change, and a field it sent EMPTY must be cleared. Folding the
   * two together meant an empty string read as "no change", so clearing a
   * `publishPath` in the editor silently kept the old one while the form showed it
   * gone — a comment would then have published against a file nobody chose.
   */
  const bump = <K extends keyof typeof was>(k: K, provided: boolean, next: (typeof was)[K] | undefined) => {
    if (!provided || next === (ann as never as Record<string, unknown>)[k]) return;
    (was as Record<string, unknown>)[k] = (ann as never as Record<string, unknown>)[k];
    if (next === undefined) delete (ann as never as Record<string, unknown>)[k];
    else (ann as never as Record<string, unknown>)[k] = next;
    changed.push(k);
  };
  const num = (v: unknown) => (Number.isFinite(v) && (v as number) > 0 ? Math.floor(v as number) : undefined);
  bump("line", input.line !== undefined, num(input.line));
  bump("text", input.text !== undefined, input.text?.trim() || undefined);
  bump("comment", input.comment !== undefined, c.comment);
  bump("disposition", input.disposition !== undefined, disposition);
  bump("severity", input.severity !== undefined, input.severity);
  bump("publishPath", input.publishPath !== undefined, input.publishPath?.trim() || undefined);
  bump("publishLine", input.publishLine !== undefined, num(input.publishLine));
  if (input.publishAttribution) ann.publishAttribution = input.publishAttribution;
  if (input.ref !== undefined && ann.target.kind === "anchor") {
    const w = await witnessAt(root, ann.target.id, input.ref || undefined);
    if (!w.witness) return { error: `could not read ${ann.target.id} at ${input.ref || "@work"} — nothing to witness against` };
    // EXACT, deliberately — not `sameBody`. The assignment below is only
    // PERSISTED if `changed` is non-empty (see the early return further down), so
    // an annotation-only difference has to count as a change or the better-
    // annotated witness is computed, assigned in memory, and dropped.
    if (w.witness.bodyHash !== ann.witness?.bodyHash) {
      was.witness = ann.witness; was.sourceRef = ann.sourceRef;
      changed.push("witness");
    }
    ann.witness = w.witness;
    ann.sourceRef = w.sourceRef;
  }

  if (!changed.length) return { ok: true, id: ann.id, changed: [], note: "nothing to change" };
  (ann.revisions ??= []).push({ at: new Date().toISOString(), by: input.by || "agent", was });
  await writeAnnotations(root, store.annotations);
  return { ok: true, id: ann.id, changed, revisions: ann.revisions.length, target: ann.target };
}

/**
 * The human decides this one is not going to the submitter — without resolving it,
 * because it may still be true and still worth having on the map.
 *
 * Separate from clearing `escalated`, which only exists on an AGENT's finding. A
 * human's own finding is publishable by virtue of having been written, so declining
 * to send it needs a record of its own rather than the absence of one.
 */
export async function withdrawAnnotation(root: string, input: { id: string; withdraw?: boolean; by?: string; reason?: string }) {
  const store = await readAnnotations(root);
  const ann = store.annotations.find((a) => a.id === input.id);
  if (!ann) return { error: `no annotation "${input.id}"` };
  if (ann.postedRef && input.withdraw !== false) {
    return { error: `that finding is already posted to PR #${ann.postedRef.pr} — withdrawing it here would not take it off the pull request. Reply to it there instead.` };
  }
  const withdraw = input.withdraw !== false;
  ann.withdrawn = withdraw
    ? { at: new Date().toISOString(), by: input.by || "human", ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}) }
    : undefined;
  await writeAnnotations(root, store.annotations);
  return { ok: true, id: ann.id, withdrawn: withdraw, target: ann.target };
}

/**
 * Hand a finding to an agent. The reviewer's half of the loop: raising a finding
 * records it, assigning it asks for something to be done about it.
 */
export async function assignAnnotation(
  root: string,
  input: { id: string; kind: "investigate" | "fix"; by?: string; note?: string },
) {
  const store = await readAnnotations(root);
  const ann = store.annotations.find((a) => a.id === input.id);
  if (!ann) return { error: `no annotation "${input.id}"` };
  if (ann.resolved) return { error: "that annotation is already resolved — reopen it before assigning" };
  ann.assignment = { to: "agent", kind: input.kind, at: new Date().toISOString(), by: input.by || "me", note: input.note };
  ann.outcome = undefined; // a re-assignment asks again; the previous answer no longer stands
  await writeAnnotations(root, store.annotations);
  return { ok: true, id: ann.id, assigned: input.kind, target: ann.target };
}

export interface QueueItem {
  id: string;
  kind: Annotation["kind"];
  severity?: BugSeverity;
  category?: string;
  /** Absent under `brief` — `textPreview` carries the head of it instead. */
  text?: string;
  textPreview?: string;
  comment?: string;
  disposition?: Disposition;
  publishState?: PublishState;
  /**
   * False when the target is not in the working tree. The queue used to serve a
   * dangling id with nothing marking it — while `annotate` and `get_anchor` both
   * rejected the same id — so an agent could work from it and never learn the code
   * was gone. `targetAt` says where it was found instead.
   */
  targetResolved?: boolean;
  targetAt?: string;
  postedRef?: Annotation["postedRef"];
  /**
   * Triage state. The queue is the only way the web findings list can see a finding
   * on a symbol the pull request does not touch, and without these three every such
   * row read as live: it offered `resolve` on an already-resolved finding and never
   * `reopen`, and no amount of resolving could take one out of the list. Resolving a
   * dead finding wrote to the store and changed nothing on screen.
   */
  resolved?: boolean;
  withdrawn?: Annotation["withdrawn"];
  escalated?: Annotation["escalated"];
  line?: number;
  author: string;
  /** Absent when listing beyond the assignment queue (`assignedOnly: false`). */
  assignment?: Annotation["assignment"];
  target: Annotation["target"];
  /** Where to look: the anchor's file and symbol, plus its current source. */
  file?: string;
  symbol?: string;
  startLine?: number;
  code?: string;
}

/**
 * What an agent has been asked to act on, with enough context to act without
 * hunting: the finding, the symbol it sits on, and that symbol's current source.
 *
 * Only unresolved, unanswered assignments — an item that already has an `outcome`
 * is waiting on the human, not on the agent, and returning it would have agents
 * redo work someone has not read yet.
 */
export async function reviewQueue(
  root: string,
  opts: {
    includeAnswered?: boolean; brief?: boolean; limit?: number; offset?: number;
    disposition?: string; publishState?: string;
    /**
     * Default true: the queue is "what a human asked an agent to act on", and an
     * assignment is what made it that.
     *
     * `false` lists every finding instead. Without it there was no way to enumerate
     * what had been PUBLISHED — a finding raised by `annotate` and never assigned
     * was posted to GitHub and then invisible to every query, which is a hole under
     * the idempotency rule even though the dedupe itself reads `postedRef` and the
     * push record rather than this.
     */
    assignedOnly?: boolean;
    includeResolved?: boolean;
    /**
     * Exactly these annotations, in the queue's own shape — restricted before
     * paging and before the full form re-indexes a file per row.
     */
    ids?: string[];
  } = {},
) {
  const store = await readAnnotations(root);
  const pushedIds = await pushedAnnotationIds(root);
  const liveIds = new Set((await readAnchorStore(root)).anchors.map((a) => a.id));
  const assignedOnly = opts.assignedOnly !== false;
  let pending = store.annotations.filter((a) => assignedOnly
    ? a.assignment && !a.resolved && (opts.includeAnswered || !a.outcome)
    : (a.kind === "finding" || a.kind === "question") && (opts.includeResolved || !a.resolved));
  if (opts.ids) { const want = new Set(opts.ids); pending = pending.filter((a) => want.has(a.id)); }
  if (opts.disposition) pending = pending.filter((a) => (a.disposition ?? "open") === opts.disposition);
  if (opts.publishState) pending = pending.filter((a) => publishStateOf(a, pushedIds) === opts.publishState);

  const rank = { critical: 0, high: 1, medium: 2, low: 3 } as Record<string, number>;
  pending.sort((x, y) => (rank[x.severity ?? "low"] ?? 3) - (rank[y.severity ?? "low"] ?? 3));
  const total = pending.length;
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.floor(opts.limit as number)) : undefined;
  const page = pending.slice(offset, limit === undefined ? undefined : offset + limit);
  const more = offset + page.length < total;

  // Brief by DEFAULT, because the full form inlines every anchor's source: the first
  // real call of this tool returned 100,882 characters and blew the token limit
  // outright, so the work could not start until it had been dumped to a file and
  // mined with jq. Full source is one `get_anchor` away; a queue you cannot read is
  // not a queue.
  // A dangling target is not an error here — the finding is still real, and the
  // comment on it is the durable artefact. It just has to be VISIBLE, so nobody
  // works from an id that `annotate` and `get_anchor` will both reject.
  const offTree = findAnchorsOutsideWork(root, [...new Set(
    pending.filter((a) => a.target.kind === "anchor" && !liveIds.has(a.target.id)).map((a) => a.target.id),
  )]);
  const keptAnchors = readOrphans(root, [...new Set(
    pending.filter((a) => a.target.kind === "anchor" && !liveIds.has(a.target.id)).map((a) => a.target.id),
  )]);
  const triageState = (a: Annotation) => ({
    ...(a.resolved ? { resolved: true } : {}),
    ...(a.withdrawn ? { withdrawn: a.withdrawn } : {}),
    ...(a.escalated ? { escalated: a.escalated } : {}),
  });
  const targetState = (a: Annotation) => {
    if (a.target.kind !== "anchor" || liveIds.has(a.target.id)) return {};
    const at = offTree.get(a.target.id)?.ref ?? (keptAnchors.has(a.target.id) ? "@orphan" : undefined);
    return { targetResolved: false, ...(at ? { targetAt: at } : {}) };
  };

  if (opts.brief !== false) {
    const brief: QueueItem[] = page.map((a) => ({
      id: a.id, kind: a.kind, severity: a.severity, category: a.category,
      disposition: a.disposition ?? "open", publishState: publishStateOf(a, pushedIds),
      comment: a.comment,
      textPreview: a.text.length > 300 ? a.text.slice(0, 300) + "…" : a.text,
      line: a.line, author: a.author, assignment: a.assignment, target: a.target,
      ...targetState(a),
      ...triageState(a),
      ...(a.postedRef ? { postedRef: a.postedRef } : {}),
    }));
    return {
      total, offset, more, queue: brief,
      hint: "brief — pass brief:false for each symbol's full source, or read one with `get_anchor`.",
    };
  }
  pending = page;
  if (!pending.length) return { total, offset, more, queue: [] as QueueItem[] };

  const anchorIds = [...new Set(pending.filter((a) => a.target.kind === "anchor").map((a) => a.target.id))];
  const anchors = new Map((await readAnchorStore(root)).anchors.filter((a) => anchorIds.includes(a.id)).map((a) => [a.id, a]));
  // A finding ingested against a pull request is written against the PR HEAD's
  // anchors, so one on a symbol the branch ADDS has no `@work` row — and the item
  // came back with no file, no symbol and no source, which is precisely the hunting
  // this surface promises the agent will not have to do. Fall back to the newest
  // cached commit snapshot that holds it.
  const elsewhere = findAnchorsOutsideWork(root, anchorIds.filter((id) => !anchors.has(id)));

  const queue: QueueItem[] = [];
  for (const a of pending) {
    const off = a.target.kind === "anchor" ? elsewhere.get(a.target.id) : undefined;
    const anc = a.target.kind === "anchor" ? (anchors.get(a.target.id) ?? off?.anchor) : undefined;
    let code: string | undefined;
    if (anc && off) {
      // Only that commit has this body; read it from the commit, not from disk.
      try {
        const src = readBlobs(root, off.ref, [anc.file]).get(anc.file);
        const live = src ? (await indexBlob(src, anc.file)).find((x) => x.id === anc.id) : undefined;
        if (src && live?.loc) code = src.slice(live.loc.startByte, live.loc.endByte);
      } catch { /* the commit is gone — the finding still stands */ }
    } else if (anc) {
      // Re-index live, as `getAnchor` does. The stored `loc` is from the last index;
      // any edit above the symbol since then shifts the window, so slicing with it
      // hands an agent asked to FIX a finding the wrong text — under a tool
      // description that promises the symbol's current source.
      try {
        const src = await readFile(join(root, anc.file), "utf8");
        const live = (await indexFile(join(root, anc.file), anc.file)).find((x) => x.id === anc.id);
        if (live?.loc) code = src.slice(live.loc.startByte, live.loc.endByte);
      } catch { /* file gone — the finding still stands, the agent will see it missing */ }
    }
    queue.push({
      id: a.id, kind: a.kind, severity: a.severity, category: a.category, text: a.text,
      line: a.line, author: a.author, assignment: a.assignment, target: a.target,
      file: anc?.file, symbol: anc?.symbolPath.join(" › "), startLine: anc?.loc?.startLine, code,
      // Where the source came from, when it is not the working tree — an agent asked
      // to FIX must know it is looking at a branch's body, not at HEAD.
      ...(off ? { atCommit: off.ref } : {}),
      comment: a.comment,
      disposition: a.disposition ?? "open",
      publishState: publishStateOf(a, pushedIds),
      ...targetState(a),
      ...triageState(a),
      ...(a.postedRef ? { postedRef: a.postedRef } : {}),
    });
  }
  return { total, offset, more, queue };
}

/**
 * An agent reporting back. It does NOT resolve the finding — reporting and
 * agreeing it is closed are different acts, and an agent marking its own work
 * done is the accountability hole the whole attestation model avoids.
 *
 * A `fix` touching more than one file is refused. That boundary was drawn
 * deliberately: a multi-file change is work to hand a proper agent, not something
 * a review tool slips into someone's branch. Declining with a reason is a useful
 * answer, so it is recorded as one.
 */
export async function closeAssignment(
  root: string,
  input: {
    id: string; result: "fixed" | "answered" | "declined"; detail: string; files?: string[]; by?: string;
    /** The submitter-facing version of what was found, if this is going to the PR. */
    comment?: string;
    /**
     * Where in the file this actually points. An agent that has just read the code
     * knows the line; until it could say so, the publisher fell back to the enclosing
     * symbol's first changed line and put comments on the wrong member.
     */
    line?: number;
    /**
     * What the investigation concluded. Deliberately NOT folded into `result`:
     * `result` is what the AGENT DID (fixed it, looked into it, declined), and
     * `disposition` is what turned out to be TRUE of the finding. A false positive
     * is `answered` + `refuted` — the agent did answer, and the answer was "not a
     * defect". Collapsing the two would make `result` mean two things at once.
     */
    disposition?: Disposition;
  },
) {
  const store = await readAnnotations(root);
  const ann = store.annotations.find((a) => a.id === input.id);
  if (!ann) return { error: `no annotation "${input.id}"` };
  if (!ann.assignment) return { error: "that annotation was not assigned to an agent" };
  // `assignAnnotation` refuses a resolved annotation for the same reason: an agent
  // holding a queue read from before the human closed this would otherwise stamp an
  // outcome over the record of what happened at close time — and `reviewQueue`
  // filters resolved items out, so the write would be invisible afterwards.
  if (ann.resolved) return { error: "that finding was resolved while you were working on it — reopen it before recording an outcome" };
  const files = input.files ?? [];
  if (input.result === "fixed" && files.length > 1) {
    return { error: `a fix may touch one file; this touched ${files.length} (${files.join(", ")}). Report \`declined\` with what the change needs — a multi-file change belongs to an agent the human dispatches, not to a review-tool edit.` };
  }
  const c = checkComment(input.comment, input.disposition ?? ann.disposition);
  if ("error" in c) return c;
  const disposition = input.disposition === undefined ? undefined : checkDisposition(input.disposition);
  if (input.disposition !== undefined && !disposition) {
    return { error: `unknown disposition "${input.disposition}" — expected one of ${DISPOSITIONS.join(", ")}` };
  }

  // Reporting back is a revision of the finding, so it leaves the same trail: what
  // it said before the investigation is exactly what a reader wants when the
  // investigation changed the answer.
  const line = Number.isFinite(input.line) && (input.line as number) > 0 ? Math.floor(input.line as number) : undefined;
  if (c.comment || disposition || line !== undefined) {
    const was: NonNullable<Annotation["revisions"]>[number]["was"] = {};
    if (c.comment && c.comment !== ann.comment) { was.comment = ann.comment; ann.comment = c.comment; }
    if (disposition && disposition !== ann.disposition) { was.disposition = ann.disposition; ann.disposition = disposition; }
    if (line !== undefined && line !== ann.line) { was.line = ann.line; ann.line = line; }
    if (Object.keys(was).length) (ann.revisions ??= []).push({ at: new Date().toISOString(), by: input.by || "agent", was });
  }
  ann.outcome = { at: new Date().toISOString(), by: input.by || "agent", result: input.result, detail: input.detail, files: files.length ? files : undefined };
  await writeAnnotations(root, store.annotations);
  return { ok: true, id: ann.id, result: input.result, disposition: ann.disposition, awaitingHuman: true, target: ann.target };
}

/**
 * Open questions a human left for the agent during review — the "answer these to
 * improve the docs" queue. Each is resolved to its target's title/symbol + a link.
 */
export async function listQuestions(root: string, opts: { includeResolved?: boolean } = {}) {
  const [annStore, nodes, store] = await Promise.all([readAnnotations(root), loadNodes(root), readAnchorStore(root)]);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const anchorById = new Map(store.anchors.map((a) => [a.id, a]));
  const qs = annStore.annotations.filter((a) => a.kind === "question" && (opts.includeResolved || !a.resolved));
  return {
    total: qs.length,
    open: qs.filter((q) => !q.resolved).length,
    questions: qs.map((q) => {
      const t = q.target.kind === "node" ? nodeById.get(q.target.id) : anchorById.get(q.target.id);
      const label = q.target.kind === "node"
        ? (t as LogicalNode | undefined)?.title ?? q.target.id
        : (t as Anchor | undefined)?.symbolPath.join(" › ") ?? q.target.id;
      return { id: q.id, text: q.text, author: q.author, resolved: !!q.resolved, target: q.target, targetLabel: label };
    }),
  };
}
