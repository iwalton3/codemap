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

  test("a long line scrolls the diff block, not each line on its own", async () => {
    // `.prdiff .fltext` carried `overflow-x: auto`, so EVERY long line got its own
    // scrollbar and reading across one left the rest of the hunk behind. The rule
    // under test is CSS, so this exercises the real stylesheet in a real browser
    // against the markup `diffReviewLines` emits.
    const page = await browser.newPage();
    await page.goto(`${server.url}/#/u/${fixture.universe}/`, { waitUntil: "networkidle0" });
    const m = await page.evaluate(() => {
      const wide = "x".repeat(4000);
      const host = document.createElement("div");
      host.style.width = "600px";
      host.innerHTML = `<div class="rvpre hljs prdiff"><div class="flrow">
        <div class="dline add"><span class="dsign">+</span><span class="flno">1</span
        ><span class="fltext">${wide}</span><button class="flcomment">c</button></div>
      </div></div>`;
      document.body.appendChild(host);
      const block = host.querySelector(".prdiff") as HTMLElement;
      const text = host.querySelector(".fltext") as HTMLElement;
      const line = host.querySelector(".dline") as HTMLElement;
      const r = {
        blockScrolls: block.scrollWidth > block.clientWidth,
        textScrolls: text.scrollWidth > text.clientWidth,
        lineReachesText: line.scrollWidth >= text.scrollWidth,
      };
      host.remove();
      return r;
    });
    assert.equal(m.textScrolls, false, "a single line must NOT be its own scroll container");
    assert.equal(m.blockScrolls, true, "the block is what scrolls sideways");
    assert.equal(m.lineReachesText, true, "the row widens to the line, so its add/del tint covers it");
    await page.close();
  });

  test("a symbol's sign-off row stays on screen while its body scrolls", async () => {
    // On a long symbol the row scrolled out of reach, so marking something signed
    // meant scrolling back up to find it. Sticky is a CSS claim, so this measures it
    // in a real browser against the real stylesheet.
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 400 });
    await page.goto(`${server.url}/#/u/${fixture.universe}/`, { waitUntil: "networkidle0" });
    const m = await page.evaluate(() => {
      const host = document.createElement("div");
      host.innerHTML = `<div class="prstep" id="step-x">
        <div class="prsthead"><code class="prsig">transfer(...)</code></div>
        <div class="prsbody"><div class="rvpre">${"<div class='fline'>line</div>".repeat(200)}</div></div>
      </div>`;
      document.body.appendChild(host);
      const head = host.querySelector(".prsthead") as HTMLElement;
      const cs = getComputedStyle(head);
      const r = {
        sticky: cs.position === "sticky",
        offset: cs.top,
        opaque: cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent",
        scrollMargin: getComputedStyle(host.querySelector(".prstep")!).scrollMarginTop,
      };
      host.remove();
      return r;
    });
    assert.equal(m.sticky, true, "the sign-off row must stay put while the body scrolls");
    assert.notEqual(m.offset, "auto", "and stick below the page header, not under it");
    assert.equal(m.opaque, true, "a transparent sticky row would have code showing through it");
    assert.notEqual(m.scrollMargin, "0px", "scrollIntoView must clear the sticky header");
    await page.close();
  });

  test("a diff highlights with multi-line context, not line by line", async () => {
    // Lexing each line on its own loses the context a block comment, an XML doc
    // comment or a verbatim string needs, so those re-lexed as code — an apostrophe
    // inside a comment opened a phantom string and swallowed the rest of the line.
    const page = await browser.newPage();
    await page.goto(`${server.url}/#/u/${fixture.universe}/`, { waitUntil: "networkidle0" });
    const m = await page.evaluate(() => {
      const lines = [
        { tag: " ", text: "/* it's a block comment" },
        { tag: " ", text: "   still the comment */" },
        { tag: "+", text: "const x = 1;" },
      ];
      // @ts-expect-error — the page exposes this for exactly this test
      const rows = window.__diffCodeRows(lines, "typescript");
      return rows.map((r: { html: string }) => r.html);
    });
    assert.ok(Array.isArray(m) && m.length === 3, "app.js must expose __diffCodeRows for this");
    assert.match(m[0]!, /hljs-comment/, "the comment opens");
    assert.match(m[1]!, /hljs-comment/, "and the continuation line is still inside it");
    assert.equal(/hljs-string/.test(m[1]!), false, "the apostrophe must not open a phantom string");
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
