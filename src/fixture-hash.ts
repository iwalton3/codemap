import { createHash } from "node:crypto";

/**
 * A body hash for tests: a readable label, a real digest.
 *
 * Fixtures used to be written `"sha256:OLD"` — short, legible, and not a hash.
 * That was not only a fixture problem. `hashSchemeOf` could not tell a malformed
 * value from a scheme-1 one, so those fixtures were *valid inputs* to the code
 * under test, and whole files compared them successfully while exercising none of
 * the real format. `acceptance.test.ts` had 69 comparisons passing because both
 * sides were unparseable and defaulted to scheme 1 together.
 *
 * Deriving the digest from the label keeps both properties: `fixtureHash("OLD")`
 * reads as well as the literal did, and produces the 64 lowercase hex characters
 * the parser now requires. Same label, same digest, every run — so a test can
 * still say "this is the same body as that one" by saying the same word.
 */
export function fixtureHash(tag: string, scheme = 1): string {
  const digest = createHash("sha256").update(`fixture:${tag}`).digest("hex");
  return `${scheme === 1 ? "" : `h${scheme}:`}sha256:${digest}`;
}
