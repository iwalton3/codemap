import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, hashTokens, hashSchemeOf, comparableHashes, ABSENT_HASH } from "./normalize.js";
import { anchorId, HASH_SCHEME } from "./schema.js";

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

// --- HASH_SCHEME: telling "the code changed" from "the rules for hashing it changed"

test("an unprefixed digest is scheme 1 — what every hash written before this looks like", () => {
  assert.equal(hashSchemeOf("sha256:abc123"), 1);
});

test("a prefixed digest reports its own scheme", () => {
  assert.equal(hashSchemeOf("h2:sha256:abc123"), 2);
  assert.equal(hashSchemeOf("h17:sha256:abc123"), 17);
});

test("hashes from one scheme are comparable; across schemes they are not", () => {
  assert.equal(comparableHashes("sha256:aaa", "sha256:bbb"), true, "both scheme 1");
  assert.equal(comparableHashes("h2:sha256:aaa", "h2:sha256:bbb"), true, "both scheme 2");
  assert.equal(comparableHashes("sha256:aaa", "h2:sha256:aaa"), false, "1 vs 2 says nothing about the code");
});

test("an absent anchor compares against any scheme — gone is gone under every derivation", () => {
  assert.equal(comparableHashes(ABSENT_HASH, "h2:sha256:aaa"), true);
  assert.equal(comparableHashes("h9:sha256:aaa", ABSENT_HASH), true);
});

test("hashTokens stamps the scheme in force, so a hash carries its own provenance", () => {
  assert.equal(hashSchemeOf(hashTokens(["a"])), HASH_SCHEME);
});
