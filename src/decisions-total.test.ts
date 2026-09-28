/**
 * The decisions fold is TOTAL: an event that parses but has the wrong shape is left out and
 * named, never thrown on (owner, 2026-09-28: "Skip it, and report it"). One such line used to
 * block every read and write of the universe's decisions for everyone who pulled it.
 *
 * The fixture is three scopes the oracle wrote (comparison, questionnaire + relayed revision,
 * confirm); each case damages one field of one event the way the structural fuzzer found it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { decisionScope, foldDecisions, leaveOutUnreadable, type SkippedEvent } from "./shared-decisions.js";
import { sortEvents, type LogEvent } from "./eventlog.js";
import { decisionsView } from "./ops/decision-holds.js";
import { universeKey } from "./sidecar-config.js";
import { discard } from "./test-tmp.js";

const fixture = JSON.parse(readFileSync("src/testdata/decisions-shapes.json", "utf8")) as Record<string, LogEvent[]>;

const setAt = (o: any, path: (string | number)[], v: unknown): any => {
  if (!path.length) return v;
  const c = Array.isArray(o) ? [...o] : { ...o };
  c[path[0]!] = setAt(o?.[path[0]!], path.slice(1), v);
  return c;
};

/** Fold `scope` with `kind`'s first event damaged at `path`; returns the fold and that event's id. */
const damaged = (scope: string, kind: string, path: (string | number)[], v: unknown) => {
  const events = fixture[scope]!.map((e) => ({ ...e }));
  const i = events.findIndex((e) => e.kind === kind);
  assert.ok(i >= 0, `${scope} has a ${kind}`);
  events[i] = { ...events[i]!, data: setAt(events[i]!.data, path, v) };
  return { s: foldDecisions(sortEvents(events)), id: events[i]!.id };
};

test("the undamaged fixture folds with nothing left out", () => {
  for (const [scope, events] of Object.entries(fixture)) {
    const s = foldDecisions(sortEvents(events));
    assert.equal(s.skipped, undefined, scope);
    assert.ok(s.decisions.length, scope);
  }
});

const cases: [string, string, string, (string | number)[], unknown][] = [
  ["a null decision in a questionnaire round", "questionnaire", "decision.round.posted", ["decisions"], [null]],
  ["a null payload", "questionnaire", "decision.round.posted", ["decisions", 0, "payload"], null],
  ["payload options that are not a list", "questionnaire", "decision.round.posted", ["decisions", 0, "payload", "options"], "x"],
  ["a null payload option", "questionnaire", "decision.round.posted", ["decisions", 0, "payload", "options"], [null]],
  ["options that are not a list", "questionnaire", "decision.round.posted", ["decisions", 0, "options"], "x"],
  ["an effect with no findings", "questionnaire", "decision.round.posted", ["decisions", 0, "options", 0, "effects"], [{}]],
  ["a relayed revision with no proof", "questionnaire", "decision.answer.revised", ["via", "proof"], null],
  ["a relayed revision whose answer is not text", "questionnaire", "decision.answer.revised", ["via", "proof", "answer"], 7],
  ["a relayed revision whose question is null", "questionnaire", "decision.answer.revised", ["via", "proof", "question"], null],
  ["a comparison request missing a side", "comparison", "decision.comparison.requested", ["request", "left"], null],
  ["a comparison judgment with no reader", "comparison", "decision.comparison.judged", ["judgment", "reader"], null],
  ["a comparison resolution with no person", "comparison", "decision.comparison.resolved", ["resolution", "human"], null],
];
for (const [name, scope, kind, path, v] of cases) {
  test(`left out and named, not thrown on: ${name}`, () => {
    const { s, id } = damaged(scope, kind, path, v);
    assert.ok(s.skipped?.some((x) => x.id === id), `${id} is named in ${JSON.stringify(s.skipped)}`);
  });
}

test("a confirm whose reading names an option that does not exist is refused, not thrown on", () => {
  const { s, id } = damaged("confirm", "decision.confirm.posted", ["decision", "confirms", "readings", 0, 0, "option"], "x");
  const c = s.decisions.find((d) => d.postingEvent === id);
  assert.match(c?.confirms?.invalid ?? "", /option that is not an exact decision/);
});

test("an unanticipated throw leaves out the event that keeps the most of the fold, and names it", () => {
  // `bad` only throws once `ref` has been read after it; leaving out either completes. Leaving
  // out `bad` keeps more, which is the whole point of not taking the first that works.
  const ev = (id: string, data: any): LogEvent => ({ id, kind: "k", subject: id, actor: { principal: "p" }, at: "t", after: [], data } as any);
  const events = [ev("a", {}), ev("bad", { boom: true }), ev("ref", { needs: "bad" }), ev("c", {})];
  const once = (es: LogEvent[]) => {
    if (es.some((e) => e.data?.boom) && es.some((e) => e.data?.needs)) throw new Error("boom");
    // Leaving `ref` out also drops what depends on it; `bad` has no dependants.
    return { kept: es.length - (es.some((e) => e.id === "ref") ? 0 : 1), skipped: undefined as SkippedEvent[] | undefined };
  };
  const t = leaveOutUnreadable(once, events, (x) => x.kept);
  assert.deepEqual(t.skipped?.map((x) => x.id), ["bad"]);
  assert.match(t.skipped![0]!.why, /could not read it: boom/);
  assert.throws(() => leaveOutUnreadable(() => { throw new Error("always"); }, events, () => 0), /always/,
    "when no single removal helps, the failure stays loud");
});

test("a read of the scope reports what was left out, on the fold and on a cache hit, and does not block", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-total-")), side = mkdtempSync(join(tmpdir(), "codemap-total-side-"));
  try {
    for (const [dir, args] of [[root, ["init", "-q"]], [side, ["init", "-q"]], [side, ["-c", "user.email=a@x", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "root"]]] as const)
      spawnSync("git", [...args], { cwd: dir });
    mkdirSync(join(root, ".codemap"), { recursive: true });
    writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
    const events = fixture.questionnaire!.map((e) => ({ ...e }));
    const i = events.findIndex((e) => e.kind === "decision.answer.revised");
    events[i] = { ...events[i]!, data: setAt(events[i]!.data, ["via", "proof"], null) };
    const dir = join(side, decisionScope(universeKey(root)));
    mkdirSync(dir, { recursive: true });
    for (const w of new Set(events.map((e) => e.writer)))
      writeFileSync(join(dir, `${w}.ndjson`), events.filter((e) => e.writer === w).map((e) => JSON.stringify(e) + "\n").join(""));
    for (const pass of ["fold", "cache hit"]) {
      const v = await decisionsView(root);
      assert.equal(v.status.status, "complete", pass);
      assert.equal(v.status.diagnostic?.reason, "malformed-event", pass);
      assert.deepEqual(v.status.diagnostic?.evidence, [events[i]!.id], pass);
      assert.ok(v.s.rounds.length, `${pass}: everything else was read`);
    }
  } finally { discard(root); discard(side); }
});

test("the fold refuses a questionnaire submission an agent wrote, whatever the op would have done", () => {
  const events = fixture.questionnaire!.filter((e) => e.kind === "decision.round.posted" || e.kind === "decision.questionnaire.submitted");
  const answered = (es: LogEvent[]) => foldDecisions(sortEvents(es)).decisions.flatMap((d) => d.answers).filter((a) => a.via === "questionnaire");
  assert.ok(answered(events).length, "a person's submission is answered");
  const agent = events.map((e) => e.kind === "decision.questionnaire.submitted"
    ? { ...e, actor: { principal: e.actor.principal, via: { kind: "agent", model: "m" } } } as LogEvent : e);
  assert.deepEqual(answered(agent), []);
});
