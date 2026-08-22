import { test } from "node:test";
import assert from "node:assert/strict";
import type { Anchor, BugWitness } from "./schema.js";
import { fixtureHash } from "./fixture-hash.js";
import { witnessDrift } from "./reviews.js";
import { staleChapters } from "./walkthrough.js";
import { recordAcceptance, resolveAcceptance } from "./acceptance.js";
import { remapOverloadIds } from "./migrate-overloads.js";

/**
 * The behaviour every comparison site was moved onto `sameBody` FOR.
 *
 * Nothing emits an annotated hash yet, so every existing test compares identical
 * strings and would pass whether the sites had been converted or not. These
 * construct the annotated form by hand, which is the only way to exercise the case
 * before the format ships — and the only way to know the conversion did anything.
 */
const D = fixtureHash("a-body").slice("sha256:".length);
const LEGACY = `h2:sha256:${D}`;                    // minted before annotations
const TAGGED = `h2:0badf00d5678abcd:sha256:${D}`;   // same body, this build
const OTHER = `h2:sha256:${fixtureHash("another-body").slice("sha256:".length)}`;

test("a witness written before annotations does not read as drift after them", () => {
  const witnesses: BugWitness[] = [{ anchorId: "a1", bodyHash: LEGACY }];
  assert.deepEqual(witnessDrift(witnesses, new Map([["a1", TAGGED]])), [],
    "the body did not change — only how the hash describes itself");
  assert.equal(witnessDrift([{ anchorId: "a1", bodyHash: LEGACY }], new Map([["a1", OTHER]])).length, 1,
    "and a real change is still a change");
});

test("a walkthrough chapter is not stale because the annotation arrived", () => {
  const wt = {
    pr: 1, head: "h", by: "izzie", at: "t",
    features: [{
      id: "f", title: "f", summary: "",
      chapters: [{ id: "c", title: "c", blocks: [], witnesses: [{ anchorId: "a1", bodyHash: LEGACY }] }],
    }],
  } as never;
  assert.deepEqual(staleChapters(wt, new Map([["a1", TAGGED]])), []);
  assert.deepEqual(staleChapters(wt, new Map([["a1", OTHER]])), ["c"], "a real move still stales it");
});

test("an acceptance made before annotations still stands after them", () => {
  const anc = { onRef: () => true, precedes: () => false, known: () => true };
  const entries = [{ bodyHash: LEGACY, commit: "c1", branch: null, at: "t" }];
  assert.notEqual(resolveAcceptance(entries, TAGGED, anc as never).via, "none",
    "the same body, approved — the annotation is not a new body");
});

test("re-approving the same body under an annotation replaces rather than duplicates", () => {
  const out = recordAcceptance(
    [{ bodyHash: LEGACY, commit: "c1", branch: null, at: "t" }],
    { bodyHash: TAGGED, commit: "c1", branch: null, at: "t2" }, 5,
  );
  assert.equal(out.length, 1, "one body at one commit is one entry, however it is spelled");
  assert.equal(out[0]!.bodyHash, TAGGED, "and the better-annotated form is the one kept");
});

/**
 * The sharpest of them. This migration pairs old anchors to new BY BODY across an
 * anchor-scheme change — the old side written by an older build, the new side
 * indexed by this one, which is exactly where two spellings meet. Keyed by raw
 * string it would find no pairs, bail, and silently drop every sign-off it exists
 * to carry across.
 */
test("the overload migration pairs across the annotation boundary", () => {
  const a = (id: string, disambiguator: string, bodyHash: string): Anchor => ({
    id, file: "src/pay.cs", symbolPath: ["Pay", "Apply"], kind: "function",
    disambiguator, bodyHash, lastVerifiedCommit: null,
  });
  const olds = [a("a_old0", "0", LEGACY), a("a_old1", "1", OTHER)];
  const news = [a("a_new_x", "(OrderClosed)", TAGGED), a("a_new_y", "(OrderCreated)", OTHER)];

  const remap = remapOverloadIds(olds, news);
  assert.equal(remap.get("a_old0"), "a_new_x", "the annotated body must still pair with its legacy self");
  assert.equal(remap.get("a_old1"), "a_new_y");
});
