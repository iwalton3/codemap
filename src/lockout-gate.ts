/**
 * The front ends' half of the lockout (plan 1.2): before any read or op, every sidecar this
 * process serves is scanned once and its flag checked; a damaged entry met mid-op locks it.
 * MCP, the web server and the CLI all come through here, so the diagnostic is one sentence
 * wherever a person meets it. See `lockout.ts` for the flag and `docs/log-repair.md`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveSidecar } from "./sidecar-config.js";
import { foldDefectNotice, scanOnOpen } from "./damage-scan.js";
import { isLogDamage } from "./log-damage.js";
import { LockedOut, locate, lockoutOf, recordLockout } from "./lockout.js";
import { scopesOnDisk } from "./eventlog.js";

/** The sidecars behind these universes, once each. A universe without one has nothing to lock. */
function sidecarsOf(roots: string[]): string[] {
  const out = new Set<string>();
  for (const r of roots) {
    const cfg = resolveSidecar(r);
    if (cfg && existsSync(join(cfg.path, ".git"))) out.add(cfg.path);
  }
  return [...out];
}

/** The lockout any of these universes' sidecars is under, scanning each once per process. */
export async function lockoutGate(roots: string[]): Promise<LockedOut | null> {
  const sidecars = sidecarsOf(roots);
  for (const s of sidecars) await scanOnOpen(s);
  for (const s of sidecars) {
    const l = lockoutOf(s);
    if (l) return new LockedOut(l);
  }
  return null;
}

/**
 * The fold-defect notice for these universes' sidecars, or null (round 2 C8). Shown beside a
 * result by every front end, never in place of one: no lock, and pushes carry on.
 */
export async function foldDefectGate(roots: string[]): Promise<string | null> {
  const found: string[] = [];
  for (const s of sidecarsOf(roots)) { const n = await foldDefectNotice(s); if (n) found.push(n); }
  return found.length ? found.join("\n") : null;
}

/**
 * What an op's failure means for the lockout: damage met mid-op (the write door's fold, a
 * direct fold) locks the sidecar that holds the entry, and answers as the lockout does.
 * Anything else is not ours and comes back null.
 */
export async function asLockout(err: unknown, roots: string[]): Promise<LockedOut | null> {
  if (err instanceof LockedOut) return err;
  if (!isLogDamage(err)) return null;
  const sidecars = sidecarsOf(roots);
  for (const s of sidecars) {
    const found = locate(s, await scopesOnDisk(s), err.entry);
    if (found.shard) return new LockedOut(recordLockout(s, found));
  }
  // Not on disk anywhere this process serves — a fold of events handed to it directly.
  const s = sidecars[0];
  return new LockedOut(s ? recordLockout(s, err.entry) : { sidecar: "(none)", entry: err.entry, at: new Date().toISOString() });
}
