import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { team, settle } from '../oracle.js';
import { draftSpec, addOperation, reviseOperation, reviseSpec, ratifySpec } from '../requirements.js';
import { postRound, answerDirect, withdrawDecision } from './decisions.js';
import { readProposalWitnesses } from '../store.js';
import { readScopeChecked } from '../eventlog.js';
import { resolveSidecar } from '../sidecar-config.js';
import { lawScope, foldStandard, reviewGap } from '../shared-standard.js';
import { operationSignoffQuestion, operationSignoffReaderBrief, submitOperationSignoffVerdict, recordOperationSignoffVerdict, applyOperationSignoff } from './operation-signoff.js';
import { PLAN_ONLY, SIGN_OPERATION } from '../operation-signoff.js';
import { discard } from '../test-tmp.js';
const ok = (r: any) => { assert.equal(r.error, undefined, JSON.stringify(r)); return r; };
function transcript(dir: string, prompt: string, requestId: string, receipt: string, verdict: "sound"|"unsound" = "sound") {
  const agentId = 'a12345678', sessionId = '5e55a0a0-0000-0000-0000-000000000001', launch = 'toolu_launch', callId = 'toolu_submit', rationale = 'The human approves the full exact operation, separately from ratification.';
  const sub = join(dir, sessionId, 'subagents');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'general-purpose', toolUseId: launch }));
  writeFileSync(join(sub, `agent-${agentId}.jsonl`), [
    { type: 'user', isSidechain: true, agentId, sessionId, message: { role: 'user', content: prompt } },
    { type: 'assistant', isSidechain: true, agentId, sessionId, message: { content: [{ type: 'tool_use', id: callId, name: 'mcp__codemap__submit_operation_signoff_verdict', input: { requestId, verdict, rationale } }] } },
    { type: 'user', isSidechain: true, agentId, sessionId, message: { content: [{ type: 'tool_result', tool_use_id: callId, content: JSON.stringify({ ok: true, held: true, receipt }) }] } }
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  writeFileSync(join(dir, `${sessionId}.jsonl`), [
    { type: 'assistant', isSidechain: false, timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id: launch, name: 'Agent', input: { prompt, subagent_type: 'general-purpose' } }] } },
    { type: 'user', isSidechain: false, message: { content: [{ type: 'tool_result', tool_use_id: launch, content: 'launched' }] }, toolUseResult: { agentId } }
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  return { requestId, receipt, agentId, callId };
}
async function fixture(option = SIGN_OPERATION, contradict = false) {
  const t = await team(['alice@acme.test', 'bob@acme.test']);
  const [a, b] = t.all;
  const tx = mkdtempSync(join(tmpdir(), 'codemap-operation-tx-'));
  const spec = ok(await draftSpec(a!.repo, { title: 'Credit policy', narrative: 'Approval context' }));
  const operation = ok(await addOperation(a!.repo, { specId: spec.id, kind: 'add_requirement', title: 'Credit limit', statement: 'Do not exceed approved credit.', section: 'Credit', provenance: 'Owner', rationale: 'Bound exposure', reversibility: 'reversible' }));
  const sibling = ok(await addOperation(a!.repo, { specId: spec.id, kind: 'add_requirement', title: 'Settlement', statement: 'Settle daily.', section: 'Settlement', provenance: 'Owner', rationale: 'Bound delay', reversibility: 'reversible' }));
  const question = ok(await operationSignoffQuestion(a!.repo, { operationId: operation.id }));
  if (contradict)
    question.payload.options[0].description = 'Do not sign any operation.';
  ok(await postRound(a!.repo, { round: { id: 'R1', source: 'operation' }, decisions: [{ id: 'd1', round: 'R1', ref: 'D1', kind: 'options', payload: question.payload, options: [{ label: SIGN_OPERATION, effects: [] }, { label: PLAN_ONLY, effects: [] }] }] }));
  const answer = ok(await answerDirect(a!.repo, { decision: 'd1', option }));
  await settle(t);
  return { t, a: a!, b: b!, tx, spec, operation, sibling, answer: answer.answer, cleanup: () => { t.dispose(); discard(tx); } };
}
async function reader(u: Awaited<ReturnType<typeof fixture>>, verdict: "sound"|"unsound" = "sound") {
  const brief = ok(await operationSignoffReaderBrief(u.b.repo, { operationId: u.operation.id, answerId: u.answer }));
  const held = ok(submitOperationSignoffVerdict(u.b.repo, { requestId: brief.requestId, verdict, rationale: 'The human approves the full exact operation, separately from ratification.' }));
  const missingNative = recordOperationSignoffVerdict(u.b.repo, { requestId: brief.requestId, receipt: held.receipt, agentId: '5e55a0a0-0000-0000-0000-000000000002', callId: 'native-call' }, u.tx) as any;
  assert.equal(missingNative.pending, true, "unproven native provenance grants no recorded reader");
  assert.match(missingNative.reason,/native|Codex|unsupported/i);
  const ref = transcript(u.tx, brief.prompt, brief.requestId, held.receipt, verdict);
  assert.equal((recordOperationSignoffVerdict(u.b.repo, ref, u.tx) as any).recorded, true);
  return ref;
}
test('Alice exact approval applied by Bob agent signs only the named operation and replays to both clones', async () => {
  const u = await fixture();
  try {
    const ref = await reader(u);
    ok(await applyOperationSignoff(u.b.repo, { operationId: u.operation.id, answerId: u.answer, reader: ref }, u.tx));
    await settle(u.t);
    for (const m of [u.a, u.b]) {
      const witnesses = await readProposalWitnesses(m.repo, { specId: u.spec.id });
      assert.equal(witnesses.length, 1);
      const w = witnesses[0]!;
      assert.equal(w.reviewer.principal, 'alice@acme.test');
      assert.equal(w.operationId, u.operation.id);
      assert.equal(w.application?.executor.principal, 'bob@acme.test');
      assert.equal(w.application?.executor.via?.kind, 'agent');
      const cfg = resolveSidecar(m.repo)!;
      const events = await readScopeChecked(cfg.path, lawScope());
      const f = foldStandard(events.events);
      const gap = reviewGap(f.specs[0]!, f.operations, f.witnesses, 'alice@acme.test');
      assert.equal(gap.framing?.state, 'unwitnessed');
      assert.deepEqual(gap.unwitnessed.map(x => x.id), [u.sibling.id]);
    }
    assert.match(String((await ratifySpec(u.a.repo, u.spec.id) as any).error), /sign|read|review/i);
    const cfg = resolveSidecar(u.a.repo)!;
    const events = (await readScopeChecked(cfg.path, lawScope())).events;
    const application = events.find(e => e.kind === 'spec.operation-signoff-applied')!;
    assert.ok(application);
    for (const corrupt of [undefined, { ...(application.data!.capsule as any), ruling: { ...(application.data!.capsule as any).ruling, selected: [PLAN_ONLY] } }, { ...(application.data!.capsule as any), reader: undefined }]) {
      const forged = { ...application, data: { capsule: corrupt } };
      assert.equal(foldStandard(events.filter(e => e.id !== application.id).concat(forged)).witnesses.length, 0);
    }
  }
  finally {
    u.cleanup();
  }
});
test('plan-only and matching label with contradictory action cannot produce an operation reader', async () => {
  for (const args of [[PLAN_ONLY, false], [SIGN_OPERATION, true]] as const) {
    const u = await fixture(args[0], args[1]);
    try {
      assert.match(String((await operationSignoffReaderBrief(u.b.repo, { operationId: u.operation.id, answerId: u.answer }) as any).error), /full exact|plan-only/);
      assert.equal((await readProposalWitnesses(u.b.repo, { specId: u.spec.id })).length, 0);
    }
    finally {
      u.cleanup();
    }
  }
});
test('missing reader, changed operation and withdrawn answer leave signatures absent', async () => {
  const u = await fixture();
  try {
    const missing = await applyOperationSignoff(u.b.repo, { operationId: u.operation.id, answerId: u.answer, reader: undefined as any }, u.tx);
    assert.match(String((missing as any).error), /reader brief/);
    const ref = await reader(u);
    ok(await reviseOperation(u.a.repo, { operationId: u.operation.id, statement: 'Revised credit law' }));
    await settle(u.t);
    assert.match(String((await applyOperationSignoff(u.b.repo, { operationId: u.operation.id, answerId: u.answer, reader: ref }, u.tx) as any).error), /presentation|changed/);
    assert.equal((await readProposalWitnesses(u.b.repo, { specId: u.spec.id })).length, 0);
  }
  finally {
    u.cleanup();
  }
  const v = await fixture();
  try {
    const ref = await reader(v);
    ok(await withdrawDecision(v.a.repo, { decision: 'd1', answer: v.answer, reason: 'No longer approving' }));
    await settle(v.t);
    assert.match(String((await applyOperationSignoff(v.b.repo, { operationId: v.operation.id, answerId: v.answer, reader: ref }, v.tx) as any).error), /authority/);
    assert.equal((await readProposalWitnesses(v.b.repo, { specId: v.spec.id })).length, 0);
  }
  finally {
    v.cleanup();
  }
});

test('framing movement, pending cross-principal comparison, and failed pull refuse pending signatures', async () => {
  for (const mode of ['framing','conflict','pull']) {
    const u=await fixture();
    try {
      const ref=await reader(u);
      if(mode==='framing') {ok(await reviseSpec(u.a.repo,{specId:u.spec.id,narrative:'Changed approval context'}));await settle(u.t);}
      if(mode==='conflict') {ok(await answerDirect(u.b.repo,{decision:'d1',option:PLAN_ONLY}));await settle(u.t);}
      if(mode==='pull') {assert.equal(spawnSync('git',['remote','set-url','origin',join(u.tx,'missing-origin')],{cwd:u.b.sidecar}).status,0);}
      const result=await applyOperationSignoff(u.b.repo,{operationId:u.operation.id,answerId:u.answer,reader:ref},u.tx) as any;
      assert.match(String(result.error),mode==='pull'?/pull/i:mode==='conflict'?/comparison|authority|resolution/i:/presentation|context|changed/i);
      assert.equal((await readProposalWitnesses(u.b.repo,{specId:u.spec.id})).length,0);
    } finally {u.cleanup();}
  }
});

test('a genuinely recorded unsound reader cannot grant sign-off', async () => {
  const u=await fixture();
  try {
    const ref=await reader(u,'unsound');
    assert.match(String((await applyOperationSignoff(u.b.repo,{operationId:u.operation.id,answerId:u.answer,reader:ref},u.tx) as any).error),/reader receipt/i);
    assert.equal((await readProposalWitnesses(u.b.repo,{specId:u.spec.id})).length,0);
  } finally {u.cleanup();}
});
