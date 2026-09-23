/**
 * The decision-round fold, run on hand-built events — the way this codebase reviews a fold
 * (CLAUDE.md, "To review a fold, RUN it"). The cases carried from the first build are the
 * sequences its two review rounds argued over; the rulings behind each are in
 * docs/decision-rounds-worked-cases.md. There is no state label to assert on: each case
 * asserts on the standing answer's facts and on the three views, because those are what the
 * person and the agents actually read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  foldDecisions, decisionHash, checkDecision, heldFindings, standing, waitingOnMe, readingsInDispute, ruledNotCarriedOut, awaitingReading,
  type FoldedDecision, type SharedDecisions,
} from "./shared-decisions.js";

const person: any = { principal: "izzie" };
const agent: any = { principal: "izzie", via: { kind: "agent", model: "m" } };
let n = 0;
const ev = (kind: string, data: any, actor: any = agent): any => ({ id: `e${++n}`, kind, subject: "s", actor, at: `2026-09-23T00:00:${String(n).padStart(2, "0")}Z`, after: [], data });
const q = (question: string, labels: string[], multi?: boolean): any => ({ question, header: "H", options: labels.map((l) => ({ label: l, description: "d" })), ...(multi ? { multiSelect: true } : {}) });
const D = (id: string, ref: string, payload: any, options: any[], extra: any = {}): any => ({ id, round: "R1", ref, kind: "options", payload, options, ...extra });
const settle = (...findings: string[]) => ({ findings, on: "settle", as: "refuted" });
const unblock = (...findings: string[]) => ({ findings, on: "unblock" });

const d1 = D("d1", "D1", q("Approve fix?", ["Settle", "No"]), [
  { label: "Settle", effects: [settle("F3"), unblock("F7")], recommended: true },
  { label: "No", effects: [] }]);
const d2 = D("d2", "D2", q("Check any to rule on separately", ["Rename fix", "Path fix", "None — approve all"], true), [
  { label: "Rename fix", effects: [settle("F10")] }, { label: "Path fix", effects: [unblock("F11")] },
  { label: "None — approve all", effects: [], approveAll: true }], { kind: "bulk" });
const d3 = D("d3", "D3", q("Park?", ["Park until 2026-10-15", "Now"]), [
  { label: "Park until 2026-10-15", effects: [], park: "2026-10-15" }, { label: "Now", effects: [unblock("F20")] }]);
const d4 = D("d4", "D4", q("Other one?", ["A", "B"]), [{ label: "A", effects: [settle("F30")] }, { label: "B", effects: [] }]);
const d5 = { ...D("d5", "D5", q("The goal, in your words?", ["x", "y"]), [{ label: "x", effects: [] }, { label: "y", effects: [] }]), kind: "words" };
const round = ev("decision.round.posted", { round: { id: "R1", source: "plan-x", universe: "u" }, decisions: [d1, d2, d3, d4, d5] });
const h = (d: any) => decisionHash(d);

type B = Record<string, FoldedDecision>;
const run = (name: string, extra: () => any[], check: (b: B, out: SharedDecisions) => boolean) => test(name, () => {
  n = 1;
  const out = foldDecisions([round, ...extra()]);
  const byId: B = Object.fromEntries(out.decisions.map((d) => [d.id, d]));
  assert.ok(check(byId, out), JSON.stringify(byId, null, 1).slice(0, 2000));
});
const logQ = (qs: any[], answers: any, transcript = "sess-A") => ev("decision.question.logged", { session: "sess-A", toolUseId: "tu1", questions: qs, answers, transcript });
const answer = (d: any, via: any, actor: any = agent, extra: any = {}) => ev("decision.answer.recorded", { decision: d.id, hash: h(d), via, ...extra }, actor);
const msg = (d: any, text: string, entryId = "u1") => answer(d, { kind: "message", session: "s", entryId, text });
const reading = (a: any, maps: any[], session = maps, extra: any = {}) =>
  ev("decision.reading.recorded", { answer: a.id, reader: { transcript: "agent-B", reading: "r", maps }, session: { reading: "r", maps: session }, ...extra });

const ruled = (d: FoldedDecision) => standing(d)?.ruled ?? [];
const rules = (d: FoldedDecision, f: string, on: string) => ruled(d).some((r) => r.finding === f && r.on === on);
const waits = (out: SharedDecisions, id: string, re?: RegExp) => waitingOnMe(out).some((w) => w.decision === id && (!re || re.test(w.why)));
const held = (out: SharedDecisions, f: string, why?: string) => (heldFindings(out).get(f) ?? []).some((x) => !why || x.why === why);

// --- what an answer rules

run("a verified answer rules both effects; the settle holds its finding for the verifier, the unblock releases", () => {
  const L = logQ([{ ...d1.payload, multiSelect: undefined }], { "Approve fix?": "Settle" });
  return [L, answer(d1, { kind: "question", question: L.id })];
}, (b, out) => rules(b.d1!, "F3", "settle") && rules(b.d1!, "F7", "unblock")
  && held(out, "F3", "ruled") && !held(out, "F7") && !waits(out, "d1"));
run("an unanswered decision waits on you and holds everything it could touch", () => [],
  (b, out) => waits(out, "d1", /not answered/) && held(out, "F3", "undecided") && held(out, "F7", "undecided"));
run("an unverified relay unblocks; its settle waits for you and stays held", () => [answer(d1, { kind: "unverified", words: "D1 yes" })],
  (b, out) => rules(b.d1!, "F7", "unblock") && !rules(b.d1!, "F3", "settle") && standing(b.d1!)!.unruled.includes("F3")
    && waits(out, "d1", /could not be verified/) && held(out, "F3", "undecided") && !held(out, "F7"));
run("a typed 'D1 yes' from the transcript rules the recommended option", () => [msg(d1, "D1 yes")], (b) => rules(b.d1!, "F3", "settle"));
run("C3: a later answer replaces the earlier as the ruling; the earlier's settle no longer holds", () => [msg(d1, "D1 A"), msg(d1, "D1 B", "u2")],
  (b, out) => b.d1!.answers[0]!.superseded === true && standing(b.d1!)!.options[0] === "No" && !held(out, "F3"));
run("a words decision is recorded, never read, and rules nothing", () => {
  const L = logQ([d5.payload], { "The goal, in your words?": "Ship it" });
  return [L, answer(d5, { kind: "question", question: L.id })];
}, (b, out) => standing(b.d5!)!.words === "Ship it" && !ruled(b.d5!).length && !waits(out, "d5") && !awaitingReading(out).length);

// --- carrying out is the finding record's to answer

run("ruled, not carried out: listed while the finding is open, gone once it closes", () => [msg(d1, "D1 A")], (b, out) => {
  const open = ruledNotCarriedOut(out, () => true);
  const closed = ruledNotCarriedOut(out, (f) => f !== "F3");
  return open.some((u) => u.finding === "F3" && u.on === "settle" && u.ruler === "izzie") && open.some((u) => u.finding === "F7" && u.on === "unblock")
    && !closed.some((u) => u.finding === "F3");
});

// --- bulk: checked = rule separately, the rest approved

run("bulk: 'None — approve all' rules every item", () => {
  const L = logQ([d2.payload], { [d2.payload.question]: ["None — approve all"] });
  return [L, answer(d2, { kind: "question", question: L.id })];
}, (b, out) => rules(b.d2!, "F10", "settle") && rules(b.d2!, "F11", "unblock") && !waits(out, "d2"));
run("bulk: a checked item is ruled on separately and waits until it is asked; the rest are approved", () => {
  const L = logQ([d2.payload], { [d2.payload.question]: ["Rename fix"] });
  return [L, answer(d2, { kind: "question", question: L.id })];
}, (b, out) => !rules(b.d2!, "F10", "settle") && rules(b.d2!, "F11", "unblock") && held(out, "F10", "undecided")
  && waits(out, "d2", /Rename fix/));
run("bulk: the separate question, once posted, stops the wait", () => {
  const L = logQ([d2.payload], { [d2.payload.question]: ["Rename fix"] });
  const A = answer(d2, { kind: "question", question: L.id });
  const nd = { ...D("d9", "D9", q("Rename fix: settle it?", ["Yes", "No"]), [{ label: "Yes", effects: [settle("F10")] }, { label: "No", effects: [] }]), round: "R2", origin: { answer: A.id } };
  return [L, A, ev("decision.round.posted", { round: { id: "R2", source: "plan-x" }, decisions: [nd] })];
}, (b, out) => !waits(out, "d2") && waits(out, "d9", /not answered/));
run("bulk: approve-all beside a checked item says two things, so it is read, not guessed", () => {
  const L = logQ([d2.payload], { [d2.payload.question]: ["Rename fix", "None — approve all"] });
  return [L, answer(d2, { kind: "question", question: L.id })];
}, (b, out) => !ruled(b.d2!).length && awaitingReading(out).some((u) => u.decision === "d2"));
run("bulk: a typed Other element makes the whole answer the reader's", () => {
  const L = logQ([d2.payload], { [d2.payload.question]: ["Path fix", "and talk to me about the tag"] });
  return [L, answer(d2, { kind: "question", question: L.id })];
}, (b, out) => !ruled(b.d2!).length && awaitingReading(out).some((u) => u.decision === "d2"));
run("bulk: an unverified approve-all unblocks and leaves its settles waiting on you", () => [answer(d2, { kind: "direct", checked: ["None — approve all"] }, person), answer(d2, { kind: "unverified", words: "all fine" })],
  (b, out) => !ruled(b.d2!).length && awaitingReading(out).length === 0 && waits(out, "d2", /no known relayer/));
run("bulk: the page's checked list is a direct answer", () => [answer(d2, { kind: "direct", checked: ["Path fix"] }, person)],
  (b) => rules(b.d2!, "F10", "settle") && !rules(b.d2!, "F11", "unblock") && standing(b.d2!)!.separately?.[0] === "Path fix");

// --- readings

run("C2: a reading maps free text onto another decision in the round", () => {
  const L = logQ([d1.payload], { "Approve fix?": "yes, and A for the other one" });
  const A = answer(d1, { kind: "question", question: L.id }, agent, { relayedBy: "sess-A" });
  return [L, A, reading(A, [{ decision: "d1", option: "Settle" }, { decision: "d4", option: "A" }])];
}, (b) => rules(b.d1!, "F3", "settle") && rules(b.d4!, "F30", "settle"));
run("free text waits for its reading, which is an agent's job, not yours", () => {
  const L = logQ([d1.payload], { "Approve fix?": "yeah probably" });
  return [L, answer(d1, { kind: "question", question: L.id })];
}, (b, out) => !ruled(b.d1!).length && held(out, "F3", "undecided") && awaitingReading(out).some((u) => u.decision === "d1") && !waits(out, "d1"));
run("readings that disagree rule nothing, are in dispute, and wait on you", () => {
  const L = logQ([d1.payload], { "Approve fix?": "hmm" });
  const A = answer(d1, { kind: "question", question: L.id });
  return [L, A, reading(A, [{ decision: "d1", option: "Settle" }], [{ decision: "d1", option: "No" }])];
}, (b, out) => !ruled(b.d1!).length && readingsInDispute(out).some((x) => x.decision === "d1") && waits(out, "d1", /two different ways/));
run("a later answer clears a dispute — the facts live on the answer, so nothing is left to reset", () => {
  const L = logQ([d1.payload], { "Approve fix?": "hmm" });
  const A = answer(d1, { kind: "question", question: L.id });
  return [L, A, reading(A, [{ decision: "d1", option: "Settle" }], [{ decision: "d1", option: "No" }]), msg(d1, "D1 B", "u9")];
}, (b, out) => !readingsInDispute(out).length && !waits(out, "d1"));
run("C1: a reading's asks is kept on the answer", () => {
  const L = logQ([d1.payload], { "Approve fix?": "Settle, and document them" });
  const A = answer(d1, { kind: "question", question: L.id });
  return [L, A, reading(A, [{ decision: "d1", option: "Settle" }], undefined, { asks: "document them" })];
}, (b) => rules(b.d1!, "F3", "settle") && standing(b.d1!)!.reading?.asks === "document them");
run("a read park option parks", () => {
  const L = logQ([d3.payload], { "Park?": "park it till mid October" });
  const A = answer(d3, { kind: "question", question: L.id });
  return [L, A, reading(A, [{ decision: "d3", option: "Park until 2026-10-15" }])];
}, (b) => standing(b.d3!)!.park === "2026-10-15");
run("P2: unverified words read as a park wait on you, and a later verified answer clears it", () => {
  const A = answer(d3, { kind: "unverified", words: "later please" }, agent, { relayedBy: "sess-A" });
  return [A, reading(A, [{ decision: "d3", option: "Park until 2026-10-15" }])];
}, (b, out) => standing(b.d3!)!.parkWaits === "2026-10-15" && !standing(b.d3!)!.park && waits(out, "d3", /park/));
run("P2: ...and the later answer", () => {
  const A = answer(d3, { kind: "unverified", words: "later please" }, agent, { relayedBy: "sess-A" });
  return [A, reading(A, [{ decision: "d3", option: "Park until 2026-10-15" }]), msg(d3, "D3 A", "u2")];
}, (b, out) => standing(b.d3!)!.park === "2026-10-15" && !waits(out, "d3"));

// --- parks

run("a verified park by option label", () => { const L = logQ([d3.payload], { "Park?": "Park until 2026-10-15" }); return [L, answer(d3, { kind: "question", question: L.id })]; },
  (b, out) => standing(b.d3!)!.park === "2026-10-15" && held(out, "F20", "undecided"));
run("a person's park on the page", () => [answer(d3, { kind: "direct", park: "2026-11-01" }, person)], (b) => standing(b.d3!)!.park === "2026-11-01");
run("a typed park on an unoffered date is accepted and flagged", () => [msg(d3, "D3 park 2099-12-31")],
  (b) => standing(b.d3!)!.park === "2099-12-31" && /not one this decision offered/.test(standing(b.d3!)!.flags?.[0] ?? ""));
run("a park on an offered date is not flagged", () => [msg(d3, "D3 park 2026-10-15")], (b) => !standing(b.d3!)!.flags);
run("a park date already past is flagged", () => [answer(d3, { kind: "direct", park: "2026-01-01" }, person)],
  (b) => standing(b.d3!)!.flags?.some((f) => /already passed/.test(f)) === true);
run("an unverified agent park applies nothing and waits on you", () => [answer(d3, { kind: "unverified", words: "D3 park 2026-10-15" })],
  (b, out) => !standing(b.d3!)!.park && standing(b.d3!)!.parkWaits === "2026-10-15" && waits(out, "d3", /park/));

// --- drops

run("a words decision answered with a letter still records only the words", () => [msg(d5, "D5 A")],
  (b) => standing(b.d5!)!.words === "D5 A" && !standing(b.d5!)!.options.length);
run("DROP: hash mismatch", () => [ev("decision.answer.recorded", { decision: "d1", hash: "d:sha256:bad", via: { kind: "message", session: "s", entryId: "u1", text: "D1 yes" } })], (b) => !b.d1!.answers.length);
run("DROP: the logged question was paraphrased", () => { const L = logQ([{ ...d1.payload, question: "Approve the fix?" }], { "Approve the fix?": "Settle" }); return [L, answer(d1, { kind: "question", question: L.id })]; }, (b) => !b.d1!.answers.length);
run("DROP: an option reworded in the logged call", () => { const L = logQ([{ ...d1.payload, options: [{ label: "Settle", description: "closes F3 and more" }, { label: "No", description: "d" }] }], { "Approve fix?": "Settle" }); return [L, answer(d1, { kind: "question", question: L.id })]; }, (b) => !b.d1!.answers.length);
run("DROP: a direct answer from an agent", () => [answer(d1, { kind: "direct", option: "Settle" })], (b) => !b.d1!.answers.length);
run("DROP: a reading by the relayer", () => { const L = logQ([d1.payload], { "Approve fix?": "hmm" }); const A = answer(d1, { kind: "question", question: L.id }, agent, { relayedBy: "sess-A" });
  return [L, A, ev("decision.reading.recorded", { answer: A.id, reader: { transcript: "sess-A", reading: "r", maps: [{ decision: "d1", option: "Settle" }] }, session: { reading: "r", maps: [{ decision: "d1", option: "Settle" }] } })]; },
  (b) => !ruled(b.d1!).length && !standing(b.d1!)!.reading);
run("DROP: the asking session reading its own answer, relayedBy omitted", () => { const L = logQ([d1.payload], { "Approve fix?": "hmm" }); const A = answer(d1, { kind: "question", question: L.id });
  return [L, A, ev("decision.reading.recorded", { answer: A.id, reader: { transcript: "sess-A", reading: "r", maps: [{ decision: "d1", option: "Settle" }] }, session: { reading: "r", maps: [{ decision: "d1", option: "Settle" }] } })]; },
  (b) => !ruled(b.d1!).length);
run("DROP: an unverified relay with no relayer cannot be read", () => { const A = answer(d1, { kind: "unverified", words: "hmm" }); return [A, reading(A, [{ decision: "d1", option: "No" }])]; },
  (b) => !standing(b.d1!)!.reading);
run("DROP: a reading naming a decision in another round", () => { const other = { ...d4, id: "x4", round: "R2" }; const L = logQ([d1.payload], { "Approve fix?": "hmm" }); const A = answer(d1, { kind: "question", question: L.id }, agent, { relayedBy: "sess-A" });
  return [ev("decision.round.posted", { round: { id: "R2", source: "y" }, decisions: [other] }), L, A, reading(A, [{ decision: "x4", option: "A" }])]; },
  (b) => !b.x4!.answers.length && !standing(b.d1!)!.reading);
run("DROP: a reading naming a decision already answered", () => { const L = logQ([d1.payload], { "Approve fix?": "hmm" }); const A = answer(d1, { kind: "question", question: L.id }, agent, { relayedBy: "sess-A" });
  return [msg(d4, "D4 B", "u9"), L, A, reading(A, [{ decision: "d4", option: "A" }])]; }, (b) => b.d4!.answers.length === 1 && !ruled(b.d4!).length);
run("DROP: 'do not D1 yes' is not a reply", () => [msg(d1, "do not D1 yes")], (b, out) => !ruled(b.d1!).length && awaitingReading(out).some((u) => u.decision === "d1"));
run("DROP: an answer to a replaced decision", () => { const nd = { ...d1, id: "d1b", ref: "D7", supersedes: "d1", round: "R1b" };
  return [ev("decision.round.posted", { round: { id: "R1b", source: "x" }, decisions: [nd] }), msg(d1, "D1 yes")]; }, (b, out) => b.d1!.replacedBy === "d1b" && !b.d1!.answers.length && !waits(out, "d1"));
run("DROP: a second posting of a decision id cannot change it", () => { const changed = { ...d1, payload: q("Something else?", ["Settle", "No"]), round: "R1c" };
  return [ev("decision.round.posted", { round: { id: "R1c", source: "x" }, decisions: [changed] })]; }, (b) => b.d1!.payload.question === "Approve fix?");
run("DROP: an answer value that is neither text nor a list of text", () => { const L = logQ([d1.payload], { "Approve fix?": { label: "Settle" } }); return [L, answer(d1, { kind: "question", question: L.id })]; }, (b) => !b.d1!.answers.length);
run("P1: an unverified letter-pick of the park option does not supersede the earlier answer", () => [msg(d3, "D3 B"), answer(d3, { kind: "unverified", words: "D3 A" })],
  (b) => b.d3!.answers.length === 2 && standing(b.d3!)!.parkWaits === "2026-10-15" && !standing(b.d3!)!.park);
run("P3: free text on a words decision is never read", () => { const A = answer(d5, { kind: "message", session: "sess-A", entryId: "u1", text: "Ship it, and A for D4" });
  return [A, reading(A, [{ decision: "d4", option: "A" }])]; }, (b) => !b.d4!.answers.length);
run("P4 (R23): a reading of an answer whose question was since replaced is dropped", () => { const L = logQ([d1.payload], { "Approve fix?": "hmm" }); const A = answer(d1, { kind: "question", question: L.id });
  const nd = { ...d1, id: "d1b", ref: "D7", supersedes: "d1", round: "R1b" };
  return [L, A, ev("decision.round.posted", { round: { id: "R1b", source: "x" }, decisions: [nd] }), reading(A, [{ decision: "d4", option: "A" }])]; },
  (b) => !b.d4!.answers.length && !b.d1!.answers[0]!.reading);

// --- what posting refuses (the fold drops exactly what the ops refuse)

const refused = (d: any, prevalidated = false) => checkDecision(d, prevalidated);
test("posting refuses what the rulings forbid, and accepts the same decision without the fault", () => {
  const good = D("dx", "D9", q("Q?", ["A", "B"]), [{ label: "A", effects: [settle("F1")] }, { label: "B", effects: [] }]);
  assert.equal(refused(good), null, "the positive every refusal below varies");
  assert.match(refused({ ...good, options: [{ label: "A", effects: [{ findings: ["F1"], on: "settle" }] }, good.options[1]] })!, /must say how it closes/);
  assert.match(refused({ ...good, options: [{ label: "A", effects: [{ findings: ["F1"], on: "settle", as: "accepted" }] }, good.options[1]] })!, /must say how it closes/);
  assert.match(refused({ ...good, options: [{ label: "A", effects: [{ findings: ["F1"], on: "unblock", as: "refuted" }] }, good.options[1]] })!, /takes no `as`/);
  assert.match(refused({ ...good, options: [{ label: "A", effects: [settle()] }, good.options[1]] })!, /needs findings/);
  const multiPark = D("dp", "D8", q("P?", ["Park until 2026-10-15", "Now"], true), [{ label: "Park until 2026-10-15", effects: [], park: "2026-10-15" }, { label: "Now", effects: [] }]);
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
});
run("DROP: a round that is not pre-validated cannot carry a close-on-answer option", () => {
  const c = { ...D("dc", "D9", q("C?", ["A", "B"]), [{ label: "A", effects: [settle("F1")], closesOnAnswer: true }, { label: "B", effects: [] }]), round: "RC" };
  return [ev("decision.round.posted", { round: { id: "RC", source: "x" }, decisions: [c] }),
    ev("decision.round.posted", { round: { id: "RD", source: "x", prevalidated: { record: "r", sortedBy: "two sorters and an arbitrator" } }, decisions: [{ ...c, id: "dd", round: "RD" }] })];
}, (b) => !b.dc && !!b.dd);
run("a close-on-answer option's settle is ruled as closing on answer", () => {
  const c = { ...D("dd", "D9", q("C?", ["A", "B"]), [{ label: "A", effects: [settle("F1"), unblock("F2")], closesOnAnswer: true }, { label: "B", effects: [] }]), round: "RD" };
  return [ev("decision.round.posted", { round: { id: "RD", source: "x", prevalidated: { record: "r", sortedBy: "two sorters and an arbitrator" } }, decisions: [c] }), msg(c, "D9 A")];
}, (b) => ruled(b.dd!).some((r) => r.finding === "F1" && r.closesOnAnswer) && ruled(b.dd!).some((r) => r.finding === "F2" && !r.closesOnAnswer));

test("garbage events are dropped, never thrown on", () => {
  const junk: any[] = [
    ev("decision.round.posted", { round: { id: "RX", source: "x" }, decisions: [null, "str", { id: "dx", round: "RX", ref: "D1", kind: "options", payload: { question: "q", options: [null] }, options: [{ label: "a" }] },
      { id: "dy", round: "RX", ref: "D2", kind: "options", payload: { question: "q", options: [{ label: "a" }] }, options: [{ label: "a" }] },
      { id: "dz", round: "RX", ref: "D3", kind: "options", payload: { question: "q", options: [{ label: "a" }] }, options: [{ label: "a", effects: [null] }] },
      { id: "dw", round: "RX", ref: [], kind: "options", payload: { question: "q", options: [{ label: "a" }] }, options: [{ label: "a", effects: [] }] }] }),
    ev("decision.round.posted", null),
    ev("decision.round.posted", { round: "R", decisions: [] }),
    ev("decision.question.logged", { session: "s", toolUseId: "t", questions: [null, 3], answers: {} }),
    ev("decision.question.logged", { session: "s", toolUseId: "t2", questions: [], answers: [] }),
    ev("decision.answer.recorded", { decision: "d1", hash: h(d1), via: null }),
    ev("decision.answer.recorded", { decision: "d2", hash: h(d2), via: { kind: "direct", checked: "x" } }, person),
    ev("decision.answer.recorded", { decision: "d3", hash: h(d3), via: { kind: "direct", park: 5 } }, person),
    ev("decision.reading.recorded", { answer: "nope", reader: null }),
    ev("decision.reading.recorded", null),
  ];
  const out = foldDecisions([round, ...junk]);
  assert.equal(out.decisions.length, 5, "the good round stands; the garbage adds nothing");
  assert.equal(out.questions.length, 0);
  assert.ok(out.decisions.every((d) => !d.answers.length));
});
