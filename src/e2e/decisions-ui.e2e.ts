/**
 * Decision rounds, in a real browser — the person's own door to answering (owner, R18).
 *
 * What it asserts is what the page is FOR: an unanswered question shows as waiting on you;
 * answering it by clicking goes through the principal notice and is recorded as a ruling, not
 * a close — the finding moves to "ruled, not carried out" and stays open.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolvePlaywright, launchPlaywright, startServer, type Server } from "./harness.js";
import * as ops from "../ops.js";
import { shareFinding } from "../ops-shared.js";
import { readFinding } from "../store.js";
import type { Questionnaire } from "../questionnaire.js";
import { discard } from "../test-tmp.js";
import { readScope } from "../eventlog.js";
import { emitEvent } from "../write.js";
import { comparisonBriefText, decisionScope, decisionsDoor, foldDecisions } from "../shared-decisions.js";
import { resolveSidecar } from "../sidecar-config.js";

const pw = resolvePlaywright();

/** Run as an agent, restoring the process after — the suite shares one process. */
async function asAgent<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.CODEMAP_AGENT_MODEL;
  process.env.CODEMAP_AGENT_MODEL = "claude-opus-5";
  try { return await fn(); } finally { if (prev === undefined) delete process.env.CODEMAP_AGENT_MODEL; else process.env.CODEMAP_AGENT_MODEL = prev; }
}

describe("the decisions UI", { skip: pw ? false : "playwright not resolvable (set CODEMAP_E2E_PLAYWRIGHT)" }, () => {
  let root: string, side: string, server: Server, browser: any, universe: string, finding = "";

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "codemap-dec-ui-"));
    side = mkdtempSync(join(tmpdir(), "codemap-dec-ui-side-"));
    const git = (...a: string[]) => spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=izzie", ...a], { cwd: root });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "izzie@x.com");
    git("config", "user.name", "izzie");
    mkdirSync(join(root, ".codemap"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "pay.ts"), "export function transfer(cents: number) { return cents; }\n");
    writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
    git("add", "-A"); git("commit", "-qm", "seed");
    await ops.init(root);
    const anchor = (await ops.search(root, "transfer") as any).anchors[0].id;
    await asAgent(async () => {
      const f = await shareFinding(root, 3, { targetKind: "anchor", targetId: anchor, text: "transfer ignores the currency" }) as any;
      assert.ok(f.id, JSON.stringify(f));
      finding = f.id;
      const payload = { question: `D1: is the currency finding (${finding}) real?`, header: "Currency", options: [{ label: "Not a defect", description: "close as refuted" }, { label: "Real, fix it", description: "fix work" }] };
      const r = await ops.postRound(root, { round: { id: "R1", source: "e2e" }, decisions: [{
        id: "d1", round: "R1", ref: "D1", kind: "options", payload,
        options: [{ label: "Not a defect", effects: [{ findings: [finding], on: "settle", as: "refuted" }] }, { label: "Real, fix it", effects: [{ findings: [finding], on: "unblock" }] }],
      }, {
        id: "d2", round: "R1", ref: "D2", kind: "options",
        payload: { question: `D2: review ${finding} now, or park it?`, header: "Park", options: [{ label: "Park until 2099-01-01" }, { label: "Now" }] },
        options: [{ label: "Park until 2099-01-01", park: "2099-01-01", effects: [] }, { label: "Now", effects: [{ findings: [finding], on: "unblock" }] }],
      }] }) as any;
      assert.equal(r.ok, true, JSON.stringify(r));
    });
    server = await startServer(root);
    browser = await launchPlaywright(pw);
    universe = (await (await fetch(`${server.url}/api/universes`)).json()).primary;
  });

  after(async () => {
    await browser?.close();
    server?.stop();
    discard(root);
    discard(side);
  });

  async function open(path: string) {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e: Error) => errors.push(e.message));
    // HASH mode: a path-form deep link falls back to home.
    await page.goto(`${server.url}/#${path}`, { waitUntil: "networkidle" });
    return { page, errors };
  }

  test("an unanswered question waits on you; answering it is a ruling, and the finding stays open", async () => {
    const hub = await open(`/u/${universe}/decisions/`);
    await hub.page.waitForSelector("text=waiting on you (2)", { timeout: 10_000 });
    assert.deepEqual(hub.errors, []);
    await hub.page.close();

    const { page, errors } = await open(`/u/${universe}/decisions/R1/`);
    await page.waitForSelector(".op-card", { timeout: 10_000 });
    assert.match((await page.textContent("main"))!, /D1: is the currency finding \(f_[0-9a-z-]+\) real\?/);
    await page.click("button.pullbtn:has-text('Not a defect')");
    await page.waitForSelector("text=ruled, not carried out (1)", { timeout: 10_000 });
    const text = (await page.textContent("main"))!;
    assert.match(text, /waiting on you \(1\)/);
    assert.match(text, new RegExp(`${finding}: close as refuted`));
    assert.match(text, /you said: Not a defect/);
    assert.deepEqual(errors, []);
    await page.close();
    assert.notEqual((await readFinding(root, finding))?.state, "refuted", "a ruling is not a close: the verifier carries it out");
  });

  test("P4.d: a park leaves 'waiting on you' for its own view, with its date", async () => {
    const { page, errors } = await open(`/u/${universe}/decisions/R1/`);
    await page.waitForSelector("text=parked (0)", { timeout: 10_000 });
    await page.click("button.pullbtn:has-text('Park until 2099-01-01')");
    await page.waitForSelector("text=parked (1)", { timeout: 10_000 });
    const text = (await page.textContent("main"))!;
    const round = await ops.decisionRound(root, "R1") as any;
    assert.ok(text.includes(`${round.round.id} D2 — until 2099-01-01`));
    assert.match(text, /waiting on you \(0\)/);
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("C6: a held finding is marked held on the findings page — held work never looks free", async () => {
    const { page, errors } = await open(`/u/${universe}/shared/3/`);
    // It waits on nobody, so the default "needs a person" view does not list it: show everything.
    await page.click("button:has-text('showing: needs a person')");
    await page.waitForSelector(`[data-f="${finding}"]`, { timeout: 10_000 });
    const row = (await page.textContent(`[data-f="${finding}"]`))!;
    assert.match(row, /held · ruled/, row);
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("changed response shows cancellation history and disables its pending confirmation", async () => {
    const { page, errors } = await open(`/u/${universe}/decisions/R1/`);
    const question = page.locator(".op-card").filter({ hasText: "D1: is the currency finding" });
    const reply = question.getByPlaceholder("or say it in your own words…");
    await reply.fill("the premise is wrong");
    await reply.press("Tab");
    await question.locator("button").filter({ hasText: /^send$/ }).click();
    await page.waitForSelector("text=the premise is wrong", { timeout: 10_000 });
    const first = await ops.decisionRound(root, "R1") as any;
    const answer = first.decisions.find((d: any) => (d.label ?? d.id) === "d1").answers.find((a: any) => a.words === "the premise is wrong");
    const confirmation = await asAgent(() => ops.confirmReading(root, { answer: answer.id, maps: [{ decision: "d1", option: "Not a defect" }] })) as any;
    assert.equal(confirmation.ok, true, JSON.stringify(confirmation));
    await reply.fill("the premise is right; investigate it");
    await reply.press("Tab");
    await question.locator("button").filter({ hasText: /^send$/ }).click();
    await page.waitForSelector("text=Cancelled: response changed", { timeout: 10_000 });
    const cancelled = page.locator(".op-card").filter({ hasText: "Cancelled: response changed" });
    assert.equal(await cancelled.locator("button").count(), 0);
    assert.match((await question.textContent())!, /Previous answer:.*the premise is wrong/);
    assert.match((await cancelled.textContent())!, /no longer needed/);
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("an independent answer's comparison shows the complete question context", async () => {
    const previous = process.env.CODEMAP_PRINCIPAL;
    process.env.CODEMAP_PRINCIPAL = "bob@x.com";
    try {
      const answer = await ops.answerDirect(root, { decision: "d1", option: "Real, fix it" }) as any;
      assert.equal(answer.recorded, true, JSON.stringify(answer));
    } finally {
      if (previous === undefined) delete process.env.CODEMAP_PRINCIPAL;
      else process.env.CODEMAP_PRINCIPAL = previous;
    }
    const view = await ops.decisionRounds(root) as any;
    assert.ok(view.intentCandidates.length >= 1, JSON.stringify(view.intentCandidates));
    const { page, errors } = await open(`/u/${universe}/decisions/`);
    await page.waitForSelector(`text=human intent to check (${view.intentCandidates.length})`, { timeout: 10_000 });
    const content = (await page.textContent("main"))!;
    assert.match(content, /Question shown: D1: is the currency finding/);
    assert.match(content, /Not a defect: close as refuted/);
    assert.match(content, /Real, fix it: fix work/);
    assert.match(content, /acts on:/);
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("a published questionnaire submits selected answers and keeps the rest pending", async () => {
    const listPrompt = `D21: mark incorrect statements about ${finding}`;
    const questionnaire: Questionnaire = { id: "Q-browser", title: "Review this work", recipient: "izzie@x.com", sections: [
      { id: "first", title: "First", questions: [
        { id: "q-short", kind: "short", prompt: "D20: explain the intended behavior?" },
        { id: "q-list", kind: "list", prompt: listPrompt, items: [
          { id: "item-a", text: "Keep A", action: `unblocks ${finding}` }, { id: "item-b", text: "Keep B" },
        ] },
      ] },
    ] };
    const posted = await asAgent(() => ops.postRound(root, { round: { id: "RQ-browser", source: "e2e", questionnaire }, decisions: [
      { id: "q-short", round: "RQ-browser", ref: "D20", kind: "words",
        payload: { question: "D20: explain the intended behavior?", options: [] }, options: [] },
      { id: "q-list", round: "RQ-browser", ref: "D21", kind: "bulk",
        payload: { question: listPrompt, multiSelect: true,
          options: [{ label: "Keep A" }, { label: "Keep B" }, { label: "Approve all" }] },
        options: [{ label: "Keep A", effects: [{ findings: [finding], on: "unblock" }] }, { label: "Keep B", effects: [] },
          { label: "Approve all", approveAll: true, effects: [] }] },
    ] })) as any;
    assert.equal(posted.ok, true, JSON.stringify(posted));
    const { page, errors } = await open(`/u/${universe}/decisions/RQ-browser/`);
    await page.waitForSelector('.questionnaire-form', { timeout: 10_000 });
    assert.match((await page.textContent('main'))!, /Review this work/);
    const short = page.locator('[data-question-id="q-short"]');
    await short.locator('textarea').fill('Keep behavior A');
    await short.getByRole('button', { name: 'Submit this answer' }).click();
    await page.waitForFunction(() => document.body.textContent?.includes('1 submitted'));
    const partial = await ops.questionnaireDetail(root, 'RQ-browser', 'izzie@x.com') as any;
    assert.equal(partial.progress.find((x: any) => x.principal === 'izzie@x.com').counts.submitted, 1);
    assert.equal(partial.progress.find((x: any) => x.principal === 'izzie@x.com').counts.unanswered, 1);
    await page.waitForSelector('[data-question-id="q-list"]');
    const list = page.locator('[data-question-id="q-list"]');
    await list.getByPlaceholder('Correction for Keep B').fill('Change B');
    await list.getByLabel('I have reviewed every item in this list').check();
    await list.getByRole('button', { name: /Submit this list/ }).click();
    await page.waitForFunction(() => document.body.textContent?.includes('2 submitted'));
    const done = await ops.questionnaireDetail(root, 'RQ-browser', 'izzie@x.com') as any;
    assert.equal(done.progress.find((x: any) => x.principal === 'izzie@x.com').counts.unanswered, 0);
    assert.equal(done.questions.find((x: any) => x.questionId === 'q-list').answers.length, 1);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('text=revise or withdraw');
    // Submitted answers stay in their cards across a reload, and the form's title does not
    // pick up the app's sticky page-header styling.
    assert.equal(await short.locator('textarea').inputValue(), 'Keep behavior A');
    assert.equal(await list.getByPlaceholder('Correction for Keep B').inputValue(), 'Change B');
    assert.equal(await list.getByLabel('Mark wrong').nth(1).isChecked(), true);
    assert.equal(await page.locator('.questionnaire-form .q-head').evaluate((el: Element) => getComputedStyle(el).position), 'static');
    const shortRuling = page.locator('.op-card').filter({ hasText: 'D20: explain the intended behavior?' }).last();
    assert.match((await shortRuling.textContent())!, /answer history \(1\)/);
    await shortRuling.getByRole('button', { name: 'review what you are revising' }).click();
    await shortRuling.locator('pre').waitFor();
    await shortRuling.getByPlaceholder('revised answer').fill('Keep behavior B');
    await shortRuling.getByPlaceholder('revised answer').press('Tab');
    await shortRuling.getByRole('button', { name: 'revise answer' }).click();
    await page.waitForFunction(() => document.body.textContent?.includes('Keep behavior B'));
    const revised = await ops.decisionRound(root, 'RQ-browser') as any;
    assert.ok(revised.decisions.find((d: any) => (d.label ?? d.id) === 'q-short').answers.some((a: any) => a.revision));
    const beforeListRevision = await ops.decisionRound(root, 'RQ-browser') as any;
    const listState = beforeListRevision.decisions.find((d: any) => (d.label ?? d.id) === 'q-list');
    assert.ok(listState?.currentByFinding?.[finding], JSON.stringify(listState));
    const listRuling = page.locator('.op-card').filter({ hasText: listPrompt })
      .filter({ has: page.getByPlaceholder('reason for withdrawal') }).first();
    assert.match((await listRuling.textContent())!, /Select the exact findings or bugs to revise/);
    await listRuling.getByLabel(new RegExp(`finding ${finding}`)).check();
    await listRuling.getByRole('button', { name: 'review what you are revising' }).click();
    await listRuling.locator('pre').waitFor();
    const reviseList = listRuling.getByRole('button', { name: 'revise reviewed list' });
    assert.equal(await reviseList.isDisabled(), false, "the reviewed item can be explicitly approved");
    await listRuling.getByLabel('Mark wrong: Keep A').check();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) =>
      button.textContent?.includes('revise reviewed list') && button.disabled));
    assert.equal(await reviseList.isDisabled(), true, "marking wrong requires a correction");
    await listRuling.getByPlaceholder('Correction for Keep A').fill('Keep A must change');
    await reviseList.click();
    await listRuling.getByText('answer history (2)').waitFor();
    const listRevised = await ops.decisionRound(root, 'RQ-browser') as any;
    const revision = listRevised.decisions.find((d: any) => (d.label ?? d.id) === 'q-list').answers.find((a: any) => a.revision);
    assert.deepEqual(revision.questionnaire.corrections, [{ itemId: 'item-a', text: 'Keep A must change', verdict: 'pending' }]);
    assert.match((await listRuling.textContent())!, /Keep A must change/);
    await listRuling.getByPlaceholder('reason for withdrawal').fill('The list needs a fresh question');
    await listRuling.getByPlaceholder('reason for withdrawal').press('Tab');
    await listRuling.getByRole('button', { name: 'withdraw this ruling' }).click();
    await page.waitForFunction(() => document.body.textContent?.includes('The list needs a fresh question'));
    const withdrawn = await ops.decisionRound(root, 'RQ-browser') as any;
    assert.ok(withdrawn.decisions.find((d: any) => (d.label ?? d.id) === 'q-list').answers.some((a: any) => a.withdrawn));
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("B11 (F6): a choice question answered through the real server at phone width", async () => {
    const prompt = `D30: is ${finding} a real defect?`;
    const questionnaire: Questionnaire = { id: "Q-phone", title: "Phone review", recipient: "izzie@x.com", sections: [
      { id: "only", title: "Only", questions: [
        { id: "q-choice", kind: "choice", prompt, allowOther: false, options: [
          { id: "fix", label: "Real, fix it", description: "Fix claim", action: `unblocks ${finding}` },
          { id: "reject", label: "Not a defect", description: "Reject claim", action: `settles ${finding} as refuted` },
        ] },
      ] },
    ] };
    const posted = await asAgent(() => ops.postRound(root, { round: { id: "RQ-phone", source: "e2e", questionnaire }, decisions: [
      { id: "q-choice", round: "RQ-phone", ref: "D30", kind: "options",
        payload: { question: prompt, options: [{ label: "Real, fix it", description: "Fix claim" }, { label: "Not a defect", description: "Reject claim" }] },
        options: [{ label: "Real, fix it", effects: [{ findings: [finding], on: "unblock" }] },
          { label: "Not a defect", effects: [{ findings: [finding], on: "settle", as: "refuted" }] }] },
    ] })) as any;
    assert.equal(posted.ok, true, JSON.stringify(posted));
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.goto(`${server.url}/#/u/${universe}/decisions/RQ-phone/`, { waitUntil: "networkidle" });
    await page.waitForSelector('.questionnaire-form', { timeout: 10_000 });
    const fits = () => page.evaluate(() => document.scrollingElement!.scrollWidth <= document.scrollingElement!.clientWidth + 1);
    const wide = await page.evaluate(() => [...document.querySelectorAll("*")].filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
      .slice(0, 12).map((el) => `${el.tagName.toLowerCase()}.${(el as HTMLElement).className} w=${Math.round(el.getBoundingClientRect().width)} r=${Math.round(el.getBoundingClientRect().right)}`));
    assert.equal(await fits(), true, `the real page fits a phone: ${JSON.stringify(wide)}`);
    const choice = page.locator('[data-question-id="q-choice"]');
    await choice.getByText("Real, fix it", { exact: true }).click();
    await choice.getByRole('button', { name: 'Submit this answer' }).click();
    await page.waitForFunction(() => document.body.textContent?.includes('1 submitted'));
    const detail = await ops.questionnaireDetail(root, 'RQ-phone', 'izzie@x.com') as any;
    assert.equal(detail.progress.find((x: any) => x.principal === 'izzie@x.com').counts.submitted, 1);
    assert.equal(await fits(), true, "and still fits once answered");
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("an identity-less or blocked questionnaire shows the complete frozen form without submission", async () => {
    const choicePrompt = `D30: read the rationale and decide whether ${finding} should close. Choice context. Action: settle or fix.`;
    const listPrompt = `D32: inspect ${finding} item by item. List context. Action: settle or fix.`;
    const questionnaire: Questionnaire = { id: "Q-readonly", title: "Frozen review", context: "Read the whole batch",
      recipient: "stakeholder@x.com", sections: [{ id: "section", title: "Risk section", context: "Section context", questions: [
        { id: "q-read-choice", kind: "choice", prompt: choicePrompt, context: "Choice context", action: "settle or fix",
          allowOther: true, options: [
            { id: "reject", label: "Reject", description: "Claim is invalid", action: `settles ${finding} as refuted` },
            { id: "fix", label: "Fix", description: "Work remains", action: `unblocks ${finding}` },
          ] },
        { id: "q-read-short", kind: "short", prompt: "D31: explain why. Short context", context: "Short context" },
        { id: "q-read-list", kind: "list", prompt: listPrompt, context: "List context", action: "settle or fix",
          items: [
            { id: "item-reject", text: "Reject item", context: "Reject context", action: `settles ${finding} as refuted` },
            { id: "item-fix", text: "Fix item", context: "Fix context", action: `unblocks ${finding}` },
          ] },
      ] }] };
    const posted = await asAgent(() => ops.postRound(root, { round: { id: "RQ-readonly", source: "e2e", questionnaire }, decisions: [
      { id: "q-read-choice", round: "RQ-readonly", ref: "D30", kind: "options", payload: { question: choicePrompt,
        options: [{ label: "Reject", description: "Claim is invalid" }, { label: "Fix", description: "Work remains" }] },
        options: [{ label: "Reject", effects: [{ findings: [finding], on: "settle", as: "refuted" }] },
          { label: "Fix", effects: [{ findings: [finding], on: "unblock" }] }] },
      { id: "q-read-short", round: "RQ-readonly", ref: "D31", kind: "words",
        payload: { question: "D31: explain why. Short context", options: [] }, options: [] },
      { id: "q-read-list", round: "RQ-readonly", ref: "D32", kind: "bulk", payload: { question: listPrompt,
        multiSelect: true, options: [{ label: "Reject item", description: "Reject context" },
          { label: "Fix item", description: "Fix context" }, { label: "Approve all", description: "" }] },
        options: [{ label: "Reject item", effects: [{ findings: [finding], on: "settle", as: "refuted" }] },
          { label: "Fix item", effects: [{ findings: [finding], on: "unblock" }] },
          { label: "Approve all", approveAll: true, effects: [] }] },
    ] })) as any;
    assert.equal(posted.ok, true, JSON.stringify(posted));
    spawnSync("git", ["config", "--unset", "user.email"], { cwd: root });
    const oldGlobal = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    let readonlyServer: Server | undefined;
    try {
      readonlyServer = await startServer(root);
      const page = await browser.newPage();
      await page.goto(`${readonlyServer.url}/#/u/${universe}/decisions/RQ-readonly/`, { waitUntil: "networkidle" });
      const content = (await page.textContent("main"))!;
      for (const expected of ["Read the whole batch", "Section context", "Choice context", "Claim is invalid",
        `settles ${finding} as refuted`, "Other — write your answer", "Short context", "Write a short answer",
        "List context", "Reject context", "Fix context", "Submitting this list approves every unmarked item"])
        assert.ok(content.includes(expected), expected);
      assert.equal(await page.locator(".questionnaire-form").count(), 0);
      assert.equal(await page.getByRole("button", { name: /submit/i }).count(), 0);
      writeFileSync(join(root, ".codemap", "sidecar"), join(root, "missing-sidecar"));
      try {
        await page.reload({ waitUntil: "networkidle" });
        const blocked = (await page.textContent("main"))!;
        assert.match(blocked, /questionnaire log is blocked/i);
        assert.match(blocked, /Submitting this list approves every unmarked item/);
        assert.match(blocked, /Claim is invalid/);
        assert.equal(await page.getByRole("button", { name: /submit/i }).count(), 0);
      } finally { writeFileSync(join(root, ".codemap", "sidecar"), side); }
      await page.close();
    } finally {
      readonlyServer?.stop();
      if (oldGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = oldGlobal;
    }
  });

  test("a human sees exact comparison evidence and explicitly resolves it", async () => {
    const view = await ops.decisionRounds(root) as any;
    const candidate = view.intentCandidates.find((x: any) => x.findings.includes(finding));
    assert.ok(candidate, JSON.stringify(view.intentCandidates));
    const requested = await asAgent(() => ops.requestComparison(root, { answers: candidate.answers })) as any;
    assert.equal(requested.ok, true, JSON.stringify(requested));
    const id = requested.id as string;
    const request = requested.comparison.request;
    const cfg = resolveSidecar(root)!;
    await emitEvent(cfg.path, decisionScope(cfg.universe), { principal: "independent-reader@x.com" },
      "decision.comparison.judged", id, {
        judgment: { requestId: id, contextHash: request.contextHash, issues: request.issues,
          answerVersions: [`${request.left.answerId}\0${request.left.version}`, `${request.right.answerId}\0${request.right.version}`],
          verdict: "incompatible", rationale: "The first permits closure while the second requires work.",
          reader: { principal: "independent-reader@x.com", agent: "reader-e2e", session: "reader-session",
            request: "reader-launch", receipt: "reader-receipt" } },
        proof: { purpose: "pair-comparison", requestId: id, contextHash: request.contextHash,
          brief: comparisonBriefText(request), receipt: "reader-receipt", agent: "reader-e2e",
          session: "reader-session", launch: "reader-launch", toolUseId: "reader-launch", call: "reader-call" },
      }, decisionsDoor);
    const pure = foldDecisions(await readScope(cfg.path, decisionScope(cfg.universe)));
    assert.equal(pure.comparisons.find((x) => x.request.id === id)?.projection.state, "incompatible", JSON.stringify(pure.comparisons));
    const detail = await ops.comparisonDetail(root, id) as any;
    assert.equal(detail.comparison.projection.state, "incompatible", JSON.stringify(detail.comparison.projection));
    const { page, errors } = await open(`/u/${universe}/decisions/?comparison=${encodeURIComponent(id)}`);
    await page.waitForSelector("text=incompatible intent", { timeout: 10_000 });
    const content = (await page.textContent("main"))!;
    assert.match(content, /D1: is the currency finding/);
    assert.match(content, /Not a defect: close as refuted/);
    assert.match(content, /The first permits closure while the second requires work/);
    assert.match(content, /executed closures involving these rulings/);
    assert.match(content, /No local principal identity is configured|Resolve this disagreement/);
    await page.locator(`input[name="comparison-preserve"][value="${request.left.answerId}"]`).check();
    await page.locator(".op-card label").filter({ hasText: "Reason for this choice" }).locator("textarea").fill("The first ruling matches the product intent.");
    await page.getByRole("button", { name: "record explicit resolution" }).click();
    await page.waitForSelector("text=resolved by human choice", { timeout: 10_000 });
    const resolved = await ops.comparisonDetail(root, id) as any;
    assert.equal(resolved.comparison.projection.preservedAnswer, request.left.answerId);
    const prior = resolved.comparison.projection.acceptedResolutions[0];
    await page.locator("select").selectOption(prior.id);
    await page.locator(`input[name="comparison-preserve"][value="${request.right.answerId}"]`).check();
    await page.locator(".op-card label").filter({ hasText: "Reason for this choice" }).locator("textarea")
      .fill("On review, the second ruling matches the product intent.");
    await page.getByRole("button", { name: "record corrected resolution" }).click();
    await page.waitForFunction((wanted: string) => document.body.textContent?.includes(`Preserved answer: ${wanted}`), request.right.answerId);
    const corrected = await ops.comparisonDetail(root, id) as any;
    assert.equal(corrected.comparison.projection.preservedAnswer, request.right.answerId);
    assert.equal(corrected.comparison.projection.acceptedResolutions[1].revises, prior.id);
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("a person reviews a bug-scoped revision and approves an exact agent withdrawal", async () => {
    const anchor = (await readFinding(root, finding))!.target.id;
    const cfg = resolveSidecar(root)!;
    const bug = await asAgent(() => ops.reportBug(root, {
      title: "Unexpected currency behavior", description: "The premise needs a product ruling", anchors: [anchor],
    })) as any;
    assert.equal(bug.ok, true, JSON.stringify(bug));
    const issue = { kind: "bug" as const, universe: cfg.universe, scope: `bugs/${cfg.universe}`, id: bug.id };
    const posted = await asAgent(() => ops.postRound(root, { round: { id: "R-bug-web", source: "e2e" }, decisions: [{
      id: "bug-web", round: "R-bug-web", ref: "D30", kind: "options",
      payload: { question: `D30: how should ${bug.id} be handled?`, options: [{ label: "Not a defect" }, { label: "Repair it" }] },
      options: [{ label: "Not a defect", effects: [{ findings: [], issues: [issue], on: "settle", as: "refuted" }] },
        { label: "Repair it", effects: [{ findings: [], issues: [issue], on: "unblock" }] }],
    }] })) as any;
    assert.equal(posted.ok, true, JSON.stringify(posted));
    const first = await ops.answerDirect(root, { decision: "bug-web", option: "Not a defect" }) as any;
    assert.equal(first.recorded, true, JSON.stringify(first));

    const { page, errors } = await open(`/u/${universe}/decisions/R-bug-web/`);
    const card = page.locator(".op-card").filter({ hasText: `D30: how should ${bug.id}` });
    await card.getByLabel(new RegExp(`bug ${bug.id}`)).check();
    await card.getByRole("button", { name: "review what you are revising" }).click();
    await card.getByText(/^Revising /).waitFor();
    assert.match((await card.textContent())!, new RegExp(first.answer));
    await card.getByRole("button", { name: "revise selected to Repair it" }).click();
    await page.waitForFunction(() => document.body.textContent?.includes("you said: Repair it"));
    const revised = await ops.decisionRound(root, "R-bug-web") as any;
    const current = revised.decisions.find((d: any) => (d.label ?? d.id) === "bug-web");
    const second = current.answers.find((a: any) => a.revision?.of.includes(first.answer));
    assert.ok(second, JSON.stringify(current.answers));
    assert.deepEqual(second.revision.issues, [issue]);

    await card.getByPlaceholder("reason for withdrawal").fill("The product owner is reconsidering this instruction");
    await card.getByPlaceholder("reason for withdrawal").press("Tab");
    await card.getByRole("button", { name: "withdraw this ruling" }).click();
    await page.waitForFunction(() => document.body.textContent?.includes("Ruling withdrawn"));
    await page.reload({ waitUntil: "networkidle" });
    assert.match((await page.textContent("main"))!, /Ruling withdrawn. Ask a fresh question/);
    assert.equal(await page.getByRole("button", { name: "withdraw unanswered question" }).count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
  });

});
