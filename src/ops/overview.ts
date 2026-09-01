import { type Anchor, type LogicalNode, type AnchorSelector, type CoverageMark } from "../schema.js";
import { originSlug, currentBranch, defaultBranch, mergeBase, onDefaultBranch } from "../git.js";
import { computeStaleness } from "../stale.js";
import { citedAnchors, isClosed, witnessesOf } from "../shared-bugs.js";
import {
  readAnchorStore, readState, loadNodes, readGraph, readBugs, readAnnotations, readCoverage, writeCoverage,
  listSnapshots, staleSchemeSnapshots, readBlockedScopes, findingCountsByPr,
} from "../store.js";
import { selectAnchors, docPct as computeDocPct, citedPct as computeCitedPct } from "../coverage.js";
import { revertedMarks, witnessDrift, realDrift } from "../reviews.js";
import { loadIgnore } from "../ignore.js";
import { tripwires as triageTripwires } from "../triage.js";
import { resolveSidecar, inUniverse } from "../sidecar-config.js";
import { standardStatus } from "./standard.js";
import { genId, liveIndex, liveAnchors, anchorBrief, coverageFor, loadNodesShared} from "./shared.js";

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

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
  for (const b of bugStore.bugs) bugsByStatus[b.state] = (bugsByStatus[b.state] ?? 0) + 1;
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

// ---------------------------------------------------------------------------
// The landing page's rollups
//
// Three reads the dashboard needs and did NOT have, and every one of them is picked
// for being cheap enough to sit on the page people land on. The expensive shapes are
// deliberately not here: `sharedHub` runs three publish dry runs (the notes one walks
// all 256 buckets) and a branch diff re-indexes the working tree, so both stay on
// their own pages and the cards below deep-link to them. What a rollup owes the
// reader is a number worth opening, not the rows.
// ---------------------------------------------------------------------------

/**
 * The branch you are on — and whether the diff surface can actually answer for it.
 *
 * The second half is the part that is easy to leave out and is the reason this exists.
 * `diff` needs a CACHED snapshot on the base side, and a snapshot written under another
 * `ANCHOR_SCHEME`/`HASH_SCHEME` reads as not cached (see CLAUDE.md § Core invariants) —
 * so a store whose snapshots all predate the current derivation has a `/diff` page that
 * can only ever error, and nothing anywhere said so. `staleSchemeSnapshots` is the same
 * SQL the diff's own resolver consults, asked one step earlier.
 *
 * `base` is the FORK POINT, not the tip of the trunk: a diff against the trunk's current
 * head reports everything that landed on it since you branched as your change.
 */
async function branchRollup(root: string) {
  const branch = currentBranch(root);
  const snaps = await listSnapshots(root);
  const stale = new Set(staleSchemeSnapshots(root));
  const usable = snaps.filter((s) => !stale.has(s.ref));

  let trunk: string | null = null, onTrunk = true, base: { ref: string; branch: string | null; at: string } | null = null;
  try {
    onTrunk = onDefaultBranch(root);
    trunk = defaultBranch(root);
    if (!onTrunk) {
      // `origin/<trunk>` first: a stale local trunk forks earlier than the branch really
      // did, which silently widens the diff by everything that landed on it meanwhile.
      const fork = mergeBase(root, "HEAD", `origin/${trunk}`) ?? mergeBase(root, "HEAD", trunk);
      base = usable.find((s) => s.ref === fork)
        ?? usable.find((s) => s.branch === trunk || s.branch === `origin/${trunk}`)
        ?? null;
    }
  } catch { /* gitless, or a detached head — the card degrades to "no base" */ }

  return {
    branch, trunk, onTrunk, base,
    /** Cached under a derivation this build cannot compare against. Re-cache with `codemap snapshot`. */
    staleSnapshots: snaps.length - usable.length,
    /** No base to diff against — the review surface is unavailable, not merely empty. */
    noBase: !onTrunk && !base,
  };
}

/**
 * Findings and the team, without the publish dry runs.
 *
 * `findingCountsByPr` is one grouped query over the canonical table, so it counts the
 * team's rows and this machine's alike and works on a store with no sidecar at all —
 * which matters, because a finding filed locally is still somebody's queue. `waiting`
 * is `needs_ack`: a person has to look at it.
 *
 * The sidecar half reads the STORED fold verdict (`shared_scope`), never the shards, for
 * the reason `readBlockedScopes` gives. A fork is the one item here a person must act on
 * and `heal` is theirs alone, so it is reported as its own flag rather than buried in a
 * count of blocked scopes.
 */
async function reviewRollup(root: string) {
  const perPr = await findingCountsByPr(root);
  const findings = {
    total: perPr.reduce((n, r) => n + r.total, 0),
    waiting: perPr.reduce((n, r) => n + r.waiting, 0),
    unshared: perPr.reduce((n, r) => n + r.unshared, 0),
    prs: perPr.length,
  };
  // The BACKLOG's own buckets, not a second count of them. Two rollups of one pile
  // disagree the moment either changes, and this page had already shipped that failure
  // once at the level above: `attention` summed docs and bugs while the standard and the
  // sidecar were in trouble. Building a second attention number here that could not see
  // an overdue carry would be the identical defect, one subsystem over.
  const { findingBacklog } = await import("../ops-shared.js");
  const b = await findingBacklog(root).catch(() => null);
  const cfg = resolveSidecar(root);
  const sidecar = cfg
    ? await readBlockedScopes(root).then((rows) => {
      const blocked = rows.filter((x) => inUniverse(x.scope, cfg.universe));
      return { universe: cfg.universe, blocked: blocked.length, forked: blocked.some((x) => /fork/i.test(x.reason)) };
    })
    : null;
  return { findings, sidecar, backlog: b ? { ...b.counts, attention: b.attention, landed: b.byLanding.landed } : null };
}

/**
 * The standard's queues, or null where there is no standard.
 *
 * `standardStatus` and not a second implementation of its six counts: it computes exactly
 * these already, and a landing page that recomputed them would drift from the hub the
 * pills link to. Its cost is the six projection reads plus `served()`'s scope check, which
 * folds only when the shards have moved — the same read the standard hub does on every
 * visit, so this is not new work per page, it is the same work one page earlier.
 *
 * Null, not zeros, when the read fails: a universe with no standard and a standard that
 * could not be read must not render as a clean one.
 */
async function standardRollup(root: string) {
  try { return await standardStatus(root); } catch { return null; }
}

/**
 * "Needs attention" rollup for the universe landing page. Composes the cheap,
 * side-effect-free signals the whole system computes — coverage, doc-version
 * status (stored on the node, so no check_stale run here), bug re-validation, the
 * standard's queues, findings waiting on a person, and the branch's review
 * readiness — into one work-queue summary. `attention` is the count a human should
 * clear.
 *
 * **`attention` has to reach every subsystem, and for a while it did not.** It summed
 * docs and bugs only, so the page rendered its green "nothing stale — docs and bugs are
 * current with the code" while the standard had overdue scrubs and acknowledgements past
 * revalidation, findings sat waiting on a human, and the sidecar's writer id was FORKED.
 * A landing page that says a universe is clean is making a claim about the universe, not
 * about the two subsystems it happens to read. `dashboard-attention.test.ts` fails if a
 * new queue is added above and left out of the sum.
 */
export async function dashboard(root: string) {
  const [{ store, nodes, result }, graph, bugStore, annStore, branch, review, standard] = await Promise.all([
    coverageFor(root), readGraph(root), readBugs(root), readAnnotations(root),
    branchRollup(root), reviewRollup(root), standardRollup(root),
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
  for (const b of bugStore.bugs) for (const id of citedAnchors(b)) { const a = store.anchors.find((x) => x.id === id); if (a) bugFiles.add(a.file); }
  const live = await liveAnchors(root, bugFiles);
  const bugIndex = liveIndex(root, live);
  const bugCounts: Record<string, number> = {};
  let openBugs = 0, possiblyFixed = 0, unverifiableBugs = 0;
  for (const b of bugStore.bugs) {
    bugCounts[b.state] = (bugCounts[b.state] ?? 0) + 1;
    // Through `witnessDrift` rather than an inline `sameBody`, which also fixes a
    // second conflation this line had: a witness from another HASH_SCHEME counted as
    // possibly-fixed too. `realDrift` is what separates "the code moved" from
    // "nobody can say", and this rollup is a count people act on.
    if (!isClosed(b.state)) {
      openBugs++;
      const changes = witnessDrift(witnessesOf(b), bugIndex);
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
    branch, review, standard,
    // The single number a reviewer/agent should drive to zero.
    reverted: reverted.length,
    attention: staleDocs + danglingDocs + possiblyFixed + openQuestions + tw.fired.length + reverted.length
      + attentionFromStandard(standard) + attentionFromReview(review)
      // ONE item, not one per stale snapshot: the reader's job here is "re-cache the
      // base", which is a single act however many rows are behind it.
      + (branch.noBase ? 1 : 0),
  };
}

/**
 * The standard's contribution to `attention`.
 *
 * `overdue.acknowledgements` and NOT `queues.acknowledgementsDue`: `standardStatus`
 * computes both from one `silenced()` call precisely so they cannot disagree, which
 * makes summing both a double count of the same rows.
 */
function attentionFromStandard(s: Awaited<ReturnType<typeof standardRollup>>): number {
  if (!s) return 0;
  const q = s.queues;
  return s.overdue.scrubs + s.overdue.acknowledgements
    + q.pendingSpecs + q.awaitingAdjudication + q.actionableProblems
    + q.promotableAudits + q.settledWithoutAdjudication;
}

/**
 * Findings and the team's contribution to `attention`.
 *
 * `waiting` only — the total is a workload, not a queue, and a page that counted every
 * open finding would never reach zero on a repo anyone reviews. A fork is one item
 * because `heal` is one act; blocked scopes are counted individually because each is a
 * different scope that answers non-authoritatively until somebody looks at it.
 */
function attentionFromReview(r: Awaited<ReturnType<typeof reviewRollup>>): number {
  // The backlog's number, not `findings.waiting` beside it. `needsAck` is a PROPERTY of
  // some open findings, not a queue of its own — every one of them is already in a
  // backlog bucket, so summing both counts the same records twice. Falling back to
  // `waiting` only where the backlog could not be computed at all.
  return (r.backlog ? r.backlog.attention : r.findings.waiting)
    + (r.sidecar ? r.sidecar.blocked + (r.sidecar.forked ? 1 : 0) : 0);
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
  const nodes = await loadNodesShared(root);
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

/**
 * The documentation work queue: only `open` anchors, ranked by likely value.
 *
 * A symbol a TEAMMATE has documented is not open work, and this used to say it was
 * — the map read `nodes`, which is one person's store, so a doc synced last week
 * came back as a gap. That is the product's north star running backwards, and it is
 * what PROPOSAL-sidecar-materialization.md §6 means by exposing shared docs through
 * the ordinary reads.
 *
 * They come out of `open` and are reported separately rather than merged into it:
 * the action is different (read theirs, do not write a second) and so is the
 * authority. Every match is an exact anchor-id equality, so a hit is a doc that
 * really cites this symbol, not a guess.
 */
export async function findGaps(
  root: string,
  opts: { pathPrefix?: string; kind?: string; limit?: number } = {},
) {
  // `coverageFor` folds the docs scope and computes coverage from the DECIDING subset,
  // so a teammate's doc counts and a blocked scope's does not. Both halves live there
  // because the state is computed there — a blocked citation has already made its
  // anchor `cited` by the time this function could filter anything.
  const { store, nodes, result, verdict } = await coverageFor(root);
  let open = store.anchors.filter((a) => result.state.get(a.id) === "open");
  if (opts.pathPrefix) open = open.filter((a) => a.file.startsWith(opts.pathPrefix!));
  if (opts.kind) open = open.filter((a) => a.kind === opts.kind);

  // Reported so the action is "go and read theirs", not "write a second doc about the
  // same code". Read off the same rows coverage used, so the list and the suppression
  // cannot disagree.
  const byAnchor = new Map<string, { nodeId: string; title: string; by?: string; status: string }[]>();
  if (!verdict?.excludeFromDecisions.size) {
    for (const n of nodes) {
      if (!n.origin) continue;
      for (const id of n.anchors) (byAnchor.get(id) ?? byAnchor.set(id, []).get(id)!).push(
        { nodeId: n.id, title: n.title ?? "", ...(n.author ? { by: n.author } : {}), status: n.status ?? "" });
    }
  }

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
    ...(byAnchor.size ? {
      documentedByTeam: {
        count: byAnchor.size,
        anchors: [...byAnchor].slice(0, limit).map(([anchorId, docs]) => ({ anchorId, docs })),
      },
    } : {}),
  };
}

/** Add a coverage/scope rule (P0.2/P0.3): mark selected anchors covered/trivial/deferred/owned. */
export async function cover(
  root: string,
  input: { as: CoverageMark; node?: string; owner?: string; select: AnchorSelector },
) {
  if (input.as === "owned" && !input.owner) return { error: "`owned` requires `owner` (the universe that owns the doc)" };
  if (input.as === "covered" && input.node) {
    const nodes = await loadNodesShared(root);
    if (!nodes.some((n) => n.id === input.node)) return { error: `unknown node "${input.node}"` };
  }
  const store = await readAnchorStore(root);
  const matched = selectAnchors(store.anchors, input.select);
  if (!matched.length) return { error: "selector matched 0 anchors — check pathPrefix/file/kind/symbol" };
  const cov = await readCoverage(root);
  const id = genId("rule");
  cov.rules.push({ id, as: input.as, node: input.node, owner: input.owner, select: input.select });
  await writeCoverage(root, cov.rules);
  // `deferred` and `owned` OUTRANK the `[tests]` bin — `resolveCoverage` resolves a rule
  // before consulting `isTest` (`coverage.ts`, "scope wins"). So a rule of those two kinds
  // over a test path silently suppresses the bin for exactly those anchors, and the bin
  // then appears to do nothing. That happened for real on a live universe and cost an
  // afternoon, because nothing said so and there was no way to take the rule back.
  const ignore = await loadIgnore(root);
  const shadowed = (input.as === "deferred" || input.as === "owned")
    ? matched.filter((a) => ignore.isTest(a.file, false))
    : [];
  return {
    ok: true, id, as: input.as, matched: matched.length,
    sample: matched.slice(0, 5).map((a) => a.symbolPath.join(".")),
    ...(shadowed.length ? {
      warning:
        `${shadowed.length} of these anchors are in the \`[tests]\` bin, and \`${input.as}\` OUTRANKS it — `
        + `they will read \`${input.as}\` rather than \`tests\`. That is usually not what you want: the bin `
        + `already keeps tests out of the documentation denominator, and this rule is one machine's local `
        + `state while the bin is a repo-wide fact. Drop it with \`uncover ${id}\` if it was a mistake.`,
    } : {}),
  };
}

/**
 * The coverage rules in force on THIS machine, with what each currently selects.
 *
 * There was no way to see them at all, which is half of why the interaction above went
 * undiagnosed: the only evidence a rule existed was the coverage number it moved.
 */
export async function coverageRules(root: string) {
  const [cov, store, ignore] = await Promise.all([readCoverage(root), readAnchorStore(root), loadIgnore(root)]);
  return {
    /** Which declaration the `[tests]` bin came from — `none` means nobody has made one. */
    ignoreSource: ignore.source,
    rules: cov.rules.map((r) => {
      const matched = selectAnchors(store.anchors, r.select);
      return {
        ...r, matched: matched.length,
        sample: matched.slice(0, 5).map((a) => a.symbolPath.join(".")),
        shadowsTests: (r.as === "deferred" || r.as === "owned")
          && matched.some((a) => ignore.isTest(a.file, false)),
      };
    }),
  };
}

/**
 * Take a coverage rule back.
 *
 * `cover` only ever pushed, so a rule was permanent short of editing the `coverage` meta
 * key by hand — which is what somebody had to do after a `deferred` rule turned out to be
 * shadowing the `[tests]` bin. An affordance that can only be applied is not a policy
 * mechanism, it is a ratchet.
 */
export async function uncover(root: string, input: { id: string }) {
  const cov = await readCoverage(root);
  const rule = cov.rules.find((r) => r.id === input.id);
  if (!rule) {
    return {
      error: cov.rules.length
        ? `no coverage rule "${input.id}" — \`coverage_rules\` lists the ${cov.rules.length} in force`
        : `no coverage rule "${input.id}": this universe has none`,
    };
  }
  await writeCoverage(root, cov.rules.filter((r) => r.id !== input.id));
  return { ok: true, removed: rule, remaining: cov.rules.length - 1 };
}

