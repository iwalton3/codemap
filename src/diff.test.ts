import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Anchor, DerivationTag, LogicalNode } from "./schema.js";
import { writeSnapshot, writeNode, dropSnapshot } from "./store.js";
import { computeDiff } from "./diff.js";

function anchor(id: string, symbol: string, bodyHash: string): Anchor {
  return { id, file: "src/pay.ts", symbolPath: [symbol], kind: "function", bodyHash, lastVerifiedCommit: null };
}

// computeDiff resolves each ref via `git rev-parse`; in a non-git temp dir that
// fails and it falls back to treating the ref string as a raw sha — so we can
// diff two hand-written cached snapshots with no git and no indexing involved.
test("diff of two cached snapshots reports added/removed/changed + impact", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-diff-"));
  try {
    // base: keep, drop, change  |  head: keep, change(new hash), add
    const base: Anchor[] = [anchor("a_keep", "keep", "h1"), anchor("a_drop", "refund", "h2"), anchor("a_chg", "transfer", "h3")];
    const head: Anchor[] = [anchor("a_keep", "keep", "h1"), anchor("a_chg", "transfer", "h3_NEW"), anchor("a_add", "audit", "h4")];
    await writeSnapshot(root, "base_sha", "main", base, "2026-07-15T00:00:00Z");
    await writeSnapshot(root, "head_sha", "feature", head, "2026-07-15T01:00:00Z");

    const node: LogicalNode = { id: "flow1", type: "process", title: "Transfer flow", summary: "", anchors: ["a_chg", "a_drop"], body: "" };
    await writeNode(root, node);

    const r = await computeDiff(root, "base_sha", "head_sha");
    assert.ok(!("error" in r), "expected a diff result");
    if ("error" in r) return;

    assert.deepEqual(r.added.map((b) => b.id), ["a_add"]);
    assert.deepEqual(r.removed.map((b) => b.id), ["a_drop"]);
    assert.deepEqual(r.changed.map((b) => b.id), ["a_chg"]);

    // The node cites the changed + removed anchors, so it is impacted (both hit).
    assert.equal(r.impact.nodes.length, 1);
    assert.equal(r.impact.nodes[0]!.id, "flow1");
    assert.deepEqual(r.impact.nodes[0]!.anchors.sort(), ["a_chg", "a_drop"]);

    // It's a process node → surfaces as an impacted flow too.
    assert.equal(r.impact.flows.length, 1);
    assert.equal(r.impact.flows[0]!.id, "flow1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("diff against an uncached base ref returns a helpful error", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-diff-"));
  try {
    const r = await computeDiff(root, "never_indexed");
    assert.ok("error" in r && /no cached snapshot/.test(r.error));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The reserved refs are not snapshots and dropping one is not a cache eviction.
 *
 * `dropSnapshot` deletes anchors BY REF, so `@work` would take the live index and
 * `@orphan` would take the retained state of anchors that have already left the
 * tree — which nothing rebuilds, because neither came from a commit.
 * `writeSnapshot` has refused `@work` since it was written; this side was
 * unguarded, and had no callers, which is how the asymmetry survived.
 */
test("the reserved refs cannot be dropped as if they were snapshots", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-drop-"));
  try {
    await writeSnapshot(root, "some_sha", "main", [anchor("a_1", "pay", "h1")], "2026-07-15T00:00:00Z");
    for (const ref of ["@work", "@orphan"]) {
      assert.throws(() => dropSnapshot(root, ref), /not a snapshot/, `${ref} was droppable`);
    }
    dropSnapshot(root, "some_sha"); // an actual snapshot still goes
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const TAG_A: DerivationTag = { anchorScheme: 3, hashScheme: 2, parserIntegrity: "p1", grammarDigest: "g_old" };
const TAG_B: DerivationTag = { anchorScheme: 3, hashScheme: 2, parserIntegrity: "p1", grammarDigest: "g_new" };
const tagged = (a: Anchor, derivation: DerivationTag): Anchor => ({ ...a, derivation });

/**
 * A re-vendored grammar tokenizes unchanged code differently, so every body hash
 * moves while `HASH_SCHEME` stays put. The numeric schemes agree, the hashes
 * differ, and without the derivation tag the diff reports the whole repository as
 * rewritten — the phantom-diff failure the schemes exist to prevent, arriving
 * through a door they do not cover.
 */
test("a grammar change is not reported as code drift", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-diff-tag-"));
  try {
    const base = [tagged(anchor("a_keep", "keep", "h1"), TAG_A), tagged(anchor("a_real", "refund", "h2"), TAG_A)];
    // Same code, re-tokenized: every hash moved. One symbol genuinely changed too,
    // and it must still be reported — the point is separating them, not suppressing.
    const head = [tagged(anchor("a_keep", "keep", "h1_RETOK"), TAG_B), tagged(anchor("a_real", "refund", "h2_REAL"), TAG_A)];
    await writeSnapshot(root, "base_sha", "main", base, "2026-07-15T00:00:00Z");
    await writeSnapshot(root, "head_sha", "feature", head, "2026-07-15T01:00:00Z");

    const d = await computeDiff(root, "base_sha", "head_sha");
    assert.ok(!("error" in d), "expected a diff result");
    assert.deepEqual(d.changed.map((b) => b.id), ["a_real"], "the real change must survive");
    assert.deepEqual(d.unverifiable.map((b) => b.id), ["a_keep"], "the re-tokenized one is not drift");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * An untagged side falls back to comparing, which is today's behaviour and has to
 * be: every stored value predates tags, and answering "unverifiable" for all of
 * them would trade a rare false positive for a universal false negative.
 */
test("an untagged side still compares, rather than going silent", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-diff-legacy-"));
  try {
    await writeSnapshot(root, "base_sha", "main", [anchor("a_1", "pay", "h1")], "2026-07-15T00:00:00Z");
    await writeSnapshot(root, "head_sha", "feature", [tagged(anchor("a_1", "pay", "h2"), TAG_B)], "2026-07-15T01:00:00Z");

    const d = await computeDiff(root, "base_sha", "head_sha");
    assert.ok(!("error" in d), "expected a diff result");
    assert.deepEqual(d.changed.map((b) => b.id), ["a_1"]);
    assert.deepEqual(d.unverifiable, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
