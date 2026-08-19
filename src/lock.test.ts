import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
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

test("a holder that outlives staleMs is not stolen from, and never deletes another's lock", async () => {
  // `withLock` had no heartbeat: `at` was written once at acquire, so work lasting
  // longer than `staleMs` looked dead and was stolen mid-flight — then the original
  // holder's unconditional `rm` deleted the THIEF's lock, admitting a third writer.
  // Publishing to a pull request is one `gh` call per viewed file at a 120s timeout
  // each, so this is reachable, not theoretical.
  const root = mkdtempSync(join(tmpdir(), "codemap-lock-"));
  try {
    const inside: string[] = [];
    let overlap = false;
    const slow = withLock(root, async () => {
      inside.push("A-in");
      await new Promise((r) => setTimeout(r, 700));      // 3.5x staleMs
      if (inside.includes("B-in")) overlap = true;
      inside.push("A-out");
    }, { staleMs: 200, timeoutMs: 5000 });

    await new Promise((r) => setTimeout(r, 350));         // past staleMs, A still running
    const other = withLock(root, async () => { inside.push("B-in"); }, { staleMs: 200, timeoutMs: 5000 });

    await Promise.all([slow, other]);
    assert.equal(overlap, false, "the heartbeat must keep a live holder from being stolen from");
    assert.deepEqual(inside, ["A-in", "A-out", "B-in"], "B waits for A rather than running beside it");
    assert.equal(existsSync(join(root, ".codemap", ".lock")), false, "and the lock is released at the end");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
