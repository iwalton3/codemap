/**
 * What a fold's refusal MEANS, by where the event came from (plan 3.1, 3.2; owner, batch 1:
 * "Anything that parses and isn't expected, existing expected FK checks failing means damage,
 * corrupt data is damage").
 *
 * At replay every refusal refuses: a conforming build mints nothing its own fold would refuse.
 * On read, a refused event already on the remote is one of three things:
 *
 * - **newer** — it parses but is not a shape this build expects (`shape`, `newer`). Pushes
 *   block until an upgrade re-folds it; reads carry on without it.
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
import { isLogDamage, LogDamage, type DamagedEntry } from "./log-damage.js";
import type { LogEvent } from "./eventlog.js";

export type RefusalClass = "shape" | "older" | "newer" | "state" | "reference";

export interface Refusal { id: string; kind: string; why: string; cls: RefusalClass }

export type Report<T> = (events: LogEvent[]) => { value: T; refused: Refusal[] };

/** A refusal collector for a fold: `refuse(e, "state", "why")` then `break`. */
export function collector(): { refused: Refusal[]; refuse: (e: LogEvent, cls: RefusalClass, why: string) => void } {
  const refused: Refusal[] = [];
  return { refused, refuse: (e, cls, why) => { refused.push({ id: e.id, kind: e.kind, why, cls }); } };
}

/** The read-side verdict: throws on damage, returns what is newer than this build. */
export function judge(events: LogEvent[], refused: Refusal[]): Refusal[] {
  if (!refused.length) return [];
  const byId = new Map(events.map((e) => [e.id, e]));
  const skipped = refused.filter((r) => r.cls === "shape" || r.cls === "newer" || r.cls === "older")
    .map((r) => byId.get(r.id)).filter((e): e is LogEvent => !!e);
  const newer: Refusal[] = [];
  for (const r of refused) {
    const e = byId.get(r.id);
    if (!e || typeof e.seq !== "number" || r.cls === "older") continue;
    if (r.cls === "shape" || r.cls === "newer") { newer.push(r); continue; }
    // Refused for naming an event this build skipped: newer too (owner, batch 2).
    if (namesAny(e, skipped, events)) { newer.push({ ...r, cls: "newer" }); continue; }
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
export function shaped<T>(report: Report<T>, shape: (e: LogEvent) => string | null): Report<T> {
  return (events) => {
    const wrong: Refusal[] = [];
    const kept = events.filter((e) => {
      const why = shape(e);
      if (why) wrong.push({ id: e.id, kind: e.kind, why, cls: "shape" });
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

/** Fold for a READ: the value, having judged the refusals. */
export function foldJudged<T>(events: LogEvent[], report: Report<T>): { value: T; newer: Refusal[] } {
  const out = report(events);
  return { value: out.value, newer: judge(events, out.refused) };
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
