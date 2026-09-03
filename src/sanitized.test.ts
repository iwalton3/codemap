import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * The client's name does not appear in this repository.
 *
 * It is PUBLIC (`github.com/iwalton3/codemap`) and the target repositories it was built
 * against are a private client's. The tree and all 54 commits were scrubbed on
 * 2026-07-31 with `git-filter-repo`, real names replaced by the `Acme` placeholder.
 *
 * **That sweep had no exit predicate, and it drifted four times in five weeks** — a Jira
 * key in a test fixture, the front-end repo's real name in a comment and again in a doc,
 * and the sidecar's real GitHub org in the handoff. All four were pushed. The repair for
 * a rule that keeps coming back is not a second sweep; it is the thing that fails the
 * build when it comes back a fifth time.
 *
 * **The needle is assembled from fragments on purpose.** A test spelling the name would
 * be the very leak it exists to prevent — and it is published like everything else here.
 * The same trap `standard-reach.test.ts` records one level up: a scan a comment can
 * satisfy measures how much was written about a rule, not whether the rule holds.
 *
 * To check it is not vacuous, put the assembled string into any tracked file and run it.
 */

/**
 * Everything that WOULD be published: tracked files plus untracked ones git would take.
 *
 * Tracked alone is a build too late — a new doc carrying the name passes until it is
 * added, and by then it is committed. `--exclude-standard` keeps `.gitignore` in force,
 * so the store, `dist/` and scratch files stay out.
 */
const publishable = (): string[] => [
  ...execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n"),
  ...execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\n"),
].filter(Boolean);

// Never written out. See the note above.
const FORBIDDEN = [["REDACTED"].join(""), ["REDACTED"].join("")];

test("no client-identifying name survives in the published tree", () => {
  const needle = new RegExp(FORBIDDEN.join("|"), "i");
  const hits: string[] = [];

  for (const path of publishable()) {
    let src: string;
    try {
      src = readFileSync(path, "utf8");
    } catch {
      continue; // unreadable or gone from the working tree; `git ls-files` lists the index
    }
    // Binary blobs (the .wasm grammars, vendored bundles) have no lines worth reporting,
    // and a NUL byte is the cheap test for one that does not need a dependency.
    if (src.includes("\0")) {
      if (needle.test(src)) hits.push(`${path}: (binary)`);
      continue;
    }
    src.split("\n").forEach((line, i) => {
      if (needle.test(line)) hits.push(`${path}:${i + 1}`);
    });
  }

  assert.deepEqual(hits, [],
    "the client name is back in the tree. Replace it with the `Acme` placeholder — the "
    + "mapping is in the sanitization memory, not in this repository, and it must stay "
    + "that way. If these lines are already committed and pushed, say so rather than "
    + "quietly fixing the tree: the history is public and a tree fix does not reach it");
});
