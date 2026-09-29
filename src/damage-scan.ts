/**
 * Look at everything this machine can see for damage, and lock on the first (plan 1.2).
 *
 * Run once per process per sidecar before its first read or op, and after every pull: the
 * folds are lazy, so without this a findings read would never see damage sitting in
 * `decisions/`. Bytes that are not JSON count in EVERY scope; the shapes and the fold's own
 * refusals count in the scopes that have them (decisions and the standard).
 */
import { readScope, readScopeChecked, scopesOnDisk, sortEvents, type LogEvent } from "./eventlog.js";
import { foldDecisions } from "./shared-decisions.js";
import { foldStandard, LAW_SCOPE } from "./shared-standard.js";
import { isLogDamage, type DamagedEntry } from "./log-damage.js";
import { clearLockout, locate, lockoutOf, recordLockout, type Lockout } from "./lockout.js";

/** Every damaged entry's first sighting, or null when the sidecar reads clean. */
export async function findDamage(logRoot: string): Promise<DamagedEntry | null> {
  const scopes = await scopesOnDisk(logRoot);
  for (const scope of scopes) {
    const read = await readScopeChecked(logRoot, scope);
    if (read.diagnostic?.reason === "corrupt-shard") {
      const [shard, line] = read.diagnostic.evidence[0]!.split(/:(?=\d+$)/);
      return { id: "(unreadable bytes)", kind: "(unreadable bytes)", scope, shard, line: Number(line),
        why: "the line is not JSON, so no build can read the event it held" };
    }
  }
  const folded = async (list: string[], fold: (events: LogEvent[]) => unknown): Promise<DamagedEntry | null> => {
    const events = sortEvents((await Promise.all(list.map((s) => readScope(logRoot, s)))).flat());
    try { fold(events); return null; } catch (e) {
      if (!isLogDamage(e)) throw e;
      return locate(logRoot, list, e.entry);
    }
  };
  for (const scope of scopes.filter((s) => s.startsWith("decisions/"))) {
    const d = await folded([scope], foldDecisions);
    if (d) return d;
  }
  const evidence = scopes.filter((s) => s.startsWith("standard/"));
  const law = scopes.includes(LAW_SCOPE) ? [LAW_SCOPE] : [];
  for (const group of evidence.length ? evidence.map((s) => [...law, s]) : [law]) {
    if (!group.length) continue;
    const d = await folded(group, foldStandard);
    if (d) return d;
  }
  return null;
}

/** Scan, and lock this sidecar if anything is damaged. */
export async function scanForDamage(logRoot: string): Promise<Lockout | null> {
  const held = lockoutOf(logRoot);
  if (held) return held;
  const d = await findDamage(logRoot);
  return d ? recordLockout(logRoot, d) : null;
}

/**
 * Clear a lock once nothing damaged is visible here, and — `inbound` — nothing on the fetched
 * tip either (the transport's check). The only way a lock clears.
 */
export async function recheckLockout(logRoot: string, inbound: DamagedEntry | null): Promise<Lockout | null> {
  if (!lockoutOf(logRoot)) return null;
  const still = (await findDamage(logRoot)) ?? inbound;
  clearLockout(logRoot);
  // Re-recorded rather than kept: after a partial repair the flag names what is still there.
  return still ? recordLockout(logRoot, still) : null;
}

const scanned = new Set<string>();

/** Once per process per sidecar: the scan a store gets when it is opened. */
export async function scanOnOpen(logRoot: string): Promise<void> {
  if (scanned.has(logRoot)) return;
  await scanForDamage(logRoot);
  scanned.add(logRoot);
}
