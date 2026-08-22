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
 * The one shape a body hash may have: an optional scheme prefix, the algorithm,
 * and exactly 64 lowercase hex characters.
 *
 * The digest is length- and charset-checked because "passes as a hash" is what
 * licenses comparing it and reporting the difference as DRIFT — a truncated or
 * corrupted value must not buy that licence. Tests use `fixtureHash`, which
 * derives a real digest from a readable label, so nothing needs a laxer parser
 * to stay legible.
 *
 * The prefix is deliberately not bounded here; `hashSchemeOf` decides what is a
 * legal scheme number, so the rule lives in one place rather than half in a regex.
 */
const HASH_FORM = /^(?:h(\d+):)?(?:([0-9a-f]{16}):)?sha256:([0-9a-f]{64})$/;

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
  if (!m) return null;
  if (m[1] === undefined) return 1;              // scheme 1 IS the unprefixed form
  // Exactly one spelling per scheme, because two spellings of one scheme compare
  // as same-scheme-different-value — a confident `stale` for a body that never
  // changed. `h1:` is the trap: it is well-formed, it is scheme 1, and nothing
  // here mints it, so it can only arrive from a client that got this wrong.
  if (!/^[1-9]\d*$/.test(m[1])) return null;    // no leading zeros
  const scheme = Number(m[1]);
  return Number.isSafeInteger(scheme) && scheme >= 2 ? scheme : null;
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

/**
 * The digest a hash carries, with any annotation stripped — or null if it is not a
 * hash this code could have minted.
 *
 * `HASH_FORM`'s second group. Kept separate from `sameBody` because a Map or Set
 * keyed by a hash string wants THIS, not an equality predicate: two spellings of
 * one body must land on one key or a count of distinct bodies is wrong.
 */
export function bodyDigest(hash: string): string | null {
  return HASH_FORM.exec(hash)?.[3] ?? null;
}

/**
 * The derivation annotation a hash carries, if any.
 *
 * READ but never written, on purpose. Nothing emits an annotated hash yet — see
 * `docs/decision-receipts-vs-prefix.md`, where whether to is still open — but a
 * reader that cannot parse one would mishandle every hash the day something
 * starts. Understanding a form before producing it is the same two-phase shape the
 * sidecar protocol cutover settled on, and here it costs one capture group.
 *
 * Unambiguous against the un-annotated form because the group is hex and `sha256`
 * is not: `h2:sha256:…` cannot read `sha256` as an annotation.
 *
 * Exactly 16 hex, not a range. A range invites two builds to spell one derivation
 * two ways, and two spellings of one thing compare as same-thing-different-value —
 * the `h1:` trap `hashSchemeOf` warns about, one capture group over. There is also
 * only ONE annotation slot in this format, and spending it on derivation identity
 * is a decision rather than an accident: a second annotation later would parse as
 * nothing on today's readers and read as incomparable, which is loud but total.
 */
export function derivationMark(hash: string): string | null {
  return HASH_FORM.exec(hash)?.[2] ?? null;
}

/**
 * Do two hashes describe the same body?
 *
 * Not `===`, and the difference is the whole reason this exists. A hash string is
 * a digest plus annotations about how it was derived, and annotations may be added
 * without the digest moving — so two strings can differ while describing byte-for-
 * byte the same token stream. Comparing the strings would then report drift for a
 * change to the annotation, which is the failure this codebase keeps re-finding
 * under different names.
 *
 * The exact-match shortcut is load-bearing rather than an optimization: it is what
 * makes `ABSENT_HASH === ABSENT_HASH` answer true, since the sentinel is
 * deliberately not a digest and would otherwise parse to null.
 *
 * INSERTING into a set is a different question and must not use this — see
 * `docs/decision-receipts-vs-prefix.md`. A grow-only set that dedupes by body can
 * never acquire a better-annotated form of a hash it already holds.
 */
export function sameBody(a: string, b: string): boolean {
  // Identical strings are the same body — but only if they ARE a body. An
  // unrestricted shortcut made two identical malformed values compare clean while
  // `comparableHashes` refuses them, which is the fail-open this codebase has
  // already closed once. `ABSENT_HASH` is the one deliberate non-digest sentinel.
  if (a === b) return a === ABSENT_HASH || bodyDigest(a) !== null;
  const da = bodyDigest(a);
  return da !== null && da === bodyDigest(b) && hashSchemeOf(a) === hashSchemeOf(b);
}

/**
 * A Map/Set key that treats two spellings of one body as one entry.
 *
 * `(scheme, digest)` rather than the digest alone: a scheme-1 body is not the same
 * body as a scheme-2 one, it is an older derivation of possibly-different code, and
 * merging them makes "how many distinct bodies" wrong. Unparseable values key as
 * themselves so they neither merge nor vanish.
 */
export function bodyKey(hash: string): string {
  const d = bodyDigest(hash);
  return d === null ? hash : `${hashSchemeOf(hash)}:${d}`;
}

/** Hash of an arbitrary string (used for ids / disambiguators). */
export function hashString(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
