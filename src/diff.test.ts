import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Anchor, DerivationTag, LogicalNode } from "./schema.js";
import { writeSnapshot, writeNode, dropSnapshot, snapshotIsDirty } from "./store.js";
import { computeDiff } from "./diff.js";
import { fixtureHash } from "./fixture-hash.js";
import { discard } from "./test-tmp.js";

function anchor(id: string, symbol: string, bodyHash: string): Anchor {
  // Through `fixtureHash`, because `sameBody` refuses a value that is not a hash —
  // a bare tag like "h1" would compare unequal to itself and every symbol would
  // read as changed. The tags stay readable; they just carry a real digest.
  return { id, file: "src/pay.ts", symbolPath: [symbol], kind: "function",
    bodyHash: fixtureHash(bodyHash), lastVerifiedCommit: null };
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
    discard(root);
  }
});

test("diff against an uncached base ref returns a helpful error", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-diff-"));
  try {
    const r = await computeDiff(root, "never_indexed");
    assert.ok("error" in r && /no cached snapshot/.test(r.error));
  } finally {
    discard(root);
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
  } finally { discard(root); }
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
    // Asserted on the CAUSE and the remedy, not on a literal sentence. The wording now
    // comes from `snapshotRefusal`, which owns this rule for every reader of a cached
    // snapshot; pinning the phrase made a message improvement look like a regression.
    assert.match(d.error, /base "base_sha"/, "says which side");
    assert.match(d.error, /different anchor\/hash derivation/, "and why it is unusable");
    assert.match(d.error, /codemap snapshot/, "and the command that repairs it");
  } finally { discard(root); }
});

/**
 * Untagged snapshots stay usable, which is deliberate and is the same answer
 * `comparableHashDerivation` gives.
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
  } finally { discard(root); }
});

// --- a snapshot that is not the commit it is named after -------------------------

/**
 * `init`/`snapshot` build a snapshot by indexing the working TREE and label it with
 * HEAD's sha. On a dirty checkout that row contains the branch's uncommitted work
 * under the commit's name, so `diff <sha>` compared the base against the same tree
 * and reported nothing changed — a confidently wrong answer at step one of the review
 * protocol, and silent. See COD-3.
 */
test("a base snapshot taken from a dirty tree is refused, not diffed", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-dirty-"));
  try {
    const same: Anchor[] = [anchor("a_keep", "keep", "h1")];
    await writeSnapshot(root, "dirty_sha", "main", same, "2026-08-26T00:00:00Z", { dirty: true });
    assert.equal(snapshotIsDirty(root, "dirty_sha"), true, "the flag survives the round trip");

    const r = await computeDiff(root, "dirty_sha") as { error?: string };
    assert.ok(r.error, "a diff against it must not be answered");
    assert.match(r.error!, /uncommitted changes/);

    // The distinction that makes the refusal useful rather than annoying: the
    // not-cached message tells you to run `init`, and `init` on a dirty tree is what
    // produced this. Following it would loop.
    assert.doesNotMatch(r.error!, /no cached snapshot/, "this is not the not-cached case");
    assert.doesNotMatch(r.error!, /codemap init/, "and must not send them back to the command that caused it");
  } finally { discard(root); }
});

test("a snapshot written from a clean tree diffs normally", async () => {
  // The control. Without it the test above passes just as well against a build that
  // refuses EVERY base, which would be a worse bug than the one being fixed.
  const root = mkdtempSync(join(tmpdir(), "codemap-clean-"));
  try {
    await writeSnapshot(root, "base_sha", "main", [anchor("a_keep", "keep", "h1")], "2026-08-26T00:00:00Z");
    await writeSnapshot(root, "head_sha", "feature", [anchor("a_keep", "keep", "h1"), anchor("a_add", "audit", "h4")], "2026-08-26T01:00:00Z");
    assert.equal(snapshotIsDirty(root, "base_sha"), false, "omitting the flag means clean");

    const r = await computeDiff(root, "base_sha", "head_sha") as { added?: unknown[]; error?: string };
    assert.equal(r.error, undefined);
    assert.equal(r.added?.length, 1, "and it still reports the change it should");
  } finally { discard(root); }
});
