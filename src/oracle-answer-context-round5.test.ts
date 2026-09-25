/** Plan §9 A/B/C: issued reader context survives later questions and sync. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { team, settle } from "./oracle.js";
import { Ledger, checkSettled } from "./oracle-properties.js";
import { shareFinding } from "./ops-shared.js";
import { postRound, answerDirect, readerBrief, submitVerdict, recordReading,
  decisionRound, decisionRounds } from "./ops/decisions.js";
import { decisionsView } from "./ops/decision-holds.js";
import { discard } from "./test-tmp.js";
import { readScope } from "./eventlog.js";
import { decisionScope } from "./shared-decisions.js";
import { universeKey } from "./sidecar-config.js";

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

/** The launch, reader call, and successful result must all match the held verdict receipt. */
function readerTranscript(dir: string, prompt: string, answer: string, verdict: string, receipt: string, launchedAt: string) {
  const agentId = "aANSWERCTX1234567", session = "5e55a0a0-0000-0000-0000-000000000041";
  const launch = "toolu_launch_answer", call = "toolu_submit_answer";
  const sub = join(dir, session, "subagents"); mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "general-purpose", toolUseId: launch }));
  writeFileSync(join(sub, `agent-${agentId}.jsonl`), [
    { type: "user", uuid: "s1", isSidechain: true, agentId, sessionId: session, message: { role: "user", content: prompt } },
    { type: "assistant", uuid: "s2", isSidechain: true, agentId, sessionId: session, message: { content: [
      { type: "tool_use", id: call, name: "mcp__codemap__submit_verdict", input: { answer, verdict } },
    ] } },
    { type: "user", uuid: "s3", isSidechain: true, agentId, sessionId: session, message: { content: [
      { type: "tool_result", tool_use_id: call, content: JSON.stringify({ ok: true, held: true, receipt }) },
    ] } },
    { type: "assistant", uuid: "s4", isSidechain: true, agentId, sessionId: session, message: { content: [
      { type: "tool_use", id: "toolu_handback_answer", name: "SubagentHandback", input: { message: verdict } },
    ] } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  writeFileSync(join(dir, `${session}.jsonl`), [
    { type: "assistant", uuid: "p1", isSidechain: false, timestamp: launchedAt, message: { content: [
      { type: "tool_use", id: launch, name: "Agent", input: { description: "read", prompt, subagent_type: "general-purpose" } },
    ] } },
    { type: "user", uuid: "p2", isSidechain: false, timestamp: launchedAt, message: { content: [
      { type: "tool_result", tool_use_id: launch, content: "launched" },
    ] }, toolUseResult: { isAsync: true, status: "async_launched", agentId } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

test("two clones preserve an issued brief through a delayed verdict and related same-ref question", async () => {
  const t = await team([alice, bob]);
  const tx = mkdtempSync(join(tmpdir(), "codemap-answer-context-tx-"));
  const ledger = new Ledger();
  try {
    const [a, b] = t.all;
    let first = "", second = "", answerId = "";
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
    await actor(alice, true, async () => {
      const posted = await postRound(a!.repo, { round: { id: "R1", source: "A and B" }, decisions: [{
        id: "q1", round: "R1", ref: "D1", kind: "options",
        payload: { question: `D1: are ${first} and ${second} invalid?`, options: [
          { label: "Reject", description: "Both premises are false" },
          { label: "Fix", description: "Both need repair" },
        ] },
        options: [
          { label: "Reject", effects: [{ findings: [first, second], on: "settle", as: "refuted" }] },
          { label: "Fix", effects: [{ findings: [first, second], on: "unblock" }] },
        ],
      }] }) as any;
      assert.equal(posted.ok, true, JSON.stringify(posted));
    });
    await settle(t); await checkSettled(t, ledger);
    await actor(alice, false, async () => {
      const answer = await answerDirect(a!.repo, { decision: "q1", words: "The first may be wrong; the second needs a fix." }) as any;
      assert.equal(answer.recorded, true, JSON.stringify(answer)); answerId = answer.answer;
    });
    await settle(t); await checkSettled(t, ledger);

    let prompt = "", receipt = "";
    const verdict = "D1 → Fix";
    const launchedAt = new Date(Date.now() + 1_000).toISOString();
    await actor("independent-reader", true, async () => {
      const issued = await readerBrief(a!.repo, { answer: answerId,
        maps: [{ decision: "q1", option: "Reject" }] }) as any;
      assert.equal(issued.ok, true, JSON.stringify(issued)); prompt = issued.prompt;
      assert.match(prompt, new RegExp(first)); assert.match(prompt, new RegExp(second));
      assert.match(prompt, /Both premises are false/);
      const held = await submitVerdict(a!.repo, { answer: answerId, verdict }, {}, tx) as any;
      assert.equal(held.held, true, JSON.stringify(held)); receipt = held.receipt;
    });
    await actor(bob, true, async () => {
      const related = await postRound(b!.repo, { round: { id: "R2", source: "A only" }, decisions: [{
        id: "q2", round: "R2", ref: "D1", follows: "q1", kind: "options",
        payload: { question: `D1: does ${first} need separate repair?`, options: [
          { label: "Yes", description: "Repair A" }, { label: "No", description: "No repair of A" },
        ] },
        options: [{ label: "Yes", effects: [{ findings: [first], on: "unblock" }] },
          { label: "No", effects: [{ findings: [first], on: "settle", as: "refuted" }] }],
      }] }) as any;
      assert.equal(related.ok, true, JSON.stringify(related));
    });
    await settle(t); await checkSettled(t, ledger);
    for (const member of t.all) {
      const one = await decisionRound(member.repo, "R1") as any;
      const two = await decisionRound(member.repo, "R2") as any;
      assert.ok(one.decisions.some((d: any) => d.id === "q1"));
      assert.ok(two.decisions.some((d: any) => d.id === "q2"));
      assert.equal(one.decisions.find((d: any) => d.id === "q1").answers[0].cancelled, undefined,
        "an unrelated related question cannot cancel the earlier response");
    }
    readerTranscript(tx, prompt, answerId, verdict, receipt, launchedAt);
    await actor("independent-reader", true, async () => {
      const recorded = await recordReading(a!.repo, { answer: answerId }, {}, tx) as any;
      assert.equal(recorded.recorded, true, JSON.stringify(recorded));
      assert.equal(recorded.agree, false, "the reader disagrees with the requesting agent's interpretation");
    });
    await settle(t); await checkSettled(t, ledger);
    for (const member of t.all) {
      const one = await decisionRound(member.repo, "R1") as any;
      const d = one.decisions.find((entry: any) => entry.id === "q1");
      const answer = d.answers.find((entry: any) => entry.id === answerId);
      assert.equal(answer.reading.agree, false);
      assert.deepEqual(answer.reading.reader.maps, [{ decision: "q1", option: "Fix" }]);
      const reading = (await readScope(member.sidecar, decisionScope(universeKey(member.repo))))
        .find((event) => event.kind === "decision.reading.recorded" && (event.data as any)?.answer === answerId);
      assert.ok(reading, "accepted reading remains an append-only event");
      assert.equal((reading!.data as any).reader.brief, prompt);
      assert.ok((reading!.data as any).reader.manifest.every((entry: any) => entry.id !== "q2"),
        "the issued manifest cannot gain the later D1 question");
      assert.ok(one.readingsInDispute.some((entry: any) => entry.answer === answerId));
      assert.ok((await decisionRound(member.repo, "R2") as any).decisions.some((entry: any) => entry.id === "q2"));
      const view = await decisionsView(member.repo);
      assert.equal(view.work(second).allowed, false, "Q1 still covers B while Q2 concerns only A");
    }
    await actor(alice, false, async () => {
      const changed = await answerDirect(a!.repo, { decision: "q1", words: "Both should be repaired." }) as any;
      assert.equal(changed.recorded, true, JSON.stringify(changed));
    });
    await settle(t); await checkSettled(t, ledger);
    for (const member of t.all) {
      const one = await decisionRound(member.repo, "R1") as any;
      const prior = one.decisions.find((d: any) => d.id === "q1").answers.find((entry: any) => entry.id === answerId);
      assert.ok(prior.cancelled?.by);
      assert.equal(prior.reading.agree, false, "historical evidence stays visible");
      assert.ok(!one.readingsInDispute.some((entry: any) => entry.answer === answerId),
        "cancelled reading is no longer an actionable dispute");
      assert.ok((await decisionRounds(member.repo) as any).rounds.some((round: any) => round.id === "R2"));
    }
  } finally { t.dispose(); discard(tx); }
});
