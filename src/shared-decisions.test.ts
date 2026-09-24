/**
 * The decision-round fold, run on hand-built events — the way this codebase reviews a fold
 * (CLAUDE.md, "To review a fold, RUN it"). The rulings behind each case are in
 * docs/decision-rounds-worked-cases.md and the review rounds' `owner.md` files; the A/B/C/S
 * numbers are `.git/triage/2026-09-23-decision-rounds-2-impl-review/plan.md`'s. There is no
 * state label to assert on: each case asserts on the standing answer and on the views, because
 * those are what the person and the agents actually read. Every case whose outcome once
 * depended on recording order is run in both orders (`both`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  foldDecisions, decisionHash, checkDecision, heldFindings, standing, waitingOnMe, readingsInDispute, ruledNotCarriedOut, awaitingReading, parked,
  possiblySuperseded, confirmPayload, confirmState, supersededFindings, readerBrief, briefManifest, briefListing, readingRefusal, intentCandidates, CONFIRM_YES, CONFIRM_NO,
  type FoldedDecision, type SharedDecisions, type Mapping,
} from "./shared-decisions.js";

const person: any = { principal: "izzie" };
const agent: any = { principal: "izzie", via: { kind: "agent", model: "m" } };
let n = 0;
const at = (k: number) => `2026-09-23T00:00:${String(k).padStart(2, "0")}Z`;
const ev = (kind: string, data: any, actor: any = agent): any => ({ id: `e${++n}`, kind, subject: "s", actor, at: at(n), after: [], data });
const q = (question: string, labels: string[], multi?: boolean): any => ({ question, header: "H", options: labels.map((l) => ({ label: l, description: "d" })), ...(multi ? { multiSelect: true } : {}) });
const D = (id: string, ref: string, payload: any, options: any[], extra: any = {}): any => ({ id, round: "R1", ref, kind: "options", payload, options, ...extra });
const settle = (...findings: string[]) => ({ findings, on: "settle", as: "refuted" });
const unblock = (...findings: string[]) => ({ findings, on: "unblock" });

const d1 = D("d1", "D1", q("D1: approve the fix for F3 and F7?", ["Settle", "No"]), [
  { label: "Settle", effects: [settle("F3"), unblock("F7")], recommended: true },
  { label: "No", effects: [] }]);
const d2 = D("d2", "D2", q("D2: check any of F10, F11 to rule on separately", ["Rename fix", "Path fix", "None — approve all"], true), [
  { label: "Rename fix", effects: [settle("F10")] }, { label: "Path fix", effects: [unblock("F11")] },
  { label: "None — approve all", effects: [], approveAll: true }], { kind: "bulk" });
const d3 = D("d3", "D3", q("D3: park F20?", ["Park until 2026-10-15", "Now"]), [
  { label: "Park until 2026-10-15", effects: [], park: "2026-10-15" }, { label: "Now", effects: [unblock("F20")] }]);
const d4 = D("d4", "D4", q("D4: close F30?", ["A", "B"]), [{ label: "A", effects: [settle("F30")] }, { label: "B", effects: [unblock("F30")] }]);
const d5 = { ...D("d5", "D5", q("D5: the goal, in your words?", ["x", "y"]), [{ label: "x", effects: [] }, { label: "y", effects: [] }]), kind: "words" };
const round = ev("decision.round.posted", { round: { id: "R1", source: "plan-x", universe: "u" }, decisions: [d1, d2, d3, d4, d5] });
const h = (d: any) => decisionHash(d);
/** `d` re-asked as `id` in `round`, with its ref in the text as posting requires. */
const reask = (d: any, id: string, ref: string, rnd: string, extra: any = {}) =>
  ({ ...d, id, ref, round: rnd, payload: { ...d.payload, question: d.payload.question.replace(d.ref, ref) }, ...extra });
const post = (id: string, decisions: any[], extra: any = {}) => ev("decision.round.posted", { round: { id, source: "x", ...extra }, decisions });

type B = Record<string, FoldedDecision>;
/** Folds `evs`. A reading built without a brief is given the one codemap writes for its answer,
 *  as `record_reading` would, from a first fold that learns the answer; `brief: null` keeps none. */
const fold = (evs: any[]) => {
  const pending = evs.filter((e) => e.kind === "decision.reading.recorded" && e.data?.reader && e.data.reader.brief === undefined);
  if (pending.length) {
    const first = foldDecisions([round, ...evs]), byId = new Map(first.decisions.map((d) => [d.id, d]));
    for (const e of pending) {
      const x = first.decisions.flatMap((d) => d.answers.map((a) => ({ d, a }))).find(({ a }) => a.id === e.data.answer);
      if (x) e.data.reader.brief = readerBrief(byId, x.d, x.a);
    }
  }
  const out = foldDecisions([round, ...evs]);
  folded = new Map(out.decisions.map((d) => [d.id, d]));
  return { out, b: Object.fromEntries(out.decisions.map((d) => [d.id, d])) as B };
};
/** The decisions of the latest fold, which `possiblySuperseded` walks down replacement chains. */
let folded = new Map<string, FoldedDecision>();
const sup = (d: FoldedDecision) => possiblySuperseded(d, folded);
const dump = (b: B, out: SharedDecisions) => JSON.stringify(Object.fromEntries(Object.entries(b).map(([k, d]) => [k, { answers: d.answers, replacedBy: d.replacedBy }])), null, 1).slice(0, 3000) + JSON.stringify(out.questions).slice(0, 600);
const run = (name: string, extra: () => any[], check: (b: B, out: SharedDecisions) => boolean) => test(name, () => {
  n = 1;
  const { out, b } = fold(extra());
  assert.ok(check(b, out), dump(b, out));
});
/** The same events in two recording orders, which must agree (plan A2: "computed from the set"). */
const both = (name: string, make: () => { first: any[]; second: any[] }, check: (b: B, out: SharedDecisions) => boolean) => test(name, () => {
  n = 1;
  const { first, second } = make();
  for (const [label, evs] of [["first order", first], ["second order", second]] as const) {
    const { out, b } = fold(evs);
    assert.ok(check(b, out), `${label}: ${dump(b, out)}`);
  }
});

/** A logged call, answered when it was logged unless `answeredAt` says otherwise. */
const logQ = (qs: any[], answers: any, extra: any = {}) => {
  const rounds = extra.rounds ?? [extra.round ?? "R1"];
  const e = ev("decision.question.logged", {
    session: "sess-A", toolUseId: `tu${n + 1}`, questions: qs, answers, transcript: "sess-A", rounds,
    bound: extra.bound ?? Object.fromEntries(qs.map((x: any) => [x.question, rounds[0]])),
    ...(extra.answeredAt ? { answeredAt: extra.answeredAt } : {}), ...(extra.toolUseId ? { toolUseId: extra.toolUseId } : {}),
  });
  e.data.answeredAt ??= e.at;
  return e;
};
const answer = (d: any, via: any, actor: any = agent, extra: any = {}) => ev("decision.answer.recorded", { decision: d.id, hash: h(d), via, ...extra }, actor);
const call = (d: any, value: any, extra: any = {}) => { const L = logQ([d.payload], { [d.payload.question]: value }, extra); return [L, answer(d, { kind: "question", question: L.id })]; };
const page = (d: any, via: any) => answer(d, { kind: "direct", ...via }, person);
/** A typed message, typed when it was relayed unless `typedAt` says otherwise. */
const msg = (d: any, text: string, entryId = "u1", typedAt?: string) => {
  const e = answer(d, { kind: "message", session: "s", entryId, text, round: d.round });
  e.data.via.at = typedAt ?? e.at;
  return e;
};
const unv = (d: any, words: string) => answer(d, { kind: "unverified", words }, agent, { relayedBy: "sess-A" });
let readers = 0;
/** A reader's verdict, as `record_reading` writes it: codemap's parse of the reader's own
 *  hand-back, a reader launched when this event was written, one reader per answer. */
const reading = (a: any, maps: Mapping[], session: Mapping[] = maps, extra: any = {}) => {
  const e = ev("decision.reading.recorded", {
    answer: a.id, session: { reading: "r", maps: session },
    reader: { agent: `aREADER${String(++readers).padStart(8, "0")}`, verdict: maps, verified: { session: "sess-X", toolUseId: "t" }, ...(extra.unclear ? { unclear: extra.unclear } : {}) },
    ...(extra.asks ? { asks: extra.asks } : {}),
  });
  e.data.reader.launchedAt = extra.launchedAt ?? e.at;
  return e;
};

/** Answers to the fixture round's other questions — made AFTER the words, so the words can then
 *  change only d1 (owner, Q1.2: a question keeps words listed until something is given after them). */
const others = () => [page(d2, { option: "None — approve all" }), page(d3, { option: "Now" }), page(d4, { option: "B" })];

const ruled = (d: FoldedDecision) => standing(d)?.ruled ?? [];
const rules = (d: FoldedDecision, f: string, on: string) => ruled(d).some((r) => r.finding === f && r.on === on);
const waits = (out: SharedDecisions, id: string, re?: RegExp, today = "2026-09-23") => waitingOnMe(out, today).some((w) => w.decision === id && (!re || re.test(w.why)));
const held = (out: SharedDecisions, f: string, why?: string, isOpen = (_: string) => true) => (heldFindings(out, isOpen).get(f) ?? []).some((x) => !why || x.why === why);
const since = (out: SharedDecisions, f: string) => (heldFindings(out, () => true).get(f) ?? []).map((x) => x.since);
const flagged = (d: FoldedDecision) => sup(d).length > 0;

// --- what an answer rules

run("a verified answer rules both effects; the settle holds its finding for the verifier, the unblock releases", () => call(d1, "Settle"),
  (b, out) => rules(b.d1!, "F3", "settle") && rules(b.d1!, "F7", "unblock") && held(out, "F3", "ruled") && !held(out, "F7") && !waits(out, "d1"));
run("an unanswered decision waits on you and holds everything it could touch", () => [],
  (b, out) => waits(out, "d1", /not answered/) && held(out, "F3", "undecided") && held(out, "F7", "undecided"));
run("an unverified relay, read, unblocks; its settle waits for you and stays held", () => {
  const A = unv(d1, "D1 yes");
  return [A, reading(A, [{ decision: "d1", option: "Settle" }])];
}, (b, out) => rules(b.d1!, "F7", "unblock") && !rules(b.d1!, "F3", "settle") && standing(b.d1!)!.unruled.includes("F3")
  && waits(out, "d1", /could not be verified/) && held(out, "F3", "undecided") && !held(out, "F7"));
run("C3: your second answer to the same question replaces the first", () => [page(d1, { option: "Settle" }), page(d1, { option: "No" })],
  (b, out) => standing(b.d1!)!.options[0] === "No" && !held(out, "F3"));
run("a words decision is recorded, never read, and rules nothing", () => call(d5, "Ship it"),
  (b, out) => standing(b.d5!)!.words === "Ship it" && !ruled(b.d5!).length && !waits(out, "d5") && !awaitingReading(out).length);

// --- which answer stands (plan A2: ranked from the set, verified first, then the later GIVEN)

run("H5: a typed 'D1 A' is never parsed — it waits for its reading, ranks nowhere, and nothing binds until then", () => [msg(d1, "D1 A")],
  (b, out) => !standing(b.d1!) && b.d1!.answers[0]!.free && awaitingReading(out).some((u) => u.decision === "d1") && held(out, "F3", "undecided"));
run("bound by a reader, a typed reply rules: its settle held, closing nothing", () => {
  const A = msg(d1, "D1 A");
  return [A, reading(A, [{ decision: "d1", option: "Settle" }])];
}, (b, out) => rules(b.d1!, "F3", "settle") && held(out, "F3", "ruled") && standing(b.d1!)!.via === "message");
run("a message typed before its question was posted binds to nothing", () => [msg(d1, "D1 A", "u1", "2026-09-22T23:59:59Z")], (b) => !b.d1!.answers.length);
run("a message typed for another round binds to nothing", () => { const e = msg(d1, "D1 A"); e.data.via.round = "R9"; return [e]; }, (b) => !b.d1!.answers.length);
run("the same message relayed twice to one decision records it once", () => [msg(d1, "D1 A", "u1"), msg(d1, "D1 A", "u1")], (b) => b.d1!.answers.length === 1);
run("a reader that cannot tell which question the words answer binds nothing, and it waits for you", () => {
  const A = msg(d1, "yes that one");
  return [A, reading(A, [], [{ decision: "d1", option: "Settle" }], { unclear: "two questions were open and the session asked neither just before" })];
}, (b, out) => !ruled(b.d1!).length && waits(out, "d1", /could not tell which question/) && !readingsInDispute(out).length && !awaitingReading(out).length);
run("B1.4: an identical question in another round does not take the answer — R1's ruling stands", () => {
  const r2 = reask(d1, "d1x", "D1", "R2");
  r2.payload = d1.payload;   // the same payload text on purpose: that is the collision
  const [L1, A1] = call(d1, "Settle");
  const R2 = post("R2", [r2]);
  const L2 = logQ([d1.payload], { [d1.payload.question]: "No" }, { round: "R2", toolUseId: "tu-R2" });
  return [L1, A1, R2, L2, answer(d1, { kind: "question", question: L2.id }), answer(r2, { kind: "question", question: L2.id })];
}, (b) => b.d1!.answers.length === 1 && rules(b.d1!, "F3", "settle") && standing(b.d1x!)!.options[0] === "No");
run("a call answered before its round was posted binds to nothing", () => call(d1, "Settle", { answeredAt: "2026-09-22T23:00:00Z" }), (b) => !b.d1!.answers.length);
run("H6.1: one call answers a decision once", () => { const [L, A] = call(d1, "Settle"); return [L, A, answer(d1, { kind: "question", question: L.id })]; },
  (b) => b.d1!.answers.length === 1);
run("A5 (P3.1 (2)): a verified page answer then an unverified relay — the ruling stands, and the relay is shown as arriving after it, unread", () => [page(d1, { option: "Settle" }), unv(d1, "D1 B")],
  (b, out) => standing(b.d1!)!.via === "direct" && rules(b.d1!, "F3", "settle")
    && waits(out, "d1", /unconfirmed answer arrived after your ruling: "D1 B"/) && !awaitingReading(out).length);
run("c4 (A5): an unconfirmed relay of the SAME pick after your ruling is shown too — unread, it cannot be told apart from agreement", () => [page(d1, { option: "Settle" }), unv(d1, "D1 Settle")],
  (b, out) => waits(out, "d1", /unconfirmed answer arrived after your ruling/) && !waits(out, "d1", /disagrees/));
run("...and your later correction replaces the ruling and clears it", () => [page(d1, { option: "Settle" }), unv(d1, "D1 B"), page(d1, { option: "No" })],
  (b, out) => standing(b.d1!)!.options[0] === "No" && !waits(out, "d1"));
run("an agent's unconfirmed words after your answer, read anyway, change nothing", () => {
  const P = page(d1, { option: "Settle" });
  const A = unv(d1, "actually fix it");
  return [P, A, reading(A, [{ decision: "d1", option: "No" }])];
}, (b, out) => rules(b.d1!, "F3", "settle") && standing(b.d1!)!.via === "direct" && !awaitingReading(out).length);
run("H7.9: between two verified answers the later GIVEN stands, not the later recorded", () => {
  // X answered at 10:00 and logged at 10:10; Y clicked at 10:05.
  const Y = page(d1, { option: "No" }); Y.at = "2026-09-23T10:05:00Z";
  const [L, X] = call(d1, "Settle", { answeredAt: "2026-09-23T10:00:00Z" }); X.at = "2026-09-23T10:10:00Z";
  return [Y, L, X];
}, (b) => standing(b.d1!)!.options[0] === "No");
run("your typed correction after a click, once read, replaces it if given later", () => {
  const P = page(d1, { option: "Settle" });
  const A = msg(d1, "no, leave it");
  return [P, A, reading(A, [{ decision: "d1", option: "No" }])];
}, (b, out) => standing(b.d1!)!.via === "message" && standing(b.d1!)!.options[0] === "No" && !held(out, "F3", "ruled") && !waits(out, "d1"));
run("...and not if it was typed before the click — and then it is moot, not waiting on anyone", () => {
  const P = page(d1, { option: "Settle" });
  const A = msg(d1, "no, leave it", "u1", "2026-09-23T00:00:01.500Z");
  return [P, A, reading(A, [{ decision: "d1", option: "No" }], [{ decision: "d1", option: "Settle" }]), ...others()];
}, (b, out) => standing(b.d1!)!.via === "direct" && !readingsInDispute(out).length && !flagged(b.d1!) && !waits(out, "d1"));

both("c1 (Q1): your typed words and an agent's relay give ONE answer, whichever was recorded first", () => {
  n = 1;
  const M = msg(d1, "D1 no, leave it");
  const U = unv(d1, "D1 settle it");
  const RU = reading(U, [{ decision: "d1", option: "Settle" }]);
  const RM = reading(M, [{ decision: "d1", option: "No" }]);
  return { first: [M, U, RU, RM], second: [U, RU, M, RM] };
}, (b, out) => standing(b.d1!)!.via === "message" && standing(b.d1!)!.options[0] === "No" && !held(out, "F3", "ruled"));
both("c1b: typed before an agent's relay but recorded after it, your words still outrank it once read", () => {
  n = 1;
  const U = unv(d1, "D1 settle it");
  const M = msg(d1, "D1 no", "u1", "2026-09-23T00:00:01.500Z");
  const RM = reading(M, [{ decision: "d1", option: "No" }]);
  const RU = reading(U, [{ decision: "d1", option: "Settle" }]);
  return { first: [U, RU, M, RM], second: [M, RM, U, RU] };
}, (b) => standing(b.d1!)!.via === "message" && standing(b.d1!)!.options[0] === "No");
both("S0.5: two verified answers given at the same moment are ordered by the log, the same in any fold", () => {
  n = 1;
  const X = page(d1, { option: "Settle" }), Y = page(d1, { option: "No" });
  X.at = Y.at = "2026-09-23T00:00:30Z";
  return { first: [X, Y], second: [X, Y] };
}, (b) => standing(b.d1!)!.options[0] === "No");

// --- S0.3: words the reader binds to ANOTHER question rank there by when given

both("c12 / S0.3: 'D2 not a defect' relayed against D1 and read as D2 rules D2 — over D2's earlier click, in either order", () => {
  n = 1;
  const P = page(d4, { option: "B" });
  const M = msg(d1, "D4 is fine as it is, A");
  const R = reading(M, [{ decision: "d4", option: "A" }]);
  return { first: [P, M, R], second: [M, P, R] };
}, (b, out) => {
  // The click is at e2 or e3 and the message is typed at the other; the later GIVEN stands.
  const click = b.d4!.answers.find((a) => a.via === "direct")!, copy = b.d4!.answers.find((a) => a.via === "message")!;
  const later = Date.parse(copy.givenAt) > Date.parse(click.givenAt) ? copy : click;
  return standing(b.d4!)!.id === later.id && !standing(b.d1!) && waits(out, "d1", /not answered/) && !awaitingReading(out).some((u) => u.decision === "d1");
});
run("S0.3: ...typed BEFORE the click and read after it, the copy is recorded last and still loses — given time, not log order", () => {
  const M = msg(d1, "and A on D4", "u1", "2026-09-23T00:00:01.500Z");
  const P = page(d4, { option: "B" });
  return [M, P, reading(M, [{ decision: "d4", option: "A" }])];
}, (b, out) => standing(b.d4!)!.via === "direct" && rules(b.d4!, "F30", "unblock") && !held(out, "F30"));
run("S0.3: ...typed after the click, the copy wins and settles F30", () => {
  const P = page(d4, { option: "B" });
  const M = msg(d1, "and A on D4");
  return [P, M, reading(M, [{ decision: "d4", option: "A" }])];
}, (b, out) => rules(b.d4!, "F30", "settle") && held(out, "F30", "ruled"));
run("C2: a reading maps free text onto another decision in the round too", () => {
  const L = logQ([d1.payload], { [d1.payload.question]: "yes, and A for the other one" });
  const A = answer(d1, { kind: "question", question: L.id });
  return [L, A, reading(A, [{ decision: "d1", option: "Settle" }, { decision: "d4", option: "A" }])];
}, (b) => rules(b.d1!, "F3", "settle") && rules(b.d4!, "F30", "settle"));
run("c2: a verified copy onto D2 is not displaced by an agent's later unverified relay there", () => {
  const L = logQ([d1.payload], { [d1.payload.question]: "neither is worth fixing: settle, and A on D4" });
  const A = answer(d1, { kind: "question", question: L.id });
  const U = unv(d4, "D4 B");
  return [L, A, reading(A, [{ decision: "d1", option: "Settle" }, { decision: "d4", option: "A" }]), U, reading(U, [{ decision: "d4", option: "B" }])];
}, (b, out) => rules(b.d4!, "F30", "settle") && held(out, "F30", "ruled") && waits(out, "d4", /arrived after your ruling/));

// --- plan A3: words that may overturn a ruling flag it, and the ruling stands

run("P4.1: a click, then unread words — the click stands, D1 and every finding it names are flagged", () => [page(d1, { option: "Settle" }), msg(d1, "D1 — hmm, not sure anymore")],
  (b, out) => rules(b.d1!, "F3", "settle") && flagged(b.d1!) && sup(b.d1!)[0]!.state === "unread"
    && supersededFindings(out).has("F3") && supersededFindings(out).has("F7") && awaitingReading(out).length === 1);
run("P4.1: ...read as unclear — the click still stands, flagged, and it waits on you", () => {
  const P = page(d1, { option: "Settle" }), M = msg(d1, "D1 — hmm");
  return [P, M, reading(M, [], [{ decision: "d1", option: "No" }], { unclear: "not an answer to anything" })];
}, (b, out) => rules(b.d1!, "F3", "settle") && sup(b.d1!)[0]!.state === "unclear" && waits(out, "d1", /could not tell/));
run("P4.1: ...read two ways — flagged, and in dispute", () => {
  const P = page(d1, { option: "Settle" }), M = msg(d1, "D1 — hmm");
  return [P, M, reading(M, [{ decision: "d1", option: "No" }], [{ decision: "d1", option: "Settle" }])];
}, (b, out) => rules(b.d1!, "F3", "settle") && sup(b.d1!)[0]!.state === "disputed" && readingsInDispute(out).length === 1);
run("P4.1: ...bound to another option — it rules, and the flag clears", () => {
  const P = page(d1, { option: "Settle" }), M = msg(d1, "D1 — no");
  return [P, M, reading(M, [{ decision: "d1", option: "No" }])];
}, (b, out) => standing(b.d1!)!.options[0] === "No" && !flagged(b.d1!) && !supersededFindings(out).size);
run("A3: a later verified answer clears the flag; the moot words wait on nobody", () => {
  const P = page(d1, { option: "Settle" }), M = msg(d1, "D1 — hmm");
  return [P, M, page(d1, { option: "No" }), ...others()];
}, (b, out) => standing(b.d1!)!.options[0] === "No" && !flagged(b.d1!) && !awaitingReading(out).length && !waits(out, "d1"));
run("S0.8(a): the flag reaches a finding the ruling released — marked, never held", () => [page(d4, { option: "B" }), msg(d4, "D4 hmm, maybe not")],
  (b, out) => !held(out, "F30") && supersededFindings(out).has("F30"));

// --- confirm-this-reading: a posted decision (the impl-2 discussion; P2.1 (1), (2); P3.1–P3.5)

/** A confirm of answer `a` on `d`, posted as `confirm_reading` posts it. */
const confirmOf = (b: B, d: string, a: string, readings: Mapping[][], ref = "D9", id = "c1", edit = (p: any) => p) => {
  const byId = new Map(Object.values(b).map((x) => [x.id, x]));
  const payload = edit(confirmPayload(byId, b[d]!, b[d]!.answers.find((x) => x.id === a)!, readings, ref));
  return ev("decision.confirm.posted", { round: b[d]!.round, decision: { id, round: b[d]!.round, ref, kind: "options", payload, options: payload.options.map((o: any) => ({ label: o.label, effects: [] })), confirms: { answer: a, readings } } });
};
/** Two passes: fold to learn the answer ids, then post the confirm and, unless `value` is
 *  undefined, answer it through a logged call. */
const withConfirm = (name: string, base: () => any[], d: string, maps: Mapping[][] | null, value: string | undefined, check: (b: B, out: SharedDecisions) => boolean, pick = (b: B) => b[d]!.answers.at(-1)!.id) => test(name, () => {
  n = 1;
  const evs = base();
  const first = fold(evs);
  const a = pick(first.b), x = first.b[d]!.answers.find((y) => y.id === a)!;
  const C = confirmOf(first.b, d, a, maps ?? [x.reading!.reader.maps, x.reading!.session.maps]);
  const { out, b } = fold([...evs, C, ...(value === undefined ? [] : call(C.data.decision, value))]);
  assert.ok(check(b, out), dump(b, out));
});
const clicked = () => [page(d1, { option: "Settle" }), msg(d1, "D1 actually leave it")];
const leave: Mapping[][] = [[{ decision: "d1", option: "No" }]];

withConfirm("S0.1: Yes on the agent's own reading of unread words binds it — at the time TYPED — and the confirm releases its hold", clicked, "d1", leave, CONFIRM_YES,
  (b, out) => standing(b.d1!)!.options[0] === "No" && standing(b.d1!)!.givenAt === at(3) && !!standing(b.d1!)!.confirmed && !flagged(b.d1!) && !held(out, "F3", "ruled")
    && !(heldFindings(out, () => true).get("F3") ?? []).some((h) => h.decision === "c1") && !waits(out, "c1"));
withConfirm("S0.2: No — the rejected reading is recorded, the old ruling stands, flagged, and you are asked to answer again", clicked, "d1", leave, CONFIRM_NO,
  (b, out) => rules(b.d1!, "F3", "settle") && flagged(b.d1!) && sup(b.d1!)[0]!.rejected?.length === 1 && waits(out, "d1", /not what you meant/));
withConfirm("the discussion: Other on a confirm is words on the confirm, read by a reader like any reply — it binds nothing about the original words", clicked, "d1", leave, "I meant fix F7 only",
  (b, out) => rules(b.d1!, "F3", "settle") && flagged(b.d1!) && b.c1!.answers.some((a) => a.words === "I meant fix F7 only" && a.free)
    && awaitingReading(out).some((u) => u.decision === "c1" && u.words === "I meant fix F7 only") && !standing(b.d1!)!.confirmed);
withConfirm("S0.2: a dispute's confirm offers both readings; picking one binds it", () => {
  const P = page(d1, { option: "Settle" }), M = msg(d1, "D1 — hmm");
  return [P, M, reading(M, [{ decision: "d1", option: "No" }], [{ decision: "d1", option: "Settle" }])];
}, "d1", null, "Reading 1",
  (b, out) => standing(b.d1!)!.options[0] === "No" && !readingsInDispute(out).length, (b) => b.d1!.answers.find((a) => a.via === "message")!.id);
withConfirm("the discussion: while open, the confirm holds the findings its reading acts on — from its own posting — and waits on you", clicked, "d1", leave, undefined,
  (b, out) => (heldFindings(out, () => true).get("F3") ?? []).some((h) => h.decision === "c1" && h.why === "undecided" && h.since === b.c1!.postedAt)
    && b.c1!.postedAt !== round.at && waits(out, "c1", /confirm what your words on D1 meant/) && !waits(out, "c1", /not answered/));
test("A confirmed action must match its complete frozen presentation", () => {
  n = 1;
  const evs = clicked(), first = fold(evs), a = first.b.d1!.answers.at(-1)!.id;
  const reworded = confirmOf(first.b, "d1", a, leave, "D9", "c1", (p) => ({ ...p, question: p.question.replace("is that what you meant?", "did you mean this?") }));
  let r = fold([...evs, reworded, ...call(reworded.data.decision, CONFIRM_YES)]);
  assert.ok(rules(r.b.d1!, "F3", "settle") && !!r.b.c1!.confirms!.invalid, dump(r.b, r.out));
  for (const forge of [
    (p: any) => ({ ...p, question: p.question.replace("D1 → No", "D1 → Settle") }),
    (p: any) => ({ ...p, question: p.question.replace("releases F3, F7", "settles F3, F7 as refuted") }),
    (p: any) => ({ ...p, options: p.options.map((o: any, i: number) => i ? o : { ...o, description: "Bind a different action" }) }),
    (p: any) => ({ ...p, question: p.question.replace(/\nD1 → .*/, "") }),
    (p: any) => ({ ...p, question: p.question.replace(/F3/g, "Fx") }),
  ]) {
    const C = confirmOf(first.b, "d1", a, leave, "D9", "c1", forge);
    r = fold([...evs, C, ...call(C.data.decision, CONFIRM_YES)]);
    assert.ok(rules(r.b.d1!, "F3", "settle") && !!r.b.c1 && !!r.b.c1.confirms!.invalid, dump(r.b, r.out));
    const open = fold([...evs, C]);
    assert.ok(waits(open.out, "c1", /not a confirm codemap can verify/) && !(heldFindings(open.out, () => true).get("F3") ?? []).some((h) => h.decision === "c1"), dump(open.b, open.out));
  }
});
test("P3.2: the latest-given pick across every confirm of the words decides — in either recording order", () => {
  n = 1;
  const evs = clicked(), first = fold(evs), a = first.b.d1!.answers.at(-1)!.id;
  const C1 = confirmOf(first.b, "d1", a, leave, "D9", "c1"), C2 = confirmOf(first.b, "d1", a, leave, "D10", "c2");
  const yes = call(C1.data.decision, CONFIRM_YES, { answeredAt: "2026-09-23T00:01:00Z" });
  const no = call(C2.data.decision, CONFIRM_NO, { answeredAt: "2026-09-23T00:02:00Z", toolUseId: "tu-later" });
  for (const order of [[...yes, ...no], [...no, ...yes]]) {
    const { b, out } = fold([...evs, C1, C2, ...order]);
    assert.ok(rules(b.d1!, "F3", "settle") && flagged(b.d1!) && !standing(b.d1!)!.confirmed, dump(b, out));
  }
  const again = call(C1.data.decision, CONFIRM_YES, { answeredAt: "2026-09-23T00:03:00Z", toolUseId: "tu-last" });
  const { b } = fold([...evs, C1, C2, ...no, ...again]);
  assert.ok(standing(b.d1!)!.options[0] === "No", "a later Yes replaces the No");
});
withConfirm("R12 (P2.1 (2)): an option with no effect says which findings it releases", () => [page(d1, { option: "Settle" }), msg(d1, "skip it")], "d1", leave, undefined,
  (b) => /^D1 → No \(releases F3, F7\)$/m.test(b.c1!.payload.question));
test("R12: a bulk line names every item it approves, with its effects; (none) says what stays held", () => {
  n = 1;
  const evs = [msg(d1, "rename separately, the rest fine, nothing on D1")], first = fold(evs), a = first.b.d1!.answers[0]!.id;
  const C = confirmOf(first.b, "d1", a, [[{ decision: "d2", option: "Rename fix" }, { decision: "d1", option: null }]]);
  const q = C.data.decision.payload.question as string;
  assert.match(q, /^D2 → Rename fix \(checked, ruled on separately: Rename fix; F10 stay held; approves Path fix \(unblocks F11\)\)$/m, q);
  assert.match(q, /^D1 → \(none\) \(rules nothing on D1; F3, F7 stay held\)$/m, q);
  const { b } = fold([...evs, C]);
  assert.ok(!b.c1!.confirms!.invalid, String(b.c1!.confirms!.invalid));
  const omit = confirmOf(first.b, "d1", a, [[{ decision: "d2", option: "Rename fix" }, { decision: "d1", option: null }]], "D9", "c1", (p) => ({ ...p, question: p.question.replace("(unblocks F11)", "") }));
  assert.match(String(fold([...evs, omit]).b.c1!.confirms!.invalid), /displayed action differs/);
});
test("P3.3: once the words are moot, an open confirm stops holding and waiting, and is listed as no longer needed", () => {
  n = 1;
  const evs = [...clicked(), ...others()], first = fold(evs), a = first.b.d1!.answers.at(-1)!.id;
  const C = confirmOf(first.b, "d1", a, leave);
  const later = page(d1, { option: "Settle" });   // a later click outranks the words
  const { b, out } = fold([...evs, C, later]);
  const byId = new Map(out.decisions.map((d) => [d.id, d]));
  assert.equal(confirmState(byId, b.c1!), "no longer needed");
  assert.ok(!waits(out, "c1") && !(heldFindings(out, () => true).get("F3") ?? []).some((h) => h.decision === "c1") && !!b.c1, dump(b, out));
});
// --- Q1.3 (owner, "The request only"): a confirm's state describes the request

const stateOf = (out: SharedDecisions, id: string) => confirmState(new Map(out.decisions.map((d) => [d.id, d])), out.decisions.find((d) => d.id === id)!);
test("Q1.3 (F9): a late Yes on a confirm no longer needed answers it, binds, and changes no standing answer", () => {
  n = 1;
  const evs = [...clicked(), ...others()], first = fold(evs), a = first.b.d1!.answers.at(-1)!.id;
  const C = confirmOf(first.b, "d1", a, leave), later = page(d1, { option: "Settle" }), yes = call(C.data.decision, CONFIRM_YES);
  const { b, out } = fold([...evs, C, later, ...yes]);
  assert.ok(stateOf(out, "c1") === "answered" && standing(b.d1!)!.options[0] === "Settle" && !!b.d1!.answers.find((x) => x.id === a)!.confirmed && !waits(out, "c1"), dump(b, out));
});
test("Q1.3 (A3, F10): words typed on a confirm after a No never reopen it — read as nothing on it, it stays answered and holds nothing", () => {
  n = 1;
  const evs = clicked(), first = fold(evs), a = first.b.d1!.answers.at(-1)!.id;
  const C = confirmOf(first.b, "d1", a, leave), no = call(C.data.decision, CONFIRM_NO);
  const other = page(C.data.decision, { words: "nothing" });
  const mid = fold([...evs, C, ...no, other]), w = mid.b.c1!.answers.find((x) => x.free)!;
  const R = reading(w, [{ decision: "c1", option: null }]);
  for (const order of [[...evs, C, ...no, other, R], [...evs, C, other, R, ...no]]) {
    const { b, out } = fold(order);
    assert.ok(standing(b.c1!)!.nothing && stateOf(out, "c1") === "answered" && !(heldFindings(out, () => true).get("F3") ?? []).some((h) => h.decision === "c1")
      && !waits(out, "c1") && waits(out, "d1", /not what you meant/), dump(b, out));
  }
});
both("Q1.3 (A2, F5/F7): a confirm no longer needed still sends its own typed words to a reader while they could change something", () => {
  n = 1;
  const evs = clicked(), first = fold(evs), a = first.b.d1!.answers.at(-1)!.id;
  // D4 answered between the original words and the reply: the original words become moot, the reply does not.
  const C = confirmOf(first.b, "d1", a, leave), d4B = page(d4, { option: "B" }), other = call(C.data.decision, "Actually A on D4"), later = page(d1, { option: "Settle" });
  const O = others().slice(0, 2);
  return { first: [...evs, C, d4B, ...other, later, ...O], second: [...evs, C, later, ...O, d4B, ...other] };
}, (b, out) => stateOf(out, "c1") === "no longer needed" && awaitingReading(out).some((u) => u.decision === "c1" && u.words === "Actually A on D4") && !waits(out, "c1", /confirm what/));
test("Q2.3 (4) (A4, F13): a confirm of words never recorded is not one codemap can verify — it waits on you and binds nothing; a cut target is no longer needed", () => {
  n = 1;
  const evs = clicked(), first = fold(evs), a = first.b.d1!.answers.at(-1)!.id;
  const C = confirmOf(first.b, "d1", a, leave);
  C.data.decision.confirms.answer = "never-existed";
  const { b, out } = fold([...evs, C]);
  assert.ok(stateOf(out, "c1") === "unverifiable" && b.c1!.confirms!.never && waitingOnMe(out, "2026-09-23").filter((w) => w.decision === "c1").length === 1, dump(b, out));
});
test("Q2.3 (2) (C1): an open confirm offering 'D1 → (none)' holds D1's findings, from its own posting", () => {
  n = 1;
  const evs = clicked(), first = fold(evs), a = first.b.d1!.answers.at(-1)!.id;
  const C = confirmOf(first.b, "d1", a, [[{ decision: "d1", option: null }]]);
  const { b, out } = fold([...evs, C]);
  assert.ok(stateOf(out, "c1") === "open" && ["F3", "F7"].every((f) => (heldFindings(out, () => true).get(f) ?? []).some((h) => h.decision === "c1" && h.why === "undecided" && h.since === b.c1!.postedAt)), dump(b, out));
});
test("Q2.3 (1) (F6): one reading given in two orders is one confirm text", () => {
  n = 1;
  const evs = [msg(d1, "no on D1, A on D4")], { b } = fold(evs), a = b.d1!.answers[0]!;
  const m: Mapping[] = [{ decision: "d1", option: "No" }, { decision: "d4", option: "A" }];
  assert.equal(confirmPayload(folded, b.d1!, a, [m], "D9").question, confirmPayload(folded, b.d1!, a, [[...m].reverse()], "D9").question);
});
test("Q2.3 (3) (A5): a posted confirm that fails the check every posted question passes is dropped, like a malformed question in a round", () => {
  n = 1;
  const evs = clicked(), first = fold(evs), a = first.b.d1!.answers.at(-1)!.id;
  const C = confirmOf(first.b, "d1", a, leave, "D9", "c1", (p) => ({ ...p, question: p.question.replace(/^D9:/, "Confirm:") }));
  const { b, out } = fold([...evs, C]);
  assert.ok(!b.c1 && !waitingOnMe(out, "2026-09-23").some((w) => w.decision === "c1"), dump(b, out));
});
test("a confirm is never replaced: a posting that names one as replaced is kept, and replaces nothing", () => {
  n = 1;
  const evs = clicked(), first = fold(evs), a = first.b.d1!.answers.at(-1)!.id;
  const C = confirmOf(first.b, "d1", a, leave);
  const R = post("RX", [{ ...D("dx", "D1", q("D1: close F3?", ["A", "B"]), [{ label: "A", effects: [settle("F3")] }, { label: "B", effects: [] }]), round: "RX", supersedes: "c1" }]);
  const { b } = fold([...evs, C, R]);
  assert.ok(!b.c1!.replacedBy && !!b.dx && !b.dx.supersedes && waits(fold([...evs, C, R]).out, "c1", /confirm what/));
});
test("R8: an agent's ad hoc question that merely starts like the old confirm binds nothing", () => {
  n = 1;
  const M = msg(d1, "hmm"), first = fold([M]);
  const qq = q(`Confirm reading of answer ${M.id} whatever`, ["Settle", "Skip"]);
  const { b } = fold([M, logQ([qq], { [qq.question]: "Settle" })]);
  assert.deepEqual(b.d1!.answers.map((x) => x.id), [first.b.d1!.answers[0]!.id]);
});
run("R9: a posted question that starts with the old confirm's prefix is answered like any other", () => {
  const dp = D("dp", "D8", q("Confirm reading of answer zzz D8: close F40?", ["A", "B"]), [{ label: "A", effects: [settle("F40")] }, { label: "B", effects: [] }], { round: "RP" });
  return [post("RP", [dp]), ...call(dp, "A", { round: "RP" })];
}, (b) => b.dp!.answers.length === 1 && rules(b.dp!, "F40", "settle"));
test("R10 + R11: two confirms answered in one call — two Yes give two answers with their own ids; two Others give one free answer on each", () => {
  n = 1;
  const evs = [msg(d1, "D4 A", "u1"), msg(d3, "D4 A too", "u2")];
  const first = fold(evs), [a1, a3] = [first.b.d1!.answers[0]!.id, first.b.d3!.answers[0]!.id];
  const onD4: Mapping[][] = [[{ decision: "d4", option: "A" }]];
  const C1 = confirmOf(first.b, "d1", a1, onD4, "D9", "c1"), C2 = confirmOf(first.b, "d3", a3, onD4, "D10", "c2");
  const [p1, p2] = [C1.data.decision.payload, C2.data.decision.payload];
  const both = (v1: string, v2: string) => {
    const L = logQ([p1, p2], { [p1.question]: v1, [p2.question]: v2 });
    return [L, answer(C1.data.decision, { kind: "question", question: L.id }), answer(C2.data.decision, { kind: "question", question: L.id })];
  };
  let r = fold([...evs, C1, C2, ...both(CONFIRM_YES, CONFIRM_YES)]);
  const ids = r.b.d4!.answers.map((x) => x.id);
  assert.ok(ids.length === 2 && new Set(ids).size === 2 && ids.every((id) => /^e\d+\/d4$/.test(id)), dump(r.b, r.out));
  r = fold([...evs, C1, C2, ...both("mine", "also mine")]);
  assert.ok(r.b.c1!.answers.some((x) => x.free && x.words === "mine") && r.b.c2!.answers.some((x) => x.free && x.words === "also mine"), dump(r.b, r.out));
});
test("(a) Step 2: a reading onto a confirm posted after the words were typed cannot bind — the confirm is not even offered", () => {
  n = 1;
  const evs = clicked(), first = fold(evs), a = first.b.d1!.answers.at(-1)!.id;
  const M2 = msg(d4, "and yes to that", "u9", at(2));   // typed before the confirm was posted
  const C = confirmOf(first.b, "d1", a, leave);
  const { out } = fold([...evs, C, M2]);
  const byId = new Map(out.decisions.map((d) => [d.id, d])), d = byId.get("d4")!, w = d.answers[0]!;
  const why = readingRefusal(byId, d, w, { verdict: [{ decision: "c1", option: CONFIRM_YES }], session: [{ decision: "c1", option: CONFIRM_YES }], launchedAt: at(59), brief: readerBrief(byId, d, w) });
  assert.match(String(why), /D9 was posted after the words were typed/);
  assert.ok(!readerBrief(byId, d, w).includes("D9:"), "the brief does not list it");
});
both("(c) a pick and a reading of the same words, recorded in either order, give one result: the pick decides", () => {
  n = 1;
  const base = clicked();
  const first = fold(base), a = first.b.d1!.answers.at(-1)!;
  const C = confirmOf(first.b, "d1", a.id, leave);
  const M = base[1];
  const R = reading(M, [{ decision: "d1", option: "Settle" }], [{ decision: "d1", option: "No" }]);
  const Y = call(C.data.decision, CONFIRM_YES);
  return { first: [...base, C, ...Y, R], second: [...base, R, C, ...Y] };
}, (b) => standing(b.d1!)!.options[0] === "No" && !!standing(b.d1!)!.confirmed);
test("Q2.1 (reverses the fold half of P2.1 (4)): a confirm naming a ref two confirms share is judged as posted — only confirm_reading checks it", () => {
  n = 1;
  const evs = clicked(), first = fold(evs), a = first.b.d1!.answers.at(-1)!.id;
  // Two clones each confirm the same words at once, and both take D9.
  const C1 = confirmOf(first.b, "d1", a, leave, "D9", "c1"), C2 = confirmOf(first.b, "d1", a, [[{ decision: "d1", option: "Settle" }]], "D9", "c2");
  const M = msg(d4, "yes to D9", "u7");
  const second = fold([...evs, C1, C2, M]);
  const C3 = confirmOf(second.b, "d4", second.b.d4!.answers[0]!.id, [[{ decision: "c1", option: CONFIRM_YES }]], "D11", "c3");
  const { b } = fold([...evs, C1, C2, M, C3]);
  assert.equal(b.c3!.confirms!.invalid, undefined);
});
/** Q2.1's pull case (premises P2): D2 answered B; words on D1 read "A on D2"; a confirm; Yes. */
const pullCase = () => {
  const old = page(d4, { option: "B" }), W = msg(d1, "A on D4"), first = fold([old, W]);
  const C = confirmOf(first.b, "d1", W.id, [[{ decision: "d4", option: "A" }]], "D9", "c1");
  return { old, W, C, yes: call(C.data.decision, CONFIRM_YES) };
};
test("Q2.1: a later pull bringing a second question numbered like one a confirm names never undoes the Yes already given", () => {
  n = 1;
  const { old, W, C, yes } = pullCase();
  // Another clone's confirm, pulled later, that also took the ref D4.
  const pulled = structuredClone(C);
  pulled.data.decision = { ...pulled.data.decision, id: "c2", ref: "D4", payload: { ...pulled.data.decision.payload, question: pulled.data.decision.payload.question.replace(/^D9:/, "D4:") } };
  for (const evs of [[old, W, C, ...yes], [old, W, C, pulled, ...yes], [old, W, C, ...yes, pulled]]) {
    const { b, out } = fold(evs);
    assert.ok(standing(b.d4!)!.options[0] === "A" && stateOf(out, "c1") === "answered" && !b.c1!.confirms!.invalid, dump(b, out));
  }
});
/** Codex F7: D1 and a second D1 in one round; words on D2 read as "D1 → A". */
const sharedRefCase = () => {
  const dx = D("dx", "D1", q("D1: a second question about F40?", ["A", "B"]), [{ label: "A", effects: [settle("F40")] }, { label: "B", effects: [] }], { round: "RS" });
  const d1s = { ...d1, id: "d1s", round: "RS" }, d2s = { ...d4, id: "d4s", round: "RS" };
  return { dx, d1s, d2s };
};
test("Q2.1 (D1, Codex F7): a reading naming a ref the reader's brief showed as shared is refused by the fold, as by the op", () => {
  n = 1;
  const { dx, d1s, d2s } = sharedRefCase();
  const R = post("RS", [d1s, dx, d2s]), old = page(d1s, { option: "No" }), W = msg(d2s, "A on D1", "u1");
  W.data.via.round = "RS";
  const RD = reading(W, [{ decision: "d1s", option: "Settle" }]);
  const { b, out } = fold([R, old, W, RD]);
  assert.ok(!b.d4s!.answers[0]!.reading && standing(b.d1s!)!.options[0] === "No" && awaitingReading(out).some((u) => u.answer === W.id), dump(b, out));
});
test("Q2.1 (control): a reading accepted before a pull brought a same-numbered question stays accepted", () => {
  n = 1;
  // Another clone's confirm numbered D4, posted BEFORE the words — so readable — and pulled after the reading.
  const W0 = msg(d1, "hmm", "u0"), C = confirmOf(fold([W0]).b, "d1", W0.id, [[{ decision: "d1", option: "No" }]], "D4", "c9");
  const old = page(d4, { option: "B" }), W = msg(d1, "A on D4", "u1"), RD = reading(W, [{ decision: "d4", option: "A" }]);
  const accepted = fold([W0, old, W, RD]);
  assert.ok(standing(accepted.b.d4!)!.options[0] === "A" && !RD.data.reader.brief.includes("share the ref"));
  const { b, out } = fold([W0, old, W, RD, C]);
  assert.ok(!!b.d1!.answers.find((x) => x.id === W.id)!.reading && standing(b.d4!)!.options[0] === "A", dump(b, out));
});

// --- carrying out is the finding record's to answer

run("ruled, not carried out: listed while the finding is open, gone once it closes", () => [page(d1, { option: "Settle" })], (b, out) => {
  const open = ruledNotCarriedOut(out, () => true);
  const closed = ruledNotCarriedOut(out, (f) => f !== "F3");
  return open.some((u) => u.finding === "F3" && u.on === "settle" && u.ruler === "izzie") && open.some((u) => u.finding === "F7" && u.on === "unblock")
    && !closed.some((u) => u.finding === "F3");
});

// --- bulk: checked = rule separately, the rest approved

run("bulk: 'None — approve all' rules every item", () => call(d2, ["None — approve all"]),
  (b, out) => rules(b.d2!, "F10", "settle") && rules(b.d2!, "F11", "unblock") && !waits(out, "d2"));
run("bulk: a checked item is ruled on separately and waits until it is asked; the rest are approved", () => call(d2, ["Rename fix"]),
  (b, out) => !rules(b.d2!, "F10", "settle") && rules(b.d2!, "F11", "unblock") && held(out, "F10", "undecided") && waits(out, "d2", /Rename fix/));
run("bulk: the separate question, once posted, stops the wait", () => {
  const [L, A] = call(d2, ["Rename fix"]);
  const nd = { ...D("d9", "D9", q("D9: Rename fix — settle F10?", ["Yes", "No"]), [{ label: "Yes", effects: [settle("F10")] }, { label: "No", effects: [] }]), round: "R2", origin: { answer: A.id } };
  return [L, A, post("R2", [nd])];
}, (b, out) => !waits(out, "d2") && waits(out, "d9", /not answered/));
run("bulk: approve-all beside a checked item says two things, so it is read, not guessed", () => call(d2, ["Rename fix", "None — approve all"]),
  (b, out) => !ruled(b.d2!).length && awaitingReading(out).some((u) => u.decision === "d2"));
run("bulk: a typed Other element makes the whole answer the reader's", () => call(d2, ["Path fix", "and talk to me about the tag"]),
  (b, out) => !ruled(b.d2!).length && awaitingReading(out).some((u) => u.decision === "d2"));
run("bulk: unverified words wait for a reader, whether or not the relayer is known (B2)", () => [answer(d2, { kind: "unverified", words: "all fine" })],
  (b, out) => !ruled(b.d2!).length && awaitingReading(out).length === 1);
run("bulk: the page's checked list is a direct answer", () => [page(d2, { checked: ["Path fix"] })],
  (b) => rules(b.d2!, "F10", "settle") && !rules(b.d2!, "F11", "unblock") && standing(b.d2!)!.separately?.[0] === "Path fix");
run("bulk: a reading's two lines for one bulk decision check both items", () => {
  const [L, A] = call(d2, "rename and path both need a closer look");
  return [L, A, reading(A, [{ decision: "d2", option: "Rename fix" }, { decision: "d2", option: "Path fix" }])];
}, (b) => standing(b.d2!)!.separately?.length === 2 && !ruled(b.d2!).length);

// --- readings

run("free text waits for its reading, which is an agent's job, not yours", () => call(d1, "yeah probably"),
  (b, out) => !ruled(b.d1!).length && held(out, "F3", "undecided") && awaitingReading(out).some((u) => u.decision === "d1") && !waits(out, "d1"));
run("readings that disagree rule nothing, are in dispute, and wait on you", () => {
  const [L, A] = call(d1, "hmm");
  return [L, A, reading(A, [{ decision: "d1", option: "Settle" }], [{ decision: "d1", option: "No" }])];
}, (b, out) => !ruled(b.d1!).length && readingsInDispute(out).some((x) => x.decision === "d1" && x.reader === "D1 → Settle") && waits(out, "d1", /two different ways/));
run("a later answer clears a dispute", () => {
  const [L, A] = call(d1, "hmm");
  return [L, A, reading(A, [{ decision: "d1", option: "Settle" }], [{ decision: "d1", option: "No" }]), page(d1, { option: "No" }), ...others()];
}, (b, out) => !readingsInDispute(out).length && !waits(out, "d1"));
run("C1: a reading's asks is kept on the answer", () => {
  const [L, A] = call(d1, "Settle, and document them");
  return [L, A, reading(A, [{ decision: "d1", option: "Settle" }], undefined, { asks: "document them" })];
}, (b) => rules(b.d1!, "F3", "settle") && standing(b.d1!)!.reading?.asks === "document them");
run("a read park option parks", () => {
  const [L, A] = call(d3, "park it till mid October");
  return [L, A, reading(A, [{ decision: "d3", option: "Park until 2026-10-15" }])];
}, (b) => standing(b.d3!)!.park === "2026-10-15");
run("unverified words read as a park wait on you", () => {
  const A = unv(d3, "later please");
  return [A, reading(A, [{ decision: "d3", option: "Park until 2026-10-15" }])];
}, (b, out) => standing(b.d3!)!.parkWaits === "2026-10-15" && !standing(b.d3!)!.park && waits(out, "d3", /park/));
run("...and your later answer clears it", () => {
  const A = unv(d3, "later please");
  return [A, reading(A, [{ decision: "d3", option: "Park until 2026-10-15" }]), page(d3, { option: "Park until 2026-10-15" })];
}, (b, out) => standing(b.d3!)!.park === "2026-10-15" && !waits(out, "d3"));
run("B2: a reader launched before the words were typed binds nothing", () => {
  const M = msg(d1, "D1 settle");
  return [M, reading(M, [{ decision: "d1", option: "Settle" }], undefined, { launchedAt: "2026-09-23T00:00:01Z" })];
}, (b) => !standing(b.d1!) && !b.d1!.answers[0]!.reading);
run("S0.8(c): one reader reads one answer — its second reading binds nothing", () => {
  const M1 = msg(d1, "D1 settle", "u1"), M2 = msg(d4, "D4 A", "u2");
  const R1 = reading(M1, [{ decision: "d1", option: "Settle" }]);
  const R2 = reading(M2, [{ decision: "d4", option: "A" }]);
  R2.data.reader.agent = R1.data.reader.agent;
  return [M1, M2, R1, R2];
}, (b) => rules(b.d1!, "F3", "settle") && !standing(b.d4!));
run("R5 (P2.1 (3)): an empty reading consumes nothing — the words still wait for a reader", () => {
  const M = msg(d1, "whatever");
  return [M, reading(M, [], [])];
}, (b, out) => b.d1!.answers[0]!.free && !b.d1!.answers[0]!.elsewhere && !b.d1!.answers[0]!.reading && awaitingReading(out).length === 1);
run("R5: ...and so does an unclear reading whose session side is empty", () => {
  const M = msg(d1, "whatever");
  return [M, reading(M, [], [], { unclear: "no idea" })];
}, (b, out) => !b.d1!.answers[0]!.reading && awaitingReading(out).length === 1);
// --- which readings count (owner, P1.2 "Not used"): only an accepted reading claims a slot

both("R1: a reading the fold rejects does not block the answer's next reader", () => {
  n = 1;
  const R4b = post("R4b", [reask(d4, "d4b", "D8", "R4b", { supersedes: "d4" })]);
  const M = msg(d1, "D1 settle and D4 A");
  // D4 was replaced before the words were typed, so this reading cannot bind.
  const bad = reading(M, [{ decision: "d1", option: "Settle" }, { decision: "d4", option: "A" }]);
  const good = reading(M, [{ decision: "d1", option: "Settle" }]);
  return { first: [R4b, M, bad, good], second: [R4b, M, good, bad] };
}, (b, out) => rules(b.d1!, "F3", "settle") && !!b.d1!.answers[0]!.reading && !awaitingReading(out).length);
both("R1: ...nor does one naming a words decision", () => {
  n = 1;
  const M = msg(d1, "Settle it");
  const bad = reading(M, [{ decision: "d5", option: null }]), good = reading(M, [{ decision: "d1", option: "Settle" }]);
  return { first: [M, bad, good], second: [M, good, bad] };
}, (b) => standing(b.d1!)?.options[0] === "Settle");
test("R2: a reader whose reading was rejected may read another answer", () => {
  for (const rejectedFirst of [true, false]) {
    n = 1;
    const R4b = post("R4b", [reask(d4, "d4b", "D8", "R4b", { supersedes: "d4" })]);
    const M1 = msg(d1, "D4 A please", "u1"), M2 = msg(d3, "now", "u2");
    M1.data.knownReplacements = ["d4b"];
    const bad = reading(M1, [{ decision: "d4", option: "A" }]), good = reading(M2, [{ decision: "d3", option: "Now" }]);
    good.data.reader.agent = bad.data.reader.agent;
    const { b, out } = fold([R4b, M1, M2, ...(rejectedFirst ? [bad, good] : [good, bad])]);
    assert.ok(!!b.d3!.answers[0]!.reading && rules(b.d3!, "F20", "unblock") && !b.d1!.answers[0]!.reading, dump(b, out));
  }
});
run("R2 (F12): a reading of words cut as given after their question was replaced claims nothing — its reader may read another answer", () => {
  const R1b = post("R1b", [reask(d1, "d1b", "D7", "R1b", { supersedes: "d1" })]);
  const cut = msg(d1, "A on D4", "u1");
  cut.data.knownReplacements = ["d1b"];
  const M2 = msg(d4, "B", "u2");
  const r1 = reading(cut, [{ decision: "d4", option: "A" }]), r2 = reading(M2, [{ decision: "d4", option: "B" }]);
  r2.data.reader.agent = r1.data.reader.agent;
  return [R1b, cut, M2, r1, r2];
}, (b) => !b.d1!.answers.length && !!b.d4!.answers.find((a) => a.via === "message" && a.words === "B")?.reading && rules(b.d4!, "F30", "unblock"));
run("Q2.2 (Step 6 part 7, reverses R1's fold half): a bindable verdict claims its slot even when the session side could never bind — disputed, not freed for another reader", () => {
  const M = msg(d1, "hmm");
  return [M, reading(M, [{ decision: "d1", option: "Settle" }], [{ decision: "d5", option: null }])];
}, (b, out) => !!b.d1!.answers[0]!.reading && !b.d1!.answers[0]!.reading!.agree && !awaitingReading(out).length && readingsInDispute(out).length === 1);
run("...but a verdict that could never bind is still refused, and the words wait for another reader", () => {
  const M = msg(d1, "hmm");
  return [M, reading(M, [{ decision: "d5", option: null }], [{ decision: "d1", option: "Settle" }])];
}, (b, out) => !b.d1!.answers[0]!.reading && awaitingReading(out).length === 1);
run("R3: two picks on a single-select question are no reading — the finding stays held, the words wait for a reader", () => {
  const M = msg(d1, "both?");
  return [M, reading(M, [{ decision: "d1", option: "Settle" }, { decision: "d1", option: "No" }])];
}, (b, out) => !standing(b.d1!) && held(out, "F3", "undecided") && awaitingReading(out).some((u) => u.decision === "d1"));
run("R3: ...nor is (none) beside a pick", () => {
  const M = msg(d1, "not that, or maybe settle");
  return [M, reading(M, [{ decision: "d1", option: null }, { decision: "d1", option: "Settle" }])];
}, (b, out) => !standing(b.d1!) && awaitingReading(out).length === 1);
run("R4: a copy onto another question does not inherit '(none)' from the answered one", () => {
  const M = msg(d1, "nothing here, and A on D4");
  return [M, reading(M, [{ decision: "d1", option: null }, { decision: "d4", option: "A" }])];
}, (b, out) => standing(b.d4!)!.nothing === undefined && rules(b.d4!, "F30", "settle") && !waits(out, "d4") && standing(b.d1!)!.nothing === true);

// --- the brief the reader was launched with (P1.4, P3.4): its structure is checked, never its wording

const briefed = (M: any, maps: Mapping[], edit: (b: string) => string) => {
  const R = reading(M, maps);
  const first = fold([M]), byId = new Map(first.out.decisions.map((d) => [d.id, d]));
  const x = first.out.decisions.flatMap((d) => d.answers.map((a) => ({ d, a }))).find(({ a }) => a.id === M.id)!;
  R.data.reader.brief = edit(readerBrief(byId, x.d, x.a));
  return R;
};
run("P3.4: a reading with no brief — written before codemap wrote one — is dropped, and the words go back to unread", () => {
  const M = msg(d1, "D1 settle"); const R = reading(M, [{ decision: "d1", option: "Settle" }]); R.data.reader.brief = null;
  return [M, R];
}, (b, out) => !b.d1!.answers[0]!.reading && awaitingReading(out).length === 1);
run("P3.4: a reworded brief still counts — only its structure is checked", () => {
  const M = msg(d1, "D1 settle");
  return [M, briefed(M, [{ decision: "d1", option: "Settle" }], (b) => b.replace("A person was asked", "Someone was asked"))];
}, (b) => rules(b.d1!, "F3", "settle"));
for (const [name, edit] of [
  ["that misquotes the words", (b: string) => b.replace(JSON.stringify("D1 settle"), JSON.stringify("D1 settle it"))],
  ["that relabels an option", (b: string) => b.replace('["Settle","No"]', '["Settle it","No"]')],
  ["that lists a question the words cannot be read onto", (b: string) => b + '\nD5: "D5: the goal, in your words?"\n  options: ["x","y"]'],
  ["that omits the question the verdict names", (b: string) => b.split("\n").filter((l) => !l.startsWith("D1: ")).join("\n")],
] as const) {
  run(`P3.4: a brief ${name} is not codemap's — the reading binds nothing`, () => {
    const M = msg(d1, "D1 settle");
    return [M, briefed(M, [{ decision: "d1", option: "Settle" }], edit)];
  }, (b, out) => !b.d1!.answers[0]!.reading && awaitingReading(out).length === 1);
}

run("S0.7: a reading in the old shape — the session's copy of the reader's maps — binds nothing", () => {
  const M = msg(d1, "D1 settle");
  return [M, ev("decision.reading.recorded", { answer: M.id, reader: { transcript: "aREADER00000000", reading: "r", maps: [{ decision: "d1", option: "Settle" }], verified: { session: "s", toolUseId: "t" } }, session: { reading: "r", maps: [{ decision: "d1", option: "Settle" }] } })];
}, (b, out) => !standing(b.d1!) && awaitingReading(out).length === 1);

// --- parks

run("a verified park by option label", () => call(d3, "Park until 2026-10-15"),
  (b, out) => standing(b.d3!)!.park === "2026-10-15" && held(out, "F20", "undecided"));
run("a person's park on the page", () => [page(d3, { park: "2026-11-01" })], (b) => standing(b.d3!)!.park === "2026-11-01");
run("a park on an unoffered date is accepted and flagged", () => [page(d3, { park: "2099-12-31" })],
  (b) => standing(b.d3!)!.park === "2099-12-31" && /not one this decision offered/.test(standing(b.d3!)!.flags?.[0] ?? ""));
run("a park on an offered date is not flagged", () => [page(d3, { park: "2026-10-15" })], (b) => !standing(b.d3!)!.flags);
run("a park date already past is flagged", () => [page(d3, { park: "2026-01-01" })],
  (b) => standing(b.d3!)!.flags?.some((f) => /already passed/.test(f)) === true);
run("S0.5: a park given after a click ranks like any verified act — D3 is parked", () => [page(d3, { option: "Now" }), page(d3, { option: "Park until 2026-10-15" })],
  (b, out) => standing(b.d3!)!.park === "2026-10-15" && held(out, "F20", "undecided") && parked(out, "2026-09-23").length === 1);
run("an unverified pick of the park option does not displace your own answer", () => [page(d3, { option: "Now" }), unv(d3, "D3 A")],
  (b, out) => b.d3!.answers.length === 2 && rules(b.d3!, "F20", "unblock") && !standing(b.d3!)!.parkWaits && waits(out, "d3", /arrived after your ruling/));

// --- drops

run("a words decision answered with a letter still records only the words", () => [msg(d5, "D5 A")],
  (b) => standing(b.d5!)!.words === "D5 A" && !standing(b.d5!)!.options.length);
run("DROP: hash mismatch", () => [ev("decision.answer.recorded", { decision: "d1", hash: "d:sha256:bad", via: { kind: "direct", option: "Settle" } }, person)], (b) => !b.d1!.answers.length);
run("DROP: the logged question was paraphrased", () => {
  const L = logQ([{ ...d1.payload, question: "D1: approve that fix?" }], { "D1: approve that fix?": "Settle" });
  return [L, answer(d1, { kind: "question", question: L.id })];
}, (b) => !b.d1!.answers.length);
run("DROP: an option reworded in the logged call", () => {
  const L = logQ([{ ...d1.payload, options: [{ label: "Settle", description: "closes F3 and more" }, { label: "No", description: "d" }] }], { [d1.payload.question]: "Settle" });
  return [L, answer(d1, { kind: "question", question: L.id })];
}, (b) => !b.d1!.answers.length);
run("DROP (H7.12): a logged call with no round or answer time, from a build before either existed", () => {
  const L = logQ([d1.payload], { [d1.payload.question]: "Settle" });
  delete L.data.rounds; delete L.data.bound; delete L.data.answeredAt;
  return [L, answer(d1, { kind: "question", question: L.id })];
}, (b, out) => !b.d1!.answers.length && !out.questions.length);
run("S0.7: a call logged with one `round`, before per-question binding, binds as that round", () => {
  const L = logQ([d1.payload], { [d1.payload.question]: "Settle" });
  delete L.data.rounds; delete L.data.bound; L.data.round = "R1";
  return [L, answer(d1, { kind: "question", question: L.id })];
}, (b) => rules(b.d1!, "F3", "settle"));
run("D4 (P2.4): one call asks two rounds — each question binds in the round it was bound to", () => {
  const r2 = D("x4", "D1", q("D1: close F30 now?", ["A", "B"]), [{ label: "A", effects: [settle("F30")] }, { label: "B", effects: [] }], { round: "R2" });
  const R2 = post("R2", [r2]);
  const L = logQ([d1.payload, r2.payload], { [d1.payload.question]: "Settle", [r2.payload.question]: "A" }, { rounds: ["R1", "R2"], bound: { [d1.payload.question]: "R1", [r2.payload.question]: "R2" } });
  return [R2, L, answer(d1, { kind: "question", question: L.id }), answer(r2, { kind: "question", question: L.id })];
}, (b) => rules(b.d1!, "F3", "settle") && rules(b.x4!, "F30", "settle"));
run("DROP (H7.12): a message with no time", () => { const e = msg(d1, "D1 A"); delete e.data.via.at; return [e]; }, (b) => !b.d1!.answers.length);
run("DROP: a direct answer from an agent", () => [answer(d1, { kind: "direct", option: "Settle" })], (b) => !b.d1!.answers.length);
run("DROP: a reading naming a decision in another round", () => {
  const other = reask(d4, "x4", "D4", "R2");
  const [L, A] = call(d1, "hmm");
  return [post("R2", [other]), L, A, reading(A, [{ decision: "x4", option: "A" }])];
}, (b) => !b.x4!.answers.length && !b.d1!.answers[0]!.reading);
run("DROP: an answer given after a replacement it already knew", () => {
  const r = post("R1b", [reask(d1, "d1b", "D7", "R1b", { supersedes: "d1" })]);
  const a = page(d1, { option: "Settle" }); a.data.knownReplacements = ["d1b"];
  return [r, a];
},
  (b, out) => b.d1!.replacedBy === "d1b" && !b.d1!.answers.length && !waits(out, "d1"));
run("DROP: a second posting of a decision id cannot change it", () => [post("R1c", [{ ...d1, payload: q("D1: something else about F3 and F7?", ["Settle", "No"]), round: "R1c" }])],
  (b) => b.d1!.payload.question === "D1: approve the fix for F3 and F7?");
run("DROP: an answer value that is neither text nor a list of text", () => call(d1, { label: "Settle" }), (b) => !b.d1!.answers.length);
run("free text on a words decision is never read", () => {
  const A = msg(d5, "Ship it, and A for D4");
  return [A, reading(A, [{ decision: "d4", option: "A" }])];
}, (b) => !b.d4!.answers.length);
run("S0.7: an old posting's closesOnAnswer is ignored — the question is kept, and closes nothing", () => {
  const c = { ...D("dc", "D9", q("D9: close F1?", ["A", "B"]), [{ label: "A", effects: [settle("F1")], closesOnAnswer: true }, { label: "B", effects: [] }]), round: "RC" };
  return [post("RC", [c]), page(c, { option: "A" })];
}, (b, out) => !!b.dc && !b.dc.options.some((o: any) => "closesOnAnswer" in o) && rules(b.dc!, "F1", "settle") && held(out, "F1", "ruled"));

// --- times that do not parse (P2.1 (5), R16): each guard stated, none resting on a negated comparison

both("R16: an answer with no time is dropped — the dated one stands in either order", () => {
  n = 1;
  const undated = page(d1, { option: "Settle" }); delete undated.at;
  const dated = page(d1, { option: "No" });
  return { first: [undated, dated], second: [dated, undated] };
}, (b) => b.d1!.answers.length === 1 && standing(b.d1!)!.options[0] === "No");
run("R16: a logged call with a garbage time is kept, and binds nothing", () => call(d1, "Settle", { answeredAt: "garbage" }),
  (b, out) => out.questions.length === 1 && !b.d1!.answers.length);
run("R16: a reading launched at a garbage time is not accepted", () => {
  const M = msg(d1, "D1 settle");
  return [M, reading(M, [{ decision: "d1", option: "Settle" }], undefined, { launchedAt: "garbage" })];
}, (b, out) => !b.d1!.answers[0]!.reading && awaitingReading(out).length === 1);
test("R16: a round with no time keeps its questions; nothing typed binds to them, a page answer does, and its hold's start is unknown", () => {
  n = 1;
  const R = post("RT", [reask(d4, "dt", "D4", "RT")]); delete R.at;
  const dt = reask(d4, "dt", "D4", "RT");
  const M = msg(dt, "D4 A");
  const { b, out } = fold([R, M, reading(M, [{ decision: "dt", option: "A" }])]);
  assert.ok(b.dt && !b.dt.answers.length, dump(b, out));
  const mine = (heldFindings(out, () => true).get("F30") ?? []).filter((x) => x.decision === "dt");
  assert.ok(mine.length === 1 && Number.isNaN(Date.parse(mine[0]!.since)), "held, from a start no assignment can be after");
  const P = fold([R, page(dt, { option: "A" })]);
  assert.ok(rules(P.b.dt!, "F30", "settle"), dump(P.b, P.out));
});

// --- plan A4: given before a replacement, recorded after

both("c3 (A4): answered at :02, replaced at :03, logged at :04 — the answer counts on D1, whatever the fold order, and holds F3 until the replacement rules", () => {
  n = 1;
  const d1b = reask(d1, "d1b", "D7", "R1b", { supersedes: "d1" });
  const L = logQ([d1.payload], { [d1.payload.question]: "Settle" }, { answeredAt: "2026-09-23T00:00:02Z" });
  const R2 = post("R1b", [d1b]); R2.at = "2026-09-23T00:00:03Z";
  const A = answer(d1, { kind: "question", question: L.id }); A.at = "2026-09-23T00:00:04Z";
  return { first: [L, R2, A], second: [L, A, R2] };
}, (b, out) => rules(b.d1!, "F3", "settle") && held(out, "F3", "ruled") && ruledNotCarriedOut(out, () => true).some((u) => u.decision === "d1" && u.replacedBy === "d1b"));
run("A4 (R23): words given before the replacement are still read, onto a question in their round", () => {
  const [L, A] = call(d1, "settle, and A on D4");
  return [L, A, post("R1b", [reask(d1, "d1b", "D7", "R1b", { supersedes: "d1" })]), reading(A, [{ decision: "d1", option: "Settle" }, { decision: "d4", option: "A" }])];
}, (b) => rules(b.d1!, "F3", "settle") && rules(b.d4!, "F30", "settle"));
run("A4 (R23): a reading onto a question replaced before the words were typed binds nothing", () => {
  const R2 = post("R4b", [reask(d4, "d4b", "D8", "R4b", { supersedes: "d4" })]);
  const [L, A] = call(d1, "settle, and A on D4");
  A.data.knownReplacements = ["d4b"];
  return [R2, L, A, reading(A, [{ decision: "d1", option: "Settle" }, { decision: "d4", option: "A" }])];
}, (b) => !b.d1!.answers[0]!.reading && !b.d4!.answers.length);

// --- what posting refuses (the fold drops exactly what the ops refuse)

test("posting refuses what the rulings forbid, and accepts the same decision without the fault", () => {
  const good = D("dx", "D9", q("D9: is F1 real?", ["A", "B"]), [{ label: "A", effects: [settle("F1")] }, { label: "B", effects: [] }]);
  const refused = (d: any) => checkDecision(d);
  assert.equal(refused(good), null, "the positive every refusal below varies");
  assert.match(refused({ ...good, options: [{ label: "A", effects: [{ findings: ["F1"], on: "settle" }] }, good.options[1]] })!, /must say how it closes/);
  assert.match(refused({ ...good, options: [{ label: "A", effects: [{ findings: ["F1"], on: "settle", as: "accepted" }] }, good.options[1]] })!, /must say how it closes/);
  assert.match(refused({ ...good, options: [{ label: "A", effects: [{ findings: ["F1"], on: "unblock", as: "refuted" }] }, good.options[1]] })!, /takes no `as`/);
  assert.match(refused({ ...good, options: [{ label: "A", effects: [settle()] }, good.options[1]] })!, /needs findings/);
  const multiPark = D("dp", "D8", q("D8: park?", ["Park until 2026-10-15", "Now"], true), [{ label: "Park until 2026-10-15", effects: [], park: "2026-10-15" }, { label: "Now", effects: [] }]);
  assert.equal(refused({ ...multiPark, payload: { ...multiPark.payload, multiSelect: false } }), null);
  assert.match(refused(multiPark)!, /multi-select question cannot offer a park/);
  assert.match(refused({ ...good, options: [{ ...good.options[0], park: "2026-10-15" }, good.options[1]] })!, /without its date/);
  assert.equal(refused(d2), null);
  assert.match(refused({ ...d2, payload: { ...d2.payload, multiSelect: false } })!, /bulk decision is a multi-select/);
  assert.match(refused({ ...d2, options: d2.options.map((o: any) => ({ ...o, approveAll: undefined })) })!, /exactly one approve-all/);
  assert.match(refused({ ...good, options: [{ ...good.options[0] }, { ...good.options[1], approveAll: true }] })!, /only a bulk decision/);
  assert.match(refused({ ...d5, options: [{ label: "x", effects: [settle("F1")] }, { label: "y", effects: [] }] })!, /words decision has no effects/);
  // H5: what the person is shown names what it acts on.
  assert.match(refused({ ...good, payload: { ...good.payload, question: "is F1 real?" } })!, /must name its ref D9/);
  assert.match(refused({ ...good, payload: { ...good.payload, question: "D90: is F1 real?" } })!, /must name its ref D9/, "D90 is not D9");
  assert.match(refused({ ...good, payload: { ...good.payload, question: "D9: is it real?" } })!, /must name F1/);
  assert.match(checkDecision(D("dl", "D9", q("D9: is F1 real?", ["A", "A"]), [{ label: "A", effects: [settle("F1")] }, { label: "A", effects: [] }]))!, /share a label/);
});

test("garbage events are dropped, never thrown on", () => {
  n = 1;
  const junk: any[] = [
    ev("decision.round.posted", { round: { id: "RX", source: "x" }, decisions: [null, "str", { id: "dx", round: "RX", ref: "D1", kind: "options", payload: { question: "q", options: [null] }, options: [{ label: "a" }] },
      { id: "dy", round: "RX", ref: "D2", kind: "options", payload: { question: "q", options: [{ label: "a" }] }, options: [{ label: "a" }] },
      { id: "dz", round: "RX", ref: "D3", kind: "options", payload: { question: "q", options: [{ label: "a" }] }, options: [{ label: "a", effects: [null] }] },
      { id: "dw", round: "RX", ref: [], kind: "options", payload: { question: "q", options: [{ label: "a" }] }, options: [{ label: "a", effects: [] }] }] }),
    ev("decision.round.posted", null),
    ev("decision.round.posted", { round: "R", decisions: [] }),
    ev("decision.question.logged", { session: "s", toolUseId: "t", questions: [null, 3], answers: {}, rounds: ["R1"], answeredAt: at(9) }),
    ev("decision.question.logged", { session: "s", toolUseId: "t2", questions: [], answers: [], rounds: ["R1"], answeredAt: at(9) }),
    ev("decision.question.logged", { session: "s", toolUseId: "t3", questions: [{ question: "Confirm reading of answer nope (D1, round R1). x", options: [{ label: "Yes" }] }], answers: { "Confirm reading of answer nope (D1, round R1). x": "Yes" }, rounds: ["R1"], answeredAt: at(9) }),
    ev("decision.answer.recorded", { decision: "d1", hash: h(d1), via: null }),
    ev("decision.answer.recorded", { decision: "d2", hash: h(d2), via: { kind: "direct", checked: "x" } }, person),
    ev("decision.answer.recorded", { decision: "d3", hash: h(d3), via: { kind: "direct", park: 5 } }, person),
    ev("decision.answer.recorded", { decision: "d1", hash: h(d1), via: { kind: "message", session: "s", entryId: "u", text: "D1 A", at: "not a time", round: "R1" } }),
    ev("decision.reading.recorded", { answer: "nope", reader: null }),
    ev("decision.reading.recorded", { answer: "nope", reader: { agent: "a1", verdict: "x" } }),
    ev("decision.reading.recorded", null),
  ];
  const out = foldDecisions([round, ...junk]);
  assert.equal(out.decisions.length, 5, "the good round stands; the garbage adds nothing");
  assert.equal(out.questions.length, 1, "only the well-formed confirm call is kept, and it confirms nothing");
  assert.ok(out.decisions.every((d) => !d.answers.length));
});

// --- the hold outlives its question until the question is answered again (B2.4)

const d1b = reask(d1, "d1b", "D7", "R1b", { supersedes: "d1", options: [{ label: "Settle", effects: [settle("F3"), unblock("F7")] }, { label: "No", effects: [unblock("F3")] }] });
const replaced = (out: SharedDecisions, f: string) => ruledNotCarriedOut(out, () => true).some((u) => u.decision === "d1" && u.finding === f && u.replacedBy === "d1b");
run("B2.4: a ruling on a question since replaced holds, and is listed replaced, until the replacement is answered", () =>
  [page(d1, { option: "Settle" }), post("R1b", [d1b])],
  (b, out) => held(out, "F3", "ruled") && replaced(out, "F3") && !waits(out, "d1") && waits(out, "d1b", /not answered/));
run("...and the replacement's answer decides: 'No' releases F3 as fix work", () =>
  [page(d1, { option: "Settle" }), post("R1b", [d1b]), page(d1b, { option: "No" })],
  (b, out) => !held(out, "F3", "ruled") && !replaced(out, "F3") && rules(b.d1b!, "F3", "unblock"));
run("a settled finding that has since closed is held by nothing", () => [page(d1, { option: "Settle" })],
  (b, out) => held(out, "F3", "ruled") && !held(out, "F3", undefined, (f) => f !== "F3"));
const dS = D("dS", "D8", q("D8: are F1 and F2 real?", ["Not defects", "Real"]), [{ label: "Not defects", effects: [settle("F1", "F2")] }, { label: "Real", effects: [unblock("F1", "F2")] }]);
const dSb = { ...D("dSb", "D1", q("D1: is F1 real?", ["Not a defect", "Real, fix F1"]), [{ label: "Not a defect", effects: [settle("F1")] }, { label: "Real, fix F1", effects: [unblock("F1")] }]), round: "R2", supersedes: "dS" };
run("H4: a replacement takes over only the findings it names", () =>
  [post("RS", [{ ...dS, round: "RS" }]), page({ ...dS, round: "RS" }, { option: "Not defects" }), post("R2", [dSb]), page(dSb, { option: "Real, fix F1" })],
  (b, out) => !held(out, "F1", "ruled") && held(out, "F2", "ruled") && ruledNotCarriedOut(out, () => true).some((u) => u.decision === "dS" && u.finding === "F2" && u.replacedBy === "dSb"));
run("H6.2: an unverified answer on the replacement leaves your verified ruling standing, and waits for you", () => {
  const P = page(d1, { option: "Settle" }), R = post("R1b", [d1b]), A = unv(d1b, "no, fix it");
  return [P, R, A, reading(A, [{ decision: "d1b", option: "No" }])];
}, (b, out) => rules(b.d1b!, "F3", "unblock") && held(out, "F3", "ruled") && replaced(out, "F3") && waits(out, "d1b", /arrived after your ruling on D1/));
run("c5 (Q2): a verified COPY's ruling on a replaced question is not taken over by an unverified answer on the replacement", () => {
  const L = logQ([d4.payload], { [d4.payload.question]: "A, and settle D1" });
  const A = answer(d4, { kind: "question", question: L.id });
  const RA = reading(A, [{ decision: "d4", option: "A" }, { decision: "d1", option: "Settle" }]);
  const U = unv(d1b, "real");
  return [L, A, RA, post("R1b", [d1b]), U, reading(U, [{ decision: "d1b", option: "No" }])];
}, (b, out) => held(out, "F3", "ruled") && replaced(out, "F3"));
run("H6.3: the ruling passes down a chain until a later question is answered", () => {
  const d1c = reask(d1b, "d1c", "D9", "R1c", { supersedes: "d1b" });
  return [page(d1, { option: "Settle" }), post("R1b", [d1b]), post("R1c", [d1c])];
}, (b, out) => held(out, "F3", "ruled") && replaced(out, "F3"));
run("...and the later answer takes it over", () => {
  const d1c = reask(d1b, "d1c", "D9", "R1c", { supersedes: "d1b" });
  return [page(d1, { option: "Settle" }), post("R1b", [d1b]), post("R1c", [d1c]), page(d1c, { option: "No" })];
}, (b, out) => !held(out, "F3", "ruled") && !replaced(out, "F3"));
run("H6.4: of two replacements from two clones the first in log order replaces; the second is live and flagged", () =>
  [post("R1b", [d1b]), post("R1x", [reask(d1b, "d1x", "D8", "R1x")])],
  (b, out) => b.d1!.replacedBy === "d1b" && b.d1x!.replaceLost === "d1b" && waits(out, "d1x", /conflicting replacement/) && waits(out, "d1x", /not answered/));

// --- R13 (owner, P1.3 "Read on D1"): words typed on D1 before it was replaced

/** Words typed on d1 half a second before d1b replaced it — and recorded after that. */
const onReplaced = (...more: ((M: any) => any[])[]) => {
  const R = post("R1b", [d1b]), M = msg(d1, "close it", "u1", new Date(Date.parse(R.at) - 500).toISOString());
  return [R, M, ...more.flatMap((f) => f(M))];
};
run("Q5/Q6: unread superseded words leave the reader queue", () => onReplaced(),
  (b, out) => b.d1!.replacedBy === "d1b" && !awaitingReading(out).some((u) => u.decision === "d1") && waits(out, "d1b", /not answered/));
run("R13: read two ways, they are in dispute", () => onReplaced((M) => [reading(M, [{ decision: "d1", option: "Settle" }], [{ decision: "d1", option: "No" }])]),
  (b, out) => readingsInDispute(out).some((x) => x.decision === "d1") && waits(out, "d1", /read two different ways/));
run("R13: bound onto D1, they rule D1 as of when typed and hold F3 until D1b is answered (B2.4)", () => onReplaced((M) => [reading(M, [{ decision: "d1", option: "Settle" }])]),
  (b, out) => rules(b.d1!, "F3", "settle") && held(out, "F3", "ruled") && ruledNotCarriedOut(out, () => true).some((u) => u.decision === "d1" && u.replacedBy === "d1b") && !awaitingReading(out).length);
run("Q5/Q6: unread words on a superseded question cannot flag an accepted ruling as actionable", () => [page(d1, { option: "Settle" }), ...onReplaced()],
  (b, out) => !flagged(b.d1!) && !supersededFindings(out).has("F3"));
run("R13 + P3.3: once D1b rules, the words leave every list", () => [page(d1, { option: "Settle" }), ...onReplaced(() => [page(d1b, { option: "No" })]), ...others()],
  (b, out) => !awaitingReading(out).length && !waits(out, "d1") && !flagged(b.d1!) && !readingsInDispute(out).length);
/** D1 replaced, undecided, by a D1c that asks about F3 only: F7 is the finding it drops. */
const d1c = reask(d1, "d1c", "D7", "R1c", { supersedes: "d1", options: [{ label: "Settle", effects: [settle("F3")] }, { label: "No", effects: [unblock("F3")] }] });
const heldBy = (out: SharedDecisions, f: string) => (heldFindings(out, () => true).get(f) ?? []).map((x) => x.decision);
both("Q1.4 (C2): a finding the replacement drops stays held by the undecided replaced question until the replacement rules", () => {
  n = 1;
  const R = post("R1c", [d1c]), M = msg(d1, "hmm", "u1", new Date(Date.parse(R.at) - 500).toISOString());
  const RM = reading(M, [{ decision: "d1", option: null }]);
  return { first: [R, M, RM], second: [M, RM, R] };
}, (b, out) => heldBy(out, "F7").includes("d1") && heldBy(out, "F3").includes("d1") && heldBy(out, "F3").includes("d1c"));
run("Q1.4 (C2): ...and once it rules, the dropped finding is released with no ruling on it", () => [post("R1c", [d1c]), page(d1c, { option: "No" })],
  (b, out) => !heldBy(out, "F7").length && !heldBy(out, "F3").length);
run("Q3.3 (b): ...unless D1 still holds a ruling its replacement never took over — then they stay listed beside it", () => {
  const d1c = reask(d1, "d1c", "D7", "R1c", { supersedes: "d1", options: [{ label: "Settle", effects: [settle("F3")] }, { label: "No", effects: [unblock("F3")] }] });
  const P = page(d1, { option: "Settle" }), R = post("R1c", [d1c]), M = msg(d1, "close it", "u1", new Date(Date.parse(R.at) - 500).toISOString());
  return [P, R, M, page(d1c, { option: "No" }), ...others()];
}, (b, out) => ruledNotCarriedOut(out, () => true).some((u) => u.decision === "d1" && u.finding === "F7") && waits(out, "d1", /remains visible for F7/));
run("Q5/Q6: an unverified replacement answer does not re-enable old unread words", () => onReplaced(() => [unv(d1b, "no")]),
  (b, out) => !awaitingReading(out).some((u) => u.decision === "d1"));

// --- Q1.2 (owner, "While they could change something"): words are moot only when no question
// they may be read onto would change

/** Q1.2's case on the fixture: D4 answered B, then words on D1 about D4, then a pick on D1. */
const aboutD4 = () => {
  const old = page(d4, { option: "B" }), W = msg(d1, "actually A on D4"), later = page(d1, { option: "Settle" });
  const O = [page(d2, { option: "None — approve all" }), page(d3, { option: "Now" })];
  return { O, old, W, later };
};
both("Q1.2: words outranked on their own question stay listed while another question they may be read onto has nothing given after them — and a reading binds them there", () => {
  n = 1;
  const { O, old, W, later } = aboutD4();
  const R = reading(W, [{ decision: "d4", option: "A" }]);
  return { first: [...O, old, W, later, R], second: [...O, later, W, old, R] };
}, (b) => standing(b.d4!)!.options[0] === "A" && standing(b.d1!)!.options[0] === "Settle");
both("Q1.2: ...unread, they wait for a reader, and D1 stays flagged", () => {
  n = 1;
  const { O, old, W, later } = aboutD4();
  return { first: [...O, old, W, later], second: [...O, later, W, old] };
}, (b, out) => awaitingReading(out).some((u) => u.decision === "d1") && flagged(b.d1!));
both("Q1.2: once D4 has a later answer too, the words leave all four lists, and a reading of them changes nothing standing", () => {
  n = 1;
  const { O, old, W, later } = aboutD4();
  const again = page(d4, { option: "B" });
  return { first: [...O, old, W, later, again], second: [...O, again, later, W, old] };
}, (b, out) => !awaitingReading(out).length && !readingsInDispute(out).length && !waits(out, "d1") && !flagged(b.d1!) && standing(b.d4!)!.options[0] === "B");
test("Q1.2: a reading of moot words binds, and changes no standing answer", () => {
  n = 1;
  const { O, old, W, later } = aboutD4();
  const again = page(d4, { option: "B" }), R = reading(W, [{ decision: "d4", option: "A" }]);
  for (const evs of [[...O, old, W, later, again, R], [...O, R, again, later, W, old]]) {
    const { b, out } = fold(evs);
    assert.ok(standing(b.d4!)!.options[0] === "B" && standing(b.d1!)!.options[0] === "Settle" && b.d4!.answers.some((a) => a.id === `${R.id}/d4`), dump(b, out));
  }
});
run("Q1.2: at an equal given time a copy ranks at the binding's log position, so words recorded before D4's answer still count on D4", () => {
  const old = page(d4, { option: "B" }), W = msg(d1, "actually A on D4", "u1", old.at), later = page(d1, { option: "Settle" });
  return [W, old, later, ...others().slice(0, 2)];
}, (b, out) => awaitingReading(out).some((u) => u.decision === "d1"));
test("Q1.2 (pinned consequence): binding moot words older than a standing answer can move when that question's hold began", () => {
  n = 1;
  const W = msg(d1, "B on D4"), P = page(d1, { option: "Settle" }), A = page(d4, { option: "A" });
  const O = [page(d2, { option: "None — approve all" }), page(d3, { option: "Now" })];
  const R = reading(W, [{ decision: "d4", option: "B" }]);
  const before = fold([...O, W, P, A]);
  assert.ok(since(before.out, "F30")[0] === round.at && !awaitingReading(before.out).length, dump(before.b, before.out));
  for (const evs of [[...O, W, P, A, R], [...O, A, P, W, R]]) {
    const { b, out } = fold(evs);
    // Unblocked by the words at their typed time, then held again by A: the hold began at A (S0.4).
    assert.ok(standing(b.d4!)!.options[0] === "A" && since(out, "F30")[0] === A.at, dump(b, out));
  }
});
test("Q3: neither a valid nor an effect-bearing invalid confirm lets unrelated words act", () => {
  n = 1;
  const W0 = msg(d1, "hmm"), first = fold([W0]);
  const C = confirmOf(first.b, "d1", first.b.d1!.answers[0]!.id, [[{ decision: "d1", option: "No" }]]);
  const W = msg(d1, "later words", "u2"), P = page(d1, { option: "Settle" }), O = others();
  const r = fold([...O, W0, C, W, P]);
  assert.ok(!awaitingReading(r.out).some((u) => u.answer === W.id), dump(r.b, r.out));
  // The same posting, but an option carries an effect: kept as a plain question (P3.4), so words can change it.
  const bad = structuredClone(C);
  bad.data.decision.options[0].effects = [settle("F3")];
  const r2 = fold([...O, W0, bad, W, P]);
  assert.ok(!!r2.b.c1!.confirms!.invalid && !awaitingReading(r2.out).some((u) => u.answer === W.id), dump(r2.b, r2.out));
});

// --- S0.4: when a hold began

run("S0.4: an undecided hold begins at its posting", () => [], (b, out) => since(out, "F3")[0] === round.at);
run("S0.4: released by an unblock, then held again by a later answer — the hold began at that answer", () => {
  const R = page(d4, { option: "B" });                 // releases F30
  const S = page(d4, { option: "A" }); S.at = "2026-09-23T00:10:00Z";   // holds it again
  return [R, S];
}, (b, out) => held(out, "F30", "ruled") && since(out, "F30")[0] === "2026-09-23T00:10:00Z");
run("S0.4: continuously held — undecided, then ruled — the hold began at the posting", () => [page(d1, { option: "Settle" })],
  (b, out) => held(out, "F3", "ruled") && since(out, "F3")[0] === round.at);
run("S0.4: a replacement inherits the start of a hold its predecessor still had", () => [page(d1, { option: "Settle" }), post("R1b", [d1b])],
  (b, out) => since(out, "F3").every((s) => s === round.at));

// --- the views, and parks

const isParked = (out: SharedDecisions, id: string, today: string) => parked(out, today).some((p) => p.decision === id);
run("H6.5–6.6: a park is under Parked, not waiting on you, through the whole of its date", () => [page(d3, { option: "Park until 2026-10-15" })],
  (b, out) => ["2026-10-14", "2026-10-15"].every((t) => isParked(out, "d3", t) && !waits(out, "d3", undefined, t))
    && parked(out, "2026-10-15")[0]!.until === "2026-10-15" && parked(out, "2026-10-15")[0]!.findings.includes("F20"));
run("...and the day after, it is yours again, its findings still held as undecided", () => [page(d3, { option: "Park until 2026-10-15" })],
  (b, out) => !isParked(out, "d3", "2026-10-16") && waits(out, "d3", /parked until 2026-10-15, which has passed/, "2026-10-16") && held(out, "F20", "undecided"));
run("B4.1: words read as a park, the two readings agreeing, park — and show under Parked", () => {
  const [L, A] = call(d3, "park it till mid October");
  return [L, A, reading(A, [{ decision: "d3", option: "Park until 2026-10-15" }])];
}, (b, out) => isParked(out, "d3", "2026-09-23"));
run("B4.1: read two ways, nothing parks and it waits on you", () => {
  const [L, A] = call(d3, "later, maybe");
  return [L, A, reading(A, [{ decision: "d3", option: "Park until 2026-10-15" }], [{ decision: "d3", option: null }])];
}, (b, out) => !isParked(out, "d3", "2026-09-23") && waits(out, "d3") && readingsInDispute(out).some((x) => x.decision === "d3"));
run("Q11 / S0.5: 'not sure, ask bob', read as nothing on both sides, ranks, rules nothing, and waits on you", () => {
  const [L, A] = call(d1, "not sure, ask bob");
  return [L, A, reading(A, [{ decision: "d1", option: null }])];
}, (b, out) => standing(b.d1!)!.nothing === true && waits(out, "d1", /rule nothing/) && held(out, "F3", "undecided") && !awaitingReading(out).length);
run("S0.5: '(none)' after a click outranks it — and waits on you, its findings undecided", () => {
  const P = page(d1, { option: "Settle" }), M = msg(d1, "forget D1");
  return [P, M, reading(M, [{ decision: "d1", option: null }])];
}, (b, out) => standing(b.d1!)!.nothing === true && waits(out, "d1", /rule nothing/) && held(out, "F3", "undecided") && !held(out, "F3", "ruled"));
run("Q13: a follow-up to a reading's copy attaches to the decision the copy is on", () => {
  const [L, A] = call(d1, "settle, and on the bulk one take the rename separately");
  const R = reading(A, [{ decision: "d1", option: "Settle" }, { decision: "d2", option: "Rename fix" }]);
  const nd = { ...D("d9", "D9", q("D9: Rename fix — settle F10?", ["Yes", "No"]), [{ label: "Yes", effects: [settle("F10")] }, { label: "No", effects: [] }]), round: "R2", origin: { answer: `${R.id}/d2` } };
  return [L, A, R, post("R2", [nd])];
}, (b, out) => standing(b.d2!)!.separately?.[0] === "Rename fix" && (b.d2!.followUps ?? []).includes("d9") && !waits(out, "d2", /Rename fix/));

// --- 2026-09-24 decision round: historical admission and human conflicts -------------------

test("Q2: an unknown replacement cannot erase an accepted direct answer", () => {
  n = 1;
  const r = post("R2", [reask(d1, "d1x", "D7", "R2", { supersedes: "d1" })]);
  const a = page(d1, { option: "Settle" });
  a.data.knownReplacements = []; // the replacement was not on the accepting clone
  const s = foldDecisions([round, r, a]);
  const old = s.decisions.find((d) => d.id === "d1")!;
  assert.equal(old.answers[0]?.id, a.id);
  assert.equal(standing(old)?.options[0], "Settle");
});

test("F2/F7: identical shown refs keep two identities and reject an ambiguous verdict", () => {
  n = 1;
  const one = { ...d1, id: "same-a", round: "RS" }, two = { ...d1, id: "same-b", round: "RS" };
  const source = { ...d4, id: "source", round: "RS", ref: "D4" };
  const R = post("RS", [one, two, source]);
  const W = msg(source, "D1 Settle", "u-same"); W.data.via.round = "RS";
  const before = foldDecisions([round, R, W]);
  const byId = new Map(before.decisions.map((d) => [d.id, d]));
  const d = byId.get("source")!, a = d.answers[0]!;
  const brief = readerBrief(byId, d, a), manifest = briefManifest(byId, d, a);
  assert.deepEqual(manifest.filter((m) => m.ref === "D1").map((m) => m.id), ["same-a", "same-b"]);
  const listed = briefListing(byId, d, a, brief, manifest);
  assert.ok(Array.isArray(listed) && listed.filter((x) => x.ref === "D1").length === 2);
  assert.match(String(briefListing(byId, d, a, brief, [{ ...manifest[0]!, hash: "wrong" }, ...manifest.slice(1)])), /manifest/);
  assert.match(brief, /context: .*"effects"/);
  assert.match(String(briefListing(byId, d, a, brief.replace("\"F3\"", "\"F8\""), manifest)), /cannot be read onto|other labels/);
  const rd = reading(W, [{ decision: "same-a", option: "Settle" }]);
  rd.data.reader.brief = brief;
  rd.data.reader.manifest = manifest;
  const after = foldDecisions([round, R, W, rd]);
  assert.equal(after.decisions.find((x) => x.id === "source")!.answers[0]!.reading, undefined);
});

test("Q3: a malformed effect-bearing confirmation keeps the evidence but no authority", () => {
  n = 1;
  const W = msg(d1, "hmm", "u-invalid"), first = fold([W]);
  const C = confirmOf(first.b, "d1", W.id, [[{ decision: "d1", option: "Settle" }]]);
  C.data.decision.options[0].effects = [settle("F3")];
  const [L, A] = call(C.data.decision, CONFIRM_YES);
  const s = foldDecisions([round, W, C, L, A]);
  const c = s.decisions.find((d) => d.id === C.data.decision.id)!;
  assert.ok(c.confirms?.invalid);
  assert.equal(c.answers[0]?.words, CONFIRM_YES);
  assert.deepEqual(c.answers[0]?.ruled, []);
  assert.ok(waits(s, c.id, /not a confirm.*ask for a new confirm/));
  assert.ok(!heldFindings(s, () => true).get("F3")?.some((h) => h.decision === c.id));
});

test("Q2 human conflict: concurrent proven rulings hold work until a shown human choice resolves the pair", () => {
  const base: any = { ...round, id: "r-base", writer: "w-base", writerPrev: "GENESIS", after: [] };
  const a: any = { id: "a-one", kind: "decision.answer.recorded", subject: "d1", actor: { principal: "alice" },
    at: at(20), writer: "w-alice", writerPrev: "GENESIS", after: [base.id],
    data: { decision: "d1", hash: h(d1), via: { kind: "direct", option: "Settle" }, knownReplacements: [] } };
  const b: any = { id: "a-two", kind: "decision.answer.recorded", subject: "d1", actor: { principal: "bob" },
    at: at(21), writer: "w-bob", writerPrev: "GENESIS", after: [base.id],
    data: { decision: "d1", hash: h(d1), via: { kind: "direct", option: "No" }, knownReplacements: [] } };
  const before = foldDecisions([base, a, b]);
  const candidates = intentCandidates(before);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0]!.answers, ["a-one", "a-two"]);
  assert.ok(heldFindings(before, () => true).get("F3")?.length);
  assert.ok(heldFindings(before, () => true).get("F3")?.some((h) => h.why === "comparison"
    && h.answers?.includes("a-one") && h.answers?.includes("a-two") && h.since === at(21)));
  assert.ok(!ruledNotCarriedOut(before, () => true).some((x) => x.finding === "F3"));
  const payload = q(`D9: Alice said ${JSON.stringify("Settle")} in a-one; Bob said ${JSON.stringify("No")} in a-two. Which answer should be preserved for F3 and F7?`, ["Preserve a-one", "Preserve a-two"]);
  const resolution = D("resolve-1", "D9", payload, [{ label: "Preserve a-one", effects: [] }, { label: "Preserve a-two", effects: [] }], { round: "R2", resolves: { answers: ["a-one", "a-two"] } });
  const R: any = { id: "r-resolve", kind: "decision.round.posted", subject: "R2", actor: { principal: "agent", via: { kind: "agent", model: "m" } },
    at: at(22), writer: "w-agent", writerPrev: "GENESIS", after: [a.id, b.id], data: { round: { id: "R2", source: "conflict", universe: "u" }, decisions: [resolution] } };
  const choice: any = { id: "a-choice", kind: "decision.answer.recorded", subject: "resolve-1", actor: { principal: "alice" },
    at: at(23), writer: "w-alice", writerPrev: a.id, after: [R.id],
    data: { decision: "resolve-1", hash: h(resolution), via: { kind: "direct", option: "Preserve a-one" }, knownReplacements: [] } };
  const after = foldDecisions([base, a, b, R, choice]);
  assert.equal(intentCandidates(after).length, 0);
  assert.ok(ruledNotCarriedOut(after, () => true).some((x) => x.finding === "F3"));
  const resolution2 = { ...resolution, id: "resolve-2", round: "R3", ref: "D10",
    payload: { ...resolution.payload, question: resolution.payload.question.replace("D9", "D10") } };
  const R3: any = { ...R, id: "r-resolve-2", subject: "R3", at: at(24), writerPrev: R.id,
    after: [choice.id], data: { round: { id: "R3", source: "conflict", universe: "u" }, decisions: [resolution2] } };
  const correction: any = { ...choice, id: "a-correction", subject: "resolve-2", at: at(25), writerPrev: choice.id,
    after: [R3.id], data: { ...choice.data, decision: "resolve-2", hash: h(resolution2), via: { kind: "direct", option: "Preserve a-two" } } };
  const corrected = foldDecisions([base, a, b, R, choice, R3, correction]);
  assert.equal(corrected.decisions.find((d) => d.id === "d1")!.answers.find((x) => x.id === "a-one")!.resolvedOutBy, correction.id);
  assert.equal(corrected.decisions.find((d) => d.id === "d1")!.answers.find((x) => x.id === "a-two")!.resolvedOutBy, undefined);
  assert.equal(intentCandidates(corrected).length, 0, "a correction preserves one current authority");
  const third: any = { ...b, id: "a-three", actor: { principal: "carol" }, writer: "w-carol", at: at(24),
    data: { ...b.data, via: { kind: "direct", option: "No" } } };
  assert.ok(intentCandidates(foldDecisions([base, a, b, R, choice, third])).some((c) => c.answers.includes("a-three")),
    "a choice about two shown answers cannot settle a third unseen person");
  const agreeingThird: any = { ...a, id: "a-agree", actor: { principal: "carol" }, writer: "w-carol", at: at(24) };
  const withAgreement = intentCandidates(foldDecisions([base, a, b, R, choice, agreeingThird]));
  assert.ok(withAgreement.some((c) => c.answers.includes("a-one") && c.answers.includes("a-agree")),
    "equal options still need comparison against their complete source context");
  assert.ok(!withAgreement.some((c) => c.answers.includes("a-two")),
    "a resolved-out answer is history, not a fresh competing instruction");
  const independentChoice: any = { ...choice, id: "a-independent-choice", actor: { principal: "bob" },
    writer: "w-bob", writerPrev: b.id, after: [R.id], at: at(24),
    data: { ...choice.data, via: { kind: "direct", option: "Preserve a-two" } } };
  const unresolvedChoices = foldDecisions([base, a, b, R, choice, independentChoice]);
  assert.equal(intentCandidates(unresolvedChoices).length, 1,
    "independent answers to a resolution question cannot select a winner by time");
  assert.ok(unresolvedChoices.decisions.find((d) => d.id === "d1")!.answers.every((x) => !x.resolvedOutBy));
  const agentChoice: any = { ...choice, id: "a-agent-choice", actor: agent };
  assert.equal(intentCandidates(foldDecisions([base, a, b, R, agentChoice])).length, 1,
    "an agent cannot resolve the pair by answering for the person");

  const newWords: any = { ...choice, id: "a-new-words", data: { ...choice.data, via: { kind: "direct", words: "Keep the work open and ask for a narrower fix" } } };
  const unread = foldDecisions([base, a, b, R, newWords]);
  assert.equal(intentCandidates(unread).length, 1, "new words alone are not yet an actionable resolution");
  const rd = unread.decisions.find((d) => d.id === "resolve-1")!;
  const ra = rd.answers.find((x) => x.id === newWords.id)!;
  const maps: Mapping[] = [{ decision: rd.id, option: null }];
  const read: any = { id: "r-new-words", kind: "decision.reading.recorded", subject: rd.id, actor: agent,
    at: at(25), writer: "w-reader", writerPrev: "GENESIS", after: [newWords.id],
    data: { answer: newWords.id, knownReplacements: [], session: { reading: "new intent", maps },
      reader: { agent: "aREADER12345678", verdict: maps, launchedAt: at(24), brief: readerBrief(new Map(unread.decisions.map((d) => [d.id, d])), rd, ra),
        verified: { session: "sess-X", toolUseId: "t" } } } };
  const changed = foldDecisions([base, a, b, R, newWords, read]);
  assert.equal(intentCandidates(changed).length, 0, "verified new intent resolves the shown pair");
  assert.ok(heldFindings(changed, () => true).get("F3")?.length, "affected work stays held until the new intent has an actionable question");
  assert.ok(waits(changed, "resolve-1", /new intent.*fresh valid question/));
  assert.equal(changed.decisions.find((d) => d.id === "resolve-1")!.answers[0]!.words, "Keep the work open and ask for a narrower fix");
});
