/**
 * Minimal git access via the `git` CLI (no dependency). Everything here is
 * best-effort: when git is absent or a command fails, callers fall back to a
 * full re-scan.
 */

import { spawnSync } from "node:child_process";

function git(root: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return { ok: r.status === 0, out: r.stdout ?? "" };
}

export function isGitRepo(root: string): boolean {
  return git(root, ["rev-parse", "--is-inside-work-tree"]).out.trim() === "true";
}

export function headCommit(root: string): string | null {
  const r = git(root, ["rev-parse", "HEAD"]);
  return r.ok ? r.out.trim() : null;
}

/** Resolve a ref (branch/tag/sha/HEAD~1/…) to a full commit sha, or null. */
export function revParse(root: string, ref: string): string | null {
  const r = git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return r.ok && r.out.trim() ? r.out.trim() : null;
}

/** Current branch name, or null when detached / no git. */
export function currentBranch(root: string): string | null {
  const r = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const b = r.ok ? r.out.trim() : "";
  return b && b !== "HEAD" ? b : null;
}

/** True if the working tree has uncommitted changes (tracked or untracked). */
export function isDirty(root: string): boolean {
  if (!isGitRepo(root)) return false;
  return git(root, ["status", "--porcelain"]).out.trim().length > 0;
}

/**
 * The contents of a repo-relative file at a commit (`git show <sha>:<path>`),
 * or null when it doesn't exist there. Read-only — never touches the working
 * tree, so it's safe for showing a base branch's code without a checkout.
 */
export function showFile(root: string, sha: string, path: string): string | null {
  const r = git(root, ["show", `${sha}:${path}`]);
  return r.ok ? r.out : null;
}

/**
 * Repo-relative paths that differ from `commit` (committed, staged, unstaged)
 * plus untracked files. Returns null when it can't be determined — the caller
 * should then treat every file as changed (full scan).
 */
export function changedFilesSince(root: string, commit: string | null): string[] | null {
  if (!commit || !isGitRepo(root)) return null;
  const diff = git(root, ["diff", "--name-only", commit, "--"]);
  if (!diff.ok) return null;
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]).out;
  const files = new Set<string>();
  for (const block of [diff.out, untracked]) {
    for (const line of block.split("\n")) {
      const t = line.trim();
      if (t) files.add(t);
    }
  }
  return [...files];
}
