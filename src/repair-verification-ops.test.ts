import { test } from "node:test";
import assert from "node:assert/strict";
import { team, settle } from "./oracle.js";
import { shareFinding, reviseFinding, reassignFinding } from "./ops-shared.js";
import { postRepairSort, recordRepairClaims, recordRepairEvidence, recordRepairParticipant } from "./ops/repairs.js";
import { requestRepairVerification, repairVerificationBrief, submitRepairVerification, arbitrateRepairVerification, applyRepairVerification, repairVerificationRecords } from "./ops/repair-verification.js";
import { RepairVerifierBoundary } from "./verifier-boundary.js";
import { issueRepairParticipation } from "./repair-participation.js";
import { headCommit } from "./git.js";
import { readFinding, trustedRepairParticipants } from "./store.js";
import type { RepairClaimVerdict } from "./repair-verification.js";
import type { RepairSortInput, RepairEvidenceInput } from "./repair-records.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { postRound } from "./ops/decisions.js";
import { decisionsView } from "./ops/decision-holds.js";
import { resolveSidecar } from "./sidecar-config.js";
import { findingScope } from "./shared-findings.js";
import { findingKeyScope } from "./review-target.js";
const ok = (result: unknown) => assert.equal((result as { error?: string }).error, undefined, JSON.stringify(result));
async function fixture(count = 1, decomposed = false, changeEvidence?: (evidence: RepairEvidenceInput, root: string) => void, holdBeforeRequest?: "legacy" | "typed") {
  const t = await team(["owner@acme.test", "fixer@acme.test"]);
  const root = t.all[0]!.repo, peer = t.all[1]!.repo, ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const f = await shareFinding(root, 7, { targetKind: "anchor", targetId: `src/pay.ts#transfer${i}`, text: `obligation ${i}`, sourceRef: headCommit(root)! }) as { id: string };
    ok(f); ids.push(f.id);
  }
  if (decomposed) ok(await recordRepairClaims(root, 7, { findingId: ids[0]!, parentId: `${ids[0]}:original`, reason: "two separate obligations", claims: [{ id: "extra", text: "second obligation" }] }));
  const sort: RepairSortInput = { id: "sort1", classification: "mechanical", kind: "isolated", source: "approved owner worklist",
    coverage: ids.map(id => ({ findingId: id, claimIds: [`${id}:original`, ...(decomposed ? ["extra"] : [])] })), restsOn: [], provenance: "owner-reviewed", assessments: [], disagreements: [] };
  ok(await postRepairSort(root, 7, sort));
  const sha = headCommit(root)!;
  const evidence: RepairEvidenceInput = { id: "proof1", sortId: "sort1", witnessCommit: sha, baseCommit: sha, fixCommit: sha,
    coverage: sort.coverage.map(ref => ({ ...ref, result: "complete", reason: "FIXER CONCLUSION MUST BE HIDDEN", claimResults: ref.claimIds.map(claimId => ({ claimId, result: "complete", reason: "FIXER CLAIM VERDICT MUST BE HIDDEN" })) })),
    reproducer: [], changeFalsifier: [], regression: [], inspected: [{ source: "src/pay.ts", commit: sha, reasoning: "FIXER REASONING MUST BE HIDDEN" }],
    noCheckReason: "synthetic inspection fixture has no useful executable check", rulingIds: [], attribution: [] };
  changeEvidence?.(evidence, root);
  ok(await recordRepairEvidence(root, 7, evidence));
  ok(await recordRepairParticipant(peer, 7, { repairId: "sort1", role: "fixer" }, issueRepairParticipation({ principal: "fixer@acme.test", harness: "codex", session: "fixer" })));
  await settle(t);
  if (holdBeforeRequest) await postHold(root, ids[0]!, holdBeforeRequest);
  const host = (session: string) => {
    const boundary = new RepairVerifierBoundary({ context: { supported: true, identity: { principal: "owner@acme.test", harness: "codex", session, model: "same-model" } }, participants: () => trustedRepairParticipants(root) });
    assert.equal(boundary.claim().ok, true);
    return { boundary };
  };
  const orchestrator = host("orchestrator");
  const requested = await requestRepairVerification(root, 7, { sortId: "sort1", evidenceId: "proof1" }, orchestrator);
  let requestId = "";
  if (holdBeforeRequest) assert.match((requested as { error: string }).error, /held|decision/);
  else { ok(requested); assert.ok("request" in requested && requested.request); requestId = requested.request.id; }
  const results = (verdict: RepairClaimVerdict["verdict"] = "fixed", subset = false): RepairClaimVerdict[] => sort.coverage.flatMap(ref => (subset ? ref.claimIds.slice(0, 1) : ref.claimIds).map(claimId => ({ findingId: ref.findingId, claimId, verdict,
    reason: verdict === "fixed" ? "independently inspected the exact guard and checked its return before mutation" : verdict === "factually-refuted" ? "the exact claimed absent guard is visibly present" : "target evidence unavailable",
    grade: verdict === "unknown" ? "none" : "inspection", executions: [], inspected: verdict === "unknown" ? [] : [{ source: "src/pay.ts", commit: evidence.fixCommit, reasoning: "independent source inspection confirms the exact claim" }], noCheckReason: "synthetic fixture has no useful runnable check" })));
  const run = async (slot: 1 | 2, verdict: RepairClaimVerdict["verdict"] = "fixed", subset = false) => {
    const h = host(`verifier-${slot}`);
    const brief = await repairVerificationBrief(root, 7, { requestId, role: "verifier", slot }, h);
    ok(brief);
    assert.equal(JSON.stringify(brief).includes("FIXER"), false);
    assert.equal(JSON.stringify(brief).includes("sealedRuns"), false);
    const submitted = await submitRepairVerification(root, 7, { requestId, slot, results: results(verdict, subset) }, h);
    ok(submitted); assert.ok("run" in submitted && submitted.run);
    assert.equal("records" in submitted, false);
    return { h, run: submitted.run };
  };
  return { t, root, peer, ids, sort, evidence, host, orchestrator, requestId, requested, results, run };
}

async function postHold(root: string, findingId: string, kind: "legacy" | "typed") {
  const cfg = resolveSidecar(root)!;
  const issues = kind === "typed" ? [{ kind: "finding" as const, universe: cfg.universe, scope: findingScope(findingKeyScope(cfg, 7)), review: "7", id: findingId }] : [];
  const findings = kind === "legacy" ? [findingId] : [];
  ok(await postRound(root, { round: { id: "R-hold", source: "unanswered requirement question" }, decisions: [{ id: "D-hold", round: "R-hold", ref: "D1", kind: "options",
    payload: { question: `D1: is ${findingId} an obligation?`, options: [{ label: "No" }, { label: "Yes" }] },
    options: [{ label: "No", effects: [{ findings, issues, on: "settle", as: "refuted" }] }, { label: "Yes", effects: [{ findings, issues, on: "unblock" }] }] }] }));
  const view = await decisionsView(root);
  const ref = { kind: "finding" as const, universe: cfg.universe, scope: findingScope(findingKeyScope(cfg, 7)), review: "7", id: findingId };
  assert.equal(view.issueWork(ref).allowed, false);
}

test("ops request, blind runs, separate application and sync close each finding independently", async () => {
  const f = await fixture(2);
  try {
    await f.run(1); await f.run(2);
    assert.equal((await readFinding(f.root, f.ids[0]!, { pr: 7 }))!.state, "created");
    for (const findingId of f.ids) {
      const applied = await applyRepairVerification(f.root, 7, { requestId: f.requestId, findingId, reason: "two independent exact inspections cover this finding" }, f.orchestrator);
      ok(applied);
      assert.equal((await readFinding(f.root, findingId, { pr: 7 }))!.state, "resolved");
    }
    await settle(f.t);
    const ours = await repairVerificationRecords(f.root, 7), theirs = await repairVerificationRecords(f.peer, 7);
    assert.ok("records" in ours && ours.records && "records" in theirs && theirs.records);
    assert.deepEqual(ours.records, theirs.records);
    assert.equal(theirs.records.applications.length, 2);
    assert.equal((await readFinding(f.peer, f.ids[1]!, { pr: 7 }))!.state, "resolved");
  } finally { f.t.dispose(); }
});

test("ops refuse fabricated hosts, slot switching, self-verification and missing blind briefs", async () => {
  const f = await fixture();
  try {
    const fake = await submitRepairVerification(f.root, 7, { requestId: f.requestId, slot: 1, results: f.results() }, {} as never);
    assert.match((fake as { error: string }).error, /trusted fresh host/);
    const self = await repairVerificationBrief(f.root, 7, { requestId: f.requestId, role: "verifier", slot: 1 }, f.orchestrator);
    assert.match((self as { error: string }).error, /orchestrator/);
    const h = f.host("third");
    const missing = await submitRepairVerification(f.root, 7, { requestId: f.requestId, slot: 1, results: f.results() }, h);
    assert.match((missing as { error: string }).error, /blind bounded/);
    ok(await repairVerificationBrief(f.root, 7, { requestId: f.requestId, role: "verifier", slot: 1 }, h));
    assert.match((await submitRepairVerification(f.root, 7, { requestId: f.requestId, slot: 2, results: f.results() }, h) as { error: string }).error, /exact slot/);
    assert.match((await repairVerificationBrief(f.root, 7, { requestId: f.requestId, role: "verifier", slot: 2 }, h) as { error: string }).error, /assigned another/);
  } finally { f.t.dispose(); }
});

test("partial independent coverage cannot resolve a multi-claim finding", async () => {
  const f = await fixture(1, true);
  try {
    await f.run(1, "fixed", true); await f.run(2, "fixed", true);
    const applied = await applyRepairVerification(f.root, 7, { requestId: f.requestId, findingId: f.ids[0]!, reason: "partial" }, f.orchestrator);
    assert.match((applied as { error: string }).error, /partial coverage/);
    assert.equal((await readFinding(f.root, f.ids[0]!, { pr: 7 }))!.state, "created");
  } finally { f.t.dispose(); }
});

test("disagreement needs a separate arbitrator who sees both sealed rationales", async () => {
  const f = await fixture();
  try {
    const a = await f.run(1, "fixed"), b = await f.run(2, "factually-refuted");
    const premature = await applyRepairVerification(f.root, 7, { requestId: f.requestId, findingId: f.ids[0]!, reason: "majority" }, f.orchestrator);
    assert.match((premature as { error: string }).error, /disagreement/);
    assert.match((await repairVerificationBrief(f.root, 7, { requestId: f.requestId, role: "arbitrator" }, a.h) as { error: string }).error, /sealed verifier/);
    const arb = f.host("arbitrator");
    const brief = await repairVerificationBrief(f.root, 7, { requestId: f.requestId, role: "arbitrator" }, arb);
    ok(brief); assert.ok("sealedRuns" in brief && brief.sealedRuns?.length === 2);
    const addresses = [{ findingId: f.ids[0]!, claimId: `${f.ids[0]}:original`, verdict: "fixed" as const, reason: "the original witness lacked the guard and the checked commit supplies it; present guard is a repair rather than contradiction of filing" }];
    ok(await arbitrateRepairVerification(f.root, 7, { requestId: f.requestId, runIds: [a.run.id, b.run.id], addresses }, arb));
    ok(await applyRepairVerification(f.root, 7, { requestId: f.requestId, findingId: f.ids[0]!, reason: "both inspection records and arbitration cover the claim" }, f.orchestrator));
  } finally { f.t.dispose(); }
});

test("changing exactly the claim or accepted sort makes application visibly stale", async () => {
  for (const mutation of ["claim", "sort"] as const) {
    const f = await fixture();
    try {
      await f.run(1); await f.run(2);
      if (mutation === "claim") ok(await reviseFinding(f.root, 7, f.ids[0]!, { text: "changed exact claim" }));
      else ok(await postRepairSort(f.root, 7, { ...f.sort, id: "sort2", prior: f.sort.id, reason: "new independent assessment" }));
      const applied = await applyRepairVerification(f.root, 7, { requestId: f.requestId, findingId: f.ids[0]!, reason: "old inputs" }, f.orchestrator);
      assert.match((applied as { error: string }).error, /stale|not currently eligible|superseded/);
      assert.equal((await readFinding(f.root, f.ids[0]!, { pr: 7 }))!.state, "created");
    } finally { f.t.dispose(); }
  }
});

test("recorded command data is never executed by request, brief, seal or application", async () => {
  const f = await fixture(1, false, (e, root) => {
    e.reproducer = [{ id: "unavailable-check", command: `touch '${join(root, "must-not-execute")}'`, commit: e.fixCommit,
      environment: "missing fixture runner", phase: "fix", outcome: "unknown", reason: "runner is unavailable; command has not run" }];
  });
  try {
    await f.run(1); await f.run(2);
    ok(await applyRepairVerification(f.root, 7, { requestId: f.requestId, findingId: f.ids[0]!, reason: "explicit independent inspection has visibly weaker grade" }, f.orchestrator));
    assert.equal(existsSync(join(f.root, "must-not-execute")), false);
    const records = await repairVerificationRecords(f.root, 7);
    assert.ok("records" in records && records.records);
    assert.equal(records.records.runs[0]!.results[0]!.grade, "inspection");
    assert.equal(records.records.requests[0]!.capsule.evidence.reproducer[0]!.outcome, "unknown");
  } finally { f.t.dispose(); }
});

test("unavailable pinned code remains explicit unknown and cannot be applied", async () => {
  const f = await fixture(1, false, e => { e.fixCommit = "a".repeat(40); });
  try {
    const records = await repairVerificationRecords(f.root, 7);
    assert.ok("records" in records && records.records);
    assert.equal(records.records.requests[0]!.capsule.code.availability, "unknown");
    await f.run(1); await f.run(2);
    const applied = await applyRepairVerification(f.root, 7, { requestId: f.requestId, findingId: f.ids[0]!, reason: "missing code cannot be closed" }, f.orchestrator);
    assert.match((applied as { error: string }).error, /unavailable/);
    assert.equal((await readFinding(f.root, f.ids[0]!, { pr: 7 }))!.state, "created");
  } finally { f.t.dispose(); }
});

test("an unanswered target decision holds a request even when evidence omits all ruling references", async () => {
  for (const kind of ["legacy", "typed"] as const) {
    const f = await fixture(1, false, undefined, kind);
    try {
      assert.deepEqual(f.evidence.rulingIds, []);
      assert.match((f.requested as { error: string }).error, /held.*decision/);
      const history = await repairVerificationRecords(f.root, 7);
      assert.ok("records" in history && history.records);
      assert.equal(history.records.requests.length, 0);
      assert.equal((await readFinding(f.root, f.ids[0]!, { pr: 7 }))!.state, "created");
    } finally { f.t.dispose(); }
  }
});

test("an unanswered decision posted after both sealed runs blocks separate application", async () => {
  for (const kind of ["legacy", "typed"] as const) {
    const f = await fixture();
    try {
      await f.run(1); await f.run(2);
      await postHold(f.root, f.ids[0]!, kind);
      assert.deepEqual(f.evidence.rulingIds, []);
      const applied = await applyRepairVerification(f.root, 7, { requestId: f.requestId, findingId: f.ids[0]!, reason: "omitted ruling refs cannot bypass current hold" }, f.orchestrator);
      assert.match((applied as { error: string }).error, /held.*decision/);
      assert.equal((await readFinding(f.root, f.ids[0]!, { pr: 7 }))!.state, "created");
    } finally { f.t.dispose(); }
  }
});

test("later human assignment preserves the established release of an ordinary decision hold", async () => {
  const f = await fixture(1, false, undefined, "legacy");
  try {
    ok(await reassignFinding(f.root, 7, f.ids[0]!, { kind: "fix", note: "owner explicitly assigns this existing mechanical work" }));
    assert.equal((await decisionsView(f.root)).work(f.ids[0]!, (await readFinding(f.root, f.ids[0]!, { pr: 7 }))!.assignment).allowed, true);
    const released = await requestRepairVerification(f.root, 7, { sortId: "sort1", evidenceId: "proof1" }, f.host("released-orchestrator"));
    ok(released);
    assert.ok("request" in released && released.request);
  } finally { f.t.dispose(); }
});
