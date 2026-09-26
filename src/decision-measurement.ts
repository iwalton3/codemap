/** Design-only extraction; observations are independently classified, never inferred from green tests. */
export interface MeasurementCohort {
  id: string;
  repositories: string[];
  start: string;
  end: string;
  followUpEnd: string;
  followUpCoverage: "complete" | "sampled" | "none";
}
export type DecisionMeasurementState = "answered" | "partial" | "unanswered" | "interpretation" | "parked" | "conflict" | "ruled-unexecuted";
export interface MeasurementAttempt {
  id: string;
  repository: string;
  findingId: string;
  claimId: string;
  at: string;
  act: "fix" | "close";
  requirementAuthority: "required" | "not-required" | "unknown";
  authorityBeforeAct: "valid" | "absent" | "invalid" | "unknown";
  classificationSource: string;
  eligible: boolean;
  evidenceGrade: "executable" | "inspection" | "none";
  reproducerSupplied: boolean;
  rerun: "passed" | "failed" | "unknown" | "not-run";
  commandIds: string[];
  outcome: "fixed" | "factually-refuted" | "decision-needed" | "unknown";
  errorsDiscovered: number;
  independence: "verified" | "unverified" | "unknown";
  modelIds: string[];
  runIds: string[];
  secondPass?: { at: string; result: "sound" | "false-close" | "unknown"; source: string };
}
export interface MeasurementQuestion {
  id: string;
  batchId: string;
  repository: string;
  postedAt: string;
  exit: DecisionMeasurementState;
  followUp: DecisionMeasurementState | "unobserved";
  deadline?: string;
}
export interface DecisionMeasurementInput {
  version: 1;
  cohort: MeasurementCohort;
  attempts: MeasurementAttempt[];
  questions: MeasurementQuestion[];
}

const states: DecisionMeasurementState[] = ["answered", "partial", "unanswered", "interpretation", "parked", "conflict", "ruled-unexecuted"];
const count = <T>(rows: T[], predicate: (row: T) => boolean) => rows.filter(predicate).length;
const unique = (values: string[]) => [...new Set(values)];
const stamp = (value: string) => { const n = Date.parse(value); if (!Number.isFinite(n)) throw new Error(`invalid timestamp: ${value}`); return n; };

export function extractDecisionMeasurement(input: DecisionMeasurementInput) {
  if (input.version !== 1) throw new Error("unsupported measurement version");
  const { cohort } = input;
  const start = stamp(cohort.start), end = stamp(cohort.end), followUpEnd = stamp(cohort.followUpEnd);
  if (start >= end || followUpEnd < end || !cohort.repositories.length || unique(cohort.repositories).length !== cohort.repositories.length)
    throw new Error("invalid cohort window or repositories");
  const repositories = new Set(cohort.repositories);
  const checkRows = (rows: { id: string; repository: string }[]) => {
    if (rows.some(r => !r.id.trim() || !repositories.has(r.repository)) || unique(rows.map(r => r.id)).length !== rows.length)
      throw new Error("duplicate/missing raw ID or repository outside declared cohort");
  };
  checkRows(input.attempts); checkRows(input.questions);
  for (const a of input.attempts) {
    if (!a.findingId.trim() || !a.claimId.trim() || !a.classificationSource.trim() || !Number.isInteger(a.errorsDiscovered) || a.errorsDiscovered < 0)
      throw new Error("attempt requires canonical IDs and independent classification source");
    if (a.rerun !== "not-run" && (!a.reproducerSupplied || a.evidenceGrade !== "executable"))
      throw new Error("rerun requires supplied executable reproducer");
    if (a.reproducerSupplied && a.evidenceGrade !== "executable") throw new Error("supplied executable reproducer requires executable evidence grade");
    if (a.secondPass && (stamp(a.secondPass.at) < stamp(a.at) || !a.secondPass.source.trim())) throw new Error("invalid second-pass observation");
    if (a.secondPass && a.act !== "close") throw new Error("closure audit requires close attempt");
  }
  for (const q of input.questions) {
    if (!q.batchId.trim() || !states.includes(q.exit) || (q.followUp !== "unobserved" && !states.includes(q.followUp))) throw new Error("invalid question observation");
    if ((q.exit === "parked" || q.followUp === "parked") && (!q.deadline || !Number.isFinite(Date.parse(q.deadline)))) throw new Error("parked question requires deadline");
  }
  const inWindow = (at: string) => stamp(at) >= start && stamp(at) < end;
  const attempts = input.attempts.filter(a => inWindow(a.at));
  const questions = input.questions.filter(q => inWindow(q.postedAt));
  const required = attempts.filter(a => a.requirementAuthority === "required");
  const eligible = attempts.filter(a => a.eligible);
  const closes = attempts.filter(a => a.act === "close");
  const audited = closes.filter(a => a.secondPass && stamp(a.secondPass.at) <= followUpEnd);
  const decisionCounts = (key: "exit" | "followUp") => {
    const byState = Object.fromEntries([...states, "unobserved"].map(s => [s, count(questions, q => q[key] === s)]));
    const batches = unique(questions.map(q => `${q.repository}\0${q.batchId}`));
    const answeredBatches = count(batches, b => questions.filter(q => `${q.repository}\0${q.batchId}` === b).every(q => q[key] === "answered"));
    return { questions: questions.length, answeredQuestions: byState.answered!, byState, batches: batches.length, answeredBatches };
  };
  return {
    version: 1 as const, cohort,
    raw: { attemptIds: attempts.map(a => a.id), findingIds: unique(attempts.map(a => `${a.repository}\0${a.findingId}`)),
      claimIds: unique(attempts.map(a => `${a.repository}\0${a.findingId}\0${a.claimId}`)), questionIds: questions.map(q => q.id),
      excludedAttemptIds: input.attempts.filter(a => !inWindow(a.at)).map(a => a.id), excludedQuestionIds: input.questions.filter(q => !inWindow(q.postedAt)).map(q => q.id) },
    authority: { observedActs: attempts.length, required: required.length,
      unauthorized: count(required, a => a.authorityBeforeAct === "absent" || a.authorityBeforeAct === "invalid"),
      valid: count(required, a => a.authorityBeforeAct === "valid"), unknownAuthority: count(required, a => a.authorityBeforeAct === "unknown"),
      unknownRequirement: count(attempts, a => a.requirementAuthority === "unknown"), historicalSample: { numerator: 13, denominator: 183 } },
    decisions: { exit: decisionCounts("exit"), followUp: decisionCounts("followUp") },
    verifier: { eligibleAttempts: eligible.length, suppliedReproducers: count(eligible, a => a.reproducerSupplied),
      actuallyRerun: count(eligible, a => a.rerun !== "not-run"),
      rerun: Object.fromEntries(["passed", "failed", "unknown", "not-run"].map(s => [s, count(eligible, a => a.rerun === s)])),
      grades: Object.fromEntries(["executable", "inspection", "none"].map(s => [s, count(eligible, a => a.evidenceGrade === s)])),
      outcomes: Object.fromEntries(["fixed", "factually-refuted", "decision-needed", "unknown"].map(s => [s, count(eligible, a => a.outcome === s)])),
      independence: Object.fromEntries(["verified", "unverified", "unknown"].map(s => [s, count(eligible, a => a.independence === s)])),
      errorsDiscovered: eligible.reduce((n, a) => n + a.errorsDiscovered, 0), modelIds: unique(eligible.flatMap(a => a.modelIds)), runIds: unique(eligible.flatMap(a => a.runIds)),
      closeAttempts: closes.length, auditedCloseAttempts: audited.length, falseClosures: count(audited, a => a.secondPass!.result === "false-close"),
      unknownSecondPass: count(audited, a => a.secondPass!.result === "unknown"), unauditedCloseAttempts: closes.length - audited.length },
  };
}
