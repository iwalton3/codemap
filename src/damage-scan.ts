/**
 * Look at everything this machine can see for damage, and lock on the first (plan 1.2).
 *
 * Run once per process per sidecar before its first read or op, and after every pull: the
 * folds are lazy, so without this a findings read would never see damage sitting in
 * `decisions/`. Bytes that are not JSON count in EVERY scope; the shapes and the fold's own
 * refusals count in the scopes that have them (decisions and the standard).
 */
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { EVENT_SCHEMA, readScope, readScopeChecked, scopesOnDisk, SHARD_EXT, SIDECAR_PROTOCOL, sortEvents, type LogEvent } from "./eventlog.js";
import { shapeCheckFor } from "./log-shape.js";
import { foldJudged, registerPushGate, reportFor } from "./validation.js";
import { withoutOverlay } from "./sync-session.js";
import { foldDecisions } from "./shared-decisions.js";
import { foldStandard, LAW_SCOPE } from "./shared-standard.js";
import { isLogDamage, type DamagedEntry } from "./log-damage.js";
import { clearLockout, locate, lockoutOf, recordLockout, type Lockout } from "./lockout.js";

/** An event this build cannot read as written: pushes block until an upgrade re-folds it. */
export interface NewerEntry { id: string; kind: string; scope: string; why: string }

export interface SidecarScan { damage: DamagedEntry | null; newer: NewerEntry[] }

const scans = new Map<string, { key: string; scan: SidecarScan }>();

/** Every shard's name, size and mtime: what a scan's result is keyed on. */
async function sidecarKey(logRoot: string, scopes: string[]): Promise<string> {
  const h = createHash("sha256");
  for (const scope of scopes) {
    let names: string[] = [];
    try { names = (await readdir(join(logRoot, scope))).filter((n) => n.endsWith(SHARD_EXT)).sort(); } catch { continue; }
    for (const n of names) {
      const st = await stat(join(logRoot, scope, n), { bigint: true }).catch(() => null);
      if (st) h.update(`${scope}/${n}\0${st.size}\0${st.mtimeNs}\0`);
    }
  }
  return h.digest("hex");
}

/**
 * The whole sidecar judged at once: the first damaged entry, and everything newer than this
 * build (plan 3.2). Cached on the shards' sizes and mtimes, so a sync with nothing new is
 * a `stat` per shard.
 */
export async function scanSidecar(logRoot: string): Promise<SidecarScan> {
  return withoutOverlay(() => scanTip(logRoot));
}

async function scanTip(logRoot: string): Promise<SidecarScan> {
  const scopes = await scopesOnDisk(logRoot);
  const key = await sidecarKey(logRoot, scopes);
  const hit = scans.get(logRoot);
  if (hit?.key === key) return hit.scan;
  const newer: NewerEntry[] = [];
  let damage: DamagedEntry | null = null;
  for (const scope of scopes) {
    const events = await readScope(logRoot, scope);
    for (const e of events) {
      if ((e.sidecarProtocol ?? SIDECAR_PROTOCOL) > SIDECAR_PROTOCOL || (e.eventSchema ?? EVENT_SCHEMA) > EVENT_SCHEMA)
        newer.push({ id: e.id, kind: e.kind, scope, why: `written by a newer codemap (protocol ${e.sidecarProtocol}, schema ${e.eventSchema})` });
    }
    const shape = shapeCheckFor(scope);
    if (shape) for (const e of events) {
      const why = typeof e.seq === "number" ? shape(e) : null;
      if (why) newer.push({ id: e.id, kind: e.kind, scope, why });
    }
    const report = reportFor(scope);
    if (report && !damage) {
      try {
        for (const r of foldJudged(events, report).newer) newer.push({ id: r.id, kind: r.kind, scope, why: r.why });
      } catch (e) {
        if (!isLogDamage(e)) throw e;
        damage = locate(logRoot, [scope], e.entry);
      }
    }
  }
  damage ??= await foldedDamage(logRoot, scopes);
  const scan = { damage, newer };
  scans.set(logRoot, { key, scan });
  return scan;
}

/** The first thing this sidecar holds that is newer than this build, as a refusal to push. */
export async function newerIn(logRoot: string): Promise<string | null> {
  const { newer } = await scanSidecar(logRoot);
  if (!newer.length) return null;
  const first = newer[0]!;
  return `the sidecar holds ${newer.length} event(s) this build cannot read as written — newer than it (first: ${first.kind} `
    + `${first.id} in ${first.scope}: ${first.why}). Pushes are blocked until codemap is upgraded; reads carry on without them.`;
}
registerPushGate(newerIn);

/** Every damaged entry's first sighting, or null when the sidecar reads clean. */
export async function findDamage(logRoot: string): Promise<DamagedEntry | null> {
  return (await scanSidecar(logRoot)).damage;
}

async function foldedDamage(logRoot: string, scopes: string[]): Promise<DamagedEntry | null> {
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
