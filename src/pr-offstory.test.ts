/**
 * Which findings a pull request owns that sit on none of its symbols.
 *
 * The bug this covers: the rule used to be "is the target missing from the working
 * tree?", which is true of every finding on every other branch. The whole map's
 * orphans were listed on every pull request alike, and an agent handed that list
 * re-cited them against changes they had nothing to do with.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { offStoryReason, type OffStoryContext } from "./pr.js";
import type { Annotation } from "./schema.js";

const HEAD = "head0000000000000000000000000000000000000";

const finding = (over: Partial<Annotation> = {}): Annotation => ({
  id: "an_1",
  target: { kind: "anchor", id: "a_gone" },
  text: "the credit gate is not enforced",
  kind: "finding",
  author: "me",
  createdCommit: null,
  ...over,
});

const ctx = (over: Partial<OffStoryContext> = {}): OffStoryContext => ({
  pr: 264,
  head: HEAD,
  changed: new Set(["src/pay.ts"]),
  unplaceable: true,
  ...over,
});

test("an orphan tied to nothing is no pull request's business", () => {
  // The regression. Its target is gone from the tree — which says where the CODE
  // went, not which change is responsible for it.
  assert.equal(offStoryReason(finding(), ctx({ file: "src/other.ts" })), null);
  assert.equal(offStoryReason(finding(), ctx({ file: undefined })), null, "and one with no file at all is still nobody's");
  assert.equal(
    offStoryReason(finding({ sourceRef: "beef000000000000000000000000000000000000" }), ctx({ file: "src/other.ts" })),
    null,
    "raised while reading ANOTHER branch stays with that branch",
  );
});

test("the four ties a pull request has to code it does not contain", () => {
  assert.equal(offStoryReason(finding({ postedRef: { pr: 264, at: "t", placement: "inline" } }), ctx()), "posted");
  assert.equal(offStoryReason(finding({ publishPath: "src/pay.ts" }), ctx({ file: "src/other.ts" })), "publish-path");
  assert.equal(offStoryReason(finding(), ctx({ file: "src/pay.ts" })), "in-diff", "the symbol this branch renamed away");
  assert.equal(offStoryReason(finding({ sourceRef: HEAD }), ctx({ file: "src/other.ts" })), "at-head");
});

test("posted somewhere else is somewhere else's", () => {
  const other = finding({ postedRef: { pr: 263, at: "t", placement: "inline" } });
  assert.equal(offStoryReason(other, ctx({ file: "src/other.ts" })), null);
  // …and being posted to this one carries a finding whose target still resolves,
  // which is the case the `unplaceable` gate would otherwise drop: it is live on
  // the pull request, so the panel must be able to edit and resolve it.
  assert.equal(
    offStoryReason(finding({ postedRef: { pr: 264, at: "t", placement: "inline" } }), ctx({ unplaceable: false })),
    "posted",
  );
});

test("a placeable target that this pull request simply does not touch is not admitted", () => {
  // The control: without it, "belongs to this PR" could be satisfied by every
  // finding in the universe and the tests above would still pass.
  assert.equal(offStoryReason(finding({ publishPath: "src/pay.ts" }), ctx({ unplaceable: false })), null);
  assert.equal(offStoryReason(finding({ sourceRef: HEAD }), ctx({ unplaceable: false })), null);
});

test("a publish path or a file outside the diff ties nothing", () => {
  assert.equal(offStoryReason(finding({ publishPath: "src/elsewhere.ts" }), ctx({ file: undefined })), null);
  assert.equal(offStoryReason(finding(), ctx({ file: "src/elsewhere.ts" })), null);
});
