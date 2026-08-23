/**
 * Cross-process write lock for a universe's `.codemap/`.
 *
 * Multiple writers — the MCP server, the CLI, a second agent's server — can race
 * on read-modify-write files like graph.json and lose an update. A writer holds
 * this lock for the whole operation; readers don't need it because writes are
 * atomic (temp + rename in store.ts), so a reader always sees a complete file.
 *
 * The lock is an exclusively-created file (`.codemap/.lock`) holding the owner's
 * pid + timestamp. A held lock is stolen only if its owner is dead or it's stale
 * (older than staleMs) — so a crashed writer never wedges the map. Zero deps.
 */

import { open, readFile, writeFile, rm, rename, mkdir, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { join, dirname } from "node:path";

const lockPath = (root: string) => join(root, ".codemap", ".lock");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The same lock, at a path the caller chooses.
 *
 * For a root whose CONTENTS are shared. A sidecar is a git repo that syncs with
 * `git add -A`, so a lock file anywhere inside it is committed and pushed to the
 * whole team — and `commitLocal` skips only when `git status` is empty, so the lock
 * appearing is itself enough to make a commit of nothing else. `withSidecarLock`
 * puts it outside the repo for that reason.
 *
 * `label` names the thing being locked in the timeout error; the lock file's own
 * path is rarely what the reader is holding.
 */
export function withLockAt<T>(lockFile: string, label: string, fn: () => Promise<T>, opts: LockOpts = {}): Promise<T> {
  return hold(lockFile, label, fn, opts);
}

export interface LockOpts { timeoutMs?: number; staleMs?: number }

function pidAlive(pid: number): boolean {
  if (!pid || pid === process.pid) return true; // ours / unknown — don't steal
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM"; // exists but not ours
  }
}

export function withLock<T>(root: string, fn: () => Promise<T>, opts: LockOpts = {}): Promise<T> {
  return hold(lockPath(root), root, fn, opts);
}

async function hold<T>(p: string, label: string, fn: () => Promise<T>, opts: LockOpts = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const staleMs = opts.staleMs ?? 60_000;
  await mkdir(dirname(p), { recursive: true });
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let fh;
    try {
      fh = await open(p, "wx"); // exclusive create — the atomic arbiter
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      // Held. Steal only if the owner is dead or the lock is stale.
      let steal = false;
      try {
        const info = JSON.parse(await readFile(p, "utf8"));
        steal = Date.now() - (info.at ?? 0) > staleMs || !pidAlive(info.pid);
      } catch {
        // Unparseable (maybe just created, content not yet written) — use mtime so
        // a freshly-created lock isn't stolen out from under its owner.
        const st = await stat(p).catch(() => null);
        steal = !st || Date.now() - st.mtimeMs > staleMs;
      }
      if (steal) {
        const grave = `${p}.dead-${process.pid}`;
        try {
          await rename(p, grave); // atomic: only one stealer wins
          await rm(grave, { force: true });
        } catch {
          /* another process got there first — just retry */
        }
        continue;
      }
      if (Date.now() > deadline) throw new Error(`codemap: ${label} is locked by another writer (timed out after ${timeoutMs}ms)`);
      await sleep(60);
      continue;
    }

    // A TOKEN, so release can tell our own lock from one somebody else has since
    // taken, and a HEARTBEAT, so a legitimately-long holder is never mistaken for a
    // dead one. Without both, work that outlives `staleMs` was stolen mid-flight and
    // the original holder then deleted the thief's lock on its way out — admitting a
    // third writer. Reachable in normal use: publishing to a pull request is one
    // `gh` call per viewed file at a 120s timeout each, and a first `/api/pr` on a
    // large repo holds this across a fetch and two full-tree indexes.
    const token = randomBytes(8).toString("hex");
    const stamp = () => writeFile(p, JSON.stringify({ pid: process.pid, at: Date.now(), token }));
    try {
      await fh.writeFile(JSON.stringify({ pid: process.pid, at: Date.now(), token }));
      await fh.close();
      // Well inside `staleMs`, whatever it is set to — a floor that exceeded it would
      // leave the heartbeat useless exactly where the window is tightest.
      const beat = setInterval(() => { void stamp().catch(() => {}); }, Math.max(50, Math.floor(staleMs / 3)));
      beat.unref?.();
      try {
        return await fn();
      } finally {
        clearInterval(beat);
      }
    } finally {
      // Only ever remove OUR lock. If it was stolen while we ran, the file now
      // belongs to whoever took it and removing it would hand the universe to a
      // third writer on top of the two already racing.
      const mine = await readFile(p, "utf8").then((t) => JSON.parse(t)?.token === token).catch(() => false);
      if (mine) await rm(p, { force: true }).catch(() => {});
    }
  }
}

/**
 * Serialize everything one machine does to one sidecar.
 *
 * `sync` is `git add -A` + commit + fetch + merge + push against a working tree.
 * Two of those at once in one repository is not a subtle race — it is index.lock
 * contention at best and a half-merged tree at worst — and nothing serialized them:
 * the HTTP path takes no lock, MCP locks the UNIVERSE rather than the sidecar, and
 * the CLI takes none. `PROPOSAL-sidecar-materialization.md` §8 records the gap.
 *
 * **The lock file lives outside the sidecar**, keyed on its real path. Anywhere
 * inside it would be committed and pushed to the whole team by that same
 * `git add -A` — and `commitLocal` returns early only when `git status` is empty,
 * so the lock file appearing is itself enough to produce a commit containing
 * nothing else. `realpath` rather than the given path so two pointers at one
 * sidecar take one lock.
 *
 * Machine-scoped by construction, which is all it can be: the sidecar's other
 * writers are other people's clones, and they are serialized by git's own merge,
 * not by this.
 *
 * **NOT reentrant.** `sync` takes it itself, because it is one whole transaction
 * and there is no legitimate reason to hold this across a sync plus something else.
 * A caller that wraps `sync` in it deadlocks for the full timeout — the same
 * convention the universe lock already follows: it is taken at the entry to a
 * complete operation, never nested.
 */
export function withSidecarLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  let real = root;
  try { real = realpathSync(root); } catch { /* not created yet — the given path is all there is */ }
  const key = createHash("sha256").update(real).digest("hex").slice(0, 16);
  return withLockAt(join(tmpdir(), `codemap-sidecar-${key}.lock`), root, fn);
}
