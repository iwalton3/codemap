/**
 * Round 3, O3 — pinned, not a fix. The ruling-application op writes the acceptance's principal,
 * the ruling's answerer and the shown context's answerer all from `rulerOf(answer)`, and the
 * fold compares them with each other, so words one person wrote and another CONFIRMED apply
 * under the confirmer (CLAUDE.md R3: "`rulerOf(a)` is who rules through an answer"). Should this
 * ever fail, the fold checks `rulerOf(a)` as the op writes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { team, settle, type Member } from "./oracle.js";
import { shareFinding } from "./ops-shared.js";
import { postRound, answerDirect, readerBrief, submitVerdict, recordReading, confirmReading } from "./ops/decisions.js";
import { applicationReaderBrief, submitApplicationVerdict, recordApplicationVerdict, applyRuling } from "./ops/ruling-application.js";
import { readFinding } from "./store.js";
import { universeKey } from "./sidecar-config.js";
import { discard } from "./test-tmp.js";

const A = "ana@acme.test";
const B = "ben@acme.test";
const withAgent = async <T>(fn: () => Promise<T>): Promise<T> => {
  const old = process.env.CODEMAP_AGENT_MODEL;
  process.env.CODEMAP_AGENT_MODEL = "claude-opus-5";
  try { return await fn(); } finally { if (old === undefined) delete process.env.CODEMAP_AGENT_MODEL; else process.env.CODEMAP_AGENT_MODEL = old; }
};
const withPerson = async <T>(fn: () => Promise<T>): Promise<T> => {
  const old = process.env.CODEMAP_AGENT_MODEL;
  delete process.env.CODEMAP_AGENT_MODEL;
  try { return await fn(); } finally { if (old !== undefined) process.env.CODEMAP_AGENT_MODEL = old; }
};

function transcript(dir: string, prompt: string, requestId: string, receipt: string, agentId: string, session: string, rationale = "The ruling defeats this exact premise.") {
  const sub = join(dir, session, "subagents");
  mkdirSync(sub, { recursive: true });
  const launch = `toolu_launch_${agentId}`, call = `toolu_submit_${agentId}`;
  writeFileSync(join(sub, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "general-purpose", toolUseId: launch }));
  writeFileSync(join(sub, `agent-${agentId}.jsonl`), [
    { type: "user", isSidechain: true, agentId, sessionId: session, message: { role: "user", content: prompt } },
    { type: "assistant", isSidechain: true, agentId, sessionId: session, message: { content: [{ type: "tool_use", id: call, name: "mcp__codemap__submit_application_verdict", input: { requestId, verdict: "sound", rationale } }] } },
    { type: "user", isSidechain: true, agentId, sessionId: session, message: { content: [{ type: "tool_result", tool_use_id: call, content: JSON.stringify({ ok: true, held: true, receipt }) }] } },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
  writeFileSync(join(dir, `${session}.jsonl`), [
    { type: "assistant", isSidechain: false, timestamp: new Date().toISOString(), message: { content: [{ type: "tool_use", id: launch, name: "Agent", input: { prompt, subagent_type: "general-purpose" } }] } },
    { type: "user", isSidechain: false, message: { content: [{ type: "tool_result", tool_use_id: launch, content: "launched" }] }, toolUseResult: { agentId } },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
  return { requestId, receipt, agentId, callId: call };
}

async function applyWithReader(m: Member, issueId: string, answerId: string, dir: string, agentId: string, session: string, rationale = "The ruling defeats this exact premise.") {
  const issue = { kind: "finding" as const, universe: universeKey(m.repo), id: issueId, review: 7 };
  return withAgent(async () => {
    const brief = await applicationReaderBrief(m.repo, { issue, answerId, slot: 1 }, dir) as any;
    assert.equal(brief.ok, true, JSON.stringify(brief));
    assert.equal(brief.directMention, true);
    const held = submitApplicationVerdict(m.repo, { requestId: brief.requestId, verdict: "sound", rationale }) as any;
    assert.equal(held.held, true, JSON.stringify(held));
    const ref = transcript(dir, brief.prompt, brief.requestId, held.receipt, agentId, session, rationale);
    assert.equal((recordApplicationVerdict(m.repo, ref, dir) as any).recorded, true);
    const applied = await applyRuling(m.repo, { issue, answerId, readers: [ref] }, dir) as any;
    assert.equal(applied.ok, true, JSON.stringify(applied));
    return applied.application as string;
  });
}

test("an acceptance through words one person wrote and another confirmed applies, under the confirmer", async () => {
  const t = await team([A, B]);
  const tx = mkdtempSync(join(tmpdir(), "codemap-o3-tx-"));
  try {
    const [a, b] = t.all as [Member, Member];
    const filed = await withAgent(() => shareFinding(a.repo, 7, { targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "transfer rounding loses precision" })) as any;
    assert.equal(filed.error, undefined, JSON.stringify(filed));
    const posted = await withAgent(() => postRound(a.repo, { round: { id: "O3", source: "o3 pin" }, decisions: [{
      id: "accept-rounding", round: "O3", ref: "D1", kind: "options",
      payload: { question: `D1: Accept ${filed.id} as real and deliberately not being fixed?`, options: [{ label: "Accept", description: "Keep the real defect as an explicit human acceptance" }, { label: "Repair", description: "Authorize repair work" }] },
      options: [{ label: "Accept", effects: [{ findings: [filed.id], on: "settle", as: "accepted" }] }, { label: "Repair", effects: [{ findings: [filed.id], on: "unblock" }] }],
    }] })) as any;
    assert.equal(posted.ok, true, JSON.stringify(posted));
    // Ana writes words; nobody has said which option they mean yet.
    const words = await withPerson(() => answerDirect(a.repo, { decision: "accept-rounding", words: "It's real, but we live with it — no repair." })) as any;
    assert.equal(words.recorded, true, JSON.stringify(words));
    await settle(t);
    const maps = [{ decision: "accept-rounding", option: "Accept" }];
    const confirm = await withAgent(async () => {
      assert.equal((await readerBrief(b.repo, { answer: words.answer, maps }) as any).ok, true);
      assert.equal((await submitVerdict(b.repo, { answer: words.answer, verdict: "D1 → Accept" }, {}, tx) as any).held, true);
      await recordReading(b.repo, { answer: words.answer }, {}, tx);
      const c = await confirmReading(b.repo, { answer: words.answer, maps }) as any;
      assert.equal(c.ok, true, JSON.stringify(c));
      return c;
    });
    await settle(t);
    // Ben confirms the reading: he now rules through Ana's words.
    const yes = confirm.ask.options[0].label as string;
    const confirmed = await withPerson(() => answerDirect(b.repo, { decision: confirm.label, option: yes })) as any;
    assert.equal(confirmed.recorded, true, JSON.stringify(confirmed));
    await settle(t);
    const application = await applyWithReader(a, filed.id, words.answer, tx, "a12345675", "5e55a0a0-0000-0000-0000-000000000005",
      "The confirmed reading accepts the whole real rounding defect and deliberately declines repair.");
    await settle(t);
    for (const m of [a, b]) {
      const f = (await readFinding(m.repo, filed.id))!;
      assert.equal(f.state, "accepted");
      assert.equal(f.closed?.eventId, application);
      assert.deepEqual(f.closed?.by, { principal: B }, "the confirmer rules, not the words' author");
    }
  } finally { t.dispose(); discard(tx); }
});
