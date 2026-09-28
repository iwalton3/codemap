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
            questionnaire: ${JSON.stringify(q)}, publicationId: new URLSearchParams(location.search).get('publication') || 'pub-1', version: 'v1', principal: 'alice',
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

  /** No horizontal scrolling anywhere on the page: the phone layout must fit. */
  const fits = (page: any) => page.evaluate(() => document.scrollingElement!.scrollWidth <= document.scrollingElement!.clientWidth + 1);

  for (const [label, viewport] of [["desktop", { width: 1280, height: 800 }], ["phone", { width: 390, height: 844 }]] as const) {
    test(`${label}: one question of each format is answered and submitted end to end`, async () => {
      const page = await browser.newPage({ viewport });
      const errors: string[] = [];
      page.on("pageerror", (e: Error) => errors.push(e.message));
      await page.goto(`${base}/?publication=${label}`);
      assert.equal(await fits(page), true, "the form fits the width");
      const state = (id: string) => page.locator(`[data-question-id="${id}"]`).getAttribute("data-state");

      const choice = page.locator('[data-question-id="choice"]');
      assert.equal(await state("choice"), "draft");
      await choice.getByText("Yes", { exact: true }).click();
      assert.equal(await state("choice"), "ready");
      await choice.getByRole("button", { name: "Submit this answer" }).click();
      await page.waitForFunction(() => (window as any).calls.length === 1);
      assert.deepEqual(await page.evaluate(() => (window as any).calls[0].answers), [{ questionId: "choice", kind: "choice", optionId: "yes" }]);
      assert.equal(await state("choice"), "submitted");

      const short = page.locator('[data-question-id="short"]');
      await short.locator("textarea").fill("Because the current behavior is relied on");
      await short.getByRole("button", { name: "Submit this answer" }).click();
      await page.waitForFunction(() => (window as any).calls.length === 2);
      assert.deepEqual(await page.evaluate(() => (window as any).calls[1].answers),
        [{ questionId: "short", kind: "short", text: "Because the current behavior is relied on" }]);

      const list = page.locator('[data-question-id="list"]');
      await list.getByLabel("Mark wrong").first().check();
      assert.equal(await state("list"), "draft", "a list is never ready until it is reviewed");
      await list.getByPlaceholder("Correction for Keep A").fill("A must change");
      await list.getByLabel("I have reviewed every item in this list").check();
      assert.equal(await state("list"), "ready");
      assert.equal(await fits(page), true, "an open correction box still fits");
      await list.getByRole("button", { name: /Submit this list/ }).click();
      await page.waitForFunction(() => (window as any).calls.length === 3);
      assert.deepEqual(await page.evaluate(() => (window as any).calls[2].answers),
        [{ questionId: "list", kind: "list", approveUnmarked: true, marked: [{ itemId: "a", correction: "A must change" }] }]);
      assert.match(await page.locator(".q-message").innerText(), /Receipt: receipt-1/);
      assert.deepEqual(errors, []);
      await page.close();
    });
  }

  test("a draft survives reload, a marked item without a correction is not ready, and a failed submit keeps everything", async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/?publication=drafts`);
    await page.locator('[data-question-id="short"] textarea').fill("Because it matters");
    await page.locator('[data-question-id="choice"]').getByText("Yes", { exact: true }).click();
    await page.reload();
    assert.equal(await page.locator('[data-question-id="short"] textarea').inputValue(), "Because it matters");
    const list = page.locator('[data-question-id="list"]');
    await list.getByLabel("Mark wrong").first().check();
    await list.getByLabel("I have reviewed every item in this list").check();
    assert.equal(await list.getAttribute("data-state"), "draft", "a marked item needs its correction");
    const all = page.locator(".q-bottom button");
    assert.match(await all.innerText(), /Submit 2 ready answers/);
    await page.evaluate(() => { (window as any).failSubmit = true; });
    await all.click();
    await page.locator(".q-error").filter({ hasText: "temporarily unavailable" }).waitFor();
    assert.equal(await page.locator('[data-question-id="short"] textarea').inputValue(), "Because it matters");
    await page.evaluate(() => { (window as any).failSubmit = false; });
    await all.click();
    await page.waitForFunction(() => (window as any).calls.length === 2);
    const [failed, sent] = await page.evaluate(() => (window as any).calls);
    assert.equal(failed.attemptId, sent.attemptId, "a retry of the same answers is the same attempt");
    assert.deepEqual(sent.answers.map((a: any) => a.questionId), ["choice", "short"]);
    await page.close();
  });
});
