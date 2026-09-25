/** Acceptance probes for the remaining explicit lifecycle acts in plan §3. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decisionHash, foldDecisions, revisionPresentation, revisionRelayQuestion, standingForFinding, standingForIssue, waitingOnMe, heldFindings } from "./shared-decisions.js";

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
  { round: { id: round, source: "test", universe: "u" }, decisions: [d] }, agent);
const answer = (id: string, d: any, option: string, actor: any, after: string[]) => event(id, "decision.answer.recorded", d.id,
  { decision: d.id, hash: decisionHash(d), via: { kind: "direct", option } }, actor, after);

test("an agent can execute only the exact human-approved withdrawal, with approval retained", () => {
  const p = post(findingDecision), a = answer("a2", findingDecision, "Settle", alice, [p.id]);
  const scope = { findings: ["F1"], issues: [] };
  const approval = event("h3", "decision.withdrawal.approved", "d1", {
    decision: "d1", answer: a.id, reason: "I retract this ruling", scope,
    knownAnswers: [a.id], sourceReceipt: "human-approval-receipt",
  }, alice, [a.id]);
  const withdrawal = event("w4", "decision.withdrawn", "d1", {
    decision: "d1", answer: a.id, reason: "I retract this ruling", scope,
    knownAnswers: [a.id], approval: approval.id,
  }, agent, [approval.id]);
  const folded = foldDecisions([p, a, approval, withdrawal]);
  const d = folded.decisions.find((x) => x.id === "d1")!;
  assert.equal(d.answers.find((x) => x.id === a.id)?.withdrawn?.by, withdrawal.id);
  assert.equal(d.withdrawals?.find((x) => x.id === withdrawal.id)?.state, "applied");
  assert.equal(waitingOnMe(folded, "2026-09-25").some((x) => x.decision === d.id), false);
  assert.equal(heldFindings(folded, () => true).has("F1"), false);
  const forged = foldDecisions([p, a, { ...withdrawal, data: { ...withdrawal.data, approval: "missing" } }]);
  assert.equal(forged.decisions.find((x) => x.id === "d1")?.answers[0]?.withdrawn, undefined);
});

test("cross-principal direct revision needs a matching prior presentation act; forged context grants nothing", () => {
  const p = post(findingDecision), first = answer("a2", findingDecision, "Settle", alice, [p.id]);
  const foldedSource = foldDecisions([p, first]).decisions.find((x) => x.id === "d1")!;
  const shownData = revisionPresentation(foldedSource, [foldedSource.answers[0]!], "bob",
    { findings: ["F1"] }, "server-presentation-receipt");
  const shown = event("s3", "decision.revision.presented", "d1", shownData, bob, [first.id]);
  const revised = event("r4", "decision.answer.revised", "d1", {
    decision: "d1", hash: decisionHash(findingDecision), via: { kind: "direct", option: "Keep open" },
    revision: { of: [first.id], findings: ["F1"], seen: { presentation: shown.id, contextHash: shownData.contextHash } },
  }, bob, [shown.id]);
  const accepted = foldDecisions([p, first, shown, revised]);
  assert.equal(accepted.decisions.find((x) => x.id === "d1")?.answers.find((x) => x.id === revised.id)?.revisionInvalid, undefined);
  assert.equal(standingForFinding(accepted.decisions.find((x) => x.id === "d1")!, "F1")?.id, revised.id);
  const forged = foldDecisions([p, first, shown, { ...revised, data: { ...revised.data,
    revision: { ...revised.data.revision, seen: { presentation: shown.id, contextHash: "wrong" } } } }]);
  assert.ok(forged.decisions.find((x) => x.id === "d1")?.answers.find((x) => x.id === revised.id)?.revisionInvalid);
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
  const current = folded.decisions.find((x) => x.id === d.id)!;
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
  const choices = folded.decisions.find((x) => x.id === "d1")!.answers;
  assert.equal(choices.find((x) => x.id === b.id)?.resolvedOutBy, undefined);
  assert.equal(choices.find((x) => x.id === a.id)?.resolvedOutBy, corrected.id);
});

test("a verified relay revision uses the human's shown source and given time, not the recorder's later pull", () => {
  const p = post(findingDecision), first = answer("a2", findingDecision, "Settle", alice, [p.id]);
  const source = foldDecisions([p, first]).decisions.find((d) => d.id === "d1")!;
  const question = revisionRelayQuestion(source, [source.answers[0]!], "bob", { findings: ["F1"] });
  const unrelated = event("p5", "decision.round.posted", "other", {
    round: { id: "other", source: "later sync", universe: "u" }, decisions: [],
  }, alice, [first.id]);
  const proof = { session: "human-session", toolUseId: "human-call", entryId: "human-receipt",
    answeredAt: at(3), question, answer: "Keep open" };
  const revision = event("r6", "decision.answer.revised", "d1", {
    decision: "d1", hash: decisionHash(findingDecision), via: { kind: "revision-relay", proof },
    revision: { of: [first.id], findings: ["F1"] },
  }, { principal: "bob", via: { kind: "agent", model: "test" } }, [first.id, unrelated.id]);
  const accepted = foldDecisions([p, first, unrelated, revision]);
  assert.equal(standingForFinding(accepted.decisions.find((d) => d.id === "d1")!, "F1")?.id, revision.id);
  assert.equal(accepted.decisions.find((d) => d.id === "d1")!.answers.find((a) => a.id === revision.id)?.givenAt, at(3));
  const forged = { ...revision, data: { ...revision.data, via: { kind: "revision-relay",
    proof: { ...proof, question: { ...question, question: question.question + " different" } } } } };
  const refused = foldDecisions([p, first, unrelated, forged]);
  assert.ok(refused.decisions.find((d) => d.id === "d1")!.answers.find((a) => a.id === revision.id)?.revisionInvalid);
});
