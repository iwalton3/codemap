import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RepairVerifierBoundary, RepairVerifierReceipts, verifierIdentityKey,
  type RepairParticipant, type RepairVerifierReceipt, type VerifierIdentity,
} from "./verifier-boundary.js";

const identity = (session = "verifier-1", child?: string): VerifierIdentity => ({
  principal: "owner@example.com", harness: "codex", session, child, model: "same-model",
});
const boundary = (who = identity(), participants: () => readonly RepairParticipant[] = () => [], receipts?: RepairVerifierReceipts) =>
  new RepairVerifierBoundary({ context: { supported: true, identity: who }, participants, receipts });
function receipt(b: RepairVerifierBoundary): RepairVerifierReceipt {
  const sealed = b.sealReceipt("request-1", "verified exact content");
  assert.ok(!("error" in sealed));
  return sealed;
}
const expected = { requestKey: "request-1", content: "verified exact content", participants: [] as RepairParticipant[] };

test("verifier identity distinguishes same-model sessions and children; model changes replace one identity", () => {
  assert.notEqual(verifierIdentityKey(identity("one")), verifierIdentityKey(identity("two")));
  assert.notEqual(verifierIdentityKey(identity("one", "a")), verifierIdentityKey(identity("one", "b")));
  assert.equal(verifierIdentityKey(identity()), verifierIdentityKey({ ...identity(), model: "replacement-model" }));
  assert.notEqual(boundary().connectionId, boundary().connectionId);
});

test("trusted fixer or relayer session cannot become verifier by reconnecting or replacing model", () => {
  for (const role of ["fixer", "relayer"] as const) {
    const participants = () => [{ identity: identity("used"), role }];
    const b = boundary({ ...identity("used"), model: "another-model" }, participants);
    assert.match((b.claim() as { error: string }).error, new RegExp(role));
    assert.ok("error" in b.sealReceipt("request-1", "content"));
    assert.equal(boundary(identity("fresh"), participants).claim().ok, true);
  }
});

test("fresh claims work; a read, write, or failed domain attempt makes a later claim late", () => {
  assert.equal(boundary().claim().ok, true);
  for (const action of ["search", "annotate", "nonexistent"]) {
    const b = boundary();
    b.enterDomainAction(action);
    assert.match((b.claim() as { error: string }).error, /before any domain action/);
    assert.ok("error" in b.sealReceipt("request-1", "content"));
  }
  const unsupported = new RepairVerifierBoundary({ context: { supported: false, reason: "no trusted session adapter" }, participants: () => [] });
  assert.match((unsupported.claim() as { error: string }).error, /no trusted session adapter/);
  unsupported.enterDomainAction("search");
  assert.match((unsupported.claim() as { error: string }).error, /before any domain action/);
});

test("repair verifier admits only explicit repair tools and a reclaim cannot reset it", () => {
  for (const tool of ["repair_brief", "repair_evidence", "repair_verification", "repair_arbitration"]) {
    const b = boundary();
    assert.equal(b.claim().ok, true);
    assert.equal(b.enterDomainAction(tool).ok, true);
    assert.equal(b.receipts.validate(receipt(b), expected).ok, true);
  }
  for (const tool of ["submit_verdict", "search", "annotate", "future_tool"]) {
    const b = boundary();
    b.claim();
    assert.equal(b.enterDomainAction(tool).ok, false);
    assert.equal(b.claim().ok, false);
    assert.ok("error" in b.sealReceipt("request-1", "content"));
  }
});

test("receipts bind actual verifier, connection, role, request and content; no identity swaps or forgery", () => {
  const registry = new RepairVerifierReceipts();
  const b = boundary(identity("one"), () => [], registry);
  const other = boundary(identity("two"), () => [], registry);
  b.claim(); other.claim();
  const r = receipt(b);
  const second = receipt(other);
  assert.equal(registry.validate(r, expected).ok, true);
  assert.equal(r.connectionId, b.connectionId);
  assert.deepEqual(r.identity, identity("one"));
  const altered = [
    { ...r, id: "invented" }, { ...r, identity: second.identity },
    { ...r, identityKey: second.identityKey }, { ...r, connectionId: second.connectionId },
    { ...r, role: "fixer" }, { ...r, requestKey: "another-request" }, { ...r, content: "different" },
  ];
  for (const value of altered) assert.equal(registry.validate(value as RepairVerifierReceipt, expected).ok, false);
  assert.equal(registry.validate(r, { ...expected, requestKey: "another-request" }).ok, false);
  assert.equal(registry.validate(r, { ...expected, content: "different" }).ok, false);
  assert.equal(new RepairVerifierReceipts().validate(r, expected).ok, false);
});

test("receipt replay rechecks forbidden actions and trusted fixer/relayer participants", () => {
  let participants: RepairParticipant[] = [];
  const b = boundary(identity(), () => participants);
  b.claim();
  const r = receipt(b);
  participants = [{ identity: identity(), role: "fixer" }];
  assert.equal(b.receipts.validate(r, expected).ok, false);
  participants = [];
  assert.equal(b.receipts.validate(r, { ...expected, participants: [{ identity: identity(), role: "relayer" }] }).ok, false);
  assert.equal(b.receipts.validate(r, expected).ok, true);
  b.enterDomainAction("submit_verdict");
  assert.equal(b.receipts.validate(r, expected).ok, false);
});

test("adapter identity is snapshotted so caller mutation cannot swap its session", () => {
  const who = identity();
  const b = boundary(who);
  who.session = "forged";
  b.claim();
  assert.equal(receipt(b).identity.session, "verifier-1");
});

test("incomplete adapter context and empty receipt bindings refuse explicitly", () => {
  const invalid = boundary({ ...identity(), child: 42 as unknown as string });
  assert.match((invalid.claim() as { error: string }).error, /incomplete session identity/);
  const b = boundary();
  b.claim();
  for (const [request, content] of [["", "content"], ["request", ""], [" ", "content"]]) {
    assert.ok("error" in b.sealReceipt(request!, content!));
  }
});

test("receipt replay rechecks external provenance and permanent connection invalidation", () => {
  let eligible = true;
  const b = new RepairVerifierBoundary({ context: { supported: true, identity: identity() },
    participants: () => [], revalidate: () => eligible ? { ok: true } : { ok: false, error: "native provenance changed" } });
  assert.equal(b.claim().ok, true);
  const r = receipt(b);
  assert.equal(b.receipts.validate(r, expected).ok, true);
  eligible = false;
  assert.match((b.receipts.validate(r, expected) as { error: string }).error, /provenance changed/);
  eligible = true;
  b.invalidate("caller identity changed");
  assert.match((b.receipts.validate(r, expected) as { error: string }).error, /identity changed/);
  assert.ok("error" in b.sealReceipt("request-1", "verified exact content"));
});
