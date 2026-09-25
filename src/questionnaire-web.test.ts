import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error Browser JS is typechecked by web/tsconfig.json.
import { draftStorageKey, loadQuestionnaireDraft, saveQuestionnaireDraft, prepareSelectedSubmission } from "../web/questionnaire.js";

const form: any = {
  id: "Q1", title: "Review", sections: [{ id: "S1", title: "First", questions: [
    { id: "choice", kind: "choice", prompt: "Choose", allowOther: true,
      options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
    { id: "short", kind: "short", prompt: "Explain" },
    { id: "list", kind: "list", prompt: "Mark wrong", items: [
      { id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" },
    ] },
  ] }],
};
const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, data };
};

test("drafts are local to exact principal, questionnaire and version", () => {
  const storage = memory();
  const draft = { selected: ["short"], answers: { short: { kind: "short", text: "Later" } } };
  assert.equal(saveQuestionnaireDraft(storage, "alice", "Q1", "v1", draft), true);
  assert.deepEqual(loadQuestionnaireDraft(storage, "alice", "Q1", "v1"), draft);
  assert.deepEqual(loadQuestionnaireDraft(storage, "bob", "Q1", "v1"), { selected: [], answers: {} });
  assert.deepEqual(loadQuestionnaireDraft(storage, "alice", "Q1", "v2"), { selected: [], answers: {} });
  assert.notEqual(draftStorageKey("a,b", "Q1", "v1"), draftStorageKey("a", "b,Q1", "v1"));
});

test("only selected complete answers are staged; an incomplete selected list stages nothing", () => {
  const answers = {
    choice: { kind: "choice", optionId: "yes" },
    short: { kind: "short", text: "because" },
    list: { kind: "list", marked: [{ itemId: "b", correction: "" }] },
  };
  const invalid = prepareSelectedSubmission(form, "v1", ["short", "list"], answers, "attempt-1");
  assert.equal(invalid.ok, false);
  const valid = prepareSelectedSubmission(form, "v1", ["short"], answers, "attempt-2");
  assert.equal(valid.ok, true);
  if (valid.ok) assert.deepEqual(valid.value.answers, [{ questionId: "short", kind: "short", text: "because" }]);
  assert.equal(prepareSelectedSubmission(form, "v1", [], answers, "attempt-3").ok, false);
});

test("a list explicitly approves unmarked items as one reviewed unit", () => {
  const result = prepareSelectedSubmission(form, "v1", ["list"], {
    list: { kind: "list", marked: [{ itemId: "c", correction: "Change C" }, { itemId: "a", correction: "Change A" }] },
  }, "attempt-1");
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value.answers, [{ questionId: "list", kind: "list", approveUnmarked: true,
    marked: [{ itemId: "a", correction: "Change A" }, { itemId: "c", correction: "Change C" }] }]);
});
