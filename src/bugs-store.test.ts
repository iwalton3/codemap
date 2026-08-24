/**
 * Bugs as STORED, as opposed to as folded.
 *
 * Three things this covers that `shared-bugs.test.ts` cannot, because they are about
 * the table rather than the log:
 *
 * - **The blob migration.** Every store that exists has its bugs in `meta["bugs"]`, and
 *   no fixture in this repository is born there. That blind spot has already shipped a
 *   build that could not open any pre-existing store — see `schema-eras.ts`.
 * - **Adoption.** Publishing preserves the id, so the fold inserts one the table already
 *   has. Getting that wrong is a constraint violation INSIDE the fold transaction, which
 *   fails every bug read on the one store that matters and never self-heals.
 * - **The routing.** With a sidecar a write is an event; without one it is a row. A
 *   local write to a fold-owned row is the quiet failure the ownership rule exists for.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { db } from "./db.js";
import { readAnchorStore, readBugs, readBug, writeLocalBug } from "./store.js";
import { testBug } from "./test-events.js";
import { resolveSidecar } from "./sidecar-config.js";
import { bugScope, readBugsShared } from "./shared-bugs.js";
import { readScope } from "./eventlog.js";
import * as ops from "./ops.js";

const git = (root: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=izzie", ...args], { cwd: root, encoding: "utf8" });

/**
 * A universe with one indexed symbol, and optionally a sidecar.
 *
 * The remote and the pointer go in BEFORE `init`: `universeKey` memoises per root, so
 * adding either afterwards leaves the cached key from before it existed and everything
 * publishes under a scope the fold does not look for.
 */
async function repo(withSidecar = false) {
  const root = mkdtempSync(join(tmpdir(), "codemap-bs-"));
  const side = mkdtempSync(join(tmpdir(), "codemap-bs-side-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "remote", "add", "origin", "https://github.com/acme/api.git");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".codemap"), { recursive: true });
  if (withSidecar) writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
  writeFileSync(join(root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "one");
  await ops.init(root);
  const anchorId = (await readAnchorStore(root)).anchors[0]!.id;
  return { root, side, anchorId, cleanup: () => [root, side].forEach((r) => rmSync(r, { recursive: true, force: true })) };
}

const noSidecar = async <T>(fn: () => Promise<T>): Promise<T> => {
  const saved = process.env.CODEMAP_SIDECAR;
  delete process.env.CODEMAP_SIDECAR;
  try { return await fn(); } finally { if (saved !== undefined) process.env.CODEMAP_SIDECAR = saved; }
};

// --- the one-time blob migration -------------------------------------------------

/**
 * A store as it really is before the `bugs` table: everything in `meta["bugs"]`.
 *
 * Written with a raw connection and CLOSED, so `db()` opens it for the first time and
 * the migration actually runs. `db()` caches per root — seeding through it and reading
 * back would test nothing, because `migrateBugsBlob` runs once at open.
 */
function blobStore(blob: string): string {
  const root = mkdtempSync(join(tmpdir(), "codemap-blob-"));
  mkdirSync(join(root, ".codemap"), { recursive: true });
  const d = new DatabaseSync(join(root, ".codemap", "codemap.db"));
  d.exec("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);");
  d.prepare("INSERT INTO meta(k,v) VALUES('bugs',?)").run(blob);
  d.close();
  return root;
}

test("the legacy `meta[\"bugs\"]` blob becomes rows, once, and the vocabulary maps", async () => {
  // Written the way a real pre-table store holds it: parallel `anchors` and
  // `witnesses`, a free-text `history`, and the four old statuses.
  const root = blobStore(JSON.stringify({
    schemaVersion: 1,
    bugs: [
      { id: "bug_a", title: "open one", status: "open", severity: "high", description: "d",
        anchors: ["a_one", "a_unwitnessed"], witnesses: [{ anchorId: "a_one", bodyHash: "sha256:old" }],
        createdCommit: "abc", history: ["opened", "reproduced on staging"] },
      { id: "bug_b", title: "fixed one", status: "fixed", severity: "low", description: "d", anchors: [], witnesses: [], history: [] },
      { id: "bug_c", title: "not doing it", status: "wontfix", severity: "low", description: "d", anchors: [], witnesses: [], history: [] },
      { id: "bug_d", title: "bogus", status: "invalid", severity: "low", description: "d", anchors: [], witnesses: [], history: [] },
    ],
  }));
  try {
    const bugs = (await readBugs(root)).bugs;
    assert.deepEqual(bugs.map((b) => `${b.id}:${b.state}`),
      ["bug_a:created", "bug_b:resolved", "bug_c:withdrawn", "bug_d:invalid"],
      "open→created, fixed→resolved, wontfix→withdrawn, invalid→invalid");

    const a = bugs.find((b) => b.id === "bug_a")!;
    assert.deepEqual(a.anchors.map((x) => `${x.anchorId}=${x.bodyHash}`),
      ["a_one=sha256:old", "a_unwitnessed=sha256:absent"],
      "the two parallel lists join, and a citation nobody witnessed says so rather than vanishing");
    assert.deepEqual(a.thread.map((c) => c.body), ["opened", "reproduced on staging"],
      "the free-text history is the thread it always was — it is the only record these bugs have");
    assert.equal(a.text, "d", "and the prose came across");
    assert.equal(a.author.principal, "", "nobody is invented as the author: a legacy bug has none");
    assert.equal(a.origin, undefined, "and it is LOCAL — publishing on upgrade would attribute the whole backlog to whoever upgraded first");
    assert.equal(bugs.find((b) => b.id === "bug_c")!.closed?.reason, "wontfix",
      "…with the old name kept, because `withdrawn` alone loses the deliberateness of a wontfix");

    assert.equal((db(root).prepare("SELECT COUNT(*) c FROM meta WHERE k='bugs'").get() as any).c, 0,
      "the blob is dropped in the same transaction, so a second open has nothing to import");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a blob this build cannot parse is left alone rather than dropped", async () => {
  const root = blobStore("{ not json");
  try {
    assert.deepEqual((await readBugs(root)).bugs, []);
    assert.equal((db(root).prepare("SELECT COUNT(*) c FROM meta WHERE k='bugs'").get() as any).c, 1,
      "nothing is destroyed — a later build can still look at it");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- filing, with and without a team ---------------------------------------------

test("with no sidecar a bug is a local row, and codemap works exactly as it always did", async () => {
  const r = await repo();
  try {
    await noSidecar(async () => {
      const filed = await ops.reportBug(r.root, { title: "t", description: "d", anchors: [r.anchorId] }) as any;
      assert.ok(filed.ok);
      assert.equal(filed.shared, false);
      const b = (await readBug(r.root, filed.id))!;
      assert.equal(b.origin, undefined);
      assert.deepEqual(b.anchors.map((a) => a.anchorId), [r.anchorId]);
      assert.ok(b.anchors[0]!.bodyHash.length > 10, "and it is witnessed against the code in front of it");
    });
  } finally { r.cleanup(); }
});

test("with a sidecar the bug enters the LOG the moment it is filed, and reads back at once", async () => {
  const r = await repo(true);
  try {
    const filed = await ops.reportBug(r.root, { title: "t", description: "d", anchors: [r.anchorId] }) as any;
    assert.equal(filed.shared, true);
    const cfg = resolveSidecar(r.root)!;
    const events = await readScope(cfg.path, bugScope(cfg.universe));
    assert.deepEqual(events.map((e) => e.kind), ["bug.filed"]);

    // Write-through: without it the bug is in the log and in nobody's table until the
    // next sync, so the tool that just filed it reads back nothing.
    const listed = await ops.listBugs(r.root) as any;
    assert.deepEqual(listed.bugs.map((b: any) => b.id), [filed.id]);
    assert.equal(listed.bugs[0]!.shared, true);
  } finally { r.cleanup(); }
});

test("a fold-owned row may not be written locally — the ownership rule, mechanically", async () => {
  const r = await repo(true);
  try {
    const filed = await ops.reportBug(r.root, { title: "t", description: "d", anchors: [r.anchorId] }) as any;
    const b = (await readBug(r.root, filed.id))!;
    assert.ok(b.origin, "it is the fold's now");
    await assert.rejects(() => writeLocalBug(r.root, { ...b, title: "sneaky" }), /owned by the sidecar fold/);
  } finally { r.cleanup(); }
});

// --- publishing what was already here, and adoption -------------------------------

test("publishing a local bug ADOPTS its row instead of colliding with it", async () => {
  const r = await repo(true);
  try {
    // A bug from before the sidecar existed: a local row, thread and all.
    await writeLocalBug(r.root, testBug({
      id: "bug_old", title: "from the blob", text: "d", createdAt: "2026-01-04T00:00:00Z",
      cites: [{ anchorId: r.anchorId, bodyHash: "sha256:old" }],
      thread: [{ id: "bug_old_h0", actor: { principal: "" }, at: "2026-01-04T00:00:00Z", body: "opened" }],
    }));

    const dry = await ops.publishBugs(r.root, { dryRun: true }) as any;
    assert.equal(dry.wouldPublish, 1);
    assert.equal((await readBug(r.root, "bug_old"))!.origin, undefined, "a count must not write");

    const out = await ops.publishBugs(r.root) as any;
    assert.deepEqual(out.ids, ["bug_old"]);

    const rows = db(r.root).prepare("SELECT COUNT(*) c FROM bugs WHERE id='bug_old'").get() as any;
    assert.equal(rows.c, 1, "one bug, one row — the id was preserved because it is the same bug");
    const b = (await readBug(r.root, "bug_old"))!;
    assert.ok(b.origin, "and the row is the fold's now");
    assert.deepEqual(b.thread.map((c) => c.body), ["opened"],
      "the thread travelled: adoption overwrites the local row, so a publish that sent only `bug.filed` would destroy it");
    assert.equal(b.filedAt, "2026-01-04T00:00:00Z",
      "…and when it was originally filed survives, apart from when it reached the team");

    const again = await ops.publishBugs(r.root) as any;
    assert.equal(again.published, 0, "nothing local is left, so a second publish is a no-op");
  } finally { r.cleanup(); }
});

test("a local row EDITED since it was published is not overwritten by the fold", async () => {
  const r = await repo(true);
  try {
    await writeLocalBug(r.root, testBug({ id: "bug_x", title: "original", text: "d" }));
    const cfg = resolveSidecar(r.root)!;
    const { fileBug } = await import("./shared-bugs.js");
    await fileBug(cfg.path, cfg.universe, { principal: "dana@x.com" }, { id: "bug_x", title: "original", text: "d", anchors: [] });
    // The local row moves on before the first fold — the window a publish leaves open.
    await writeLocalBug(r.root, testBug({ id: "bug_x", title: "edited since", text: "d" }));

    await ops.listBugs(r.root);
    assert.equal((await readBug(r.root, "bug_x"))!.title, "edited since",
      "local rows are the one non-regenerable thing in this database — the event is left in the log instead");
  } finally { r.cleanup(); }
});

// --- commenting, and external tracking --------------------------------------------

test("a comment on a shared bug is an event and shows to everyone reading the scope", async () => {
  const r = await repo(true);
  try {
    const filed = await ops.reportBug(r.root, { title: "t", description: "d", anchors: [r.anchorId] }) as any;
    assert.ok((await ops.commentBug(r.root, filed.id, "reproduced on staging") as any).ok);
    const cfg = resolveSidecar(r.root)!;
    const shared = (await readBugsShared(cfg.path, cfg.universe)).get(filed.id)!;
    assert.deepEqual(shared.thread.map((c) => c.body), ["reproduced on staging"]);
    assert.equal(((await ops.commentBug(r.root, filed.id, "   ")) as any).error, "an empty comment says nothing");
  } finally { r.cleanup(); }
});

test("a comment on a LOCAL bug still lands, because codemap works without a team", async () => {
  const r = await repo();
  try {
    await noSidecar(async () => {
      const filed = await ops.reportBug(r.root, { title: "t", description: "d", anchors: [r.anchorId] }) as any;
      await ops.commentBug(r.root, filed.id, "note to self");
      assert.deepEqual((await readBug(r.root, filed.id))!.thread.map((c) => c.body), ["note to self"]);
    });
  } finally { r.cleanup(); }
});

test("a tracking link needs somewhere to point, and has to be a link", async () => {
  const r = await repo(true);
  try {
    const filed = await ops.reportBug(r.root, { title: "t", description: "d", anchors: [r.anchorId] }) as any;
    assert.match((await ops.trackBugExternally(r.root, filed.id, {}) as any).error, /needs a key or a URL/);
    assert.match((await ops.trackBugExternally(r.root, filed.id, { url: "ACME-1" }) as any).error, /not a link/);

    const ok = await ops.trackBugExternally(r.root, filed.id, { key: "ACME-1", url: "https://jira/ACME-1" }) as any;
    assert.deepEqual(ok.tracking, [{ system: "jira", key: "ACME-1", url: "https://jira/ACME-1" }]);

    const detail = await ops.bugDetail(r.root, filed.id) as any;
    assert.equal(detail.tracked, true);
    assert.equal(detail.state, "created", "and being in a tracker did not close it");
  } finally { r.cleanup(); }
});

test("tracking a bug with no team says where it would go, rather than pretending", async () => {
  const r = await repo();
  try {
    await noSidecar(async () => {
      const filed = await ops.reportBug(r.root, { title: "t", description: "d", anchors: [r.anchorId] }) as any;
      assert.match((await ops.trackBugExternally(r.root, filed.id, { key: "ACME-1" }) as any).error,
        /no sidecar is configured/);
    });
  } finally { r.cleanup(); }
});

// --- the drift verdict, which is computed here and never stored ---------------------

test("a bug whose code moved is QUEUED, not closed", async () => {
  const r = await repo(true);
  try {
    const filed = await ops.reportBug(r.root, { title: "t", description: "d", anchors: [r.anchorId] }) as any;
    writeFileSync(join(r.root, "src", "pay.ts"), "export function transfer(c: number) { return Math.abs(c); }\n", "utf8");

    const listed = await ops.listBugs(r.root) as any;
    const b = listed.bugs.find((x: any) => x.id === filed.id);
    assert.equal(b.possiblyFixed, true);
    assert.equal(b.state, "created", "the code vanishing under a bug is not evidence it was fixed");
    assert.equal((await ops.listBugs(r.root, { queue: true }) as any).bugs.length, 1,
      "so it goes to the queue a person clears");

    // …and the verdict is nobody else's. It is a join against THIS index.
    const cfg = resolveSidecar(r.root)!;
    const shared = (await readBugsShared(cfg.path, cfg.universe)).get(filed.id)!;
    assert.ok(!JSON.stringify(shared).includes("possiblyFixed"));
  } finally { r.cleanup(); }
});

test("refreshing the witnesses clears the drift — and it is an event, not a row edit", async () => {
  const r = await repo(true);
  try {
    const filed = await ops.reportBug(r.root, { title: "t", description: "d", anchors: [r.anchorId] }) as any;
    writeFileSync(join(r.root, "src", "pay.ts"), "export function transfer(c: number) { return Math.abs(c); }\n", "utf8");
    assert.equal((await ops.bugDetail(r.root, filed.id) as any).staleAnchors, 1);

    await ops.updateBug(r.root, { id: filed.id, refreshWitnesses: true, note: "still wrong, re-witnessed" });
    assert.equal((await ops.bugDetail(r.root, filed.id) as any).staleAnchors, 0);
    const cfg = resolveSidecar(r.root)!;
    const kinds = (await readScope(cfg.path, bugScope(cfg.universe))).map((e) => e.kind);
    assert.deepEqual(kinds, ["bug.filed", "bug.anchored", "bug.commented"],
      "separate acts, because they merge differently — a citation is grow-only and a comment is not");
  } finally { r.cleanup(); }
});

// --- accepting a finding ------------------------------------------------------------

test("accepting a finding files a bug, cross-links it, and takes the obligation", async () => {
  const r = await repo(true);
  try {
    const shared = await import("./ops-shared.js");
    const f = await shared.shareFinding(r.root, 264, {
      targetKind: "anchor", targetId: r.anchorId, text: "negatives are not rejected", comment: "guard it",
      severity: "high", category: "Validation",
    }) as any;

    const accepted = await ops.acceptFinding(r.root, 264, f.id) as any;
    assert.ok(accepted.ok);

    const bug = await ops.bugDetail(r.root, accepted.id) as any;
    assert.equal(bug.title, "negatives are not rejected");
    assert.equal(bug.severity, "high");
    assert.equal(bug.category, "Validation");
    assert.deepEqual(bug.anchors.map((a: any) => a.id), [r.anchorId], "witnessed against the code here");
    assert.deepEqual(bug.from, { pr: "264", finding: f.id });
    assert.ok(bug.text.includes("guard it"), "and the submitter-facing summary is kept beside the evidence");

    const findings = await shared.sharedFindings(r.root, 264) as any;
    assert.equal(findings.findings[0]!.bug, accepted.id, "the finding survives and cross-links");
    assert.equal(findings.findings[0]!.state, "created", "the PR's history should still show it was raised there");
    assert.equal(findings.waitingOnYou, 0, "its successor is asking now, not it");

    assert.match((await ops.acceptFinding(r.root, 264, f.id) as any).error, /already bug/);
  } finally { r.cleanup(); }
});

test("a finding pointing at code this checkout does not have is refused, not guessed at", async () => {
  const r = await repo(true);
  try {
    const shared = await import("./ops-shared.js");
    const f = await shared.shareFinding(r.root, 264, {
      targetKind: "anchor", targetId: "a_from_another_branch", text: "something", comment: "x",
    }) as any;
    assert.match((await ops.acceptFinding(r.root, 264, f.id) as any).error,
      /resolves to no anchor in this checkout/);
  } finally { r.cleanup(); }
});

test("accepting with no sidecar says so — a bug nobody else can see is not accepting", async () => {
  const r = await repo();
  try {
    await noSidecar(async () => {
      assert.match((await ops.acceptFinding(r.root, 264, "f_1") as any).error, /no sidecar configured/);
    });
  } finally { r.cleanup(); }
});
