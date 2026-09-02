/**
 * The bug backlog — a defect that is real, is not being fixed now, and comes back.
 *
 * The same third exit findings got, one record kind over, and it exists for the same
 * measured reason: a bug nobody will reach this quarter has two options today, and both
 * are wrong. Stay in the open queue and dilute it, or close as won't-fix, which asserts a
 * decision nobody made. The first is what happens, and it is how a bug queue stops being
 * read.
 *
 * Every test drives `foldBugs` on hand-built events, because that is the only way this
 * project has ever found a guard-in-one-end defect (CLAUDE.md § the sidecar). The fold is
 * the authority: a write-time check protects the honest writer and nobody else, and a
 * teammate's clone applies the log without ever seeing one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { foldBugs } from "./shared-bugs.js";
import type { LogEvent } from "./eventlog.js";
import type { Actor } from "./schema.js";

const PERSON: Actor = { principal: "izzie@x.com" };
const OTHER: Actor = { principal: "dana@x.com" };
const AGENT: Actor = { principal: "izzie@x.com", via: { kind: "agent", model: "claude-opus-5" } };
const W = { anchorId: "a_1", bodyHash: "h2:aaaa:sha256:bbbb" };
const W2 = { anchorId: "a_2", bodyHash: "h2:aaaa:sha256:cccc" };

let seq = 0;
const ev = (kind: string, actor: Actor, data: Record<string, unknown>): LogEvent =>
  ({ id: `e${++seq}`, kind, subject: "bug_1", actor, at: "2026-09-01T00:00:00Z", data } as unknown as LogEvent);

const filed = (over: Record<string, unknown> = {}) =>
  ev("bug.filed", PERSON, { title: "settlement double posts", text: "repro", anchors: [W], ...over });

const fold = (...events: LogEvent[]) => foldBugs(events).get("bug_1")!;

test("backlogging a bug needs a deadline, and the FOLD is what enforces it", () => {
  const ok = fold(filed(), ev("bug.backlogged", PERSON, {
    until: "2026-11-01", reason: "the settlement rewrite lands next quarter", anchors: [W],
  }));
  assert.equal(ok.backlogged?.until, "2026-11-01");
  assert.equal(ok.backlogged?.reason, "the settlement rewrite lands next quarter");
  assert.deepEqual(ok.backlogged?.witnesses, [W], "the code as it stood when somebody said 'not now'");

  // Each of these would never wake — the `acknowledgements` rule verbatim, because a
  // linked ticket closed as won't-do, moved or deleted leaves the record asleep
  // permanently and silently. Every deferral in the measured finding data was like that.
  assert.equal(fold(filed(), ev("bug.backlogged", PERSON, { reason: "not now", anchors: [W] })).backlogged,
    undefined, "no date at all");
  assert.equal(fold(filed(), ev("bug.backlogged", PERSON, { until: "next quarter", reason: "not now" })).backlogged,
    undefined, "a date that is not a date");
  assert.equal(fold(filed(), ev("bug.backlogged", PERSON, { until: "2026-11-01" })).backlogged,
    undefined, "no reason — it is a record of a decision, not a mute button");
});

test("an agent may not backlog a bug, and may not bring one back either", () => {
  // Both sides of the same queue-clearing move: an agent that could end a deferral could
  // end every one. Principal-granted like `debt`, and the fold drops the event rather
  // than relying on a tool check a teammate's clone never runs.
  assert.equal(fold(filed(), ev("bug.backlogged", AGENT, { until: "2026-11-01", reason: "r", anchors: [W] })).backlogged,
    undefined, "an agent's attempt is dropped by the FOLD, not merely refused by the tool");

  const granted = ev("bug.backlogged", PERSON, { until: "2026-11-01", reason: "r", anchors: [W] });
  // Mutation check: the same event from a person lands, so the assertion above is about
  // the actor and not about a malformed event.
  assert.ok(fold(filed(), granted).backlogged, "the same event from a person is accepted");
  assert.ok(fold(filed(), granted, ev("bug.backlogReleased", AGENT, { reason: "r" })).backlogged,
    "an agent's release is dropped too");
  assert.equal(fold(filed(), granted, ev("bug.backlogReleased", OTHER, { reason: "we are doing it now" })).backlogged,
    undefined, "and another person's is applied — anybody's decision, not only the granter's");
});

test("bringing a bug back records WHY, at both ends", () => {
  const granted = ev("bug.backlogged", PERSON, { until: "2026-11-01", reason: "r", anchors: [W] });
  // The writer refuses an empty reason and the fold did not, on the finding side, which
  // is the guard-at-one-end shape this contract forbids: a buggy or older client could
  // un-backlog with no record of why, and every clone would apply it.
  assert.ok(fold(filed(), granted, ev("bug.backlogReleased", PERSON, {})).backlogged,
    "no reason, no release");
  assert.ok(fold(filed(), granted, ev("bug.backlogReleased", PERSON, { reason: "" })).backlogged,
    "and an empty one is no reason");
});

test("only the bug's OWN live citations may witness the deferral", () => {
  // A witness on unrelated code would answer drift about code the bug is not about: edits
  // to the actual defect would never wake it and edits elsewhere would. A wrong witness is
  // worse than none — none is visibly undecidable, this looks settled. The fold can hold
  // this line where the finding fold could not, because a bug's citations are fold state.
  const b = fold(filed(), ev("bug.backlogged", PERSON, {
    until: "2026-11-01", reason: "r", anchors: [W, W2],
  }));
  assert.deepEqual(b.backlogged?.witnesses, [W], "the uncited anchor is dropped");

  // Only the WITNESSES are dropped. The deadline is the guaranteed release condition and
  // a decision somebody made must not be lost over a bad optional field — date-only is a
  // supported state, and it is exactly what an acknowledgement has.
  const dateOnly = fold(filed(), ev("bug.backlogged", PERSON, { until: "2026-11-01", reason: "r", anchors: [W2] }));
  assert.equal(dateOnly.backlogged?.until, "2026-11-01");
  assert.equal(dateOnly.backlogged?.witnesses, undefined);

  // And a citation a person has TOMBSTONED is not a live one.
  const dropped = fold(
    filed(),
    ev("bug.unanchored", PERSON, { anchorId: "a_1", reason: "wrong code" }),
    ev("bug.backlogged", PERSON, { until: "2026-11-01", reason: "r", anchors: [W] }),
  );
  assert.equal(dropped.backlogged?.witnesses, undefined);
});

test("a deferral is a record, not a deletion — the bug and its history survive", () => {
  const b = fold(
    filed(),
    ev("bug.commented", PERSON, { body: "still reproduces on develop" }),
    ev("bug.backlogged", PERSON, { until: "2026-11-01", reason: "r", anchors: [W] }),
  );
  assert.equal(b.state, "created", "backlogging changes no state — it is not a closure");
  assert.equal(b.thread.length, 1);
  assert.deepEqual(b.anchors.map((a) => a.anchorId), ["a_1"], "and it still points at its code");

  // Released, the field is GONE rather than dated: it is back, and the events are the
  // history. A dated one would need every reader to know which dates mean "over".
  const back = fold(
    filed(),
    ev("bug.backlogged", PERSON, { until: "2026-11-01", reason: "r", anchors: [W] }),
    ev("bug.backlogReleased", PERSON, { reason: "we are doing it now" }),
  );
  assert.equal(back.backlogged, undefined);
});

test("a build that has never heard of these events keeps folding everything after them", () => {
  // The upgrade-skew degradation, verified rather than assumed: `foldBugs` has no
  // `default:` case, so an unknown kind is dropped and the fold carries on. That is what
  // makes a mixed-version team safe in the OLD -> new direction; the other direction is
  // what `MATERIALIZER_VERSION` 20 is for.
  const b = fold(
    filed(),
    ev("bug.somethingFromTheFuture", PERSON, { whatever: true }),
    ev("bug.backlogged", PERSON, { until: "2026-11-01", reason: "r", anchors: [W] }),
  );
  assert.ok(b.backlogged, "the event after the unknown one still folded");
});
