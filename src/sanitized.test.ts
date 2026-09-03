import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * No name from the forbidden list appears in the published tree.
 *
 * This repository is PUBLIC and was built against a private client's repositories. The
 * tree and all commits were scrubbed once with `git-filter-repo`, and that sweep had no
 * exit predicate: it drifted back twice, and the second time the sweep's own guard
 * carried the name.
 *
 * **The terms are NOT in this repository, and that is the whole design.** A guard that
 * spells what it forbids publishes it — obfuscating it into adjacent fragments defeats a
 * grep and not a reader, which is exactly the mistake this file made on its first
 * writing. So the list lives outside the tree, at `$CODEMAP_FORBIDDEN_NAMES` or
 * `~/.config/codemap/forbidden-names`: one term per line, `#` for comments, matched
 * case-insensitively as substrings.
 *
 * With no list this SKIPS, in the idiom `db-eras.test.ts` already uses for its
 * git cross-check — a stranger who clones this has nothing to check against and should
 * not get a red suite for it. The maintainer has the file; nobody else needs it.
 *
 * To check it is not vacuous: put a term from your list into any file and run it.
 */

const listPath = (): string =>
  process.env.CODEMAP_FORBIDDEN_NAMES || join(homedir(), ".config", "codemap", "forbidden-names");

function terms(): string[] | null {
  try {
    return readFileSync(listPath(), "utf8")
      .split("\n").map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return null;
  }
}

/**
 * Everything that WOULD be published: tracked files plus untracked ones git would take.
 *
 * Tracked alone is a build too late — a new doc carrying a name passes until it is added,
 * and by then it is committed. `--exclude-standard` keeps `.gitignore` in force, so the
 * store, `dist/` and scratch files stay out.
 */
const publishable = (): string[] => [
  ...execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n"),
  ...execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\n"),
].filter(Boolean);

const skip = (): string | false =>
  terms()?.length ? false : `no forbidden-names list at ${listPath()} — this check is the maintainer's`;

test("no forbidden name survives in the published tree", { skip: skip() }, () => {
  const needle = new RegExp(terms()!.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");
  const hits: string[] = [];

  for (const path of publishable()) {
    let src: string;
    try {
      src = readFileSync(path, "utf8");
    } catch {
      continue; // unreadable, or listed in the index and gone from the working tree
    }
    // Binary blobs (the .wasm grammars, vendored bundles) have no lines worth reporting,
    // and a NUL byte is the cheap test for one that needs no dependency.
    if (src.includes("\0")) {
      if (needle.test(src)) hits.push(`${path}: (binary)`);
      continue;
    }
    src.split("\n").forEach((line, i) => {
      if (needle.test(line)) hits.push(`${path}:${i + 1}`);
    });
  }

  // The LOCATIONS only. Printing the matching line would put the term in CI output, which
  // is published in its own way — and this assertion's message is read by whoever has the
  // list and can look for themselves.
  assert.deepEqual(hits, [],
    "a forbidden name is in the tree. Use the placeholder from your mapping — it lives "
    + "with the list, outside this repository, and it must stay there. If these lines are "
    + "already committed and pushed, say so rather than quietly fixing the tree: the "
    + "history is public and a tree fix does not reach it");
});
