/**
 * The scrub — going and checking on a schedule, rather than waiting for something to move
 * (COD-29). `docs/requirements-architecture.md` is normative; this implements it.
 *
 * **Differential audit covers what moved; the scrub covers what did not**, and neither is
 * optional. Differential audit is cheap precisely *because* change drives it, so a rule
 * whose pointers never move is never audited — which promotes *never fires → false calm*
 * from an accident to a structural property. Without a scrub the system is systematically
 * blind exactly where nothing has changed for a long time, which is also where a quietly
 * wrong rule has had the most time to matter. That is a stronger argument for it than
 * vacuity-hygiene.
 *
 * Vacuity is silent corruption: you do not find it by using the thing, because a vacuous
 * pointer looks fine every single time you look at it. You find it the way an array finds a
 * bad block — by going and checking, on a schedule, across the whole population.
 *
 * ## Three pathologies, and each has a different detector
 *
 *  - **Never fires** → false calm. It looks like coverage and is not. A RATE, derived here
 *    from the observation history.
 *  - **Always fires** → cry-wolf. A pointer that goes off on every commit gets ignored, and
 *    then so does the requirement behind it. Also a rate, from the same history.
 *  - **Fired → was edited → now quiet** — the detector modified by the change it was meant
 *    to detect. Neither rate catches it; the hash pin does, and `brokenPins` already
 *    reports it. The scrub's job for that one is to put it on a SCHEDULE.
 *
 * Rates are derived rather than asserted, the same reason a gap's magnitude is a population
 * and not an estimate — and no rate is reported below `minObservations`, because a rate
 * from one look is not a rate and calling it one would make the scrub commit the exact
 * error it exists to catch.
 */

import { randomBytes } from "node:crypto";
import type { Audit, ScrubPolicy } from "./schema.js";
import { COVERING_TRIGGERS, parseAsOf } from "./schema.js";
import { readAudits, readPointers, readRequirements, readScrubPolicy, writeLocalScrubPolicy } from "./store.js";
import { requireActor } from "./identity.js";
import type { ActorInput } from "./identity.js";
import { disposition, shareScrubPolicy } from "./standard-publish.js";

const mint = () => "sc_" + randomBytes(6).toString("hex");
const now = () => new Date().toISOString();
const DAY = 86_400_000;

export type Err = { error: string };
const isErr = (x: unknown): x is Err => !!x && typeof x === "object" && "error" in (x as object);

// --- the policy ---------------------------------------------------------------

/**
 * State the rate and coverage period.
 *
 * Open to any actor: a schedule cannot silence anything, and a scrub policy nobody set is
 * the failure mode — so making it hard to set would be gating in the wrong direction. What
 * IS refused is a policy that cannot do its job: a period of zero covers nothing, and
 * fewer than two observations is not a rate.
 */
export async function setScrubPolicy(
  root: string, input: { coverageDays: number; minObservations?: number } & ActorInput,
): Promise<{ ok: true; policy: ScrubPolicy } | Err> {
  const coverageDays = Number(input.coverageDays);
  if (!Number.isFinite(coverageDays) || coverageDays <= 0) {
    return { error: "`coverageDays` must be a positive number of days — it is the period within which every rule in force is looked at" };
  }
  const minObservations = input.minObservations === undefined ? 3 : Number(input.minObservations);
  if (!Number.isInteger(minObservations) || minObservations < 2) {
    return {
      error:
        "`minObservations` must be at least 2. A firing rate from a single look is not a "
        + "rate, and reporting one would make the scrub commit the error it exists to "
        + "catch — a confident verdict from a check that could not have produced one.",
    };
  }
  const actor = requireActor(root, input);
  if (isErr(actor)) return actor;
  const policy: ScrubPolicy = { coverageDays, minObservations, setBy: actor, setAt: now() };
  const d = disposition(await shareScrubPolicy(root, policy));
  if ("error" in d) return d;
  if (d.local) await writeLocalScrubPolicy(root, policy);
  return { ok: true, policy };
}

/**
 * Audits that RESET a rule's coverage deadline.
 *
 * **Branch work resets nothing**, whatever its trigger. A provisional audit is about
 * somebody's work in progress and may never merge, and a coverage clock is a claim about
 * the codebase. The proof that an audit examined code which LANDED is promotion, and
 * `promotableAudits` decides that on WITNESSES — the exact source is verbatim present —
 * rather than on commit ancestry, which is unsound in the other direction. A promoted
 * audit is not provisional, so this one test covers both routes.
 *
 * Then, among audits about the codebase:
 *
 *  - `scrub` and `baseline` cover by construction: they were asked to look at what did not
 *    move, and they must report every active pointer to be recorded at all.
 *  - `differential` covers too, but only having got past the provisional test above — it
 *    looked at what CHANGED, so it says nothing until that change is proven present. It
 *    covers exactly the POINTERS it reports observing, which is why it may now carry a
 *    subset: the deadline is the pointer's, and one that moves inside every coverage period
 *    used to reset the clock for the ones beside it that never move.
 *  - `ad-hoc` covers nothing. Nobody asked what it looked at and nothing records what it
 *    left out, so treating it as coverage is the self-report the deadline exists to
 *    replace. An audit written before triggers existed reads `ad-hoc` for that reason.
 */
const covers = (a: Audit): boolean => {
  if (a.provisional) return false;
  const trigger = a.trigger ?? "ad-hoc";
  return COVERING_TRIGGERS.includes(trigger) || trigger === "differential";
};

// --- the rates ----------------------------------------------------------------

export interface PointerRate {
  pointerId: string;
  requirementId: string;
  observations: number;
  fired: number;
  /**
   * `null` until `minObservations`, and that is the guard that matters.
   *
   * A rate from two looks is not a rate. Reporting one would be a confident verdict from a
   * check that could not have produced one — which is precisely the shape the scrub exists
   * to find, so committing it here would be the mechanism failing at its own standard.
   */
  pathology: "never-fires" | "always-fires" | null;
}

/**
 * Firing rates per pointer, derived from the scrub history rather than asserted.
 *
 * `live` restricts the answer to pointers still watching a rule still in force. The
 * history of a retired pointer or a repealed rule is real and stays on the record — it is
 * just not a pathology, because a pathology is a claim that something is wrong NOW, and
 * asking anybody to act on a dead record is the noise this mechanism exists to reduce.
 */
export async function pointerRates(root: string, opts: { live?: boolean } = {}): Promise<PointerRate[]> {
  const policy = await readScrubPolicy(root);
  const min = policy?.minObservations ?? Infinity;   // no policy → no rate is reportable
  let alive: Set<string> | null = null;
  if (opts.live) {
    const inForce = new Set((await readRequirements(root, { status: "ratified" })).requirements.map((r) => r.id));
    alive = new Set((await readPointers(root, { state: "active" }))
      .filter((p) => inForce.has(p.requirementId)).map((p) => p.id));
  }
  const tally = new Map<string, { requirementId: string; observations: number; fired: number }>();
  for (const sc of (await readAudits(root)).filter(covers)) {
    for (const o of sc.observations ?? []) {
      const t = tally.get(o.pointerId) ?? { requirementId: sc.requirementId, observations: 0, fired: 0 };
      t.observations++;
      if (o.firing) t.fired++;
      tally.set(o.pointerId, t);
    }
  }
  return [...tally].filter(([id]) => !alive || alive.has(id)).map(([pointerId, t]) => ({
    pointerId, requirementId: t.requirementId, observations: t.observations, fired: t.fired,
    pathology: t.observations < min ? null
      : t.fired === 0 ? "never-fires"
        : t.fired === t.observations ? "always-fires"
          : null,
  }));
}

// --- the schedule ---------------------------------------------------------------

export interface ScrubDue {
  requirementId: string;
  title: string;
  section: string;
  /**
   * The OLDEST of this rule's pointer deadlines — the one that makes it due.
   *
   * Per pointer, not per rule, and that is the whole repair. A single timestamp on the
   * requirement meant any covering look reset the clock for everything watching it: with
   * pointer A moving every 29 days and B never, each differential audit of A reset R, so B
   * was never examined and *everything is covered every T* quietly failed. The deadline
   * belongs to the thing being watched.
   */
  lastScrubbed: string | null;
  daysSince: number | null;
  /** The pointers actually overdue, oldest first — what a scrub of this rule has to look at. */
  stale: { pointerId: string; lastScrubbed: string | null; daysSince: number | null }[];
}

export interface ScrubPlan {
  /**
   * `null` is a FINDING, not a default. Without a stated period the scrub is "whenever
   * somebody remembers", which is the thing it exists to replace, and its cost is
   * unbudgeted — the principal-time failure arriving from a third direction.
   */
  policy: ScrubPolicy | null;
  /** Rules in force. A retired rule does not bind, so it is not on the schedule. */
  population: number;
  /** Never looked at even once — the sharpest bucket, and where seeding lands everything. */
  neverScrubbed: number;
  /** Past the coverage period, oldest first: coverage is guaranteed, not sampled. */
  due: ScrubDue[];
  /**
   * The budget, stated: the AVERAGE rules per day needed to cover the population every
   * `coverageDays`. The number that makes the cost visible before it is incurred, which is
   * the difference between a schedule and an intention.
   *
   * Not rounded up. `Math.ceil` reports one rule every 365 days as "1 per day" — 365 times
   * the real workload — and the only reading that would justify a ceiling is a quota that
   * must be performed daily, which this schedule does not require. The number that answers
   * *what must I do today* is `due.length`, and it is right there.
   */
  perDay: number | null;
  /** Pointers whose firing rate says they are not doing the job they look like they do. */
  pathologies: PointerRate[];
}

export async function scrubPlan(root: string, opts: { asOf?: string } = {}): Promise<ScrubPlan> {
  const asOf = parseAsOf(opts.asOf).ms;
  const policy = await readScrubPolicy(root);
  const { requirements } = await readRequirements(root, { status: "ratified" });

  // The deadline is per POINTER, keyed by what each audit actually said it looked at.
  //
  // It used to be per requirement — one timestamp, set by any covering audit of the rule —
  // and that is how differential activity could starve the scrub: pointer A moving every 29
  // days produced a differential audit every 29 days, each of which reset R, so pointer B
  // was never examined while the schedule reported R as covered. A rule is only as covered
  // as its least-recently-looked-at pointer.
  //
  // Audits that COVER are the covering triggers plus `differential` — the latter having
  // proved its change is on the default branch. Not `ad-hoc`: nobody asked what that one
  // would look at, so it names no pointers and resets nothing.
  const covered = new Map<string, string>();          // pointerId -> when
  const ruleWide = new Map<string, string>();          // requirementId -> when, for the pointerless case
  for (const a of (await readAudits(root)).filter(covers)) {   // ORDER BY at — last wins
    ruleWide.set(a.requirementId, a.at);
    for (const o of a.observations ?? []) covered.set(o.pointerId, a.at);
  }
  const watching = new Map<string, string[]>();
  for (const p of await readPointers(root, { state: "active" })) {
    (watching.get(p.requirementId) ?? watching.set(p.requirementId, []).get(p.requirementId)!).push(p.id);
  }
  const since = (at: string | null) => (at ? Math.floor((asOf - Date.parse(at)) / DAY) : null);

  const rows: ScrubDue[] = requirements.map((r) => {
    const ps = watching.get(r.id) ?? [];
    // A rule with nothing watching it has no finer thing to key on, so it keeps the
    // rule-wide timestamp. `auditQueue.unwatched` is what reports the missing pointer;
    // dropping such a rule off the schedule as well would hide it twice.
    const stale = ps.map((pointerId) => {
      const at = covered.get(pointerId) ?? null;
      return { pointerId, lastScrubbed: at, daysSince: since(at) };
    }).sort((a, b) => (b.daysSince ?? Infinity) - (a.daysSince ?? Infinity));
    const at = ps.length
      // The OLDEST pointer decides. `null` — never observed — is older than any date.
      ? (stale.some((x) => x.lastScrubbed === null) ? null : stale[0]!.lastScrubbed)
      : ruleWide.get(r.id) ?? null;
    return {
      requirementId: r.id, title: r.title, section: r.section, lastScrubbed: at,
      daysSince: since(at),
      stale: policy
        ? stale.filter((x) => x.daysSince === null || x.daysSince >= policy.coverageDays)
        : stale,
    };
  });
  // Never-scrubbed first, then oldest first. Coverage is the property being guaranteed, so
  // the order is least-recently-looked-at and never "whatever moved" — that is differential
  // audit's job, and a scrub driven by movement covers exactly what it is meant to cover.
  const overdue = policy
    ? rows.filter((x) => x.daysSince === null || x.daysSince >= policy.coverageDays)
    : rows;
  overdue.sort((a, b) => (a.daysSince ?? Infinity) === (b.daysSince ?? Infinity)
    ? a.requirementId.localeCompare(b.requirementId)
    : (b.daysSince ?? Infinity) - (a.daysSince ?? Infinity));

  return {
    policy, population: requirements.length,
    neverScrubbed: rows.filter((x) => x.lastScrubbed === null).length,
    due: overdue,
    perDay: policy ? Math.round((requirements.length / policy.coverageDays) * 100) / 100 : null,
    pathologies: (await pointerRates(root, { live: true })).filter((p) => p.pathology !== null),
  };
}

/** The covering audits of one rule, oldest first — the history a rate is read from. */
export async function scrubsFor(root: string, requirementId: string): Promise<Audit[]> {
  return (await readAudits(root, { requirementId })).filter(covers);
}

/**
 * A BASELINE is not a queue, it is a sweep: every rule in force, with what is known about
 * each, because something warrants looking at all of it at once — a large refactor landing,
 * a high-risk feature shipping. Expensive on purpose, which is why it is asked for rather
 * than scheduled.
 */
export async function baselinePlan(root: string): Promise<{
  population: number;
  rules: { requirementId: string; title: string; section: string; lastCovered: string | null; pointers: number }[];
}> {
  const { requirements } = await readRequirements(root, { status: "ratified" });
  const covering = (await readAudits(root)).filter(covers);
  const last = new Map<string, string>();
  for (const a of covering) last.set(a.requirementId, a.at);
  const watching = new Map<string, number>();
  for (const p of await readPointers(root, { state: "active" })) {
    watching.set(p.requirementId, (watching.get(p.requirementId) ?? 0) + 1);
  }
  return {
    population: requirements.length,
    rules: requirements.map((r) => ({
      requirementId: r.id, title: r.title, section: r.section,
      lastCovered: last.get(r.id) ?? null, pointers: watching.get(r.id) ?? 0,
    })),
  };
}
