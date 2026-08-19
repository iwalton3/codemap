import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffLineRanges } from "./git.js";
import { planPrPush, isAgentAuthored, isElected, pushVerdict, executePrPush, placeAnnotation, publishStateOf, buildComments } from "./pr-push.js";
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
  createdCommit: null, kind: "finding", severity: "medium",
  comment: "the by-id branch has no tenant predicate", disposition: "confirmed", ...over,
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

test("a finding with no submitter-facing comment is held back, not sent as its evidence", () => {
  // `text` is the investigation, written for the map. Falling back to it would
  // publish "PARTLY CONFIRMED — the stated impact is overstated" followed by three
  // paragraphs of what was traced, to the person who just has to fix it.
  const none = new Set<string>();
  assert.equal(pushVerdict(ann({ comment: undefined }), true, none), "no-comment");
  assert.equal(pushVerdict(ann({ comment: "   " }), true, none), "no-comment");

  // and it is reported LAST, so a finding that was never going out anyway does not
  // claim to be blocked on wording
  assert.equal(pushVerdict(ann({ comment: undefined, resolved: true }), true, none), "resolved");
  assert.equal(pushVerdict(ann({ comment: undefined, author: "agent:x" }), true, none), "not-elected");
});

test("only findings triage stands behind go out unasked", () => {
  const none = new Set<string>();
  // A refuted finding published to the submitter reads as "actually this is not a
  // bug" — noise on the PR, and exactly what batching is meant to prevent.
  assert.equal(pushVerdict(ann({ disposition: "refuted" }), true, none), "not-publishable");
  assert.equal(pushVerdict(ann({ disposition: "accepted" }), true, none), "not-publishable");
  assert.equal(pushVerdict(ann({ disposition: "open" }), true, none), "not-publishable", "nobody has checked it yet");

  for (const d of ["confirmed", "partial", "rerated"] as const) {
    assert.equal(pushVerdict(ann({ disposition: d }), true, none), "push", d);
  }

  // ...but naming it explicitly is the human picking a batch, and that outranks the
  // default: a refutation of a concern they already raised on the PR is worth one
  // line closing it out, so the submitter stops defending a non-issue.
  assert.equal(pushVerdict(ann({ disposition: "refuted" }), true, none, { ids: new Set(["n1"]) }), "push");

  // a note is not a finding and has no disposition to stand behind
  assert.equal(pushVerdict(ann({ kind: "note", disposition: undefined }), true, none), "push");
});

test("withdrawn stays on the map and off the pull request", () => {
  const none = new Set<string>();
  assert.equal(pushVerdict(ann({ withdrawn: { at: "now", by: "me" } }), true, none), "withdrawn");
  // a finding already posted is never re-sent, whichever record says so
  assert.equal(pushVerdict(ann({ postedRef: { pr: 7, at: "now", placement: "inline" } }), true, none), "already-pushed");
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
    const r = await executePrPush(root, plan as any, { markViewed: true, gh: fakeGh as any, headNow: { headSha: plan.head } as any });
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
    const r = await executePrPush(root, plan as any, { markViewed: true, gh: fakeGh as any, headNow: { headSha: plan.head } as any });
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
    const r = await executePrPush(root, plan as any, { comments: false, markViewed: true, gh: fakeGh as any, headNow: { headSha: plan.head } as any });
    assert.equal(calls.includes("post-review"), false, "viewed state is a different act from commenting");
    assert.equal(r.postedComments, 0);
    assert.deepEqual(r.markedViewed, ["a.ts"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a viewed sync is refused when the pull request head moved under the plan", async () => {
  // GitHub records a tick against whatever the head is NOW, so ticking a plan built
  // against an older head claims the reviewer read code that arrived afterwards.
  const root = mkdtempSync(join(tmpdir(), "codemap-moved-"));
  try {
    const plan = {
      fingerprint: "f", pr: { number: 5, title: "t", url: "u", owner: "o", repo: "r" }, head: "OLDHEAD",
      body: "b", comments: [], deferred: [], viewedPaths: ["a.ts"],
      skipped: { alreadyPushed: 0, resolved: 0, notElected: 0, belowSeverity: 0 },
    };
    const calls: string[] = [];
    const fakeGh = (args: string[]) => { calls.push(args[0]!); return { ok: true, out: "{}", err: "" }; };

    const moved = await executePrPush(root, plan as any, {
      comments: false, markViewed: true, gh: fakeGh as any,
      headNow: { headSha: "NEWHEAD" } as any,
    });
    assert.deepEqual(moved.markedViewed, [], "nothing is ticked against a head nobody reviewed");
    assert.ok(moved.errors.some((e) => /head moved/.test(e)));
    assert.equal(calls.length, 0, "and GitHub is not called at all");

    const same = await executePrPush(root, plan as any, {
      comments: false, markViewed: true, gh: fakeGh as any,
      headNow: { headSha: "OLDHEAD" } as any,
    });
    assert.deepEqual(same.markedViewed, ["a.ts"], "an unmoved head syncs normally");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("publishing viewed state alone does not erase the link to a review posted earlier", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-url-"));
  try {
    await writePush(root, "9", { annotationIds: ["n1"], viewedPaths: [], at: "t1", reviewUrl: "https://x/1" });
    await writePush(root, "9", { annotationIds: [], viewedPaths: ["a.ts"], at: "t2" });
    const rec = (await readPushes(root)).pushes["9"]!;
    assert.equal(rec.reviewUrl, "https://x/1", "the arrays union; a scalar must not be blanked by a later write");
    assert.deepEqual(rec.viewedPaths, ["a.ts"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * Placement is where the surprises live: GitHub takes a review comment only on a
 * file in the diff and only inside a hunk, and findings honour neither constraint.
 */
const place = (a: Partial<Annotation>, subject: { file?: string; symbol?: string }, world: {
  diff?: Record<string, [number, number][]>;
  symbolLine?: number;
} = {}) => {
  const diff: Record<string, [number, number][]> = world.diff ?? { "touched.cs": [[10, 20]] };
  return placeAnnotation(ann(a), subject, {
    inDiff: (f: string) => f in diff,
    commentable: (f: string, l: number) => (diff[f] ?? []).some(([x, y]) => l >= x && l <= y),
    firstHunkLine: (f: string) => diff[f]?.[0]?.[0],
    firstChangedLineOfSymbol: () => world.symbolLine,
  });
};

test("a finding on a changed line lands on that line, with nothing prepended", () => {
  const p = place({ line: 12 }, { file: "touched.cs", symbol: "S › M" });
  assert.deepEqual(p, { kind: "inline", path: "touched.cs", line: 12 });
});

test("a finding whose line is outside every hunk falls back to the symbol's changed lines", () => {
  const p = place({ line: 3 }, { file: "touched.cs", symbol: "S › M" }, { symbolLine: 15 });
  assert.deepEqual(p, { kind: "inline", path: "touched.cs", line: 15 },
    "the comment belongs on the code it is about, not swept into the summary");
});

test("landing somewhere other than the subject leads with where the subject really is", () => {
  // The reader's context is wrong by construction: they are looking at line 10 of a
  // file and being told about line 3. Without this the comment reads as being about
  // whatever hunk it happened to be pinned to.
  const p = place({ line: 3 }, { file: "touched.cs", symbol: "S › M" });
  assert.deepEqual(p, { kind: "inline", path: "touched.cs", line: 10, preamble: "touched.cs:3" });
});

test("a finding about code the pull request never touched needs a file the human picked", () => {
  // The common case, not an error: a fail-open predicate the branch made reachable
  // but did not edit, or a missing registration — an ABSENCE, which has no line
  // anywhere. Guessing a file costs the submitter more than not sending it.
  const nowhere = place({ line: 51 }, { file: "untouched.cs", symbol: "Q › Handle" });
  assert.equal(nowhere.kind, "body");
  assert.match((nowhere as { why: string }).why, /not in this pull request.*publishPath/);

  const placed = place({ line: 51, publishPath: "touched.cs" }, { file: "untouched.cs", symbol: "Q › Handle" });
  assert.deepEqual(placed, { kind: "inline", path: "touched.cs", line: 10, preamble: "untouched.cs:51" },
    "and it says out loud that the real subject is elsewhere");
});

test("a publishPath that is not in the diff either is refused by name", () => {
  // Silently falling through to the body would hide the human's typo behind a
  // generic 'could not place this'.
  const p = place({ publishPath: "also-untouched.cs" }, { file: "untouched.cs" });
  assert.equal(p.kind, "body");
  assert.match((p as { why: string }).why, /also-untouched\.cs.*not a file in this pull request/);
});

test("publishState is read from the acts that already happened, not stored twice", () => {
  const none = new Set<string>();
  assert.equal(publishStateOf(ann({ author: "agent:x" }), none), "local", "an agent's proposal is not vouched for");
  assert.equal(publishStateOf(ann({ author: "human" }), none), "approved", "writing it yourself IS the act");
  assert.equal(publishStateOf(ann({ author: "agent:x", escalated: { at: "n", by: "me" } }), none), "approved");
  assert.equal(publishStateOf(ann({ withdrawn: { at: "n", by: "me" } }), none), "withdrawn");
  assert.equal(publishStateOf(ann(), new Set(["n1"])), "posted", "the push record is the receipt");
  assert.equal(publishStateOf(ann({ postedRef: { pr: 7, at: "n", placement: "inline" } }), none), "posted");

  // posted outranks withdrawn: deciding against it afterwards does not un-send it
  assert.equal(publishStateOf(ann({ withdrawn: { at: "n", by: "me" } }), new Set(["n1"])), "posted");
});

/**
 * The assembly. Every piece of it was testable alone and the whole was not, because
 * reaching it needed a live GitHub pull request — which is exactly how the
 * silently-dropped finding survived.
 */
const world = (over: Partial<Parameters<typeof buildComments>[1]> = {}) => ({
  inPr: (id: string) => (id === "a_1" ? { file: "touched.cs", symbol: "S › M" } : undefined),
  anchorOf: (id: string) => ({ a_1: { file: "touched.cs", symbol: "S › M" }, a_far: { file: "untouched.cs", symbol: "Q › Handle" } } as Record<string, { file: string; symbol: string }>)[id],
  pushed: new Set<string>(),
  inDiff: (p: string) => p === "touched.cs",
  commentable: (p: string, l: number) => p === "touched.cs" && l >= 10 && l <= 20,
  firstHunkLine: (p: string) => (p === "touched.cs" ? 10 : undefined),
  firstChangedLineOfSymbol: () => 12,
  headHashOf: () => undefined,
  ...over,
});

test("the plan publishes the comment, never the evidence", () => {
  const set = buildComments([ann({ line: 12, text: "PARTLY CONFIRMED — three paragraphs of what was traced" })], world());
  assert.equal(set.comments.length, 1);
  assert.match(set.comments[0]!.body, /no tenant predicate/);
  assert.doesNotMatch(set.comments[0]!.body, /PARTLY CONFIRMED/,
    "publishing `text` is the wall of text this whole split exists to prevent");
});

test("an agent's comment is marked, a human's is not", () => {
  const mine = buildComments([ann({ line: 12, author: "izzie" })], world());
  assert.doesNotMatch(mine.comments[0]!.body, /\[Claude\]/);

  const theirs = buildComments([ann({ line: 12, author: "agent:pr-first-pass", escalated: { at: "n", by: "me" } })], world());
  assert.match(theirs.comments[0]!.body, /^\[Claude\] /, "short, at the start — not a banner or a generated-by footer");

  // a human who rewrites an agent's wording owns it, and does not have to choose
  // between mislabelling it and losing the marker
  const rewritten = buildComments([ann({
    line: 12, author: "agent:pr-first-pass", escalated: { at: "n", by: "me" },
    revisions: [{ at: "n", by: "izzie", was: { comment: "the agent's wording" } }],
  })], world());
  assert.doesNotMatch(rewritten.comments[0]!.body, /\[Claude\]/);
});

test("a question asks for an answer, and says so", () => {
  const set = buildComments([ann({ line: 12, kind: "question", disposition: "confirmed" })], world());
  assert.match(set.comments[0]!.body, /\*\*Question\*\* —/);
});

test("an elected finding on code the PR never touched is reported, not dropped", () => {
  // The defect this replaced: a bare `continue`, uncounted, so electing one meant it
  // silently never went out AND the plan said nothing was held back.
  const far = ann({ id: "n2", target: { kind: "anchor", id: "a_far" }, line: 51, author: "izzie" });
  const set = buildComments([far], world());
  assert.equal(set.comments.length, 0);
  assert.equal(set.blocked.length, 1);
  assert.equal(set.blocked[0]!.file, "untouched.cs");
  assert.match(set.blocked[0]!.label, /no tenant predicate/, "named, so it can be recognised");
  assert.match(set.blocked[0]!.why, /publishPath/);

  // ...and placing it is one field
  const placed = buildComments([{ ...far, publishPath: "touched.cs" } as Annotation], world());
  assert.equal(placed.blocked.length, 0);
  assert.deepEqual([placed.comments[0]!.path, placed.comments[0]!.line], ["touched.cs", 10]);
  assert.match(placed.comments[0]!.body, /Re: untouched\.cs:51/, "and it says where the subject really is");
});

test("an unelected agent finding on untouched code stays silent", () => {
  // The map is full of annotations about other code. Only a human's deliberate act
  // makes one this pull request's business.
  const set = buildComments([ann({ id: "n3", target: { kind: "anchor", id: "a_far" }, author: "agent:x" })], world());
  assert.deepEqual([set.blocked.length, set.comments.length], [0, 0]);
  assert.equal(set.skipped.notElected, 0, "not even counted — it was never a candidate");
});

test("a finding with no comment is blocked by name, with what to write", () => {
  const set = buildComments([ann({ line: 12, comment: undefined })], world());
  assert.equal(set.comments.length, 0);
  assert.equal(set.skipped.noComment, 1);
  assert.match(set.blocked[0]!.why, /what is broken, the file:line proving it, the ask/);
  assert.match(set.blocked[0]!.label, /boom/, "falls back to the evidence just to identify it");
});

test("the skip counts add up to what was held back, and say why", () => {
  const set = buildComments([
    ann({ id: "p1", line: 12 }),
    ann({ id: "p2", line: 12, resolved: true }),
    ann({ id: "p3", line: 12, withdrawn: { at: "n", by: "me" } }),
    ann({ id: "p4", line: 12, disposition: "refuted" }),
    ann({ id: "p5", line: 12, author: "agent:x" }),
    ann({ id: "p6", line: 12, severity: "low" }),
  ], world(), { minSeverity: "medium" });
  assert.equal(set.comments.length, 1, "only p1");
  assert.deepEqual(set.skipped, {
    alreadyPushed: 0, resolved: 1, notElected: 1, belowSeverity: 1,
    withdrawn: 1, noComment: 0, notPublishable: 1, evidenceMoved: 0,
  });
});

test("naming a batch publishes exactly it", () => {
  const set = buildComments([ann({ id: "p1", line: 12 }), ann({ id: "p2", line: 12 })], world(), { ids: ["p2"] });
  assert.deepEqual(set.comments.map((c) => c.annotationId), ["p2"]);
});

/**
 * Cross-PR contamination: a finding accurately describing PR #227's version of
 * EmailTemplateService.cs was filed onto PR #264's anchor for the same path, because
 * an anchor id is path+symbol with no ref in it. The prose, line numbers and quoted
 * expressions were all correct — for the other branch. Nothing inside the finding
 * marked it as wrong, and it would have gone to #264's author in the batch.
 *
 * See the report: codemap-bug-cross-pr-finding-contamination.md.
 */
test("a finding written against a different body does not reach the submitter", () => {
  const onHead = new Map([["a_1", "sha256:HEAD"]]);
  const w = world({ headHashOf: (id: string) => onHead.get(id) });

  const fromHere = buildComments([ann({ line: 12, witness: { anchorId: "a_1", bodyHash: "sha256:HEAD" } })], w);
  assert.equal(fromHere.comments.length, 1, "witnessed against this PR's body — it goes");

  const fromElsewhere = buildComments([ann({
    line: 12, witness: { anchorId: "a_1", bodyHash: "sha256:OTHER-BRANCH" }, sourceRef: "b352cb66aa",
  })], w);
  assert.equal(fromElsewhere.comments.length, 0);
  assert.equal(fromElsewhere.skipped.evidenceMoved, 1);
  assert.match(fromElsewhere.blocked[0]!.why, /different version of this code \(b352cb66aa\)/);
  assert.match(fromElsewhere.blocked[0]!.why, /belongs on that one/, "and says where to look");

  // a finding written against the WORKING TREE during a PR review says so by name —
  // that is the third-version case, and the one the reported bug actually hit
  const fromWorktree = buildComments([ann({
    line: 12, witness: { anchorId: "a_1", bodyHash: "sha256:DEVELOP" }, sourceRef: "@work",
  })], w);
  assert.match(fromWorktree.blocked[0]!.why, /the working tree, not this pull request/);
});

test("findings filed before witnessing are sent, but named as unchecked", () => {
  // Blocking every pre-existing finding would be a migration disguised as a safety
  // check. Letting them read as verified would be a lie. So: they go, and they are
  // listed.
  const w = world({ headHashOf: () => "sha256:HEAD" });
  const set = buildComments([ann({ id: "old", line: 12 }), ann({ id: "new", line: 12, witness: { anchorId: "a_1", bodyHash: "sha256:HEAD" } })], w);
  assert.equal(set.comments.length, 2);
  assert.deepEqual(set.unverified, ["old"]);
});

test("a PR that does not carry the anchor at all cannot judge the witness", () => {
  // `headHashOf` returning undefined means this PR's snapshot has no body for that
  // anchor — a symbol the branch deletes, say. Absence of evidence is not a mismatch,
  // and treating it as one would block every finding on deleted code.
  const set = buildComments([ann({ line: 12, witness: { anchorId: "a_1", bodyHash: "sha256:ANY" } })], world());
  assert.equal(set.comments.length, 1);
  assert.equal(set.skipped.evidenceMoved, 0);
});
