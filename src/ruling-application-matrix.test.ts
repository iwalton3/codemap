/** Plan §9 application paths through real ops and transcript-backed reader receipts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { indexBlob } from "./repo.js";
import { writeStore, readFinding, readBug } from "./store.js";
import { shareFinding } from "./ops-shared.js";
import { reportBug, updateBug } from "./ops/bugs.js";
import { postRound, answerDirect } from "./ops/decisions.js";
import { applicationReaderBrief, submitApplicationVerdict, recordApplicationVerdict, applyRuling,
  type ApplicationReceiptRef } from "./ops/ruling-application.js";
import { universeKey } from "./sidecar-config.js";
import { readScope } from "./eventlog.js";
import { discard } from "./test-tmp.js";

const code = "export function creditLine(cents) { return cents * 2; }\n";
const error = (value: any) => String(value?.error ?? value?.reason ?? "");
const withActor = async (agent: boolean, action: () => Promise<void>) => {
  const before = process.env.CODEMAP_AGENT_MODEL;
  if (agent) process.env.CODEMAP_AGENT_MODEL = "claude-opus-5";
  else delete process.env.CODEMAP_AGENT_MODEL;
  try { await action(); } finally {
    if (before === undefined) delete process.env.CODEMAP_AGENT_MODEL;
    else process.env.CODEMAP_AGENT_MODEL = before;
  }
};

async function fixture(kind: "finding" | "bug", direct = false) {
  const root = mkdtempSync(join(tmpdir(), "codemap-application-matrix-"));
  const sidecar = mkdtempSync(join(tmpdir(), "codemap-application-matrix-side-"));
  const transcripts = mkdtempSync(join(tmpdir(), "codemap-application-matrix-transcripts-"));
  const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "alice@x.com");
  git("config", "user.name", "alice");
  mkdirSync(join(root, ".codemap")); mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".codemap", "sidecar"), sidecar);
  writeFileSync(join(root, "src/credit.js"), code);
  const anchors = await indexBlob(code, "src/credit.js");
  await writeStore(root, anchors, { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as any);
  const universe = universeKey(root);
  let id = "";
  await withActor(true, async () => {
    if (kind === "finding") {
      const result = await shareFinding(root, 7, {
        targetKind: "anchor", targetId: anchors[0]!.id, text: "creditLine doubles the charge",
      }) as any;
      assert.equal(result.ok, true, JSON.stringify(result));
      id = result.id;
    } else {
      const result = await reportBug(root, {
        title: "Credit doubles unexpectedly", description: "The charge is doubled",
        anchors: [anchors[0]!.id],
      }) as any;
      assert.equal(result.ok, true, JSON.stringify(result));
      id = result.id;
    }
  });
  const issue = kind === "finding"
    ? { kind, universe, review: "7", scope: `findings/${universe}/pr-7`, id }
    : { kind, universe, scope: `bugs/${universe}`, id };
  const question = direct ? `D1: Is ${id} actually invalid?` : "D1: Is doubling the charge actually intended?";
  const effects = kind === "bug"
    ? [{ findings: [], issues: [issue], on: "settle" as const, as: "refuted" as const }]
    : direct ? [{ findings: [id], on: "settle" as const, as: "refuted" as const }] : [];
  let posted: any;
  await withActor(true, async () => {
    posted = await postRound(root, { round: { id: "R1", source: "application matrix" }, decisions: [{
      id: "d1", round: "R1", ref: "D1", kind: "options",
      payload: { question, options: [{ label: "Not a defect", description: "The doubling is intended" },
        { label: "Real defect", description: "The charge needs repair" }] },
      options: [{ label: "Not a defect", effects }, { label: "Real defect", effects: [] }],
    }] });
  });
  let answer = "";
  if (posted.ok) await withActor(false, async () => {
    const result = await answerDirect(root, { decision: "d1", option: "Not a defect" }) as any;
    assert.equal(result.recorded, true, JSON.stringify(result));
    answer = result.answer;
  });
  return { root, sidecar, transcripts, kind, id, issue, answer, posted,
    cleanup: () => { discard(root); discard(sidecar); discard(transcripts); } };
}

function writeTranscript(dir: string, prompt: string, requestId: string,
  verdict: "sound" | "unsound", rationale: string, receipt: string, slot: number): ApplicationReceiptRef {
  const agentId = `a1234567${slot}`;
  const session = `5e55a0a0-0000-0000-0000-00000000000${slot}`;
  const sub = join(dir, session, "subagents");
  mkdirSync(sub, { recursive: true });
  const launch = `toolu_launch_${agentId}`, call = `toolu_submit_${agentId}`;
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

async function reader(u: Awaited<ReturnType<typeof fixture>>, slot: number,
  verdict: "sound" | "unsound", rationale: string, readers?: ApplicationReceiptRef[]) {
  const brief = await applicationReaderBrief(u.root, { issue: u.issue, answerId: u.answer,
    slot, ...(slot === 3 ? { role: "arbitrator" as const, readers } : {}) }, u.transcripts) as any;
  assert.equal(brief.ok, true, JSON.stringify(brief));
  assert.equal(brief.directMention, false, "the issue ID was not shown as an exact mention");
  const held = submitApplicationVerdict(u.root, { requestId: brief.requestId, verdict, rationale }) as any;
  assert.equal(held.held, true, JSON.stringify(held));
  const ref = writeTranscript(u.transcripts, brief.prompt, brief.requestId, verdict, rationale, held.receipt, slot);
  const recorded = recordApplicationVerdict(u.root, ref, u.transcripts) as any;
  assert.equal(recorded.recorded, true, JSON.stringify(recorded));
  return { brief, ref };
}

const issueRow = async (u: Awaited<ReturnType<typeof fixture>>) =>
  u.kind === "finding" ? readFinding(u.root, u.id) : readBug(u.root, u.id);
const applicationEvents = async (u: Awaited<ReturnType<typeof fixture>>) => {
  const scope = u.kind === "finding" ? `findings/${u.issue.universe}/pr-7` : `bugs/${u.issue.universe}`;
  return (await readScope(u.sidecar, scope)).filter((event) => event.kind === `${u.kind}.rulingApplied`);
};

test("indirect finding application needs two independent sound readers and closes once", async () => {
  const u = await fixture("finding");
  try {
    assert.equal(u.posted.ok, true, JSON.stringify(u.posted));
    await withActor(true, async () => {
      const first = await reader(u, 1, "sound", "The intended doubling rebuts this finding.");
      assert.match(error(await applyRuling(u.root, { issue: u.issue, answerId: u.answer,
        readers: [first.ref] }, u.transcripts)), /two independent sound readers/);
      assert.equal((await applicationEvents(u)).length, 0, "one sound reader spends nothing");
      const second = await reader(u, 2, "sound", "The stated intent defeats the charge premise.");
      const applied = await applyRuling(u.root, { issue: u.issue, answerId: u.answer,
        readers: [first.ref, second.ref] }, u.transcripts) as any;
      assert.equal(applied.ok, true, JSON.stringify(applied));
      assert.equal((await issueRow(u))?.state, "invalid");
      assert.equal((await applicationEvents(u)).length, 1);
      const retry = await applyRuling(u.root, { issue: u.issue, answerId: u.answer, readers: [] }, u.transcripts) as any;
      assert.equal(retry.application, applied.application);
      assert.equal((await applicationEvents(u)).length, 1);
    });
  } finally { u.cleanup(); }
});

test("indirect bug application preserves its typed target and needs two sound readers", async () => {
  const u = await fixture("bug");
  try {
    // The target is canonical metadata. Its ID is absent from the question and answer the person saw.
    assert.equal(u.posted.ok, true, JSON.stringify(u.posted));
    await withActor(true, async () => {
      const first = await reader(u, 1, "sound", "The ruling rebuts the reported bug.");
      assert.match(error(await applyRuling(u.root, { issue: u.issue, answerId: u.answer,
        readers: [first.ref] }, u.transcripts)), /two independent sound readers/);
      assert.equal((await applicationEvents(u)).length, 0);
      const second = await reader(u, 2, "sound", "The reported behavior is the intended policy.");
      const applied = await applyRuling(u.root, { issue: u.issue, answerId: u.answer,
        readers: [first.ref, second.ref] }, u.transcripts) as any;
      assert.equal(applied.ok, true, JSON.stringify(applied));
      assert.equal((await issueRow(u))?.state, "refuted");
      assert.equal((await applicationEvents(u)).length, 1);
    });
  } finally { u.cleanup(); }
});

test("disagreeing indirect readers need an independently launched arbitrator who sees both reasons", async () => {
  const u = await fixture("finding");
  try {
    assert.equal(u.posted.ok, true, JSON.stringify(u.posted));
    await withActor(true, async () => {
      const first = await reader(u, 1, "sound", "The doubling is intended.");
      const second = await reader(u, 2, "unsound", "The claim still describes an error.");
      assert.match(error(await applyRuling(u.root, { issue: u.issue, answerId: u.answer,
        readers: [first.ref, second.ref] }, u.transcripts)), /arbitrator/);
      assert.equal((await applicationEvents(u)).length, 0);
      const arbitration = await reader(u, 3, "sound", "The policy supports the intended doubling.",
        [first.ref, second.ref]);
      assert.match(arbitration.brief.prompt, /The doubling is intended/);
      assert.match(arbitration.brief.prompt, /The claim still describes an error/);
      const applied = await applyRuling(u.root, { issue: u.issue, answerId: u.answer,
        readers: [first.ref, second.ref], arbitrator: arbitration.ref }, u.transcripts) as any;
      assert.equal(applied.ok, true, JSON.stringify(applied));
      assert.equal((await issueRow(u))?.state, "invalid");
      assert.equal((await applicationEvents(u)).length, 1);
    });
  } finally { u.cleanup(); }
});

test("changed answer or bug claim after recorded reading refuses closure without spending", async () => {
  const changedAnswer = await fixture("finding", true);
  const changedClaim = await fixture("bug", true);
  try {
    for (const u of [changedAnswer, changedClaim]) assert.equal(u.posted.ok, true, JSON.stringify(u.posted));
    let oldAnswerRef!: ApplicationReceiptRef, oldClaimRef!: ApplicationReceiptRef;
    await withActor(true, async () => {
      const a = await applicationReaderBrief(changedAnswer.root, { issue: changedAnswer.issue,
        answerId: changedAnswer.answer, slot: 1 }, changedAnswer.transcripts) as any;
      const heldA = submitApplicationVerdict(changedAnswer.root, { requestId: a.requestId, verdict: "sound",
        rationale: "The original answer rebuts the finding." }) as any;
      oldAnswerRef = writeTranscript(changedAnswer.transcripts, a.prompt, a.requestId, "sound",
        "The original answer rebuts the finding.", heldA.receipt, 1);
      assert.equal((recordApplicationVerdict(changedAnswer.root, oldAnswerRef, changedAnswer.transcripts) as any).recorded, true);

      const b = await applicationReaderBrief(changedClaim.root, { issue: changedClaim.issue,
        answerId: changedClaim.answer, slot: 1 }, changedClaim.transcripts) as any;
      const heldB = submitApplicationVerdict(changedClaim.root, { requestId: b.requestId, verdict: "sound",
        rationale: "The original claim is answered." }) as any;
      oldClaimRef = writeTranscript(changedClaim.transcripts, b.prompt, b.requestId, "sound",
        "The original claim is answered.", heldB.receipt, 1);
      assert.equal((recordApplicationVerdict(changedClaim.root, oldClaimRef, changedClaim.transcripts) as any).recorded, true);
    });
    await withActor(false, async () => {
      const changed = await answerDirect(changedAnswer.root, { decision: "d1", option: "Real defect" }) as any;
      assert.equal(changed.recorded, true, JSON.stringify(changed));
    });
    await withActor(true, async () => {
      const changed = await updateBug(changedClaim.root, { id: changedClaim.id,
        description: "The charge is tripled" }) as any;
      assert.equal(changed.error, undefined, JSON.stringify(changed));
      assert.match(error(await applyRuling(changedAnswer.root, { issue: changedAnswer.issue,
        answerId: changedAnswer.answer, readers: [oldAnswerRef] }, changedAnswer.transcripts)), /no current verified authority|not a current ruling/);
      assert.match(error(await applyRuling(changedClaim.root, { issue: changedClaim.issue,
        answerId: changedClaim.answer, readers: [oldClaimRef] }, changedClaim.transcripts)), /another issue\/ruling version/);
    });
    assert.equal((await issueRow(changedAnswer))?.state, "issued");
    assert.notEqual((await issueRow(changedClaim))?.state, "invalid");
    for (const u of [changedAnswer, changedClaim]) assert.equal((await applicationEvents(u)).length, 0);
  } finally { changedAnswer.cleanup(); changedClaim.cleanup(); }
});
