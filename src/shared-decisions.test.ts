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
  possiblySuperseded, confirmPayload, supersededFindings, CONFIRM_YES, CONFIRM_NO,
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
const fold = (evs: any[]) => {
  const out = foldDecisions([round, ...evs]);
  return { out, b: Object.fromEntries(out.decisions.map((d) => [d.id, d])) as B };
};
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
    bound: extra.bound ?? Object.fromEntries(qs.filter((x: any) => !x.question.startsWith("Confirm reading")).map((x: any) => [x.question, rounds[0]])),
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

const ruled = (d: FoldedDecision) => standing(d)?.ruled ?? [];
const rules = (d: FoldedDecision, f: string, on: string) => ruled(d).some((r) => r.finding === f && r.on === on);
const waits = (out: SharedDecisions, id: string, re?: RegExp, today = "2026-09-23") => waitingOnMe(out, today).some((w) => w.decision === id && (!re || re.test(w.why)));
const held = (out: SharedDecisions, f: string, why?: string, isOpen = (_: string) => true) => (heldFindings(out, isOpen).get(f) ?? []).some((x) => !why || x.why === why);
const since = (out: SharedDecisions, f: string) => (heldFindings(out, () => true).get(f) ?? []).map((x) => x.since);
const flagged = (d: FoldedDecision) => possiblySuperseded(d).length > 0;

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
  return [P, A, reading(A, [{ decision: "d1", option: "No" }], [{ decision: "d1", option: "Settle" }])];
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
  (b, out) => rules(b.d1!, "F3", "settle") && flagged(b.d1!) && possiblySuperseded(b.d1!)[0]!.state === "unread"
    && supersededFindings(out).has("F3") && supersededFindings(out).has("F7") && awaitingReading(out).length === 1);
run("P4.1: ...read as unclear — the click still stands, flagged, and it waits on you", () => {
  const P = page(d1, { option: "Settle" }), M = msg(d1, "D1 — hmm");
  return [P, M, reading(M, [], [{ decision: "d1", option: "No" }], { unclear: "not an answer to anything" })];
}, (b, out) => rules(b.d1!, "F3", "settle") && possiblySuperseded(b.d1!)[0]!.state === "unclear" && waits(out, "d1", /could not tell/));
run("P4.1: ...read two ways — flagged, and in dispute", () => {
  const P = page(d1, { option: "Settle" }), M = msg(d1, "D1 — hmm");
  return [P, M, reading(M, [{ decision: "d1", option: "No" }], [{ decision: "d1", option: "Settle" }])];
}, (b, out) => rules(b.d1!, "F3", "settle") && possiblySuperseded(b.d1!)[0]!.state === "disputed" && readingsInDispute(out).length === 1);
run("P4.1: ...bound to another option — it rules, and the flag clears", () => {
  const P = page(d1, { option: "Settle" }), M = msg(d1, "D1 — no");
  return [P, M, reading(M, [{ decision: "d1", option: "No" }])];
}, (b, out) => standing(b.d1!)!.options[0] === "No" && !flagged(b.d1!) && !supersededFindings(out).size);
run("A3: a later verified answer clears the flag; the moot words wait on nobody", () => {
  const P = page(d1, { option: "Settle" }), M = msg(d1, "D1 — hmm");
  return [P, M, page(d1, { option: "No" })];
}, (b, out) => standing(b.d1!)!.options[0] === "No" && !flagged(b.d1!) && !awaitingReading(out).length && !waits(out, "d1"));
run("S0.8(a): the flag reaches a finding the ruling released — marked, never held", () => [page(d4, { option: "B" }), msg(d4, "D4 hmm, maybe not")],
  (b, out) => !held(out, "F30") && supersededFindings(out).has("F30"));

// --- confirm-this-reading (S0.1, S0.2)

const confirmCall = (b: B, d: string, a: string, maps: Mapping[][], value: string, extra: any = {}) => {
  const out = foldDecisions([]);
  void out;
  const all = Object.values(b);
  const p = confirmPayload(all, b[d]!, b[d]!.answers.find((x) => x.id === a)!, maps)!;
  return logQ([p], { [p.question]: value }, extra);
};
/** Two passes: fold to learn the answer ids, then append the logged confirm call. */
const withConfirm = (name: string, base: () => any[], d: string, maps: Mapping[][] | null, value: string, check: (b: B, out: SharedDecisions) => boolean, pick = (b: B) => b[d]!.answers.at(-1)!.id) => test(name, () => {
  n = 1;
  const evs = base();
  const first = fold(evs);
  const a = pick(first.b);
  const ms = maps ?? [first.b[d]!.answers.find((x) => x.id === a)!.reading!.reader.maps, first.b[d]!.answers.find((x) => x.id === a)!.reading!.session.maps];
  const C = confirmCall(first.b, d, a, ms, value);
  const { out, b } = fold([...evs, C]);
  assert.ok(check(b, out), dump(b, out));
});
withConfirm("S0.1: Yes on the agent's own reading of unread words binds it — at the time TYPED", () => [page(d1, { option: "Settle" }), msg(d1, "D1 actually leave it")],
  "d1", [[{ decision: "d1", option: "No" }]], CONFIRM_YES,
  (b, out) => standing(b.d1!)!.options[0] === "No" && standing(b.d1!)!.givenAt === at(3) && !!standing(b.d1!)!.confirmed && !flagged(b.d1!) && !held(out, "F3", "ruled"));
withConfirm("S0.2: No — the rejected reading is recorded, the old ruling stands, flagged, and you are asked to answer again", () => [page(d1, { option: "Settle" }), msg(d1, "D1 actually leave it")],
  "d1", [[{ decision: "d1", option: "No" }]], CONFIRM_NO,
  (b, out) => rules(b.d1!, "F3", "settle") && flagged(b.d1!) && possiblySuperseded(b.d1!)[0]!.rejected?.length === 1 && waits(out, "d1", /not what you meant/));
withConfirm("S0.2: Other — your own words, a new answer on the original question at the call's time, for a reader", () => [page(d1, { option: "Settle" }), msg(d1, "D1 actually leave it")],
  "d1", [[{ decision: "d1", option: "No" }]], "I meant fix F7 only",
  (b, out) => rules(b.d1!, "F3", "settle") && b.d1!.answers.some((a) => a.words === "I meant fix F7 only" && a.free && a.verified) && awaitingReading(out).some((u) => u.words === "I meant fix F7 only"));
withConfirm("S0.2: a dispute's confirm offers both readings; picking one binds it", () => {
  const P = page(d1, { option: "Settle" }), M = msg(d1, "D1 — hmm");
  return [P, M, reading(M, [{ decision: "d1", option: "No" }], [{ decision: "d1", option: "Settle" }])];
}, "d1", null, "Reading 1",
  (b, out) => standing(b.d1!)!.options[0] === "No" && !readingsInDispute(out).length, (b) => b.d1!.answers.find((a) => a.via === "message")!.id);
test("S0.2: a confirm whose text is not exactly the one codemap issues binds nothing", () => {
  n = 1;
  const evs = [page(d1, { option: "Settle" }), msg(d1, "D1 actually leave it")];
  const first = fold(evs);
  const a = first.b.d1!.answers.at(-1)!;
  const p = confirmPayload(Object.values(first.b), first.b.d1!, a, [[{ decision: "d1", option: "No" }]])!;
  // Each parses — the mapping line is untouched — and differs only where parsing does not look.
  for (const forged of [
    { ...p, options: [{ ...p.options[0]!, description: "Bind whatever you think best" }, p.options[1]!] },
    { ...p, question: p.question.replace("Is that what you meant?", "OK?") },
  ]) {
    const { b } = fold([...evs, logQ([forged], { [forged.question]: CONFIRM_YES })]);
    assert.ok(rules(b.d1!, "F3", "settle") && flagged(b.d1!), dump(b, first.out));
  }
});
test("S0.2: of two confirmations of the same words, the later wins", () => {
  n = 1;
  const evs = [page(d1, { option: "Settle" }), msg(d1, "D1 hmm")];
  const first = fold(evs);
  const a = first.b.d1!.answers.at(-1)!;
  const yes = confirmCall(first.b, "d1", a.id, [[{ decision: "d1", option: "No" }]], CONFIRM_YES, { answeredAt: "2026-09-23T00:01:00Z" });
  const no = confirmCall(first.b, "d1", a.id, [[{ decision: "d1", option: "No" }]], CONFIRM_NO, { answeredAt: "2026-09-23T00:02:00Z", toolUseId: "tu-later" });
  for (const order of [[yes, no], [no, yes]]) {
    const { b } = fold([...evs, ...order]);
    assert.ok(rules(b.d1!, "F3", "settle") && flagged(b.d1!), dump(b, first.out));
  }
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
run("bulk: unverified words wait for a reader, relayer known or not (the relayer guard is gone, B2)", () => [answer(d2, { kind: "unverified", words: "all fine" })],
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
  return [L, A, reading(A, [{ decision: "d1", option: "Settle" }], [{ decision: "d1", option: "No" }]), page(d1, { option: "No" })];
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
run("DROP: an answer given after its decision was replaced", () => [post("R1b", [reask(d1, "d1b", "D7", "R1b", { supersedes: "d1" })]), page(d1, { option: "Settle" })],
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
