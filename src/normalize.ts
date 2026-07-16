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

/** "sha256:..." digest of the canonicalized token stream. */
export function hashTokens(tokens: string[]): string {
  return "sha256:" + createHash("sha256").update(canonicalize(tokens)).digest("hex");
}

/** Hash of an arbitrary string (used for ids / disambiguators). */
export function hashString(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
