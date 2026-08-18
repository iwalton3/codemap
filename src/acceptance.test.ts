import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAcceptance, recordAcceptance } from "./acceptance.js";
import type { AcceptedEntry } from "./schema.js";

const e = (bodyHash: string, commit: string, at = "2026-08-18T00:00:00Z"): AcceptedEntry => ({ bodyHash, commit, branch: null, at });
/** Ancestry oracle: the listed commits are in the viewed ref's history. */
const onlyOn = (...commits: string[]) => (c: string | null) => c === null || commits.includes(c);

test("the newest acceptance on this ancestry is a direct approval", () => {
  const r = resolveAcceptance([e("H1", "c1"), e("H2", "c2")], "H2", onlyOn("c1", "c2"));
  assert.equal(r.via, "direct");
});

test("a body approved on another lineage replays — switching branches is not a revert", () => {
  // H_pr was approved on a PR branch this ref does not descend from.
  const r = resolveAcceptance([e("H_dev", "c1"), e("H_pr", "pr1")], "H_pr", onlyOn("c1"));
  assert.equal(r.via, "replayed");
  assert.equal(r.entry?.commit, "pr1");
});

test("a commit moving this ancestry BACK to an older approved body is a revert", () => {
  // Approved H1 at c1, then H2 at c2, both on this history; the code is H1 again.
  const r = resolveAcceptance([e("H1", "c1"), e("H2", "c2")], "H1", onlyOn("c1", "c2"));
  assert.equal(r.via, "reverted", "the code went backwards on its own history");
  assert.equal(r.entry?.commit, "c1");
  assert.equal(r.supersededBy?.commit, "c2", "names the newer body it went back from");
});

test("the two cases are told apart by ancestry alone, not by content", () => {
  const entries = [e("H1", "c1"), e("H2", "c2")];
  // Same entries, same live body — only the viewed ref's history differs.
  assert.equal(resolveAcceptance(entries, "H1", onlyOn("c1", "c2")).via, "reverted");
  assert.equal(resolveAcceptance(entries, "H1", onlyOn("c1")).via, "direct");
});

test("a body never approved is not accepted at all", () => {
  assert.equal(resolveAcceptance([e("H1", "c1")], "H_new", onlyOn("c1")).via, "none");
  assert.equal(resolveAcceptance([], "H1", onlyOn()).via, "none");
  assert.equal(resolveAcceptance([e("H1", "c1")], undefined, onlyOn("c1")).via, "none");
});

test("recordAcceptance appends, dedupes the same body at the same commit, and stays bounded", () => {
  let entries: AcceptedEntry[] = [];
  entries = recordAcceptance(entries, e("H1", "c1"), 3);
  entries = recordAcceptance(entries, e("H1", "c1"), 3);
  assert.equal(entries.length, 1, "re-approving the identical body at the same commit is a no-op");

  entries = recordAcceptance(entries, e("H2", "c2"), 3);
  entries = recordAcceptance(entries, e("H3", "c3"), 3);
  entries = recordAcceptance(entries, e("H4", "c4"), 3);
  assert.deepEqual(entries.map((x) => x.bodyHash), ["H2", "H3", "H4"], "capped, oldest dropped");
});

test("the same body re-approved on a different commit is kept as its own acceptance", () => {
  const entries = recordAcceptance([e("H1", "c1")], e("H1", "c2"), 10);
  assert.equal(entries.length, 2, "provenance differs, so both acceptances are worth keeping");
});
