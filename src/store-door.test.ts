import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { admitStore, NoStore, setStoreCreation, storeCreationFor } from "./store-door.js";
import { discard } from "./test-tmp.js";

const CLI = join(process.cwd(), "dist/cli.js");

/** A git repo with one commit, no `.codemap/`, and `docs/rules/` ignored (a cut-over repo). */
function storeless(): string {
  const root = mkdtempSync(join(tmpdir(), "cmdoor-"));
  const git = (...a: string[]) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(root, ".gitignore"), "docs/rules/\n");
  writeFileSync(join(root, "a.py"), "def f():\n    return 1\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return root;
}

// spawnSync's stdin is a pipe, never a tty: this is an agent or a script.
const cli = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args],
  { encoding: "utf8", env: { ...process.env, CODEMAP_SIDECAR: "", ...env } });

test("the door: without a tty only init (and its alias) may create a store; with one, any command may and says so", () => {
  assert.equal(storeCreationFor("diff", false), "refuse");
  assert.equal(storeCreationFor("diff", true), "announce");
  assert.equal(storeCreationFor("init", false), "silent");
  assert.equal(storeCreationFor("reindex", false), "silent");
});

test("the door refuses a storeless root but admits a legacy JSON store, which the first open imports", () => {
  const root = storeless();
  try {
    setStoreCreation("refuse");
    assert.throws(() => admitStore(root), NoStore);
    mkdirSync(join(root, ".codemap"));
    writeFileSync(join(root, ".codemap", "sidecar"), "/elsewhere\n");
    assert.throws(() => admitStore(root), NoStore, "a sidecar pointer is not a store");
    writeFileSync(join(root, ".codemap", "anchors.json"), "{}");
    admitStore(root);
  } finally { setStoreCreation("silent"); discard(root); }
});

test("without a tty, a CLI command other than init refuses a storeless checkout and creates nothing", () => {
  const root = storeless();
  try {
    const diff = cli(["diff", "HEAD", "--repo", root]);
    assert.equal(diff.status, 1, diff.stdout + diff.stderr);
    assert.match(diff.stderr, /no codemap store at .*codemap init/);
    assert.doesNotMatch(diff.stderr, /\n\s+at /, "one line, not a stack trace");
    // `snapshot` takes the universe lock first, which made `.codemap/` for its `.lock`.
    const snap = cli(["snapshot", root]);
    assert.equal(snap.status, 1, snap.stdout + snap.stderr);
    const sidecar = mkdtempSync(join(tmpdir(), "cmdoor-sc-"));
    spawnSync("git", ["init", "-q", sidecar]);
    const sync = cli(["sync", root], { CODEMAP_SIDECAR: sidecar });
    discard(sidecar);
    assert.equal(sync.status, 1, sync.stdout + sync.stderr);
    assert.equal(existsSync(join(root, ".codemap")), false, "nothing created");

    const init = cli(["init", root]);
    assert.equal(init.status, 0, init.stderr);
    assert.ok(existsSync(join(root, ".codemap", "codemap.db")));
  } finally { discard(root); }
});

test("a legacy JSON store passes the CLI door and is imported, as before", () => {
  const root = storeless();
  try {
    mkdirSync(join(root, ".codemap"));
    writeFileSync(join(root, ".codemap", "anchors.json"), JSON.stringify({ anchors: [] }));
    const r = cli(["diff", "HEAD", "--repo", root]);
    assert.doesNotMatch(r.stderr, /no codemap store/);
    assert.ok(existsSync(join(root, ".codemap", "codemap.db")));
  } finally { discard(root); }
});

/** Start a server, wait for it to exit or answer `initialize` and settle; then stop it. */
async function server(script: string, args: string[], cwd: string): Promise<{ code: number | null; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEMAP_SIDECAR: "", PORT: "0" }; // never the default 4310
  delete env.CODEMAP_ROOT;
  const p = spawn(process.execPath, ["--no-warnings", join(process.cwd(), "dist", script), ...args], { cwd, env, stdio: "pipe" });
  let stderr = "", stdout = "";
  p.stderr.on("data", (d) => { stderr += d; });
  p.stdout.on("data", (d) => { stdout += d; });
  const exited = new Promise<number | null>((r) => p.on("exit", (c) => r(c)));
  if (script === "mcp.js") {
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) + "\n");
  }
  // Every wait here must end when the server does: the suite is one process, and a live timer
  // keeps it from ever exiting after its last test.
  let over = false;
  void exited.then(() => { over = true; });
  const answered = (async () => { while (!over && !stdout.includes('"id":1') && !/codemap-serve: http/.test(stderr)) await new Promise((r) => setTimeout(r, 50)); })();
  const first = await Promise.race([exited.then((c) => ({ c })), answered.then(() => null), new Promise((r) => setTimeout(r, 10_000).unref()).then(() => null)]);
  if (first) return { code: first.c, stderr };
  // The startup rules write is not awaited by the server; give it time to land, then stop.
  await new Promise((r) => setTimeout(r, 1500));
  p.kill();
  await exited;
  return { code: null, stderr };
}

test("a bare `codemap mcp` and a bare `codemap serve` are refused, and create nothing", async () => {
  const root = storeless();
  try {
    for (const script of ["mcp.js", "serve.js"]) {
      const r = await server(script, [], root);
      assert.equal(r.code, 1, `${script}: ${r.stderr}`);
      assert.match(r.stderr, /repo|workspace/);
      assert.equal(existsSync(join(root, ".codemap")), false, script);
      assert.equal(existsSync(join(root, "docs")), false, script);
    }
  } finally { discard(root); }
});

test("a server given a storeless checkout writes no rule set at start", async () => {
  const root = storeless();
  try {
    const r = await server("mcp.js", [root], root);
    assert.equal(r.code, null, r.stderr);
    assert.equal(existsSync(join(root, "docs", "rules")), false, "an empty store renders \"None.\"");
  } finally { discard(root); }
});

test("`mcp --existing` serves a checkout that has a store and refuses one that has none, creating nothing", async () => {
  // For a launch configured once for every directory (a global cwd config): it may use a store,
  // never create one (owner, 2026-10-16).
  const root = storeless();
  try {
    const refused = await server("mcp.js", ["--existing", "."], root);
    assert.equal(refused.code, 1, refused.stderr);
    assert.match(refused.stderr, /no codemap store/);
    assert.equal(existsSync(join(root, ".codemap")), false);
    assert.equal(cli(["init", root]).status, 0);
    const served = await server("mcp.js", ["--existing", "."], root);
    assert.equal(served.code, null, served.stderr);
  } finally { discard(root); }
});
