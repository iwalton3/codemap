/**
 * A leftover finding is made by the application that closed its parent, with no `finding.created`
 * event (C4), so "does this finding exist" goes through `findingIds` (`leftover-findings.ts`). A
 * reader that scans for `finding.created` itself refuses every leftover — four did when leftovers
 * became derived. This fails when a fifth appears.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Each file allowed to name the kind, and the lines that may: the fold, its door, its vocabulary and its emitter. */
const ALLOWED: Record<string, RegExp[]> = {
  "src/leftover-findings.ts": [/if \(e\.kind === "finding\.created"\) \{/],
  "src/shared-findings.ts": [
    /^ {4}if \(e\.kind === "finding\.created"\) \{$/,                 // foldFindingsInternal
    /^ {2}if \(e\.kind === "finding\.created"\) \{$/,                 // outsideReferences: the creation's key and topic
    /^ {2}"finding\.created", "finding\.revised",/,                  // FINDING_KINDS
    /await emit\(logRoot, pr, actor, id, "finding\.created",/,        // createFinding
  ],
};

const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? (e.name === "e2e" ? [] : walk(join(d, e.name))) : [join(d, e.name)]);

test("only the fold, its door and findingIds read finding.created; every other existence check calls findingIds", () => {
  const hits = walk("src").filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
    .flatMap((file) => readFileSync(file, "utf8").split("\n").map((line, i) => ({ file, line, at: i + 1 })))
    .filter((x) => x.line.includes('"finding.created"'));
  const stray = hits.filter((x) => !(ALLOWED[x.file] ?? []).some((re) => re.test(x.line)));
  assert.deepEqual(stray.map((x) => `${x.file}:${x.at}: ${x.line.trim()}`), []);
  for (const [file, lines] of Object.entries(ALLOWED))
    for (const re of lines) assert.equal(hits.filter((x) => x.file === file && re.test(x.line)).length, 1, `${file} still holds ${re}`);
});
