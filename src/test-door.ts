/**
 * Append an event the way a build WITHOUT the write door would have — a teammate on an older
 * or broken build. Test-only: it is how a test puts in front of a fold an event this build
 * refuses to write (plan 1.1). Nothing in production may import it.
 *
 * `after`, when given, replaces the causal heads, so an event can be written as CONCURRENT
 * with what it conflicts with: a teammate who had not pulled. Without it the event saw the
 * whole scope, which is what a sequential write on one clone is.
 */
import { appendEvents, causalHeads, emitEventChecked, EVENT_SCHEMA, GENESIS, mintId, readScope, readShard, shardFor, SIDECAR_PROTOCOL, sortEvents, writerFor, type LogEvent } from "./eventlog.js";
import { join } from "node:path";
import type { Acknowledgement, Actor, Audit, BugWitness, Operation, Pointer, PopulationPredicate, Problem, ProposalWitness, ScrubPolicy, Spec, VacuityCheck } from "./schema.js";

/** Every id `appendUnfolded` wrote, so a population check can tell a planted event from an op's. */
export const planted = new Set<string>();

export async function appendUnfolded(
  logRoot: string, scope: string, actor: Actor, kind: string, subject: string, data: Record<string, unknown>,
  opts: { after?: string[]; writer?: string } = {},
): Promise<LogEvent> {
  if (!opts.after && !opts.writer) {
    const e = await emitEventChecked(logRoot, scope, actor, async () => ({ kind, subject, data }), () => ({ refused: [] }));
    if ("error" in e) throw new Error(e.error);
    planted.add(e.id);
    return e;
  }
  const writer = opts.writer ?? await writerFor(logRoot);
  const own = await readShard(join(logRoot, shardFor(scope, writer)));
  const event: LogEvent = {
    sidecarProtocol: SIDECAR_PROTOCOL, eventSchema: EVENT_SCHEMA, id: mintId(), kind, subject, actor,
    at: new Date().toISOString(), writer, writerPrev: own.length ? own[own.length - 1]!.id : GENESIS,
    after: opts.after ?? causalHeads(sortEvents(await readScope(logRoot, scope))), data,
  };
  await appendEvents(logRoot, scope, writer, [event]);
  planted.add(event.id);
  return event;
}

/**
 * The standard's publishers, as a build without the write door would append — the same kinds,
 * subjects and payloads as `shared-standard.ts`'s. For fold tests that plant an event this
 * build refuses to write.
 */
export const unfolded = {
  publishSpecDrafted: (l: string, s: string, a: Actor, spec: Spec) => appendUnfolded(l, s, a, "spec.drafted", spec.id, { spec }),
  publishOperation: (l: string, s: string, a: Actor, op: Operation) => appendUnfolded(l, s, a, "spec.operation", op.specId, { operation: op }),
  publishSpecRevised: (l: string, s: string, a: Actor, spec: Spec, at: string) => appendUnfolded(l, s, a, "spec.revised", spec.id, { spec, at }),
  publishOperationRevised: (l: string, s: string, a: Actor, op: Operation) => appendUnfolded(l, s, a, "spec.operation.revised", op.specId, { operation: op }),
  publishOperationRemoved: (l: string, s: string, a: Actor, op: Operation) => appendUnfolded(l, s, a, "spec.operation.removed", op.specId, { operation: op }),
  publishSpecReviewed: (l: string, s: string, a: Actor, w: ProposalWitness) => appendUnfolded(l, s, a, "spec.reviewed", w.specId, { witness: w }),
  publishSpecRatified: (l: string, s: string, a: Actor, specId: string, at: string, witnesses: Record<string, BugWitness[]>, operations: string[]) =>
    appendUnfolded(l, s, a, "spec.ratified", specId, { at, witnesses, operations }),
  publishSpecWithdrawn: (l: string, s: string, a: Actor, specId: string, at: string, reason: string) => appendUnfolded(l, s, a, "spec.withdrawn", specId, { at, reason }),
  publishAckGranted: (l: string, s: string, a: Actor, ack: Acknowledgement) => appendUnfolded(l, s, a, "ack.granted", ack.id, { ack }),
  publishAckReleased: (l: string, s: string, a: Actor, id: string, at: string, reason: string) => appendUnfolded(l, s, a, "ack.released", id, { at, reason }),
  publishAudit: (l: string, s: string, a: Actor, audit: Audit) => appendUnfolded(l, s, a, "audit.recorded", audit.requirementId, { audit }),
  publishVacuityCheck: (l: string, s: string, a: Actor, check: VacuityCheck) => appendUnfolded(l, s, a, "vacuity.checked", check.criterionId, { check }),
  publishPointerDeclared: (l: string, s: string, a: Actor, p: Pointer) => appendUnfolded(l, s, a, "pointer.declared", p.id, { pointer: p }),
  publishPointerRestated: (l: string, s: string, a: Actor, id: string, at: string, witnesses: BugWitness[]) => appendUnfolded(l, s, a, "pointer.restated", id, { at, witnesses }),
  publishPointerRetired: (l: string, s: string, a: Actor, id: string, at: string, reason: string) => appendUnfolded(l, s, a, "pointer.retired", id, { at, reason }),
  publishPopulationPinned: (l: string, s: string, a: Actor, pin: PopulationPredicate, supersedes?: string) =>
    appendUnfolded(l, s, a, "population.pinned", pin.id, { pin, ...(supersedes ? { supersedes } : {}) }),
  publishScrubPolicy: (l: string, s: string, a: Actor, policy: ScrubPolicy) => appendUnfolded(l, s, a, "scrub.policy", s, { policy }),
  publishProblemRaised: (l: string, s: string, a: Actor, problem: Problem) => appendUnfolded(l, s, a, "problem.raised", problem.id, { problem }),
  publishAdjudication: (l: string, s: string, a: Actor, id: string, disposition: string, reason: string, at: string) =>
    appendUnfolded(l, s, a, "problem.adjudicated", id, { disposition, reason, at }),
};
