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
 */
import { LogDamage, namesAny } from "./log-damage.js";
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
