/**
 * The shared-review page, in a real browser.
 *
 * Driven by playwright rather than the puppeteer the older UI suite uses — both
 * are resolved from wherever the machine happens to have them and both SKIP when
 * absent, because the golden rule applies to the test tree: a browser driver is
 * something the machine may have, never something this repo pulls in.
 *
 * What it is really guarding is the wiring. `web/shared.js` is a new module that
 * app.js imports for its side effects, and the ways that goes wrong — a helper
 * that was never exported, a route naming a component defined after routing was
 * enabled, a `.map()` where vdx demands `each()` — all render as a blank page and
 * a console error, and no unit test can see any of them.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolvePlaywright, launchPlaywright, startServer, type Server } from "./harness.js";
import { shareFinding, promoteFinding, corroborateFinding } from "../ops-shared.js";

const pw = resolvePlaywright();

describe("shared review UI", { skip: pw ? false : "playwright not resolvable (set CODEMAP_E2E_PLAYWRIGHT)" }, () => {
  let root: string, side: string, server: Server, browser: any, universe: string;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "codemap-sui-"));
    side = mkdtempSync(join(tmpdir(), "codemap-sui-side-"));
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

    // One finding that needs a person, and one that does not — so the queue filter
    // has something to actually filter.
    const a = await shareFinding(root, 264, {
      targetKind: "anchor", targetId: "a_1", severity: "high", category: "Authorization",
      text: "the by-id branch has no tenant predicate",
      comment: "CreateTicket.cs:1006 queries Aircraft on x.Id without a tenant scope.",
    }) as { id: string };
    await promoteFinding(root, 264, a.id);
    await corroborateFinding(root, 264, a.id, "confirm", "reproduced on staging");
    await shareFinding(root, 264, {
      targetKind: "anchor", targetId: "a_2", severity: "low",
      text: "a nit about naming", comment: "rename this local for clarity",
    });

    server = await startServer(root);
    browser = await launchPlaywright(pw);
    // Asked for, never assumed: a single-repo universe is keyed by its directory
    // basename, which is a fresh mkdtemp name here.
    universe = (await (await fetch(`${server.url}/api/universes`)).json()).primary;
  });

  after(async () => {
    await browser?.close();
    server?.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(side, { recursive: true, force: true });
  });

  /** A page plus every console error it produced — a blank render is the failure. */
  async function open(path: string) {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e: Error) => errors.push(e.message));
    // The vdx router is HASH mode: a path-form deep link silently falls back to home.
    await page.goto(`${server.url}/#${path}`, { waitUntil: "networkidle" });
    return { page, errors };
  }

  test("the shared page renders a team's findings, with no console errors", async () => {
    const { page, errors } = await open(`/u/${universe}/shared/264/`);
    await page.waitForSelector(".frow", { timeout: 10_000 });
    const text = await page.textContent("main");
    assert.match(text, /tenant scope/, "the finding's submitter-facing comment is what leads");
    assert.deepEqual(errors, [], "a console error here means the module wiring is broken");
    await page.close();
  });

  test("the queue is the default view, and the toggle widens it", async () => {
    // The page exists to answer "what needs me"; showing everything first buries it.
    const { page } = await open(`/u/${universe}/shared/264/`);
    await page.waitForSelector(".frow");
    assert.equal(await page.locator(".frow").count(), 1, "only the promoted+confirmed one");

    await page.getByRole("button", { name: /showing: needs a person/ }).click();
    await page.waitForFunction(() => document.querySelectorAll(".frow").length === 2, null, { timeout: 10_000 });
    assert.equal(await page.locator(".frow").count(), 2, "the nit appears once everything is shown");
    await page.close();
  });

  test("a finding that needs a person says so, and names its independent support", async () => {
    const { page } = await open(`/u/${universe}/shared/264/`);
    await page.waitForSelector(".prbadge.needsack");
    const badges = await page.locator(".frow").first().textContent();
    assert.match(badges, /needs ack/);
    assert.match(badges, /promoted/);
    // izzie confirming izzie's own finding is NOT independent, and the page must
    // not claim otherwise — that number is what the queue would be ranked by.
    assert.doesNotMatch(badges, /\d+ independent/, "same principal is not a second opinion");
    await page.close();
  });

  test("expanding a finding shows the evidence and who said what", async () => {
    const { page, errors } = await open(`/u/${universe}/shared/264/`);
    await page.waitForSelector(".frow");
    await page.locator(".frow .row").first().click();
    await page.waitForSelector(".fdetail");
    const detail = await page.textContent(".fdetail");
    assert.match(detail, /tenant predicate/, "the evidence, which is never published");
    assert.match(detail, /reproduced on staging/, "and the rationale behind the verdict");
    assert.match(detail, /not independent/, "labelled honestly");
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("the peers page names who writes here and what they write under", async () => {
    const { page, errors } = await open(`/u/${universe}/shared/264/peers/`);
    await page.waitForSelector("main");
    const text = await page.textContent("main");
    assert.match(text, /izzie@x\.com/);
    assert.match(text, /anchor scheme \d+/);
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("a pull request with nothing shared says so rather than rendering blank", async () => {
    const { page, errors } = await open(`/u/${universe}/shared/999/`);
    await page.waitForSelector("main");
    const text = await page.textContent("main");
    assert.match(text, /nothing is waiting on a person|no shared findings/);
    assert.deepEqual(errors, []);
    await page.close();
  });
});
