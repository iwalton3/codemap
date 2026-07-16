import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeStore, readTriage, writeAnchorStore, writeNode, readGraph, writeGraph } from "./store.js";
import type { Anchor } from "./schema.js";
import { setTriage, clearTriage, triageStatus, triageSeverity, deriveTriage } from "./triage.js";

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

test("the ratchet: escalation always allowed, lowering human-only, graph respects humans", async () => {
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
    // An agent MAY escalate a human mark (mis-flag / code grew teeth) — as a `likely` proposal.
    r = await setTriage(root, { ...t, importance: "business-critical", source: "agent" });
    assert.equal(r.ok, true); assert.equal(r.likely, true);
    assert.equal((await readTriage(root)).triage[0]!.importance, "business-critical");
    // ...but the blind graph batch will NOT override a human mark.
    await setTriage(root, { ...t, importance: "mechanical", source: "human" });
    r = await setTriage(root, { ...t, importance: "business-critical", source: "graph" });
    assert.equal(r.ok, false);
    assert.equal((await readTriage(root)).triage[0]!.importance, "mechanical");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deriveTriage: graph signals → likely stakes; human marks are preserved", async () => {
  const root = initRoot();
  try {
    await init(root);
    const anchor: Anchor = { id: "a1", file: "src/pay.ts", symbolPath: ["Payments", "charge"], kind: "function", bodyHash: "h", lastVerifiedCommit: null };
    await writeAnchorStore(root, [anchor]);
    await writeNode(root, { id: "pay", type: "command", title: "Charge card", summary: "", anchors: ["a1"], body: "" });
    await writeNode(root, { id: "proj", type: "projection", title: "Order list view", summary: "", anchors: [], body: "" });
    await writeNode(root, { id: "h1", type: "handler", title: "Submit order", summary: "", anchors: [], body: "" });
    const g = await readGraph(root); g.edges.push({ from: "h1", to: "evt", type: "emits" }); await writeGraph(root, g);
    // A human mark that derivation must not clobber (even though structural = mechanical).
    await setTriage(root, { targetKind: "node", targetId: "proj", importance: "business-critical", source: "human" });

    const r = await deriveTriage(root);
    assert.ok(r.derived >= 2);
    const imp = async (kind: "node" | "anchor", id: string) => (await triageStatus(root, { kind, id })).importance;
    assert.equal(await imp("node", "pay"), "business-critical"); // "Charge" money name
    assert.equal(await imp("node", "h1"), "important"); // emits a domain event
    assert.equal(await imp("node", "proj"), "business-critical"); // human mark preserved
    assert.equal(await imp("anchor", "a1"), "business-critical"); // inherited from citing node "pay"

    // Re-running is idempotent (regenerates graph marks, still doesn't touch the human one).
    await deriveTriage(root);
    assert.equal(await imp("node", "proj"), "business-critical");
    const projRow = (await readTriage(root)).triage.find((t) => t.target.id === "proj")!;
    assert.equal(projRow.source, "human");
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
