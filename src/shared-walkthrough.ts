/**
 * Walkthroughs over the event log — the first payload on the shared substrate.
 *
 * Chosen to go first because it is the cleanest thing to share and the least able
 * to hide a mistake: a walkthrough is self-contained, keyed by pull request, and
 * already stamped with the head it was written against, so one that has gone stale
 * is DETECTABLE rather than silently wrong. That matters more when somebody else's
 * agent wrote it than when yours did.
 *
 * The fold is the whole contract: given the same events in any arrival order,
 * every reader must land on the same walkthroughs. `eventlog.sortEvents` supplies
 * the order; this supplies the meaning.
 */

import type { Actor } from "./schema.js";
import type { PrWalkthrough } from "./walkthrough.js";
import { emitEvent, mintId, readScope, type LogEvent } from "./eventlog.js";

/** One person's walkthrough of one pull request, with who wrote it. */
export interface SharedWalkthrough {
  walkthrough: PrWalkthrough;
  actor: Actor;
  /** The event that last set it — the causal handle for anything that supersedes it. */
  eventId: string;
  at: string;
}

/** Universe-qualified by the caller, for the same reason as `findingScope`. */
export const walkthroughScope = (pr: number | string): string => `walkthrough/${pr}`;

/**
 * Record a walkthrough.
 *
 * `after` is the high watermark of what this writer had already folded, which is
 * what lets a later reader tell "wrote it without seeing yours" from "wrote it
 * having read yours". Without that, two people mapping the same PR minutes apart
 * are indistinguishable from one revising the other.
 */
export async function publishWalkthrough(
  logRoot: string,
  actor: Actor,
  w: PrWalkthrough,
  /** Scope key; `ops` passes a universe-qualified one. Defaults to the bare PR. */
  key: number | string = w.pr,
): Promise<LogEvent> {
  return emitEvent(logRoot, walkthroughScope(key), actor, "walkthrough.published", `pr-${w.pr}`,
    { walkthrough: w as unknown as Record<string, unknown> });
}

/**
 * Every walkthrough of a pull request, one per author, newest last.
 *
 * Per AUTHOR rather than one winner: two people mapping the same PR is not a
 * conflict to arbitrate, it is two readings, and picking one silently would throw
 * away work somebody did. A later event from the same author supersedes their own
 * earlier one — that is a revision, and the only case where replacing is right.
 *
 * Pure, and separate from the read so a caller can fold events from anywhere —
 * a pull, a test, a merge that has not been written to disk yet.
 */
/**
 * Is this the BUILT walkthrough, or the input somebody meant to build from?
 *
 * The two differ only by fields a JSON boundary erases — `PrWalkthrough` and `WalkInput`
 * are structurally close enough that TypeScript never sees the substitution, and every
 * publish path crosses one (an MCP argument, an HTTP body, an NDJSON line).
 */
export function walkthroughShaped(w: PrWalkthrough): boolean {
  if (!Array.isArray(w.features)) return false;
  return w.features.every((f) =>
    Array.isArray(f?.chapters)
    && f.chapters.every((c) => c && typeof c.id === "string" && Array.isArray(c.witnesses)));
}

export function foldWalkthroughs(events: LogEvent[]): SharedWalkthrough[] {
  const byAuthor = new Map<string, SharedWalkthrough>();
  for (const e of events) {
    if (e.kind !== "walkthrough.published") continue;
    const w = e.data?.walkthrough as PrWalkthrough | undefined;
    // A malformed event is skipped, not fatal: it reached us through somebody
    // else's client and a shared store that will not load is worse than one
    // missing a record.
    if (!w || typeof w.pr !== "number" || typeof w.head !== "string") continue;
    // And the CHAPTERS, which this checked only at the envelope. One event on
    // `Acme.API` PR 269 carried the agent's `WalkInput` — `{title, blocks}` with no id
    // and no witnesses — instead of the built walkthrough, and every reader crashed on
    // it: `staleChapters` reads `c.witnesses` and the pull-request page 500'd for good,
    // because the log is append-only and the fold had no opinion about the shape.
    //
    // Witnesses are not decoration. A chapter without them cannot go stale, so a
    // walkthrough of them would sit under a green check that can never turn — which is
    // the one thing this project's marks are for.
    if (!walkthroughShaped(w)) continue;
    byAuthor.set(e.actor.principal, { walkthrough: w, actor: e.actor, eventId: e.id, at: e.at });
  }
  return [...byAuthor.values()];
}

/** Read and fold in one step — what a front-end wants. */
export async function readWalkthroughs(logRoot: string, pr: number | string): Promise<SharedWalkthrough[]> {
  return foldWalkthroughs(await readScope(logRoot, walkthroughScope(pr)));
}

/**
 * The one to show, for a given head, or undefined.
 *
 * A walkthrough about a different commit is not wrong so much as ABOUT SOMETHING
 * ELSE, so a matching head is required rather than preferred — showing a stale one
 * silently is the failure the `head` stamp exists to prevent. Ties break on the
 * event id, which is the same total order every reader already agrees on.
 */
export function currentWalkthrough(all: SharedWalkthrough[], head: string): SharedWalkthrough | undefined {
  let best: SharedWalkthrough | undefined;
  for (const s of all) {
    if (s.walkthrough.head !== head) continue;
    if (!best || s.eventId > best.eventId) best = s;
  }
  return best;
}

/** Walkthroughs written against some other commit — stale, and worth saying so. */
export function staleWalkthroughs(all: SharedWalkthrough[], head: string): SharedWalkthrough[] {
  return all.filter((s) => s.walkthrough.head !== head);
}
