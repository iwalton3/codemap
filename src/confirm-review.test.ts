/**
 * `confirm` records the read it performs — and does not overwrite a person.
 *
 * Confirming is the strongest read the maintenance loop has: it compares a doc
 * against code that CHANGED and says the claims still hold. It recorded nothing,
 * so `trustOf` went on reading `stale` off the review mark whose witness the same
 * change had invalidated. A sweep that verified the whole map left the whole map
 * looking unverified.
 *
 * The fix cannot be unconditional, and the first test here is why: review rows are
 * keyed on target+level and NOT on actor, so an agent mark replaces a human's
 * sign-off outright. That is a characterization test — it pins the behaviour the
 * guard exists for, so a future change making reviews actor-keyed fails here and
 * is pointed at the guard it makes unnecessary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { document } from "./ops.js";
import { markReviewed } from "./reviews.js";
import { readReviews, writeStore } from "./store.js";
import { trustOf } from "./ops/shared.js";
import { indexBlob } from "./repo.js";
import type { State } from "./schema.js";
import { discard } from "./test-tmp.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const SRC = "export function charge(cents) { return cents; }\n";

async function universe() {
  const root = mkdtempSync(join(tmpdir(), "codemap-confirm-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "izzie@x.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "izzie"], { cwd: root });
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/pay.js"), SRC, "utf8");
  const indexed = await indexBlob(SRC, "src/pay.js");
  await writeStore(root, indexed, state);
  await document(root, {
    id: "payments", type: "module", title: "Payments", summary: "charging",
    anchors: indexed.map((a) => a.id),
  });
  return { root, cleanup: () => discard(root) };
}

const logicalRows = async (root: string) =>
  (await readReviews(root)).reviews.filter(
    (r) => r.target.kind === "node" && r.target.id === "payments" && r.level === "logical");

test("an agent's logical mark REPLACES a human sign-off — which is why confirm guards", async () => {
  const u = await universe();
  try {
    await markReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "human" });
    const signed = await logicalRows(u.root);
    assert.equal(signed.length, 1);
    assert.equal(signed[0]!.actor, "human", "a person signed it");

    await markReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "agent" });
    const after = await logicalRows(u.root);
    assert.equal(after.length, 1, "one row per (target, level) — not one per actor");
    assert.equal(after[0]!.actor, "agent",
      "the person's sign-off is GONE. `confirm` must not do this on a maintenance sweep");
  } finally { u.cleanup(); }
});

test("with nobody signed, an agent review is what moves trust off unverified", async () => {
  const u = await universe();
  try {
    // What `confirm` now records, and the state it records it from.
    assert.equal(trustOf("fresh", undefined), "unverified");
    await markReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "agent" });
    const [row] = await logicalRows(u.root);
    assert.ok(row, "the mark landed");
    assert.equal(row!.actor, "agent");

    const review = {
      logical: { state: "reviewed", actor: "agent" as const },
      code: { state: "unreviewed" },
    };
    assert.equal(trustOf("fresh", review), "checked",
      "an agent's corroborating read — never `verified`, which stays a person's");
    // And the ceiling holds: this cannot manufacture a human sign-off.
    assert.notEqual(trustOf("fresh", review), "verified");
  } finally { u.cleanup(); }
});

test("a stale doc's trust is still gated on the doc's own status", async () => {
  // Recording a review does not paper over a `stale`/`dangling` node: `trustOf`
  // short-circuits on status before it looks at any mark, so `confirm` clearing the
  // flag and recording the read are two separate things that must both happen.
  const review = { logical: { state: "reviewed", actor: "agent" as const }, code: { state: "unreviewed" } };
  assert.equal(trustOf("stale", review), "stale");
  assert.equal(trustOf("dangling", review), "stale");
  assert.equal(trustOf("fresh", review), "checked");
});
