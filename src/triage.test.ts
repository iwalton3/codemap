import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeStore, readTriage } from "./store.js";
import { setTriage, clearTriage, triageStatus, triageSeverity } from "./triage.js";

const initRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-triage-"));
  return root;
};
const init = async (root: string) => writeStore(root, [], { schemaVersion: 1, lastVerifiedCommit: null, grammarVersions: {} });

test("triageSeverity implements the docs/triage.md matrix", () => {
  // Business Critical: unread=critical, read-but-unsigned=high, signed=complete.
  assert.equal(triageSeverity("business-critical", { read: false, signed: false }), "critical");
  assert.equal(triageSeverity("business-critical", { read: true, signed: false }), "high");
  assert.equal(triageSeverity("business-critical", { read: true, signed: true }), "complete");
  // Important: unread=high, read-but-unsigned=medium, signed=complete.
  assert.equal(triageSeverity("important", { read: false, signed: false }), "high");
  assert.equal(triageSeverity("important", { read: true, signed: false }), "medium");
  assert.equal(triageSeverity("important", { read: true, signed: true }), "complete");
  // Mechanical: unread=low, read=complete (sign-off never required).
  assert.equal(triageSeverity("mechanical", { read: false, signed: false }), "low");
  assert.equal(triageSeverity("mechanical", { read: true, signed: false }), "complete");
});

test("the ratchet: agents may only raise; a human may lower or confirm", async () => {
  const root = initRoot();
  try {
    await init(root);
    const t = { targetKind: "anchor" as const, targetId: "a_r" };
    // Agent proposes `important` (a `likely` proposal).
    let r = await setTriage(root, { ...t, importance: "important", source: "agent" });
    assert.equal(r.ok, true); assert.equal(r.likely, true);
    // Agent may RAISE to business-critical.
    r = await setTriage(root, { ...t, importance: "business-critical", source: "agent" });
    assert.equal(r.ok, true); assert.equal(r.importance, "business-critical");
    // Agent may NOT lower — ratchet refuses, tier unchanged.
    r = await setTriage(root, { ...t, importance: "mechanical", source: "agent" });
    assert.equal(r.ok, false); assert.equal(r.importance, "business-critical");
    // A human MAY lower, and their mark is confirmed (not likely).
    r = await setTriage(root, { ...t, importance: "mechanical", source: "human" });
    assert.equal(r.ok, true); assert.equal(r.likely, false);
    assert.equal((await readTriage(root)).triage[0]!.importance, "mechanical");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("triageStatus crosses stakes with attestation to a severity + bar", async () => {
  const root = initRoot();
  try {
    await init(root);
    const t = { targetKind: "anchor" as const, targetId: "a_s" };
    // Untriaged → escalates to a distinct 'untriaged' bucket, no bar.
    let info = await triageStatus(root, { kind: "anchor", id: "a_s" });
    assert.equal(info.severity, "untriaged");
    assert.equal(info.importance, null);
    // Business-critical, no review → critical, bar = signed.
    await setTriage(root, { ...t, importance: "business-critical", source: "human" });
    info = await triageStatus(root, { kind: "anchor", id: "a_s" });
    assert.equal(info.severity, "critical");
    assert.equal(info.bar, "signed");
    // Clearing stakes returns it to untriaged.
    await clearTriage(root, t);
    info = await triageStatus(root, { kind: "anchor", id: "a_s" });
    assert.equal(info.severity, "untriaged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
