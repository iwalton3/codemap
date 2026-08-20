import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Anchor, State } from "./schema.js";
import { writeStore, writeSnapshot, readReviews } from "./store.js";
import { containedAnchorIds, markReviewedBatch, unmarkCovered, reviewStatesFor } from "./reviews.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;

const at = (id: string, path: string[], kind: Anchor["kind"], hash: string, startByte: number, endByte: number): Anchor => ({
  id, file: "src/Orders.cs", symbolPath: path, kind, bodyHash: hash, lastVerifiedCommit: null,
  loc: { startByte, endByte, startLine: startByte, endLine: endByte },
});

// A class and the two methods inside it, plus a second class in the same file whose
// member happens to share the leaf name.
const CLASS = at("a_cls", ["Orders", "Ledger"], "class", "sha256:cls", 100, 900);
const M1 = at("a_m1", ["Orders", "Ledger", "Post"], "method", "sha256:m1", 200, 400);
const M2 = at("a_m2", ["Orders", "Ledger", "Void"], "method", "sha256:m2", 500, 800);
const OTHER = at("a_far", ["Orders", "Audit"], "class", "sha256:far", 1000, 1200);

test("containment is decided by the span, not by the symbol path alone", () => {
  const anchors = [CLASS, M1, M2, OTHER];
  assert.deepEqual(containedAnchorIds(anchors, "a_cls").sort(), ["a_m1", "a_m2"]);
  assert.deepEqual(containedAnchorIds(anchors, "a_far"), [], "a sibling type contains nothing of the other's");

  // Two same-named types in one file (told apart by a disambiguator) share a path
  // prefix, so their members would cross-claim on the path alone.
  const twin = { ...CLASS, id: "a_cls2", disambiguator: "#1", loc: { startByte: 2000, endByte: 2400, startLine: 2000, endLine: 2400 } };
  assert.deepEqual(containedAnchorIds([...anchors, twin], "a_cls2"), [], "a same-named twin elsewhere in the file claims no members");

  const noSpan = { ...M1, loc: undefined };
  assert.deepEqual(containedAnchorIds([CLASS, noSpan], "a_cls"), [], "an unprovable cover is not a cover");
});

/**
 * The point of writing per-member marks rather than one blanket claim: each
 * witnesses its OWN hash, so a later edit to one method stales that method and
 * leaves the rest of the sign-off standing.
 */
test("a cover marks each member at its own hash, so one member's edit stales only it", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-cover-"));
  try {
    await writeStore(root, [], state);
    await writeSnapshot(root, "headsha", "feature", [CLASS, M1, M2], "2026-08-19T00:00:00Z");
    await markReviewedBatch(root, ["a_cls"], { level: "code", actor: "human", attestation: "signed", ref: "headsha" });
    await markReviewedBatch(root, ["a_m1", "a_m2"], { level: "code", actor: "human", attestation: "signed", ref: "headsha", coveredBy: "a_cls" });

    const rows = (await readReviews(root)).reviews;
    assert.equal(rows.find((r) => r.target.id === "a_cls")!.coveredBy, undefined, "the symbol actually clicked is not a cover row");
    assert.equal(rows.find((r) => r.target.id === "a_m1")!.coveredBy, "a_cls");
    assert.deepEqual(rows.find((r) => r.target.id === "a_m1")!.witnesses, [{ anchorId: "a_m1", bodyHash: "sha256:m1" }]);

    // The branch moves on: `Post` is rewritten, everything else stands.
    await writeSnapshot(root, "head2", "feature", [CLASS, { ...M1, bodyHash: "sha256:m1b" }, M2], "2026-08-19T01:00:00Z");
    const now = await reviewStatesFor(root, [{ kind: "anchor", id: "a_cls" }, { kind: "anchor", id: "a_m1" }, { kind: "anchor", id: "a_m2" }], { ref: "head2" });
    assert.equal(now.get("anchor:a_m1")!.code.state, "stale", "the edited member returns to the worklist");
    assert.equal(now.get("anchor:a_m2")!.code.state, "reviewed");
    assert.equal(now.get("anchor:a_cls")!.code.state, "reviewed", "a type's hash is its shell — a method body is not in it");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("withdrawing a container's sign-off takes its cover with it, and nothing else", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-cover-"));
  try {
    await writeStore(root, [], state);
    await writeSnapshot(root, "headsha", "feature", [CLASS, M1, M2], "2026-08-19T00:00:00Z");
    // `Void` was signed on its own first; the class sign-off must not restate it as
    // borrowed, or taking the class back would take a mark it never made.
    await markReviewedBatch(root, ["a_m2"], { level: "code", actor: "human", attestation: "signed", ref: "headsha" });
    await markReviewedBatch(root, ["a_m1", "a_m2"], { level: "code", actor: "human", attestation: "signed", ref: "headsha", coveredBy: "a_cls" });
    const after = (await readReviews(root)).reviews;
    assert.equal(after.find((r) => r.target.id === "a_m2")!.coveredBy, undefined, "a cover never overwrites a direct mark");

    const { removed } = await unmarkCovered(root, "a_cls", { level: "code", attestation: "signed" });
    assert.deepEqual(removed, ["a_m1"]);
    const left = (await readReviews(root)).reviews.map((r) => r.target.id).sort();
    assert.deepEqual(left, ["a_m2"], "the member signed in its own right survives");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a viewed cover and a signed cover are independent marks", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-cover-"));
  try {
    await writeStore(root, [], state);
    await writeSnapshot(root, "headsha", "feature", [CLASS, M1], "2026-08-19T00:00:00Z");
    await markReviewedBatch(root, ["a_m1"], { level: "code", actor: "human", attestation: "viewed", ref: "headsha", coveredBy: "a_cls" });
    await markReviewedBatch(root, ["a_m1"], { level: "code", actor: "human", attestation: "signed", ref: "headsha", coveredBy: "a_cls" });
    assert.deepEqual((await unmarkCovered(root, "a_cls", { level: "code", attestation: "signed" })).removed, ["a_m1"]);
    const left = (await readReviews(root)).reviews;
    assert.equal(left.length, 1);
    assert.equal(left[0]!.attestation, "viewed", "unsigning must not clear the exposure mark");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
