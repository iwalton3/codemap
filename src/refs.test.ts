import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAnchorRefs } from "./refs.js";
import { type Anchor } from "./schema.js";

// Three overloads of GetExports plus one unrelated member — the shape that made
// `file#Symbol` ambiguous on roughly a dozen symbols in an overload-heavy C# repo.
const anchor = (id: string, symbol: string, startLine: number, endLine: number): Anchor => ({
  id,
  file: "Exporter.cs",
  symbolPath: ["Sample", "Exporter", symbol],
  kind: "method",
  bodyHash: "sha256:x",
  lastVerifiedCommit: null,
  loc: { startByte: 0, endByte: 0, startLine, endLine },
});
const ANCHORS: Anchor[] = [
  anchor("a_one", "GetExports", 5, 5),
  anchor("a_two", "GetExports", 7, 7),
  anchor("a_three", "GetExports", 9, 12),
  anchor("a_other", "Unrelated", 14, 14),
];

test("an ambiguous ref names every candidate with its id AND line range", () => {
  const { ids, errors } = resolveAnchorRefs(ANCHORS, ["Exporter.cs#GetExports"]);
  assert.deepEqual(ids, []);
  assert.equal(errors.length, 1);
  // Everything needed to pick, without a second lookup.
  for (const frag of ["a_one, 5-5", "a_two, 7-7", "a_three, 9-12"]) assert.ok(errors[0]!.includes(frag), `missing ${frag} in: ${errors[0]}`);
  assert.ok(errors[0]!.includes("Exporter.cs#GetExports(*)"), "should offer the all-overloads form");
});

test("`file#Symbol(*)` resolves every overload in one ref", () => {
  const { ids, errors } = resolveAnchorRefs(ANCHORS, ["Exporter.cs#GetExports(*)"]);
  assert.deepEqual(ids, ["a_one", "a_two", "a_three"]);
  assert.deepEqual(errors, []);
});

test("`(*)` with no match is an error, not an empty success", () => {
  const { ids, errors } = resolveAnchorRefs(ANCHORS, ["Exporter.cs#Ghost(*)"]);
  assert.deepEqual(ids, []);
  assert.equal(errors.length, 1);
});

test("resolved ids and errors come back separately, so a write can partially accept", () => {
  const { ids, errors } = resolveAnchorRefs(ANCHORS, ["Exporter.cs#Unrelated", "Exporter.cs#GetExports", "Exporter.cs#Ghost"]);
  assert.deepEqual(ids, ["a_other"]); // the good one survives its neighbours
  assert.equal(errors.length, 2); // ambiguous + missing
});

test("ids are deduped across refs (overlapping refs cite an anchor once)", () => {
  const { ids } = resolveAnchorRefs(ANCHORS, ["Exporter.cs#GetExports(*)", "Exporter.cs:7", "a_one"]);
  assert.deepEqual(ids, ["a_one", "a_two", "a_three"]);
});

test("file:line still picks the most specific enclosing anchor", () => {
  const { ids, errors } = resolveAnchorRefs(ANCHORS, ["Exporter.cs:10"]);
  assert.deepEqual(ids, ["a_three"]);
  assert.deepEqual(errors, []);
});
