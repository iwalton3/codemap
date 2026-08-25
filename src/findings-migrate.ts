/**
 * Move this store's local findings into the canonical `findings` table.
 *
 * A one-off, and deliberately not a bridge: `docs/plan-findings-unification.md` says
 * findings live in one table, and until the 96 in `meta.annotations` are rows, every
 * reader has to look in two places or lose half of them.
 *
 * **A backfill is a new attributed act.** `after` is captured at append time, so a
 * migrated finding's causal position cannot be recreated — these become LOCAL rows
 * (`origin` null), and publishing them to the team stays the separate, explicit act it
 * already is. Nothing here touches the sidecar log.
 *
 * **The pull request has to come from somewhere true.** A local annotation has no `pr`
 * field; the only recorded one is `postedRef.pr`, written when it was posted to GitHub.
 * Anything else is inference from a worklist, which is the very thing this whole change
 * exists to stop doing — so an annotation with no `postedRef` is REPORTED for a person
 * to assign, never guessed.
 */

import { readAnnotations, writeAnnotations, readFinding, writeLocalFinding } from "./store.js";
import { isAgentActor } from "./identity.js";
import type { Annotation, Actor } from "./schema.js";
import type { SharedFinding, FindingState } from "./shared-findings.js";

/** One annotation the migration cannot place, and why a person has to. */
export interface Unplaced {
  id: string;
  /** Still open, so somebody may still act on it — the ones worth assigning first. */
  open: boolean;
  /** First line, enough to recognise it by. */
  label: string;
}

export interface MigrateResult {
  /** What moved (or would), as `id -> pr`. */
  moved: { id: string; pr: string }[];
  /** Already rows — the migration is idempotent, and re-running is how you check. */
  alreadyThere: number;
  /** No `postedRef.pr` and no assignment: a person says which pull request, or none. */
  unplaced: Unplaced[];
  /**
   * Findings whose creation time is not recorded anywhere on the annotation, so the
   * row carries the migration's own timestamp. Counted rather than hidden: a made-up
   * `createdAt` that nobody flagged is how a backfill starts lying about history.
   */
  stampedNow: number;
  dryRun: boolean;
}

/** Every timestamp an annotation actually records, so the earliest is a true bound. */
function earliestKnown(a: Annotation): string | undefined {
  const times: string[] = [];
  if (a.postedRef?.at) times.push(a.postedRef.at);
  if (a.withdrawn?.at) times.push(a.withdrawn.at);
  if (a.escalated?.at) times.push(a.escalated.at);
  if (a.assignment?.at) times.push(a.assignment.at);
  if (a.outcome?.at) times.push(a.outcome.at);
  for (const r of a.revisions ?? []) if (r.at) times.push(r.at);
  return times.sort()[0];
}

/**
 * The lifecycle state an annotation is really in.
 *
 * `withdrawn` and `resolved` are their own fields; a `refuted` disposition is a verdict
 * somebody reached and the shared model has a state for it. Everything else is open,
 * and opens the way the fold would have opened it — an agent's is a proposal.
 */
function stateOf(a: Annotation, actor: Actor): FindingState {
  if (a.withdrawn) return "withdrawn";
  if (a.resolved) return "resolved";
  if (a.disposition === "refuted") return "refuted";
  return isAgentActor(actor) ? "issued" : "created";
}

/** The structured actor, or the best one recoverable from the legacy `author` string. */
function actorOf(a: Annotation): Actor {
  if (a.actor) return a.actor;
  // A name is not a principal, and inventing one would put a person's identity on a
  // record they did not make. The string is preserved as the principal so the row says
  // exactly what the annotation said, and no more.
  return { principal: a.author || "unknown" };
}

function toFinding(a: Annotation, now: string): { finding: SharedFinding; stamped: boolean } {
  const actor = actorOf(a);
  const known = earliestKnown(a);
  return {
    stamped: !known,
    finding: {
      id: a.id,
      target: a.target,
      text: a.text,
      ...(a.comment ? { comment: a.comment } : {}),
      ...(a.severity ? { severity: a.severity } : {}),
      ...(a.category ? { category: a.category } : {}),
      ...(a.line !== undefined ? { line: a.line } : {}),
      ...(a.witness ? { witness: a.witness } : {}),
      ...(a.sourceRef ? { sourceRef: a.sourceRef } : {}),
      author: actor,
      createdAt: known ?? now,
      state: stateOf(a, actor),
      corroboration: [],
      thread: [],
      ...(a.assignment ? { assignment: { kind: a.assignment.kind, by: { principal: a.assignment.by }, at: a.assignment.at, ...(a.assignment.note ? { note: a.assignment.note } : {}) } } : {}),
      ...(a.outcome ? { outcome: { result: a.outcome.result, detail: a.outcome.detail, ...(a.outcome.files ? { files: a.outcome.files } : {}), by: { principal: a.outcome.by }, at: a.outcome.at } } : {}),
      // `by` is the annotation's own actor: the posting was this store's act, and the
      // record has nobody else to name for it.
      //
      // `commentId` -> `key` is load-bearing, not tidiness: `inboundReplies` matches the
      // submitter's thread by that id and skips a `posted` without one, so dropping it
      // migrated the finding and silently lost every reply it had already received.
      // A body-placement ref genuinely has no comment id; those stay keyless.
      ...(a.postedRef
        ? {
          posted: {
            system: "github" as const,
            ...(a.postedRef.commentId !== undefined ? { key: String(a.postedRef.commentId) } : {}),
            ...(a.postedRef.url ? { url: a.postedRef.url } : {}),
            at: a.postedRef.at,
            by: actor,
          },
        }
        : {}),
      ...(a.withdrawn ? { closed: { at: a.withdrawn.at, by: { principal: a.withdrawn.by }, reason: a.withdrawn.reason ?? "withdrawn before this store had findings" } } : {}),
      revisions: (a.revisions ?? []).map((r) => ({ at: r.at, by: { principal: r.by }, was: r.was as Record<string, unknown> })),
    },
  };
}

/**
 * @param assign Explicit `annotation id -> pull request` decisions, for the ones with no
 *   `postedRef`. This is where a person's judgement enters; nothing infers it.
 */
export async function migrateLocalFindings(
  root: string,
  opts: { dryRun?: boolean; assign?: Record<string, string | number> } = {},
): Promise<MigrateResult> {
  const store = await readAnnotations(root);
  const now = new Date().toISOString();
  const assign = opts.assign ?? {};

  const moved: { id: string; pr: string }[] = [];
  const unplaced: Unplaced[] = [];
  const migratedIds = new Set<string>();
  let alreadyThere = 0, stampedNow = 0;

  for (const a of store.annotations) {
    if (a.kind !== "finding") continue;
    const pr = assign[a.id] !== undefined ? String(assign[a.id]) : a.postedRef?.pr !== undefined ? String(a.postedRef.pr) : null;
    if (pr === null) {
      unplaced.push({
        id: a.id,
        open: !a.resolved && !a.withdrawn,
        label: (a.comment || a.text || "").split("\n")[0]!.slice(0, 120),
      });
      continue;
    }
    if (await readFinding(root, a.id, { pr })) { alreadyThere++; migratedIds.add(a.id); continue; }
    const { finding, stamped } = toFinding(a, now);
    if (stamped) stampedNow++;
    if (!opts.dryRun) {
      await writeLocalFinding(root, finding, pr);
      // Read it back BEFORE the annotation is dropped. The row is the only copy once
      // the blob is rewritten, and a write this loop did not verify is how a migration
      // loses the one thing in this database that is not regenerable.
      if (!(await readFinding(root, a.id, { pr }))) {
        throw new Error(`${a.id} did not read back after being written to pr ${pr} — nothing has been removed; fix and re-run`);
      }
      migratedIds.add(a.id);
    }
    moved.push({ id: a.id, pr });
  }

  // Only after every row is written and verified. Findings LEAVE the blob: two copies
  // of one finding is the state this whole change exists to end, and the PR page would
  // list each of them twice.
  if (!opts.dryRun && migratedIds.size) {
    await writeAnnotations(root, store.annotations.filter((a) => !migratedIds.has(a.id)));
  }

  return { moved, alreadyThere, unplaced, stampedNow, dryRun: !!opts.dryRun };
}
