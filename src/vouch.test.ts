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
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { document, reindex, getNode } from "./ops.js";
import { markReviewed } from "./reviews.js";
import { writeStore } from "./store.js";
import { indexBlob } from "./repo.js";
import type { State } from "./schema.js";
import { discard } from "./test-tmp.js";

const signed = { state: "reviewed", actor: "human" as const, at: "2026-01-01T00:00:00Z" };
const checked = { state: "reviewed", actor: "agent" as const, at: "2026-02-02T00:00:00Z" };
const none = { state: "unreviewed" };

/**
 * Driven through the REAL ops, not hand-built review states.
 *
 * The first version of this test constructed `{state: "reviewed"}` alongside a stale
 * node status — a pairing the system never produces. When code moves, the MARK's own
 * state becomes `stale` too, so the implementation it validated returned
 * `accountable: null` on every real stale doc, and the test passed anyway. Vacuous in
 * the exact way this project keeps warning about: the property could not have failed
 * on the inputs it was given. Only rendering a real universe caught it.
 */
test("a stale doc keeps its signature — which trust throws away", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-vouch-"));
  try {
    for (const a of [["init", "-q", "-b", "main"], ["config", "user.email", "izzie@x.com"], ["config", "user.name", "izzie"]]) {
      spawnSync("git", a as string[], { cwd: root });
    }
    mkdirSync(join(root, ".codemap"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    const SRC = "export function charge(cents) {\n  return cents;\n}\n";
    writeFileSync(join(root, "src/pay.js"), SRC, "utf8");
    const ix = await indexBlob(SRC, "src/pay.js");
    await writeStore(root, ix, { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State);
    await document(root, { id: "payments", type: "module", title: "Payments", summary: "charging", anchors: ix.map((a) => a.id) });

    // A PERSON signs it, then the code moves underneath them.
    await markReviewed(root, { targetKind: "node", targetId: "payments", level: "logical", actor: "human" });
    const before = await getNode(root, "payments") as any;
    assert.equal(before.trust, "verified");
    assert.equal(before.vouch.accountable.current, true, "signed, and about the current body");

    writeFileSync(join(root, "src/pay.js"), SRC.replace("return cents;", "return cents * 3;"), "utf8");
    await reindex(root);

    const after = await getNode(root, "payments") as any;
    // The single word: signed-and-then-changed is now spelled exactly like never-read.
    assert.equal(after.trust, "stale");
    // The split: both facts survive.
    assert.equal(after.vouch.fresh, false, "the code did move");
    assert.ok(after.vouch.accountable, "and a person still signed it");
    assert.equal(after.vouch.accountable.current, false, "about a body that has since changed");
    assert.equal(after.vouch.accountable.at, before.vouch.accountable.at, "the same act, not a new one");
  } finally { discard(root); }
});

test("accountability and evidence are independent, in both directions", () => {
  const both = vouchOf("fresh", { logical: signed, code: checked });
  assert.ok(both.accountable && both.evidence, "a person signed AND an agent checked");
  assert.equal(both.accountable!.level, "logical");
  assert.equal(both.accountable!.current, true, "a `reviewed` mark is current");
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
