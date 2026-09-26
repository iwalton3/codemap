import { test } from "node:test";
import assert from "node:assert/strict";
import { RepairSealService, verifyRepairSeal, type RepairSigningKey, type RepairVerificationSeal } from "./repair-seals.js";
import { RepairVerifierBoundary, type RepairParticipant, type RepairSealCapability } from "./verifier-boundary.js";

const who = { principal: "owner", harness: "codex", session: "fresh-direct-child", child: "fresh-direct-child", model: "same-model" };
const makeBoundary = (participants: () => RepairParticipant[] = () => []) => new RepairVerifierBoundary({
  context: { supported: true, identity: who }, participants,
});
function fixture() {
  let stored: RepairSigningKey | undefined;
  let saves = 0;
  const storage = { loadKey: () => stored, saveKey: (key: RepairSigningKey) => { stored = key; saves++; } };
  const service = new RepairSealService(storage);
  const boundary = makeBoundary();
  assert.equal(boundary.claim().ok, true);
  const capability = boundary.sealCapability("request-1", "exact immutable verification payload");
  assert.ok(!("error" in capability));
  const seal = service.seal(capability);
  assert.ok(!("error" in seal));
  const expected = { publicKey: service.publicProducer().publicKey, requestKey: "request-1", content: "exact immutable verification payload", participants: [] as RepairParticipant[] };
  return { service, storage, boundary, seal, expected, saves: () => saves };
}

test("durable repair seal survives producer restart and another clone's portable replay", () => {
  const f = fixture();
  assert.equal(verifyRepairSeal(JSON.parse(JSON.stringify(f.seal)), f.expected).ok, true);
  const restarted = new RepairSealService(f.storage);
  assert.deepEqual(restarted.publicProducer(), f.service.publicProducer());
  assert.equal(f.saves(), 1);
  assert.equal(verifyRepairSeal(f.seal, { ...f.expected, publicKey: restarted.publicProducer().publicKey }).ok, true);
  assert.equal(JSON.stringify(f.seal).includes("PRIVATE KEY"), false);
  assert.equal(JSON.stringify(restarted.publicProducer()).includes("PRIVATE KEY"), false);
});

test("a caller cannot fabricate a sealing capability from tool JSON, identity or receipt", () => {
  const f = fixture();
  for (const counterfeit of [{}, who, f.seal.receipt, JSON.parse(JSON.stringify(f.seal))]) {
    assert.match((f.service.seal(counterfeit as RepairSealCapability) as { error: string }).error, /unissued/);
  }
  const cap = f.boundary.sealCapability("another-request", "another exact payload");
  assert.ok(!("error" in cap));
  assert.ok(!("error" in f.service.seal(cap)));
  assert.match((f.service.seal(cap) as { error: string }).error, /unissued/);
});

test("signing rechecks late contamination and fresh native provenance after capability creation", () => {
  let eligible = true;
  let participants: RepairParticipant[] = [];
  const boundary = new RepairVerifierBoundary({ context: { supported: true, identity: who }, participants: () => participants,
    revalidate: () => eligible ? { ok: true } : { ok: false, error: "native child provenance changed" } });
  const f = fixture();
  boundary.claim();
  const cap = boundary.sealCapability("request-1", f.expected.content);
  assert.ok(!("error" in cap));
  eligible = false;
  assert.match((f.service.seal(cap) as { error: string }).error, /provenance changed/);
  eligible = true;
  participants = [{ identity: who, role: "fixer" }];
  assert.match((f.service.seal(cap) as { error: string }).error, /fixer/);
  participants = [];
  boundary.enterDomainAction("annotate");
  assert.match((f.service.seal(cap) as { error: string }).error, /forbidden/);
});

test("every durable receipt and producer binding is covered by signature", () => {
  const f = fixture();
  const mutations: RepairVerificationSeal[] = [
    { ...f.seal, version: 2 as 1 }, { ...f.seal, producerKeyId: "invented" }, { ...f.seal, signature: "invalid" },
    ...["id", "connectionId", "requestKey", "content", "identityKey", "role"].map(field => ({ ...f.seal, receipt: { ...f.seal.receipt, [field]: "invented" } })),
    { ...f.seal, receipt: { ...f.seal.receipt, identity: { ...who, session: "different-child" } } },
    { ...f.seal, receipt: { ...f.seal.receipt, identity: { ...who, model: "other-model" } } },
  ];
  for (const altered of mutations) assert.equal(verifyRepairSeal(altered, f.expected).ok, false, JSON.stringify(altered.receipt));
  assert.equal(verifyRepairSeal(f.seal, { ...f.expected, requestKey: "different" }).ok, false);
  assert.equal(verifyRepairSeal(f.seal, { ...f.expected, content: "different" }).ok, false);
  assert.equal(verifyRepairSeal(f.seal, { ...f.expected, participants: [{ identity: who, role: "relayer" }] }).ok, false);
});

test("a seal from an unregistered self-selected producer does not validate", () => {
  const a = fixture(), b = fixture();
  assert.notEqual(a.service.publicProducer().producerKeyId, b.service.publicProducer().producerKeyId);
  assert.equal(verifyRepairSeal(a.seal, { ...a.expected, publicKey: b.expected.publicKey }).ok, false);
  assert.equal(verifyRepairSeal({ ...a.seal, publicKey: b.expected.publicKey, producerKeyId: b.seal.producerKeyId }, b.expected).ok, false);
});

test("malformed durable receipts refuse rather than throwing", () => {
  const f = fixture();
  for (const seal of [null, {}, { ...f.seal, receipt: null }, { ...f.seal, receipt: { ...f.seal.receipt, identity: null } }, { ...f.seal, signature: null }]) {
    assert.equal(verifyRepairSeal(seal as unknown as RepairVerificationSeal, f.expected).ok, false);
  }
});

test("damaged or replaced local signing keys refuse without silent regeneration", () => {
  const f = fixture(), other = fixture();
  const key = f.storage.loadKey()!;
  let saved = false;
  for (const stored of [{ ...key, privateKey: "torn" }, { ...key, publicKey: other.expected.publicKey }]) {
    assert.throws(() => new RepairSealService({ loadKey: () => stored, saveKey: () => { saved = true; } }));
  }
  assert.equal(saved, false);
});
