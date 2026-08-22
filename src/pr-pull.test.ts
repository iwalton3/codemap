import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Anchor, State } from "./schema.js";
import { writeStore, writeSnapshot, readReviews } from "./store.js";
import { markReviewedBatch, reviewStatesFor } from "./reviews.js";
import { pullViewedFromGitHub } from "./pr-push.js";
import { fixtureHash } from "./fixture-hash.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const anchor = (id: string, hash: string): Anchor => ({ id, file: "src/pay.cs", symbolPath: [id], kind: "function", bodyHash: hash, lastVerifiedCommit: null });

/** A worklist stub — the real one needs a repo, a PR and a network. */
const fakeTriage = (items: any[]) => async () => ({
  pr: { owner: "o", repo: "r", number: 1 },
  refs: { head: "headsha", mergeBase: "basesha" },
  worklist: items,
});
const item = (id: string, file: string, over: any = {}) => ({ id, file, lane: "code", reviewed: false, viewed: false, ...over });

test("a ticked file marks every symbol the PR changed in it — as viewed, never signed", async () => {
  const calls: any[] = [];
  const r = await pullViewedFromGitHub("/nope", "1", {
    triage: fakeTriage([item("a1", "src/a.cs"), item("a2", "src/a.cs"), item("a3", "src/b.cs")]) as any,
    markBatch: async (_root, ids, o) => { calls.push({ ids, o }); return { marked: ids.length }; },
    fetchViewed: () => ({ viewed: new Set(["src/a.cs"]), total: 2 }),
  });
  assert.ok(!("error" in r));
  if ("error" in r) return;
  assert.deepEqual(calls[0].ids, ["a1", "a2"], "only the ticked file's symbols");
  assert.equal(calls[0].o.attestation, "viewed");
  assert.equal(calls[0].o.actor, "human");
  assert.notEqual(calls[0].o.attestation, "signed");
  assert.equal(calls[0].o.ref, "headsha", "witnessed against the code that was on screen");
  assert.equal(r.anchors.marked, 2);
});

test("an existing sign-off is not downgraded by a tick", async () => {
  const calls: any[] = [];
  const r = await pullViewedFromGitHub("/nope", "1", {
    triage: fakeTriage([item("a1", "src/a.cs", { reviewed: true }), item("a2", "src/a.cs", { viewed: true }), item("a3", "src/a.cs")]) as any,
    markBatch: async (_root, ids) => { calls.push(ids); return { marked: ids.length }; },
    fetchViewed: () => ({ viewed: new Set(["src/a.cs"]), total: 1 }),
  });
  if ("error" in r) return assert.fail(r.error);
  assert.deepEqual(calls[0], ["a3"], "signed and already-viewed symbols are left alone");
  assert.equal(r.anchors.alreadySigned, 1);
  assert.equal(r.anchors.alreadyViewed, 1);
});

test("a ticked file with nothing reviewable is reported, not silently dropped", async () => {
  const r = await pullViewedFromGitHub("/nope", "1", {
    triage: fakeTriage([item("a1", "src/a.cs"), item("t1", "tests/a.cs", { lane: "test" })]) as any,
    markBatch: async (_r, ids) => ({ marked: ids.length }),
    fetchViewed: () => ({ viewed: new Set(["src/a.cs", "tests/a.cs", "gen/x.cs"]), total: 3 }),
  });
  if ("error" in r) return assert.fail(r.error);
  assert.deepEqual(r.skippedFiles.sort(), ["gen/x.cs", "tests/a.cs"]);
  assert.equal(r.files.mapped, 1);
});

test("batch marking keeps the accepted set and witnesses at the ref", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-pull-"));
  try {
    await writeStore(root, [], state);                                   // not on this branch
    await writeSnapshot(root, "headsha", "feature", [anchor("a1", fixtureHash("NEW"))], "2026-08-18T00:00:00Z");
    await markReviewedBatch(root, ["a1"], { level: "code", actor: "human", attestation: "viewed", ref: "headsha" });

    const row = (await readReviews(root)).reviews[0]!;
    assert.equal(row.attestation, "viewed");
    assert.equal(row.witnesses[0]!.bodyHash, fixtureHash("NEW"));
    assert.equal(row.accepted![0]!.entries[0]!.bodyHash, fixtureHash("NEW"));

    const st = await reviewStatesFor(root, [{ kind: "anchor", id: "a1" }], { viewed: true, ref: "headsha" });
    assert.equal(st.get("anchor:a1")!.code.state, "reviewed", "reads fresh against the code it covered");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
