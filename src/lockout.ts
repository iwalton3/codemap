/**
 * The lockout: damage anywhere this machine can see stops the whole application (plan 1.2).
 *
 * The owner's words: a halt "should basically lockout the entire application until it is
 * fixed", sync included — "don't pile more entries onto a possibly broken datastore" (batch 4)
 * — and it triggers on damage anywhere this machine can see, an incoming pull it refused
 * included (batch 8). Not acknowledgeable: the repair is a person-approved history rewrite,
 * docs/log-repair.md.
 *
 * The flag lives in the damaged sidecar clone's GIT DIR, never its work tree (`sync` is
 * `git add -A`, and a committed flag would lock the whole team out of a repair), so every
 * store on that sidecar sees it — several universes share one sidecar — and every codemap
 * process checks the flags of every sidecar it serves before any read or op.
 *
 * Folding is lazy, which is why a flag and not a fold: a findings read never folds
 * `decisions/`, so without a flag set by whoever DID fold it, the rest of the app would carry
 * on past the damage. `damage-scan.ts` folds every shape-checked scope at open and after each
 * pull; any other fold that meets damage sets the flag too.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DamagedEntry } from "./log-damage.js";

const FLAG = "codemap-lockout.json";

export interface Lockout { sidecar: string; entry: DamagedEntry; at: string }

function gitDir(root: string): string | null {
  const dot = join(root, ".git");
  try {
    if (statSync(dot).isDirectory()) return dot;
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"));
    return m ? resolve(root, m[1]!.trim()) : null;
  } catch { return null; }
}

/** The lockout recorded on this sidecar, if any. */
export function lockoutOf(logRoot: string): Lockout | null {
  const dir = gitDir(logRoot);
  if (!dir) return null;
  try { return JSON.parse(readFileSync(join(dir, FLAG), "utf8")) as Lockout; } catch { return null; }
}

/**
 * Where an entry sits: the shard and its 1-based line, so `sed -n <line>p` finds it. Searched
 * by id; a scope whose shards cannot be read leaves the entry as it was.
 */
export function locate(logRoot: string, scopes: string[], entry: DamagedEntry): DamagedEntry {
  if (entry.shard) return entry;
  const needle = `"id":${JSON.stringify(entry.id)}`;
  for (const scope of scopes) {
    let names: string[] = [];
    try { names = readdirSync(join(logRoot, scope)).filter((n) => n.endsWith(".ndjson")).sort(); } catch { continue; }
    for (const n of names) {
      let lines: string[] = [];
      try { lines = readFileSync(join(logRoot, scope, n), "utf8").split("\n"); } catch { continue; }
      const i = lines.findIndex((l) => l.includes(needle));
      if (i >= 0) return { ...entry, scope, shard: `${scope}/${n}`, line: i + 1 };
    }
  }
  return entry;
}

/**
 * Lock this sidecar. The FIRST damage found is kept: a repair starts from one entry, and a
 * flag that moved each time a different read met a different entry would never settle.
 */
export function recordLockout(logRoot: string, entry: DamagedEntry): Lockout {
  const held = lockoutOf(logRoot);
  if (held) return held;
  const lockout: Lockout = { sidecar: logRoot, entry, at: new Date().toISOString() };
  const dir = gitDir(logRoot);
  // No git dir: nothing to put a flag in. The thrown damage still stops this read.
  if (dir) writeFileSync(join(dir, FLAG), JSON.stringify(lockout, null, 2) + "\n", "utf8");
  return lockout;
}

/** Only `damage-scan.ts` clears, and only once nothing damaged is visible any more. */
export function clearLockout(logRoot: string): void {
  const dir = gitDir(logRoot);
  if (dir && existsSync(join(dir, FLAG))) rmSync(join(dir, FLAG));
}

/** The one diagnostic every read and op answers while locked. */
export function lockoutMessage(l: Lockout): string {
  const e = l.entry;
  const where = e.shard ? `${e.shard}${e.line ? `:${e.line}` : ""}` : e.scope ?? "an unknown scope";
  return `codemap is locked: the shared log at ${l.sidecar} holds a damaged entry, so nothing reads or `
    + `writes until it is repaired. Entry ${e.id} (${e.kind}) at ${where}: ${e.why}. The log is immutable, `
    + `so the repair is a history rewrite that a person approves — see docs/log-repair.md. Sync is refused `
    + `too, except to fetch and re-check; the lock clears once no damage is visible here or on the fetched tip.`;
}

export class LockedOut extends Error {
  readonly lockout: Lockout;
  constructor(lockout: Lockout) { super(lockoutMessage(lockout)); this.name = "LockedOut"; this.lockout = lockout; }
}

/** Refuse, naming the damage, if any of these sidecars is locked. */
export function assertNotLockedOut(logRoots: (string | undefined)[]): void {
  for (const r of logRoots) {
    const l = r ? lockoutOf(r) : null;
    if (l) throw new LockedOut(l);
  }
}
