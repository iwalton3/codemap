import { randomUUID, generateKeyPairSync, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireActor } from '../identity.js';
import type { SidecarConfig } from '../sidecar-config.js';
import type { Operation, Spec, AskedQuestion } from '../schema.js';
import { sidecarWriteDoor } from '../sidecar-config.js';
import { emitEventChecked, readScopeChecked } from '../eventlog.js';
import { foldStandard, lawScope, standardScope } from '../shared-standard.js';
import { materializeStandard } from '../standard-publish.js';
import { decisionScope, foldDecisions, answerHasCurrentAuthority, intentCandidates, comparisonRestricts } from '../shared-decisions.js';
import { operationContent, framingContent, contentDiff } from '../schema.js';
import { readReader, isUnverified, transcriptDir } from '../transcript.js';
import { saveReaderRequest, readerRequest, holdReaderReceipt, readerReceipts, settleReaderReceipt } from '../reader-local.js';
import { readRepairSigningKey, saveRepairSigningKey, readProposalWitnesses } from '../store.js';
import { operationSignoffProducerId, operationSignoffSignedBytes, operationSignoffDisplay, operationSignoffReaderPrompt, operationSignoffKey, signoffHash, validateOperationSignoff, SIGN_OPERATION, type OperationSignoffCapsule } from '../operation-signoff.js';
const PURPOSE = 'operation-signoff' as const;
export interface OperationSignoffReceiptRef {
  requestId: string;
  receipt: string;
  agentId: string;
  callId: string;
}
interface Brief {
  requestId: string;
  context: Pick<OperationSignoffCapsule, 'operationId' | 'specId' | 'content' | 'framing' | 'ruling'>;
  prompt: string;
}
function parsedBrief(root: string, requestId: string): Brief | undefined {
  try {
    const raw = readerRequest(root, { purpose: PURPOSE, requestId });
    return raw ? JSON.parse(raw) : undefined;
  }
  catch {
    return undefined;
  }
}
interface Context {
  cfg: SidecarConfig;
  op: Operation;
  spec: Spec;
  content: Record<string, string>;
  framing: Record<string, string>;
  payload: AskedQuestion;
  ruling?: OperationSignoffCapsule['ruling'];
}
async function context(root: string, input: {
  operationId: string;
  answerId?: string;
  ref?: string;
}): Promise<Context | {
  error: string;
}> {
  const door = sidecarWriteDoor(root);
  if (!door.cfg)
    return { error: door.error ?? 'operation sign-off requires a configured sidecar' };
  const cfg = door.cfg;
  const law = await readScopeChecked(cfg.path, lawScope());
  const evidence = await readScopeChecked(cfg.path, standardScope(cfg.universe));
  if (law.status !== 'complete' || evidence.status !== 'complete')
    return { error: 'the standard scope is blocked' };
  const state = foldStandard([...law.events, ...evidence.events]);
  const op = state.operations.find(o => o.id === input.operationId && !o.removed);
  const spec = state.specs.find(s => s.id === op?.specId);
  if (!op || !spec || spec.status !== 'draft')
    return { error: 'sign-off requires a current draft operation' };
  const content = operationContent(op), framing = framingContent(spec), payload = operationSignoffDisplay(op.id, spec.id, content, framing, input.ref);
  if (!input.answerId)
    return { cfg, op, spec, content, framing, payload };
  const source = await readScopeChecked(cfg.path, decisionScope(cfg.universe));
  if (source.status !== 'complete')
    return { error: 'the answer scope is blocked' };
  const decisions = foldDecisions(source.events);
  const pair = decisions.decisions.flatMap(d => d.answers.map(a => ({ d, a }))).find(x => x.a.id === input.answerId);
  if (!pair)
    return { error: 'no recorded human answer' };
  const { d, a } = pair;
  const scope = { kind: 'decision' as const, id: d.id, universe: cfg.universe, scope: decisionScope(cfg.universe) };
  if (!a.verified || a.sourceAnswer || a.cancelled || a.withdrawn || a.resolvedOutBy || a.elsewhere || a.revisionInvalid || d.withdrawn || d.withdrawals?.some(w => w.state === 'conflict') || !answerHasCurrentAuthority(d, a, scope))
    return { error: 'answer has no current verified human authority' };
  if (intentCandidates(decisions).some(c => c.answers.includes(a.id) && comparisonRestricts(decisions, c, scope)))
    return { error: 'answer awaits comparison or human resolution' };
  if (signoffHash(d.payload) !== signoffHash(operationSignoffDisplay(op.id, spec.id, content, framing, d.ref)) || a.options.length !== 1 || a.options[0] !== SIGN_OPERATION)
    return { error: 'answer does not sign the full exact operation presentation; plan-only answers sign nothing' };
  const ruling: OperationSignoffCapsule['ruling'] = { answerId: a.id, decisionId: d.id, ref: d.ref, universe: cfg.universe, sourceScope: decisionScope(cfg.universe), via:a.via, ...(a.sourceReceipt?{sourceReceipt:a.sourceReceipt}:{}), ...(a.questionnaire?{questionnaire:a.questionnaire}:{}), principal: a.by.principal, responseHash: a.responseHash, display: d.payload, selected: a.options, words: a.words, verified: true, status: 'current', comparison: 'clear', sourceFingerprint: signoffHash(source.events), checkedAt: new Date().toISOString() };
  return { cfg, op, spec, content, framing, payload, ruling };
}
export async function operationSignoffQuestion(root: string, input: {
  operationId: string;
  ref?: string;
}) {
  const c = await context(root, input);
  if ('error' in c)
    return c;
  return { ok: true as const, operationId: c.op.id, specId: c.spec.id, content: c.content, framing: c.framing, payload: c.payload };
}
export async function operationSignoffReaderBrief(root: string, input: {
  operationId: string;
  answerId: string;
}) {
  const c = await context(root, input);
  if ('error' in c)
    return c;
  const ruling = c.ruling!;
  const requestId = 'operation_reader_' + signoffHash([c.op.id, ruling.answerId, ruling.responseHash, c.content, c.framing, ruling.sourceFingerprint]).slice(7);
  const prior = parsedBrief(root, requestId);
  if (prior)
    ruling.checkedAt = prior.context.ruling.checkedAt;
  const frozen = { operationId: c.op.id, specId: c.spec.id, content: c.content, framing: c.framing, ruling };
  const prompt = operationSignoffReaderPrompt(requestId, frozen);
  const saved = saveReaderRequest(root, { purpose: PURPOSE, requestId }, JSON.stringify({ requestId, context: frozen, prompt }));
  if ('error' in saved)
    return saved;
  return { ok: true as const, requestId, prompt };
}
export function submitOperationSignoffVerdict(root: string, input: {
  requestId: string;
  verdict: 'sound' | 'unsound';
  rationale: string;
}) {
  if (!parsedBrief(root, input.requestId))
    return { error: 'no operation sign-off reader brief' };
  if (!['sound', 'unsound'].includes(input.verdict) || !input.rationale?.trim())
    return { error: 'reader verdict and rationale are required' };
  const receipt = randomUUID();
  const held = holdReaderReceipt(root, { purpose: PURPOSE, requestId: input.requestId }, receipt, JSON.stringify({ verdict: input.verdict, rationale: input.rationale }));
  return 'error' in held ? held : { ok: true as const, held: true as const, receipt };
}
interface VerifiedCall {
  agentId: string;
  callId: string;
  session: string;
  launch: string;
  launchedAt: string;
}
const resultObject = (v: unknown): any => {
  if (v && typeof v === "object") {
    if (Array.isArray(v))
      return resultObject(v.find((x) => x?.type === "text")?.text);
    if ((v as any).content && !(v as any).held)
      return resultObject((v as any).content);
    return v;
  }
  if (typeof v === "string") {
    try {
      return resultObject(JSON.parse(v));
    }
    catch {
      return undefined;
    }
  }
  return undefined;
};
function verifyCall(brief: Brief, receipt: string, body: {
  verdict: string;
  rationale: string;
}, agentId: string, callId: string, dir: string): VerifiedCall | {
  error: string;
} {
  const reader = readReader(agentId, callId, dir);
  if (isUnverified(reader))
    return { error: reader.unverified };
  if (reader.prompt !== brief.prompt)
    return { error: "reader launch did not use the exact issued operation sign-off brief" };
  let lines: any[];
  try {
    lines = readFileSync(join(dir, reader.session, "subagents", `agent-${agentId}.jsonl`), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }
  catch {
    return { error: "reader transcript is unreadable" };
  }
  const calls = lines.filter((e) => e.type === "assistant" && e.isSidechain === true && e.agentId === agentId)
    .flatMap((e) => (e.message?.content ?? []).filter((x: any) => x?.type === "tool_use" && x.id === callId).map((x: any) => ({ e, x })));
  if (calls.length !== 1 || !/(^|__)submit_operation_signoff_verdict$/.test(calls[0]!.x.name ?? ""))
    return { error: "reader's operation sign-off submit call was not found uniquely" };
  const submitted = calls[0]!.x.input;
  if (submitted?.requestId !== brief.requestId || submitted?.verdict !== body.verdict || submitted?.rationale !== body.rationale)
    return { error: "reader's submitted verdict differs from the held receipt" };
  const results = lines.filter((e) => e.type === "user" && e.isSidechain === true && e.agentId === agentId
    && Array.isArray(e.message?.content) && e.message.content.some((x: any) => x?.type === "tool_result" && x.tool_use_id === callId));
  if (results.length !== 1)
    return { error: "reader's submit call has no unique result" };
  const result = results[0]!;
  const blocks = Array.isArray(result.message?.content) ? result.message.content.filter((x: any) => x?.type === "tool_result") : [];
  if (blocks.length !== 1)
    return { error: "reader submit result is ambiguous" };
  const parsed = resultObject(result.toolUseResult) ?? resultObject(blocks[0]!.content);
  if (parsed?.ok !== true || parsed?.held !== true || parsed?.receipt !== receipt)
    return { error: "reader's successful submit receipt was not found" };
  return { agentId, callId, session: reader.session, launch: reader.toolUseId, launchedAt: reader.launchedAt };
}
function verifiedReceipt(root: string, ref: OperationSignoffReceiptRef, dir: string, recorded = true) {
  const brief = parsedBrief(root, ref?.requestId);
  if (!brief)
    return { error: 'operation reader brief is missing' };
  const held = readerReceipts(root, { purpose: PURPOSE, requestId: ref.requestId }).find(r => r.receipt === ref.receipt);
  if (held?.state === 'recorded' && held.call !== ref.callId) return {error:'reader receipt was recorded from another call'};
  if (!held || (recorded && (held.state !== 'recorded' || held.call !== ref.callId)))
    return { error: 'operation reader receipt is not recorded and verified' };
  if (!['pending', 'recorded'].includes(held.state))
    return { error: 'reader receipt is not actionable' };
  let body: {
    verdict: 'sound' | 'unsound';
    rationale: string;
  };
  try {
    body = JSON.parse(held.body);
  }
  catch {
    return { error: 'malformed reader verdict' };
  }
  const call = verifyCall(brief, ref.receipt, body, ref.agentId, ref.callId, dir);
  if ('error' in call)
    return call;
  return { brief, body, call };
}
export function recordOperationSignoffVerdict(root: string, input: OperationSignoffReceiptRef, dir = transcriptDir()) {
  const checked = verifiedReceipt(root, input, dir, false);
  if ('error' in checked)
    return { pending: true as const, reason: checked.error };
  const settled = settleReaderReceipt(root, { purpose: PURPOSE, requestId: input.requestId }, input.receipt, 'recorded', undefined, input.callId);
  return 'error' in settled ? settled : { ok: true as const, recorded: true as const };
}
export async function applyOperationSignoff(root: string, input: {
  operationId: string;
  answerId: string;
  reader: OperationSignoffReceiptRef;
}, dir = transcriptDir()) {
  const initial = await context(root, input);
  if ('error' in initial)
    return initial;
  const { sharedPull } = await import('../ops-shared.js');
  try {
    const pull = await sharedPull(root);
    if ('error' in pull)
      return { error: `pull refused before sign-off: ${pull.error}` };
  }
  catch (e) {
    return { error: `pull failed before sign-off: ${String(e)}` };
  }
  const actor = requireActor(root, { agent: true });
  if ('error' in actor)
    return actor;
  let signingKey = readRepairSigningKey(root);
  if (!signingKey) {
    const pair = generateKeyPairSync('ed25519');
    signingKey = { publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
    saveRepairSigningKey(root, signingKey);
  }
  if (createPublicKey(signingKey.privateKey).export({ type: 'spki', format: 'pem' }) !== signingKey.publicKey || createPrivateKey(signingKey.privateKey).asymmetricKeyType !== 'ed25519')
    return { error: 'invalid local operation sign-off producer key' };
  const key = signingKey;
  const producerKeyId = operationSignoffProducerId(key.publicKey);
  const registered = await emitEventChecked(initial.cfg.path, lawScope(), actor, async (events) => {
    const prior = events.find(e => e.kind === 'spec.operation-signoff-producer' && e.subject === producerKeyId);
    if (prior)
      return prior.actor.principal === actor.principal ? { existing: prior } : { error: 'operation sign-off producer belongs to another principal' };
    return { kind: 'spec.operation-signoff-producer', subject: producerKeyId, data: { publicKey: key.publicKey } };
  });
  if ('error' in registered)
    return registered;
  const event = await emitEventChecked(initial.cfg.path, lawScope(), actor, async (events) => {
    const c = await context(root, input);
    if ('error' in c)
      return c;
    const state = foldStandard(events);
    const op = state.operations.find(o => o.id === input.operationId);
    const spec = state.specs.find(s => s.id === op?.specId);
    if (!op || !spec)
      return { error: 'operation disappeared before append' };
    const changes = [...contentDiff(initial.content, c.content), ...contentDiff(initial.framing, c.framing)];
    if (changes.length)
      return { error: `content changed during pull: ${changes.map(x => x.field).join(', ')}` };
    const checked = verifiedReceipt(root, input.reader, dir);
    if ('error' in checked)
      return checked;
    const frozen = checked.brief.context;
    c.ruling!.checkedAt = frozen.ruling.checkedAt;
    if (signoffHash(frozen) !== signoffHash({ operationId: op.id, specId: spec.id, content: c.content, framing: c.framing, ruling: c.ruling }))
      return { error: 'operation, context, or answer changed since the independent reading' };
    const body: Omit<OperationSignoffCapsule, 'seal'> = { version: 1, key: operationSignoffKey(op.id, input.answerId), ...frozen, executor: actor, reader: { id: input.reader.receipt, requestId: input.reader.requestId, session: checked.call.session, launch: checked.call.launch, callId: input.reader.callId, prompt: checked.brief.prompt, displayHash: signoffHash(frozen.ruling), verdict: checked.body.verdict as 'sound', rationale: checked.body.rationale } };
    const capsule: OperationSignoffCapsule = { ...body, seal: { producerKeyId, publicKey: key.publicKey, signature: sign(null, operationSignoffSignedBytes(body), key.privateKey).toString('base64') } };
    const valid = validateOperationSignoff(capsule, op, spec, actor, key.publicKey);
    if ('error' in valid)
      return valid;
    const existing = events.find(e => e.kind === 'spec.operation-signoff-applied' && (e.data?.capsule as any)?.key === capsule.key);
    if (existing)
      return { existing };
    return { kind: 'spec.operation-signoff-applied', subject: op.id, data: { capsule } };
  });
  if ('error' in event)
    return event;
  const folded = await materializeStandard(root, initial.cfg);
  const witness = (await readProposalWitnesses(root, { specId: initial.spec.id })).find(w => w.application?.key === operationSignoffKey(input.operationId, input.answerId));
  return witness ? { ok: true as const, application: event.id, folded } : { error: 'sign-off act is durable but no accepted witness is projected; sync and inspect the scope' };
}
