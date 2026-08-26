import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSupportedFiles, toPosixRel } from "./fs-scan.js";
import { discard } from "./test-tmp.js";

/**
 * The walk must skip a linked WORKTREE and keep a SUBMODULE, and the two look almost
 * identical on disk — both are a directory whose `.git` is a file. Only the gitdir
 * target separates them, which is why the check reads that file rather than testing
 * for `.git`. Written with plain `writeFileSync` rather than real `git worktree add`
 * / `submodule add`: the shapes are stable, and a hermetic fixture keeps this in the
 * unit suite where it belongs.
 */
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-scan-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, "own.ts"), "export const own = 1;\n");

  // A linked worktree: a whole second checkout of this same repo.
  mkdirSync(join(root, ".claude", "worktrees", "wt1"), { recursive: true });
  writeFileSync(join(root, ".claude", "worktrees", "wt1", ".git"),
    `gitdir: ${join(root, ".git", "worktrees", "wt1")}\n`);
  writeFileSync(join(root, ".claude", "worktrees", "wt1", "own.ts"), "export const own = 1;\n");

  // A submodule: different gitdir target, and its code is indexed on purpose.
  mkdirSync(join(root, "vendorlib"), { recursive: true });
  writeFileSync(join(root, "vendorlib", ".git"), "gitdir: ../.git/modules/vendorlib\n");
  writeFileSync(join(root, "vendorlib", "lib.ts"), "export const lib = 2;\n");

  return root;
};

const rels = async (root: string) => (await listSupportedFiles(root)).map((f) => toPosixRel(root, f)).sort();

test("a linked worktree is not walked — it is the same repo a second time", async () => {
  const root = fixture();
  try {
    const found = await rels(root);
    assert.deepEqual(found.filter((f) => f.startsWith(".claude/")), [],
      "a worktree's copy of the tree must not be indexed alongside the original");
    // Could this have failed? Only if the walk reaches that depth at all.
    assert.ok(found.includes("own.ts"), "the root's own source is still indexed");
  } finally { discard(root); }
});

test("a submodule IS walked — its gitdir says modules, not worktrees", async () => {
  // The one-rule-for-everything version — skip any nested `.git`, file or directory —
  // would fail this. Submodule code is indexed deliberately: `init` warns when an
  // uninitialized one had to be skipped, so silently dropping initialized ones would
  // contradict a message the CLI already prints. See COD-1.
  const root = fixture();
  try {
    assert.ok((await rels(root)).includes("vendorlib/lib.ts"),
      "a submodule is a dependency this repo ships, not a duplicate of itself");
  } finally { discard(root); }
});

test("the two are told apart by the gitdir target, not by `.git` existing", async () => {
  // Pins the discriminator itself. If someone later 'simplifies' this to an existsSync
  // check, the submodule test above fails — this one says why in one place.
  const root = fixture();
  try {
    const found = await rels(root);
    assert.deepEqual(found, ["own.ts", "vendorlib/lib.ts"],
      "exactly the root's own code and the submodule's — not the worktree's copy");
  } finally { discard(root); }
});
