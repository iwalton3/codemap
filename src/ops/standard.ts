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
 * **Do not add a guard here.** Every gate in this subsystem is duplicated between the
 * write path and the FOLD, because a teammate's clone applies the log without ever seeing
 * this call — a guard in one front end binds only this machine. That mistake has been made
 * four times in this subsystem alone (see `sharing-boundary.test.ts` §BOTH_ENDS). If a new
 * refusal is needed it goes in the record module and in the fold, and arrives here for
 * free.
 */

import {
  draftSpec as draftSpecRec, addOperation as addOperationRec, ratifySpec as ratifySpecRec,
  reorganizeRequirement as reorganizeRec, requirementSections, listRequirements as listRequirementsRec,
  getRequirement as getRequirementRec, getSpec as getSpecRec, pendingSpecs,
} from "../requirements.js";
import {
  acknowledgeGap as ackGapRec, acknowledgeDebt as ackDebtRec,
  releaseAcknowledgement as releaseAckRec, listAcknowledgements as listAcksRec, dueForRevalidation,
} from "../acknowledgements.js";
import {
  recordAudit as recordAuditRec, promotableAudits, promoteProvisionalAudit as promoteAuditRec,
  auditsFor as auditsForRec, conformance as conformanceRec, silenced,
} from "../audits.js";
import {
  raiseProblem as raiseProblemRec, adjudicate as adjudicateRec, listProblems as listProblemsRec,
  awaitingAdjudication, actionable, settledWithoutAdjudication,
} from "../problems.js";
import type { ActorInput } from "../identity.js";
import type {
  AcknowledgementPriority, AuditEvidence, AuditOutcome, OperationKind, ProblemDisposition,
  Requirement, Reversibility,
} from "../schema.js";

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
  const [state, specs, adjudication, fixes, settled, promotable] = await Promise.all([
    silenced(root), pendingSpecs(root), awaitingAdjudication(root), actionable(root),
    settledWithoutAdjudication(root), promotableAudits(root),
  ]);
  return {
    conformance: state,
    queues: {
      pendingSpecs: specs.length,
      awaitingAdjudication: adjudication.length,
      actionableProblems: fixes.length,
      promotableAudits: promotable.length,
      // `state.due`, not a second `dueForRevalidation` call. Both default `asOf` to their
      // own `now()`, so an acknowledgement falling due between the two would be counted
      // once in the distribution and not in the queue, in one response.
      acknowledgementsDue: state.due,
      settledWithoutAdjudication: settled.length,
    },
  };
}

export { requirementSections, pendingSpecs, promotableAudits, dueForRevalidation };
export { awaitingAdjudication, settledWithoutAdjudication };

/** The fix queue — problems that have been DECIDED. An un-adjudicated one is never here. */
export const actionableProblems = actionable;

export const listRequirements = (
  root: string, input: { status?: Requirement["status"]; section?: string } = {},
) => listRequirementsRec(root, input);

export const getRequirement = (root: string, input: { id: string }) =>
  getRequirementRec(root, input.id);

export const conformance = (root: string, input: { asOf?: string } = {}) =>
  conformanceRec(root, input);

// --- specs and their operations ----------------------------------------------

export const draftSpec = (root: string, input: { title: string; narrative?: string } & ActorInput) =>
  draftSpecRec(root, input);

export const addOperation = (
  root: string,
  input: {
    specId: string; kind: OperationKind; rationale: string; reversibility: Reversibility;
    requirementId?: string; title?: string; section?: string; statement?: string;
    provenance?: string; cites?: string[]; evidence?: string;
  } & ActorInput,
) => addOperationRec(root, input);

export const ratifySpec = (root: string, input: { specId: string } & ActorInput) =>
  ratifySpecRec(root, input.specId, input);

export const getSpec = (root: string, input: { specId: string }) => getSpecRec(root, input.specId);

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

export const listAcknowledgements = (
  root: string,
  input: { requirementId?: string; state?: "active" | "released"; asOf?: string } = {},
) => listAcksRec(root, input);

// --- audits -------------------------------------------------------------------

export const recordAudit = (
  root: string,
  input: {
    requirementId: string; outcome: AuditOutcome; finding: string; evidence?: AuditEvidence;
    promotedFrom?: string;
  } & ActorInput,
) => recordAuditRec(root, input);

export const auditsFor = (root: string, input: { requirementId: string }) =>
  auditsForRec(root, input.requirementId);

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

export const listProblems = (root: string, input: { requirementId?: string } = {}) =>
  listProblemsRec(root, input);
