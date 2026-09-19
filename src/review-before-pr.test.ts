/**
 * Reviewing a branch before its pull request exists (docs/plan-review-before-pr.md, Part B).
 *
 * The fixture is the case the feature was asked for: `main` in the root, branch `feature`
 * in a LINKED WORKTREE that adds `IdentifierFilter` and holds one uncommitted method. A
 * finding is filed against the branch, and it shows under the pull request once the
 * pull request is linked to the branch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { reportDefect } from "./ops/defect.js";
import { init, reviewQueue } from "./ops.js";
import { readFindings, readAnchorStore } from "./store.js";
import { readSnapshot } from "./snapshots.js";
import { findingKeyScope, branchKey, normalizeBranch, assertFindingKey } from "./review-target.js";
import { foldReviewLinks } from "./shared-reviews.js";
import type { LogEvent } from "./eventlog.js";
import { discard } from "./test-tmp.js";

const FILTER = "export class IdentifierFilter {\n  matches(id: string) {\n    return id.length > 0;\n  }\n}\n";

async function worktreeRepo(withSidecar: boolean) {
  const base = mkdtempSync(join(tmpdir(), "codemap-prepr-"));
  const root = join(base, "repo");
  const wt = join(base, "wt");
  const side = join(base, "side");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".codemap"), { recursive: true });
  const git = (cwd: string, ...a: string[]) => {
    const r = spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=izzie", ...a], { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "izzie@x.com"); git(root, "config", "user.name", "izzie");
  writeFileSync(join(root, "src/pay.ts"), "export function transfer(cents: number) {\n  return cents;\n}\n");
  writeFileSync(join(root, ".gitignore"), ".codemap/\n");
  if (withSidecar) writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
  git(root, "add", "-A"); git(root, "commit", "-q", "-m", "main");
  git(root, "checkout", "-q", "-b", "feature");
  writeFileSync(join(root, "src/filter.ts"), FILTER);
  git(root, "add", "-A"); git(root, "commit", "-q", "-m", "feature");
  const featureSha = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
  git(root, "worktree", "add", "-q", wt, "feature");
  // A method that exists only in the worktree's uncommitted edits.
  writeFileSync(join(wt, "src/filter.ts"), FILTER.replace("\n}\n", "\n  clear() {\n    return 0;\n  }\n}\n"));
  await init(root);
  const filter = (await readSnapshot(root, featureSha))!.find((a) => a.symbolPath.join("#").endsWith("matches"))!;
  return { root, wt, featureSha, filter, cleanup: () => discard(base) };
}

const file = (root: string, targetId: string, branch = "feature") => reportDefect(root, {
  context: { kind: "branch", branch },
  targetKind: "anchor", targetId,
  text: "the evidence", comment: "empty ids match nothing", severity: "medium",
}) as Promise<Record<string, unknown>>;

test("a branch key scopes by a hash of the name, and a PR number as before", () => {
  const cfg = { path: "/x", universe: "acme/api" };
  assert.equal(findingKeyScope(cfg, 17), "acme/api/pr-17");
  assert.equal(findingKeyScope(cfg, "#17"), "acme/api/pr-17");
  const a = findingKeyScope(cfg, branchKey("feature/x"));
  assert.match(a, /^acme\/api\/b-[0-9a-f]{40}$/);
  assert.equal(findingKeyScope(cfg, branchKey("feature/x")), a, "derived, so two people land in one scope");
  assert.notEqual(findingKeyScope(cfg, branchKey("Feature/x")), a, "case is not folded");
  assert.notEqual(findingKeyScope({ ...cfg, universe: "acme/react" }, branchKey("feature/x")), a, "per universe");
  assert.notEqual(findingKeyScope(cfg, branchKey("pr-17")), findingKeyScope(cfg, 17), "a branch named pr-17 is not PR 17");
  assert.throws(() => findingKeyScope(cfg, "https://github.com/o/r/pull/5"));
  assert.throws(() => findingKeyScope(cfg, branchKey("")));
});

test("the link fold keeps one row per pair and drops malformed links", () => {
  const ev = (data: Record<string, unknown>) => ({ kind: "review.linked", data } as unknown as LogEvent);
  assert.deepEqual(foldReviewLinks([
    ev({ pr: "12", branch: "feature" }), ev({ pr: "12", branch: "feature" }),
    ev({ pr: "12", branch: "feature-renamed" }), ev({ pr: "x", branch: "feature" }), ev({ pr: "13" }),
  ]), [{ pr: "12", branch: "feature" }, { pr: "12", branch: "feature-renamed" }]);
});

for (const withSidecar of [true, false]) {
  const where = withSidecar ? "through the sidecar" : "with no sidecar";

  test(`a branch finding is witnessed at the branch head, and filed under the branch (${where})`, async () => {
    const u = await worktreeRepo(withSidecar);
    try {
      const out = await file(u.root, "src/filter.ts#IdentifierFilter.matches");
      assert.equal(out.error, undefined, String(out.error));
      assert.equal(out.branch, "feature");
      const [f] = (await readFindings(u.root, { pr: branchKey("feature") })).findings;
      assert.ok(f, "a row under the branch key");
      assert.equal(f.target.id, u.filter.id);
      assert.equal(f.witness?.bodyHash, u.filter.bodyHash, "the committed body");
      assert.equal(f.sourceRef, u.featureSha);
      assert.equal((await readAnchorStore(u.root)).anchors.some((a) => a.id === u.filter.id), false,
        "and the root checkout never had the symbol");
    } finally { u.cleanup(); }
  });

  test(`a target that exists only in uncommitted edits is refused, and says why (${where})`, async () => {
    const u = await worktreeRepo(withSidecar);
    try {
      const out = await file(u.root, "src/filter.ts#IdentifierFilter.clear");
      assert.match(String(out.error), /uncommitted changes/);
      assert.match(String(out.error), /Commit it/);
    } finally { u.cleanup(); }
  });

  test(`once the pull request is linked, its reads include the branch's findings (${where})`, async () => {
    const u = await worktreeRepo(withSidecar);
    try {
      await file(u.root, "src/filter.ts#IdentifierFilter.matches");
      assert.equal((await readFindings(u.root, { pr: 12 })).findings.length, 0, "not before the link");
      const shared = await import("./ops-shared.js");
      const l = await shared.linkReviewOp(u.root, "12", "feature") as Record<string, unknown>;
      assert.equal(l.error, undefined, String(l.error));
      assert.equal((await shared.linkReviewOp(u.root, "12", "feature") as Record<string, unknown>).already, true);

      const [f] = (await readFindings(u.root, { pr: 12 })).findings;
      assert.ok(f, "under the pull request");
      assert.equal(f.pr, branchKey("feature"), "keeping its own key, which is where its events live");
      const listed = await reviewQueue(u.root, { pr: "12", assignedOnly: false, brief: true } as never) as { items?: { id: string }[] };
      assert.ok(JSON.stringify(listed).includes(f.id), "and in the `findings` list for the pull request");
      if (withSidecar) {
        const s = await shared.sharedFindings(u.root, 12) as { findings?: { id: string }[] };
        assert.ok(JSON.stringify(s).includes(f.id), "and in `shared_findings`");
      }
    } finally { u.cleanup(); }
  });
}

test("a branch finding's verdict is judged at the branch, not the checkout answering", async () => {
  // The main checkout is on `main`, which does not contain the branch commit the finding
  // was witnessed at. Judged against the checkout, every verdict on a branch finding made
  // through it would be refused as "the checkout lacks the code".
  const u = await worktreeRepo(true);
  try {
    const out = await file(u.root, "src/filter.ts#IdentifierFilter.matches");
    const shared = await import("./ops-shared.js");
    const v = await shared.corroborateFinding(u.root, branchKey("feature"), String(out.id), "confirm", "read it at the head") as Record<string, unknown>;
    assert.equal(v.error, undefined, String(v.error));
  } finally { u.cleanup(); }
});

test("a pull request is linked only when gh says its head is in this repository", async () => {
  const u = await worktreeRepo(true);
  try {
    const { observePrBranch } = await import("./ops-shared.js");
    const { linkedBranches } = await import("./store.js");
    await observePrBranch(u.root, { number: 20, headRef: "feature", source: "gh", crossRepo: true });
    await observePrBranch(u.root, { number: 21, headRef: "feature", source: "gh" });
    await observePrBranch(u.root, { number: 22, headRef: "feature", source: "git", crossRepo: false });
    assert.deepEqual([20, 21, 22].map((n) => linkedBranches(u.root, n).length), [0, 0, 0],
      "a fork, an unknown origin, and a git-derived meta are never linked");
    await observePrBranch(u.root, { number: 23, headRef: "feature", source: "gh", crossRepo: false });
    assert.deepEqual(linkedBranches(u.root, 23), ["feature"]);
  } finally { u.cleanup(); }
});

const gitIn = (cwd: string, ...a: string[]) => {
  const r = spawnSync("git", a, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

test("a branch name has one spelling: refs/heads/ and origin/ are stripped, revisions and other remotes refused", async () => {
  const u = await worktreeRepo(false);
  try {
    gitIn(u.root, "update-ref", "refs/remotes/origin/only-remote", u.featureSha);
    gitIn(u.root, "update-ref", "refs/remotes/upstream/feature", u.featureSha);
    const name = (raw: string) => { const n = normalizeBranch(u.root, raw); return "name" in n ? n.name : "ERR"; };
    assert.equal(name("feature"), "feature");
    assert.equal(name("refs/heads/feature"), "feature");
    assert.equal(name("origin/only-remote"), "only-remote", "a reviewer who never checked the branch out");
    assert.equal(name("refs/remotes/origin/only-remote"), "only-remote");
    assert.equal(name("merged-and-deleted"), "merged-and-deleted", "existence is not required to READ a branch");
    for (const bad of ["HEAD", "feature~1", "HEAD~1", u.featureSha, "upstream/feature", "main@{1}"]) {
      assert.equal(name(bad), "ERR", bad);
    }
    assert.throws(() => assertFindingKey(branchKey("HEAD~1")));
    assert.doesNotThrow(() => assertFindingKey(branchKey("feature/x")));
  } finally { u.cleanup(); }
});

for (const withSidecar of [true, false]) {
  test(`every spelling of one branch files into one review, and a revision is refused (${withSidecar ? "sidecar" : "no sidecar"})`, async () => {
    const u = await worktreeRepo(withSidecar);
    try {
      gitIn(u.root, "update-ref", "refs/remotes/origin/feature", u.featureSha);
      for (const spelling of ["feature", "refs/heads/feature", "origin/feature"]) {
        const out = await file(u.root, "src/filter.ts#IdentifierFilter.matches", spelling);
        assert.equal(out.error, undefined, `${spelling}: ${out.error}`);
        assert.equal(out.branch, "feature", spelling);
      }
      assert.equal((await readFindings(u.root, { pr: branchKey("feature") })).findings.length, 3);
      for (const bad of ["HEAD", "HEAD~1", u.featureSha]) {
        assert.match(String((await file(u.root, "src/filter.ts#IdentifierFilter.matches", bad)).error), /not a branch name/, bad);
      }
    } finally { u.cleanup(); }
  });
}

test("link_review stores the normalized name", async () => {
  const u = await worktreeRepo(false);
  try {
    const shared = await import("./ops-shared.js");
    const { linkedBranches } = await import("./store.js");
    await shared.linkReviewOp(u.root, "12", "refs/heads/feature");
    assert.deepEqual(linkedBranches(u.root, 12), ["feature"]);
    assert.match(String((await shared.linkReviewOp(u.root, "12", "HEAD") as Record<string, unknown>).error), /not a branch name/);
  } finally { u.cleanup(); }
});
