import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { resolvePuppeteer, startServer, makeFixture, makeRevertFixture, watchErrors, launch, type Server, type Fixture } from "./harness.js";

const puppeteer = resolvePuppeteer();

describe("web UI", { skip: puppeteer ? false : "puppeteer not resolvable (set CODEMAP_E2E_PUPPETEER)" }, () => {
  let fixture: Fixture, server: Server, browser: any;

  before(async () => {
    fixture = await makeFixture();
    server = await startServer(fixture.root);
    browser = await launch(puppeteer);
  });

  after(async () => {
    await browser?.close();
    server?.stop();
    fixture?.cleanup();
  });

  /** Deep links are HASH-mode (`/#/u/...`); a path-form link silently falls back to home. */
  const routes = () => [
    { name: "home / outline", hash: "#/" },
    { name: "node catalog", hash: `#/u/${fixture.universe}/nodes/` },
    { name: "node detail", hash: `#/u/${fixture.universe}/node/n_transfer_flow/` },
    { name: "flows", hash: `#/u/${fixture.universe}/flows/` },
    { name: "diff", hash: `#/u/${fixture.universe}/diff/` },
  ];

  test("every core route renders without a console error", async () => {
    for (const r of routes()) {
      const page = await browser.newPage();
      const seen = watchErrors(page);
      await page.goto(`${server.url}/${r.hash}`, { waitUntil: "networkidle0", timeout: 20_000 });
      const text = await page.evaluate(() => document.body.innerText);
      assert.ok(text.trim().length > 0, `${r.name}: rendered an empty body`);
      assert.deepEqual(seen.errors, [], `${r.name}: page reported errors`);
      await page.close();
    }
  });

  test("a deep link to a node renders that node, not the home fallback", async () => {
    const page = await browser.newPage();
    const seen = watchErrors(page);
    await page.goto(`${server.url}/#/u/${fixture.universe}/node/n_transfer_flow/`, { waitUntil: "networkidle0" });
    const text = await page.evaluate(() => document.body.innerText);
    assert.match(text, /Transfer flow/, "the node's title should be on the page");
    assert.deepEqual(seen.errors, []);
    await page.close();
  });

  /**
   * The happy path needs a real GitHub PR, so it cannot be hermetic. What IS worth
   * asserting here is that the page degrades without exploding — a stack trace in
   * the console is how a review session turns into a debugging session.
   */
  test("the PR walkthrough reports a bad PR reference instead of throwing", async () => {
    const page = await browser.newPage();
    const seen = watchErrors(page);
    await page.goto(`${server.url}/#/u/${fixture.universe}/pr/999999/`, { waitUntil: "networkidle0", timeout: 30_000 });
    const text = await page.evaluate(() => document.body.innerText);
    assert.ok(text.trim().length > 0, "the page should render something, not a blank body");
    assert.doesNotMatch(text, /undefined|\[object Object\]/, "an unhandled value leaked into the UI");
    assert.deepEqual(seen.errors, [], "a failed PR lookup must not produce console errors");
    await page.close();
  });

  test("the path form of a deep link is NOT a working link (documents the hash-router constraint)", async () => {
    const page = await browser.newPage();
    await page.goto(`${server.url}/u/${fixture.universe}/node/n_transfer_flow/`, { waitUntil: "networkidle0" });
    const text = await page.evaluate(() => document.body.innerText);
    assert.doesNotMatch(text, /Transfer flow/, "if this now works, the router left hash mode — update CLAUDE.md");
    await page.close();
  });
});

/**
 * An approval that survives because the code went BACK to a body it once covered
 * looks exactly like one earned here — unless every surface says which it is.
 * These assert the whole chain (acceptance resolution → API → each renderer),
 * because the failure mode is silent: a green tick that is quietly wrong.
 */
describe("an approval sitting on a revert", { skip: puppeteer ? false : "puppeteer not resolvable" }, () => {
  let fixture: Awaited<ReturnType<typeof makeRevertFixture>>, server: Server, browser: any;

  before(async () => {
    fixture = await makeRevertFixture();
    server = await startServer(fixture.root);
    browser = await launch(puppeteer);
  });
  after(async () => { await browser?.close(); server?.stop(); fixture?.cleanup(); });

  test("the node rollup does not present it as an ordinary sign-off", async () => {
    const page = await browser.newPage();
    const seen = watchErrors(page);
    await page.goto(`${server.url}/#/u/${fixture.universe}/node/${fixture.nodeId}/`, { waitUntil: "networkidle0", timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 800));

    const flags: string[] = await page.evaluate(() => [...document.querySelectorAll(".viaflag")].map((x) => (x as HTMLElement).innerText));
    assert.ok(flags.some((f) => /reverted/.test(f)), `expected a reverted flag on the rollup, got ${JSON.stringify(flags)}`);

    const marked = await page.evaluate(() => document.querySelectorAll("button.reverted").length);
    assert.ok(marked > 0, "the segment's own mark should render as reverted too");
    assert.deepEqual(seen.errors, []);
    await page.close();
  });

  test("the dashboard raises it, so it is findable without knowing where to look", async () => {
    const page = await browser.newPage();
    const seen = watchErrors(page);
    await page.goto(`${server.url}/#/u/${fixture.universe}/`, { waitUntil: "networkidle0", timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 800));
    const pills: string[] = await page.evaluate(() => [...document.querySelectorAll(".attn-pill")].map((x) => (x as HTMLElement).innerText));
    assert.ok(pills.some((p) => /reverted code/.test(p)), `expected an attention pill, got ${JSON.stringify(pills)}`);
    assert.deepEqual(seen.errors, []);
    await page.close();
  });
});
