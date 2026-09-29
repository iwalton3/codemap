/**
 * The repair verification FOLD, run on hand-built events (CLAUDE.md: "To review a fold, RUN it").
 * The rules are the owner's, 2026-09-28: a verifier is a dedicated connection or a subagent; the
 * fixer's own connection cannot verify its repair, a subagent it launched can at a weaker grade;
 * "fixed" is the verifier's OWN observation of a check failing at the witness and passing at the
 * fix; two blind slots per request, a third verifier arbitrates a real disagreement.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { foldRepairRecords, type RepairSortInput, type RepairEvidenceInput, type RepairExecution } from "./repair-records.js";
import { foldFindings } from "./shared-findings.js";
import { issueClaimHash } from "./ruling-application.js";
import { testChain } from "./test-events.js";
import {
  foldRepairVerification, repairVerificationDecision, repairVerificationHash, earlierUnfavourableRuns, isRepairVerificationState,
  type RepairVerificationCapsule, type RepairClaimVerdict,
} from "./repair-verification.js";
import type { VerifierIdentity } from "./verifier-boundary.js";
import type { LogEvent } from "./eventlog.js";

const W = "a".repeat(40), F = "c".repeat(40);
const owner = { principal: "owner" };
const conn = (session: string): VerifierIdentity => ({ principal: "owner", harness: "mcp", session });
const sub = (session: string, child: string): VerifierIdentity => ({ principal: "owner", harness: "claude-subagent", session, child });
const run = (command: string, commit: string, phase: RepairExecution["phase"], outcome: "passed" | "failed"): RepairExecution =>
  ({ id: `${phase}-${commit.slice(0, 1)}`, command, commit, environment: "scratch", phase, outcome, exitCode: outcome === "passed" ? 0 : 1 });
const CHECK = "node --test guard.test.js";
const observedFix = [run(CHECK, W, "witness", "failed"), run(CHECK, F, "fix", "passed")];

function fixture(opts: { pinned?: RepairExecution[]; classification?: string; refutationSubtype?: "factual" | "assumed" } = {}) {
  const sort: RepairSortInput = { id: "sort", classification: opts.classification ?? "mechanical", kind: "isolated", coverage: [{ findingId: "f", claimIds: ["f:original"] }],
    restsOn: [], source: "owner reviewed", provenance: "owner-reviewed", assessments: [], disagreements: [], ...(opts.refutationSubtype ? { refutationSubtype: opts.refutationSubtype } : {}) };
  const evidence: RepairEvidenceInput = { id: "proof", sortId: "sort", witnessCommit: W, baseCommit: "b".repeat(40), fixCommit: F,
    coverage: [{ findingId: "f", claimIds: ["f:original"], result: "complete", reason: "r", claimResults: [{ claimId: "f:original", result: "complete", reason: "r" }] }],
    reproducer: opts.pinned ?? [], regression: [], inspected: [], rulingIds: [], attribution: [] };
  const events: LogEvent[] = testChain("w", [
    { id: "created", actor: owner, kind: "finding.created", subject: "f", data: { text: "missing guard", targetId: "a", targetKind: "anchor" } },
    { id: "sort", actor: owner, kind: "repair.sort-recorded", subject: "sort", data: { ...sort } },
    { id: "proof", actor: owner, kind: "repair.evidence-recorded", subject: "proof", data: { ...evidence } },
  ]);
  const finding = foldFindings(events).get("f")!;
  const capsule: RepairVerificationCapsule = { scope: "findings/acme/1", claims: foldRepairRecords(events).claims, sort, evidence,
    targets: [{ findingId: "f", openEpoch: finding.openEpoch!, claimHash: issueClaimHash("finding", finding) }],
    code: { witnessCommit: W, baseCommit: evidence.baseCommit, fixCommit: F, touched: [], availability: "available" }, rulingContext: "ctx", orchestrator: conn("fixer") };
  const add = (id: string, kind: string, subject: string, data: Record<string, unknown>) => {
    events.push(...testChain("w", [{ id, kind, subject, actor: owner, data, writerPrev: events.at(-1)!.id, after: [events.at(-1)!.id] }]));
    return id;
  };
  const request = (id = "rq") => add(`e-${id}`, "repair.verification-requested", id, { id, capsule, capsuleHash: repairVerificationHash(capsule) });
  const verdict = (v: RepairClaimVerdict["verdict"], executions: RepairExecution[], grade: RepairClaimVerdict["grade"] = "executable", inspected: RepairClaimVerdict["inspected"] = []): RepairClaimVerdict =>
    ({ findingId: "f", claimId: "f:original", verdict: v, reason: "checked", grade, executions, inspected, ...(grade === "inspection" ? { noCheckReason: "nothing runs" } : {}) });
  const verify = (slot: 1 | 2, identity: VerifierIdentity, result: RepairClaimVerdict, requestId = "rq") =>
    add(`e-run-${requestId}-${slot}-${identity.session}-${identity.child ?? ""}`, "repair.verification-recorded", `run-${requestId}-${slot}`,
      { id: `run-${requestId}-${slot}`, requestId, capsuleHash: repairVerificationHash(capsule), slot, identity, results: [result] });
  const apply = (identity: VerifierIdentity, outcome = "fixed") => add(`e-apply-${events.length}`, "finding.repairApplied", "f",
    { id: `apply-${events.length}`, requestId: "rq", capsuleHash: repairVerificationHash(capsule), findingId: "f", openEpoch: finding.openEpoch,
      claimHash: issueClaimHash("finding", finding), outcome, contextHash: repairVerificationHash("ctx"), reason: "verified", identity });
  const folded = () => foldRepairVerification(events);
  const rejected = (eventId: string) => folded().rejected.find((r) => r.eventId === eventId)?.reason;
  return { events, request, verdict, verify, apply, folded, rejected, add, capsule };
}

test("fixed is the verifier's own fail-then-pass observation; an echo of the fixer's pass is refused", () => {
  const f = fixture(); f.request();
  f.verify(1, conn("v1"), f.verdict("fixed", observedFix));
  const echo = f.verify(2, conn("v2"), f.verdict("fixed", [run(CHECK, F, "fix", "passed")]));
  assert.match(f.rejected(echo) ?? "", /own observation of the check failing at the witness and passing at the fix/);
  f.verify(2, conn("v3"), f.verdict("fixed", observedFix));
  const d = repairVerificationDecision(f.folded(), "rq", "f");
  assert.deepEqual([d.verdict, d.complete, d.grade], ["fixed", true, "executable"]);
});

test("a check the fixer pinned must be run by the verifier at both commits; one the fixer could not run pins nothing", () => {
  const pinned = fixture({ pinned: [run(CHECK, W, "witness", "failed"), run(CHECK, F, "fix", "passed")] }); pinned.request();
  const inspected = pinned.verify(1, conn("v1"), pinned.verdict("fixed", [], "inspection", [{ source: "guard.ts", commit: F, reasoning: "guard present" }]));
  assert.match(pinned.rejected(inspected) ?? "", /must run it rather than inspect/);
  const other = pinned.verify(1, conn("v2"), pinned.verdict("fixed", [run("other", W, "witness", "failed"), run("other", F, "fix", "passed")]));
  assert.match(pinned.rejected(other) ?? "", /own observation/, "its own check does not replace the pinned one");
  const unrun = fixture({ pinned: [{ ...run(CHECK, W, "witness", "failed"), outcome: "unknown", exitCode: undefined, reason: "no runner" }] }); unrun.request();
  const ok = unrun.verify(1, conn("v1"), unrun.verdict("fixed", [], "inspection", [{ source: "guard.ts", commit: F, reasoning: "guard present" }]));
  assert.equal(unrun.rejected(ok), undefined);
});

const tests = { basis: { tests: true, reason: "the check calls the guarded path with the claimed input" } };
test("plan 3.3 real basis: a refutation runs the PINNED check at the old code, having said why it tests the claim", () => {
  const pinnedCheck = [run(CHECK, W, "witness", "passed")];
  const f = fixture({ classification: "factual-refutation", refutationSubtype: "factual", pinned: pinnedCheck }); f.request();
  const atFix = f.verify(1, conn("v1"), { ...f.verdict("factually-refuted", [run(CHECK, F, "fix", "passed")]), ...tests });
  assert.match(f.rejected(atFix) ?? "", /each pinned check at the witness/);
  const anyCommand = f.verify(1, conn("v2"), { ...f.verdict("factually-refuted", [run("true", W, "witness", "passed")]), ...tests });
  assert.match(f.rejected(anyCommand) ?? "", /each pinned check at the witness/, "the any-passing-command door is shut");
  const noBasis = f.verify(1, conn("v3"), f.verdict("factually-refuted", [run(CHECK, W, "witness", "passed")]));
  assert.match(f.rejected(noBasis) ?? "", /states whether and why/);
  const notTesting = f.verify(1, conn("v4"), { ...f.verdict("factually-refuted", [run(CHECK, W, "witness", "passed")]), basis: { tests: false, reason: "it never reaches the guard" } });
  assert.match(f.rejected(notTesting) ?? "", /does not test the claim cannot refute/);
  assert.equal(f.rejected(f.verify(1, conn("v5"), { ...f.verdict("factually-refuted", [run(CHECK, W, "witness", "passed")]), ...tests })), undefined);
  const unpinned = fixture({ classification: "factual-refutation", refutationSubtype: "factual" }); unpinned.request();
  const bare = unpinned.verify(1, conn("v1"), { ...unpinned.verdict("factually-refuted", [run(CHECK, W, "witness", "passed")]), ...tests });
  assert.match(unpinned.rejected(bare) ?? "", /inspection with a written reason/);
});

test("plan 3.3: a reviewer's refuted assumption closes as invalid through two runs, by inspection or execution", () => {
  const f = fixture({ classification: "invalid", refutationSubtype: "assumed" }); f.request();
  const asRefuted = f.verify(1, conn("v1"), { ...f.verdict("factually-refuted", [], "inspection", [{ source: "pay.ts", commit: W, reasoning: "the guard exists" }]) });
  assert.match(f.rejected(asRefuted) ?? "", /closes as invalid/);
  f.verify(1, conn("v2"), f.verdict("invalid", [], "inspection", [{ source: "pay.ts", commit: W, reasoning: "the reviewer assumed no guard; line 12 guards it" }]));
  f.verify(2, conn("v3"), f.verdict("invalid", [], "inspection", [{ source: "pay.ts", commit: W, reasoning: "guarded at line 12" }]));
  const d = repairVerificationDecision(f.folded(), "rq", "f");
  assert.deepEqual([d.verdict, d.complete], ["invalid", true]);
  assert.equal(foldRepairRecords(f.events).sorts[0]!.eligible, true, "an assumed sort is eligible for verification");
  const wrongKind = fixture({ classification: "factual-refutation", refutationSubtype: "factual" }); wrongKind.request();
  const inv = wrongKind.verify(1, conn("v1"), wrongKind.verdict("invalid", [], "inspection", [{ source: "pay.ts", commit: W, reasoning: "r" }]));
  assert.match(wrongKind.rejected(inv) ?? "", /only a reviewer's refuted assumption/);
});

test("grant model (R2): the requester's own connection never verifies; subagents on the controlled path do, with no second grade", () => {
  const f = fixture(); f.request();
  const own = f.verify(1, conn("fixer"), f.verdict("fixed", observedFix));
  assert.match(f.rejected(own) ?? "", /orchestrator cannot verify its own request/);
  f.verify(1, sub("fixer", "a1111111"), f.verdict("fixed", observedFix));
  f.verify(2, sub("fixer", "a2222222"), f.verdict("fixed", observedFix));
  const d = repairVerificationDecision(f.folded(), "rq", "f");
  assert.deepEqual([d.complete, d.grade], [true, "executable"], "a grant verifies; codemap does not pretend to know who the fixer is");
});

test("a retired repair kind is skipped, never shown as a rejected record", () => {
  const f = fixture();
  f.add("old-participant", "repair.participant-recorded", "sort", { repairId: "sort", identity: conn("fixer"), role: "fixer" });
  f.request();
  f.verify(1, conn("v1"), f.verdict("fixed", observedFix));
  const records = foldRepairRecords(f.events);
  assert.equal(records.rejected.length, 0, JSON.stringify(records.rejected));
  assert.ok(!("participants" in records));
});

test("two blind slots take two verifiers, once each, and the orchestrator is neither", () => {
  const f = fixture(); f.request();
  f.verify(1, conn("v1"), f.verdict("fixed", observedFix));
  assert.match(f.rejected(f.verify(2, conn("v1"), f.verdict("fixed", observedFix))) ?? "", /its own verifier/);
  assert.match(f.rejected(f.verify(1, conn("v9"), f.verdict("fixed", observedFix))) ?? "", /its own verifier/, "a slot is taken once");
  const self = fixture(); self.capsule.orchestrator = conn("orch"); self.request();
  assert.match(self.rejected(self.verify(1, conn("orch"), self.verdict("fixed", observedFix))) ?? "", /orchestrator cannot verify/);
});

test("a disagreement needs a third verifier who addresses it with reasons", () => {
  const f = fixture(); f.request();
  f.verify(1, conn("v1"), f.verdict("fixed", observedFix));
  f.verify(2, conn("v2"), f.verdict("unknown", [], "none"));
  assert.equal(repairVerificationDecision(f.folded(), "rq", "f").complete, false);
  const arb = (id: string, identity: VerifierIdentity, reason: string) => f.add(id, "repair.verification-arbitrated", id,
    { id, requestId: "rq", capsuleHash: repairVerificationHash(f.capsule), identity, runIds: ["run-rq-1", "run-rq-2"], addresses: [{ findingId: "f", claimId: "f:original", verdict: "fixed", reason }] });
  assert.match(f.rejected(arb("a1", conn("v1"), "the guard is there and the check shows it")) ?? "", /third verifier/);
  assert.match(f.rejected(arb("a2", conn("v3"), "agree")) ?? "", /substantively/);
  assert.equal(f.rejected(arb("a3", conn("v3"), "slot 2 could not run the check; slot 1's run shows it failing then passing")), undefined);
  const d = repairVerificationDecision(f.folded(), "rq", "f");
  assert.equal(d.verdict, "unknown", "arbitration cannot manufacture the evidence slot 2 never had");
});

test("a verdict closes its finding once per opening, never by a verifier, and never on unknown", () => {
  const f = fixture(); f.request();
  f.verify(1, conn("v1"), f.verdict("fixed", observedFix));
  f.verify(2, conn("v2"), f.verdict("fixed", observedFix));
  assert.match(f.rejected(f.apply(conn("v1"))) ?? "", /cannot apply the verdict it gave/);
  const applied = f.apply(conn("fixer"));
  assert.equal(foldFindings(f.events).get("f")!.closed?.eventId, applied);
  const again = f.apply(conn("fixer"));
  assert.equal(f.rejected(again), undefined, "the verification fold no longer spends it (F34)");
  assert.equal(foldFindings(f.events).get("f")!.closed?.eventId, applied, "the findings arm closed once; the second closed nothing");
  const unknown = fixture(); unknown.request();
  unknown.verify(1, conn("v1"), unknown.verdict("unknown", [], "none"));
  unknown.verify(2, conn("v2"), unknown.verdict("unknown", [], "none"));
  unknown.apply(conn("fixer"));
  assert.equal(foldFindings(unknown.events).get("f")!.state, "created");
});

test("a new request on the same fix shows the earlier unfavourable runs beside it", () => {
  const f = fixture(); f.request("rq");
  f.verify(1, conn("v1"), f.verdict("unknown", [], "none"), "rq");
  f.verify(2, conn("v2"), f.verdict("fixed", observedFix), "rq");
  f.request("rq2");
  const earlier = earlierUnfavourableRuns(f.folded(), "rq2");
  assert.deepEqual(earlier.map((r) => r.id), ["run-rq-1"]);
  assert.deepEqual(earlierUnfavourableRuns(f.folded(), "rq"), [], "the first request has nothing before it");
});

test("a projected verification state with a broken record fails closed", () => {
  const f = fixture(); f.request();
  f.verify(1, conn("v1"), f.verdict("fixed", observedFix));
  const state = JSON.parse(JSON.stringify(f.folded()));
  assert.equal(isRepairVerificationState(state), true);
  state.runs[0].identity = { principal: "owner", harness: "claude-subagent", session: "s" };
  assert.equal(isRepairVerificationState(state), false, "a subagent identity names its subagent");
});
