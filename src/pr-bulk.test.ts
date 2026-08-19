import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { State } from "./schema.js";
import { writeStore, readViewedImports, writeViewedImport } from "./store.js";
import { surveyViewed, viewedPaths, changedSymbolsIn } from "./pr-bulk.js";
import { prBaseCommit, mergeBase } from "./git.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;



test("import progress is recorded per PR so a long run resumes instead of restarting", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-bulk-"));
  try {
    await writeStore(root, [], state);
    assert.deepEqual((await readViewedImports(root)).imported, {});
    await writeViewedImport(root, "94", 124);
    await writeViewedImport(root, "227", 0);
    const got = (await readViewedImports(root)).imported;
    assert.equal(got["94"]!.marked, 124);
    assert.ok(got["227"], "a PR that yielded nothing is still recorded — otherwise it is retried forever");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * The bug this pins: once a PR is merged, its head is an ancestor of the base
 * branch, so `merge-base(tip, head)` is the head and the PR reads as changing
 * nothing. It emptied 67 of 69 PRs on a real back-catalogue import before it was
 * caught, and it silently produced *plausible* zeros rather than an error.
 */
test("a merged PR still resolves to the commit it forked from", () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-base-"));
  try {
    const git = (...a: string[]) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: root, encoding: "utf8" });
    const sha = () => spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    git("init", "-q", "-b", "develop");
    writeFileSync(join(root, "a.txt"), "base\n"); git("add", "-A"); git("commit", "-qm", "base");
    const forkPoint = sha();

    git("checkout", "-q", "-b", "feature");
    writeFileSync(join(root, "a.txt"), "feature\n"); git("add", "-A"); git("commit", "-qm", "feature");
    const head = sha();

    git("checkout", "-q", "develop");
    git("merge", "-q", "--no-ff", "feature", "-m", "merge");        // head is now an ancestor of develop
    writeFileSync(join(root, "b.txt"), "later\n"); git("add", "-A"); git("commit", "-qm", "later");
    // stand in for the remote-tracking ref the real code reads
    git("update-ref", "refs/remotes/origin/develop", sha());

    // the naive answer collapses to the head itself
    assert.equal(mergeBase(root, sha(), head), head, "precondition: the tip-based merge-base is the head");

    const resolved = prBaseCommit(root, { recordedBase: forkPoint, baseRef: "develop", headSha: head });
    assert.equal(resolved, forkPoint, "GitHub's recorded base recovers the real fork point");
    assert.notEqual(resolved, head);

    // and with no recorded base it refuses rather than returning the collapsed answer
    assert.notEqual(prBaseCommit(root, { recordedBase: null, baseRef: "develop", headSha: head }), head);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * An accepted set is documented "oldest first", and `resolveAcceptance` treats the
 * last entry on the ancestry as the current body. Two things broke that on the
 * first real import and between them read 1,148 of 3,724 marks back as `reverted`:
 * PRs walked newest-first, and every acceptance recorded the working tree's commit
 * instead of the PR's head — so the ancestry test had nothing to discriminate on.
 */
test("acceptances accumulate oldest-first, each stamped with its own PR head", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-order-"));
  try {
    await writeStore(root, [], state);
    const { markReviewedBatch } = await import("./reviews.js");
    const { readReviews } = await import("./store.js");

    // as the importer now runs: oldest PR first, each with its own head sha
    for (const [commit, hash] of [["c_old", "sha256:V1"], ["c_mid", "sha256:V2"], ["c_new", "sha256:V3"]] as const) {
      await markReviewedBatch(root, ["a_1"], {
        level: "code", actor: "human", attestation: "viewed", reviewer: "github-import",
        ref: commit, hashes: new Map([["a_1", hash]]),
      });
    }
    const entries = (await readReviews(root)).reviews[0]!.accepted![0]!.entries;
    assert.deepEqual(entries.map((e) => e.bodyHash), ["sha256:V1", "sha256:V2", "sha256:V3"], "oldest first");
    assert.deepEqual(entries.map((e) => e.commit), ["c_old", "c_mid", "c_new"], "each acceptance carries its own PR head, not the working tree's commit");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * The survey is a cheap GATE: whether a PR is imported at all rides on it. Every
 * way it could fail to answer used to be indistinguishable from "this pull request
 * has no viewed ticks", so the PR was counted in `surveyed`, never in `processed`
 * or `errors`, and nothing recorded that it had been skipped.
 */
const ghOk = (payload: unknown) => ({ ok: true, out: JSON.stringify(payload), err: "" });

test("a survey that cannot answer says so, instead of reading as 'no ticks'", () => {
  const files = (states: string[], hasNextPage = false) =>
    ({ pageInfo: { hasNextPage }, nodes: states.map((s) => ({ viewerViewedState: s })) });

  const survey = surveyViewed("o/r", [1, 2, 3, 4], {
    gh: () => ghOk({
      data: { repository: {
        p1: { files: files(["VIEWED", "UNVIEWED"]) },              // settled: has ticks
        p2: { files: files(["UNVIEWED", "UNVIEWED"]) },            // settled: none
        p3: { files: files(["UNVIEWED"], true) },                  // more pages, no tick yet
        // p4 missing from the response entirely
      } },
    }),
  });

  assert.equal(survey.get(1)!.viewed, 2 - 1);
  assert.ok(!survey.get(1)!.unknown);
  assert.ok(!survey.get(2)!.unknown, "a short file list with no ticks IS an answer");
  assert.equal(survey.get(3)!.unknown, true, "ticks may be past the first page — check it properly");
  assert.equal(survey.get(4)!.unknown, true, "a PR the response omits was not answered");
});

test("one inaccessible PR does not silently remove its whole batch", () => {
  // `gh api graphql` exits non-zero if ANY aliased PR in the batch is inaccessible,
  // and a batch is 20 pull requests.
  const numbers = Array.from({ length: 20 }, (_, i) => i + 1);
  const survey = surveyViewed("o/r", numbers, { gh: () => ({ ok: false, out: "", err: "Could not resolve to a PullRequest" }) });
  assert.equal(survey.size, 20);
  assert.ok(numbers.every((n) => survey.get(n)!.unknown), "all 20 are unresolved, not tick-free");

  // an unparseable response is the same kind of not-an-answer
  const garbled = surveyViewed("o/r", [7], { gh: () => ({ ok: true, out: "<html>", err: "" }) });
  assert.equal(garbled.get(7)!.unknown, true);
});

test("a viewed list that was not read to the end is an error, not a short answer", () => {
  // Returned as a success, the caller wrote a COMPLETED import record for a PR it
  // had only half read, so the rest was never retried without --force.
  let page = 0;
  const r = viewedPaths("o/r", 42, {
    gh: () => ghOk({ data: { repository: { pullRequest: { files: {
      pageInfo: { hasNextPage: true, endCursor: `c${page++}` },
      nodes: [{ path: `f${page}.cs`, viewerViewedState: "VIEWED" }],
    } } } } }),
  });
  assert.ok("error" in r, "an exhausted paginator must not look like a complete list");
  assert.match((r as { error: string }).error, /not read to the end/);

  // the ordinary case still returns the set
  const done = viewedPaths("o/r", 42, {
    gh: () => ghOk({ data: { repository: { pullRequest: { files: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{ path: "a.cs", viewerViewedState: "VIEWED" }, { path: "b.cs", viewerViewedState: "DISMISSED" }],
    } } } } }),
  });
  assert.ok(!("error" in done));
  assert.deepEqual([...(done as Set<string>)], ["a.cs"], "DISMISSED is not exposure");
});

test("a ticked file marks only the symbols the PR changed in it", async () => {
  // GitHub's unit is the file and codemap's is the symbol. A tick on a 30-symbol
  // file where the PR touched one method must not record exposure to the other 29:
  // GitHub never rendered them, and those marks would then satisfy `pr-push`'s
  // vetting gate. This ran inline and untested while a `pr-push` helper that did the
  // WRONG thing — every anchor in the file, off a tip-based merge-base — carried the
  // test asserting the property. That helper is gone; this is the path that runs.
  const index = async (src: string, path: string) =>
    src ? src.split("\n").filter(Boolean).map((l) => {
      const [name, body] = l.split("=");
      return { id: `${path}#${name}`, bodyHash: `sha256:${body}` };
    }) : [];

  const r = await changedSymbolsIn(
    new Map([["a.cs", "one=1\ntwo=CHANGED\nthree=3"]]),
    new Map([["a.cs", "one=1\ntwo=2\nthree=3"]]),
    index,
  );
  assert.deepEqual(r.ids, ["a.cs#two"], "only the method the PR touched");
  assert.equal(r.hashes.get("a.cs#two"), "sha256:CHANGED", "witnessed at the HEAD body");

  // a file the branch adds has no base side, so every symbol in it is changed
  const added = await changedSymbolsIn(new Map([["b.cs", "x=1\ny=2"]]), new Map(), index);
  assert.deepEqual(added.ids, ["b.cs#x", "b.cs#y"]);
});
