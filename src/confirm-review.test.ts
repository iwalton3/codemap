/**
 * `confirm` records the read it performs — and does not overwrite a person.
 *
 * Confirming is the strongest read the maintenance loop has: it compares a doc
 * against code that CHANGED and says the claims still hold. It recorded nothing,
 * so `trustOf` went on reading `stale` off the review mark whose witness the same
 * change had invalidated. A sweep that verified the whole map left the whole map
 * looking unverified.
 *
 * It shipped with a guard — do not record on a doc a person has signed — because
 * review rows were keyed on target+level and an agent mark replaced a sign-off
 * outright. Step 3 of the trust split keyed rows on the reviewer, the
 * characterization test below failed exactly as it was written to, and the guard
 * was removed. What is left is the record: both marks now coexist.
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

test("an agent's mark sits BESIDE a human sign-off — the guard's reason is gone", async () => {
  // This test previously asserted the opposite, and was written to fail here: rows
  // were keyed on (target, level) so an agent mark replaced the sign-off, which is
  // why `confirm` refused to record on a signed doc at all. Rows are keyed on the
  // reviewer now (`rowIdentity` — principal, model, actor kind, observed harness),
  // so the two are different rows and the guard has nothing left to prevent.
  const u = await universe();
  try {
    await markReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "human" });
    assert.equal((await logicalRows(u.root)).length, 1);

    await markReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "agent" });
    const after = await logicalRows(u.root);
    assert.equal(after.length, 2, "two claims, two rows");
    assert.deepEqual(after.map((r) => r.actor).sort(), ["agent", "human"],
      "the person's sign-off survived a maintenance sweep");
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
