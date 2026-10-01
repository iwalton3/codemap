/**
 * What a fold's refusal MEANS, by where the event came from (plan 3.1, 3.2; owner, batch 1:
 * "Anything that parses and isn't expected, existing expected FK checks failing means damage,
 * corrupt data is damage").
 *
 * At replay every refusal refuses: a conforming build mints nothing its own fold would refuse.
 * On read, `classify` first holds out what a newer build wrote (an unknown kind, envelope field,
 * protocol or schema). Then a refused event already on the remote is one of three things:
 *
 * - **newer** — it parses but is not a shape this build expects (`shape`, `newer`), or it
 *   depends on a newer event. Pushes block until an upgrade re-folds it; reads carry on.
 * - **damage** — a LINEAR event (it has a `seq`: validated at replay by whoever pushed it)
 *   that fails its own precondition or a reference check (`state`, `reference`). The
 *   application locks.
 * - **skipped** — an event from before the linear log (no `seq`), or a known dev-era shape
 *   (`older`; owner, Q7: "fold or skip"). Merge-era events were never validated against an
 *   order, so refusing one is what the merge-era folds always did: drop it. Phase 7's
 *   migration decides what they become.
 *
 * There is no "race" outcome: every event on the remote was validated against the exact log
 * before it, so a linear refusal on read is never two people writing at once.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { isLogDamage, LogDamage, type DamagedEntry } from "./log-damage.js";
import { ENVELOPE_FIELDS, EVENT_SCHEMA, readSets, SIDECAR_PROTOCOL, SKIPPED_KINDS, type LogEvent, type Vocabulary } from "./eventlog.js";

export type RefusalClass = "shape" | "older" | "newer" | "state" | "reference";

export interface Refusal { id: string; kind: string; why: string; cls: RefusalClass }

export type Report<T> = (events: LogEvent[]) => { value: T; refused: Refusal[] };

/** A refusal collector for a fold: `refuse(e, "state", "why")` then `break`. */
export function collector(): { refused: Refusal[]; refuse: (e: LogEvent, cls: RefusalClass, why: string) => void } {
  const refused: Refusal[] = [];
  return { refused, refuse: (e, cls, why) => { refused.push({ id: e.id, kind: e.kind, why, cls }); } };
}

/**
 * The classification step before any fold (owner, C17): what this build must not fold because
 * a newer build wrote it — a protocol or schema above this build's, an envelope field it does
 * not read, or a kind outside the family's vocabulary. Those are NEWER: excluded from the fold,
 * reads carry on, pushes block. A known skip (`SKIPPED_KINDS`) is excluded silently. An event
 * from before the linear log (no `seq`) is passed through as the merge-era folds always took it.
 */
export function classify(events: LogEvent[], vocab: Vocabulary | undefined): { fold: LogEvent[]; newer: Refusal[]; skipped: LogEvent[] } {
  const fold: LogEvent[] = [], skipped: LogEvent[] = [];
  const newer: Refusal[] = [];
  for (const e of events) {
    const why = newerWhy(e, vocab);
    if (why === null) fold.push(e);
    else if (why) newer.push({ id: e.id, kind: e.kind, why, cls: "newer" });
    else skipped.push(e);
  }
  return { fold, newer, skipped };
}

/** Why `e` is newer than this build; `""` for a known skip; null to fold it. */
function newerWhy(e: LogEvent, vocab: Vocabulary | undefined): string | null {
  if ((e.sidecarProtocol ?? SIDECAR_PROTOCOL) > SIDECAR_PROTOCOL || (e.eventSchema ?? EVENT_SCHEMA) > EVENT_SCHEMA)
    return `written by a newer codemap (protocol ${e.sidecarProtocol}, schema ${e.eventSchema})`;
  if (SKIPPED_KINDS.includes(e.kind) || vocab?.skip?.(e)) return "";
  if (typeof e.seq !== "number") return null;
  const extra = Object.keys(e).find((k) => !ENVELOPE_FIELDS.has(k));
  if (extra) return `its envelope carries "${extra}", which this build does not read`;
  if (vocab && !vocab.kinds.has(e.kind)) return `${e.kind} is not a kind this build knows`;
  return null;
}

/**
 * Whether a teammate's manifest records a materializer version above this build's (owner,
 * C17): a validator failure is then NEWER — the newer build may accept what this one refuses —
 * until this build reaches that version, when it is damage. Set by the readers that know the
 * sidecar (`materialize.ts`, `damage-scan.ts`); a fold alone does not.
 */
const ahead = new AsyncLocalStorage<boolean>();
export const withPeersAhead = <T>(flag: boolean, fn: () => T): T => ahead.run(flag, fn);

/**
 * The read-side verdict on what the fold refused: throws on damage, returns what is newer than
 * this build. `excluded` is what `classify` kept out of the fold. A refusal that depends on an
 * excluded or skipped event — names it, or read it (`after`) — takes that event's class:
 * newer, or skipped with it (owner, batch 2).
 */
export function judge(events: LogEvent[], refused: Refusal[], excluded: LogEvent[] = [], skipped: LogEvent[] = []): Refusal[] {
  if (!refused.length) return [];
  const all = [...events, ...excluded, ...skipped];
  const byId = new Map(all.map((e) => [e.id, e]));
  const reads = readSets(all);
  const skippedNewer = [...excluded], skippedOlder = [...skipped];
  const on = (e: LogEvent, set: LogEvent[]) => namesAny(e, set, all) || set.some((s) => reads.saw(e.id, s.id));
  const newer: Refusal[] = [];
  for (const r of refused) {
    const e = byId.get(r.id);
    if (!e) continue;
    if (typeof e.seq !== "number" || r.cls === "older") { skippedOlder.push(e); continue; }
    if (r.cls === "shape" || r.cls === "newer") { newer.push(r); skippedNewer.push(e); continue; }
    if (on(e, skippedNewer)) { newer.push({ ...r, cls: "newer" }); skippedNewer.push(e); continue; }
    if (on(e, skippedOlder)) { skippedOlder.push(e); continue; }
    if (ahead.getStore()) {
      newer.push({ ...r, cls: "newer", why: `${r.why} — a teammate's codemap folds a newer version, which may accept it` });
      continue;
    }
    throw new LogDamage({ id: r.id, kind: r.kind, why: r.why });
  }
  return newer;
}

/**
 * Whether `e` names one of `skipped` anywhere in its payload: by event id, an `id` the skipped
 * event carries in its own payload (a request names itself `request.id`), or a subject the
 * skipped event CREATED — the first event of that subject in `all`. A skipped event that merely
 * shares a subject (another answer to one decision) excuses nothing.
 */
export function namesAny(e: LogEvent | undefined, skipped: LogEvent[], all: LogEvent[]): boolean {
  if (!e || !skipped.length) return false;
  const text = JSON.stringify({ subject: e.subject, data: e.data });
  const created = (s: LogEvent): boolean => all.find((x) => x.subject === s.subject)?.id === s.id;
  const ids = (s: LogEvent): string[] => [s.id, ...(s.subject !== e.subject || created(s) ? [s.subject] : []),
    ...Object.values(s.data ?? {}).map((v) => (v as { id?: unknown } | null)?.id).filter((v): v is string => typeof v === "string")];
  return skipped.some((s) => ids(s).some((id) => id === s.id ? text.includes(id) : text.includes(`"${id}"`)));
}

/**
 * A report for a family whose shapes are checked AHEAD of its fold (decisions, the standard:
 * `log-shape.ts`): a wrong-shaped event is refused as `shape` and never reaches the fold, and
 * a throw nothing anticipated is damage naming its entry (`culprit`).
 */
export function shaped<T>(report: Report<T>, shape: (e: LogEvent) => string | null, devEra: (e: LogEvent) => boolean = () => false): Report<T> {
  return (events) => {
    const wrong: Refusal[] = [];
    const kept = events.filter((e) => {
      const why = shape(e);
      if (why) wrong.push({ id: e.id, kind: e.kind, why, cls: devEra(e) ? "older" : "shape" });
      return !why;
    });
    let out: ReturnType<Report<T>>;
    try { out = report(kept); } catch (err) {
      if (isLogDamage(err)) throw err;
      throw new LogDamage(culprit(kept, report, err));
    }
    return { value: out.value, refused: [...wrong, ...out.refused] };
  };
}

/**
 * Name the entry behind a throw no shape check anticipated: the LATEST event whose absence
 * lets the fold complete — removing the round a bad answer sits on completes too, and an event
 * depends on earlier ones, not later. Named, never left out: leaving one out is how a good
 * answer was dropped.
 */
function culprit(events: LogEvent[], report: (events: LogEvent[]) => unknown, err: unknown): DamagedEntry {
  const message = err instanceof Error ? err.message : String(err);
  for (let i = events.length - 1; i >= 0; i--) {
    try { report([...events.slice(0, i), ...events.slice(i + 1)]); } catch { continue; }
    return { id: events[i]!.id, kind: events[i]!.kind, why: `the fold cannot read it: ${message}` };
  }
  return { id: "(unknown)", kind: "(unknown)", why: `the fold cannot read this log, and no single entry explains it: ${message}` };
}

/** Fold for a READ: classified first, then the value, having judged the refusals. */
export function foldJudged<T>(events: LogEvent[], report: Report<T>, vocab: Vocabulary | undefined): { value: T; newer: Refusal[] } {
  const { fold, newer, skipped } = classify(events, vocab);
  const out = report(fold);
  const ids = new Set(newer.map((n) => n.id));
  const excluded = events.filter((e) => ids.has(e.id));
  return { value: out.value, newer: [...newer, ...judge(fold, out.refused, excluded, skipped)] };
}

/**
 * Each scope family's fold report, so the damage scan and the newer check can walk every scope
 * without importing every fold. Registered by the families themselves, like the doors.
 */
const reports: { match: (scope: string) => boolean; report: Report<unknown> }[] = [];
export function registerReport(match: (scope: string) => boolean, report: Report<unknown>): void {
  reports.push({ match, report });
}
export const reportFor = (scope: string): Report<unknown> | undefined => reports.find((r) => r.match(scope))?.report;

/**
 * What stops a push: the sidecar holds data newer than this build (owner: "in the mean time
 * all pushes get blocked. Reads would still be allowed"). Registered by the damage scan, which
 * reads every fold and so cannot be imported by the transport.
 */
let gate: ((logRoot: string) => Promise<string | null>) | null = null;
export function registerPushGate(g: (logRoot: string) => Promise<string | null>): void { gate = g; }
export const pushGate = (logRoot: string): Promise<string | null> => gate ? gate(logRoot) : Promise.resolve(null);

/**
 * A revision's compare-and-swap. `was` is each field it changes as its author read it (`null`:
 * unset). Answers why it is refused when a field has since moved to something other than what
 * it asks for; landing on the value it already asks for is not a conflict (owner, Q5).
 *
 * Only LINEAR events are checked: a merge-era revision (no `seq`) folds as it always did, and
 * a field `was` does not name is unchecked — bugs wrote `was: {}` and notes none.
 */
/** `was` for a revision of `entity`: each field `now` changes, as it reads now (`null`: unset). */
export function wasOf(entity: object | undefined, now: Record<string, unknown>): Record<string, unknown> {
  const cur = (entity ?? {}) as Record<string, unknown>;
  return Object.fromEntries(Object.keys(now).map((k) => [k, cur[k] ?? null]));
}

export function staleRevision(e: LogEvent, current: Record<string, unknown>): string | null {
  if (typeof e.seq !== "number") return null;
  const d = e.data as { was?: unknown; now?: unknown } | undefined;
  const was = d?.was && typeof d.was === "object" ? d.was as Record<string, unknown> : {};
  const now = d?.now && typeof d.now === "object" ? d.now as Record<string, unknown> : {};
  const moved = Object.keys(now).filter((k) => k in was
    && (current[k] ?? null) !== (was[k] ?? null) && (current[k] ?? null) !== (now[k] ?? null));
  return moved.length ? `${moved.join(", ")} changed since you read it` : null;
}
