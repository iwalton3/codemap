import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffLineRanges } from "./git.js";
import { planPrPush } from "./pr-push.js";
import { readPushes, writePush } from "./store.js";

const git = (root: string, ...a: string[]) =>
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: root, encoding: "utf8" });

test("diffLineRanges reports the head-side lines GitHub will accept a comment on", () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-push-"));
  try {
    git(root, "init", "-q", "-b", "main");
    const lines = (n: number, tag = "x") => Array.from({ length: n }, (_, i) => `${tag}${i + 1}`).join("\n") + "\n";
    writeFileSync(join(root, "a.txt"), lines(40));
    git(root, "add", "-A"); git(root, "commit", "-qm", "base");
    const base = git(root, "rev-parse", "HEAD").stdout.trim();

    const edited = lines(40).split("\n");
    edited[19] = "CHANGED";                       // line 20
    writeFileSync(join(root, "a.txt"), edited.join("\n"));
    git(root, "add", "-A"); git(root, "commit", "-qm", "edit");
    const head = git(root, "rev-parse", "HEAD").stdout.trim();

    const ranges = diffLineRanges(root, base, head);
    const a = ranges.get("a.txt");
    assert.ok(a && a.length, "expected a hunk for the edited file");
    const covers = (n: number) => a!.some(([lo, hi]) => n >= lo && n <= hi);
    assert.ok(covers(20), "the changed line must be commentable");
    assert.ok(covers(18) && covers(22), "context lines around it are commentable too");
    assert.ok(!covers(1), "a line far from any hunk is not commentable");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a push record accumulates, so re-running never re-posts a comment", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-push-"));
  try {
    await writePush(root, "264", { annotationIds: ["an_1", "an_2"], viewedPaths: ["a.cs"], at: "2026-08-18T00:00:00Z" });
    await writePush(root, "264", { annotationIds: ["an_2", "an_3"], viewedPaths: ["b.cs"], at: "2026-08-18T01:00:00Z" });

    const rec = (await readPushes(root)).pushes["264"]!;
    assert.deepEqual(rec.annotationIds.sort(), ["an_1", "an_2", "an_3"], "ids union, never duplicate");
    assert.deepEqual(rec.viewedPaths.sort(), ["a.cs", "b.cs"]);
    assert.equal(rec.at, "2026-08-18T01:00:00Z", "keeps the latest push time");

    // a different PR is tracked separately
    await writePush(root, "290", { annotationIds: ["an_9"], viewedPaths: [], at: "2026-08-18T02:00:00Z" });
    assert.deepEqual((await readPushes(root)).pushes["290"]!.annotationIds, ["an_9"]);
    assert.equal((await readPushes(root)).pushes["264"]!.annotationIds.length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unrecognised --min-severity is refused, never read as \"no filter\"", async () => {
  // indexOf() === -1 read as "no severity filter" published every `low` finding to
  // the PR while the plan printed `belowSeverity: 0` — a confirmation that nothing
  // had been held back. It must refuse before any git or network work.
  const root = mkdtempSync(join(tmpdir(), "codemap-push-"));
  try {
    for (const bad of ["High", "med", "major", ""]) {
      const r = await planPrPush(root, "owner/repo#1", { minSeverity: bad as any });
      assert.ok("error" in r, `"${bad}" must not be accepted`);
      assert.match((r as { error: string }).error, /min-severity/i, `"${bad}" should name the flag`);
    }
    // an absent filter is still "no filter", which is a different thing
    const ok = await planPrPush(root, "", {});
    assert.ok(!("error" in ok) || !/min-severity/i.test((ok as { error: string }).error));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
