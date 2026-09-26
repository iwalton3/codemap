import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDecisionMeasurement, type DecisionMeasurementInput, type MeasurementAttempt } from "./decision-measurement.js";
const at = "2026-09-01T12:00:00Z";
const attempt = (id: string, changes: Partial<MeasurementAttempt> = {}): MeasurementAttempt => ({ id, repository: "repo", findingId: "f1", claimId: "c1", at,
  act: "close", requirementAuthority: "required", authorityBeforeAct: "valid", classificationSource: "audit-1", eligible: true,
  evidenceGrade: "executable", reproducerSupplied: true, rerun: "passed", commandIds: ["shared-command"], outcome: "fixed", errorsDiscovered: 0,
  independence: "verified", modelIds: ["model"], runIds: [id], ...changes });
function fixture(): DecisionMeasurementInput {
  return { version: 1, cohort: { id: "synthetic", repositories: ["repo"], start: "2026-09-01T00:00:00Z", end: "2026-09-02T00:00:00Z", followUpEnd: "2026-09-05T00:00:00Z", followUpCoverage: "sampled" },
    attempts: [attempt("a1", { act: "fix", authorityBeforeAct: "absent", eligible: false, rerun: "not-run" }),
      attempt("a2", { rerun: "failed", errorsDiscovered: 1, outcome: "decision-needed" }),
      attempt("a3", { findingId: "f2", claimId: "c2", secondPass: { at: "2026-09-04T00:00:00Z", result: "false-close", source: "audit-2" } }),
      attempt("a4", { findingId: "f3", claimId: "c3", act: "fix", requirementAuthority: "unknown", authorityBeforeAct: "unknown", evidenceGrade: "inspection", reproducerSupplied: false, rerun: "not-run", outcome: "unknown", independence: "unknown", commandIds: [] })],
    questions: [{ id: "q1", batchId: "b1", repository: "repo", postedAt: at, exit: "unanswered", followUp: "unobserved" },
      { id: "q2", batchId: "b2", repository: "repo", postedAt: at, exit: "answered", followUp: "answered" },
      { id: "q3", batchId: "b2", repository: "repo", postedAt: at, exit: "partial", followUp: "interpretation" }] };
}
test("P7 synthetic denominators retain repeated attempts, shared commands, failed verification and later wrong closure", () => {
  const result = extractDecisionMeasurement(fixture());
  assert.equal(result.raw.attemptIds.length, 4); assert.equal(result.raw.findingIds.length, 3); assert.equal(result.raw.claimIds.length, 3);
  assert.deepEqual(result.authority, { observedActs: 4, required: 3, unauthorized: 1, valid: 2, unknownAuthority: 0, unknownRequirement: 1, historicalSample: { numerator: 13, denominator: 183 } });
  assert.equal(result.verifier.eligibleAttempts, 3); assert.equal(result.verifier.suppliedReproducers, 2);
  assert.equal(result.verifier.actuallyRerun, 2);
  assert.deepEqual(result.verifier.rerun, { passed: 1, failed: 1, unknown: 0, "not-run": 1 });
  assert.equal(result.verifier.errorsDiscovered, 1); assert.equal(result.verifier.closeAttempts, 2); assert.equal(result.verifier.auditedCloseAttempts, 1);
  assert.equal(result.verifier.falseClosures, 1); assert.equal(result.verifier.unauditedCloseAttempts, 1);
  assert.equal(result.decisions.exit.questions, 3); assert.equal(result.decisions.exit.answeredQuestions, 1);
  assert.equal(result.decisions.exit.batches, 2); assert.equal(result.decisions.exit.answeredBatches, 0);
  assert.equal(result.decisions.followUp.byState.unobserved, 1); assert.equal(result.decisions.followUp.byState.interpretation, 1);
});
test("P7 uses a half-open act window and explicit follow-up cutoff", () => {
  const input = fixture(); input.attempts.push(attempt("outside", { at: input.cohort.end }));
  input.attempts[2]!.secondPass!.at = "2026-09-06T00:00:00Z";
  const r = extractDecisionMeasurement(input); assert.deepEqual(r.raw.excludedAttemptIds, ["outside"]);
  assert.equal(r.verifier.falseClosures, 0); assert.equal(r.verifier.auditedCloseAttempts, 0); assert.equal(r.verifier.unauditedCloseAttempts, 2);
});
test("P7 zero second-pass coverage remains visible alongside zero false closures", () => {
  const input = fixture(); input.cohort.followUpCoverage = "none"; delete input.attempts[2]!.secondPass;
  const r = extractDecisionMeasurement(input); assert.equal(r.verifier.falseClosures, 0); assert.equal(r.verifier.auditedCloseAttempts, 0); assert.equal(r.verifier.unauditedCloseAttempts, 2);
});
test("P7 duplicate raw IDs, cross-cohort rows and unsupported schema refuse", () => {
  const a = fixture(); a.attempts.push(a.attempts[0]!); assert.throws(() => extractDecisionMeasurement(a), /duplicate/);
  const b = fixture(); b.questions[0]!.repository = "other"; assert.throws(() => extractDecisionMeasurement(b), /repository/);
  const c = fixture(); (c as any).version = 2; assert.throws(() => extractDecisionMeasurement(c), /version/);
});
test("P7 unknown authority and partial answers never become valid or answered", () => {
  const input = fixture(); input.attempts[0]!.authorityBeforeAct = "unknown";
  const r = extractDecisionMeasurement(input); assert.equal(r.authority.unauthorized, 0); assert.equal(r.authority.unknownAuthority, 1);
  assert.equal(r.decisions.exit.byState.partial, 1); assert.equal(r.decisions.exit.answeredQuestions, 1);
});
test("P7 untestable evidence cannot claim a rerun, and parked questions require deadlines", () => {
  const a = fixture(); a.attempts[3]!.rerun = "passed"; assert.throws(() => extractDecisionMeasurement(a), /reproducer/);
  const b = fixture(); b.questions[0]!.exit = "parked"; assert.throws(() => extractDecisionMeasurement(b), /deadline/);
});
