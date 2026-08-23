/**
 * Resolving an anchor id against an index whose build may not be the one that
 * minted the id.
 *
 * This replaces one idiom, which occurs in five places:
 *
 *     live.get(anchorId) ?? ABSENT_HASH
 *
 * It answers "the code is gone" and "I could not resolve that id" with the same
 * value, and `ABSENT_HASH` is comparable to everything *on purpose*, so nothing
 * downstream can tell them apart. The rule that separates them is already written
 * in `PROPOSAL-provenance.md` §5 — "`ABSENT_HASH` is universally comparable only
 * AFTER anchor compatibility is established; before that, 'there is no code here'
 * is not a statement anyone is entitled to make" — and it needs a three-valued
 * answer to be expressible at all.
 *
 * Kept free of the store so the policy is unit-testable in isolation, the same
 * reason `normalize.ts` holds no tree-sitter. See docs/anchor-id-provenance.md §6.
 *
 * The consumers are `evalVersion`, `witnessDrift`, `staleChapters`, the bug rollups
 * and `nodeVersions`. `anchor-resolve.test.ts` still builds its indexes by hand,
 * because the interesting inputs — an index built by another grammar — cannot be
 * produced by this build at all.
 */

import { comparableAnchorDerivation, type DerivationTag } from "./schema.js";
import { derivationMark, derivationFingerprint } from "./normalize.js";

/** What a ref's rows say about the build(s) that minted them. */
export interface IndexDerivations {
  /** Every distinct derivation the rows carry. A SET: `applyIndexUpdate` adds rows
   *  incrementally, so one ref legitimately holds rows minted by two builds. */
  tags: DerivationTag[];
  /** Some row carries no derivation at all. A pre-provenance index could have
   *  minted anything, so it cannot rule any id out. */
  anyUntagged: boolean;
}

/**
 * KNOWN LIMIT, recorded rather than fixed: "this index has no tag matching your
 * mark" is ambiguous between *a different build produced it* and *that language is
 * not in this index at all*. Without a locator on the record — see
 * docs/anchor-id-provenance.md §4 for why there isn't one — nothing here can tell
 * which grammar an id belonged to, so the two cases look identical.
 *
 * It leans the safe way in the common case: when a grammar changes, the code is
 * still there, so the index still carries a tag for that language under the new
 * digest and the mismatch is real. The false reading needs every file of a language
 * to be gone at once, which is itself the deletion case — where the cost is a
 * record reading "cannot tell" instead of "removed", not a wrong claim about code.
 */
/**
 * Three values rather than a boolean beside a hash, so that a caller which forgets
 * the third does not compile: reading `.hash` off the union without narrowing is a
 * type error, which is a stronger guarantee than remembering to write the branch.
 */
export type Resolved =
  /** The id is here. */
  | { at: "found"; hash: string }
  /** Not here, and it would have resolved if it existed — so the absence is real. */
  | { at: "absent" }
  /**
   * Not here, and this index cannot say whether it could ever have been.
   *
   * Distinct from `absent` for exactly ONE reader: a tombstone, whose claim is
   * "these are gone" and which therefore reads absence as EVIDENCE. An index with
   * no usable derivation tags produces absence for free, and letting a tombstone
   * win on it hides a doc whose code may be sitting right there — the direction
   * with no recovery. Every other caller treats this the same as `absent`, which
   * is what they did before it existed.
   */
  | { at: "undetermined"; detail: string }
  /** Not here, and it could not have been minted by this index either way. */
  | { at: "incomparable"; detail: string };

/**
 * A live-hash map that also knows which build(s) produced it.
 *
 * An intersection rather than a wrapper, deliberately: every consumer in this
 * codebase already holds a `Map<string, string>` and calls `.get`, and forcing ~20
 * of them through a new accessor to reach two extra fields would be churn with its
 * own transcription risk. What the type DOES buy is that a bare `Map` no longer
 * satisfies a signature that needs provenance, so building one is a decision.
 */
export type AnchorIndex = Map<string, string> & {
  derivations: IndexDerivations;
  /**
   * Every tag this machine has recorded under that fingerprint — `derivationsFor`,
   * over the local `derivations` table. Rides on the index because that is where
   * store access exists; without it the comparison falls back to matching
   * fingerprints, which errs in both directions (see `matches`).
   *
   * A LIST, because the fingerprint excludes `anchorScheme`: one fingerprint can
   * name two retained tags, and picking one of them would make the answer depend on
   * row order.
   */
  knownTags?: (mark: string) => DerivationTag[];
};

/**
 * Attach what a ref's rows say about their build to the hashes read out of it.
 *
 * CONSUMES `hashes` — the properties are assigned onto the map you pass, not a copy.
 * Every caller builds a fresh map for the purpose; hand it a cached or shared one
 * and you smuggle provenance onto something else's object, and a second call over
 * one map silently overwrites the first's derivations.
 */
export function anchorIndex(
  hashes: Map<string, string>,
  derivations: IndexDerivations,
  knownTags?: (mark: string) => DerivationTag[],
): AnchorIndex {
  return Object.assign(hashes, { derivations, ...(knownTags ? { knownTags } : {}) }) as AnchorIndex;
}

/**
 * An index that cannot answer the provenance question, so every absence reads as
 * real — today's behaviour, exactly.
 *
 * For hashes read from somewhere with no derivation on record, and for tests whose
 * subject is not provenance. NOT a default: a site that needs the real answer and
 * gets this one is silently back where it started, which is why `anchorIndex` takes
 * the derivations rather than defaulting them.
 */
export const legacyIndex = (hashes: Map<string, string>): AnchorIndex =>
  anchorIndex(hashes, { tags: [], anyUntagged: true });

/** What a set of already-loaded anchors says about the build(s) that minted them. */
export function derivationsOf(anchors: Iterable<{ derivation?: DerivationTag }>): IndexDerivations {
  const tags: DerivationTag[] = [];
  // Identity first, and it is not a micro-optimization: tags are INTERNED, so every
  // row of one derivation carries the same object. Hashing per row instead made this
  // a SHA-256 per anchor on `workHashes` — which `loadNodes`, `confirmNode` and
  // `ackHole` all call — and on a real store that is thousands of digests per call.
  const byRef = new Set<DerivationTag>();
  const byValue = new Set<string>();
  let anyUntagged = false;
  for (const a of anchors) {
    if (!a.derivation) { anyUntagged = true; continue; }
    if (byRef.has(a.derivation)) continue;
    byRef.add(a.derivation);
    // `anchorScheme` is not in the fingerprint but does decide an id, so it needs
    // its own place in the key or two derivations collapse into one tag.
    const k = derivationFingerprint(a.derivation) + "\0" + a.derivation.anchorScheme;
    if (!byValue.has(k)) { byValue.add(k); tags.push(a.derivation); }
  }
  return { tags, anyUntagged };
}

/**
 * Resolve one id, given whatever hashes the record holds beside it.
 *
 * `evidence` is the record's own body hashes — one for a `BugWitness`, up to n for a
 * citation's `acceptedHashes`. Their derivation marks are the evidence, which is why
 * a tombstone that empties its accepted set arrives with none (see `ackHole` and
 * `retireSharedDoc`).
 *
 */
export function resolveAnchor(
  anchorId: string,
  evidence: readonly string[],
  index: AnchorIndex,
): Resolved {
  const hash = index.get(anchorId);
  // Equality first, provenance second — the ordering the hash side already uses
  // ("comparability is consulted only after two digests differ"). An id that
  // resolved needs no argument about which build minted it.
  if (hash !== undefined) return { at: "found", hash };

  const parsed = evidence.map(derivationMark);
  const marks = [...new Set(parsed.filter((m): m is string => m !== null))];
  // No evidence, or an index that cannot give any: fall back to today's answer.
  //
  // Three ways to have none. No marks — a pre-emission record asserts nothing about
  // its derivation. Untagged rows — a pre-provenance index could have minted
  // anything. And NO TAGS AT ALL, which is an index with no rows: it did not mint
  // this id, but it did not mint anything, so it is not evidence about how ids are
  // derived. That last one is not hypothetical — deleting the last anchored symbol
  // in a repo produces it, and calling every record undecidable at that moment would
  // stop `ackHole` from ever acknowledging a hole.
  const d = index.derivations;
  // An UNANNOTATED hash in the set is itself evidence, and dropping it was a bug:
  // it proves the id resolved under some derivation nobody recorded, which could be
  // this index's. So accruing a foreign annotated hash beside a legacy one must not
  // turn `absent` into `incomparable` — more evidence cannot make an answer worse.
  if (!marks.length || parsed.some((m) => m === null)) return { at: "absent" };

  // ANY match is enough, and the asymmetry is deliberate: a hash only enters an
  // accepted set when the id RESOLVED under that derivation (`store.ts`, `capture`),
  // so one matching mark is positive proof that a build like this one joined this id
  // before — which outranks any number of derivations that never saw it.
  //
  // BEFORE the no-tag fallback, not after. One legacy row beside a tagged one sets
  // `anyUntagged`, and checking that first threw away a positive match — which is
  // precisely the partially-upgraded window this whole mechanism is for.
  for (const m of marks) if (matches(m, d, index.knownTags)) return { at: "absent" };

  // An index with NO ROWS AT ALL stays `absent`, and this is load-bearing rather
  // than a leftover: an index scoped to a doc's citations is empty exactly when all
  // of that code is gone, which is the situation a tombstone DESCRIBES. Calling it
  // undecidable would make every legitimate retirement inert and stop `ackHole`
  // acknowledging a hole — the case the paragraph above is about.
  if (!d.tags.length) return { at: "absent" };

  // Untagged rows beside tagged ones is the partially-upgraded window, and there the
  // index genuinely cannot say. `absent` for everyone who asks "is the code here" —
  // still the best answer, and the one they got before — but not proof of removal,
  // which is the one reading that can hide a doc. See `Resolved.undetermined`.
  if (d.anyUntagged) {
    return {
      at: "undetermined",
      detail: "this index holds rows from before provenance, so it cannot say which builds minted its ids",
    };
  }

  return {
    at: "incomparable",
    detail: `minted under a derivation this index has not used (${marks.join(", ")})`,
  };
}

/**
 * Does this mark name a derivation the index was built by?
 *
 * Two paths, and the difference is not cosmetic. `derivationFingerprint` digests
 * `{hashScheme, parserIntegrity, grammarDigest}` while an id is decided by
 * `{anchorScheme, parserIntegrity, grammarDigest}` — so the raw-mark path errs in
 * BOTH directions, and only one of them is safe:
 *
 *  - it over-rejects on `hashScheme`, which decides no id. Conservative, and the
 *    same trade `parserIntegrity` already makes;
 *  - it under-rejects on `anchorScheme`, which decides every id. Two derivations
 *    differing only there share a fingerprint and read as comparable here.
 *
 * That second one is why `checkManifest`'s fatal refusal must be KEPT rather than
 * deleted when this lands: `anchorScheme` is gated out of band, by that refusal, by
 * `readSnapshot`, and by `migrateOverloads`. Nothing in this file covers it.
 *
 * `knownTags` closes the FIRST gap whenever the fingerprint is one this machine has
 * seen, which is why it is worth threading through. It does not close the second:
 * two tags differing only on `anchorScheme` share a fingerprint, so a lookup can
 * return both and the permissive reading calls them comparable. `anchorScheme` stays
 * gated out of band, and that is not a shortcut — it is where it belongs.
 */
function matches(
  mark: string,
  derivations: IndexDerivations,
  knownTags?: (mark: string) => DerivationTag[],
): boolean {
  const theirs = knownTags?.(mark) ?? [];
  // Any candidate comparable to any of the index's tags is enough. Permissive on
  // purpose: a fingerprint can name two retained tags that differ on `anchorScheme`,
  // and a stricter reading would have the answer turn on which row came back first.
  if (theirs.length) {
    return theirs.some((t) => derivations.tags.some((x) => comparableAnchorDerivation(t, x)));
  }
  return derivations.tags.some((t) => derivationFingerprint(t) === mark);
}
