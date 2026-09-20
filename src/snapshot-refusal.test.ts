/**
 * One rule for "this cached snapshot is not that commit", in one place.
 *
 * It used to be two shapes of one pattern: `diff` refused a dirty base snapshot
 * (COD-3) and the witnessing path did not check at all, so a `reindex` on a dirty
 * tree re-cached HEAD from the working tree and a later `review(ref: head)` recorded
 * the working tree's body under that sha. Nine other `readSnapshot` callers had no
 * check either.
 *
 * The guard is central, and the read now REPAIRS: a refused row is rebuilt from git
 * objects by whichever read meets it, so no caller has to tell "not cached" from
 * "empty". Only a commit git cannot read is still refused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { snapshotRefusal, writeStore, writeSnapshot, readOrphans, readCachedSnapshot } from "./store.js";
import { readSnapshot } from "./snapshots.js";
import { db } from "./db.js";
import { snapshotAt, snapshot, reindex, diff } from "./ops.js";
import { indexBlob } from "./repo.js";
import { liveHashes, markReviewedBatch } from "./reviews.js";
import { witnessAt } from "./ops/annotations.js";
import type { State } from "./schema.js";
import { discard } from "./test-tmp.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const SRC = "export function charge(cents) {\n  return cents;\n}\n";

/** A repo with HEAD committed and cached cleanly from git objects. */
async function dirtied() {
  const root = mkdtempSync(join(tmpdir(), "codemap-snaprefuse-"));
  const git = (...a: string[]) =>
    spawnSync("git", ["-c", "user.email=t@x.com", "-c", "user.name=t", ...a], { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/pay.js"), SRC, "utf8");
  const indexed = await indexBlob(SRC, "src/pay.js");
  await writeStore(root, indexed, state);
  git("add", "-A"); git("commit", "-q", "-m", "head");
  const head = git("rev-parse", "HEAD").stdout.trim();
  await snapshotAt(root, head);
  return { root, head, ids: indexed.map((a) => a.id), git, cleanup: () => discard(root) };
}

const DIRTY = SRC.replace("return cents;", "return cents * 3;");

/**
 * The row an older build left behind: HEAD's snapshot holding a dirty working tree's
 * bodies, flagged. Nothing writes one any more (a working tree's state belongs to the
 * worktree, not the commit), but stores in the field still hold them.
 */
const soil = async (u: Awaited<ReturnType<typeof dirtied>>) => {
  writeFileSync(join(u.root, "src/pay.js"), DIRTY, "utf8");
  await writeSnapshot(u.root, u.head, "main", await indexBlob(DIRTY, "src/pay.js"), new Date().toISOString());
  db(u.root).prepare("UPDATE snapshots SET dirty = 1 WHERE ref = ?").run(u.head);
};

test("a clean snapshot is not refused, and a dirty one is — with the reason", async () => {
  const u = await dirtied();
  try {
    assert.equal(snapshotRefusal(u.root, u.head), null, "clean: usable as that commit");
    await soil(u);
    const why = snapshotRefusal(u.root, u.head)!;
    assert.equal(why.reason, "dirty");
    // The message must not send the reader to the command that CAUSED it. `init` /
    // `reindex` re-index the working tree; `snapshot` reads git objects.
    assert.match(why.message, /codemap snapshot/);
    assert.doesNotMatch(why.message, /codemap init/);
  } finally { u.cleanup(); }
});

test("readSnapshot rebuilds a refused row from git objects on the read that meets it", async () => {
  const u = await dirtied();
  try {
    await soil(u);
    // The escape hatch reads the row as it stands, and does not repair it.
    const dirty = await indexBlob(DIRTY, "src/pay.js");
    const raw = new Map((await readSnapshot(u.root, u.head, { allowDirty: true }))!.map((a) => [a.id, a.bodyHash]));
    for (const a of dirty) assert.equal(raw.get(a.id), a.bodyHash);

    const committed = await indexBlob(SRC, "src/pay.js");
    const read = new Map((await readSnapshot(u.root, u.head))!.map((a) => [a.id, a.bodyHash]));
    for (const a of committed) assert.equal(read.get(a.id), a.bodyHash, "the commit's bodies");
    assert.equal(snapshotRefusal(u.root, u.head), null, "and the row is clean from now on");
  } finally { u.cleanup(); }
});

test("a commit never cached is built on first read, by sha or by name", async () => {
  const u = await dirtied();
  try {
    db(u.root).prepare("DELETE FROM snapshots WHERE ref = ?").run(u.head);
    db(u.root).prepare("DELETE FROM anchors WHERE ref = ?").run(u.head);
    assert.ok((await readSnapshot(u.root, "main"))?.length, "a branch name resolves to its commit");
    assert.equal(snapshotRefusal(u.root, u.head), null, "cached under the sha");
  } finally { u.cleanup(); }
});

test("a commit git cannot read is still refused, and says so", async () => {
  const u = await dirtied();
  try {
    const nowhere = "0".repeat(40);
    assert.equal(await readSnapshot(u.root, nowhere), null);
    assert.equal(snapshotRefusal(u.root, nowhere)?.reason, "absent");
    assert.match(snapshotRefusal(u.root, nowhere)!.message, /no cached snapshot/);
  } finally { u.cleanup(); }
});

test("the callers that used to refuse a dirty row now answer, because the read repairs it", async () => {
  const u = await dirtied();
  try {
    await soil(u);
    const committed = await indexBlob(SRC, "src/pay.js");
    const hashes = await liveHashes(u.root, u.ids, u.head);
    for (const a of committed) assert.equal(hashes.get(a.id), a.bodyHash, "witnessing sees the commit");
    const d = await diff(u.root, u.head) as { error?: string };
    assert.equal(d.error, undefined, "and diff has a base");
  } finally { u.cleanup(); }
});

test("witnessing a finding at a ref reads the commit, never a refused row", async () => {
  const u = await dirtied();
  try {
    await soil(u);
    const committed = await indexBlob(SRC, "src/pay.js");
    for (const a of committed) {
      const w = await witnessAt(u.root, a.id, u.head);
      assert.equal(w.witness?.bodyHash, a.bodyHash, `${a.id}: the commit's body, not the dirty row's`);
      assert.equal(w.sourceRef, u.head);
    }
  } finally { u.cleanup(); }
});

test("witnessing an id outside the tree skips a snapshot the guard refuses", async () => {
  const u = await dirtied();
  try {
    const ghost = { ...(await indexBlob(SRC, "src/pay.js"))[0]!, id: "a_ghost" };
    const legacy = "f".repeat(40);
    await writeSnapshot(u.root, legacy, null, [ghost], new Date().toISOString());
    db(u.root).prepare("UPDATE snapshots SET dirty = 1 WHERE ref = ?").run(legacy);
    const w = await witnessAt(u.root, "a_ghost");
    assert.equal(w.witness, undefined, "a dirty row is no witness");
  } finally { u.cleanup(); }
});

test("rebuilding a snapshot keeps the referenced anchors only the old row held", async () => {
  const u = await dirtied();
  try {
    const ghost = { ...(await indexBlob(SRC, "src/pay.js"))[0]!, id: "a_ghost" };
    await writeSnapshot(u.root, u.head, "main", [...(await readSnapshot(u.root, u.head))!, ghost], new Date().toISOString());
    await markReviewedBatch(u.root, ["a_ghost"], { level: "code", actor: "agent", hashes: new Map([["a_ghost", ghost.bodyHash]]) });
    await snapshotAt(u.root, u.head, { force: true });
    assert.ok(readOrphans(u.root, ["a_ghost"]).has("a_ghost"), "retained under @orphan, not stranded");
  } finally { u.cleanup(); }
});

test("a caller that never had a guard now REPAIRS instead of serving it", async () => {
  // `snapshotAt` short-circuits on an existing snapshot, so a dirty one used to be
  // cached under that sha for ever unless somebody passed `force`. It was never
  // edited for this fix — it inherits the refusal, sees "not cached", and re-indexes
  // from git objects, which is exactly the repair.
  const u = await dirtied();
  try {
    await soil(u);
    const r = await snapshotAt(u.root, u.head) as { cached?: boolean; ok?: boolean };
    assert.equal(r.ok, true);
    assert.equal(r.cached, false, "it rebuilt rather than serving the dirty cache");
    assert.equal(snapshotRefusal(u.root, u.head), null, "and the cache is clean again");

    // Which means the whole chain works afterwards, with no other change.
    const hashes = await liveHashes(u.root, u.ids, u.head);
    assert.equal(hashes.size ?? [...hashes].length, u.ids.length);
  } finally { u.cleanup(); }
});

test("a reindex on a dirty tree leaves the commit's snapshot as it was", async () => {
  const u = await dirtied();
  try {
    writeFileSync(join(u.root, "src/pay.js"), DIRTY, "utf8");
    const r = await reindex(u.root) as { snapshotSkipped?: string };
    assert.equal(r.snapshotSkipped, "dirty");
    assert.equal(snapshotRefusal(u.root, u.head), null, "still usable as that commit");
    const committed = await indexBlob(SRC, "src/pay.js");
    const cached = new Map((await readSnapshot(u.root, u.head))!.map((a) => [a.id, a.bodyHash]));
    for (const a of committed) assert.equal(cached.get(a.id), a.bodyHash, "the commit's bodies, not the tree's");
  } finally { u.cleanup(); }
});

test("`snapshot` on a dirty tree caches the commit, not the working tree", async () => {
  const u = await dirtied();
  try {
    db(u.root).prepare("DELETE FROM snapshots WHERE ref = ?").run(u.head);
    writeFileSync(join(u.root, "src/pay.js"), DIRTY, "utf8");
    const r = await snapshot(u.root) as { ok?: boolean; ref?: string };
    assert.equal(r.ok, true);
    assert.equal(r.ref, u.head);
    assert.equal(snapshotRefusal(u.root, u.head), null, "a clean row: it came from git objects");
    const committed = await indexBlob(SRC, "src/pay.js");
    const cached = new Map((await readSnapshot(u.root, u.head))!.map((a) => [a.id, a.bodyHash]));
    for (const a of committed) assert.equal(cached.get(a.id), a.bodyHash);
  } finally { u.cleanup(); }
});

/**
 * A snapshot row that says it holds anchors while its rows are gone. The concurrent
 * upgrade produced it (a second process reading a ref's rows outside the transaction
 * that rewrites them), but the guard is cause-agnostic on purpose: what it forbids is
 * SERVING the emptiness, which reports every symbol in that commit as removed.
 */
const wipe = (u: Awaited<ReturnType<typeof dirtied>>) =>
  db(u.root).prepare("DELETE FROM snapshot_sets WHERE ref = ?").run(u.head);

test("a snapshot whose rows are gone is refused, not served empty", async () => {
  const u = await dirtied();
  try {
    assert.equal(snapshotRefusal(u.root, u.head), null, "healthy first");
    wipe(u);
    const why = snapshotRefusal(u.root, u.head)!;
    assert.equal(why.reason, "lost", "the loss is visible");
    assert.match(why.message, /holds none/);
    assert.match(why.message, /codemap snapshot/, "and names the rebuild");
    assert.equal(await readCachedSnapshot(u.root, u.head), null, "the CACHE read never serves []");
  } finally { u.cleanup(); }
});

test("and the read that meets it rebuilds it from git objects", async () => {
  const u = await dirtied();
  try {
    wipe(u);
    const committed = await indexBlob(SRC, "src/pay.js");
    const read = new Map((await readSnapshot(u.root, u.head))!.map((a) => [a.id, a.bodyHash]));
    for (const a of committed) assert.equal(read.get(a.id), a.bodyHash, "the commit's bodies are back");
    assert.equal(snapshotRefusal(u.root, u.head), null, "and the row is whole again");
  } finally { u.cleanup(); }
});

/**
 * The control, and the reason the guard tests ZERO rows rather than "fewer than
 * `count`". `count` is the pre-dedup `anchors.length`; the rows are `(ref, id)`-keyed,
 * so two partial classes sharing an id leave a healthy snapshot one row short — 10451
 * against 10449, measured on a jellyfin store. A strict count-vs-rows guard refuses
 * that on every read, for ever, over nothing.
 */
test("a snapshot short by id dedup is healthy and still serves", async () => {
  const u = await dirtied();
  try {
    const anchors = (await readSnapshot(u.root, u.head))!;
    await writeSnapshot(u.root, u.head, "main", [...anchors, anchors[0]!], new Date().toISOString());
    const stored = db(u.root).prepare("SELECT count FROM snapshots WHERE ref = ?").get(u.head) as { count: number };
    assert.equal(stored.count, anchors.length + 1, "the row counts what was handed in");
    assert.equal(snapshotRefusal(u.root, u.head), null, "and it is NOT refused");
    assert.equal((await readCachedSnapshot(u.root, u.head))?.length, anchors.length, "it serves the deduped rows");
  } finally { u.cleanup(); }
});
