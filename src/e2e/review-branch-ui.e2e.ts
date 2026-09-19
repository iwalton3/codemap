/**
 * The browser half of docs/plan-review-before-pr.md — every page that plan changed, against a
 * real repository with a real pull request (a bare origin carrying `refs/pull/5/head`, which is
 * how a pull request resolves without `gh`).
 *
 * `main` has `transfer` and `refund`, and a doc on `transfer`. Branch `feature` (PR 5) changes
 * `transfer`, DELETES `refund` and adds `cap`. A finding is filed against the branch.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolvePlaywright, launchPlaywright, startServer, type Server } from "./harness.js";
import { discard } from "../test-tmp.js";

const pw = resolvePlaywright();

const PAY_MAIN = "export function transfer(cents: number) {\n  return cents;\n}\n\nexport function refund(cents: number) {\n  return -cents;\n}\n";
const PAY_FEATURE = "export function transfer(cents: number) {\n  return cents * 2;\n}\n";

describe("reviewing a branch, in the browser", { skip: pw ? false : "playwright not resolvable (set CODEMAP_E2E_PLAYWRIGHT)" }, () => {
  let base: string, root: string, server: Server, browser: any, universe: string;
  let transferId: string, refundId: string, findingId: string;

  before(async () => {
    base = mkdtempSync(join(tmpdir(), "codemap-rbui-"));
    root = join(base, "repo");
    const origin = join(base, "origin.git");
    const side = join(base, "side");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".codemap"), { recursive: true });
    const git = (cwd: string, ...a: string[]) => {
      const r = spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=izzie", ...a], { cwd, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
      return r.stdout.trim();
    };
    git(base, "init", "-q", "--bare", origin);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "izzie@x.com"); git(root, "config", "user.name", "izzie");
    git(root, "remote", "add", "origin", origin);
    writeFileSync(join(root, ".gitignore"), ".codemap/\n");
    writeFileSync(join(root, "src/pay.ts"), PAY_MAIN);
    writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
    git(root, "add", "-A"); git(root, "commit", "-q", "-m", "main");
    git(root, "checkout", "-q", "-b", "feature");
    writeFileSync(join(root, "src/pay.ts"), PAY_FEATURE);
    writeFileSync(join(root, "src/cap.ts"), "export function cap(cents: number) {\n  return Math.min(cents, 100);\n}\n");
    git(root, "add", "-A"); git(root, "commit", "-q", "-m", "feature");
    git(root, "push", "-q", "origin", "main", "feature", "feature:refs/pull/5/head");
    git(root, "checkout", "-q", "main");

    const ops = await import("../ops.js");
    const { readAnchorStore } = await import("../store.js");
    await ops.init(root);
    const anchors = (await readAnchorStore(root)).anchors;
    transferId = anchors.find((a) => a.symbolPath.at(-1) === "transfer")!.id;
    refundId = anchors.find((a) => a.symbolPath.at(-1) === "refund")!.id;
    await ops.document(root, { type: "concept", title: "Pay", summary: "how money moves", body: "transfer moves it", anchors: [transferId] });
    const f = await ops.reportDefect(root, {
      context: { kind: "branch", branch: "feature" }, targetKind: "anchor", targetId: transferId,
      text: "doubling is not what the spec says", comment: "transfer doubles the amount it is given",
    }) as { id?: string; error?: string };
    assert.equal(f.error, undefined, String(f.error));
    findingId = f.id!;

    server = await startServer(root);
    browser = await launchPlaywright(pw);
    universe = (await (await fetch(`${server.url}/api/universes`)).json()).primary;
  });

  after(async () => {
    await browser?.close();
    server?.stop();
    discard(base);
  });

  async function open(path: string) {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.goto(`${server.url}/#${path}`, { waitUntil: "networkidle" });
    return { page, errors };
  }
  const encoded = encodeURIComponent("branch:feature");

  test("the anchor page labels a branch finding and links to it by its encoded key", async () => {
    const { page, errors } = await open(`/u/${universe}/anchor/${transferId}/`);
    const link = page.locator(".afind a", { hasText: "branch feature" });
    await link.waitFor();
    assert.ok((await link.getAttribute("href"))!.includes(encoded));
    await link.click();
    await page.locator(".crumbs", { hasText: "branch feature" }).waitFor();
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("a branch finding's id in the header box lands on its review, focused", async () => {
    const { page, errors } = await open(`/u/${universe}/`);
    await page.waitForSelector("header .search input");
    await page.fill("header .search input", findingId);
    await page.press("header .search input", "Enter");
    await page.waitForFunction((key: string) => location.hash.includes(`/shared/${key}/`), encoded, { timeout: 10_000 });
    await page.waitForSelector(`.frow[data-f="${findingId}"].ffocus`);
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("letting go of a focused branch finding keeps the review's encoded key", async () => {
    const { page } = await open(`/u/${universe}/shared/${encoded}/?f=${findingId}`);
    await page.waitForSelector(`.frow[data-f="${findingId}"]`);
    await page.locator("button", { hasText: /showing:/ }).click();
    await page.waitForFunction(() => !location.hash.includes("f="), null, { timeout: 10_000 });
    assert.ok((await page.evaluate(() => location.hash)).includes(`/shared/${encoded}/`));
    await page.locator(".crumbs", { hasText: "branch feature" }).waitFor();
    await page.close();
  });

  test("a search hit for a branch finding opens its review", async () => {
    const { page, errors } = await open(`/u/${universe}/search/?q=doubles`);
    const hit = page.locator(`a.sym[href*="${encoded}"]`);
    await hit.waitFor();
    await hit.click();
    await page.locator(".crumbs", { hasText: "branch feature" }).waitFor();
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("a backlogged branch finding's row names the branch and links to its review", async () => {
    const ops = await import("../ops.js");
    const r = await ops.backlogOn(root, { id: findingId, until: "2099-01-31", reason: "after the rebuild lands" }) as { error?: string };
    assert.equal(r.error, undefined, String(r.error));
    const { page, errors } = await open(`/u/${universe}/backlog/`);
    // Attached, not visible: the row sits in a collapsed section, and what this checks is
    // its label and where it links.
    const row = page.locator(".blpr", { hasText: "branch feature" });
    await row.waitFor({ state: "attached" });
    assert.ok((await row.getAttribute("href"))!.includes(encoded));
    assert.deepEqual(errors, []);
    await page.close();
    await ops.releaseBacklogOn(root, findingId, "back to the round");
  });

  test("the diff page renders against a branch nobody cached, and a sign-off reads as signed there", async () => {
    const { page, errors } = await open(`/u/${universe}/diff/?base=main&head=feature&sel=sym:${transferId}`);
    await page.waitForSelector(".dsummary");
    assert.doesNotMatch(await page.textContent("main"), /no cached snapshot/);
    // The selected symbol's own code mark: signing it on this page must read back signed
    // on this page, not as stale against whatever the working tree holds.
    const code = page.locator('button[title^="code: "]').last();
    await code.waitFor();
    assert.match((await code.getAttribute("title"))!, /code: unreviewed/);
    await code.click();
    await page.waitForFunction(() => [...document.querySelectorAll('button[title^="code: "]')]
      .some((b) => /code: reviewed/.test(b.getAttribute("title") ?? "")), null, { timeout: 10_000 });
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("signing a symbol the pull request deletes says it was not signed, and stays on it", async () => {
    const { page, errors } = await open(`/u/${universe}/pr/5/`);
    const step = page.locator(`#step-${refundId}`);
    await step.waitFor({ timeout: 20_000 });
    await step.locator('button[title^="signed:"]').first().click();
    await page.locator(".marknote", { hasText: "not signed" }).waitFor();
    assert.equal(await step.evaluate((el: Element) => el.classList.contains("done")), false);
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("a diff to the working tree shows a doc stale when an uncommitted edit moved its code", async () => {
    const file = join(root, "src/pay.ts");
    const was = readFileSync(file, "utf8");
    writeFileSync(file, was.replace("return cents;", "return cents + 1;"));
    try {
      const { page, errors } = await open(`/u/${universe}/diff/?base=main`);
      await page.locator(".dfdoc.stale", { hasText: "Pay" }).waitFor({ timeout: 10_000 });
      assert.deepEqual(errors, []);
      await page.close();
    } finally { writeFileSync(file, was); }
  });
});
