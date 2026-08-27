/**
 * One rule for "this cached snapshot is not that commit", in one place.
 *
 * It used to be two shapes of one pattern: `diff` refused a dirty base snapshot
 * (COD-3) and the witnessing path did not check at all, so a `reindex` on a dirty
 * tree re-cached HEAD from the working tree and a later `review(ref: head)` recorded
 * the working tree's body under that sha. Nine other `readSnapshot` callers had no
 * check either.
 *
 * What matters about the fix is the last test here: a caller that never had a guard
 * now gets one without being edited. That is the difference between enumerating a
 * population and making it have one member.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readSnapshot, snapshotRefusal, writeStore } from "./store.js";
import { snapshotAt, reindex, diff } from "./ops.js";
import { indexBlob } from "./repo.js";
import { liveHashes } from "./reviews.js";
import type { State } from "./schema.js";
import { discard } from "./test-tmp.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const SRC = "export function charge(cents) {\n  return cents;\n}\n";

/** A repo with HEAD cached cleanly, then a dirty working tree re-cached over it. */
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

const soil = async (u: Awaited<ReturnType<typeof dirtied>>) => {
  writeFileSync(join(u.root, "src/pay.js"), SRC.replace("return cents;", "return cents * 3;"), "utf8");
  const r = await reindex(u.root) as { dirtySnapshot?: boolean };
  assert.equal(r.dirtySnapshot, true, "reindex re-cached HEAD from a dirty tree — the fixture's premise");
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

test("readSnapshot itself refuses it — the guard is central, not per-caller", async () => {
  const u = await dirtied();
  try {
    assert.ok((await readSnapshot(u.root, u.head))?.length, "clean snapshot reads");
    await soil(u);
    assert.equal(await readSnapshot(u.root, u.head), null, "dirty one does not");
    // The escape hatch exists and is explicit, so a future caller that genuinely
    // wants "whatever some build produced" does not have to bypass the rule.
    assert.ok((await readSnapshot(u.root, u.head, { allowDirty: true }))?.length);
  } finally { u.cleanup(); }
});

test("the two callers that DID guard now say the same thing", async () => {
  const u = await dirtied();
  try {
    await soil(u);
    await assert.rejects(() => liveHashes(u.root, u.ids, u.head), /uncommitted changes/,
      "witnessing refuses");
    const d = await diff(u.root, u.head) as { error?: string };
    assert.match(String(d.error), /uncommitted changes/, "and so does diff");
    assert.match(String(d.error), /hide the very changes you are reviewing/,
      "with its own consequence still attached — the rule is shared, the stakes are local");
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
