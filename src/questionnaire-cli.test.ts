import { test } from "node:test";
import assert from "node:assert/strict";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { team, settle } from "./oracle.js";
import { sharedSync } from "./ops-shared.js";
import { postRound, submitQuestionnaire, withdrawDecision } from "./ops/decisions.js";
import { questionnaireVersion, type Questionnaire } from "./questionnaire.js";
import { questionnaireRead, questionnaireStatus, waitQuestionnaireStatus } from "./ops/questionnaire-status.js";

const Q: Questionnaire = {
  id: "stakeholder-review", title: "Release choice", recipient: "ben@acme.test",
  sections: [{ id: "release", title: "Release", questions: [
    { id: "q1", kind: "short", prompt: "D1: What should ship?" },
    { id: "q2", kind: "short", prompt: "D2: What should wait?" },
  ] }],
};
const decisions = [
  { id: "q1", round: "R1", ref: "D1", kind: "words" as const,
    payload: { question: "D1: What should ship?", options: [] }, options: [] },
  { id: "q2", round: "R1", ref: "D2", kind: "words" as const,
    payload: { question: "D2: What should wait?", options: [] }, options: [] },
];

const cli = (root: string, ...args: string[]) => spawnSync(process.execPath,
  [join(process.cwd(), "dist/cli.js"), "questionnaires", ...args, "--repo", root], { encoding: "utf8" });

test("questionnaire CLI retrieves JSON after explicit sync, resumes by content cursor, and reports blocked scope", async () => {
  const t = await team(["ana@acme.test", "ben@acme.test"]);
  const [a, b] = t.all;
  let moved = false;
  try {
    const published = await postRound(a!.repo, { round: { id: "R1", source: "stakeholder", questionnaire: Q }, decisions }) as any;
    assert.equal(published.ok, true, JSON.stringify(published));
    await settle(t);

    const list = cli(b!.repo, "list");
    assert.equal(list.status, 0, list.stderr);
    assert.equal(JSON.parse(list.stdout).questionnaires[0].id, Q.id);
    const detail = cli(b!.repo, "detail", Q.id);
    assert.equal(detail.status, 0, detail.stderr);
    const body = JSON.parse(detail.stdout);
    assert.deepEqual(body.questionnaire.sections[0].questions.map((x: any) => x.id), ["q1", "q2"]);
    assert.equal(body.progress.find((p: any) => p.principal === Q.recipient).counts.unanswered, 2);
    assert.equal(body.history.length, 2);
    assert.ok(body.pending);

    const initial = await questionnaireStatus(b!.repo, Q.id) as any;
    assert.equal(initial.ok, true);
    assert.match(initial.cursor, /^[a-f0-9]{64}$/);
    assert.equal(initial.remoteFreshness, "unknown-until-sync");
    assert.equal(initial.requiresSync, true);
    const unchanged = await waitQuestionnaireStatus(b!.repo, Q.id, initial.cursor, 0) as any;
    assert.equal(unchanged.timedOut, true);
    assert.equal(unchanged.changed, false);

    const submission = await submitQuestionnaire(a!.repo, { round: "R1", submission: {
      questionnaireId: Q.id, version: questionnaireVersion(Q), attemptId: "attempt-1",
      answers: [{ questionId: "q1", kind: "short", text: "Ship the safe path." }],
    } }) as any;
    assert.equal(submission.ok, true, JSON.stringify(submission));
    assert.equal((await questionnaireStatus(b!.repo, Q.id, initial.cursor) as any).changed, false,
      "a remote answer is unavailable until explicit sync");
    assert.equal((await waitQuestionnaireStatus(b!.repo, Q.id, initial.cursor, 0) as any).timedOut, true);
    assert.equal((await sharedSync(a!.repo) as any).ok, true);
    assert.equal((await sharedSync(b!.repo) as any).ok, true);

    const status = cli(b!.repo, "status", Q.id, "--cursor", initial.cursor);
    assert.equal(status.status, 0, status.stderr);
    const arrived = JSON.parse(status.stdout);
    assert.equal(arrived.changed, true);
    assert.equal(arrived.questions.find((x: any) => x.questionId === "q1").answers[0].source.answer.text, "Ship the safe path.", JSON.stringify(arrived.questions));
    assert.equal(arrived.progress.find((p: any) => p.principal === Q.recipient).counts.submitted, 0,
      "another principal's answer never completes the recipient's form");
    assert.equal(arrived.progress.find((p: any) => p.principal === "ana@acme.test").counts.submitted, 1);
    assert.ok(arrived.lastSync?.at);
    assert.equal((await questionnaireStatus(b!.repo, Q.id, arrived.cursor) as any).changed, false);
    assert.equal((await sharedSync(b!.repo) as any).ok, true);
    assert.equal((await questionnaireStatus(b!.repo, Q.id, arrived.cursor) as any).changed, false,
      "a no-op sync updates metadata without moving the projected-content cursor");
    assert.equal((await questionnaireRead(b!.repo, Q.id) as any).questions[0].answers.length, 1);

    const withdrawn = await withdrawDecision(a!.repo, { decision: "q1", answer: submission.answers[0].id, reason: "Reconsider this answer" }) as any;
    assert.equal(withdrawn.ok, true, JSON.stringify(withdrawn));
    await sharedSync(a!.repo); await sharedSync(b!.repo);
    const revised = await questionnaireStatus(b!.repo, Q.id, arrived.cursor) as any;
    assert.equal(revised.changed, true, "authority change moves the cursor without a new answer count");
    assert.equal(revised.questions[0].answers.length, 1);
    assert.ok(revised.questions[0].answers[0].withdrawn);
    assert.equal((await waitQuestionnaireStatus(b!.repo, Q.id, arrived.cursor, 0) as any).changed, true);

    const timed = cli(b!.repo, "wait", Q.id, "--cursor", revised.cursor, "--wait-ms", "0");
    assert.equal(timed.status, 0, timed.stderr);
    assert.equal(JSON.parse(timed.stdout).timedOut, true);
    const invalid = cli(b!.repo, "wait", Q.id, "--cursor", revised.cursor, "--wait-ms", "60001");
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /60000/);

    renameSync(b!.sidecar, `${b!.sidecar}-missing`); moved = true;
    const blocked = await questionnaireStatus(b!.repo, Q.id, revised.cursor) as any;
    assert.equal(blocked.status.status, "blocked");
    assert.equal(blocked.syncState, "blocked");
    assert.equal((await waitQuestionnaireStatus(b!.repo, Q.id, blocked.cursor, 0) as any).status.status, "blocked");
  } finally {
    if (moved) renameSync(`${b!.sidecar}-missing`, b!.sidecar);
    t.dispose();
  }
});
