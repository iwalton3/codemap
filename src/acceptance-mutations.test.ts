/**
 * The owner's acceptance mutations (plan, "Acceptance"): a corrupted sidecar and a corrupted
 * write are each REJECTED. Every mutation is applied to the fixture — the files on disk or the
 * staged op — never to `dist/`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { scenario, who, settle, type Person } from "./scenario.js";
import { LINEAR_SHARD, SIDECAR_PROTOCOL, EVENT_SCHEMA, mintId } from "./eventlog.js";
import { begin, syncSession } from "./sync-engine.js";
import { stage } from "./sync-queue.js";
import { currentSession } from "./sync-session.js";
import { sync } from "./sidecar.js";
import { createFinding, findingScope, readFindings, setState } from "./shared-findings.js";
import { findDamage, newerIn } from "./damage-scan.js";
import { lockoutOf } from "./lockout.js";

const PR = "acme/api/pr-9";
const NEW = { targetKind: "anchor" as const, targetId: "a_1", text: "t" };
const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
const shard = (p: Person) => join(p.sidecar, findingScope(PR), LINEAR_SHARD);
/** What a build without codemap's gates does: commit whatever is on disk and push it. */
const pushRaw = (p: Person, message: string) => { git(p.sidecar, "add", "-A"); git(p.sidecar, "commit", "-qm", message); git(p.sidecar, "push", "-q", "origin", "HEAD:main"); };

async function team() {
  const s = await scenario(["ana@x.com", "ben@x.com"]);
  const ana = who(s, "ana@x.com"), ben = who(s, "ben@x.com");
  const id = await createFinding(ana.sidecar, PR, ana.actor, NEW);
  await setState(ana.sidecar, PR, ana.actor, id, "refuted", "no");
  await settle(s);
  return { s, ana, ben, id };
}

// --- a corrupted sidecar ------------------------------------------------------------------

test("mutation: bytes that are not JSON — the pull refuses them and the clone locks", async () => {
  const { s, ana, ben } = await team();
  try {
    appendFileSync(shard(ana), "\x00\x01 not json\n");
    pushRaw(ana, "a broken build");
    const r = await sync(ben.sidecar, ben.actor);
    assert.ok("error" in r && /not JSON/.test(r.error), JSON.stringify(r));
    assert.ok(lockoutOf(ben.sidecar));
  } finally { s.dispose(); }
});

test("mutation: a shard truncated mid-line — damage, not a torn tail", async () => {
  const { s, ana, ben } = await team();
  try {
    const lines = readFileSync(shard(ana), "utf8").trim().split("\n");
    // The FIRST line cut short and everything after it kept: only a crash can leave a partial
    // LAST line, so this one is corruption.
    writeFileSync(shard(ana), [lines[0]!.slice(0, 40), ...lines.slice(1)].join("\n") + "\n");
    pushRaw(ana, "a truncated shard");
    const r = await sync(ben.sidecar, ben.actor);
    assert.ok("error" in r && /not JSON/.test(r.error), JSON.stringify(r));
    assert.ok(lockoutOf(ben.sidecar));
  } finally { s.dispose(); }
});

test("mutation: a reference to a shared item that does not exist — damage, and every read refuses", async () => {
  const { s, ana, ben, id } = await team();
  try {
    const [first] = readFileSync(shard(ana), "utf8").trim().split("\n");
    const e = JSON.parse(first!);
    appendFileSync(shard(ana), JSON.stringify({ ...e, id: mintId(), kind: "finding.commented", subject: "f_nobody_filed",
      data: { body: "about nothing" }, seq: 999 }) + "\n");
    pushRaw(ana, "a dangling reference");
    await sync(ben.sidecar, ben.actor);
    const d = await findDamage(ben.sidecar);
    assert.ok(d && /no finding f_nobody_filed/.test(d.why), JSON.stringify(d));
    await assert.rejects(readFindings(ben.sidecar, PR), /no finding f_nobody_filed/);
    void id;
  } finally { s.dispose(); }
});

test("mutation: an event from a newer build — pushes block, reads carry on, nothing locks", async () => {
  const { s, ana, ben, id } = await team();
  try {
    const [first] = readFileSync(shard(ana), "utf8").trim().split("\n");
    const e = JSON.parse(first!);
    appendFileSync(shard(ana), JSON.stringify({ ...e, id: mintId(), kind: "finding.something-new", subject: id,
      sidecarProtocol: SIDECAR_PROTOCOL + 1, eventSchema: EVENT_SCHEMA + 1, seq: 999 }) + "\n");
    pushRaw(ana, "a newer build");
    const pulled = await sync(ben.sidecar, ben.actor);
    assert.ok(!("error" in pulled), "a sync with nothing of its own still pulls");
    assert.match(await newerIn(ben.sidecar) ?? "", /newer than it/);
    assert.equal((await readFindings(ben.sidecar, PR)).get(id)!.state, "refuted", "reads carry on");
    await assert.rejects(setState(ben.sidecar, PR, ben.actor, id, "created", "reopen"), /Pushes are blocked/);
    assert.equal(lockoutOf(ben.sidecar), null, "newer is not damage");
  } finally { s.dispose(); }
});

test("mutation: a reference to an event this build keeps but cannot fold — newer, not damage", async () => {
  const { s, ana, ben, id } = await team();
  try {
    const [first] = readFileSync(shard(ana), "utf8").trim().split("\n");
    const e = JSON.parse(first!);
    // A finding in a shape this build does not write, then a comment on it: the comment's
    // target exists in the log, this build just cannot fold it (owner, batch 2).
    appendFileSync(shard(ana), JSON.stringify({ ...e, id: "0000000001-newshape", kind: "finding.created", subject: "f_newshape",
      data: { targetKind: "symbol-v9", targetId: "x", text: "t" }, seq: 998 }) + "\n");
    appendFileSync(shard(ana), JSON.stringify({ ...e, id: "0000000002-onit", kind: "finding.commented", subject: "f_newshape",
      data: { body: "on the new one" }, seq: 999 }) + "\n");
    pushRaw(ana, "a newer build's finding");
    await sync(ben.sidecar, ben.actor);
    assert.equal(await findDamage(ben.sidecar), null, "not damage");
    assert.match(await newerIn(ben.sidecar) ?? "", /newer than it/, "but newer: pushes block");
    assert.ok((await readFindings(ben.sidecar, PR)).get(id), "and reads carry on");
  } finally { s.dispose(); }
});

// --- a corrupted write --------------------------------------------------------------------

test("mutation: a staged op with a broken reference — refused at replay, never pushed", async () => {
  const { s, ana, ben } = await team();
  try {
    begin(ana.sidecar);
    stage(ana.sidecar, currentSession().session, findingScope(PR), {
      sidecarProtocol: SIDECAR_PROTOCOL, eventSchema: EVENT_SCHEMA, id: mintId(), kind: "finding.commented",
      subject: "f_nobody_filed", actor: ana.actor, at: new Date().toISOString(), after: [], data: { body: "x" },
    });
    const r = await syncSession(ana.sidecar, ana.actor);
    assert.ok("error" in r && r.conflicts?.[0]?.why.includes("no finding f_nobody_filed"), JSON.stringify(r));
    await settle(s).catch(() => {});
    assert.ok(!readFileSync(shard(ben), "utf8").includes("f_nobody_filed"), "the remote never saw it");
  } finally { s.dispose(); }
});

test("mutation: a staged op whose precondition the tip no longer meets — refused at replay, never pushed", async () => {
  const { s, ana, ben, id } = await team();
  try {
    begin(ana.sidecar);
    await setState(ana.sidecar, PR, ana.actor, id, "created", "reopen it");     // staged against `refuted`
    await setState(ben.sidecar, PR, ben.actor, id, "created", "reopened first");
    const r = await syncSession(ana.sidecar, ana.actor);
    assert.ok("error" in r && r.conflicts?.length, JSON.stringify(r));
    await settle(s).catch(() => {});
    assert.equal(readFileSync(shard(ben), "utf8").split("\n").filter((l) => l.includes("reopen it")).length, 0);
  } finally { s.dispose(); }
});
