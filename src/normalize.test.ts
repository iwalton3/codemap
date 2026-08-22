import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, hashTokens, hashSchemeOf, comparableHashes, sameBody, bodyDigest,
  derivationMark, derivationFingerprint, ABSENT_HASH } from "./normalize.js";
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
    "h1:sha256:" + digest,             // scheme 1 IS the unprefixed form
    "h99999999999999999999:sha256:" + digest,
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

/**
 * `h1:` is the trap the one-spelling rule exists for.
 *
 * It is well-formed, it is scheme 1, and nothing in this codebase mints it —
 * `schemePrefix(1)` returns "". So it can only arrive from a client that got the
 * encoding wrong, and if it parsed, `h1:sha256:X` and `sha256:X` would be the same
 * body reading as comparable-and-different: a confident `stale` for code nobody
 * touched. That is the exact false staleness the scheme numbers were added to
 * prevent, reached through their own encoding.
 */
test("a scheme number has exactly one spelling", () => {
  const d = fixtureHash("body").slice("sha256:".length);
  assert.equal(hashSchemeOf("sha256:" + d), 1, "unprefixed is scheme 1");
  assert.equal(hashSchemeOf("h1:sha256:" + d), null, "and h1: is not a second spelling of it");
  assert.equal(comparableHashes("h1:sha256:" + d, "sha256:" + d), false);
  // Large scheme numbers are legal — the bound is what a number can represent,
  // not how many digits a regex happened to allow.
  assert.equal(hashSchemeOf("h10000:sha256:" + d), 10000);
  assert.equal(hashSchemeOf("h99999999999999999999:sha256:" + d), null, "past safe-integer");
});

test("the absent sentinel stays comparable to everything, including junk", () => {
  // "there is no code here" is true under every derivation, so it must read as
  // CHANGED rather than unverifiable whatever it is compared against.
  assert.equal(comparableHashes(ABSENT_HASH, "garbage"), true);
  assert.equal(comparableHashes(ABSENT_HASH, ABSENT_HASH), true);
});

// --- body identity, which is not string identity ---------------------------------

const D = "a".repeat(64), D2 = "b".repeat(64), FP = "deadbeef12345678";

/**
 * A hash string is a digest plus annotations about how it was derived, so two
 * strings can differ while describing byte-for-byte the same token stream.
 * Comparing the strings then reports drift for a change to the annotation — the
 * failure this codebase keeps re-finding under new names.
 */
test("the same body under different annotations is the same body", () => {
  assert.equal(sameBody(`h2:sha256:${D}`, `h2:${FP}:sha256:${D}`), true);
  assert.equal(sameBody(`h2:${FP}:sha256:${D}`, `h2:0badf00d56781234:sha256:${D}`), true,
    "an identical digest means an identical token stream, whoever produced it");
  assert.equal(sameBody(`h2:sha256:${D}`, `h2:sha256:${D2}`), false, "different bodies");
  assert.equal(sameBody(`sha256:${D}`, `h2:sha256:${D}`), false, "a scheme difference is not comparable");
});

/**
 * The exact-match shortcut is load-bearing, not an optimization: `ABSENT_HASH` is
 * deliberately not a digest, so it parses to nothing and would otherwise fail to
 * equal itself — turning "no code here, still no code here" into drift.
 */
test("the absent sentinel equals itself", () => {
  assert.equal(sameBody(ABSENT_HASH, ABSENT_HASH), true);
  assert.equal(sameBody(ABSENT_HASH, `h2:sha256:${D}`), false);
});

/**
 * Read, never written. Nothing emits an annotated hash yet; a reader that could
 * not parse one would mishandle every hash the day something starts.
 */
test("an annotation is parsed without being minted", () => {
  assert.equal(derivationMark(`h2:${FP}:sha256:${D}`), FP);
  // One spelling per derivation: a short or long annotation is not a shorter or
  // longer spelling of the same thing, it is not an annotation.
  assert.equal(derivationMark(`h2:deadbeef:sha256:${D}`), null, "8 hex is not the format");
  assert.equal(hashSchemeOf(`h2:deadbeef:sha256:${D}`), null, "and the whole hash is refused");
  assert.equal(derivationMark(`h2:sha256:${D}`), null);
  assert.equal(bodyDigest(`h2:${FP}:sha256:${D}`), D, "the digest survives the annotation");
  assert.equal(bodyDigest(`h2:sha256:${D}`), D);
  assert.equal(bodyDigest("garbage"), null);
  // `sha256` is not hex, so the un-annotated form cannot be misread as annotated.
  assert.equal(derivationMark(hashTokens(["a"])), null, "nothing this build mints carries one");
  assert.equal(hashSchemeOf(`h2:${FP}:sha256:${D}`), 2, "the scheme still reads through it");
});

/**
 * A golden vector for OUR half of the derivation.
 *
 * The `DerivationTag` covers two of the three things that decide a body hash — the
 * grammar blob and the tree-sitter runtime — automatically, by digesting the
 * artifacts. It cannot cover the third, which is this file and the indexer walk:
 * digesting our own source would invalidate every hash in every store on every
 * release, and only a person can tell which changes to it actually move a token
 * stream. That third input is guarded by `HASH_SCHEME`, bumped by hand.
 *
 * Which makes it the weak link, because a manual bump can be forgotten — and a
 * forgotten one is silent and total: every hash moves, the tag says nothing
 * changed, so `comparableDerivation` calls them comparable and the entire store
 * reads as drift. Demonstrated by changing one separator in `canonicalize` and
 * watching the hash move while the tag stood still.
 *
 * So this pins the output. Change how tokens are canonicalized and this fails,
 * which turns "did you mean to bump HASH_SCHEME?" into a question somebody is
 * forced to answer rather than one they might not think to ask. If the change was
 * deliberate, bump the scheme and update the vector in the same commit.
 */
test("canonicalization is pinned, so changing it cannot be silent", () => {
  assert.equal(
    hashTokens(["public", "void", "Apply", "(", ")"]),
    "h2:sha256:c4b0a002464aa2e6e5b86bb22d1a6e06e510d70abcb22ed1c33d4645eeb07b12",
  );
  // Length-prefixed, so two tokens cannot be confused with one containing the
  // separator — the property the prefix exists for, stated as a test.
  assert.notEqual(hashTokens(["a", "b"]), hashTokens(["a:b"]));
  assert.notEqual(hashTokens(["a", "b"]), hashTokens(["ab"]));
});

/**
 * A golden vector for the fingerprint preimage, for the same reason canonicalize
 * has one — but with a sharper consequence.
 *
 * Changing how `canonicalize` works moves hashes and is caught by a scheme bump.
 * Changing this function's ENCODING moves fingerprints, which turns every
 * already-emitted annotation foreign — a store-wide derivation change caused by
 * editing a serializer. There is no scheme number guarding it, so this vector is
 * the guard.
 *
 * Fixed inputs rather than the live tag: the live one moves whenever a grammar or
 * the runtime does, which is the thing the fingerprint is *supposed* to track.
 */
test("the derivation fingerprint's preimage is pinned", () => {
  assert.equal(
    derivationFingerprint({ hashScheme: 2, parserIntegrity: "p".repeat(64), grammarDigest: "g".repeat(64) }),
    "bc45f3b175916060",
  );
  assert.equal(derivationFingerprint({ hashScheme: 2, parserIntegrity: "p".repeat(64), grammarDigest: "g".repeat(64) }).length, 16,
    "exactly the width HASH_FORM accepts — a range would allow two spellings of one derivation");

  // Every field participates, and the separators keep them apart: no reshuffling of
  // one field's bytes into another can produce the same preimage.
  const base = { hashScheme: 2, parserIntegrity: "aa", grammarDigest: "bb" };
  const fps = new Set([
    derivationFingerprint(base),
    derivationFingerprint({ ...base, hashScheme: 3 }),
    derivationFingerprint({ ...base, parserIntegrity: "aab" }),
    derivationFingerprint({ ...base, grammarDigest: "bbb" }),
    derivationFingerprint({ hashScheme: 2, parserIntegrity: "a", grammarDigest: "abb" }),
  ]);
  assert.equal(fps.size, 5, "a field boundary was ambiguous");
});
