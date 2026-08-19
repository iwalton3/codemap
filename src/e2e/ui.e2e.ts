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

  test("a finding's submitter-facing half sits UNDER it, not beside it", async () => {
    // `.prfrow` is a flex row of [location | finding], so a sibling added to it lands
    // in a third column and the editor ends up in a 2em-wide strip. The last CSS bug
    // here was exactly this shape and reasoning about the cascade did not catch it —
    // only printing the rects did. So this measures them.
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 700 });
    await page.goto(`${server.url}/#/u/${fixture.universe}/`, { waitUntil: "networkidle0" });
    const m = await page.evaluate(() => {
      const host = document.createElement("div");
      host.style.width = "800px";
      host.innerHTML = `<div class="prfindings"><div class="prfgroup"><div class="prfrow">
        <div class="prfloc"><code>pay.ts:2</code></div>
        <div class="prfbody">
          <div class="rvfind k-finding"><span class="rvftext">${"the evidence ".repeat(20)}</span></div>
          <div class="prfcmt"><span class="prfcmttext">${"the short version ".repeat(10)}</span><button>edit</button></div>
        </div>
      </div></div></div>`;
      document.body.appendChild(host);
      const find = host.querySelector(".rvfind") as HTMLElement;
      const cmt = host.querySelector(".prfcmt") as HTMLElement;
      const loc = host.querySelector(".prfloc") as HTMLElement;
      const panel = host.querySelector(".prfindings") as HTMLElement;
      const [f, c, l] = [find.getBoundingClientRect(), cmt.getBoundingClientRect(), loc.getBoundingClientRect()];
      const r = {
        commentBelow: c.top >= f.bottom - 1,
        sameLeft: Math.abs(c.left - f.left) < 1,
        besideLocation: c.left > l.right - 1,
        wideEnough: c.width > 300,
        noSideScroll: panel.scrollWidth <= panel.clientWidth + 1,
      };
      host.remove();
      return r;
    });
    assert.equal(m.commentBelow, true, "the comment stacks under the finding");
    assert.equal(m.sameLeft, true, "and lines up with it, rather than starting a new column");
    assert.equal(m.besideLocation, true, "the file:line stays in its own column to the left");
    assert.equal(m.wideEnough, true, "it gets real width, not a squeezed flex leftover");
    assert.equal(m.noSideScroll, true, "and none of it pushes the panel sideways");
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

  test("a finding with a long agent report wraps instead of running off the page", async () => {
    // `.asgndetail` claims its own line with `flex-basis: 100%`, but a flex row that
    // cannot WRAP made it an over-wide item instead: the report ran off the right
    // edge and squeezed the finding text into a tall thin column beside it.
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 700 });
    await page.goto(`${server.url}/#/u/${fixture.universe}/`, { waitUntil: "networkidle0" });
    const m = await page.evaluate(() => {
      const long = "PARTLY CONFIRMED — ".repeat(40);
      const host = document.createElement("div");
      host.style.width = "700px";
      host.innerHTML = `<div class="rvfinds"><div class="rvfind k-finding">
        <span class="rvfpin">⚑ 518</span><span class="rvfcat">TENANT SAFETY</span>
        <span class="rvftext">session.Query&lt;Aircraft&gt;().FirstOrDefaultAsync(x =&gt; x.Id == request.AircraftId.Value) ${long}</span>
        <span class="rvfacts"><span class="dim rvfauthor">agent:pr-first-pass</span>
        <span class="asgn done r-answered">answered</span>
        <button class="rvfraise on">raised</button><button class="annores">resolve</button></span>
        <div class="asgndetail">${long}</div>
      </div></div>`;
      document.body.appendChild(host);
      const row = host.querySelector(".rvfind") as HTMLElement;
      const detail = host.querySelector(".asgndetail") as HTMLElement;
      const text = host.querySelector(".rvftext") as HTMLElement;
      const r = {
        wraps: getComputedStyle(row).flexWrap === "wrap",
        detailOnOwnLine: detail.getBoundingClientRect().left <= row.getBoundingClientRect().left + 24,
        detailFits: detail.getBoundingClientRect().right <= row.getBoundingClientRect().right + 1,
        textFits: text.getBoundingClientRect().right <= row.getBoundingClientRect().right + 1,
        textWide: text.getBoundingClientRect().width > 200,
        noPageOverflow: document.documentElement.scrollWidth <= window.innerWidth,
        // The raise/resolve pair must stay together on one line: `.annores` uses
        // `margin-left: auto`, which on a wrapped row would strand it opposite the
        // raise button with a gap between them.
        controlsTogether: (() => {
          const raise = host.querySelector(".rvfraise")!.getBoundingClientRect();
          const res = host.querySelector(".annores")!.getBoundingClientRect();
          // Vertical CENTRES: a button and a span baseline-align a couple of pixels
          // apart even when they sit side by side.
          const mid = (b: DOMRect) => b.top + b.height / 2;
          return Math.abs(mid(raise) - mid(res)) < 8 && res.left - raise.right < 24;
        })(),
      };
      host.remove();
      return r;
    });
    assert.equal(m.wraps, true);
    assert.equal(m.detailOnOwnLine, true, "the agent's report belongs on its own line, not beside the finding");
    assert.equal(m.detailFits, true, "and inside the row rather than off the edge");
    assert.equal(m.textFits, true);
    assert.equal(m.textWide, true, "the finding text gets the row, not a tall thin column");
    assert.equal(m.noPageOverflow, true, "nothing pushes the page sideways");
    assert.equal(m.controlsTogether, true, "raise and resolve stay side by side, not split across the row");
    await page.close();
  });

  test("a walkthrough renders prose between the symbols, not before them", async () => {
    // The interleaving is the whole point: a paragraph followed by ten code boxes is
    // what the reviewer already has. This drives the real renderers via the page's
    // own component, so a template change that reordered blocks would fail it.
    const page = await browser.newPage();
    await page.goto(`${server.url}/#/u/${fixture.universe}/`, { waitUntil: "networkidle0" });
    const order = await page.evaluate(() => {
      const host = document.createElement("div");
      host.innerHTML = `<div class="prcbody">
        <div class="wkprose"><div class="md"><p>Read the guard first:</p></div></div>
        <div class="prstep" id="step-a1"><div class="prsthead"><code class="prsig">Apply(Created)</code></div></div>
        <div class="wkprose"><div class="md"><p>…then the fold:</p></div></div>
        <div class="prstep" id="step-a2"><div class="prsthead"><code class="prsig">Apply(Confirmed)</code></div></div>
      </div>`;
      document.body.appendChild(host);
      const kinds = [...host.querySelectorAll(".wkprose, .prstep")].map((n) => n.className.split(" ")[0]);
      const prose = host.querySelector(".wkprose") as HTMLElement;
      const cs = getComputedStyle(prose);
      const r = { kinds, readable: parseFloat(cs.maxWidth) > 0 && parseFloat(cs.maxWidth) < 900, lineHeight: cs.lineHeight };
      host.remove();
      return r;
    });
    assert.deepEqual(order.kinds, ["wkprose", "prstep", "wkprose", "prstep"],
      "prose alternates with symbols in the order the agent wrote them");
    assert.equal(order.readable, true, "prose is set to a measured line length, not the full page width");
    await page.close();
  });

  test("signing advances to the next symbol in READING order, not story order", async () => {
    // A walkthrough regroups the derived chapters into features and re-orders them.
    // Advancing along `story.chapters` therefore jumped to an unrelated section in
    // another chapter — the reviewer's next symbol has to be the next one on screen.
    const page = await browser.newPage();
    await page.goto(`${server.url}/#/u/${fixture.universe}/`, { waitUntil: "networkidle0" });
    const m = await page.evaluate(() => {
      // story order is a1,a2,a3; the walkthrough reads a3 (feature 1) then a1,a2.
      const story = {
        chapters: [
          { id: "c1", steps: [{ anchorId: "a1", reviewed: true }, { anchorId: "a2", reviewed: false }] },
          { id: "c2", steps: [{ anchorId: "a3", reviewed: false }, { anchorId: "a4", reviewed: false }] },
        ],
        walkthrough: {
          features: [
            { id: "f1", chapters: [{ id: "w1", blocks: [{ kind: "prose" }, { kind: "symbol", anchorId: "a3" }] }] },
            { id: "f2", chapters: [{ id: "w2", blocks: [{ kind: "symbol", anchorId: "a1" }, { kind: "symbol", anchorId: "a2" }] }] },
          ],
          coverage: { uncovered: ["a4", "a_gone"] },
        },
      };
      const steps = new Map();
      for (const c of story.chapters) for (const s of c.steps) steps.set(s.anchorId, s);
      const walk = (window as any).__readingOrder(story, steps) as { chapter: { id: string }; step: { anchorId: string; reviewed: boolean } }[];
      const plain = (window as any).__readingOrder({ chapters: story.chapters }, steps) as typeof walk;
      const after = (id: string) => {
        const i = walk.findIndex((x) => x.step.anchorId === id);
        return walk.slice(i + 1).find((x) => !x.step.reviewed) || null;
      };
      return {
        exposed: typeof (window as any).__readingOrder === "function",
        order: walk.map((x) => x.step.anchorId),
        chapters: walk.map((x) => x.chapter.id),
        plain: plain.map((x) => x.step.anchorId),
        afterA3: after("a3")?.step.anchorId ?? null,
        afterA2: after("a2")?.step.anchorId ?? null,
      };
    });
    assert.equal(m.exposed, true, "app.js must expose __readingOrder for this");
    assert.deepEqual(m.order, ["a3", "a1", "a2", "a4"], "reading order is the walkthrough's, and a symbol it never cites comes last");
    assert.deepEqual(m.chapters, ["w1", "w2", "w2", "__uncovered"], "each symbol carries the chapter it is rendered under, so the right one gets opened");
    assert.deepEqual(m.plain, ["a1", "a2", "a3", "a4"], "with no walkthrough, the derived chapters are the reading order");
    assert.equal(m.afterA3, "a2", "signing the first symbol of a feature moves to the next one on screen");
    assert.equal(m.afterA2, "a4", "and at the end of a chapter, on to what nothing explained — not back up the story");
    await page.close();
  });

  test("signing moves the walkthrough by the least it can", async () => {
    // Advancing is a courtesy, not a jump: the reviewer's eye is already on the page.
    // Geometry against a real viewport is the only place this is observable, so the
    // page exposes the rule itself and the scroll is intercepted rather than watched.
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    await page.goto(`${server.url}/#/u/${fixture.universe}/`, { waitUntil: "networkidle0" });
    const m = await page.evaluate(() => {
      const host = document.createElement("div");
      host.innerHTML = `<div class="prcbody">
        <div id="spacer"></div>
        <div class="wkprose" id="prose"></div>
        <div class="prstep" id="step-x"></div>
        <div id="tail" style="height:4000px"></div>
      </div>`;
      document.body.appendChild(host);
      const el = (id: string) => document.getElementById(id) as HTMLElement;

      /** Set the layout, park the scroll, and report where revealStep wants to go. */
      const ask = (spacer: number, prose: number, step: number, scroll: number) => {
        el("spacer").style.height = `${spacer}px`;
        el("prose").style.height = `${prose}px`;
        el("step-x").style.height = `${step}px`;
        window.scrollTo(0, scroll);
        const real = window.scrollTo;
        let target: number | null = null;
        (window as any).scrollTo = (o: any) => { target = o && typeof o === "object" ? o.top : null; };
        (window as any).__revealStep("x");
        window.scrollTo = real;
        const s = el("step-x").getBoundingClientRect(), p = el("prose").getBoundingClientRect();
        return { target, scrollY: window.scrollY, top: s.top, bottom: s.bottom, proseTop: p.top };
      };

      const hdr = (document.querySelector("header") as HTMLElement).getBoundingClientRect().height;
      const viewH = window.innerHeight - hdr;
      const r = {
        hdr, innerHeight: window.innerHeight, exposed: typeof (window as any).__revealStep === "function",
        // whole thing already on screen · hanging off the bottom · taller than the
        // viewport with a short intro · taller, with an intro too long to keep
        fits: ask(hdr + 40, 0, 200, 0),
        hangs: ask(600, 0, 300, 0),
        tallShortProse: ask(400, 80, viewH + 400, 0),
        tallLongProse: ask(400, viewH - 60, viewH + 400, 0),
      };
      host.remove();
      window.scrollTo(0, 0);
      return r;
    });
    assert.equal(m.exposed, true, "app.js must expose __revealStep for this");
    assert.equal(m.fits.target, null, "a symbol already fully on screen must not be scrolled at all");

    const moved = (c: { target: number | null; scrollY: number }, y: number) => y - ((c.target as number) - c.scrollY);
    assert.notEqual(m.hangs.target, null, "a symbol hanging off the bottom has to move");
    assert.ok(moved(m.hangs, m.hangs.bottom) <= m.innerHeight, "…far enough that its end is on screen");
    assert.ok(moved(m.hangs, m.hangs.top) >= m.hdr, "…but not so far that its head hides under the page header");

    assert.ok(Math.abs(moved(m.tallShortProse, m.tallShortProse.proseTop) - m.hdr) < 20,
      "a symbol too tall to frame aligns the prose that introduces it, not itself");
    assert.ok(Math.abs(moved(m.tallLongProse, m.tallLongProse.top) - m.hdr) < 20,
      "unless the prose is long enough to push the symbol off screen — then the symbol wins");
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
