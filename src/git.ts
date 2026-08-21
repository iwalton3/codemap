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
  // `git show <sha>:<path>` is relative to the REPO root, but every caller passes a
  // path relative to the codemap root. For a universe rooted in a subdirectory those
  // differ, and without the prefix this read the wrong blob — including the
  // repo-root `.codemapignore`, which then filtered sub-relative paths and made the
  // commit index disagree with the walk.
  const r = spawnSync("git", ["show", `${sha}:${repoPrefix(root)}${path}`], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
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

/**
 * The repo-relative path of `root` itself ("" at the toplevel, else "sub/dir/").
 * Memoised: it is a `git` process, and the blob readers call it per batch.
 */
const prefixCache = new Map<string, string>();
export function repoPrefix(root: string): string {
  let p = prefixCache.get(root);
  if (p === undefined) { p = git(root, ["rev-parse", "--show-prefix"]).out.trim(); prefixCache.set(root, p); }
  return p;
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
  /** Blob size in bytes. `ls-tree -l` prints `-` for a gitlink, which reads as 0 —
   * a submodule's target sha is in `oid`, which is what `indexCommit` recurses on. */
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
  const r = spawnSync("git", ["-c", "core.quotePath=false", "ls-tree", "-r", "-l", "--full-name", sha], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
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
 *
 * THROWS if a batch fails. A dropped chunk is indistinguishable from "those files
 * had no symbols", so swallowing it let `indexCommit` persist a snapshot missing
 * up to 500 files — which the next diff reads as a mass symbol deletion. Loud is
 * correct here: `indexCommit` turns it back into its documented `null`, and every
 * other caller sits under a front-end that renders the message.
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
    if (r.status !== 0 || !r.stdout) {
      const why = r.error?.message ?? (r.stderr ? Buffer.from(r.stderr).toString("utf8").trim() : "");
      throw new Error(`git cat-file failed reading ${batch.length} path(s) at ${sha.slice(0, 12)}${why ? `: ${why}` : ""}`);
    }
    const buf: Buffer = r.stdout;
    let off = 0;
    for (const p of batch) {
      const nl = buf.indexOf(10, off);
      if (nl < 0) break;
      // Header is "<request> SP <type> SP <size>" for a hit and "<request> SP missing"
      // for a miss — and <request> is `<sha>:<path>`, which can contain spaces. Parse
      // from the RIGHT: splitting from the left made `size` NaN on a spaced path,
      // which reset the read offset to 0 and handed the NEXT file the WRONG blob.
      // Reachable in normal use: `changedFilesBetween` lists files deleted at head,
      // which are exactly the misses.
      const header = buf.subarray(off, nl).toString("utf8");
      const parts = header.split(" ");
      const size = Number(parts[parts.length - 1]);
      const type = parts[parts.length - 2];
      if (header.endsWith(" missing") || parts.length < 3 || type !== "blob" || !Number.isFinite(size)) {
        off = nl + 1;
        continue;
      }
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
  const r = spawnSync("git", ["-c", "core.quotePath=false", "diff", "--numstat", "-M", from, to], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
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

/**
 * Head-side line ranges that appear in a diff, per file — the lines GitHub will
 * accept a review comment on. A finding anchored to a symbol often sits on a line
 * the PR never touched, and posting there is rejected outright, so the caller
 * needs to know before it tries.
 */
export interface FileHunks {
  /** New-side line ranges GitHub will accept a comment on — hunk bodies, context included. */
  ranges: [number, number][];
  /**
   * New-side lines the change actually ADDED.
   *
   * Distinct from `ranges` because a hunk carries three lines of context either
   * side, and a review comment placed on a context line is placed on code this
   * change did not touch — which is how a finding about `AircraftRegistration`
   * landed on an unchanged `ActualQuantity` eleven lines above it.
   */
  added: Set<number>;
}

/** Hunk geometry per file: what is commentable, and what was actually added. */
export function diffHunks(root: string, from: string, to: string): Map<string, FileHunks> {
  const r = spawnSync("git", ["-c", "core.quotePath=false", "diff", "--unified=3", "--no-color", from, to], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const out = new Map<string, FileHunks>();
  if (r.status !== 0) return out;
  let file = "";
  // New-side line number of the next body line, so `+` lines can be recorded by
  // absolute position rather than inferred from the hunk header afterwards.
  let newLine = 0;
  // A hunk body is consumed by counting the lines its own header promises, because
  // an ADDED source line beginning "++ " renders as "+++ ..." and is otherwise
  // indistinguishable from a file header — one in a fixture or patch file
  // re-attributed every later hunk to a file the commit never touched, which is
  // where pr-push then tried to post a comment.
  let oldLeft = 0, newLeft = 0;
  for (const line of (r.stdout ?? "").split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      // Inside a hunk: context counts against both sides, "\ No newline" against neither.
      if (line.startsWith(" ")) { oldLeft--; newLeft--; newLine++; }
      else if (line.startsWith("-")) oldLeft--;
      else if (line.startsWith("+")) { newLeft--; if (file) out.get(file)?.added.add(newLine); newLine++; }
      else if (line.startsWith("\\")) continue;
      // Anything else means the diff is not shaped as the counts claimed; fall
      // through to structural parsing rather than swallowing the rest of the file.
      else { oldLeft = newLeft = 0; }
      if (oldLeft > 0 || newLeft > 0) continue;
      if (line.startsWith(" ") || line.startsWith("-") || line.startsWith("+")) continue;
    }
    if (line.startsWith("diff --git ")) { file = ""; continue; }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      file = p === "/dev/null" ? "" : p.replace(/^b\//, "");
      continue;
    }
    if (!line.startsWith("@@")) continue;
    // @@ -oldStart,oldLen +newStart,newLen @@
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    oldLeft = m[2] === undefined ? 1 : Number(m[2]);
    newLeft = m[4] === undefined ? 1 : Number(m[4]);
    const start = Number(m[3]);
    const len = newLeft;
    if (!file || !len) continue;
    const e = out.get(file) ?? { ranges: [], added: new Set<number>() };
    e.ranges.push([start, start + len - 1]);
    out.set(file, e);
    newLine = start;
  }
  return out;
}

/** Just the commentable ranges — the shape most callers want. */
export function diffLineRanges(root: string, from: string, to: string): Map<string, [number, number][]> {
  return new Map([...diffHunks(root, from, to)].map(([f, h]) => [f, h.ranges]));
}

/** True when `maybeAncestor` is an ancestor of `ref` (or the same commit). */
export function isAncestor(root: string, maybeAncestor: string, ref: string): boolean {
  return spawnSync("git", ["merge-base", "--is-ancestor", maybeAncestor, ref], { cwd: root }).status === 0;
}

/** Repo-relative paths changed between two commits (rename-aware, head-side names). */
export function changedFilesBetween(root: string, from: string, to: string): string[] {
  const r = spawnSync("git", ["-c", "core.quotePath=false", "diff", "--name-only", "-M", from, to], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return [];
  const prefix = repoPrefix(root);
  return (r.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean)
    .filter((p) => !prefix || p.startsWith(prefix))
    .map((p) => (prefix ? p.slice(prefix.length) : p));
}

/**
 * Fetch every pull-request head in one go. One fetch instead
 * of one per PR: a back-catalogue import otherwise pays a network round trip
 * hundreds of times over for objects it mostly already has.
 */
export function fetchAllPrHeads(root: string, remote = "origin"): { ok: boolean; err: string } {
  const r = spawnSync("git", ["fetch", "--no-tags", "--quiet", remote, `+refs/pull/*/head:refs/remotes/${remote}/pr/*`], {
    cwd: root, encoding: "utf8", timeout: 900_000,
  });
  return { ok: r.status === 0, err: (r.stderr ?? "").trim() };
}

/**
 * The commit a pull request actually forked from.
 *
 * `recordedBase` is GitHub's base sha for the PR and must be preferred over the
 * base branch's current tip. Once a PR is merged its head is an ancestor of that
 * tip, so `merge-base(tip, head)` is the head itself and the PR appears to change
 * nothing — which silently empties every merged PR in a back catalogue. The
 * recorded sha reproduces GitHub's own changed-file count for open, closed and
 * merged alike.
 */
export function prBaseCommit(root: string, opts: { recordedBase?: string | null; baseRef: string; headSha: string }): string | null {
  const fromRecorded = opts.recordedBase && hasObject(root, opts.recordedBase)
    ? mergeBase(root, opts.recordedBase, opts.headSha) : null;
  if (fromRecorded && fromRecorded !== opts.headSha) return fromRecorded;
  const tip = revParse(root, `origin/${opts.baseRef}`);
  const fromTip = tip ? mergeBase(root, tip, opts.headSha) : null;
  // A tip-derived base equal to the head is the merged-PR collapse, not a real answer.
  if (fromTip && fromTip !== opts.headSha) return fromTip;
  // Not `?? fromRecorded`: the only way it is non-null here is by equalling the
  // head, which is the same collapse just rejected. Returning it made the caller
  // snapshot head-vs-head and report the PR as changing nothing — the failure this
  // function exists to prevent. No answer is better than that one.
  return null;
}

/**
 * A submodule whose checked-out commit is not the one the parent pins.
 *
 * `ahead`/`behind` are indistinguishable from the parent's point of view — the
 * only fact `git submodule status` reports is "not the pinned commit" — so both
 * are `drifted`. That is the state that matters: a worktree scan indexes what is
 * on disk, so a drifted submodule puts anchors into `@work` (and into the
 * snapshot written for HEAD) that this commit does not ship.
 */
export type SubmoduleState = "drifted" | "uninitialized" | "conflict";

export interface SubmoduleDrift {
  path: string;
  sha: string;
  state: SubmoduleState;
}

/**
 * Parse `git submodule status`. Kept separate from the spawn so the format —
 * which is positional and easy to get subtly wrong — is testable without a repo.
 *
 * Each line is `<flag><sha> <path> (<describe>)`, where the flag is a space when
 * the checkout matches the pin, `+` when it does not, `-` when the submodule was
 * never initialized, and `U` when it has unmerged conflicts. Only the non-space
 * flags are returned; an in-sync submodule is not news.
 */
export function parseSubmoduleStatus(out: string): SubmoduleDrift[] {
  const drift: SubmoduleDrift[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const flag = line[0]!;
    const state: SubmoduleState | null =
      flag === "+" ? "drifted" : flag === "-" ? "uninitialized" : flag === "U" ? "conflict" : null;
    if (!state) continue;
    // `slice(1)` drops the flag; the describe suffix is advisory and dropped with it.
    const rest = line.slice(1).trim();
    const sp = rest.indexOf(" ");
    if (sp < 0) continue;
    drift.push({ sha: rest.slice(0, sp), path: rest.slice(sp + 1).replace(/\s+\(.*\)\s*$/, ""), state });
  }
  return drift;
}

/**
 * Submodules that would make a worktree scan disagree with the commit it is
 * about to be recorded against. Empty when there are no submodules, when git is
 * absent, or when everything is in sync — this is a warning path, never a hard
 * failure, so a repo without git still indexes.
 */
export function submoduleDrift(root: string): SubmoduleDrift[] {
  const r = spawnSync("git", ["submodule", "status"], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) return [];
  return parseSubmoduleStatus(r.stdout ?? "");
}
