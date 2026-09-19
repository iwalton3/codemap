/**
 * `at:` on the read tools: an agent in a git worktree reads its own branch through the
 * main checkout's universe, and the main checkout's index does not move.
 *
 * The fixture is the case the feature was asked for. `main` is checked out in the root,
 * with a doc on `transfer`. Branch `feature` is checked out in a LINKED WORKTREE; it adds
 * `IdentifierFilter` and changes `transfer`, and the worktree holds one uncommitted edit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { init, search, context, getAnchor, getNode, staleAt, status } from "./ops.js";
import { rpc } from "./test-mcp.js";
import { readAnchorStore, readState, writeNode } from "./store.js";
import { markReviewedBatch } from "./reviews.js";
import { discard } from "./test-tmp.js";

const PAY_V1 = "export function transfer(cents: number) {\n  return cents;\n}\n";
const PAY_V2 = "export function transfer(cents: number) {\n  return cents * 2;\n}\n";
const FILTER = "export class IdentifierFilter {\n  matches(id: string) {\n    return id.length > 0;\n  }\n}\n";

async function worktreeRepo() {
  const base = mkdtempSync(join(tmpdir(), "codemap-readat-"));
  const root = join(base, "repo");
  const wt = join(base, "wt");
  mkdirSync(join(root, "src"), { recursive: true });
  const git = (cwd: string, ...a: string[]) => {
    const r = spawnSync("git", ["-c", "user.email=t@x.com", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "src/pay.ts"), PAY_V1);
  writeFileSync(join(root, ".gitignore"), ".codemap/\n");
  git(root, "add", "-A"); git(root, "commit", "-q", "-m", "main");

  git(root, "checkout", "-q", "-b", "feature");
  writeFileSync(join(root, "src/pay.ts"), PAY_V2);
  writeFileSync(join(root, "src/filter.ts"), FILTER);
  git(root, "add", "-A"); git(root, "commit", "-q", "-m", "feature");
  const featureSha = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
  git(root, "worktree", "add", "-q", wt, "feature");
  writeFileSync(join(wt, "src/filter.ts"), FILTER.replace("> 0", "> 1"));   // uncommitted

  await init(root);
  const transfer = (await readAnchorStore(root)).anchors.find((a) => a.symbolPath.at(-1) === "transfer")!;
  await writeNode(root, { id: "n_pay", type: "module", title: "Pay", summary: "", anchors: [transfer.id], body: "pays" });
  return { root, wt, featureSha, transfer, cleanup: () => discard(base) };
}

test("search at a branch sees what only the branch has, and says which commit it read", async () => {
  const u = await worktreeRepo();
  try {
    const plain = await search(u.root, "IdentifierFilter") as any;
    assert.equal(plain.anchors.length, 0, "the root checkout does not have it");
    const at = await search(u.root, "IdentifierFilter", 30, { at: "feature" }) as any;
    assert.ok(at.anchors.length >= 1, "the branch does");
    assert.equal(at.at.sha, u.featureSha);
    assert.deepEqual(at.at.uncommitted, ["src/filter.ts"], "the worktree's uncommitted file is named, not silently missing");
  } finally { u.cleanup(); }
});

test("an at-read leaves the root's index exactly as it was", async () => {
  const u = await worktreeRepo();
  try {
    const before = { state: await readState(u.root), count: (await readAnchorStore(u.root)).anchors.length, status: await status(u.root) };
    await search(u.root, "transfer", 30, { at: "feature" });
    await context(u.root, ["src/filter.ts"], { at: "feature" });
    await staleAt(u.root, "feature");
    assert.deepEqual(await readState(u.root), before.state);
    assert.equal((await readAnchorStore(u.root)).anchors.length, before.count);
    assert.equal((await status(u.root)).anchors, before.status.anchors);
  } finally { u.cleanup(); }
});

test("get_anchor at a branch returns the branch's source and names the commit", async () => {
  const u = await worktreeRepo();
  try {
    const r = await getAnchor(u.root, u.transfer.id, { at: "feature" }) as any;
    assert.match(r.code, /cents \* 2/);
    assert.equal(r.sourceCommit, u.featureSha);
    assert.equal(r.sourceRef, "feature");
    const here = await getAnchor(u.root, u.transfer.id) as any;
    assert.doesNotMatch(here.code, /cents \* 2/, "and without `at` it is still the working tree's");
  } finally { u.cleanup(); }
});

test("context at a branch scopes to the branch's files", async () => {
  const u = await worktreeRepo();
  try {
    const plain = await context(u.root, ["src/filter.ts"]) as any;
    assert.ok(plain.errors?.length, "the root has no such file");
    const at = await context(u.root, ["src/filter.ts"], { at: "feature" }) as any;
    assert.ok(at.scopeAnchors > 0);
    assert.equal(at.at.sha, u.featureSha);
  } finally { u.cleanup(); }
});

test("get_node at a branch judges the doc against the branch's code", async () => {
  const u = await worktreeRepo();
  try {
    assert.equal((await getNode(u.root, "n_pay") as any).status, "fresh");
    const at = await getNode(u.root, "n_pay", { at: "feature" }) as any;
    assert.equal(at.status, "stale", "the branch changed the code the doc cites");
  } finally { u.cleanup(); }
});

test("check_stale at a branch reports what it touched, the docs it staled, and its review state", async () => {
  const u = await worktreeRepo();
  try {
    await markReviewedBatch(u.root, [u.transfer.id], { level: "code", actor: "agent", ref: "feature" });
    const r = await staleAt(u.root, "feature") as any;
    assert.equal(r.at.sha, u.featureSha);
    assert.deepEqual(r.touched.changed.map((b: any) => b.id), [u.transfer.id]);
    assert.ok(r.touched.added.some((b: any) => b.symbol.startsWith("IdentifierFilter")));
    assert.deepEqual(r.staleDocs.map((d: any) => d.id), ["n_pay"]);
    assert.deepEqual(r.gate, { staleDocs: 1, pass: false });
    assert.deepEqual(r.reviews.reviewed, [u.transfer.id], "marked at the branch, and it still holds there");
    assert.ok(r.reviews.unreviewed.length >= 1, "the added class was never reviewed");
  } finally { u.cleanup(); }
});

test("an unknown ref is an error, not an answer about the working tree", async () => {
  const u = await worktreeRepo();
  try {
    const r = await search(u.root, "transfer", 30, { at: "no-such-branch" }) as any;
    assert.match(r.error, /cannot resolve/);
  } finally { u.cleanup(); }
});

test("a sha has no worktree, so nothing is reported as uncommitted", async () => {
  const u = await worktreeRepo();
  try {
    const r = await search(u.root, "transfer", 30, { at: u.featureSha }) as any;
    assert.equal(r.at.uncommitted, undefined);
  } finally { u.cleanup(); }
});

test("through MCP: check_stale at a branch answers read-only, and a derived view refuses `at`", async () => {
  const u = await worktreeRepo();
  try {
    const [stale, matrix, plainMatrix] = await rpc(u.root, [
      { name: "check_stale", arguments: { at: "feature" } },
      { name: "event_matrix", arguments: { at: "feature" } },
      { name: "event_matrix", arguments: {} },
    ]);
    const s = JSON.parse(stale!);
    assert.equal(s.at.sha, u.featureSha);
    assert.equal(s.gate.pass, false);
    assert.equal(s.rebaselined, undefined, "the at-mode is not the rebaselining pass");
    assert.match(matrix!, /cannot answer at a commit/, "a view generated from the working tree says so");
    assert.doesNotMatch(plainMatrix!, /cannot answer at a commit/);
  } finally { u.cleanup(); }
});

test("dirty: true reads the worktree's uncommitted body, and review state stays the commit's", async () => {
  const u = await worktreeRepo();
  try {
    const found = await search(u.root, "matches", 30, { at: "feature" }) as any;
    const id = found.anchors.find((a: any) => a.symbol.endsWith("matches")).id;
    await markReviewedBatch(u.root, [id], { level: "code", actor: "agent", ref: "feature" });

    const committed = await getAnchor(u.root, id, { at: "feature" }) as any;
    assert.match(committed.code, /> 0/);
    assert.match(committed.at.uncommittedNote, /dirty: true/, "it says how to include them");

    const dirty = await getAnchor(u.root, id, { at: "feature", dirty: true }) as any;
    assert.match(dirty.code, /> 1/, "the worktree's edit");
    assert.equal(dirty.at.overlaid, true);
    assert.equal(dirty.review.code.state, "reviewed", "review does not cover uncommitted changes, so the commit's mark stands");
  } finally { u.cleanup(); }
});

test("through MCP: check_stale refuses `dirty` — its gate is judged at a commit", async () => {
  const u = await worktreeRepo();
  try {
    const [r] = await rpc(u.root, [{ name: "check_stale", arguments: { at: "feature", dirty: true } }]);
    assert.match(r!, /judged at a commit/);
  } finally { u.cleanup(); }
});

test("a mark made at a branch NAME records the commit, not the moving name", async () => {
  const u = await worktreeRepo();
  try {
    await markReviewedBatch(u.root, [u.transfer.id], { level: "code", actor: "agent", ref: "feature" });
    const { readReviews } = await import("./store.js");
    const row = (await readReviews(u.root)).reviews.find((r) => r.target.id === u.transfer.id)!;
    assert.equal(row.reviewedCommit, u.featureSha);
    assert.equal(row.accepted?.[0]?.entries.at(-1)?.commit, u.featureSha);
  } finally { u.cleanup(); }
});

test("check_stale at a branch with an explicit base diffs against where the branch left it, not its tip", async () => {
  // Triage run 2026-09-19-branch-review-round, J16. `develop` moves on after `feature`
  // forks; diffing against develop's TIP reported develop's own changes as the branch's.
  const base = mkdtempSync(join(tmpdir(), "codemap-readat-base-"));
  const root = join(base, "repo");
  const git = (...a: string[]) => {
    const r = spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=izzie", ...a], { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".codemap"), { recursive: true });
    git("init", "-q", "-b", "develop");
    writeFileSync(join(root, ".gitignore"), ".codemap/\n");
    writeFileSync(join(root, "src/a.ts"), "export function a() {\n  return 1;\n}\n");
    writeFileSync(join(root, "src/b.ts"), "export function b() {\n  return 1;\n}\n");
    git("add", "-A"); git("commit", "-q", "-m", "fork point");
    git("checkout", "-q", "-b", "feature");
    writeFileSync(join(root, "src/a.ts"), "export function a() {\n  return 2;\n}\n");
    git("commit", "-q", "-am", "feature changes a");
    git("checkout", "-q", "develop");
    writeFileSync(join(root, "src/b.ts"), "export function b() {\n  return 3;\n}\n");
    git("commit", "-q", "-am", "develop changes b");
    await init(root);
    const r = await staleAt(root, "feature", "develop") as any;
    assert.equal(r.error, undefined, String(r.error));
    const touched = [...r.touched.added, ...r.touched.changed, ...r.touched.removed].map((x: any) => x.symbol);
    assert.deepEqual(touched.sort(), ["a"], `only the branch's own change: ${JSON.stringify(r.touched)}`);
    assert.equal(r.base.sha, git("merge-base", "feature", "develop"));
  } finally { discard(base); }
});
