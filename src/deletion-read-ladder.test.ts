/**
 * A read that judges code resolves an anchor's file the same way the write that witnessed
 * it did (triage 2026-09-19-review-and-findings-systems, I12 / Q7).
 *
 * The write side has walked the full ladder since deletions existed — `@work`, then the
 * newest snapshot holding the id, then a retained orphan. Three READ sites looked in
 * `@work` alone, and a deletion citation's anchor is BY CONSTRUCTION absent from `@work`:
 * it was retained as an orphan precisely because it left the tree. So its file was never
 * handed to `liveAnchors`, the working-tree re-read every other citation kind gets never
 * happened, and a deletion coming back could not be seen until something else re-indexed.
 *
 * EXACTLY ONE record per fixture, and a re-index. The defect is masked whenever another
 * record cites the same file — that one drags the file into the set and the deletion
 * citation is found by accident. `deletion-bug.test.ts` passes for that reason and could
 * never have failed on this, which is why these are separate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, reindex } from "./ops.js";
import { reportDefect } from "./ops/defect.js";
import { acceptFinding, listBugs } from "./ops/bugs.js";
import { dashboard } from "./ops/overview.js";
import { branchKey } from "./review-target.js";
import { readAnchorStore, writeLocalFinding, readOrphans } from "./store.js";
import { findingBacklog } from "./ops-shared.js";
import { discard } from "./test-tmp.js";

const PAY = "export function transfer(c) {\n  return c;\n}\n\nexport function refund(c) {\n  return -c;\n}\n";
const WITHOUT_REFUND = PAY.split("export function refund")[0]!;

/** One deletion bug, and NOTHING else citing that file. */
async function oneDeletionBug() {
  const base = mkdtempSync(join(tmpdir(), "codemap-delladder-"));
  const root = join(base, "repo");
  const side = join(base, "side");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(side, { recursive: true });
  const git = (...a: string[]) => {
    const r = spawnSync("git", ["-c", "user.email=i@x.com", "-c", "user.name=i", ...a], { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "src/pay.ts"), PAY, "utf8");
  writeFileSync(join(root, ".gitignore"), ".codemap/\n", "utf8");
  git("add", "-A"); git("commit", "-qm", "main");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(root, "src/pay.ts"), WITHOUT_REFUND, "utf8");
  git("commit", "-qam", "delete refund");
  git("checkout", "-q", "main");
  writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
  await init(root);

  const f = await reportDefect(root, {
    context: { kind: "branch", branch: "feature" }, targetKind: "anchor", targetId: "src/pay.ts#refund",
    text: "the evidence", comment: "callers still need it", severity: "medium",
  }) as { id?: string; error?: string };
  if (f.error) throw new Error(f.error);
  git("merge", "-q", "--ff-only", "feature");
  await acceptFinding(root, branchKey("feature"), String(f.id));
  // RE-INDEX after the merge. Without this the assertions run through a stale `@work`
  // that still holds the deleted id, which is exactly how the older test was vacuous.
  await reindex(root);
  return { root, git, cleanup: () => discard(base) };
}

const possiblyFixed = async (root: string) =>
  (await listBugs(root, {}) as { bugs: { possiblyFixed?: boolean }[] }).bugs.filter((b) => b.possiblyFixed).length;

test("a deletion bug is re-read from the WORKING TREE, like every other citation", async () => {
  const u = await oneDeletionBug();
  try {
    assert.equal(await possiblyFixed(u.root), 0, "the symbol is gone, so the deletion still holds");
    const store = await readAnchorStore(u.root);
    assert.ok(!store.anchors.some((a) => a.file === "src/pay.ts" && a.symbolPath.at(-1) === "refund"),
      "and its id is NOT in @work — which is the whole reason the read has to look further");

    // Put it back in the working tree only. Nothing re-indexes; a live re-read is what
    // must see it, and that is the behaviour a deletion citation was missing.
    writeFileSync(join(u.root, "src/pay.ts"), PAY, "utf8");
    assert.equal(await possiblyFixed(u.root), 1, "the deletion came back — that is its drift");
  } finally { u.cleanup(); }
});

test("and the hub's own counts see it, which are a SECOND copy of the same read", async () => {
  const u = await oneDeletionBug();
  try {
    const count = async () => (await dashboard(u.root) as { bugs: { possiblyFixed: number } }).bugs.possiblyFixed;
    assert.equal(await count(), 0);
    writeFileSync(join(u.root, "src/pay.ts"), PAY, "utf8");
    // `dashboard` built its own file set rather than calling `drift`, so fixing the bugs
    // read left this one wrong by its own code path — the hub and the bugs page disagreed.
    assert.equal(await count(), 1);
  } finally { u.cleanup(); }
});

/**
 * The third site: `workIdx`, which judges findings when there is no trunk to judge them
 * against. Reachable in an ordinary GIT clone, not only a gitless one — a clone whose
 * remote has a single `feature` branch makes `defaultBranch` fall through to the literal
 * "main", which resolves nowhere. That is `clone --single-branch`, or any repository whose
 * trunk is named outside the known set.
 */
async function singleBranchClone() {
  const base = mkdtempSync(join(tmpdir(), "codemap-singlebranch-"));
  const origin = join(base, "origin.git");
  const root = join(base, "repo");
  spawnSync("git", ["init", "-q", "--bare", "-b", "feature", origin]);
  mkdirSync(join(root, "src"), { recursive: true });
  const git = (...a: string[]) => {
    const r = spawnSync("git", ["-c", "user.email=i@x.com", "-c", "user.name=i", ...a], { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q", "-b", "feature");
  writeFileSync(join(root, "src/gone.ts"), "export function doomed(c) {\n  return c * 9;\n}\n", "utf8");
  writeFileSync(join(root, ".gitignore"), ".codemap/\n", "utf8");
  git("add", "-A"); git("commit", "-qm", "one");
  git("remote", "add", "origin", origin);
  git("push", "-q", "origin", "feature");
  git("fetch", "-q", "origin");
  await init(root);
  const doomed = (await readAnchorStore(root)).anchors.find((a) => a.symbolPath.at(-1) === "doomed")!;
  git("rm", "-q", "src/gone.ts"); git("commit", "-qm", "delete it");
  await reindex(root);
  return { root, git, doomed, cleanup: () => discard(base) };
}

test("`workIdx` re-reads a deletion witness too — it judges when there is no trunk", async () => {
  const u = await singleBranchClone();
  try {
    assert.equal((await findingBacklog(u.root)).trunk, null,
      "no trunk resolves here, so `workIdx` is the judge — the reason this site is in scope at all");
    assert.ok(!(await readAnchorStore(u.root)).anchors.some((a) => a.id === u.doomed.id),
      "the deleted id is not in @work");

    await writeLocalFinding(u.root, {
      id: "f_del_workidx", target: { kind: "anchor", id: u.doomed.id },
      text: "the evidence", comment: "this deletion breaks callers",
      witness: { anchorId: u.doomed.id, bodyHash: "h2:0:sha256:absent", deleted: true },
      author: { principal: "izzie@x.com" }, createdAt: "2026-09-01T00:00:00Z",
      state: "created", corroboration: [], thread: [], revisions: [],
    } as never, "branch:feature");

    const bucketOf = async () => {
      const b = await findingBacklog(u.root, { asOf: "2026-09-19" });
      const keys = ["due", "woken", "sleeping", "live", "moved", "unjudgeable", "unfetched", "inReview"] as const;
      return keys.find((k) => (b[k] as { id: string }[]).some((r) => r.id === "f_del_workidx"));
    };
    assert.equal(await bucketOf(), "live", "gone from the tree, so the deletion still holds");

    // `git rm` took the now-empty directory with it, this being the only file in it.
    mkdirSync(join(u.root, "src"), { recursive: true });
    writeFileSync(join(u.root, "src/gone.ts"), "export function doomed(c) {\n  return c * 9;\n}\n", "utf8");
    assert.equal(await bucketOf(), "moved", "restored in the working tree, and the live re-read sees it");
  } finally { u.cleanup(); }
});
