import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAcceptance, recordAcceptance, type Ancestry } from "./acceptance.js";
import type { AcceptedEntry } from "./schema.js";

const e = (bodyHash: string, commit: string | null, at = "2026-08-18T00:00:00Z"): AcceptedEntry =>
  ({ bodyHash, commit, branch: null, at });

/**
 * A commit graph (`commit -> parents`) viewed from `ref`. Commits the graph does
 * not mention are roots, so naming one is how a test puts an acceptance on a
 * lineage this ref does not descend from.
 */
const viewedFrom = (ref: string, parents: Record<string, string[]> = {}): Ancestry => {
  const ancestorsOf = (c: string): Set<string> => {
    const seen = new Set<string>();
    const walk = [...(parents[c] ?? [])];
    while (walk.length) {
      const p = walk.pop()!;
      if (seen.has(p)) continue;
      seen.add(p);
      walk.push(...(parents[p] ?? []));
    }
    return seen;
  };
  return {
    onRef: (c) => c === null || c === ref || ancestorsOf(ref).has(c),
    precedes: (a, b) => a !== null && b !== null && a !== b && ancestorsOf(b).has(a),
  };
};

/** A straight line of commits, oldest first, viewed from the last one. */
const chain = (...commits: string[]): Ancestry =>
  viewedFrom(commits[commits.length - 1]!, Object.fromEntries(commits.map((c, i) => [c, i ? [commits[i - 1]!] : []])));

test("the newest acceptance on this ancestry is a direct approval", () => {
  const r = resolveAcceptance([e("H1", "c1"), e("H2", "c2")], "H2", chain("c1", "c2"));
  assert.equal(r.via, "direct");
});

test("a body approved on another lineage replays — switching branches is not a revert", () => {
  // H_pr was approved on a PR branch this ref does not descend from.
  const r = resolveAcceptance([e("H_dev", "c1"), e("H_pr", "pr1")], "H_pr", chain("c1"));
  assert.equal(r.via, "replayed");
  assert.equal(r.entry?.commit, "pr1");
});

test("a commit moving this ancestry BACK to an older approved body is a revert", () => {
  // Approved H1 at c1, then H2 at c2; c3 put the code back to H1 without a new mark.
  const r = resolveAcceptance([e("H1", "c1"), e("H2", "c2")], "H1", chain("c1", "c2", "c3"));
  assert.equal(r.via, "reverted", "the code went backwards on its own history");
  assert.equal(r.entry?.commit, "c1");
  assert.equal(r.supersededBy?.commit, "c2", "names the newer body it went back from");
});

test("re-approving a body after it came back stands on its own", () => {
  const entries = [e("H1", "c1"), e("H2", "c2"), e("H1", "c3")];
  const r = resolveAcceptance(entries, "H1", chain("c1", "c2", "c3"));
  assert.equal(r.via, "direct", "the newest acceptance on this history approves the live body");
  assert.equal(r.entry?.commit, "c3");
});

test("the two cases are told apart by ancestry alone, not by content", () => {
  const entries = [e("H1", "c1"), e("H2", "c2")];
  // Same entries, same live body — only the viewed ref's history differs.
  assert.equal(resolveAcceptance(entries, "H1", chain("c1", "c2", "c3")).via, "reverted");
  assert.equal(resolveAcceptance(entries, "H1", chain("c1")).via, "direct");
});

test("an acceptance off this ancestry cannot supersede one on it", () => {
  // H2 was approved on a branch this ref never took; H1 is still what c1 approved.
  const r = resolveAcceptance([e("H1", "c1"), e("H2", "other")], "H1", chain("c1"));
  assert.equal(r.via, "direct");
  assert.equal(r.supersededBy, undefined);
});

test("signing a stack tip before its base is not a revert", () => {
  // Walking a stack downwards writes the tip's acceptance first, so the array is
  // in the opposite order to the history. Verdicts come from ancestry, not position.
  const entries = [e("H2", "c2"), e("H1", "c1")];
  const tip = resolveAcceptance(entries, "H2", chain("c1", "c2"));
  assert.equal(tip.via, "direct", "the tip's own body is what the tip approved");
  assert.equal(tip.supersededBy, undefined, "an ancestor commit cannot supersede its descendant");
  assert.equal(resolveAcceptance(entries, "H1", chain("c1")).via, "direct", "and the base still reads direct");
});

test("a merge of two branches does not turn either acceptance into a revert", () => {
  // b0 → f1 and b0 → m1 are concurrent; m2 merges them, so both are ancestors of
  // the viewed ref and NEITHER follows the other. Whichever body won the merge is
  // the one that was approved for it.
  const merged = viewedFrom("m2", { m2: ["m1", "f1"], m1: ["b0"], f1: ["b0"], b0: [] });
  const entries = [e("H_f", "f1"), e("H_m", "m1")];
  assert.equal(resolveAcceptance(entries, "H_f", merged).via, "direct");
  assert.equal(resolveAcceptance(entries, "H_m", merged).via, "direct");
});

test("a legacy acceptance with no commit never raises a revert", () => {
  // Marks written before acceptances recorded a commit: their place in history is
  // unknown, so they neither supersede nor are superseded.
  const entries = [e("H1", null), e("H2", "c2")];
  assert.equal(resolveAcceptance(entries, "H1", chain("c1", "c2")).via, "direct");
  assert.equal(resolveAcceptance(entries, "H2", chain("c1", "c2")).via, "direct");
  assert.equal(resolveAcceptance([e("H1", null)], "H1", chain("c1")).via, "direct");
});

test("the verdict does not depend on the order acceptances were written", () => {
  const history = viewedFrom("m2", { m2: ["m1", "f1"], m1: ["b0"], f1: ["b0"], b0: [] });
  const entries = [e("H0", "b0"), e("H_f", "f1"), e("H_m", "m1")];
  for (const live of ["H0", "H_f", "H_m"]) {
    const forward = resolveAcceptance(entries, live, history).via;
    const backward = resolveAcceptance([...entries].reverse(), live, history).via;
    assert.equal(backward, forward, `${live} reads the same either way`);
  }
  // b0 is an ancestor of both later acceptances, so it is genuinely superseded.
  assert.equal(resolveAcceptance(entries, "H0", history).via, "reverted");
});

test("a body never approved is not accepted at all", () => {
  assert.equal(resolveAcceptance([e("H1", "c1")], "H_new", chain("c1")).via, "none");
  assert.equal(resolveAcceptance([], "H1", chain("c1")).via, "none");
  assert.equal(resolveAcceptance([e("H1", "c1")], undefined, chain("c1")).via, "none");
});

test("recordAcceptance appends, dedupes the same body at the same commit, and stays bounded", () => {
  let entries: AcceptedEntry[] = [];
  entries = recordAcceptance(entries, e("H1", "c1"), 3);
  entries = recordAcceptance(entries, e("H1", "c1"), 3);
  assert.equal(entries.length, 1, "re-approving the identical body at the same commit is a no-op");

  entries = recordAcceptance(entries, e("H2", "c2"), 3);
  entries = recordAcceptance(entries, e("H3", "c3"), 3);
  entries = recordAcceptance(entries, e("H4", "c4"), 3);
  assert.deepEqual(entries.map((x) => x.bodyHash), ["H2", "H3", "H4"], "capped, oldest dropped");
});

test("the same body re-approved on a different commit is kept as its own acceptance", () => {
  const entries = recordAcceptance([e("H1", "c1")], e("H1", "c2"), 10);
  assert.equal(entries.length, 2, "provenance differs, so both acceptances are worth keeping");
});
