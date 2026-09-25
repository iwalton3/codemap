/**
 * Decision rounds, in a real browser — the person's own door to answering (owner, R18).
 *
 * What it asserts is what the page is FOR: an unanswered question shows as waiting on you;
 * answering it by clicking goes through the principal notice and is recorded as a ruling, not
 * a close — the finding moves to "ruled, not carried out" and stays open.
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
import { readFinding } from "../store.js";
import { discard } from "../test-tmp.js";

const pw = resolvePlaywright();

/** Run as an agent, restoring the process after — the suite shares one process. */
async function asAgent<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.CODEMAP_AGENT_MODEL;
  process.env.CODEMAP_AGENT_MODEL = "claude-opus-5";
  try { return await fn(); } finally { if (prev === undefined) delete process.env.CODEMAP_AGENT_MODEL; else process.env.CODEMAP_AGENT_MODEL = prev; }
}

describe("the decisions UI", { skip: pw ? false : "playwright not resolvable (set CODEMAP_E2E_PLAYWRIGHT)" }, () => {
  let root: string, side: string, server: Server, browser: any, universe: string, finding = "";

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "codemap-dec-ui-"));
    side = mkdtempSync(join(tmpdir(), "codemap-dec-ui-side-"));
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
    const anchor = (await ops.search(root, "transfer") as any).anchors[0].id;
    await asAgent(async () => {
      const f = await shareFinding(root, 3, { targetKind: "anchor", targetId: anchor, text: "transfer ignores the currency" }) as any;
      assert.ok(f.id, JSON.stringify(f));
      finding = f.id;
      const payload = { question: `D1: is the currency finding (${finding}) real?`, header: "Currency", options: [{ label: "Not a defect", description: "close as refuted" }, { label: "Real, fix it", description: "fix work" }] };
      const r = await ops.postRound(root, { round: { id: "R1", source: "e2e" }, decisions: [{
        id: "d1", round: "R1", ref: "D1", kind: "options", payload,
        options: [{ label: "Not a defect", effects: [{ findings: [finding], on: "settle", as: "refuted" }] }, { label: "Real, fix it", effects: [{ findings: [finding], on: "unblock" }] }],
      }, {
        id: "d2", round: "R1", ref: "D2", kind: "options",
        payload: { question: `D2: review ${finding} now, or park it?`, header: "Park", options: [{ label: "Park until 2099-01-01" }, { label: "Now" }] },
        options: [{ label: "Park until 2099-01-01", park: "2099-01-01", effects: [] }, { label: "Now", effects: [{ findings: [finding], on: "unblock" }] }],
      }] }) as any;
      assert.equal(r.ok, true, JSON.stringify(r));
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
    // HASH mode: a path-form deep link falls back to home.
    await page.goto(`${server.url}/#${path}`, { waitUntil: "networkidle" });
    return { page, errors };
  }

  test("an unanswered question waits on you; answering it is a ruling, and the finding stays open", async () => {
    const hub = await open(`/u/${universe}/decisions/`);
    await hub.page.waitForSelector("text=waiting on you (2)", { timeout: 10_000 });
    assert.deepEqual(hub.errors, []);
    await hub.page.close();

    const { page, errors } = await open(`/u/${universe}/decisions/R1/`);
    await page.waitForSelector(".op-card", { timeout: 10_000 });
    assert.match((await page.textContent("main"))!, /D1: is the currency finding \(f_[0-9a-z-]+\) real\?/);
    await page.click("button.pullbtn:has-text('Not a defect')");
    await page.waitForSelector("text=ruled, not carried out (1)", { timeout: 10_000 });
    const text = (await page.textContent("main"))!;
    assert.match(text, /waiting on you \(1\)/);
    assert.match(text, new RegExp(`${finding}: close as refuted`));
    assert.match(text, /you said: Not a defect/);
    assert.deepEqual(errors, []);
    await page.close();
    assert.notEqual((await readFinding(root, finding))?.state, "refuted", "a ruling is not a close: the verifier carries it out");
  });

  test("P4.d: a park leaves 'waiting on you' for its own view, with its date", async () => {
    const { page, errors } = await open(`/u/${universe}/decisions/R1/`);
    await page.waitForSelector("text=parked (0)", { timeout: 10_000 });
    await page.click("button.pullbtn:has-text('Park until 2099-01-01')");
    await page.waitForSelector("text=parked (1)", { timeout: 10_000 });
    const text = (await page.textContent("main"))!;
    assert.match(text, /R1 D2 — until 2099-01-01/);
    assert.match(text, /waiting on you \(0\)/);
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("C6: a held finding is marked held on the findings page — held work never looks free", async () => {
    const { page, errors } = await open(`/u/${universe}/shared/3/`);
    // It waits on nobody, so the default "needs a person" view does not list it: show everything.
    await page.click("button:has-text('showing: needs a person')");
    await page.waitForSelector(`[data-f="${finding}"]`, { timeout: 10_000 });
    const row = (await page.textContent(`[data-f="${finding}"]`))!;
    assert.match(row, /held · ruled/, row);
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("changed response shows cancellation history and disables its pending confirmation", async () => {
    const { page, errors } = await open(`/u/${universe}/decisions/R1/`);
    const question = page.locator(".op-card").filter({ hasText: "D1: is the currency finding" });
    await question.locator("input").fill("the premise is wrong");
    await question.locator("input").press("Tab");
    await question.locator("button").filter({ hasText: /^send$/ }).click();
    await page.waitForSelector("text=the premise is wrong", { timeout: 10_000 });
    const first = await ops.decisionRound(root, "R1") as any;
    const answer = first.decisions.find((d: any) => d.id === "d1").answers.find((a: any) => a.words === "the premise is wrong");
    const confirmation = await asAgent(() => ops.confirmReading(root, { answer: answer.id, maps: [{ decision: "d1", option: "Not a defect" }] })) as any;
    assert.equal(confirmation.ok, true, JSON.stringify(confirmation));
    await question.locator("input").fill("the premise is right; investigate it");
    await question.locator("input").press("Tab");
    await question.locator("button").filter({ hasText: /^send$/ }).click();
    await page.waitForSelector("text=Cancelled: response changed", { timeout: 10_000 });
    const cancelled = page.locator(".op-card").filter({ hasText: "Cancelled: response changed" });
    assert.equal(await cancelled.locator("button").count(), 0);
    assert.match((await question.textContent())!, /Previous answer:.*the premise is wrong/);
    assert.match((await cancelled.textContent())!, /no longer needed/);
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("an independent answer's comparison shows the complete question context", async () => {
    const previous = process.env.CODEMAP_PRINCIPAL;
    process.env.CODEMAP_PRINCIPAL = "bob@x.com";
    try {
      const answer = await ops.answerDirect(root, { decision: "d1", option: "Real, fix it" }) as any;
      assert.equal(answer.recorded, true, JSON.stringify(answer));
    } finally {
      if (previous === undefined) delete process.env.CODEMAP_PRINCIPAL;
      else process.env.CODEMAP_PRINCIPAL = previous;
    }
    const view = await ops.decisionRounds(root) as any;
    assert.ok(view.intentCandidates.length >= 1, JSON.stringify(view.intentCandidates));
    const { page, errors } = await open(`/u/${universe}/decisions/`);
    await page.waitForSelector(`text=human intent to check (${view.intentCandidates.length})`, { timeout: 10_000 });
    const content = (await page.textContent("main"))!;
    assert.match(content, /Question shown: D1: is the currency finding/);
    assert.match(content, /Not a defect: close as refuted/);
    assert.match(content, /Real, fix it: fix work/);
    assert.match(content, /acts on:/);
    assert.deepEqual(errors, []);
    await page.close();
  });

});
