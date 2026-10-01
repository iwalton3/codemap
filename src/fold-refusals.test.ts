/**
 * Every way the decisions and standard folds refuse an event is one output (plan 1.1), and a
 * read judges it as every family's is (`validation.ts judge`): a linear event refused is
 * damage, and halts naming the entry (1.2).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { foldDecisions, foldDecisionsReport } from "./shared-decisions.js";
import { foldStandard } from "./shared-standard.js";
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
  const d = damageOf(() => foldDecisions(sortEvents(events)));
  assert.deepEqual([d?.id, d?.why], [id, "a questionnaire submission is the person's own act"]);
});

test("two identical withdrawals: the second is a no-op, not a refusal (owner, Q5)", () => {
  const events = fixture.confirm!;
  const first = events.find((e) => e.kind === "decision.withdrawn")!;
  const second = { ...first, id: first.id.replace(/.$/, (c) => (c === "0" ? "1" : "0")), writer: "w_other", writerPrev: "GENESIS",
    seq: Math.max(...events.map((e) => e.seq!)) + 1 } as LogEvent;
  const { refused, value } = foldDecisionsReport(sortEvents([...events, second]));
  assert.deepEqual(refused, []);
  const records = value.decisions.flatMap((d) => d.withdrawals ?? []);
  assert.equal(records.find((w) => w.id === second.id)?.state, "settled");
});

test("a standard event its own writer's door would have refused halts, named with its reason", () => {
  const spec = { id: "SPEC-1", title: "t", createdAt: "2026-09-28T00:00:00Z", status: "draft" };
  const events = [
    ev("e1", "spec.drafted", "SPEC-1", { spec }),
    ev("e2", "spec.reviewed", "SPEC-1", { witness: { id: "w1", specId: "SPEC-1", content: { title: "t" } } },
      { principal: "alice", via: { kind: "agent", model: "m" } } as LogEvent["actor"], ["e1"]),
  ].map((e, i) => ({ ...e, seq: i + 1 }));
  const d = damageOf(() => foldStandard(events));
  assert.deepEqual([d?.id, d?.why], ["e2", "a sign-off is a person's act"]);
});

