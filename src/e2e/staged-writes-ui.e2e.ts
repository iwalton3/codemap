/**
 * A tab's staged writes over a real server and a real remote (plan 4.2): a write refused
 * because a teammate got there first opens the modal naming it, and a tab closed with a write
 * still queued has it attempted by the server — landed, or kept as a conflict shown on the
 * next open.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { team, settle, type Member } from "../oracle.js";
import { conflicts } from "../sync-queue.js";
import { shareFinding, requestOnFinding, closeFinding, sharedFindings, attemptGoneSessions } from "../ops-shared.js";
import { resolvePlaywright, launchPlaywright, startServer, type Server } from "./harness.js";
/** Run `fn` with these environment variables, restoring them after. */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const pw = resolvePlaywright();
const skip = pw ? false : "playwright not resolvable (set CODEMAP_E2E_PLAYWRIGHT)";

/** A finding an agent has asked a person to resolve, so the page offers the act. */
async function askedFinding(ana: Member, text = "transfer skips the tenant check"): Promise<string> {
  const f = await withEnv({ CODEMAP_AGENT_MODEL: "claude-test" }, () => shareFinding(ana.repo, 264, {
    targetKind: "anchor", targetId: "a_1", text, comment: text,
  })) as { id: string };
  await withEnv({ CODEMAP_AGENT_MODEL: "claude-test" }, () => requestOnFinding(ana.repo, 264, f.id, "resolve", "the guard landed in abc123"));
  return f.id;
}

/** Hold the page's background syncs until released: the window in which a teammate acts. */
async function holdSyncs(page: any): Promise<() => void> {
  const held: any[] = [];
  let open = false;
  await page.route("**/api/shared/sync*", (route: any) => (open ? route.continue() : held.push(route)));
  return () => { open = true; for (const r of held.splice(0)) void r.continue(); };
}

test("a write a teammate beat to it opens the modal, naming what was refused", { skip }, async () => {
  const t = await team(["ana@acme.test", "ben@acme.test"]);
  let server: Server | undefined, browser: any;
  try {
    const [ana, ben] = t.all as [Member, Member];
    const id = await askedFinding(ana);
    await settle(t);
    server = await startServer(ana.repo);
    browser = await launchPlaywright(pw);
    const page = await browser.newPage();
    const release = await holdSyncs(page);
    await page.goto(`${server.url}/#/u/acme-api/shared/264/`, { waitUntil: "networkidle" });
    await page.waitForSelector(".frow");
    await page.locator(".frow .fmeta").first().click();
    await page.getByRole("button", { name: /agree — resolve/ }).click();
    await page.waitForFunction(() => !document.querySelector(".askbox"), null, { timeout: 10_000 });
    // Ben closes it first, inline, while ana's close waits in her tab.
    const theirs = await closeFinding(ben.repo, 264, id, "invalid", "not a defect") as { state?: string };
    assert.equal(theirs.state, "invalid", JSON.stringify(theirs));
    release();
    await page.waitForSelector("#conflicts", { timeout: 20_000 });
    assert.match(await page.textContent("#conflicts"), /may not become resolved/);
    await page.getByRole("button", { name: "Drop everything unsaved" }).click();
    await page.waitForFunction(() => !document.getElementById("conflicts"));
    await settle(t);
    for (const m of [ana, ben]) {
      const f = ((await sharedFindings(m.repo, 264)) as any).findings.find((x: any) => x.id === id);
      assert.equal(f.state, "invalid", `${m.actor.principal}: ben's close stands; ana's never landed`);
    }
    await page.close();
  } finally { await browser?.close(); server?.stop(); t.dispose(); }
});

test("a tab closed with a write queued: the server lands it — or keeps the conflict for the next open", { skip }, async () => {
  const t = await team(["ana@acme.test", "ben@acme.test"]);
  let server: Server | undefined, browser: any;
  try {
    const [ana, ben] = t.all as [Member, Member];
    const landed = await askedFinding(ana, "the first finding, closed and left");
    const refused = await askedFinding(ana, "the second finding, beaten to it");
    await settle(t);
    server = await startServer(ana.repo);
    browser = await launchPlaywright(pw);
    const shared = `${server.url}/#/u/acme-api/shared/264/`;
    // Each tab closes with its write still queued (its page's sync is never let through; a
    // closing page's beacon may still deliver it — either way the write must land or be kept).
    const closeTab = async (text: string, before?: () => Promise<unknown>) => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await holdSyncs(page);
      await page.goto(shared, { waitUntil: "networkidle" });
      await page.locator(".frow", { hasText: text }).locator(".fmeta").click();
      await before?.();
      await page.getByRole("button", { name: /agree — resolve/ }).click();
      await page.waitForFunction(() => !document.querySelector(".askbox"), null, { timeout: 10_000 });
      await ctx.close();   // not `page.close()`, which would let the write settle first
    };
    await closeTab("the first finding, closed and left");
    // Ben closes the second while its tab is open and before its click: every route that write
    // can take — the beacon, the server's attempt — replays it after ben's and refuses it.
    await closeTab("the second finding, beaten to it", () => closeFinding(ben.repo, 264, refused, "invalid", "not a defect"));
    const out = await withEnv({ CODEMAP_TAB_GONE_MS: "1" }, () => attemptGoneSessions([ana.repo]));
    // Whichever route refused it — the beacon, or this attempt — leaves a local conflict.
    // Read without adopting: the test process is not the next session the conflict is for.
    const kept = conflicts(ana.sidecar);
    assert.ok(kept.some((op) => op.event.subject === refused), JSON.stringify({ out, kept }));
    // The next page open on this machine shows the conflict, and resolving it there is what
    // lets this machine push again (review C10: the next session resolves before it pushes).
    const page = await browser.newPage();
    await page.goto(shared, { waitUntil: "networkidle" });
    await page.waitForSelector("#conflicts", { timeout: 20_000 });
    assert.match(await page.textContent("#conflicts"), /may not become resolved/);
    await page.getByRole("button", { name: "Drop the refused and send the rest" }).click();
    await page.waitForFunction(() => !document.getElementById("conflicts"));
    await page.close();
    await settle(t);
    const state = async (id: string) => ((await sharedFindings(ben.repo, 264)) as any).findings.find((x: any) => x.id === id).state;
    assert.equal(await state(landed), "resolved", "the closed tab's write landed");
    assert.equal(await state(refused), "invalid", "and the refused one did not");
  } finally { await browser?.close(); server?.stop(); t.dispose(); }
});

test("round 4, I2: a refused background pull says why, not 'remote unreachable'", { skip }, async () => {
  const t = await team(["ana@acme.test"]);
  let server: Server | undefined, browser: any;
  try {
    const [ana] = t.all as [Member];
    server = await startServer(ana.repo);
    browser = await launchPlaywright(pw);
    const page = await browser.newPage();
    const error = "joining a team: run sync first — `codemap sync` brings along the writes this clone made on its own";
    await page.route("**/api/shared/staged*", (route: any) => route.fulfill({ contentType: "application/json",
      body: JSON.stringify({ staged: [], conflicts: [], lastPull: { at: new Date().toISOString(), ok: false, error } }) }));
    await page.goto(`${server.url}/#/u/acme-api/shared/264/`, { waitUntil: "networkidle" });
    await page.waitForSelector("#sync-status");
    const text = await page.textContent("#sync-status span");
    assert.match(text, /pull failed \d+s ago: joining a team: run sync first/);
    assert.doesNotMatch(text, /unreachable/);
    assert.equal(await page.getAttribute("#sync-status span", "title"), error, "the whole refusal on hover");
  } finally { await browser?.close(); server?.stop(); t.dispose(); }
});
