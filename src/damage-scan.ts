/**
 * Look at everything this machine can see for damage, and lock on the first (plan 1.2).
 *
 * Run once per process per sidecar before its first read or op, and after every pull: the
 * folds are lazy, so without this a findings read would never see damage sitting in
 * `decisions/`. Bytes that are not JSON count in EVERY scope, and so does classification
 * (newer); the fold's own refusals count in the scopes that have a fold.
 */
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  EVENT_SCHEMA, kindsFor, prefixReader, readScopeChecked, referencesFor, scopesOnDisk, SHARD_EXT, SIDECAR_PROTOCOL, sortEvents,
  type LogEvent, type ScopeReader, type Vocabulary,
} from "./eventlog.js";
import { classify, foldJudged, registerPushGate, reportFor, withPeersAhead, type Report } from "./validation.js";
import { withoutOverlay } from "./sync-session.js";
import { foldDecisionsReport } from "./shared-decisions.js";
import { foldStandardReport, LAW_SCOPE } from "./shared-standard.js";
import { peersAhead } from "./sidecar.js";
import { isLogDamage, type DamagedEntry } from "./log-damage.js";
import { clearLockout, locate, lockoutOf, recordLockout, type Lockout } from "./lockout.js";

/** An event this build cannot read as written: pushes block until an upgrade re-folds it. */
export interface NewerEntry { id: string; kind: string; scope: string; why: string }

/**
 * Valid against the log before it, refused over the whole log: a later valid event changed a
 * fold's verdict on it — a defect in this build's fold, not in the data (owner, round 2 C8:
 * "Visible, no lock"). Shown; never a lock, never a push block.
 */
export type FoldDefect = NewerEntry;

export interface SidecarScan { damage: DamagedEntry | null; newer: NewerEntry[]; defects: FoldDefect[] }

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
  const defects: FoldDefect[] = [];
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
  const judged = await judgeReads(reads, ahead);
  newer.push(...judged.newer);
  defects.push(...judged.defects);
  const first = judged.damage[0];
  damage ??= first ? (first.shard ? first : locate(logRoot, [first.scope ?? ""], first)) : null;
  const scan = { damage, newer: dedupe(newer), defects: dedupe(defects) };
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

/** What the front ends show while this build's folds leave a valid event out (C8), or null. */
export async function foldDefectNotice(logRoot: string): Promise<string | null> {
  const { defects } = await scanSidecar(logRoot);
  if (!defects.length) return null;
  return defects.map((d) => `a codemap fold defect left out event ${d.id} (${d.kind}, ${d.scope}): ${d.why} — your data is `
    + `intact; upgrade codemap when a fix ships`).join("\n");
}

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

/** What a scope reads as, for `judgeReads`: its events and any line that parsed but failed the envelope. */
export interface ScopeRead { events: LogEvent[]; malformed: { shard: string; line: number; parsed?: unknown }[] }

/**
 * The read's judgment over a set of scopes: classification, every family's fold judged against
 * each event's prefix, and cross-scope references against the log before each event (O30).
 * `scanSidecar` runs it over what is on disk; the migration runs it over the log it is about to
 * write (round 2 C6), so a migrated log reads exactly as it was judged. Damage entries carry
 * their scope, and their shard and line only where the read knows them. `every`: keep judging
 * after the first damage, for a caller that drops what is damaged and judges again.
 */
export async function judgeReads(reads: Map<string, ScopeRead>, ahead: boolean, every = false): Promise<{ damage: DamagedEntry[]; newer: NewerEntry[]; defects: FoldDefect[] }> {
  const scopes = [...reads.keys()];
  const newer: NewerEntry[] = [], defects: FoldDefect[] = [], damage: DamagedEntry[] = [];
  const hit = (d: DamagedEntry) => { if (every || !damage.length) damage.push(d); };
  // A line that parses but fails the envelope check: a newer protocol or schema wrote it, or an
  // existing validator is failing — damage, unless a teammate's build is ahead (owner, C17).
  for (const [scope, read] of reads) {
    for (const m of read.malformed) {
      const p = (m.parsed ?? {}) as Partial<LogEvent>;
      const id = typeof p.id === "string" ? p.id : "(malformed)", kind = typeof p.kind === "string" ? p.kind : "(malformed)";
      if ((Number(p.sidecarProtocol) || 0) > SIDECAR_PROTOCOL || (Number(p.eventSchema) || 0) > EVENT_SCHEMA || ahead) {
        newer.push({ id, kind, scope, why: `its envelope is not one this build reads (${m.shard}:${m.line})` });
      } else hit({ id, kind, scope, shard: m.shard, line: m.line, why: "its envelope is missing a field every event carries" });
    }
  }
  // Every family's fold, classified first: one judge for newer and for damage.
  const judged = (group: string[], report: Report<unknown>, kinds: Vocabulary | undefined) => {
    const events = sortEvents(group.flatMap((s) => reads.get(s)!.events));
    const scopeOf = new Map<string, string>();
    for (const s of group) for (const e of reads.get(s)!.events) scopeOf.set(e.id, s);
    try {
      const out = withPeersAhead(ahead, () => foldJudged(events, report, kinds));
      for (const r of out.newer) newer.push({ id: r.id, kind: r.kind, scope: scopeOf.get(r.id) ?? group[0]!, why: r.why });
      for (const r of out.defects) defects.push({ id: r.id, kind: r.kind, scope: scopeOf.get(r.id) ?? group[0]!, why: r.why });
    } catch (e) {
      if (!isLogDamage(e)) throw e;
      hit({ ...e.entry, scope: scopeOf.get(e.entry.id) ?? group[group.length - 1]! });
    }
  };
  // A scope with no fold is still classified (round 2, C10): one no family of this build
  // registers holds only kinds it does not know — newer (owner, C17) — and `materializer/` has a
  // vocabulary and no fold.
  const unfolded = (scope: string) => {
    const vocab = kindsFor(scope), events = reads.get(scope)!.events;
    const found = vocab ? classify(events, vocab).newer
      : events.map((e) => ({ id: e.id, kind: e.kind, why: `no family of this build reads ${scope}` }));
    for (const r of found) newer.push({ id: r.id, kind: r.kind, scope, why: r.why });
  };
  for (const scope of scopes) {
    if (scope.startsWith("decisions/")) judged([scope], foldDecisionsReport, kindsFor(scope));
    else if (scope.startsWith("standard/") || scope === LAW_SCOPE) continue;
    else { const report = reportFor(scope); if (report) judged([scope], report, kindsFor(scope)); else unfolded(scope); }
  }
  const evidence = scopes.filter((s) => s.startsWith("standard/"));
  const law = scopes.includes(LAW_SCOPE) ? [LAW_SCOPE] : [];
  for (const group of evidence.length ? evidence.map((s) => [...law, s]) : [law]) {
    if (group.length) judged(group, foldStandardReport, kindsFor(group[group.length - 1]!));
  }
  // What each event names in other scopes, against the log before it (owner, O30): a reference
  // that did not resolve there is a failed foreign key — damage — and nothing later re-judges it.
  if (!damage.length || every) {
    const all: ScopeReader = { read: async (s) => reads.get(s)?.events ?? [], scopes: async () => scopes };
    const held = new Set([...newer.map((n) => n.id), ...damage.map((d) => d.id)]);
    outer: for (const scope of scopes) {
      const check = referencesFor(scope);
      if (!check) continue;
      const own = reads.get(scope)!.events;
      for (const [i, e] of own.entries()) {
        if (typeof e.seq !== "number" || held.has(e.id) || !kindsFor(scope)?.kinds.has(e.kind)) continue;
        const [bad] = await check(scope, e, own.slice(0, i), prefixReader(all, e.seq));
        if (!bad) continue;
        if (ahead) { newer.push({ id: e.id, kind: e.kind, scope, why: `${bad.why} — a teammate's codemap folds a newer version` }); continue; }
        hit({ id: e.id, kind: e.kind, scope, why: bad.why });
        if (!every) break outer;
      }
    }
  }
  return { damage, newer, defects };
}
