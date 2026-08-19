import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexRepo, indexCommit } from "./repo.js";
import { headCommit } from "./git.js";

const git = (root: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "protocol.file.allow=always", ...args], { cwd: root, encoding: "utf8" });

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "codemap-commit-"));
  git(root, "init", "-q", "-b", "main");
  return root;
}
const commit = (root: string, msg = "c") => { git(root, "add", "-A"); git(root, "commit", "-qm", msg); };
/** id+hash pairs — the identity that matters, since ids are what diffs are computed over. */
const fingerprint = (as: { id: string; bodyHash: string }[]) => as.map((a) => `${a.id}|${a.bodyHash}`).sort().join("\n");

test("indexCommit at HEAD matches indexRepo on a clean tree", async () => {
  const root = repo();
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/pay.ts"), "export function transfer(a: number) { return a * 2; }\nexport const cfg = { retry: 3 };\n");
    writeFileSync(join(root, "src/util.py"), "def helper(x):\n    return x + 1\n");
    commit(root);

    const walk = await indexRepo(root);
    const blob = await indexCommit(root, headCommit(root)!);
    assert.ok(walk.length > 0, "fixture should produce anchors");
    assert.equal(fingerprint(blob!), fingerprint(walk), "blob-index must equal walk-index");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("indexCommit ignores working-tree edits — it reads the commit, not the disk", async () => {
  const root = repo();
  try {
    writeFileSync(join(root, "a.ts"), "export function f() { return 1; }\n");
    commit(root);
    const before = await indexCommit(root, headCommit(root)!);

    writeFileSync(join(root, "a.ts"), "export function f() { return 999; }\n");
    writeFileSync(join(root, "b.ts"), "export function g() { return 2; }\n"); // uncommitted new file
    assert.equal(fingerprint((await indexCommit(root, headCommit(root)!))!), fingerprint(before!), "uncommitted edits must not leak in");
    assert.notEqual(fingerprint(await indexRepo(root)), fingerprint(before!), "the walk should see them");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an untracked .codemapignore still applies (both live universes keep it in info/exclude)", async () => {
  const root = repo();
  try {
    mkdirSync(join(root, "tests"));
    writeFileSync(join(root, "keep.ts"), "export function keep() { return 1; }\n");
    writeFileSync(join(root, "tests/skip.ts"), "export function skip() { return 2; }\n");
    commit(root);
    // written after the commit and never added — the fallback path
    writeFileSync(join(root, ".codemapignore"), "tests/\n");

    const files = new Set((await indexCommit(root, headCommit(root)!))!.map((a) => a.file));
    assert.ok(files.has("keep.ts"), "unignored file indexed");
    assert.ok(!files.has("tests/skip.ts"), "untracked .codemapignore must still exclude");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a committed .codemapignore is read as of that commit, not from disk", async () => {
  const root = repo();
  try {
    mkdirSync(join(root, "gen"));
    writeFileSync(join(root, "keep.ts"), "export function keep() { return 1; }\n");
    writeFileSync(join(root, "gen/out.ts"), "export function gen() { return 2; }\n");
    writeFileSync(join(root, ".codemapignore"), "gen/\n");
    commit(root, "excludes gen");
    const excluded = headCommit(root)!;

    writeFileSync(join(root, ".codemapignore"), "\n"); // a later commit stops excluding it
    commit(root, "includes gen");
    const included = headCommit(root)!;

    const at = async (sha: string) => new Set((await indexCommit(root, sha))!.map((a) => a.file));
    assert.ok(!(await at(excluded)).has("gen/out.ts"), "old commit judged by its own rules");
    assert.ok((await at(included)).has("gen/out.ts"), "new commit judged by its own rules");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("submodule contents are indexed under the parent's path", async (t) => {
  const root = repo(), sub = repo();
  try {
    writeFileSync(join(sub, "money.ts"), "export function settle(cents: number) { return cents; }\n");
    commit(sub, "sub");

    writeFileSync(join(root, "app.ts"), "export function main() { return 1; }\n");
    commit(root, "app");
    const added = git(root, "submodule", "add", "-q", sub, "lib");
    // A bare `return` here made this pass VACUOUSLY, and it is the only coverage of
    // the gitlink recursion — so a build that refuses file:// submodules reported
    // green for a path it never ran. Skip loudly instead.
    if (added.status !== 0) { t.skip(`git refused a file:// submodule: ${added.stderr.trim().slice(0, 120)}`); return; }
    commit(root, "add sub");

    const anchors = (await indexCommit(root, headCommit(root)!))!;
    const files = new Set(anchors.map((a) => a.file));
    assert.ok(files.has("lib/money.ts"), `submodule file should be indexed under its parent path, got ${[...files]}`);
    // ids hash the path, so the parent-prefixed path is what makes them line up with the walk
    assert.equal(fingerprint(anchors), fingerprint(await indexRepo(root)), "submodule anchors must match the walk");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(sub, { recursive: true, force: true }); }
});

test("indexCommit matches indexRepo for non-ASCII names and a nested universe", async () => {
  // The parity tests only used ASCII basenames at the repo ROOT, so they could not
  // see the two ways the two indexers diverge: `ls-tree` C-quotes a non-ASCII path,
  // and a universe rooted in a subdirectory has to reconcile `repoPrefix` with the
  // root-relative paths `showFile` returns. Ids hash the path, so a divergence
  // means every anchor in those files reads as removed-and-added in the next diff.
  const root = repo();
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/café.ts"), "export function facturé(n: number) { return n; }\n");
    writeFileSync(join(root, "src/naïve-π.py"), "def calcul(x):\n    return x\n");
    commit(root);
    assert.equal(fingerprint(await indexCommit(root, headCommit(root)!) ?? []), fingerprint(await indexRepo(root)),
      "a non-ASCII filename must index identically from the tree and from disk");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a universe rooted in a subdirectory indexes the same either way", async () => {
  const outer = repo();
  try {
    mkdirSync(join(outer, "services/api/src"), { recursive: true });
    writeFileSync(join(outer, "services/api/src/pay.ts"), "export function transfer(a: number) { return a; }\n");
    writeFileSync(join(outer, "top.ts"), "export function ignored() { return 0; }\n");
    commit(outer);

    // the universe is the subdirectory, not the repo root
    const root = join(outer, "services/api");
    const fromTree = (await indexCommit(root, headCommit(root)!)) ?? [];
    assert.equal(fingerprint(fromTree), fingerprint(await indexRepo(root)));
    assert.deepEqual([...new Set(fromTree.map((a) => a.file))], ["src/pay.ts"],
      "paths are relative to the universe, and the repo's other files are not its business");
  } finally { rmSync(outer, { recursive: true, force: true }); }
});
