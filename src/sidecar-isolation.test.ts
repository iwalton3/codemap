/**
 * The sidecar must be its OWN git repository, wherever it is put.
 *
 * The documented zero-configuration layout is `.codemap/sidecar` inside the code
 * repo, which is inside a work tree. `ensureSidecar` used to ask
 * `rev-parse --is-inside-work-tree` — "am I inside some repo" — so that layout
 * answered true, `git init` was skipped, and every later git call operated on the
 * developer's own repository: `commitLocal` is `git add -A` plus a commit, and
 * `push` resolves that repo's `origin`.
 *
 * One `sync` therefore committed work the developer had deliberately not
 * committed, pushed it to the team remote, and reported success — while sharing
 * nothing at all, because the shards live under the `*`-ignored `.codemap/`.
 *
 * These tests reproduce that setup and assert the damage does not happen. They
 * exercise the real thing: a real code repo with real uncommitted files, and a
 * real bare remote for `push` to find.
 */

import { test } from "node:test";
import { testEvent } from "./test-events.js";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ensureSidecar, sync } from "./sidecar.js";
import { appendEvents, mintId } from "./eventlog.js";
import type { Actor } from "./schema.js";
import { discard } from "./test-tmp.js";

const izzie: Actor = { principal: "izzie@x.com" };

function git(cwd: string, ...args: string[]) {
  return spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=izzie", ...args],
    { cwd, encoding: "utf8" });
}

/** A code repo with one commit, one modified file and one untracked file. */
function codeRepo() {
  const remote = mkdtempSync(join(tmpdir(), "codemap-remote-"));
  git(remote, "init", "-q", "--bare");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codemap-code-")));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "initial");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "origin", "main");

  // The state that must survive: an edit in progress and a file never staged.
  writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
  writeFileSync(join(root, "secret-wip.ts"), "export const notReadyYet = true;\n");

  // Exactly what db.ts writes, and the reason the shards would have been invisible.
  mkdirSync(join(root, ".codemap"), { recursive: true });
  writeFileSync(join(root, ".codemap", ".gitignore"), "*\n");

  const head = () => git(root, "rev-parse", "HEAD").stdout.trim();
  const status = () => git(root, "status", "--porcelain").stdout.trim();
  return {
    root, remote, head, status,
    remoteLog: () => git(remote, "log", "--oneline").stdout.trim(),
    cleanup: () => [root, remote].forEach((d) => discard(d)),
  };
}

test("a sidecar nested inside a code repo becomes its own repository", async () => {
  const c = codeRepo();
  try {
    const side = join(c.root, ".codemap", "sidecar");
    const r = await ensureSidecar(side, izzie);
    assert.deepEqual(r, { created: true }, "it must init, not adopt the enclosing repo");

    const top = git(side, "rev-parse", "--show-toplevel").stdout.trim();
    // `.native`, the same resolver `samePath` uses. git reports the long Windows path
    // while `tmpdir()` hands back the 8.3 short form, and plain `realpathSync` expands
    // neither — so this compared `RUNNER~1` against `runneradmin` and failed on a
    // difference that is not the one it is testing.
    assert.equal(realpathSync.native(top), realpathSync.native(side),
      "the sidecar's git root is itself, not the code repo");
    assert.ok(existsSync(join(side, ".git")), "it has its own .git");
  } finally { c.cleanup(); }
});

test("syncing a nested sidecar does not commit or push the code repo", async () => {
  const c = codeRepo();
  try {
    const side = join(c.root, ".codemap", "sidecar");
    await ensureSidecar(side, izzie);
    const headBefore = c.head(), remoteBefore = c.remoteLog(), statusBefore = c.status();

    // Real traffic, so commitLocal has something to do.
    await appendEvents(side, "findings/acme/pr-1", "w_test_clone", [testEvent({
      id: mintId(), kind: "finding.created", subject: "f_1", actor: izzie,
      writer: "w_test_clone",
      data: { targetKind: "anchor", targetId: "a_1", text: "evidence" },
    })]);
    await sync(side, izzie);

    assert.equal(c.head(), headBefore, "the code repo gained a commit");
    assert.equal(c.remoteLog(), remoteBefore, "something was pushed to the code repo's remote");
    assert.equal(c.status(), statusBefore, "the working tree changed");
    assert.match(statusBefore, /secret-wip\.ts/, "the fixture's whole point — an untracked file was present throughout");
  } finally { c.cleanup(); }
});

test("a path that IS a repo root is still adopted, not re-initialised", async () => {
  // The other half of the contract, and the reason the check is "is this path the
  // root" rather than "init unconditionally": pointing codemap at a sidecar repo
  // you already cloned is the normal way a second person joins.
  const c = codeRepo();
  try {
    assert.deepEqual(await ensureSidecar(c.root, izzie), { created: false });
    assert.equal(git(c.root, "log", "--oneline").stdout.trim().split("\n").length, 1,
      "adopting a repo must not lose its history");
  } finally { c.cleanup(); }
});
