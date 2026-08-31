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
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
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
import { markAgentSession, clearAgentSession } from "./identity.js";

const ok = <T>(r: T): Exclude<T, { error: string }> => {
  assert.ok(!(r && typeof r === "object" && "error" in (r as object)), `unexpected error: ${(r as any)?.error}`);
  return r as Exclude<T, { error: string }>;
};
import { discard } from "./test-tmp.js";

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
  return { root, side, anchorId, cleanup: () => [root, side].forEach((r) => discard(r)) };
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
  } finally { discard(root); }
});

test("a blob this build cannot parse is left alone rather than dropped", async () => {
  const root = blobStore("{ not json");
  try {
    assert.deepEqual((await readBugs(root)).bugs, []);
    assert.equal((db(root).prepare("SELECT COUNT(*) c FROM meta WHERE k='bugs'").get() as any).c, 1,
      "nothing is destroyed — a later build can still look at it");
  } finally { discard(root); }
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
    assert.match((await ops.deferFinding(r.root, f.id) as any).error,
      /resolves to no anchor here/);
  } finally { r.cleanup(); }
});

test("a finding on code the BRANCH introduces defers — that is the normal case, not an edge", async () => {
  const r = await repo(true);
  try {
    // The shape that read like a design limit: a finding about code the pull request
    // ADDS resolves to no `@work` anchor, so deferring it answered "index the branch it
    // is on first" over a snapshot `codemap pr <N>` had already written. `resolveRefs`
    // carried `scopeRef` and `includeOrphans` the whole time, with comments describing
    // this exact case; `witnessRefs` was the one call site that did not pass them.
    const { writeSnapshot } = await import("./store.js");
    const { indexBlob } = await import("./repo.js");
    const src = "export function onlyOnTheBranch(cents: number) {\n  return cents * 2;\n}\n";
    const branchAnchors = await indexBlob(src, "src/branch-only.ts");
    const id = branchAnchors[0]!.id;
    await writeSnapshot(r.root, "prhead", "feature/x", branchAnchors, "2026-08-19T00:00:00Z");

    const shared = await import("./ops-shared.js");
    const f = await shared.shareFinding(r.root, 264, {
      targetKind: "anchor", targetId: id, text: "doubles instead of halving", comment: "fix the factor",
      sourceRef: "prhead",
    } as never) as any;

    const accepted = await ops.deferFinding(r.root, f.id) as any;
    assert.ok(accepted.ok, `deferral refused: ${accepted.error}`);
    const bug = await ops.bugDetail(r.root, accepted.id) as any;
    assert.deepEqual(bug.anchors.map((a: any) => a.id), [id], "anchored to the branch's symbol");
    // The symbol is not in the WORKING tree — it exists only on the branch — so the bug
    // records that honestly rather than refusing to exist. `present: false` with no
    // staleness reads as "this is elsewhere", which is exactly true.
    assert.equal(bug.anchors[0]!.present, false);
    assert.equal(bug.anchors[0]!.stale, false, "not stale — it was never here to drift");
    assert.deepEqual(bug.from, { pr: "264", finding: f.id }, "and it carries the cross-link");
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


/**
 * Reading a bug list: what is ON it by default, in what ORDER, and what is being ASKED.
 *
 * All three were absent. The list came back in whatever order the store held it, with
 * every resolved and withdrawn bug in it — so on a map with any history the first thing a
 * person read was an accident about work nobody has to do. And an agent asking to close a
 * bug folded into `waitingOnYou` beside four unrelated reasons, so the one queue worth
 * working after a fixing pass was indistinguishable from a severity argument.
 */
test("the list is open-first, ordered, and says what is being asked", async () => {
  const r = await repo(true);
  try {
    const mk = async (title: string, severity: "low" | "medium" | "high" | "critical") =>
      (await ops.reportBug(r.root, { title, description: "d", severity, anchors: [r.anchorId] }) as any).id;
    const low = await mk("a low one", "low");
    const crit = await mk("a critical one", "critical");
    const med = await mk("a medium one", "medium");

    // SEVERITY by default. Filing order is low, critical, medium — so store order and
    // severity order disagree, which is what makes this assertion mean something.
    const bySev = await ops.listBugs(r.root) as any;
    assert.equal(bySev.sort, "severity");
    assert.deepEqual(bySev.bugs.map((b: any) => b.severity), ["critical", "medium", "low"]);
    assert.deepEqual((await ops.listBugs(r.root, { sort: "title" }) as any).bugs.map((b: any) => b.title),
      ["a critical one", "a low one", "a medium one"]);
    assert.deepEqual((await ops.listBugs(r.root, { sort: "oldest" }) as any).bugs.map((b: any) => b.id),
      [low, crit, med], "filing order, which is exactly what severity order is not");

    // An AGENT asks to close one. It may not close it itself — that is the ratchet — so
    // the attempt becomes an ask, and the ask is what a person needs to see.
    markAgentSession();
    try {
      ok(await ops.requestOnBugOp(r.root, crit, "resolve", "the guard is in place now"));
    } finally { clearAgentSession(); }

    const rows = (await ops.listBugs(r.root) as any).bugs;
    const asked = rows.find((b: any) => b.id === crit);
    assert.equal(asked.pending.ask, "resolve", "the ask itself, not just `waitingOnYou`");
    assert.equal(asked.pending.rationale, "the guard is in place now",
      "and WHY — a person deciding needs the reason, not a badge");
    assert.equal(rows.find((b: any) => b.id === low).pending, undefined);

    // …and it is its own queue, narrower than "needs you".
    const askedOnly = await ops.listBugs(r.root, { asked: true }) as any;
    assert.deepEqual(askedOnly.bugs.map((b: any) => b.id), [crit]);
    assert.equal(askedOnly.asked, 1);

    // OPEN excludes what is closed, and `counts` still describes everything — the filter
    // is a view, not a deletion.
    ok(await ops.updateBug(r.root, { id: low, state: "resolved" }));
    const openOnly = await ops.listBugs(r.root, { open: true }) as any;
    assert.equal(openOnly.bugs.some((b: any) => b.id === low), false, "a closed bug is history, not work");
    assert.equal(openOnly.open, 2);
    assert.equal(openOnly.counts.resolved, 1, "the count is of everything, whatever the filter shows");
    assert.equal((await ops.listBugs(r.root) as any).bugs.length, 3, "unfiltered still means unfiltered");
  } finally { r.cleanup(); }
});

/**
 * A bug id is the one thing in this store a person actually holds in their head — it comes
 * off a PR comment, a ticket, a teammate's message — and the only way to reach one was to
 * know it was a bug, go to that page, and scroll.
 */
test("search finds a bug by its id and by its title, open ones first", async () => {
  const r = await repo(true);
  try {
    const shut = (await ops.reportBug(r.root, { title: "ledger rounding drifts", description: "old", anchors: [r.anchorId] }) as any).id;
    const live = (await ops.reportBug(r.root, { title: "ledger totals disagree", description: "new", anchors: [r.anchorId] }) as any).id;
    ok(await ops.updateBug(r.root, { id: shut, state: "resolved" }));

    const byId = await ops.search(r.root, live) as any;
    assert.deepEqual(byId.bugs.map((b: any) => b.id), [live], "pasting an id and getting nothing is the specific failure");

    const byWord = await ops.search(r.root, "ledger") as any;
    assert.deepEqual(byWord.bugs.map((b: any) => b.id), [live, shut], "open first — a closed match is history");
    assert.equal(byWord.bugs[1]!.closed, true, "and it says so, rather than looking live");

    // The prose too, not just the title.
    assert.deepEqual((await ops.search(r.root, "old") as any).bugs.map((b: any) => b.id), [shut]);
    assert.deepEqual((await ops.search(r.root, "nothing matches this") as any).bugs, []);
  } finally { r.cleanup(); }
});


/**
 * Search has to MATERIALIZE first, like every other bug read.
 *
 * `listBugs` and `bugDetail` open with `refreshBugRows`; the new search arm read the table
 * directly. So a teammate's bug that is in the shared log but not yet folded into this
 * machine's rows was unfindable until some unrelated list or detail read happened to fold
 * it — which is exactly the failure the search was added for, on the bugs most worth
 * finding. Found by codex and by the /code-review pass independently.
 */
test("search finds a teammate's bug straight from the log, with no list read first", async () => {
  const r = await repo(true);
  try {
    const { fileBug } = await import("./shared-bugs.js");
    const cfg = resolveSidecar(r.root)!;
    await fileBug(cfg.path, cfg.universe, { principal: "mate@x.com" }, {
      id: "bug_needle", title: "Needle", text: "exact search target", anchors: [],
    } as never);

    // No `listBugs` first. That call is what used to be doing the materializing.
    assert.deepEqual((await ops.search(r.root, "bug_needle") as any).bugs.map((b: any) => b.id), ["bug_needle"],
      "a bug in the log and not yet in the rows is the one a person is most likely to paste an id for");
  } finally { r.cleanup(); }
});

/**
 * The "asked to close" queue, and its count, must describe the same bugs.
 *
 * Two defects in one row. `bug.stateChanged` clears `pending` but keeps the outcome as
 * history, so a bug reported fixed and then resolved by a person carried
 * `reported.result === "fixed"` for ever and sat in the queue for ever with it, asking for
 * a decision already made. And the counts were derived from a list already narrowed by
 * `state`/`open` while the chip they feed navigates to a differently-filtered view — so
 * the number and the list it opens disagreed. Codex found the first, /code-review the
 * second.
 *
 * Built with `testBug` on a LOCAL store, because a bug's `outcome` has no op of its own:
 * it arrives from the fold or with a finding, and the thing under test is `listBugs`.
 */
test("the asked-to-close queue drops what is already closed, and its count matches its list", async () => {
  const r = await repo();
  try {
    const at = "2026-08-30T00:00:00Z";
    const who = { principal: "mate@x.com" };
    await writeLocalBug(r.root, testBug({
      id: "bug_live", title: "still open", state: "created",
      pending: { ask: "resolve", by: who, at, rationale: "the guard is in place now" },
    }));
    await writeLocalBug(r.root, testBug({
      id: "bug_fixed", title: "reported fixed, still open", state: "created",
      outcome: { result: "fixed", detail: "done", by: who, at },
    }));
    await writeLocalBug(r.root, testBug({
      id: "bug_done", title: "already dealt with", state: "resolved",
      outcome: { result: "fixed", detail: "done", by: who, at },
      closed: { reason: "verified", by: who, at: "2026-08-31T00:00:00Z" },
    }));

    const asked = await ops.listBugs(r.root, { asked: true }) as any;
    assert.deepEqual(asked.bugs.map((b: any) => b.id).sort(), ["bug_fixed", "bug_live"],
      "an open ask and an open report are asks; a decision already made is not");
    assert.equal(asked.bugs.some((b: any) => b.id === "bug_done"), false);

    // The COUNT is over everything, so the chip agrees with the view it opens — that view
    // sends `asked=1` and NO `open` filter, and the count used to be derived from a list
    // the caller had already narrowed.
    const fromOpenView = await ops.listBugs(r.root, { open: true }) as any;
    assert.equal(fromOpenView.asked, asked.bugs.length,
      "a count that disagrees with the list it links to is worse than no count");
    const fromStateView = await ops.listBugs(r.root, { state: "resolved" }) as any;
    assert.equal(fromStateView.asked, asked.bugs.length, "and it does not move with the filter on screen");
  } finally { r.cleanup(); }
});
