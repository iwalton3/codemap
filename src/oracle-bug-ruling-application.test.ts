import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { team, settle, type Member } from "./oracle.js";
import { discard } from "./test-tmp.js";
import { reportBug, updateBug } from "./ops/bugs.js";
import { postRound, answerDirect } from "./ops/decisions.js";
import { applicationReaderBrief, submitApplicationVerdict, recordApplicationVerdict, applyRuling } from "./ops/ruling-application.js";
import { readBug } from "./store.js";
import { universeKey } from "./sidecar-config.js";
import { bugScope } from "./shared-bugs.js";
import { emitEvent } from "./eventlog.js";

const A = "ana@acme.test";
async function as<T>(agent: boolean, run: () => Promise<T>): Promise<T> {
  const before = process.env.CODEMAP_AGENT_MODEL;
  if (agent) process.env.CODEMAP_AGENT_MODEL = "bug-ruling-oracle";
  else delete process.env.CODEMAP_AGENT_MODEL;
  try { return await run(); } finally {
    if (before === undefined) delete process.env.CODEMAP_AGENT_MODEL;
    else process.env.CODEMAP_AGENT_MODEL = before;
  }
}
const noError = (v: any) => assert.equal(v?.error, undefined, JSON.stringify(v));
function question(id: string, round: string, ref: string, issue: { kind: "bug"; universe: string; scope: string; id: string }) {
  return { id, round, ref, kind: "options" as const,
    payload: { question: `${ref}: Is ${issue.id} a real defect?`, options: [
      { label: "No", description: "The reported premise is false" }, { label: "Yes", description: "Repair it" }] },
    options: [{ label: "No", effects: [{ findings: [], issues: [issue], on: "settle" as const, as: "refuted" as const }] },
      { label: "Yes", effects: [{ findings: [], issues: [issue], on: "unblock" as const }] }] };
}
function transcript(dir: string, prompt: string, requestId: string, receipt: string, n: number) {
  const agentId = `aBUGORACLE${n}`, session = `5e55a0a0-0000-0000-0000-00000000910${n}`;
  const launch = `toolu_launch_${n}`, call = `toolu_submit_${n}`;
  const sub = join(dir, session, "subagents");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "general-purpose", toolUseId: launch }));
  writeFileSync(join(sub, `agent-${agentId}.jsonl`), [
    { type: "user", isSidechain: true, agentId, sessionId: session, message: { role: "user", content: prompt } },
    { type: "assistant", isSidechain: true, agentId, sessionId: session, message: { content: [{ type: "tool_use", id: call,
      name: "mcp__codemap__submit_application_verdict", input: { requestId, verdict: "sound", rationale: "This ruling defeats the precise bug premise." } }] } },
    { type: "user", isSidechain: true, agentId, sessionId: session, message: { content: [{ type: "tool_result", tool_use_id: call,
      content: JSON.stringify({ ok: true, held: true, receipt }) }] } },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
  writeFileSync(join(dir, `${session}.jsonl`), [
    { type: "assistant", isSidechain: false, timestamp: new Date().toISOString(), message: { content: [{ type: "tool_use", id: launch,
      name: "Agent", input: { prompt, subagent_type: "general-purpose" } }] } },
    { type: "user", isSidechain: false, message: { content: [{ type: "tool_result", tool_use_id: launch, content: "launched" }] }, toolUseResult: { agentId } },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
  return { requestId, receipt, agentId, callId: call };
}
async function applied(m: Member, issue: { kind: "bug"; universe: string; scope: string; id: string }, answerId: string, dir: string, n: number) {
  return as(true, async () => {
    const brief = await applicationReaderBrief(m.repo, { issue, answerId, slot: 1 }, dir) as any;
    assert.equal(brief.ok, true, JSON.stringify(brief));
    assert.equal(brief.directMention, true);
    const held = submitApplicationVerdict(m.repo, { requestId: brief.requestId, verdict: "sound", rationale: "This ruling defeats the precise bug premise." }) as any;
    assert.equal(held.held, true, JSON.stringify(held));
    const ref = transcript(dir, brief.prompt, brief.requestId, held.receipt, n);
    assert.equal((recordApplicationVerdict(m.repo, ref, dir) as any).recorded, true);
    const out = await applyRuling(m.repo, { issue, answerId, readers: [ref] }, dir) as any;
    assert.equal(out.ok, true, JSON.stringify(out));
    return out.application as string;
  });
}

test("two clones keep a bug ruling pair spent after reopen, delayed duplicate and retry; a new ruling can close", async () => {
  const t = await team([A, A]);
  const tx = mkdtempSync(join(tmpdir(), "codemap-bug-ruling-oracle-tx-"));
  try {
    const [a, b] = t.all as [Member, Member];
    const filed = await as(true, () => reportBug(a.repo, { title: "transfer bug", description: "transfer accepts a wrong amount", anchors: ["src/pay.ts#transfer"] })) as any;
    noError(filed);
    const issue = { kind: "bug" as const, universe: universeKey(a.repo), scope: bugScope(universeKey(a.repo)), id: filed.id as string };
    noError(await as(true, () => postRound(a.repo, { round: { id: "R1", source: "bug oracle" }, decisions: [question("d1", "R1", "D1", issue)] })));
    const firstAnswer = await as(false, () => answerDirect(a.repo, { decision: "d1", option: "No" })) as any;
    assert.equal(firstAnswer.recorded, true, JSON.stringify(firstAnswer));
    await settle(t);
    const first = await applied(a, issue, firstAnswer.answer, tx, 1);
    await settle(t);
    for (const m of [a, b]) {
      const bug = await readBug(m.repo, issue.id);
      assert.equal(bug?.state, "invalid");
      assert.equal(bug?.closed?.eventId, first);
      assert.deepEqual(bug?.applications?.map((x) => x.status), ["executed"]);
    }
    const reopened = await as(true, () => updateBug(b.repo, { id: issue.id, state: "issued", reason: "investigate the claim again" })) as any;
    assert.equal(reopened.state, "issued", JSON.stringify(reopened));
    await settle(t);
    for (const m of [a, b]) assert.equal((await readBug(m.repo, issue.id))?.state, "issued");
    const capsule = (await readBug(a.repo, issue.id))!.applications![0]!.capsule!;
    const duplicate = await emitEvent(b.sidecar, issue.scope, { principal: A, via: { kind: "agent", model: "delayed" } },
      "bug.rulingApplied", issue.id, { capsule });
    await settle(t);
    for (const m of [a, b]) {
      const bug = await readBug(m.repo, issue.id);
      assert.equal(bug?.state, "issued", "a delayed old pair cannot close a new open epoch");
      assert.deepEqual(bug?.applications?.map((x) => x.status), ["executed", "duplicate"]);
      assert.equal(bug?.applications?.[1]?.eventId, duplicate.id);
    }
    const retry = await as(true, () => applyRuling(a.repo, { issue, answerId: firstAnswer.answer, readers: [] }, tx)) as any;
    assert.equal(retry.application, first, JSON.stringify(retry));
    assert.equal((await readBug(a.repo, issue.id))?.state, "issued");
    const newBrief = await as(true, () => applicationReaderBrief(a.repo, { issue, answerId: firstAnswer.answer, slot: 1 }, tx)) as any;
    assert.equal(newBrief.ok, true, JSON.stringify(newBrief));
    {
      const held = submitApplicationVerdict(a.repo, { requestId: newBrief.requestId, verdict: "sound", rationale: "This ruling defeats the precise bug premise." }) as any;
      assert.equal(held.held, true, JSON.stringify(held));
      const ref = transcript(tx, newBrief.prompt, newBrief.requestId, held.receipt, 2);
      assert.equal((recordApplicationVerdict(a.repo, ref, tx) as any).recorded, true);
      const again = await as(true, () => applyRuling(a.repo, { issue, answerId: firstAnswer.answer, readers: [ref] }, tx)) as any;
      assert.equal(again.application, first, JSON.stringify(again));
    }
    await settle(t);
    for (const m of [a, b]) assert.equal((await readBug(m.repo, issue.id))?.state, "issued");
    noError(await as(true, () => postRound(b.repo, { round: { id: "R2", source: "new investigation" }, decisions: [question("d2", "R2", "D1", issue)] })));
    const next = await as(false, () => answerDirect(b.repo, { decision: "d2", option: "No" })) as any;
    assert.equal(next.recorded, true, JSON.stringify(next));
    await settle(t);
    const second = await applied(b, issue, next.answer, tx, 3);
    assert.notEqual(second, first);
    await settle(t);
    for (const m of [a, b]) {
      const bug = await readBug(m.repo, issue.id);
      assert.equal(bug?.state, "invalid");
      assert.equal(bug?.closed?.eventId, second);
      assert.deepEqual(bug?.applications?.map((x) => x.status), ["executed", "duplicate", "executed"]);
      assert.notEqual(bug?.applications?.[0]?.key, bug?.applications?.[2]?.key);
    }
  } finally { t.dispose(); discard(tx); }
});
