/**
 * Validation for the bugs scope (plan 3.1, 3.2), the findings pattern in `validation.test.ts`: a
 * staged bug act replays against the tip and is refused when the tip has moved; a refused bug
 * event on the log is damage when linear and skipped when merge-era or dev-era; and the door
 * checks what a bug event names in another scope (docs/sidecar-references.md, rows 70-71, 78-80).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scenario, who, settle } from "./scenario.js";
import { doorFor, readScope } from "./eventlog.js";
import { begin, syncSession, staged } from "./sync-engine.js";
import { bugScope, fileBug, findingScopeOfBugKey, foldBugs, readBugsShared, setBugState } from "./shared-bugs.js";
import { createFinding } from "./shared-findings.js";
import { findingKeyScope } from "./review-target.js";
import type { SidecarConfig } from "./sidecar-config.js";
import { isLogDamage } from "./log-damage.js";
import { testEvent } from "./test-events.js";
import { lockoutOf } from "./lockout.js";
import { discard } from "./test-tmp.js";

const U = "acme/api";
const NEW = { title: "negatives are not rejected", text: "transfer() takes a negative amount", anchors: [{ anchorId: "a_1", bodyHash: "sha256:one" }] };

test("closing a bug a teammate closed first is refused at replay, and its author is told", async () => {
  const s = await scenario(["ana@x.com", "ben@x.com"]);
  try {
    const ana = who(s, "ana@x.com"), ben = who(s, "ben@x.com");
    const id = await fileBug(ana.sidecar, U, ana.actor, NEW);
    await settle(s);
    begin(ana.sidecar);
    assert.ok(!("error" in await setBugState(ana.sidecar, U, ana.actor, id, "resolved", "fixed in abc")));
    assert.ok(!("error" in await setBugState(ben.sidecar, U, ben.actor, id, "invalid", "not a defect")));
    const r = await syncSession(ana.sidecar, ana.actor);
    assert.ok("error" in r, "ana's close replays against ben's");
    assert.deepEqual(r.conflicts?.map((c) => c.kind), ["bug.stateChanged"]);
    assert.match(r.conflicts![0]!.why, /is invalid; it may not become resolved — this was decided when it was created/);
    assert.equal(staged(ana.sidecar).length, 1, "and it stays staged for her");
    await settle(s).catch(() => {});
    for (const p of [ana, ben]) {
      assert.equal((await readBugsShared(p.sidecar, U)).get(id)!.state, "invalid", "one close, ben's");
      assert.equal(lockoutOf(p.sidecar), null);
    }
    const onRemote = await readScope(ben.sidecar, bugScope(U));
    assert.equal(onRemote.filter((e) => e.kind === "bug.stateChanged").length, 1, "the refused close never reached the remote");
  } finally { s.dispose(); }
});

const filed = testEvent({ id: "e1", kind: "bug.filed", subject: "b1", data: NEW, seq: 1 });

test("on read: a refused LINEAR bug event is damage, a merge-era one is skipped", () => {
  const orphan = { kind: "bug.commented", subject: "b_missing", data: { body: "hi" } };
  assert.throws(() => foldBugs([filed, testEvent({ id: "e2", ...orphan, seq: 2 })]),
    (e: unknown) => isLogDamage(e) && e.entry.id === "e2" && /no bug b_missing/.test(e.entry.why));
  assert.equal(foldBugs([filed, testEvent({ id: "e2", ...orphan })]).size, 1, "no seq: dropped, as the merge-era fold did");
});

test("on read: a dev-era ruling capsule is skipped, and a shape this build does not write is newer", () => {
  const v2 = testEvent({ id: "e2", kind: "bug.rulingApplied", subject: "b1", data: { capsule: { version: 2 } }, seq: 2 });
  assert.equal(foldBugs([filed, v2]).get("b1")!.state, "created", "skipped, never locked on (owner, Q7)");
  const odd = testEvent({ id: "e2", kind: "bug.assigned", subject: "b1", data: { kind: "someday" }, seq: 2 });
  assert.equal(foldBugs([filed, odd]).get("b1")!.assignment, undefined, "the read carries on without it");
});

test("the door refuses a bug filed from a finding its scope never created", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-bv-"));
  try {
    await assert.rejects(fileBug(root, U, { principal: "izzie@x.com" }, { ...NEW, from: { pr: 7, finding: "f_nope" } }),
      /no finding f_nope in findings\/acme\/api\/pr-7/);
    await createFinding(root, `${U}/pr-7`, { principal: "izzie@x.com" }, { id: "f_real", targetKind: "anchor", targetId: "a_1", text: "t" });
    await fileBug(root, U, { principal: "izzie@x.com" }, { ...NEW, from: { pr: 7, finding: "f_real" } });
    assert.equal((await readBugsShared(root, U)).size, 1);
  } finally { discard(root); }
});

test("a bug's finding key resolves to the scope the finding lives in, for a number and a branch", () => {
  const cfg = { universe: U } as SidecarConfig;
  for (const key of ["7", "branch:feat/x"]) assert.equal(findingScopeOfBugKey(U, key), `findings/${findingKeyScope(cfg, key)}`);
  assert.equal(findingScopeOfBugKey(U, "https://example/pull/7"), null);
});

test("the door refuses a ruling application naming a round the decisions scope never posted", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-bv-"));
  try {
    const id = await fileBug(root, U, { principal: "izzie@x.com" }, NEW);
    const events = await readScope(root, bugScope(U));
    const minted = testEvent({ id: "e_apply", kind: "bug.rulingApplied", subject: id, seq: 99,
      data: { capsule: { version: 3, ruling: { answerId: "a_x", roundId: "r_x", questionId: "r_x:q1" } } } });
    const verdict = await doorFor(root, bugScope(U))!([...events, minted], minted);
    assert.ok(verdict.refused.some((r) => r.id === "e_apply" && /no round r_x in decisions\/acme\/api/.test(r.why)), JSON.stringify(verdict));
  } finally { discard(root); }
});
