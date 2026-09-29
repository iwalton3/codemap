/**
 * Every way the decisions and standard folds refuse an event is one output, `refused`, naming
 * the event (plan 1.1). The write door asks it whether a new event would be applied.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { foldDecisionsReport } from "./shared-decisions.js";
import { foldStandardReport } from "./shared-standard.js";
import { sortEvents, type LogEvent } from "./eventlog.js";

const fixture = JSON.parse(readFileSync("src/testdata/decisions-shapes.json", "utf8")) as Record<string, LogEvent[]>;
const agent = (e: LogEvent): LogEvent => ({ ...e, actor: { principal: e.actor.principal, via: { kind: "agent", model: "m" } } } as LogEvent);

test("the oracle's scopes fold with nothing refused", () => {
  for (const [scope, events] of Object.entries(fixture)) {
    assert.deepEqual(foldDecisionsReport(sortEvents(events)).refused, [], scope);
  }
});

test("a refused decisions event is named with its reason", () => {
  const events = fixture.questionnaire!.map((e) => e.kind === "decision.questionnaire.submitted" ? agent(e) : e);
  const id = events.find((e) => e.kind === "decision.questionnaire.submitted")!.id;
  const { refused } = foldDecisionsReport(sortEvents(events));
  assert.deepEqual(refused.filter((r) => r.id === id).map((r) => r.why), ["a questionnaire submission is the person's own act"]);
});

test("a refused standard event is named with its reason", () => {
  const person = { principal: "alice" };
  const ev = (id: string, kind: string, subject: string, data: Record<string, unknown>, actor: LogEvent["actor"] = person, after: string[] = []): LogEvent =>
    ({ id, kind, subject, actor, at: "2026-09-28T00:00:00Z", after, writer: "w", data } as LogEvent);
  const spec = { id: "SPEC-1", title: "t", createdAt: "2026-09-28T00:00:00Z", status: "draft" };
  const events = [
    ev("e1", "spec.drafted", "SPEC-1", { spec }),
    ev("e2", "spec.reviewed", "SPEC-1", { witness: { id: "w1", specId: "SPEC-1", content: { title: "t" } } },
      { principal: "alice", via: { kind: "agent", model: "m" } } as LogEvent["actor"], ["e1"]),
  ];
  const { refused } = foldStandardReport(events);
  assert.deepEqual(refused.map((r) => r.id), ["e2"]);
  assert.match(refused[0]!.why, /e\.actor\.via/);
});
