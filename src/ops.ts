/**
 * The operations behind the MCP tools — a plain async API over a `.codemap/`
 * repo. Kept free of any protocol concern so it can be driven from tests, a
 * CLI, or the MCP server identically.
 *
 * Every operation that writes a claim (document / report_bug / annotate)
 * validates that the anchors it references actually exist — the "no floating
 * claims" invariant, enforced mechanically.
 */

/**
 * This file is a BARREL. The operations themselves live in `src/ops/*.ts`, one
 * module per surface, and every one of them is re-exported here so `ops.js`
 * stays the single import for the front-ends (mcp.ts, serve.ts, cli.ts), the
 * tests, and `web/app.js`'s `ApiMap`.
 *
 * Nothing under `src/ops/` may import from this file — the barrel imports all of
 * them, so a module reaching back closes a cycle. An ES-module cycle resolves to
 * a partially-initialized module rather than an error, and in this repo the
 * symptom is a blank page with nothing in the console (see
 * `src/import-cycles.test.ts`). Shared helpers go DOWN into `src/ops/shared.ts`.
 */

export { type Trust } from "./ops/shared.js";

export { availableViews, status, dashboard, lintSummaries, findGaps, cover } from "./ops/overview.js";

export { reindex, init, checkStale, indexFreshness, snapshot, snapshotAt, snapshots } from "./ops/indexing.js";

export { orphanedWork, type WhereWas, whereWas, whereWere } from "./ops/orphans.js";

export { diff, docDiff, diffCode } from "./ops/diffs.js";

export {
  pr, prPacketFor, prIngest, prWalkthroughSet, prWalkthroughGet, prStoryFor, prOffStoryFindings,
  prStepMark, prChapterMark, prTriageDerive, prPromotePlan, prPromote, prPullViewed, prPullViewedAll,
  prPushPlan, prResolvePlan, prResolvePush, prResolvePull, prPushExecute, prCode, prsFor, prs,
} from "./ops/pr.js";

export {
  nodeCatalog, eventMatrix, getNode, neighborhood, subgraph, flows, pipelineGraph, stateMap, flow,
} from "./ops/graph.js";

export { outline, search, context, getAnchor, nodeReview, fileSource } from "./ops/read.js";

export {
  setTriage, anchorMark, clearTriage, deriveTriage, tripwires, triageDriftList, changedSince,
  queueContestedTriage,
} from "./ops/triage.js";

export {
  document, connect, disconnect, updateNode, confirm, UNPLACEABLE_CATEGORY, ackHole, nodeVersions, removeNode, linksReport,
} from "./ops/docs.js";

export {
  reportBug, listBugs, bugDetail, updateBug, commentBug, trackBugExternally,
  corroborateBugOp, promoteBugOp, requestOnBugOp, resolveBugContestOp, unanchorBugOp,
  publishBugs, acceptFinding,
} from "./ops/bugs.js";

export {
  anchorAnnotations, annotate, resolveAnnotation, escalateAnnotation, reviseAnnotation, withdrawAnnotation,
  assignAnnotation, type QueueItem, reviewQueue, closeAssignment, closeLocalFinding, listQuestions,
} from "./ops/annotations.js";

import { closeAssignment as closeAnnotation, closeLocalFinding as closeLocal } from "./ops/annotations.js";
import { readFinding } from "./store.js";
export { reportDefect, type DefectContext, type DefectInput } from "./ops/defect.js";

/**
 * Report back on whatever `review_queue` handed you — annotation or finding.
 *
 * The queue serves both, so its ids have to be closeable without the caller knowing
 * which store a row lives in. Resolved against the RECORD rather than the id's prefix:
 * `f_`, `finding_` and `bug_` are minted by a generic helper and are visually
 * confusable, so dispatching on them would route by a serialization detail.
 *
 * It lives HERE, in the aggregator, because the three branches span two layers that may
 * not import each other: `ops/annotations` reaching `ops-shared` closes a cycle through
 * `ops/triage`. Only front ends import `ops.ts`, so this is the one place all three are
 * reachable at once.
 */
export async function closeFinding(
  root: string,
  input: { id: string; result: "fixed" | "answered" | "declined"; detail: string; files?: string[]; by?: string; comment?: string; line?: number; disposition?: never },
): Promise<Record<string, unknown>> {
  const f = await readFinding(root, input.id).catch(() => null);
  if (!f) return closeAnnotation(root, input as never) as Promise<Record<string, unknown>>;
  if (!f.origin) return closeLocal(root, input as never);
  // Fold-owned: a row the fold owns may only be changed by an event.
  const shared = await import("./ops-shared.js");
  const r = await shared.reportOnFinding(root, f.pr!, f.id, input.result, input.detail, input.files) as Record<string, unknown>;
  if (r.error) return r;
  const d = (input as { disposition?: string }).disposition;
  const verdict = d === "refuted" ? "refute" as const : d === "confirmed" ? "confirm" as const : null;
  if (verdict) await shared.corroborateFinding(root, f.pr!, f.id, verdict, input.detail);
  return {
    ok: true, id: f.id, pr: f.pr, shared: true,
    note: "reported — a person still has to close it"
      + (d && !verdict ? `; disposition "${d}" is not recorded on a shared finding — verdicts are` : ""),
  };
}
