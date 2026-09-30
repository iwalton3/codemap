/**
 * Validation for every kind (plan phase 3): a staged act replays against the tip and is refused
 * when the tip no longer meets its precondition or its references; a refused event found in the
 * log is damage when it is linear, newer when it is a shape this build does not write, and
 * skipped when it predates the linear log.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scenario, who, settle } from "./scenario.js";
import { readScope } from "./eventlog.js";
import { begin, syncSession, staged } from "./sync-engine.js";
import { createFinding, findingScope, foldFindings, readFindings, setState } from "./shared-findings.js";
import { isLogDamage } from "./log-damage.js";
import { judge } from "./validation.js";
import { testEvent } from "./test-events.js";
import { lockoutOf } from "./lockout.js";

const PR = "acme/api/pr-7";
const NEW = { targetKind: "anchor" as const, targetId: "a_1", text: "transfer rounds", comment: "c" };

test("closing a finding a teammate closed first is refused at replay, and its author is told", async () => {
  const s = await scenario(["ana@x.com", "ben@x.com"]);
  try {
    const ana = who(s, "ana@x.com"), ben = who(s, "ben@x.com");
    const id = await createFinding(ana.sidecar, PR, ana.actor, NEW);
    await settle(s);
    begin(ana.sidecar);
    await setState(ana.sidecar, PR, ana.actor, id, "resolved", "fixed in abc");
    await setState(ben.sidecar, PR, ben.actor, id, "invalid", "not a defect");
    const r = await syncSession(ana.sidecar, ana.actor);
    assert.ok("error" in r, "ana's close replays against ben's");
    assert.deepEqual(r.conflicts?.map((c) => c.kind), ["finding.stateChanged"]);
    assert.match(r.conflicts![0]!.why, /is invalid; it may not become resolved — this was decided when it was created/);
    assert.equal(staged(ana.sidecar).length, 1, "and it stays staged for her");
    await settle(s).catch(() => {});
    for (const p of [ana, ben]) {
      assert.equal((await readFindings(p.sidecar, PR)).get(id)!.state, "invalid", "one close, ben's");
      assert.equal(lockoutOf(p.sidecar), null);
    }
    const onRemote = await readScope(ben.sidecar, findingScope(PR));
    assert.equal(onRemote.filter((e) => e.kind === "finding.stateChanged").length, 1, "the refused close never reached the remote");
  } finally { s.dispose(); }
});

const created = testEvent({ id: "e1", kind: "finding.created", subject: "f1", data: NEW, seq: 1 });

test("on read: a refused LINEAR event is damage, a merge-era one is skipped", () => {
  const orphan = { kind: "finding.commented", subject: "f_missing", data: { body: "hi" } };
  assert.throws(() => foldFindings([created, testEvent({ id: "e2", ...orphan, seq: 2 })]),
    (e: unknown) => isLogDamage(e) && e.entry.id === "e2" && /no finding f_missing/.test(e.entry.why));
  assert.equal(foldFindings([created, testEvent({ id: "e2", ...orphan })]).size, 1, "no seq: dropped, as the merge-era fold did");
});

test("on read: a shape this build does not write is newer — reads go on, it is reported", () => {
  const odd = testEvent({ id: "e2", kind: "finding.corroborated", subject: "f1", data: { verdict: "maybe" }, seq: 2 });
  assert.equal(foldFindings([created, odd]).get("f1")!.corroboration.length, 0, "the read carries on without it");
  assert.deepEqual(judge([created, odd], [{ id: "e2", kind: odd.kind, why: "x", cls: "shape" }]).map((r) => r.id), ["e2"]);
});
