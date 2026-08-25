import { test } from "node:test";
import assert from "node:assert/strict";
import { legacyIndex, anchorIndex } from "./anchor-resolve.js";
import { hashTokens } from "./normalize.js";
import type { DerivationTag } from "./schema.js";
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
    Array.from({ length: 9 }, (_, i) => ({ id: `a_gen${i}`, lane: "generated" })),
  );
  assert.deepEqual(c.uncovered, ["a_3", "a_4"]);
  assert.equal(c.covered, 2);
  assert.equal(c.total, 4);
  assert.equal(c.outsideQueue, 9, "generated and vendored code is EXPECTED to go unwalked — counted apart");
  // WHICH ones. A bare `outsideQueue: 2` beside `uncovered: []` read as "two symbols you
  // cited are not in the queue" — not what it counts, and nothing to act on either way.
  assert.equal(c.outsideQueueSymbols!.length, 9);
  assert.equal(c.outsideQueueSymbols![0]!.lane, "generated");
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

  assert.deepEqual(staleChapters(w, legacyIndex(new Map([["a_1", fixtureHash("A")], ["a_2", fixtureHash("B")]]))), []);
  assert.deepEqual(staleChapters(w, legacyIndex(new Map([["a_1", fixtureHash("A")], ["a_2", fixtureHash("CHANGED")]]))), ["moved"]);
  assert.deepEqual(staleChapters(w, legacyIndex(new Map([["a_1", fixtureHash("A")]]))), ["moved"], "a symbol that vanished is drift too");
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

/**
 * A chapter is not stale because a teammate's build spells the ids differently.
 *
 * `staleChapters` used to read a missing id as ABSENT_HASH, which is comparable to
 * everything, so a walkthrough witnessed by another build flagged every chapter —
 * work nobody could do, on a surface whose whole point is showing a reviewer what
 * actually changed. `headMoved` already covers "the whole thing is suspect".
 */
test("a chapter whose ids this build could not have minted is not stale", () => {
  const MINE: DerivationTag = {
    anchorScheme: 3, hashScheme: 2, parserIntegrity: "p".repeat(64), grammarDigest: "g".repeat(64),
  };
  const THEIRS: DerivationTag = { ...MINE, grammarDigest: "f".repeat(64) };
  const theirHash = hashTokens(["body"], THEIRS);
  const w = buildWalkthrough({
    pr: 1, head: "h", by: "agent", at: "t",
    features: [feature("F", [{ title: "theirs", blocks: [sym("a_theirs")] }])],
  }, () => theirHash);

  const mineIdx = anchorIndex(new Map(), { tags: [MINE], anyUntagged: false });
  assert.deepEqual(staleChapters(w, mineIdx), [], "cannot tell is not the same as moved");

  // The control: an id this build DID mint, now gone, is still drift.
  const mineHash = hashTokens(["body"], MINE);
  const w2 = buildWalkthrough({
    pr: 1, head: "h", by: "agent", at: "t",
    features: [feature("F", [{ title: "mine", blocks: [sym("a_mine")] }])],
  }, () => mineHash);
  assert.deepEqual(staleChapters(w2, mineIdx), ["mine"]);
});

/**
 * The declared write schema has to admit what the read hands back.
 *
 * A description is checked by eye; a schema is checked by the CLIENT, before the call is
 * ever made. `pr_walkthrough_get` returns `id` on every feature and chapter and
 * `witnesses` on every chapter, and the write schema is `additionalProperties: false` —
 * so the only natural editing loop there is (get, edit, put) was rejected client-side,
 * and every caller had to know to strip two derived fields first. Stripping them also
 * halved a 62 KB payload, which is how much of that response the writer never needed.
 *
 * Reads the SOURCE rather than importing `mcp.ts`, the technique `api-map.test.ts` uses
 * and for a sharper reason here: importing that module installs a stdin reader and calls
 * `markAgentSession()`, a process-global latch with no way back — and the whole suite
 * runs in one process. The first draft of this test simply hung.
 *
 * Asserted against the schema and not against the op, because the op never refused them:
 * nothing server-side enforces `additionalProperties`, so a test that called
 * `prWalkthroughSet` passed under the defect and proved nothing.
 */
test("what `pr_walkthrough_get` returns is a shape `pr_walkthrough` declares", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("src/mcp.ts", "utf8");
  const start = src.indexOf('name: "pr_walkthrough",');
  assert.ok(start > 0, "could not find the pr_walkthrough tool");
  const schema = src.slice(start, src.indexOf('name: "pr_walkthrough_chapter"', start));

  const built = buildWalkthrough(
    { pr: 1, head: "h", by: "me", at: "2026-01-01T00:00:00Z", features: [feature("F", [{ title: "c", blocks: [sym("a_1")] }])] },
    () => "sha256:x",
  );
  // Every key the read puts on a feature or a chapter has to be declared, or the loop
  // breaks again the next time one is added.
  for (const k of [...Object.keys(built.features[0]!), ...Object.keys(built.features[0]!.chapters[0]!)]) {
    assert.match(schema, new RegExp(`\\b${k}: \\{`), `\`${k}\` is returned by the read but not declared by the write`);
  }
  // `obj(props, required, false)` — the third argument is the strictness, and it stays
  // on. Declaring the derived fields is not a licence to send anything.
  assert.match(schema, /\], false\)/, "still strict — this is not a licence to send anything");
});
