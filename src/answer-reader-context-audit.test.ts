import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmPayload, decisionHash, foldDecisions, readerBrief } from "./shared-decisions.js";

const when = (second: number) => `2026-09-25T00:00:${String(second).padStart(2, "0")}Z`;
const posted = (decision: any, questionnaire?: any) => ({
  id: "posted", kind: "decision.round.posted", subject: "R1", actor: { principal: "alice" }, at: when(1), after: [],
  data: { publication: 2, round: { id: "R1", source: "audit", ...(questionnaire ? { questionnaire } : {}) }, decisions: [decision] },
});
const words = (decision: any) => ({
  id: "answer", kind: "decision.answer.recorded", subject: decision.id, actor: { principal: "alice" }, at: when(2), after: ["posted"],
  data: { decision: decision.id, hash: decisionHash(decision), via: {
    kind: "message", session: "s", entryId: "reply", text: "I think so", round: "posted", at: when(2),
  } },
});
const context = (decision: any, questionnaire?: any) => {
  const s = foldDecisions([posted(decision, questionnaire), words(decision)] as any);
  assert.equal(s.decisions.length, 1);
  const d = s.decisions[0]!;
  const a = d.answers[0]!;
  assert.ok(a);
  return { d, a, byId: new Map([[d.id, d]]) };
};

test("answer reader and confirmation include frozen questionnaire section and option identities", () => {
  const decision = {
    id: "choice", round: "R1", ref: "D1", kind: "options",
    payload: { question: "D1: Choose a path?", options: [
      { label: "Ship", description: "Ship now" }, { label: "Wait", description: "Wait" },
    ] },
    options: [{ label: "Ship", effects: [] }, { label: "Wait", effects: [] }],
  };
  const questionnaire = {
    id: "frozen-form", title: "Release decision", recipient: "alice", sections: [{
      id: "release-section", title: "RELEASE_SECTION_CONTEXT", questions: [{
        id: "choice", kind: "choice", prompt: decision.payload.question, allowOther: true,
        options: [
          { id: "SHIP_OPTION_ID", label: "Ship", description: "Ship now" },
          { id: "WAIT_OPTION_ID", label: "Wait", description: "Wait" },
        ],
      }],
    }],
  };
  const { d, a, byId } = context(decision, questionnaire);
  const brief = readerBrief(byId, d, a);
  assert.match(brief, /RELEASE_SECTION_CONTEXT/);
  assert.match(brief, /SHIP_OPTION_ID/);
  const confirmation = confirmPayload(byId, d, a, [[{ decision: d.id, option: "Ship" }]], "D9");
  assert.match(confirmation.question, /RELEASE_SECTION_CONTEXT/);
  assert.match(confirmation.question, /SHIP_OPTION_ID/);
});

test("confirmation states what a typed bug choice releases", () => {
  const first = { kind: "bug", universe: "u", scope: "bugs/u", id: "B1" };
  const second = { kind: "bug", universe: "u", scope: "bugs/u", id: "B2" };
  const decision = {
    id: "bugs", round: "R1", ref: "D1", kind: "options",
    payload: { question: "D1: Rule on B1 and B2?", options: [
      { label: "Reject B1", description: "B1 is invalid" },
      { label: "Keep B2", description: "B2 is real" },
    ] },
    options: [
      { label: "Reject B1", effects: [{ findings: [], issues: [first], on: "settle", as: "refuted" }] },
      { label: "Keep B2", effects: [{ findings: [], issues: [second], on: "unblock" }] },
    ],
  };
  const { d, a, byId } = context(decision);
  const confirmation = confirmPayload(byId, d, a, [[{ decision: d.id, option: "Reject B1" }]], "D9");
  assert.match(confirmation.question, /releases .*B2/);
});
