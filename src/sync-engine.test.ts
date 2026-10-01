/**
 * The linear log and its sync (plan phase 2): one file per scope in push order, the queue that
 * is append and drop only, the proposal's kill conditions K1/K2/K4 as SEQUENTIAL syncs,
 * transactions, and sessions that are gone. docs/PROPOSAL-online-only-sync.md.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { scenario, who, settle, type Person } from "./scenario.js";
import { LINEAR_SHARD, readScope, readScopeChecked, readSets, registerDoor, sortEvents, type LogEvent } from "./eventlog.js";
import { emitEvent, emitEventChecked, emitEvents } from "./write.js";
import * as queue from "./sync-queue.js";
import { attemptGone, begin, discard as discardTx, dropOp, localConflicts, staged, syncSession } from "./sync-engine.js";
import { withSession } from "./sync-session.js";
import { ensureSidecar, sync, PUSHES_PER_MINUTE } from "./sidecar.js";
import { lockoutOf } from "./lockout.js";
import {
  foldStandardReport, LAW_SCOPE, publishOperation, publishOperationRemoved, publishPointerDeclared, publishSpecDrafted,
  standardScope,
} from "./shared-standard.js";
import { criterionIdFor, requirementIdFor, type Actor, type Operation, type Pointer, type Spec } from "./schema.js";
import { discard } from "./test-tmp.js";

/**
 * A scope whose fold refuses a second claim on one subject — the smallest precondition that
 * the tip can stop meeting, so the engine is tested apart from any real fold's rules.
 */
const CLAIMS = "tst/claims";
registerDoor((s) => s.startsWith("tst/"), () => (events) => {
  const held = new Set<string>();
  const refused: { id: string; why: string }[] = [];
  for (const e of events) {
    if (e.kind !== "claim") continue;
    if (held.has(e.subject)) refused.push({ id: e.id, why: `${e.subject} is already claimed` });
    else held.add(e.subject);
  }
  return { refused };
});
const claim = (p: Person, subject: string) =>
  emitEventChecked(p.sidecar, CLAIMS, p.actor, async () => ({ kind: "claim", subject }));

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
const linesOf = (p: Person, scope: string): LogEvent[] =>
  readFileSync(join(p.sidecar, scope, LINEAR_SHARD), "utf8").trim().split("\n").map((l) => JSON.parse(l) as LogEvent);

/** C2: nothing a sync put on the remote is refused by its own scope's fold. */
function clean(events: LogEvent[], report: (e: LogEvent[]) => { refused: { id: string }[] }): void {
  assert.deepEqual(report(sortEvents(events)).refused, [], "an event on the remote that its fold refuses");
}

// --- 2.1: one file per scope, order = push order ----------------------------------------

test("two writers append to ONE file per scope, and line order is push order, not id order", async () => {
  const s = await scenario(["ana@x.com", "ben@x.com"]);
  try {
    const ana = who(s, "ana@x.com"), ben = who(s, "ben@x.com");
    begin(ana.sidecar);
    const early = await emitEvent(ana.sidecar, "tst/u/b", ana.actor, "noted", "n1");   // minted FIRST, staged
    const late = await emitEvent(ben.sidecar, "tst/u/b", ben.actor, "noted", "n2");    // lands first
    assert.ok(early.id < late.id, "precondition: the staged event has the smaller id");
    const r = await syncSession(ana.sidecar, ana.actor);
    assert.ok(!("error" in r), JSON.stringify(r));
    await settle(s);
    for (const p of [ana, ben]) {
      assert.deepEqual(readdirSync(join(p.sidecar, "tst/u/b")), [LINEAR_SHARD], "one file, whoever wrote");
      assert.deepEqual(linesOf(p, "tst/u/b").map((e) => e.id), [late.id, early.id], "lines in push order");
      assert.deepEqual((await readScope(p.sidecar, "tst/u/b")).map((e) => e.id), [late.id, early.id], "and so is fold order");
    }
    const [a, b] = linesOf(ana, "tst/u/b");
    assert.ok(a!.seq! < b!.seq!, "seq follows the push");
    assert.deepEqual(b!.after, [], "and the staged act records what its author had SEEN: not ben's");
  } finally { s.dispose(); }
});

test("seq orders events across scopes by push, which a merged fold relies on", async () => {
  const s = await scenario(["ana@x.com", "ben@x.com"]);
  try {
    const ana = who(s, "ana@x.com"), ben = who(s, "ben@x.com");
    begin(ana.sidecar);
    const staged1 = await emitEvent(ana.sidecar, "tst/a", ana.actor, "noted", "x");
    const landed = await emitEvent(ben.sidecar, "tst/b", ben.actor, "noted", "y");
    assert.ok(!("error" in await syncSession(ana.sidecar, ana.actor)));
    await settle(s);
    const merged = sortEvents([...await readScope(ben.sidecar, "tst/a"), ...await readScope(ben.sidecar, "tst/b")]);
    assert.deepEqual(merged.map((e) => e.id), [landed.id, staged1.id], "the merged order is the order they landed");
  } finally { s.dispose(); }
});

test("a batch's later acts read the earlier ones, synced inline or staged in a transaction", async () => {
  // A linear `writerPrev` reads nothing (`readSets`), so each act after the first names the one before.
  const s = await scenario(["ana@x.com"]);
  try {
    const ana = who(s, "ana@x.com");
    const items = [{ kind: "noted", subject: "n1" }, { kind: "noted", subject: "n2" }, { kind: "noted", subject: "n3" }];
    const check = async (scope: string, batch: LogEvent[]) => {
      const reads = readSets(await readScope(ana.sidecar, scope));
      assert.ok(reads.saw(batch[2]!.id, batch[0]!.id) && reads.saw(batch[1]!.id, batch[0]!.id), scope);
    };
    await check("tst/u/inline", await emitEvents(ana.sidecar, "tst/u/inline", ana.actor, items));
    begin(ana.sidecar);
    const staged = await emitEvents(ana.sidecar, "tst/u/tx", ana.actor, items);
    assert.ok(!("error" in await syncSession(ana.sidecar, ana.actor)));
    await check("tst/u/tx", staged);
  } finally { s.dispose(); }
});

// --- 2.2: the queue ---------------------------------------------------------------------

test("the queue is append, drop, and re-assign a dead session's items: nothing exported edits an op or moves it", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-queue-"));
  try {
    await ensureSidecar(root, { principal: "q@x.com" });
    // Every exported function, named. A new one that edits or reorders fails here first.
    assert.deepEqual(Object.keys(queue).sort(), [
      "allQueuedIds", "closeQueues", "conflicts", "drop", "forgetSession", "getMeta", "markConflict", "markInflight",
      "markLanded", "markStaged", "markUnknown", "noteRefusal", "pending", "pruneLanded", "reassign", "sessionRow",
      "sessionsWithConflicts", "sessionsWithPending", "setMeta", "setTx", "stage", "touchSession",
    ]);
    const ev = (id: string) => ({ id, kind: "k", subject: "s", actor: { principal: "q@x.com" }, at: "t", after: [], sidecarProtocol: 2, eventSchema: 1 });
    for (const id of ["e1", "e2", "e3"]) queue.stage(root, "s1", "tst/q", ev(id));
    assert.ok(queue.drop(root, "s1", "e2"));
    queue.stage(root, "s1", "tst/q", ev("e4"));
    assert.deepEqual(queue.pending(root, "s1").map((o) => o.event.id), ["e1", "e3", "e4"], "drop, then append at the END");
    queue.markInflight(root, ["e1"]);
    assert.equal(queue.drop(root, "s1", "e1"), false, "an op a sync holds cannot be dropped from under it");
    assert.equal(queue.drop(root, "s2", "e3"), false, "nor by another session");
    // The transitions move state and nothing else.
    const before = queue.pending(root, "s1").map((o) => [o.pos, JSON.stringify(o.event)]);
    queue.markStaged(root, ["e1"]); queue.markInflight(root, ["e3"]); queue.markStaged(root, ["e3"]);
    assert.deepEqual(queue.pending(root, "s1").map((o) => [o.pos, JSON.stringify(o.event)]), before);
    // Re-assignment moves the session and nothing else (owner: "Allow the owner change").
    queue.markStaged(root, ["e1"]);
    queue.reassign(root, "s1", "s3");
    assert.deepEqual(queue.pending(root, "s3").map((o) => [o.pos, JSON.stringify(o.event)]), before);
  } finally { queue.closeQueues(); discard(root); }
});

// --- 2.3: the kill conditions, as sequential syncs --------------------------------------

test("K1: garbage on the remote — the sync takes it, locks, and no write lands on top of it", async () => {
  const s = await scenario(["ana@x.com", "ben@x.com"]);
  try {
    const ana = who(s, "ana@x.com"), ben = who(s, "ben@x.com");
    await claim(ana, "x");
    await settle(s);
    appendFileSync(join(ana.sidecar, CLAIMS, LINEAR_SHARD), "\x00 not json\n");
    git(ana.sidecar, "commit", "-qam", "a broken build"); git(ana.sidecar, "push", "-q", "origin", "HEAD:main");
    const r = await sync(ben.sidecar, ben.actor);
    assert.ok("error" in r && /damaged/.test(r.error), JSON.stringify(r));
    assert.ok(lockoutOf(ben.sidecar), "damage this machine can see locks it");
    // Owner, RULE-locked: "If another instance pushes broken state we should still pull it".
    assert.equal((await readScopeChecked(ben.sidecar, CLAIMS)).status, "blocked", "ben's tree took the bytes, and says so");
    const inline = await claim(ben, "y");
    assert.ok("error" in inline, "a write refuses too, rather than landing on top of it");
  } finally { s.dispose(); }
});

const SPEC: Spec = { id: "sp_1", title: "T", status: "draft", author: { principal: "izzie@x.com" }, createdAt: "2026-08-01T00:00:00.000Z" };
const ADD: Operation = { id: "op_1", specId: "sp_1", kind: "add_requirement", ord: 0, title: "Credit line currency",
  section: "Credit/Limits", statement: "All credit lines are in USD.", provenance: "p", rationale: "r", reversibility: "reversible" };
const CRIT: Operation = { id: "op_2", specId: "sp_1", kind: "add_criterion", ord: 1, targetOperationId: "op_1",
  criterion: "c", falsifier: "f", evidenceKind: "lint-test", rationale: "r", reversibility: "reversible" };
const U = "acme/api";
const pointer = (by: Actor): Pointer => ({
  id: "pt_1", requirementId: requirementIdFor("op_1"), criterionId: criterionIdFor("op_2"), operationId: "op_2", universe: U,
  target: { kind: "anchor", id: "a_lint" }, rationale: "watch it", witnesses: [{ anchorId: "a_lint", bodyHash: "h1:sha256:x" }],
  state: "pending", declaredBy: by, declaredAt: "2026-08-02T00:00:00.000Z",
});
const standardEvents = async (p: Person) =>
  [...await readScope(p.sidecar, LAW_SCOPE), ...await readScope(p.sidecar, standardScope(U))];

for (const first of ["law", "evidence"] as const) {
  test(`K2: law and evidence racing (${first} lands first) — one lands, the other is refused and told, nothing locks`, async () => {
    const s = await scenario(["izzie@x.com", "bob@x.com"]);
    try {
      const izzie = who(s, "izzie@x.com"), bob = who(s, "bob@x.com");
      await publishSpecDrafted(izzie.sidecar, LAW_SCOPE, izzie.actor, SPEC);
      await publishOperation(izzie.sidecar, LAW_SCOPE, izzie.actor, ADD);
      await publishOperation(izzie.sidecar, LAW_SCOPE, izzie.actor, CRIT);
      await settle(s);
      const removal = () => publishOperationRemoved(izzie.sidecar, LAW_SCOPE, izzie.actor,
        { ...CRIT, removed: { reason: "not needed", at: "2026-08-03T00:00:00.000Z", by: izzie.actor } } as Operation);
      const declare = () => publishPointerDeclared(bob.sidecar, standardScope(U), bob.actor, pointer(bob.actor));
      // The one that lands second acted inside a transaction: it had not seen the other.
      const [loser, stage, land] = first === "law" ? [bob, declare, removal] : [izzie, removal, declare];
      begin(loser.sidecar);
      await stage();
      await land();
      const r = await syncSession(loser.sidecar, loser.actor);
      await settle(s).catch(() => {});
      for (const p of [izzie, bob]) {
        assert.equal(lockoutOf(p.sidecar), null, `${p.actor.principal}: a race is not damage`);
        clean(await standardEvents(p), (e) => foldStandardReport(e));
      }
      if ("error" in r) {
        assert.ok(r.conflicts?.length, "a refusal names what was refused");
        assert.deepEqual(staged(loser.sidecar).map((o) => o.event.kind), r.conflicts!.map((c) => c.kind), "and it stays staged for its author");
      }
    } finally { s.dispose(); }
  });
}

test("K4: of two sequential acts the second is validated against the first — refused and told, never silently", async () => {
  const s = await scenario(["ana@x.com", "ben@x.com"]);
  try {
    const ana = who(s, "ana@x.com"), ben = who(s, "ben@x.com");
    begin(ana.sidecar);
    const mine = await claim(ana, "the-desk");
    assert.ok(!("error" in mine), "staging is checked against what ana could see: nobody had claimed it");
    const theirs = await claim(ben, "the-desk");
    assert.ok(!("error" in theirs), "ben's lands");
    const r = await syncSession(ana.sidecar, ana.actor);
    assert.ok("error" in r, "ana's replays against ben's and is refused");
    assert.deepEqual(r.conflicts?.map((c) => [c.kind, c.why]), [["claim", "the-desk is already claimed"]], "and she is told why");
    assert.deepEqual((await readScope(ana.sidecar, CLAIMS)).map((e) => e.actor.principal), ["ben@x.com"],
      "her refused act stays staged for her, and is NOT read as if it would land");
    assert.equal(staged(ana.sidecar).length, 1);
    discardTx(ana.sidecar);
    await settle(s);
    for (const p of [ana, ben]) {
      const events = await readScope(p.sidecar, CLAIMS);
      assert.deepEqual(events.map((e) => e.actor.principal), ["ben@x.com"], "only the one that landed is in the log");
      assert.equal(lockoutOf(p.sidecar), null);
    }
  } finally { s.dispose(); }
});

test("a write with the remote unreachable fails loudly and keeps nothing; staged acts stay staged", async () => {
  const s = await scenario(["ana@x.com"]);
  try {
    const ana = who(s, "ana@x.com");
    git(ana.sidecar, "remote", "set-url", "origin", join(tmpdir(), "codemap-no-such-remote"));
    const inline = await claim(ana, "x");
    assert.ok("error" in inline && /could not reach the sidecar remote/.test(inline.error), JSON.stringify(inline));
    assert.deepEqual(staged(ana.sidecar), [], "an inline act that could not sync is not kept to land later");
    begin(ana.sidecar);
    await claim(ana, "y");
    const r = await syncSession(ana.sidecar, ana.actor);
    assert.ok("error" in r && /online-only/.test(r.error));
    assert.equal(staged(ana.sidecar).length, 1, "a transaction's acts wait for a sync that succeeds");
  } finally { s.dispose(); }
});

test(`more than ${PUSHES_PER_MINUTE} pushes in a minute warns, and never throttles`, async () => {
  const s = await scenario(["ana@x.com"]);
  try {
    const ana = who(s, "ana@x.com");
    for (let i = 0; i < PUSHES_PER_MINUTE; i++) assert.ok(!("error" in await claim(ana, `c${i}`)));
    begin(ana.sidecar);
    await claim(ana, "one-more");
    const r = await syncSession(ana.sidecar, ana.actor);
    assert.ok(!("error" in r) && r.pushed, "the push still happens");
    assert.match((r as { warning?: string }).warning ?? "", /GitHub recommends at most 6/);
  } finally { s.dispose(); }
});

// --- 2.4: transactions ------------------------------------------------------------------

test("a transaction is all or nothing, returns every conflict, and pushes the rest once the refused op is dropped", async () => {
  const s = await scenario(["ana@x.com", "ben@x.com"]);
  try {
    const ana = who(s, "ana@x.com"), ben = who(s, "ben@x.com");
    begin(ana.sidecar);
    await claim(ana, "a"); await claim(ana, "b"); await claim(ana, "c");
    await claim(ben, "b");
    const refused = await syncSession(ana.sidecar, ana.actor);
    assert.ok("error" in refused);
    assert.deepEqual(refused.conflicts!.map((c) => c.why), ["b is already claimed"]);
    assert.deepEqual((await readScope(ben.sidecar, CLAIMS)).map((e) => e.subject), ["b"], "nothing of ana's was pushed");
    assert.equal(staged(ana.sidecar).length, 3, "the transaction stays staged");
    const b = staged(ana.sidecar).find((o) => o.event.subject === "b")!;
    assert.ok(dropOp(ana.sidecar, b.event.id).ok);
    const ok = await syncSession(ana.sidecar, ana.actor);
    assert.ok(!("error" in ok), JSON.stringify(ok));
    await settle(s);
    assert.deepEqual((await readScope(ben.sidecar, CLAIMS)).map((e) => `${e.actor.principal}:${e.subject}`),
      ["ben@x.com:b", "ana@x.com:a", "ana@x.com:c"]);
  } finally { s.dispose(); }
});

test("a session reads its own staged acts, and a sync pushes only the caller's", async () => {
  const s = await scenario(["ana@x.com"]);
  try {
    const ana = who(s, "ana@x.com");
    await withSession("web:" + "a".repeat(16), "web", async () => {
      begin(ana.sidecar);
      await claim(ana, "tab-a");
      assert.deepEqual((await readScope(ana.sidecar, CLAIMS)).map((e) => e.subject), ["tab-a"], "the tab sees its own act");
    });
    await withSession("web:" + "b".repeat(16), "web", async () => {
      assert.deepEqual((await readScope(ana.sidecar, CLAIMS)).map((e) => e.subject), [], "another tab does not");
      begin(ana.sidecar);
      await claim(ana, "tab-b");
      const r = await syncSession(ana.sidecar, ana.actor);
      assert.ok(!("error" in r), JSON.stringify(r));
    });
    assert.deepEqual((await readScope(ana.sidecar, CLAIMS)).map((e) => e.subject), ["tab-b"], "tab b's sync pushed only tab b's");
    await withSession("web:" + "a".repeat(16), "web", async () => {
      assert.equal(staged(ana.sidecar).length, 1, "tab a's is still waiting for tab a");
      discardTx(ana.sidecar);
      assert.equal(staged(ana.sidecar).length, 0);
    });
  } finally { s.dispose(); }
});

// --- 2.5: sessions that are gone --------------------------------------------------------

const DEAD = "cli:999999:dead";

test("a gone session's transaction is attempted: it lands, or becomes a local conflict — never lost", async () => {
  const s = await scenario(["ana@x.com", "ben@x.com"]);
  try {
    const ana = who(s, "ana@x.com"), ben = who(s, "ben@x.com");
    await withSession(DEAD, "cli", async () => { begin(ana.sidecar); await claim(ana, "fine"); });
    await withSession("cli:999998:dead", "cli", async () => { begin(ana.sidecar); await claim(ana, "taken"); });
    await claim(ben, "taken");
    const out = await attemptGone(ana.sidecar);
    assert.deepEqual(out.map((o) => o.outcome).sort(), ["conflict", "landed"]);
    await settle(s);
    assert.deepEqual((await readScope(ben.sidecar, CLAIMS)).map((e) => e.subject), ["taken", "fine"]);
    const shown = localConflicts(ana.sidecar);
    assert.deepEqual(shown.map((o) => [o.event.subject, o.why]), [["taken", "taken is already claimed"]], "shown on the next open");
    assert.ok(dropOp(ana.sidecar, shown[0]!.event.id).ok, "and dismissable");
    assert.deepEqual(localConflicts(ana.sidecar), []);
  } finally { s.dispose(); }
});

test("a crash between the push and its bookkeeping: the next attempt finds the op on the remote and pushes nothing twice", async () => {
  const s = await scenario(["ana@x.com"]);
  try {
    const ana = who(s, "ana@x.com");
    await withSession(DEAD, "cli", async () => { begin(ana.sidecar); await claim(ana, "once"); });
    const id = queue.pending(ana.sidecar, DEAD)[0]!.event.id;
    assert.ok(!("error" in await withSession(DEAD, "cli", () => syncSession(ana.sidecar, ana.actor))));
    // The process died after the push and before `markLanded`: put the row back as it would be.
    queue.closeQueues();
    const db = new DatabaseSync(join(ana.sidecar, ".git", "codemap-queue.db"));
    db.prepare("UPDATE queue SET state = 'inflight' WHERE event_id = ?").run(id);
    db.close();
    const out = await attemptGone(ana.sidecar);
    assert.deepEqual(out.map((o) => o.outcome), ["landed"]);
    const onRemote = git(s.origin, "show", `main:${CLAIMS}/${LINEAR_SHARD}`).stdout;
    assert.equal(onRemote.split("\n").filter((l) => l.includes(id)).length, 1, "exactly one copy on the remote");
  } finally { s.dispose(); }
});

test("a sync refuses rather than destroy a clone's own unsynced or hand-edited events", async () => {
  const s = await scenario(["ana@x.com", "ben@x.com"]);
  try {
    const ana = who(s, "ana@x.com"), ben = who(s, "ben@x.com");
    await claim(ana, "x");
    await claim(ben, "y");
    // An event an older build appended and never synced.
    const file = join(ana.sidecar, CLAIMS, LINEAR_SHARD);
    const [line] = readFileSync(file, "utf8").trim().split("\n");
    appendFileSync(file, JSON.stringify({ ...JSON.parse(line!), id: "0000000000-orphan" }) + "\n");
    const r = await sync(ana.sidecar, ana.actor);
    assert.ok("error" in r && /not staged through a sync|differ from the remote/.test(r.error), JSON.stringify(r));
    assert.ok(readFileSync(file, "utf8").includes("0000000000-orphan"), "and it is still there");
    // A hand edit that removes a line: refused, never reset away.
    writeFileSync(file, "");
    const r2 = await sync(ana.sidecar, ana.actor);
    assert.ok("error" in r2 && /edited by hand/.test(r2.error), JSON.stringify(r2));
  } finally { s.dispose(); }
});

test("a staged act whose identical twin landed first replays as a no-op: one event, reported", async () => {
  const s = await scenario(["ana@x.com"]);
  try {
    const ana = who(s, "ana@x.com");
    const staged1 = await withSession("mcp:a", "mcp", async () => {
      begin(ana.sidecar);
      return emitEvent(ana.sidecar, "tst/u/dup", ana.actor, "noted", "n1", { x: 1 });
    });
    // The same person's same act lands first, from another session.
    await withSession("mcp:b", "mcp", () => emitEvent(ana.sidecar, "tst/u/dup", ana.actor, "noted", "n1", { x: 1 }));
    const r = await withSession("mcp:a", "mcp", () => syncSession(ana.sidecar, ana.actor)) as { noop?: string[]; error?: string };
    assert.equal(r.error, undefined, String(r.error));
    assert.deepEqual(r.noop, [staged1.id]);
    assert.equal((await readScope(ana.sidecar, "tst/u/dup")).length, 1, "one event on the log");
  } finally { s.dispose(); }
});

test("C9: a locked clone's sweep of a gone session pushes nothing; the writes stay for the repair", async () => {
  const s = await scenario(["ana@x.com"]);
  try {
    const ana = who(s, "ana@x.com");
    await withSession(DEAD, "cli", async () => { begin(ana.sidecar); await claim(ana, "while-locked"); });
    const { recordLockout } = await import("./lockout.js");
    recordLockout(ana.sidecar, { id: "e_bad", kind: "decision.answered", why: "the fold refuses it", scope: "decisions/u", shard: "decisions/u/events.ndjson", line: 1 });
    const before = git(s.origin, "rev-parse", "main").stdout.trim();
    const out = await attemptGone(ana.sidecar);
    assert.equal(git(s.origin, "rev-parse", "main").stdout.trim(), before, `nothing reached the remote: ${JSON.stringify(out)} ${git(s.origin, "log", "--stat", "-1", "main").stdout}`);
    assert.equal(queue.pending(ana.sidecar, DEAD).length + localConflicts(ana.sidecar).length, 1, "the write is kept");
  } finally { s.dispose(); }
});

test("C7: an inline act whose push the remote refused is NOT written, and no later sync lands it", async () => {
  const s = await scenario(["ana@x.com"]);
  const hook = join(s.origin, "hooks", "pre-receive");
  try {
    const ana = who(s, "ana@x.com");
    await emitEvent(ana.sidecar, "tst/seed", ana.actor, "noted", "seed");
    writeFileSync(hook, "#!/bin/sh\necho no >&2\nexit 1\n"); chmodSync(hook, 0o755);
    const r = await emitEventChecked(ana.sidecar, "tst/c7", ana.actor, async () => ({ kind: "noted", subject: "n1" }));
    assert.ok("error" in r && /NOT written/.test(r.error), JSON.stringify(r));
    rmSync(hook);
    begin(ana.sidecar);
    assert.ok(!("error" in await syncSession(ana.sidecar, ana.actor)));
    assert.equal(git(s.origin, "show", "main:tst/c7/events.ndjson").status, 128, "it never reached the remote");
  } finally { rmSync(hook, { force: true }); s.dispose(); }
});

test("C7: a failed push with the remote unreachable leaves the ops unknown, and dropping them says they may have landed", async () => {
  const s = await scenario(["ana@x.com"]);
  const hook = join(s.origin, "hooks", "pre-receive");
  try {
    const ana = who(s, "ana@x.com");
    begin(ana.sidecar);
    const op = await emitEvent(ana.sidecar, "tst/c7u", ana.actor, "noted", "n1");
    // The push fails, and so does the fetch that would settle it: the hook breaks this clone's URL.
    writeFileSync(hook, `#!/bin/sh\nunset GIT_DIR GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES\n`
      + `git -C ${JSON.stringify(ana.sidecar)} remote set-url origin /nonexistent/remote\nexit 1\n`);
    chmodSync(hook, 0o755);
    const r = await syncSession(ana.sidecar, ana.actor) as { error?: string; unknown?: string[] };
    assert.match(r.error ?? "", /may already have landed/, JSON.stringify(r));
    assert.deepEqual(r.unknown, [op.id]);
    git(ana.sidecar, "remote", "set-url", "origin", s.origin);
    assert.deepEqual(staged(ana.sidecar).map((o) => o.state), ["unknown"], "shown, not lost");
    const d = discardTx(ana.sidecar);
    assert.deepEqual(d.mayHaveLanded, [op.id], "never a bare ok");
  } finally { rmSync(hook, { force: true }); s.dispose(); }
});

test("C8a: a push that exited 0 while another process held the tracking ref's lock is settled, not reported unsent", async () => {
  const s = await scenario(["ana@x.com"]);
  const hook = join(s.all[0]!.sidecar, ".git", "hooks", "pre-push");
  const lock = join(s.all[0]!.sidecar, ".git", "refs", "remotes", "origin", "main.lock");
  // The other process lets go a moment later, as a concurrent fetch does.
  const release = setInterval(() => { try { if (Date.now() - statSync(lock).mtimeMs > 120) rmSync(lock); } catch { /* not held */ } }, 40);
  try {
    const ana = who(s, "ana@x.com");
    writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(lock)}\nexit 0\n`); chmodSync(hook, 0o755);
    const r = await emitEventChecked(ana.sidecar, "tst/c8a", ana.actor, async () => ({ kind: "noted", subject: "n1" }));
    assert.ok(!("error" in r), `it reached the remote, and the caller is told so: ${JSON.stringify(r)}`);
    assert.equal(git(s.origin, "show", "main:tst/c8a/events.ndjson").status, 0);
  } finally { clearInterval(release); rmSync(hook, { force: true }); rmSync(lock, { force: true }); s.dispose(); }
});

test("C8b: a shard an ignore rule would leave out is still committed and pushed", async () => {
  const s = await scenario(["ana@x.com"]);
  try {
    const ana = who(s, "ana@x.com");
    appendFileSync(join(ana.sidecar, ".git", "info", "exclude"), "*.ndjson\n");
    const r = await emitEventChecked(ana.sidecar, "tst/c8b", ana.actor, async () => ({ kind: "noted", subject: "n1" }));
    assert.ok(!("error" in r), JSON.stringify(r));
    assert.equal(git(s.origin, "show", "main:tst/c8b/events.ndjson").status, 0, "the event is on the remote");
  } finally { s.dispose(); }
});

test("C10: a gone session's refused write is the only conflict; the next session adopts the rest and lands it once it resolves", async () => {
  const s = await scenario(["ana@x.com", "ben@x.com"]);
  try {
    const ana = who(s, "ana@x.com"), ben = who(s, "ben@x.com");
    await withSession(DEAD, "cli", async () => { begin(ana.sidecar); await claim(ana, "x"); await claim(ana, "y"); });
    await claim(ben, "x");
    assert.deepEqual((await attemptGone(ana.sidecar)).map((o) => o.outcome), ["conflict"]);
    assert.deepEqual(localConflicts(ana.sidecar, { session: "cli:1:next", kind: "cli" }).map((o) => [o.event.subject, o.why]),
      [["x", "x is already claimed"]], "only the refused one");
    // The next session here has adopted the closed one's queue: it must resolve before it pushes.
    const next = { session: "cli:1:next", kind: "cli" as const };
    const blocked = await withSession(next.session, next.kind, () => syncSession(ana.sidecar, ana.actor, next)) as { error?: string };
    assert.match(blocked.error ?? "", /wait for you here/);
    assert.ok(dropOp(ana.sidecar, localConflicts(ana.sidecar, next)[0]!.event.id, next).ok);
    const r = await withSession(next.session, next.kind, () => syncSession(ana.sidecar, ana.actor, next));
    assert.ok(!("error" in r), JSON.stringify(r));
    await settle(s);
    assert.deepEqual((await readScope(ben.sidecar, CLAIMS)).map((e) => `${e.subject} ${e.actor.principal}`), ["x ben@x.com", "y ana@x.com"],
      "the valid write landed; the refused one did not");
  } finally { s.dispose(); }
});

test("C19: dropping a staged write leaves the next one the tip it read", async () => {
  const s = await scenario(["ana@x.com"]);
  try {
    const ana = who(s, "ana@x.com");
    const t = await claim(ana, "seen") as LogEvent;
    begin(ana.sidecar);
    const a = await claim(ana, "a") as LogEvent;
    const b = await claim(ana, "b") as LogEvent;
    assert.ok(dropOp(ana.sidecar, a.id).ok);
    assert.ok(!("error" in await syncSession(ana.sidecar, ana.actor)));
    const all = await readScope(ana.sidecar, CLAIMS);
    assert.ok(readSets(all).saw(b.id, t.id), "B still read what was on the tip when it was written");
    assert.ok(!all.find((e) => e.id === b.id)!.after.includes(a.id), "and names nothing that is not in the log");
  } finally { s.dispose(); }
});

test("O10: the refused writes read back with why and what they said, so they can be redone", async () => {
  const s = await scenario(["ana@x.com", "ben@x.com"]);
  try {
    const ana = who(s, "ana@x.com"), ben = who(s, "ben@x.com");
    begin(ana.sidecar);
    await emitEventChecked(ana.sidecar, CLAIMS, ana.actor, async () => ({ kind: "claim", subject: "x", data: { note: "mine" } }));
    await claim(ben, "x");
    assert.ok("error" in await syncSession(ana.sidecar, ana.actor));
    const [op] = staged(ana.sidecar);
    assert.equal(op!.why, "x is already claimed");
    assert.deepEqual(op!.event.data, { note: "mine" });
  } finally { s.dispose(); }
});

test("C11: an act that waited on the lock while a sync closed its transaction writes inline, not into a closed one", async () => {
  const s = await scenario(["ana@x.com"]);
  try {
    const ana = who(s, "ana@x.com");
    const { withSidecarLock } = await import("./lock.js");
    const { currentSession } = await import("./sync-session.js");
    const me = currentSession();
    begin(ana.sidecar);
    let first: Promise<LogEvent | { error: string }> | undefined;
    await withSidecarLock(ana.sidecar, async () => {
      // The act passes the transaction check, then waits for the lock a sync holds…
      first = emitEventChecked(ana.sidecar, "tst/c11", ana.actor, async () => ({ kind: "noted", subject: "i1" }));
      // …and the sync closes the transaction while it still holds it.
      queue.setTx(ana.sidecar, me.session, me.kind, false);
    });
    const r1 = await first!;
    assert.ok(!("error" in r1), JSON.stringify(r1));
    assert.equal(queue.pending(ana.sidecar, me.session).length, 0, "nothing staged under a closed transaction");
    assert.equal(git(s.origin, "show", "main:tst/c11/events.ndjson").status, 0, "it landed inline");
  } finally { s.dispose(); }
});

test("C15: a sync prunes landed rows past their retention", async () => {
  const s = await scenario(["ana@x.com"]);
  try {
    const ana = who(s, "ana@x.com");
    const landed = await emitEvent(ana.sidecar, "tst/c15", ana.actor, "noted", "n1");
    queue.closeQueues();
    const db = new DatabaseSync(join(ana.sidecar, ".git", "codemap-queue.db"));
    db.prepare("UPDATE queue SET landed_at = '2000-01-01T00:00:00.000Z' WHERE event_id = ?").run(landed.id);
    const before = (db.prepare("SELECT COUNT(*) n FROM queue WHERE event_id = ?").get(landed.id) as { n: number }).n;
    db.close();
    assert.equal(before, 1, "the fixture must hold the landed row, or this proves nothing");
    await sync(ana.sidecar, ana.actor);
    assert.ok(!queue.allQueuedIds(ana.sidecar).includes(landed.id));
  } finally { s.dispose(); }
});
