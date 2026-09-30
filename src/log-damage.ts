/**
 * DAMAGE in a folded log, and the one rule that tells it apart from a race (plan 1.2, 1.3).
 *
 * The log is a durable event store and is intended to be immutable (owner, 2026-09-28): an
 * entry "from a bug or a broken build, not from a race between two people" halts, names the
 * entry, and waits for a person-approved repair (docs/log-repair.md). What two conforming
 * builds racing can produce is not damage; it is conflict handling.
 *
 * The rule, mechanically: an event the fold refuses is damage when the fold ALSO refuses it
 * over what its writer had in front of it — its causal ancestors, and every scope it never
 * linked to. That is exactly the check the write door made before appending, so a conforming
 * build cannot have written it. Refused only because of events its writer could not see, it
 * is a race.
 */
import { causalContext, type LogEvent } from "./eventlog.js";

export interface DamagedEntry {
  id: string;
  kind: string;
  why: string;
  /** Where it sits, once a reader that knows the scope has filled it in. */
  scope?: string;
  shard?: string;
  line?: number;
}

export class LogDamage extends Error {
  readonly entry: DamagedEntry;
  constructor(entry: DamagedEntry) {
    super(`damaged log entry ${entry.id} (${entry.kind}${entry.scope ? ` in ${entry.scope}` : ""}): ${entry.why}`);
    this.name = "LogDamage";
    this.entry = entry;
  }
}

export const isLogDamage = (e: unknown): e is LogDamage => e instanceof LogDamage;

interface Refusal { id: string; kind: string; why: string }

/**
 * Fold `events`, halting on damage: a wrong shape at entry, a throw nothing anticipated, or a
 * refusal its writer's own door would have made. Returns the value and the refusals that are
 * NOT damage — races, for conflict handling.
 */
export function foldHaltingOnDamage<T, R extends Refusal>(
  events: LogEvent[],
  report: (events: LogEvent[]) => { value: T; refused: R[] },
  shape: (e: LogEvent) => string | null,
): { value: T; refused: R[] } {
  // One event, however often it arrives: `merge=union` stitches a line in twice, and the
  // reader already drops the copy. A folder handed both must not read it as two acts.
  const seen = new Set<string>();
  events = events.filter((e) => !seen.has(e.id) && !!seen.add(e.id));
  // A wrong shape is newer than this build (or a dev-era one, owner Q7) and is skipped, never
  // halted on (owner, batch 1). The door refuses it at replay; `newerIn` blocks pushes on it.
  const original = events;
  const skipped = events.filter((e) => !!shape(e));
  events = events.filter((e) => !shape(e));
  let out: { value: T; refused: R[] };
  try { out = report(events); } catch (err) {
    if (isLogDamage(err)) throw err;
    throw new LogDamage(culprit(events, report, err));
  }
  for (const r of out.refused) {
    // Refused for naming an event this build skipped as newer: newer too, not damage (owner,
    // batch 2: "a reference that resolves to a kept event this build can't fold" is newer).
    if (namesAny(events.find((e) => e.id === r.id), skipped, original)) continue;
    let again: R | undefined;
    try { again = report(causalContext(events, r.id)).refused.find((x) => x.id === r.id); }
    catch (err) { throw new LogDamage(culprit(events, report, err)); }
    if (again) throw new LogDamage({ id: r.id, kind: r.kind, why: again.why });
  }
  return out;
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
 * Name the entry behind a throw no shape check anticipated: the LATEST event whose absence
 * lets the fold complete — removing the round a bad answer sits on completes too, and an event
 * depends on earlier ones, not later. Named, never left out: leaving one out is how a good
 * answer was dropped.
 */
function culprit<T>(events: LogEvent[], report: (events: LogEvent[]) => T, err: unknown): DamagedEntry {
  const message = err instanceof Error ? err.message : String(err);
  for (let i = events.length - 1; i >= 0; i--) {
    try { report([...events.slice(0, i), ...events.slice(i + 1)]); } catch { continue; }
    return { id: events[i]!.id, kind: events[i]!.kind, why: `the fold cannot read it: ${message}` };
  }
  return { id: "(unknown)", kind: "(unknown)", why: `the fold cannot read this log, and no single entry explains it: ${message}` };
}
