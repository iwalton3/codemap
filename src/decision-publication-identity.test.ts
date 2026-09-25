import { test } from "node:test";
import assert from "node:assert/strict";
import { team, settle } from "./oracle.js";
import { postRound, answerDirect, decisionRound, questionnaireDetail } from "./ops/decisions.js";
import { decisionHash, foldDecisions } from "./shared-decisions.js";

const actor = (principal: string) => ({ principal });
const question = (text: string) => ({ id: "d1", round: "R1", ref: "D1", kind: "options" as const,
  payload: { question: `D1: ${text}`, options: [{ label: "Yes" }, { label: "No" }] },
  options: [{ label: "Yes", effects: [] }, { label: "No", effects: [] }] });
const event = (id: string, kind: string, data: unknown, principal: string, at: string) => ({
  id, kind, subject: "R1", data, actor: actor(principal), at, writer: principal,
  writerPrev: "GENESIS", after: [],
}) as any;

for (const sameText of [false, true]) test(`fold keeps independent same-label publications (${sameText ? "equal" : "different"} text)`, () => {
  const left = question("Decide the left issue?");
  const right = question(sameText ? left.payload.question : "Decide the right issue?");
  const p1 = event("p1", "decision.round.posted", { publication: 2, round: { id: "R1", source: "left", universe: "u" }, decisions: [left] }, "alice", "2026-09-25T00:00:01Z");
  const p2 = event("p2", "decision.round.posted", { publication: 2, round: { id: "R1", source: "right", universe: "u" }, decisions: [right] }, "bob", "2026-09-25T00:00:02Z");
  const a1 = event("a1", "decision.answer.recorded", { decision: "p1:d1", hash: decisionHash(left), via: { kind: "direct", option: "Yes" } }, "alice", "2026-09-25T00:00:03Z");
  const a2 = event("a2", "decision.answer.recorded", { decision: "p2:d1", hash: decisionHash(right), via: { kind: "direct", option: "No" } }, "bob", "2026-09-25T00:00:04Z");
  for (const postings of [[p1, p2], [p2, p1]]) {
    const folded = foldDecisions([...postings, a1, a2]);
    assert.equal(folded.rounds.length, 2);
    assert.equal(folded.decisions.length, 2);
    assert.deepEqual(folded.decisions.map((d) => [d.id, d.label, d.answers.map((a) => a.id)]).sort(),
      [["p1:d1", "d1", ["a1"]], ["p2:d1", "d1", ["a2"]]]);
  }
});

test("two clones retain same-label publications and their own answers after sync", async () => {
  const previous = process.env.CODEMAP_AGENT_MODEL;
  delete process.env.CODEMAP_AGENT_MODEL;
  let t: Awaited<ReturnType<typeof team>> | undefined;
  try {
    t = await team(["alice@acme.test", "bob@acme.test"]);
    const [alice, bob] = t.all;
    const left = await postRound(alice!.repo, { round: { id: "R1", source: "left" }, decisions: [question("Decide the left issue?")] }) as any;
    const right = await postRound(bob!.repo, { round: { id: "R1", source: "right" }, decisions: [question("Decide the right issue?")] }) as any;
    assert.equal(left.ok, true, JSON.stringify(left));
    assert.equal(right.ok, true, JSON.stringify(right));
    assert.notEqual(left.round, right.round);
    assert.notEqual(left.ask[0].decision, right.ask[0].decision);
    assert.equal((await answerDirect(alice!.repo, { decision: left.ask[0].decision, option: "Yes" }) as any).recorded, true);
    assert.equal((await answerDirect(bob!.repo, { decision: right.ask[0].decision, option: "No" }) as any).recorded, true);
    await settle(t);
    for (const member of t.all) {
      const ambiguous = await decisionRound(member.repo, "R1") as any;
      assert.match(ambiguous.error, /ambiguous/);
      assert.match(ambiguous.error, new RegExp(left.round));
      assert.match(ambiguous.error, new RegExp(right.round));
      assert.match((await answerDirect(member.repo, { decision: "d1", option: "Yes" }) as any).error, /ambiguous/);
      const l = await decisionRound(member.repo, left.round) as any;
      const r = await decisionRound(member.repo, right.round) as any;
      assert.deepEqual(l.decisions[0].answers.map((a: any) => a.words), ["Yes"]);
      assert.deepEqual(r.decisions[0].answers.map((a: any) => a.words), ["No"]);
    }
  } finally {
    t?.dispose();
    if (previous === undefined) delete process.env.CODEMAP_AGENT_MODEL;
    else process.env.CODEMAP_AGENT_MODEL = previous;
  }
});

test("questionnaire submissions stay with the exact same-label publication", async () => {
  const previous = process.env.CODEMAP_AGENT_MODEL;
  delete process.env.CODEMAP_AGENT_MODEL;
  let t: Awaited<ReturnType<typeof team>> | undefined;
  try {
    t = await team(["alice@acme.test", "bob@acme.test"]);
    const [alice, bob] = t.all;
    const publish = (text: string) => {
      const prompt = `D1: ${text}`;
      const questionnaire = { id: "Q1", title: text, sections: [{ id: "s", title: "Section", questions: [
        { id: "d1", kind: "choice" as const, prompt, allowOther: false, options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
      ] }] };
      return { round: { id: "R1", source: text, questionnaire }, decisions: [{ id: "d1", round: "R1", ref: "D1", kind: "options" as const,
        payload: { question: prompt, options: [{ label: "Yes" }, { label: "No" }] },
        options: [{ label: "Yes", effects: [] }, { label: "No", effects: [] }] }] };
    };
    const l = await postRound(alice!.repo, publish("Left publication?")) as any;
    const r = await postRound(bob!.repo, publish("Right publication?")) as any;
    assert.equal(l.ok, true, JSON.stringify(l));
    assert.equal(r.ok, true, JSON.stringify(r));
    const { submitQuestionnaire } = await import("./ops/decisions.js");
    const answer = (posted: any, optionId: string) => ({ round: posted.round,
      submission: { questionnaireId: "Q1", version: posted.questionnaire.version, attemptId: "same-attempt",
        answers: [{ questionId: "d1", kind: "choice" as const, optionId }] } });
    assert.equal((await submitQuestionnaire(alice!.repo, answer(l, "yes")) as any).ok, true);
    assert.equal((await submitQuestionnaire(bob!.repo, answer(r, "no")) as any).ok, true);
    await settle(t);
    for (const member of t.all) {
      const bare = await questionnaireDetail(member.repo, "Q1") as any;
      assert.match(bare.error, /ambiguous/);
      const left = await questionnaireDetail(member.repo, l.round) as any;
      const right = await questionnaireDetail(member.repo, r.round) as any;
      assert.deepEqual(left.questions[0].answers.map((a: any) => a.source.answer.optionId), ["yes"]);
      assert.deepEqual(right.questions[0].answers.map((a: any) => a.source.answer.optionId), ["no"]);
    }
  } finally {
    t?.dispose();
    if (previous === undefined) delete process.env.CODEMAP_AGENT_MODEL;
    else process.env.CODEMAP_AGENT_MODEL = previous;
  }
});

test("replaying one publication event does not mint a second question or erase its answer", () => {
  const d = question("One publication?");
  const posted = event("p1", "decision.round.posted", { publication: 2, round: { id: "R1", source: "test", universe: "u" }, decisions: [d] }, "alice", "2026-09-25T00:00:01Z");
  const answered = event("a1", "decision.answer.recorded", { decision: "p1:d1", hash: decisionHash(d), via: { kind: "direct", option: "Yes" } }, "alice", "2026-09-25T00:00:02Z");
  const folded = foldDecisions([posted, answered, posted]);
  assert.deepEqual(folded.rounds.map((r) => r.id), ["p1"]);
  assert.deepEqual(folded.decisions.map((d) => [d.id, d.answers.map((a) => a.id)]), [["p1:d1", ["a1"]]]);
});

test("same-label confirm postings keep distinct event identities", () => {
  const d = question("Original question?");
  const p = event("p1", "decision.round.posted", { publication: 2, round: { id: "R1", source: "test", universe: "u" }, decisions: [d] }, "alice", "2026-09-25T00:00:01Z");
  const confirm = { id: "c1", round: "p1", ref: "D2", kind: "options", payload: {
    question: "D2: Confirm this reading?", options: [{ label: "Yes" }, { label: "No" }] },
    options: [{ label: "Yes", effects: [] }, { label: "No", effects: [] }],
    confirms: { answer: "missing", readings: [[{ decision: "p1:d1", option: "Yes" }]] } };
  const c1 = event("c1-event", "decision.confirm.posted", { publication: 2, round: "p1", decision: confirm }, "alice", "2026-09-25T00:00:02Z");
  const c2 = event("c2-event", "decision.confirm.posted", { publication: 2, round: "p1", decision: confirm }, "bob", "2026-09-25T00:00:03Z");
  const folded = foldDecisions([p, c1, c2]);
  assert.deepEqual(folded.decisions.filter((d) => d.label === "c1").map((d) => d.id), ["c1-event", "c2-event"]);
});
