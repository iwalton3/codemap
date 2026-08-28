/**
 * The requirements/standard surface, as ops.
 *
 * The six record modules (`requirements`, `acknowledgements`, `audits`, `problems`, and
 * the two sharing layers) already hold all the logic and every refusal. This layer exists
 * for one reason: **shape**. A front end hands its handler a single arguments object, and
 * several of the record functions take their subject positionally
 * (`ratifySpec(root, specId, input)`), so without a normalizing layer every tool would
 * destructure differently and the ApiMap would have no single shape to derive from.
 *
 * The one thing that DOES belong here is the scope warning. `served()` below attaches it
 * to every read, and it is not a guard in the sense the paragraph after this forbids: a
 * guard is a rule about what a WRITER may do, so it has to bind the fold as well, whereas
 * a scope status is this machine's verdict on its own log shards. There is no other end
 * for it to bind — which is exactly why the read path was the surface that never looked.
 *
 * **Do not add a guard here.** Every gate in this subsystem is duplicated between the
 * write path and the FOLD, because a teammate's clone applies the log without ever seeing
 * this call — a guard in one front end binds only this machine. That mistake has been made
 * four times in this subsystem alone (see `sharing-boundary.test.ts` §BOTH_ENDS). If a new
 * refusal is needed it goes in the record module and in the fold, and arrives here for
 * free.
 */

import {
  draftSpec as draftSpecRec, addOperation as addOperationRec, ratifySpec as ratifySpecRec,
  withdrawSpec as withdrawSpecRec,
  reorganizeRequirement as reorganizeRec, requirementSections as requirementSectionsRec,
  listRequirements as listRequirementsRec, getRequirement as getRequirementRec,
  getSpec as getSpecRec, pendingSpecs as pendingSpecsRec,
} from "../requirements.js";
import {
  acknowledgeGap as ackGapRec, acknowledgeDebt as ackDebtRec,
  releaseAcknowledgement as releaseAckRec, listAcknowledgements as listAcksRec,
  dueForRevalidation as dueRec,
} from "../acknowledgements.js";
import {
  recordAudit as recordAuditRec, promotableAudits as promotableRec,
  promoteProvisionalAudit as promoteAuditRec, auditsFor as auditsForRec,
  conformance as conformanceRec, silenced,
} from "../audits.js";
import {
  raiseProblem as raiseProblemRec, adjudicate as adjudicateRec, listProblems as listProblemsRec,
  awaitingAdjudication as awaitingRec, actionable, settledWithoutAdjudication as settledRec,
} from "../problems.js";
import type { ActorInput } from "../identity.js";
import {
  recordVacuityCheck as recordVacuityCheckRec, weakAssertions as weakRec,
  criteriaSummary as criteriaSummaryRec,
} from "../criteria.js";
import {
  declarePointer as declarePointerRec, restatePointer as restatePointerRec,
  retirePointer as retirePointerRec, pointersFor as pointersForRec, auditQueue as auditQueueRec,
} from "../pointers.js";
import {
  pinPopulation as pinRec, declareNotExpressible as notExpressibleRec,
  populationFor as populationForRec, brokenPins as brokenPinsRec,
} from "../population.js";
import {
  setScrubPolicy as setScrubPolicyRec, scrubPlan as scrubPlanRec,
  scrubsFor as scrubsForRec, baselinePlan as baselinePlanRec,
} from "../scrub.js";
import { standardScopeWarning, type StandardScope } from "../standard-publish.js";
import type {
  AcknowledgementPriority, AuditEvidence, AuditOutcome, AuditTrigger, EvidenceKind, OperationKind,
  PopulationMember, ProblemDisposition, Requirement, Reversibility, VacuityCheck,
} from "../schema.js";

/**
 * Attach the non-authoritative marker, when there is one.
 *
 * The status rides WITH the value rather than beside it, the way `Cached<T>` does one
 * layer down, so a caller cannot take the rows and forget to ask. That is the whole fix:
 * the rows were always served, and nothing on the read path ever consulted the verdict.
 *
 * A blocked scope still ANSWERS — see `readScopeChecked` and the sidecar architecture's
 * §7. Hiding the rows would leave a reader staring at an empty page with no way to repair
 * what they cannot see; what `blocked` forbids is presenting it as settled.
 *
 * Array results are wrapped in a named object rather than returned bare, because a
 * property set on an array does not survive `JSON.stringify` — the marker would vanish
 * on exactly the surfaces that carry it to a reader.
 *
 * It takes a THUNK, and that is load-bearing rather than style. The scope check folds the
 * log when the shards have moved, so it has to finish BEFORE the rows are read — running
 * them together (or taking an already-evaluated promise) reads rows from before the fold
 * and reports a verdict from after it, which is a stale answer wearing an authoritative
 * marker. That is the bug this whole mechanism exists to prevent, one layer up.
 */
async function served<T extends object>(root: string, produce: () => T | Promise<T>): Promise<T & { scope?: StandardScope }> {
  const scope = await standardScopeWarning(root);
  const v = await produce();
  return scope ? { ...v, scope } : v;
}

// --- the standard ------------------------------------------------------------

/**
 * The one read that says whether the standard is in trouble, and where.
 *
 * `silenced` is the conformance distribution; the rest are the queues, and they are here
 * because a distribution alone cannot distinguish a healthy standard from one whose
 * findings nobody is disposing of. `settledWithoutAdjudication` is the andon signal —
 * business questions that were answered by changing code — so it is reported even when it
 * is the only nonzero row.
 */
export async function standardStatus(root: string) {
  return served(root, async () => {
    // The RECORD functions, not the wrapped ops above them: the wrappers each ask whether
    // the scope is authoritative, and asking six times for one response would stat the
    // shards six times to reach the same verdict. `served` asks once, before any of them.
    const [state, specs, adjudication, fixes, settled, promotable] = await Promise.all([
      silenced(root), pendingSpecsRec(root), awaitingRec(root), actionable(root),
      settledRec(root), promotableRec(root),
    ]);
    return {
      conformance: state,
      queues: {
        pendingSpecs: specs.length,
        awaitingAdjudication: adjudication.length,
        actionableProblems: fixes.length,
        promotableAudits: promotable.length,
        // `state.due`, not a second `dueForRevalidation` call. Both default `asOf` to
        // their own `now()`, so an acknowledgement falling due between the two would be
        // counted once in the distribution and not in the queue, in one response.
        acknowledgementsDue: state.due,
        settledWithoutAdjudication: settled.length,
      },
    };
  });
}

export const requirementSections = async (root: string) =>
  served(root, async () => ({ sections: await requirementSectionsRec(root) }));

export const pendingSpecs = async (root: string) => served(root, async () => ({ specs: await pendingSpecsRec(root) }));

export const promotableAudits = async (root: string) => served(root, async () => ({ audits: await promotableRec(root) }));

export const dueForRevalidation = async (root: string, input: { asOf?: string } = {}) =>
  served(root, async () => ({ acknowledgements: await dueRec(root, input) }));

export const awaitingAdjudication = async (root: string) =>
  served(root, async () => ({ problems: await awaitingRec(root) }));

export const settledWithoutAdjudication = async (root: string) =>
  served(root, async () => ({ problems: await settledRec(root) }));

/** The fix queue — problems that have been DECIDED. An un-adjudicated one is never here. */
export const actionableProblems = async (root: string) => served(root, async () => ({ problems: await actionable(root) }));

export const listRequirements = async (
  root: string, input: { status?: Requirement["status"]; section?: string } = {},
) => served(root, async () => ({ requirements: await listRequirementsRec(root, input) }));

export const getRequirement = async (root: string, input: { id: string }) =>
  served(root, () => getRequirementRec(root, input.id));

export const conformance = async (root: string, input: { asOf?: string } = {}) =>
  served(root, async () => ({ conformance: await conformanceRec(root, input) }));

// --- specs and their operations ----------------------------------------------

export const draftSpec = (root: string, input: { title: string; narrative?: string } & ActorInput) =>
  draftSpecRec(root, input);

export const addOperation = (
  root: string,
  input: {
    specId: string; kind: OperationKind; rationale: string; reversibility: Reversibility;
    requirementId?: string; title?: string; section?: string; statement?: string;
    provenance?: string; cites?: string[]; evidence?: string;
    criterion?: string; falsifier?: string; evidenceKind?: EvidenceKind;
    assertedBy?: string[]; targetOperationId?: string;
    fromSection?: string; toSection?: string;
  } & ActorInput,
) => addOperationRec(root, input);

export const ratifySpec = (root: string, input: { specId: string } & ActorInput) =>
  ratifySpecRec(root, input.specId, input);

export const withdrawSpec = (root: string, input: { specId: string; reason: string } & ActorInput) =>
  withdrawSpecRec(root, input.specId, input);

export const getSpec = async (root: string, input: { specId: string }) =>
  served(root, () => getSpecRec(root, input.specId));

export const reorganizeRequirement = (
  root: string, input: { id: string; title?: string; section?: string } & ActorInput,
) => reorganizeRec(root, input.id, { title: input.title, section: input.section }, input);

// --- acknowledgements ---------------------------------------------------------

export const acknowledgeGap = (
  root: string,
  input: {
    operationId: string; rationale: string; priority: AcknowledgementPriority;
    revalidateBy: string; workItem?: string;
  } & ActorInput,
) => ackGapRec(root, input);

export const acknowledgeDebt = (
  root: string,
  input: {
    requirementId: string; rationale: string; priority: AcknowledgementPriority;
    revalidateBy: string; workItem?: string;
  } & ActorInput,
) => ackDebtRec(root, input);

export const releaseAcknowledgement = (
  root: string, input: { id: string; reason: string } & ActorInput,
) => releaseAckRec(root, input.id, input.reason, input);

export const listAcknowledgements = async (
  root: string,
  input: { requirementId?: string; state?: "active" | "released"; asOf?: string } = {},
) => served(root, async () => ({ acknowledgements: await listAcksRec(root, input) }));

// --- audits -------------------------------------------------------------------

export const recordAudit = (
  root: string,
  input: {
    requirementId: string; outcome: AuditOutcome; finding: string; evidence?: AuditEvidence;
    promotedFrom?: string; trigger?: AuditTrigger;
    observations?: { pointerId: string; firing: boolean }[];
  } & ActorInput,
) => recordAuditRec(root, input);

// --- acceptance criteria -----------------------------------------------------

export const weakAssertions = async (root: string) => served(root, () => weakRec(root));

export const criteriaSummary = async (root: string, input: { requirementId: string }) =>
  served(root, () => criteriaSummaryRec(root, input.requirementId));

export const recordVacuityCheck = (
  root: string,
  input: { criterionId: string; verdict: VacuityCheck["verdict"]; method?: string } & ActorInput,
) => recordVacuityCheckRec(root, input);

// --- the scrub ------------------------------------------------------------------

export const setScrubPolicy = (
  root: string, input: { coverageDays: number; minObservations?: number } & ActorInput,
) => setScrubPolicyRec(root, input);

export const scrubPlan = async (root: string, input: { asOf?: string } = {}) =>
  served(root, () => scrubPlanRec(root, input));

export const scrubsFor = async (root: string, input: { requirementId: string }) =>
  served(root, async () => ({ scrubs: await scrubsForRec(root, input.requirementId) }));

export const baselinePlan = async (root: string) => served(root, () => baselinePlanRec(root));

// --- population predicates ----------------------------------------------------

export const pinPopulation = (
  root: string,
  input: { requirementId: string; lint: string[]; members: PopulationMember[] } & ActorInput,
) => pinRec(root, input);

export const declareNotExpressible = (
  root: string, input: { requirementId: string; reason: string } & ActorInput,
) => notExpressibleRec(root, input);

export const populationFor = async (root: string, input: { requirementId: string }) =>
  served(root, () => populationForRec(root, input.requirementId));

export const brokenPins = async (root: string) =>
  served(root, async () => ({ pins: await brokenPinsRec(root) }));

// --- pointers -----------------------------------------------------------------

export const declarePointer = (
  root: string,
  input: { requirementId: string; targetKind: "node" | "anchor"; targetId: string; rationale: string } & ActorInput,
) => declarePointerRec(root, input);

export const restatePointer = (root: string, input: { id: string } & ActorInput) =>
  restatePointerRec(root, input);

export const retirePointer = (root: string, input: { id: string; reason: string } & ActorInput) =>
  retirePointerRec(root, input);

export const pointersFor = async (root: string, input: { requirementId: string }) =>
  served(root, async () => ({ pointers: await pointersForRec(root, input.requirementId) }));

export const auditQueue = async (root: string) => served(root, () => auditQueueRec(root));

export const auditsFor = async (root: string, input: { requirementId: string }) =>
  served(root, async () => ({ audits: await auditsForRec(root, input.requirementId) }));

export const promoteProvisionalAudit = (root: string, input: { auditId: string } & ActorInput) =>
  promoteAuditRec(root, input.auditId, input);

// --- problems -----------------------------------------------------------------

export const raiseProblem = (
  root: string, input: { auditId: string; summary: string; prior?: string } & ActorInput,
) => raiseProblemRec(root, input);

export const adjudicate = (
  root: string,
  input: { problemId: string; disposition: ProblemDisposition; reason: string } & ActorInput,
) => adjudicateRec(root, input.problemId, input.disposition, input.reason, input);

export const listProblems = async (root: string, input: { requirementId?: string } = {}) =>
  served(root, async () => ({ problems: await listProblemsRec(root, input) }));
