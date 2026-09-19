/**
 * Signing a class the pull request DELETES signs the deletion, and covers the members it
 * deletes with it (triage run 2026-09-19-post-round-review, Item D: "Should probably land
 * both"; Q5 counts them). This reverses branch-review-round P-3, which followed the
 * earlier "deleted code is not signable". A LIVE class still covers a member the change
 * deleted: that is the case `9bc78a0`'s cover exemption was written for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { team, who, edit, commit, branch, pushBranch, openPr, SEED } from "./oracle.js";
import { pr, prStepMark, prChapterMark, prWalkthroughSet, prWalkthroughGet } from "./ops.js";
import { readReviews } from "./store.js";

const LEDGER = "export class Ledger {\n  post(x: number) {\n    return x + 1;\n  }\n  void(x: number) {\n    return x - 1;\n  }\n}\n";
const A = "ana@acme.test";

async function deletingPr(n: number, after: string | null) {
  const t = await team([A], { seed: { ...SEED, "src/ledger.ts": LEDGER } });
  const a = who(t, A);
  branch(a, `feature/${n}`, { create: true });
  edit(a, { "src/ledger.ts": after });
  const head = commit(a, "change the ledger");
  pushBranch(a, `feature/${n}`);
  openPr(a, n, { sha: head });
  branch(a, "main");
  const r = await pr(a.repo, String(n)) as any;
  assert.equal(r.error, undefined, String(r.error));
  const find = (s: string) => r.worklist.find((w: any) => w.symbol.replace(/ › /g, ".").endsWith(s))!;
  return { t, repo: a.repo, cls: find("Ledger"), post: find("Ledger.post"), void_: find("Ledger.void") };
}

const covered = async (repo: string) =>
  (await readReviews(repo)).reviews.filter((r) => r.coveredBy).map((r) => r.target.id);

test("signing a deleted class, one symbol at a time, signs it and covers its members", async () => {
  const f = await deletingPr(31, null);
  try {
    assert.ok(f.cls && f.post, "the removed class and its members are on the worklist");
    const r = await prStepMark(f.repo, "31", f.cls.id, { attestation: "signed" }) as any;
    assert.equal(r.error, undefined, String(r.error));
    assert.equal(r.unwitnessed, undefined, "the deletion is signable");
    assert.deepEqual((await covered(f.repo)).sort(), [f.post.id, f.void_.id].sort(), "and its members with it");
  } finally { f.t.dispose(); }
});

test("signing a chapter that walks a deleted class covers its members", async () => {
  const f = await deletingPr(32, null);
  try {
    const w = await prWalkthroughSet(f.repo, "32", [{
      title: "Ledger", summary: "the ledger goes",
      chapters: [{ title: "Removal", blocks: [{ kind: "symbol", anchorId: f.cls.id }] }],
    }]) as any;
    assert.equal(w.error, undefined, JSON.stringify(w));
    const chapter = ((await prWalkthroughGet(f.repo, "32")) as any).walkthrough.features[0].chapters[0].id;
    const r = await prChapterMark(f.repo, "32", chapter, { attestation: "signed" }) as any;
    assert.equal(r.error, undefined, String(r.error));
    assert.deepEqual((await covered(f.repo)).sort(), [f.post.id, f.void_.id].sort());
  } finally { f.t.dispose(); }
});

test("a live class still covers a member the change deleted", async () => {
  const f = await deletingPr(33, "export class Ledger {\n  post(x: number) {\n    return x + 2;\n  }\n}\n");
  try {
    const r = await prStepMark(f.repo, "33", f.cls.id, { attestation: "signed" }) as any;
    assert.equal(r.error, undefined, String(r.error));
    assert.equal(r.unwitnessed, undefined);
    assert.ok((await covered(f.repo)).includes(f.void_.id), "the deleted member is covered by its live class");
  } finally { f.t.dispose(); }
});
