import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLock } from "./lock.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("withLock serializes concurrent critical sections", async () => {
  const root = await mkdtemp(join(tmpdir(), "cmlock-"));
  let active = 0;
  let maxActive = 0;
  const crit = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await sleep(25);
    active--;
  };
  await Promise.all([withLock(root, crit), withLock(root, crit), withLock(root, crit)]);
  assert.equal(maxActive, 1, "at most one critical section runs at a time");
  await rm(root, { recursive: true, force: true });
});

test("withLock releases the lock afterward (and on throw)", async () => {
  const root = await mkdtemp(join(tmpdir(), "cmlock-"));
  await assert.rejects(withLock(root, async () => { throw new Error("boom"); }));
  // lock file must be gone so the next writer isn't wedged
  await assert.rejects(readFile(join(root, ".codemap", ".lock"), "utf8"));
  let ran = false;
  await withLock(root, async () => { ran = true; });
  assert.ok(ran);
  await rm(root, { recursive: true, force: true });
});

test("a stale/dead lock is stolen, not waited on forever", async () => {
  const root = await mkdtemp(join(tmpdir(), "cmlock-"));
  await mkdir(join(root, ".codemap"), { recursive: true });
  // A lock owned by a dead pid, timestamped long ago.
  await writeFile(join(root, ".codemap", ".lock"), JSON.stringify({ pid: 2 ** 22, at: Date.now() - 5 * 60_000 }));
  let ran = false;
  await withLock(root, async () => { ran = true; }, { timeoutMs: 3000 });
  assert.ok(ran, "stole the stale lock and ran");
  await rm(root, { recursive: true, force: true });
});
