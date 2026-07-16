/**
 * `.codemapignore` — gitignore-style excludes for vendored / generated code.
 *
 * Vendored code is usually *committed*, so git's own ignore machinery doesn't
 * cover it; this is a separate, repo-local list. Supported syntax (a practical
 * gitignore subset):
 *
 *   # comment
 *   framework.js          a basename, matched at any depth (file or dir)
 *   wwwroot/vdx/          a path, anchored to repo root; trailing / = dir only
 *   /build                anchored to root
 *   generated/            globstar and single-star globs are supported too
 *   !keep/this.js         re-include (last matching pattern wins)
 *
 * Like gitignore, a file cannot be re-included if an ancestor directory is
 * excluded (excluded dirs are pruned during the walk).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

interface Pattern {
  re: RegExp;
  negate: boolean;
}

export interface Ignore {
  /** `relPath` is repo-relative POSIX; set `isDir` for directories. */
  ignores(relPath: string, isDir: boolean): boolean;
}

const MATCH_NOTHING: Ignore = { ignores: () => false };

function globToRegexBody(glob: string): string {
  // Single pass so glob operators never collide with metachar escaping.
  const META = ".+^${}()|[]\\";
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          out += "(?:.*/)?"; // **/ → optional path prefix across segments
        } else {
          out += ".*"; // ** → anything, including slashes
        }
      } else {
        out += "[^/]*"; // * → within a single segment
      }
    } else if (c === "?") {
      out += "[^/]"; // ? → one non-slash char
    } else if (META.includes(c)) {
      out += "\\" + c;
    } else {
      out += c; // literal (including "/")
    }
  }
  return out;
}

function compile(raw: string): Pattern | null {
  let pat = raw.trim();
  if (!pat || pat.startsWith("#")) return null;
  let negate = false;
  if (pat.startsWith("!")) {
    negate = true;
    pat = pat.slice(1);
  }
  let dirOnly = false;
  if (pat.endsWith("/")) {
    dirOnly = true;
    pat = pat.slice(0, -1);
  }
  // A pattern containing a slash is anchored to the repo root; a bare basename
  // matches at any depth.
  const anchored = pat.includes("/");
  if (pat.startsWith("/")) pat = pat.slice(1);
  const body = globToRegexBody(pat);
  const prefix = anchored ? "^" : "(?:^|/)";
  // Directory test-paths are normalized with a trailing "/", so a dir-only
  // pattern requires that slash; others match a file end or a dir boundary.
  const suffix = dirOnly ? "/" : "(?:/|$)";
  return { re: new RegExp(prefix + body + suffix), negate };
}

/** Build an Ignore from raw `.codemapignore` text (pure — no filesystem). */
export function compileIgnore(text: string): Ignore {
  const patterns = text.split("\n").map(compile).filter((p): p is Pattern => p !== null);
  if (!patterns.length) return MATCH_NOTHING;
  return {
    ignores(relPath, isDir) {
      const test = isDir ? relPath + "/" : relPath;
      let ignored = false;
      for (const p of patterns) {
        if (p.re.test(test)) ignored = !p.negate; // last match wins
      }
      return ignored;
    },
  };
}

export async function loadIgnore(root: string): Promise<Ignore> {
  try {
    return compileIgnore(await readFile(join(root, ".codemapignore"), "utf8"));
  } catch {
    return MATCH_NOTHING;
  }
}
