/**
 * The decisions fold HALTS on a damaged entry and names it (owner, node 18: "Halt on any bad
 * entry"; plan 1.2). It used to leave the entry out and carry on, which could drop a good
 * answer and blame it; the log is immutable, so the entry waits for a person's repair.
 *
 * The fixture is three scopes the oracle wrote (comparison, questionnaire + relayed revision,
 * confirm); each case damages one field of one event the way the structural fuzzer found it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decisionsDoor, foldDecisions } from "./shared-decisions.js";
import { decisionEventShape } from "./log-shape.js";
import { sortEvents, type LogEvent } from "./eventlog.js";
import { foldHaltingOnDamage, isLogDamage, LogDamage } from "./log-damage.js";

const fixture = JSON.parse(readFileSync("src/testdata/decisions-shapes.json", "utf8")) as Record<string, LogEvent[]>;

const setAt = (o: any, path: (string | number)[], v: unknown): any => {
  if (!path.length) return v;
  const c = Array.isArray(o) ? [...o] : { ...o };
  c[path[0]!] = setAt(o?.[path[0]!], path.slice(1), v);
  return c;
};

/** `scope`'s events with `kind`'s first event damaged at `path`, and that event's id. */
const damaged = (scope: string, kind: string, path: (string | number)[], v: unknown) => {
  const events = fixture[scope]!.map((e) => ({ ...e }));
  const i = events.findIndex((e) => e.kind === kind);
  assert.ok(i >= 0, `${scope} has a ${kind}`);
  events[i] = { ...events[i]!, data: setAt(events[i]!.data, path, v) };
  return { events: sortEvents(events), id: events[i]!.id };
};

const halts = (events: LogEvent[]): LogDamage => {
  try { foldDecisions(events); } catch (e) { if (isLogDamage(e)) return e; throw e; }
  assert.fail("the fold carried on past a damaged entry");
};

test("the undamaged fixture folds", () => {
  for (const [scope, events] of Object.entries(fixture)) assert.ok(foldDecisions(sortEvents(events)).decisions.length, scope);
});

const cases: [string, string, string, (string | number)[], unknown][] = [
  ["a null decision in a questionnaire round", "questionnaire", "decision.round.posted", ["decisions"], [null]],
  ["a null payload", "questionnaire", "decision.round.posted", ["decisions", 0, "payload"], null],
  ["payload options that are not a list", "questionnaire", "decision.round.posted", ["decisions", 0, "payload", "options"], "x"],
  ["a null payload option", "questionnaire", "decision.round.posted", ["decisions", 0, "payload", "options"], [null]],
  ["options that are not a list", "questionnaire", "decision.round.posted", ["decisions", 0, "options"], "x"],
  ["an effect with no findings", "questionnaire", "decision.round.posted", ["decisions", 0, "options", 0, "effects"], [{}]],
  ["a round with no publication (a dev-era shape)", "questionnaire", "decision.round.posted", ["publication"], undefined],
  ["a relayed revision with no proof", "questionnaire", "decision.answer.revised", ["via", "proof"], null],
  ["a relayed revision whose answer is not text", "questionnaire", "decision.answer.revised", ["via", "proof", "answer"], 7],
  ["a relayed revision whose question is null", "questionnaire", "decision.answer.revised", ["via", "proof", "question"], null],
  ["a revision without its revision", "questionnaire", "decision.answer.revised", ["revision"], undefined],
  ["a comparison request missing a side", "comparison", "decision.comparison.requested", ["request", "left"], null],
  ["a comparison judgment with no reader", "comparison", "decision.comparison.judged", ["judgment", "reader"], null],
  ["a comparison resolution with no person", "comparison", "decision.comparison.resolved", ["resolution", "human"], null],
  ["a confirm whose reading names an option that does not exist", "confirm", "decision.confirm.posted", ["decision", "confirms", "readings", 0, 0, "option"], "x"],
];
// A shape this build does not write is NEWER (owner, batch 1): skipped on read, refused at the
// door, never halted on. Anything the fold itself refuses still halts, naming the entry.
for (const [name, scope, kind, path, v] of cases) {
  test(`a wrong entry is newer or halts, never a TypeError: ${name}`, async () => {
    const { events, id } = damaged(scope, kind, path, v);
    const bad = events.find((e) => e.id === id)!;
    if (decisionEventShape(bad)) {
      assert.doesNotThrow(() => foldDecisions(events), "a shape is newer: the read carries on");
      const door = await decisionsDoor(events.filter((e) => e.id !== id), bad);
      assert.ok(door.refused.some((r) => r.id === id), "and the door refuses it at replay");
    } else {
      assert.equal(halts(events).entry.id, id);
    }
  });
}

test("an agent's questionnaire submission halts: no conforming build writes it", () => {
  const events = fixture.questionnaire!.filter((e) => e.kind === "decision.round.posted" || e.kind === "decision.questionnaire.submitted");
  const agent = events.map((e) => e.kind === "decision.questionnaire.submitted"
    ? { ...e, actor: { principal: e.actor.principal, via: { kind: "agent", model: "m" } } } as LogEvent : e);
  const d = halts(sortEvents(agent));
  assert.equal(d.entry.kind, "decision.questionnaire.submitted");
  assert.match(d.entry.why, /the person's own act/);
});

test("an unknown kind is skipped, not damage: a teammate one version ahead still reads", () => {
  const events = [...fixture.confirm!, { ...fixture.confirm![0]!, id: "zz-future", kind: "decision.something-new", data: { anything: 1 } } as LogEvent];
  assert.ok(foldDecisions(sortEvents(events)).decisions.length);
});

test("a throw no shape anticipated names the latest entry whose absence lets the fold complete", () => {
  const ev = (id: string, data: any): LogEvent => ({ id, kind: "k", subject: id, actor: { principal: "p" }, at: "t", after: [], data } as any);
  const events = [ev("a", {}), ev("dep", { dep: true }), ev("bad", { boom: true }), ev("c", {})];
  // `bad` throws only when `dep` is present: leaving out either completes, and the later is named.
  const report = (es: LogEvent[]) => {
    if (es.some((e) => e.data?.boom) && es.some((e) => e.data?.dep)) throw new Error("boom");
    return { value: es.length, refused: [] };
  };
  assert.throws(() => foldHaltingOnDamage(events, report, () => null),
    (e: unknown) => isLogDamage(e) && e.entry.id === "bad" && /cannot read it: boom/.test(e.entry.why));
});
