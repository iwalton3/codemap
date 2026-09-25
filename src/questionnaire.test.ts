import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyAttempt, questionnaireVersion, stageSubmission, validateQuestionnaire, type Questionnaire } from "./questionnaire.js";

const q: Questionnaire = {
  id: "Q-2026", title: "Review the backlog", context: "Read each section before submitting.", recipient: "owner",
  sections: [
    { id: "priority", title: "Priority", questions: [
      { id: "severity", kind: "choice", prompt: "Which priority?", allowOther: true,
        options: [{ id: "urgent", label: "Urgent", description: "Fix this week", action: "schedule now" },
          { id: "later", label: "Later", description: "Can wait" }] },
      { id: "reason", kind: "short", prompt: "Why?" },
    ] },
    { id: "review", title: "Review each proposed item", questions: [
      { id: "items", kind: "list", prompt: "Mark wrong items", items: [
        { id: "a", text: "Keep A", context: "Current behavior" },
        { id: "b", text: "Keep B", action: "preserve B" },
        { id: "c", text: "Keep C" },
      ] },
    ] },
  ],
};
const draft = (answers: unknown[], attemptId = "attempt-1") => ({ questionnaireId: q.id,
  version: questionnaireVersion(q), attemptId, answers });

test("a selected partial batch submits only its named question in display order", () => {
  const out = stageSubmission(q, draft([{ questionId: "reason", kind: "short", text: "Because" }]));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.value.answers.map((a) => a.questionId), ["reason"]);
  assert.deepEqual(out.value.listApprovals, []);
  assert.equal(stageSubmission(q, draft([])).ok, false, "nothing is submitted by saving or leaving the page");
});

test("a reviewed list submits as one unit with explicit unmarked approvals and per-item corrections", () => {
  const complete = { questionId: "items", kind: "list", approveUnmarked: true,
    marked: [{ itemId: "b", correction: "Rewrite B" }] };
  const out = stageSubmission(q, draft([complete]));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.value.listApprovals, [{ questionId: "items", approvedItemIds: ["a", "c"], correctedItemIds: ["b"] }]);
  assert.equal(stageSubmission(q, draft([{ ...complete, approveUnmarked: false }])).ok, false);
  assert.equal(stageSubmission(q, draft([{ ...complete, marked: [{ itemId: "b", correction: " " }] }])).ok, false);
  assert.equal(stageSubmission(q, draft([{ ...complete, marked: [{ itemId: "missing", correction: "Wrong" }] }])).ok, false);
});

test("one incomplete selected list refuses the whole staged batch without partial approval", () => {
  const out = stageSubmission(q, draft([
    { questionId: "reason", kind: "short", text: "Complete" },
    { questionId: "items", kind: "list", approveUnmarked: true, marked: [{ itemId: "b", correction: "" }] },
  ]));
  assert.equal(out.ok, false);
  assert.equal(stageSubmission(q, draft([{ questionId: "reason", kind: "short", text: "Complete" }])).ok, true,
    "the complete question can be explicitly selected separately");
});

test("choice accepts exact option or permitted Other and rejects hidden defaults", () => {
  assert.equal(stageSubmission(q, draft([{ questionId: "severity", kind: "choice", optionId: "urgent" }])).ok, true);
  assert.equal(stageSubmission(q, draft([{ questionId: "severity", kind: "choice", other: "It depends" }])).ok, true);
  for (const answer of [
    { questionId: "severity", kind: "choice" },
    { questionId: "severity", kind: "choice", optionId: "unknown" },
    { questionId: "severity", kind: "choice", optionId: "urgent", other: "Also" },
  ]) assert.equal(stageSubmission(q, draft([answer])).ok, false);
});

test("version pins the exact displayed context and attempt identity is payload-bound", () => {
  const first = stageSubmission(q, draft([{ questionId: "reason", kind: "short", text: "One" }]));
  const retry = stageSubmission(q, draft([{ questionId: "reason", kind: "short", text: "One" }]));
  const changed = stageSubmission(q, draft([{ questionId: "reason", kind: "short", text: "Two" }]));
  assert.ok(first.ok && retry.ok && changed.ok);
  if (!first.ok || !retry.ok || !changed.ok) return;
  assert.equal(classifyAttempt(undefined, first.value), "new");
  assert.equal(classifyAttempt(first.value, retry.value), "retry");
  assert.equal(classifyAttempt(first.value, changed.value), "conflict");
  assert.equal(classifyAttempt(first.value, { ...changed.value, attemptId: "attempt-2" }), "new");
  const altered = structuredClone(q);
  const choice = altered.sections[0]!.questions[0]!;
  if (choice.kind !== "choice") throw new Error("fixture changed");
  choice.options[0]!.description = "Fix next week";
  assert.equal(stageSubmission(altered, draft([{ questionId: "reason", kind: "short", text: "One" }])).ok, false);
});

test("publication refuses duplicate IDs and incomplete display data", () => {
  const bad = structuredClone(q);
  bad.sections[1]!.id = "priority";
  assert.equal(validateQuestionnaire(bad).ok, false);
  const duplicate = structuredClone(q);
  duplicate.sections[1]!.questions[0]!.id = "reason";
  assert.equal(validateQuestionnaire(duplicate).ok, false);
  const missing = structuredClone(q);
  missing.sections[0]!.questions[0]!.prompt = "";
  assert.equal(validateQuestionnaire(missing).ok, false);
});

test("answer order and marked item order normalize to displayed order for retries", () => {
  const a = { questionId: "items", kind: "list", approveUnmarked: true,
    marked: [{ itemId: "c", correction: "C" }, { itemId: "a", correction: "A" }] };
  const b = { ...a, marked: [...a.marked].reverse() };
  const first = stageSubmission(q, draft([a, { questionId: "reason", kind: "short", text: "Why" }]));
  const retry = stageSubmission(q, draft([{ questionId: "reason", kind: "short", text: "Why" }, b]));
  assert.ok(first.ok && retry.ok);
  if (first.ok && retry.ok) assert.equal(classifyAttempt(first.value, retry.value), "retry");
});

test("publication rejects invisible fields and version ignores object key insertion order", () => {
  const extra = structuredClone(q) as Questionnaire & { hidden?: string };
  extra.hidden = "unshown action";
  assert.equal(validateQuestionnaire(extra).ok, false);
  const reordered = { sections: q.sections, recipient: q.recipient, context: q.context, title: q.title, id: q.id } as Questionnaire;
  assert.equal(questionnaireVersion(reordered), questionnaireVersion(q));
});
