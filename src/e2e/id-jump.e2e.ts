/**
 * Pasting an id navigates to the record — in a real browser, which is the only place
 * this can be checked.
 *
 * The whole feature is a claim about the browser: a resolve request, a route built from
 * the answer, a history entry that must be REPLACED rather than pushed, and a row that
 * has to exist on the page it lands on. `tsc -p web` reads every one of those templates
 * as opaque text, and the failure mode of getting it wrong is the one this project keeps
 * re-learning — a page that renders nothing and logs nothing.
 *
 * The `?f=` half is the part with a hidden trap in it, and it has its own test below: the
 * shared page defaults to the queue filter and folds settled findings away, so a link to a
 * finding that is neither lands on a page that does not contain it. That is the exact
 * failure the address was added to fix.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolvePlaywright, launchPlaywright, startServer, type Server } from "./harness.js";
import { shareFinding } from "../ops-shared.js";
import { discard } from "../test-tmp.js";

const pw = resolvePlaywright();

describe("an id is a destination", { skip: pw ? false : "playwright not resolvable (set CODEMAP_E2E_PLAYWRIGHT)" }, () => {
  let root: string, side: string, server: Server, browser: any, universe: string;
  let findingId: string, anchorId: string;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "codemap-idjump-"));
    side = mkdtempSync(join(tmpdir(), "codemap-idjump-side-"));
    const git = (...a: string[]) => spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=izzie", ...a], { cwd: root });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "izzie@x.com");
    git("config", "user.name", "izzie");
    mkdirSync(join(root, ".codemap"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "pay.ts"), "export function transfer(cents: number) { return cents; }\n");
    writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
    git("add", "-A"); git("commit", "-qm", "seed");

    const { init } = await import("../ops.js");
    await init(root);
    const { readAnchorStore } = await import("../store.js");
    anchorId = (await readAnchorStore(root)).anchors[0]!.id;

    // Deliberately a finding NOBODY has escalated and nobody has confirmed: it is
    // therefore filtered out of the default queue view, which is what makes it the
    // finding worth linking to.
    findingId = (await shareFinding(root, 264, {
      targetKind: "anchor", targetId: anchorId, severity: "low", category: "Naming",
      text: "a nit about naming", comment: "rename this local for clarity",
    }) as { id: string }).id;

    // A doc whose id is the SLUG of its title, so `transfer` is a real prefix of a real
    // node id. Without it the "an ordinary word searches" test below is vacuous: nothing
    // would match that word however the guard behaved.
    const { document: documentNode } = await import("../ops.js");
    await documentNode(root, {
      type: "concept", title: "Transfer rules",
      summary: "how a transfer reaches the ledger",
      body: "transfer() is the only entry point.",
      anchors: [anchorId],
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
    await page.goto(`${server.url}/#${path}`, { waitUntil: "networkidle" });
    return { page, errors };
  }

  test("typing a finding id in the header goes to the finding, and clears the box", async () => {
    const { page, errors } = await open(`/u/${universe}/`);
    await page.waitForSelector("header .search input");
    await page.fill("header .search input", findingId);
    await page.press("header .search input", "Enter");
    await page.waitForFunction(
      (id: string) => location.hash.includes("/shared/264/") && location.hash.includes(id),
      findingId, { timeout: 10_000 },
    );
    // Cleared, and only because it jumped: the query did its work, and text left behind
    // makes the header look like it is still showing results for it.
    assert.equal(await page.inputValue("header .search input"), "");
    assert.deepEqual(errors, []);
    await page.close();
  });

  /**
   * The half a person actually copies. The suffix of `f_00mt93q2i0-cc017f2546` looks like
   * a checksum, so the front is what gets pasted — and it used to resolve to nothing.
   */
  test("the timestamp half of an id resolves the same as the whole thing", async () => {
    const { page } = await open(`/u/${universe}/`);
    await page.waitForSelector("header .search input");
    await page.fill("header .search input", findingId.split("-")[0]!);
    await page.press("header .search input", "Enter");
    await page.waitForFunction(
      (id: string) => location.hash.includes(id), findingId, { timeout: 10_000 },
    );
    await page.close();
  });

  /**
   * The trap. This finding is unconfirmed and unescalated, so the queue filter hides it
   * and the settled fold would too — a link that lands on a page not containing the
   * record it names is worse than no link.
   */
  test("a linked finding is on the page, even though the default view hides it", async () => {
    const { page, errors } = await open(`/u/${universe}/shared/264/?f=${findingId}`);
    await page.waitForSelector(`.frow[data-f="${findingId}"]`, { timeout: 10_000 });
    // Opened and marked, because the summary line is the least of what somebody
    // following an id came for.
    assert.equal(await page.locator(`.frow[data-f="${findingId}"].ffocus`).count(), 1);
    assert.match(await page.textContent("main"), /rename this local/);
    assert.deepEqual(errors, []);
    await page.close();
  });

  /**
   * The toggle must not read as broken while a finding is focused. Focus forces the queue
   * filter off, so flipping the flag alone would change nothing on screen.
   */
  test("reaching for the queue filter lets go of the focused finding", async () => {
    const { page } = await open(`/u/${universe}/shared/264/?f=${findingId}`);
    await page.waitForSelector(`.frow[data-f="${findingId}"]`);
    await page.getByRole("button", { name: /showing: everything|showing: needs a person/ }).click();
    await page.waitForFunction(() => !location.hash.includes("?f="), null, { timeout: 10_000 });
    // The unconfirmed, unescalated finding is exactly what the queue hides.
    await page.waitForFunction(() => document.querySelectorAll(".frow").length === 0, null, { timeout: 10_000 });
    await page.close();
  });

  /**
   * A search URL carrying an id exists only to leave. Pushing that jump would put it
   * back under Back, and pressing Back would bounce forward again — a trap you escape
   * only by holding the button.
   */
  test("jumping from a search URL does not trap the back button", async () => {
    const { page } = await open(`/u/${universe}/`);
    await page.waitForSelector("header .search input");
    // Straight to the search route, the way a deep link or a restored tab arrives.
    await page.goto(`${server.url}/#/u/${universe}/search/?q=${findingId}`, { waitUntil: "networkidle" });
    await page.waitForFunction(
      (id: string) => location.hash.includes("/shared/264/") && location.hash.includes(id),
      findingId, { timeout: 10_000 },
    );
    await page.goBack();
    await page.waitForFunction(() => !location.hash.includes("/search/"), null, { timeout: 10_000 });
    assert.ok(!(await page.evaluate(() => location.hash)).includes("/search/"),
      "Back landed on the search URL, which immediately jumps forward again");
    await page.close();
  });

  /**
   * Prose must not teleport. Node ids are human-readable slugs, so an unrestricted prefix
   * resolve turns a search for a common word into a jump to a document, and the reader
   * never sees the results they asked for.
   */
  test("an ordinary word searches instead of navigating", async () => {
    const { page } = await open(`/u/${universe}/`);
    await page.waitForSelector("header .search input");
    // `transfer-rules` is a real node id here, so this word IS a live prefix match —
    // the guard is the only thing between it and a jump to that document.
    await page.fill("header .search input", "transfer");
    await page.press("header .search input", "Enter");
    await page.waitForFunction(() => location.hash.includes("/search/"), null, { timeout: 10_000 });
    assert.match(await page.evaluate(() => location.hash), /\/search\//);
    assert.ok(!(await page.evaluate(() => location.hash)).includes("/node/"),
      "a prose search resolved a node-id prefix and teleported");
    await page.close();
  });

  /**
   * The branch `looksLikeId` alone would make unreachable. A node id is a slug with no
   * kind tag, so nothing about its SHAPE says id — but a complete one is not a guess
   * about what somebody meant, and it has to go where it points.
   */
  test("a complete node id jumps even though it looks like prose", async () => {
    const { page } = await open(`/u/${universe}/`);
    await page.waitForSelector("header .search input");
    await page.fill("header .search input", "transfer-rules");
    await page.press("header .search input", "Enter");
    await page.waitForFunction(
      () => location.hash.includes("/node/transfer-rules/"), null, { timeout: 10_000 },
    );
    await page.close();
  });

  test("an anchor id pasted into the box lands on the anchor", async () => {
    const { page } = await open(`/u/${universe}/`);
    await page.waitForSelector("header .search input");
    await page.fill("header .search input", anchorId.slice(0, 14));
    await page.press("header .search input", "Enter");
    await page.waitForFunction(
      (id: string) => location.hash.includes(`/anchor/${id}/`), anchorId, { timeout: 10_000 },
    );
    await page.close();
  });

  /**
   * The copy button puts the ID on the clipboard, not a URL — the point of the whole
   * exercise. Everyone runs this UI locally, so a copied link carries a port that is only
   * true for whoever copied it.
   */
  test("the copy button copies the id, and does not toggle the row it sits in", async () => {
    const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
    const page = await ctx.newPage();
    await page.goto(`${server.url}/#/u/${universe}/shared/264/?f=${findingId}`, { waitUntil: "networkidle" });
    await page.waitForSelector(`.frow[data-f="${findingId}"]`);
    const openBefore = await page.locator(`.frow[data-f="${findingId}"].fopen`).count();
    await page.locator(`.frow[data-f="${findingId}"] .copyid`).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), findingId);
    // The button sits inside a row that owns a click; copying must not collapse it.
    assert.equal(await page.locator(`.frow[data-f="${findingId}"].fopen`).count(), openBefore,
      "copying an id also toggled the finding it belongs to");
    await ctx.close();
  });
});
