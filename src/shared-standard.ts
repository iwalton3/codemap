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
import { criterionIdFor, movedSection, normalizeSection, requirementIdFor, EVIDENCE_KINDS, AUDIT_TRIGGERS, COVERING_TRIGGERS, auditClaimStands } from "./schema.js";
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
export function foldStandard(events: LogEvent[], opts: { evidence?: boolean } = {}): SharedStandard {
  const evidenceReadable = opts.evidence !== false;
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
  const contest = newContestState();
  const causal = causality(events);

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
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
          // A section move carries no `context` — its subject is a path, not a statement —
          // so it needs its own applicability test or it is the ONE operation kind that
          // slips through this check on every clone. A move whose source has since been
          // emptied applies cleanly and does nothing, which is the silent half.
          if (op.kind === "move_section") return !moveApplicable(requirements, op, mine);
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
        if (e.actor.via) break;
        const at = str(e.data, "at") ?? e.at;
        const mine = [...operations.values()].filter((o) => o.specId === sp.id);
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
  for (const o of m.operations.values()) if (!own.has(o.id) && (cites(o.requirementId) || cites(o.context?.requirementId))) hit.push(o.id);
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
      provenance: op.provenance!, status: "ratified",
      author: sp.author, createdAt: at, introducedBy: sp.id,
      ratifiedBy: who, ratifiedAt: at, origin: "sync",
    });
    return;
  }
  if (op.kind === "move_section") {
    // Ahead of the `requirementId` lookup below on purpose: a move names no rule, so
    // falling through would take the amend branch and write `statement: undefined` over
    // whatever rule the operation happened not to name.
    const from = normalizeSection(op.fromSection ?? "");
    const to = normalizeSection(op.toSection ?? "");
    if (!from || !to || from === to) return;
    // One pass over a snapshot of the entries: rewriting in place while iterating could
    // re-enter a row whose new path is still under `from` (`A` → `A/B`) and move it twice.
    for (const [id, r] of [...requirements]) {
      const next = movedSection(r.section, from, to);
      if (next !== r.section) requirements.set(id, { ...r, section: next });
    }
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
    amendedBy: [...(r.amendedBy ?? []), sp.id],
  });
}
