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
import { join } from "node:path";
import {
  type Anchor, type LogicalNode, type LogicalNodeType, type EdgeType, type State,
  type Bug, type BugStatus, type BugSeverity, type Annotation,
  type AnchorSelector, type CoverageMark, type CoverageState, type Edge, type ReviewLevel, type Importance, type Complexity, type TriageSource,
  SCHEMA_VERSION,
} from "./schema.js";
import { indexFile, indexRepo, indexCommit } from "./repo.js";
import { headCommit, currentBranch, isDirty, revParse, mergeBase, originSlug } from "./git.js";
import { computeStaleness } from "./stale.js";
import {
  readAnchorStore, readState, writeState, writeStore, loadNodes, readGraph, writeGraph, writeNode, slug,
  readBugs, writeBugs, readAnnotations, writeAnnotations, readCoverage, writeCoverage, readReviews,
  writeSnapshot, readSnapshot, listSnapshots, deleteNode as storeDeleteNode, confirmNode, ackHole as storeAckHole, loadNodeVersions,
} from "./store.js";
import { GRAMMAR_VERSIONS } from "./grammar-versions.js";
import { computeDiff, anchorCodeDiff, docDiff as computeDocDiff } from "./diff.js";
import { prTriage, listOpenPrs, prPacket, prStory, prAnchorCode } from "./pr.js";
import { parseAgentLines, ingestAgentReview } from "./pr-ingest.js";
import { resolveCoverage, selectAnchors, docPct as computeDocPct, citedPct as computeCitedPct, type CoverageResult } from "./coverage.js";
import { resolveAnchorRefs } from "./refs.js";
import { refreshAnalyzers } from "./analyzers/run.js";
import { applyIndexUpdate } from "./sync.js";
import { grammarForPath } from "./grammars.js";
import { reviewStatus, reviewStatesFor, anchorReviewMap, changedSince as reviewsChangedSince, deriveCodeReview, type Attestation, type ReviewPair, type DerivedCodeReview } from "./reviews.js";
import { setTriage as triageSet, clearTriage as triageClear, triageStatus, reviewTriageFor, deriveTriage as triageDerive, coverageFor as triageCoverageFor, rollupCoverage, tripwires as triageTripwires, triageDrift } from "./triage.js";

const HL_LANG: Record<string, string> = { c_sharp: "csharp", python: "python", javascript: "javascript", typescript: "typescript", tsx: "typescript" };
const langFor = (file: string) => HL_LANG[grammarForPath(file) ?? ""] ?? "plaintext";

function genId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

/** Re-index the given files and return current anchors by id (source of truth for "now"). */
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
  const anchorIds = new Set(store.anchors.map((a) => a.id));
  const danglingIds = new Set(nodes.filter((n) => n.anchors.some((a) => !anchorIds.has(a))).map((n) => n.id));
  const staleIds = new Set(stale.flaggedNodes.map((f) => f.node.id));
  const danglingDocs = danglingIds.size;
  const staleDocs = [...staleIds].filter((id) => !danglingIds.has(id)).length;

  // Bug re-validation: live re-index of bug-cited files vs each bug's witness.
  const bugFiles = new Set<string>();
  for (const b of bugStore.bugs) for (const id of b.anchors) { const a = store.anchors.find((x) => x.id === id); if (a) bugFiles.add(a.file); }
  const live = await liveAnchors(root, bugFiles);
  const bugCounts: Record<string, number> = {};
  let openBugs = 0, possiblyFixed = 0;
  for (const b of bugStore.bugs) {
    bugCounts[b.status] = (bugCounts[b.status] ?? 0) + 1;
    if (b.status === "open") { openBugs++; if (b.witnesses.some((w) => live.get(w.anchorId)?.bodyHash !== w.bodyHash)) possiblyFixed++; }
  }

  const openQuestions = annStore.annotations.filter((a) => a.kind === "question" && !a.resolved).length;

  // Fired tripwires: business-critical code someone is watching that has since moved.
  let tw: Awaited<ReturnType<typeof triageTripwires>> = { fired: [], armedCount: 0 };
  try { tw = await triageTripwires(root); } catch { /* best-effort */ }

  return {
    coverage: { docPct: computeDocPct(result.breakdown), citedPct: computeCitedPct(result.breakdown), open: result.breakdown.open, anchors: store.anchors.length, nodes: nodes.length, edges: graph.edges.length, breakdown: result.breakdown },
    views: availableViews(tallyTypes(nodes), { prs: !!originSlug(root) }), // which extra views this map can offer
    docs: { total: nodes.length, stale: staleDocs, dangling: danglingDocs, fresh: nodes.length - staleDocs - danglingDocs },
    bugs: { total: bugStore.bugs.length, open: openBugs, possiblyFixed, byStatus: bugCounts },
    annotations: annStore.annotations.length,
    openQuestions,
    tripwires: { fired: tw.fired.map((f) => ({ kind: f.target.kind, id: f.target.id, importance: f.importance, reason: f.reason })), armed: tw.armedCount },
    baselineCommit: commit,
    // The single number a reviewer/agent should drive to zero.
    attention: staleDocs + danglingDocs + possiblyFixed + openQuestions + tw.fired.length,
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
  const anchors = await indexRepo(root);
  const commit = headCommit(root);
  const branch = currentBranch(root);
  for (const a of anchors) a.lastVerifiedCommit = commit;
  const state: State = { schemaVersion: SCHEMA_VERSION, lastVerifiedCommit: commit, branch, grammarVersions: GRAMMAR_VERSIONS };
  await writeStore(root, anchors, state);
  if (commit) await writeSnapshot(root, commit, branch, anchors, new Date().toISOString());
  const files = new Set(anchors.map((a) => a.file)).size;
  return { ok: true, anchors: anchors.length, files, commit, branch };
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
  const anchorIds = new Set(store.anchors.map((a) => a.id));
  const danglingDocs = nodes
    .map((n) => ({ n, missing: n.anchors.filter((a) => !anchorIds.has(a)) }))
    .filter((x) => x.missing.length > 0)
    .map(({ n, missing }) => ({ node: n.id, title: n.title, missingAnchors: missing }));
  // Bring the anchor store up to date (new anchors resolve; moved locs refreshed),
  // then keep any analyzer-covered graph current.
  const indexUpdate = await applyIndexUpdate(root);
  const refreshed = await refreshAnalyzers(root, { changed });
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
  const r = await ingestAgentReview(root, lines, { annotate }, { headRef: t.refs.head, author: opts.author, dryRun: opts.dryRun });
  return { ...r, malformed: bad, pr: t.pr.number, head: t.refs.head };
}

/** The PR's spec-derived walkthrough. */
export async function prStoryFor(root: string, input: string, opts: { fetch?: boolean } = {}) {
  return prStory(root, input, opts);
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
  const rv = (id: string) => reviews.get(id) ?? { code: "unreviewed" as const, logical: "unreviewed" as const, codeActor: null, logicalActor: null };
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
  type Grp = { anchors: number; b: Record<CoverageState, number>; isFile: boolean; rDenom: number; rc: number; rcStale: number; rl: number; rlStale: number };
  const groups = new Map<string, Grp>();
  for (const a of store.anchors) {
    if (!a.file.startsWith(p)) continue;
    const rest = a.file.slice(p.length);
    const slash = rest.indexOf("/");
    const seg = slash === -1 ? rest : rest.slice(0, slash);
    let g = groups.get(seg);
    if (!g) groups.set(seg, (g = { anchors: 0, b: { open: 0, cited: 0, covered: 0, trivial: 0, deferred: 0, owned: 0 }, isFile: slash === -1, rDenom: 0, rc: 0, rcStale: 0, rl: 0, rlStale: 0 }));
    g.anchors++;
    g.b[state(a.id)]++;
    if (inScope(a.id)) { // review % over documentable anchors only
      g.rDenom++;
      const r = rv(a.id);
      if (r.code === "reviewed") g.rc++; else if (r.code === "stale") g.rcStale++;
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
        review: { total: g.rDenom, logical: g.rl, logicalStale: g.rlStale, code: g.rc, codeStale: g.rcStale },
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
  const anchor = store.anchors.find((a) => a.id === id);
  if (!anchor) return { error: `no anchor "${id}"` };
  // Resolve current code live so it is always exact.
  let code: string | null = null;
  let present = false;
  try {
    const src = await readFile(join(root, anchor.file), "utf8"); // loc index the parsed string, not raw bytes
    const fresh = await indexFile(join(root, anchor.file), anchor.file);
    const live = fresh.find((a) => a.id === id);
    if (live?.loc) {
      code = src.slice(live.loc.startByte, live.loc.endByte);
      present = true;
    }
  } catch {
    /* file gone */
  }
  const citing = nodes.filter((n) => n.anchors.includes(id));
  const citeReviews = await reviewStatesFor(root, citing.map((n) => ({ kind: "node" as const, id: n.id })));
  return {
    ...anchorBrief(anchor),
    present,
    code,
    // citedBy carries the trust ladder so "what documents this code, and can I
    // trust it?" is answerable from the anchor alone.
    citedBy: citing.map((n) => {
      const rp = citeReviews.get(`node:${n.id}`);
      return { id: n.id, title: n.title, status: n.status ?? "fresh", trust: trustOf(n.status, rp) };
    }),
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
  const [store, annStore] = await Promise.all([readAnchorStore(root), readAnnotations(root)]);
  const inFile = store.anchors.filter((a) => a.file === file);
  let code: string;
  try { code = await readFile(join(root, file), "utf8"); } catch { return { error: `cannot read "${file}"` }; }
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
  input: { targetKind: "node" | "anchor"; targetId: string; level: ReviewLevel; attestation: Attestation },
) {
  return reviewsChangedSince(root, { kind: input.targetKind, id: input.targetId }, { level: input.level, attestation: input.attestation });
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
async function resolveRefs(root: string, refs: string[], scopeRef?: string): Promise<{ ids: string[]; errors: string[] }> {
  const store = await readAnchorStore(root);
  let anchors = store.anchors;
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
  input: { id?: string; type: LogicalNodeType; title: string; summary: string; anchors: string[]; body?: string; steps?: StepInput[] },
) {
  const r = await resolveRefs(root, input.anchors);
  // Partial acceptance — but a node with no anchors is a floating claim, so a call
  // where nothing resolved is still rejected outright.
  if (!r.ids.length) return { error: r.errors.join("; ") || "no anchors given" };
  const id = input.id ?? slug(input.title);
  const body = input.body ?? "";
  await writeNode(root, { id, type: input.type, title: input.title, summary: input.summary, anchors: r.ids, body });

  const result: Record<string, unknown> = { ok: true, id, anchors: r.ids.length, ...rejected(r.errors) };

  // P1.2 — inline ordered steps materialize step nodes + step_of + touches edges.
  if (input.type === "process" && input.steps?.length) {
    const graph = await readGraph(root);
    const taken = new Set((await loadNodes(root)).map((n) => n.id)); // includes the process just written
    const created: string[] = [];
    const warnings: string[] = [];
    let i = 0;
    for (const step of input.steps) {
      const sr = await resolveRefs(root, step.anchors);
      // A step with nothing resolved is SKIPPED, not fatal: the process node and
      // its other steps are already written, so aborting here would leave the map
      // half-built and the caller re-sending everything.
      if (!sr.ids.length) { warnings.push(`step "${step.title}" skipped — no anchor resolved: ${sr.errors.join("; ")}`); i++; continue; }
      for (const e of sr.errors) warnings.push(`step "${step.title}": ${e}`);
      const stepId = step.id ?? uniqueSlug(slug(step.title), taken);
      taken.add(stepId);
      await writeNode(root, { id: stepId, type: "step", title: step.title, summary: step.summary, anchors: sr.ids, body: step.body ?? "" });
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

/**
 * Ack a hole: the doc's cited code was removed here and that's correct → tombstone
 * it on this branch (disappears from this branch's map; still live on branches
 * where the code exists). Only valid when the doc is `dangling`.
 */
export async function ackHole(root: string, id: string) {
  return storeAckHole(root, id);
}

/** All versions of a node, each with its per-branch status (for the version UI). */
export async function nodeVersions(root: string, id: string) {
  const versions = await loadNodeVersions(root, id);
  const store = await readAnchorStore(root);
  const work = new Map(store.anchors.map((a) => [a.id, a.bodyHash]));
  return {
    id,
    versions: versions.map((v) => {
      const stale = v.removed
        ? v.citations.filter((c) => work.has(c.anchorId)).map((c) => c.anchorId)
        : v.citations.filter((c) => work.has(c.anchorId) && !c.acceptedHashes.includes(work.get(c.anchorId)!)).map((c) => c.anchorId);
      const dangling = v.removed ? [] : v.citations.filter((c) => !work.has(c.anchorId)).map((c) => c.anchorId);
      const status = v.generatedBy ? "generated" : v.removed ? "removed" : dangling.length ? "dangling" : stale.length ? "stale" : "fresh";
      return {
        versionId: v.versionId, title: v.title, summary: v.summary, removed: !!v.removed,
        createdCommit: v.createdCommit, createdBranch: v.createdBranch, createdAt: v.createdAt,
        anchors: v.citations.map((c) => c.anchorId), status, staleAnchors: stale, danglingAnchors: dangling,
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
  return {
    counts: bugStore.bugs.reduce((m, b) => ((m[b.status] = (m[b.status] ?? 0) + 1), m), {} as Record<string, number>),
    bugs: bugs.map((b) => {
      const changed = b.witnesses.filter((w) => live.get(w.anchorId)?.bodyHash !== w.bodyHash).map((w) => w.anchorId);
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
  const witness = new Map(bug.witnesses.map((w) => [w.anchorId, w.bodyHash]));
  const anchors = bug.anchors.map((aid) => {
    const a = byId.get(aid);
    const liveA = live.get(aid);
    const witHash = witness.get(aid);
    const loc = liveA?.loc ?? a?.loc;
    return {
      id: aid,
      symbol: a ? a.symbolPath.join(" › ") : aid.slice(0, 12),
      file: a?.file ?? null,
      lines: loc ? `${loc.startLine}-${loc.endLine}` : null,
      present: !!liveA,
      // stale when we have a witness and the live code no longer matches it.
      stale: witHash !== undefined && (liveA?.bodyHash ?? "sha256:absent") !== witHash,
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

export async function annotate(
  root: string,
  input: { targetKind: "anchor" | "node"; targetId: string; text: string; author?: string; kind?: Annotation["kind"]; severity?: BugSeverity; category?: string; line?: number; ref?: string },
) {
  // Validate the target exists (anchor targets accept file#Symbol refs too).
  let targetId = input.targetId;
  if (input.targetKind === "anchor") {
    // A single-target ref is strict: there is nothing partial to accept, and the
    // ambiguity error now carries the candidates' ids and line ranges.
    const r = await resolveRefs(root, [input.targetId], input.ref);
    if (!r.ids.length) return { error: r.errors.join("; ") };
    targetId = r.ids[0]!;
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
  const ann: Annotation = {
    id: genId(kind || "note"),
    target: { kind: input.targetKind, id: targetId },
    text: input.text,
    kind,
    ...(severity ? { severity } : {}),
    ...(category ? { category } : {}),
    resolved: false,
    ...(line !== undefined ? { line } : {}),
    author: input.author ?? "agent",
    createdCommit: headCommit(root),
  };
  const annStore = await readAnnotations(root);
  annStore.annotations.push(ann);
  await writeAnnotations(root, annStore.annotations);
  return { ok: true, id: ann.id };
}

/** Resolve (or re-open) an annotation — used to close out an answered question. */
export async function resolveAnnotation(root: string, id: string, resolved = true) {
  const annStore = await readAnnotations(root);
  const ann = annStore.annotations.find((a) => a.id === id);
  if (!ann) return { error: `no annotation "${id}"` };
  ann.resolved = resolved;
  await writeAnnotations(root, annStore.annotations);
  return { ok: true, id, resolved };
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
