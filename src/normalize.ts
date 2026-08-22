/**
 * Normalization + hashing of a symbol's body — the false-staleness guard.
 *
 * The indexer walks a symbol's syntax subtree, drops comment nodes, and emits
 * the remaining leaf tokens in source order. This module turns that token
 * stream into a stable hash: cosmetic edits (whitespace, comments, reindenting)
 * leave the hash untouched, while any change to the actual tokens (logic, string
 * literals, identifiers) flips it.
 *
 * Kept deliberately free of tree-sitter so it is unit-testable in isolation and
 * so the "what counts as a change" policy lives in exactly one place.
 */

import { createHash } from "node:crypto";
import { HASH_SCHEME } from "./schema.js";

/**
 * Canonical string for a token stream.
 *
 * Each token is length-prefixed (`<byteLen>:<token>`) before joining. This is
 * not for readability — it makes the encoding injective so that token
 * *boundaries* cannot be forged by tokens that happen to contain the separator.
 * Without it, the single token "a b" and the pair ["a","b"] would collide, and
 * multiline string literals could collude with adjacent identifiers.
 */
export function canonicalize(tokens: string[]): string {
  let out = "";
  for (const t of tokens) {
    // Byte length, not code-unit length, so multibyte content can't misalign.
    out += Buffer.byteLength(t, "utf8") + ":" + t + "\n";
  }
  return out;
}

/**
 * The value a hash takes when the anchor resolves to nothing.
 *
 * Deliberately scheme-free: "there is no code here" is true under every
 * derivation, so an absent anchor must read as CHANGED rather than as
 * unverifiable, whatever scheme the witness it is compared against was minted
 * under. See `hashSchemeOf`.
 */
export const ABSENT_HASH = "sha256:absent";

/** Prefix carried by hashes from scheme 2 onward; scheme 1 is the bare digest. */
const schemePrefix = (scheme: number): string => (scheme === 1 ? "" : `h${scheme}:`);

/** "sha256:..." digest of the canonicalized token stream, stamped with its scheme. */
export function hashTokens(tokens: string[]): string {
  return schemePrefix(HASH_SCHEME) + "sha256:" + createHash("sha256").update(canonicalize(tokens)).digest("hex");
}

/**
 * The shape a body hash has: an optional scheme prefix, then the algorithm, then
 * the digest. `h0:`/`h01:` are refused so a scheme number has one spelling.
 *
 * The digest itself is not length- or charset-checked, which is a deliberate stop
 * short of "strictly parse everything": the suite carries ~100 readable fixtures
 * across 22 files (`sha256:OLD`, `sha256:NEW`) whose legibility is worth more than
 * catching a corrupt digest that would be reported as drift either way. That check
 * belongs with the derivation receipts, which is also when the fixtures can carry
 * real digests without becoming unreadable.
 */
const HASH_FORM = /^(?:h([1-9]\d*):)?sha256:(.+)$/;

/**
 * Which derivation minted a hash, or NULL when the string is not one this code
 * could have produced.
 *
 * An unprefixed digest is scheme 1 — that is what every hash written before
 * HASH_SCHEME existed looks like, and there is no way to retrofit them, so "no
 * prefix" has to mean "the original".
 *
 * Which is exactly why this must be able to answer "not a hash". Scheme 1 is
 * encoded as the ABSENCE of a prefix, so treating anything unrecognized as scheme 1
 * fails OPEN: a malformed value used to compare equal-scheme against every legacy
 * hash, mismatch, and report confident `stale` — drift asserted about code nobody
 * had actually compared.
 */
export function hashSchemeOf(hash: string): number | null {
  const m = HASH_FORM.exec(hash);
  return m ? Number(m[1] ?? "1") : null;
}

/**
 * Whether two hashes are comparable at all — i.e. whether their inequality would
 * mean the code differs, rather than that the rules for hashing it did.
 *
 * ABSENT_HASH is comparable to everything on purpose: it encodes the absence of
 * code, not a derivation of it.
 */
export function comparableHashes(a: string, b: string): boolean {
  if (a === ABSENT_HASH || b === ABSENT_HASH) return true;
  const scheme = hashSchemeOf(a);
  // Unparseable is not comparable to anything, including another unparseable value:
  // two things nobody can read are not thereby known to be equal.
  return scheme !== null && scheme === hashSchemeOf(b);
}

/** Hash of an arbitrary string (used for ids / disambiguators). */
export function hashString(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
