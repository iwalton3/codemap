/** Exact operation approval carried into workspace law without delegating ratification. */
import { createHash } from 'node:crypto';
import { framingContent, operationContent, witnessHash, type Actor, type AskedQuestion, type Operation, type Spec, type OperationSignoffCapsule } from './schema.js';
import { canonical } from './transcript.js';
export const SIGN_OPERATION = 'Sign off this exact operation';
export const PLAN_ONLY = 'Plan only';
export const signoffHash = (value: unknown) => 'sha256:' + createHash('sha256').update(canonical(value)).digest('hex');
export function operationSignoffDisplay(operationId: string, specId: string, content: Record<string, string>, framing: Record<string, string>, ref = "D1"): AskedQuestion {
  return {
    multiSelect: false,
    question: `${ref}: Review operation ${operationId} in spec ${specId}. Sign-off covers only this exact operation; ratification and framing approval are separate.
Choose "${SIGN_OPERATION}" only if you have read and approve the complete operation and its shown context under your identity. Choose "${PLAN_ONLY}" to record a plan-only ruling without signing any operation or framing.
${JSON.stringify({ operationId, specId, content, framing }, null, 2)}`,
    options: [{ label: SIGN_OPERATION }, { label: PLAN_ONLY }],
  };
}
export type { OperationSignoffCapsule } from "./schema.js";
export const operationSignoffKey = (operationId: string, answerId: string) => 'op_sign_' + signoffHash([operationId, answerId]).slice(7);
const word = (x: unknown): x is string => typeof x === 'string' && !!x.trim();
/**
 * `current: false` is the FOLD's call (D7: F58). The op checks the capsule against the operation's
 * text now; the fold must not, because "now" is the fold position, and a concurrent A→B→A edit
 * then decided admission by where it happened to sort. The fold records what was signed, and
 * ratification's `reviewGap` counts it iff that text is the text at ratification.
 */
export function validateOperationSignoff(value: unknown, op: Operation, spec: Spec, executor?: Actor, opts: { current?: boolean } = {}): {
  capsule: OperationSignoffCapsule;
} | {
  error: string;
} {
  try {
    const c = value as OperationSignoffCapsule;
    if (!c || c.version !== 1 || c.operationId !== op.id || c.specId !== spec.id || op.specId !== spec.id || spec.status !== 'draft' || op.removed)
      return { error: 'sign-off requires the exact current draft operation' };
    const contentMap = (v: unknown): v is Record<string, string> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(x => typeof x === 'string');
    if (!contentMap(c.content) || !contentMap(c.framing))
      return { error: 'sign-off content must be exact string field maps' };
    if (opts.current !== false && (witnessHash(c.content) !== witnessHash(operationContent(op)) || witnessHash(c.framing) !== witnessHash(framingContent(spec))))
      return { error: 'operation or framing content differs from the human presentation' };
    const r = c.ruling;
    if (!r || ![r.answerId, r.decisionId, r.ref, r.universe, r.sourceScope, r.via, r.principal, r.responseHash, r.sourceFingerprint, r.checkedAt].every(word) || !Number.isFinite(Date.parse(r.checkedAt)) || typeof r.words !== 'string' || r.verified !== true || r.status !== 'current' || r.comparison !== 'clear')
      return { error: 'sign-off lacks current verified human authority' };
    if (r.sourceScope !== `decisions/${r.universe}`) return {error:'answer source scope is invalid'};
    if (canonical(r.display) !== canonical(operationSignoffDisplay(op.id, spec.id, c.content, c.framing, r.ref)) || !Array.isArray(r.selected) || r.selected.length !== 1 || r.selected[0] !== SIGN_OPERATION)
      return { error: 'the full human presentation does not explicitly sign this operation' };
    if (c.key !== operationSignoffKey(op.id, r.answerId) || !c.executor || !word(c.executor.principal) || (executor && canonical(executor) !== canonical(c.executor)))
      return { error: 'sign-off identity or executor differs from the act' };
    const reader = c.reader;
    if (!reader || ![reader.id, reader.requestId, reader.session, reader.launch, reader.callId, reader.prompt, reader.rationale].every(word) || reader.verdict !== 'sound' || reader.displayHash !== signoffHash(r))
      return { error: 'independent reader receipt is missing or unbound' };
    const expected = operationSignoffReaderPrompt(reader.requestId, { operationId: op.id, specId: spec.id, content: c.content, framing: c.framing, ruling: r });
    if (reader.prompt !== expected)
      return { error: 'reader did not receive the complete exact operation and human answer' };
    return { capsule: c };
  }
  catch {
    return { error: 'malformed operation sign-off capsule' };
  }
}
export function operationSignoffReaderPrompt(requestId: string, context: Pick<OperationSignoffCapsule, 'operationId' | 'specId' | 'content' | 'framing' | 'ruling'>): string {
  return JSON.stringify({ purpose: 'operation-signoff', requestId, ...context,
    task: 'Independently decide whether this exact human answer signs off the complete shown operation and context. '
      + 'Plan-only approval, matching labels with contradictory text, or partial approval are unsound. Do not approve '
      + 'framing, other operations, or ratification. Call submit_operation_signoff_verdict with sound or unsound and your rationale.' });
}
