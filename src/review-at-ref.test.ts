/**
 * A review function handed a `ref` resolves a DOC at that ref too, not only its hashes.
 *
 * Which version of a doc wins depends on the code in front of you (`loadNodesAt`), so a
 * node's anchor list at a pull request's head can differ from the working tree's. These
 * functions took hashes from the ref and the anchor list from `@work`, so a sign-off made
 * at a head witnessed code the doc does not cite there.
 *
 * The fixture: one node with two versions. v1 cites A, which only the working tree has;
 * v2 cites B, which only the snapshot at `REF` has. v1 wins at `@work`, v2 at `REF`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Anchor, LogicalNode, State } from "./schema.js";
import { writeStore, writeSnapshot, writeNode, writeReviews, readReviews } from "./store.js";
import { legacyIndex } from "./anchor-resolve.js";
import { markReviewed, markReviewedBatch, witnessesFor, reviewStatesFor } from "./reviews.js";
import { reviewTriageFor } from "./triage.js";
import { indexBlob } from "./repo.js";
import { discard } from "./test-tmp.js";

const REF = "ref_sha";

async function twoVersions() {
  const root = mkdtempSync(join(tmpdir(), "codemap-reviewref-"));
  mkdirSync(join(root, ".codemap"), { recursive: true });
  const [a] = await indexBlob("export function alpha() {\n  return 1;\n}\n", "src/a.ts");
  const [b] = await indexBlob("export function beta() {\n  return 2;\n}\n", "src/b.ts");
  const idx = (xs: Anchor[]) => legacyIndex(new Map(xs.map((x) => [x.id, x.bodyHash])));
  const node = (anchors: string[]): LogicalNode =>
    ({ id: "n", type: "module", title: "N", summary: "s", body: "b", anchors } as LogicalNode);

  await writeNode(root, node([a!.id]), { hashes: idx([a!]), commit: null, branch: null });
  // Against an index without A, v1 is not fresh, so this forks: v2 citing B.
  await writeNode(root, node([b!.id]), { hashes: idx([b!]), commit: null, branch: null });

  await writeStore(root, [a!], { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State);
  await writeSnapshot(root, REF, "feature", [b!], "2026-09-18T00:00:00Z");
  return { root, a: a!, b: b!, cleanup: () => discard(root) };
}

test("a node mark made at a ref witnesses what the doc cites THERE", async () => {
  const u = await twoVersions();
  try {
    const r = await markReviewed(u.root, { targetKind: "node", targetId: "n", level: "logical", actor: "agent", ref: REF });
    assert.ok(!("error" in r), `marked: ${JSON.stringify(r)}`);
    const row = (await readReviews(u.root)).reviews.find((x) => x.target.id === "n")!;
    assert.deepEqual(row.witnesses.map((w) => w.anchorId), [u.b.id]);
    assert.equal(row.witnesses[0]!.bodyHash, u.b.bodyHash);
  } finally { u.cleanup(); }
});

test("witnessesFor a node at a ref takes the version that wins at the ref", async () => {
  const u = await twoVersions();
  try {
    const ws = await witnessesFor(u.root, { kind: "node", id: "n" }, REF);
    assert.deepEqual(ws.map((w) => w.anchorId), [u.b.id]);
  } finally { u.cleanup(); }
});

test("reviewStatesFor at a ref judges a node mark against the ref's version", async () => {
  const u = await twoVersions();
  try {
    await writeReviews(u.root, [{
      id: "rev_1", target: { kind: "node", id: "n" }, level: "logical", reviewer: "me", actor: "agent",
      at: "2026-09-18T00:00:00Z", reviewedCommit: REF,
      witnesses: [{ anchorId: u.b.id, bodyHash: u.b.bodyHash }],
      accepted: [{ anchorId: u.b.id, entries: [{ bodyHash: u.b.bodyHash, commit: REF, branch: "feature", at: "2026-09-18T00:00:00Z" }] }],
    }]);
    const s = (await reviewStatesFor(u.root, [{ kind: "node", id: "n" }], { ref: REF })).get("node:n")!;
    assert.equal(s.logical.state, "reviewed");
  } finally { u.cleanup(); }
});

test("reviewTriageFor at a ref derives a node's code review from the ref's citations", async () => {
  const u = await twoVersions();
  try {
    const m = await markReviewedBatch(u.root, [u.b.id], { level: "code", actor: "agent", ref: REF });
    assert.equal(m.marked, 1);
    const t = (await reviewTriageFor(u.root, [{ kind: "node", id: "n" }], { ref: REF })).get("node:n")!;
    assert.equal(t.review.code.state, "reviewed", "B is the node's code at the ref, and B was reviewed there");
  } finally { u.cleanup(); }
});
