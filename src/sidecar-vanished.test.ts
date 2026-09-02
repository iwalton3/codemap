/**
 * A `.codemap/sidecar` pointing at a path that is not there.
 *
 * The failure, reproduced before it was fixed: **one read wiped the team's rows out of
 * the canonical table.** The fold is total — it computes the whole projection from the
 * whole scope — so folding zero events over a scope that has rows writes the empty
 * result, and `listBugs`, `search` and the dashboard then all agreed there were no bugs.
 * Recoverable, because the log is authoritative and restoring the path restores them,
 * but silently wrong meanwhile: the same shape as a corrupt shard reading as an empty
 * scope, one layer up.
 *
 * A typo in the file, an unmounted drive, or a sidecar this machine has not cloned yet
 * all produce it, and every one of those is on the path from working alone to working
 * with a team.
 *
 * Two halves, and they are deliberately asymmetric: reads DEGRADE and say so, the
 * transport STOPS. Syncing would have `ensureSidecar` mkdir a brand new empty sidecar at
 * the wrong path and put somebody on a team of one without telling them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, renameSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as ops from "./ops.js";
import { sharedSync, sharedPull, sharedStatus, adoptSidecar } from "./ops-shared.js";
import { readBugs } from "./store.js";
import { discard } from "./test-tmp.js";

const git = (root: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=izzie", ...args], { cwd: root, encoding: "utf8" });

async function teamed() {
  const root = mkdtempSync(join(tmpdir(), "codemap-van-"));
  const side = mkdtempSync(join(tmpdir(), "codemap-van-side-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "remote", "add", "origin", "https://github.com/acme/api.git");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".codemap"), { recursive: true });
  writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
  writeFileSync(join(root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "one");
  await ops.init(root);
  const { readAnchorStore } = await import("./store.js");
  const anchorId = (await readAnchorStore(root)).anchors[0]!.id;
  await ops.reportBug(root, { title: "settlement double posts", description: "repro", anchors: [anchorId] });
  const point = (at: string) => writeFileSync(join(root, ".codemap", "sidecar"), at, "utf8");
  return { root, side, point, cleanup: () => [root, side].forEach(discard) };
}

test("a sidecar that is not there does not empty the table — the reads keep serving", async () => {
  const r = await teamed();
  try {
    assert.equal((await ops.listBugs(r.root) as any).bugs.length, 1, "the check could have failed");
    r.point(r.side + "-typo");

    // The read itself used to do the damage: `raw` went from one row to none.
    assert.equal((await ops.listBugs(r.root) as any).bugs.length, 1);
    assert.equal((await readBugs(r.root)).bugs.length, 1, "and the rows are still in the table afterwards");
    assert.equal((await ops.search(r.root, "settlement") as any).bugs.length, 1);
    assert.equal((await ops.dashboard(r.root) as any).bugs.total, 1);

    // …and it comes back cleanly, because nothing was discarded on the way.
    r.point(r.side);
    assert.equal((await ops.listBugs(r.root) as any).bugs.length, 1);
  } finally { r.cleanup(); }
});

test("but the transport REFUSES, rather than creating a new empty sidecar at the wrong path", async () => {
  const r = await teamed();
  try {
    const gone = r.side + "-typo";
    r.point(gone);

    for (const [what, run] of [["sync", sharedSync], ["pull", sharedPull]] as const) {
      const out = await run(r.root) as { error?: string };
      assert.match(out.error ?? "", /is not at/, `${what} must refuse`);
      assert.match(out.error ?? "", /team of one/, `${what} must say what it is refusing to do`);
    }
    // The thing the refusal is protecting against: `ensureSidecar` mkdirs and inits.
    assert.equal((await ops.listBugs(r.root) as any).bugs.length, 1, "and nothing was lost meanwhile");
    assert.equal((await sharedStatus(r.root) as any).blocked?.includes("is not at"), true,
      "the status page leads with it — everything else there describes a sidecar that is not there");

    // Mutation check: with the path restored, the same calls work. So the refusal is
    // about the missing path and not about something else in this store.
    r.point(r.side);
    assert.equal((await sharedSync(r.root) as { error?: string }).error, undefined);
    assert.equal((await sharedStatus(r.root) as any).blocked, undefined);
  } finally { r.cleanup(); }
});

test("a FIRST sync still creates the sidecar — absence alone is not the error", async () => {
  // The half that would break setup if the guard were `existsSync` alone: writing a path
  // into `.codemap/sidecar` and running sync is how somebody sets one up, and at that
  // point nothing has ever been folded here.
  const root = mkdtempSync(join(tmpdir(), "codemap-van-first-"));
  const side = join(tmpdir(), `codemap-van-new-${Date.now()}`);
  try {
    git(root, "init", "-q", "-b", "main");
    git(root, "remote", "add", "origin", "https://github.com/acme/api.git");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".codemap"), { recursive: true });
    writeFileSync(join(root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "one");
    await ops.init(root);
    writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");

    const out = await sharedSync(root) as { error?: string };
    assert.equal(out.error, undefined, `a first sync must create it: ${out.error}`);
  } finally { [root, side].forEach(discard); }
});

// --- repointing to a DIFFERENT sidecar -------------------------------------------

/**
 * Repointing from one team's repo to another is REFUSED.
 *
 * Nothing migrates. The rows already folded from the old sidecar keep their
 * `source_scope`, the ownership rule keeps refusing local writes to them, and no fold
 * ever revisits them because the new sidecar has no such scope — so they answer every
 * read for ever, describing a log this store can no longer reach. Silently, which is the
 * part worth stopping for.
 *
 * The identity is the sidecar's oldest ROOT COMMIT, not its path, and these three tests
 * are the reason: a sidecar that moved and a sidecar that was re-cloned are the same
 * sidecar and must keep working.
 */
test("pointing at another team's sidecar is refused, and says what to do about it", async () => {
  const r = await teamed();
  const other = mkdtempSync(join(tmpdir(), "codemap-van-other-"));
  try {
    assert.equal((await sharedSync(r.root) as { error?: string }).error, undefined, "the baseline syncs");
    // A real, separate sidecar — somebody else's team.
    const { ensureSidecar } = await import("./sidecar.js");
    await ensureSidecar(other, { principal: "dana@x.com" });
    r.point(other);

    for (const [what, run] of [["sync", sharedSync], ["pull", sharedPull]] as const) {
      const out = await run(r.root) as { error?: string };
      assert.match(out.error ?? "", /is a different sidecar/, `${what} must refuse`);
      assert.match(out.error ?? "", /codemap sidecar adopt/, `${what} must name the way through`);
    }
    assert.match((await sharedStatus(r.root) as any).blocked ?? "", /different sidecar/);
    assert.equal((await ops.listBugs(r.root) as any).bugs.length, 1, "and nothing was lost meanwhile");
  } finally { r.cleanup(); discard(other); }
});

test("a sidecar that MOVED is the same sidecar, and is not refused", async () => {
  const r = await teamed();
  const moved = r.side + "-moved";
  try {
    assert.equal((await sharedSync(r.root) as { error?: string }).error, undefined);
    renameSync(r.side, moved);
    r.point(moved);
    assert.equal((await sharedSync(r.root) as { error?: string }).error, undefined,
      "a directory rename is not a change of team");
    assert.equal((await ops.listBugs(r.root) as any).bugs.length, 1);
  } finally { r.cleanup(); discard(moved); }
});

test("a RE-CLONE of the same sidecar is the same sidecar too", async () => {
  // The recovery this must not break: the clone got wedged, so delete it and clone
  // again. A path check would refuse it; the root commit is in the clone's history.
  const r = await teamed();
  const clone = mkdtempSync(join(tmpdir(), "codemap-van-clone-"));
  try {
    assert.equal((await sharedSync(r.root) as { error?: string }).error, undefined);
    cpSync(r.side, clone, { recursive: true });
    r.point(clone);
    assert.equal((await sharedSync(r.root) as { error?: string }).error, undefined);
  } finally { r.cleanup(); discard(clone); }
});

test("adopt is the way through, and what it costs is stated AND recoverable", async () => {
  const r = await teamed();
  const other = mkdtempSync(join(tmpdir(), "codemap-van-adopt-"));
  try {
    assert.equal((await sharedSync(r.root) as { error?: string }).error, undefined);
    const before = (await ops.listBugs(r.root) as any).bugs.map((b: any) => b.id);
    assert.equal(before.length, 1, "the check could have failed");

    // A real, separate sidecar with its OWN history — otherwise there is nothing to
    // adopt, which `adoptSidecar` refuses for its own reasons.
    const { ensureSidecar, sync: sidecarSync } = await import("./sidecar.js");
    await ensureSidecar(other, { principal: "dana@x.com" });
    await sidecarSync(other, { principal: "dana@x.com" }, "dana's team");
    r.point(other);

    const adopted = await adoptSidecar(r.root) as any;
    assert.equal(adopted.error, undefined, `adopt must work: ${adopted.error}`);
    assert.equal(adopted.wasAt, r.side, "it names where the old one was, so the recovery is actionable");
    assert.ok(adopted.replaced.length, "and which scopes go");
    assert.match(adopted.note, /point \.codemap\/sidecar back at/);

    // They GO. An earlier version of this claimed they were kept, and could not keep
    // them: a fold is total per scope, so the new sidecar's empty copy replaces them.
    // The comment said one thing and the code did the other, which is the failure mode
    // a confident comment produces.
    assert.deepEqual((await ops.listBugs(r.root) as any).bugs.map((b: any) => b.id), [],
      "the next read folds the adopted sidecar over them");

    // And what makes that survivable is RUN, not asserted: they are a projection, and
    // the events are still in the old sidecar.
    r.point(r.side);
    assert.equal((await adoptSidecar(r.root) as any).error, undefined, "adopting back is the same act");
    assert.equal((await sharedSync(r.root) as { error?: string }).error, undefined);
    assert.deepEqual((await ops.listBugs(r.root) as any).bugs.map((b: any) => b.id), before,
      "the rows fold again — nothing was ever destroyed, only re-derived");
  } finally { r.cleanup(); discard(other); }
});

test("an agent may not move a store to another team", async () => {
  const r = await teamed();
  try {
    // A sidecar has no history until its first sync commits one, and there is nothing to
    // adopt without it — so the gate under test is only reachable after this.
    assert.equal((await sharedSync(r.root) as { error?: string }).error, undefined);
    const { markAgentSession, clearAgentSession } = await import("./identity.js");
    markAgentSession();
    try {
      assert.match((await adoptSidecar(r.root) as any).error ?? "", /person's call/);
    } finally { clearAgentSession(); }
    // Mutation check: the same call from a person is accepted.
    assert.equal((await adoptSidecar(r.root) as any).error, undefined);
  } finally { r.cleanup(); }
});

/**
 * The WRITE path needs the guard too, and this is what it looked like without it.
 *
 * `bugLog` and `bind` resolve the config and hand it straight to `ensureSidecar`, so after
 * a repoint `report_bug` appended to the STRANGER's log, the read then correctly declined
 * to fold it, and the op answered `ok` with an id for a bug that was in no table on any
 * machine. Measured before it was fixed, not reasoned about.
 */
test("a write refuses too — an ok with an id for a record in no table is the worst answer", async () => {
  const r = await teamed();
  const other = mkdtempSync(join(tmpdir(), "codemap-van-write-"));
  try {
    assert.equal((await sharedSync(r.root) as { error?: string }).error, undefined);
    const { ensureSidecar, sync: sidecarSync } = await import("./sidecar.js");
    await ensureSidecar(other, { principal: "dana@x.com" });
    await sidecarSync(other, { principal: "dana@x.com" }, "dana's team");
    r.point(other);

    const { readAnchorStore } = await import("./store.js");
    const anchorId = (await readAnchorStore(r.root)).anchors[0]!.id;
    const filed = await ops.reportBug(r.root, { title: "lands where?", description: "d", anchors: [anchorId] }) as any;
    assert.match(filed.error ?? "", /different sidecar/, "the write refuses rather than succeeding into a stranger");
    assert.equal(existsSync(join(other, "bugs")), false, "and nothing reached the stranger's log");

    // Mutation check: pointed back, the identical call works.
    r.point(r.side);
    assert.equal((await ops.reportBug(r.root, { title: "fine now", description: "d", anchors: [anchorId] }) as any).error, undefined);
  } finally { r.cleanup(); discard(other); }
});

/**
 * The quiet doors, and why they are the ones worth a test.
 *
 * `sidecarForWrite` answers null for BOTH "no sidecar" and "the wrong sidecar", and every
 * consumer of `Shared` reports a failed publish by asking `configured && !shared`. So the
 * collapse routed a bad binding around the branch that exists to report it: `setTriage`
 * returned `ok: true` three lines under a comment reading "failing loudly is the honest
 * answer", and `annotate` — the verb the guard was built around — answered a bare `ok`.
 * Nothing was written anywhere wrong, which is exactly why it needed a test rather than
 * a stack trace.
 */
test("a configured sidecar that may not be written to is REPORTED, not read as no sidecar", async () => {
  const r = await teamed();
  try {
    assert.equal((await sharedSync(r.root) as { error?: string }).error, undefined);
    const { readAnchorStore } = await import("./store.js");
    const anchorId = (await readAnchorStore(r.root)).anchors[0]!.id;
    r.point(r.side + "-typo");

    const ann = await ops.annotate(r.root, {
      targetKind: "anchor", targetId: anchorId, kind: "note", text: "the team should see this",
    } as any) as any;
    assert.equal(ann.ok, true, "the local write still stands — it always did");
    assert.equal(ann.shared, undefined);
    assert.match(ann.shareError ?? "", /nowhere to write/, "and the author is told the team did not get it");

    const tri = await ops.setTriage(r.root, {
      targetKind: "anchor", targetId: anchorId, importance: 3, complexity: 2, likely: true, source: "human",
    } as any) as any;
    assert.equal(tri.ok, false, "triage fails loudly, which is what its own comment claims it does");
    assert.match(tri.reason ?? "", /nowhere to write/);

    // The read guard over the standard fails CLOSED on the same condition — it returned
    // `undefined` (no warning at all) while the rows were being answered as the team's.
    const { standardScopeWarning } = await import("./standard-publish.js");
    const scope = await standardScopeWarning(r.root) as any;
    assert.equal(scope?.status, "blocked");
    assert.equal(scope?.diagnostic?.reason, "sidecar-missing");

    // Mutation check: pointed back, every one of them goes quiet again. Without this the
    // three assertions above pass against a build that refuses unconditionally.
    r.point(r.side);
    const ok = await ops.annotate(r.root, {
      targetKind: "anchor", targetId: anchorId, kind: "note", text: "healthy",
    } as any) as any;
    assert.equal(ok.shared, true);
    assert.equal(ok.shareError, undefined);
    assert.equal((await ops.setTriage(r.root, {
      targetKind: "anchor", targetId: anchorId, importance: 3, complexity: 2, likely: true, source: "human",
    } as any) as any).ok, true);
    assert.equal(await standardScopeWarning(r.root), undefined);
  } finally { r.cleanup(); }
});

/** The other half of the binding refusal: a REAL sidecar, belonging to somebody else. */
test("and the same is true of a stranger's sidecar, which reports the mismatch", async () => {
  const r = await teamed();
  const other = mkdtempSync(join(tmpdir(), "codemap-van-quiet-"));
  try {
    assert.equal((await sharedSync(r.root) as { error?: string }).error, undefined);
    const { ensureSidecar, sync: sidecarSync } = await import("./sidecar.js");
    await ensureSidecar(other, { principal: "dana@x.com" });
    await sidecarSync(other, { principal: "dana@x.com" }, "dana's team");
    r.point(other);

    const { readAnchorStore } = await import("./store.js");
    const anchorId = (await readAnchorStore(r.root)).anchors[0]!.id;
    const ann = await ops.annotate(r.root, {
      targetKind: "anchor", targetId: anchorId, kind: "note", text: "whose team?",
    } as any) as any;
    assert.match(ann.shareError ?? "", /different sidecar/);

    const { standardScopeWarning } = await import("./standard-publish.js");
    const scope = await standardScopeWarning(r.root) as any;
    assert.equal(scope?.diagnostic?.reason, "sidecar-mismatch");
    assert.equal(existsSync(join(other, "notes")), false, "and nothing reached the stranger");
  } finally { r.cleanup(); discard(other); }
});

test("and a write refuses when the sidecar is simply not there", async () => {
  const r = await teamed();
  try {
    assert.equal((await sharedSync(r.root) as { error?: string }).error, undefined);
    r.point(r.side + "-typo");
    const { readAnchorStore } = await import("./store.js");
    const anchorId = (await readAnchorStore(r.root)).anchors[0]!.id;
    const filed = await ops.reportBug(r.root, { title: "x", description: "d", anchors: [anchorId] }) as any;
    assert.match(filed.error ?? "", /nowhere to write/);
  } finally { r.cleanup(); }
});

/**
 * `adopt` must work on the history it is looking at, not one it remembers.
 *
 * `sidecarLineage` cached its answer per path. Replace the history at the SAME path — an
 * orphan checkout, a `commit-tree` — and adopt recorded the STALE root, so the store
 * stayed blocked until the process restarted. An escape hatch that needs a restart is not
 * one, and this is the only way out of a refused binding.
 */
test("adopt reads the sidecar's history now, not a cached answer from before it changed", async () => {
  const r = await teamed();
  try {
    assert.equal((await sharedSync(r.root) as { error?: string }).error, undefined);
    const { sidecarLineage } = await import("./sidecar.js");
    assert.ok(sidecarLineage(r.side), "warm the cache the way an ordinary sync does");

    // The history is replaced in place, tree untouched.
    const tree = git(r.side, "write-tree").stdout.trim();
    const made = spawnSync("git", ["commit-tree", tree], { cwd: r.side, encoding: "utf8", input: "stranger\n" });
    git(r.side, "update-ref", "HEAD", made.stdout.trim());
    const actual = git(r.side, "rev-list", "--max-parents=0", "HEAD").stdout.trim();

    assert.match((await sharedSync(r.root) as { error?: string }).error ?? "", /different sidecar/,
      "it is a stranger now, and the transport says so");
    const adopted = await adoptSidecar(r.root) as any;
    assert.equal(adopted.lineage, actual, "adopt records what is THERE");
    assert.equal((await sharedStatus(r.root) as any).blocked, undefined, "and the refusal is actually lifted");
  } finally { r.cleanup(); }
});

/**
 * A read degrades where the transport stops.
 *
 * The write gate went into `bind()`, which 33 of its 34 callers are writes — but
 * `findingRecord` is a read, and it started refusing data that `sharedFindings` happily
 * serves from the same rows.
 */
test("reading one finding degrades on a broken binding, exactly as reading them all does", async () => {
  const r = await teamed();
  try {
    const { shareFinding, sharedFindings, findingRecord } = await import("./ops-shared.js");
    const made = await shareFinding(r.root, 5, { targetKind: "anchor", targetId: "a_1", text: "real thing" }) as any;
    assert.equal(made.error, undefined);
    assert.equal((await sharedSync(r.root) as { error?: string }).error, undefined);

    r.point(r.side + "-typo");
    const all = await sharedFindings(r.root, 5) as any;
    const one = await findingRecord(r.root, 5, made.id) as any;
    assert.equal(all.findings.length, 1, "the list still serves what this store holds");
    assert.equal(one.error, undefined, "and so does the single read — same rows, same answer");
    assert.equal(one.id, made.id);
  } finally { r.cleanup(); }
});
