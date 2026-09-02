/**
 * The bug backlog's verbs, on real stores — local rows and the sidecar log alike.
 *
 * `bug-backlogged.test.ts` covers the fold. This covers what the fold cannot see: which
 * lists a deferred bug leaves, which it must NOT leave, and that the witnesses are taken
 * when the decision is made rather than read off the record.
 *
 * The hard constraint, and the one an implementation drifts from first: **a backlogged
 * bug is never deleted and never silenced from search.** The finding backlog can afford
 * `sleeping` to be quiet because a finding is a claim about one pull request; a bug is a
 * standing defect record, and a defect you cannot find is worse than one nobody has
 * prioritised.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as ops from "./ops.js";
import { readBug, writeLocalBug } from "./store.js";
import { readBugsShared } from "./shared-bugs.js";
import { resolveSidecar } from "./sidecar-config.js";
import { markAgentSession, clearAgentSession } from "./identity.js";
import { discard } from "./test-tmp.js";

const ok = <T>(r: T): Exclude<T, { error: string }> => {
  assert.ok(!(r && typeof r === "object" && "error" in (r as object)), `unexpected error: ${(r as any)?.error}`);
  return r as Exclude<T, { error: string }>;
};
const err = (r: unknown): string => {
  assert.ok(r && typeof r === "object" && "error" in (r as object), `expected a refusal, got ${JSON.stringify(r)}`);
  return (r as { error: string }).error;
};

const git = (root: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=izzie", ...args], { cwd: root, encoding: "utf8" });

const V1 = "export function transfer(c: number) { return c; }\n";
const V2 = "export function transfer(c: number) { return c + 0; }\n";
const V3 = "export function transfer(c: number) { return Math.round(c); }\n";

async function repo(withSidecar = false) {
  const root = mkdtempSync(join(tmpdir(), "codemap-bbl-"));
  const side = mkdtempSync(join(tmpdir(), "codemap-bbl-side-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "remote", "add", "origin", "https://github.com/acme/api.git");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".codemap"), { recursive: true });
  if (withSidecar) writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
  writeFileSync(join(root, "src", "pay.ts"), V1, "utf8");
  // A second file whose code nobody touches, so a test can hold one bug's witnesses
  // still while another's move. Sharing one anchor made every deferral wake together.
  writeFileSync(join(root, "src", "ledger.ts"), "export function total(n: number) { return n; }\n", "utf8");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "one");
  await ops.init(root);
  const { readAnchorStore } = await import("./store.js");
  const anchors = (await readAnchorStore(root)).anchors;
  const anchorId = anchors.find((a) => a.file === "src/pay.ts")!.id;
  const otherId = anchors.find((a) => a.file === "src/ledger.ts")!.id;
  const edit = (src: string) => writeFileSync(join(root, "src", "pay.ts"), src, "utf8");
  return { root, side, anchorId, otherId, edit, cleanup: () => [root, side].forEach(discard) };
}

const file = async (root: string, anchorId: string, title: string) =>
  (ok(await ops.reportBug(root, { title, description: "repro", anchors: [anchorId] })) as any).id;

const ids = (r: any) => r.bugs.map((b: any) => b.id);

test("a backlogged bug leaves the WORKING queue and nothing else", async () => {
  const r = await repo();
  try {
    const asleep = await file(r.root, r.anchorId, "settlement double posts");
    const awake = await file(r.root, r.anchorId, "ledger totals disagree");
    ok(await ops.backlogOn(r.root, { id: asleep, until: "2027-01-31", reason: "the settlement rewrite lands next quarter" }));

    // `open` is what the browser's default page sends, and it is the ONLY thing deferring
    // changes. A bare listing is a question rather than a queue and still answers with it.
    const working = await ops.listBugs(r.root, { open: true }) as any;
    assert.deepEqual(ids(working), [awake], "out of the queue people read — that is what deferring is for");
    assert.ok(ids(await ops.listBugs(r.root) as any).includes(asleep),
      "and out of nothing else: an unfiltered listing still has it");
    assert.equal(working.backlogged, 1, "the register's size is reported beside the queue, not hidden");
    assert.equal(working.sleeping, 1);
    // …and the queue counts are of what the queues can SHOW. Counting a live deferral as
    // work would make deferring honestly look identical to ignoring the thing, which is
    // why `sleeping` is out of the finding backlog's `attention` too.
    assert.equal(working.open, 1, "the chip and the list it opens must agree");

    // Its own list, not a bucket: bugs already have a queue people read, and the point is
    // that the main one means "what we are doing" again.
    const register = await ops.listBugs(r.root, { backlog: true }) as any;
    assert.deepEqual(ids(register), [asleep]);
    assert.equal(register.bugs[0]!.backlogged.until, "2027-01-31");
    assert.equal(register.bugs[0]!.backlogged.state, "sleeping");

    // THE constraint. A defect you cannot find is worse than one nobody has prioritised.
    const found = await ops.search(r.root, "settlement double") as any;
    assert.deepEqual(found.bugs.map((b: any) => b.id), [asleep], "still findable, and this is the whole rule");
    assert.equal(found.bugs[0]!.backlogged.until, "2027-01-31",
      "and marked, so it never reads as an ordinary open bug nobody is doing");

    // `state=all` is the way back to everything, and a deferral is not a state. This is
    // the half a first version broke: the search page links a backlogged hit to
    // `state=all`, so clicking it opened a list that did not contain the bug you clicked.
    assert.ok(ids(await ops.listBugs(r.root, {}) as any).includes(asleep), "`all` means all");
    assert.ok(ids(await ops.listBugs(r.root, { state: "created" }) as any).includes(asleep),
      "and an explicit state is a question about state, not a queue");
    assert.ok(ids(await ops.listBugs(r.root, { backlog: true }) as any).includes(asleep));
    const detail = await ops.bugDetail(r.root, asleep) as any;
    assert.equal(detail.backlogged.state, "sleeping", "the detail agrees with the list about one bug");
  } finally { r.cleanup(); }
});

test("the release condition fires on its own — a due or woken bug is back in the queue", async () => {
  const r = await repo();
  try {
    const due = await file(r.root, r.otherId, "deadline passed");
    const woken = await file(r.root, r.anchorId, "code moved under it");
    // Cites the file this test does not touch, or it would wake with `woken`.
    const sleeping = await file(r.root, r.otherId, "still asleep");
    for (const id of [due, woken, sleeping]) {
      ok(await ops.backlogOn(r.root, { id, until: id === due ? "2026-01-01" : "2099-01-01", reason: "not now" }));
    }
    // Somebody is editing the exact code the decision was about — the early wake, and the
    // half only codemap can offer.
    r.edit(V2);

    const working = ids(await ops.listBugs(r.root, { open: true, asOf: "2026-09-01" }) as any);
    assert.ok(working.includes(due), "you said you would come back, and the date has passed");
    assert.ok(working.includes(woken), "and somebody is editing the code the deferral was about");
    assert.ok(!working.includes(sleeping), "the one still asleep stays out");

    const register = await ops.listBugs(r.root, { backlog: true, asOf: "2026-09-01" }) as any;
    const state = Object.fromEntries(register.bugs.map((b: any) => [b.id, b.backlogged.state]));
    assert.equal(state[due], "due");
    assert.equal(state[woken], "woken");
    assert.equal(state[sleeping], "sleeping");
    assert.equal(register.sleeping, 1, "and `sleeping` counts only the ones that still are");
  } finally { r.cleanup(); }
});

/**
 * The subtlety the finding side got wrong first, and the one this will drift from.
 *
 * `SharedBug.anchors` carries the hashes the bug was FILED with, and backlogging normally
 * follows an investigation — so a release condition keyed on those fires the moment it is
 * granted, on code that moved days ago. The snapshot is taken NOW.
 */
test("the witnesses are snapshotted when it is BACKLOGGED, not read off the bug", async () => {
  const r = await repo();
  try {
    const id = await file(r.root, r.anchorId, "settlement double posts");
    // The investigation: the code moves between filing and the decision.
    r.edit(V2);
    assert.equal((await ops.listBugs(r.root) as any).bugs.find((b: any) => b.id === id).possiblyFixed, true,
      "the FILING witness is already stale — this is the state a deferral is normally granted in");

    ok(await ops.backlogOn(r.root, { id, until: "2099-01-01", reason: "not now" }));
    const after = await ops.listBugs(r.root, { backlog: true }) as any;
    assert.equal(after.bugs[0]!.backlogged.state, "sleeping",
      "keyed on the filing witness it would have woken instantly, on code that moved before the decision");

    // Mutation check: it wakes on the NEXT change, so `sleeping` above is a live answer
    // and not a witness the comparison silently could not use.
    r.edit(V3);
    assert.equal((await ops.listBugs(r.root, { backlog: true }) as any).bugs[0]!.backlogged.state, "woken");
  } finally { r.cleanup(); }
});

test("an agent may not backlog a bug or bring one back — and the refusal says why", async () => {
  const r = await repo();
  try {
    const id = await file(r.root, r.anchorId, "settlement double posts");
    markAgentSession();
    assert.match(err(await ops.backlogOn(r.root, { id, until: "2099-01-01", reason: "not now" })),
      /person's decision/);
    clearAgentSession();

    // Mutation check: the identical call from a person is accepted, so the refusal is
    // about the actor and not about the input.
    ok(await ops.backlogOn(r.root, { id, until: "2099-01-01", reason: "not now" }));

    markAgentSession();
    assert.match(err(await ops.releaseBacklogOn(r.root, id, "we are doing it now")), /person's/);
    clearAgentSession();
    assert.ok((await ops.listBugs(r.root, { backlog: true }) as any).bugs.length, "and it is still deferred");
  } finally { clearAgentSession(); r.cleanup(); }
});

test("a deferral needs a deadline and a reason, and bringing one back needs a reason", async () => {
  const r = await repo();
  try {
    const id = await file(r.root, r.anchorId, "settlement double posts");
    assert.match(err(await ops.backlogOn(r.root, { id, until: "", reason: "not now" })), /needs `until`/);
    assert.match(err(await ops.backlogOn(r.root, { id, until: "next quarter", reason: "not now" })), /needs `until`/);
    assert.match(err(await ops.backlogOn(r.root, { id, until: "2099-01-01", reason: "  " })), /needs a reason/);

    ok(await ops.backlogOn(r.root, { id, until: "2099-01-01", reason: "not now" }));
    assert.match(err(await ops.releaseBacklogOn(r.root, id, "")), /say why/);

    // …and the reason is RECORDED, not merely demanded. The finding path shipped
    // required-field theatre here, on the store that holds most of the backlog.
    ok(await ops.releaseBacklogOn(r.root, id, "the rewrite slipped"));
    const back = (await readBug(r.root, id))!;
    assert.equal(back.backlogged, undefined);
    assert.ok(back.thread.some((c) => c.body.includes("the rewrite slipped")), "the reason is on the record");
  } finally { r.cleanup(); }
});

test("with a sidecar it is an EVENT, so a teammate's clone sees the same decision", async () => {
  const r = await repo(true);
  try {
    const id = await file(r.root, r.anchorId, "settlement double posts");
    ok(await ops.backlogOn(r.root, { id, until: "2099-01-01", reason: "the rewrite lands next quarter" }));

    const cfg = resolveSidecar(r.root)!;
    const fromLog = (await readBugsShared(cfg.path, cfg.universe)).get(id)!;
    assert.equal(fromLog.backlogged?.until, "2099-01-01",
      "in the log, not only in this machine's row — a local mutation of a fold-owned row is the ownership failure");
    assert.deepEqual(fromLog.backlogged?.witnesses?.map((w) => w.anchorId), [r.anchorId]);

    assert.deepEqual(ids(await ops.listBugs(r.root, { open: true }) as any), [], "and the working queue is empty here too");
    ok(await ops.releaseBacklogOn(r.root, id, "we are doing it now"));
    assert.equal((await readBugsShared(cfg.path, cfg.universe)).get(id)!.backlogged, undefined);
    assert.deepEqual(ids(await ops.listBugs(r.root, { open: true }) as any), [id]);
  } finally { r.cleanup(); }
});

/**
 * Publishing must not silently undo a decision.
 *
 * A local bug that was backlogged and lost the record on the way to the team would come
 * straight back into everybody's working queue with no trace of why it had left this one.
 * `publishBug` re-files the row as `bug.filed`, so anything not named there is dropped —
 * which is exactly how a field added later goes missing.
 */
test("a local deferral survives being published to the team", async () => {
  const r = await repo();
  try {
    const id = await file(r.root, r.anchorId, "settlement double posts");
    ok(await ops.backlogOn(r.root, { id, until: "2099-01-01", reason: "the rewrite lands next quarter" }));

    // The sidecar arrives after the fact, which is the ordinary way a store joins a team.
    writeFileSync(join(r.root, ".codemap", "sidecar"), r.side, "utf8");
    ok(await ops.publishBugs(r.root));

    const cfg = resolveSidecar(r.root)!;
    const shared = (await readBugsShared(cfg.path, cfg.universe)).get(id)!;
    assert.equal(shared.backlogged?.until, "2099-01-01", "the deferral went with it");
    assert.equal(shared.backlogged?.reason, "the rewrite lands next quarter");
    assert.deepEqual(ids(await ops.listBugs(r.root, { open: true }) as any), [], "so it stays out of the working queue");
  } finally { r.cleanup(); }
});

/**
 * The dashboard's number and the bugs page's must be one number.
 *
 * A rollup that says N over a list showing N-1 is worse than no number, and this is the
 * shape that produces it: the dashboard reads the store directly rather than through
 * `listBugs`, so a filter added to one and not the other splits them silently.
 */
test("the dashboard does not count a live deferral as work", async () => {
  const r = await repo();
  try {
    const id = await file(r.root, r.anchorId, "settlement double posts");
    await file(r.root, r.anchorId, "ledger totals disagree");
    // Drift on the FILING witness, which is the normal state at the moment a deferral is
    // granted — and the term that used to carry it into `attention` regardless.
    r.edit(V2);
    const before = await ops.dashboard(r.root) as any;
    assert.equal(before.bugs.open, 2);
    assert.equal(before.bugs.possiblyFixed, 2, "the check could have failed — both are drifted");

    ok(await ops.backlogOn(r.root, { id, until: "2099-01-01", reason: "not now" }));
    const after = await ops.dashboard(r.root) as any;
    assert.equal(after.bugs.open, 1, "the dashboard agrees with the list it links to");
    assert.equal(after.bugs.possiblyFixed, 1);
    assert.equal(after.bugs.backlogged, 1, "reported beside them, never dropped");
    assert.equal(after.bugs.sleeping, 1);
    assert.equal(after.attention, before.attention - 1,
      "counting a live deferral as debt makes deferring honestly look identical to ignoring it");
  } finally { r.cleanup(); }
});

/**
 * An AGENT publishing must not strip a person's deferral on the way to the team.
 *
 * `publishBug` re-emits `bug.backlogged` as the PUBLISHER, and the fold drops an agent's —
 * correctly, since an agent may not grant one. So publishing from an agent session put the
 * bug on the team with the deferral gone, back in everybody's working queue, while the
 * result said `published: N` and nothing else.
 */
test("an agent publishing a deferred bug skips it and says so, rather than stripping it", async () => {
  // NO sidecar at first: with one configured a bug goes straight to the log and there is
  // nothing to publish. `publishBugs` is for the rows that predate the sidecar, which is
  // exactly where a person's deferral can already be sitting.
  const r = await repo();
  try {
    const deferred = await file(r.root, r.anchorId, "deferred");
    const ordinary = await file(r.root, r.anchorId, "ordinary");
    ok(await ops.backlogOn(r.root, { id: deferred, until: "2099-01-01", reason: "not now" }));
    writeFileSync(join(r.root, ".codemap", "sidecar"), r.side, "utf8");

    const { markAgentSession, clearAgentSession } = await import("./identity.js");
    markAgentSession();
    let asAgent: any;
    try { asAgent = await ops.publishBugs(r.root, {}); } finally { clearAgentSession(); }
    assert.deepEqual(asAgent.skipped, [deferred], "the deferred one is held back");
    assert.deepEqual(asAgent.ids, [ordinary], "and the ordinary one still goes");
    assert.match(asAgent.note, /Ask a person/);

    // Mutation check: a person publishes it, deferral intact. Without the skip the agent
    // run above would have published it here with `backlogged` silently absent.
    const asPerson = await ops.publishBugs(r.root, {}) as any;
    assert.deepEqual(asPerson.ids, [deferred]);
    const cfg = resolveSidecar(r.root)!;
    assert.equal((await readBugsShared(cfg.path, cfg.universe)).get(deferred)!.backlogged?.until, "2099-01-01");
  } finally { r.cleanup(); }
});

test("a deadline keeps only its DATE, so it cannot sleep a day past itself", async () => {
  // `ISO_DATE` admits a trailing `T` and a full timestamp, and every reader compares
  // `until <= asOf` lexicographically against a date — so anything past the tenth
  // character sorts after the deadline.
  const r = await repo();
  try {
    const id = await file(r.root, r.anchorId, "x");
    ok(await ops.backlogOn(r.root, { id, until: "2027-01-01T00:00:00Z", reason: "not now" }));
    const row = (await ops.listBugs(r.root, { backlog: true, asOf: "2027-01-01" }) as any).bugs[0]!;
    assert.equal(row.backlogged.until, "2027-01-01", "stored as a date");
    assert.equal(row.backlogged.state, "due", "and due ON the deadline, not the day after");
  } finally { r.cleanup(); }
});

/**
 * A deadline stored BEFORE the slice must still be judged as a date.
 *
 * Normalising only on write fixes records made from now on. A row already holding
 * `2027-01-01T00:00:00Z` compares as greater than the date it names, so it slept a day
 * past its own deadline — and the fold's slice never reaches a LOCAL row at all, which is
 * where most of the backlog lives.
 */
test("a deadline stored as a full timestamp is still due on the day it names", async () => {
  const r = await repo();
  try {
    const id = await file(r.root, r.anchorId, "filed before the fix");
    const bug = (await readBug(r.root, id))!;
    bug.backlogged = { until: "2027-01-01T00:00:00Z", reason: "r", by: { principal: "izzie@x.com" }, at: "2026-01-01T00:00:00Z" };
    await writeLocalBug(r.root, bug);

    const register = await ops.listBugs(r.root, { backlog: true, asOf: "2027-01-01" }) as any;
    assert.equal(register.bugs[0]!.backlogged.state, "due", "due ON the deadline, not the day after");
    assert.equal(register.bugs[0]!.backlogged.until, "2027-01-01", "and shown as the date it is");
    assert.ok(ids(await ops.listBugs(r.root, { open: true, asOf: "2027-01-01" }) as any).includes(id),
      "so it is back in the working queue");
  } finally { r.cleanup(); }
});

test("the publish dry run predicts what the real run does, for an agent too", async () => {
  const r = await repo();
  try {
    const deferred = await file(r.root, r.anchorId, "deferred");
    await file(r.root, r.anchorId, "ordinary");
    ok(await ops.backlogOn(r.root, { id: deferred, until: "2099-01-01", reason: "not now" }));
    writeFileSync(join(r.root, ".codemap", "sidecar"), r.side, "utf8");

    const { markAgentSession, clearAgentSession } = await import("./identity.js");
    markAgentSession();
    try {
      const dry = await ops.publishBugs(r.root, { dryRun: true }) as any;
      const live = await ops.publishBugs(r.root, {}) as any;
      // It answered `wouldPublish: 2` for a run that publishes 1. A prediction that
      // disagrees with the act is worse than no prediction.
      assert.equal(dry.wouldPublish, live.published);
      assert.deepEqual(dry.wouldSkip, live.skipped);
    } finally { clearAgentSession(); }
  } finally { r.cleanup(); }
});
