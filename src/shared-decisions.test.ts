/**
 * The decision-round fold, run on hand-built events — the way this codebase reviews a fold
 * (CLAUDE.md, "To review a fold, RUN it"). The cases carried from the first build are the
 * sequences its two review rounds argued over; the rulings behind each are in
 * docs/decision-rounds-worked-cases.md, and the P/Q/H numbers are the 2026-09-23 review
 * round's plan (`.git/triage/2026-09-23-decision-rounds-2-review/plan.md`). There is no
 * state label to assert on: each case asserts on the standing answer's facts and on the
 * views, because those are what the person and the agents actually read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  foldDecisions, decisionHash, checkDecision, heldFindings, standing, waitingOnMe, readingsInDispute, ruledNotCarriedOut, awaitingReading, parked,
  type FoldedDecision, type SharedDecisions,
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
const d4 = D("d4", "D4", q("D4: close F30?", ["A", "B"]), [{ label: "A", effects: [settle("F30")] }, { label: "B", effects: [] }]);
const d5 = { ...D("d5", "D5", q("D5: the goal, in your words?", ["x", "y"]), [{ label: "x", effects: [] }, { label: "y", effects: [] }]), kind: "words" };
const round = ev("decision.round.posted", { round: { id: "R1", source: "plan-x", universe: "u" }, decisions: [d1, d2, d3, d4, d5] });
const h = (d: any) => decisionHash(d);
/** `d` re-asked as `id` in `round`, with its ref in the text as posting requires. */
const reask = (d: any, id: string, ref: string, rnd: string, extra: any = {}) =>
  ({ ...d, id, ref, round: rnd, payload: { ...d.payload, question: d.payload.question.replace(d.ref, ref) }, ...extra });
const post = (id: string, decisions: any[], extra: any = {}) => ev("decision.round.posted", { round: { id, source: "x", ...extra }, decisions });

type B = Record<string, FoldedDecision>;
const run = (name: string, extra: () => any[], check: (b: B, out: SharedDecisions) => boolean) => test(name, () => {
  n = 1;
  const out = foldDecisions([round, ...extra()]);
  const byId: B = Object.fromEntries(out.decisions.map((d) => [d.id, d]));
  assert.ok(check(byId, out), JSON.stringify(Object.fromEntries(Object.entries(byId).map(([k, d]) => [k, { answers: d.answers, replacedBy: d.replacedBy }])), null, 1).slice(0, 3000) + JSON.stringify(out.questions).slice(0, 800));
});
/** A logged call, answered when it was logged unless `answeredAt` says otherwise. */
const logQ = (qs: any[], answers: any, extra: any = {}) => {
  const e = ev("decision.question.logged", { session: "sess-A", toolUseId: `tu${n + 1}`, questions: qs, answers, transcript: "sess-A", round: "R1", ...extra });
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
const reading = (a: any, maps: any[], session = maps, extra: any = {}) =>
  ev("decision.reading.recorded", { answer: a.id, reader: { transcript: "agent-B", reading: "r", maps }, session: { reading: "r", maps: session }, ...extra });

const ruled = (d: FoldedDecision) => standing(d)?.ruled ?? [];
const rules = (d: FoldedDecision, f: string, on: string) => ruled(d).some((r) => r.finding === f && r.on === on);
const waits = (out: SharedDecisions, id: string, re?: RegExp, today = "2026-09-23") => waitingOnMe(out, today).some((w) => w.decision === id && (!re || re.test(w.why)));
const held = (out: SharedDecisions, f: string, why?: string, isOpen = (_: string) => true) => (heldFindings(out, isOpen).get(f) ?? []).some((x) => !why || x.why === why);

// --- what an answer rules

run("a verified answer rules both effects; the settle holds its finding for the verifier, the unblock releases", () => call(d1, "Settle"),
  (b, out) => rules(b.d1!, "F3", "settle") && rules(b.d1!, "F7", "unblock") && held(out, "F3", "ruled") && !held(out, "F7") && !waits(out, "d1"));
run("an unanswered decision waits on you and holds everything it could touch", () => [],
  (b, out) => waits(out, "d1", /not answered/) && held(out, "F3", "undecided") && held(out, "F7", "undecided"));
run("an unverified relay, read, unblocks; its settle waits for you and stays held", () => {
  const A = answer(d1, { kind: "unverified", words: "D1 yes" }, agent, { relayedBy: "sess-A" });
  return [A, reading(A, [{ decision: "d1", option: "Settle" }])];
}, (b, out) => rules(b.d1!, "F7", "unblock") && !rules(b.d1!, "F3", "settle") && standing(b.d1!)!.unruled.includes("F3")
  && waits(out, "d1", /could not be verified/) && held(out, "F3", "undecided") && !held(out, "F7"));
run("C3 (regression guard): your second answer to the same question replaces the first", () => [page(d1, { option: "Settle" }), page(d1, { option: "No" })],
  (b, out) => b.d1!.answers[0]!.superseded === true && standing(b.d1!)!.options[0] === "No" && !held(out, "F3"));
run("a words decision is recorded, never read, and rules nothing", () => call(d5, "Ship it"),
  (b, out) => standing(b.d5!)!.words === "Ship it" && !ruled(b.d5!).length && !waits(out, "d5") && !awaitingReading(out).length);

// --- P1: which answer counts

run("P1.b (H5): a typed 'D1 A' is never parsed — it waits for its reading, and nothing binds until then", () => [msg(d1, "D1 A")],
  (b, out) => !ruled(b.d1!).length && standing(b.d1!)!.free && awaitingReading(out).some((u) => u.decision === "d1") && held(out, "F3", "undecided"));
run("P1.b + H8: bound by the reader, a typed reply rules — its settle held, never closing, and not your own answer yet", () => {
  const A = msg(d1, "D1 A");
  return [A, reading(A, [{ decision: "d1", option: "Settle" }])];
}, (b, out) => rules(b.d1!, "F3", "settle") && held(out, "F3", "ruled") && !ruled(b.d1!).some((r) => r.closesOnAnswer) && standing(b.d1!)!.own === false);
run("P1.b: a message typed before its question was posted binds to nothing", () => [msg(d1, "D1 A", "u1", "2026-09-22T23:59:59Z")],
  (b) => !b.d1!.answers.length);
run("P1.b: a message typed for another round binds to nothing", () => { const e = msg(d1, "D1 A"); e.data.via.round = "R9"; return [e]; },
  (b) => !b.d1!.answers.length);
run("P1.b: the same message relayed twice to one decision records it once", () => [msg(d1, "D1 A", "u1"), msg(d1, "D1 A", "u1")],
  (b) => b.d1!.answers.length === 1);
run("P1.b: a reader that cannot tell which question the words answer binds nothing, and it waits for you", () => {
  const A = msg(d1, "yes that one");
  return [A, reading(A, [], [], { unclear: "two questions were open and the session asked neither just before" })];
}, (b, out) => !ruled(b.d1!).length && waits(out, "d1", /could not tell which question/) && !readingsInDispute(out).length && !awaitingReading(out).length);
run("P1.a (B1.4): an identical question in another round does not take the answer — R1's ruling stands", () => {
  const r2 = reask(d1, "d1x", "D1", "R2");
  // The same payload text on purpose: that is the collision.
  r2.payload = d1.payload;
  const [L1, A1] = call(d1, "Settle");
  const R2 = post("R2", [r2]);
  const L2 = logQ([d1.payload], { [d1.payload.question]: "No" }, { round: "R2", toolUseId: "tu-R2" });
  return [L1, A1, R2, L2, answer(d1, { kind: "question", question: L2.id }), answer(r2, { kind: "question", question: L2.id })];
}, (b) => b.d1!.answers.length === 1 && rules(b.d1!, "F3", "settle") && standing(b.d1x!)!.options[0] === "No");
run("P1.a: a call answered before its round was posted binds to nothing", () => call(d1, "Settle", { answeredAt: "2026-09-22T23:00:00Z" }),
  (b) => !b.d1!.answers.length);
run("P1 (H6.1): one call answers a decision once", () => { const [L, A] = call(d1, "Settle"); return [L, A, answer(d1, { kind: "question", question: L.id })]; },
  (b) => b.d1!.answers.length === 1);
run("P1.c (B2.1): a verified page answer then an unverified relay — the ruling stands and the relay waits for you as a conflict", () => [page(d1, { option: "Settle" }), answer(d1, { kind: "unverified", words: "D1 B" }, agent, { relayedBy: "sess-A" })],
  (b, out) => standing(b.d1!)!.via === "direct" && rules(b.d1!, "F3", "settle") && b.d1!.answers[1]!.conflicts === true
    && waits(out, "d1", /unconfirmed answer disagrees/) && !awaitingReading(out).length);
run("P1.c: ...and your own later correction replaces the ruling and clears the conflict", () => [page(d1, { option: "Settle" }), answer(d1, { kind: "unverified", words: "D1 B" }), page(d1, { option: "No" })],
  (b, out) => standing(b.d1!)!.options[0] === "No" && !waits(out, "d1"));
run("P1.f (H6.8): your typed words after your own answer, read as the same pick, are no conflict", () => {
  const P = page(d1, { option: "Settle" });
  const A = msg(d1, "yes settle it");
  return [P, A, reading(A, [{ decision: "d1", option: "Settle" }])];
}, (b, out) => standing(b.d1!)!.via === "direct" && !b.d1!.answers[1]!.conflicts && !waits(out, "d1"));
run("P1.f: ...read as another pick, they are, and they change nothing", () => {
  const P = page(d1, { option: "Settle" });
  const A = msg(d1, "no, leave it");
  return [P, A, reading(A, [{ decision: "d1", option: "No" }])];
}, (b, out) => rules(b.d1!, "F3", "settle") && b.d1!.answers[1]!.conflicts === true && waits(out, "d1", /disagrees/));
run("P1.f: an agent's unconfirmed words after your answer are never sent to the reader", () => {
  const P = page(d1, { option: "Settle" });
  const A = answer(d1, { kind: "unverified", words: "actually fix it" }, agent, { relayedBy: "sess-A" });
  return [P, A, reading(A, [{ decision: "d1", option: "No" }])];
}, (b, out) => !b.d1!.answers[1]!.reading && !awaitingReading(out).length && rules(b.d1!, "F3", "settle"));
run("P1.d (H7.9): between two of your own answers the later GIVEN stands, not the later recorded", () => {
  // X answered at 10:00 and logged at 10:10; Y clicked at 10:05.
  const Y = page(d1, { option: "No" }); Y.at = "2026-09-23T10:05:00Z";
  const [L, X] = call(d1, "Settle", { answeredAt: "2026-09-23T10:00:00Z" }); X.at = "2026-09-23T10:10:00Z";
  return [Y, L, X];
}, (b) => standing(b.d1!)!.options[0] === "No" && b.d1!.answers[1]!.superseded === true);

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
run("bulk: unverified words with no known relayer cannot be read, and wait on you", () => [answer(d2, { kind: "unverified", words: "all fine" })],
  (b, out) => !ruled(b.d2!).length && awaitingReading(out).length === 0 && waits(out, "d2", /no known relayer/));
run("bulk: the page's checked list is a direct answer", () => [page(d2, { checked: ["Path fix"] })],
  (b) => rules(b.d2!, "F10", "settle") && !rules(b.d2!, "F11", "unblock") && standing(b.d2!)!.separately?.[0] === "Path fix");

// --- readings

run("C2: a reading maps free text onto another decision in the round", () => {
  const L = logQ([d1.payload], { [d1.payload.question]: "yes, and A for the other one" });
  const A = answer(d1, { kind: "question", question: L.id }, agent, { relayedBy: "sess-A" });
  return [L, A, reading(A, [{ decision: "d1", option: "Settle" }, { decision: "d4", option: "A" }])];
}, (b) => rules(b.d1!, "F3", "settle") && rules(b.d4!, "F30", "settle") && standing(b.d4!)!.own === false);
run("free text waits for its reading, which is an agent's job, not yours", () => call(d1, "yeah probably"),
  (b, out) => !ruled(b.d1!).length && held(out, "F3", "undecided") && awaitingReading(out).some((u) => u.decision === "d1") && !waits(out, "d1"));
run("readings that disagree rule nothing, are in dispute, and wait on you", () => {
  const [L, A] = call(d1, "hmm");
  return [L, A, reading(A, [{ decision: "d1", option: "Settle" }], [{ decision: "d1", option: "No" }])];
}, (b, out) => !ruled(b.d1!).length && readingsInDispute(out).some((x) => x.decision === "d1") && waits(out, "d1", /two different ways/));
run("a later answer clears a dispute — the facts live on the answer, so nothing is left to reset", () => {
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
run("P2: unverified words read as a park wait on you", () => {
  const A = answer(d3, { kind: "unverified", words: "later please" }, agent, { relayedBy: "sess-A" });
  return [A, reading(A, [{ decision: "d3", option: "Park until 2026-10-15" }])];
}, (b, out) => standing(b.d3!)!.parkWaits === "2026-10-15" && !standing(b.d3!)!.park && waits(out, "d3", /park/));
run("P2: ...and your later answer clears it", () => {
  const A = answer(d3, { kind: "unverified", words: "later please" }, agent, { relayedBy: "sess-A" });
  return [A, reading(A, [{ decision: "d3", option: "Park until 2026-10-15" }]), page(d3, { option: "Park until 2026-10-15" })];
}, (b, out) => standing(b.d3!)!.park === "2026-10-15" && !waits(out, "d3"));
// --- parks

run("a verified park by option label", () => call(d3, "Park until 2026-10-15"),
  (b, out) => standing(b.d3!)!.park === "2026-10-15" && held(out, "F20", "undecided"));
run("a person's park on the page", () => [page(d3, { park: "2026-11-01" })], (b) => standing(b.d3!)!.park === "2026-11-01");
run("a park on an unoffered date is accepted and flagged", () => [page(d3, { park: "2099-12-31" })],
  (b) => standing(b.d3!)!.park === "2099-12-31" && /not one this decision offered/.test(standing(b.d3!)!.flags?.[0] ?? ""));
run("a park on an offered date is not flagged", () => [page(d3, { park: "2026-10-15" })], (b) => !standing(b.d3!)!.flags);
run("a park date already past is flagged", () => [page(d3, { park: "2026-01-01" })],
  (b) => standing(b.d3!)!.flags?.some((f) => /already passed/.test(f)) === true);
run("an unverified agent park, read, applies nothing and waits on you", () => {
  const A = answer(d3, { kind: "unverified", words: "D3 park 2026-10-15" }, agent, { relayedBy: "sess-A" });
  return [A, reading(A, [{ decision: "d3", option: "Park until 2026-10-15" }])];
}, (b, out) => !standing(b.d3!)!.park && standing(b.d3!)!.parkWaits === "2026-10-15" && waits(out, "d3", /park/));

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
  delete L.data.round; delete L.data.answeredAt;
  return [L, answer(d1, { kind: "question", question: L.id })];
}, (b, out) => !b.d1!.answers.length && !out.questions.length);
run("DROP (H7.12): a message with no time", () => { const e = msg(d1, "D1 A"); delete e.data.via.at; return [e]; }, (b) => !b.d1!.answers.length);
run("DROP: a direct answer from an agent", () => [answer(d1, { kind: "direct", option: "Settle" })], (b) => !b.d1!.answers.length);
run("DROP: a reading by the relayer", () => {
  const [L, A] = call(d1, "hmm"); A.data.relayedBy = "sess-A";
  return [L, A, ev("decision.reading.recorded", { answer: A.id, reader: { transcript: "sess-A", reading: "r", maps: [{ decision: "d1", option: "Settle" }] }, session: { reading: "r", maps: [{ decision: "d1", option: "Settle" }] } })];
}, (b) => !ruled(b.d1!).length && !standing(b.d1!)!.reading);
run("DROP: the asking session reading its own answer, relayedBy omitted", () => {
  const [L, A] = call(d1, "hmm");
  return [L, A, ev("decision.reading.recorded", { answer: A.id, reader: { transcript: "sess-A", reading: "r", maps: [{ decision: "d1", option: "Settle" }] }, session: { reading: "r", maps: [{ decision: "d1", option: "Settle" }] } })];
}, (b) => !ruled(b.d1!).length);
run("DROP: an unverified relay with no relayer cannot be read", () => { const A = answer(d1, { kind: "unverified", words: "hmm" }); return [A, reading(A, [{ decision: "d1", option: "No" }])]; },
  (b) => !standing(b.d1!)!.reading);
run("DROP: a reading naming a decision in another round", () => {
  const other = reask(d4, "x4", "D4", "R2");
  const [L, A] = call(d1, "hmm");
  return [post("R2", [other]), L, A, reading(A, [{ decision: "x4", option: "A" }])];
}, (b) => !b.x4!.answers.length && !standing(b.d1!)!.reading);
run("DROP: a reading naming a decision already answered", () => {
  const [L, A] = call(d1, "hmm");
  return [page(d4, { option: "B" }), L, A, reading(A, [{ decision: "d4", option: "A" }])];
}, (b) => b.d4!.answers.length === 1 && !ruled(b.d4!).length);
run("DROP: an answer to a replaced decision", () => [post("R1b", [reask(d1, "d1b", "D7", "R1b", { supersedes: "d1" })]), page(d1, { option: "Settle" })],
  (b, out) => b.d1!.replacedBy === "d1b" && !b.d1!.answers.length && !waits(out, "d1"));
run("DROP: a second posting of a decision id cannot change it", () => [post("R1c", [{ ...d1, payload: q("D1: something else about F3 and F7?", ["Settle", "No"]), round: "R1c" }])],
  (b) => b.d1!.payload.question === "D1: approve the fix for F3 and F7?");
run("DROP: an answer value that is neither text nor a list of text", () => call(d1, { label: "Settle" }), (b) => !b.d1!.answers.length);
run("P1: an unverified pick of the park option does not displace your own answer", () => [page(d3, { option: "Now" }), answer(d3, { kind: "unverified", words: "D3 A" })],
  (b, out) => b.d3!.answers.length === 2 && rules(b.d3!, "F20", "unblock") && !standing(b.d3!)!.parkWaits && waits(out, "d3", /disagrees/));
run("P3: free text on a words decision is never read", () => {
  const A = msg(d5, "Ship it, and A for D4");
  return [A, reading(A, [{ decision: "d4", option: "A" }])];
}, (b) => !b.d4!.answers.length);
run("P4 (R23): a reading of an answer whose question was since replaced is dropped", () => {
  const [L, A] = call(d1, "hmm");
  return [L, A, post("R1b", [reask(d1, "d1b", "D7", "R1b", { supersedes: "d1" })]), reading(A, [{ decision: "d4", option: "A" }])];
}, (b) => !b.d4!.answers.length && !b.d1!.answers[0]!.reading);

// --- what posting refuses (the fold drops exactly what the ops refuse)

const refused = (d: any, prevalidated = false) => checkDecision(d, prevalidated);
test("posting refuses what the rulings forbid, and accepts the same decision without the fault", () => {
  const good = D("dx", "D9", q("D9: is F1 real?", ["A", "B"]), [{ label: "A", effects: [settle("F1")] }, { label: "B", effects: [] }]);
  assert.equal(refused(good), null, "the positive every refusal below varies");
  assert.match(refused({ ...good, options: [{ label: "A", effects: [{ findings: ["F1"], on: "settle" }] }, good.options[1]] })!, /must say how it closes/);
  assert.match(refused({ ...good, options: [{ label: "A", effects: [{ findings: ["F1"], on: "settle", as: "accepted" }] }, good.options[1]] })!, /must say how it closes/);
  assert.match(refused({ ...good, options: [{ label: "A", effects: [{ findings: ["F1"], on: "unblock", as: "refuted" }] }, good.options[1]] })!, /takes no `as`/);
  assert.match(refused({ ...good, options: [{ label: "A", effects: [settle()] }, good.options[1]] })!, /needs findings/);
  const multiPark = D("dp", "D8", q("D8: park?", ["Park until 2026-10-15", "Now"], true), [{ label: "Park until 2026-10-15", effects: [], park: "2026-10-15" }, { label: "Now", effects: [] }]);
  assert.equal(refused({ ...multiPark, payload: { ...multiPark.payload, multiSelect: false } }), null);
  assert.match(refused(multiPark)!, /multi-select question cannot offer a park/);
  assert.match(refused({ ...good, options: [{ ...good.options[0], park: "2026-10-15" }, good.options[1]] })!, /without its date/);
  const closes = { ...good, options: [{ ...good.options[0], closesOnAnswer: true }, good.options[1]] };
  assert.equal(refused(closes, true), null);
  assert.match(refused(closes)!, /only a pre-validated round/);
  assert.match(refused({ ...good, options: [{ label: "A", effects: [unblock("F1")], closesOnAnswer: true }, good.options[1]] }, true)!, /settles nothing/);
  assert.equal(refused(d2), null);
  assert.match(refused({ ...d2, payload: { ...d2.payload, multiSelect: false } })!, /bulk decision is a multi-select/);
  assert.match(refused({ ...d2, options: d2.options.map((o: any) => ({ ...o, approveAll: undefined })) })!, /exactly one approve-all/);
  assert.match(refused({ ...good, options: [{ ...good.options[0] }, { ...good.options[1], approveAll: true }] })!, /only a bulk decision/);
  assert.match(refused({ ...d5, options: [{ label: "x", effects: [settle("F1")] }, { label: "y", effects: [] }] })!, /words decision has no effects/);
  // P1.g (H5): what the person is shown names what it acts on.
  assert.match(refused({ ...good, payload: { ...good.payload, question: "is F1 real?" } })!, /must name its ref D9/);
  assert.match(refused({ ...good, payload: { ...good.payload, question: "D90: is F1 real?" } })!, /must name its ref D9/, "D90 is not D9");
  assert.match(refused({ ...good, payload: { ...good.payload, question: "D9: is it real?" } })!, /must name F1/);
});
run("DROP: a round that is not pre-validated cannot carry a close-on-answer option", () => {
  const c = { ...D("dc", "D9", q("D9: close F1?", ["A", "B"]), [{ label: "A", effects: [settle("F1")], closesOnAnswer: true }, { label: "B", effects: [] }]), round: "RC" };
  return [post("RC", [c]), post("RD", [{ ...c, id: "dd", round: "RD" }], { prevalidated: { record: "r", sortedBy: "two sorters and an arbitrator" } })];
}, (b) => !b.dc && !!b.dd);

const PV = { prevalidated: { record: "r", sortedBy: "two sorters and an arbitrator" } };
const cd = { ...D("dd", "D9", q("D9: close F1, release F2?", ["A", "B"]), [{ label: "A", effects: [settle("F1"), unblock("F2")], closesOnAnswer: true }, { label: "B", effects: [] }]), round: "RD" };
const cd2 = { ...D("de", "D10", q("D10: close F4?", ["Agree", "No"]), [{ label: "Agree", effects: [settle("F4")], closesOnAnswer: true }, { label: "No", effects: [] }]), round: "RD" };
run("a close-on-answer option's settle is ruled as closing on answer, when you picked it", () => [post("RD", [cd], PV), page(cd, { option: "A" })],
  (b) => ruled(b.dd!).some((r) => r.finding === "F1" && r.closesOnAnswer) && ruled(b.dd!).some((r) => r.finding === "F2" && !r.closesOnAnswer));
run("P2.a (B2.2): words read onto a pre-staged question you were never shown rule it, and close nothing", () => {
  const RD = post("RD", [cd, cd2], PV);
  const L = logQ([cd.payload], { [cd.payload.question]: "B, and agree on the other" }, { round: "RD" });
  const A = answer(cd, { kind: "question", question: L.id });
  return [RD, L, A, reading(A, [{ decision: "dd", option: "B" }, { decision: "de", option: "Agree" }])];
}, (b, out) => rules(b.de!, "F4", "settle") && !ruled(b.de!).some((r) => r.closesOnAnswer) && held(out, "F4", "ruled"));
run("P2.g (H6.7): 'Other' text in a logged call, read onto the close option, rules and is held", () => {
  const RD = post("RD", [cd2], PV);
  const L = logQ([cd2.payload], { [cd2.payload.question]: "yes agree, close it" }, { round: "RD" });
  const A = answer(cd2, { kind: "question", question: L.id });
  return [RD, L, A, reading(A, [{ decision: "de", option: "Agree" }])];
}, (b, out) => rules(b.de!, "F4", "settle") && !ruled(b.de!).some((r) => r.closesOnAnswer) && held(out, "F4", "ruled"));
run("a logged call's own pick of a close option closes on answer", () => {
  const RD = post("RD", [cd2], PV);
  const L = logQ([cd2.payload], { [cd2.payload.question]: "Agree" }, { round: "RD" });
  return [RD, L, answer(cd2, { kind: "question", question: L.id })];
}, (b) => ruled(b.de!).some((r) => r.finding === "F4" && r.closesOnAnswer));

test("garbage events are dropped, never thrown on", () => {
  const junk: any[] = [
    ev("decision.round.posted", { round: { id: "RX", source: "x" }, decisions: [null, "str", { id: "dx", round: "RX", ref: "D1", kind: "options", payload: { question: "q", options: [null] }, options: [{ label: "a" }] },
      { id: "dy", round: "RX", ref: "D2", kind: "options", payload: { question: "q", options: [{ label: "a" }] }, options: [{ label: "a" }] },
      { id: "dz", round: "RX", ref: "D3", kind: "options", payload: { question: "q", options: [{ label: "a" }] }, options: [{ label: "a", effects: [null] }] },
      { id: "dw", round: "RX", ref: [], kind: "options", payload: { question: "q", options: [{ label: "a" }] }, options: [{ label: "a", effects: [] }] }] }),
    ev("decision.round.posted", null),
    ev("decision.round.posted", { round: "R", decisions: [] }),
    ev("decision.question.logged", { session: "s", toolUseId: "t", questions: [null, 3], answers: {}, round: "R1", answeredAt: at(9) }),
    ev("decision.question.logged", { session: "s", toolUseId: "t2", questions: [], answers: [], round: "R1", answeredAt: at(9) }),
    ev("decision.answer.recorded", { decision: "d1", hash: h(d1), via: null }),
    ev("decision.answer.recorded", { decision: "d2", hash: h(d2), via: { kind: "direct", checked: "x" } }, person),
    ev("decision.answer.recorded", { decision: "d3", hash: h(d3), via: { kind: "direct", park: 5 } }, person),
    ev("decision.answer.recorded", { decision: "d1", hash: h(d1), via: { kind: "message", session: "s", entryId: "u", text: "D1 A", at: "not a time", round: "R1" } }),
    ev("decision.reading.recorded", { answer: "nope", reader: null }),
    ev("decision.reading.recorded", null),
  ];
  const out = foldDecisions([round, ...junk]);
  assert.equal(out.decisions.length, 5, "the good round stands; the garbage adds nothing");
  assert.equal(out.questions.length, 0);
  assert.ok(out.decisions.every((d) => !d.answers.length));
});

// --- P3: the hold outlives its question until the question is answered again

const d1b = reask(d1, "d1b", "D7", "R1b", { supersedes: "d1", options: [{ label: "Settle", effects: [settle("F3"), unblock("F7")] }, { label: "No", effects: [unblock("F3")] }] });
const replaced = (out: SharedDecisions, f: string) => ruledNotCarriedOut(out, () => true).some((u) => u.decision === "d1" && u.finding === f && u.replacedBy === "d1b");
run("P3.a (B2.4): a ruling on a question since replaced holds, and is listed replaced, until the replacement is answered", () =>
  [page(d1, { option: "Settle" }), post("R1b", [d1b])],
  (b, out) => held(out, "F3", "ruled") && replaced(out, "F3") && !waits(out, "d1") && waits(out, "d1b", /not answered/));
run("P3.a: ...and the replacement's answer decides: 'No' releases F3 as fix work", () =>
  [page(d1, { option: "Settle" }), post("R1b", [d1b]), page(d1b, { option: "No" })],
  (b, out) => !held(out, "F3", "ruled") && !replaced(out, "F3") && rules(b.d1b!, "F3", "unblock"));
run("P3.b (bulk 1): a settled finding that has since closed is held by nothing", () => [page(d1, { option: "Settle" })],
  (b, out) => held(out, "F3", "ruled") && !held(out, "F3", undefined, (f) => f !== "F3"));
const dS = D("dS", "D8", q("D8: are F1 and F2 real?", ["Not defects", "Real"]), [{ label: "Not defects", effects: [settle("F1", "F2")] }, { label: "Real", effects: [unblock("F1", "F2")] }]);
const dSb = { ...D("dSb", "D1", q("D1: is F1 real?", ["Not a defect", "Real, fix F1"]), [{ label: "Not a defect", effects: [settle("F1")] }, { label: "Real, fix F1", effects: [unblock("F1")] }]), round: "R2", supersedes: "dS" };
run("P3.d (H4): a replacement takes over only the findings it names", () =>
  [post("RS", [{ ...dS, round: "RS" }]), page({ ...dS, round: "RS" }, { option: "Not defects" }), post("R2", [dSb]), page(dSb, { option: "Real, fix F1" })],
  (b, out) => !held(out, "F1", "ruled") && held(out, "F2", "ruled") && ruledNotCarriedOut(out, () => true).some((u) => u.decision === "dS" && u.finding === "F2" && u.replacedBy === "dSb"));
run("P3.e + P3.f (H6.2): an unconfirmed answer on the replacement leaves your ruling standing, and waits for you", () => {
  const A = answer(d1b, { kind: "unverified", words: "no, fix it" }, agent, { relayedBy: "sess-A" });
  return [page(d1, { option: "Settle" }), post("R1b", [d1b]), A, reading(A, [{ decision: "d1b", option: "No" }])];
}, (b, out) => rules(b.d1b!, "F3", "unblock") && held(out, "F3", "ruled") && replaced(out, "F3") && waits(out, "d1b", /disagrees with your ruling on D1/));
run("P3.g (H6.3): the ruling passes down a chain until a later question is answered", () => {
  const d1c = reask(d1b, "d1c", "D9", "R1c", { supersedes: "d1b" });
  return [page(d1, { option: "Settle" }), post("R1b", [d1b]), post("R1c", [d1c])];
}, (b, out) => held(out, "F3", "ruled") && replaced(out, "F3"));
run("P3.g: ...and the later answer takes it over", () => {
  const d1c = reask(d1b, "d1c", "D9", "R1c", { supersedes: "d1b" });
  return [page(d1, { option: "Settle" }), post("R1b", [d1b]), post("R1c", [d1c]), page(d1c, { option: "No" })];
}, (b, out) => !held(out, "F3", "ruled") && !replaced(out, "F3"));
run("P3.h (H6.4): of two replacements from two clones the first in log order replaces; the second is live and flagged", () =>
  [post("R1b", [d1b]), post("R1x", [reask(d1b, "d1x", "D8", "R1x")])],
  (b, out) => b.d1!.replacedBy === "d1b" && b.d1x!.replaceLost === "d1b" && waits(out, "d1x", /conflicting replacement/) && waits(out, "d1x", /not answered/));

// --- P4: the views, and parks

const isParked = (out: SharedDecisions, id: string, today: string) => parked(out, today).some((p) => p.decision === id);
run("P4.a (B3.1, H6.5–6.6): a park is under Parked, not waiting on you, through the whole of its date", () => [page(d3, { option: "Park until 2026-10-15" })],
  (b, out) => ["2026-10-14", "2026-10-15"].every((t) => isParked(out, "d3", t) && !waits(out, "d3", undefined, t))
    && parked(out, "2026-10-15")[0]!.until === "2026-10-15" && parked(out, "2026-10-15")[0]!.findings.includes("F20"));
run("P4.a: ...and the day after, it is yours again, its findings still held as undecided", () => [page(d3, { option: "Park until 2026-10-15" })],
  (b, out) => !isParked(out, "d3", "2026-10-16") && waits(out, "d3", /parked until 2026-10-15, which has passed/, "2026-10-16") && held(out, "F20", "undecided"));
run("P4.a (B4.1): words read as a park, the two readings agreeing, park — and show under Parked", () => {
  const [L, A] = call(d3, "park it till mid October");
  return [L, A, reading(A, [{ decision: "d3", option: "Park until 2026-10-15" }])];
}, (b, out) => isParked(out, "d3", "2026-09-23"));
run("P4.a (B4.1): read two ways, nothing parks and it waits on you", () => {
  const [L, A] = call(d3, "later, maybe");
  return [L, A, reading(A, [{ decision: "d3", option: "Park until 2026-10-15" }], [{ decision: "d3", option: null }])];
}, (b, out) => !isParked(out, "d3", "2026-09-23") && waits(out, "d3") && readingsInDispute(out).some((x) => x.decision === "d3"));
run("P4.b (Q11): 'not sure, ask bob', read as nothing on both sides, stays waiting on you", () => {
  const [L, A] = call(d1, "not sure, ask bob");
  return [L, A, reading(A, [{ decision: "d1", option: null }])];
}, (b, out) => waits(out, "d1", /rule nothing/) && held(out, "F3", "undecided") && !awaitingReading(out).length);
run("P4.c (Q13): a follow-up to a reading's copy attaches to the decision the copy is on", () => {
  const [L, A] = call(d1, "settle, and on the bulk one take the rename separately");
  const R = reading(A, [{ decision: "d1", option: "Settle" }, { decision: "d2", option: "Rename fix" }]);
  const copy = `${R.id}/d2`;
  const nd = { ...D("d9", "D9", q("D9: Rename fix — settle F10?", ["Yes", "No"]), [{ label: "Yes", effects: [settle("F10")] }, { label: "No", effects: [] }]), round: "R2", origin: { answer: copy } };
  return [L, A, R, post("R2", [nd])];
}, (b, out) => standing(b.d2!)!.separately?.[0] === "Rename fix" && (b.d2!.followUps ?? []).includes("d9") && !waits(out, "d2", /Rename fix/));
test("P5 (bulk 8): two options sharing a label are refused", () => {
  assert.match(checkDecision(D("dl", "D9", q("D9: is F1 real?", ["A", "A"]), [{ label: "A", effects: [settle("F1")] }, { label: "A", effects: [] }]))!, /share a label/);
});

// --- P7 + H8: a typed reply bound by a verified reader is the person's own answer

const verified = { verified: { session: "sess-A", toolUseId: "tu-agent" } };
const vreading = (a: any, maps: any[]) => ev("decision.reading.recorded", { answer: a.id, reader: { transcript: "a0000000000000b01", reading: "r", maps, ...verified }, session: { reading: "r", maps } });
run("H8: 'D9 A' bound by a verified reader to a pre-staged question closes on answer, and is your own", () => {
  const RD = post("RD", [cd2], PV);
  const A = msg(cd2, "D10 Agree");
  return [RD, A, vreading(A, [{ decision: "de", option: "Agree" }])];
}, (b) => ruled(b.de!).some((r) => r.finding === "F4" && r.closesOnAnswer) && standing(b.de!)!.own === true);
run("H8: ...the same reply with an unverified reader rules and is held", () => {
  const RD = post("RD", [cd2], PV);
  const A = msg(cd2, "D10 Agree");
  return [RD, A, reading(A, [{ decision: "de", option: "Agree" }])];
}, (b, out) => rules(b.de!, "F4", "settle") && !ruled(b.de!).some((r) => r.closesOnAnswer) && held(out, "F4", "ruled"));
run("H8 + H7.9: your typed correction after a page click, once verified, replaces it if given later", () => {
  const P = page(d1, { option: "Settle" });
  const A = msg(d1, "no, leave it");
  return [P, A, vreading(A, [{ decision: "d1", option: "No" }])];
}, (b, out) => standing(b.d1!)!.via === "message" && standing(b.d1!)!.options[0] === "No" && !held(out, "F3", "ruled") && !waits(out, "d1"));
run("H8 + H7.9: ...and not if it was typed before the click", () => {
  // Clicked at 00:00:02; typed at 00:00:01.5 and relayed after the click.
  const P = page(d1, { option: "Settle" });
  const A = msg(d1, "no, leave it", "u1", "2026-09-23T00:00:01.500Z");
  return [P, A, vreading(A, [{ decision: "d1", option: "No" }])];
}, (b) => standing(b.d1!)!.via === "direct" && b.d1!.answers[1]!.superseded === true && !b.d1!.answers[1]!.conflicts);
run("H8: a verified reader's copy onto another question is still never your own", () => {
  const M = msg(d1, "settle, and A on the other");
  return [M, vreading(M, [{ decision: "d1", option: "Settle" }, { decision: "d4", option: "A" }])];
}, (b) => standing(b.d1!)!.own === true && standing(b.d4!)!.own === false);
