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
 * NOTHING CALLS THIS YET — the five sites are steps 3-4 of that document's build
 * order. Landing the reader first is the safe half of a two-part change (unused code
 * decides nothing, where an unhonoured annotation would have decided wrongly), and
 * it is the same two-phase shape `derivationMark` used: understand the form, then
 * produce it. `anchor-resolve.test.ts` therefore builds its indexes by hand, because
 * no production path constructs one.
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

export type Resolved =
  /** The id is here. */
  | { at: "found"; hash: string }
  /** Not here, and it would have resolved if it existed — so the absence is real. */
  | { at: "absent" }
  /** Not here, and it could not have been minted by this index either way. */
  | { at: "incomparable"; detail: string };

export interface AnchorIndex {
  hash(anchorId: string): string | undefined;
  derivations: IndexDerivations;
}

/**
 * Resolve one id, given whatever hashes the record holds beside it.
 *
 * `evidence` is the record's own body hashes — one for a `BugWitness`, up to n for a
 * citation's `acceptedHashes`. Their derivation marks are the evidence, which is why
 * a tombstone that empties its accepted set arrives with none (see `ackHole` and
 * `retireSharedDoc`).
 *
 * `knownTag` resolves a fingerprint back to the tag it was made from — `derivationFor`,
 * over the local `derivations` table. Optional because this module does not touch the
 * store; when it can answer, the comparison is the honest one.
 */
export function resolveAnchor(
  anchorId: string,
  evidence: readonly string[],
  index: AnchorIndex,
  knownTag?: (mark: string) => DerivationTag | null,
): Resolved {
  const hash = index.hash(anchorId);
  // Equality first, provenance second — the ordering the hash side already uses
  // ("comparability is consulted only after two digests differ"). An id that
  // resolved needs no argument about which build minted it.
  if (hash !== undefined) return { at: "found", hash };

  const marks = [...new Set(evidence.map(derivationMark).filter((m): m is string => m !== null))];
  // No evidence, or an index that predates provenance: fall back to today's answer.
  // Every stored value predates tags, and answering "cannot decide" for all of them
  // would trade a rare false positive for a universal false negative.
  if (!marks.length || index.derivations.anyUntagged) return { at: "absent" };

  // ANY match is enough, and the asymmetry is deliberate: a hash only enters an
  // accepted set when the id RESOLVED under that derivation (`store.ts`, `capture`),
  // so one matching mark is positive proof that a build like this one joined this id
  // before — which outranks any number of derivations that never saw it.
  for (const m of marks) if (matches(m, index.derivations, knownTag)) return { at: "absent" };

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
 * `knownTag` closes both gaps whenever the fingerprint is one this machine has seen,
 * which is why it is worth threading through.
 */
function matches(
  mark: string,
  derivations: IndexDerivations,
  knownTag?: (mark: string) => DerivationTag | null,
): boolean {
  const theirs = knownTag?.(mark) ?? null;
  if (theirs) return derivations.tags.some((t) => comparableAnchorDerivation(theirs, t));
  return derivations.tags.some((t) => derivationFingerprint(t) === mark);
}
