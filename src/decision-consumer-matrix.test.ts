import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { team, settle } from "./oracle.js";
import { discard } from "./test-tmp.js";
import { shareFinding, reassignFinding, reportOnFinding, sharedFindings, findingBacklog } from "./ops-shared.js";
import { reportBug, listBugs, bugDetail, updateBug } from "./ops/bugs.js";
import { postRound, answerDirect } from "./ops/decisions.js";
import { requestComparison, comparisonBrief, submitComparisonJudgment, recordComparisonJudgment,
  comparisonDetail, comparisonResolutionBrief, resolveComparison } from "./ops/comparisons.js";
import { decisionsView } from "./ops/decision-holds.js";
import { resolveDecisionIssue } from "./decision-issues.js";
import { universeKey } from "./sidecar-config.js";
import { reviewQueue } from "./ops/annotations.js";

const A = "ana@acme.test", B = "ben@acme.test";
async function identity<T>(principal: string, agent: boolean, action: () => Promise<T>): Promise<T> {
  const priorPrincipal = process.env.CODEMAP_PRINCIPAL;
  const priorModel = process.env.CODEMAP_AGENT_MODEL;
  process.env.CODEMAP_PRINCIPAL = principal;
  if (agent) process.env.CODEMAP_AGENT_MODEL = "consumer-matrix";
  else delete process.env.CODEMAP_AGENT_MODEL;
  try { return await action(); } finally {
    if (priorPrincipal === undefined) delete process.env.CODEMAP_PRINCIPAL; else process.env.CODEMAP_PRINCIPAL = priorPrincipal;
    if (priorModel === undefined) delete process.env.CODEMAP_AGENT_MODEL; else process.env.CODEMAP_AGENT_MODEL = priorModel;
  }
}
const required = (result: any) => assert.equal(result?.ok, true, JSON.stringify(result));
const optionDecision = (id: string, ref: string, target: string, effects: any[], other: any[], question: string) => ({
  id, round: "R1", ref, kind: "options" as const,
  payload: { question: `${ref}: ${question} ${target}?`, options: [
    { label: "Fix", description: "Repair the code" }, { label: "Reject", description: "The premise is false" },
  ] },
  options: [{ label: "Fix", effects }, { label: "Reject", effects: other }],
});
function readerTranscript(dir: string, prompt: string, request: string, verdict: string, rationale: string, receipt: string, n: number) {
  const agentId = `aCOMPARE${String(n).padStart(8, "0")}`;
  const session = `5e55a0a0-0000-0000-0000-${String(n).padStart(12, "0")}`;
  const launch = `toolu_launch_${n}`, call = `toolu_submit_${n}`;
  const sub = join(dir, session, "subagents");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "general-purpose", toolUseId: launch }));
  writeFileSync(join(sub, `agent-${agentId}.jsonl`), [
    { type: "user", isSidechain: true, agentId, sessionId: session, message: { role: "user", content: prompt } },
    { type: "assistant", isSidechain: true, agentId, sessionId: session, timestamp: new Date().toISOString(),
      message: { content: [{ type: "tool_use", id: call, name: "mcp__codemap__submit_comparison_judgment",
        input: { request, verdict, rationale } }] } },
    { type: "user", isSidechain: true, agentId, sessionId: session,
      message: { content: [{ type: "tool_result", tool_use_id: call,
        content: JSON.stringify({ ok: true, held: true, receipt }) }] } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  writeFileSync(join(dir, `${session}.jsonl`), [
    { type: "assistant", isSidechain: false, timestamp: new Date().toISOString(),
      message: { content: [{ type: "tool_use", id: launch, name: "Agent",
        input: { description: "compare", prompt, subagent_type: "general-purpose" } }] } },
    { type: "user", isSidechain: false, message: { content: [{ type: "tool_result", tool_use_id: launch, content: "launched" }] },
      toolUseResult: { agentId } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
}
async function judge(root: string, dir: string, answers: [string, string], issue: any,
  verdict: "equivalent" | "incompatible", n: number) {
  return identity("independent-reader@acme.test", true, async () => {
    const requested = await requestComparison(root, { answers, issues: [issue] }) as any;
    required(requested);
    const brief = await comparisonBrief(root, requested.id) as any;
    required(brief);
    const frozen = JSON.parse(brief.prompt);
    assert.equal(frozen.purpose, "pair-comparison");
    assert.deepEqual(frozen.request.issues, [issue]);
    for (const source of [frozen.request.left, frozen.request.right]) {
      assert.ok(source.answerId && source.version && source.questionId && source.questionVersion);
      assert.ok(source.display.prompt.includes(issue.id));
      assert.ok(source.display.options.some((option: any) => option.displayed?.description));
      assert.ok(source.words);
    }
    const rationale = verdict === "equivalent"
      ? "Both answers authorize the same repair for this exact issue."
      : "One answer rejects the claim and the other calls for a repair.";
    const held = await submitComparisonJudgment(root, { request: requested.id, verdict, rationale }) as any;
    assert.equal(held.held, true, JSON.stringify(held));
    readerTranscript(dir, brief.prompt, requested.id, verdict, rationale, held.receipt, n);
    const recorded = await recordComparisonJudgment(root, { request: requested.id }, {}, dir) as any;
    assert.equal(recorded.recorded, true, JSON.stringify(recorded));
    return requested.id as string;
  });
}
const hasComparisonHold = (mark: any) => Array.isArray(mark.held) && mark.held.some((h: any) => h.why === "comparison");
const backlogRow = (backlog: any, id: string): any => Object.values(backlog)
  .flatMap((value: any) => Array.isArray(value) ? value : []).find((row: any) => row.id === id);

test("two clones agree on comparison restrictions across finding and bug work consumers", async () => {
  const t = await team([A, B]);
  const tx = mkdtempSync(join(tmpdir(), "codemap-consumer-matrix-tx-"));
  const [ana, ben] = t.all;
  try {
    const filed = await identity(A, true, () => shareFinding(ana!.repo, 7,
      { targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "transfer validation needs repair" })) as any;
    required(filed);
    const ordinary = await identity(A, true, () => shareFinding(ana!.repo, 7,
      { targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "a separate hold remains open" })) as any;
    required(ordinary);
    const unaffected = await identity(A, true, () => shareFinding(ana!.repo, 7,
      { targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "unrelated assigned work" })) as any;
    required(unaffected);
    const bug = await identity(A, true, () => reportBug(ana!.repo,
      { title: "transfer bug", description: "transfer validates the wrong amount", anchors: ["src/pay.ts#transfer"] })) as any;
    required(bug);
    const otherBug = await identity(A, true, () => reportBug(ana!.repo,
      { title: "refund bug", description: "refund applies the wrong sign", anchors: ["src/pay.ts#refund"] })) as any;
    required(otherBug);
    required(await identity(A, false, () => reassignFinding(ana!.repo, 7, filed.id, { kind: "fix" })));
    required(await identity(A, false, () => reassignFinding(ana!.repo, 7, unaffected.id, { kind: "fix" })));
    const f = await resolveDecisionIssue(ana!.repo, { kind: "finding", universe: universeKey(ana!.repo), review: 7, id: filed.id });
    const b = await resolveDecisionIssue(ana!.repo, { kind: "bug", universe: universeKey(ana!.repo), id: bug.id });
    assert.equal(f.ok, true, JSON.stringify(f)); assert.equal(b.ok, true, JSON.stringify(b));
    if (!f.ok || !b.ok) return;
    const findFix = [{ findings: [], issues: [f.ref], on: "unblock" as const }];
    const findReject = [{ findings: [], issues: [f.ref], on: "settle" as const, as: "refuted" as const }];
    const bugFix = [{ findings: [], issues: [b.ref], on: "unblock" as const }];
    const bugReject = [{ findings: [], issues: [b.ref], on: "settle" as const, as: "refuted" as const }];
    const decisions = [
      optionDecision("find-a", "D1", filed.id, findFix, findReject, "Repair validation for"),
      optionDecision("find-b", "D2", filed.id, findFix, findReject, "Fix the validation defect in"),
      optionDecision("bug-a", "D3", bug.id, bugFix, bugReject, "Is the premise of"),
      optionDecision("bug-b", "D4", bug.id, bugFix, bugReject, "Should the code for"),
      { id: "ordinary", round: "R1", ref: "D5", kind: "options" as const,
        payload: { question: `D5: should ${ordinary.id} be fixed?`, options: [{ label: "Fix" }, { label: "Reject" }] },
        options: [{ label: "Fix", effects: [{ findings: [ordinary.id], on: "unblock" as const }] },
          { label: "Reject", effects: [{ findings: [ordinary.id], on: "settle" as const, as: "refuted" as const }] }] },
    ];
    required(await identity(A, true, () => postRound(ana!.repo,
      { round: { id: "R1", source: "consumer-matrix" }, decisions })));
    await settle(t);

    const af = await identity(A, false, () => answerDirect(ana!.repo, { decision: "find-a", option: "Fix" })) as any;
    const ab = await identity(A, false, () => answerDirect(ana!.repo, { decision: "bug-a", option: "Reject" })) as any;
    const bf = await identity(B, false, () => answerDirect(ben!.repo, { decision: "find-b", option: "Fix" })) as any;
    const bb = await identity(B, false, () => answerDirect(ben!.repo, { decision: "bug-b", option: "Fix" })) as any;
    for (const result of [af, ab, bf, bb]) assert.equal(result.recorded, true, JSON.stringify(result));
    await settle(t);
    const findingAnswers: [string, string] = [af.answer, bf.answer];
    const bugAnswers: [string, string] = [ab.answer, bb.answer];
    for (const m of [ana!, ben!]) {
      const view = await decisionsView(m.repo);
      const ff = await resolveDecisionIssue(m.repo, { kind: "finding", universe: universeKey(m.repo), review: 7, id: filed.id });
      const bbRef = await resolveDecisionIssue(m.repo, { kind: "bug", universe: universeKey(m.repo), id: bug.id });
      assert.equal(ff.ok, true); assert.equal(bbRef.ok, true);
      if (!ff.ok || !bbRef.ok) continue;
      assert.equal(hasComparisonHold(view.issueMark(ff.ref)), true);
      assert.equal(hasComparisonHold(view.issueMark(bbRef.ref)), true);
      assert.equal(view.issueWork(ff.ref).allowed, false);
      assert.equal(view.issueWork(bbRef.ref).allowed, false);
      const queue = await reviewQueue(m.repo);
      assert.ok(!queue.queue.some((row) => row.id === filed.id));
      assert.ok(queue.queue.some((row) => row.id === unaffected.id));
      const findings = await sharedFindings(m.repo, 7) as any;
      assert.equal(hasComparisonHold(findings.findings.find((row: any) => row.id === filed.id)), true);
      const backlog = await findingBacklog(m.repo) as any;
      assert.equal(backlogRow(backlog, filed.id)?.work?.allowed, false);
      const bugs = await listBugs(m.repo, { open: true }) as any;
      assert.ok(!bugs.bugs.some((row: any) => row.id === bug.id));
      assert.ok(bugs.bugs.some((row: any) => row.id === otherBug.id));
      assert.equal((await bugDetail(m.repo, bug.id) as any).decisionWork.allowed, false);
      assert.ok((await reportOnFinding(m.repo, 7, filed.id, "fixed", "Would repair", ["src/pay.ts"]) as any).error);
      assert.ok((await updateBug(m.repo, { id: bug.id, state: "resolved", reason: "Would close" }) as any).error);
    }

    // A later human assignment cannot override the unresolved semantic comparison.
    required(await identity(A, false, () => reassignFinding(ana!.repo, 7, filed.id, { kind: "fix" })));
    assert.ok(!(await reviewQueue(ana!.repo)).queue.some((row) => row.id === filed.id));
    const findingComparison = await judge(ana!.repo, tx, findingAnswers, f.ref, "equivalent", 1);
    await settle(t);
    for (const m of [ana!, ben!]) {
      const view = await decisionsView(m.repo);
      assert.equal((await comparisonDetail(m.repo, findingComparison) as any).comparison.projection.restrictsWork, false);
      assert.equal(hasComparisonHold(view.issueMark(f.ref)), false);
      assert.equal(view.issueWork(f.ref).allowed, true);
      assert.equal(view.work(ordinary.id).allowed, false, "unrelated ordinary hold survives equivalence");
      assert.ok((await reviewQueue(m.repo)).queue.some((row) => row.id === filed.id));
      assert.equal(backlogRow(await findingBacklog(m.repo), filed.id)?.work?.allowed, true);
      assert.equal((await bugDetail(m.repo, bug.id) as any).decisionWork.allowed, false);
    }

    const bugComparison = await judge(ana!.repo, tx, bugAnswers, b.ref, "incompatible", 2);
    await settle(t);
    for (const m of [ana!, ben!]) {
      const detail = await comparisonDetail(m.repo, bugComparison) as any;
      assert.equal(detail.comparison.projection.state, "incompatible");
      assert.equal((await bugDetail(m.repo, bug.id) as any).decisionWork.allowed, false);
    }
    const shown = await comparisonResolutionBrief(ana!.repo, bugComparison) as any;
    required(shown);
    required(await identity("resolver@acme.test", false, () => resolveComparison(ana!.repo, {
      request: bugComparison, preserve: bb.answer, rationale: "Keep the repair after reading both complete answers.",
      shownHash: shown.shownHash, executionsHash: shown.executionsHash, source: "web",
    })));
    await settle(t);
    for (const m of [ana!, ben!]) {
      const detail = await bugDetail(m.repo, bug.id) as any;
      assert.equal(detail.decisionWork.allowed, true, JSON.stringify(detail.decisionWork));
      assert.ok((await listBugs(m.repo, { open: true }) as any).bugs.some((row: any) => row.id === bug.id));
      assert.equal((await decisionsView(m.repo)).work(ordinary.id).allowed, false);
    }
    required(await identity(A, true, () => reportOnFinding(ana!.repo, 7, filed.id, "fixed", "Repaired validation", ["src/pay.ts"])));
    required(await identity(A, false, () => updateBug(ana!.repo, { id: bug.id, state: "resolved", reason: "Repaired the bug" })));
    await settle(t);
    for (const m of [ana!, ben!]) {
      const finding = (await sharedFindings(m.repo, 7) as any).findings.find((row: any) => row.id === filed.id);
      assert.equal(finding?.outcome?.result, "fixed");
      assert.equal((await bugDetail(m.repo, bug.id) as any).state, "resolved");
      assert.equal((await decisionsView(m.repo)).work(ordinary.id).allowed, false);
    }
  } finally { t.dispose(); discard(tx); }
});
