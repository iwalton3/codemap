/**
 * Every way the decisions and standard folds refuse an event is one output (plan 1.1), and a
 * refusal is DAMAGE or a RACE by one test: is the event refused over what its own writer saw?
 * Damage halts, naming the entry (1.2); a race is reported for conflict handling (1.3).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { foldDecisionsReport } from "./shared-decisions.js";
import { foldStandardReport } from "./shared-standard.js";
import { sortEvents, type LogEvent } from "./eventlog.js";
import { isLogDamage } from "./log-damage.js";

const fixture = JSON.parse(readFileSync("src/testdata/decisions-shapes.json", "utf8")) as Record<string, LogEvent[]>;
const agent = (e: LogEvent): LogEvent => ({ ...e, actor: { principal: e.actor.principal, via: { kind: "agent", model: "m" } } } as LogEvent);
const person = { principal: "alice" };
const ev = (id: string, kind: string, subject: string, data: Record<string, unknown>, actor: LogEvent["actor"] = person, after: string[] = [], writer = "w"): LogEvent =>
  ({ id, kind, subject, actor, at: "2026-09-28T00:00:00Z", after, writer, data } as LogEvent);
const damageOf = (fold: () => unknown) => {
  try { fold(); } catch (e) { if (isLogDamage(e)) return e.entry; throw e; }
  return undefined;
};

test("the oracle's scopes fold with nothing refused", () => {
  for (const [scope, events] of Object.entries(fixture)) {
    assert.deepEqual(foldDecisionsReport(sortEvents(events)).refused, [], scope);
  }
});

test("a decisions event its own writer's door would have refused halts, named with its reason", () => {
  const events = fixture.questionnaire!.map((e) => e.kind === "decision.questionnaire.submitted" ? agent(e) : e);
  const id = events.find((e) => e.kind === "decision.questionnaire.submitted")!.id;
  const d = damageOf(() => foldDecisionsReport(sortEvents(events)));
  assert.deepEqual([d?.id, d?.why], [id, "a questionnaire submission is the person's own act"]);
});

test("two withdrawals of one question written without seeing each other: the second is a race, reported", () => {
  const events = fixture.confirm!;
  const first = events.find((e) => e.kind === "decision.withdrawn")!;
  const second = { ...first, id: first.id.replace(/.$/, (c) => (c === "0" ? "1" : "0")), writer: "w_other", writerPrev: "GENESIS" } as LogEvent;
  const { refused } = foldDecisionsReport(sortEvents([...events, second]));
  const later = [first.id, second.id].sort()[1]!;
  assert.deepEqual(refused.map((r) => r.id), [later]);
});

test("a standard event its own writer's door would have refused halts, named with its reason", () => {
  const spec = { id: "SPEC-1", title: "t", createdAt: "2026-09-28T00:00:00Z", status: "draft" };
  const events = [
    ev("e1", "spec.drafted", "SPEC-1", { spec }),
    ev("e2", "spec.reviewed", "SPEC-1", { witness: { id: "w1", specId: "SPEC-1", content: { title: "t" } } },
      { principal: "alice", via: { kind: "agent", model: "m" } } as LogEvent["actor"], ["e1"]),
  ];
  const d = damageOf(() => foldStandardReport(events));
  assert.deepEqual([d?.id, d?.why], ["e2", "a sign-off is a person's act"]);
});

test("a standard event refused only because of what its writer could not see is a race, reported", () => {
  const spec = { id: "SPEC-1", title: "t", createdAt: "2026-09-28T00:00:00Z", status: "draft" };
  const events = sortEvents([
    ev("e1", "spec.drafted", "SPEC-1", { spec }),
    ev("e2", "spec.withdrawn", "SPEC-1", { reason: "not needed" }, person, ["e1"]),
    // Bob had not pulled the withdrawal.
    ev("e3", "spec.revised", "SPEC-1", { spec: { ...spec, title: "t2", revisions: [{ at: "t", by: { principal: "bob" }, was: { title: "t" } }] } },
      { principal: "bob" }, ["e1"], "w_bob"),
  ]);
  const { refused, value } = foldStandardReport(events);
  assert.deepEqual(refused.map((r) => [r.id, r.why]), [["e3", "only a draft spec is revised"]]);
  assert.equal(value.specs[0]!.status, "withdrawn");
});
