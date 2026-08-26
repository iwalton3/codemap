import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexRepo, indexCommit } from "./repo.js";
import { headCommit, showFile } from "./git.js";
import { discard } from "./test-tmp.js";

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
  } finally { discard(root); }
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
  } finally { discard(root); }
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
  } finally { discard(root); }
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
  } finally { discard(root); }
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
  } finally { discard(root); discard(sub); }
});

test("a submodule's source is readable from the parent, at the commit the parent pins", async (t) => {
  // Indexing recursed through gitlinks; retrieval did not. So the anchors existed and
  // their code did not — a blank drill-down and an empty PR diff for shared code.
  const root = repo(), sub = repo();
  try {
    writeFileSync(join(sub, "money.ts"), "export function settle(cents: number) { return cents; }\n");
    commit(sub, "sub v1");
    writeFileSync(join(root, "app.ts"), "export function main() { return 1; }\n");
    commit(root, "app");
    const added = git(root, "submodule", "add", "-q", sub, "lib");
    if (added.status !== 0) { t.skip(`git refused a file:// submodule: ${added.stderr.trim().slice(0, 120)}`); return; }
    commit(root, "add sub");
    const pinned = headCommit(root)!;

    const got = showFile(root, pinned, "lib/money.ts");
    assert.ok(got, "a file inside a gitlink must be reachable from the parent");
    assert.match(got!.toString("utf8"), /export function settle/);

    // Control: the ordinary path is untouched, and a miss is still a miss.
    assert.match(showFile(root, pinned, "app.ts")!.toString("utf8"), /export function main/);
    assert.equal(showFile(root, pinned, "lib/nope.ts"), null, "a nonexistent file inside a submodule is still null");
    assert.equal(showFile(root, pinned, "nope/nope.ts"), null, "and so is a nonexistent path with no gitlink at all");

    // The PIN is what is served, not whatever the submodule happens to be on now.
    // Committed inside the submodule CHECKOUT rather than in `sub` + a fetch: it puts
    // v2 in the same object store with no network-shaped step in a hermetic suite,
    // and moves the submodule's HEAD off the pin, which is the situation being tested.
    writeFileSync(join(root, "lib", "money.ts"), "export function settle(cents: number) { return cents * 2; }\n");
    commit(join(root, "lib"), "sub v2");
    const still = showFile(root, pinned, "lib/money.ts")!.toString("utf8");
    assert.match(still, /return cents;/, "the parent's commit pins v1, so v1 is what it serves");
    assert.doesNotMatch(still, /cents \* 2/);
  } finally { discard(root); discard(sub); }
});

test("a submodule that cannot be read makes the whole commit index null, not a short one", async (t) => {
  // The dangerous outcome is not the failure, it is the SUCCESS: a snapshot missing
  // every symbol behind the gitlink still looks complete, gets cached under the
  // commit, and the next diff reads all of them as deleted. Same rule the blob read
  // already follows — no snapshot at all beats a truncated one.
  const root = repo(), sub = repo();
  try {
    writeFileSync(join(sub, "money.ts"), "export function settle(cents: number) { return cents; }\n");
    commit(sub, "sub");
    writeFileSync(join(root, "app.ts"), "export function main() { return 1; }\n");
    commit(root, "app");
    const added = git(root, "submodule", "add", "-q", sub, "lib");
    if (added.status !== 0) { t.skip(`git refused a file:// submodule: ${added.stderr.trim().slice(0, 120)}`); return; }
    commit(root, "add sub");
    const sha = headCommit(root)!;
    assert.ok((await indexCommit(root, sha))!.some((a) => a.file === "lib/money.ts"), "readable to begin with");

    // Now make it unreadable, the way an uninitialized or unfetched submodule is.
    rmSync(join(root, "lib"), { recursive: true, force: true });
    assert.equal(await indexCommit(root, sha), null, "an unreadable submodule must fail the whole index");
  } finally { discard(root); discard(sub); }
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
  } finally { discard(root); }
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
  } finally { discard(outer); }
});
