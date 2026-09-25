import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { team, settle, whileApart, type Member } from "./oracle.js";
import { shareFinding, closeFinding } from "./ops-shared.js";
import { postRound, answerDirect } from "./ops/decisions.js";
import { applicationReaderBrief, submitApplicationVerdict, recordApplicationVerdict, applyRuling } from "./ops/ruling-application.js";
import { readFinding } from "./store.js";
import { universeKey } from "./sidecar-config.js";
import { emitEvent } from "./eventlog.js";
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
const error = (v: any) => String(v?.error ?? "");

const question = (id: string, decision: string, ref: string, round: string) => ({
  id: decision, round, ref, kind: "options" as const,
  payload: { question: `${ref}: is ${id} a real defect?`, options: [{ label: "No", description: "the premise is false" }, { label: "Yes", description: "repair it" }] },
  options: [{ label: "No", effects: [{ findings: [id], on: "settle" as const, as: "refuted" as const }] },
    { label: "Yes", effects: [{ findings: [id], on: "unblock" as const }] }],
});

async function fileAndRule(m: Member, decision = "d1", round = "R1", ref = "D1") {
  const filed = await withAgent(() => shareFinding(m.repo, 7, { targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "transfer accepts the wrong amount" })) as any;
  assert.equal(filed.error, undefined, JSON.stringify(filed));
  const posted = await withAgent(() => postRound(m.repo, { round: { id: round, source: "oracle" }, decisions: [question(filed.id, decision, ref, round)] })) as any;
  assert.equal(posted.ok, true, JSON.stringify(posted));
  const answered = await withPerson(() => answerDirect(m.repo, { decision, option: "No" })) as any;
  assert.equal(answered.recorded, true, JSON.stringify(answered));
  return { id: filed.id as string, answer: answered.answer as string };
}

function transcript(dir: string, prompt: string, requestId: string, receipt: string, agentId: string, session: string) {
  const sub = join(dir, session, "subagents");
  mkdirSync(sub, { recursive: true });
  const launch = `toolu_launch_${agentId}`, call = `toolu_submit_${agentId}`;
  writeFileSync(join(sub, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "general-purpose", toolUseId: launch }));
  writeFileSync(join(sub, `agent-${agentId}.jsonl`), [
    { type: "user", isSidechain: true, agentId, sessionId: session, message: { role: "user", content: prompt } },
    { type: "assistant", isSidechain: true, agentId, sessionId: session, message: { content: [{ type: "tool_use", id: call, name: "mcp__codemap__submit_application_verdict", input: { requestId, verdict: "sound", rationale: "The ruling defeats this exact premise." } }] } },
    { type: "user", isSidechain: true, agentId, sessionId: session, message: { content: [{ type: "tool_result", tool_use_id: call, content: JSON.stringify({ ok: true, held: true, receipt }) }] } },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
  writeFileSync(join(dir, `${session}.jsonl`), [
    { type: "assistant", isSidechain: false, timestamp: new Date().toISOString(), message: { content: [{ type: "tool_use", id: launch, name: "Agent", input: { prompt, subagent_type: "general-purpose" } }] } },
    { type: "user", isSidechain: false, message: { content: [{ type: "tool_result", tool_use_id: launch, content: "launched" }] }, toolUseResult: { agentId } },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
  return { requestId, receipt, agentId, callId: call };
}

async function applyWithReader(m: Member, issueId: string, answerId: string, dir: string, agentId: string, session: string) {
  const issue = { kind: "finding" as const, universe: universeKey(m.repo), id: issueId, review: 7 };
  return withAgent(async () => {
    const brief = await applicationReaderBrief(m.repo, { issue, answerId, slot: 1 }, dir) as any;
    assert.equal(brief.ok, true, JSON.stringify(brief));
    assert.equal(brief.directMention, true);
    const held = submitApplicationVerdict(m.repo, { requestId: brief.requestId, verdict: "sound", rationale: "The ruling defeats this exact premise." }) as any;
    assert.equal(held.held, true, JSON.stringify(held));
    const ref = transcript(dir, brief.prompt, brief.requestId, held.receipt, agentId, session);
    assert.equal((recordApplicationVerdict(m.repo, ref, dir) as any).recorded, true);
    const applied = await applyRuling(m.repo, { issue, answerId, readers: [ref] }, dir) as any;
    assert.equal(applied.ok, true, JSON.stringify(applied));
    return applied.application as string;
  });
}

const readBoth = async (a: Member, b: Member, id: string) => {
  const one = await readFinding(a.repo, id), two = await readFinding(b.repo, id);
  assert.ok(one && two, "both canonical stores hold the shared issue");
  return [one, two] as const;
};

test("two clones preserve one-shot application across reopen and delayed duplicate; a new ruling has a new opportunity", async () => {
  const t = await team([A, A]);
  const tx = mkdtempSync(join(tmpdir(), "codemap-oracle-application-tx-"));
  try {
    const [a, b] = t.all as [Member, Member];
    const original = await fileAndRule(a);
    await settle(t);
    const first = await applyWithReader(a, original.id, original.answer, tx,
      "a12345671", "5e55a0a0-0000-0000-0000-000000000001");
    await settle(t);
    for (const issue of await readBoth(a, b, original.id)) {
      assert.equal(issue.state, "invalid");
      assert.equal(issue.closed?.eventId, first);
      assert.deepEqual(issue.applications?.map((x) => x.status), ["executed"]);
    }

    const reopened = await withAgent(() => closeFinding(b.repo, 7, original.id, "issued", "the claim needs another look")) as any;
    assert.equal(reopened.state, "issued", JSON.stringify(reopened));
    await settle(t);
    for (const issue of await readBoth(a, b, original.id)) {
      assert.equal(issue.state, "issued");
      assert.deepEqual(issue.applications?.map((x) => x.status), ["executed"]);
    }

    const old = (await readFinding(a.repo, original.id))!.applications![0]!.capsule!;
    const duplicate = await emitEvent(b.sidecar, old.issue.ref.scope, { principal: A, via: { kind: "agent", model: "delayed" } },
      "finding.rulingApplied", original.id, { capsule: old });
    await settle(t);
    for (const issue of await readBoth(a, b, original.id)) {
      assert.equal(issue.state, "issued", "the old pair cannot close a reopened epoch");
      assert.deepEqual(issue.applications?.map((x) => x.status), ["executed", "duplicate"]);
      assert.equal(issue.applications?.[1]?.eventId, duplicate.id);
      assert.equal(issue.applications?.[0]?.eventId, first);
    }
    const retry = await withAgent(() => applyRuling(a.repo,
      { issue: { kind: "finding", universe: universeKey(a.repo), id: original.id, review: 7 }, answerId: original.answer, readers: [] }, tx)) as any;
    assert.equal(retry.application, first, JSON.stringify(retry));

    const posted = await withAgent(() => postRound(b.repo, { round: { id: "R2", source: "new investigation" },
      decisions: [question(original.id, "d2", "D1", "R2")] })) as any;
    assert.equal(posted.ok, true, JSON.stringify(posted));
    const next = await withPerson(() => answerDirect(b.repo, { decision: "d2", option: "No" })) as any;
    assert.equal(next.recorded, true, JSON.stringify(next));
    await settle(t);
    const second = await applyWithReader(b, original.id, next.answer, tx,
      "a12345672", "5e55a0a0-0000-0000-0000-000000000002");
    assert.notEqual(second, first);
    await settle(t);
    for (const issue of await readBoth(a, b, original.id)) {
      assert.equal(issue.state, "invalid");
      assert.equal(issue.closed?.eventId, second);
      assert.deepEqual(issue.applications?.map((x) => x.status), ["executed", "duplicate", "executed"]);
      assert.notEqual(issue.applications?.[0]?.key, issue.applications?.[2]?.key);
    }
  } finally { t.dispose(); discard(tx); }
});

test("an already-closed issue spends nothing, while a concurrent ordinary close preserves historical execution on both clones", async () => {
  const t = await team([A, B]);
  const tx = mkdtempSync(join(tmpdir(), "codemap-oracle-application-tx-"));
  try {
    const [a, b] = t.all as [Member, Member];
    const closed = await fileAndRule(a, "closed-d", "CLOSED", "D1");
    await settle(t);
    const ordinary = await withPerson(() => closeFinding(b.repo, 7, closed.id, "invalid", "separate human disposition")) as any;
    assert.equal(ordinary.state, "invalid", JSON.stringify(ordinary));
    await settle(t);
    const refusal = await withAgent(() => applyRuling(a.repo,
      { issue: { kind: "finding", universe: universeKey(a.repo), id: closed.id, review: 7 }, answerId: closed.answer, readers: [] }, tx)) as any;
    assert.match(error(refusal), /already closed/);
    for (const issue of await readBoth(a, b, closed.id)) {
      assert.equal(issue.state, "invalid");
      assert.equal(issue.applications?.length ?? 0, 0, "a refusal never spends the pair");
    }

    const racing = await fileAndRule(a, "race-d", "RACE", "D1");
    await settle(t);
    let application = "";
    await whileApart(t,
      A, async (m) => { application = await applyWithReader(m, racing.id, racing.answer, tx,
        "a12345673", "5e55a0a0-0000-0000-0000-000000000003"); },
      B, async (m) => {
        const result = await withPerson(() => closeFinding(m.repo, 7, racing.id, "invalid", "independent human close")) as any;
        assert.equal(result.state, "invalid", JSON.stringify(result));
      });
    for (const issue of await readBoth(a, b, racing.id)) {
      assert.equal(issue.state, "invalid");
      assert.equal(issue.applications?.filter((x) => x.status === "executed").length, 1,
        "a concurrent ordinary close does not refund the ruling pair");
      assert.equal(issue.applications?.[0]?.eventId, application);
    }
  } finally { t.dispose(); discard(tx); }
});
