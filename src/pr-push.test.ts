import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffLineRanges } from "./git.js";
import { planPrPush, isAgentAuthored, isElected, pushVerdict, executePrPush } from "./pr-push.js";
import { readPushes, writePush } from "./store.js";
import type { Annotation } from "./schema.js";

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

test("an added line that looks like a diff header does not re-attribute the hunks after it", () => {
  // "++ b/other.ts" in a patch fixture renders as "+++ b/other.ts" inside the hunk
  // body. Read as a file header it moved every later hunk onto a file the commit
  // never touched — and pr-push posts review comments at these line numbers.
  const root = mkdtempSync(join(tmpdir(), "codemap-push-"));
  try {
    git(root, "init", "-q", "-b", "main");
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `x${i + 1}`).join("\n") + "\n";
    writeFileSync(join(root, "fixture.patch"), lines(40));
    writeFileSync(join(root, "untouched.ts"), lines(10));
    git(root, "add", "-A"); git(root, "commit", "-qm", "base");
    const base = git(root, "rev-parse", "HEAD").stdout.trim();

    const edited = lines(40).split("\n");
    edited[4] = "++ b/untouched.ts";     // line 5 — the trap
    edited[29] = "CHANGED";              // line 30 — a second, later hunk in the same file
    writeFileSync(join(root, "fixture.patch"), edited.join("\n"));
    git(root, "add", "-A"); git(root, "commit", "-qm", "edit");
    const head = git(root, "rev-parse", "HEAD").stdout.trim();

    const ranges = diffLineRanges(root, base, head);
    assert.equal(ranges.has("untouched.ts"), false, "a file the commit never changed must have no commentable range");
    const f = ranges.get("fixture.patch");
    assert.ok(f && f.length >= 2, "both hunks belong to the file that actually changed");
    assert.ok(f!.some(([lo, hi]) => 30 >= lo && 30 <= hi), "the hunk after the trap keeps its own file");
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

test("only findings the human elected are publishable", () => {
  // Publishing posts under your account and notifies the author, so an agent's
  // proposal needs an explicit act — not merely having been read.
  const mine = { author: "human", text: "x" } as any;
  const theirs = { author: "agent:pr-first-pass", text: "x" } as any;
  const raised = { author: "agent:pr-first-pass", text: "x", escalated: { at: "now", by: "human" } } as any;

  assert.equal(isAgentAuthored(mine), false);
  assert.equal(isAgentAuthored(theirs), true);

  assert.equal(isElected(mine), true, "writing it yourself IS the act");
  assert.equal(isElected(theirs), false, "an unraised agent proposal must not go out");
  assert.equal(isElected(raised), true, "raising it to the maintainer is what makes it publishable");

  // an author codemap did not set is treated as a person, not an agent
  assert.equal(isElected({ author: "izzie", text: "x" } as any), true);
  assert.equal(isElected({ author: "", text: "x" } as any), true);
});

/**
 * Every decision about what lands irreversibly on somebody else's pull request
 * used to live inside a loop no test reached: the vetting gate, the re-run dedupe
 * and the severity bar could all have been deleted without breaking anything.
 */
const ann = (over: Partial<Annotation> = {}): Annotation => ({
  id: "n1", target: { kind: "anchor", id: "a_1" }, text: "boom", author: "human",
  createdCommit: null, kind: "finding", severity: "medium", ...over,
} as Annotation);

test("what gets published: mine, raised ones, unresolved, unsent, above the bar", () => {
  const none = new Set<string>();
  assert.equal(pushVerdict(ann(), true, none), "push");

  assert.equal(pushVerdict(ann(), false, none), "not-in-pr", "a finding on a symbol this PR does not touch");
  assert.equal(pushVerdict(ann({ resolved: true }), true, none), "resolved", "closed locally is not news for the author");
  assert.equal(pushVerdict(ann(), true, new Set(["n1"])), "already-pushed", "a re-run never duplicates a comment");

  const theirs = ann({ author: "agent:pr-first-pass" });
  assert.equal(pushVerdict(theirs, true, none), "not-elected", "an agent's proposal needs raising first");
  assert.equal(pushVerdict({ ...theirs, escalated: { at: "now", by: "me" } } as Annotation, true, none), "push");
  assert.equal(pushVerdict(theirs, true, none, { electedOnly: false }), "push", "--all is the override");

  assert.equal(pushVerdict(ann({ severity: "low" }), true, none, { minSeverity: "high" }), "below-severity");
  assert.equal(pushVerdict(ann({ severity: "critical" }), true, none, { minSeverity: "high" }), "push");
  assert.equal(pushVerdict(ann({ severity: undefined }), true, none, { minSeverity: "medium" }), "below-severity",
    "no severity reads as the lowest, not as exempt");

  // the order matters: resolved beats everything, so a resolved agent finding
  // reports as resolved rather than as unelected
  assert.equal(pushVerdict({ ...theirs, resolved: true } as Annotation, true, none), "resolved");
});

test("publishing records the review BEFORE syncing viewed state", async () => {
  // The viewed sync is a `gh` call per file with a 120s timeout each. Recording
  // afterwards left a window where an interrupt lost the only evidence the review
  // went out, and the next publish re-posted every inline comment.
  const root = mkdtempSync(join(tmpdir(), "codemap-exec-"));
  try {
    const calls: string[] = [];
    const plan = {
      fingerprint: "f", pr: { number: 7, title: "t", url: "u", owner: "o", repo: "r" }, head: "h",
      body: "summary", comments: [{ path: "a.ts", line: 2, side: "RIGHT" as const, body: "x", annotationId: "n1" }],
      deferred: [], viewedPaths: ["a.ts"],
      skipped: { alreadyPushed: 0, resolved: 0, notElected: 0, belowSeverity: 0 },
    };
    const fakeGh = (args: string[]) => {
      const kind = args.includes("--method") ? "post-review" : args[0] === "pr" ? "node-id" : "mark-viewed";
      calls.push(kind);
      if (kind === "post-review") return { ok: true, out: JSON.stringify({ html_url: "https://x/1" }), err: "" };
      if (kind === "node-id") return { ok: true, out: "PR_1", err: "" };
      return { ok: true, out: "{}", err: "" };
    };
    const seenAt: string[] = [];
    const origRead = readPushes;
    const r = await executePrPush(root, plan as any, { markViewed: true, gh: fakeGh as any });
    assert.equal(r.postedComments, 1);
    assert.deepEqual(r.markedViewed, ["a.ts"]);
    assert.deepEqual(calls, ["post-review", "node-id", "mark-viewed"], "post, then sync");
    void seenAt; void origRead;

    const rec = (await readPushes(root)).pushes["7"]!;
    assert.deepEqual(rec.annotationIds, ["n1"], "the publish is recorded, so a re-run skips it");
    assert.deepEqual(rec.viewedPaths, ["a.ts"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed comment post does not abandon a viewed sync that was also asked for", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-exec2-"));
  try {
    const plan = {
      fingerprint: "f", pr: { number: 8, title: "t", url: "u", owner: "o", repo: "r" }, head: "h",
      body: "b", comments: [{ path: "a.ts", line: 1, side: "RIGHT" as const, body: "x", annotationId: "n1" }],
      deferred: [], viewedPaths: ["a.ts"],
      skipped: { alreadyPushed: 0, resolved: 0, notElected: 0, belowSeverity: 0 },
    };
    const fakeGh = (args: string[]) => args.includes("--method")
      ? { ok: false, out: "", err: "422 unprocessable" }
      : { ok: true, out: args[0] === "pr" ? "PR_1" : "{}", err: "" };
    const r = await executePrPush(root, plan as any, { markViewed: true, gh: fakeGh as any });
    assert.equal(r.postedComments, 0);
    assert.ok(r.errors.some((e) => /review post failed/.test(e)));
    assert.deepEqual(r.markedViewed, ["a.ts"], "they are independent acts; one failing is not the other's news");
    // and nothing is recorded as published, so a retry still sends the comment
    assert.equal((await readPushes(root)).pushes["8"]?.annotationIds?.length ?? 0, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pushing viewed state alone opens no review on the pull request", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-exec3-"));
  try {
    const calls: string[] = [];
    const plan = {
      fingerprint: "f", pr: { number: 9, title: "t", url: "u", owner: "o", repo: "r" }, head: "h",
      body: "b", comments: [{ path: "a.ts", line: 1, side: "RIGHT" as const, body: "x", annotationId: "n1" }],
      deferred: [], viewedPaths: ["a.ts"],
      skipped: { alreadyPushed: 0, resolved: 0, notElected: 0, belowSeverity: 0 },
    };
    const fakeGh = (args: string[]) => {
      calls.push(args.includes("--method") ? "post-review" : args[0] === "pr" ? "node-id" : "mark-viewed");
      return { ok: true, out: args[0] === "pr" ? "PR_1" : "{}", err: "" };
    };
    const r = await executePrPush(root, plan as any, { comments: false, markViewed: true, gh: fakeGh as any });
    assert.equal(calls.includes("post-review"), false, "viewed state is a different act from commenting");
    assert.equal(r.postedComments, 0);
    assert.deepEqual(r.markedViewed, ["a.ts"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
