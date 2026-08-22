import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * No tracked source file may contain a raw NUL byte.
 *
 * A NUL makes git call the file BINARY: `git diff` renders "Binary files differ"
 * with zero insertions and zero deletions, so a change to it is invisible in a
 * PR — and `grep -I`, the default for most agent harnesses, and `git grep`, skip
 * it entirely and report no matches rather than an error.
 *
 * This bit twice: `git.ts` and `shared-findings.ts` each wrote a separator as a
 * literal NUL instead of the `\0` escape — byte-identical at runtime, and
 * catastrophic at rest. Searching shared-findings.ts for its own exported
 * functions returned nothing at all.
 */
test("no tracked source file contains a raw NUL byte", () => {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const tracked = execFileSync(
    "git",
    ["ls-files", "-z", "--", "*.ts", "*.js", "*.json", "*.md", "*.html", "*.css"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 },
  ).split("\0").filter(Boolean);

  assert.ok(tracked.length > 50, `expected a source tree, got ${tracked.length} files`);

  const offenders: string[] = [];
  for (const f of tracked) {
    // Vendored blobs are somebody else's bytes; we do not get to reformat them.
    if (f.startsWith("web/vendor/") || f.startsWith("grammars/")) continue;
    if (readFileSync(`${root}/${f}`).includes(0)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], "write the separator as the escape \\0, not as the byte");
});
