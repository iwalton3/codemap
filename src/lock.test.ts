import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLock, touchHeldLocks, SIDECAR_LOCK_STALE_MS } from "./lock.js";
import { GIT_CALL_TIMEOUT_MS } from "./sidecar.js";
import { discard } from "./test-tmp.js";

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
  } finally { discard(root); }
});

test("the sidecar's stale window outlasts one git call", () => {
  // Not a tautology, and not a style rule. `staleMs` narrower than a single git call
  // means a slow fetch is stolen from mid-merge no matter what the heartbeat does,
  // because nothing at all runs while `spawnSync` blocks. These two numbers live in
  // different files and drifted apart once already — 60s against a 180s timeout.
  assert.ok(
    SIDECAR_LOCK_STALE_MS > GIT_CALL_TIMEOUT_MS,
    `the sidecar lock goes stale in ${SIDECAR_LOCK_STALE_MS}ms but one git call may block for ${GIT_CALL_TIMEOUT_MS}ms`,
  );
});

test("a held lock can be refreshed from inside a synchronous block", async () => {
  // The heartbeat is a `setInterval`, and git is `spawnSync`. A run of git calls
  // never turns the event loop, so the timer cannot fire — not during a call and not
  // between two of them. `touchHeldLocks` is the only thing that executes in that
  // window, which is why it is synchronous.
  const root = mkdtempSync(join(tmpdir(), "codemap-lock-"));
  try {
    const lockFile = join(root, ".codemap", ".lock");
    // `readFileSync`, and nothing awaited between the reads. An `await` here turns
    // the event loop, and a timer whose deadline passed during the block fires the
    // instant it does — so an async read measures the catch-up rather than the
    // window, and the control below passes for the wrong reason. (It did.)
    const stampedAt = () => JSON.parse(readFileSync(lockFile, "utf8")).at as number;
    // Busy-wait, NOT `sleep`: sleeping yields, and yielding is precisely what a
    // blocking subprocess does not do. This reproduces the real window.
    const block = (ms: number) => { const until = Date.now() + ms; while (Date.now() < until) { /* spin */ } };

    await withLock(root, async () => {
      const before = stampedAt();

      // CONTROL: the timer is genuinely dead across a synchronous block. Without
      // this, the assertion below would pass just as well if the heartbeat worked
      // and `touchHeldLocks` did nothing at all.
      block(150);
      assert.equal(stampedAt(), before, "no timer fires while the event loop is blocked");

      touchHeldLocks();
      assert.ok(stampedAt() > before, "touchHeldLocks refreshed the lock from inside the block");
    }, { staleMs: 100 });

    assert.equal(existsSync(lockFile), false, "and the lock is still released normally");
  } finally {
    discard(root);
  }
});

test("a released lock is no longer refreshed", async () => {
  // The held-lock registry must not leak: a stamp after release would rewrite a lock
  // that now belongs to somebody else, which is the failure the token check exists
  // to prevent on the delete side.
  const root = mkdtempSync(join(tmpdir(), "codemap-lock-"));
  try {
    const lockFile = join(root, ".codemap", ".lock");
    await withLock(root, async () => { assert.ok(existsSync(lockFile)); });
    touchHeldLocks();
    assert.equal(existsSync(lockFile), false, "touchHeldLocks did not resurrect a released lock");
  } finally {
    discard(root);
  }
});
