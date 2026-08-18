/**
 * End-to-end harness for the web UI.
 *
 * The UI is where codemap's review surfaces actually live, and it has bitten
 * repeatedly in ways unit tests cannot see (hash-mode deep links, `each()` guards,
 * boolean attribute binding — see CLAUDE.md). These tests drive a real browser
 * against a real server on a throwaway universe and fail on any console error.
 *
 * Puppeteer is resolved *at runtime from outside this project* and the suite
 * skips when it is absent: the golden rule (no runtime dependencies) applies to
 * the test tree too, and `npm test` must never depend on a browser being
 * installed. Point `CODEMAP_E2E_PUPPETEER` at any dir with puppeteer installed.
 */

import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHROMIUM = process.env.CODEMAP_E2E_CHROMIUM ?? "/usr/bin/chromium";
const PUPPETEER_DIRS = [process.env.CODEMAP_E2E_PUPPETEER, "/working/vdx-web/tests/e2e/", resolve(".")].filter(Boolean) as string[];

export function resolvePuppeteer(): any | null {
  for (const dir of PUPPETEER_DIRS) {
    try {
      return createRequire(dir.endsWith("/") ? dir : dir + "/")("puppeteer");
    } catch { /* try the next candidate */ }
  }
  return null;
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

export interface Server { url: string; stop(): void }

/** Boot `serve.js` against a target and wait until it answers. Killed by pid — never pkill. */
export async function startServer(target: string): Promise<Server> {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, [resolve("dist/serve.js"), target, String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = `http://localhost:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`serve.js exited early (${child.exitCode})`);
    try {
      const r = await fetch(`${url}/api/universes`);
      if (r.ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) { child.kill("SIGKILL"); throw new Error("serve.js did not become ready"); }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { url, stop: () => { if (child.exitCode === null) child.kill("SIGTERM"); } };
}

export interface Fixture { root: string; universe: string; cleanup(): void }

/**
 * A throwaway git repo with a real index and one documented node, so every UI
 * surface has something to render. Hermetic on purpose — the e2e suite must not
 * read the live universes under /working.
 */
export async function makeFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "codemap-e2e-"));
  const git = (...a: string[]) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: root });
  git("init", "-q", "-b", "main");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/pay.ts"), `
export function transfer(cents: number, to: string) {
  if (cents <= 0) throw new Error("bad amount");
  return { to, cents };
}
export function refund(cents: number) {
  return transfer(-cents, "origin");
}
export const feeSchedule = { flat: 30, pct: 0.029 };
`);
  writeFileSync(join(root, "src/ledger.ts"), `
export function post(entry: { cents: number }) {
  return entry.cents;
}
`);
  git("add", "-A"); git("commit", "-qm", "init");

  const ops = await import("../ops.js");
  const { readAnchorStore } = await import("../store.js");
  const { writeNode } = await import("../store.js");
  await ops.init(root);
  const anchors = (await readAnchorStore(root)).anchors;
  const cited = anchors.filter((a) => a.file === "src/pay.ts").slice(0, 2).map((a) => a.id);
  await writeNode(root, {
    id: "n_transfer_flow", type: "process", title: "Transfer flow",
    summary: "Moves money between accounts.", anchors: cited, body: "A transfer validates the amount and records it.",
  } as any);

  return { root, universe: require_basename(root), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function require_basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1]!;
}

export interface PageErrors { errors: string[] }

/** Attach console/pageerror collection — any entry fails the test. */
export function watchErrors(page: any): PageErrors {
  const errors: string[] = [];
  page.on("console", (m: any) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("pageerror", (e: Error) => errors.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r: any) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ""}`));
  return { errors };
}

export async function launch(puppeteer: any) {
  return puppeteer.launch({
    executablePath: CHROMIUM,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}

/**
 * A universe where an approval sits on top of a revert.
 *
 * Built by actually doing it — sign the body at v1, sign the changed body at v2,
 * then commit a third change putting the body back to v1. That is the one review
 * state no live repo happens to be in, and the one whose whole point is that it
 * looks identical to an ordinary approval unless every surface says otherwise.
 */
export async function makeRevertFixture(): Promise<Fixture & { anchorId: string; nodeId: string }> {
  const root = mkdtempSync(join(tmpdir(), "codemap-e2e-revert-"));
  const git = (...a: string[]) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: root });
  git("init", "-q", "-b", "main");
  mkdirSync(join(root, "src"));
  const write = (body: string) => writeFileSync(join(root, "src/pay.ts"), `export function transfer(cents: number) {\n${body}\n}\n`);
  const commit = (m: string) => { git("add", "-A"); git("commit", "-qm", m); return spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim(); };

  write("  return cents;");
  const c1 = commit("v1");
  write('  if (cents < 0) throw new Error("neg");\n  return cents;');
  const c2 = commit("v2 guard");

  const ops = await import("../ops.js");
  const { writeNode, readAnchorStore, writeSnapshot } = await import("../store.js");
  const { markReviewed } = await import("../reviews.js");
  const { indexCommit } = await import("../repo.js");
  await ops.init(root);
  for (const sha of [c1, c2]) await writeSnapshot(root, sha, "main", (await indexCommit(root, sha))!, new Date().toISOString());

  const anchorId = (await readAnchorStore(root)).anchors.find((a) => a.symbolPath.join(".") === "transfer")!.id;
  await writeNode(root, { id: "n_pay", type: "process", title: "Payment transfer", summary: "Moves money.", anchors: [anchorId], body: "The guard rejects negative amounts." } as any);
  for (const ref of [c1, c2]) {
    await markReviewed(root, { targetKind: "anchor", targetId: anchorId, level: "code", actor: "human", attestation: "signed", ref });
  }

  write("  return cents;");                       // the revert: back to the v1 body
  commit("revert the guard");

  return { root, universe: root.split("/").pop()!, anchorId, nodeId: "n_pay", cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
