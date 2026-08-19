import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Review, BugWitness, Anchor, State } from "./schema.js";
import { readReviews, writeStore } from "./store.js";
import { markReviewed, unmarkReviewed, changedSince, reviewStatesFor, witnessDrift, effectiveAttestation, deriveCodeReview } from "./reviews.js";
import { anchorMark } from "./ops.js";
import { indexBlob } from "./repo.js";

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
  const base = { replayed: 0, reverted: 0 };
  // no segments → nothing to review
  assert.deepEqual(deriveCodeReview([]), { state: "unreviewed", actor: null, signed: 0, total: 0, stale: 0, ...base });
  // partial → unreviewed, but progress is reported
  assert.deepEqual(deriveCodeReview([{ state: "reviewed", actor: "human" }, { state: "unreviewed" }]),
    { state: "unreviewed", actor: null, signed: 1, total: 2, stale: 0, ...base });
  // all signed → reviewed; a human signer promotes the actor (→ trust can reach verified)
  assert.deepEqual(deriveCodeReview([{ state: "reviewed", actor: "agent" }, { state: "reviewed", actor: "human" }]),
    { state: "reviewed", actor: "human", signed: 2, total: 2, stale: 0, ...base });
  // all signed but only agents → agent-checked
  assert.deepEqual(deriveCodeReview([{ state: "reviewed", actor: "agent" }]),
    { state: "reviewed", actor: "agent", signed: 1, total: 1, stale: 0, ...base });
  // any stale segment poisons the whole node, even if the rest are signed
  assert.deepEqual(deriveCodeReview([{ state: "reviewed", actor: "human" }, { state: "stale" }]),
    { state: "stale", actor: null, signed: 1, total: 2, stale: 1, ...base });
});

test("deriveCodeReview carries how its ticks were earned up to the rollup", () => {
  // A rollup that reports a plain "all signed" while a segment's approval is
  // borrowed, or sits on undone work, tells the same lie the per-segment mark was
  // fixed to stop telling — one level up, where it is harder to notice.
  const r = deriveCodeReview([
    { state: "reviewed", actor: "human", via: "direct" },
    { state: "reviewed", actor: "human", via: "replayed" },
    { state: "reviewed", actor: "human", via: "reverted" },
  ]);
  assert.equal(r.state, "reviewed");
  assert.equal(r.signed, 3);
  assert.equal(r.replayed, 1);
  assert.equal(r.reverted, 1);

  // counts only reviewed segments — an unreviewed one has no `via` to report
  const q = deriveCodeReview([{ state: "unreviewed", via: "replayed" }, { state: "reviewed", actor: "human" }]);
  assert.equal(q.replayed, 0);
});

test("a review write reports the resulting mark, so one symbol can be updated in place", async () => {
  // The walkthrough re-fetched the WHOLE PR story to learn what one sign-off did,
  // which on a large pull request is seconds of work. The state has nuance the
  // client must not guess (replayed, sitting on a revert), so the server returns it.
  const root = mkdtempSync(join(tmpdir(), "codemap-mark-"));
  try {
    // A real file on disk: review state is judged against LIVE hashes, so a
    // store-only anchor would read as stale rather than reviewed.
    mkdirSync(join(root, "src"));
    const src = "export function transfer(cents: number) {\n  return cents;\n}\n";
    writeFileSync(join(root, "src/pay.ts"), src);
    const anchors = await indexBlob(src, "src/pay.ts");
    await writeStore(root, anchors, { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State);
    const id = anchors[0]!.id;

    const before = await anchorMark(root, id);
    assert.equal(before.reviewed, false);
    assert.equal(before.viewed, false);

    await markReviewed(root, { targetKind: "anchor", targetId: id, level: "code", actor: "human", attestation: "signed" });
    const after = await anchorMark(root, id);
    assert.equal(after.reviewed, true, "the sign-off is visible without re-deriving the PR");
    assert.ok(after.review, "and carries the mark itself, not just a boolean");
    assert.equal(after.viewed, false, "viewed and signed stay independent");

    await markReviewed(root, { targetKind: "anchor", targetId: id, level: "code", actor: "human", attestation: "viewed" });
    assert.equal((await anchorMark(root, id)).viewed, true);

    await unmarkReviewed(root, { targetKind: "anchor", targetId: id, level: "code", attestation: "signed" });
    assert.equal((await anchorMark(root, id)).reviewed, false, "taking it back is reported too");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
