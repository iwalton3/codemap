import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateWalkthrough, walkCoverage, buildWalkthrough, staleChapters, citedAnchors,
  type WalkInput,
} from "./walkthrough.js";
import { fixtureHash } from "./fixture-hash.js";

const sym = (anchorId: string) => ({ kind: "symbol" as const, anchorId });
const prose = (text: string) => ({ kind: "prose" as const, text });

const feature = (title: string, chapters: { title: string; blocks: any[] }[], over: Partial<WalkInput> = {}): WalkInput =>
  ({ title, summary: `what ${title} is for`, chapters, ...over });

test("a chapter interleaves prose and symbols, in the order the agent wrote them", () => {
  // Not a paragraph with code boxes bolted underneath: the prose sits BETWEEN the
  // symbols and says what to look at next, which is what makes it a walkthrough.
  const f = feature("Confirmation axis", [{
    title: "the state machine",
    blocks: [
      prose("The aggregate owns every transition. Read the guard first:"),
      sym("a_created"),
      prose("…which is the only place Pending is enforced."),
      sym("a_confirmed"),
    ],
  }]);
  assert.deepEqual(citedAnchors([f]).map((c) => c.anchorId), ["a_created", "a_confirmed"],
    "symbols come back in reading order");
  assert.deepEqual(f.chapters[0]!.blocks.map((b) => b.kind), ["prose", "symbol", "prose", "symbol"]);
});

test("a walkthrough may not cite code the pull request does not touch", () => {
  const v = validateWalkthrough(
    [feature("F", [{ title: "c", blocks: [sym("a_1"), sym("a_elsewhere")] }])],
    new Set(["a_1", "a_2"]),
  );
  assert.deepEqual(v.notInPr, ["a_elsewhere"]);
  assert.equal(v.ok, false);
});

test("no symbol may be claimed by two chapters", () => {
  // The reviewer must never read one twice, or have to work out which chapter's
  // sign-off counted for it.
  const v = validateWalkthrough([
    feature("F", [
      { title: "endpoints", blocks: [sym("a_1"), sym("a_2")] },
      { title: "the job", blocks: [sym("a_2")] },
    ]),
  ], new Set(["a_1", "a_2"]));
  assert.deepEqual(v.claimedTwice, [{ anchorId: "a_2", chapters: ["endpoints", "the job"] }]);
  assert.equal(v.ok, false);

  // …including across two different features
  const across = validateWalkthrough([
    feature("A", [{ title: "one", blocks: [sym("a_1")] }]),
    feature("B", [{ title: "two", blocks: [sym("a_1")] }]),
  ], new Set(["a_1"]));
  assert.equal(across.claimedTwice.length, 1);
});

test("a chapter with no symbol in it is not a chapter", () => {
  const v = validateWalkthrough(
    [feature("F", [{ title: "just talking", blocks: [prose("some prose")] }])],
    new Set(["a_1"]),
  );
  assert.deepEqual(v.emptyChapters, ["just talking"]);
});

test("coverage counts what the reviewer would end up reading on GitHub instead", () => {
  // Not a tidiness metric: an uncovered symbol is work escaping the tool.
  const c = walkCoverage(
    [feature("F", [{ title: "c", blocks: [sym("a_1"), prose("x"), sym("a_2")] }])],
    new Set(["a_1", "a_2", "a_3", "a_4"]),
    9,
  );
  assert.deepEqual(c.uncovered, ["a_3", "a_4"]);
  assert.equal(c.covered, 2);
  assert.equal(c.total, 4);
  assert.equal(c.outsideQueue, 9, "generated and vendored code is EXPECTED to go unwalked — counted apart");
});

test("ids are derived from titles, so re-walking an unchanged structure keeps them", () => {
  // The ids key open/closed and sign-off state in the UI; minting fresh ones on
  // every walk would reset the reviewer's place in the change.
  const input = {
    pr: 264, head: "h", by: "agent", at: "2026-08-19T00:00:00Z",
    features: [feature("Confirmation axis", [{ title: "the state machine", blocks: [sym("a_1")] }])],
  };
  const hashes = new Map([["a_1", fixtureHash("A")]]);
  const a = buildWalkthrough(input, (id) => hashes.get(id));
  const b = buildWalkthrough(input, (id) => hashes.get(id));
  assert.equal(a.features[0]!.id, "confirmation-axis");
  assert.equal(a.features[0]!.chapters[0]!.id, "the-state-machine");
  assert.deepEqual(a, b);

  // two chapters that happen to share a title still get distinct ids
  const dup = buildWalkthrough({
    ...input,
    features: [feature("F", [{ title: "Notes", blocks: [sym("a_1")] }, { title: "Notes", blocks: [sym("a_2")] }])],
  }, () => fixtureHash("x"));
  const ids = dup.features[0]!.chapters.map((c) => c.id);
  assert.equal(new Set(ids).size, 2, ids.join(","));
});

test("a chapter is witnessed, so only the chapters whose code moved go stale", () => {
  // A walkthrough is a claim about code. When the submitter pushes, re-walking the
  // whole thing on a 22k-line PR is not affordable — and not necessary.
  const w = buildWalkthrough({
    pr: 1, head: "h", by: "agent", at: "t",
    features: [feature("F", [
      { title: "untouched", blocks: [sym("a_1")] },
      { title: "moved", blocks: [prose("look here"), sym("a_2")] },
    ])],
  }, (id) => ({ a_1: fixtureHash("A"), a_2: fixtureHash("B") } as Record<string, string>)[id]);

  assert.deepEqual(staleChapters(w, new Map([["a_1", fixtureHash("A")], ["a_2", fixtureHash("B")]])), []);
  assert.deepEqual(staleChapters(w, new Map([["a_1", fixtureHash("A")], ["a_2", fixtureHash("CHANGED")]])), ["moved"]);
  assert.deepEqual(staleChapters(w, new Map([["a_1", fixtureHash("A")]])), ["moved"], "a symbol that vanished is drift too");
});

test("a drive-by is recorded as data, not buried in prose", () => {
  // "What is in here that nobody told me about" is a question about the PR, so the
  // answer has to be filterable rather than a sentence in a summary.
  const w = buildWalkthrough({
    pr: 264, head: "h", by: "agent", at: "t",
    features: [
      feature("Supplier order confirmation", [{ title: "c1", blocks: [sym("a_1")] }]),
      feature("Airport reference data refresh", [{ title: "c2", blocks: [sym("a_2")] }], { unstated: true }),
    ],
  }, () => fixtureHash("x"));
  assert.deepEqual(w.features.filter((f) => f.unstated).map((f) => f.title), ["Airport reference data refresh"]);
  assert.equal(w.features[0]!.unstated, undefined, "the flag is absent, not false, when it is stated");
});
