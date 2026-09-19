/**
 * A pull-request finding filed without `ref` is witnessed at the pull request's HEAD.
 *
 * It used to be witnessed at the working tree, which during a review is usually the base:
 * the base's body is still on the trunk, so the backlog read the finding as `landed`
 * before the pull request merged (owner, 2026-09-19: default to the head, refuse when it
 * cannot be found, and do not ask GitHub once per finding).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { team, who, edit, commit, branch, pushBranch, openPr, SEED } from "./oracle.js";
import { reportDefect } from "./ops/defect.js";
import { pr, checkStale } from "./ops.js";
import { findingBacklog } from "./ops-shared.js";
import { readFindings } from "./store.js";
import { clearPrMetaCache } from "./pr.js";

const LEDGER = "export class Ledger {\n  post(x: number) {\n    return x + 1;\n  }\n}\n";
const A = "ana@acme.test";

/** PR `n` changes `Ledger.post`; the reviewer is back on `main`, as a review usually is. */
async function reviewing(n: number) {
  const t = await team([A], { seed: { ...SEED, "src/ledger.ts": LEDGER } });
  const a = who(t, A);
  branch(a, `feature/${n}`, { create: true });
  edit(a, { "src/ledger.ts": LEDGER.replace("x + 1", "x + 2") });
  const head = commit(a, "post adds two");
  pushBranch(a, `feature/${n}`);
  openPr(a, n, { sha: head });
  branch(a, "main");
  return { t, a, head };
}

const file = (root: string, n: number, targetId: string, ref?: string) => reportDefect(root, {
  context: { kind: "pull_request", pr: String(n) },
  targetKind: "anchor", targetId, ...(ref ? { ref } : {}),
  text: "the evidence", comment: "post adds two", severity: "medium",
}) as Promise<Record<string, any>>;

test("with no ref, the finding is witnessed at the head, and is not landed before the merge", async () => {
  const { t, a, head } = await reviewing(41);
  try {
    const out = await file(a.repo, 41, "src/ledger.ts#Ledger.post");
    assert.equal(out.error, undefined, String(out.error));
    const f = (await readFindings(a.repo, { pr: 41 })).findings.find((x) => x.id === out.id)!;
    assert.equal(f.sourceRef, head, "the head, not the working tree");
    const row = Object.values(await findingBacklog(a.repo) as Record<string, unknown>)
      .flatMap((v) => (Array.isArray(v) ? v : [])).find((r: any) => r.id === out.id) as { landed?: string };
    assert.ok(row, "the finding is on the backlog listing");
    assert.notEqual(row.landed, "landed", "the base's body is on the trunk; the finding is about the head's");
  } finally { t.dispose(); }
});

test("the head the reviewer was shown is reused: a second finding resolves nothing", async () => {
  const { t, a, head } = await reviewing(42);
  try {
    assert.equal((await pr(a.repo, "42") as any).error, undefined);
    // Take the pull request off the remote and out of the metadata cache: any fresh
    // resolution now fails, so success can only come from the head already seen.
    spawnSync("git", ["update-ref", "-d", "refs/pull/42/head"], { cwd: t.codeOrigin });
    spawnSync("git", ["update-ref", "-d", "refs/remotes/origin/pr/42"], { cwd: a.repo });
    clearPrMetaCache();
    const out = await file(a.repo, 42, "src/ledger.ts#Ledger.post");
    assert.equal(out.error, undefined, String(out.error));
    assert.equal((await readFindings(a.repo, { pr: 42 })).findings[0]!.sourceRef, head);
  } finally { t.dispose(); }
});

test("a head that cannot be found is refused, and says to pass ref", async () => {
  const { t, a } = await reviewing(43);
  try {
    const out = await file(a.repo, 99, "src/ledger.ts#Ledger.post");
    assert.match(String(out.error), /pull request 99's head .* pass `ref`/);
    assert.deepEqual((await readFindings(a.repo, { pr: 99 })).findings, []);
  } finally { t.dispose(); }
});

test("a symbol only in the reviewer's unpushed commits is refused on the PR, and filed on the branch", async () => {
  // Owner, triage 2026-09-19-post-round-review Q12: the pull request's head is what it
  // holds; commits not pushed yet are the local branch's.
  const { t, a } = await reviewing(44);
  try {
    branch(a, "feature/44");
    edit(a, { "src/ledger.ts": LEDGER.replace("x + 1", "x + 2").replace("\n}\n", "\n  refund(x: number) {\n    return -x;\n  }\n}\n") });
    commit(a, "refund, not pushed");
    await checkStale(a.repo);   // the live index follows the checkout on its next refresh
    const out = await file(a.repo, 44, "src/ledger.ts#Ledger.refund");
    assert.match(String(out.error), /file it on your branch/);
    const onBranch = await reportDefect(a.repo, {
      context: { kind: "branch", branch: "feature/44" }, targetKind: "anchor", targetId: "src/ledger.ts#Ledger.refund",
      text: "evidence", comment: "refund is negative",
    }) as Record<string, unknown>;
    assert.equal(onBranch.error, undefined, String(onBranch.error));
  } finally { t.dispose(); }
});
