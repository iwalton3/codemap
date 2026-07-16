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
import { loadIgnore } from "./ignore.js";

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

const MAX_BYTES = 1_000_000; // generated bundles / data files

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
