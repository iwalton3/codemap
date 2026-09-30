/**
 * The lockout over a real server (plan 1.2): once the shared log is found damaged, every API
 * route answers 423 with the one diagnostic, sync and pull still run (they are how a lock
 * clears), and a page shows the lockout in place of itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { team } from "../oracle.js";
import { decisionScope } from "../shared-decisions.js";
import { universeKey } from "../sidecar-config.js";
import { appendUnfolded } from "../test-door.js";
import { launchPlaywright, resolvePlaywright, startServer, type Server } from "./harness.js";

test("a damaged log locks every API route with 423, leaves sync reachable, and covers the page", async () => {
  const t = await team(["ana@acme.test"]);
  let server: Server | undefined;
  try {
    const ana = t.all[0]!;
    server = await startServer(ana.repo);
    const u = universeKey(ana.repo);
    // An answer to a decision nobody posted: a linear event its fold refuses on a reference —
    // damage. (A wrong shape would be newer, which blocks pushes and does not lock.)
    const bad = await appendUnfolded(ana.sidecar, decisionScope(u), ana.actor, "decision.answer.recorded", "d_nobody_posted",
      { decision: "d_nobody_posted", hash: "h", via: { kind: "direct", option: "x" } });

    const first = await fetch(`${server.url}/api/decisions?u=${encodeURIComponent(u)}`);
    assert.equal(first.status, 423, "the read that folds the damage answers the lockout");
    const body = await first.json() as { error: string; lockout: { entry: { id: string } } };
    assert.equal(body.lockout.entry.id, bad.id);
    assert.match(body.error, /docs\/log-repair\.md/);

    const other = await fetch(`${server.url}/api/universes`);
    assert.equal(other.status, 423, "and then every route does, however unrelated");

    const sync = await fetch(`${server.url}/api/shared/sync`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ u }) });
    assert.equal(sync.status, 200, "sync still runs: a locked clone fetches and re-checks");
    assert.match(((await sync.json()) as { error?: string }).error ?? "", /locked|refusing/);

    const pw = resolvePlaywright();
    if (!pw) return;
    const browser = await launchPlaywright(pw);
    try {
      const page = await browser.newPage();
      await page.goto(`${server.url}/#/u/${encodeURIComponent(u)}/`);
      await page.waitForSelector("#lockout", { timeout: 10_000 });
      assert.match((await page.textContent("#lockout"))!, /codemap is locked/);
    } finally { await browser.close(); }
  } finally { server?.stop(); t.dispose(); }
});
