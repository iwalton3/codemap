/**
 * The triage fold, rule by rule against `docs/shared-triage.md`.
 *
 * Every test here states which rule it pins, because the rules were each chosen over
 * an obvious alternative that is wrong in a specific way — and a test that only says
 * "folds correctly" is one nobody can check against the design later.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { testEvent } from "./test-events.js";
import { sortEvents, type LogEvent } from "./eventlog.js";
import type { Actor, Importance, Complexity } from "./schema.js";
import { ratchet } from "./triage.js";
import { foldTriage, triageSubject, triageOf, type SharedTriage } from "./shared-triage.js";

const izzie: Actor = { principal: "izzie@x.com" };
const ben: Actor = { principal: "ben@x.com" };
const opus: Actor = { principal: "izzie@x.com", via: { kind: "agent", model: "claude-opus-5" } };
const bensAgent: Actor = { principal: "ben@x.com", via: { kind: "agent", model: "claude-opus-5" } };

const SUBJ = triageSubject("anchor", "a_1");

interface Say {
  id: string;
  by: Actor;
  writer?: string;
  after?: string[];
  importance?: Importance;
  complexity?: Complexity;
  tripwire?: boolean;
  source?: "agent" | "human" | "graph";
  reason?: string;
  target?: string;
}

/** One `triage.asserted`, with the boring half of the envelope filled in. */
const say = (s: Say): LogEvent => testEvent({
  id: s.id, kind: "triage.asserted", subject: triageSubject("anchor", s.target ?? "a_1"),
  actor: s.by, writer: s.writer ?? `w_${s.by.principal}`, after: s.after ?? [],
  data: {
    targetKind: "anchor", targetId: s.target ?? "a_1",
    ...(s.importance !== undefined ? { importance: s.importance } : {}),
    ...(s.complexity !== undefined ? { complexity: s.complexity } : {}),
    ...(s.tripwire !== undefined ? { tripwire: s.tripwire } : {}),
    source: s.source ?? (s.by.via ? "agent" : "human"),
    ...(s.reason ? { reason: s.reason } : {}),
    witnesses: [],
  },
});

/** One `triage.cleared`. `present: false` is explicit — see the writer's own note. */
const clear = (id: string, by: Actor, over: Partial<Say> = {}): LogEvent => testEvent({
  id, kind: "triage.cleared", subject: triageSubject("anchor", over.target ?? "a_1"),
  actor: by, writer: over.writer ?? `w_${by.principal}`, after: over.after ?? [],
  data: { targetKind: "anchor", targetId: over.target ?? "a_1", present: false },
});

const fold = (events: LogEvent[]) => foldTriage(sortEvents(events));
const one = (events: LogEvent[]): SharedTriage | undefined => fold(events).get(SUBJ);

// --- the headline: no lattice, so no max-fold ---------------------------------

test("the counterexample is real: two agent claims do not commute through the ratchet", () => {
  // THE CONTROL for the whole design. If replaying agent claims commuted, canonical
  // order would be a pointless complication and a max-fold would do. Replayed exactly
  // as the fold replays them — a refusal is skipped and the state stands.
  const replay = (claims: { importance?: Importance; complexity?: Complexity }[]) => {
    let state: any;
    for (const c of claims) {
      const d = ratchet(state, { ...c, source: "agent" });
      if ("refused" in d) continue;
      state = { target: { kind: "anchor", id: "a_1" }, likely: true, at: "", witnesses: [], source: "agent", ...d };
    }
    return { importance: state?.importance, complexity: state?.complexity };
  };
  const A = { importance: "important" as const };                                  // no complexity
  const B = { importance: "business-critical" as const, complexity: "wiring" as const };

  assert.deepEqual(replay([A, B]), { importance: "business-critical", complexity: undefined },
    "A then B: an absent complexity is read as `standard` once a mark exists, so `wiring` does not raise it");
  assert.deepEqual(replay([B, A]), { importance: "business-critical", complexity: "wiring" },
    "B then A: an explicit `wiring` stands on a FIRST mark, and A then raises nothing at all");
  assert.notDeepEqual(replay([A, B]), replay([B, A]),
    "the asymmetry this design is built around is gone — a max-fold would now be correct, and this file is over-engineered");
});

test("and the fold is order-independent anyway, because the order is canonical", () => {
  const events = [
    say({ id: "0000000001-aa", by: opus, writer: "w_a", importance: "important" }),
    say({ id: "0000000002-bb", by: bensAgent, writer: "w_b", importance: "business-critical", complexity: "wiring" }),
  ];
  const forward = triageOf(one(events)!);
  const backward = triageOf(one(events.slice().reverse())!);
  assert.deepEqual(forward, backward, "the order events ARRIVED in changed what they mean");
});

// --- supersession -------------------------------------------------------------

test("causally-seen supersedes: looking at business-critical and setting low IS the decision", () => {
  const t = one([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", importance: "business-critical" }),
    say({ id: "0000000002-bb", by: ben, writer: "w_b", after: ["0000000001-aa"], importance: "low" }),
  ])!;
  assert.equal(t.importance.effective.value, "low");
  assert.equal(t.importance.contested, undefined, "a decision is not a conflict, whatever line it crosses");
  assert.equal(t.importance.concurrent, undefined, "a superseded claim is not a retained divergence");
});

test("supersession is per FIELD: settling complexity does not settle importance", () => {
  const t = one([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", importance: "business-critical", complexity: "deep" }),
    // Ben saw it and answered the complexity only. He said nothing about the stakes.
    say({ id: "0000000002-bb", by: ben, writer: "w_b", after: ["0000000001-aa"], complexity: "wiring" }),
  ])!;
  assert.equal(t.importance.effective.value, "business-critical", "the importance he never touched still stands");
  assert.equal(t.complexity!.effective.value, "wiring");
  assert.equal(t.importance.effective.actor.principal, "izzie@x.com");
  assert.equal(t.complexity!.effective.actor.principal, "ben@x.com",
    "one record, two receipts — which is the whole reason the table is per field");
});

// --- concurrent divergence ----------------------------------------------------

test("concurrent divergence takes the HIGHER value, silently, and keeps both receipts", () => {
  const t = one([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", importance: "low" }),
    say({ id: "0000000002-bb", by: ben, writer: "w_b", importance: "important" }),
  ])!;
  assert.equal(t.importance.effective.value, "important");
  assert.equal(t.importance.contested, undefined,
    "low vs important is not worth a person's attention — a rule people route around is worse");
  assert.deepEqual(t.importance.concurrent?.map((r) => r.value), ["low"],
    "the losing receipt is RETAINED — per-field provenance is required either way");
});

test("last-in-wins is specifically NOT the rule: the larger id does not decide", () => {
  // The rejected design, pinned. `low` sorts later here; under last-in-wins it would
  // silently lower a mark written by somebody who never saw it.
  const t = one([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", importance: "important" }),
    say({ id: "0000000009-zz", by: ben, writer: "w_b", importance: "low" }),
  ])!;
  assert.equal(t.importance.effective.value, "important", "review priority decided by event id");
});

test("across the business-critical line it goes to a person instead", () => {
  const t = one([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", importance: "business-critical" }),
    say({ id: "0000000002-bb", by: ben, writer: "w_b", importance: "low" }),
  ])!;
  assert.equal(t.importance.effective.value, "business-critical", "and the higher value still holds meanwhile");
  assert.equal(t.importance.contested, true);
});

test("equal values are not a disagreement, however many people say it", () => {
  const t = one([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", importance: "business-critical" }),
    say({ id: "0000000002-bb", by: ben, writer: "w_b", importance: "business-critical" }),
  ])!;
  assert.equal(t.importance.contested, undefined);
  assert.equal(t.importance.effective.eventId, "0000000001-aa", "ties break on id, so every clone picks the same one");
});

// --- clearing -----------------------------------------------------------------

test("a clear causally after a mark folds the target to absent", () => {
  const got = fold([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", importance: "business-critical" }),
    clear("0000000002-bb", ben, { writer: "w_b", after: ["0000000001-aa"] }),
  ]);
  assert.equal(got.get(SUBJ), undefined, "the superseded mark stays in history and out of the projection");
});

test("a clear CONCURRENT with an assertion loses — presence wins", () => {
  const t = one([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", importance: "important" }),
    clear("0000000002-bb", ben, { writer: "w_b" }),
  ])!;
  assert.equal(t.importance.effective.value, "important",
    "a mark nobody wanted costs a glance; a mark silently removed costs the review it was asking for");
});

test("an agent may not clear, and the fold is what enforces it", () => {
  const t = one([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", importance: "important" }),
    clear("0000000002-bb", opus, { writer: "w_o", after: ["0000000001-aa"] }),
  ])!;
  assert.equal(t.importance.effective.value, "important", "a write-time check protects the honest writer and nobody else");
});

test("a clear is not a permanent ban — stakes genuinely arrive later", () => {
  const t = one([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", importance: "low" }),
    clear("0000000002-bb", izzie, { writer: "w_i", after: ["0000000001-aa"] }),
    say({ id: "0000000003-cc", by: opus, writer: "w_o", after: ["0000000002-bb"], importance: "business-critical" }),
  ])!;
  assert.equal(t.importance.effective.value, "business-critical");
  assert.equal(t.importance.effective.likely, true, "an agent proposes; it does not confirm a tier");
});

test("but a complexity-only agent claim after a clear is still refused", () => {
  // There is no importance on record, and an agent that asserts no stakes does not get
  // one invented for it. Same rule as `ratchet`, reached through the fold.
  const got = fold([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", importance: "low" }),
    clear("0000000002-bb", izzie, { writer: "w_i", after: ["0000000001-aa"] }),
    say({ id: "0000000003-cc", by: opus, writer: "w_o", after: ["0000000002-bb"], complexity: "deep" }),
  ]);
  assert.equal(got.get(SUBJ), undefined);
});

// --- which agent claims stay active -------------------------------------------

test("a human assertion suppresses only the agent claims it actually SAW", () => {
  const t = one([
    // The agent's claim sorts FIRST. A sequential fold that treated the human as
    // "reset the state" would erase an escalation she never saw.
    say({ id: "0000000001-aa", by: opus, writer: "w_o", importance: "business-critical", reason: "money path" }),
    say({ id: "0000000002-bb", by: izzie, writer: "w_i", importance: "low" }),
  ])!;
  assert.equal(t.importance.effective.value, "business-critical");
  assert.equal(t.importance.baseline?.value, "low", "the human baseline stays visible, or `confirm` means nothing");
  assert.equal(t.importance.escalation?.actor.via?.model, "claude-opus-5");
});

test("and it does suppress one it saw — that is a person answering the agent", () => {
  const t = one([
    say({ id: "0000000001-aa", by: opus, writer: "w_o", importance: "business-critical" }),
    say({ id: "0000000002-bb", by: izzie, writer: "w_i", after: ["0000000001-aa"], importance: "low" }),
  ])!;
  assert.equal(t.importance.effective.value, "low");
  assert.equal(t.importance.escalation, undefined);
});

test("concurrency alone is not an escalation: a lower agent claim stays invisible", () => {
  const t = one([
    say({ id: "0000000001-aa", by: opus, writer: "w_o", importance: "low" }),
    say({ id: "0000000002-bb", by: izzie, writer: "w_i", importance: "important" }),
  ])!;
  assert.equal(t.importance.effective.value, "important");
  assert.equal(t.importance.escalation, undefined, "an agent may only ever RAISE");
});

// --- graph never travels ------------------------------------------------------

test("`source: graph` is ignored by the fold, not merely refused at the publish surface", () => {
  const got = fold([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", source: "graph", importance: "business-critical" }),
  ]);
  assert.equal(got.get(SUBJ), undefined,
    "remote events come from builds this one did not write, so the publish check cannot be the only gate");
});

// --- tripwire -----------------------------------------------------------------

test("an agent's tripwire value is ignored outright", () => {
  const t = one([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", importance: "important" }),
    say({ id: "0000000002-bb", by: opus, writer: "w_o", importance: "business-critical", tripwire: true }),
  ])!;
  assert.equal(t.tripwire, undefined, "humans only — `false` suppresses a notification");
});

test("concurrent true/false resolves to ARMED", () => {
  const t = one([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", importance: "important", tripwire: true }),
    say({ id: "0000000002-bb", by: ben, writer: "w_b", importance: "important", tripwire: false }),
  ])!;
  assert.equal(t.tripwire?.effective.value, true,
    "an unwanted alarm is reversible and visible; a silently disarmed one is the failure");
});

test("the way to disarm an alarm is to look at it and disarm it", () => {
  const t = one([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", importance: "important", tripwire: true }),
    say({ id: "0000000002-bb", by: ben, writer: "w_b", after: ["0000000001-aa"], importance: "important", tripwire: false }),
  ])!;
  assert.equal(t.tripwire?.effective.value, false);
});

// --- what is not a mark -------------------------------------------------------

test("a complexity with no importance anywhere is not a mark", () => {
  const got = fold([say({ id: "0000000001-aa", by: izzie, writer: "w_i", complexity: "deep" })]);
  assert.equal(got.get(SUBJ), undefined, "nothing can stand in for stakes — `triageFromRows` drops such a group too");
});

test("targets do not leak into each other", () => {
  const got = fold([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", importance: "business-critical" }),
    say({ id: "0000000002-bb", by: ben, writer: "w_b", importance: "low", target: "a_2" }),
  ]);
  assert.equal(got.get(triageSubject("anchor", "a_1"))!.importance.effective.value, "business-critical");
  assert.equal(got.get(triageSubject("anchor", "a_2"))!.importance.effective.value, "low");
  assert.equal(got.size, 2);
});

test("an event whose envelope and payload disagree about the target is refused", () => {
  // The subject is what the fold groups on; the payload is what it reads. A mismatch
  // would file one target's stakes under another's name.
  const bad = testEvent({
    id: "0000000001-aa", kind: "triage.asserted", subject: triageSubject("anchor", "a_1"), actor: izzie,
    writer: "w_i", data: { targetKind: "anchor", targetId: "a_2", source: "human", importance: "low", witnesses: [] },
  });
  assert.equal(fold([bad]).size, 0);
});

// --- the compatibility surface ------------------------------------------------

test("`likely` is DERIVED: true when any effective field is agent-supplied", () => {
  const t = one([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", importance: "business-critical", complexity: "wiring" }),
    say({ id: "0000000002-bb", by: opus, writer: "w_o", complexity: "deep" }),
  ])!;
  const flat = triageOf(t);
  assert.equal(flat.importance, "business-critical");
  assert.equal(flat.complexity, "deep", "the agent raised the complexity it was allowed to raise");
  assert.equal(flat.source, "human", "top-level source is the IMPORTANCE receipt, documented as an alias");
  assert.equal(flat.likely, true, "and `likely` says an agent supplied one of the effective values");
});
