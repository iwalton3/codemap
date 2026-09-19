/**
 * `at:` reads that look into a branch's worktree: the paths `git status` reports are
 * repo-root-relative and a rename carries two of them, while anchors are universe-relative.
 * Triage run 2026-09-19-branch-review-round, P-1 and J1.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { init } from "./ops.js";
import { viewAt } from "./ops/at.js";
import { getAnchor } from "./ops/read.js";
import { discard } from "./test-tmp.js";

const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=izzie", ...a], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/** `main` in the root, `feature` in a linked worktree; the universe is `sub` ("" = repo root). */
async function repo(sub: string) {
  const base = mkdtempSync(join(tmpdir(), "codemap-atpaths-"));
  const top = join(base, "repo");
  const wt = join(base, "wt");
  const u = sub ? join(top, sub) : top;
  mkdirSync(join(u, "src"), { recursive: true });
  mkdirSync(join(top, "other"), { recursive: true });
  mkdirSync(join(u, ".codemap"), { recursive: true });
  git(top, "init", "-q", "-b", "main");
  writeFileSync(join(u, "src/a.ts"), "export function alpha() {\n  return 1;\n}\n");
  writeFileSync(join(top, "other/b.ts"), "export function beta() {\n  return 2;\n}\n");
  writeFileSync(join(top, ".gitignore"), ".codemap/\n");
  git(top, "add", "-A"); git(top, "commit", "-q", "-m", "main");
  git(top, "branch", "feature");
  git(top, "worktree", "add", "-q", wt, "feature");
  await init(u);
  return { base, top, wt, u, wtU: sub ? join(wt, sub) : wt, cleanup: () => discard(base) };
}

test("a subdirectory universe's worktree overlay uses universe-relative paths and ignores the rest of the repo", async () => {
  const r = await repo("services/api");
  try {
    writeFileSync(join(r.wtU, "src/a.ts"), "export function alpha() {\n  return 42;\n}\n");
    writeFileSync(join(r.wt, "other/b.ts"), "export function beta() {\n  return 3;\n}\n");
    const v = await viewAt(r.u, "feature", { dirty: true });
    assert.ok(!("error" in v), JSON.stringify(v));
    assert.deepEqual(v.uncommitted, ["src/a.ts"], "universe-relative, and nothing outside the universe");
    const alphas = v.anchors.filter((a) => a.symbolPath.join(".") === "alpha");
    assert.equal(alphas.length, 1, "the overlay replaces the committed row rather than adding one");
    assert.equal(alphas[0]!.file, "src/a.ts");
    const got = await getAnchor(r.u, alphas[0]!.id, { at: "feature", dirty: true }) as { code?: string };
    assert.match(String(got.code), /return 42/, "read from the worktree's copy of the universe's file");
  } finally { r.cleanup(); }
});

test("a staged rename in the worktree drops the original file's symbols from the overlay", async () => {
  const r = await repo("");
  try {
    git(r.wt, "mv", "src/a.ts", "src/renamed.ts");
    const v = await viewAt(r.u, "feature", { dirty: true });
    assert.ok(!("error" in v), JSON.stringify(v));
    assert.ok(v.uncommitted.includes("src/a.ts"), `the original is reported: ${v.uncommitted}`);
    assert.ok(v.uncommitted.includes("src/renamed.ts"));
    const alphas = v.anchors.filter((a) => a.symbolPath.join(".") === "alpha");
    assert.deepEqual(alphas.map((a) => a.file), ["src/renamed.ts"], "no duplicate from the file that no longer exists");
  } finally { r.cleanup(); }
});

test("changedFilesSince answers in universe-relative paths in a subdirectory universe", async () => {
  const { changedFilesSince, headCommit } = await import("./git.js");
  const r = await repo("services/api");
  try {
    writeFileSync(join(r.u, "src/a.ts"), "export function alpha() {\n  return 7;\n}\n");
    writeFileSync(join(r.u, "src/new.ts"), "export function gamma() {}\n");
    writeFileSync(join(r.top, "other/b.ts"), "export function beta() {\n  return 9;\n}\n");
    assert.deepEqual(changedFilesSince(r.u, headCommit(r.u))?.sort(), ["src/a.ts", "src/new.ts"]);
  } finally { r.cleanup(); }
});
