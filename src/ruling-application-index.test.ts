import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, tx } from "./db.js";
import { testEvent } from "./test-events.js";
import { foldFindings } from "./shared-findings.js";
import { foldBugs } from "./shared-bugs.js";
import { findingsProjection, bugsProjection } from "./shared-projections.js";
import { rulingApplicationsForAnswer } from "./store.js";
import { discard } from "./test-tmp.js";
import type { ApplicationAttempt } from "./ruling-application.js";

test("target projection updates the indexed ruling execution view", () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-application-index-"));
  try {
    const scope = "findings/acme/api/pr-1";
    const created = testEvent({ id: "created", kind: "finding.created", subject: "f_1",
      actor: { principal: "agent@example.test", via: { kind: "agent", model: "test" } },
      data: { targetKind: "anchor", targetId: "a_1", text: "claim" } });
    const value = foldFindings([created]);
    const issue = value.get("f_1")!;
    const execution = { eventId: "execution", at: "2026-09-25T00:00:00Z", by: created.actor,
      status: "executed", key: "apply_1", capsule: { key: "apply_1",
        ruling: { answerId: "answer_1" }, issue: { ref: { kind: "finding", id: "f_1" } } } } as ApplicationAttempt;
    issue.applications = [execution];
    const d = db(root);
    tx(d, () => findingsProjection.write(d, scope, value));
    assert.deepEqual(rulingApplicationsForAnswer(root, "answer_1"), [execution]);
    assert.deepEqual(rulingApplicationsForAnswer(root, "another_answer"), []);

    issue.applications = [];
    tx(d, () => findingsProjection.write(d, scope, value));
    assert.deepEqual(rulingApplicationsForAnswer(root, "answer_1"), [],
      "a target-scope refold must invalidate its former ruling execution index");
  } finally { discard(root); }
});

test("bug projection replaces its indexed ruling execution view", () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-bug-application-index-"));
  try {
    const scope = "bugs/acme/api";
    const filed = testEvent({ id: "filed", kind: "bug.filed", subject: "bug_1",
      actor: { principal: "agent@example.test", via: { kind: "agent", model: "test" } },
      data: { title: "claim", text: "claim", anchors: [] } });
    const value = foldBugs([filed]);
    const issue = value.get("bug_1")!;
    const execution = { eventId: "execution", at: "2026-09-25T00:00:00Z", by: filed.actor,
      status: "executed", key: "apply_2", capsule: { key: "apply_2",
        ruling: { answerId: "answer_2" }, issue: { ref: { kind: "bug", id: "bug_1" } } } } as ApplicationAttempt;
    issue.applications = [execution];
    const d = db(root);
    tx(d, () => bugsProjection.write(d, scope, value));
    assert.deepEqual(rulingApplicationsForAnswer(root, "answer_2"), [execution]);
    issue.applications = [];
    tx(d, () => bugsProjection.write(d, scope, value));
    assert.deepEqual(rulingApplicationsForAnswer(root, "answer_2"), []);
  } finally { discard(root); }
});
