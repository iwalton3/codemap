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
 * somebody remembered. Same reason `mutates` sits on the tool rather than in a list
 * of names.
 *
 * ## WHERE the declaration lives: the repo, then the sidecar
 *
 * The paragraph above wants a COMMITTED home and assumed the code repo was the only
 * one. It is not, and the code repo has a defect the sidecar does not: `.codemapignore`
 * is resolved from the working tree, so it is coupled to the branch you have checked
 * out. A branch cut before the file was committed does not have it, and checking that
 * branch out deletes it — after which this module used to return "no declaration" as
 * silently as it returns "declared, and nothing matched".
 *
 * Two harms, and the second is the one that matters. Generated code floods back in as
 * documentation gaps, which is loud. And `ServedPointer.rank` derives `check` from
 * `isTest` (`pointers.ts`), so every pointer at a test anchor silently demotes from the
 * TOP rung — a check that runs, covering a whole population — to `symbol` /
 * `lastResort: true`, the rung that "goes quiet exactly when the code it governs is
 * edited". The ladder inverts, and nothing says so.
 *
 * So the declaration is LAYERED, in the precedence `sidecar-config.ts` already uses for
 * finding the sidecar itself:
 *
 *   1. `<repo>/.codemapignore` — authoritative if PRESENT. A branch that renames its
 *      test directory genuinely wants its own patterns, and there branch coupling is
 *      correct behaviour rather than a bug.
 *   2. `<sidecar>/config/<universeKey>/codemapignore` — the team default, on the
 *      sidecar's own branch, so it does not move when somebody checks out a six-week-old
 *      feature branch. Keyed exactly like every other scope, which matters: `universeKey`
 *      falls back to the directory basename with no GitHub origin, and an address spelled
 *      `owner/repo` would be unreachable from any local clone.
 *   3. Neither — `source: "none"`.
 *
 * OVERRIDE, not merge. Merging would give "team default plus this branch's extras" but
 * makes removing an inherited pattern impossible without a negation, and negation
 * interacts with the ancestor-pruning rule above in ways that are genuinely hard to
 * reason about. Repo-wins is also the backward-compatible order.
 *
 * **`source` is why this is three states and not two**, and it is load-bearing rather
 * than diagnostic: an intentionally EMPTY repo file is a real declaration and must not
 * inherit the team default, while an absent one must. Collapsing both to "matches
 * nothing" is what made the layer inexpressible.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveSidecar } from "./sidecar-config.js";

interface Pattern {
  re: RegExp;
  negate: boolean;
}

/**
 * Which declaration this came from. `"none"` means nobody has declared one ANYWHERE —
 * distinct from a declaration that happens to match nothing, which is a decision.
 */
export type IgnoreSource = "repo" | "sidecar" | "none";

export interface Ignore {
  /** `relPath` is repo-relative POSIX; set `isDir` for directories. */
  ignores(relPath: string, isDir: boolean): boolean;
  /** In the `[tests]` bin: indexed, citable, never a documentation gap. */
  isTest(relPath: string, isDir: boolean): boolean;
  source: IgnoreSource;
}

const matchNothing = (source: IgnoreSource): Ignore =>
  ({ ignores: () => false, isTest: () => false, source });

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

/**
 * Build an Ignore from raw `.codemapignore` text (pure — no filesystem).
 *
 * `source` defaults to `"repo"` because that is what every direct caller is compiling:
 * text it read out of a working tree or a git object. Only `loadIgnore` passes anything
 * else, and only `loadIgnore` may produce `"none"`.
 */
export function compileIgnore(text: string, source: IgnoreSource = "repo"): Ignore {
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
  // DECLARED, and matching nothing — which is not the same as undeclared, and the
  // difference is what lets `loadIgnore` decide whether to fall through to the team's.
  if (!excluded.length && !tests.length) return matchNothing(source);
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
    source,
  };
}

/** Where a universe's team-wide declaration lives inside the sidecar. */
export const sidecarIgnorePath = (sidecarRoot: string, universe: string): string =>
  join(sidecarRoot, "config", ...universe.split("/"), "codemapignore");

/**
 * The declaration in force here: the repo's if it has one, else the team's, else none.
 *
 * See the header for why it is layered and why override beats merge. The sidecar half
 * needs no new transport — `sync` commits the sidecar with `git add -A`, so a file
 * dropped at `sidecarIgnorePath` travels with the next one.
 */
export async function loadIgnore(root: string): Promise<Ignore> {
  try {
    return compileIgnore(await readFile(join(root, ".codemapignore"), "utf8"), "repo");
  } catch { /* no repo declaration — the team's may still stand */ }

  const cfg = resolveSidecar(root);
  if (cfg) {
    try {
      return compileIgnore(await readFile(sidecarIgnorePath(cfg.path, cfg.universe), "utf8"), "sidecar");
    } catch { /* none there either */ }
  }
  return matchNothing("none");
}
