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

/** A tag this build would never produce — a snapshot from another grammar or parser. */
const FOREIGN: DerivationTag = { anchorScheme: 3, hashScheme: 2, parserIntegrity: "p_other", grammarDigest: "g_other" };
const tagged = (a: Anchor, derivation: DerivationTag): Anchor => ({ ...a, derivation });

/**
 * A snapshot derived by another build is NOT CACHED, so it is rebuilt.
 *
 * This is the repair the codebase already performs for a scheme bump, extended to
 * the question the scheme numbers cannot ask: a re-vendored grammar moves every
 * body hash without touching either number. A snapshot is minted atomically by one
 * build, so unlike `@work` it has a truthful derivation and can simply be
 * regenerated — `ensureSnapshot` does it in seconds, and its comment ("a hit here
 * means genuinely usable") stays true only because of this check.
 *
 * Reporting the mismatch downstream instead would leave a repairable cache in
 * place and flood the diff with symbols nobody can compare.
 */
test("a snapshot from a different build reads as not cached, not as drift", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-diff-tag-"));
  try {
    await writeSnapshot(root, "base_sha", "main", [tagged(anchor("a_1", "pay", "h1"), FOREIGN)], "2026-07-15T00:00:00Z");
    await writeSnapshot(root, "head_sha", "feature", [tagged(anchor("a_1", "pay", "h2"), FOREIGN)], "2026-07-15T01:00:00Z");

    const d = await computeDiff(root, "base_sha", "head_sha");
    assert.ok("error" in d, "a foreign-derivation snapshot must not be silently compared");
    assert.match(d.error, /no cached snapshot for base/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * Untagged snapshots stay usable, which is deliberate and is the same answer
 * `comparableDerivation` gives.
 *
 * Every snapshot cached before tags existed is untagged. Treating those as stale
 * would rebuild every cache on upgrade to answer a question they cannot answer, and
 * two different meanings for "untagged" would be worse than either one.
 */
test("an untagged snapshot still diffs, rather than going silent", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-diff-legacy-"));
  try {
    await writeSnapshot(root, "base_sha", "main", [anchor("a_1", "pay", "h1")], "2026-07-15T00:00:00Z");
    await writeSnapshot(root, "head_sha", "feature", [anchor("a_1", "pay", "h2")], "2026-07-15T01:00:00Z");

    const d = await computeDiff(root, "base_sha", "head_sha");
    assert.ok(!("error" in d), "expected a diff result");
    assert.deepEqual(d.changed.map((b) => b.id), ["a_1"]);
    assert.deepEqual(d.unverifiable, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
