import { strict as assert } from "node:assert";
import { test } from "node:test";
import { workEligibility } from "./ops/decision-holds.js";

const assigned = { at: "2026-09-25T12:00:00.000Z", by: { principal: "owner" } };

test("bug comparison restriction survives later human assignment", () => {
  const mark = { held: [
    { decision: "d1", why: "undecided" as const, since: "2026-09-25T09:00:00.000Z" },
    { decision: "d2", why: "comparison" as const, answers: ["a1", "a2"] as [string, string], since: "2026-09-25T10:00:00.000Z" },
  ] };
  const work = workEligibility(mark, assigned, "bug");
  assert.equal(work.allowed, false);
  assert.equal(work.restrictions.length, 2);
  assert.match(work.reason!, /bug work awaits comparison/);
});

test("releasing one bug restriction leaves the other independent hold", () => {
  const undecided = { held: [{ decision: "d1", why: "undecided" as const, since: "2026-09-25T09:00:00.000Z" }] };
  assert.equal(workEligibility(undecided, undefined, "bug").allowed, false);
  assert.equal(workEligibility(undecided, assigned, "bug").allowed, true);
  assert.equal(workEligibility({ held: "unknown" }, assigned, "bug").allowed, false);
});
