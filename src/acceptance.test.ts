import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAcceptance, recordAcceptance, type Ancestry } from "./acceptance.js";
import type { AcceptedEntry } from "./schema.js";
import { fixtureHash } from "./fixture-hash.js";

/**
 * A body hash in the real format.
 *
 * These fixtures used bare tags, which `hashSchemeOf` refuses to read as hashes at
 * all — so every comparison here was passing because BOTH sides were unparseable
 * and defaulted to scheme 1 together. `fixtureHash` derives a real digest from the
 * label, so the tags stay readable and the values are what the code actually mints.
 */
const h = fixtureHash;

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
  // Every commit named in the graph exists; anything else has been rewritten away
  // (a squash- or rebase-merge) and cannot be placed on or off this history.
  const all = new Set([ref, ...Object.keys(parents), ...Object.values(parents).flat()]);
  return {
    onRef: (c) => c === null || c === ref || ancestorsOf(ref).has(c),
    precedes: (a, b) => a !== null && b !== null && a !== b && ancestorsOf(b).has(a),
    known: (c) => all.has(c),
  };
};

/** A straight line of commits, oldest first, viewed from the last one. */
const chain = (...commits: string[]): Ancestry =>
  viewedFrom(commits[commits.length - 1]!, Object.fromEntries(commits.map((c, i) => [c, i ? [commits[i - 1]!] : []])));

test("the newest acceptance on this ancestry is a direct approval", () => {
  const r = resolveAcceptance([e(h("H1"), "c1"), e(h("H2"), "c2")], h("H2"), chain("c1", "c2"));
  assert.equal(r.via, "direct");
});

test("a body approved on another lineage replays — switching branches is not a revert", () => {
  // H_pr was approved on a PR branch this ref does not descend from — and that
  // branch still EXISTS, which is what makes it a branch switch rather than a
  // commit that was rewritten away.
  const r = resolveAcceptance([e(h("H_dev"), "c1"), e(h("H_pr"), "pr1")], h("H_pr"), viewedFrom("c1", { c1: [], pr1: [] }));
  assert.equal(r.via, "replayed");
  assert.equal(r.entry?.commit, "pr1");
});

test("a squash-merged sign-off is direct, not a permanent `replayed` badge", () => {
  // Squash- and rebase-merge — GitHub's default — REWRITE the pull request's
  // commits, so the head a sign-off was witnessed against is not an ancestor of the
  // mainline and never will be. Read as a branch switch, every acceptance ever made
  // on a PR surface badged `replayed` forever and `reverted` could never fire for
  // one. A commit that no longer exists cannot be placed, so it is read the way a
  // legacy (null) commit is: on-ref, and unable to supersede anything.
  const squashed = viewedFrom("s1", { s1: ["base"], base: [] });   // prhead is gone
  assert.equal(resolveAcceptance([e(h("H1"), "prhead")], h("H1"), squashed).via, "direct");

  // The limit, stated rather than papered over: supersession needs one commit to
  // DESCEND from another, and a commit that no longer exists descends from nothing.
  // So two acceptances both made on a squashed branch cannot be ordered, and this
  // reports the benign verdict rather than guessing from write order — which is the
  // very thing that used to read 1,148 of 3,724 marks back as reverts.
  const both = resolveAcceptance([e(h("H1"), "prhead"), e(h("H2"), "prhead2")], h("H1"), squashed);
  assert.equal(both.via, "direct");

  // A revert on the surviving mainline is still caught, because those commits are
  // real and can be ordered.
  const line = viewedFrom("c3", { c3: ["c2"], c2: ["c1"], c1: [] });
  const onMain = resolveAcceptance([e(h("H1"), "c1"), e(h("H2"), "c2")], h("H1"), line);
  assert.equal(onMain.via, "reverted");
  assert.equal(onMain.supersededBy?.bodyHash, h("H2"));
});

test("a commit moving this ancestry BACK to an older approved body is a revert", () => {
  // Approved H1 at c1, then H2 at c2; c3 put the code back to H1 without a new mark.
  const r = resolveAcceptance([e(h("H1"), "c1"), e(h("H2"), "c2")], h("H1"), chain("c1", "c2", "c3"));
  assert.equal(r.via, "reverted", "the code went backwards on its own history");
  assert.equal(r.entry?.commit, "c1");
  assert.equal(r.supersededBy?.commit, "c2", "names the newer body it went back from");
});

test("re-approving a body after it came back stands on its own", () => {
  const entries = [e(h("H1"), "c1"), e(h("H2"), "c2"), e(h("H1"), "c3")];
  const r = resolveAcceptance(entries, h("H1"), chain("c1", "c2", "c3"));
  assert.equal(r.via, "direct", "the newest acceptance on this history approves the live body");
  assert.equal(r.entry?.commit, "c3");
});

test("the two cases are told apart by ancestry alone, not by content", () => {
  const entries = [e(h("H1"), "c1"), e(h("H2"), "c2")];
  // Same entries, same live body — only the viewed ref's history differs.
  assert.equal(resolveAcceptance(entries, h("H1"), chain("c1", "c2", "c3")).via, "reverted");
  assert.equal(resolveAcceptance(entries, h("H1"), chain("c1")).via, "direct");
});

test("an acceptance off this ancestry cannot supersede one on it", () => {
  // H2 was approved on a branch this ref never took; H1 is still what c1 approved.
  const r = resolveAcceptance([e(h("H1"), "c1"), e(h("H2"), "other")], h("H1"), chain("c1"));
  assert.equal(r.via, "direct");
  assert.equal(r.supersededBy, undefined);
});

test("signing a stack tip before its base is not a revert", () => {
  // Walking a stack downwards writes the tip's acceptance first, so the array is
  // in the opposite order to the history. Verdicts come from ancestry, not position.
  const entries = [e(h("H2"), "c2"), e(h("H1"), "c1")];
  const tip = resolveAcceptance(entries, h("H2"), chain("c1", "c2"));
  assert.equal(tip.via, "direct", "the tip's own body is what the tip approved");
  assert.equal(tip.supersededBy, undefined, "an ancestor commit cannot supersede its descendant");
  assert.equal(resolveAcceptance(entries, h("H1"), chain("c1")).via, "direct", "and the base still reads direct");
});

test("a merge of two branches does not turn either acceptance into a revert", () => {
  // b0 → f1 and b0 → m1 are concurrent; m2 merges them, so both are ancestors of
  // the viewed ref and NEITHER follows the other. Whichever body won the merge is
  // the one that was approved for it.
  const merged = viewedFrom("m2", { m2: ["m1", "f1"], m1: ["b0"], f1: ["b0"], b0: [] });
  const entries = [e(h("H_f"), "f1"), e(h("H_m"), "m1")];
  assert.equal(resolveAcceptance(entries, h("H_f"), merged).via, "direct");
  assert.equal(resolveAcceptance(entries, h("H_m"), merged).via, "direct");
});

test("a legacy acceptance with no commit never raises a revert", () => {
  // Marks written before acceptances recorded a commit: their place in history is
  // unknown, so they neither supersede nor are superseded.
  const entries = [e(h("H1"), null), e(h("H2"), "c2")];
  assert.equal(resolveAcceptance(entries, h("H1"), chain("c1", "c2")).via, "direct");
  assert.equal(resolveAcceptance(entries, h("H2"), chain("c1", "c2")).via, "direct");
  assert.equal(resolveAcceptance([e(h("H1"), null)], h("H1"), chain("c1")).via, "direct");
});

test("the verdict does not depend on the order acceptances were written", () => {
  const history = viewedFrom("m2", { m2: ["m1", "f1"], m1: ["b0"], f1: ["b0"], b0: [] });
  const entries = [e(h("H0"), "b0"), e(h("H_f"), "f1"), e(h("H_m"), "m1")];
  for (const live of [h("H0"), h("H_f"), h("H_m")]) {
    const forward = resolveAcceptance(entries, live, history).via;
    const backward = resolveAcceptance([...entries].reverse(), live, history).via;
    assert.equal(backward, forward, `${live} reads the same either way`);
  }
  // b0 is an ancestor of both later acceptances, so it is genuinely superseded.
  assert.equal(resolveAcceptance(entries, h("H0"), history).via, "reverted");
});

test("a body never approved is not accepted at all", () => {
  assert.equal(resolveAcceptance([e(h("H1"), "c1")], h("H_new"), chain("c1")).via, "none");
  assert.equal(resolveAcceptance([], h("H1"), chain("c1")).via, "none");
  assert.equal(resolveAcceptance([e(h("H1"), "c1")], undefined, chain("c1")).via, "none");
});

test("recordAcceptance appends, dedupes the same body at the same commit, and stays bounded", () => {
  let entries: AcceptedEntry[] = [];
  entries = recordAcceptance(entries, e(h("H1"), "c1"), 3);
  entries = recordAcceptance(entries, e(h("H1"), "c1"), 3);
  assert.equal(entries.length, 1, "re-approving the identical body at the same commit is a no-op");

  entries = recordAcceptance(entries, e(h("H2"), "c2"), 3);
  entries = recordAcceptance(entries, e(h("H3"), "c3"), 3);
  entries = recordAcceptance(entries, e(h("H4"), "c4"), 3);
  assert.deepEqual(entries.map((x) => x.bodyHash), [h("H2"), h("H3"), h("H4")], "capped, oldest dropped");
});

test("the same body re-approved on a different commit is kept as its own acceptance", () => {
  const entries = recordAcceptance([e(h("H1"), "c1")], e(h("H1"), "c2"), 10);
  assert.equal(entries.length, 2, "provenance differs, so both acceptances are worth keeping");
});

test("the cap evicts a duplicate before it forgets a body entirely", () => {
  // Dropping the oldest outright changed the VERDICT rather than just bounding
  // storage: a body you did sign, whose only entry had gone, read as `none` — stale,
  // with no record it was ever approved.
  let entries: AcceptedEntry[] = [];
  entries = recordAcceptance(entries, e(h("H_first"), "c0"), 3);
  // three more approvals of one other body, at different commits, would have
  // crowded the first one out
  for (const c of ["c1", "c2", "c3"]) entries = recordAcceptance(entries, e(h("H_hot"), c), 3);

  assert.equal(entries.length, 3);
  assert.ok(entries.some((x) => x.bodyHash === h("H_first")), "the body signed once is still known");
  assert.equal(entries.filter((x) => x.bodyHash === h("H_hot")).length, 2, "a hot body loses its own duplicates first");

  // and it still resolves rather than reading as never-approved
  assert.equal(resolveAcceptance(entries, h("H_first"), chain("c0", "c1", "c2", "c3")).via, "reverted");
});
