/**
 * `PrStoryPage.blank()` is what a navigation between pull requests resets, and
 * `propsChanged` applies it with `Object.assign` — a MERGE. So a state field that
 * is assigned somewhere but missing from `blank()` is not reset: it carries from
 * the pull request you were just on to the one you are now looking at.
 *
 * That is not hypothetical. Five fields were missing when this was written, and
 * two of them decide what gets published: `pushDraft` holds the review summary
 * and the APPROVE / REQUEST_CHANGES verdict, and `pick` the finding ids selected
 * to go out with it. The comment above `blank()` already described this failure
 * for a different field; this is the check that makes it stop recurring.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function prStoryPage(): string {
  const src = readFileSync("web/app.js", "utf8");
  const at = src.indexOf("class PrStoryPage extends Component");
  assert.ok(at > 0, "could not find PrStoryPage in web/app.js");
  const end = src.indexOf("\ndefineComponent('pr-story-page'", at);
  assert.ok(end > at, "could not find the end of PrStoryPage");
  return src.slice(at, end);
}

test("every state field PrStoryPage writes is reset when the pull request changes", () => {
  const body = prStoryPage();
  const blank = body.slice(body.indexOf("static blank()"), body.indexOf("constructor(props)"));
  const reset = new Set([...blank.matchAll(/(\w+):/g)].map((m) => m[1]!));
  assert.ok(reset.size > 10, `only parsed ${reset.size} fields out of blank() — the parse is wrong, not the code`);

  const written = new Set([...body.matchAll(/this\.state\.(\w+)\s*=[^=]/g)].map((m) => m[1]!));
  assert.ok(written.size > 5, `only parsed ${written.size} state writes — the parse is wrong, not the code`);

  const carried = [...written].filter((k) => !reset.has(k)).sort();
  assert.deepEqual(carried, [], "these survive a move to another pull request — add them to PrStoryPage.blank()");
});

test("the reset is applied as a merge, which is why the check above is needed", () => {
  // If this ever becomes a wholesale replacement the invariant holds for free —
  // and this test should be deleted rather than left asserting a stale reason.
  assert.match(prStoryPage(), /Object\.assign\(this\.state, PrStoryPage\.blank\(\)\)/);
});
