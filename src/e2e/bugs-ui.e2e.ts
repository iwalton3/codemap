/**
 * The bugs page, in a real browser.
 *
 * A bug stopped being a local record with a status dropdown and became a team object:
 * it travels, people comment on it, and it can point at a ticket. Every one of those is
 * a new write path from the browser, and the ways they break — a helper that was never
 * exported, a `.map()` where vdx demands `each()`, a POST route that does not exist —
 * all render as a blank page and a console error that no unit test can see.
 *
 * What this asserts beyond "it renders" is the two things the page is FOR: that a
 * refusal reaches the person who caused it, and that the drift verdict on screen is
 * about the code in front of them.
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
import { discard } from "../test-tmp.js";

const pw = resolvePlaywright();

describe("bugs UI", { skip: pw ? false : "playwright not resolvable (set CODEMAP_E2E_PLAYWRIGHT)" }, () => {
  let root: string, side: string, server: Server, browser: any, universe: string;
  let filed = "", accepted = "";

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "codemap-bui-"));
    side = mkdtempSync(join(tmpdir(), "codemap-bui-side-"));
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

    filed = ((await ops.reportBug(root, {
      title: "transfer accepts a negative amount",
      description: "No guard on `cents`, so a negative moves money the wrong way.",
      anchors: ["src/pay.ts#transfer"], severity: "high", category: "Validation",
    })) as any).id;

    // A second bug, from a pull-request finding — so the page has one of each kind and
    // the "accepted from" line has something to render.
    const f = await shareFinding(root, 264, {
      targetKind: "anchor", targetId: "src/pay.ts#transfer",
      text: "the retry is not idempotent", comment: "make it idempotent", severity: "medium",
    }) as any;
    accepted = ((await ops.acceptFinding(root, 264, f.id)) as any).id;

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

  test("the list renders both bugs with no console errors", async () => {
    const { page, errors } = await open(`/u/${universe}/bugs/`);
    await page.waitForSelector(".brow", { timeout: 10_000 });
    assert.equal(await page.locator(".brow").count(), 2);
    const text = await page.textContent("main");
    assert.match(text, /transfer accepts a negative amount/);
    assert.match(text, /retry is not idempotent/);
    assert.deepEqual(errors, [], "a console error here means the page is wired wrong");
    await page.close();
  });

  test("a bug accepted from a finding says where it came from", async () => {
    const { page, errors } = await open(`/u/${universe}/bugs/?bug=${accepted}`);
    await page.waitForSelector(".ddetail");
    const detail = await page.textContent(".ddetail");
    assert.match(detail, /accepted from finding/, "the cross-link is what makes it traceable back to the PR");
    assert.match(detail, /make it idempotent/, "and the submitter-facing half came with it");
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("a person comments from the browser, and it is there on reload", async () => {
    // The other half of the loop. Agents write through MCP; if the only way to answer
    // one is another agent, the human is not in the conversation.
    const { page, errors } = await open(`/u/${universe}/bugs/?bug=${filed}`);
    await page.waitForSelector(".bdraft");
    await page.locator(".bdraft").fill("checked staging — reproduces with -100");
    await page.getByRole("button", { name: "comment", exact: true }).click();
    await page.waitForFunction(
      () => !!document.querySelector(".bcomment"), null, { timeout: 10_000 },
    );
    assert.match(await page.textContent(".ddetail"), /reproduces with -100/);
    assert.deepEqual(errors, []);
    await page.close();

    const again = await open(`/u/${universe}/bugs/?bug=${filed}`);
    await again.page.waitForSelector(".bcomment");
    assert.match(await again.page.textContent(".ddetail"), /reproduces with -100/, "it is durable, not optimistic");
    await again.page.close();
  });

  test("linking a ticket puts a clickable reference on the bug, and does not close it", async () => {
    const { page, errors } = await open(`/u/${universe}/bugs/?bug=${filed}`);
    await page.waitForSelector(".ddetail");
    await page.getByRole("button", { name: "link a ticket" }).click();
    await page.locator('input[name="key"]').fill("ACME-31");
    await page.locator('input[name="url"]').fill("https://jira.acme.test/ACME-31");
    await page.getByRole("button", { name: "link", exact: true }).click();
    await page.waitForSelector(".btrack a", { timeout: 10_000 });

    assert.equal(await page.locator(".btrack a").getAttribute("href"), "https://jira.acme.test/ACME-31");
    // Being in a tracker is not being fixed — the witness is still what decides that.
    assert.match(await page.textContent(".dsymhead"), /created/);
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("a refusal reaches the person who caused it, instead of a silent reload", async () => {
    const { page } = await open(`/u/${universe}/bugs/?bug=${filed}`);
    await page.waitForSelector(".ddetail");
    // A tracking reference with neither key nor URL is refused by ops. The page must
    // SHOW that: a reload that quietly changed nothing reads as "it worked".
    await page.getByRole("button", { name: "link a ticket" }).click();
    await page.getByRole("button", { name: "link", exact: true }).click();
    await page.waitForSelector(".note", { timeout: 10_000 });
    assert.match(await page.textContent(".note"), /needs a key or a URL/);
    await page.close();
  });

  test("code moving under a bug shows as possibly fixed, and the queue holds it", async () => {
    writeFileSync(join(root, "src", "pay.ts"),
      "export function transfer(cents: number) {\n  if (cents <= 0) throw new Error('no');\n  return cents;\n}\n");
    const { page, errors } = await open(`/u/${universe}/bugs/?queue=1`);
    await page.waitForSelector(".brow", { timeout: 10_000 });
    const text = await page.textContent("main");
    assert.match(text, /possibly fixed/, "the verdict is computed against the code in front of the reader");
    // Not closed, ever: a symbol that vanished may have been renamed, or deleted
    // without the defect being addressed. Only a person can tell those apart.
    assert.match(text, /created/);
    assert.deepEqual(errors, []);
    await page.close();
  });
});
