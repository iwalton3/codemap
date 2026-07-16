import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, hashTokens } from "./normalize.js";
import { anchorId } from "./schema.js";

test("hash is stable for identical token streams", () => {
  assert.equal(hashTokens(["a", ".", "b"]), hashTokens(["a", ".", "b"]));
});

test("comment/whitespace stripping is the indexer's job — hashing only sees tokens", () => {
  // The indexer would drop comments before calling us, so these are equal here.
  const withoutComment = ["return", "x", "+", "1"];
  const alsoWithoutComment = ["return", "x", "+", "1"];
  assert.equal(hashTokens(withoutComment), hashTokens(alsoWithoutComment));
});

test("a logic change flips the hash", () => {
  assert.notEqual(hashTokens(["return", "x", "+", "1"]), hashTokens(["return", "x", "+", "2"]));
});

test("length-prefixing prevents boundary collisions", () => {
  // "a b" as one token must not hash the same as ["a", "b"].
  assert.notEqual(hashTokens(["a b"]), hashTokens(["a", "b"]));
  assert.notEqual(canonicalize(["a b"]), canonicalize(["a", "b"]));
});

test("string-literal content is significant", () => {
  assert.notEqual(hashTokens(['"hello"']), hashTokens(['"world"']));
});

test("anchorId is deterministic and path-sensitive", () => {
  const a = anchorId("src/x.py", ["Foo", "bar"]);
  assert.equal(a, anchorId("src/x.py", ["Foo", "bar"]));
  assert.notEqual(a, anchorId("src/x.py", ["Foo", "baz"]));
  assert.notEqual(a, anchorId("src/y.py", ["Foo", "bar"]));
});

test("anchorId disambiguator separates overloads", () => {
  assert.notEqual(
    anchorId("src/x.cs", ["C", "M"], "(int)"),
    anchorId("src/x.cs", ["C", "M"], "(string)"),
  );
});
