import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeStore, readTriage, writeTriage, writeAnchorStore, writeNode, readGraph, writeGraph } from "./store.js";
import type { Anchor, Triage } from "./schema.js";
import { setTriage, clearTriage, triageStatus, triageSeverity, deriveTriage, rollupCoverage, triageDrift, tripwires } from "./triage.js";
import type { TriageInfo } from "./triage.js";

const initRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-triage-"));
  return root;
};
const init = async (root: string) => writeStore(root, [], { schemaVersion: 1, lastVerifiedCommit: null, grammarVersions: {} });

test("triageSeverity crosses stakes × complexity × review-gap (docs/triage.md)", () => {
  const S = triageSeverity;
  // Only business-critical + deep + unread reaches `critical` (the meaty money logic).
  assert.equal(S("business-critical", "deep", { read: false, signed: false }), "critical");
  assert.equal(S("business-critical", "deep", { read: true, signed: false }), "high");
  // Money code that's just wiring is NOT critical — a glance (viewed) clears it.
  assert.equal(S("business-critical", "wiring", { read: false, signed: false }), "medium"); // BC floor
  assert.equal(S("business-critical", "wiring", { read: true, signed: false }), "complete"); // bar = viewed
  // The rote authz check: important but a quick confirm, not deep work.
  assert.equal(S("business-critical", "rote", { read: false, signed: false }), "medium");
  // Floor: business-critical / important never rank below medium while a gap remains.
  assert.equal(S("important", "wiring", { read: false, signed: false }), "medium");
  assert.equal(S("important", "rote", { read: true, signed: false }), "medium");
  // Low stakes gets no floor.
  assert.equal(S("low", "standard", { read: false, signed: false }), "low");
  assert.equal(S("low", "wiring", { read: true, signed: false }), "complete");
  assert.equal(S("low", "deep", { read: false, signed: false }), "medium");
  // Signing always completes, any complexity.
  assert.equal(S("business-critical", "deep", { read: true, signed: true }), "complete");
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
    r = await setTriage(root, { ...t, importance: "low", source: "agent" });
    assert.equal(r.ok, false); assert.equal(r.importance, "business-critical");
    // A human MAY lower, and their mark is confirmed (not likely).
    r = await setTriage(root, { ...t, importance: "low", source: "human" });
    assert.equal(r.ok, true); assert.equal(r.likely, false);
    // An agent MAY escalate a human mark (mis-flag / code grew teeth) — as a `likely` proposal.
    r = await setTriage(root, { ...t, importance: "business-critical", source: "agent" });
    assert.equal(r.ok, true); assert.equal(r.likely, true);
    assert.equal((await readTriage(root)).triage[0]!.importance, "business-critical");
    // ...but the blind graph batch will NOT override a human mark.
    await setTriage(root, { ...t, importance: "low", source: "human" });
    r = await setTriage(root, { ...t, importance: "business-critical", source: "graph" });
    assert.equal(r.ok, false);
    assert.equal((await readTriage(root)).triage[0]!.importance, "low");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("complexity ratchets independently: agents raise it, humans set it freely", async () => {
  const root = initRoot();
  try {
    await init(root);
    const t = { targetKind: "anchor" as const, targetId: "a_cx" };
    // Agent proposes important + wiring.
    let r = await setTriage(root, { ...t, importance: "important", complexity: "wiring", source: "agent" });
    assert.equal(r.complexity, "wiring");
    // Agent may RAISE complexity (grew a branch) even without touching stakes.
    r = await setTriage(root, { ...t, importance: "important", complexity: "standard", source: "agent" });
    assert.equal(r.ok, true); assert.equal(r.complexity, "standard");
    // Agent may NOT lower complexity — and with neither axis rising, the whole mark is refused.
    r = await setTriage(root, { ...t, importance: "important", complexity: "wiring", source: "agent" });
    assert.equal(r.ok, false); assert.equal(r.complexity, "standard");
    // A human may lower it.
    r = await setTriage(root, { ...t, importance: "important", complexity: "wiring", source: "human" });
    assert.equal(r.ok, true); assert.equal(r.complexity, "wiring");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollupCoverage summarizes a set of severities into the review-complete number", () => {
  const info = (severity: string): TriageInfo => ({ importance: null, likely: false, severity: severity as TriageInfo["severity"], bar: null });
  const cov = rollupCoverage([info("complete"), info("complete"), info("critical"), info("low"), info("untriaged")]);
  assert.equal(cov.total, 5);
  assert.equal(cov.complete, 2);
  assert.equal(cov.outstanding, 3);
  assert.equal(cov.completePct, 40);
  assert.equal(cov.worst, "critical"); // critical outranks untriaged/low
  assert.equal(cov.bySeverity.complete, 2);
  // Empty set is vacuously 100% complete (nothing owed).
  const empty = rollupCoverage([]);
  assert.equal(empty.completePct, 100);
  assert.equal(empty.worst, null);
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

// A triage mark whose stored witness hash won't match live (the anchor has no file, so
// live reads "absent") — i.e. code that has drifted since the mark was set.
const staleMark = (over: Partial<Triage>): Triage => ({
  target: { kind: "anchor", id: "a_x" }, importance: "business-critical", likely: false,
  source: "human", at: "2026-07-16T00:00:00Z", witnesses: [{ anchorId: "a_x", bodyHash: "sha256:OLD" }], ...over,
});

test("triageDrift + tripwires surface marks whose witnessed code moved", async () => {
  const root = initRoot();
  try {
    await init(root);
    await writeTriage(root, [
      staleMark({ target: { kind: "anchor", id: "a_moved" }, tripwire: true, witnesses: [{ anchorId: "a_moved", bodyHash: "sha256:OLD" }] }),
      staleMark({ target: { kind: "anchor", id: "a_watch_only" }, tripwire: false, witnesses: [{ anchorId: "a_watch_only", bodyHash: "sha256:OLD" }] }),
    ]);
    const drift = await triageDrift(root);
    assert.equal(drift.length, 2); // both drifted (their witnessed hashes ≠ live)
    const tw = await tripwires(root);
    assert.equal(tw.armedCount, 1); // only one is armed
    assert.equal(tw.fired.length, 1); // and it has fired (its code moved)
    assert.equal(tw.fired[0]!.target.id, "a_moved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("re-triage on drift: a human mark escalates when its code changed AND stakes rose", async () => {
  const root = initRoot();
  try {
    await init(root);
    await writeNode(root, { id: "pay", type: "command", title: "Charge card", summary: "", anchors: ["a_p"], body: "" });
    // Human deliberately set `pay` mechanical — but its witnessed code has since drifted.
    await writeTriage(root, [staleMark({ target: { kind: "node", id: "pay" }, importance: "low", witnesses: [{ anchorId: "a_p", bodyHash: "sha256:OLD" }] })]);

    const r = await deriveTriage(root);
    // The graph now derives business-critical (money name) > the human's mechanical, and
    // because the code drifted this is a legitimate re-escalation (not blind override).
    assert.ok(r.escalated >= 1);
    const info = await triageStatus(root, { kind: "node", id: "pay" });
    assert.equal(info.importance, "business-critical");
    assert.equal(info.likely, true); // re-enters the confirm queue, not silently owned
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no drift → a human mark is NOT re-escalated (blind graph respects it)", async () => {
  const root = initRoot();
  try {
    await init(root);
    await writeNode(root, { id: "pay2", type: "command", title: "Charge card", summary: "", anchors: [], body: "" });
    // Human set mechanical with NO witnesses → nothing drifted; graph must respect it.
    await writeTriage(root, [{ target: { kind: "node", id: "pay2" }, importance: "low", likely: false, source: "human", at: "2026-07-16T00:00:00Z", witnesses: [] }]);
    const r = await deriveTriage(root);
    assert.equal(r.escalated, 0);
    assert.equal((await triageStatus(root, { kind: "node", id: "pay2" })).importance, "low");
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
    // Business-critical + deep, no review → critical, bar = signed.
    await setTriage(root, { ...t, importance: "business-critical", complexity: "deep", source: "human" });
    info = await triageStatus(root, { kind: "anchor", id: "a_s" });
    assert.equal(info.severity, "critical");
    assert.equal(info.complexity, "deep");
    assert.equal(info.bar, "signed");
    // Same stakes but pure wiring → NOT critical (a glance clears it); bar = viewed.
    await setTriage(root, { ...t, importance: "business-critical", complexity: "wiring", source: "human" });
    info = await triageStatus(root, { kind: "anchor", id: "a_s" });
    assert.equal(info.severity, "medium"); // BC floor, but not critical
    assert.equal(info.bar, "viewed");
    // Clearing stakes returns it to untriaged.
    await clearTriage(root, t);
    info = await triageStatus(root, { kind: "anchor", id: "a_s" });
    assert.equal(info.severity, "untriaged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
