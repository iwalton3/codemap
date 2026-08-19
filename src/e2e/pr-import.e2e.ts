/**
 * Importing a pull request from a real repository.
 *
 * These cover the parts of the PR path that a synthetic fixture cannot reach and
 * that unit tests had to take on trust: base resolution for a MERGED pull request,
 * whether the reading depends on what the working tree is checked out to, and
 * whether a symbol the branch DELETES comes back with a body.
 *
 * See `real-repo.ts` for the fixture and why the suite skips rather than fetching.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { cloneAt, skipReason, FIXTURE_PR, type Clone } from "./real-repo.js";
import * as ops from "../ops.js";

const skip = skipReason();
const PR = `${FIXTURE_PR.slug}#${FIXTURE_PR.number}`;

/** `fetch: false` throughout — every fixture object is already local, and an e2e suite must not hit the network. */
const read = (root: string) => ops.pr(root, PR, { fetch: false });

describe("PR import against a real repository", { skip: skip ?? false }, () => {
  const clones: Clone[] = [];
  const at = (sha: string) => { const c = cloneAt(sha); clones.push(c); return c.root; };
  after(() => { for (const c of clones) c.cleanup(); });

  test("a merged PR resolves to the commit it forked from, not to its own head", async () => {
    const r = await read(at(FIXTURE_PR.head)) as any;
    assert.ok(!r.error, r.error);

    // The head of a merged PR is an ancestor of the base branch, so merge-base
    // against the branch TIP is the head itself. Reading it that way reports the
    // PR as changing nothing — every merged PR in a back catalogue empties out.
    assert.notEqual(r.refs.mergeBase, r.refs.head, "the merged-PR collapse");
    assert.equal(r.refs.mergeBase, FIXTURE_PR.forkPoint);
    assert.ok(r.totals.changedLines > 0, "a merged PR still has a diff");
    assert.ok(r.totals.anchors > 0, "and symbols behind it");
  });

  test("the reading does not depend on what the working tree is checked out to", async () => {
    // The whole review model is witnessed against a PR head while the checkout sits
    // on some unrelated branch. Anything that leaks the working tree's commit into
    // the answer shows up here as a difference between these three.
    const states = [FIXTURE_PR.head, FIXTURE_PR.forkPoint, FIXTURE_PR.laterOnBase];
    const readings: any[] = [];
    for (const s of states) {
      const r = await read(at(s)) as any;
      assert.ok(!r.error, `${s}: ${r.error}`);
      readings.push(r);
    }

    const shape = (r: any) => ({
      refs: r.refs,
      totals: r.totals,
      files: r.files,
      lanes: r.lanes,
      worklist: r.worklist.map((w: any) => ({ id: w.id, file: w.file, symbol: w.symbol, change: w.change, lane: w.lane })),
    });
    for (let i = 1; i < readings.length; i++) {
      assert.deepEqual(shape(readings[i]), shape(readings[0]),
        `checked out at ${states[i]} the PR reads differently than at ${states[0]}`);
    }
  });

  test("a symbol the PR deletes comes back with the body it deleted", async () => {
    // `head` is null for a removed symbol, so the walkthrough fell through to it and
    // rendered "(source unavailable)" over a step that still carried a sign-off
    // button — an attestation to code the reviewer was never shown.
    const root = at(FIXTURE_PR.head);
    const r = await read(root) as any;
    const removed = r.worklist.filter((w: any) => w.change === "removed");
    assert.ok(removed.length, "the fixture PR is chosen because it removes a symbol");

    const target = removed.find((w: any) => w.symbol.includes(FIXTURE_PR.removedSymbol)) ?? removed[0];
    const code = await ops.prCode(root, PR, target.id) as any;
    assert.ok(!code.error, code.error);
    assert.equal(code.head, null, "a removed symbol has no head side");
    assert.ok(code.base && code.base.length > 0, "but the deleted body must be readable");
    assert.ok(code.baseStartLine >= 1, "and carry the line it started at, so findings can be pinned");
    assert.ok(code.lines.length > 0, "the removal diff is available too");
    assert.ok(code.lines.every((l: any) => l.tag === "-"), "a removal is all deletions");
  });

  test("added and changed symbols keep the sides that define them", async () => {
    const root = at(FIXTURE_PR.head);
    const r = await read(root) as any;
    for (const change of ["added", "changed"] as const) {
      const w = r.worklist.find((x: any) => x.change === change);
      if (!w) continue;
      const code = await ops.prCode(root, PR, w.id) as any;
      assert.ok(!code.error, code.error);
      assert.ok(code.head, `${change}: head side must be present`);
      assert.equal(code.base === null, change === "added", `${change}: base side`);
    }
  });

  test("a commit's index is deterministic — the same sha twice gives the same anchors", async () => {
    // Snapshots are cached as immutable and diffed against each other; a
    // non-deterministic index would surface as phantom added/removed symbols.
    const { indexCommit } = await import("../repo.js");
    const root = at(FIXTURE_PR.forkPoint);
    const a = await indexCommit(root, FIXTURE_PR.head);
    const b = await indexCommit(root, FIXTURE_PR.head);
    assert.ok(a && b && a.length > 1000, "a real C# tree indexes to thousands of anchors");
    assert.deepEqual(b, a);
  });
});
