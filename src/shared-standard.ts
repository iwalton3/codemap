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
  PopulationPredicate, Problem, Requirement, ScrubPolicy, Spec, VacuityCheck,
} from "./schema.js";
import { criterionIdFor, requirementIdFor, EVIDENCE_KINDS, AUDIT_TRIGGERS, COVERING_TRIGGERS } from "./schema.js";
import type { LogEvent } from "./eventlog.js";
import { emitEvent } from "./eventlog.js";

export const standardScope = (universe: string): string => `standard/${universe}`;

/** Everything one universe's standard scope folds to. */
export interface SharedStandard {
  specs: Spec[];
  operations: Operation[];
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
  specs: [], operations: [], requirements: [], criteria: [], vacuityChecks: [], pointers: [],
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
 * The ratification, carrying the witnesses the ratifier observed.
 *
 * The event is subject-keyed on the SPEC, not on any requirement: adopting a spec is one
 * act, and splitting it per operation would let a clone fold half an argument.
 */
export const publishSpecRatified = (
  logRoot: string, scope: string, actor: Actor, specId: string, at: string,
  witnesses: Record<string, BugWitness[]>, operations: string[],
) => put(logRoot, scope, actor, "spec.ratified", specId, { at, witnesses, operations });

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
export function foldStandard(events: LogEvent[]): SharedStandard {
  const specs = new Map<string, Spec>();
  const operations = new Map<string, Operation>();
  const requirements = new Map<string, Requirement>();
  const criteria = new Map<string, AcceptanceCriterion>();
  const vacuityChecks = new Map<string, VacuityCheck>();
  const pointers = new Map<string, Pointer>();
  const populations = new Map<string, PopulationPredicate>();
  let scrubPolicy: ScrubPolicy | null = null;
  const acknowledgements = new Map<string, Acknowledgement>();
  const audits = new Map<string, Audit>();
  const problems = new Map<string, Problem>();

  for (const e of events) {
    switch (e.kind) {
      case "spec.drafted": {
        const spec = obj(e.data, "spec") as Spec | undefined;
        if (spec?.id) specs.set(spec.id, { ...spec, status: "draft", origin: "sync" });
        break;
      }
      case "spec.operation": {
        const op = obj(e.data, "operation") as Operation | undefined;
        if (op?.id) operations.set(op.id, { ...op, origin: "sync" });
        break;
      }
      case "spec.ratified": {
        const sp = specs.get(e.subject);
        // A ratification for a spec this fold never saw drafted is not fatal: the drafting
        // shard may simply not have arrived yet, and the next sync completes it.
        if (!sp || sp.status === "ratified") break;
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
        const mine = (pinned
          ? pinned.map((id) => operations.get(id)).filter(Boolean) as Operation[]
          : [...operations.values()].filter((o) => o.specId === sp.id))
          .sort((a, b) => a.ord - b.ord);

        // Context, verified here and not only in the tool. The local check is TOCTOU
        // across clones — the log is pull/push and never read on an ordinary read — so two
        // principals can each validate against the same statement and both append. Without
        // this the second silently overwrites an amendment the first ratified.
        //
        // ALL OR NOTHING, exactly as `ratifySpec` refuses: applying the half that still
        // fits yields a standard nobody approved.
        const stale = mine.some((op) => {
          if (!op.context) return false;
          const cur = requirements.get(op.context.requirementId);
          return !cur || cur.status === "retired" || cur.statement !== op.context.statement;
        });
        if (stale || (pinned && mine.length !== pinned.length)) {
          specs.set(sp.id, { ...sp, status: "ratified", ratifiedBy: e.actor, ratifiedAt: at, conflicted: true });
          break;
        }
        specs.set(sp.id, { ...sp, status: "ratified", ratifiedBy: e.actor, ratifiedAt: at });
        // The `add_requirement` operations this ratification carries, so a criterion naming
        // one can be checked against what actually landed rather than against a derived id.
        const creating = new Set(mine.filter((o) => o.kind === "add_requirement").map((o) => o.id));
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
        // Non-vacuity, restated at the fold. A `conformant` audit that touched no code
        // certifies nothing, and this is the only place that binds a writer whose tool
        // did not check — which is the one path by which `conformant` could be reached
        // without a code-backed audit.
        //
        // `some(passed)`, NOT `ran.length`: a command that FAILED is evidence of
        // non-conformance, never of conformance. `touchedCode` in `audits.ts` was tightened
        // for exactly that reason and this end was left counting any nonempty `ran`, so
        // `{command: "false", passed: false}` still certified a rule for every clone —
        // the one-end fix, on the guard whose whole job is to bind the other end.
        const ev = audit.evidence ?? {};
        const touched = !!(ev.read?.length || ev.ran?.some((r) => r.passed && !!r.command?.trim()));
        if (audit.outcome === "conformant" && !touched) break;
        if (audit.trigger && !AUDIT_TRIGGERS.includes(audit.trigger)) break;
        // An audit that concluded nothing. `recordAudit` has always refused this and the
        // fold never has — a pre-existing one-end gap, found because folding the scrub in
        // brought a test that exercises it. What an auditor concluded IS the record; a row
        // without it is a timestamp claiming somebody looked.
        if (!audit.finding?.trim()) break;
        // A COVERING audit resets this rule's coverage deadline, which is the quieting
        // direction — so it must say what every ACTIVE pointer was doing. `recordAudit`
        // refuses an omission, a phantom and a repeat; this end binds a clone whose tool
        // did not. The pointer state is read from the fold's OWN map, so it is the team's
        // view of what was active rather than the writer's account of it.
        if (COVERING_TRIGGERS.includes(audit.trigger ?? "ad-hoc")) {
          const obs = audit.observations ?? [];
          if (obs.some((o) => !o?.pointerId || typeof o.firing !== "boolean")) break;
          const watching = [...pointers.values()]
            .filter((p) => p.requirementId === audit.requirementId && p.state === "active");
          const seen = new Set(obs.map((o) => o.pointerId));
          if (watching.some((p) => !seen.has(p.id))) break;
          if (obs.some((o) => !watching.some((p) => p.id === o.pointerId))) break;
          if (seen.size !== obs.length) break;
        } else if (audit.observations?.length) {
          // Observations from a pass that never covered anything would feed the rate while
          // resetting no deadline — the rate detached from the coverage it describes.
          break;
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
        // ACTIVE, whatever the payload said. A `declared` event carrying `state:
        // "retired"` would fold to a pointer that was never watching anything and cannot
        // be retired again — the same partial-strip shape that let `problem.raised` name a
        // decider who never decided.
        const { retiredBy, retiredAt, retiredReason, restatedBy, restatedAt, ...declared } = p;
        pointers.set(p.id, { ...declared, state: "active", origin: "sync" });
        break;
      }
      case "pointer.restated": {
        const p = pointers.get(e.subject);
        if (!p || p.state !== "active") break;
        const witnesses = obj(e.data, "witnesses") as BugWitness[] | undefined;
        if (!Array.isArray(witnesses)) break;
        pointers.set(p.id, { ...p, witnesses, restatedBy: e.actor, restatedAt: str(e.data, "at") ?? e.at });
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
        if (!p?.id) break;
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
        if (!disposition) break;
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
function applyOperation(
  requirements: Map<string, Requirement>, criteria: Map<string, AcceptanceCriterion>,
  op: Operation, sp: Spec, who: Actor, at: string, witnesses: BugWitness[],
  /** The other operations this same ratification carries — see `targetOperationId` below. */
  siblings: Set<string>,
): void {
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
    if (op.targetOperationId && !siblings.has(op.targetOperationId)) return;
    const rid = op.targetOperationId ? requirementIdFor(op.targetOperationId) : op.requirementId;
    if (!rid || !op.criterion?.trim() || !op.falsifier?.trim() || !op.evidenceKind) return;
    // The closed list, and the falsifier that restates its criterion — both refused by
    // `addOperation` and neither by this end, which binds every clone. A criterion whose
    // "falsifier" repeats it asserts nothing about what failure looks like, and an
    // evidence kind this build does not model is a vocabulary nobody can read.
    if (!EVIDENCE_KINDS.includes(op.evidenceKind)) return;
    const flat = (x: string) => x.replace(/\W+/g, "").toLowerCase();
    if (flat(op.falsifier) === flat(op.criterion)) return;
    const id = criterionIdFor(op.id);
    criteria.set(id, {
      id, requirementId: rid, criterion: op.criterion, falsifier: op.falsifier,
      evidenceKind: op.evidenceKind, assertedBy: op.assertedBy ?? [], witnesses,
      author: sp.author, createdAt: at, introducedBy: op.id, specId: sp.id, origin: "sync",
    });
    return;
  }
  if (op.kind === "add_requirement") {
    // The operation event was published when the operation was ADDED, before anything
    // bound a requirement to it — so the id is derived here rather than read off a field
    // that is legitimately absent. This is the whole reason it is a function of `op.id`.
    const id = requirementIdFor(op.id);
    requirements.set(id, {
      id, title: op.title!, section: op.section!, statement: op.statement!,
      provenance: op.provenance!, status: "ratified", cites: op.cites ?? [], witnesses,
      author: sp.author, createdAt: at, introducedBy: sp.id,
      ratifiedBy: who, ratifiedAt: at, origin: "sync",
    });
    return;
  }
  const r = op.requirementId ? requirements.get(op.requirementId) : undefined;
  if (!r) return;
  if (op.kind === "retire_requirement") {
    requirements.set(r.id, { ...r, status: "retired", retiredBy: who, retiredAt: at });
    return;
  }
  requirements.set(r.id, {
    ...r, statement: op.statement!, ratifiedBy: who, ratifiedAt: at,
    amendedBy: [...(r.amendedBy ?? []), sp.id], witnesses,
  });
}
