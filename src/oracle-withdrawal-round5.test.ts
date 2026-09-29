/** Plan §9 withdrawal races through real ops and two sidecar clones. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { team, settle } from "./oracle.js";
import { Ledger, checkAlways, checkSettled } from "./oracle-properties.js";
import { shareFinding } from "./ops-shared.js";
import { postRound, answerDirect, withdrawDecision, readerBrief, submitVerdict,
  recordReading, confirmReading, decisionRound } from "./ops/decisions.js";
import { decisionsView } from "./ops/decision-holds.js";
import { discard } from "./test-tmp.js";
import { readFinding } from "./store.js";
import { universeKey } from "./sidecar-config.js";
import { applicationReaderBrief, submitApplicationVerdict, recordApplicationVerdict, applyRuling } from "./ops/ruling-application.js";

const alice = "alice@acme.test", bob = "bob@acme.test";
const actor = async (principal: string, agent: boolean, work: () => Promise<void>) => {
  const oldPrincipal = process.env.CODEMAP_PRINCIPAL, oldModel = process.env.CODEMAP_AGENT_MODEL;
  process.env.CODEMAP_PRINCIPAL = principal;
  if (agent) process.env.CODEMAP_AGENT_MODEL = "test-reader"; else delete process.env.CODEMAP_AGENT_MODEL;
  try { await work(); } finally {
    if (oldPrincipal === undefined) delete process.env.CODEMAP_PRINCIPAL; else process.env.CODEMAP_PRINCIPAL = oldPrincipal;
    if (oldModel === undefined) delete process.env.CODEMAP_AGENT_MODEL; else process.env.CODEMAP_AGENT_MODEL = oldModel;
  }
};
const heldBy = async (root: string, finding: string) => {
  const held = (await decisionsView(root)).mark(finding).held;
  return Array.isArray(held) ? held : [];
};

async function fixture(principals: [string, string] = [alice, bob]) {
  const t = await team(principals);
  const ledger = new Ledger();
  const [a] = t.all;
  let first = "", second = "", q1 = "", q2 = "";
  await actor(alice, true, async () => {
    const f = await shareFinding(a!.repo, 7, {
      targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "transfer duplicates a charge",
    }) as any;
    const g = await shareFinding(a!.repo, 7, {
      targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "transfer skips validation",
    }) as any;
    assert.ok(f.id && g.id); first = f.id; second = g.id;
  });
  await settle(t); await checkSettled(t, ledger);
  const d = (id: string, ref: string, finding: string) => ({
    id, round: "R1", ref, kind: "options" as const,
    payload: { question: `${ref}: is ${finding} invalid?`, options: [
      { label: "Reject", description: "The premise is false" },
      { label: "Fix", description: "The code needs repair" },
    ] },
    options: [{ label: "Reject", effects: [{ findings: [finding], on: "settle" as const, as: "refuted" as const }] },
      { label: "Fix", effects: [{ findings: [finding], on: "unblock" as const }] }],
  });
  await actor(alice, true, async () => {
    const posted = await postRound(a!.repo, { round: { id: "R1", source: "withdrawal oracle" },
      decisions: [d("q1", "D1", first), d("q2", "D2", second)] }) as any;
    assert.equal(posted.ok, true, JSON.stringify(posted));
    q1 = posted.ask.find((x: any) => x.label === "q1").decision;
    q2 = posted.ask.find((x: any) => x.label === "q2").decision;
  });
  await settle(t); await checkSettled(t, ledger);
  return { t, ledger, first, second, q1, q2, cleanup: () => t.dispose() };
}

test("unanswered withdrawal releases only its hold locally; independent delayed answer and conflict survive sync", async () => {
  const u = await fixture();
  try {
    const [a, b] = u.t.all;
    let withdrawal = "", answer = "";
    await actor(alice, false, async () => {
      const result = await withdrawDecision(a!.repo, { decision: "q1", reason: "The first question needs reframing" }) as any;
      assert.equal(result.ok, true, JSON.stringify(result)); withdrawal = result.withdrawal;
    });
    assert.equal((await heldBy(a!.repo, u.first)).some((hold) => hold.decision === u.q1), false,
      "unanswered withdrawal releases Q1 before another answer arrives");
    assert.equal((await heldBy(a!.repo, u.second)).some((hold) => hold.decision === u.q2), true,
      "Q2's unrelated ordinary hold survives");
    await actor(bob, false, async () => {
      const result = await answerDirect(b!.repo, { decision: "q1", option: "Reject" }) as any;
      assert.equal(result.recorded, true, JSON.stringify(result)); answer = result.answer;
    });
    await checkAlways(u.t, u.ledger);
    await settle(u.t); await checkSettled(u.t, u.ledger);
    for (const member of u.t.all) {
      const view = await decisionRound(member.repo, "R1") as any;
      const q1 = view.decisions.find((d: any) => d.id === u.q1);
      assert.ok(q1.answers.some((entry: any) => entry.id === answer && entry.by.principal === bob));
      assert.ok(q1.withdrawals.some((entry: any) => entry.id === withdrawal && entry.state === "conflict"
        && entry.conflictingAnswers.includes(answer)), "both independent human acts remain in history");
      assert.ok((await heldBy(member.repo, u.first)).some((hold) => hold.why === "withdrawal"),
        "the newly discovered conflict restricts Q1 work");
      assert.ok((await heldBy(member.repo, u.second)).some((hold) => hold.decision === u.q2),
        "conflict handling cannot release Q2's unrelated hold");
    }
  } finally { u.cleanup(); }
});

test("answered withdrawal cancels a pending reading and confirmation without reviving the older answer", async () => {
  const u = await fixture([alice, alice]);
  const tx = mkdtempSync(join(tmpdir(), "codemap-withdrawal-reader-tx-"));
  try {
    const [a, b] = u.t.all;
    let older = "", current = "", confirm = "", withdrawal = "";
    await actor(alice, false, async () => {
      const first = await answerDirect(a!.repo, { decision: "q1", option: "Fix" }) as any;
      assert.equal(first.recorded, true, JSON.stringify(first)); older = first.answer;
      const second = await answerDirect(a!.repo, { decision: "q1", words: "The premise is false after all." }) as any;
      assert.equal(second.recorded, true, JSON.stringify(second)); current = second.answer;
    });
    await settle(u.t); await checkSettled(u.t, u.ledger);
    await actor("independent-reader", true, async () => {
      const brief = await readerBrief(b!.repo, { answer: current,
        maps: [{ decision: "q1", option: "Reject" }] }) as any;
      assert.equal(brief.ok, true, JSON.stringify(brief));
      const held = await submitVerdict(b!.repo, { answer: current, verdict: "D1 → Reject" }, {}, tx) as any;
      assert.equal(held.held, true, JSON.stringify(held));
      const pending = await recordReading(b!.repo, { answer: current }, {}, tx) as any;
      assert.equal(pending.pending, true, "the reader has not yet supplied a verifiable transcript result");
      const posted = await confirmReading(b!.repo, { answer: current,
        maps: [{ decision: "q1", option: "Reject" }] }) as any;
      assert.equal(posted.ok, true, JSON.stringify(posted)); confirm = posted.confirm;
    });
    await settle(u.t); await checkSettled(u.t, u.ledger);
    assert.equal((await decisionRound(a!.repo, "R1") as any).decisions.find((d: any) => d.id === confirm)?.confirm.state, "open");
    await actor(alice, false, async () => {
      const result = await withdrawDecision(a!.repo, { decision: "q1", answer: current,
        reason: "I retract this ruling" }) as any;
      assert.equal(result.ok, true, JSON.stringify(result)); withdrawal = result.withdrawal;
    });
    await settle(u.t); await checkSettled(u.t, u.ledger);
    await actor("independent-reader", true, async () => {
      const cancelled = await recordReading(b!.repo, { answer: current }, {}, tx) as any;
      assert.equal(cancelled.cancelled, true, JSON.stringify(cancelled));
      assert.equal(cancelled.cancelledBy, withdrawal);
    });
    for (const member of u.t.all) {
      const view = await decisionRound(member.repo, "R1") as any;
      const q1 = view.decisions.find((d: any) => d.id === u.q1);
      assert.equal(q1.standing, null, "the earlier direct answer cannot revive");
      assert.equal(q1.answers.length, 2);
      assert.ok(q1.answers.every((answer: any) => answer.withdrawn?.by === withdrawal),
        "both historical answers remain and the earlier one stays retired");
      assert.equal(view.decisions.find((d: any) => d.id === confirm)?.confirm.state, "no longer needed");
      assert.equal((await heldBy(member.repo, u.first)).some((hold) => hold.decision === u.q1), false);
      assert.equal((await heldBy(member.repo, u.second)).some((hold) => hold.decision === u.q2), true);
    }
  } finally { u.cleanup(); discard(tx); }
});


function applicationTranscript(dir: string, prompt: string, requestId: string, receipt: string) {
  const agentId = "aWITHDRAW1234567", session = "5e55a0a0-0000-0000-0000-000000000081";
  const launch = "toolu_launch_withdraw", call = "toolu_submit_withdraw";
  const verdict = "sound", rationale = "The person's ruling directly defeats the reported premise.";
  const sub = join(dir, session, "subagents"); mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "general-purpose", toolUseId: launch }));
  writeFileSync(join(sub, `agent-${agentId}.jsonl`), [
    { type: "user", isSidechain: true, agentId, sessionId: session, message: { role: "user", content: prompt } },
    { type: "assistant", isSidechain: true, agentId, sessionId: session, message: { content: [
      { type: "tool_use", id: call, name: "mcp__codemap__submit_application_verdict", input: { requestId, verdict, rationale } },
    ] } },
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
  return { requestId, receipt, agentId, callId: call };
}

test("withdrawing an executed ruling preserves its finding closure and receipt on both clones", async () => {
  const u = await fixture([alice, alice]);
  const tx = mkdtempSync(join(tmpdir(), "codemap-withdrawal-application-tx-"));
  try {
    const [a] = u.t.all;
    let answer = "", application = "";
    await actor(alice, false, async () => {
      const result = await answerDirect(a!.repo, { decision: "q1", option: "Reject" }) as any;
      assert.equal(result.recorded, true, JSON.stringify(result)); answer = result.answer;
    });
    await settle(u.t); await checkSettled(u.t, u.ledger);
    const issue = { kind: "finding" as const, universe: universeKey(a!.repo), review: 7, id: u.first };
    await actor("application-agent", true, async () => {
      const brief = await applicationReaderBrief(a!.repo, { issue, answerId: answer, slot: 1 }, tx) as any;
      assert.equal(brief.ok, true, JSON.stringify(brief));
      assert.equal(brief.directMention, true);
      const rationale = "The person's ruling directly defeats the reported premise.";
      const held = submitApplicationVerdict(a!.repo, { requestId: brief.requestId, verdict: "sound", rationale }) as any;
      assert.equal(held.held, true, JSON.stringify(held));
      const ref = applicationTranscript(tx, brief.prompt, brief.requestId, held.receipt);
      assert.equal((recordApplicationVerdict(a!.repo, ref, tx) as any).recorded, true);
      const applied = await applyRuling(a!.repo, { issue, answerId: answer, readers: [ref] }, tx) as any;
      assert.equal(applied.ok, true, JSON.stringify(applied)); application = applied.application;
    });
    await settle(u.t); await checkSettled(u.t, u.ledger);
    await actor(alice, false, async () => {
      const withdrawn = await withdrawDecision(a!.repo, { decision: "q1", answer,
        reason: "I retract this ruling for future use" }) as any;
      assert.equal(withdrawn.ok, true, JSON.stringify(withdrawn));
    });
    await settle(u.t); await checkSettled(u.t, u.ledger);
    for (const member of u.t.all) {
      const finding = await readFinding(member.repo, u.first);
      assert.equal(finding?.state, "refuted", "withdrawal cannot silently reopen an executed closure");
      assert.ok(finding?.applications?.some((entry) => entry.eventId === application && entry.status === "executed"));
      const round = await decisionRound(member.repo, "R1") as any;
      const historical = round.decisions.find((d: any) => d.id === u.q1).answers.find((entry: any) => entry.id === answer);
      assert.ok(historical.withdrawn);
      assert.ok(historical.executions.some((entry: any) => entry.eventId === application),
        "the withdrawn answer still exposes the target-scope execution receipt");
    }
  } finally { u.cleanup(); discard(tx); }
});
