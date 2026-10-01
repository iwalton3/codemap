/**
 * Review C14: a tab in a workspace whose universes have their own sidecars tracks every universe
 * it wrote to. The unsaved count covers both, and the background sync lands both — tracking only
 * the last one left the first write unsynced and uncounted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { team, settle, type Member, type Team } from "../oracle.js";
import { shareFinding, sharedFindings } from "../ops-shared.js";
import { discard } from "../test-tmp.js";
import { resolvePlaywright, launchPlaywright, startServer, type Server } from "./harness.js";

const pw = resolvePlaywright();
const skip = pw ? false : "playwright not resolvable (set CODEMAP_E2E_PLAYWRIGHT)";

test("a tab that writes to two universes counts and syncs both", { skip }, async () => {
  const teams: Team[] = [await team(["ana@acme.test"]), await team(["ana@acme.test"])];
  const dir = mkdtempSync(join(tmpdir(), "codemap-ws-"));
  let server: Server | undefined, browser: any;
  try {
    const [a, b] = teams.map((t) => t.all[0] as Member) as [Member, Member];
    const ids: string[] = [];
    for (const [m, t] of [[a, teams[0]!], [b, teams[1]!]] as const) {
      const f = await shareFinding(m.repo, 264, { targetKind: "anchor", targetId: "a_1", text: "a finding to comment on" }) as { id: string };
      ids.push(f.id);
      await settle(t);
    }
    const manifest = join(dir, "codemap.workspace.json");
    writeFileSync(manifest, JSON.stringify({ universes: [{ id: "ua", path: a.repo, primary: true }, { id: "ub", path: b.repo }] }));
    server = await startServer(manifest);
    browser = await launchPlaywright(pw);
    const page = await browser.newPage();
    // Hold the background syncs, so both writes are staged at once.
    const held: any[] = [];
    let open = false;
    await page.route("**/api/shared/sync*", (route: any) => (open ? route.continue() : held.push(route)));
    await page.goto(`${server.url}/`, { waitUntil: "networkidle" });
    await page.evaluate(async ([fa, fb]: string[]) => {
      for (const [u, id] of [["ua", fa], ["ub", fb]]) {
        const r = await fetch("/api/shared/comment", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ u, id, body: `from the tab, in ${u}` }) });
        if (!r.ok) throw new Error(await r.text());
      }
    }, ids);
    await page.waitForFunction(() => /2 unsaved/.test(document.getElementById("sync-status")?.textContent ?? ""), null, { timeout: 25_000 });
    open = true;
    for (const r of held.splice(0)) void r.continue();
    await page.evaluate(() => (window as any).__codemapSettle());
    for (const [m, t, id] of [[a, teams[0]!, ids[0]!], [b, teams[1]!, ids[1]!]] as const) {
      await settle(t);
      const f = ((await sharedFindings(m.repo, 264)) as any).findings.find((x: any) => x.id === id);
      assert.ok(f.thread.some((c: any) => /from the tab/.test(c.body)), `${m.repo}: the tab's comment landed`);
    }
    await page.close();
  } finally { await browser?.close(); server?.stop(); teams.forEach((t) => t.dispose()); discard(dir); }
});
