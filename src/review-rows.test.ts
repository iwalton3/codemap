/**
 * Review rows are keyed on WHO made them (trust split, step 3).
 *
 * Before this, one row existed per (target, level, viewed) and a new mark replaced
 * it — so an agent's `checked` silently wiped a person's `signed`. That is why
 * `confirm` had to refuse to record on a signed doc, and why `Vouch.evidence` could
 * not count distinct error profiles: the count was pinned at 1 by the storage.
 *
 * The second half of this file is the hazard the change CREATES if only half of it
 * is done: `unmarkReviewed` and `markReviewedBatch` both cleared every row at a
 * slot regardless of author, which is harmless with one row and is a way to delete
 * somebody else's sign-off with two.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { markReviewed, markReviewedBatch, unmarkReviewed, reviewStatus } from "./reviews.js";
import { readReviews, writeStore } from "./store.js";
import { document, getNode } from "./ops.js";
import { indexBlob } from "./repo.js";
import type { State } from "./schema.js";
import { discard } from "./test-tmp.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const SRC = "export function charge(cents) {\n  return cents;\n}\n";

async function universe() {
  const root = mkdtempSync(join(tmpdir(), "codemap-rows-"));
  for (const a of [["init", "-q", "-b", "main"], ["config", "user.email", "izzie@x.com"], ["config", "user.name", "izzie"]]) {
    spawnSync("git", a, { cwd: root });
  }
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/pay.js"), SRC, "utf8");
  const ix = await indexBlob(SRC, "src/pay.js");
  await writeStore(root, ix, state);
  await document(root, { id: "payments", type: "module", title: "Payments", summary: "charging", anchors: ix.map((a) => a.id) });
  return { root, anchors: ix.map((a) => a.id), cleanup: () => discard(root) };
}

/** Runs `fn` as a distinct error profile — `resolveActor` reads the model from env. */
const asModel = async (model: string | undefined, fn: () => Promise<unknown>) => {
  const saved = process.env.CODEMAP_AGENT_MODEL;
  if (model === undefined) delete process.env.CODEMAP_AGENT_MODEL;
  else process.env.CODEMAP_AGENT_MODEL = model;
  try { await fn(); } finally {
    if (saved === undefined) delete process.env.CODEMAP_AGENT_MODEL;
    else process.env.CODEMAP_AGENT_MODEL = saved;
  }
};

const rowsFor = async (root: string, level = "logical") =>
  (await readReviews(root)).reviews.filter((r) => r.target.id === "payments" && r.level === level);

test("an agent's mark no longer replaces a person's sign-off", async () => {
  const u = await universe();
  try {
    await markReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "human" });
    await asModel("claude-opus-5", () =>
      markReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "agent" }));

    const rows = await rowsFor(u.root);
    assert.equal(rows.length, 2, "two reviewers, two rows — this was 1 before step 3");
    assert.deepEqual(rows.map((r) => r.actor).sort(), ["agent", "human"]);
  } finally { u.cleanup(); }
});

test("two models for one person are two rows, not one revised one", async () => {
  // `reviewerKey` is principal + model, and its own comment argues this: a reviewer
  // running two models produces two opinions, and collapsing them loses the
  // disagreement. Reviews now key the same way corroborations do.
  const u = await universe();
  try {
    await asModel("claude-opus-5", () =>
      markReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "agent" }));
    await asModel("codex-1", () =>
      markReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "agent" }));
    assert.equal((await rowsFor(u.root)).length, 2, "different error profiles, kept apart");

    // ...and the SAME profile twice is a revision, not a second opinion.
    await asModel("codex-1", () =>
      markReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "agent" }));
    assert.equal((await rowsFor(u.root)).length, 2, "re-marking replaces your own row");
  } finally { u.cleanup(); }
});

test("the collapsed view still answers, human first", async () => {
  // ~25 call sites read one `ReviewInfo` per level and none wants a list.
  const u = await universe();
  try {
    await asModel("claude-opus-5", () =>
      markReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "agent" }));
    const agentOnly = await reviewStatus(u.root, { kind: "node", id: "payments" });
    assert.equal(agentOnly.logical.actor, "agent");

    await markReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "human" });
    const both = await reviewStatus(u.root, { kind: "node", id: "payments" });
    assert.equal(both.logical.actor, "human", "the person's mark is what the collapsed view reports");
    assert.equal(both.logical.state, "reviewed");

    // And the node surface agrees — `trust` unchanged, `vouch` now sees both.
    const n = await getNode(u.root, "payments") as any;
    assert.equal(n.trust, "verified");
    assert.ok(n.vouch.accountable, "a person signed");
  } finally { u.cleanup(); }
});

// ---------------------------------------------------------------------------
// The hazard: multiplying rows without narrowing the deletes.
// ---------------------------------------------------------------------------

test("unmark withdraws YOUR vouch, not everybody's", async () => {
  // The defect this guards: `review(unmark: true)` cleared every row at the level,
  // so once rows are actor-keyed an agent could delete a person's sign-off through
  // the ordinary tool, with no guard and no record.
  const u = await universe();
  try {
    await markReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "human" });
    await asModel("claude-opus-5", () =>
      markReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "agent" }));
    assert.equal((await rowsFor(u.root)).length, 2);

    // The AGENT withdraws, as an agent. A blanket patch once made this say "human",
    // which correctly deleted the person's row and failed — the parameter is doing
    // exactly its job.
    await asModel("claude-opus-5", () =>
      unmarkReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "agent" }));

    const left = await rowsFor(u.root);
    assert.equal(left.length, 1, "only the agent's own mark went");
    assert.equal(left[0]!.actor, "human", "the person's sign-off survived");
  } finally { u.cleanup(); }
});

test("a person's unmark spares an agent row that recorded no model or harness", async () => {
  // The collision the first version of this had, and the reason `unmarkReviewed`
  // takes ONE key rather than trying both spellings of its own. A human caller has
  // no `via`, so its agent-spelling is `principal\0\0agent\0` — which is exactly the
  // key of an agent row with nothing recorded about it. Clearing your own sign-off
  // silently took that agent's mark with it.
  //
  // Not covered by the sibling test above: that one runs the agent WITH a model, so
  // the keys could not collide and it passed against the broken version.
  const u = await universe();
  try {
    await markReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "agent" });
    await markReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "human" });
    assert.equal((await rowsFor(u.root)).length, 2, "an unattributed agent mark and a sign-off");

    await unmarkReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "human" });

    const left = await rowsFor(u.root);
    assert.equal(left.length, 1, "only the person's own mark went");
    assert.equal(left[0]!.actor, "agent", "the agent's read survived");
  } finally { u.cleanup(); }
});

test("a batch mark does not clear other reviewers across a whole PR's anchors", async () => {
  // The same defect, louder: one `review(ids: [...])` call spans every anchor in a
  // packet page, so an unnarrowed replace would wipe a reviewer's marks wholesale.
  const u = await universe();
  try {
    for (const id of u.anchors) {
      await markReviewed(u.root, { targetKind: "anchor", targetId: id, level: "code", actor: "human" });
    }
    const before = (await readReviews(u.root)).reviews.filter((r) => r.actor === "human").length;
    assert.equal(before, u.anchors.length, "the fixture really has human marks to lose");

    await asModel("claude-opus-5", () =>
      markReviewedBatch(u.root, u.anchors, { level: "code", actor: "agent" }));

    const after = (await readReviews(u.root)).reviews;
    assert.equal(after.filter((r) => r.actor === "human").length, before, "none of them went");
    assert.equal(after.filter((r) => r.actor === "agent").length, u.anchors.length, "and the agent's landed");
  } finally { u.cleanup(); }
});

// ---------------------------------------------------------------------------
// Distinct error profiles — the count that could not vary before step 3.
// ---------------------------------------------------------------------------

test("profiles counts distinct error profiles, not reads", async () => {
  const u = await universe();
  try {
    const level = (n: string) => reviewStatus(u.root, { kind: "node", id: n }).then((p) => p.logical);

    await asModel("claude-opus-5", () =>
      markReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "agent" }));
    assert.equal((await level("payments")).profiles, 1);

    // The SAME profile looking again is not a second profile. This is the whole
    // reason the field counts profiles rather than acts.
    await asModel("claude-opus-5", () =>
      markReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "agent" }));
    assert.equal((await level("payments")).profiles, 1, "re-reading is not corroboration");

    // A different vendor is.
    await asModel("codex-1", () =>
      markReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "agent" }));
    assert.equal((await level("payments")).profiles, 2, "two looks that could have failed differently");

    // And a person is their own profile, distinct from any agent.
    await markReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "human" });
    assert.equal((await level("payments")).profiles, 3);
  } finally { u.cleanup(); }
});

test("the count reaches the vouch, and 1 is reported rather than omitted", async () => {
  // A reader must be able to tell "one profile" from "this build does not compute it".
  const u = await universe();
  try {
    await asModel("claude-opus-5", () =>
      markReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "agent" }));
    const n = await getNode(u.root, "payments") as any;
    assert.ok(n.vouch.evidence, "an agent read it");
    assert.equal(n.vouch.evidence.profiles, 1);

    await asModel("codex-1", () =>
      markReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "agent" }));
    const n2 = await getNode(u.root, "payments") as any;
    assert.equal(n2.vouch.evidence.profiles, 2, "cross-vendor corroboration is visible on the node");
  } finally { u.cleanup(); }
});

// ---------------------------------------------------------------------------
// What two review passes found that the tests above did not.
// ---------------------------------------------------------------------------

test("a sign-off and an agent's check are BOTH reported, at one level", async () => {
  // The defect keying rows on the reviewer exists to prevent, surviving at the
  // reporting layer: `vouchOf` read the COLLAPSED row, which keeps one mark per
  // level, so a person's sign-off hid the agent's read entirely and `evidence` was
  // null. The storage held both; nothing surfaced both.
  const u = await universe();
  try {
    await markReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "human" });
    await asModel("claude-opus-5", () =>
      markReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "agent" }));

    const n = await getNode(u.root, "payments") as any;
    assert.ok(n.vouch.accountable, "a person signed");
    assert.ok(n.vouch.evidence, "AND an agent read it — this was null");
    assert.equal(n.vouch.accountable.level, "logical");
    assert.equal(n.vouch.evidence.level, "logical", "both at the SAME level");
    assert.equal(n.vouch.evidence.profiles, 2);
  } finally { u.cleanup(); }
});

test("any stale mark makes the vouch not fresh, not just the collapsed one", async () => {
  // A current human sign-off beside a stale agent check reported `fresh: true`,
  // because `fresh` read the one row the collapse chose.
  const { vouchOf } = await import("./ops/shared.js");
  const marks = [{ actor: "human" as const, state: "reviewed" }, { actor: "agent" as const, state: "stale" }];
  const v = vouchOf("fresh", { logical: { state: "reviewed", actor: "human", marks }, code: { state: "unreviewed" } });
  assert.equal(v.fresh, false, "the agent's witness moved, and that is visible");
  assert.ok(v.accountable?.current, "while the person's mark is still current");
  assert.equal(v.evidence?.current, false);
});

test("unmark works when the environment names a harness", async () => {
  // `resolveActor` sets `via` from CODEMAP_AGENT_MODEL or _HARNESS, so a `serve.js`
  // launched from a shell exporting either wrote web sign-offs under the human key
  // and computed the AGENT key to withdraw them: nothing matched, the call returned
  // `{ ok: true, removed: 0 }`, and the chip stayed green. Mark and unmark must
  // derive identity the same way.
  const u = await universe();
  const saved = process.env.CODEMAP_AGENT_HARNESS;
  process.env.CODEMAP_AGENT_HARNESS = "some-harness";
  try {
    await markReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "human" });
    assert.equal((await rowsFor(u.root)).length, 1);
    await unmarkReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "human" });
    assert.equal((await rowsFor(u.root)).length, 0, "the person's own mark was withdrawn");
  } finally {
    if (saved === undefined) delete process.env.CODEMAP_AGENT_HARNESS; else process.env.CODEMAP_AGENT_HARNESS = saved;
    u.cleanup();
  }
});

test("a pre-identity row can still be replaced and withdrawn", async () => {
  // Rows written before `Review.by` existed key as `legacy\0<reviewer>`, which the
  // modern form cannot produce once a git identity resolves. Matching only the modern
  // key left them unreachable: re-marking accumulated a duplicate, and unmarking
  // removed nothing while reporting success.
  const u = await universe();
  try {
    const { writeReviews } = await import("./store.js");
    const { actorLabel } = await import("./identity.js");
    const { resolveActor } = await import("./identity.js");
    const label = actorLabel(resolveActor(u.root, {})!);
    await writeReviews(u.root, [{
      id: "rev_legacy", target: { kind: "node", id: "payments" }, level: "logical",
      reviewer: label, at: "2025-01-01T00:00:00Z", witnesses: [], accepted: [],
    } as never]);
    assert.equal((await rowsFor(u.root)).length, 1, "a legacy row with no `by`");

    await markReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "human" });
    assert.equal((await rowsFor(u.root)).length, 1, "replaced, not duplicated");

    await unmarkReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical", actor: "human" });
    assert.equal((await rowsFor(u.root)).length, 0, "and it can be cleared");
  } finally { u.cleanup(); }
});

test("withdrawing a cover takes only the caller's cover rows", async () => {
  // The THIRD write path. `docs/trust-split.md` claimed the hazard was closed "in
  // both write paths"; this one still dropped every reviewer's covered rows.
  const u = await universe();
  try {
    const { markReviewedBatch, unmarkCovered } = await import("./reviews.js");
    await markReviewedBatch(u.root, u.anchors, { level: "code", actor: "human", coveredBy: "payments" });
    await asModel("codex-1", () =>
      markReviewedBatch(u.root, u.anchors, { level: "code", actor: "agent", coveredBy: "payments" }));
    const all = (await readReviews(u.root)).reviews.filter((r) => r.coveredBy === "payments");
    assert.equal(all.length, u.anchors.length * 2, "two reviewers' covers");

    await unmarkCovered(u.root, "payments", { level: "code", actor: "human" });
    const left = (await readReviews(u.root)).reviews.filter((r) => r.coveredBy === "payments");
    assert.equal(left.length, u.anchors.length, "only the person's covers went");
    assert.ok(left.every((r) => r.actor === "agent"), "the agent's survived");
  } finally { u.cleanup(); }
});
