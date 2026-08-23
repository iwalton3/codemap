import { test } from "node:test";
import assert from "node:assert/strict";
import { legacyIndex, anchorIndex } from "./anchor-resolve.js";
import { hashTokens } from "./normalize.js";
import type { DerivationTag } from "./schema.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Review, BugWitness, Anchor, State } from "./schema.js";
import { readReviews, writeStore } from "./store.js";
import { markReviewed, unmarkReviewed, changedSince, reviewStatesFor, witnessDrift, realDrift, effectiveAttestation, deriveCodeReview } from "./reviews.js";
import { anchorMark } from "./ops.js";
import { indexBlob } from "./repo.js";
import { fixtureHash } from "./fixture-hash.js";

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
  // Real digests, because `sameBody` refuses a value that is not a hash: a bare
  // tag would compare unequal to itself and every witness would read as drift.
  const witnesses: BugWitness[] = [
    { anchorId: "a1", bodyHash: fixtureHash("h1") },
    { anchorId: "a2", bodyHash: fixtureHash("h2") },
    { anchorId: "a3", bodyHash: fixtureHash("h3") },
  ];
  const live = new Map([["a1", fixtureHash("h1")], ["a2", fixtureHash("h2_NEW")]]); // a3 absent from live
  const drift = witnessDrift(witnesses, legacyIndex(live));
  assert.deepEqual(drift.map((d) => d.anchorId).sort(), ["a2", "a3"]);
  assert.equal(drift.find((d) => d.anchorId === "a2")!.now, fixtureHash("h2_NEW"));
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

test("a mark made against a PR head records THAT commit, not the working tree's", async () => {
  // `reviewedCommit` was always `headCommit(root)`, so a PR sign-off claimed to have
  // happened at the local HEAD while its witnesses came from the PR head.
  // `changedSince` then compared the two and reported the whole mark as drifted —
  // "what changed since I signed?" was unusable for anything signed on a PR surface.
  const root = mkdtempSync(join(tmpdir(), "codemap-refmark-"));
  try {
    mkdirSync(join(root, "src"));
    const src = "export function transfer(cents: number) {\n  return cents;\n}\n";
    writeFileSync(join(root, "src/pay.ts"), src);
    const anchors = await indexBlob(src, "src/pay.ts");
    await writeStore(root, anchors, { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State);
    const id = anchors[0]!.id;

    const { writeSnapshot, readReviews } = await import("./store.js");
    await writeSnapshot(root, "prhead", "feature/x", anchors, "2026-08-19T00:00:00Z");

    await markReviewed(root, { targetKind: "anchor", targetId: id, level: "code", actor: "human", attestation: "signed", ref: "prhead" });
    const r = (await readReviews(root)).reviews[0]!;
    assert.equal(r.reviewedCommit, "prhead", "the mark is about the commit it was made against");
    assert.equal(r.accepted![0]!.entries[0]!.commit, "prhead");
    assert.equal(r.accepted![0]!.entries[0]!.branch, "feature/x",
      "and carries THAT commit's branch, not whichever the working tree was on");
    assert.equal((await changedSince(root, { kind: "anchor", id }, { level: "code", attestation: "signed" })).changed.length, 0,
      "nothing changed since it was signed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("markReviewedBatch dedupes its ids — every reader assumes one row per target", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-batch-"));
  try {
    await writeStore(root, [], { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State);
    const { markReviewedBatch } = await import("./reviews.js");
    const { readReviews } = await import("./store.js");
    const r = await markReviewedBatch(root, ["a_1", "a_1", "a_2"], {
      level: "code", actor: "human", attestation: "viewed", reviewer: "github-import",
      ref: "h", hashes: new Map([["a_1", fixtureHash("A")], ["a_2", fixtureHash("B")]]),
    });
    assert.equal(r.marked, 2, "a repeated id is one mark");
    const rows = (await readReviews(root)).reviews.filter((x) => x.target.id === "a_1");
    assert.equal(rows.length, 1, "two rows for one (target, level, attestation) breaks every `.find` that reads them");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an imported viewed tick does not raise an approval-sitting-on-a-revert alarm", async () => {
  // A bulk import writes thousands of `viewed` rows (reviewer "github-import") that
  // are explicitly NOT vouches, and the dashboard renders every revert alarm as
  // "approvals sitting on top of a revert".
  const root = mkdtempSync(join(tmpdir(), "codemap-revert-"));
  try {
    mkdirSync(join(root, "src"));
    const v1 = "export function f() {\n  return 1;\n}\n";
    writeFileSync(join(root, "src/f.ts"), v1);
    const a1 = await indexBlob(v1, "src/f.ts");
    await writeStore(root, a1, { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State);
    const id = a1[0]!.id;
    const h1 = a1[0]!.bodyHash;
    const a2 = await indexBlob("export function f() {\n  return 2;\n}\n", "src/f.ts");
    const h2 = a2[0]!.bodyHash;

    const { markReviewedBatch, revertedMarks } = await import("./reviews.js");
    // viewed at v1, viewed at v2, and the code is back at v1 — a revert, on ticks
    for (const [ref, hash] of [["c1", h1], ["c2", h2]] as const) {
      await markReviewedBatch(root, [id], {
        level: "code", actor: "human", attestation: "viewed", reviewer: "github-import",
        ref, hashes: new Map([[id, hash]]),
      });
    }
    const marks = await revertedMarks(root);
    assert.deepEqual(marks, [], "exposure is not approval; these must not read as approvals on a revert");

    const withViewed = await revertedMarks(root, { includeViewed: true });
    for (const m of withViewed) assert.equal(m.attestation, "viewed", "and when asked for, they say which they are");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("changedSince answers about the ref you ask about, not the working tree", async () => {
  // Without a ref, "now" is the working tree — which for a PR sign-off is some other
  // branch entirely, so a mark whose code has not moved at the PR head still reported
  // the whole thing as drifted.
  const root = mkdtempSync(join(tmpdir(), "codemap-since-"));
  try {
    mkdirSync(join(root, "src"));
    const worktree = "export function f() {\n  return 1;\n}\n";
    writeFileSync(join(root, "src/f.ts"), worktree);
    const onDisk = await indexBlob(worktree, "src/f.ts");
    await writeStore(root, onDisk, { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State);
    const id = onDisk[0]!.id;

    // the PR head holds a DIFFERENT body for the same symbol
    const { writeSnapshot } = await import("./store.js");
    const branch = await indexBlob("export function f() {\n  return 99;\n}\n", "src/f.ts");
    await writeSnapshot(root, "prhead", "feature/x", branch, "2026-08-19T00:00:00Z");

    await markReviewed(root, { targetKind: "anchor", targetId: id, level: "code", actor: "human", attestation: "signed", ref: "prhead" });

    const atHead = await changedSince(root, { kind: "anchor", id }, { level: "code", attestation: "signed", ref: "prhead" });
    assert.deepEqual(atHead.changed, [], "nothing changed at the head it was signed against");

    const atWorktree = await changedSince(root, { kind: "anchor", id }, { level: "code", attestation: "signed" });
    assert.equal(atWorktree.changed.length, 1, "and the working tree really does differ — a separate question");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- a witness from an older HASH_SCHEME is not drift --------------------------

test("a witness minted under another hash scheme reports unverifiable, not drift", () => {
  const witnesses: BugWitness[] = [{ anchorId: "a1", bodyHash: fixtureHash("old") }];
  const live = new Map([["a1", fixtureHash("new", 2)]]);
  const d = witnessDrift(witnesses, legacyIndex(live));
  assert.equal(d.length, 1, "it is still reported — the mark does need re-witnessing");
  assert.equal(d[0]!.unverifiable, true);
  assert.deepEqual(realDrift(d), [], "but it is NOT drift, so nothing escalates on it");
});

test("a real edit under one scheme is still drift", () => {
  const d = witnessDrift([{ anchorId: "a1", bodyHash: fixtureHash("aaa", 2) }], legacyIndex(new Map([["a1", fixtureHash("bbb", 2)]])));
  assert.equal(d.length, 1);
  assert.notEqual(d[0]!.unverifiable, true);
  assert.equal(realDrift(d).length, 1);
});

test("an anchor that vanished is drift under any scheme — absence is not a derivation", () => {
  // The dangerous reading: `lost` code looking like "just an old hash" and going quiet.
  const d = witnessDrift([{ anchorId: "gone", bodyHash: fixtureHash("old") }], legacyIndex(new Map()));
  assert.equal(d.length, 1);
  assert.notEqual(d[0]!.unverifiable, true, "a missing anchor must never read as unverifiable");
  assert.equal(realDrift(d).length, 1);
});

test("an unchanged witness is silent whatever the scheme", () => {
  assert.deepEqual(witnessDrift([{ anchorId: "a1", bodyHash: fixtureHash("same") }], legacyIndex(new Map([["a1", fixtureHash("same")]]))), []);
});

// --- a witness whose id another build minted ---------------------------------

const MINE_D: DerivationTag = {
  anchorScheme: 3, hashScheme: 2,
  parserIntegrity: "p".repeat(64), grammarDigest: "g".repeat(64),
};
const THEIRS_D: DerivationTag = { ...MINE_D, grammarDigest: "f".repeat(64) };
const mine = anchorIndex(new Map(), { tags: [MINE_D], anyUntagged: false });

/**
 * An anchor id is derived from the parse — two grammars mint different ids for the
 * same overload — so a witness can name an id this build would never produce.
 *
 * `live.get(id) ?? ABSENT_HASH` turned that into a confident claim that the code is
 * gone, because ABSENT_HASH is comparable to everything on purpose. The witness has
 * to say "cannot tell" instead, which is the answer `unverifiable` already exists
 * for. See docs/anchor-id-provenance.md §6.
 */
test("a witness minted by another build is unverifiable, not drift to absent", () => {
  const d = witnessDrift([{ anchorId: "a_theirs", bodyHash: hashTokens(["body"], THEIRS_D) }], mine);
  assert.equal(d.length, 1, "still reported — the mark does need attention");
  assert.equal(d[0]!.unverifiable, true, "but it is not evidence the code moved");
  assert.deepEqual(realDrift(d), [], "so nothing that escalates on drift escalates on it");
});

/**
 * The control, and the reason the test above is not just "absence was suppressed".
 * A symbol THIS build did mint, now missing, is a deletion and must still say so.
 */
test("a symbol this build minted, now absent, is still real drift", () => {
  const d = witnessDrift([{ anchorId: "a_mine", bodyHash: hashTokens(["body"], MINE_D) }], mine);
  assert.equal(d.length, 1);
  assert.ok(!d[0]!.unverifiable, "this index could have resolved it, so its absence is real");
  assert.equal(realDrift(d).length, 1);
});
