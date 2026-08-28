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
import type { Actor, Scrub, ScrubPolicy } from "./schema.js";
import {
  readPointers, readRequirement, readRequirements, readScrubPolicy, readScrubs,
  writeLocalScrub, writeLocalScrubPolicy,
} from "./store.js";
import { requireActor } from "./identity.js";
import type { ActorInput } from "./identity.js";
import { disposition, shareScrub, shareScrubPolicy } from "./standard-publish.js";

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

// --- recording a scrub --------------------------------------------------------

/**
 * Record that somebody went and looked at a rule.
 *
 * The gate is the OBSERVATIONS, and it is the audit's evidence refusal transposed: a scrub
 * resets a rule's coverage clock, which is the quieting direction, so *"I looked"* with
 * nothing recorded is a self-report buying a fresh period. The observations must cover the
 * rule's active pointers exactly — no omissions, and no phantoms either, since an
 * observation of a pointer that is not there is the same self-report wearing evidence.
 *
 * A rule with nothing watching it legitimately observes nothing, and recording that IS the
 * finding: `unwatched` is the requirement-side twin of `unknown`.
 */
export async function recordScrub(
  root: string,
  input: {
    requirementId: string; finding: string; verdict: Scrub["verdict"];
    observations?: { pointerId: string; firing: boolean }[];
  } & ActorInput,
): Promise<{ ok: true; id: string; scrub: Scrub } | Err> {
  if (input.verdict !== "sound" && input.verdict !== "suspect") {
    return { error: '`verdict` must be "sound" or "suspect"' };
  }
  const finding = input.finding?.trim();
  if (!finding) {
    return {
      error:
        "a scrub needs a `finding` — what you concluded from looking. A scrub that records "
        + "nothing is the vacuous check this whole mechanism exists to detect, one level up.",
    };
  }
  const r = await readRequirement(root, input.requirementId);
  if (!r) return { error: `no requirement "${input.requirementId}"` };
  if (r.status === "retired") return { error: `${r.id} is retired — a rule that does not bind is not on the schedule` };

  const active = await readPointers(root, { requirementId: r.id, state: "active" });
  const observations = input.observations ?? [];
  const seen = new Set(observations.map((o) => o.pointerId));
  const missed = active.filter((p) => !seen.has(p.id));
  const phantom = observations.filter((o) => !active.some((p) => p.id === o.pointerId));
  if (missed.length) {
    return {
      error:
        `this scrub does not say what ${missed.length} of the rule's active pointer(s) were doing `
        + `(${missed.map((p) => p.id).join(", ")}). A scrub resets the coverage clock, so one that `
        + `skips a pointer buys a fresh period without having looked at it.`,
    };
  }
  if (phantom.length) {
    return { error: `observed pointer(s) that are not active on ${r.id}: ${phantom.map((o) => o.pointerId).join(", ")}` };
  }
  if (observations.some((o) => typeof o.firing !== "boolean")) {
    return { error: "every observation needs `firing: true|false` — that boolean IS the history a rate is derived from" };
  }
  // The same pointer twice in one scrub is one look counted as several, and it defeats
  // `minObservations` exactly: three copies of one observation reaches the default floor
  // from a single call and reports a pathology. That is the error the floor exists to
  // prevent, arriving through the door the floor does not watch. `checkMembers` in
  // `population.ts` refuses duplicates for the same reason.
  if (seen.size !== observations.length) {
    return { error: "the same pointer is observed twice — one look counted as several is how a rate stops being a rate" };
  }
  const actor = requireActor(root, input);
  if (isErr(actor)) return actor;

  const scrub: Scrub = {
    id: mint(), requirementId: r.id, observations, finding, verdict: input.verdict,
    scrubbedBy: actor, at: now(),
  };
  const d = disposition(await shareScrub(root, scrub));
  if ("error" in d) return d;
  if (d.local) await writeLocalScrub(root, scrub);
  return { ok: true, id: scrub.id, scrub };
}

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
  for (const sc of await readScrubs(root)) {
    for (const o of sc.observations) {
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
  lastScrubbed: string | null;
  daysSince: number | null;
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
  /**
   * Rules whose most recent scrub said something is off and which nobody has looked at
   * since — the OUTPUT of the mechanism, as opposed to its schedule.
   *
   * Derived from the latest scrub rather than from a status field, so it clears by
   * somebody looking again rather than by anybody marking it clear.
   */
  suspect: { requirementId: string; at: string; finding: string }[];
}

export async function scrubPlan(root: string, opts: { asOf?: string } = {}): Promise<ScrubPlan> {
  const asOf = opts.asOf ? Date.parse(opts.asOf) : Date.now();
  const policy = await readScrubPolicy(root);
  const { requirements } = await readRequirements(root, { status: "ratified" });

  const inForce = new Set(requirements.map((r) => r.id));
  const last = new Map<string, string>();
  const latest = new Map<string, { at: string; finding: string; verdict: string }>();
  for (const sc of await readScrubs(root)) {   // ORDER BY at — last wins
    last.set(sc.requirementId, sc.at);
    latest.set(sc.requirementId, { at: sc.at, finding: sc.finding, verdict: sc.verdict });
  }

  const rows: ScrubDue[] = requirements.map((r) => {
    const at = last.get(r.id) ?? null;
    return {
      requirementId: r.id, title: r.title, section: r.section, lastScrubbed: at,
      daysSince: at ? Math.floor((asOf - Date.parse(at)) / DAY) : null,
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
    suspect: [...latest]
      .filter(([rid, x]) => inForce.has(rid) && x.verdict === "suspect")
      .map(([requirementId, x]) => ({ requirementId, at: x.at, finding: x.finding })),
  };
}

/** Every scrub against one rule, oldest first — the history a rate is read from. */
export async function scrubsFor(root: string, requirementId: string): Promise<Scrub[]> {
  return readScrubs(root, { requirementId });
}
