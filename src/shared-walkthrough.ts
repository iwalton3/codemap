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
import { appendEvents, mintId, readScope, causalHeads, type LogEvent } from "./eventlog.js";

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
  const scope = walkthroughScope(key);
  const seen = causalHeads(await readScope(logRoot, scope));
  const event: LogEvent = {
    id: mintId(),
    kind: "walkthrough.published",
    subject: `pr-${w.pr}`,
    actor,
    at: new Date().toISOString(),
    ...(seen.length ? { after: seen } : {}),
    data: { walkthrough: w as unknown as Record<string, unknown> },
  };
  await appendEvents(logRoot, scope, actor, [event]);
  return event;
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
export function foldWalkthroughs(events: LogEvent[]): SharedWalkthrough[] {
  const byAuthor = new Map<string, SharedWalkthrough>();
  for (const e of events) {
    if (e.kind !== "walkthrough.published") continue;
    const w = e.data?.walkthrough as PrWalkthrough | undefined;
    // A malformed event is skipped, not fatal: it reached us through somebody
    // else's client and a shared store that will not load is worse than one
    // missing a record.
    if (!w || typeof w.pr !== "number" || typeof w.head !== "string") continue;
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
