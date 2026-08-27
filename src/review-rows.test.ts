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

    await asModel("claude-opus-5", () =>
      unmarkReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical" }));

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

    await unmarkReviewed(u.root, { targetKind: "node", targetId: "payments", level: "logical" });

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
