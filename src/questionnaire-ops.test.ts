import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { indexBlob } from "./repo.js";
import { writeStore } from "./store.js";
import { shareFinding } from "./ops-shared.js";
import { postRound, questionnaireDetail, submitQuestionnaire, reviseDecision, withdrawDecision } from "./ops/decisions.js";
import { decisionScope, foldDecisions } from "./shared-decisions.js";
import { readScope } from "./eventlog.js";
import { questionnaireVersion, type Questionnaire, type QuestionnaireAnswer } from "./questionnaire.js";
import { universeKey } from "./sidecar-config.js";
import { discard } from "./test-tmp.js";
import type { State } from "./schema.js";
import { decisionsView } from "./ops/decision-holds.js";

const src = "export function creditLine(cents) { return cents * 2; }\n";
const env = async (principal: string | undefined, agent: boolean, fn: () => Promise<void>) => {
  const oldModel = process.env.CODEMAP_AGENT_MODEL, oldPrincipal = process.env.CODEMAP_PRINCIPAL;
  if (agent) process.env.CODEMAP_AGENT_MODEL = "claude-opus-5"; else delete process.env.CODEMAP_AGENT_MODEL;
  if (principal) process.env.CODEMAP_PRINCIPAL = principal; else delete process.env.CODEMAP_PRINCIPAL;
  try { await fn(); } finally {
    if (oldModel === undefined) delete process.env.CODEMAP_AGENT_MODEL; else process.env.CODEMAP_AGENT_MODEL = oldModel;
    if (oldPrincipal === undefined) delete process.env.CODEMAP_PRINCIPAL; else process.env.CODEMAP_PRINCIPAL = oldPrincipal;
  }
};
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codemap-questionnaire-op-"));
  const side = mkdtempSync(join(tmpdir(), "codemap-questionnaire-side-"));
  const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "main"); git("config", "user.email", "alice@x.com"); git("config", "user.name", "alice");
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, ".codemap", "sidecar"), side);
  writeFileSync(join(root, "src", "credit.js"), src);
  const anchors = await indexBlob(src, "src/credit.js");
  await writeStore(root, anchors, { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State);
  let finding = "";
  await env(undefined, true, async () => {
    const f = await shareFinding(root, 7, { targetKind: "anchor", targetId: anchors[0]!.id, text: "creditLine doubles" }) as any;
    finding = f.id;
  });
  const q: Questionnaire = { id: "stakeholder-q", title: "Review decisions", recipient: "stakeholder",
    sections: [
      { id: "decision", title: "Decision", questions: [
        { id: "choice", kind: "choice", prompt: `D1: Is ${finding} a real defect?`, allowOther: true,
          options: [
            { id: "reject", label: "Not a defect", description: "Reject claim", action: `settles ${finding} as refuted` },
            { id: "fix", label: "Real, fix it", description: "Fix claim", action: `unblocks ${finding}` },
          ] },
        { id: "short", kind: "short", prompt: "D2: Why does this matter?" },
      ] },
      { id: "items", title: "Review each item", questions: [
        { id: "list", kind: "list", prompt: `D3: Review ${finding} item by item`,
          items: [
            { id: "fix-item", text: "Fix item", context: "Move to work", action: `unblocks ${finding}` },
            { id: "reject-item", text: "Reject item", context: "Close claim", action: `settles ${finding} as refuted` },
          ] },
      ] },
    ] };
  const decisions = [
    { id: "choice", round: "R1", ref: "D1", kind: "options" as const,
      payload: { question: q.sections[0]!.questions[0]!.prompt, options: [
        { label: "Not a defect", description: "Reject claim" }, { label: "Real, fix it", description: "Fix claim" }] },
      options: [
        { label: "Not a defect", effects: [{ findings: [finding], on: "settle" as const, as: "refuted" as const }] },
        { label: "Real, fix it", effects: [{ findings: [finding], on: "unblock" as const }] },
      ] },
    { id: "short", round: "R1", ref: "D2", kind: "words" as const,
      payload: { question: q.sections[0]!.questions[1]!.prompt, options: [] }, options: [] },
    { id: "list", round: "R1", ref: "D3", kind: "bulk" as const,
      payload: { question: q.sections[1]!.questions[0]!.prompt, multiSelect: true,
        options: [
          { label: "Fix item", description: "Move to work" },
          { label: "Reject item", description: "Close claim" },
          { label: "Approve all unmarked" },
        ] },
      options: [
        { label: "Fix item", effects: [{ findings: [finding], on: "unblock" as const }] },
        { label: "Reject item", effects: [{ findings: [finding], on: "settle" as const, as: "refuted" as const }] },
        { label: "Approve all unmarked", effects: [], approveAll: true },
      ] },
  ];
  await env(undefined, true, async () => {
    const posted = await postRound(root, { round: { id: "R1", source: "stakeholder", questionnaire: q }, decisions }) as any;
    assert.equal(posted.ok, true, JSON.stringify(posted));
  });
  return { root, side, q, finding, cleanup: () => { discard(root); discard(side); } };
}
const submit = (q: Questionnaire, attemptId: string, answers: unknown[]) => ({
  round: "R1", submission: { questionnaireId: q.id, version: questionnaireVersion(q), attemptId, answers: answers as QuestionnaireAnswer[] },
});

test("selected questionnaire batch is one event, with retry identity and pending corrections", async () => {
  const u = await fixture();
  try {
    const answers = [
      { questionId: "choice", kind: "choice", optionId: "fix" },
      { questionId: "list", kind: "list", approveUnmarked: true,
        marked: [{ itemId: "reject-item", correction: "The claim needs qualification" }] },
    ];
    let first: any;
    await env("alice@x.com", false, async () => { first = await submitQuestionnaire(u.root, submit(u.q, "attempt-1", answers)); });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.answers.length, 2);
    assert.deepEqual(first.answers.find((a: any) => a.questionId === "list")?.approvals, ["fix-item"]);
    assert.equal(first.answers.find((a: any) => a.questionId === "list")?.corrections[0].verdict, "pending");
    const scope = decisionScope(universeKey(u.root));
    assert.equal((await readScope(u.side, scope)).filter((e) => e.kind === "decision.questionnaire.submitted").length, 1);
    await env("alice@x.com", false, async () => {
      const retry = await submitQuestionnaire(u.root, submit(u.q, "attempt-1", [...answers].reverse())) as any;
      assert.equal(retry.submission, first.submission);
      const conflict = await submitQuestionnaire(u.root, submit(u.q, "attempt-1", [{ questionId: "choice", kind: "choice", optionId: "reject" }])) as any;
      assert.match(conflict.error, /attempt ID/);
    });
    const detail = await questionnaireDetail(u.root, u.q.id, "alice@x.com") as any;
    const alice = detail.progress.find((p: any) => p.principal === "alice@x.com");
    const recipient = detail.progress.find((p: any) => p.principal === "stakeholder");
    assert.deepEqual(alice.counts, { submitted: 2, withdrawn: 0, unanswered: 1 });
    assert.equal(recipient.counts.submitted, 0, "another principal does not complete the recipient's form");
    assert.equal(detail.questions.find((x: any) => x.questionId === "short").answers.length, 0);
    assert.equal((await decisionsView(u.root)).work(u.finding).allowed, false, "marked correction remains pending");
  } finally { u.cleanup(); }
});

test("questionnaire source can be explicitly revised or withdrawn; independent answers compare", async () => {
  const u = await fixture();
  try {
    let alice: any;
    await env("alice@x.com", false, async () => {
      alice = await submitQuestionnaire(u.root, submit(u.q, "a1", [{ questionId: "choice", kind: "choice", optionId: "fix" }]));
    });
    assert.equal(alice.ok, true, JSON.stringify(alice));
    const source = alice.answers[0].id;
    await env("alice@x.com", false, async () => {
      const revised = await reviseDecision(u.root, { decision: "choice", revises: [source],
        findings: [u.finding], option: "Not a defect" }) as any;
      assert.equal(revised.ok, true, JSON.stringify(revised));
    });
    let bob: any;
    await env("bob@x.com", false, async () => {
      bob = await submitQuestionnaire(u.root, submit(u.q, "b1", [{ questionId: "choice", kind: "choice", optionId: "Real, fix it" }]));
    });
    // The wrong optionId is refused atomically and left no new answer.
    assert.match(bob.error, /selected option/);
    await env("bob@x.com", false, async () => {
      bob = await submitQuestionnaire(u.root, submit(u.q, "b1", [{ questionId: "choice", kind: "choice", optionId: "fix" }]));
    });
    assert.equal(bob.ok, true, JSON.stringify(bob));
    const candidates = (await decisionsView(u.root)).s;
    assert.ok(candidates.decisions.find((d) => d.id === "choice")!.answers.some((a) => a.id === source));
    assert.equal((await import("./shared-decisions.js")).intentCandidates(candidates).some((c) => c.findings.includes(u.finding)), true);
    // A separate unanswered question can be withdrawn without being counted as pending.
    await env("alice@x.com", false, async () => {
      const withdrawn = await withdrawDecision(u.root, { decision: "short", reason: "Not needed" }) as any;
      assert.equal(withdrawn.ok, true, JSON.stringify(withdrawn));
    });
    const detail = await questionnaireDetail(u.root, u.q.id, "alice@x.com") as any;
    assert.equal(detail.questions.find((x: any) => x.questionId === "short").withdrawn, true);
    assert.equal(detail.progress.find((p: any) => p.principal === "alice@x.com").counts.unanswered, 1);
  } finally { u.cleanup(); }
});

test("publication refuses a displayed action that differs from its folded effect", async () => {
  const u = await fixture();
  try {
    const altered = structuredClone(u.q);
    const question = altered.sections[0]!.questions[0]!;
    if (question.kind !== "choice") throw new Error("fixture changed");
    question.options[0]!.action = "unblocks instead";
    await env(undefined, true, async () => {
      const posted = await postRound(u.root, { round: { id: "R2", source: "wrong", questionnaire: altered },
        decisions: [
          { id: "choice", round: "R2", ref: "D1", kind: "options", payload: {
            question: altered.sections[0]!.questions[0]!.prompt,
            options: [{ label: "Not a defect", description: "Reject claim" }, { label: "Real, fix it", description: "Fix claim" }] },
            options: [{ label: "Not a defect", effects: [{ findings: [u.finding], on: "settle", as: "refuted" }] },
              { label: "Real, fix it", effects: [{ findings: [u.finding], on: "unblock" }] }] },
          { id: "short", round: "R2", ref: "D2", kind: "words", payload: { question: "D2: Why does this matter?", options: [] }, options: [] },
          { id: "list", round: "R2", ref: "D3", kind: "bulk", payload: { question: altered.sections[1]!.questions[0]!.prompt,
            multiSelect: true, options: [{ label: "Fix item", description: "Move to work" }, { label: "Reject item", description: "Close claim" },
              { label: "Approve all unmarked" }] }, options: [
              { label: "Fix item", effects: [{ findings: [u.finding], on: "unblock" }] },
              { label: "Reject item", effects: [{ findings: [u.finding], on: "settle", as: "refuted" }] },
              { label: "Approve all unmarked", effects: [], approveAll: true }] },
        ] }) as any;
      assert.match(posted.error, /choice.*differs/);
    });
  } finally { u.cleanup(); }
});


test("one principal's answer withdrawal leaves the question open for others", async () => {
  const u = await fixture();
  try {
    let answer = "";
    await env("alice@x.com", false, async () => {
      const submitted = await submitQuestionnaire(u.root, submit(u.q, "withdraw-one",
        [{ questionId: "choice", kind: "choice", optionId: "fix" }])) as any;
      assert.equal(submitted.ok, true, JSON.stringify(submitted));
      answer = submitted.answers[0].id;
      const withdrawn = await withdrawDecision(u.root, { decision: "choice", answer, reason: "Correction needed" }) as any;
      assert.equal(withdrawn.ok, true, JSON.stringify(withdrawn));
    });
    const detail = await questionnaireDetail(u.root, u.q.id, "alice@x.com") as any;
    assert.equal(detail.questions.find((x: any) => x.questionId === "choice").withdrawn, false);
    const alice = detail.progress.find((p: any) => p.principal === "alice@x.com");
    const recipient = detail.progress.find((p: any) => p.principal === "stakeholder");
    assert.equal(alice.counts.withdrawn, 1);
    assert.equal(recipient.counts.unanswered, 3);
  } finally { u.cleanup(); }
});
