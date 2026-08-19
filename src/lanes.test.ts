import { test } from "node:test";
import assert from "node:assert/strict";
import { compileLanes, parseLaneOverrides, LANE_POLICY } from "./lanes.js";

const laneOf = (p: string) => compileLanes().classify(p);
const reviewOf = (p: string) => LANE_POLICY[laneOf(p)].review;

test("a directory name does not take parseable source out of the review queue", () => {
  // Lanes route attention; they never hide a defect. `**/Migrations/` is in the data
  // lane, so an EF migration — C# that can drop a column — classified as `glance`
  // and was filtered out of the queue entirely.
  assert.equal(laneOf("src/Db/Migrations/20260101_AddColumn.cs"), "code");
  assert.equal(reviewOf("src/Db/Migrations/20260101_AddColumn.cs"), "queue");
  assert.equal(laneOf("src/i18n/locales/index.ts"), "code");

  // …but a data FILE in the same place is still data
  assert.equal(laneOf("src/Db/Migrations/seed.sql"), "data");
  assert.equal(laneOf("src/i18n/locales/en.json"), "data");

  // and generated/test keep their claim on source — being machine-written or a
  // test is a fact about the file, not about the directory it sits in
  assert.equal(laneOf("src/Api/Client.g.cs"), "generated");
  assert.equal(laneOf("src/orders/order.test.ts"), "test");
});

test("`.spec.` only means a test when it is source", () => {
  // The test lane is evaluated first, so `*.spec.*` made an API contract read as
  // "test evidence about code elsewhere".
  assert.equal(laneOf("src/orders/orders.spec.ts"), "test");
  assert.equal(laneOf("contracts/orders.spec.yaml"), "data");
  assert.equal(laneOf("contracts/orders.spec.json"), "data");
});

test("a malformed .codemaplanes is reported, never silently applied to the wrong lane", () => {
  // A header with inner spaces was not recognised as a header, so it and every
  // pattern under it were appended to the PREVIOUS section — and if that was
  // `[generated]`, the user's own code landed in the skip lane and disappeared.
  const r = parseLaneOverrides("[generated]\n*.gen.ts\n[ test ]\nsrc/Foo.cs\n");
  assert.deepEqual(r.overrides.generated, ["*.gen.ts"], "nothing leaks into the previous lane");
  assert.deepEqual(r.overrides.test, ["src/Foo.cs"], "a header with spaces is still a header");
  assert.deepEqual(r.problems, []);
  assert.equal(compileLanes(r.overrides).classify("src/Foo.cs"), "test");

  // an unknown lane name drops its patterns — but says so
  const bad = parseLaneOverrides("[tests]\nsrc/Foo.cs\n");
  assert.deepEqual(bad.overrides, {});
  assert.equal(bad.problems.length, 1);
  assert.match(bad.problems[0]!, /unknown lane "tests"/);

  // as does a pattern written before any section
  const early = parseLaneOverrides("src/Foo.cs\n[test]\nsrc/Bar.cs\n");
  assert.deepEqual(early.overrides.test, ["src/Bar.cs"]);
  assert.equal(early.problems.length, 1);
  assert.match(early.problems[0]!, /not under any \[lane\]/);

  // and a broken file never claims to have worked
  assert.equal(compileLanes(bad.overrides, bad.problems).problems.length, 1);
});
