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
  withdrawSpec as withdrawSpecRec, reviseSpec as reviseSpecRec,
  reviseOperation as reviseOperationRec, removeOperation as removeOperationRec,
  type OperationInput,
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
  provisionalAudits as provisionalRec,
  conformance as conformanceRec, silenced, type ConformanceSubject,
} from "../audits.js";
import {
  raiseProblem as raiseProblemRec, adjudicate as adjudicateRec, listProblems as listProblemsRec,
  awaitingAdjudication as awaitingRec, actionable, settledWithoutAdjudication as settledRec,
} from "../problems.js";
import type { ActorInput } from "../identity.js";
// Dynamic at call time, not a static edge: `ops-shared.ts` sits beside this module in
// the layering and importing it here statically is the shape `import-cycles.test.ts`
// exists to catch.
const sharedNotesRec = async (root: string, targetId: string) =>
  (await import("../ops-shared.js")).sharedNotes(root, targetId);
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
      // What is OVERDUE, not just what is outstanding. A queue that only ever grows reads
      // the same at every length; a deadline that has passed is the thing worth a banner.
      // Izzie, 2026-08-29: the scrub coincides with branch lifecycles and releases anyway,
      // so what it needs is a reminder when it is late rather than a scheduler.
      overdue: {
        scrubs: (await scrubPlanRec(root, {})).due.length,
        acknowledgements: state.due,
      },
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

/**
 * Every queue's ROWS, in one read.
 *
 * `standardStatus` computes exactly these and throws all but the lengths away, so this
 * costs it nothing extra — and without it the hub reports six numbers a reader cannot
 * open. A count nobody can act on is not a queue, it is a scoreboard.
 *
 * One response rather than six routes for the reason `served` exists: the scope check
 * folds the log, and asking it once for a page that shows all six is one fold instead of
 * six, with no window for the six answers to disagree about whether the standard is
 * authoritative.
 */
export async function standardQueues(root: string) {
  return served(root, async () => {
    const [specs, adjudication, fixes, settled, promotable, due] = await Promise.all([
      pendingSpecsRec(root), awaitingRec(root), actionable(root), settledRec(root),
      promotableRec(root), dueRec(root, {}),
    ]);
    return {
      specs, awaitingAdjudication: adjudication, actionable: fixes,
      settledWithoutAdjudication: settled, promotableAudits: promotable, acknowledgementsDue: due,
    };
  });
}

/**
 * What an auditor should look at next, and what is wrong with the apparatus itself.
 *
 * Five reads that were MCP-only, and they are the ones that decide where effort goes:
 * `auditQueue` (a pointer is firing, or a rule has nothing watching it), the scrub's
 * coverage deadlines, the baseline sweep, pins whose lint has been edited, and criteria
 * whose check nobody has shown can fail. A browser that cannot see them leaves the person
 * choosing what to audit with only the conformance distribution, which says what is
 * unknown and never where to start.
 */
export async function standardHealth(root: string) {
  return served(root, async () => {
    const [queue, scrub, baseline, pins, weak] = await Promise.all([
      auditQueueRec(root), scrubPlanRec(root, {}), baselinePlanRec(root),
      brokenPinsRec(root), weakRec(root),
    ]);
    return { auditQueue: queue, scrub, baseline, brokenPins: pins, weakAssertions: weak };
  });
}

export const requirementSections = async (root: string) =>
  served(root, async () => ({ sections: await requirementSectionsRec(root) }));

export const pendingSpecs = async (root: string) => served(root, async () => ({ specs: await pendingSpecsRec(root) }));

export const promotableAudits = async (root: string) => served(root, async () => ({ audits: await promotableRec(root) }));

/**
 * Branch findings — this machine's and the team's — for one commit, or all of them.
 *
 * A separate read from `auditsFor` rather than a flag on it, because these are the
 * observations that must never be mistaken for the state of the codebase. Keeping them in
 * their own answer is the honest shape; nothing depends on it, since a provisional audit
 * is never folded and so has no row to be counted in anywhere.
 */
export const provisionalAudits = async (root: string, input: { commit?: string } = {}) =>
  served(root, async () => ({ audits: await provisionalRec(root, input) }));

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

/**
 * The rule dossier — everything said about one rule, in one read.
 *
 * `audits` is the codebase's record; `provisionalAudits` is the branch work beside it —
 * this machine's and the team's — kept in its own key rather than mixed in, so a reader
 * cannot take a branch observation for the state of the code.
 *
 * Criteria, population and scrubs are folded in here rather than given routes of their own
 * because they are the same question: what discharges this rule, what it ranges over, and
 * when it was last swept. A dossier that sends the reader elsewhere for those is the trade
 * `getSpec`'s own note warns about, one level down.
 */
export const getRequirement = async (root: string, input: { id: string }) =>
  served(root, async () => {
    const d = await getRequirementRec(root, input.id);
    if ("error" in d) return d;
    const [provisionalAudits, criteria, population, scrubs] = await Promise.all([
      provisionalRec(root, { requirementId: input.id }),
      criteriaSummaryRec(root, input.id),
      populationForRec(root, input.id),
      scrubsForRec(root, input.id),
    ]);
    return {
      ...d, provisionalAudits, scrubs,
      // Both can only fail by naming a rule that does not exist, which `getRequirementRec`
      // has already ruled out — so an error here would be a bug, not a state to render.
      criteria: "error" in criteria ? { criteria: [], asserted: 0, sound: 0 } : criteria,
      population: "error" in population ? { state: "absent" as const, history: [] } : population,
    };
  });

/**
 * `about: "branch"` is the reviewer's question — does the code in front of me conform —
 * and the only read where provisional evidence counts. The default is the team's standard.
 */
export const conformance = async (
  root: string, input: { asOf?: string; about?: ConformanceSubject } = {},
) => served(root, async () => ({ conformance: await conformanceRec(root, input) }));

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

/**
 * The three correction verbs on a DRAFT. Open to any actor, exactly as `draft_spec` and
 * `add_operation` are — correcting a proposal is authoring it, and the asymmetry is in
 * adoption. Every refusal lives in `requirements.ts` and in `foldStandard`; nothing is
 * gated here (see the module header).
 */
export const reviseSpec = (
  root: string, input: { specId: string; title?: string; narrative?: string } & ActorInput,
) => reviseSpecRec(root, input);

export const reviseOperation = (
  root: string, input: { operationId: string } & Partial<OperationInput> & ActorInput,
) => reviseOperationRec(root, input);

export const removeOperation = (
  root: string, input: { operationId: string; reason: string } & ActorInput,
) => removeOperationRec(root, input);

export const withdrawSpec = (root: string, input: { specId: string; reason: string } & ActorInput) =>
  withdrawSpecRec(root, input.specId, input);

/**
 * A spec rendered for disposal, with the team's comments on it.
 *
 * The comments belong HERE and not one navigation away, for the reason every other
 * panel on this surface does: the trade is that a principal reads N operations instead
 * of 5,000 lines, and it fails at its last step if deciding means leaving to find what
 * a teammate already said about the thing being decided.
 *
 * Threads are per TARGET — the spec, and each operation — so an objection to one
 * amendment renders against that amendment rather than in a single running log.
 */
export const getSpec = async (root: string, input: { specId: string }) => {
  const out = await served(root, () => getSpecRec(root, input.specId));
  if ("error" in out) return out;
  // Why the thread came back empty, when it did. An empty array reads as "nobody said
  // anything", and on a store with no sidecar — or one whose note scope will not read —
  // that is a surface answering a question it never asked, which is the failure
  // `standardScopeWarning` exists for one layer over. The rows still come back; what this
  // forbids is presenting silence as agreement.
  let commentsUnavailable: string | undefined;
  const notesFor = async (id: string) => {
    const r = await sharedNotesRec(root, id);
    if (!("error" in r)) return r.notes;
    commentsUnavailable ??= r.error;
    return [];
  };
  const comments = await notesFor(input.specId);
  const operations = await Promise.all(
    out.operations.map(async (o) => ({ ...o, comments: await notesFor(o.operation.id) })),
  );
  return {
    ...out, comments, operations,
    ...(commentsUnavailable ? { commentsUnavailable } : {}),
  };
};

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
