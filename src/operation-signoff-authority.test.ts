import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { testChain } from "./test-events.js";
import { foldStandard, reviewGap } from "./shared-standard.js";
import { operationContent, framingContent, type Actor, type Operation, type Spec, type OperationSignoffCapsule } from "./schema.js";
import { operationSignoffDisplay, operationSignoffKey, operationSignoffReaderPrompt, operationSignoffProducerId, operationSignoffSignedBytes, signoffHash, SIGN_OPERATION } from "./operation-signoff.js";

const executor: Actor = { principal: "bob@acme.test", via: { kind: "agent", model: "coordinator" } };
const principal: Actor = { principal: "alice@acme.test" };
const spec: Spec = { id: "sp_authority", title: "Credit rule", narrative: "Bounded credit context", status: "draft", author: executor, createdAt: "2026-09-26T00:00:00Z" };
const op: Operation = { id: "op_authority", specId: spec.id, ord: 0, kind: "add_requirement", title: "Credit limit", statement: "Do not exceed approved credit.", section: "Credit", provenance: "Human", rationale: "Bound exposure", reversibility: "reversible" };

function fixture() {
  const key = generateKeyPairSync("ed25519");
  const publicKey = key.publicKey.export({ type: "spki", format: "pem" }).toString();
  const producerKeyId = operationSignoffProducerId(publicKey);
  const content = operationContent(op), framing = framingContent(spec);
  const ruling: OperationSignoffCapsule["ruling"] = { answerId: "native-answer", decisionId: "decision", ref: "D1", universe: "acme/api", sourceScope: "decisions/acme/api", via: "web", principal: principal.principal, responseHash: "source-response", display: operationSignoffDisplay(op.id, spec.id, content, framing), selected: [SIGN_OPERATION], words: "Sign off this exact operation", verified: true, status: "current", comparison: "clear", sourceFingerprint: "source-events", checkedAt: "2026-09-26T00:00:00Z" };
  const context = { operationId: op.id, specId: spec.id, content, framing, ruling };
  const body: Omit<OperationSignoffCapsule, "seal"> = { version: 1, key: operationSignoffKey(op.id, ruling.answerId), ...context, executor,
    reader: { id: "receipt", requestId: "request", session: "fresh-reader", launch: "launch", callId: "call", prompt: operationSignoffReaderPrompt("request", context), displayHash: signoffHash(ruling), verdict: "sound", rationale: "The full exact operation is approved, separately from ratification." } };
  const signed = (value: Omit<OperationSignoffCapsule, "seal"> | OperationSignoffCapsule): OperationSignoffCapsule => ({ ...value, seal: { producerKeyId, publicKey, signature: sign(null, operationSignoffSignedBytes(value), key.privateKey).toString("base64") } });
  const capsule = signed(body);
  const before = testChain("signoff-authority", [
    { id: "draft", kind: "spec.drafted", subject: spec.id, actor: executor, data: { spec } },
    { id: "operation", kind: "spec.operation", subject: op.id, actor: executor, data: { operation: op } },
    { id: "sibling", kind: "spec.operation", subject: "op_sibling", actor: executor, data: { operation: { ...op, id: "op_sibling", ord: 1 } } },
    { id: "producer", kind: "spec.operation-signoff-producer", subject: producerKeyId, actor: executor, data: { publicKey } },
  ]);
  const applied = (c: unknown, actor = executor) => ({ ...before[3]!, id: "application", writerPrev: "producer", kind: "spec.operation-signoff-applied", subject: op.id, actor, data: { capsule: c } });
  return { capsule, before, applied, signed, publicKey, producerKeyId };
}

test("registered sign-off seals bind every authority field and sign only exact shown operation", () => {
  const f = fixture();
  const good = foldStandard([...f.before, f.applied(f.capsule)]);
  assert.equal(good.witnesses.length, 1); assert.deepEqual(good.witnesses[0]!.reviewer, principal);
  assert.equal(good.specs[0]!.status, "draft"); assert.equal(good.requirements.length, 0);
  const gap = reviewGap(good.specs[0]!, good.operations, good.witnesses, principal.principal);
  assert.equal(gap.framing?.state, "unwitnessed"); assert.deepEqual(gap.unwitnessed.map(o => o.id), ["op_sibling"]);
  for (const mutate of [
    (c: OperationSignoffCapsule) => delete (c as Partial<OperationSignoffCapsule>).seal,
    (c: OperationSignoffCapsule) => c.ruling.principal = "stranger@acme.test",
    (c: OperationSignoffCapsule) => c.ruling.words = "Do not sign this operation",
    (c: OperationSignoffCapsule) => c.reader.rationale = "Invented approval",
    (c: OperationSignoffCapsule) => c.reader.session = "another-reader",
    (c: OperationSignoffCapsule) => c.executor = principal,
    (c: OperationSignoffCapsule) => c.content.statement = "Different credit law",
    (c: OperationSignoffCapsule) => c.framing.narrative = "Different approval context",
    (c: OperationSignoffCapsule) => c.seal.signature = "invented",
  ]) {
    const bad = structuredClone(f.capsule); mutate(bad);
    assert.equal(foldStandard([...f.before, f.applied(bad)]).witnesses.length, 0);
  }
  assert.equal(foldStandard(f.before.filter(e => e.kind !== "spec.operation-signoff-producer").concat(f.applied(f.capsule))).witnesses.length, 0);
  assert.equal(foldStandard([...f.before, f.applied(f.capsule, principal)]).witnesses.length, 0, "signed executor cannot be replaced by event actor");
  const wrongScope = f.signed({ ...f.capsule, ruling: { ...f.capsule.ruling, sourceScope: "decisions/another/api" } });
  assert.equal(foldStandard([...f.before, f.applied(wrongScope)]).witnesses.length, 0, "even a signed capsule must have the answer's exact universe scope");
});

test("producer registration cannot be taken over by another principal or replaced key", () => {
  const f = fixture();
  const rogue = { principal: "rogue@acme.test", via: { kind: "agent" as const, model: "forger" } };
  const reassigned = { ...f.before[3]!, id: "replace-principal", writerPrev: "producer", actor: rogue };
  const rogueCapsule = f.signed({ ...f.capsule, executor: rogue });
  assert.equal(foldStandard([...f.before, reassigned, { ...f.applied(rogueCapsule, rogue), writerPrev: reassigned.id }]).witnesses.length, 0);
  const newKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  const replaced = { ...f.before[3]!, id: "replace-key", writerPrev: "producer", data: { publicKey: newKey } };
  assert.equal(foldStandard([...f.before, replaced, { ...f.applied(f.capsule), writerPrev: replaced.id }]).witnesses.length, 1, "invalid replacement cannot erase a legitimate producer");
  const fake = { ...f.capsule, seal: { ...f.capsule.seal, publicKey: newKey } };
  assert.equal(foldStandard([...f.before, f.applied(fake)]).witnesses.length, 0);
});
