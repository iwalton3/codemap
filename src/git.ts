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
 * The raw bytes of a repo-relative file at a commit (`git show <sha>:<path>`),
 * or null when it doesn't exist there. Read-only — never touches the working
 * tree, so it's safe for showing a base branch's code without a checkout.
 * Returns raw bytes; decode to UTF-8 and slice the *string* by `loc`, which
 * holds UTF-16 code-unit indices despite the `startByte` name (see indexBlob).
 */
export function showFile(root: string, sha: string, path: string): Buffer | null {
  const r = spawnSync("git", ["show", `${sha}:${path}`], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
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

/** The repo-relative path of `root` itself ("" at the toplevel, else "sub/dir/"). */
export function repoPrefix(root: string): string {
  return git(root, ["rev-parse", "--show-prefix"]).out.trim();
}

/** The merge-base of two refs — a PR's true base, which is rarely the base branch tip. */
export function mergeBase(root: string, a: string, b: string): string | null {
  const r = git(root, ["merge-base", a, b]);
  return r.ok && r.out.trim() ? r.out.trim() : null;
}

export interface TreeEntry {
  path: string;
  /** "blob" for a file, "commit" for a submodule gitlink. */
  type: "blob" | "commit";
  /** Blob size in bytes; the gitlink's target sha for a submodule. */
  size: number;
  oid: string;
}

/**
 * Every entry in a commit's tree, as paths relative to `root`. Submodule
 * gitlinks are returned (as `type: "commit"`) rather than dropped: a bumped
 * submodule pointer is one line in a raw diff and can carry an arbitrary amount
 * of real code behind it.
 */
export function lsTreeEntries(root: string, sha: string): TreeEntry[] | null {
  const r = spawnSync("git", ["ls-tree", "-r", "-l", "--full-name", sha], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) return null;
  const prefix = repoPrefix(root);
  const out: TreeEntry[] = [];
  for (const line of (r.stdout ?? "").split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const meta = line.slice(0, tab).split(/\s+/); // <mode> <type> <oid> <size>  (size is "-" for a gitlink)
    const type = meta[1];
    if (type !== "blob" && type !== "commit") continue;
    const full = line.slice(tab + 1);
    if (prefix && !full.startsWith(prefix)) continue;
    out.push({ path: prefix ? full.slice(prefix.length) : full, type, size: Number(meta[3]) || 0, oid: meta[2]! });
  }
  return out;
}

/**
 * Read many blobs from one commit in a single `git cat-file --batch` pass —
 * one process for the whole tree instead of one `git show` per file (~55ms vs
 * minutes on a 1200-file repo). Paths absent from the commit are omitted.
 */
export function readBlobs(root: string, sha: string, paths: string[]): Map<string, string> {
  const prefix = repoPrefix(root);
  const found = new Map<string, string>();
  const CHUNK = 500; // bound peak memory on big trees
  for (let i = 0; i < paths.length; i += CHUNK) {
    const batch = paths.slice(i, i + CHUNK);
    const r = spawnSync("git", ["cat-file", "--batch"], {
      cwd: root,
      input: batch.map((p) => `${sha}:${prefix}${p}`).join("\n") + "\n",
      maxBuffer: 512 * 1024 * 1024,
    });
    if (r.status !== 0 || !r.stdout) continue;
    const buf: Buffer = r.stdout;
    let off = 0;
    for (const p of batch) {
      const nl = buf.indexOf(10, off);
      if (nl < 0) break;
      const header = buf.subarray(off, nl).toString("utf8").split(" ");
      // "<oid> missing" / "<oid> <type> <size>" — a missing object has no payload.
      if (header[1] === "missing" || header.length < 3) { off = nl + 1; continue; }
      const size = Number(header[2]);
      const start = nl + 1;
      found.set(p, buf.subarray(start, start + size).toString("utf8"));
      off = start + size + 1; // payload is followed by a newline
    }
  }
  return found;
}

/** True when the object is already present locally (so a fetch can be skipped). */
export function hasObject(root: string, sha: string): boolean {
  return spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: root }).status === 0;
}

/**
 * Fetch a refspec from a remote. This is the one network- and .git-writing call
 * in codemap; it never touches the working tree, switches a branch, or moves
 * HEAD, so it is safe against a repo someone else is working in.
 */
export function fetchRef(root: string, remote: string, refspec: string): { ok: boolean; err: string } {
  const r = spawnSync("git", ["fetch", "--no-tags", "--quiet", remote, refspec], { cwd: root, encoding: "utf8", timeout: 180_000 });
  return { ok: r.status === 0, err: (r.stderr ?? "").trim() };
}

/** Per-file added/deleted line counts between two commits (three-dot semantics are the caller's job). */
export function numstat(root: string, from: string, to: string): { path: string; adds: number; dels: number }[] | null {
  const r = spawnSync("git", ["diff", "--numstat", "-M", from, to], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  const out: { path: string; adds: number; dels: number }[] = [];
  for (const line of (r.stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    const [a, d, ...rest] = line.split("\t");
    let path = rest.join("\t");
    // rename entries look like `old/{a => b}/new` or `old\tnew` under -M
    const arrow = path.indexOf(" => ");
    if (arrow >= 0) path = path.replace(/\{([^}]*) => ([^}]*)\}/, "$2").replace(/^.* => /, "");
    out.push({ path, adds: a === "-" ? 0 : Number(a) || 0, dels: d === "-" ? 0 : Number(d) || 0 });
  }
  return out;
}

/** `owner/repo` from the origin remote (https or ssh form), or null. */
export function originSlug(root: string): { owner: string; repo: string } | null {
  const url = git(root, ["remote", "get-url", "origin"]).out.trim();
  const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}
