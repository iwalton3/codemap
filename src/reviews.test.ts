import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Review, BugWitness } from "./schema.js";
import { readReviews, writeStore } from "./store.js";
import { markReviewed, unmarkReviewed, changedSince, reviewStatesFor, witnessDrift, effectiveAttestation, deriveCodeReview } from "./reviews.js";

const rev = (over: Partial<Review>): Review => ({
  id: "r", target: { kind: "anchor", id: "a" }, level: "code", reviewer: "me",
  at: "2026-07-16T00:00:00Z", reviewedCommit: null, witnesses: [], ...over,
});

test("effectiveAttestation resolves the two legacy defaults", () => {
  assert.equal(effectiveAttestation(rev({ actor: "agent" })), "checked");
  assert.equal(effectiveAttestation(rev({ actor: "human" })), "signed"); // legacy human = sign-off
  assert.equal(effectiveAttestation(rev({})), "checked"); // legacy null actor = agent-checked
  assert.equal(effectiveAttestation(rev({ actor: "human", attestation: "viewed" })), "viewed");
  assert.equal(effectiveAttestation(rev({ actor: "human", attestation: "signed" })), "signed");
});

test("witnessDrift reports only the anchors whose live hash moved", () => {
  const witnesses: BugWitness[] = [
    { anchorId: "a1", bodyHash: "h1" },
    { anchorId: "a2", bodyHash: "h2" },
    { anchorId: "a3", bodyHash: "h3" },
  ];
  const live = new Map([["a1", "h1"], ["a2", "h2_NEW"]]); // a3 absent from live
  const drift = witnessDrift(witnesses, live);
  assert.deepEqual(drift.map((d) => d.anchorId).sort(), ["a2", "a3"]);
  assert.equal(drift.find((d) => d.anchorId === "a2")!.now, "h2_NEW");
  assert.equal(drift.find((d) => d.anchorId === "a3")!.now, "sha256:absent");
});

test("viewed and signed are independent rows; each replaces only its own kind", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-rev-"));
  try {
    await writeStore(root, [], { schemaVersion: 1, lastVerifiedCommit: null, grammarVersions: {} }); // init the universe
    const t = { targetKind: "anchor" as const, targetId: "a_x", level: "code" as const };
    // A human viewed, then signed: both marks coexist.
    await markReviewed(root, { ...t, actor: "human", attestation: "viewed" });
    await markReviewed(root, { ...t, actor: "human", attestation: "signed" });
    let rows = (await readReviews(root)).reviews.filter((r) => r.target.id === "a_x");
    assert.deepEqual(rows.map((r) => effectiveAttestation(r)).sort(), ["signed", "viewed"]);

    // Re-signing replaces the vouch but leaves the viewed row untouched.
    await markReviewed(root, { ...t, actor: "human", attestation: "signed" });
    rows = (await readReviews(root)).reviews.filter((r) => r.target.id === "a_x");
    assert.deepEqual(rows.map((r) => effectiveAttestation(r)).sort(), ["signed", "viewed"]);
    assert.equal(rows.filter((r) => effectiveAttestation(r) === "viewed").length, 1);

    // An agent `checked` supersedes... no: a human sign-off outranks; but a fresh agent
    // check is still a vouch and replaces the existing vouch at this level.
    await markReviewed(root, { ...t, actor: "agent" });
    rows = (await readReviews(root)).reviews.filter((r) => r.target.id === "a_x");
    assert.deepEqual(rows.map((r) => effectiveAttestation(r)).sort(), ["checked", "viewed"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unmark scopes to a single attestation", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-rev-"));
  try {
    await writeStore(root, [], { schemaVersion: 1, lastVerifiedCommit: null, grammarVersions: {} }); // init the universe
    const t = { targetKind: "anchor" as const, targetId: "a_y", level: "code" as const };
    await markReviewed(root, { ...t, actor: "human", attestation: "viewed" });
    await markReviewed(root, { ...t, actor: "human", attestation: "signed" });
    await unmarkReviewed(root, { ...t, attestation: "signed" }); // drop sign-off only
    const rows = (await readReviews(root)).reviews.filter((r) => r.target.id === "a_y");
    assert.deepEqual(rows.map((r) => effectiveAttestation(r)), ["viewed"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reviewStatesFor reads the vouch by default, the viewed marks with {viewed:true}", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-rev-"));
  try {
    await writeStore(root, [], { schemaVersion: 1, lastVerifiedCommit: null, grammarVersions: {} });
    const t = { targetKind: "anchor" as const, targetId: "a_v", level: "code" as const };
    await markReviewed(root, { ...t, actor: "human", attestation: "viewed" });
    await markReviewed(root, { ...t, actor: "human", attestation: "signed" });
    const tgt = { kind: "anchor" as const, id: "a_v" };
    const found = (s: string) => s !== "unreviewed"; // absent synthetic anchors read `stale`, not `reviewed`
    const vouch = (await reviewStatesFor(root, [tgt])).get("anchor:a_v")!;
    const view = (await reviewStatesFor(root, [tgt], { viewed: true })).get("anchor:a_v")!;
    assert.ok(found(vouch.code.state), "default read finds the sign-off row");
    assert.ok(found(view.code.state), "{viewed:true} finds the exposure row");
    // Dropping the sign-off empties the vouch but leaves the viewed mark selectable.
    await unmarkReviewed(root, { ...t, attestation: "signed" });
    assert.equal((await reviewStatesFor(root, [tgt])).get("anchor:a_v")!.code.state, "unreviewed");
    assert.ok(found((await reviewStatesFor(root, [tgt], { viewed: true })).get("anchor:a_v")!.code.state));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("changedSince finds the mark and reports no drift when code is unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-rev-"));
  try {
    await writeStore(root, [], { schemaVersion: 1, lastVerifiedCommit: null, grammarVersions: {} }); // init the universe
    const t = { targetKind: "anchor" as const, targetId: "a_z", level: "code" as const };
    assert.equal((await changedSince(root, { kind: "anchor", id: "a_z" }, { level: "code", attestation: "signed" })).found, false);
    await markReviewed(root, { ...t, actor: "human", attestation: "signed" });
    const r = await changedSince(root, { kind: "anchor", id: "a_z" }, { level: "code", attestation: "signed" });
    assert.equal(r.found, true);
    assert.deepEqual(r.changed, []); // witness == live (both "absent"), nothing moved
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deriveCodeReview: a node is code-reviewed only when every segment is signed", () => {
  // no segments → nothing to review
  assert.deepEqual(deriveCodeReview([]), { state: "unreviewed", actor: null, signed: 0, total: 0, stale: 0 });
  // partial → unreviewed, but progress is reported
  assert.deepEqual(deriveCodeReview([{ state: "reviewed", actor: "human" }, { state: "unreviewed" }]),
    { state: "unreviewed", actor: null, signed: 1, total: 2, stale: 0 });
  // all signed → reviewed; a human signer promotes the actor (→ trust can reach verified)
  assert.deepEqual(deriveCodeReview([{ state: "reviewed", actor: "agent" }, { state: "reviewed", actor: "human" }]),
    { state: "reviewed", actor: "human", signed: 2, total: 2, stale: 0 });
  // all signed but only agents → agent-checked
  assert.deepEqual(deriveCodeReview([{ state: "reviewed", actor: "agent" }]),
    { state: "reviewed", actor: "agent", signed: 1, total: 1, stale: 0 });
  // any stale segment poisons the whole node, even if the rest are signed
  assert.deepEqual(deriveCodeReview([{ state: "reviewed", actor: "human" }, { state: "stale" }]),
    { state: "stale", actor: null, signed: 1, total: 2, stale: 1 });
});
