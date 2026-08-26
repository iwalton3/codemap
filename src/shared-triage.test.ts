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
import { foldTriage, triageSubject, triageOf, isTombstone, type SharedTriage } from "./shared-triage.js";
import { discard } from "./test-tmp.js";

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
/** The mark for `a_1`, or undefined — a tombstone is an ASSERTED absence, not a mark. */
const one = (events: LogEvent[]): SharedTriage | undefined => {
  const e = fold(events).get(SUBJ);
  return e && !isTombstone(e) ? e : undefined;
};

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

test("an agent raising over a human baseline is an ESCALATION, not a contest", () => {
  // Not even a concurrency case: a person marks a symbol `low`, then `pr-triage` runs
  // and its agent proposes `business-critical` on the same machine, having seen it.
  // Counting that as a contest files a review-queue item per symbol on every sync —
  // "contest everything", which this design rejected, reached through a side door on a
  // pull request that marks hundreds of symbols.
  const t = one([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", importance: "low" }),
    say({ id: "0000000002-bb", by: opus, writer: "w_i", after: ["0000000001-aa"], importance: "business-critical" }),
  ])!;
  assert.equal(t.importance.effective.value, "business-critical", "the escalation still holds the value");
  assert.equal(t.importance.escalation?.actor.via?.model, "claude-opus-5");
  assert.equal(t.importance.baseline?.value, "low", "and the human baseline stays visible, so `confirm` means something");
  assert.equal(t.importance.contested, undefined, "it saw the mark it raised — that is an escalation, not a disagreement");
});

test("two AGENTS across the line, concurrent, IS a contest", () => {
  // The design: "An agent may settle an agent/agent disagreement; it may not settle one
  // between two people." A disagreement it can settle is still a disagreement.
  const t = one([
    say({ id: "0000000001-aa", by: opus, writer: "w_o", importance: "low" }),
    say({ id: "0000000002-bb", by: bensAgent, writer: "w_b", importance: "business-critical" }),
  ])!;
  assert.equal(t.importance.contested, true);
});

test("but an agent may NOT settle it either — it proposes, a person settles", () => {
  const t = one([
    say({ id: "0000000001-aa", by: opus, writer: "w_o", importance: "low" }),
    say({ id: "0000000002-bb", by: bensAgent, writer: "w_b", importance: "business-critical" }),
    say({ id: "0000000003-cc", by: opus, writer: "w_o2", after: ["0000000001-aa", "0000000002-bb"], importance: "business-critical" }),
  ])!;
  assert.equal(
    t.importance.contested, true,
    "the design's agent-settles-agent half is unreachable (`ratchet` refuses an agent no-op, and "
    + "there is nothing above business-critical to assert) — so an agent investigates and proposes, "
    + "and the person settles by re-triaging",
  );
});

test("but an agent may NOT settle a disagreement between two people", () => {
  const t = one([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", importance: "business-critical" }),
    say({ id: "0000000002-bb", by: ben, writer: "w_b", importance: "low" }),
    say({ id: "0000000003-cc", by: opus, writer: "w_o", after: ["0000000001-aa", "0000000002-bb"], importance: "business-critical" }),
  ])!;
  assert.equal(t.importance.contested, true, "an agent pruning human receipts would settle a human disagreement by machine");
});

test("a person settles it, and then it is settled", () => {
  const t = one([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", importance: "business-critical" }),
    say({ id: "0000000002-bb", by: ben, writer: "w_b", importance: "low" }),
    say({ id: "0000000003-cc", by: ben, writer: "w_b2", after: ["0000000001-aa", "0000000002-bb"], importance: "important" }),
  ])!;
  assert.equal(t.importance.contested, undefined);
  assert.equal(t.importance.effective.value, "important");
});

test("a FORK's own disagreement is contested — `sameWriter` is deleted, not made fork-aware", () => {
  // `docs/sidecar-architecture.md`: sameWriter is deleted from contest detection
  // because "its only residual effect was suppressing intra-fork disagreements". Two
  // clones holding one writer id is exactly the case worth seeing, and an earlier
  // draft of this rule tested writer inequality and would have hidden it.
  const t = one([
    say({ id: "0000000001-aa", by: izzie, writer: "w_SHARED", importance: "business-critical" }),
    say({ id: "0000000002-bb", by: izzie, writer: "w_SHARED", importance: "low" }),
  ])!;
  assert.equal(t.importance.contested, true);
});

test("a human answering ONE field leaves the agent's other field standing", () => {
  // The bug this cost the most to find: eligibility was judged per EVENT, so a person
  // answering the complexity of an agent's `{business-critical, deep}` dropped the
  // whole event — and the business-critical importance nobody disputed vanished with
  // it. The target folded to ABSENT.
  const t = one([
    say({ id: "0000000001-aa", by: opus, writer: "w_o", importance: "business-critical", complexity: "deep" }),
    say({ id: "0000000002-bb", by: izzie, writer: "w_i", after: ["0000000001-aa"], complexity: "wiring" }),
  ]);
  assert.ok(t, "the target must not fold to absent — nobody disputed the stakes");
  assert.equal(t!.importance.effective.value, "business-critical");
  assert.equal(t!.complexity!.effective.value, "wiring", "and the field she DID answer is hers");
});

test("an agent may not lower an active human complexity, even with no human importance", () => {
  // `ratchet` judges against a state that must be able to hold a complexity with no
  // importance. Seeded as `undefined` the replay took the FIRST-MARK branch, where an
  // explicit `wiring` stands — so the agent lowered a person's `deep`.
  const t = one([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", complexity: "deep" }),
    say({ id: "0000000002-bb", by: opus, writer: "w_o", after: ["0000000001-aa"], importance: "important", complexity: "wiring" }),
  ])!;
  assert.equal(t.importance.effective.value, "important", "the agent's stakes stand — nobody had set any");
  assert.equal(t.complexity!.effective.value, "deep", "and the human's complexity is not lowered by a machine");
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

test("a clear causally after a mark folds the target to an asserted absence", () => {
  const got = fold([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", importance: "business-critical" }),
    clear("0000000002-bb", ben, { writer: "w_b", after: ["0000000001-aa"] }),
  ]);
  const e = got.get(SUBJ)!;
  assert.ok(e && isTombstone(e), "a TOMBSTONE, not nothing — see below for why the difference is load-bearing");
  assert.equal(e.cleared.actor.principal, "ben@x.com", "and it says who cleared it");
  assert.equal(one([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", importance: "business-critical" }),
    clear("0000000002-bb", ben, { writer: "w_b", after: ["0000000001-aa"] }),
  ]), undefined, "the superseded mark stays in history and out of the marks");
});

test("a target with nothing ADMISSIBLE is not a tombstone — it is uncovered", () => {
  // The distinction the whole F2 repair turns on. A tombstone says "the team cleared
  // this"; no row at all says "the team never said anything usable". Collapsing them
  // lets a REFUSED agent claim — one the ratchet rejected because an agent may not
  // invent stakes — suppress somebody's local mark, which is the same lowering by the
  // back door.
  const got = fold([say({ id: "0000000001-aa", by: opus, writer: "w_o", complexity: "deep" })]);
  assert.equal(got.get(SUBJ), undefined, "no entry at all, so the reader knows the log has no answer here");
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
  const e = got.get(SUBJ)!;
  assert.ok(isTombstone(e), "the clear still stands — a complexity alone cannot revive a cleared mark");
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
  const mark = (id: string) => { const e = got.get(triageSubject("anchor", id))!; return isTombstone(e) ? null : e; };
  assert.equal(mark("a_1")!.importance.effective.value, "business-critical");
  assert.equal(mark("a_2")!.importance.effective.value, "low");
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

// --- the write paths, which is where causality is captured -------------------

test("a failed append with a sidecar configured writes NOTHING", async () => {
  // The defect this closes is not the failure — it is the RECOVERY. A local row written
  // here is published later, and `emitEvents` captures causal heads at APPEND time, so
  // the event would claim this act had seen everything pulled in between. That is the
  // "reconstructed events falsely claim to have seen everything just pulled" defect
  // `docs/sidecar-architecture.md` bans, arriving by a slower route.
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { writeStore, readLocalTriage } = await import("./store.js");
  const { setTriage } = await import("./triage.js");

  const root = mkdtempSync(join(tmpdir(), "codemap-nofallback-"));
  try {
    mkdirSync(join(root, ".codemap"), { recursive: true });
    await writeStore(root, [], { schemaVersion: 1, lastVerifiedCommit: null, grammarVersions: {} } as any);
    // A sidecar that cannot work: the path is a FILE, so every append throws.
    writeFileSync(join(root, "not-a-dir"), "x");
    writeFileSync(join(root, ".codemap", "sidecar"), join(root, "not-a-dir"));

    const r = await setTriage(root, {
      targetKind: "anchor", targetId: "a_1", importance: "business-critical", source: "human",
    }) as { ok: boolean; reason?: string };

    assert.equal(r.ok, false, "a write that did not reach the log must not report success");
    assert.match(r.reason ?? "", /sidecar/i, "and it must say what to fix");
    assert.deepEqual(
      (await readLocalTriage(root)).triage, [],
      "NOTHING was written — a row here is the causality-fabrication path, not a safety net",
    );
  } finally { discard(root); }
});

test("but with NO sidecar the local row is still the whole story", async () => {
  // The control. Without it the rule above passes just as well if `setTriage` had
  // simply stopped writing anything at all, which would break every single-player store.
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { writeStore, readLocalTriage } = await import("./store.js");
  const { setTriage } = await import("./triage.js");

  const root = mkdtempSync(join(tmpdir(), "codemap-solo-"));
  try {
    mkdirSync(join(root, ".codemap"), { recursive: true });
    await writeStore(root, [], { schemaVersion: 1, lastVerifiedCommit: null, grammarVersions: {} } as any);
    const r = await setTriage(root, {
      targetKind: "anchor", targetId: "a_1", importance: "business-critical", source: "human",
    }) as { ok: boolean };
    assert.equal(r.ok, true);
    assert.equal((await readLocalTriage(root)).triage[0]?.importance, "business-critical");
  } finally { discard(root); }
});

test("a failed shared clear does not delete the local row on its way out", async () => {
  // The order IS the correctness. Removing the local row first and appending second
  // leaves a failed append returning `{ok:false}` with the mark already gone — "a
  // failed append writes nothing", broken by the function that reports it.
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { writeStore, readLocalTriage, replaceLocalTriage } = await import("./store.js");
  const { clearTriage } = await import("./triage.js");

  const root = mkdtempSync(join(tmpdir(), "codemap-clearfail-"));
  try {
    mkdirSync(join(root, ".codemap"), { recursive: true });
    await writeStore(root, [], { schemaVersion: 1, lastVerifiedCommit: null, grammarVersions: {} } as any);
    await replaceLocalTriage(root, [{
      target: { kind: "anchor", id: "a_1" }, importance: "business-critical",
      likely: false, source: "human", at: "t", witnesses: [],
    }]);
    // A sidecar that cannot work: the path is a FILE, so the append throws.
    writeFileSync(join(root, "not-a-dir"), "x");
    writeFileSync(join(root, ".codemap", "sidecar"), join(root, "not-a-dir"));

    const r = await clearTriage(root, { targetKind: "anchor", targetId: "a_1" }) as
      { ok: boolean; removed: number };
    assert.equal(r.ok, false, "the clear did not land, so it must not report success");
    assert.equal(r.removed, 0, "and must not claim to have removed anything");
    assert.equal(
      (await readLocalTriage(root)).triage.length, 1,
      "the mark is STILL THERE — a failed clear that deleted it locally is the worst of both",
    );
  } finally { discard(root); }
});

test("a complexity-only assertion does not erase a tombstone", () => {
  // A clear is superseded only by something that could REINSTATE the mark. Judged
  // against every later human entry, a complexity-only assertion killed the clear while
  // `humanBaseline` — which filters on the field — still read the target as cleared, so
  // the fold returned NEITHER a mark nor a tombstone. A legacy local row then filled a
  // hole that a deliberate clear had made.
  const got = fold([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", importance: "business-critical" }),
    clear("0000000002-bb", izzie, { writer: "w_i", after: ["0000000001-aa"] }),
    say({ id: "0000000003-cc", by: ben, writer: "w_b", after: ["0000000002-bb"], complexity: "deep" }),
  ]);
  const e = got.get(SUBJ);
  assert.ok(e && isTombstone(e), "the clear still stands, and still says so to the table");
});

test("but an importance DOES reinstate it — a clear is not a permanent ban", () => {
  // The control. Without it the rule above passes just as well if nothing could ever
  // supersede a clear, which would make a cleared target unusable forever.
  const t = one([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", importance: "business-critical" }),
    clear("0000000002-bb", izzie, { writer: "w_i", after: ["0000000001-aa"] }),
    say({ id: "0000000003-cc", by: ben, writer: "w_b", after: ["0000000002-bb"], importance: "important" }),
  ])!;
  assert.equal(t.importance.effective.value, "important");
});

test("a contest names EVERY side, not just the one that happens to be effective", () => {
  // The queue item is what a person acts on, so a question that says two parties
  // disagree and lists one is worse than not asking. `effective + concurrent` could not
  // supply both: `concurrent` holds only the human receipts the baseline won over, and
  // an agent's losing claim was computed for the contest check and then dropped.
  const agentAgent = one([
    say({ id: "0000000001-aa", by: opus, writer: "w_o", importance: "low", reason: "guarded" }),
    say({ id: "0000000002-bb", by: bensAgent, writer: "w_b", importance: "business-critical", reason: "money" }),
  ])!;
  assert.equal(agentAgent.importance.contested, true);
  assert.deepEqual(
    (agentAgent.importance.contestedWith ?? []).map((r) => r.value).sort(),
    ["business-critical", "low"],
    "two agents disagreeing: both claims are on the record",
  );

  const humanAgent = one([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", importance: "low" }),
    say({ id: "0000000002-bb", by: bensAgent, writer: "w_b", importance: "business-critical" }),
  ])!;
  assert.deepEqual(
    (humanAgent.importance.contestedWith ?? []).map((r) => r.actor.principal).sort(),
    ["ben@x.com", "izzie@x.com"],
    "and a human/agent contest names the person as well as the machine",
  );
});
