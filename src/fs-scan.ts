/**
 * Repo traversal + ignore rules.
 *
 * Directories are skipped by *basename* (not path substring) — so a repo that
 * merely lives under a path like `~/bin/...` is fine; only a child dir actually
 * named `bin` (a .NET build output) is skipped.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { grammarForPath } from "./grammars.js";
import { loadIgnore, type Ignore } from "./ignore.js";

export const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "obj", "bin", "out",
  ".next", ".nuxt", ".svelte-kit", ".venv", "venv", "env",
  "__pycache__", ".pytest_cache", "coverage", ".turbo", ".cache", "vendor",
]);

/** Files that parse but carry no first-party logic worth anchoring. */
export function isSkippedFile(name: string): boolean {
  return (
    /\.min\.(js|mjs|cjs)$/.test(name) || /\.d\.(ts|mts|cts)$/.test(name)
  );
}

export const MAX_BYTES = 1_000_000; // generated bundles / data files

export function toPosixRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

/**
 * A LINKED WORKTREE, which must not be walked into.
 *
 * `.git` is in `SKIP_DIRS`, and that does not help: in a linked worktree `.git` is a
 * FILE, so basename directory-pruning never fires and the entire repo is indexed
 * again, once per worktree. Measured on a clone with one: 1,882 of 3,764 anchors —
 * exactly half the store — came from `.claude/worktrees/`, which the repo had already
 * gitignored. `search` then floods, `document` refuses every `file#Symbol` as
 * ambiguous, and `context` answers "gap" for a symbol that is documented, because the
 * path ref matched a worktree copy. See COD-1.
 *
 * **Submodules are deliberately NOT pruned, and this is why the check reads the file
 * rather than merely testing for `.git`.** A submodule's `.git` is also a file — its
 * gitdir points at `.git/modules/<name>` where a worktree's points at
 * `.git/worktrees/<name>` — and submodule code is indexed ON PURPOSE: `codemap init`
 * warns when an uninitialized one had to be skipped, and `indexCommit` recurses
 * through gitlinks. The one-rule-for-everything version suggested on the ticket
 * ("any nested `.git`, file or directory") would have silently stopped indexing
 * submodules, which is a feature with its own user-facing warning.
 *
 * The two markers NEST, and only the LAST one says what this directory is: a
 * submodule of a worktree is `…/worktrees/<wt>/modules/<sub>`, a worktree of a
 * submodule is `…/modules/<sub>/worktrees/<wt>`. Testing for `worktrees` anywhere
 * read the first marker and so pruned every submodule of any repo scanned from a
 * worktree — silently, because `git submodule status` reports it in sync and the
 * only symptom is nodes citing its anchors going dangling. See COD-15. Matching the
 * last marker also survives a repo that merely lives under a directory named
 * `modules` or `worktrees`, which a "check `modules` first" fix would not.
 *
 * A nested plain clone (`.git` as a directory) is also left alone for the same
 * reason — an old-style submodule has one — and `.codemapignore` covers that case.
 */
async function isLinkedWorktree(dir: string): Promise<boolean> {
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(await readFile(join(dir, ".git"), "utf8"));
    if (!m) return false;
    const last = /.*[\\/](worktrees|modules)[\\/]/.exec(m[1]!.trim()); // greedy: the LAST marker
    return last?.[1] === "worktrees";
  } catch {
    return false; // no `.git`, or it is a directory — neither is a linked worktree
  }
}

/**
 * All supported, non-ignored source files under `root` (absolute paths).
 * Applies built-in SKIP_DIRS/file rules plus the repo's `.codemapignore`.
 */
export async function listSupportedFiles(root: string): Promise<string[]> {
  const ignore = await loadIgnore(root);
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip quietly
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = toPosixRel(root, abs);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || ignore.ignores(rel, true)) continue;
        if (await isLinkedWorktree(abs)) continue;
        await walk(abs);
      } else if (e.isFile()) {
        if (!grammarForPath(e.name) || isSkippedFile(e.name)) continue;
        if (ignore.ignores(rel, false)) continue;
        try {
          if ((await stat(abs)).size > MAX_BYTES) continue;
        } catch {
          continue;
        }
        out.push(abs);
      }
    }
  }
  await walk(root);
  return out;
}

/**
 * Whether a repo-relative POSIX path should be indexed, judged from the path
 * alone (no filesystem) — for indexing a commit's tree listing, where there is
 * no walk to prune.
 *
 * Ancestors are tested explicitly because that is where `listSupportedFiles`
 * enforces gitignore's "an excluded directory prunes everything under it": a
 * flat path list would otherwise let a `!keep/this.js` negation resurrect a
 * file under an excluded dir. The two must stay in step — a divergence surfaces
 * as phantom added/removed anchors in a diff, which reads exactly like a real
 * code change.
 */
export function isIndexablePath(rel: string, ignore: Ignore): boolean {
  const segs = rel.split("/");
  const name = segs[segs.length - 1]!;
  if (!grammarForPath(name) || isSkippedFile(name)) return false;
  for (let i = 0; i < segs.length - 1; i++) {
    if (SKIP_DIRS.has(segs[i]!)) return false;
    if (ignore.ignores(segs.slice(0, i + 1).join("/"), true)) return false;
  }
  return !ignore.ignores(rel, false);
}
