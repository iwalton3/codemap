/**
 * Review topics and "code moved on main" against a real history (plan 2026-10-02-review-topics,
 * F22 and F26). The fixture PR is merged, so a RANGE topic over its fork point and head must be
 * exactly the PR's code lane — the PR walkthrough is the oracle for a range topic.
 *
 * Main's tip is set per test by moving `origin/master` in the throwaway clone: the merge commit
 * (`030031dc`, which changes none of the PR's symbols) and `laterOnBase` (which changes four).
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { cloneAt, skipReason, FIXTURE_PR, type Clone } from "./real-repo.js";
import * as ops from "../ops.js";
import { discard } from "../test-tmp.js";

const skip = skipReason();
const PR = `${FIXTURE_PR.slug}#${FIXTURE_PR.number}`;
const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync("git", a, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const ok = <T>(r: T): Exclude<T, { error: string }> => {
  if (r && typeof r === "object" && "error" in r) assert.fail(String((r as { error: unknown }).error));
  return r as Exclude<T, { error: string }>;
};

describe("review topics against a real repository", { skip: skip ?? false }, () => {
  const clones: Clone[] = [];
  const dirs: string[] = [];
  after(() => { for (const c of clones) c.cleanup(); for (const d of dirs) discard(d); });

  /** A clone whose main is `trunk`, with a local sidecar and an identity. */
  const repo = (trunk: string) => {
    const c = cloneAt(FIXTURE_PR.head); clones.push(c);
    git(c.root, "update-ref", "refs/remotes/origin/master", trunk);
    git(c.root, "config", "user.email", "izzie@x.com"); git(c.root, "config", "user.name", "izzie");
    const side = mkdtempSync(join(tmpdir(), "codemap-e2e-side-")); dirs.push(side);
    mkdirSync(join(c.root, ".codemap"), { recursive: true });
    writeFileSync(join(c.root, ".codemap", "sidecar"), side);
    return c.root;
  };
  const mergeCommit = (root: string) =>
    git(root, "rev-list", "--ancestry-path", "--reverse", `${FIXTURE_PR.head}..${FIXTURE_PR.laterOnBase}`).split("\n")[0]!;

  test("a merged PR's walkthrough shows nothing moved at the merge, and what main changed after", async () => {
    const root = repo(FIXTURE_PR.head);
    git(root, "update-ref", "refs/remotes/origin/master", mergeCommit(root));
    const r = await ops.pr(root, PR, { fetch: false }) as any;
    const code = r.worklist.filter((w: any) => w.lane === "code");
    // One chapter per symbol, so a moved chapter names exactly one symbol.
    const features = [{ title: "PR", summary: "s", chapters: code.map((w: any) => ({ title: w.id, blocks: [{ kind: "symbol", anchorId: w.id }] })) }];
    ok(await ops.prWalkthroughSet(root, PR, features as never));

    const atMerge = ok(await ops.prWalkthroughGet(root, PR)) as any;
    assert.deepEqual(atMerge.movedOnMain?.chapters, [], "the merge changes none of the PR's symbols");

    git(root, "update-ref", "refs/remotes/origin/master", FIXTURE_PR.laterOnBase);
    const later = ok(await ops.prWalkthroughGet(root, PR)) as any;
    assert.equal(later.stale.length, 0, "against its own head nothing is stale — which is why this indicator exists");
    assert.ok(later.movedOnMain.chapters.length > 0, "441 commits later, main has changed some of them");
    assert.deepEqual([...later.movedOnMain.chapters].sort(), [...later.movedOnMain.symbols].map((id: string) =>
      later.walkthrough.features[0].chapters.find((c: any) => c.blocks[0].anchorId === id).id).sort());
  });

  test("a range topic over the merged PR is its code lane; a signed walk makes the re-walk a delta", async () => {
    const root = repo(FIXTURE_PR.laterOnBase);
    const r = await ops.pr(root, PR, { fetch: false }) as any;
    const code = new Set(r.worklist.filter((w: any) => w.lane === "code").map((w: any) => w.id));
    const files = [...new Set(r.files.map((f: any) => f.path))] as string[];

    ok(await ops.topicDefine(root, { slug: "played-filter", title: "Played filter", selector: { paths: files, base: FIXTURE_PR.forkPoint } }));
    const packet = ok(await ops.topicPacket(root, "played-filter", { head: FIXTURE_PR.head, limit: 1000 }));
    assert.deepEqual(new Set(packet.items.map((i) => i.id)), code, "the PR walkthrough is the oracle for a range topic");

    const walk1 = ok(await ops.topicWalkthroughSet(root, "played-filter",
      [{ title: "All", summary: "s", chapters: [{ title: "everything", blocks: packet.items.map((i) => ({ kind: "symbol" as const, anchorId: i.id })) }] }],
      { head: FIXTURE_PR.head }));
    assert.deepEqual(walk1.coverage.uncovered, []);
    const signed = ok(await ops.topicChapterMark(root, "played-filter", walk1.walk!, "everything", { attestation: "signed" }));
    assert.equal(signed.anchors, code.size);

    const g = ok(await ops.topicWalkthroughGet(root, "played-filter", walk1.walk!));
    assert.ok(g.moved!.symbols.length > 0, "main has moved some of what was signed");

    const rewalk = ok(await ops.topicPacket(root, "played-filter", { head: FIXTURE_PR.laterOnBase, limit: 1000 }));
    assert.equal(rewalk.base, FIXTURE_PR.head, "the delta since the walk this person signed in");
    assert.deepEqual(rewalk.since, { walk: walk1.walk, head: FIXTURE_PR.head });
    const delta = new Set(rewalk.items.map((i) => i.id));
    for (const id of g.moved!.symbols) assert.ok(delta.has(id), `${id} moved on main since it was signed, so the re-walk must include it`);
    const whole = ok(await ops.topicPacket(root, "played-filter", { head: FIXTURE_PR.laterOnBase, whole: true, limit: 1000 }));
    assert.ok(rewalk.counts.total < whole.counts.total, `a delta (${rewalk.counts.total}), not the whole range again (${whole.counts.total})`);
  });
});
