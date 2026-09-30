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
import { LogDamage } from "./log-damage.js";
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
  const newer: Refusal[] = [];
  for (const r of refused) {
    const e = byId.get(r.id);
    if (!e || typeof e.seq !== "number" || r.cls === "older") continue;
    if (r.cls === "shape" || r.cls === "newer") { newer.push(r); continue; }
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
