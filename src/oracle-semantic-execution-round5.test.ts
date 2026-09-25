/** Plan §9 E and conflict-after-execution through real ops and verified readers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { team, settle } from "./oracle.js";
import { Ledger, checkSettled } from "./oracle-properties.js";
import { shareFinding } from "./ops-shared.js";
import { postRound, answerDirect } from "./ops/decisions.js";
import { requestComparison, comparisonBrief, submitComparisonJudgment, recordComparisonJudgment,
  comparisonDetail, comparisonResolutionBrief, resolveComparison } from "./ops/comparisons.js";
import { applicationReaderBrief, submitApplicationVerdict, recordApplicationVerdict, applyRuling } from "./ops/ruling-application.js";
import { readFinding } from "./store.js";
import { universeKey } from "./sidecar-config.js";
import { discard } from "./test-tmp.js";

const A = "alice@acme.test", B = "bob@acme.test";
const as = async (principal: string, agent: boolean, action: () => Promise<void>) => {
  const oldPrincipal = process.env.CODEMAP_PRINCIPAL, oldModel = process.env.CODEMAP_AGENT_MODEL;
  process.env.CODEMAP_PRINCIPAL = principal;
  if (agent) process.env.CODEMAP_AGENT_MODEL = "semantic-oracle"; else delete process.env.CODEMAP_AGENT_MODEL;
  try { await action(); } finally {
    if (oldPrincipal === undefined) delete process.env.CODEMAP_PRINCIPAL; else process.env.CODEMAP_PRINCIPAL = oldPrincipal;
    if (oldModel === undefined) delete process.env.CODEMAP_AGENT_MODEL; else process.env.CODEMAP_AGENT_MODEL = oldModel;
  }
};
async function fixture() {
  const t = await team([A, B]);
  const tx = mkdtempSync(join(tmpdir(), "codemap-semantic-execution-tx-"));
  const ledger = new Ledger();
  let finding = "";
  await as(A, true, async () => {
    const result = await shareFinding(t.all[0]!.repo, 7, {
      targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "transfer doubles a charge",
    }) as any;
    assert.ok(result.id, JSON.stringify(result)); finding = result.id;
  });
  await settle(t); await checkSettled(t, ledger);
  return { t, tx, ledger, finding, cleanup: () => { t.dispose(); discard(tx); } };
}

function transcript(dir: string, prompt: string, tool: "submit_comparison_judgment" | "submit_application_verdict",
  input: Record<string, unknown>, receipt: string, slot: number) {
  const agentId = `aSEMANTIC${String(slot).padStart(7, "0")}`;
  const session = `5e55a0a0-0000-0000-0000-${String(slot).padStart(12, "0")}`;
  const launch = `toolu_launch_${slot}`, call = `toolu_submit_${slot}`;
  const sub = join(dir, session, "subagents"); mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "general-purpose", toolUseId: launch }));
  writeFileSync(join(sub, `agent-${agentId}.jsonl`), [
    { type: "user", isSidechain: true, agentId, sessionId: session, message: { role: "user", content: prompt } },
    { type: "assistant", isSidechain: true, agentId, sessionId: session, timestamp: new Date().toISOString(),
      message: { content: [{ type: "tool_use", id: call, name: `mcp__codemap__${tool}`, input }] } },
    { type: "user", isSidechain: true, agentId, sessionId: session, message: { content: [
      { type: "tool_result", tool_use_id: call, content: JSON.stringify({ ok: true, held: true, receipt }) },
    ] } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  writeFileSync(join(dir, `${session}.jsonl`), [
    { type: "assistant", isSidechain: false, timestamp: new Date().toISOString(), message: { content: [
      { type: "tool_use", id: launch, name: "Agent", input: { prompt, subagent_type: "general-purpose" } },
    ] } },
    { type: "user", isSidechain: false, message: { content: [
      { type: "tool_result", tool_use_id: launch, content: "launched" },
    ] }, toolUseResult: { agentId } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return { requestId: String(input.requestId), receipt, agentId, callId: call };
}

async function compare(u: Awaited<ReturnType<typeof fixture>>, answers: [string, string],
  verdict: "incompatible" | "equivalent", slot = 1) {
  const root = u.t.all[0]!.repo;
  let id = "", prompt = "";
  await as("independent-reader@acme.test", true, async () => {
    const requested = await requestComparison(root, { answers }) as any;
    assert.equal(requested.ok, true, JSON.stringify(requested)); id = requested.id;
    const brief = await comparisonBrief(root, id) as any;
    assert.equal(brief.ok, true, JSON.stringify(brief)); prompt = brief.prompt;
    const rationale = verdict === "equivalent"
      ? "Despite different words, both authorize the same correction in this scope."
      : "The same Yes label refers to incompatible read-only and write-through policies.";
    const held = await submitComparisonJudgment(root, { request: id, verdict, rationale }) as any;
    assert.equal(held.held, true, JSON.stringify(held));
    transcript(u.tx, prompt, "submit_comparison_judgment", { request: id, verdict, rationale }, held.receipt, slot);
    const recorded = await recordComparisonJudgment(root, { request: id }, {}, u.tx) as any;
    assert.equal(recorded.recorded, true, JSON.stringify(recorded));
  });
  await settle(u.t); await checkSettled(u.t, u.ledger);
  return { id, prompt };
}

test("a prior invalidity application is shown with exact receipts when a later conflict needs resolution", async () => {
  const u = await fixture();
  try {
    const [a, b] = u.t.all;
    const d = { id: "d1", round: "R1", ref: "D1", kind: "options" as const,
      payload: { question: `D1: is ${u.finding} a real defect?`, options: [
        { label: "Reject", description: "The behavior is intended" },
        { label: "Fix", description: "Repair the behavior" },
      ] },
      options: [{ label: "Reject", effects: [{ findings: [u.finding], on: "settle" as const, as: "refuted" as const }] },
        { label: "Fix", effects: [{ findings: [u.finding], on: "unblock" as const }] }],
    };
    await as(A, true, async () => {
      const posted = await postRound(a!.repo, { round: { id: "R1", source: "execution oracle" }, decisions: [d] }) as any;
      assert.equal(posted.ok, true, JSON.stringify(posted));
    });
    await settle(u.t); await checkSettled(u.t, u.ledger);
    let first = "", second = "", execution = "", readerReceipt = "";
    await as(A, false, async () => {
      const result = await answerDirect(a!.repo, { decision: "d1", option: "Reject" }) as any;
      assert.equal(result.recorded, true, JSON.stringify(result)); first = result.answer;
    });
    const issue = { kind: "finding" as const, universe: universeKey(a!.repo), review: 7, id: u.finding };
    await as("application-agent", true, async () => {
      const brief = await applicationReaderBrief(a!.repo, { issue, answerId: first, slot: 1 }, u.tx) as any;
      assert.equal(brief.ok, true, JSON.stringify(brief));
      const rationale = "The human ruling defeats the premise of this exact finding.";
      const held = submitApplicationVerdict(a!.repo, { requestId: brief.requestId, verdict: "sound", rationale }) as any;
      assert.equal(held.held, true, JSON.stringify(held)); readerReceipt = held.receipt;
      const ref = transcript(u.tx, brief.prompt, "submit_application_verdict",
        { requestId: brief.requestId, verdict: "sound", rationale }, held.receipt, 11);
      assert.equal((recordApplicationVerdict(a!.repo, ref, u.tx) as any).recorded, true);
      const applied = await applyRuling(a!.repo, { issue, answerId: first, readers: [ref] }, u.tx) as any;
      assert.equal(applied.ok, true, JSON.stringify(applied)); execution = applied.application;
    });
    await settle(u.t); await checkSettled(u.t, u.ledger);
    for (const member of u.t.all) assert.equal((await readFinding(member.repo, u.finding))?.state, "invalid");
    await as(B, false, async () => {
      const result = await answerDirect(b!.repo, { decision: "d1", option: "Fix" }) as any;
      assert.equal(result.recorded, true, JSON.stringify(result)); second = result.answer;
    });
    await settle(u.t); await checkSettled(u.t, u.ledger);
    const compared = await compare(u, [first, second], "incompatible", 12);
    for (const member of u.t.all) {
      const brief = await comparisonResolutionBrief(member.repo, compared.id) as any;
      assert.equal(brief.ok, true, JSON.stringify(brief));
      const application = brief.shown.executions.find((entry: any) => entry.eventId === execution);
      assert.ok(application, "the exact completed closure must be shown to the resolver");
      assert.equal(application.capsule.issue.ref.id, u.finding);
      assert.equal(application.capsule.ruling.answerId, first);
      assert.equal(application.capsule.evidence.readers[0].id, readerReceipt);
      assert.equal((await readFinding(member.repo, u.finding))?.state, "invalid",
        "discovering disagreement cannot reopen an executed closure");
    }
    const humanBrief = await comparisonResolutionBrief(a!.repo, compared.id) as any;
    await as("resolver@acme.test", false, async () => {
      const resolved = await resolveComparison(a!.repo, { request: compared.id, preserve: second,
        rationale: "I saw the prior closure and choose the repair intent for future work.",
        shownHash: humanBrief.shownHash, executionsHash: humanBrief.executionsHash, source: "web" }) as any;
      assert.equal(resolved.ok, true, JSON.stringify(resolved));
    });
    await settle(u.t); await checkSettled(u.t, u.ledger);
    for (const member of u.t.all) {
      assert.equal((await readFinding(member.repo, u.finding))?.state, "invalid");
      assert.equal((await comparisonDetail(member.repo, compared.id) as any).comparison.projection.preservedAnswer, second);
    }
  } finally { u.cleanup(); }
});

test("equal-looking qualified Yes remains incompatible; different words can be reader-equivalent", async () => {
  for (const mode of ["qualified", "different"] as const) {
    const u = await fixture();
    try {
      const [a, b] = u.t.all;
      const yes = [{ findings: [u.finding], on: "unblock" as const }];
      const questions = mode === "qualified" ? [
        { id: "read-only", ref: "D1", question: `D1: For read-only cache mode, should ${u.finding} be repaired?`,
          label: "Yes", description: "Preserve only read cache; write path must bypass cache" },
        { id: "write-through", ref: "D2", question: `D2: For write-through cache mode, should ${u.finding} be repaired?`,
          label: "Yes", description: "Preserve write cache and mutate it on every write" },
      ] : [
        { id: "repair", ref: "D1", question: `D1: Should ${u.finding} be repaired?`,
          label: "Repair", description: "Correct the transfer rounding defect" },
        { id: "correct", ref: "D2", question: `D2: Should ${u.finding} be corrected?`,
          label: "Correct", description: "Fix the same transfer rounding defect" },
      ];
      await as(A, true, async () => {
        const decisions = questions.map((q) => ({ id: q.id, round: "R1", ref: q.ref, kind: "options" as const,
          payload: { question: q.question, options: [{ label: q.label, description: q.description },
            { label: "No", description: "Leave this issue open" }] },
          options: [{ label: q.label, effects: yes }, { label: "No", effects: [] }] }));
        const posted = await postRound(a!.repo, { round: { id: "R1", source: "semantic oracle" }, decisions }) as any;
        assert.equal(posted.ok, true, JSON.stringify(posted));
      });
      await settle(u.t); await checkSettled(u.t, u.ledger);
      let first = "", second = "";
      await as(A, false, async () => {
        const result = await answerDirect(a!.repo, { decision: questions[0]!.id, option: questions[0]!.label }) as any;
        assert.equal(result.recorded, true, JSON.stringify(result)); first = result.answer;
      });
      await as(B, false, async () => {
        const result = await answerDirect(b!.repo, { decision: questions[1]!.id, option: questions[1]!.label }) as any;
        assert.equal(result.recorded, true, JSON.stringify(result)); second = result.answer;
      });
      await settle(u.t); await checkSettled(u.t, u.ledger);
      const requested = await requestComparison(a!.repo, { answers: [first, second] }) as any;
      assert.equal(requested.ok, true, JSON.stringify(requested));
      const pending = await comparisonDetail(a!.repo, requested.id) as any;
      assert.equal(pending.comparison.projection.state, "pending");
      assert.equal(pending.comparison.projection.restrictsWork, true);
      const compared = await compare(u, [first, second], mode === "qualified" ? "incompatible" : "equivalent");
      const prompt = JSON.parse(compared.prompt);
      assert.ok(prompt.request.left.display.prompt.includes(mode === "qualified" ? "cache mode" : "repaired"));
      assert.ok(prompt.request.right.display.prompt.includes(mode === "qualified" ? "cache mode" : "corrected"));
      assert.ok(prompt.request.left.display.options.some((option: any) => option.displayed?.description));
      assert.ok(prompt.request.right.display.options.some((option: any) => option.displayed?.description));
      for (const member of u.t.all) {
        const detail = await comparisonDetail(member.repo, compared.id) as any;
        assert.equal(detail.comparison.projection.state, mode === "qualified" ? "incompatible" : "equivalent");
        assert.equal(detail.comparison.projection.restrictsWork, mode === "qualified");
      }
    } finally { u.cleanup(); }
  }
});
