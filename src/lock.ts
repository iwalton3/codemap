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

import { open, readFile, rm, rename, mkdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";

const lockPath = (root: string) => join(root, ".codemap", ".lock");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid: number): boolean {
  if (!pid || pid === process.pid) return true; // ours / unknown — don't steal
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM"; // exists but not ours
  }
}

export async function withLock<T>(root: string, fn: () => Promise<T>, opts: { timeoutMs?: number; staleMs?: number } = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const staleMs = opts.staleMs ?? 60_000;
  const p = lockPath(root);
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
      if (Date.now() > deadline) throw new Error(`codemap: ${root} is locked by another writer (timed out after ${timeoutMs}ms)`);
      await sleep(60);
      continue;
    }

    try {
      await fh.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      await fh.close();
      return await fn();
    } finally {
      await rm(p, { force: true }).catch(() => {});
    }
  }
}
