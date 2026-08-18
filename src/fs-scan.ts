/**
 * Repo traversal + ignore rules.
 *
 * Directories are skipped by *basename* (not path substring) — so a repo that
 * merely lives under a path like `~/bin/...` is fine; only a child dir actually
 * named `bin` (a .NET build output) is skipped.
 */

import { readdir, stat } from "node:fs/promises";
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
        if (!SKIP_DIRS.has(e.name) && !ignore.ignores(rel, true)) await walk(abs);
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
