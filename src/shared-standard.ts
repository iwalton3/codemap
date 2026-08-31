/**
 * The standard as shared state: what enters the log, and how it folds back.
 *
 * `docs/sidecar-architecture.md` is normative for shared state and this obeys it. The
 * rule that shapes everything below is its one-sentence version — **acts enter the log at
 * the moment they happen; everything derivable is a local projection.**
 *
 * So the events here are ACTS and nothing else:
 *
 *   spec.drafted · spec.operation · spec.ratified
 *   ack.granted · ack.released
 *   audit.recorded
 *   problem.raised · problem.adjudicated
 *   vacuity.checked
 *   pointer.declared · pointer.restated · pointer.retired
 *   population.pinned
 *   scrub.policy
 *
 * ACCEPTANCE CRITERIA are not among them either, for the reason requirements are not: a
 * criterion is created by a ratified `add_criterion` operation, so it is derived by
 * replaying operations and every clone must arrive at the same id (`criterionIdFor`). A
 * vacuity check IS an act — somebody tried to break a check and reports what happened —
 * so it has an honest actor and enters the log directly.
 *
 * And the REQUIREMENTS are not among them. The standard is a projection of the ratified
 * specs, so a requirement is derived by replaying operations — which is exactly why its
 * id had to become a function of the operation that creates it (`requirementIdFor`). A
 * derived event has no honest actor and no honest causal position, and a deterministic
 * fold means every clone would mint its own copy.
 *
 * One scope per universe rather than one per record kind. The kinds cross-reference each
 * other constantly — a problem closes on an audit or on a ratified spec — and a fold sees
 * only its own scope's events, so splitting them would leave the derivations unable to
 * see their own inputs.
 *
 * **Witnesses are an observation of the ratifier's checkout**, carried on the ratification
 * event rather than recomputed per clone. A clone whose code differs then reads the rule
 * as recheck-due, which is the honest answer: the code it has is not the code the rule was
 * adopted against. Generalising this to a SET of accepted hashes, the way
 * `NodeCitation.acceptedHashes` already does per branch, is the obvious next move and is
 * deliberately not done here.
 */

import type {
  AcceptanceCriterion, Acknowledgement, Actor, Audit, BugWitness, Operation, Pointer,
  PopulationPredicate, Problem, ProposalWitness, Requirement, ScrubPolicy, Spec, VacuityCheck,
} from "./schema.js";
import { criterionIdFor, movedSection, normalizeSection, requirementIdFor, EVIDENCE_KINDS, AUDIT_TRIGGERS, COVERING_TRIGGERS, PROBLEM_DISPOSITIONS, ACK_PRIORITIES, ISO_DATE, auditClaimStands, contentDiff, framingContent, operationContent, witnessHash } from "./schema.js";
import type { LogEvent } from "./eventlog.js";
import { causality, emitEvent } from "./eventlog.js";
import { applyRevision, newContestState } from "./contest.js";

/** The EVIDENCE half — audits, pointers, populations, problems, debt. Per universe. */
export const standardScope = (universe: string): string => `standard/${universe}`;

/**
 * The LAW half — requirements, specs, operations, criteria, gaps. ONE per workspace.
 *
 * A constant, and that is correct rather than lazy: a sidecar is declared once per
 * workspace (`codemap.workspace.json` names one for every universe in it), so the log this
 * scope lives in already IS the workspace boundary. Keying it on something derived would
 * invent a second, weaker way to say what the sidecar already says.
 *
 * Old law events still sit in `standard/<universe>` on stores written before the split.
 * Nothing migrates them, and nothing needs to: the fold reads BOTH scopes and merges, so a
 * pre-split log folds exactly as it did and new law lands in the shared scope.
 */
export const LAW_SCOPE = "law/standard";
export const lawScope = (): string => LAW_SCOPE;

/** Which scope an event kind belongs in. The publish side and the projection share it. */
export const isLawEvent = (kind: string): boolean =>
  kind.startsWith("spec.") || kind === "ack.granted" || kind === "ack.released";

/** Everything one universe's standard scope folds to. */
export interface SharedStandard {
  specs: Spec[];
  operations: Operation[];
  /** Who read which version of what. See `ProposalWitness`. */
  witnesses: ProposalWitness[];
  requirements: Requirement[];
  criteria: AcceptanceCriterion[];
  vacuityChecks: VacuityCheck[];
  pointers: Pointer[];
  populations: PopulationPredicate[];
  scrubs: Audit[];
  /** One decision, so one row. `null` until somebody states it — which is itself a finding. */
  scrubPolicy: ScrubPolicy | null;
  acknowledgements: Acknowledgement[];
  audits: Audit[];
  problems: Problem[];
}

export const emptyStandard = (): SharedStandard => ({
  specs: [], operations: [], witnesses: [], requirements: [], criteria: [], vacuityChecks: [], pointers: [],
  populations: [], scrubs: [], scrubPolicy: null, acknowledgements: [], audits: [], problems: [],
});

// --- writing -----------------------------------------------------------------

const put = (logRoot: string, scope: string, actor: Actor, kind: string, subject: string, data: Record<string, unknown>) =>
  emitEvent(logRoot, scope, actor, kind, subject, data);

export const publishSpecDrafted = (logRoot: string, scope: string, actor: Actor, spec: Spec) =>
  put(logRoot, scope, actor, "spec.drafted", spec.id, { spec });

export const publishOperation = (logRoot: string, scope: string, actor: Actor, op: Operation) =>
  put(logRoot, scope, actor, "spec.operation", op.specId, { operation: op });

/**
 * Correcting a DRAFT: the title/narrative, one operation's payload, and pulling one out.
 *
 * Acts, so they enter the log — and each is subject-keyed the way its creating event is
 * (`spec.revised` on the spec, both operation events on the SPEC, matching `spec.operation`)
 * so a clone folding by subject sees the whole proposal's history in one place.
 *
 * Each carries the corrected record whole. The fold re-checks the draft status and, for a
 * removal, that nothing else in the draft targets it — a row reaching a teammate's clone was
 * never seen by their MCP call, so a guard that lives only in the tool binds one machine.
 */
export const publishSpecRevised = (
  logRoot: string, scope: string, actor: Actor, spec: Spec, at: string,
) => put(logRoot, scope, actor, "spec.revised", spec.id, { spec, at });

export const publishOperationRevised = (logRoot: string, scope: string, actor: Actor, op: Operation) =>
  put(logRoot, scope, actor, "spec.operation.revised", op.specId, { operation: op });

export const publishOperationRemoved = (logRoot: string, scope: string, actor: Actor, op: Operation) =>
  put(logRoot, scope, actor, "spec.operation.removed", op.specId, { operation: op });

/**
 * The ratification, carrying the witnesses the ratifier observed.
 *
 * The event is subject-keyed on the SPEC, not on any requirement: adopting a spec is one
 * act, and splitting it per operation would let a clone fold half an argument.
 */
/**
 * One reviewer signing off one subject. An ACT, so it enters the log.
 *
 * Subject-keyed on the SPEC rather than on the operation, matching `spec.operation`: a
 * clone folding by subject then sees a proposal's whole review history in one place, which
 * is the question anybody asks of it ("who has read this, and how much of it").
 */
export const publishSpecReviewed = (logRoot: string, scope: string, actor: Actor, w: ProposalWitness) =>
  put(logRoot, scope, actor, "spec.reviewed", w.specId, { witness: w });

export const publishSpecRatified = (
  logRoot: string, scope: string, actor: Actor, specId: string, at: string,
  witnesses: Record<string, BugWitness[]>, operations: string[],
) => put(logRoot, scope, actor, "spec.ratified", specId, { at, witnesses, operations });

export const publishSpecWithdrawn = (
  logRoot: string, scope: string, actor: Actor, specId: string, at: string, reason: string,
) => put(logRoot, scope, actor, "spec.withdrawn", specId, { at, reason });

export const publishAckGranted = (logRoot: string, scope: string, actor: Actor, ack: Acknowledgement) =>
  put(logRoot, scope, actor, "ack.granted", ack.id, { ack });

export const publishAckReleased = (
  logRoot: string, scope: string, actor: Actor, id: string, at: string, reason: string,
) => put(logRoot, scope, actor, "ack.released", id, { at, reason });

export const publishAudit = (logRoot: string, scope: string, actor: Actor, audit: Audit) =>
  put(logRoot, scope, actor, "audit.recorded", audit.requirementId, { audit });

/**
 * Somebody tried to make a criterion's assertion fail. An ACT, so it enters the log.
 *
 * Subject-keyed on the criterion, which is what lets the fold find the row it supersedes.
 */
export const publishVacuityCheck = (logRoot: string, scope: string, actor: Actor, check: VacuityCheck) =>
  put(logRoot, scope, actor, "vacuity.checked", check.criterionId, { check });

/**
 * Declaring, re-baselining and retiring a pointer are three ACTS, so three events.
 *
 * The whole record travels on `declared` and on `restated` — the witnesses are an
 * observation of the writer's checkout and a fold cannot make one, which is the same
 * reason ratification carries its witnesses rather than recomputing them per clone.
 * `retired` carries only the decision, because nothing about it is an observation.
 */
export const publishPointerDeclared = (logRoot: string, scope: string, actor: Actor, p: Pointer) =>
  put(logRoot, scope, actor, "pointer.declared", p.id, { pointer: p });

export const publishPointerRestated = (
  logRoot: string, scope: string, actor: Actor, id: string, at: string, witnesses: BugWitness[],
) => put(logRoot, scope, actor, "pointer.restated", id, { at, witnesses });

export const publishPointerRetired = (
  logRoot: string, scope: string, actor: Actor, id: string, at: string, reason: string,
) => put(logRoot, scope, actor, "pointer.retired", id, { at, reason });

/**
 * A pin, carrying the pin it supersedes. ONE act: superseding the previous pin is what
 * pinning a new one MEANS, so splitting it would let a clone fold half of it and hold two
 * active populations for one rule.
 */
export const publishPopulationPinned = (
  logRoot: string, scope: string, actor: Actor, pin: PopulationPredicate, supersedes?: string,
) => put(logRoot, scope, actor, "population.pinned", pin.id, { pin, ...(supersedes ? { supersedes } : {}) });

/**
 * The schedule, subject-keyed on the scope: a policy is a decision and two of them is no
 * policy, so the LAST one wins rather than accumulating.
 */
export const publishScrubPolicy = (logRoot: string, scope: string, actor: Actor, policy: ScrubPolicy) =>
  put(logRoot, scope, actor, "scrub.policy", scope, { policy });

export const publishProblemRaised = (logRoot: string, scope: string, actor: Actor, problem: Problem) =>
  put(logRoot, scope, actor, "problem.raised", problem.id, { problem });

export const publishAdjudication = (
  logRoot: string, scope: string, actor: Actor, id: string,
  disposition: string, reason: string, at: string,
) => put(logRoot, scope, actor, "problem.adjudicated", id, { disposition, reason, at });

// --- folding -----------------------------------------------------------------

const obj = (d: unknown, k: string): any => (d && typeof d === "object" ? (d as any)[k] : undefined);
const str = (d: unknown, k: string): string | undefined => {
  const v = obj(d, k);
  return typeof v === "string" ? v : undefined;
};

/**
 * Replay one universe's standard.
 *
 * Events arrive in the log's total order, which is what makes this deterministic: every
 * clone sees the same sequence and applies the same operations to the same base. Anything
 * that would need a local observation — live hashes, whether the code conforms now — is
 * NOT computed here; it is derived at read time from rows the projection wrote.
 *
 * Unknown kinds are skipped rather than refused: a newer clone may write an act this
 * build does not model, and folding what it does understand is better than answering
 * nothing. What it must never do is drop a row it cannot PARSE — see `CorruptProjection`.
 */
/** The one rewritable value on a pointer, and therefore the only one that can conflict. */
const POINTER_CONTESTABLE = ["witnesses"] as const;

/**
 * Do two baselines say the same thing?
 *
 * Identity is wrong here — two identical witness arrays are different objects, so `===`
 * would raise a contest on every concurrent restate, including the ordinary case where
 * both auditors baselined the same hashes and agree completely. Order-insensitive on
 * `anchorId`, because the set is what the baseline means and `watched()` makes no
 * ordering promise.
 */
function sameBaseline(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const key = (w: BugWitness) => `${w.anchorId}\0${w.bodyHash}`;
  const left = [...(a as BugWitness[])].map(key).sort();
  const right = [...(b as BugWitness[])].map(key).sort();
  return left.every((k, i) => k === right[i]);
}

/**
 * Is this actor barred from rewriting or pulling this operation, because somebody ELSE's
 * pending approval hangs off it?
 *
 * The tool's `attachedByOthers`, restated where a remote clone can see it. The tool's count
 * is TOCTOU across clones — a gap granted elsewhere is invisible to it — so without this a
 * revision races an acknowledgement and silently changes what that grant approved.
 */
function revisionBlocked(
  op: Operation, actor: Actor, acknowledgements: Map<string, Acknowledgement>,
): boolean {
  for (const ack of acknowledgements.values()) {
    if (ack.operationId !== op.id) continue;
    if (ack.state === "released") continue;
    if (ack.grantedBy?.principal !== actor.principal) return true;
  }
  return false;
}

/**
 * Fold the standard from a MERGED event stream — law plus evidence.
 *
 * `opts.evidence` says whether the evidence half could be read as settled. It defaults to
 * true so every existing caller and test is unchanged, and it is load-bearing in exactly
 * one place: `spec.withdrawn`. Withdrawal is permitted only when NOTHING relies on what a
 * spec introduced, and reliance is counted from audits, pointers, populations, problems and
 * criteria. A fold that cannot see those does not find *less* reliance — it finds NONE, and
 * permits a withdrawal that something already cites. That is the one failure in this design
 * that answers wrongly rather than incompletely, so it refuses instead.
 */
/**
 * What a named reviewer has NOT approved of a proposal as it now stands.
 *
 * The one computation behind both ends. `ratifySpec` refuses on it and renders it for the
 * caller; `foldStandard` refuses the arriving `spec.ratified` on the same result, because
 * a ratification reaching a teammate's clone was never seen by their MCP call — and a
 * signature check that binds only the machine that ran it is not a signature check.
 *
 * Keyed on the RATIFIER's own principal. Somebody else having read the proposal is not the
 * ratifier having read it, and adoption is the act that produces accountability (COD-17 —
 * accountability, never evidence).
 */
export interface ReviewGap {
  reviewer: string;
  total: number;
  /** Never signed off by this reviewer. */
  unwitnessed: { id: string; kind: string; title: string }[];
  /** Signed off, and the text moved afterwards. Carries what moved. */
  moved: {
    id: string; kind: string; title: string; readAt: string;
    changed: { field: string; was?: string; now?: string }[];
  }[];
  /** The spec's title and narrative — what every operation is read under. */
  framing?: { state: "unwitnessed" | "moved"; readAt?: string; changed?: { field: string; was?: string; now?: string }[] };
}

export const reviewComplete = (g: ReviewGap): boolean =>
  !g.unwitnessed.length && !g.moved.length && !g.framing;

/** A short label for an operation in a refusal — what it does, to what. */
export const operationLabel = (op: Operation): string =>
  op.title ?? op.criterion ?? (op.fromSection ? `${op.fromSection} -> ${op.toSection}` : undefined) ?? op.requirementId ?? op.id;

export function reviewGap(
  spec: Spec, ops: Operation[], witnesses: ProposalWitness[], reviewer: string,
): ReviewGap {
  const mine = witnesses.filter((w) => w.specId === spec.id && w.reviewer.principal === reviewer);
  // LAST one wins, and the rows are in log order: a reviewer who signs off, the text
  // moves, and they sign off again has read the current text.
  const latest = new Map<string, ProposalWitness>();
  for (const w of mine) latest.set(w.operationId ?? "", w);

  const gap: ReviewGap = { reviewer, total: ops.length, unwitnessed: [], moved: [] };
  const frame = latest.get("");
  const frameNow = framingContent(spec);
  if (!frame) gap.framing = { state: "unwitnessed" };
  else if (witnessHash(frame.content) !== witnessHash(frameNow)) {
    gap.framing = { state: "moved", readAt: frame.at, changed: contentDiff(frame.content, frameNow) };
  }
  for (const op of ops) {
    const w = latest.get(op.id);
    const label = operationLabel(op);
    if (!w) { gap.unwitnessed.push({ id: op.id, kind: op.kind, title: label }); continue; }
    const now = operationContent(op);
    if (witnessHash(w.content) !== witnessHash(now)) {
      gap.moved.push({ id: op.id, kind: op.kind, title: label, readAt: w.at, changed: contentDiff(w.content, now) });
    }
  }
  return gap;
}

export function foldStandard(events: LogEvent[], opts: { evidence?: boolean } = {}): SharedStandard {
  const evidenceReadable = opts.evidence !== false;
  const specs = new Map<string, Spec>();
  const operations = new Map<string, Operation>();
  // Keyed on subject-and-reviewer, so a later sign-off REPLACES the earlier one: a
  // ratification asks what you last read, never how many times you looked. Named `reviews`
  // and not `witnesses` because `spec.ratified` already binds that word to the CODE
  // hashes it carries, which are a different observation entirely.
  const reviews = new Map<string, ProposalWitness>();
  const requirements = new Map<string, Requirement>();
  const criteria = new Map<string, AcceptanceCriterion>();
  const vacuityChecks = new Map<string, VacuityCheck>();
  const pointers = new Map<string, Pointer>();
  const populations = new Map<string, PopulationPredicate>();
  let scrubPolicy: ScrubPolicy | null = null;
  const acknowledgements = new Map<string, Acknowledgement>();
  const audits = new Map<string, Audit>();
  const problems = new Map<string, Problem>();
  const contest = newContestState();
  const causal = causality(events);

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    switch (e.kind) {
      case "spec.drafted": {
        const spec = obj(e.data, "spec") as Spec | undefined;
        // `title` and `createdAt` too, not just an id: both are NOT NULL in the projection,
        // and `draftSpec` refuses a spec without a title. See `bindable` in
        // `shared-projections.ts` for what an unbindable row used to cost.
        if (!spec?.id || !spec.title?.trim() || !spec.createdAt) break;
        specs.set(spec.id, { ...spec, status: "draft", origin: "sync" });
        break;
      }
      case "spec.operation": {
        const op = obj(e.data, "operation") as Operation | undefined;
        if (!op?.id) break;
        // A DRAFT check, which this arm had none of. `addOperation` refuses a spec that is
        // not a draft; the fold took the row verbatim, so Bob — who has not pulled — could
        // add an `amend_statement` to a spec Alice already ratified. It never applies, and
        // that is not the end of it: nothing distinguishes it from an adopted operation in
        // `readOperations({requirementId})`, and `moveMade` in `problems.ts` tests only the
        // kind, `spec.status === "ratified"` and `ratifiedAt >= since` — so a problem CLOSES
        // on an amendment that never changed anything.
        //
        // An operation for a spec this fold has not seen drafted is kept: the drafting shard
        // may simply not have arrived, the same allowance `spec.ratified` makes above.
        const sp = specs.get(op.specId);
        if (sp && sp.status !== "draft") break;
        operations.set(op.id, { ...op, origin: "sync" });
        break;
      }
      /**
       * Correcting a DRAFT — the fold half of `reviseSpec` / `reviseOperation` /
       * `removeOperation`.
       *
       * Every refusal the tool makes is restated here, because a row reaching a teammate's
       * clone was never seen by their MCP call. The one that carries the design is the
       * DRAFT check: immutability attaches at ratification, so an event that would rewrite
       * a ratified spec or one of its operations is dropped whoever wrote it. Anything else
       * would let a client edit the act that produced a binding rule.
       *
       * Deliberately NOT restated: the comment count. Notes are a different sidecar scope
       * and `foldStandard` does not read it — see `commentsByOthers`, which states the
       * consequence.
       */
      case "spec.revised": {
        const next = obj(e.data, "spec") as Spec | undefined;
        const sp = next?.id ? specs.get(next.id) : undefined;
        if (!next || !sp || sp.status !== "draft") break;
        if (!next.title?.trim()) break;
        // See `spec.operation.revised` for the argument. Same biconditional, over the
        // framing rather than the operation.
        if ((JSON.stringify(framingContent(sp)) !== JSON.stringify(framingContent({ ...sp, title: next.title, narrative: next.narrative })))
          !== ((next.revisions ?? []).length > (sp.revisions ?? []).length)) break;
        specs.set(sp.id, {
          ...sp, title: next.title, narrative: next.narrative,
          revisions: next.revisions, origin: "sync",
        });
        break;
      }
      case "spec.operation.revised":
      case "spec.operation.removed": {
        const next = obj(e.data, "operation") as Operation | undefined;
        const cur = next?.id ? operations.get(next.id) : undefined;
        if (!next || !cur) break;
        const sp = specs.get(cur.specId);
        if (!sp || sp.status !== "draft") break;
        // A kind change is a different operation validated against fields this one was
        // never written with; the tool refuses it and so does this.
        if (next.kind !== cur.kind) break;
        if (revisionBlocked(cur, e.actor, acknowledgements)) break;
        if (e.kind === "spec.operation.removed") {
          if (cur.removed || !next.removed?.reason?.trim()) break;
          // A criterion in this same draft naming the operation as its target would be left
          // with no rule. Restated from the fold's OWN operation map rather than from the
          // writer's account of it.
          const dependents = [...operations.values()]
            .some((o) => o.specId === cur.specId && !o.removed && o.targetOperationId === cur.id);
          if (dependents) break;
          operations.set(cur.id, { ...cur, removed: next.removed, origin: "sync" });
          for (const [id, ack] of acknowledgements) {
            if (ack.operationId === cur.id && ack.state !== "released") {
              acknowledgements.set(id, { ...ack, state: "released", releasedAt: next.removed.at });
            }
          }
          break;
        }
        if (cur.removed) break;
        // A rewrite and a revision entry must arrive TOGETHER. Either alone misdescribes
        // what happened, in opposite directions:
        //
        //  - entry, no rewrite: `reviseOperation` refuses it ("nothing to change") and this
        //    end did not, so every clone renders "corrected 1× — <reason>" over text that
        //    never moved. With `reason` on the entry that is a paragraph of prose accounting
        //    for an act nobody performed.
        //  - rewrite, no entry: the text a ratifier already signed changes with nothing
        //    saying it did. `reviewGap` re-hashes the content so the SIGNATURE still
        //    invalidates — but the correction history, which is the reader's account of
        //    why, silently omits it.
        //
        // Compared over `operationContent` rather than over the writer's own `was`, and
        // that is the whole subtlety. `changedFields` records `was[k] = before[k]`, which
        // for a field being SET for the first time is `undefined` — a key JSON drops. So a
        // revision adding an absent `evidence` arrives with `was: {}` and a `was`-based
        // check discards it: the tool answers `{ok: true}`, the fold writes nothing, and on
        // a sidecar store the correction exists nowhere at all. This asks the operation
        // what it says instead of asking the writer what they claim to have changed.
        const moved = JSON.stringify(operationContent(cur)) !== JSON.stringify(operationContent(next));
        if (moved !== ((next.revisions ?? []).length > (cur.revisions ?? []).length)) break;
        // `ord`, `specId` and `removed` are the fold's, never the writer's: a revision that
        // moved an operation's position would re-order a proposal a ratifier already read.
        operations.set(cur.id, { ...next, specId: cur.specId, ord: cur.ord, removed: undefined, origin: "sync" });
        break;
      }
      case "spec.reviewed": {
        const w = obj(e.data, "witness") as ProposalWitness | undefined;
        if (!w?.id || !w.content) break;
        const sp = specs.get(w.specId);
        // Only a DRAFT is reviewable. A witness of a ratified spec claims a reading of
        // something that can no longer change, which is nothing, and folding one would let
        // a witness arrive AFTER the ratification it is supposed to have preceded.
        if (!sp || sp.status !== "draft") break;
        // A reviewer's sign-off is a PRINCIPAL's act, restated where a remote clone can see
        // it. Letting an agent write it would void the whole gate in one step: an agent
        // signs off twelve operations for its principal and the principal then ratifies
        // having read none of them — completion drive taking the shortest path, which is
        // the failure this subsystem is built against.
        if (e.actor.via) break;
        // The reviewer is the EVENT's actor, never the payload's. A row that named its own
        // reviewer would let one clone write another person's approval.
        if (w.operationId) {
          const op = operations.get(w.operationId);
          if (!op || op.specId !== sp.id || op.removed) break;
        }
        reviews.set(`${w.specId}|${w.operationId ?? ""}|${e.actor.principal}`, {
          ...w, reviewer: e.actor, at: str(e.data, "at") ?? w.at ?? e.at, origin: "sync",
        });
        break;
      }
      case "spec.ratified": {
        const sp = specs.get(e.subject);
        // A ratification for a spec this fold never saw drafted is not fatal: the drafting
        // shard may simply not have arrived yet, and the next sync completes it.
        // `!== "draft"`, not `=== "ratified"`. Every other spec arm in this fold tests for a
        // draft; this one tested only for a double-ratify, so a WITHDRAWN or REPEALED spec
        // could still be adopted. `ratifySpec` refuses anything but a draft and deliberately
        // does not pull, so it needs no bad actor: Alice withdraws the draft, Bob ratifies
        // from a read taken before the pull, and the row lands `status: "ratified"` while
        // still carrying `withdrawnBy`/`withdrawnAt` — a spec that is both, which no verb
        // can undo, since a second ratification breaks here and a fresh withdrawal must
        // clear `foldReliance`.
        if (!sp || sp.status !== "draft") break;
        // Adoption is a principal's act, and a remote clone sees only this row. Without
        // this the tool's gate binds nobody but the machine that ran it.
        if (e.actor.via) break;
        const at = str(e.data, "at") ?? e.at;
        const witnesses = (obj(e.data, "witnesses") ?? {}) as Record<string, BugWitness[]>;
        // The operations the principal actually approved, pinned on the event. Collecting
        // them at replay time instead let an operation authored by an un-synced clone sort
        // BEFORE the ratification and be adopted though nobody ever saw it in the diff —
        // or sort after and be dropped for ever while `addOperation` had returned ok.
        const pinned = obj(e.data, "operations") as string[] | undefined;
        // `!o.removed` on BOTH arms. `readOperations` drops a tombstone by default, so
        // `ratifySpec` can never adopt one and this end could: Bob calls `remove_operation`,
        // Alice ratifies from a clone that has not pulled — `ratifySpec` deliberately does
        // not pull — and pins it, and the withdrawn rule is created on every clone. It even
        // reads as reviewed, because `operationContent` omits `removed` so the witness still
        // matches. Filtering here also makes the count differ from `pinned`, which the
        // existing length check below turns into `conflicted` rather than a silent drop.
        const mine = (pinned
          ? pinned.map((id) => operations.get(id)).filter((o): o is Operation => !!o && !o.removed)
          : [...operations.values()].filter((o) => o.specId === sp.id && !o.removed))
          .sort((a, b) => a.ord - b.ord);

        // Context, verified here and not only in the tool. The local check is TOCTOU
        // across clones — the log is pull/push and never read on an ordinary read — so two
        // principals can each validate against the same statement and both append. Without
        // this the second silently overwrites an amendment the first ratified.
        //
        // ALL OR NOTHING, exactly as `ratifySpec` refuses: applying the half that still
        // fits yields a standard nobody approved.
        const stale = mine.some((op) => {
          // A section move carries no `context` — its subject is a path, not a statement —
          // so it needs its own applicability test or it is the ONE operation kind that
          // slips through this check on every clone. A move whose source has since been
          // emptied applies cleanly and does nothing, which is the silent half.
          if (op.kind === "move_section") return !moveApplicable(requirements, op, mine);
          if (!op.context) return false;
          const cur = requirements.get(op.context.requirementId);
          return !cur || cur.status === "retired" || cur.statement !== op.context.statement;
        });
        // The RATIFIER's own signature over the proposal's own text, restated here for the
        // reason every other gate is: this row reaching a teammate's clone was never seen
        // by their MCP call. Without it the witness binds one machine, and the machine it
        // binds is the one whose operator already chose to run the check.
        //
        // `conflicted` rather than a skip, exactly as a moved base is: the ratification
        // really happened and the honest record says so; what did not happen is the
        // application. A silent skip would leave the spec `draft` on the receiving clone
        // with nothing saying why.
        const unread = !reviewComplete(reviewGap(sp, mine, [...reviews.values()], e.actor.principal));
        // The `add_requirement` operations this ratification carries, so a criterion naming
        // one can be checked against what actually landed rather than against a derived id.
        const creating = new Set(mine.filter((o) => o.kind === "add_requirement").map((o) => o.id));
        // DRY RUN, and it is the difference between all-or-nothing and nearly-all.
        //
        // `applyOperation` skips an operation it cannot apply — a criterion aimed at a
        // non-`add_requirement`, a move with an empty end, an amend whose rule is gone. In
        // a bare loop each skip is silent, so a spec with one malformed operation folded
        // `ratified` and NOT `conflicted`, carrying every OTHER operation: a partial
        // application, on the one surface that promises adoption is all-or-nothing, and
        // invisible because the spec looks adopted and the missing rule looks unproposed.
        //
        // Throwaway copies rather than a second predicate: a hand-written "would this
        // apply" check is a second copy of six guards that drift apart. The maps are
        // replace-not-mutate, so a shallow clone is a real sandbox. `siblings`/`creating`
        // are read-only here.
        const dryR = new Map(requirements), dryC = new Map(criteria);
        const allApply = mine.every((op) =>
          applyOperation(dryR, dryC, op, sp, e.actor, at, witnesses[op.id] ?? [], creating));
        // `conflicted` rather than a skip, for the reason the moved-base case is: the
        // ratification really happened and the honest record says so; what did not happen
        // is the application.
        if (stale || unread || !allApply || (pinned && mine.length !== pinned.length)) {
          specs.set(sp.id, { ...sp, status: "ratified", ratifiedBy: e.actor, ratifiedAt: at, conflicted: true });
          break;
        }
        specs.set(sp.id, { ...sp, status: "ratified", ratifiedBy: e.actor, ratifiedAt: at });
        for (const op of mine) applyOperation(requirements, criteria, op, sp, e.actor, at, witnesses[op.id] ?? [], creating);

        // Bind what the operations produced. The LOCAL path does this at ratification
        // (`writeLocalOperation` with the new id, and `bindGapsForSpec`); without the same
        // binding here, a shared `add_requirement` kept `requirementId: null` for ever —
        // so a folded rule had no history and never reported `irreversible`, and a folded
        // GAP was attached to nothing, silencing a requirement that nothing could find it
        // by. Both are the "one team fact, invisible on every other clone" shape.
        for (const op of mine) {
          // A criterion attached to a rule this spec creates binds the same way, and it
          // has to happen HERE and not in `applyOperation`: the operation row is what
          // `readOperations({requirementId})` reads, so without this a criterion added
          // alongside its rule has no history on either end.
          if (op.kind === "add_criterion") {
            if (op.targetOperationId) operations.set(op.id, { ...op, requirementId: requirementIdFor(op.targetOperationId) });
            continue;
          }
          if (op.kind !== "add_requirement") continue;
          const rid = requirementIdFor(op.id);
          operations.set(op.id, { ...op, requirementId: rid });
          for (const [id, ack] of acknowledgements) {
            // Bind AND activate together — see `bindGapsForSpec`. A released one stays
            // released: adopting the spec does not resurrect an acceptance somebody
            // withdrew while it was still a proposal.
            if (ack.operationId === op.id && !ack.requirementId && ack.state !== "released") {
              acknowledgements.set(id, { ...ack, requirementId: rid, state: "active" });
            }
          }
        }
        // And the DETECTORS proposed with this spec — `bindPointersForSpec` at the end that
        // binds every clone. Outside the loop above because a detector hangs off an
        // `add_criterion`, which that loop `continue`s past, and because a pointer whose
        // operation was PULLED has to be retired rather than left `pending` for ever: its
        // criterion is never going to exist.
        const mineIds = new Map(mine.map((o) => [o.id, o]));
        const pulled = new Map(
          [...operations.values()].filter((o) => o.specId === sp.id && o.removed).map((o) => [o.id, o]),
        );
        for (const [id, p] of pointers) {
          if (p.state !== "pending" || !p.operationId) continue;
          if (mineIds.has(p.operationId)) pointers.set(id, { ...p, state: "active", origin: "sync" });
          else if (pulled.has(p.operationId)) {
            pointers.set(id, {
              ...p, state: "retired", retiredBy: e.actor, retiredAt: at, origin: "sync",
              retiredReason: `the operation it was proposed with was pulled from ${sp.id}`,
            });
          }
        }
        break;
      }
      case "spec.withdrawn": {
        const sp = specs.get(e.subject);
        if (!sp || sp.status === "withdrawn" || sp.status === "repealed") break;
        // A withdrawal with no reason. `withdrawSpec` refuses one — "it stays on the record
        // as the act it is" — and the fold did not, so a client that skipped the field
        // removed rules from every clone's standard with nothing on the record saying why.
        // Same shape as the retired-pointer gate below it.
        if (!str(e.data, "reason")?.trim()) break;
        // See the header. Absent evidence makes `foldReliance` answer zero, not unknown.
        if (!evidenceReadable) break;
        // Withdrawal takes something OUT of the standard, so it is a principal's act — the
        // same gate `withdrawSpec` applies, restated where a remote clone can see it.
        //
        // With ONE exception, and it is the same one the tool makes: an agent may take back
        // its own principal's DRAFT. Nothing applied, so nothing is unbound, and COD-29 puts
        // authorship on the open side of the asymmetry. The two conditions the tool checks
        // are both re-checked here from the fold's own rows — the author on the spec, and
        // any pending acknowledgement somebody else granted against its operations — because
        // this row was never seen by the receiving clone's MCP call.
        if (e.actor.via) {
          if (sp.status !== "draft") break;
          if (sp.author?.principal !== e.actor.principal) break;
          const mineSoFar = [...operations.values()].filter((o) => o.specId === sp.id && !o.removed);
          if (mineSoFar.some((o) => revisionBlocked(o, e.actor, acknowledgements))) break;
        }
        const at = str(e.data, "at") ?? e.at;
        // `!o.removed`, exactly as `mineSoFar` four lines above already had it. `withdrawSpec`
        // counts live operations only, so without this the fold saw a tombstone the tool never
        // did and refused a withdrawal the tool had approved — permanently, with the wrong
        // diagnosis ("something already relies on what the spec introduced"). A spent spec
        // cannot be re-withdrawn, so the rule could never leave the standard on any clone.
        const mine = [...operations.values()].filter((o) => o.specId === sp.id && !o.removed);
        if (sp.status === "ratified") {
          // Both refusals, in the fold and not only in the tool. The tool's reliance count
          // is TOCTOU across clones — an audit or a pointer appended elsewhere is invisible
          // to it — so without this a withdrawal races a citation and orphans it on every
          // machine but the one that asked.
          if (mine.some((o) => o.kind !== "add_requirement" && o.kind !== "add_criterion")) break;
          if (foldReliance(sp, mine, { operations, acknowledgements, audits, problems, criteria, pointers, populations, vacuityChecks }).length) break;
          // Reliance that arrives LATER in the log. The fold is one forward pass, so a
          // citation appended concurrently on another clone may sort after this event —
          // and then the rule is deleted here and the audit or pointer that cites it lands
          // on nothing. Looking ahead is deterministic (every clone folds the same ordered
          // log) and it makes the WITHDRAWAL lose the race, which is the direction this
          // subsystem gates in: removing a rule is the quieting act.
          //
          // Deliberately crude — a substring match on the serialized event rather than a
          // per-kind reader. It cannot miss a reference, every false positive refuses the
          // withdrawal rather than allowing it, and a per-kind version would have to be
          // extended in lockstep with every record kind that learns to cite a rule, which
          // is the maintenance shape `foldReliance` already has to carry once.
          const doomed = [
            ...mine.filter((o) => o.kind === "add_requirement").map((o) => requirementIdFor(o.id)),
            // The criteria go too, and a `vacuity.checked` names one of these and no rule.
            ...mine.filter((o) => o.kind === "add_criterion").map((o) => criterionIdFor(o.id)),
          ];
          const later = events.slice(i + 1).some((n) => {
            if (n.kind === "spec.withdrawn") return false;
            const blob = JSON.stringify(n.data ?? {});
            return doomed.some((rid) => blob.includes(rid));
          });
          if (later) break;
          for (const o of mine) {
            if (o.kind === "add_requirement") requirements.delete(requirementIdFor(o.id));
            if (o.kind === "add_criterion") criteria.delete(criterionIdFor(o.id));
          }
        }
        for (const o of mine) {
          // A detector PROPOSED with this spec, retired for the same reason and by the same
          // argument. Withdrawal was the one exit from `pending` nothing covered: ratification
          // binds, and a pulled operation retires at ratification — but a spec that is never
          // adopted at all left the pointer pending for ever, watching a criterion that will
          // never exist, reachable by nothing. Retired, not deleted: it was really proposed.
          for (const [id, p] of pointers) {
            if (p.state === "pending" && p.operationId === o.id) {
              pointers.set(id, {
                ...p, state: "retired", retiredBy: e.actor, retiredAt: at,
                retiredReason: `the spec it was proposed with was withdrawn`, origin: "sync",
              });
            }
          }
          for (const [id, ack] of acknowledgements) {
            // Released, not deleted: the grant really happened, and the rule it approved is
            // the thing that stops existing.
            if (ack.operationId === o.id && ack.state !== "released") {
              acknowledgements.set(id, { ...ack, state: "released", releasedAt: at });
            }
          }
        }
        specs.set(sp.id, { ...sp, status: "withdrawn", withdrawnBy: e.actor, withdrawnAt: at });
        break;
      }
      case "ack.granted": {
        const ack = obj(e.data, "ack") as Acknowledgement | undefined;
        if (!ack?.id) break;
        // DEBT is an admission with an owner, so an agent may not grant one — the same
        // rule `acknowledgeDebt` enforces, restated where a remote clone can see it. A
        // GAP from an agent is legitimate: an auditor classifying ahead of adoption is
        // the intended caller, and a gap admits nothing.
        if (ack.basis === "debt" && e.actor.via) break;
        // `checkCommon`'s three field checks, restated — see `ACK_PRIORITIES` in `schema.ts`
        // for why their absence here made a PERMANENT silencer rather than an untidy row.
        if (!ack.rationale?.trim()) break;
        if (!ACK_PRIORITIES.includes(ack.priority)) break;
        if (!ack.revalidateBy || !ISO_DATE.test(ack.revalidateBy)) break;
        // A GAP must still be MINTED BEFORE RATIFICATION, and only this end binds a writer
        // whose tool did not check. `Acknowledgement.operationId` calls that asymmetry
        // "structural rather than advisory" because the local path takes an operation in a
        // draft spec — but the fold took the record's word for it, so an event naming a
        // ratified `requirementId` and no operation at all was accepted verbatim and
        // `conformance()` then reported a binding rule as `gap`. That is the laundering the
        // whole record exists to close, arriving through the one door nobody was watching:
        // not "amend the rule to match the code" but "declare the rule not yet applicable".
        if (ack.basis === "gap") {
          const op = ack.operationId ? operations.get(ack.operationId) : undefined;
          if (!op || op.kind !== "add_requirement") break;
          if (specs.get(op.specId)?.status === "ratified") break;
        }
        // A GAP folds PENDING: it is part of an argument nobody has adopted yet, and it
        // silences nothing until ratification binds it — in the same act that creates the
        // rule. Folding it active would leave a silencer for a spec that may never land,
        // and this end is the one that binds a clone whose tool did not check.
        acknowledgements.set(ack.id, {
          ...ack, state: ack.basis === "gap" ? "pending" : "active", origin: "sync",
        });
        break;
      }
      case "ack.released": {
        const a = acknowledgements.get(e.subject);
        if (!a || a.state === "released") break;
        // No reason check here, unlike `spec.withdrawn` and `pointer.retired` above, and
        // that asymmetry is deliberate. `releaseAcknowledgement` does refuse an empty
        // reason — but refusing one HERE would leave the silencer active on every clone
        // but the author's, which is the quieting direction. Gate what silences.
        acknowledgements.set(a.id, {
          ...a, state: "released", releasedBy: e.actor,
          releasedAt: str(e.data, "at") ?? e.at, releasedReason: str(e.data, "reason") ?? "",
        });
        break;
      }
      case "audit.recorded": {
        const audit = obj(e.data, "audit") as Audit | undefined;
        if (!audit?.id) break;
        // Provisional work is about somebody's branch, not about the codebase. `shareAudit`
        // will not send one; this binds a client that did.
        if (audit.provisional) break;
        // Every rule about the RECORD itself, restated where it binds a writer whose tool
        // did not check: the outcome, the trigger, a finding, evidence that matches the
        // outcome, and witnesses that match the evidence. `readProvisionalAudits` applies
        // the same predicate to a teammate's file. See `auditClaimStands` for what each
        // clause is and which of them the two ends used to disagree about.
        if (!auditClaimStands(audit)) break;
        // An observation resets the deadline of the POINTER it names, so a trigger owes
        // exactly what it claims to have looked at: a covering audit every active pointer,
        // a `differential` one the subset it examined, an `ad-hoc` one none at all.
        // `recordAudit` refuses an omission, a phantom and a repeat; this end binds a clone
        // whose tool did not. The pointer state comes from the fold's OWN map, so it is the
        // team's view of what was active rather than the writer's account of it.
        {
          const trigger = audit.trigger ?? "ad-hoc";
          const obs = audit.observations ?? [];
          const covering = COVERING_TRIGGERS.includes(trigger);
          if (!covering && trigger !== "differential" && obs.length) break;
          if (covering || obs.length) {
            if (obs.some((o) => !o?.pointerId || typeof o.firing !== "boolean")) break;
            const watching = [...pointers.values()]
              .filter((p) => p.requirementId === audit.requirementId && p.state === "active");
            const seen = new Set(obs.map((o) => o.pointerId));
            // Exhaustive only where the audit claims to have covered the whole rule.
            if (covering && watching.some((p) => !seen.has(p.id))) break;
            if (obs.some((o) => !watching.some((p) => p.id === o.pointerId))) break;
            if (seen.size !== obs.length) break;
          }
        }
        audits.set(audit.id, { ...audit, origin: "sync" });
        break;
      }
      case "vacuity.checked": {
        const check = obj(e.data, "check") as VacuityCheck | undefined;
        if (!check?.id || !check.criterionId) break;
        if (!VACUITY_VERDICTS.includes(check.verdict)) break;
        // The criterion has to EXIST here. A check against an id nothing created is a
        // verdict about nothing that `criteriaFor` will never surface and no reader will
        // ever see — and it can never be superseded, so it would sit in the log for ever.
        const subject = criteria.get(check.criterionId);
        if (!subject) break;
        // A `demonstrated` check with no witnesses can NEVER be superseded — `serveCheck`
        // treats an empty witness list as "nothing to drift from" — so it would certify a
        // check for ever, across every rewrite of that check. `recordVacuityCheck` cannot
        // produce one (it refuses `demonstrated` on an unasserted criterion and witnesses
        // whatever `assertedBy` names); this is that refusal at the end that binds a clone.
        if (check.verdict === "demonstrated" && !check.witnesses?.length) break;
        // The evidence gate, restated where it binds every clone and not only the machine
        // whose tool ran it. `demonstrated` is the SILENCING direction — it says the check
        // is trustworthy, which is what lets an audit lean on it — so a demonstration that
        // records no method is the vacuous claim wearing the shape of evidence, which is
        // `audit.recorded`'s argument arriving one layer down. The weakening verdicts are
        // deliberately not gated: gating them would gate what UNSILENCES.
        if (check.verdict === "demonstrated" && !check.method?.trim()) break;
        vacuityChecks.set(check.id, { ...check, origin: "sync" });
        break;
      }
      case "pointer.declared": {
        const p = obj(e.data, "pointer") as Pointer | undefined;
        if (!p?.id || !p.requirementId) break;
        if (p.target?.kind !== "node" && p.target?.kind !== "anchor") break;
        // A pointer with no rationale is one nobody can evaluate, which is the vacuity
        // problem arriving at the record that exists to make auditing cheaper. Refused in
        // `declarePointer` and restated here, because the tool binds only writers who ask.
        if (!p.rationale?.trim()) break;
        // A pointer with NO witnesses can never fire, and a pointer that cannot fire reads
        // as coverage while providing none — the `never fires → false calm` pathology
        // arriving at declaration time rather than through a rate. `declarePointer` refuses
        // an address that does not resolve, which is what guarantees witnesses locally; a
        // doc citing nothing is the one legitimate empty case and it is a `node` target.
        if (p.target.kind === "anchor" && !p.witnesses?.length) break;
        // ACTIVE, whatever the payload said — with ONE exception. A `declared` event
        // carrying `state: "retired"` would fold to a pointer that was never watching
        // anything and cannot be retired again, the same partial-strip shape that let
        // `problem.raised` name a decider who never decided.
        //
        // The exception is `pending`, and it is earned rather than trusted: the payload
        // must name an `add_criterion` in a spec that is still a DRAFT here, which is
        // `proposePointer`'s guard restated at the end that binds every clone. Without the
        // check a client could mint a permanently pending pointer against nothing; without
        // the exception a proposed detector would fold ACTIVE on every clone the moment it
        // was proposed, watching a criterion nobody has adopted — the mechanism inverted.
        const { retiredBy, retiredAt, retiredReason, restatedBy, restatedAt, ...declared } = p;
        if (p.state === "pending") {
          const against = p.operationId ? operations.get(p.operationId) : undefined;
          // DROPPED when it names nothing that could ever bind it. `proposePointer` refuses
          // a payload like this, and folding it `active` would turn a refusal at one end
          // into a live detector at the other — laxer than the tool, in the direction that
          // manufactures coverage.
          if (!against || against.kind !== "add_criterion" || against.removed) break;
          const sp = specs.get(against.specId);
          if (!sp) break;
          // The spec's state decides, NOT the payload's — and this is where two orderings of
          // the same two events used to disagree. A proposal folded before its ratification
          // bound; one folded after was silently dropped, so the author's own store kept a
          // detector every clone had thrown away, decided by nothing but the merge tiebreak.
          //
          // Both orderings now converge. Late is not invalid: the criterion exists by then,
          // which is exactly when `declarePointer` would have been the verb, so it folds
          // ACTIVE — an ordinary detector declared after adoption, which is the normal path.
          // What it loses is only that the ratifier did not see it, and a detector declared
          // after ratification never was seen.
          if (sp.status === "draft") pointers.set(p.id, { ...declared, state: "pending", origin: "sync" });
          else if (sp.status === "ratified") pointers.set(p.id, { ...declared, state: "active", origin: "sync" });
          // Withdrawn or repealed: the criterion is never going to exist. Retired rather than
          // dropped, so it reads as a proposal that went nowhere and not as one never made.
          else {
            pointers.set(p.id, {
              ...declared, state: "retired", retiredBy: e.actor, retiredAt: e.at, origin: "sync",
              retiredReason: `the spec it was proposed with was ${sp.status}`,
            });
          }
          break;
        }
        pointers.set(p.id, { ...declared, state: "active", origin: "sync" });
        break;
      }
      case "pointer.restated": {
        const p = pointers.get(e.subject);
        if (!p || p.state !== "active") break;
        const witnesses = obj(e.data, "witnesses") as BugWitness[] | undefined;
        if (!Array.isArray(witnesses)) break;
        // A re-baseline REWRITES a value, which is the one shape in this design that can
        // genuinely conflict — everything else is append-only or a latch. Two auditors
        // restating one pointer from two branches were silently resolved to whoever
        // folded last, and in load-bearing code that is where the other auditor's
        // observation was worth most. Both sides are correct; the fold keeps the residue
        // and hands it to whoever audits next rather than picking.
        const next: Pointer = { ...p, witnesses, restatedBy: e.actor, restatedAt: str(e.data, "at") ?? e.at };
        applyRevision(next, e, { witnesses }, POINTER_CONTESTABLE, contest, causal, sameBaseline);
        pointers.set(p.id, next);
        break;
      }
      case "pointer.retired": {
        const p = pointers.get(e.subject);
        if (!p || p.state === "retired") break;
        const reason = str(e.data, "reason");
        // A retirement with no reason is a rule quietly losing what watches it, which is
        // how a standard comes to look settled. Refused at both ends.
        if (!reason?.trim()) break;
        pointers.set(p.id, {
          ...p, state: "retired", retiredBy: e.actor,
          retiredAt: str(e.data, "at") ?? e.at, retiredReason: reason,
        });
        break;
      }
      case "population.pinned": {
        const pin = obj(e.data, "pin") as PopulationPredicate | undefined;
        if (!pin?.id || !pin.requirementId) break;
        if (pin.basis !== "lint" && pin.basis !== "not-expressible") break;
        if (!Array.isArray(pin.members)) break;
        // Zero members is GREEN and green reads as conformant, so an empty lint pin is
        // refused — the default failure mode here, not an edge case. Restated at the fold
        // because the tool binds only writers who ask, which is the one-end mistake this
        // subsystem has now shipped four times.
        if (pin.basis === "lint" && !pin.members.length) break;
        if (pin.basis === "lint" && pin.members.some((m) => !m?.id?.trim() || !MEMBER_STATES.includes(m.state))) break;
        // The one basis nothing can check needs its argument, or it is a silent route to
        // "this rule ranges over nothing" that no reader can evaluate.
        if (pin.basis === "not-expressible" && !pin.reason?.trim()) break;
        // Provisional work is about somebody's branch, not about the codebase.
        // `sharePopulationPinned` will not send one; this binds a client that did.
        if (pin.provisional) break;

        // The pin being replaced is found HERE, from this fold's own map — never read off
        // the event's `supersedes`. Trusting that field is the shape the `ack.granted` case
        // above already names: the fold took the record's word for it. An event that simply
        // OMITS `supersedes` then bypassed the narrowing gate entirely and left the rule
        // holding two active populations, which is a state nothing else models. It also
        // survives arrival order, which the field cannot: a superseding event can fold
        // before the pin it names, because an un-synced clone's shard sorts where the log
        // puts it and not where its writer expected.
        const prior = [...populations.values()]
          .find((x) => x.requirementId === pin.requirementId && x.state === "active");
        // NARROWING is a principal's act, and only this end binds a clone whose tool did
        // not check: dropping members can flip debt into a gap, which is silencing. Decided
        // from the two member lists rather than from the writer's account of the change.
        if (prior && e.actor.via) {
          const after = new Set(pin.members.map((m) => m.id));
          if (prior.members.some((m) => !after.has(m.id))) break;
        }
        if (prior) populations.set(prior.id, { ...prior, state: "superseded" });
        populations.set(pin.id, { ...pin, state: "active", origin: "sync" });
        break;
      }
      case "scrub.policy": {
        const policy = obj(e.data, "policy") as ScrubPolicy | undefined;
        if (!policy) break;
        // A period of zero covers nothing, and a rate from one look is not a rate. Both
        // refused at both ends: a policy this build cannot honour would make the scrub
        // report pathologies it has no basis for.
        if (!Number.isFinite(policy.coverageDays) || policy.coverageDays <= 0) break;
        if (!Number.isInteger(policy.minObservations) || policy.minObservations < 2) break;
        scrubPolicy = { ...policy, origin: "sync" };
        break;
      }
      case "problem.raised": {
        const p = obj(e.data, "problem") as Problem | undefined;
        // `requirementId`, `auditId` and `raisedAt` are NOT NULL in the projection, and
        // `raiseProblem` supplies all three — a problem is BY DEFINITION about a rule and
        // provoked by an audit. See `bindable` in `shared-projections.ts`.
        if (!p?.id || !p.requirementId || !p.auditId || !p.raisedAt) break;
        // Raised state only, and EVERY adjudication field is stripped rather than just
        // the verdict: a payload carrying `adjudicatedBy` with no `disposition` would
        // otherwise fold to a problem that names a decider who never decided. Dropping
        // the verdict alone was the first version of this, and the test below is what
        // found it. See `docs/requirements-architecture.md`.
        // Same rule as the audit it rests on: a problem is exactly as shareable as its
        // evidence, and branch-local work is nobody else's.
        if (p.provisional) break;
        const { disposition, adjudicatedBy, adjudicatedAt, adjudicationReason, ...raised } = p;
        problems.set(p.id, { ...raised, origin: "sync" });
        break;
      }
      case "problem.adjudicated": {
        const p = problems.get(e.subject);
        if (!p || p.disposition) break;
        // The fold must not be more permissive than the tool: adjudication is a
        // principal's act, and a remote clone sees only this row.
        if (e.actor.via) break;
        const disposition = str(e.data, "disposition");
        // Both of the tool's remaining checks, restated. Neither bound this end, and the
        // effect of the first is not cosmetic: an unrecognised verdict still counts as
        // adjudicated, so the problem leaves `awaitingAdjudication` on every clone while
        // `moveMade`'s switch falls through to `false` and `AWAITING[...]` is undefined —
        // a business question silently off the principal's queue and in the fix queue for
        // ever, with nothing saying what would close it.
        if (!PROBLEM_DISPOSITIONS.includes(disposition as NonNullable<Problem["disposition"]>)) break;
        // And a decision with no reason leaves a later reader only the verb.
        if (!str(e.data, "reason")?.trim()) break;
        problems.set(p.id, {
          ...p, disposition: disposition as Problem["disposition"],
          adjudicatedBy: e.actor, adjudicatedAt: str(e.data, "at") ?? e.at,
          adjudicationReason: str(e.data, "reason") ?? "",
        });
        break;
      }
      default: break;
    }
  }

  return {
    specs: [...specs.values()], operations: [...operations.values()],
    witnesses: [...reviews.values()],
    requirements: [...requirements.values()], criteria: [...criteria.values()],
    vacuityChecks: [...vacuityChecks.values()], pointers: [...pointers.values()],
    populations: [...populations.values()],
    // Derived, not stored twice: a scrub IS an audit with a covering trigger.
    scrubs: [...audits.values()].filter((a) => a.trigger === "scrub" || a.trigger === "baseline"),
    scrubPolicy,
    acknowledgements: [...acknowledgements.values()],
    audits: [...audits.values()], problems: [...problems.values()],
  };
}

const VACUITY_VERDICTS: VacuityCheck["verdict"][] = ["demonstrated", "vacuous", "wrong-layer"];
const MEMBER_STATES = ["conforms", "violates", "undecidable"];

/** The same application `ratifySpec` performs locally, over folded state. */
/**
 * The fold's half of `relianceOn` — what already depends on the rules a spec introduced.
 *
 * Written from the fold's maps rather than from store queries, so the two halves are
 * genuinely independent implementations of one rule; the correspondence is registered in
 * `sharing-boundary.test.ts`. Only the COUNT is used here — the tool reports which things
 * relied, because it is the end with a person reading the answer.
 */
function foldReliance(
  sp: Spec, mine: Operation[],
  m: {
    operations: Map<string, Operation>; acknowledgements: Map<string, Acknowledgement>;
    audits: Map<string, Audit>; problems: Map<string, Problem>;
    criteria: Map<string, AcceptanceCriterion>; pointers: Map<string, Pointer>;
    populations: Map<string, PopulationPredicate>; vacuityChecks: Map<string, VacuityCheck>;
  },
): string[] {
  const introduced = new Set(mine.filter((o) => o.kind === "add_requirement").map((o) => requirementIdFor(o.id)));
  const own = new Set(mine.map((o) => o.id));
  const hit: string[] = [];
  const cites = (rid: string | undefined) => !!rid && introduced.has(rid);
  // `!o.removed`, which `relianceOn` gets for free because `readOperations` drops a tombstone
  // by default. Without it this end counted an operation somebody PULLED from a draft, so a
  // withdrawal the tool approved was refused here for ever — and with the wrong diagnosis,
  // naming a row the caller had already withdrawn. A spent spec cannot be re-withdrawn, so
  // the rule could never leave the standard on any clone.
  for (const o of m.operations.values()) {
    if (o.removed || own.has(o.id)) continue;
    if (cites(o.requirementId) || cites(o.context?.requirementId)) hit.push(o.id);
  }
  for (const a of m.acknowledgements.values()) {
    if (a.state === "released") continue;
    if (a.operationId && own.has(a.operationId)) continue;
    if (cites(a.requirementId)) hit.push(a.id);
  }
  for (const a of m.audits.values()) if (cites(a.requirementId)) hit.push(a.id);
  for (const p of m.problems.values()) if (cites(p.requirementId)) hit.push(p.id);
  for (const c of m.criteria.values()) if (!own.has(c.introducedBy) && cites(c.requirementId)) hit.push(c.id);
  for (const p of m.pointers.values()) if (cites(p.requirementId)) hit.push(p.id);
  for (const p of m.populations.values()) if (cites(p.requirementId)) hit.push(p.id);
  // Hangs off a CRITERION, so `cites` cannot see it — and this spec's criteria go too.
  const doomedCriteria = new Set(mine.filter((o) => o.kind === "add_criterion").map((o) => criterionIdFor(o.id)));
  for (const v of m.vacuityChecks.values()) if (doomedCriteria.has(v.criterionId)) hit.push(v.id);
  void sp;
  return hit;
}

/**
 * Whether a `move_section` still means what it said — the fold's half of `checkMove`.
 *
 * Both halves must agree, and they are written from different inputs (a store query there,
 * this map here), so the correspondence is registered in `sharing-boundary.test.ts`. The
 * asymmetry worth knowing: a heading INSIDE the moving subtree is vacated by the move, so
 * it is never what `to` collides or case-clashes with — which is what makes `credit` →
 * `Credit`, the repair for a case split, a legal move rather than a refused one.
 */
function moveApplicable(
  requirements: Map<string, Requirement>, op: Operation, siblings: Operation[],
): boolean {
  const from = normalizeSection(op.fromSection ?? "");
  const to = normalizeSection(op.toSection ?? "");
  if (!from || !to || from === to) return false;
  const others = siblings.filter((o) => o.id !== op.id);
  const moving = (sec: string) => sec === from || sec.startsWith(`${from}/`);
  const known = new Set<string>([
    ...[...requirements.values()].map((r) => r.section),
    // Sections this same ratification opens have no row yet and count on both sides.
    ...others.filter((o) => o.kind === "add_requirement" && o.section).map((o) => normalizeSection(o.section!)),
  ]);
  const members = [...known].filter(moving);
  if (!members.length) return false;
  const produced = new Set(members.map((sec) => movedSection(sec, from, to)));
  const stay = [...known].filter((sec) => !moving(sec));
  if (stay.some((sec) => produced.has(sec))) return false;
  if (stay.some((sec) => sec.toLowerCase() === to.toLowerCase() && sec !== to)) return false;
  return !others.some((o) => {
    if (o.kind !== "move_section" || !o.fromSection) return false;
    const f = normalizeSection(o.fromSection);
    return f === from || from.startsWith(`${f}/`) || f.startsWith(`${from}/`);
  });
}

function applyOperation(
  requirements: Map<string, Requirement>, criteria: Map<string, AcceptanceCriterion>,
  op: Operation, sp: Spec, who: Actor, at: string, witnesses: BugWitness[],
  /** The other operations this same ratification carries — see `targetOperationId` below. */
  siblings: Set<string>,
  /**
   * True when the operation applied; FALSE when it could not and was skipped.
   *
   * It used to return `void`, and a skip inside the caller's loop is a PARTIAL
   * ratification: the spec lands `ratified` and NOT `conflicted` with one of its
   * operations silently absent, on a surface whose whole promise is that adoption is
   * all-or-nothing. The caller now dry-runs this over throwaway maps first — with this
   * function, so the check cannot drift from the thing it checks.
   */
): boolean {
  if (op.kind === "add_criterion") {
    // The rule it attaches to: named outright, or derived from the `add_requirement` in
    // this same spec — which is only possible because the id is a function of the
    // operation. `witnesses` here are of `assertedBy`, not of the rule's `cites`.
    //
    // A `targetOperationId` naming an operation this spec does not carry would derive an id
    // for a requirement nobody creates, leaving a criterion attached to a phantom rule —
    // so the caller resolves it and passes `undefined` when it cannot.
    // And it must be an `add_requirement` IN THIS SPEC. `requirementIdFor` is a pure
    // function of an operation id, so a `targetOperationId` naming something the spec does
    // not carry derives a perfectly well-formed id for a rule nobody ever creates — a
    // criterion attached to a phantom, which no surface can show and nothing can retire.
    if (op.targetOperationId && !siblings.has(op.targetOperationId)) return false;
    const rid = op.targetOperationId ? requirementIdFor(op.targetOperationId) : op.requirementId;
    if (!rid || !op.criterion?.trim() || !op.falsifier?.trim() || !op.evidenceKind) return false;
    // The closed list, and the falsifier that restates its criterion — both refused by
    // `addOperation` and neither by this end, which binds every clone. A criterion whose
    // "falsifier" repeats it asserts nothing about what failure looks like, and an
    // evidence kind this build does not model is a vocabulary nobody can read.
    if (!EVIDENCE_KINDS.includes(op.evidenceKind)) return false;
    const flat = (x: string) => x.replace(/\W+/g, "").toLowerCase();
    if (flat(op.falsifier) === flat(op.criterion)) return false;
    const id = criterionIdFor(op.id);
    criteria.set(id, {
      id, requirementId: rid, criterion: op.criterion, falsifier: op.falsifier,
      evidenceKind: op.evidenceKind,
      author: sp.author, createdAt: at, introducedBy: op.id, specId: sp.id, origin: "sync",
    });
    return true;
  }
  if (op.kind === "add_requirement") {
    // The four fields `addOperation` requires, restated — this arm validated NOTHING and
    // `case "spec.operation"` stores an operation verbatim, so an empty one folded to a
    // ratified requirement with `title`/`section`/`statement`/`provenance` all undefined.
    //
    // That is not merely an ugly row. `shared-projections.ts` binds `r.section` against
    // `section TEXT NOT NULL` and `node:sqlite` throws on an undefined bind, so the merged
    // fold then fails on every subsequent read — permanently, from an append-only log
    // nobody can edit. Refusing here makes the whole ratification `conflicted` instead.
    if (!op.title?.trim() || !op.section?.trim() || !op.statement?.trim() || !op.provenance?.trim()) return false;
    // The operation event was published when the operation was ADDED, before anything
    // bound a requirement to it — so the id is derived here rather than read off a field
    // that is legitimately absent. This is the whole reason it is a function of `op.id`.
    const id = requirementIdFor(op.id);
    requirements.set(id, {
      id, title: op.title!, section: op.section!, statement: op.statement!,
      provenance: op.provenance!, status: "ratified",
      author: sp.author, createdAt: at, introducedBy: sp.id,
      ratifiedBy: who, ratifiedAt: at, origin: "sync",
    });
    return true;
  }
  if (op.kind === "move_section") {
    // Ahead of the `requirementId` lookup below on purpose: a move names no rule, so
    // falling through would take the amend branch and write `statement: undefined` over
    // whatever rule the operation happened not to name.
    const from = normalizeSection(op.fromSection ?? "");
    const to = normalizeSection(op.toSection ?? "");
    if (!from || !to || from === to) return false;
    // One pass over a snapshot of the entries: rewriting in place while iterating could
    // re-enter a row whose new path is still under `from` (`A` → `A/B`) and move it twice.
    for (const [id, r] of [...requirements]) {
      const next = movedSection(r.section, from, to);
      if (next !== r.section) requirements.set(id, { ...r, section: next });
    }
    return true;
  }
  const r = op.requirementId ? requirements.get(op.requirementId) : undefined;
  if (!r) return false;
  if (op.kind === "retire_requirement") {
    requirements.set(r.id, { ...r, status: "retired", retiredBy: who, retiredAt: at });
    return true;
  }
  // Same gap on the amend arm, and it BLANKS a standing rule rather than creating a junk
  // one: `statement: ""` on every clone, for a rule that already says something.
  if (!op.statement?.trim()) return false;
  requirements.set(r.id, {
    ...r, statement: op.statement, ratifiedBy: who, ratifiedAt: at,
    amendedBy: [...(r.amendedBy ?? []), sp.id],
  });
  return true;
}
