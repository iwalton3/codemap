import { test } from "node:test";
import assert from "node:assert/strict";
import { comparableAnchorDerivation, type DerivationTag } from "./schema.js";
import { hashTokens, derivationFingerprint } from "./normalize.js";
import { resolveAnchor, anchorIndex, derivationsOf, type AnchorIndex } from "./anchor-resolve.js";

const MINE: DerivationTag = {
  anchorScheme: 3, hashScheme: 2,
  parserIntegrity: "p".repeat(64), grammarDigest: "g".repeat(64),
};
const tag = (over: Partial<DerivationTag>): DerivationTag => ({ ...MINE, ...over });

/** A body hash minted under `t` — the evidence a record carries beside an id. */
const evidence = (t: DerivationTag | null, body = "same") => hashTokens([body], t);

const index = (
  tags: DerivationTag[],
  opts: { have?: Record<string, string>; untagged?: boolean; knownTags?: (m: string) => DerivationTag[] } = {},
): AnchorIndex =>
  anchorIndex(new Map(Object.entries(opts.have ?? {})), { tags, anyUntagged: !!opts.untagged }, opts.knownTags);

// --- the projection ---------------------------------------------------------

/**
 * The other three-field projection. It excludes `hashScheme`, where the hash side
 * excludes `anchorScheme` — and a single `comparableDerivation` would have to pick
 * one of those and be wrong for the other caller.
 */
test("id comparability excludes hashScheme and includes anchorScheme", () => {
  assert.equal(comparableAnchorDerivation(MINE, tag({ hashScheme: 99 })), true,
    "an id contains no body hash, so how bodies are hashed cannot move one");
  assert.equal(comparableAnchorDerivation(MINE, tag({ anchorScheme: 4 })), false,
    "which is the one field the hash projection drops");
  assert.equal(comparableAnchorDerivation(MINE, tag({ grammarDigest: "f".repeat(64) })), false,
    "the grammar reads symbolPath and the disambiguator off the parse");
  assert.equal(comparableAnchorDerivation(MINE, tag({ parserIntegrity: "q".repeat(64) })), false);
  assert.equal(comparableAnchorDerivation(undefined, MINE), true, "untagged still falls back to comparing");
});

// --- resolution -------------------------------------------------------------

test("an id that resolves needs no argument about which build minted it", () => {
  const h = evidence(MINE);
  const r = resolveAnchor("a_1", [evidence(tag({ grammarDigest: "f".repeat(64) }))],
    index([MINE], { have: { a_1: h } }));
  assert.deepEqual(r, { at: "found", hash: h },
    "equality first — a foreign-looking witness against a present id is still present");
});

test("absence is real when this index could have minted the id", () => {
  assert.deepEqual(resolveAnchor("a_gone", [evidence(MINE)], index([MINE])), { at: "absent" },
    "a build with this derivation joined it before, so its absence now is deletion");
});

test("absence is NOT decidable when the id came from another derivation", () => {
  const foreign = evidence(tag({ grammarDigest: "f".repeat(64) }));
  const r = resolveAnchor("a_theirs", [foreign], index([MINE]));
  assert.equal(r.at, "incomparable", "this index has never minted ids that way");
});

/**
 * The asymmetry, and it is the whole reason the accepted set is worth reading.
 *
 * A hash only enters an accepted set when the id RESOLVED under that derivation, so
 * one matching mark is positive proof that a build like this one joined this id.
 * Any number of derivations that never saw it prove nothing against that.
 */
test("one matching mark outranks any number of foreign ones", () => {
  const marks = [
    evidence(tag({ grammarDigest: "f".repeat(64) })),
    evidence(tag({ parserIntegrity: "q".repeat(64) })),
    evidence(MINE),
  ];
  assert.deepEqual(resolveAnchor("a_gone", marks, index([MINE])), { at: "absent" });
});

test("a pre-provenance record or index falls back to today's answer", () => {
  assert.deepEqual(resolveAnchor("a_gone", [evidence(null)], index([MINE])), { at: "absent" },
    "an unannotated hash asserts nothing about its derivation");
  assert.deepEqual(resolveAnchor("a_gone", [], index([MINE])), { at: "absent" },
    "and a record with no hashes at all — a tombstone that emptied its set — has no evidence");
  const foreign = resolveAnchor("a_gone", [evidence(tag({ grammarDigest: "f".repeat(64) }))],
    index([MINE], { untagged: true }));
  assert.equal(foreign.at, "undetermined",
    "an index holding untagged rows could have minted anything, so it rules nothing out — "
    + "but that is 'cannot say', not the established absence a tombstone may win on");
});

/**
 * The ordering, which is the half of this that can hide a doc.
 *
 * `anyUntagged` used to be tested BEFORE the positive-match loop, so one legacy row
 * beside a tagged one threw away a match that had actually been found — during
 * exactly the partially-upgraded window the mechanism exists for.
 */
test("a positive match survives a legacy row sitting beside it", () => {
  assert.deepEqual(resolveAnchor("a_gone", [evidence(MINE)], index([MINE], { untagged: true })),
    { at: "absent" }, "this index's own derivation minted that id before — the absence is established");
  // The control: without the match it is still only 'cannot say'.
  assert.equal(resolveAnchor("a_gone", [evidence(tag({ grammarDigest: "e".repeat(64) }))],
    index([MINE], { untagged: true })).at, "undetermined");
});

test("an index with NO rows still establishes absence, and must", () => {
  // The boundary of `undetermined`, and it is deliberate. An index scoped to a doc's
  // citations is empty exactly when all of that code is gone — which is what a
  // tombstone describes. Calling it undecidable makes every legitimate retirement
  // inert. Deleting the last anchored symbol in a repo produces the same shape.
  assert.deepEqual(resolveAnchor("a_gone", [evidence(MINE)], index([])), { at: "absent" });
});

/**
 * A ref legitimately holds rows from two builds — `applyIndexUpdate` adds
 * incrementally — so the operand is a SET, and matching any member is enough.
 */
test("an index built by two builds is compared against both", () => {
  const older = tag({ grammarDigest: "f".repeat(64) });
  assert.deepEqual(resolveAnchor("a_gone", [evidence(older)], index([MINE, older])), { at: "absent" });
});

// --- what the raw mark can and cannot see -----------------------------------

/**
 * The fingerprint is not the id projection, and errs in BOTH directions. Pinned
 * because only one of the two is safe, and the unsafe one is what keeps
 * `checkManifest`'s fatal refusal load-bearing.
 */
test("without the local dictionary the mark over-rejects on hashScheme", () => {
  const otherHashScheme = tag({ hashScheme: 3 });
  assert.equal(resolveAnchor("a_gone", [evidence(otherHashScheme)], index([MINE])).at, "incomparable",
    "conservative: a different fingerprint, though nothing that decides an id moved");

  const knownTags = (m: string) => (m === derivationFingerprint(otherHashScheme) ? [otherHashScheme] : []);
  assert.deepEqual(resolveAnchor("a_gone", [evidence(otherHashScheme)], index([MINE], { knownTags })), { at: "absent" },
    "and the dictionary upgrades it to the honest three-field test");
});

test("and UNDER-rejects on anchorScheme, which is why the manifest gate stays", () => {
  const otherAnchorScheme = tag({ anchorScheme: 4 });
  assert.equal(derivationFingerprint(otherAnchorScheme), derivationFingerprint(MINE),
    "anchorScheme is deliberately not in the fingerprint — it decides ids, not hashes");
  assert.deepEqual(resolveAnchor("a_gone", [evidence(otherAnchorScheme)], index([MINE])), { at: "absent" },
    "so the raw mark cannot see an anchor-scheme change at all");

  const knownTags = (m: string) => (m === derivationFingerprint(otherAnchorScheme) ? [otherAnchorScheme] : []);
  assert.equal(resolveAnchor("a_gone", [evidence(otherAnchorScheme)], index([MINE], { knownTags })).at, "incomparable",
    "the dictionary closes it only while it holds one candidate");

  // And it stops closing it as soon as the store has seen both, because they share a
  // fingerprint: the permissive reading wins, so `anchorScheme` stays gated by
  // `checkManifest` / `readSnapshot` / `migrateOverloads` rather than by this.
  const both = (m: string) => (m === derivationFingerprint(MINE) ? [otherAnchorScheme, MINE] : []);
  assert.deepEqual(resolveAnchor("a_gone", [evidence(otherAnchorScheme)], index([MINE], { knownTags: both })), { at: "absent" });
});

/**
 * The index's derivations come from the rows themselves, and one ref legitimately
 * holds rows from two builds — `applyIndexUpdate` adds incrementally.
 */
test("derivationsOf collects distinct tags and notices untagged rows", () => {
  const older = tag({ grammarDigest: "f".repeat(64) });
  const d = derivationsOf([{ derivation: MINE }, { derivation: older }, { derivation: MINE }]);
  assert.equal(d.tags.length, 2, "distinct, not one per row");
  assert.equal(d.anyUntagged, false);

  const mixed = derivationsOf([{ derivation: MINE }, {}]);
  assert.equal(mixed.anyUntagged, true, "a pre-provenance row cannot rule anything out");

  // anchorScheme is not in the fingerprint, so it needs its own place in the key —
  // otherwise two derivations that differ only there collapse into one tag and the
  // honest comparison never sees the second.
  assert.equal(derivationsOf([{ derivation: MINE }, { derivation: tag({ anchorScheme: 4 }) }]).tags.length, 2);
});

/**
 * More evidence must never make the answer worse.
 *
 * An unannotated hash in an accepted set still proves the id RESOLVED under some
 * derivation nobody recorded — possibly this one. Dropping it before counting marks
 * meant a legacy-only citation read `absent` while the same citation, after
 * accruing one foreign annotated hash, read `incomparable`.
 */
test("a legacy hash beside a foreign one keeps the fallback", () => {
  const foreign = evidence(tag({ grammarDigest: "f".repeat(64) }));
  assert.deepEqual(resolveAnchor("a_gone", [evidence(null)], index([MINE])), { at: "absent" });
  assert.deepEqual(resolveAnchor("a_gone", [evidence(null), foreign], index([MINE])), { at: "absent" },
    "accruing a mark cannot revoke what the unannotated hash already proved");
  assert.equal(resolveAnchor("a_gone", [foreign], index([MINE])).at, "incomparable",
    "control: foreign evidence alone is still undecidable");
});
