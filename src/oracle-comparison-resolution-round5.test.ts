/** Plan §9 D/H: comparison authority across actual sidecar syncs. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { team, settle } from "./oracle.js";
import { Ledger, checkSettled } from "./oracle-properties.js";
import { shareFinding } from "./ops-shared.js";
import { postRound, answerDirect, decisionRounds } from "./ops/decisions.js";
import { requestComparison, comparisonBrief, submitComparisonJudgment, recordComparisonJudgment,
  comparisonDetail, comparisonResolutionBrief, resolveComparison } from "./ops/comparisons.js";
import { decisionsView } from "./ops/decision-holds.js";
import { discard } from "./test-tmp.js";

type Team = Awaited<ReturnType<typeof team>>;
const actor = async (principal: string, agent: boolean, work: () => Promise<void>) => {
  const oldPrincipal = process.env.CODEMAP_PRINCIPAL, oldModel = process.env.CODEMAP_AGENT_MODEL;
  process.env.CODEMAP_PRINCIPAL = principal;
  if (agent) process.env.CODEMAP_AGENT_MODEL = "test-reader"; else delete process.env.CODEMAP_AGENT_MODEL;
  try { await work(); } finally {
    if (oldPrincipal === undefined) delete process.env.CODEMAP_PRINCIPAL; else process.env.CODEMAP_PRINCIPAL = oldPrincipal;
    if (oldModel === undefined) delete process.env.CODEMAP_AGENT_MODEL; else process.env.CODEMAP_AGENT_MODEL = oldModel;
  }
};
const alice = "alice@acme.test", bob = "bob@acme.test", carol = "carol@acme.test";

async function fixture() {
  const t = await team([alice, bob]);
  const transcripts = mkdtempSync(join(tmpdir(), "codemap-comparison-oracle-tx-"));
  const ledger = new Ledger();
  const [a, b] = t.all;
  let finding = "", aliceAnswer = "", bobAnswer = "";
  await actor(alice, true, async () => {
    const filed = await shareFinding(a!.repo, 7, {
      targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "transfer doubles the charge",
    }) as any;
    assert.ok(filed.id, JSON.stringify(filed));
    finding = filed.id;
  });
  await settle(t); await checkSettled(t, ledger);
  await actor(alice, true, async () => {
    const posted = await postRound(a!.repo, { round: { id: "R1", source: "resolution oracle" }, decisions: [{
      id: "d1", round: "R1", ref: "D1", kind: "options",
      payload: { question: `D1: Is ${finding} invalid?`, options: [
        { label: "Reject", description: "The behavior is intended" },
        { label: "Fix", description: "The behavior needs repair" },
      ] },
      options: [
        { label: "Reject", effects: [{ findings: [finding], on: "settle", as: "refuted" }] },
        { label: "Fix", effects: [{ findings: [finding], on: "unblock" }] },
      ],
    }] }) as any;
    assert.equal(posted.ok, true, JSON.stringify(posted));
  });
  await settle(t); await checkSettled(t, ledger);
  await actor(alice, false, async () => {
    const answer = await answerDirect(a!.repo, { decision: "d1", option: "Reject" }) as any;
    assert.equal(answer.recorded, true, JSON.stringify(answer)); aliceAnswer = answer.answer;
  });
  await actor(bob, false, async () => {
    const answer = await answerDirect(b!.repo, { decision: "d1", option: "Fix" }) as any;
    assert.equal(answer.recorded, true, JSON.stringify(answer)); bobAnswer = answer.answer;
  });
  await settle(t); await checkSettled(t, ledger);
  return { t, transcripts, ledger, finding, aliceAnswer, bobAnswer,
    cleanup: () => { t.dispose(); discard(transcripts); } };
}

function readerTranscript(dir: string, prompt: string, request: string, verdict: string, rationale: string, receipt: string) {
  const agentId = "aCOMPARED12345678", session = "5e55a0a0-0000-0000-0000-000000000011";
  const launch = "toolu_launch", call = "toolu_submit";
  const sub = join(dir, session, "subagents"); mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "general-purpose", toolUseId: launch }));
  writeFileSync(join(sub, `agent-${agentId}.jsonl`), [
    { type: "user", uuid: "s1", isSidechain: true, agentId, sessionId: session, message: { role: "user", content: prompt } },
    { type: "assistant", uuid: "s2", isSidechain: true, agentId, sessionId: session, timestamp: new Date().toISOString(),
      message: { content: [{ type: "tool_use", id: call, name: "mcp__codemap__submit_comparison_judgment",
        input: { request, verdict, rationale } }] } },
    { type: "user", uuid: "s3", isSidechain: true, agentId, sessionId: session,
      message: { content: [{ type: "tool_result", tool_use_id: call,
        content: JSON.stringify({ ok: true, held: true, receipt }) }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  writeFileSync(join(dir, `${session}.jsonl`), [
    { type: "assistant", uuid: "p1", isSidechain: false, timestamp: new Date().toISOString(),
      message: { content: [{ type: "tool_use", id: launch, name: "Agent",
        input: { description: "compare", prompt, subagent_type: "general-purpose" } }] } },
    { type: "user", uuid: "p2", isSidechain: false,
      message: { content: [{ type: "tool_result", tool_use_id: launch, content: "launched" }] },
      toolUseResult: { agentId } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

async function incompatible(u: Awaited<ReturnType<typeof fixture>>) {
  const root = u.t.all[0]!.repo;
  let id = "";
  await actor("independent-reader", true, async () => {
    const request = await requestComparison(root, { answers: [u.aliceAnswer, u.bobAnswer] }) as any;
    assert.equal(request.ok, true, JSON.stringify(request)); id = request.id;
    const brief = await comparisonBrief(root, id) as any;
    assert.equal(brief.ok, true, JSON.stringify(brief));
    assert.match(brief.prompt, /The behavior is intended/);
    assert.match(brief.prompt, /The behavior needs repair/);
    const rationale = "The two complete rulings require opposite treatment of the charge.";
    const held = await submitComparisonJudgment(root, { request: id,
      verdict: "incompatible", rationale }) as any;
    assert.equal(held.held, true, JSON.stringify(held));
    readerTranscript(u.transcripts, brief.prompt, id, "incompatible", rationale, held.receipt);
    const recorded = await recordComparisonJudgment(root, { request: id }, {}, u.transcripts) as any;
    assert.equal(recorded.recorded, true, JSON.stringify(recorded));
  });
  await settle(u.t); await checkSettled(u.t, u.ledger);
  for (const member of u.t.all) {
    const detail = await comparisonDetail(member.repo, id) as any;
    assert.equal(detail.comparison.projection.state, "incompatible");
  }
  return id;
}

async function resolve(root: string, id: string, principal: string, preserve: string,
  revises?: { id: string; preserve: string; receipt: string }) {
  let result: any;
  await actor(principal, false, async () => {
    const brief = await comparisonResolutionBrief(root, id) as any;
    assert.equal(brief.ok, true, JSON.stringify(brief));
    result = await resolveComparison(root, { request: id, preserve,
      rationale: revises ? "I have reviewed my earlier resolution and correct it." : "I have reviewed both complete alternatives.",
      shownHash: brief.shownHash, executionsHash: brief.executionsHash, source: "web",
      ...(revises ? { revises: revises.id, shownResolution: revises } : {}),
    }) as any;
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

test("two clones converge on an informed correction; an unseen Carol is compared against the new frontier", async () => {
  const u = await fixture();
  try {
    const [a, b] = u.t.all;
    const id = await incompatible(u);
    const initial = await resolve(a!.repo, id, alice, u.aliceAnswer);
    await settle(u.t); await checkSettled(u.t, u.ledger);
    const first = (await comparisonDetail(a!.repo, id) as any).comparison.projection.acceptedResolutions
      .find((entry: any) => entry.id === initial.event);
    assert.ok(first?.human?.receipt, "the correction must name the original human receipt");
    await resolve(a!.repo, id, alice, u.bobAnswer,
      { id: initial.event, preserve: u.aliceAnswer, receipt: first.human.receipt });
    await settle(u.t); await checkSettled(u.t, u.ledger);
    for (const member of u.t.all) {
      const detail = await comparisonDetail(member.repo, id) as any;
      assert.equal(detail.comparison.projection.state, "resolved");
      assert.equal(detail.comparison.projection.preservedAnswer, u.bobAnswer);
      assert.equal(detail.comparison.projection.acceptedResolutions.length, 2);
      const view = await decisionsView(member.repo);
      const d = view.s.decisions.find((entry) => entry.id === "d1")!;
      assert.equal((d.answers.find((answer) => answer.id === u.aliceAnswer)?.comparisonLostOn?.length ?? 0) > 0, true);
      assert.equal(d.answers.find((answer) => answer.id === u.bobAnswer)?.comparisonLostOn?.length ?? 0, 0);
    }
    let carolAnswer = "";
    await actor(carol, false, async () => {
      const answer = await answerDirect(b!.repo, { decision: "d1", option: "Fix" }) as any;
      assert.equal(answer.recorded, true, JSON.stringify(answer)); carolAnswer = answer.answer;
    });
    await settle(u.t); await checkSettled(u.t, u.ledger);
    for (const member of u.t.all) {
      const view = await decisionRounds(member.repo) as any;
      assert.ok(view.intentCandidates.some((candidate: any) => candidate.answers.includes(u.bobAnswer)
        && candidate.answers.includes(carolAnswer)), "unseen Carol still needs semantic comparison");
      assert.ok(!view.intentCandidates.some((candidate: any) => candidate.answers.includes(u.aliceAnswer)),
        "the historical losing answer must not resurrect against Carol");
      assert.equal((await comparisonDetail(member.repo, id) as any).comparison.projection.preservedAnswer, u.bobAnswer);
    }
  } finally { u.cleanup(); }
});

test("concurrent contrary human resolutions remain disputed after sidecar sync", async () => {
  const u = await fixture();
  try {
    const [a, b] = u.t.all;
    const id = await incompatible(u);
    const first = await resolve(a!.repo, id, alice, u.aliceAnswer);
    const second = await resolve(b!.repo, id, bob, u.bobAnswer);
    assert.notEqual(first.event, second.event);
    await settle(u.t); await checkSettled(u.t, u.ledger);
    for (const member of u.t.all) {
      const detail = await comparisonDetail(member.repo, id) as any;
      assert.equal(detail.comparison.projection.state, "disputed");
      assert.equal(detail.comparison.projection.preservedAnswer, undefined);
      assert.equal(detail.comparison.projection.acceptedResolutions.length, 2);
      assert.equal(detail.comparison.projection.restrictsWork, true);
      assert.equal((await decisionsView(member.repo)).work(u.finding).allowed, false);
    }
  } finally { u.cleanup(); }
});
