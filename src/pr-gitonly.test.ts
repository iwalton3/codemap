import { test } from "node:test";
import assert from "node:assert/strict";
import { team, who, edit, commit, branch, pushBranch, openPr, mergeBranch, type Team, type Member } from "./oracle.js";
import { prMetaFromGit, prBranchFor, defaultBaseRef, type PrMeta } from "./pr.js";
import { pr } from "./ops.js";

/**
 * PR review with no `gh` anywhere in the loop.
 *
 * These run against a local bare origin, which has no GitHub slug — so `prContext`
 * takes the git path by the same rule production uses, rather than by a flag a test
 * had to remember to set. That the fixtures are reachable AT ALL is the point being
 * made: `refs/pull/N/head` is served by the remote, forks included.
 */

const A = "ana@acme.test";
const B = "ben@acme.test";

/**
 * One member unless a test needs two. Every fixture clones a repo, indexes it and
 * builds a sidecar, and all but one of these tests only ever look at A.
 */
const withTeam = async (fn: (t: Team) => Promise<void>, principals: string[] = [A]) => {
  const t = await team(principals);
  try { await fn(t); } finally { t.dispose(); }
};

/** A branch with one real change on it, pushed, plus its pull ref. */
function proposeChange(m: Member, name: string, n: number, opts: { fork?: boolean } = {}): string {
  branch(m, name, { create: true });
  edit(m, {
    "src/pay.ts":
      "export function transfer(amount: number, to: string) {\n"
      + "  if (amount <= 0) throw new Error(\"amount must be positive\");\n"
      + "  if (!to) throw new Error(\"payee required\");\n"
      + "  return { to, amount, at: \"now\" };\n"
      + "}\n\n"
      + "export function refund(amount: number, to: string) {\n"
      + "  return transfer(-amount, to);\n"
      + "}\n",
  });
  const head = commit(m, `guard the payee on ${name}`);
  // A fork's head is on somebody else's repository: it reaches this origin as a pull
  // ref and as no branch at all.
  if (!opts.fork) pushBranch(m, name);
  openPr(m, n, { sha: head });
  branch(m, "main");
  return head;
}

test("a same-origin PR resolves with no gh, and recovers its branch name", async () => {
  await withTeam(async (t) => {
    const a = who(t, A);
    const head = proposeChange(a, "feature/payee-guard", 11);

    const r = await pr(a.repo, "11") as any;
    assert.equal(r.error, undefined, `pr triage failed: ${r.error}`);
    assert.equal(r.pr.source, "git", "resolved without gh");
    assert.equal(r.pr.headSha, head);
    assert.equal(r.pr.headRef, "feature/payee-guard", "the branch name came back from ls-remote");
    assert.equal(r.pr.baseRef, "main");
    assert.equal(r.refs.mergeBase, r.pr.baseSha, "the base is the fork point, not the tip");
    assert.deepEqual(r.files.map((f: any) => f.path), ["src/pay.ts"]);
    assert.ok(r.worklist.length > 0, "and the changed symbol is on the worklist");
  });
});

test("a FORK's PR resolves too — the case gh was thought to be required for", async () => {
  await withTeam(async (t) => {
    const a = who(t, A);
    const head = proposeChange(a, "fork/payee-guard", 12, { fork: true });

    const r = await pr(a.repo, "12") as any;
    assert.equal(r.error, undefined, `pr triage failed: ${r.error}`);
    assert.equal(r.pr.headSha, head);
    // CONTROL for the test above: this head is a branch on NO remote here, so there
    // is no name to recover and the pull ref is the only identity it has. If this
    // came back as a branch name, `prBranchFor` would be matching something other
    // than what it claims to.
    assert.equal(r.pr.headRef, "pull/12/head");
    assert.equal(prBranchFor(a.repo, head), null, "the fork's head is in no origin branch");
    assert.deepEqual(r.files.map((f: any) => f.path), ["src/pay.ts"]);
  });
});

test("a MERGED PR does not read as changing nothing", async () => {
  // The collapse this guards: once a head is merged it is an ancestor of the base
  // tip, so merge-base(tip, head) is the head and every merged PR in the back
  // catalogue reports an empty diff. GitHub's recorded base sha is what solves it
  // for `gh` users and is exactly what git cannot be told.
  await withTeam(async (t) => {
    const a = who(t, A);
    const head = proposeChange(a, "feature/landed", 13);
    mergeBranch(a, "feature/landed");
    pushBranch(a, "main");

    const meta = prMetaFromGit(a.repo, 13, null) as PrMeta;
    assert.equal("error" in meta, false, `resolution failed: ${(meta as any).error}`);
    assert.equal(meta.state, "MERGED");
    assert.notEqual(meta.baseSha, head, "the base must not collapse onto the head");
    assert.equal(meta.changedFiles, 1);
    assert.ok(meta.additions > 0, "and the change is still visible");

    const r = await pr(a.repo, "13") as any;
    assert.equal(r.error, undefined, `pr triage failed: ${r.error}`);
    assert.deepEqual(r.files.map((f: any) => f.path), ["src/pay.ts"]);
  });
});

test("an unmerged PR reports its own facts, not a merged one's", async () => {
  // CONTROL for the merged case: the recovery path must not fire on an open PR, or
  // "MERGED" means nothing and the first-parent walk is picking up unrelated merges.
  await withTeam(async (t) => {
    const a = who(t, A);
    proposeChange(a, "feature/open", 14);
    const meta = prMetaFromGit(a.repo, 14, null) as PrMeta;
    assert.equal(meta.state, "UNKNOWN", "git cannot know an open PR's state, and says so");
    assert.equal(meta.source, "git");
  });
});

test("re-reading a PR after a push sees the push", async () => {
  // The failure this guards is silent and it would have poisoned every long
  // scenario: resolution is cached for 60 seconds, a test runs in milliseconds, so
  // a step that pushes and then re-reads is handed the head from before its own
  // push and asserts against state it did not produce.
  await withTeam(async (t) => {
    const a = who(t, A);
    proposeChange(a, "feature/moving", 15);
    const first = await pr(a.repo, "15") as any;

    branch(a, "feature/moving");
    edit(a, { "src/ledger.ts": "export class Ledger {\n  post(e: { amount: number }) { return e.amount; }\n  reverse(e: { amount: number }) { return -e.amount; }\n}\n" });
    const second = commit(a, "add reverse");
    pushBranch(a, "feature/moving");
    openPr(a, 15, { branch: "feature/moving" });
    branch(a, "main");

    const again = await pr(a.repo, "15") as any;
    assert.notEqual(again.pr.headSha, first.pr.headSha, "the second read must not be the first read");
    assert.equal(again.pr.headSha, second);
    assert.deepEqual(
      again.files.map((f: any) => f.path).sort(), ["src/ledger.ts", "src/pay.ts"],
      "and the newly pushed file is in the review",
    );
  });
});

test("a PR that does not target the default branch needs its base saying", async () => {
  // `refs/pull/N/head` is a head commit and nothing else, so a PR onto `release`
  // looks exactly like a PR onto `main`. Guessing the default silently attributes
  // every commit `release` has that `main` does not to this author's change. The
  // guess is flagged, and an explicit base is honoured.
  await withTeam(async (t) => {
    const a = who(t, A);
    branch(a, "release", { create: true });
    edit(a, { "src/release-only.ts": "export function releaseOnly() { return 1; }\n" });
    commit(a, "release-only work");
    pushBranch(a, "release");

    branch(a, "feature/onto-release", { create: true });
    edit(a, { "src/settle.py": "def settle(batch):\n    return sum(i['amount'] for i in batch)\n\ndef reconcile(a, b):\n    return abs(a - b)\n" });
    const head = commit(a, "reconcile by absolute difference");
    pushBranch(a, "feature/onto-release");
    openPr(a, 21, { branch: "feature/onto-release" });
    branch(a, "main");

    const guessed = prMetaFromGit(a.repo, 21, null) as PrMeta;
    assert.equal(guessed.baseRef, "main", "with nothing to go on it takes the remote default");
    assert.equal(guessed.baseInferred, true, "and says the base is a guess, because a wrong base is a wrong diff");
    assert.equal(guessed.changedFiles, 2, "the guess drags release's own work into this PR");

    const told = prMetaFromGit(a.repo, 21, null, "origin", { base: "release" }) as PrMeta;
    assert.equal(told.baseRef, "release");
    assert.equal(told.baseInferred, undefined, "a base that was given is not a guess");
    assert.equal(told.headSha, head);
    assert.equal(told.changedFiles, 1, "and the review is only what this branch actually changed");
  });
});

test("a number with no pull ref says what is wrong", async () => {
  await withTeam(async (t) => {
    const a = who(t, A);
    const r = prMetaFromGit(a.repo, 999, null) as { error: string };
    assert.match(r.error, /no refs\/pull\/999\/head/);
    assert.match(r.error, /without `gh`/, "and names the mechanism, so the fix is findable");
  });
});

test("the base branch comes from the remote's own default", async () => {
  await withTeam(async (t) => {
    assert.equal(defaultBaseRef(who(t, B).repo), "main");
  }, [A, B]);
});
