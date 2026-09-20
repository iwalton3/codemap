/**
 * Which commit a deletion is measured from (triage run 2026-09-19-deletion-fixes-review, Q2):
 * the change's OWN base — a PR's base, a branch's trunk merge-base, a diff's `<a>` — not
 * always where the head left the trunk. Stacked PRs and PRs merged with a merge commit are
 * the two shapes where those differ.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { reportDefect } from "./ops/defect.js";
import { init } from "./ops.js";
import { readSnapshot } from "./snapshots.js";
import { computeDiff } from "./diff.js";
import { markReviewedBatch, reviewStatesFor } from "./reviews.js";
import { findingBacklog } from "./ops-shared.js";
import { readFindings, writeLocalFinding } from "./store.js";
import { discard } from "./test-tmp.js";

const PAY = "export function transfer(cents: number) {\n  return cents;\n}\n";
const FOO = "export function foo(x: number) {\n  return x * 2;\n}\n";

function gitIn(root: string) {
  return (...a: string[]) => {
    const r = spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=izzie", ...a], { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
}

/** main has `transfer`; `parent` adds `foo`; `child` (cut from parent) deletes it. */
async function stacked() {
  const base = mkdtempSync(join(tmpdir(), "codemap-delbase-"));
  const root = join(base, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".codemap"), { recursive: true });
  const git = gitIn(root);
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "src/pay.ts"), PAY);
  writeFileSync(join(root, ".gitignore"), ".codemap/\n");
  git("add", "-A"); git("commit", "-q", "-m", "main");
  git("checkout", "-q", "-b", "parent");
  writeFileSync(join(root, "src/foo.ts"), FOO);
  git("add", "-A"); git("commit", "-q", "-m", "add foo");
  const parentSha = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", "child");
  git("rm", "-q", "src/foo.ts"); git("commit", "-q", "-m", "delete foo");
  const childSha = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  await init(root);
  const foo = (await readSnapshot(root, parentSha))!.find((a) => a.symbolPath.at(-1) === "foo")!;
  await readSnapshot(root, childSha);
  return { root, git, parentSha, childSha, foo, cleanup: () => discard(base) };
}

/** main has `foo`; `feature` deletes it and is merged back with a merge commit. */
async function mergedWithMergeCommit() {
  const base = mkdtempSync(join(tmpdir(), "codemap-delmerged-"));
  const root = join(base, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".codemap"), { recursive: true });
  const git = gitIn(root);
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "src/pay.ts"), PAY);
  writeFileSync(join(root, "src/foo.ts"), FOO);
  writeFileSync(join(root, ".gitignore"), ".codemap/\n");
  git("add", "-A"); git("commit", "-q", "-m", "main");
  const baseSha = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", "feature");
  git("rm", "-q", "src/foo.ts"); git("commit", "-q", "-m", "delete foo");
  const headSha = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  git("merge", "-q", "--no-ff", "-m", "merge feature", "feature");
  await init(root);
  const foo = (await readSnapshot(root, baseSha))!.find((a) => a.symbolPath.at(-1) === "foo")!;
  await readSnapshot(root, headSha);
  return { root, baseSha, headSha, foo, cleanup: () => discard(base) };
}

const onPr = (root: string, targetId: string, ref: string, base?: string) => reportDefect(root, {
  context: { kind: "pull_request", pr: "7" }, targetKind: "anchor", targetId, ref, ...(base ? { base } : {}),
  text: "the evidence", comment: "callers still need this", severity: "medium",
}) as Promise<Record<string, unknown>>;

test("a stacked PR's finding on a symbol its parent added is a deletion, measured from the PR's base", async () => {
  const u = await stacked();
  try {
    const r = await onPr(u.root, "src/foo.ts#foo", u.childSha, u.parentSha);
    assert.equal(r.error, undefined, String(r.error));
    assert.equal(r.id !== undefined, true);
  } finally { u.cleanup(); }
});

test("a stacked BRANCH with no PR still measures from the trunk, so it is refused — it declares no parent", async () => {
  const u = await stacked();
  try {
    const r = await reportDefect(u.root, {
      context: { kind: "branch", branch: "child" }, targetKind: "anchor", targetId: "src/foo.ts#foo",
      text: "e", comment: "c", severity: "medium",
    }) as Record<string, unknown>;
    assert.match(String(r.error), /merge-base with main/);
    assert.doesNotMatch(String(r.error), /not pushed/, "the unpushed-commits hint is for PRs only");
  } finally { u.cleanup(); }
});

test("a stacked PR's deletion is signable at its base, and the diff reaches done", async () => {
  const u = await stacked();
  try {
    const batch = await markReviewedBatch(u.root, [u.foo.id], { level: "code", actor: "human", attestation: "signed", ref: u.childSha, base: u.parentSha });
    assert.equal(batch.unwitnessed, undefined);
    const st = (await reviewStatesFor(u.root, [{ kind: "anchor", id: u.foo.id }], { ref: u.childSha, base: u.parentSha })).get(`anchor:${u.foo.id}`)!;
    assert.equal(st.code.state, "reviewed");
    const d = await computeDiff(u.root, u.parentSha, u.childSha);
    if ("error" in d) throw new Error(d.error);
    assert.equal(d.removed.length, 1);
    assert.equal(d.coverage.outstanding, 0, JSON.stringify(d.coverage));
  } finally { u.cleanup(); }
});

test("a PR merged with a merge commit still takes findings and sign-offs on what it deleted", async () => {
  const u = await mergedWithMergeCommit();
  try {
    const r = await onPr(u.root, "src/foo.ts#foo", u.headSha, u.baseSha);
    assert.equal(r.error, undefined, String(r.error));
    const m = await markReviewedBatch(u.root, [u.foo.id], { level: "code", actor: "human", attestation: "signed", ref: u.headSha, base: u.baseSha });
    assert.equal(m.unwitnessed, undefined);
  } finally { u.cleanup(); }
});

const landedOf = async (root: string, id: string) => {
  const b = await findingBacklog(root, { asOf: "2026-09-19" });
  const rows = [b.due, b.woken, b.sleeping, b.live, b.moved, b.unjudgeable, b.unfetched, b.inReview].flat() as { id: string; landed: string }[];
  return rows.find((r) => r.id === id);
};

test("a stacked PR's deletion of code the trunk never held reads open until the change itself lands (Q8)", async () => {
  // Gone from the trunk tip is true at filing — the trunk never had `foo` — so the shortcut
  // that lands a deletion of trunk code would call this landed before anything merged.
  const u = await stacked();
  try {
    const r = await onPr(u.root, "src/foo.ts#foo", u.childSha, u.parentSha);
    assert.equal(r.error, undefined, String(r.error));
    assert.equal((await landedOf(u.root, String(r.id)))?.landed, "open");
  } finally { u.cleanup(); }
});

test("a deletion witnessed under another build's id derivation does not read landed on absence (I10)", async () => {
  const u = await mergedWithMergeCommit();
  try {
    // Filed on a branch that is NOT merged, so only the tip shortcut could call it landed.
    const git = gitIn(u.root);
    git("checkout", "-q", "-b", "other", u.baseSha);
    git("rm", "-q", "src/pay.ts"); git("commit", "-q", "-m", "delete pay");
    const other = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    const r = await onPr(u.root, "src/pay.ts#transfer", other, u.baseSha);
    assert.equal(r.error, undefined, String(r.error));
    const key = "7";
    const f = (await readFindings(u.root, { pr: key })).findings.find((x) => x.id === r.id)!;
    // The same deletion as another build would spell it: an id this build never minted, and
    // a hash marked with a derivation it does not have.
    f.witness = { anchorId: "a_" + "e".repeat(64), bodyHash: "h2:ffffffffffffffff:sha256:" + "d".repeat(64), deleted: true };
    await writeLocalFinding(u.root, f, key);
    assert.notEqual((await landedOf(u.root, String(r.id)))?.landed, "landed");
  } finally { u.cleanup(); }
});
