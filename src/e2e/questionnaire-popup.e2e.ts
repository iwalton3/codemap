import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as ops from "../ops.js";
import { sharedSync } from "../ops-shared.js";
import { discard } from "../test-tmp.js";
import { resolvePlaywright, launchPlaywright, startServer, watchErrors, type Server } from "./harness.js";
import type { Questionnaire } from "../questionnaire.js";

const pw = resolvePlaywright();
describe("pending questionnaire popup", { skip: pw ? false : "playwright not resolvable" }, () => {
  let root: string, side: string, server: Server, browser: any, universe: string;
  before(async () => {
    root = mkdtempSync(join(tmpdir(), "codemap-popup-")); side = mkdtempSync(join(tmpdir(), "codemap-popup-side-"));
    const git = (...args: string[]) => spawnSync("git", args, { cwd: root });
    git("init", "-q", "-b", "main"); git("config", "user.email", "popup@example.test"); git("config", "user.name", "Popup reviewer");
    mkdirSync(join(root, ".codemap")); writeFileSync(join(root, ".codemap", "sidecar"), side);
    writeFileSync(join(root, "sample.ts"), "export function sample() { return 1; }\n");
    git("add", "-A"); git("commit", "-qm", "fixture"); await ops.init(root); await sharedSync(root);
    server = await startServer(root); browser = await launchPlaywright(pw);
    universe = (await (await fetch(`${server.url}/api/universes`)).json()).primary;
  });
  after(async () => { await browser?.close(); server?.stop(); discard(root); discard(side); });
  async function publish(id: string, recipient?: string) {
    const questionnaire: Questionnaire = { id, title: `Review ${id}`, recipient, context: "Frozen context", sections: [
      { id: "section", title: "Full batch", questions: [
        { id: `${id}-a`, kind: "short", prompt: "D1: Explain the intended behavior" },
        { id: `${id}-b`, kind: "short", prompt: "D2: Describe the follow-up" },
      ] },
    ] };
    const prev = process.env.CODEMAP_AGENT_MODEL; process.env.CODEMAP_AGENT_MODEL = "claude-opus-5";
    try {
      const result = await ops.postRound(root, { round: { id, source: "popup browser test", questionnaire }, decisions: questionnaire.sections[0]!.questions.map((q, i) => ({
        id: q.id, round: id, ref: `D${i + 1}`, kind: "words" as const, payload: { question: q.prompt, options: [] }, options: [],
      })) });
      assert.equal("ok" in result && result.ok, true, JSON.stringify(result));
    } finally { if (prev === undefined) delete process.env.CODEMAP_AGENT_MODEL; else process.env.CODEMAP_AGENT_MODEL = prev; }
  }
  test("a new questionnaire shows as a badge without taking focus; Escape keeps the draft; a dismissal survives reload", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
    const { errors } = watchErrors(page);
    await page.goto(`${server.url}/#/u/${universe}/`, { waitUntil: "networkidle" });
    assert.equal(await page.locator('.questionnaire-popup[open]').count(), 0);
    await page.locator('main').click();
    await publish("popup-first", "popup@example.test");
    await page.locator('.questionnaire-notice.is-new').waitFor({ timeout: 22000 });
    assert.match(await page.locator('.questionnaire-notice').innerText(), /New questionnaire: Review popup-first/);
    assert.equal(await page.locator('.questionnaire-popup[open]').count(), 0, "a poll never opens the dialog");
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.questionnaire-popup,.questionnaire-notice')), false,
      "and never takes focus");
    await page.locator('.questionnaire-notice').click();
    await page.locator('.questionnaire-popup[open]').waitFor();
    const first = page.locator('[data-question-id="popup-first-a"]');
    await first.locator('textarea').fill("This draft survives dismissal");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator('.questionnaire-popup[open]').count(), 0);
    assert.equal((await ops.questionnaireDetail(root, "popup-first", "popup@example.test") as any).progress[0].counts.submitted, 0);
    // A poll must not pop the same publication again, and nor must a reload.
    await page.waitForTimeout(15500);
    assert.equal(await page.locator('.questionnaire-popup[open]').count(), 0);
    await page.reload({ waitUntil: "networkidle" });
    await page.locator('.questionnaire-notice').waitFor();
    assert.equal(await page.locator('.questionnaire-popup[open]').count(), 0);
    assert.equal(await page.locator('.questionnaire-notice.is-new').count(), 0, "a dismissed questionnaire is not new after reload");
    await page.locator('.questionnaire-notice').click();
    assert.equal(await first.locator('textarea').inputValue(), "This draft survives dismissal");
    const second = page.locator('[data-question-id="popup-first-b"]');
    await second.locator('textarea').fill("Keep this unsubmitted draft");
    await first.getByRole('button', { name: 'Submit this answer', exact: true }).click();
    await page.locator('.q-message').filter({ hasText: 'Receipt:' }).waitFor();
    await page.waitForFunction(() => document.querySelector('[data-popup-progress]')?.textContent?.includes('1 submitted; 1 unanswered'));
    assert.equal(await second.locator('textarea').inputValue(), "Keep this unsubmitted draft");
    assert.equal(await page.locator('.questionnaire-popup[open]').count(), 1);
    await second.getByRole('button', { name: 'Submit this answer', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-popup-progress]')?.textContent?.includes('2 submitted; 0 unanswered'));
    assert.match(await page.locator('.q-message').innerText(), /Receipt:/);
    const width = await page.locator('.questionnaire-popup').evaluate((el: HTMLElement) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    assert.ok(width.scroll <= width.client + 1, JSON.stringify(width));
    assert.deepEqual(errors, []); await page.close();
  });
  test("other recipients do not auto-open; decisions pages do not mount a duplicate form", async () => {
    await publish("popup-other", "someone@example.test");
    const page = await browser.newPage(); await page.goto(`${server.url}/#/u/${universe}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.questionnaire-popup[open]').count(), 0);
    await publish("popup-inline", "popup@example.test");
    await page.goto(`${server.url}/#/u/${universe}/decisions/popup-inline/`, { waitUntil: "networkidle" });
    await page.locator('main .questionnaire-form').waitFor();
    assert.equal(await page.locator('.questionnaire-popup .questionnaire-form').count(), 0);
    assert.equal(await page.locator('.questionnaire-popup[open]').count(), 0); await page.close();
  });
  test("blocked refresh retains draft; identity changed before submit refuses a POST", async () => {
    const page = await browser.newPage();
    await page.goto(`${server.url}/#/u/${universe}/`, { waitUntil: "networkidle" });
    await page.locator('.questionnaire-notice').click();
    await page.locator('.questionnaire-popup[open]').waitFor();
    const draft = page.locator('.questionnaire-popup textarea').first();
    await draft.fill("Retain through unavailable state");
    await page.route('**/api/decisions/questionnaires?**', async (route: any) => {
      const response = await route.fetch(); const body = await response.json();
      body.status = { ...body.status, status: "blocked" }; await route.fulfill({ response, json: body });
    });
    await page.evaluate(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
    await page.waitForFunction(() => document.querySelector('.questionnaire-popup [role="status"]')?.textContent?.includes('blocked'));
    assert.equal(await draft.inputValue(), "Retain through unavailable state"); assert.equal(await draft.isDisabled(), true);
    await page.unroute('**/api/decisions/questionnaires?**');
    await page.evaluate(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
    await page.waitForFunction(() => !(document.querySelector('.questionnaire-popup textarea') as HTMLTextAreaElement)?.disabled);
    let posts = 0; page.on('request', (request: any) => { if (request.url().includes('/questionnaire/submit')) posts++; });
    await page.route('**/api/decisions/questionnaire?**', async (route: any) => {
      const response = await route.fetch(); const body = await response.json();
      body.currentPrincipal = 'changed@example.test'; await route.fulfill({ response, json: body });
    });
    await page.locator('.questionnaire-popup').getByRole('button', { name: 'Submit this answer', exact: true }).first().click();
    await page.locator('.q-error').filter({ hasText: 'No submission was sent' }).waitFor();
    assert.equal(posts, 0); assert.equal(await draft.inputValue(), "Retain through unavailable state"); await page.close();
  });

  test("late detail after universe switch cannot mount or reopen old questionnaire", async () => {
    const page = await browser.newPage();
    let release: () => void = () => {}; let received: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const requested = new Promise<void>((resolve) => { received = resolve; });
    await page.route('**/api/decisions/questionnaire?**', async (route: any) => {
      const response = await route.fetch(); received(); await held; await route.fulfill({ response });
    });
    await page.goto(`${server.url}/#/u/${universe}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('.questionnaire-notice').click();
    await requested;
    await page.evaluate(async () => { const modulePath = '/core.js'; const { nav } = await import(modulePath); nav.current = null; });
    release(); await page.waitForTimeout(300);
    assert.equal(await page.locator('.questionnaire-popup[open]').count(), 0);
    assert.equal(await page.locator('.questionnaire-popup .questionnaire-form').count(), 0);
    assert.equal(await page.locator('.questionnaire-notice').isVisible(), false); await page.close();
  });

});
