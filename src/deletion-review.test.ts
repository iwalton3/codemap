/**
 * Review of DELETIONS (triage run 2026-09-19-post-round-review, Item D): a symbol a change
 * deletes is signable, counts in the done-count (Q5), and its sign-off holds while the
 * symbol stays absent. Reverses the earlier "deleted code is not signable" (branch round,
 * item 7).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { init } from "./ops.js";
import { readSnapshot } from "./snapshots.js";
import { computeDiff } from "./diff.js";
import { markReviewed, markReviewedBatch, reviewStatesFor } from "./reviews.js";
import { readReviews, writeReviews } from "./store.js";
import { discard } from "./test-tmp.js";

const LEDGER = "export class Ledger {\n  post(x: number) {\n    return x;\n  }\n  void(x: number) {\n    return -x;\n  }\n}\n";
const PAY = "export function transfer(cents: number) {\n  return cents;\n}\n";

/** main has `Ledger` (2 methods); `feature` deletes the file. */
async function repo() {
  const base = mkdtempSync(join(tmpdir(), "codemap-delreview-"));
  const root = join(base, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".codemap"), { recursive: true });
  const git = (...a: string[]) => {
    const r = spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=izzie", ...a], { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "src/ledger.ts"), LEDGER);
  writeFileSync(join(root, "src/pay.ts"), PAY);
  writeFileSync(join(root, ".gitignore"), ".codemap/\n");
  git("add", "-A"); git("commit", "-q", "-m", "main");
  const baseSha = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", "feature");
  git("rm", "-q", "src/ledger.ts");
  git("commit", "-q", "-m", "delete the ledger");
  const headSha = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  await init(root);
  const baseSnap = (await readSnapshot(root, baseSha))!;
  await readSnapshot(root, headSha);
  const ledger = baseSnap.filter((a) => a.file === "src/ledger.ts");
  const cls = ledger.find((a) => a.symbolPath.length === 1)!;
  const members = ledger.filter((a) => a !== cls);
  return { root, git, baseSha, headSha, cls, members, cleanup: () => discard(base) };
}

const coverage = async (root: string, base: string, head: string) => {
  const d = await computeDiff(root, base, head);
  if ("error" in d) throw new Error(d.error);
  return d.coverage;
};

const sign = (root: string, ids: string[], ref: string, coveredBy?: string) =>
  markReviewedBatch(root, ids, { level: "code", actor: "human", attestation: "signed", ref, ...(coveredBy ? { coveredBy } : {}) });

test("a change deleting a class with N methods has N+1 symbols to review, and one sign-off clears them", async () => {
  const u = await repo();
  try {
    assert.equal(u.members.length, 2);
    const before = await coverage(u.root, u.baseSha, u.headSha);
    assert.equal(before.total, 3, "the class and its two methods");
    assert.equal(before.outstanding, 3);

    const r = await sign(u.root, [u.cls.id], u.headSha);
    assert.equal(r.unwitnessed, undefined, "a deleted symbol is signable");
    await sign(u.root, u.members.map((m) => m.id), u.headSha, u.cls.id);
    const after = await coverage(u.root, u.baseSha, u.headSha);
    assert.equal(after.outstanding, 0, JSON.stringify(after));
  } finally { u.cleanup(); }
});

test("a deletion sign-off goes stale when the symbol comes back at the head", async () => {
  const u = await repo();
  try {
    await sign(u.root, [u.cls.id], u.headSha);
    u.git("checkout", "-q", "feature");
    writeFileSync(join(u.root, "src/ledger.ts"), LEDGER);
    u.git("add", "-A"); u.git("commit", "-q", "-m", "the ledger is back");
    const back = u.git("rev-parse", "HEAD");
    u.git("checkout", "-q", "main");
    const at = async (ref: string) => (await reviewStatesFor(u.root, [{ kind: "anchor", id: u.cls.id }], { ref })).get(`anchor:${u.cls.id}`)!.code.state;
    assert.equal(await at(u.headSha), "reviewed");
    assert.equal(await at(back), "stale", "the deletion it approved is no longer being made");
  } finally { u.cleanup(); }
});

test("a sign-off made before this on an absent symbol still reads reviewed", async () => {
  // The only stored shape that reached deleted code before: a live container's cover of
  // a deleted member (9bc78a0), witnessed ABSENT with no accepted body.
  const u = await repo();
  try {
    await sign(u.root, [u.members[0]!.id], u.headSha, u.cls.id);
    const rs = await readReviews(u.root);
    for (const r of rs.reviews) {
      r.witnesses = r.witnesses.map((w) => ({ anchorId: w.anchorId, bodyHash: "sha256:absent" }));
      r.accepted = r.accepted?.map((c) => ({ ...c, entries: [] }));
    }
    await writeReviews(u.root, rs.reviews);
    const s = (await reviewStatesFor(u.root, [{ kind: "anchor", id: u.members[0]!.id }], { ref: u.headSha }))
      .get(`anchor:${u.members[0]!.id}`)!.code.state;
    assert.equal(s, "reviewed");
  } finally { u.cleanup(); }
});

test("a change that deletes nothing has the same done-count as before", async () => {
  const u = await repo();
  try {
    u.git("checkout", "-q", "-b", "edit", u.baseSha);
    writeFileSync(join(u.root, "src/pay.ts"), PAY.replace("cents;", "cents + 0;"));
    u.git("commit", "-q", "-am", "edit");
    const edit = u.git("rev-parse", "HEAD");
    u.git("checkout", "-q", "main");
    await readSnapshot(u.root, edit);
    const c = await coverage(u.root, u.baseSha, edit);
    assert.equal(c.total, 1, "only the changed function");
  } finally { u.cleanup(); }
});

test("a deletion sign-off goes stale when the base it deleted from now holds another body", async () => {
  // The session's decision in the plan (Item D), open to the owner's correction: a rebase
  // onto a trunk that edited the class means a different deletion is being made.
  const u = await repo();
  try {
    // A method, because a class's hash leaves its members' bodies out.
    const post = u.members.find((m) => m.symbolPath.at(-1) === "post")!;
    await sign(u.root, [post.id], u.headSha);
    writeFileSync(join(u.root, "src/ledger.ts"), LEDGER.replace("return x;", "return x * 2;"));
    u.git("commit", "-q", "-am", "the trunk edits the ledger");
    u.git("checkout", "-q", "-b", "feature2");
    u.git("rm", "-q", "src/ledger.ts");
    u.git("commit", "-q", "-m", "delete it again, from the new base");
    const head2 = u.git("rev-parse", "HEAD");
    u.git("checkout", "-q", "main");
    const at = async (ref: string) => (await reviewStatesFor(u.root, [{ kind: "anchor", id: post.id }], { ref })).get(`anchor:${post.id}`)!.code.state;
    assert.equal(await at(u.headSha), "reviewed");
    assert.equal(await at(head2), "stale");
  } finally { u.cleanup(); }
});

test("the single-target writer signs a deletion exactly as the batch writer does (the diff page's button)", async () => {
  const u = await repo();
  try {
    const single = await markReviewed(u.root, { targetKind: "anchor", targetId: u.cls.id, level: "code", actor: "human", attestation: "signed", ref: u.headSha });
    assert.equal((single as { error?: string }).error, undefined, "signable through /api/review");
    const row = (await readReviews(u.root)).reviews.find((r) => r.target.id === u.cls.id)!;
    assert.deepEqual(row.witnesses, [{ anchorId: u.cls.id, bodyHash: u.cls.bodyHash, deleted: true }]);
    assert.equal(row.accepted?.[0]?.entries.at(-1)?.deleted, true);
    const st = (await reviewStatesFor(u.root, [{ kind: "anchor", id: u.cls.id }], { ref: u.headSha })).get(`anchor:${u.cls.id}`)!;
    assert.equal(st.code.state, "reviewed");
  } finally { u.cleanup(); }
});
