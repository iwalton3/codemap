import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { db } from "./db.js";
import { loadNodes, loadNodeVersions, readAnchorStore, ackHole, writeNode, confirmNode, remapNodeCitations } from "./store.js";
import { selectWinner } from "./doc-version.js";
import { anchorIndex } from "./anchor-resolve.js";
import type { NodeVersion } from "./schema.js";

/**
 * Fold-owned rows, hand-written.
 *
 * Nothing WRITES an `origin` until the projection is retargeted, so every guard in
 * this step is inert on a store the fold has never touched. That is exactly why they
 * belong here and not later: they are read-path prerequisites, and the moment the
 * projection lands, `versionsOf` starts returning fold rows to every one of these
 * call sites at once. Standing them up by hand is the only way to test the guards
 * before the thing they guard against exists.
 */
function foldRow(root: string, v: Partial<NodeVersion> & { versionId: string; nodeId: string }): void {
  db(root).prepare(
    "INSERT INTO node_versions(version_id,node_id,type,title,summary,body,generated_by,created_commit,"
    + "created_branch,created_at,citations,removed,origin,source_scope,ord,author) "
    + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    v.versionId, v.nodeId, v.type ?? "concept", v.title ?? "Team doc", v.summary ?? "s", v.body ?? "b",
    null, null, null, v.createdAt ?? "2026-01-01T00:00:00Z", JSON.stringify(v.citations ?? []),
    v.removed ? 1 : 0, "sync", "docs/acme/api", 1, JSON.stringify({ principal: "dana@x.com" }),
  );
}

const git = (root: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8" });

/** A universe with one indexed symbol, and that symbol's anchor id. */
async function repo(): Promise<{ root: string; anchorId: string; cleanup: () => void }> {
  const root = mkdtempSync(join(tmpdir(), "codemap-own-"));
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
  const { init } = await import("./ops.js");
  await init(root);
  const anchorId = (await readAnchorStore(root)).anchors[0]!.id;
  return { root, anchorId, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("(f) an agent cannot tombstone a node a teammate has documented", async () => {
  // `ackHole` does not MUTATE a fold-owned row — it inserts a new local one, which is
  // `origin IS NULL` and so passes the ownership guard completely. And a tombstone
  // citing absent anchors scores badness 0 against the teammate's dangling 1, so it
  // wins and `loadNodes` hides the node. That is `retireSharedDoc`'s person-only rule
  // and `shareDoc`'s refusal of `removed: true`, both bypassed locally.
  const r = await repo();
  try {
    foldRow(r.root, { versionId: "nv_team", nodeId: "n_pay", citations: [{ anchorId: "a_gone", acceptedHashes: [] }] });
    const res = await ackHole(r.root, "n_pay");
    assert.ok(res.error, "refused");
    assert.match(res.error!, /teammate's doc/);
    assert.match(res.error!, /retire_shared_doc/, "and it names the person-shaped way to do it");
  } finally { r.cleanup(); }
});

test("(f) a local tombstone stops applying once the node is not only yours", async () => {
  // The ordering race the gate cannot cover: the ack was made honestly while the node
  // was purely local, and a teammate published under the same id afterwards.
  const r = await repo();
  try {
    // The local content version cites code that is GONE, which is the situation
    // `ackHole` is for: only then does its tombstone outrank the content version.
    db(r.root).prepare(
      "INSERT INTO node_versions(version_id,node_id,type,title,summary,body,generated_by,created_commit,"
      + "created_branch,created_at,citations,removed) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run("nv_mine", "n_pay", "concept", "Mine", "s", "b", null, null, null, "2026-01-01T00:00:00Z",
      JSON.stringify([{ anchorId: "a_gone", acceptedHashes: [] }]), 0);
    db(r.root).prepare(
      "INSERT INTO node_versions(version_id,node_id,type,title,summary,body,generated_by,created_commit,"
      + "created_branch,created_at,citations,removed) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run("nv_tomb", "n_pay", "concept", "Mine", "s", "b", null, null, null, "2026-02-01T00:00:00Z",
      JSON.stringify([{ anchorId: "a_gone", acceptedHashes: [] }]), 1);

    // CONTROL — while the node is purely local the tombstone still works. Without
    // this the rule would read "tombstones never apply", which breaks `ackHole`.
    assert.equal((await loadNodes(r.root)).some((n) => n.id === "n_pay"), false, "hidden while local");

    foldRow(r.root, { versionId: "nv_team", nodeId: "n_pay", citations: [{ anchorId: "a_gone", acceptedHashes: [] }] });
    const listed = await loadNodes(r.root);
    assert.ok(listed.some((n) => n.id === "n_pay"), "the teammate's doc shows once it exists");
    assert.equal(listed.find((n) => n.id === "n_pay")!.status, "dangling", "as dangling, which is honest");
  } finally { r.cleanup(); }
});

test("(f) a fold-owned tombstone still hides the doc — retirement keeps working", async () => {
  // CONTROL against a partition that simply ignores all tombstones. A published
  // retirement went through `retireSharedDoc`'s person-only gate and is not local.
  const r = await repo();
  try {
    foldRow(r.root, { versionId: "nv_team", nodeId: "n_pay", citations: [{ anchorId: "a_gone", acceptedHashes: [] }] });
    foldRow(r.root, { versionId: "nv_team_tomb", nodeId: "n_pay", removed: true, createdAt: "2026-03-01T00:00:00Z",
      citations: [{ anchorId: "a_gone", acceptedHashes: [] }] });
    assert.equal((await loadNodes(r.root)).some((n) => n.id === "n_pay"), false, "still retired");
  } finally { r.cleanup(); }
});

test("(g) a local citation remap cannot rewrite a teammate's citations", async () => {
  const r = await repo();
  try {
    foldRow(r.root, { versionId: "nv_team", nodeId: "n_pay", citations: [{ anchorId: "a_old", acceptedHashes: [] }] });
    await writeNode(r.root, { id: "n_mine", type: "concept", title: "Mine", summary: "s", body: "b", anchors: ["a_old"] });
    const moved = remapNodeCitations(r.root, new Map([["a_old", "a_new"]]));
    assert.equal(moved, 1, "only the local version moved");
    const team = (await loadNodeVersions(r.root, "n_pay")).find((v) => v.versionId === "nv_team")!;
    assert.equal(team.citations[0]!.anchorId, "a_old", "the fold's row is the fold's to write");
  } finally { r.cleanup(); }
});

test("(b) an identical analyzer re-emit does not churn once a teammate shares the node", async () => {
  const r = await repo();
  try {
    const gen = { id: "n_gen", type: "concept" as const, title: "Generated", summary: "s", body: "b",
      anchors: [r.anchorId], generatedBy: "marten" };
    await writeNode(r.root, gen);
    foldRow(r.root, { versionId: "nv_team", nodeId: "n_gen", citations: [{ anchorId: r.anchorId, acceptedHashes: [] }] });
    const idOf = async () => (await loadNodeVersions(r.root, "n_gen")).find((v) => !v.origin)!.versionId;
    const before = await idOf();
    await writeNode(r.root, gen);
    assert.equal(await idOf(), before, "an unchanged re-emit rewrites nothing");

    // CONTROL — a CHANGED re-emit must still replace the local row, and must still
    // leave the teammate's alone.
    await writeNode(r.root, { ...gen, body: "different" });
    assert.notEqual(await idOf(), before, "a real change still writes");
    assert.ok((await loadNodeVersions(r.root, "n_gen")).some((v) => v.versionId === "nv_team"), "and the team row survives");
  } finally { r.cleanup(); }
});

test("a person's prose beats a machine synopsis at equal badness", () => {
  // DECLARED behaviour change, not an inert guard. Both score badness 0, so recency
  // decided — and a generated row's `createdAt` refreshes on every re-emit, so after
  // any code change the analyzer's summary silently outranked the human doc.
  const work = anchorIndex(new Map<string, string>(), { tags: [], anyUntagged: false });
  const base = { nodeId: "n", type: "concept" as const, title: "t", summary: "s", body: "b",
    citations: [], createdCommit: null, createdBranch: null };
  const human: NodeVersion = { ...base, versionId: "v_human", createdAt: "2026-01-01T00:00:00Z" };
  const machine: NodeVersion = { ...base, versionId: "v_gen", generatedBy: "marten", createdAt: "2026-06-01T00:00:00Z" };
  assert.equal(selectWinner([human, machine], work).v.versionId, "v_human", "even though the synopsis is newer");

  // CONTROL — badness still comes first, so a DRIFTED human doc loses to a current
  // synopsis. And a generated-only node still resolves to its generated version.
  assert.equal(selectWinner([machine], work).v.versionId, "v_gen");
});

test("(d) editing a node whose winner is a teammate's forks, and does not silently no-op", async () => {
  // The fence makes an in-place edit of a fold-owned row safe — the UPDATE matches
  // zero rows. Safe and SILENT: the caller is told the edit landed. Forking is the
  // honest answer and is what the drifted path already does.
  const r = await repo();
  try {
    foldRow(r.root, { versionId: "nv_team", nodeId: "n_pay", body: "theirs",
      citations: [{ anchorId: r.anchorId, acceptedHashes: [] }] });
    await writeNode(r.root, { id: "n_pay", type: "concept", title: "Mine", summary: "s", body: "mine", anchors: [r.anchorId] });

    const versions = await loadNodeVersions(r.root, "n_pay");
    assert.equal(versions.length, 2, "a new local version, not an overwrite");
    assert.equal(versions.find((v) => v.origin)!.body, "theirs", "theirs is untouched");
    assert.ok(versions.some((v) => !v.origin && v.body === "mine"), "and mine exists");
  } finally { r.cleanup(); }
});

test("versionCount counts what exists, not what resolution considered", async () => {
  // `resolvable` narrows the pool, and `resolveNode` counted the narrowed one — so a
  // node with three versions reported two, disagreeing with the version-history UI
  // that lists them all. The narrowing is a resolution rule, not a claim about how
  // much history there is.
  const r = await repo();
  try {
    db(r.root).prepare(
      "INSERT INTO node_versions(version_id,node_id,type,title,summary,body,generated_by,created_commit,"
      + "created_branch,created_at,citations,removed) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run("nv_tomb", "n_pay", "concept", "Mine", "s", "b", null, null, null, "2026-02-01T00:00:00Z",
      JSON.stringify([{ anchorId: "a_gone", acceptedHashes: [] }]), 1);
    foldRow(r.root, { versionId: "nv_team", nodeId: "n_pay", citations: [{ anchorId: r.anchorId, acceptedHashes: [] }] });

    const node = (await loadNodes(r.root)).find((n) => n.id === "n_pay")!;
    assert.equal(node.versionCount, 2, "both versions are counted");
    assert.equal((await loadNodeVersions(r.root, "n_pay")).length, 2, "and the history agrees");
  } finally { r.cleanup(); }
});

test("confirming a teammate's winning version is refused, not silently dropped", async () => {
  // The fence makes the UPDATE affect zero rows. Without this the call still returned
  // `ok` with a predicted fresh status, and a reload showed the row unchanged: a
  // confirmation reported and never stored.
  const r = await repo();
  try {
    foldRow(r.root, { versionId: "nv_team", nodeId: "n_pay", citations: [{ anchorId: r.anchorId, acceptedHashes: [] }] });
    const res = await confirmNode(r.root, "n_pay") as { ok?: true; error?: string };
    assert.ok(res.error, "refused");
    assert.match(res.error!, /teammate's/);
  } finally { r.cleanup(); }
});

test("removing a node that is only a teammate's does not report a deletion", async () => {
  // `deleteNode` removes local rows only, so the node survives — and `removeNode`
  // reported `deleted` anyway AND dropped every edge touching it. A deletion that did
  // not happen, with real collateral.
  const r = await repo();
  try {
    const { removeNode } = await import("./ops.js");
    foldRow(r.root, { versionId: "nv_team", nodeId: "n_pay", citations: [{ anchorId: r.anchorId, acceptedHashes: [] }] });
    const res = await removeNode(r.root, "n_pay") as { ok?: true; error?: string };
    assert.ok(res.error, "refused");
    assert.ok((await loadNodes(r.root)).some((n) => n.id === "n_pay"), "and it is still there");

    // CONTROL — a purely local node still deletes. Without this the rule reads
    // "removeNode never works".
    await writeNode(r.root, { id: "n_mine", type: "concept", title: "Mine", summary: "s", body: "b", anchors: [r.anchorId] });
    const ok = await removeNode(r.root, "n_mine") as { ok?: true; error?: string };
    assert.equal(ok.error, undefined);
    assert.equal((await loadNodes(r.root)).some((n) => n.id === "n_mine"), false);
  } finally { r.cleanup(); }
});
