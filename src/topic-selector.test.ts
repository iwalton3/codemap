import { test } from "node:test";
import assert from "node:assert/strict";
import type { Anchor } from "./schema.js";
import { legacyIndex } from "./anchor-resolve.js";
import { fixtureHash } from "./fixture-hash.js";
import { resolveSelector, containmentFor, selectorChanged, newlyMatched } from "./topic-selector.js";
import { walkCoverage, movedSince, buildWalkthrough } from "./walkthrough.js";

const anchor = (id: string, file: string, path: string[], start: number, end: number, body = id): Anchor => ({
  id, file, symbolPath: path, kind: "method", bodyHash: fixtureHash(body), lastVerifiedCommit: null,
  loc: { startByte: start, endByte: end, startLine: 1, endLine: 1 },
});

// Two classes named `Fees` in one file (a partial, say): only the cited one's span counts.
const HEAD = [
  anchor("a_fees", "src/fees.cs", ["Fees"], 0, 100),
  anchor("a_calc", "src/fees.cs", ["Fees", "Calc"], 10, 50),
  anchor("a_fees2", "src/fees.cs", ["Fees"], 200, 300),
  anchor("a_round", "src/fees.cs", ["Fees", "Round"], 210, 250),
  anchor("a_other", "src/other.cs", ["Other"], 0, 10),
  anchor("a_test", "test/fees.test.cs", ["FeesTest"], 0, 10),
];
const queueOnly = (f: string) => (f.startsWith("test/") ? "test" : null);

test("a path glob and an overlapping symbol resolve to one set, tests counted apart", () => {
  const r = resolveSelector({ paths: ["src/fees.cs", "test/**"], symbols: ["a_fees"] }, { head: HEAD, outsideLane: queueOnly });
  assert.deepEqual(r.ids, ["a_calc", "a_fees", "a_fees2", "a_round"]);
  assert.deepEqual(r.outside, [{ id: "a_test", lane: "test" }]);
  assert.deepEqual(r.unresolved, []);
});

test("a cited class brings its members; a same-named class elsewhere in the file does not", () => {
  const r = resolveSelector({ symbols: ["a_fees"] }, { head: HEAD, outsideLane: queueOnly });
  assert.deepEqual(r.ids, ["a_calc", "a_fees"]);
});

test("a range includes the members it deletes, read from the base", () => {
  const base = [...HEAD, anchor("a_gone", "src/fees.cs", ["Fees", "Gone"], 60, 90)];
  const head = HEAD.map((a) => (a.id === "a_calc" ? { ...a, bodyHash: fixtureHash("edited") } : a));
  const r = resolveSelector({ symbols: ["a_fees"], base: "b" }, { head, base, outsideLane: queueOnly });
  assert.deepEqual(r.ids, ["a_calc", "a_gone"], "the unchanged container falls out of the range; the edit and the deletion stay");
});

test("a symbol that no longer resolves is reported, never dropped", () => {
  const r = resolveSelector({ symbols: ["a_renamed_away"], nodes: ["n_doc", "n_gone"] },
    { head: HEAD, nodeAnchors: new Map([["n_doc", ["a_other", "a_vanished"]]]), outsideLane: queueOnly });
  assert.deepEqual(r.ids, ["a_other"]);
  assert.deepEqual(r.unresolved, [
    { kind: "symbol", id: "a_renamed_away" },
    { kind: "symbol", id: "a_vanished", via: "n_doc" },
    { kind: "node", id: "n_gone" },
  ]);
});

test("a cited container covers its members for a topic; without containment (a PR) it does not", () => {
  const queue = new Set(["a_fees", "a_calc"]);
  const features = [{ chapters: [{ title: "c", blocks: [{ kind: "symbol" as const, anchorId: "a_fees" }] }] }];
  const contained = containmentFor(["a_fees"], [HEAD], queue);
  assert.deepEqual(walkCoverage(features, queue, [], contained).uncovered, []);
  assert.deepEqual(walkCoverage(features, queue, []).uncovered, ["a_calc"], "PR behaviour unchanged");
});

test("selectorChanged and newlyMatched are empty on identical input and name a one-field change", () => {
  const sel = { paths: ["src/**"], symbols: ["a_1"] };
  assert.deepEqual(selectorChanged(sel, { ...sel }), {});
  assert.deepEqual(selectorChanged(sel, { ...sel, symbols: ["a_2"] }), { symbols: { added: ["a_2"], removed: ["a_1"] } });
  assert.deepEqual(selectorChanged(sel, { ...sel, base: "abc" }), { base: { from: null, to: "abc" } });
  assert.deepEqual(newlyMatched(["a_1"], ["a_1"]), []);
  assert.deepEqual(newlyMatched(["a_1"], ["a_1", "a_2"]), ["a_2"]);
});

test("movedSince names the chapter and the symbol trunk changed, and nothing on identical code", () => {
  const w = buildWalkthrough({ pr: 0, head: "h", by: "x", at: "t", features: [
    { title: "F", summary: "s", chapters: [{ title: "one", blocks: [{ kind: "symbol", anchorId: "a_1" }] },
      { title: "two", blocks: [{ kind: "symbol", anchorId: "a_2" }] }] },
  ] }, (id) => fixtureHash(id));
  assert.deepEqual(movedSince(w, legacyIndex(new Map([["a_1", fixtureHash("a_1")], ["a_2", fixtureHash("a_2")]]))), { chapters: [], symbols: [] });
  assert.deepEqual(movedSince(w, legacyIndex(new Map([["a_1", fixtureHash("a_1")], ["a_2", fixtureHash("new")]]))), { chapters: ["two"], symbols: ["a_2"] });
});
