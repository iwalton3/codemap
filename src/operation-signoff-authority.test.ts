/**
 * What the standard fold credits from an operation sign-off an agent relayed.
 *
 * The capsule carries a copy of the person's answer; the op checked that copy against the
 * decisions log when it wrote the event, and the FOLD checks the copy itself: it credits the
 * answer's principal only where that answer signs this exact operation (owner, 2026-09-28,
 * "It cites that person's real answer" and "Embedded answer"). Forgery is out of scope, so the
 * cases below are the mistakes an agent can make, each made internally consistent where it can
 * be — a copy whose hashes were recomputed must still be refused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isLogDamage } from "./log-damage.js";
import { testChain } from "./test-events.js";
import { foldStandard, reviewGap } from "./shared-standard.js";
import { operationContent, framingContent, type Actor, type Operation, type Spec, type OperationSignoffCapsule } from "./schema.js";
import { operationSignoffDisplay, operationSignoffKey, operationSignoffReaderPrompt, signoffHash, PLAN_ONLY, SIGN_OPERATION } from "./operation-signoff.js";

const executor: Actor = { principal: "bob@acme.test", via: { kind: "agent", model: "coordinator" } };
const principal: Actor = { principal: "alice@acme.test" };
const spec: Spec = { id: "sp_authority", title: "Credit rule", narrative: "Bounded credit context", status: "draft", author: executor, createdAt: "2026-09-26T00:00:00Z" };
const op: Operation = { id: "op_authority", specId: spec.id, ord: 0, kind: "add_requirement", title: "Credit limit", statement: "Do not exceed approved credit.", section: "Credit", provenance: "Human", rationale: "Bound exposure", reversibility: "reversible" };
const sibling: Operation = { ...op, id: "op_sibling", ord: 1 };

/** A capsule whose every derived field is recomputed from `ruling`, as a careful agent would. */
function capsuleFor(ruling: OperationSignoffCapsule["ruling"]): OperationSignoffCapsule {
  const context = { operationId: op.id, specId: spec.id, content: operationContent(op), framing: framingContent(spec), ruling };
  return { version: 1, key: operationSignoffKey(op.id, ruling.answerId), ...context, executor,
    reader: { id: "receipt", requestId: "request", session: "fresh-reader", launch: "launch", callId: "call",
      prompt: operationSignoffReaderPrompt("request", context), displayHash: signoffHash(ruling), verdict: "sound",
      rationale: "The full exact operation is approved, separately from ratification." } };
}

const answer = (over: Partial<OperationSignoffCapsule["ruling"]> = {}): OperationSignoffCapsule["ruling"] => ({
  answerId: "answer", decisionId: "decision", ref: "D1", universe: "acme/api", sourceScope: "decisions/acme/api", via: "direct",
  principal: principal.principal, responseHash: "response", display: operationSignoffDisplay(op.id, spec.id, operationContent(op), framingContent(spec)),
  selected: [SIGN_OPERATION], words: SIGN_OPERATION, verified: true, status: "current", comparison: "clear",
  sourceFingerprint: "source-events", checkedAt: "2026-09-26T00:00:00Z", ...over,
});

const before = testChain("signoff-authority", [
  { id: "draft", kind: "spec.drafted", subject: spec.id, actor: executor, data: { spec } },
  { id: "operation", kind: "spec.operation", subject: op.id, actor: executor, data: { operation: op } },
  { id: "sibling", kind: "spec.operation", subject: sibling.id, actor: executor, data: { operation: sibling } },
]);
const applied = (c: unknown, actor = executor) => ({ ...before[2]!, id: "application", writerPrev: "sibling",
  kind: "spec.operation-signoff-applied", subject: op.id, actor, data: { capsule: c } });
const credited = (c: unknown, actor = executor) => foldStandard([...before, applied(c, actor)]).witnesses;
/** Why the fold halts on this application (plan 1.2): no conforming build writes one it refuses. */
const halts = (c: unknown, actor = executor): string | undefined => {
  try { credited(c, actor); return undefined; } catch (e) { if (isLogDamage(e)) return e.entry.why; throw e; }
};

test("a relayed sign-off credits the person whose answer it carries, for that operation only", () => {
  const w = credited(capsuleFor(answer()));
  assert.equal(w.length, 1);
  assert.deepEqual(w[0]!.reviewer, principal);
  const s = foldStandard([...before, applied(capsuleFor(answer()))]);
  assert.equal(s.specs[0]!.status, "draft", "a sign-off ratifies nothing");
  const gap = reviewGap(s.specs[0]!, s.operations, s.witnesses, principal.principal);
  assert.equal(gap.framing?.state, "unwitnessed");
  assert.deepEqual(gap.unwitnessed.map((o) => o.id), [sibling.id]);
});

test("an answer that does not sign this exact operation credits nobody, however consistent the copy", () => {
  const cases: [string, OperationSignoffCapsule["ruling"]][] = [
    ["a plan-only answer", answer({ selected: [PLAN_ONLY], words: PLAN_ONLY })],
    ["an answer to another operation's question", answer({ display: operationSignoffDisplay(sibling.id, spec.id, operationContent(sibling), framingContent(spec)) })],
    ["an answer shown different text", answer({ display: operationSignoffDisplay(op.id, spec.id, { ...operationContent(op), statement: "Other law" }, framingContent(spec)) })],
    ["an unverified answer", answer({ verified: false as true })],
    ["an answer from another universe's log", answer({ sourceScope: "decisions/another/api" })],
    ["a withdrawn or outranked answer", answer({ status: "superseded" as "current" })],
  ];
  for (const [name, ruling] of cases) assert.ok(halts(capsuleFor(ruling)), `${name} credits nobody: the log halts on it`);
});

test("a copy edited after the reading, or recorded by someone other than its executor, credits nobody", () => {
  for (const mutate of [
    (c: OperationSignoffCapsule) => { c.ruling.principal = "stranger@acme.test"; },
    (c: OperationSignoffCapsule) => { c.ruling.words = "Do not sign this operation"; },
    (c: OperationSignoffCapsule) => { c.content.statement = "Different credit law"; },
    (c: OperationSignoffCapsule) => { c.framing.narrative = "Different approval context"; },
    (c: OperationSignoffCapsule) => { c.reader.verdict = "unsound" as "sound"; },
  ]) {
    const bad = capsuleFor(answer()); mutate(bad);
    assert.ok(halts(bad), String(mutate));
  }
  assert.ok(halts(capsuleFor(answer()), principal), "the event's actor must be the capsule's executor");
});
