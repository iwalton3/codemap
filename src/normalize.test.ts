import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, hashTokens, hashSchemeOf, comparableHashes, ABSENT_HASH } from "./normalize.js";
import { anchorId, HASH_SCHEME } from "./schema.js";
import { fixtureHash } from "./fixture-hash.js";

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
  assert.equal(hashSchemeOf(fixtureHash("abc123")), 1);
});

test("a prefixed digest reports its own scheme", () => {
  assert.equal(hashSchemeOf(fixtureHash("abc123", 2)), 2);
  assert.equal(hashSchemeOf(fixtureHash("abc123", 17)), 17);
});

test("hashes from one scheme are comparable; across schemes they are not", () => {
  assert.equal(comparableHashes(fixtureHash("aaa"), fixtureHash("bbb")), true, "both scheme 1");
  assert.equal(comparableHashes(fixtureHash("aaa", 2), fixtureHash("bbb", 2)), true, "both scheme 2");
  assert.equal(comparableHashes(fixtureHash("aaa"), fixtureHash("aaa", 2)), false, "1 vs 2 says nothing about the code");
});

test("an absent anchor compares against any scheme — gone is gone under every derivation", () => {
  assert.equal(comparableHashes(ABSENT_HASH, fixtureHash("aaa", 2)), true);
  assert.equal(comparableHashes(fixtureHash("aaa", 9), ABSENT_HASH), true);
});

test("hashTokens stamps the scheme in force, so a hash carries its own provenance", () => {
  assert.equal(hashSchemeOf(hashTokens(["a"])), HASH_SCHEME);
});

/**
 * A value that is not a hash must not read as scheme 1.
 *
 * Scheme 1 is encoded as the ABSENCE of a prefix, so "unrecognized" and "the
 * original derivation" looked identical. That failed open: an unparseable value
 * compared equal-scheme against every legacy hash, mismatched, and produced a
 * confident `stale` — drift asserted about code nothing had actually compared.
 */
test("an unparseable value is not a hash, and is comparable to nothing", () => {
  // Written as literals on purpose: `fixtureHash` produces WELL-FORMED hashes, so
  // routing these through it would quietly turn the malformed cases valid and the
  // test would assert nothing.
  const good = fixtureHash("aaa"), good2 = fixtureHash("aaa", 2);
  const digest = good.slice("sha256:".length);
  for (const junk of [
    "garbage", "", "sha256", "sha256:", "h2:", "h2:md5:" + digest,
    "h0:sha256:" + digest,             // scheme numbers have one spelling
    "h01:sha256:" + digest,
    "sha256:" + digest.slice(0, 63),   // truncated
    "sha256:" + digest.toUpperCase(),  // canonical form is lowercase
    "sha256:" + digest + "0",          // over-long
    "sha256:" + "z".repeat(64),        // right length, not hex
  ]) {
    assert.equal(hashSchemeOf(junk), null, `${JSON.stringify(junk)} should not parse`);
    assert.equal(comparableHashes(junk, good), false, `${JSON.stringify(junk)} vs a scheme-1 hash`);
    assert.equal(comparableHashes(good2, junk), false, `a scheme-2 hash vs ${JSON.stringify(junk)}`);
  }
  // Two things nobody can read are not thereby known to be equal.
  assert.equal(comparableHashes("garbage", "garbage"), false);
});

test("the absent sentinel stays comparable to everything, including junk", () => {
  // "there is no code here" is true under every derivation, so it must read as
  // CHANGED rather than unverifiable whatever it is compared against.
  assert.equal(comparableHashes(ABSENT_HASH, "garbage"), true);
  assert.equal(comparableHashes(ABSENT_HASH, ABSENT_HASH), true);
});
