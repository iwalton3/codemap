import { test } from "node:test";
import assert from "node:assert/strict";
import { comparisonContextHash, deriveComparison, validateComparisonRequest,
  type ComparisonRequest, type ReaderJudgment, type HumanResolution } from "./decision-comparison.js";

const base: Omit<ComparisonRequest, "contextHash"> = {
  id: "compare-1",
  left: { answerId: "a1", version: "response-hash-a1", principal: "alice", questionId: "q1", questionVersion: "qv1",
    display: { prompt: "Keep cache?", context: "For reads only", answerFormat: "choice",
      options: [{ id: "yes", label: "Yes", description: "Keep read cache", action: "preserve cache" }] }, words: "Yes" },
  right: { answerId: "b1", version: "response-hash-b1", principal: "bob", questionId: "q2", questionVersion: "qv2",
    display: { prompt: "Keep cache?", context: "For writes too", answerFormat: "choice",
      options: [{ id: "yes", label: "Yes", description: "Keep write cache", action: "preserve cache" }] }, words: "Yes" },
  issues: [{ universe: "u", kind: "finding", scope: "review-42", id: "f1" }],
};
const req: ComparisonRequest = { ...base, contextHash: comparisonContextHash(base) };
const current = { a1: req.left.version, b1: req.right.version };
const judgment = (id: string, verdict: ReaderJudgment["verdict"], agent = id): ReaderJudgment => ({
  id, requestId: req.id, contextHash: req.contextHash, issues: req.issues,
  answerVersions: [`a1\0${req.left.version}`, `b1\0${req.right.version}`], verdict,
  rationale: "Compared the full question context and intended implementation.",
  reader: { principal: "reader", agent, session: `session-${id}`, request: `request-${id}`, receipt: `receipt-${id}` },
  at: "2026-09-25T00:00:00Z",
});
const resolution = (id: string, preserve: string, revises?: string, principal = "owner"): HumanResolution => ({
  id, requestId: req.id, contextHash: req.contextHash, issues: req.issues,
  answerVersions: judgment("j", "incompatible").answerVersions, preserve,
  ...(revises ? { revises, shownResolution: { id: revises, preserve: "a1", receipt: `human-receipt-${revises}` } } : {}), rationale: "I saw the two complete alternatives and choose this one.",
  at: "2026-09-25T00:10:00Z",
  human: { principal, session: `human-${id}`, request: `ask-${id}`, receipt: `human-receipt-${id}`, shownHash: req.contextHash },
});
const project = (js: ReaderJudgment[], hs: HumanResolution[] = [], versions = current) => {
  const out = deriveComparison(req, versions, js, hs);
  if (!out.ok) throw new Error(out.errors.join("; "));
  return out.value;
};

test("exact full context distinguishes equal Yes labels and must be shown to a reader", () => {
  assert.equal(validateComparisonRequest(req).ok, true);
  const altered = structuredClone(req);
  altered.right.display.options = [{ id: "yes", label: "Yes", description: "Only reads" }];
  assert.equal(validateComparisonRequest(altered).ok, false);
  const pending = project([]);
  assert.equal(pending.state, "pending");
  assert.equal(pending.restrictsWork, true);
});

test("independent equivalent judgment releases only this comparison", () => {
  const out = project([judgment("j1", "equivalent")]);
  assert.equal(out.state, "equivalent");
  assert.equal(out.restrictsWork, false);
  assert.equal(out.acceptedJudgments.length, 1);
  assert.equal(out.preservedAnswer, undefined);
  const unnecessary = project([judgment("j1", "equivalent")], [resolution("h1", "a1")]);
  assert.equal(unnecessary.state, "equivalent");
  assert.equal(unnecessary.preservedAnswer, undefined);
  assert.equal(unnecessary.history.find((entry) => entry.id === "h1")?.state, "refused");
});

test("incompatible asks human, unclear stays restricted, contradictory readers are disputed", () => {
  assert.equal(project([judgment("j1", "incompatible")]).state, "incompatible");
  assert.equal(project([judgment("j1", "unclear")]).state, "unclear");
  for (const js of [[judgment("j1", "equivalent"), judgment("j2", "incompatible")],
    [judgment("j2", "incompatible"), judgment("j1", "equivalent")]]) {
    const out = project(js);
    assert.equal(out.state, "disputed");
    assert.equal(out.restrictsWork, true);
  }
});

test("a changed answer version invalidates old judgment and resolution without erasing history", () => {
  const out = project([judgment("j1", "incompatible")], [resolution("h1", "a1")],
    { ...current, a1: "new-response" });
  assert.equal(out.state, "pending");
  assert.equal(out.acceptedJudgments.length, 0);
  assert.equal(out.acceptedResolutions.length, 0);
  assert.deepEqual(out.history.map((x) => x.state), ["invalidated", "invalidated"]);
});

test("resolution correction changes the authority frontier; independent opposite resolutions dispute", () => {
  const js = [judgment("j1", "incompatible")];
  const corrected = project(js, [resolution("h2", "b1", "h1"), resolution("h1", "a1")]);
  assert.equal(corrected.state, "resolved");
  assert.equal(corrected.preservedAnswer, "b1");
  assert.equal(corrected.acceptedResolutions.length, 2, "earlier choice stays in history");
  const dispute = project(js, [resolution("h1", "a1"), resolution("h-bob", "b1", undefined, "other-owner")]);
  assert.equal(dispute.state, "disputed");
  assert.equal(dispute.preservedAnswer, undefined);
  assert.equal(dispute.restrictsWork, true);
});

test("mismatched receipt/scope or source-reader identity cannot release work", () => {
  const bad = judgment("j1", "equivalent");
  bad.reader.principal = "alice";
  const wrongScope = judgment("j2", "equivalent");
  wrongScope.issues = [{ ...req.issues[0]!, id: "another" }];
  const out = project([bad, wrongScope]);
  assert.equal(out.state, "pending");
  assert.deepEqual(out.history.map((x) => x.state), ["refused", "refused"]);
});

test("duplicate reader evidence cannot release work in either event order", () => {
  const yes = judgment("yes", "equivalent", "reader-one");
  const no = judgment("no", "incompatible", "reader-one");
  for (const readings of [[yes, no], [no, yes]]) {
    const out = project(readings);
    assert.equal(out.state, "pending");
    assert.equal(out.restrictsWork, true);
    assert.deepEqual(out.history.map((x) => x.state), ["refused", "refused"]);
  }
});

test("resolution corrections require the prior receipt and reject cycles", () => {
  const j = [judgment("j1", "incompatible")];
  const unshown = resolution("h2", "b1", "h1");
  unshown.shownResolution!.receipt = "not the prior receipt";
  assert.equal(project(j, [resolution("h1", "a1"), unshown]).preservedAnswer, "a1");
  const h1 = resolution("h1", "a1", "h2");
  h1.shownResolution = { id: "h2", preserve: "b1", receipt: "human-receipt-h2" };
  const h2 = resolution("h2", "b1", "h1");
  const out = project(j, [h2, h1]);
  assert.equal(out.state, "incompatible");
  assert.equal(out.acceptedResolutions.length, 0);
});
