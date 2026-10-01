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
import { EVENT_SCHEMA, kindsFor, readScopeChecked, scopesOnDisk, SHARD_EXT, SIDECAR_PROTOCOL, sortEvents, type LogEvent, type Vocabulary } from "./eventlog.js";
import { foldJudged, registerPushGate, reportFor, withPeersAhead, type Report } from "./validation.js";
import { withoutOverlay } from "./sync-session.js";
import { foldDecisionsReport } from "./shared-decisions.js";
import { foldStandardReport, LAW_SCOPE } from "./shared-standard.js";
import { peersAhead } from "./sidecar.js";
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
  const ahead = await peersAhead(logRoot);
  const newer: NewerEntry[] = [];
  let damage: DamagedEntry | null = null;
  const reads = new Map<string, Awaited<ReturnType<typeof readScopeChecked>>>();
  for (const scope of scopes) reads.set(scope, await readScopeChecked(logRoot, scope));
  // Bytes first: a line that is not JSON is damage in every scope, whatever folds it.
  for (const [scope, read] of reads) {
    if (read.diagnostic?.reason !== "corrupt-shard") continue;
    const [shard, line] = read.diagnostic.evidence[0]!.split(/:(?=\d+$)/);
    damage = { id: "(unreadable bytes)", kind: "(unreadable bytes)", scope, shard, line: Number(line),
      why: "the line is not JSON, so no build can read the event it held" };
    break;
  }
  // A line that parses but fails the envelope check: a newer protocol or schema wrote it, or an
  // existing validator is failing — damage, unless a teammate's build is ahead (owner, C17).
  for (const [scope, read] of reads) {
    for (const m of read.malformed) {
      const p = (m.parsed ?? {}) as Partial<LogEvent>;
      const id = typeof p.id === "string" ? p.id : "(malformed)", kind = typeof p.kind === "string" ? p.kind : "(malformed)";
      if ((Number(p.sidecarProtocol) || 0) > SIDECAR_PROTOCOL || (Number(p.eventSchema) || 0) > EVENT_SCHEMA || ahead) {
        newer.push({ id, kind, scope, why: `its envelope is not one this build reads (${m.shard}:${m.line})` });
      } else damage ??= { id, kind, scope, shard: m.shard, line: m.line, why: "its envelope is missing a field every event carries" };
    }
  }
  // Every family's fold, classified first: one judge for newer and for damage.
  const judged = (group: string[], report: Report<unknown>, kinds: Vocabulary | undefined) => {
    const events = sortEvents(group.flatMap((s) => reads.get(s)!.events));
    const scopeOf = new Map<string, string>();
    for (const s of group) for (const e of reads.get(s)!.events) scopeOf.set(e.id, s);
    try {
      for (const r of withPeersAhead(ahead, () => foldJudged(events, report, kinds)).newer)
        newer.push({ id: r.id, kind: r.kind, scope: scopeOf.get(r.id) ?? group[0]!, why: r.why });
    } catch (e) {
      if (!isLogDamage(e)) throw e;
      damage ??= locate(logRoot, group, e.entry);
    }
  };
  for (const scope of scopes) {
    if (scope.startsWith("decisions/")) judged([scope], foldDecisionsReport, kindsFor(scope));
    else if (scope.startsWith("standard/") || scope === LAW_SCOPE) continue;
    else { const report = reportFor(scope); if (report) judged([scope], report, kindsFor(scope)); }
  }
  const evidence = scopes.filter((s) => s.startsWith("standard/"));
  const law = scopes.includes(LAW_SCOPE) ? [LAW_SCOPE] : [];
  for (const group of evidence.length ? evidence.map((s) => [...law, s]) : [law]) {
    if (group.length) judged(group, foldStandardReport, kindsFor(group[group.length - 1]!));
  }
  const scan = { damage, newer: dedupe(newer) };
  scans.set(logRoot, { key, scan });
  return scan;
}

/** The law scope is folded once per evidence scope; report each newer law event once. */
const dedupe = (list: NewerEntry[]): NewerEntry[] => [...new Map(list.map((n) => [n.id, n])).values()];

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
