/**
 * `.codemapignore` — what codemap should do with a path. TWO bins, not one.
 *
 * Vendored code is usually *committed*, so git's own ignore machinery doesn't
 * cover it; this is a separate list. Supported syntax (a practical gitignore
 * subset):
 *
 *   # comment
 *   framework.js          a basename, matched at any depth (file or dir)
 *   wwwroot/vdx/          a path, anchored to repo root; trailing / = dir only
 *   /build                anchored to root
 *   generated/            globstar and single-star globs are supported too
 *   !keep/this.js         re-include (last matching pattern wins)
 *
 *   [tests]               everything below is INDEXED but never documented
 *   *.Tests/
 *
 * Like gitignore, a file cannot be re-included if an ancestor directory is
 * excluded (excluded dirs are pruned during the walk).
 *
 * ## Why `[tests]` is a bin here and not a `cover` rule
 *
 * Tests belong in the map — a requirement pins a lint by hash, so the lint has to
 * be indexed, citable and hashable. What they do NOT belong in is the
 * documentation denominator: code is a liability and describing it reduces that,
 * which is what `find_gaps` ranks, whereas a test is already a claim in
 * executable form. An uncovered piece of code is a gap; an uncovered test is not.
 * Indexed as ordinary anchors they would enter the model with the wrong sign.
 *
 * `cover ... as trivial` expresses that and CANNOT be used for it: coverage rules
 * live in `.codemap/codemap.db` under the `coverage` meta key, which is gitignored
 * and is not in `SHARED_KINDS`, so the rule is one machine's local state. A
 * repo-wide policy declared in a committed file cannot have its other half in an
 * uncommitted one — every fresh clone would report thousands of phantom gaps until
 * somebody remembered. This file is already the committed declaration of what
 * codemap does with paths, so the bin belongs here and there is nothing to keep in
 * sync. Same reason `mutates` sits on the tool rather than in a list of names.
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
  /** In the `[tests]` bin: indexed, citable, never a documentation gap. */
  isTest(relPath: string, isDir: boolean): boolean;
}

const MATCH_NOTHING: Ignore = { ignores: () => false, isTest: () => false };

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

/** `[section]` on its own line switches which bin the following patterns fill. */
const SECTION = /^\[([a-z-]+)\]$/;

/** Build an Ignore from raw `.codemapignore` text (pure — no filesystem). */
export function compileIgnore(text: string): Ignore {
  const excluded: Pattern[] = [];
  const tests: Pattern[] = [];
  let bin = excluded;
  for (const line of text.split("\n")) {
    const section = SECTION.exec(line.trim());
    // An UNKNOWN section falls back to `excluded` rather than being skipped: a
    // typo that silently dropped its patterns would quietly re-admit whatever
    // they excluded, and over-excluding is the visible failure of the two.
    if (section) { bin = section[1] === "tests" ? tests : excluded; continue; }
    const p = compile(line);
    if (p) bin.push(p);
  }
  if (!excluded.length && !tests.length) return MATCH_NOTHING;
  const matches = (patterns: Pattern[], relPath: string, isDir: boolean): boolean => {
    if (!patterns.length) return false;
    const path = isDir ? relPath + "/" : relPath;
    let hit = false;
    for (const p of patterns) {
      if (p.re.test(path)) hit = !p.negate; // last match wins
    }
    return hit;
  };
  return {
    ignores: (relPath, isDir) => matches(excluded, relPath, isDir),
    isTest: (relPath, isDir) => matches(tests, relPath, isDir),
  };
}

export async function loadIgnore(root: string): Promise<Ignore> {
  try {
    return compileIgnore(await readFile(join(root, ".codemapignore"), "utf8"));
  } catch {
    return MATCH_NOTHING;
  }
}
