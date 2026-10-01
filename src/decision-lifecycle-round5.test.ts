/** Acceptance probes for the remaining explicit lifecycle acts in plan §3. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isLogDamage } from "./log-damage.js";
import { decisionHash, foldDecisions, revisionRelayQuestion, standingForFinding, standingForIssue, waitingOnMe, heldFindings,
  withdrawalQuestion, withdrawalBriefContent, withdrawalBriefHash, WITHDRAW_IT, KEEP_IT } from "./shared-decisions.js";

const alice = { principal: "alice" };
const bob = { principal: "bob" };
const agent = { principal: "alice", via: { kind: "agent", model: "test" } };
const at = (n: number) => `2026-09-25T00:00:${String(n).padStart(2, "0")}Z`;
const event = (id: string, kind: string, subject: string, data: any, actor: any, after: string[] = []): any => ({
  id, kind, subject, data, actor, after, at: at(Number(id.replace(/\D/g, "")) || 1),
  writer: actor.principal + (actor.via ? "-agent" : "-human"), writerPrev: "GENESIS",
});
const findingDecision: any = {
  id: "d1", round: "R1", ref: "D1", kind: "options" as const,
  payload: { question: "D1: settle F1?", options: [{ label: "Settle" }, { label: "Keep open" }] },
  options: [{ label: "Settle", effects: [{ findings: ["F1"], on: "settle", as: "refuted" }] },
    { label: "Keep open", effects: [] }],
};
const post = (d: any, id = "p1", round = "R1") => event(id, "decision.round.posted", round,
  { publication: 2, round: { id: round, source: "test", universe: "u" }, decisions: [d] }, agent);
/** A posted decision's id is its posting event's (`p1:d1`); its label is the id it was posted with. */
const byLabel = (label: string) => (x: { label?: string }) => x.label === label;
/** Why a read halts on these events landed in this order (plan 1.2), or undefined when it folds them. */
const damageOf = (evs: any[]): string | undefined => {
  try { foldDecisions(evs.map((e, i) => ({ ...e, seq: i + 1 }))); return undefined; } catch (e) { if (isLogDamage(e)) return e.entry.why; throw e; }
};
const answer = (id: string, d: any, option: string, actor: any, after: string[]) => event(id, "decision.answer.recorded", d.id,
  { decision: d.id, hash: decisionHash(d), via: { kind: "direct", option } }, actor, after);

test("an agent retires a ruling only as the person's answer to the relayed withdrawal question", () => {
  // Owner, 2026-09-28: "me for rulings, allow relay via verified question system".
  const p = post(findingDecision), a = answer("a2", findingDecision, "Settle", alice, [p.id]);
  const d1 = foldDecisions([p, a]).decisions.find(byLabel("d1"))!;
  const reason = "it conflicts with the later currency ruling";
  const q = withdrawalQuestion(d1, d1.answers[0]!, reason, "D1");
  const relay: any = { id: "withdraw", round: "R9", ref: "D1", kind: "options", payload: q, options: q.options.map((o) => ({ label: o.label, effects: [] })) };
  const posted = { ...post(relay, "p3", "R9"), after: [a.id] };
  const withdraw = (id: string, after: string[], over: any = {}) => event(id, "decision.withdrawn", "p1:d1",
    { decision: "p1:d1", answer: a.id, reason, knownAnswers: [a.id], relay: "p3:withdraw", ...over }, agent, after);
  const state = (evs: any[], id: string) => foldDecisions(evs).decisions.find(byLabel("d1"))!.withdrawals?.find((w) => w.id === id);

  const yes = answer("a4", relay, WITHDRAW_IT, alice, [posted.id]);
  assert.equal(state([p, a, posted, yes, withdraw("w5", [yes.id])], "w5")?.state, "applied");
  assert.equal(foldDecisions([p, a, posted, yes, withdraw("w5", [yes.id])]).decisions.find(byLabel("d1"))!.answers[0]!.withdrawn?.by, "w5");
  // Each refusal below is one the agent's own door makes, so a log holding it halts on it.
  assert.match(damageOf([p, a, posted, answer("a4", relay, KEEP_IT, alice, [posted.id]), withdraw("w5", ["a4"])]) ?? "", /has not answered "Withdraw it"/);
  assert.match(damageOf([p, a, posted, answer("a4", relay, WITHDRAW_IT, bob, [posted.id]), withdraw("w5", ["a4"])]) ?? "", /has not answered/,
    "another person's answer is not the ruling's principal's");
  // Written without having read the person's answer: refused for exactly that.
  assert.match(damageOf([p, a, posted, yes, withdraw("w5", [posted.id])]) ?? "", /written before the person's answer/);
  assert.match(damageOf([p, a, posted, yes, withdraw("w5", [yes.id], { reason: "a different reason" })]) ?? "", /relayed withdrawal question/);
  assert.match(damageOf([p, a, withdraw("w5", [a.id], { relay: undefined })]) ?? "", /relayed withdrawal question/, "no relay, no retirement");
});

test("an agent withdraws an unanswered question only with two sound readers, or an arbitrator between them", () => {
  // Owner: "Readers for unanswered" — the ruling-application shape (A6).
  const p = post(findingDecision);
  const d1 = foldDecisions([p]).decisions.find(byLabel("d1"))!;
  const reason = "the finding was withdrawn by its author";
  const brief = withdrawalBriefHash(withdrawalBriefContent(d1, reason));
  const reader = (n: number, verdict: "sound" | "unsound", hash = brief) => ({ id: `r${n}`, session: `s${n}`, launch: `l${n}`, briefHash: hash, verdict, rationale: `reason ${n}` });
  const withdraw = (review: unknown) => event("w5", "decision.withdrawn", "p1:d1", { decision: "p1:d1", reason, knownAnswers: [], review }, agent, [p.id]);
  const state = (review: unknown) => foldDecisions([p, withdraw(review)]).decisions.find(byLabel("d1"))!.withdrawals?.[0];
  const refused = (review: unknown) => damageOf([p, withdraw(review)]) ?? "";
  assert.equal(state({ readers: [reader(1, "sound"), reader(2, "sound")] })?.state, "applied");
  assert.match(refused({ readers: [reader(1, "sound")] }), /two readers/);
  assert.match(refused({ readers: [reader(1, "sound"), { ...reader(2, "sound"), session: "s1" }] }), /independently/);
  assert.match(refused({ readers: [reader(1, "sound"), reader(2, "sound", "sha256:other")] }), /this exact brief/);
  assert.match(refused({ readers: [reader(1, "sound"), reader(2, "unsound")] }), /third reader must arbitrate/);
  const arbHash = withdrawalBriefHash(withdrawalBriefContent(d1, reason, ["reason 1", "reason 2"]));
  assert.equal(state({ readers: [reader(1, "sound"), reader(2, "unsound")], arbitrator: reader(3, "sound", arbHash) })?.state, "applied");
  assert.match(refused({ readers: [reader(1, "sound"), reader(2, "unsound")], arbitrator: reader(3, "unsound", arbHash) }), /arbitrator found/);
  assert.match(refused({ readers: [reader(1, "unsound"), reader(2, "unsound")] }), /both readers/);
  assert.match(refused(undefined), /two readers/, "an agent alone withdraws nothing");
});

test("another person's revision stands", () => {
  // The owner's rule; the shown-the-old-answer receipt was too strict (plan Phase 3.2).
  const p = post(findingDecision), first = answer("a2", findingDecision, "Settle", alice, [p.id]);
  const revise = (after: string[]) => event("r4", "decision.answer.revised", "p1:d1", {
    decision: "d1", hash: decisionHash(findingDecision), via: { kind: "direct", option: "Keep open" },
    revision: { of: [first.id], findings: ["F1"] },
  }, bob, after);
  const accepted = foldDecisions([p, first, revise([first.id])]).decisions.find(byLabel("d1"))!;
  assert.equal(accepted.answers.find((x) => x.id === "r4")?.revisionInvalid, undefined);
  assert.equal(standingForFinding(accepted, "F1")?.id, "r4");
});

test("a scoped revision can change one canonical bug without changing an unrelated finding", () => {
  const bug = { kind: "bug" as const, universe: "u", scope: "bugs/u", id: "b1" };
  const d = { ...findingDecision, payload: { question: "D1: settle F1 or bug b1?", options: findingDecision.payload.options },
    options: [{ label: "Settle", effects: [{ findings: ["F1"], issues: [bug], on: "settle", as: "refuted" }] },
      { label: "Keep open", effects: [] }] };
  const p = post(d), first = answer("a2", d, "Settle", alice, [p.id]);
  const revised = event("r3", "decision.answer.revised", d.id, {
    decision: d.id, hash: decisionHash(d), via: { kind: "direct", option: "Keep open" },
    revision: { of: [first.id], findings: [], issues: [bug] },
  }, alice, [first.id]);
  const folded = foldDecisions([p, first, revised]);
  const current = folded.decisions.find(byLabel(d.id))!;
  assert.equal(standingForIssue(current, bug)?.id, revised.id);
  assert.equal(current.answers.find((x) => x.id === first.id)?.cancelled, undefined);
});

test("an explicit correction of a resolution switches its authority frontier", () => {
  const p = post(findingDecision), a = answer("a2", findingDecision, "Settle", alice, [p.id]);
  const b = answer("b3", findingDecision, "Keep open", bob, [p.id]);
  const resolution = { id: "resolve", round: "R2", ref: "D2", kind: "options" as const,
    payload: { question: `D2: Alice ${a.id} said ${JSON.stringify("Settle")}; Bob ${b.id} said ${JSON.stringify("Keep open")}. Which exact intent for F1?`,
      options: [{ label: `Preserve ${a.id}` }, { label: `Preserve ${b.id}` }] },
    options: [{ label: `Preserve ${a.id}`, effects: [] }, { label: `Preserve ${b.id}`, effects: [] }],
    resolves: { answers: [a.id, b.id] as [string, string] } };
  const rp = post(resolution, "p4", "R2"); rp.after = [a.id, b.id];
  const first = answer("c5", resolution, `Preserve ${a.id}`, alice, [rp.id]);
  const corrected = event("c6", "decision.answer.revised", resolution.id, {
    decision: resolution.id, hash: decisionHash(resolution), via: { kind: "direct", option: `Preserve ${b.id}` },
    revision: { of: [first.id], resolves: { answers: [a.id, b.id], priorResolution: first.id, shownHash: decisionHash(resolution) } },
  }, alice, [first.id]);
  const folded = foldDecisions([p, a, b, rp, first, corrected]);
  const choices = folded.decisions.find(byLabel("d1"))!.answers;
  assert.equal(choices.find((x) => x.id === b.id)?.resolvedOutBy, undefined);
  assert.equal(choices.find((x) => x.id === a.id)?.resolvedOutBy, corrected.id);
});

test("a verified relay revision uses the human's shown source and given time, not the recorder's later pull", () => {
  const p = post(findingDecision), first = answer("a2", findingDecision, "Settle", alice, [p.id]);
  const source = foldDecisions([p, first]).decisions.find(byLabel("d1"))!;
  const question = revisionRelayQuestion(source, [source.answers[0]!], "bob", { findings: ["F1"] });
  const unrelated = event("p5", "decision.round.posted", "other", {
    publication: 2, round: { id: "other", source: "later sync", universe: "u" }, decisions: [],
  }, alice, [first.id]);
  const proof = { session: "human-session", toolUseId: "human-call", entryId: "human-receipt",
    answeredAt: at(3), question, answer: "Keep open" };
  const revision = event("r6", "decision.answer.revised", "p1:d1", {
    decision: "d1", hash: decisionHash(findingDecision), via: { kind: "revision-relay", proof },
    revision: { of: [first.id], findings: ["F1"] },
  }, { principal: "bob", via: { kind: "agent", model: "test" } }, [first.id, unrelated.id]);
  const accepted = foldDecisions([p, first, unrelated, revision]);
  assert.equal(standingForFinding(accepted.decisions.find(byLabel("d1"))!, "F1")?.id, revision.id);
  assert.equal(accepted.decisions.find(byLabel("d1"))!.answers.find((a) => a.id === revision.id)?.givenAt, at(3));
  const forged = { ...revision, data: { ...revision.data, via: { kind: "revision-relay",
    proof: { ...proof, question: { ...question, question: question.question + " different" } } } } };
  assert.match(damageOf([p, first, unrelated, forged]) ?? "", /revision needs exact source/);
});
