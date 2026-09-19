/**
 * Where a pull request's link to its branch is recorded (triage run
 * 2026-09-19-branch-review-round, R-C): once, where the pull request is resolved through
 * `gh`, under the write lock — taken briefly by a read, skipped when somebody else holds
 * it, and never re-taken by an operation that already holds it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { init } from "./ops.js";
import { pr, prPacketFor } from "./ops/pr.js";
import { linkReviewOp } from "./ops-shared.js";
import { linkedBranches } from "./store.js";
import { clearPrMetaCache } from "./pr.js";
import { withLock } from "./lock.js";
import { discard } from "./test-tmp.js";

const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=izzie", ...a], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/**
 * Node's `spawn` finds only `gh.exe`/`gh.com` on Windows, so no script can stand in for
 * `gh` there — and a production seam just for these tests was ruled out (owner,
 * 2026-09-19). Nothing they check is platform-specific; Linux runs them.
 */
const FAKE_GH_UNSUPPORTED = process.platform === "win32" && "a fake `gh` cannot be a script on Windows";

/** A repo whose origin is on GitHub, a `feature` branch, and a fake `gh` that says PR 12 is feature → main. */
async function fixture(withSidecar: boolean) {
  const base = mkdtempSync(join(tmpdir(), "codemap-link-"));
  const root = join(base, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".codemap"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "remote", "add", "origin", "https://github.com/acme/api.git");
  writeFileSync(join(root, "src/pay.ts"), "export function transfer(cents: number) {\n  return cents;\n}\n");
  writeFileSync(join(root, ".gitignore"), ".codemap/\n");
  if (withSidecar) writeFileSync(join(root, ".codemap", "sidecar"), join(base, "side"), "utf8");
  git(root, "add", "-A"); git(root, "commit", "-q", "-m", "main");
  const mainSha = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "-b", "feature");
  writeFileSync(join(root, "src/pay.ts"), "export function transfer(cents: number) {\n  return cents * 2;\n}\n");
  git(root, "commit", "-q", "-am", "feature");
  const headSha = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
  await init(root);

  const bin = join(base, "bin");
  mkdirSync(bin);
  const meta = {
    number: 12, url: "https://github.com/acme/api/pull/12", title: "t", author: { login: "izzie" },
    baseRefName: "main", headRefName: "feature", baseRefOid: mainSha, headRefOid: headSha,
    isDraft: false, state: "OPEN", createdAt: "2026-09-19T00:00:00Z", updatedAt: "2026-09-19T00:00:00Z",
    additions: 1, deletions: 1, changedFiles: 1, commits: [{}], isCrossRepository: false,
  };
  writeFileSync(join(bin, "gh"), `#!/bin/sh\ncase "$1" in\n  --version) echo fake; exit 0;;\n  pr) cat <<'JSON'\n${JSON.stringify(meta)}\nJSON\n  exit 0;;\nesac\nexit 1\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  clearPrMetaCache();
  return {
    root,
    cleanup: () => { process.env.PATH = oldPath; clearPrMetaCache(); discard(base); },
  };
}

test("pr_packet records the link — it holds the write lock, and does not wait on itself", { skip: FAKE_GH_UNSUPPORTED }, async () => {
  const f = await fixture(true);
  try {
    const t0 = Date.now();
    const r = await withLock(f.root, () => prPacketFor(f.root, "12", { fetch: false })) as Record<string, unknown>;
    assert.equal(r.error, undefined, String(r.error));
    assert.ok(Date.now() - t0 < 10_000, "a non-reentrant lock re-taken inside would wait out its 30s timeout");
    assert.deepEqual(linkedBranches(f.root, 12), ["feature"]);
  } finally { f.cleanup(); }
});

test("a read links the pull request when the lock is free", { skip: FAKE_GH_UNSUPPORTED }, async () => {
  const f = await fixture(true);
  try {
    const r = await pr(f.root, "12", { fetch: false }) as Record<string, unknown>;
    assert.equal(r.error, undefined, String(r.error));
    assert.deepEqual(linkedBranches(f.root, 12), ["feature"]);
  } finally { f.cleanup(); }
});

test("a read skips the link, promptly, while another process holds the lock", { skip: FAKE_GH_UNSUPPORTED }, async () => {
  const f = await fixture(true);
  try {
    // A live pid that is not ours: the lock is genuinely held, not stale.
    writeFileSync(join(f.root, ".codemap", ".lock"), JSON.stringify({ pid: process.ppid, at: Date.now(), token: "other" }));
    const t0 = Date.now();
    const r = await pr(f.root, "12", { fetch: false }) as Record<string, unknown>;
    assert.equal(r.error, undefined, String(r.error));
    assert.ok(Date.now() - t0 < 10_000, "the read does not wait for the writer");
    assert.deepEqual(linkedBranches(f.root, 12), [], "and writes nothing outside the lock");
  } finally { f.cleanup(); }
});

test("a link recorded before the sidecar existed is published once there is one", async () => {
  const f = await fixture(false);
  try {
    await linkReviewOp(f.root, "12", "feature");
    assert.deepEqual(linkedBranches(f.root, 12, { published: true }), []);
    writeFileSync(join(f.root, ".codemap", "sidecar"), join(f.root, "..", "side"), "utf8");
    const r = await linkReviewOp(f.root, "12", "feature") as Record<string, unknown>;
    assert.equal(r.already, undefined, "not `already`: only this machine had it");
    assert.deepEqual(linkedBranches(f.root, 12, { published: true }), ["feature"]);
  } finally { f.cleanup(); }
});

test("a pull request's remembered head belongs to its repository, not only its number", { skip: FAKE_GH_UNSUPPORTED }, async () => {
  const f = await fixture(true);
  try {
    const { prHeadForFinding } = await import("./pr.js");
    const own = await prHeadForFinding(f.root, "12") as { sha?: string; error?: string };
    assert.ok(own.sha, String(own.error));
    // Another repository's #12: gh cannot see it here, so there is no head to give.
    const gh = join(f.root, "..", "bin", "gh");
    writeFileSync(gh, `#!/bin/sh\ncase "$*" in *other/repo*) exit 1;; esac\nexit 1\n`);
    chmodSync(gh, 0o755);
    const other = await prHeadForFinding(f.root, "other/repo#12") as { sha?: string; error?: string };
    assert.equal(other.sha, undefined, "acme/api#12's head was served for other/repo#12");
  } finally { f.cleanup(); }
});
