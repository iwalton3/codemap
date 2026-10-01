/**
 * Append an event the way a build WITHOUT the write door would have — a teammate on an older
 * or broken build. Test-only: it is how a test puts in front of a fold an event this build
 * refuses to write (plan 1.1). Nothing in production may import it.
 *
 * Without options the event is the next linear act (it has a `seq`) and read the whole scope.
 * `after` or `writer` plants a merge-era event instead — no `seq`, that read set — which a
 * read skips rather than locks on when the fold refuses it.
 */
import { appendChecked, appendLinear, causalHeads, EVENT_SCHEMA, GENESIS, mintId, readScope, SIDECAR_PROTOCOL, sortEvents, writerFor, type LogEvent } from "./eventlog.js";
import { join } from "node:path";
import { isLogDamage, type DamagedEntry } from "./log-damage.js";
import { shapeCheckFor } from "./log-shape.js";
import { judge, type Report } from "./validation.js";
import { foldStandardReport } from "./shared-standard.js";
import type { Acknowledgement, Actor, Audit, BugWitness, Operation, Pointer, PopulationPredicate, Problem, ProposalWitness, ScrubPolicy, Spec, VacuityCheck } from "./schema.js";

/** Every id `appendUnfolded` wrote, so a population check can tell a planted event from an op's. */
export const planted = new Set<string>();

export async function appendUnfolded(
  logRoot: string, scope: string, actor: Actor, kind: string, subject: string, data: Record<string, unknown>,
  opts: { after?: string[]; writer?: string } = {},
): Promise<LogEvent> {
  if (!opts.after && !opts.writer) {
    // The local door, never `write.ts`: a build without the door appends straight to its
    // clone, and nothing validates it until something reads or syncs.
    const e = await appendChecked(logRoot, scope, actor, async () => ({ kind, subject, data }), () => ({ refused: [] }), true);
    if ("error" in e) throw new Error(e.error);
    planted.add(e.id);
    return e;
  }
  const writer = opts.writer ?? await writerFor(logRoot);
  const scoped = sortEvents(await readScope(logRoot, scope));
  const own = scoped.filter((e) => e.writer === writer);
  // Into the scope's one file, but with no `seq`: an event from before the linear log, placed
  // where a migrated sidecar would hold it. (A per-writer shard would read as unmigrated.)
  const event: LogEvent = {
    sidecarProtocol: SIDECAR_PROTOCOL, eventSchema: EVENT_SCHEMA, id: mintId(), kind, subject, actor,
    at: new Date().toISOString(), writer, writerPrev: own.length ? own[own.length - 1]!.id : GENESIS,
    after: opts.after ?? causalHeads(scoped), data,
  };
  await appendLinear(logRoot, scope, [event]);
  planted.add(event.id);
  return event;
}

type Act<R> = (l: string, s: string, a: Actor, kind: string, subject: string, data: Record<string, unknown>) => R;

/**
 * The standard's publishers — the same kinds, subjects and payloads as `shared-standard.ts`'s —
 * over any way of acting on one event, so a fold test can plant an event this build refuses to
 * write (`unfolded`) or ask what the fold would make of it as the next act (`probe`).
 */
const standardActs = <R>(act: Act<R>) => ({
  publishSpecDrafted: (l: string, s: string, a: Actor, spec: Spec) => act(l, s, a, "spec.drafted", spec.id, { spec }),
  publishOperation: (l: string, s: string, a: Actor, op: Operation) => act(l, s, a, "spec.operation", op.specId, { operation: op }),
  publishSpecRevised: (l: string, s: string, a: Actor, spec: Spec, at: string) => act(l, s, a, "spec.revised", spec.id, { spec, at }),
  publishOperationRevised: (l: string, s: string, a: Actor, op: Operation) => act(l, s, a, "spec.operation.revised", op.specId, { operation: op }),
  publishOperationRemoved: (l: string, s: string, a: Actor, op: Operation) => act(l, s, a, "spec.operation.removed", op.specId, { operation: op }),
  publishSpecReviewed: (l: string, s: string, a: Actor, w: ProposalWitness) => act(l, s, a, "spec.reviewed", w.specId, { witness: w }),
  publishSpecRatified: (l: string, s: string, a: Actor, specId: string, at: string, witnesses: Record<string, BugWitness[]>, operations: string[]) =>
    act(l, s, a, "spec.ratified", specId, { at, witnesses, operations }),
  publishSpecWithdrawn: (l: string, s: string, a: Actor, specId: string, at: string, reason: string) => act(l, s, a, "spec.withdrawn", specId, { at, reason }),
  publishAckGranted: (l: string, s: string, a: Actor, ack: Acknowledgement) => act(l, s, a, "ack.granted", ack.id, { ack }),
  publishAckReleased: (l: string, s: string, a: Actor, id: string, at: string, reason: string) => act(l, s, a, "ack.released", id, { at, reason }),
  publishAudit: (l: string, s: string, a: Actor, audit: Audit) => act(l, s, a, "audit.recorded", audit.requirementId, { audit }),
  publishVacuityCheck: (l: string, s: string, a: Actor, check: VacuityCheck) => act(l, s, a, "vacuity.checked", check.criterionId, { check }),
  publishPointerDeclared: (l: string, s: string, a: Actor, p: Pointer) => act(l, s, a, "pointer.declared", p.id, { pointer: p }),
  publishPointerRestated: (l: string, s: string, a: Actor, id: string, at: string, witnesses: BugWitness[]) => act(l, s, a, "pointer.restated", id, { at, witnesses }),
  publishPointerRetired: (l: string, s: string, a: Actor, id: string, at: string, reason: string) => act(l, s, a, "pointer.retired", id, { at, reason }),
  publishPopulationPinned: (l: string, s: string, a: Actor, pin: PopulationPredicate, supersedes?: string) =>
    act(l, s, a, "population.pinned", pin.id, { pin, ...(supersedes ? { supersedes } : {}) }),
  publishScrubPolicy: (l: string, s: string, a: Actor, policy: ScrubPolicy) => act(l, s, a, "scrub.policy", s, { policy }),
  publishProblemRaised: (l: string, s: string, a: Actor, problem: Problem) => act(l, s, a, "problem.raised", problem.id, { problem }),
  publishAdjudication: (l: string, s: string, a: Actor, id: string, disposition: string, reason: string, at: string) =>
    act(l, s, a, "problem.adjudicated", id, { disposition, reason, at }),
});

/** The standard's acts as a build without the write door would append them. */
export const unfolded = standardActs(appendUnfolded);

/** The standard's acts, folded as the next event and NOT written: damage, newer, or applied. */
export const probe = standardActs((l, s, a, kind, subject, data) => foldWithNext(l, s, foldStandardReport, a, kind, subject, data));

/**
 * Fold `scope` with one more event on the end, NOT written: the next linear act, as a writer
 * who had read the whole scope would append it, or — `unseen` — as one who had not read those
 * events (its read set leaves them out). A refusal is judged as a read would judge it: damage,
 * or newer for a shape this build does not write (`validation.ts judge`).
 */
export async function foldWithNext<T>(
  logRoot: string, scope: string, report: Report<T>,
  actor: Actor, kind: string, subject: string, data: Record<string, unknown>, opts: { unseen?: string[] } = {},
): Promise<{ id: string; value?: T; refused?: { id: string; why: string }; damage?: DamagedEntry; newer?: string }> {
  const events = sortEvents(await readScope(logRoot, scope));
  // A shape this build does not write is newer: skipped on read, refused by the door.
  const wrong = shapeCheckFor(scope)?.({ kind, subject, data } as LogEvent);
  if (wrong) return { id: "(not minted)", newer: wrong };
  const seen = opts.unseen ? events.filter((e) => !opts.unseen!.includes(e.id)) : events;
  const e: LogEvent = { sidecarProtocol: SIDECAR_PROTOCOL, eventSchema: EVENT_SCHEMA, id: mintId(), kind, subject, actor,
    at: new Date().toISOString(), writer: opts.unseen ? "w_teammate" : "w_here", writerPrev: GENESIS, after: causalHeads(seen), data,
    seq: Math.max(0, ...events.map((x) => x.seq ?? 0)) + 1 };
  const all = sortEvents([...events, e]);
  let r: ReturnType<Report<T>>;
  try { r = report(all); } catch (err) {
    if (isLogDamage(err)) return { id: e.id, damage: err.entry };
    throw err;
  }
  const mine = r.refused.filter((x) => x.id === e.id);
  // `refused` is what replay tells its author; `damage` is what a read of a log holding it does.
  try { judge(all, mine); } catch (err) {
    if (isLogDamage(err)) return { id: e.id, value: r.value, refused: mine[0], damage: err.entry };
    throw err;
  }
  return { id: e.id, value: r.value, refused: mine[0] };
}
