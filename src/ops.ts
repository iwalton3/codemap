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
  document, connect, updateNode, confirm, UNPLACEABLE_CATEGORY, ackHole, nodeVersions, removeNode, linksReport,
} from "./ops/docs.js";

export { reportBug, listBugs, bugDetail, updateBug } from "./ops/bugs.js";

export {
  anchorAnnotations, annotate, resolveAnnotation, escalateAnnotation, reviseAnnotation, withdrawAnnotation,
  assignAnnotation, type QueueItem, reviewQueue, closeAssignment, listQuestions,
} from "./ops/annotations.js";
