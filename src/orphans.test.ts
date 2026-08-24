import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { annotate, reindex, orphanedWork, getAnchor, reviewQueue, assignAnnotation, resolveAnnotation, withdrawAnnotation } from "./ops.js";
import { spawnSync } from "node:child_process";
import { readAnnotations } from "./store.js";

/**
 * A reindex used to delete anchors the new index did not produce, taking every
 * finding on them with it. That is not an edge case: an anchor id is
 * file + symbol path + signature, so a rename, a deletion, or a change to an
 * overload's parameter list is enough — and the overloads in an event-sourced
 * codebase (`Apply(SomeEvent)`) are exactly the code people file findings about.
 *
 * It had already destroyed a batch of findings once when this was written.
 */
const write = (root: string, body: string) => writeFileSync(join(root, "src/pay.ts"), body);

async function repo() {
  const root = mkdtempSync(join(tmpdir(), "codemap-orphan-"));
  mkdirSync(join(root, "src"));
  write(root, "export function transfer(cents: number) {\n  return cents;\n}\n");
  await reindex(root);
  return root;
}

test("a reindex that drops an anchor somebody filed against does not lose it", async () => {
  const root = await repo();
  try {
    const anchors = (await import("./store.js")).readAnchorStore;
    const id = (await anchors(root)).anchors.find((a) => a.symbolPath.join(".") === "transfer")!.id;
    const f = await annotate(root, {
      targetKind: "anchor", targetId: id, text: "no guard on negatives",
      comment: "`transfer` accepts negative cents", kind: "finding", severity: "high", author: "me",
    }) as { id: string };

    // rename the symbol — a new anchor id, and the old one gone from the tree
    write(root, "export function transferFunds(cents: number) {\n  return cents;\n}\n");
    const r = await reindex(root) as { orphans?: { retained: number } };
    assert.equal(r.orphans?.retained, 1, "the reindex says what it stranded");

    // the finding is untouched and its target is still readable
    const ann = (await readAnnotations(root)).annotations.find((a) => a.id === f.id)!;
    assert.equal(ann.target.id, id, "nothing rewrote the finding");
    const a = await getAnchor(root, id) as any;
    assert.equal(a.error, undefined, "the target still resolves");
    assert.equal(a.orphaned, true);
    assert.match(a.orphanedNote, /no longer in the working tree/);
    assert.match(a.orphanedNote, /may exist on a branch/, "…and does not claim it was deleted");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the sweep says what broke, and whether it can be recovered", async () => {
  const root = await repo();
  try {
    const { readAnchorStore } = await import("./store.js");
    const id = (await readAnchorStore(root)).anchors[0]!.id;
    await annotate(root, {
      targetKind: "anchor", targetId: id, text: "e", comment: "the credit gate is not enforced",
      kind: "finding", author: "me",
    });
    assert.equal((await orphanedWork(root)).total, 0, "nothing is broken yet");

    write(root, "export function transferFunds(cents: number) {\n  return cents;\n}\n");
    await reindex(root);

    const o = await orphanedWork(root);
    assert.equal(o.total, 1);
    assert.equal((o.retained[0] as any).file, "src/pay.ts", "with the file it was in");
    assert.match((o.retained[0] as any).symbol, /transfer/);
    assert.match((o.retained[0] as any).label, /credit gate/, "and enough of the finding to recognise it");
    assert.equal(o.lost.length, 0, "retained, not lost — the distinction is the point");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a symbol that comes back is live code again, not a retained ghost", async () => {
  // A branch checked out, a revert, a rename undone. Leaving the retained copy
  // beside the live one would give two answers to what the id means.
  const root = await repo();
  try {
    const { readAnchorStore } = await import("./store.js");
    const id = (await readAnchorStore(root)).anchors[0]!.id;
    await annotate(root, { targetKind: "anchor", targetId: id, text: "e", comment: "c", kind: "finding", author: "me" });

    write(root, "export function transferFunds(cents: number) {\n  return cents;\n}\n");
    await reindex(root);
    assert.equal((await orphanedWork(root)).total, 1);

    write(root, "export function transfer(cents: number) {\n  return cents;\n}\n");
    const back = await reindex(root) as { orphans?: { recovered: number } };
    assert.equal(back.orphans?.recovered, 1);
    assert.equal((await orphanedWork(root)).total, 0);
    assert.equal(((await getAnchor(root, id)) as any).orphaned, undefined, "it is ordinary live code again");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a dangling target is flagged in the queue rather than served silently", async () => {
  // `review_queue` returned a target that `annotate` and `get_anchor` both rejected,
  // with nothing marking it dead — so an agent could work from it and never find out.
  const root = await repo();
  try {
    const { readAnchorStore } = await import("./store.js");
    const id = (await readAnchorStore(root)).anchors[0]!.id;
    const f = await annotate(root, { targetKind: "anchor", targetId: id, text: "e", comment: "c", kind: "finding", author: "me" }) as { id: string };
    await assignAnnotation(root, { id: f.id, kind: "investigate", by: "me" });

    assert.equal((await reviewQueue(root)).queue[0]!.targetResolved, undefined, "live targets say nothing");

    write(root, "export function transferFunds(cents: number) {\n  return cents;\n}\n");
    await reindex(root);

    const q = (await reviewQueue(root)).queue[0]!;
    assert.equal(q.targetResolved, false);
    assert.equal(q.targetAt, "@orphan", "and where the last record of it is");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an orphaned anchor can still be filed against, so stranded work is reachable", async () => {
  // Re-filing against code the tree no longer has is exactly what someone needs when
  // a reindex has stranded a finding. Refusing it leaves the work unreachable rather
  // than safe — one pointer could not be re-issued as a finding for this reason.
  const root = await repo();
  try {
    const { readAnchorStore } = await import("./store.js");
    const id = (await readAnchorStore(root)).anchors[0]!.id;
    await annotate(root, { targetKind: "anchor", targetId: id, text: "e", comment: "c", kind: "pointer", author: "me" });

    write(root, "export function transferFunds(cents: number) {\n  return cents;\n}\n");
    await reindex(root);

    const re = await annotate(root, {
      targetKind: "anchor", targetId: id, text: "supersedes the pointer",
      comment: "the credit gate is not enforced", kind: "finding", author: "me",
    }) as any;
    assert.ok(!re.error, re.error);
    const ann = (await readAnnotations(root)).annotations.find((a) => a.id === re.id)!;
    assert.equal(ann.sourceRef, "@orphan", "and it says the body it witnessed is the last one anybody saw");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a symbol that exists only on a branch can be annotated without naming the ref", async () => {
  // Reviewing a pull request mostly means annotating files the branch ADDS, and those
  // are not in the working tree at all — so `annotate` failing on them made the
  // common case the one that broke. One finding could not be re-filed for this reason
  // and had to stay a `pointer` with a publish path as a workaround.
  const root = await repo();
  try {
    const { writeSnapshot } = await import("./store.js");
    const { indexBlob } = await import("./repo.js");
    const branchOnly = await indexBlob(
      "export function onlyOnTheBranch(x: number) {\n  return x;\n}\n", "src/branch-only.ts");
    await writeSnapshot(root, "prhead", "feature/x", branchOnly, "2026-08-19T00:00:00Z");
    const id = branchOnly[0]!.id;

    const r = await annotate(root, {
      targetKind: "anchor", targetId: id, text: "no guard", comment: "no guard on the new endpoint",
      kind: "finding", author: "me",
    }) as any;
    assert.ok(!r.error, r.error);

    const a = (await readAnnotations(root)).annotations.find((x) => x.id === r.id)!;
    assert.equal(a.target.id, id);
    assert.equal(a.sourceRef, "prhead", "and it witnesses the branch's body, not the working tree's");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reading a branch-only symbol answers with the branch's body, and says so", async () => {
  // `annotate` accepted these ids while `get_anchor` refused them — the tool
  // disagreeing with itself on the read path a reviewer reaches for FIRST. And the
  // answer has to name where it came from: the working tree is a third version
  // during a PR review, neither the branch under review nor what the reader assumes.
  const root = await repo();
  try {
    const { writeSnapshot } = await import("./store.js");
    const { indexBlob } = await import("./repo.js");
    const src = "export function onlyOnTheBranch(x: number) {\n  return x * 2;\n}\n";
    const branchOnly = await indexBlob(src, "src/branch-only.ts");
    await writeSnapshot(root, "prhead", "feature/x", branchOnly, "2026-08-19T00:00:00Z");

    const a = await getAnchor(root, branchOnly[0]!.id) as any;
    assert.equal(a.error, undefined, "it resolves");
    assert.equal(a.sourceRef, "prhead");
    assert.equal(a.offTree, true);
    assert.equal(a.orphaned, undefined, "off-tree is not orphaned — the code exists, just not here");
    assert.match(a.offTreeNote, /not in the working tree/);
    assert.match(a.offTreeNote, /feature\/x/, "and names the branch it is on");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a doc can cite code that exists only on a branch", async () => {
  // Same shape as `annotate`: `ops.document` has accepted a `ref` since it was
  // written — its own comment says a doc written during a PR review would otherwise
  // "cite symbols the working tree has never seen and match nothing" — and the MCP
  // tool never exposed it. Capability present, surface absent, nothing fails loudly.
  const root = await repo();
  try {
    const { writeSnapshot, loadNodes } = await import("./store.js");
    const { indexBlob } = await import("./repo.js");
    const { document } = await import("./ops.js");
    const branchOnly = await indexBlob(
      "export function onlyOnTheBranch(x: number) {\n  return x;\n}\n", "src/branch-only.ts");
    await writeSnapshot(root, "prhead", "feature/x", branchOnly, "2026-08-19T00:00:00Z");

    const bare = await document(root, {
      type: "concept", title: "T", summary: "S", anchors: [branchOnly[0]!.id],
    }) as any;
    assert.ok(bare.error || bare.rejectedAnchors, "without a ref the branch's symbol is not in scope");

    const withRef = await document(root, {
      type: "concept", title: "The branch feature", summary: "what it does",
      anchors: [branchOnly[0]!.id], ref: "prhead",
    }) as any;
    assert.ok(!withRef.error, withRef.error);
    assert.equal(withRef.rejectedAnchors, undefined);
    const node = (await loadNodes(root)).find((n) => n.id === withRef.id)!;
    assert.deepEqual(node.anchors, [branchOnly[0]!.id]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the queue reports triage state, or a finding on stranded code cannot be cleared", async () => {
  // The PR findings list can only see a finding whose symbol the branch does not
  // touch through this queue. While the projection dropped `resolved`/`withdrawn`,
  // every such row read as live: it offered "resolve" on one already resolved,
  // never "reopen", and no amount of resolving took it out of the list asking for
  // action. Nine of them had been resolved and were still being offered.
  const root = await repo();
  try {
    const { readAnchorStore } = await import("./store.js");
    const id = (await readAnchorStore(root)).anchors[0]!.id;
    const live = await annotate(root, { targetKind: "anchor", targetId: id, text: "a", comment: "c", kind: "finding", author: "me" }) as { id: string };
    const done = await annotate(root, { targetKind: "anchor", targetId: id, text: "b", comment: "c", kind: "finding", author: "me" }) as { id: string };
    const gone = await annotate(root, { targetKind: "anchor", targetId: id, text: "c", comment: "c", kind: "finding", author: "me" }) as { id: string };
    await resolveAnnotation(root, done.id, true);
    await withdrawAnnotation(root, { id: gone.id, withdraw: true, by: "me", reason: "superseded" });

    // What the web asks for: every finding, resolved ones included.
    const opts = { assignedOnly: false, includeResolved: true };
    const byId = (q: { queue: { id: string }[] }) => new Map(q.queue.map((x) => [x.id, x as never as Record<string, unknown>]));

    for (const brief of [false, true]) {
      const q = byId(await reviewQueue(root, { ...opts, brief }));
      assert.equal(q.get(live.id)!.resolved, undefined, `brief=${brief}: a live finding says nothing`);
      assert.equal(q.get(live.id)!.withdrawn, undefined, `brief=${brief}`);
      assert.equal(q.get(done.id)!.resolved, true, `brief=${brief}: a resolved one says so`);
      assert.ok(q.get(gone.id)!.withdrawn, `brief=${brief}: and so does a withdrawn one`);
    }

    // Reopening has to be visible too, or the round trip is one-way.
    await resolveAnnotation(root, done.id, false);
    assert.equal(byId(await reviewQueue(root, opts)).get(done.id)!.resolved, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * `lost` used to mean "no record anywhere", which it never did. It was raw id
 * membership in two local tables, presented as a claim about the CODE — the shape
 * `resolveAnchor` exists to stop. A record carries its own address, and indexing
 * that commit answers what the id named.
 */
const gitIn = (root: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.email=t@x", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8" });

/**
 * A repo whose FIRST commit was never indexed here, so nothing holds a copy of the
 * symbol it had: no `@work` row, no snapshot, and — because the record is written
 * after the last reindex — no retention either. That is the only way to reach the
 * `lost` path, and it is the ordinary shape of a finding ingested against a branch
 * whose snapshot has since been evicted.
 */
async function committedRepo() {
  const root = mkdtempSync(join(tmpdir(), "codemap-orphan-loc-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/pay.ts"), "export function transfer(cents: number) {\n  return cents;\n}\n");
  gitIn(root, "init", "-q", "-b", "main");
  gitIn(root, "add", "-A");
  gitIn(root, "commit", "-qm", "first");
  const first = gitIn(root, "rev-parse", "HEAD").stdout.trim();
  writeFileSync(join(root, "src/pay.ts"), "export function settle(cents: number) {\n  return cents;\n}\n");
  gitIn(root, "commit", "-qam", "renamed");
  await reindex(root);
  return { root, first };
}

test("a stranded record whose own commit still names its id is not lost", async () => {
  const { root, first } = await committedRepo();
  try {
    const { indexBlob } = await import("./repo.js");
    const { readBugs, writeLocalBugs } = await import("./store.js");
    const { testBug } = await import("./test-events.js");
    // The id as it was at `first`, taken WITHOUT storing it — so nothing retains it
    // and nothing snapshots it, which is what makes this the `lost` path rather
    // than `retained` or `offTree`.
    const gone = (await indexBlob("export function transfer(cents: number) {\n  return cents;\n}\n", "src/pay.ts"))
      .find((a) => a.symbolPath.join(".") === "transfer")!;

    // Filed AFTER the reindex, so retention never saw it — as an ingested finding
    // against a branch whose snapshot has since been evicted would be.
    const bugs = await readBugs(root);
    bugs.bugs.push(testBug({
      id: "b_1", title: "no guard on negatives", severity: "high", text: "d",
      cites: [{ anchorId: gone.id, bodyHash: gone.bodyHash }], createdCommit: first,
    }));
    await writeLocalBugs(root, bugs.bugs);

    const before = await orphanedWork(root) as any;
    assert.equal(before.located.length, 0, "nothing is claimed without asking");
    assert.equal(before.lost.length, 1);
    assert.equal(before.lost[0].why, "not asked — pass `locate`");
    assert.equal(before.locatable.records, 1, "…but it says the question can be asked");
    assert.equal(before.locatable.notAsked, undefined,
      "and not as though a cap had stopped it — nothing was attempted");

    const after = await orphanedWork(root, { locate: true }) as any;
    assert.equal(after.lost.length, 0, "asked, and answered");
    assert.equal(after.located.length, 1);
    assert.equal(after.located[0].file, "src/pay.ts");
    assert.equal(after.located[0].symbol, "transfer");
    assert.equal(after.located[0].at, first, "read at the commit the record itself names");
    assert.equal(after.byKind.bug.located, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("asking and finding nothing is a different answer from not asking", async () => {
  // The control for the one above. Without it, `locate` could report `located` for
  // anything and both would pass.
  const { root, first } = await committedRepo();
  try {
    const { readBugs, writeLocalBugs } = await import("./store.js");
    const { testBug } = await import("./test-events.js");
    const { fixtureHash } = await import("./fixture-hash.js");
    const bugs = await readBugs(root);
    bugs.bugs.push(testBug({
      id: "b_ghost", title: "an id that commit never produced", severity: "low", text: "d",
      cites: [{ anchorId: "a_0000000000000000", bodyHash: fixtureHash("X") }], createdCommit: first,
    }));
    await writeLocalBugs(root, bugs.bugs);

    const r = await orphanedWork(root, { locate: true }) as any;
    assert.equal(r.located.length, 0);
    assert.equal(r.lost.length, 1);
    assert.equal(r.lost[0].why, "absent", "this build read that commit and does not produce it");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a record with nothing to ask says so, rather than claiming the code is gone", async () => {
  // The control, and the honest half: `lost` now carries WHY, because *nothing to
  // ask*, *not asked* and *asked and absent* are three different situations.
  const root = mkdtempSync(join(tmpdir(), "codemap-orphan-why-"));
  try {
    const { writeStore, readBugs, writeLocalBugs } = await import("./store.js");
    const { testBug } = await import("./test-events.js");
    const { fixtureHash } = await import("./fixture-hash.js");
    await writeStore(root, [], { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as any);
    const bugs = await readBugs(root);
    bugs.bugs.push(testBug({
      id: "b_1", title: "old bug", severity: "high", text: "d",
      cites: [{ anchorId: "a_nowhere", bodyHash: fixtureHash("X") }],
    }));
    await writeLocalBugs(root, bugs.bugs);

    const r = await orphanedWork(root, { locate: true }) as any;
    assert.equal(r.lost.length, 1);
    assert.equal(r.lost[0].why, "no address to ask");
    assert.equal(r.locatable, undefined, "and nothing is offered that cannot be done");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("what `locate` did not reach is reported, never dropped", async () => {
  // A silent cap reads as "we looked" when we did not — the same lie the `lost`
  // bucket used to tell.
  const { root, first } = await committedRepo();
  try {
    const { indexBlob } = await import("./repo.js");
    const { readBugs, writeLocalBugs } = await import("./store.js");
    const { testBug } = await import("./test-events.js");

    // A second symbol, at a second commit, and gone again — so the two records have
    // two different addresses and `locate` has two trees to open.
    writeFileSync(join(root, "src/led.ts"), "export function post(cents: number) {\n  return cents;\n}\n");
    gitIn(root, "add", "-A");
    gitIn(root, "commit", "-qm", "ledger");
    const second = gitIn(root, "rev-parse", "HEAD").stdout.trim();
    rmSync(join(root, "src/led.ts"));
    gitIn(root, "commit", "-qam", "ledger gone");
    await reindex(root);

    const at = async (src: string, file: string, name: string) =>
      (await indexBlob(src, file)).find((a) => a.symbolPath.join(".") === name)!;
    const one = await at("export function transfer(cents: number) {\n  return cents;\n}\n", "src/pay.ts", "transfer");
    const two = await at("export function post(cents: number) {\n  return cents;\n}\n", "src/led.ts", "post");

    const bugs = await readBugs(root);
    bugs.bugs.push(
      testBug({ id: "b_1", title: "one", severity: "low", text: "d", cites: [{ anchorId: one.id, bodyHash: one.bodyHash }], createdCommit: first }),
      testBug({ id: "b_2", title: "two", severity: "low", text: "d", cites: [{ anchorId: two.id, bodyHash: two.bodyHash }], createdCommit: second }),
    );
    await writeLocalBugs(root, bugs.bugs);

    const all = await orphanedWork(root, { locate: true }) as any;
    assert.equal(all.located.length, 2, "both are findable when both commits are read");
    assert.equal(all.locatable, undefined, "and nothing is left unsaid");

    const capped = await orphanedWork(root, { locate: true, maxCommits: 1 }) as any;
    assert.equal(capped.located.length, 1);
    assert.equal(capped.lost.length, 1);
    assert.equal(capped.lost[0].why, "not asked — over the commit cap");
    assert.equal(capped.locatable.notAsked, 1, "the count of what it did not read");
    assert.equal(capped.locatable.cap, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a record with nothing to ask says so, rather than claiming the code is gone", async () => {
  // The control, and the honest half: `lost` now carries WHY, because *nothing to
  // ask*, *not asked* and *asked and absent* are three different situations.
  const root = mkdtempSync(join(tmpdir(), "codemap-orphan-why-"));
  try {
    const { writeStore, readBugs, writeLocalBugs } = await import("./store.js");
    const { testBug } = await import("./test-events.js");
    const { fixtureHash } = await import("./fixture-hash.js");
    await writeStore(root, [], { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as any);
    const bugs = await readBugs(root);
    bugs.bugs.push(testBug({
      id: "b_1", title: "old bug", severity: "high", text: "d",
      cites: [{ anchorId: "a_nowhere", bodyHash: fixtureHash("X") }],
    }));
    await writeLocalBugs(root, bugs.bugs);

    const r = await orphanedWork(root, { locate: true }) as any;
    assert.equal(r.lost.length, 1);
    assert.equal(r.lost[0].why, "no address to ask");
    assert.equal(r.locatable, undefined, "and nothing is offered that cannot be done");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

