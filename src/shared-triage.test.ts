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
import { foldTriage, foldTriageReport, triageSubject, triageOf, isTombstone, type SharedTriage } from "./shared-triage.js";
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
  /** Push order. Given where it must differ from id order. */
  seq?: number;
}

/** One `triage.asserted`, with the boring half of the envelope filled in. */
const say = (s: Say): LogEvent => testEvent({
  id: s.id, kind: "triage.asserted", subject: triageSubject("anchor", s.target ?? "a_1"),
  actor: s.by, writer: s.writer ?? `w_${s.by.principal}`, after: s.after ?? [],
  ...(s.seq !== undefined ? { seq: s.seq } : {}),
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
  ...(over.seq !== undefined ? { seq: over.seq } : {}),
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

// --- push order (owner, Q6: "Correct push order is what matters") -----------

test("between people the later mark in PUSH order supersedes, whatever its value or id", () => {
  // Pushed second but minted first: the id sorts earlier, the log puts it later. Neither
  // writer read the other; nobody is asked to arbitrate, and nothing is ranked.
  const t = one([
    say({ id: "0000000009-zz", by: izzie, writer: "w_i", importance: "important", seq: 1 }),
    say({ id: "0000000001-aa", by: ben, writer: "w_b", importance: "low", seq: 2 }),
  ])!;
  assert.equal(t.importance.effective.value, "low", "the later push stands, not the higher value");
  assert.equal(t.importance.effective.actor.principal, "ben@x.com");
});

test("across the business-critical line too: the later mark stands and nothing is queued", () => {
  const t = one([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", importance: "business-critical", seq: 1 }),
    say({ id: "0000000002-bb", by: ben, writer: "w_b", importance: "low", seq: 2 }),
  ])!;
  assert.equal(t.importance.effective.value, "low");
  assert.deepEqual(Object.keys(t.importance).sort(), ["baseline", "effective"], "no contest residue on the axis");
});

test("an agent raising over a human baseline is an ESCALATION", () => {
  const t = one([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", importance: "low" }),
    say({ id: "0000000002-bb", by: opus, writer: "w_i", after: ["0000000001-aa"], importance: "business-critical" }),
  ])!;
  assert.equal(t.importance.effective.value, "business-critical", "the escalation holds the value");
  assert.equal(t.importance.escalation?.actor.via?.model, "claude-opus-5");
  assert.equal(t.importance.baseline?.value, "low", "and the human baseline stays visible, so `confirm` means something");
});

test("a stale agent claim below the value it lands on is refused — the ratchet at replay", () => {
  // Two agents staged apart: the lower one lands second, against the higher. An agent may
  // only raise, judged against the log before it.
  const events = sortEvents([
    say({ id: "0000000002-bb", by: bensAgent, writer: "w_b", importance: "business-critical", seq: 1 }),
    say({ id: "0000000001-aa", by: opus, writer: "w_o", importance: "low", seq: 2 }),
  ]);
  const { value, refused } = foldTriageReport(events);
  assert.deepEqual(refused.map((r) => [r.id, r.cls]), [["0000000001-aa", "state"]]);
  const t = value.get(SUBJ) as SharedTriage;
  assert.equal(t.importance.effective.value, "business-critical");
  // The other order is an ordinary raise, and lands.
  const raised = foldTriageReport(sortEvents([
    say({ id: "0000000001-aa", by: opus, writer: "w_o", importance: "low", seq: 1 }),
    say({ id: "0000000002-bb", by: bensAgent, writer: "w_b", importance: "business-critical", seq: 2 }),
  ]));
  assert.deepEqual(raised.refused, []);
  assert.equal((raised.value.get(SUBJ) as SharedTriage).importance.effective.value, "business-critical");
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

test("the same value said twice: the later receipt is the effective one", () => {
  const t = one([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", importance: "business-critical", seq: 1 }),
    say({ id: "0000000002-bb", by: ben, writer: "w_b", importance: "business-critical", seq: 2 }),
  ])!;
  assert.equal(t.importance.effective.eventId, "0000000002-bb");
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

test("a clear and a mark written apart: whichever is pushed later stands", () => {
  const cleared = fold([
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", importance: "important", seq: 1 }),
    clear("0000000002-bb", ben, { writer: "w_b", seq: 2 }),
  ]).get(SUBJ)!;
  assert.ok(isTombstone(cleared), "the clear was pushed second");
  const marked = one([
    clear("0000000002-bb", ben, { writer: "w_b", seq: 1 }),
    say({ id: "0000000001-aa", by: izzie, writer: "w_i", importance: "important", seq: 2 }),
  ])!;
  assert.equal(marked.importance.effective.value, "important", "the mark was pushed second");
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

test("a person's mark later in the log answers the agent claim before it, read or not", () => {
  const t = one([
    say({ id: "0000000001-aa", by: opus, writer: "w_o", importance: "business-critical", reason: "money path", seq: 1 }),
    say({ id: "0000000002-bb", by: izzie, writer: "w_i", importance: "low", seq: 2 }),
  ])!;
  assert.equal(t.importance.effective.value, "low");
  assert.equal(t.importance.escalation, undefined);
});

test("but an agent claim AFTER the person's mark still escalates over it", () => {
  const t = one([
    say({ id: "0000000002-bb", by: izzie, writer: "w_i", importance: "low", seq: 1 }),
    say({ id: "0000000001-aa", by: opus, writer: "w_o", importance: "business-critical", seq: 2 }),
  ])!;
  assert.equal(t.importance.effective.value, "business-critical");
  assert.equal(t.importance.baseline?.value, "low", "the human baseline stays visible, or `confirm` means nothing");
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

test("the later tripwire value in push order stands", () => {
  const trip = (first: boolean, second: boolean) => one([
    say({ id: "0000000002-bb", by: izzie, writer: "w_i", importance: "important", tripwire: first, seq: 1 }),
    say({ id: "0000000001-aa", by: ben, writer: "w_b", importance: "important", tripwire: second, seq: 2 }),
  ])!.tripwire?.effective.value;
  assert.equal(trip(true, false), false);
  assert.equal(trip(false, true), true);
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
