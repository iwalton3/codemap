/**
 * "Does the sidecar know this node?" — the leaf half, for the same structural reason
 * `triage-publish.ts` and `notes-publish.ts` exist.
 *
 * `annotate` asks this so a doc the team published, and this store never adopted, still
 * has a path to the review queue. Reaching `ops-shared.ts` from `ops/annotations.ts` to
 * ask made that module a hub, and every later edge into `ops-shared` closed a cycle
 * through it. An ES-module cycle here fails with a blank page and an empty console.
 */

import { resolveSidecar, sidecarIdentity } from "./sidecar-config.js";
import { readCached, ensureMaterialized } from "./materialize.js";
import { docsByNode, docsProjection } from "./shared-projections.js";
import { foldDocs, docScope } from "./shared-docs.js";
import type { ScopeStatus } from "./eventlog.js";

export async function sharedKnowsNode(root: string, nodeId: string): Promise<boolean> {
  const cfg = resolveSidecar(root);
  if (!cfg) return false;
  const scope = docScope(cfg.universe);
  const { fresh } = await ensureMaterialized(root, cfg.path, scope, sidecarIdentity(cfg), foldDocs, docsProjection);
  if (fresh) return docsByNode(root, scope, [nodeId]).size > 0;
  // The projection is behind, so ask the log rather than answer "no" from rows we have
  // been told are stale — a false no here refuses a legitimate target.
  return (await readCached(root, cfg.path, scope, sidecarIdentity(cfg), foldDocs, docsProjection)).value.has(nodeId);
}

export interface DocsVerdict extends ScopeStatus {
  /** The docs scope, when there is a sidecar at all. */
  scope?: string;
  /**
   * Scopes a DECIDING caller must not let decide for it.
   *
   * Empty when the scope is healthy or absent. Non-empty means: the rows are still
   * there and still shown, and they may not remove work from anybody's queue.
   */
  excludeFromDecisions: ReadonlySet<string>;
}

const NO_SIDECAR_VERDICT: DocsVerdict = { status: "complete", excludeFromDecisions: new Set() };

/**
 * Fold the docs scope and say whether it may be believed.
 *
 * **The one place the suppression decision is derived.** It used to be derived in two
 * (`sharedCoverage` and `findGaps`), which is how a rule that reads identically in
 * both ends up applied in one.
 *
 * Fails CLOSED but never crashes. The agnostic core does not depend on the sidecar,
 * and an unreadable one must not break a local read that predates it — so an I/O
 * failure degrades to `blocked` rather than throwing inside outline, search, context,
 * diff and the analyzer.
 */
export async function docsVerdict(root: string): Promise<DocsVerdict> {
  const cfg = resolveSidecar(root);
  if (!cfg) return NO_SIDECAR_VERDICT;
  const scope = docScope(cfg.universe);
  try {
    const { fresh, ...status } = await ensureMaterialized(
      root, cfg.path, scope, sidecarIdentity(cfg), foldDocs, docsProjection,
    );
    const trustworthy = fresh && status.status === "complete";
    return { ...status, scope, excludeFromDecisions: trustworthy ? new Set() : new Set([scope]) };
  } catch (e: any) {
    return {
      status: "blocked",
      diagnostic: { reason: "fork", detail: `the shared docs could not be read: ${e?.message ?? e}`, evidence: [] },
      scope,
      excludeFromDecisions: new Set([scope]),
    };
  }
}
