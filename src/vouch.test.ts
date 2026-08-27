/**
 * `vouchOf` — the claims `trust` collapses into one word, said separately.
 *
 * The headline defect, and the first test below: `trustOf` short-circuits on a stale
 * status before it looks at any mark, so a doc a person signed and an agent
 * re-checked reads identically to one nobody ever read the moment the code moves.
 * Freshness is a real answer, but it is not a verdict on who vouched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { trustOf, vouchOf } from "./ops/shared.js";

const signed = { state: "reviewed", actor: "human" as const, at: "2026-01-01T00:00:00Z" };
const checked = { state: "reviewed", actor: "agent" as const, at: "2026-02-02T00:00:00Z" };
const none = { state: "unreviewed" };

test("a stale doc keeps its signature — which trust throws away", () => {
  const review = { logical: signed, code: none };

  // What the single word does today, and it is not wrong — just lossy.
  assert.equal(trustOf("fresh", review), "verified");
  assert.equal(trustOf("stale", review), "stale");
  assert.equal(trustOf("stale", { logical: none, code: none }), "stale",
    "signed and never-read are the SAME word once the code moves");

  // What the split says instead.
  const v = vouchOf("stale", review);
  assert.equal(v.fresh, false, "the code did move — that stays true");
  assert.ok(v.accountable, "and a person still signed it, which is also true");
  assert.equal(v.accountable!.at, signed.at);

  const never = vouchOf("stale", { logical: none, code: none });
  assert.equal(never.accountable, null);
  // The distinction trust cannot express.
  assert.notDeepEqual(v.accountable, never.accountable);
});

test("accountability and evidence are independent, in both directions", () => {
  const both = vouchOf("fresh", { logical: signed, code: checked });
  assert.ok(both.accountable && both.evidence, "a person signed AND an agent checked");
  assert.equal(both.accountable!.level, "logical");
  assert.equal(both.evidence!.level, "code");

  const agentOnly = vouchOf("fresh", { logical: checked, code: none });
  assert.equal(agentOnly.accountable, null, "an agent's read is never accountability");
  assert.ok(agentOnly.evidence);

  const humanOnly = vouchOf("fresh", { logical: signed, code: none });
  assert.ok(humanOnly.accountable);
  assert.equal(humanOnly.evidence, null, "and a sign-off is not evidence of a read");
});

test("no agent act can produce accountability", () => {
  // The rule that keeps the axis honest. If this ever fails, an agent has been
  // given a way to manufacture a human's sign-off.
  for (const level of ["logical", "code"] as const) {
    const review = { logical: none, code: none, [level]: checked } as never;
    assert.equal(vouchOf("fresh", review).accountable, null);
  }
});

test("a legacy mark with no actor is evidence, NOT accountability", () => {
  // Every default in `reviews.ts` is `?? "agent"` — a legacy row cannot show that a
  // person stood behind it, and the safe reading of "cannot tell" is the lower tier.
  // `ReviewInfo`'s doc comment claimed the opposite and was corrected alongside this;
  // it was wrong in the direction that inflates trust, and this test is what caught it.
  const legacy = { state: "reviewed", at: "2025-01-01T00:00:00Z" };
  const review = { logical: legacy, code: none };
  assert.equal(trustOf("fresh", review), "checked", "not `verified`");
  const v = vouchOf("fresh", review);
  assert.equal(v.accountable, null, "nobody's name is on this");
  assert.ok(v.evidence, "but a read did happen");
});

test("coverage is unknown until something derives it", () => {
  // ~100% of nodes at first, and that is the honest starting reading — the queue it
  // creates is the work-list. It must never be settable by an author.
  for (const status of ["fresh", "stale", "generated", undefined]) {
    assert.equal(vouchOf(status, { logical: signed, code: checked }).coverage, "unknown");
  }
});

test("generated nodes still report freshness and vouching", () => {
  // `trustOf` returns "generated" and stops, which is an ORIGIN answer occupying the
  // slot. The origin stays on `status`, where it belongs; this axis keeps answering.
  assert.equal(trustOf("generated", { logical: signed, code: none }), "generated");
  const v = vouchOf("generated", { logical: signed, code: none });
  assert.equal(v.fresh, true);
  assert.ok(v.accountable, "an analyzer-emitted node a person signed is still signed");
});
