/**
 * The topic page and the PR page read the same way (review round 2026-10-05, R5b — the owner's
 * "screenshot testing … and a feature parity check"). One change, two reviews of it: pull request
 * 5 (a bare origin carrying `refs/pull/5/head`) and a range topic over the same commits, each
 * walked with the same features. Every feature below is exercised on BOTH pages, and each page
 * is screenshotted at the end (CODEMAP_E2E_SHOTS names the directory; a temp one otherwise).
 *
 * `main` has `post`. The branch changes `post`, and adds class `Fees` (`calc`, `round`) and
 * `audit`. The walkthrough cites `Fees`, `post` and `round` — `audit` is left unaccounted for.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolvePlaywright, launchPlaywright, startServer, watchErrors, type Server } from "./harness.js";
import { discard } from "../test-tmp.js";

const pw = resolvePlaywright();

const LEDGER_MAIN = "export function post(c: number) {\n  return c;\n}\n";
const LEDGER_FEATURE = "export function post(c: number) {\n  const fee = 1;\n  return c + fee;\n}\n";
const FEES = "export class Fees {\n  calc(c: number) {\n    return c * 2;\n  }\n  round(c: number) {\n    return Math.round(c);\n  }\n}\n";

describe("the topic page has the PR page's reading features", { skip: pw ? false : "playwright not resolvable (set CODEMAP_E2E_PLAYWRIGHT)" }, () => {
  let base: string, root: string, server: Server, browser: any, universe: string, shots: string;
  const id: Record<string, string> = {};

  before(async () => {
    base = mkdtempSync(join(tmpdir(), "codemap-parity-"));
    shots = process.env.CODEMAP_E2E_SHOTS || join(base, "shots");
    mkdirSync(shots, { recursive: true });
    root = join(base, "repo");
    const origin = join(base, "origin.git");
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
    writeFileSync(join(root, "src/ledger.ts"), LEDGER_MAIN);
    writeFileSync(join(root, ".codemap", "sidecar"), join(base, "side"), "utf8");
    git(root, "add", "-A"); git(root, "commit", "-q", "-m", "main");
    const mainSha = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "-q", "-b", "feature");
    writeFileSync(join(root, "src/ledger.ts"), LEDGER_FEATURE);
    writeFileSync(join(root, "src/fees.ts"), FEES);
    writeFileSync(join(root, "src/audit.ts"), "export function audit() {\n  return 0;\n}\n");
    git(root, "add", "-A"); git(root, "commit", "-q", "-m", "feature");
    const featureSha = git(root, "rev-parse", "HEAD");
    git(root, "push", "-q", "origin", "main", "feature", "feature:refs/pull/5/head");
    git(root, "checkout", "-q", "main");

    const ops = await import("../ops.js");
    const { readSnapshot } = await import("../snapshots.js");
    await ops.init(root);
    for (const a of (await readSnapshot(root, featureSha))!) id[a.symbolPath.at(-1)!] = a.id;

    const features = [
      { title: "Fees", summary: "how a **fee** is computed", chapters: [
        { title: "the class", blocks: [{ kind: "prose" as const, text: "The class is the rule." }, { kind: "symbol" as const, anchorId: id.Fees! }] },
        { title: "the ledger", blocks: [{ kind: "symbol" as const, anchorId: id.post! }] },
      ] },
      { title: "Drive-by", summary: "found while walking", unstated: true, chapters: [
        { title: "rounding", blocks: [{ kind: "symbol" as const, anchorId: id.round! }] },
      ] },
    ];
    const pr = await ops.prWalkthroughSet(root, "5", features) as { error?: string };
    assert.equal(pr.error, undefined, String(pr.error));
    const def = await ops.topicDefine(root, { slug: "fees", title: "Fee rules", selector: { paths: ["src/**"], base: mainSha } }) as { error?: string };
    assert.equal(def.error, undefined, String(def.error));
    const tw = await ops.topicWalkthroughSet(root, "fees", features, { head: featureSha, whole: true }) as { error?: string };
    assert.equal(tw.error, undefined, String(tw.error));

    server = await startServer(root);
    browser = await launchPlaywright(pw);
    universe = (await (await fetch(`${server.url}/api/universes`)).json()).primary;
  });

  after(async () => {
    await browser?.close();
    server?.stop();
    if (!process.env.CODEMAP_E2E_SHOTS) discard(base);
  });

  const PAGES = { pr: () => `/u/${universe}/pr/5/`, topic: () => `/u/${universe}/topic/fees/` } as const;

  for (const kind of ["pr", "topic"] as const) {
    test(`${kind} page: names, roll-ups, unstated, unaccounted for, cover, auto-advance, diff, inline finding, viewed, collapse`, async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 1800 } });
      const { errors } = watchErrors(page);
      try {
        await page.goto(`${server.url}/#${PAGES[kind]()}`, { waitUntil: "networkidle" });
        await page.waitForSelector("main .wkfeature", { timeout: 30_000 });
        const step = (leaf: string) => page.locator(`#step-${id[leaf]}`);

        // F11: a symbol row is named by its signature, not an id.
        assert.match(await step("post").locator(".prsig").textContent(), /function post\(c: number\)/);
        // F22, R4: the unstated badge, and a summary that is markdown.
        assert.equal(await page.locator("main .wkunstated").count(), 1);
        assert.equal(await page.textContent("main .wkfsummary strong"), "fee");
        // F16, F12: progress overall and per chapter.
        assert.match(await page.textContent("main .prstats"), /0\/\d+ symbols signed/);
        assert.match(await page.locator("main .wkchapter .prchead").first().textContent(), /0\/\d+ signed/);

        // D2: what no chapter accounts for is listed, under its own head.
        const uncovered = page.locator("main .wkuncovered");
        assert.match(await uncovered.textContent(), /unaccounted for/);
        await uncovered.locator(".prchead").click();
        await step("audit").waitFor({ timeout: 10_000 });

        // F18: signing the class signs its members — calc reads covered (↳) where it is listed: in
        // "unaccounted for" on the PR page, which does not count containment, and under the class
        // on the topic page, whose chapter folds away once signed (as the PR page's do) and is reopened.
        await step("Fees").locator('button[title^="signed:"]').click();
        if (kind === "topic") {
          const theClass = page.locator("main .wkchapter", { hasText: "the class" });
          await page.waitForFunction(() => /2\/2 signed/.test([...document.querySelectorAll("main .wkchapter .prchead")]
            .find((h) => /the class/.test(h.textContent ?? ""))?.textContent ?? ""), null, { timeout: 15_000 });
          if (!await theClass.locator(".prcbody").count()) await theClass.locator(".prchead").click();
        }
        await page.waitForFunction((cid: string) => /signed ↳/.test(document.querySelector(`#step-${cid} .prrev`)?.textContent ?? ""),
          id.calc, { timeout: 15_000 });
        // F21: signing moves the walk on — the next symbol to sign opens on its own.
        await step("post").locator(".prsbody").waitFor({ timeout: 15_000 });

        // F19: a changed symbol opens on its diff, with the full source one click away.
        assert.equal(await step("post").locator(".prdiff").count(), 1);
        assert.equal(await step("post").locator("button", { hasText: "show full source" }).count(), 1);
        // F17: line numbers, and a finding filed on a line pins there.
        assert.ok(await step("post").locator(".flno").count() > 0);
        const line = step("post").locator(".flrow:has(.flcomment)").nth(1);
        await line.hover();
        await line.locator(".flcomment").click();
        await step("post").locator(".rvftextin").fill("post adds a fee nobody asked for");
        await step("post").locator(".rvaddf button", { hasText: "raise" }).click();
        await step("post").locator(".rvfind.k-finding", { hasText: "post adds a fee" }).waitFor({ timeout: 15_000 });

        // F20: viewed is its own attestation (on a symbol nothing has signed: a sign-off drops it).
        await step("audit").locator('button[title^="viewed:"]').click();
        await page.waitForFunction((rid: string) => /viewed ✓/.test(document.querySelector(`#step-${rid} .prrev`)?.textContent ?? ""),
          id.audit, { timeout: 15_000 });

        // F21: a chapter collapses from its first click.
        const rounding = page.locator("main .wkchapter", { hasText: "rounding" });
        await rounding.locator(".prchead").click();
        await page.waitForFunction(() => ![...document.querySelectorAll("main .wkchapter")]
          .some((s) => /rounding/.test(s.textContent ?? "") && s.querySelector(".prcbody")), null, { timeout: 5_000 });

        await page.screenshot({ path: join(shots, `parity-${kind}.png`), fullPage: true });
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
});
