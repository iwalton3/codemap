import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { resolvePlaywright, launchPlaywright } from "./harness.js";

const pw = resolvePlaywright();
const q = {
  id: "Q1", title: "Review the work", recipient: "owner", sections: [
    { id: "first", title: "First", questions: [
      { id: "choice", kind: "choice", prompt: "Choose", allowOther: true,
        options: [{ id: "yes", label: "Yes", description: "Keep the current behavior" }] },
      { id: "short", kind: "short", prompt: "Explain why" },
    ] },
    { id: "second", title: "Second", questions: [
      { id: "list", kind: "list", prompt: "Mark wrong items", items: [
        { id: "a", text: "Keep A" }, { id: "b", text: "Keep B" },
      ] },
    ] },
  ],
};

describe("questionnaire form in a browser", { skip: pw ? false : "playwright not resolvable" }, () => {
  let server: Server, browser: any, base: string;
  before(async () => {
    server = createServer((req, res) => {
      if (req.url === "/questionnaire.js") {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(readFileSync("web/questionnaire.js"));
      } else {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<main id="form"></main><script type="module">
          import { mountQuestionnaire } from '/questionnaire.js';
          window.calls = []; window.failSubmit = false;
          mountQuestionnaire(document.querySelector('#form'), {
            questionnaire: ${JSON.stringify(q)}, version: 'v1', principal: 'alice',
            onSubmit: async (payload) => { window.calls.push(payload); return window.failSubmit
              ? { error: 'temporarily unavailable' } : { ok: true, receipt: 'receipt-1' }; },
          });
        </script>`);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await launchPlaywright(pw);
  });
  after(async () => { await browser?.close(); await new Promise<void>((resolve) => server?.close(() => resolve())); });

  test("draft survives reload; incomplete list cannot submit; receipt clears submitted controls", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.goto(base);
    const short = page.locator('[data-question-id="short"]');
    await short.locator('textarea').fill("Because it matters");
    await short.locator('input[data-select-question]').check();
    await page.reload();
    assert.equal(await page.locator('[data-question-id="short"] textarea').inputValue(), "Because it matters");
    assert.equal(await page.locator('[data-question-id="short"] input[data-select-question]').isChecked(), true);
    const list = page.locator('[data-question-id="list"]');
    await list.locator('input[type="checkbox"]').nth(2).check();
    await list.getByRole('button', { name: /Submit this list/ }).click();
    assert.match(await page.locator('.q-error').innerText(), /correction/);
    assert.equal(await page.evaluate(() => (window as any).calls.length), 0);
    await list.locator('textarea').nth(1).fill("Change B");
    await list.locator('input[data-select-question]').check();
    await page.getByRole('button', { name: /Submit selected questions — approve unmarked/ }).click();
    const calls = await page.evaluate(() => (window as any).calls);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].answers.map((a: any) => a.questionId), ["short", "list"]);
    assert.deepEqual(calls[0].answers[1], { questionId: "list", kind: "list", approveUnmarked: true,
      marked: [{ itemId: "b", correction: "Change B" }] });
    assert.match(await page.locator('.q-message').innerText(), /receipt-1/);
    assert.equal(await page.locator('[data-question-id="short"] textarea').inputValue(), "");
    assert.equal(await page.locator('[data-question-id="list"] input[data-select-question]').isChecked(), false);
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("failed submission retries the same attempt until its content changes", async () => {
    const page = await browser.newPage();
    await page.goto(base);
    await page.evaluate(() => { (window as any).failSubmit = true; });
    const short = page.locator('[data-question-id="short"]');
    await short.locator('textarea').fill("First answer");
    await short.getByRole('button', { name: 'Submit this answer' }).click();
    assert.match(await page.locator('.q-error').innerText(), /temporarily unavailable/);
    await short.getByRole('button', { name: 'Submit this answer' }).click();
    await short.locator('textarea').fill("Changed answer");
    await short.getByRole('button', { name: 'Submit this answer' }).click();
    const calls = await page.evaluate(() => (window as any).calls);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].attemptId, calls[1].attemptId);
    assert.notEqual(calls[1].attemptId, calls[2].attemptId);
    await page.close();
  });
});
