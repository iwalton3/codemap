import { test } from "node:test";
import assert from "node:assert/strict";
import type { NodeVersion, DerivationTag } from "./schema.js";
import { hashTokens } from "./normalize.js";
import { anchorIndex } from "./anchor-resolve.js";
import { evalVersion, selectWinner } from "./doc-version.js";

/**
 * What a doc does with a citation whose id this index could not have minted.
 *
 * This is the site with durable consequences. `dangling` scores in `badness`,
 * `badness` picks which version of a doc wins on this branch, and a winner that is
 * not `fresh` makes `documentNode` FORK a new version instead of editing in place.
 * So an id spelled by another build used to take a write.
 *
 * See docs/anchor-id-provenance.md §3 and §6.
 */

const MINE: DerivationTag = {
  anchorScheme: 3, hashScheme: 2, parserIntegrity: "p".repeat(64), grammarDigest: "g".repeat(64),
};
const THEIRS: DerivationTag = { ...MINE, grammarDigest: "f".repeat(64) };

const version = (over: Partial<NodeVersion>): NodeVersion => ({
  versionId: "v1", nodeId: "n1", type: "process", title: "t", summary: "s", body: "b",
  citations: [], createdCommit: null, createdBranch: null, createdAt: "2026-01-01T00:00:00Z",
  ...over,
} as NodeVersion);

/** An index built by MINE that holds nothing — the code is not in this checkout. */
const mineEmpty = anchorIndex(new Map([["a_other", hashTokens(["x"], MINE)]]), { tags: [MINE], anyUntagged: false });

test("a citation from another build is unverifiable, not a hole", () => {
  const v = version({ citations: [{ anchorId: "a_theirs", acceptedHashes: [hashTokens(["body"], THEIRS)] }] });
  const e = evalVersion(v, mineEmpty);
  assert.deepEqual(e.dangling, [], "not a hole — nobody established the symbol is gone");
  assert.deepEqual(e.unverifiable, ["a_theirs"]);
  assert.equal(e.status, "unverifiable");
  assert.equal(e.badness, 0,
    "and out of badness, so it cannot reshuffle which version wins or make documentNode fork");
});

test("a citation this build did mint, now absent, is still a hole", () => {
  const v = version({ citations: [{ anchorId: "a_mine", acceptedHashes: [hashTokens(["body"], MINE)] }] });
  const e = evalVersion(v, mineEmpty);
  assert.deepEqual(e.dangling, ["a_mine"], "this index could have resolved it, so its absence is real");
  assert.equal(e.status, "dangling");
  assert.equal(e.badness, 1);
});

/**
 * A tombstone inverts the polarity, so an undecidable citation counts AGAINST it.
 *
 * Its claim is "these are gone", inferred from absence — and an id this index could
 * not have minted is not evidence of absence. Letting it win on that would HIDE a
 * doc whose code may be sitting right there, and hiding is the direction with no
 * recovery: nobody goes looking for a doc they cannot see.
 */
test("a tombstone does not get to win on citations nobody could resolve", () => {
  const cites = [{ anchorId: "a_theirs", acceptedHashes: [hashTokens(["body"], THEIRS)] }];
  const tomb = version({ versionId: "v_tomb", citations: cites, removed: true } as Partial<NodeVersion>);
  const e = evalVersion(tomb, mineEmpty);
  assert.equal(e.status, "removed");
  assert.equal(e.badness, 1, "undecidable is not evidence of removal");

  // And the content version wins over it, so the doc stays visible.
  const content = version({ versionId: "v_content", citations: cites });
  assert.equal(selectWinner([tomb, content], mineEmpty).v.versionId, "v_content");
});

test("a tombstone whose citations this build resolved as gone still wins", () => {
  const cites = [{ anchorId: "a_mine", acceptedHashes: [hashTokens(["body"], MINE)] }];
  const tomb = version({ versionId: "v_tomb", citations: cites, removed: true } as Partial<NodeVersion>);
  assert.equal(evalVersion(tomb, mineEmpty).badness, 0, "control: a real removal still reads as one");
  const content = version({ versionId: "v_content", citations: cites });
  assert.equal(selectWinner([tomb, content], mineEmpty).v.versionId, "v_tomb");
});
