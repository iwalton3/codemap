/**
 * The topic page in a browser: a real walkthrough renders, a chapter signs and stays signed
 * across a reload (the walk's own history, not a cached click), and the snapshot picker
 * moves between walks with each keeping its own sign-off state.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolvePlaywright, launchPlaywright, startServer, type Server } from "./harness.js";
import { discard } from "../test-tmp.js";

const pw = resolvePlaywright();

describe("review topic page", { skip: pw ? false : "playwright not resolvable (set CODEMAP_E2E_PLAYWRIGHT)" }, () => {
  let root: string, side: string, server: Server, browser: any, universe: string, walk1: string, walk2: string;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "codemap-tui-"));
    side = mkdtempSync(join(tmpdir(), "codemap-tui-side-"));
    const git = (...a: string[]) => spawnSync("git", a, { cwd: root });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "izzie@x.com"); git("config", "user.name", "izzie");
    mkdirSync(join(root, ".codemap"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "fees.ts"), "export class Fees {\n  calc(c: number) {\n    return c * 2;\n  }\n}\n");
    writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
    writeFileSync(join(root, ".gitignore"), ".codemap/\n");
    git("add", "-A"); git("commit", "-qm", "seed");

    const ops = await import("../ops.js");
    await ops.init(root);
    const { readAnchorStore } = await import("../store.js");
    const fees = (await readAnchorStore(root)).anchors.find((a) => a.symbolPath.at(-1) === "Fees")!.id;
    await ops.topicDefine(root, { slug: "fees", title: "Fee rules", selector: { paths: ["src/fees.ts"] } });
    const features = [{ title: "Fees", summary: "how a fee is computed", chapters: [{ title: "the class", blocks: [
      { kind: "prose" as const, text: "Read the class; calc is the whole rule." }, { kind: "symbol" as const, anchorId: fees }] }] }];
    walk1 = ((await ops.topicWalkthroughSet(root, "fees", features)) as { walk: string }).walk;
    walk2 = ((await ops.topicWalkthroughSet(root, "fees", features, { whole: true })) as { walk: string }).walk;

    server = await startServer(root);
    browser = await launchPlaywright(pw);
    universe = (await (await fetch(`${server.url}/api/universes`)).json()).primary;
  });

  after(async () => {
    await browser?.close();
    server?.stop();
    discard(root); discard(side);
  });

  test("a chapter signed in walk 1 stays signed there across a reload, and walk 2 has its own state", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    try {
      const open = async (walk: string) => {
        await page.goto(`${server.url}/#/u/${universe}/topic/fees/?walk=${walk}`, { waitUntil: "networkidle" });
        await page.waitForFunction(() => !document.querySelector("main .loading"), null, { timeout: 15_000 });
      };
      await open(walk1);
      assert.match(await page.textContent("main"), /Fee rules/);
      assert.match(await page.textContent("main"), /calc is the whole rule/, "prose renders between symbols");
      assert.equal(await page.locator("main .dnav a").count(), 2, "the snapshot picker lists both walks");

      await page.locator("main .blrow .blhead button", { hasText: "sign" }).first().click();
      await page.waitForFunction(() => /✓ signed/.test(document.querySelector("main")?.textContent ?? ""), null, { timeout: 15_000 });

      await open(walk1);
      assert.match(await page.textContent("main"), /✓ signed/, "read back from the walk's history");
      await open(walk2);
      assert.doesNotMatch(await page.textContent("main"), /✓ signed/, "walk 2 never signed anything");
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
});
