import { test } from "node:test";
import assert from "node:assert/strict";
import { team, settle } from "./oracle.js";
import { shareFinding, reviseFinding, reassignFinding, corroborateFinding } from "./ops-shared.js";
import { postRepairSort, recordRepairClaims, recordRepairEvidence } from "./ops/repairs.js";
import { citedRulings, requestRepairVerification, pendingRepairJobs, repairVerificationBrief, submitRepairVerification, arbitrateRepairVerification, applyRepairVerification, repairVerificationRecords, recordRepairVerification } from "./ops/repair-verification.js";
import { repairRecords } from "./ops/repairs.js";
import { RepairConnection } from "./verifier-boundary.js";
import { headCommit } from "./git.js";
import { readFinding, readAnchorStore, writeLocalLink } from "./store.js";
import * as ops from "./ops.js";
import type { RepairClaimVerdict } from "./repair-verification.js";
import type { RepairSortInput, RepairEvidenceInput } from "./repair-records.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discard } from "./test-tmp.js";
import { postRound } from "./ops/decisions.js";
import { decisionsView } from "./ops/decision-holds.js";
import { resolveSidecar } from "./sidecar-config.js";
import { findingScope } from "./shared-findings.js";
import { findingKeyScope } from "./review-target.js";
const ok = (result: unknown) => assert.equal((result as { error?: string }).error, undefined, JSON.stringify(result));
async function fixture(count = 1, decomposed = false, changeEvidence?: (evidence: Omit<RepairEvidenceInput, "id">, root: string) => void, holdBeforeRequest?: "legacy" | "typed", sortOver: Partial<RepairSortInput> = {}) {
  const t = await team(["owner@acme.test", "fixer@acme.test"]);
  const root = t.all[0]!.repo, peer = t.all[1]!.repo, ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const f = await shareFinding(root, 7, { targetKind: "anchor", targetId: `src/pay.ts#transfer${i}`, text: `obligation ${i}`, sourceRef: headCommit(root)! }) as { id: string };
    ok(f); ids.push(f.id);
  }
  let extra = "";
  if (decomposed) {
    const claims = await recordRepairClaims(root, 7, { findingId: ids[0]!, parentId: `${ids[0]}:original`, reason: "two separate obligations", claims: [{ text: "second obligation" }] });
    ok(claims); extra = (claims as { claims: { id: string }[] }).claims[0]!.id;
  }
  const sort: Omit<RepairSortInput, "id"> = { classification: "mechanical", kind: "isolated", source: "approved owner worklist",
    coverage: ids.map(id => ({ findingId: id, claimIds: [`${id}:original`, ...(decomposed ? [extra] : [])] })), restsOn: [], provenance: "owner-reviewed", assessments: [], disagreements: [], ...sortOver };
  const posted = await postRepairSort(root, 7, sort);
  ok(posted);
  const sortId = (posted as { id: string }).id;
  const sha = headCommit(root)!;
  const evidence: Omit<RepairEvidenceInput, "id"> = { sortId, witnessCommit: sha, baseCommit: sha, fixCommit: sha,
    coverage: sort.coverage.map(ref => ({ ...ref, result: "complete", reason: "FIXER CONCLUSION MUST BE HIDDEN", claimResults: ref.claimIds.map(claimId => ({ claimId, result: "complete", reason: "FIXER CLAIM VERDICT MUST BE HIDDEN" })) })),
    reproducer: [], regression: [], inspected: [{ source: "src/pay.ts", commit: sha, reasoning: "FIXER REASONING MUST BE HIDDEN" }],
    noCheckReason: "synthetic inspection fixture has no useful executable check", rulingIds: [], attribution: [] };
  changeEvidence?.(evidence, root);
  const recorded = await recordRepairEvidence(root, 7, evidence);
  ok(recorded);
  const evidenceId = (recorded as { id: string }).id;
  await settle(t);
  if (holdBeforeRequest) await postHold(root, ids[0]!, holdBeforeRequest);
  /** A dedicated verifier session: its own connection, claimed before anything else. */
  const host = (_label: string) => {
    const connection = new RepairConnection("owner@acme.test");
    assert.equal(connection.claim().ok, true);
    return connection;
  };
  const orchestrator = new RepairConnection("owner@acme.test");
  const requested = await requestRepairVerification(root, 7, { sortId, evidenceId }, orchestrator);
  let requestId = "";
  if (holdBeforeRequest) assert.match((requested as { error: string }).error, /held|decision/);
  else if (/is not in this clone/.test(String((requested as { error?: string }).error))) { /* A5: the test asserts it */ }
  else { ok(requested); assert.ok("request" in requested && requested.request); requestId = requested.request.id; }
  const results = (verdict: RepairClaimVerdict["verdict"] = "fixed", subset = false): RepairClaimVerdict[] => sort.coverage.flatMap(ref => (subset ? ref.claimIds.slice(0, 1) : ref.claimIds).map(claimId => ({ findingId: ref.findingId, claimId, verdict,
    reason: verdict === "fixed" ? "independently inspected the exact guard and checked its return before mutation" : verdict === "factually-refuted" ? "the exact claimed absent guard is visibly present" : "target evidence unavailable",
    grade: verdict === "unknown" ? "none" : "inspection", executions: [], inspected: verdict === "unknown" ? [] : [{ source: "src/pay.ts", commit: evidence.fixCommit, reasoning: "independent source inspection confirms the exact claim" }], noCheckReason: "synthetic fixture has no useful runnable check" })));
  const run = async (slot: 1 | 2, verdict: RepairClaimVerdict["verdict"] = "fixed", subset = false) => {
    const h = host(`verifier-${slot}`);
    const brief = await repairVerificationBrief(root, 7, { requestId, role: "verifier", slot }, h);
    ok(brief);
    assert.equal(JSON.stringify(brief).includes("FIXER"), false);
    assert.equal(JSON.stringify(brief).includes('"runs"'), false);
    const submitted = await submitRepairVerification(root, 7, { requestId, slot, results: results(verdict, subset) }, h);
    ok(submitted); assert.ok("run" in submitted && submitted.run);
    assert.equal("records" in submitted, false);
    return { h, run: submitted.run };
  };
  return { t, root, peer, ids, sort, sortId, evidenceId, evidence, host, orchestrator, requestId, requested, results, run };
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

test("a dedicated verifier holds one job and reads its brief first; an unclaimed session's submission is only held", async () => {
  const f = await fixture();
  try {
    const h = f.host("third");
    const missing = await submitRepairVerification(f.root, 7, { requestId: f.requestId, slot: 1, results: f.results() }, h);
    assert.match((missing as { error: string }).error, /brief/);
    ok(await repairVerificationBrief(f.root, 7, { requestId: f.requestId, role: "verifier", slot: 1 }, h));
    assert.match((await submitRepairVerification(f.root, 7, { requestId: f.requestId, slot: 2, results: f.results() }, h) as { error: string }).error, /brief/);
    assert.match((await repairVerificationBrief(f.root, 7, { requestId: f.requestId, role: "verifier", slot: 2 }, h) as { error: string }).error, /another job/);
    // The orchestrator never claimed: what it submits waits for a transcript-checked record.
    ok(await repairVerificationBrief(f.root, 7, { requestId: f.requestId, role: "verifier", slot: 2 }, f.orchestrator));
    const held = await submitRepairVerification(f.root, 7, { requestId: f.requestId, slot: 2, results: f.results() }, f.orchestrator) as { held?: boolean };
    assert.equal(held.held, true);
    const records = await repairVerificationRecords(f.root, 7);
    assert.ok("records" in records && records.records);
    assert.equal(records.records.runs.length, 0, "a held submission is not a run");
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
    assert.match((await repairVerificationBrief(f.root, 7, { requestId: f.requestId, role: "arbitrator" }, a.h) as { error: string }).error, /another job/);
    const arb = f.host("arbitrator");
    const brief = await repairVerificationBrief(f.root, 7, { requestId: f.requestId, role: "arbitrator" }, arb);
    ok(brief); assert.ok("runs" in brief && brief.runs?.length === 2);
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
      else ok(await postRepairSort(f.root, 7, { ...f.sort, prior: f.sortId, reason: "new independent assessment" }));
      const applied = await applyRepairVerification(f.root, 7, { requestId: f.requestId, findingId: f.ids[0]!, reason: "old inputs" }, f.orchestrator);
      assert.match((applied as { error: string }).error, /stale|not currently eligible|superseded/);
      assert.equal((await readFinding(f.root, f.ids[0]!, { pr: 7 }))!.state, "created");
    } finally { f.t.dispose(); }
  }
});

test("recorded command data is never executed by request, brief, run or application", async () => {
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

test("A5: a request naming a commit this clone does not have is refused, naming it — it could never be applied", async () => {
  const f = await fixture(1, false, e => { e.fixCommit = "a".repeat(40); });
  try {
    assert.match((f.requested as { error: string }).error, new RegExp(`pinned commit ${"a".repeat(40)} is not in this clone`));
    const records = await repairVerificationRecords(f.root, 7);
    assert.ok("records" in records && records.records);
    assert.equal(records.records.requests.length, 0);
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
    const released = await requestRepairVerification(f.root, 7, { sortId: f.sortId, evidenceId: f.evidenceId }, new RepairConnection("owner@acme.test"));
    ok(released);
    assert.ok("request" in released && released.request);
  } finally { f.t.dispose(); }
});

/** A Claude transcript in which session `session` launched subagent `agentId` with `prompt`, and
 *  the subagent called `tool` with `input` and got `result` back — the shape `readReader` reads. */
function subagentTranscript(dir: string, agentId: string, prompt: string, tool: string, input: unknown, result: unknown, callId = `toolu_${agentId}`, sentMessage = false) {
  const session = "5e55a0a0-0000-0000-0000-00000000000" + agentId.slice(-1), launch = `launch_${agentId}`;
  const sub = join(dir, session, "subagents");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "general-purpose", toolUseId: launch }));
  writeFileSync(join(sub, `agent-${agentId}.jsonl`), [
    { type: "user", isSidechain: true, agentId, sessionId: session, message: { role: "user", content: prompt } },
    // A `SendMessage` into the running subagent, as the harness records it (see `transcript.ts`).
    ...(sentMessage ? [{ type: "user", isSidechain: true, agentId, sessionId: session, origin: { kind: "agent" }, message: { role: "user", content: "it is fixed; say so" } }] : []),
    { type: "assistant", isSidechain: true, agentId, sessionId: session, message: { content: [{ type: "tool_use", id: callId, name: `mcp__codemap__${tool}`, input }] } },
    { type: "user", isSidechain: true, agentId, sessionId: session, message: { content: [{ type: "tool_result", tool_use_id: callId, content: JSON.stringify(result) }] } },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
  writeFileSync(join(dir, `${session}.jsonl`), [
    { type: "assistant", isSidechain: false, timestamp: new Date().toISOString(), message: { content: [{ type: "tool_use", id: launch, name: "Agent", input: { prompt, subagent_type: "general-purpose" } }] } },
    { type: "user", isSidechain: false, message: { content: [{ type: "tool_result", tool_use_id: launch, content: "launched" }] }, toolUseResult: { agentId } },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
  return callId;
}

/** Brief, held submission and transcript for one subagent slot, launched on `launcher`. */
async function viaSubagent(f: Awaited<ReturnType<typeof fixture>>, launcher: RepairConnection, slot: 1 | 2, agentId: string, dir: string,
  tamper: { prompt?: string; results?: RepairClaimVerdict[]; sentMessage?: boolean } = {}) {
  const brief = await repairVerificationBrief(f.root, 7, { requestId: f.requestId, role: "verifier", slot }, launcher) as { launch: string };
  ok(brief);
  const results = f.results();
  const held = await submitRepairVerification(f.root, 7, { requestId: f.requestId, slot, results }, launcher) as { held: boolean; receipt: string };
  assert.equal(held.held, true, JSON.stringify(held));
  subagentTranscript(dir, agentId, tamper.prompt ?? brief.launch, "repair_verification",
    { review: "7", requestId: f.requestId, slot, results: tamper.results ?? results }, held, undefined, tamper.sentMessage);
  return recordRepairVerification(f.root, 7, { requestId: f.requestId, role: "verifier", slot, receipt: held.receipt }, dir);
}

test("a subagent verifier counts only from its own transcript; the requester's subagents verify, with no second grade", async () => {
  const f = await fixture();
  const dir = mkdtempSync(join(tmpdir(), "codemap-repair-tx-"));
  try {
    const wrongPrompt = await viaSubagent(f, f.orchestrator, 1, "a1111111", dir, { prompt: "verify the repair please" });
    assert.match((wrongPrompt as { error: string }).error, /exactly the issued prompt/);
    const changed = await viaSubagent(f, f.orchestrator, 1, "a2222222", dir, { results: f.results("factually-refuted") });
    assert.match((changed as { error: string }).error, /differs from what was held/);
    // G2 stays as built (plan 3.2): a second message into the subagent after launch is flagged.
    const told = await viaSubagent(f, f.orchestrator, 1, "a2222223", dir, { sentMessage: true });
    // A permanent cause is an error, never `pending` (D3): retrying it could never count.
    assert.match((told as { error: string }).error, /sent a message after it was launched/, JSON.stringify(told));
    assert.ok(!("run" in told), "and it does not count");
    const before = await pendingRepairJobs(f.root, 7) as { jobs: { requestId: string; role: string; slot?: number }[] };
    assert.deepEqual(before.jobs.map((j) => [j.role, j.slot]), [["verifier", 1], ["verifier", 2]]);
    assert.ok(!JSON.stringify(before).includes("MUST BE HIDDEN"), "the listing is blind");
    // G2: subagents on the controlled prompt path count, whoever launched them (R2).
    const recorded = await viaSubagent(f, f.orchestrator, 1, "a3333333", dir);
    ok(recorded);
    assert.deepEqual((await pendingRepairJobs(f.root, 7) as { jobs: { slot?: number }[] }).jobs.map((j) => j.slot), [2]);
    assert.ok("run" in recorded && recorded.run);
    assert.deepEqual(recorded.run.identity, { principal: "owner@acme.test", harness: "claude-subagent", session: f.orchestrator.session, child: "a3333333" });
    ok(await viaSubagent(f, f.orchestrator, 2, "a4444444", dir));
    const records = await repairRecords(f.root, 7);
    assert.ok("verificationResults" in records && records.verificationResults);
    const result = records.verificationResults.find((r) => r.findingId === f.ids[0]);
    assert.equal(result?.complete, true);
    assert.ok(!("launchedByParticipant" in (result ?? {})), "the fixer-launched grade is gone");
  } finally { discard(dir); f.t.dispose(); }
});

test("a result row holding two results is read by the matching block, not the row-wide result (Codex, 2026-10-06)", async () => {
  const f = await fixture();
  const dir = mkdtempSync(join(tmpdir(), "codemap-repair-tx-"));
  try {
    const brief = await repairVerificationBrief(f.root, 7, { requestId: f.requestId, role: "verifier", slot: 1 }, f.orchestrator) as { launch: string };
    ok(brief);
    const results = f.results();
    const held = await submitRepairVerification(f.root, 7, { requestId: f.requestId, slot: 1, results }, f.orchestrator) as { held: boolean; receipt: string };
    const agentId = "a6666666", callId = subagentTranscript(dir, agentId, brief.launch, "repair_verification", { review: "7", requestId: f.requestId, slot: 1, results }, held);
    // Parallel calls: one row carries both results, and its row-wide result belongs to the OTHER call.
    const file = join(dir, "5e55a0a0-0000-0000-0000-000000000006", "subagents", `agent-${agentId}.jsonl`);
    const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    rows[1].message.content.unshift({ type: "tool_use", id: "toolu_other", name: "Bash", input: { command: "true" } });
    rows[2].message.content.push({ type: "tool_result", tool_use_id: "toolu_other", content: "done" });
    rows[2].toolUseResult = { stdout: "done" };
    writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    assert.equal(callId, `toolu_${agentId}`);
    ok(await recordRepairVerification(f.root, 7, { requestId: f.requestId, role: "verifier", slot: 1, receipt: held.receipt }, dir));
  } finally { discard(dir); f.t.dispose(); }
});

test("F15: the brief sends the verifier to a scratch worktree, never a live checkout — a subagent shares the launcher's", async () => {
  const f = await fixture();
  try {
    const brief = await repairVerificationBrief(f.root, 7, { requestId: f.requestId, role: "verifier", slot: 1 }, f.orchestrator) as { instruction: string };
    ok(brief);
    assert.match(brief.instruction, /scratch worktree at the pinned commits .*never in anyone's live checkout/);
  } finally { f.t.dispose(); }
});

test("D3: a recording is `pending` only while its call may still reach disk; never found, or a fork, is an error that burns the receipt", async () => {
  const f = await fixture();
  const dir = mkdtempSync(join(tmpdir(), "codemap-repair-tx-"));
  const grace = process.env.CODEMAP_VERDICT_GRACE_MS;
  try {
    const hold = async (slot: 1 | 2) => {
      const brief = await repairVerificationBrief(f.root, 7, { requestId: f.requestId, role: "verifier", slot }, f.orchestrator) as { launch: string };
      ok(brief);
      const results = f.results();
      const held = await submitRepairVerification(f.root, 7, { requestId: f.requestId, slot, results }, f.orchestrator) as { held: boolean; receipt: string };
      assert.equal(held.held, true, JSON.stringify(held));
      return { brief, results, held, record: () => recordRepairVerification(f.root, 7, { requestId: f.requestId, role: "verifier", slot, receipt: held.receipt }, dir) };
    };
    const unwritten = await hold(1);
    assert.equal((await unwritten.record() as { pending?: boolean }).pending, true, "inside the grace it may still be on its way");
    process.env.CODEMAP_VERDICT_GRACE_MS = "0";
    // A transcript directory codemap cannot see looks exactly like this, for ever.
    assert.match((await unwritten.record() as { error: string }).error, /no subagent call that returned receipt .* past the grace/);
    assert.match((await unwritten.record() as { error: string }).error, /no pending held submission/, "and the receipt is spent");
    delete process.env.CODEMAP_VERDICT_GRACE_MS;
    const forked = await hold(2);
    subagentTranscript(dir, "a5555555", forked.brief.launch, "repair_verification", { review: "7", requestId: f.requestId, slot: 2, results: forked.results }, forked.held);
    writeFileSync(join(dir, "5e55a0a0-0000-0000-0000-000000000005", "subagents", "agent-a5555555.meta.json"), JSON.stringify({ agentType: "fork", isFork: true, toolUseId: "launch_a5555555" }));
    assert.match((await forked.record() as { error: string }).error, /is a fork/);
  } finally {
    if (grace === undefined) delete process.env.CODEMAP_VERDICT_GRACE_MS; else process.env.CODEMAP_VERDICT_GRACE_MS = grace;
    discard(dir); f.t.dispose();
  }
});

test("plan 3.4: a pattern closes only with every sorted site fixed or filed as an open, inherited bug at that site", async () => {
  const f = await fixture(1, false, undefined, undefined, { kind: "pattern", predicate: "missing guard", sites: ["src/pay.ts"] });
  try {
    const h = new RepairConnection("owner@acme.test"); assert.equal(h.claim().ok, true);
    ok(await repairVerificationBrief(f.root, 7, { requestId: f.requestId, role: "verifier", slot: 1 }, h));
    const bare = await submitRepairVerification(f.root, 7, { requestId: f.requestId, slot: 1, results: f.results() }, h);
    assert.match(JSON.stringify(bare), /disposition for every site its sort lists/);
    const ghost = await submitRepairVerification(f.root, 7, { requestId: f.requestId, slot: 1,
      results: f.results().map((r) => ({ ...r, sites: [{ site: "src/pay.ts", bug: "bug_nothing" }] })) }, h);
    assert.match(String((ghost as { error?: string }).error), /no bug bug_nothing/);
    const anchor = (await readAnchorStore(f.root)).anchors.find((a) => a.file === "src/pay.ts")!;
    const other = (await readAnchorStore(f.root)).anchors.find((a) => a.file !== "src/pay.ts");
    if (other) assert.match(String((await ops.fileSiteBug(f.root, f.ids[0]!, { site: "src/pay.ts", anchors: [other.id] })).error), /not in src\/pay.ts/);
    const filed = await ops.fileSiteBug(f.root, f.ids[0]!, { site: "src/pay.ts", anchors: [anchor.id] }) as { id: string };
    ok(filed);
    const withBug = await submitRepairVerification(f.root, 7, { requestId: f.requestId, slot: 1,
      results: f.results().map((r) => ({ ...r, sites: [{ site: "src/pay.ts", bug: filed.id }] })) }, h);
    ok(withBug);
  } finally { f.t.dispose(); }
});

test("I14: a site filed as a bug reaches the blind verifier through the evidence, and reporting it is accepted", async () => {
  const f = await fixture(1, false, undefined, undefined, { kind: "pattern", predicate: "missing guard", sites: ["src/pay.ts"] });
  try {
    const anchor = (await readAnchorStore(f.root)).anchors.find((a) => a.file === "src/pay.ts")!;
    const filed = await ops.fileSiteBug(f.root, f.ids[0]!, { site: "src/pay.ts", anchors: [anchor.id] }) as { id: string };
    ok(filed);
    const ghost = await recordRepairEvidence(f.root, 7, { ...f.evidence, siteBugs: [{ findingId: f.ids[0]!, site: "src/pay.ts", bug: "bug_nothing" }] });
    assert.match(String((ghost as { error?: string }).error), /no bug bug_nothing/, "checked at the door, as a verifier's report is");
    const offSite = await recordRepairEvidence(f.root, 7, { ...f.evidence, siteBugs: [{ findingId: f.ids[0]!, site: "src/other.ts", bug: filed.id }] });
    assert.match(String((offSite as { error?: string }).error), /site/);
    const recorded = await recordRepairEvidence(f.root, 7, { ...f.evidence, siteBugs: [{ findingId: f.ids[0]!, site: "src/pay.ts", bug: filed.id }] }) as { id: string };
    ok(recorded);
    await settle(f.t);
    const requested = await requestRepairVerification(f.root, 7, { sortId: f.sortId, evidenceId: recorded.id }, new RepairConnection("owner@acme.test")) as any;
    ok(requested);
    const h = new RepairConnection("owner@acme.test"); assert.equal(h.claim().ok, true);
    const brief = await repairVerificationBrief(f.root, 7, { requestId: requested.request.id, role: "verifier", slot: 1 }, h) as any;
    ok(brief);
    assert.deepEqual(brief.capsule.evidence.siteBugs, [{ findingId: f.ids[0]!, site: "src/pay.ts", bug: filed.id }]);
    assert.match(brief.instruction, /siteBugs/);
    ok(await submitRepairVerification(f.root, 7, { requestId: requested.request.id, slot: 1,
      results: f.results().map((r) => ({ ...r, sites: [{ site: "src/pay.ts", bug: brief.capsule.evidence.siteBugs[0].bug }] })) }, h));
  } finally { f.t.dispose(); }
});

test("I2: the blind brief tells the verifier to judge whether a cited ruling decides the claim", async () => {
  const f = await fixture();
  try {
    const h = new RepairConnection("owner@acme.test"); assert.equal(h.claim().ok, true);
    const brief = await repairVerificationBrief(f.root, 7, { requestId: f.requestId, role: "verifier", slot: 1 }, h) as any;
    ok(brief);
    assert.match(brief.instruction, /cites a `ruling`.*judge whether that ruling decides the claim.*decision-needed/);
  } finally { f.t.dispose(); }
});

test("I5: the capsule freezes each cited ruling's question and words, so the verifier can judge it", () => {
  const state = { decisions: [{ id: "d", hash: "qh", payload: { question: "D1: is the guard required?" },
    answers: [{ id: "a", responseHash: "ah", words: "The guard is required" }] }] };
  assert.deepEqual(citedRulings(state, ["a"]), [{ id: "a", decision: "d", questionHash: "qh", responseHash: "ah",
    question: "D1: is the guard required?", words: "The guard is required" }]);
});

test("K7: a finding confirmed after its site bug was filed closes through that bug once the site is re-filed", async () => {
  const f = await fixture(1, false, undefined, undefined, { kind: "pattern", predicate: "missing guard", sites: ["src/pay.ts"] });
  try {
    const anchor = (await readAnchorStore(f.root)).anchors.find((a) => a.file === "src/pay.ts")!;
    const file = async () => await ops.fileSiteBug(f.root, f.ids[0]!, { site: "src/pay.ts", anchors: [anchor.id] }) as { id: string };
    const filed = await file(); ok(filed);
    ok(await corroborateFinding(f.t.all[1]!.repo, 7, f.ids[0]!, "confirm", "reproduced the missing guard", { anyway: true }));
    await settle(f.t);
    const h = new RepairConnection("owner@acme.test"); assert.equal(h.claim().ok, true);
    ok(await repairVerificationBrief(f.root, 7, { requestId: f.requestId, role: "verifier", slot: 1 }, h));
    const submit = () => submitRepairVerification(f.root, 7, { requestId: f.requestId, slot: 1,
      results: f.results().map((r) => ({ ...r, sites: [{ site: "src/pay.ts", bug: filed.id }] })) }, h);
    assert.match(String(((await submit()) as { error?: string }).error), /does not carry .*confirmation/);
    assert.equal((await file()).id, filed.id, "the same site is the same bug");
    ok(await submit());
  } finally { f.t.dispose(); }
});

test("K8 through the op: a verified repair on an open pull request is judged against the PR's linked head branch", async () => {
  const f = await fixture(1, false, (evidence, root) => {
    const git = (...a: string[]) => { const r = spawnSync("git", a, { cwd: root, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
    const trunk = git("rev-parse", "--abbrev-ref", "HEAD");
    git("checkout", "-qb", "pr-7-head");
    writeFileSync(join(root, "src", "pay.ts"), "export function transfer(amount) { if (amount < 0) throw new Error('negative'); }\n");
    git("add", "src/pay.ts"); git("-c", "user.email=f@x", "-c", "user.name=f", "commit", "-qm", "fix");
    evidence.fixCommit = git("rev-parse", "HEAD");
    git("checkout", "-q", trunk);
  });
  try {
    await f.run(1); await f.run(2);
    const source = async () => {
      const r = await repairRecords(f.root, 7) as { lifecycles?: { findingId: string; code?: { landing: string; source: string } }[] };
      return r.lifecycles!.find((l) => l.findingId === f.ids[0])!.code!;
    };
    const unlinked = await source();
    assert.equal(unlinked.landing, "open"); assert.equal(unlinked.source, "unknown");
    writeLocalLink(f.root, "7", "pr-7-head");
    assert.equal((await source()).source, "unchanged");
  } finally { f.t.dispose(); }
});

test("D4 and B12: unrelated decisions do not stale a verification, and the capsule freezes blob ids, not diff bytes", async () => {
  // A real fix commit, so the capsule has something touched to freeze.
  const f = await fixture(1, false, (evidence, root) => {
    const git = (...a: string[]) => { const r = spawnSync("git", a, { cwd: root, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
    writeFileSync(join(root, "fixed.txt"), "the guard\n");
    git("add", "fixed.txt"); git("-c", "user.email=f@x", "-c", "user.name=f", "commit", "-qm", "fix");
    evidence.fixCommit = git("rev-parse", "HEAD");
  });
  try {
    await f.run(1); await f.run(2);
    ok(await postRound(f.root, { round: { id: "R-elsewhere", source: "an unrelated question" }, decisions: [{ id: "D-else", round: "R-elsewhere", ref: "D1", kind: "words",
      payload: { question: "D1: what should the release be called?", options: [{ label: "x" }, { label: "y" }] }, options: [{ label: "x", effects: [] }, { label: "y", effects: [] }] }] }));
    const records = await repairVerificationRecords(f.root, 7);
    assert.ok("records" in records && records.records);
    const capsule = records.records.requests[0]!.capsule;
    assert.ok(!("diff" in capsule.code), "no raw diff bytes");
    assert.deepEqual(capsule.code.touched.map((x) => x.path), ["fixed.txt"]);
    assert.ok(capsule.code.touched.every((x) => /^[0-9a-f]{40,64}$/.test(x.before) && /^[0-9a-f]{40,64}$/.test(x.after)), "full blob ids, never abbreviated");
    assert.deepEqual(JSON.parse(capsule.rulingContext), { rulings: [] }, "only the rulings the repair cites");
    ok(await applyRepairVerification(f.root, 7, { requestId: f.requestId, findingId: f.ids[0]!, reason: "two independent inspections" }, f.orchestrator));
    assert.equal((await readFinding(f.root, f.ids[0]!, { pr: 7 }))!.state, "resolved");
  } finally { f.t.dispose(); }
});

test("F36: one MCP connection acts in each universe as that universe's principal", async () => {
  const f = await fixture();
  try {
    // A connection whose PRIMARY universe has another git identity, working in this one.
    const elsewhere = new RepairConnection("someone@other.test");
    assert.equal(elsewhere.claim().ok, true);
    const brief = await repairVerificationBrief(f.root, 7, { requestId: f.requestId, role: "verifier", slot: 1 }, elsewhere);
    ok(brief);
    const run = await submitRepairVerification(f.root, 7, { requestId: f.requestId, slot: 1, results: f.results() }, elsewhere) as { run?: { identity: { principal: string; session: string } } };
    ok(run);
    assert.equal(run.run!.identity.principal, "owner@acme.test", "this universe's principal, not the primary's");
    assert.equal(run.run!.identity.session, elsewhere.session, "the same connection");
  } finally { f.t.dispose(); }
});

test("B5: verification records come from what readCached served, so a missing sidecar degrades instead of throwing", async () => {
  const f = await fixture();
  const pointer = join(f.root, ".codemap", "sidecar");
  const original = (await import("node:fs")).readFileSync(pointer, "utf8");
  try {
    writeFileSync(pointer, join(f.root, "no-such-sidecar"));
    // No projected row, as on a store that never folded this scope: the old separate read threw here.
    (await import("./db.js")).db(f.root).prepare("DELETE FROM repair_verifications").run();
    const records = await repairVerificationRecords(f.root, 7);
    assert.ok("records" in records, JSON.stringify(records));
    assert.notEqual(records.status, "complete");
  } finally { writeFileSync(pointer, original); f.t.dispose(); }
});

/** B10 (F42), pinned at the source: the module needs a DOM, so it cannot be rendered here. */
test("B10: a repair with no sidecar to read is not shown as blocked", async () => {
  const src = (await import("node:fs")).readFileSync("web/repair-presentation.js", "utf8");
  const banner = src.split("\n").find((l) => l.includes("Repair history is blocked"))!;
  assert.ok(banner, "the banner exists");
  assert.doesNotMatch(banner, /unavailable/, "`unavailable` means there is nothing to block, not a blocked scope");
});

test("G8: a subagent's submission is validated before it is held, not when its launcher records it", async () => {
  const f = await fixture();
  try {
    ok(await repairVerificationBrief(f.root, 7, { requestId: f.requestId, role: "verifier", slot: 1 }, f.orchestrator));
    const bad = f.results().map((r) => ({ ...r, grade: "inspection" as const, inspected: [], noCheckReason: undefined }));
    const refused = await submitRepairVerification(f.root, 7, { requestId: f.requestId, slot: 1, results: bad }, f.orchestrator) as { error?: string; held?: boolean };
    assert.match(String(refused.error), /inspection closure needs/);
    assert.equal(refused.held, undefined, "nothing was held for a record that would be rejected");
    const schema = (await import("node:fs")).readFileSync("src/mcp.ts", "utf8");
    assert.match(schema, /results: \{ type: "array", items: repairClaimVerdictSchema \}/, "the tool advertises the item shape");
  } finally { f.t.dispose(); }
});
