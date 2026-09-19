/**
 * Which pull request a branch became — the link that carries a branch's findings onto the
 * pull request opened from it.
 *
 * One scope per universe, `reviews/<universe>`, and one event: `review.linked {pr, branch}`.
 * It is written when somebody's codemap first resolves the pull request through `gh` and
 * learns its head branch, or by hand (`link_review`) where there is no `gh`. That bends
 * the sidecar rule that derivable facts stay local projections, on the owner's ruling
 * (2026-09-18): a teammate without `gh` could not otherwise see branch findings under the
 * pull request. It stays honest because the actor is who OBSERVED the link, and a link has
 * no causal order to get wrong. Duplicates from several clones fold to one row.
 *
 * A fork's pull request is never linked: its head branch lives in somebody else's
 * repository, and a local branch of the same name is unrelated code
 * (`docs/review-target-identity.md`, the "unrelated branch" row). Callers enforce that,
 * since only they hold `isCrossRepository`.
 */
import { emitEvent, readScope, type LogEvent } from "./eventlog.js";
import type { Actor } from "./schema.js";

export const reviewScope = (universe: string): string => `reviews/${universe}`;

export interface ReviewLink { pr: string; branch: string }

/** Every distinct (pr, branch) pair on record, first-seen order. */
export function foldReviewLinks(events: LogEvent[]): ReviewLink[] {
  const out: ReviewLink[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (e.kind !== "review.linked") continue;
    const pr = typeof e.data?.pr === "string" ? e.data.pr : null;
    const branch = typeof e.data?.branch === "string" ? e.data.branch : null;
    if (!pr || !/^\d+$/.test(pr) || !branch) continue;
    const k = `${pr}\0${branch}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ pr, branch });
  }
  return out;
}

export const linkReview = (logRoot: string, universe: string, actor: Actor, pr: string, branch: string) =>
  emitEvent(logRoot, reviewScope(universe), actor, "review.linked", `pr-${pr}`, { pr, branch });

export async function readReviewLinks(logRoot: string, universe: string): Promise<ReviewLink[]> {
  return foldReviewLinks(await readScope(logRoot, reviewScope(universe)));
}
