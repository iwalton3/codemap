import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { State } from "./schema.js";
import { writeStore, readViewedImports, writeViewedImport } from "./store.js";
import { viewedTargetsFor } from "./pr-push.js";
import { prBaseCommit, mergeBase } from "./git.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;

test("viewedTargetsFor reads only the changed, reviewable files — never the whole tree", async () => {
  const read: string[][] = [];
  const r = await viewedTargetsFor("/nope", { baseRef: "develop", headSha: "head" }, {
    mergeBase: () => "mb",
    changedFiles: () => ["src/pay.cs", "tests/pay.cs", "gen/x.g.cs", "docs/spec.md"],
    readBlobs: (_r, _s, paths) => { read.push(paths); return new Map(paths.map((p) => [p, "class X {}"])); },
    indexBlob: async (_src, path) => [{ id: "a_" + path, bodyHash: "sha256:" + path }],
    // stand-in lane classifier: only src/ is the review queue
    lane: (p) => (p.startsWith("src/") ? "code" : p.startsWith("tests/") ? "test" : p.endsWith(".md") ? "spec" : "generated"),
  });
  assert.ok(!("error" in r));
  if ("error" in r) return;
  assert.deepEqual(read[0], ["src/pay.cs"], "tests, generated and spec files are never even read");
  assert.deepEqual([...r.byFile.keys()], ["src/pay.cs"]);
  assert.equal(r.byFile.get("src/pay.cs")![0]!.hash, "sha256:src/pay.cs", "the head body is the witness");
});

test("viewedTargetsFor reports a missing merge-base rather than guessing one", async () => {
  const r = await viewedTargetsFor("/nope", { baseRef: "gone", headSha: "head" }, {
    mergeBase: () => null,
    changedFiles: () => [], readBlobs: () => new Map(), indexBlob: async () => [], lane: () => "code",
  });
  assert.ok("error" in r);
});

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
