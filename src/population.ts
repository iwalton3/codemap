/**
 * The population predicate — a hash-pinned lint (COD-29, COD-18).
 * `docs/population-predicate.md` is the brief; `docs/requirements-architecture.md` outranks it.
 *
 * What a rule RANGES OVER, and it is load-bearing in four separate places: it makes `gap`
 * decidable (*no code that should conform exists yet* needs to know what the rule ranges
 * over), it makes a gap's magnitude COUNTED rather than estimated (an estimate is a
 * self-report by the party whose judgement is in question), it is what COD-17's re-derive
 * was always for, and it is what a ratifier is being asked to take on faith when an agent
 * attaches a gap to a draft operation.
 *
 * **A lint, not a query language**, and that is the decision not to re-litigate. Anything
 * strong enough for "every HTTP endpoint" is framework knowledge — the analyzer boundary,
 * and its 138 false positives before 4 genuine findings — so a query language would make
 * codemap responsible for understanding every target framework and inherit that error rate
 * into the record that is meant to be more trustworthy than the code. Nothing here parses
 * a member id. It counts them and diffs them.
 *
 * ## The laundering door this closes, and the one it opens
 *
 * The cheapest way to make a failing rule pass is to **narrow its population until the
 * violators fall outside it**. That is not amending the rule and not fixing the code; it
 * redefines what the rule was ever about and leaves the statement — the part a human reads
 * — untouched. After *amend the rule to match the code* and *declare the rule not yet
 * applicable*, this is *declare those things were never in scope*.
 *
 * A lint makes that MORE invisible, not less: the edit is buried in test code and looks
 * like maintenance. So the pin alone is not the answer — narrow the selector, the pin
 * breaks, re-pin, quiet again is the same door in two steps. Two things close it:
 *
 *  - **The delta is the rendering**, never two diffed selectors, which are not reviewable:
 *    *"this drops 14 members, 9 of which currently violate"*. That converts *detect
 *    underhandedness* into *read a number*, and agent arithmetic and agent discernment do
 *    not have the same reliability.
 *  - **Gate by consequence.** A re-pin that drops members can flip debt into gap, which is
 *    silencing, so it is a principal's act. One that adds or keeps them cannot, so it is
 *    open. Gate what silences, never what unsilences.
 */

import { randomBytes } from "node:crypto";
import type { PopulationMember, PopulationPredicate } from "./schema.js";
import {
  readAcknowledgements, readPopulations, readRequirement, writeLocalPopulation,
} from "./store.js";
import { liveHashes, liveIndex, witnessDrift, realDrift } from "./reviews.js";
import { legacyIndex, resolveAnchor, type AnchorIndex } from "./anchor-resolve.js";
import { requireActor, isAgentActor } from "./identity.js";
import { currentBranch, headCommit, isDirty, isGitRepo, onDefaultBranch } from "./git.js";
import type { ActorInput } from "./identity.js";
import { disposition, sharePopulationPinned } from "./standard-publish.js";
import { releaseAcknowledgement } from "./acknowledgements.js";

const mint = () => "pop_" + randomBytes(6).toString("hex");
const now = () => new Date().toISOString();

export type Err = { error: string };
const isErr = (x: unknown): x is Err => !!x && typeof x === "object" && "error" in (x as object);

const STATES: PopulationMember["state"][] = ["conforms", "violates", "undecidable"];

export interface Counts { members: number; conforms: number; violates: number; undecidable: number }

/** Derived from the member list, never stored beside it — they cannot then disagree. */
export function counts(members: PopulationMember[]): Counts {
  return {
    members: members.length,
    conforms: members.filter((m) => m.state === "conforms").length,
    violates: members.filter((m) => m.state === "violates").length,
    undecidable: members.filter((m) => m.state === "undecidable").length,
  };
}

export interface ServedPopulation extends PopulationPredicate {
  counts: Counts;
  /**
   * The lint itself was edited since it was pinned — *fired → was edited → now quiet*.
   *
   * The one pathology a scrub cannot reach, which is the whole reason the pin exists. A
   * broken pin does not say the edit was underhanded; it says nobody has looked at it.
   */
  pinBroken: boolean;
  drifted: string[];
  /** The lint's code is gone entirely, so it can never fire again. */
  missing: boolean;
}

function serveWith(root: string, p: PopulationPredicate, live: AnchorIndex): ServedPopulation {
  // From `live`, not from `@work` — the two disagree about a renamed symbol and the
  // disagreement is silent in the worst direction. See `liveIndex`. The pin's own hashes
  // are the evidence, so a lint minted by a build this one cannot compare with reads as
  // undecidable rather than gone.
  const byId = new Map(p.witnesses.map((w) => [w.anchorId, w.bodyHash]));
  const base = {
    ...p, counts: counts(p.members),
    missing: p.basis === "lint" && p.lint.length > 0
      && p.lint.some((id) => resolveAnchor(id, byId.has(id) ? [byId.get(id)!] : [], live).at === "absent"),
  };
  if (!p.witnesses.length) return { ...base, pinBroken: false, drifted: [] };
  const changes = realDrift(witnessDrift(p.witnesses, live));
  return { ...base, pinBroken: changes.length > 0, drifted: changes.map((c) => c.anchorId) };
}

/**
 * `liveHashes` reads the whole `@work` anchor table and re-parses the files it needs, so a
 * batch read must ask ONCE for the union rather than once per pin.
 */
const liveFor = (root: string, pins: PopulationPredicate[]): Promise<AnchorIndex> => {
  // The pinned LINT as well as the witnesses: `serveWith` decides `missing` from it, and a
  // pin whose lint is not in this index would read as present for want of an answer.
  const ids = [...new Set(pins.flatMap((p) => [...p.witnesses.map((w) => w.anchorId), ...p.lint]))];
  return ids.length ? liveHashes(root, ids) : Promise.resolve(legacyIndex(new Map()));
};

export async function serve(root: string, p: PopulationPredicate): Promise<ServedPopulation> {
  return serveWith(root, p, await liveFor(root, [p]));
}

// --- the delta ---------------------------------------------------------------

export interface PopulationDelta {
  dropped: PopulationMember[];
  added: PopulationMember[];
  /** Members that stayed but whose verdict changed — the other way a lint can be narrowed. */
  reclassified: { id: string; from: PopulationMember["state"]; to: PopulationMember["state"] }[];
  /**
   * Of the dropped, how many the OLD pin said were violating.
   *
   * The number the whole rendering exists to produce. Dropping members that were already
   * conforming is ordinary refactoring; dropping the ones that were failing is the
   * laundering move, stated as arithmetic rather than left to discernment.
   */
  droppedViolating: number;
  /** Any drop at all. What decides whether a re-pin needs a principal. */
  narrows: boolean;
}

/**
 * What changed between two pins, as members rather than as selectors.
 *
 * Two diffed selectors are not reviewable — that is the point of doing it this way. The
 * mechanical cross-check the design asks for (run the lint at both hashes, diff the member
 * lists) is exactly this function, and it needs no judgement at all.
 */
export function populationDelta(before: PopulationMember[], after: PopulationMember[]): PopulationDelta {
  const was = new Map(before.map((m) => [m.id, m]));
  const is = new Map(after.map((m) => [m.id, m]));
  const dropped = before.filter((m) => !is.has(m.id));
  const added = after.filter((m) => !was.has(m.id));
  const reclassified = after
    .filter((m) => was.has(m.id) && was.get(m.id)!.state !== m.state)
    .map((m) => ({ id: m.id, from: was.get(m.id)!.state, to: m.state }));
  return {
    dropped, added, reclassified,
    droppedViolating: dropped.filter((m) => m.state === "violates").length,
    narrows: dropped.length > 0,
  };
}

// --- pinning -----------------------------------------------------------------

function checkMembers(members: PopulationMember[] | undefined): Err | null {
  if (!Array.isArray(members)) return { error: "`members` must be the list the lint examined" };
  // A lint over zero members is GREEN, and green reads as conformant. With a query
  // language that was an edge case; with a lint it is the default failure mode, so the
  // cheap mechanical layer refuses it outright. It does not catch a lint that CLAIMS 47
  // members and examined none — codemap cannot run anything, so only a reader catches
  // that, which is the auditor layer and is deliberately kept as well.
  if (!members.length) {
    return {
      error:
        "a lint reporting zero members cannot be pinned. Zero members is green, and green "
        + "reads as conformant — an empty population is the default failure mode here, not "
        + "an edge case. If the rule genuinely ranges over nothing yet, that is a gap; if no "
        + "lint can express it, pin `not-expressible` with a reason.",
    };
  }
  for (const m of members) {
    if (!m?.id?.trim()) return { error: "every member needs an `id` — the enumeration is the only review anybody can perform on a predicate" };
    if (!STATES.includes(m.state)) return { error: `member "${m.id}" has state "${m.state}"; must be one of ${STATES.join(" | ")}` };
  }
  const ids = members.map((m) => m.id);
  if (new Set(ids).size !== ids.length) return { error: "the same member is listed twice — counts derived from this would be wrong" };
  return null;
}

/**
 * Where this pin was taken, and whether that makes it somebody's work in progress.
 *
 * A lint enumerates whatever is CHECKED OUT, so the branch is not incidental to a member
 * list the way it is to a rule's text — it is what the list is an observation of.
 */
function provenance(root: string): Pick<PopulationPredicate, "provisional" | "commit" | "branch"> {
  const git = isGitRepo(root);
  const provisional = !onDefaultBranch(root) || (git && isDirty(root));
  return {
    commit: git ? headCommit(root) : null,
    branch: git ? currentBranch(root) : null,
    ...(provisional ? { provisional: true } : {}),
  };
}

export interface Pinned { ok: true; id: string; population: ServedPopulation; delta?: PopulationDelta; released: string[] }

/**
 * Pin what a rule ranges over.
 *
 * Open on a first pin and on a widening re-pin; a NARROWING re-pin needs a principal,
 * because dropping members can flip debt into gap and that is silencing. The refusal
 * carries the delta, so the person who has to decide is reading a number rather than two
 * selectors.
 */
export async function pinPopulation(
  root: string,
  input: { requirementId: string; lint: string[]; members: PopulationMember[] } & ActorInput,
): Promise<Pinned | Err> {
  const r = await readRequirement(root, input.requirementId);
  if (!r) return { error: `no requirement "${input.requirementId}"` };
  if (r.status === "retired") return { error: `${r.id} is retired` };

  const lint = (input.lint ?? []).filter((x) => x?.trim());
  if (!lint.length) {
    return { error: "a pin needs the `lint` anchors it is pinning — without them nothing witnesses the detector, and an edit to it is invisible" };
  }
  // The LIVE index, which is what this error has always said. Asking `@work` let a pin be
  // taken over a renamed lint: every witness `sha256:absent`, and absent never drifts, so
  // `pinBroken` — the one pathology a scrub cannot reach — could never fire. See `liveIndex`.
  const { live: pinned, absent: gone } = await liveIndex(root, lint);
  if (gone.length) return { error: `not in the live index: ${gone.join(", ")}` };

  const bad = checkMembers(input.members);
  if (bad) return bad;

  const actor = requireActor(root, input);
  if (isErr(actor)) return actor;

  const current = (await readPopulations(root, { requirementId: r.id, state: "active" })).at(-1);
  let delta: PopulationDelta | undefined;
  if (current) {
    delta = populationDelta(current.members, input.members);
    if (delta.narrows && isAgentActor(actor)) {
      return {
        error:
          `this re-pin NARROWS the population: it drops ${delta.dropped.length} member(s), `
          + `${delta.droppedViolating} of which the current pin says are violating`
          + (delta.dropped.length ? ` (${delta.dropped.slice(0, 8).map((m) => m.id).join(", ")}${delta.dropped.length > 8 ? ", …" : ""})` : "")
          + ". Narrowing a population can turn debt into a gap, which is silencing, so a "
          + "principal has to make it. Widening or re-stating the same members is open.",
      };
    }
  }

  const pin: PopulationPredicate = {
    id: mint(), requirementId: r.id, basis: "lint", lint,
    witnesses: lint.map((id) => ({ anchorId: id, bodyHash: pinned.get(id)! })),
    members: input.members, state: "active", pinnedBy: actor, pinnedAt: now(),
    ...provenance(root),
    ...(current ? { supersedes: current.id } : {}),
  };

  // A PROVISIONAL pin never reaches the log — `sharePopulationPinned` short-circuits it to
  // `localOnly` — so it takes the local branch below and tries to supersede `current` with
  // a local write. When `current` arrived from the fold, `writeLocalPopulation` refuses to
  // touch it and THROWS, so re-pinning from a branch or a dirty tree rejected the promise
  // instead of returning an `Err`: an internal error to the caller, and the new pin lost.
  //
  // Refused, and it fails closed: the team's pin stays the one in force. Superseding it
  // needs an event, and a provisional observation is exactly what may not become one.
  if (current?.origin === "sync" && pin.provisional) {
    return {
      error:
        `${r.id} already has a population pinned by the team (${current.id}), and this pin is `
        + `provisional — taken off the default branch or on a dirty tree, so it is about `
        + `nobody's code and cannot supersede theirs. Pin again from a clean default branch.`,
    };
  }
  const d = disposition(await sharePopulationPinned(root, pin, current?.id));
  if ("error" in d) return d;
  if (d.local) {
    // Supersede FIRST. These are two writes and nothing makes them atomic, so the order
    // decides what a crash between them leaves: superseding first can leave a rule with no
    // active population, which reads as `absent` and is the fail-closed answer; the other
    // order can leave two active pins for one rule, which is a state nothing else models.
    if (current) await writeLocalPopulation(root, { ...current, state: "superseded" });
    await writeLocalPopulation(root, pin);
  }
  return {
    ok: true, id: pin.id, population: await serve(root, pin),
    ...(delta ? { delta } : {}), released: await settleGaps(root, pin),
  };
}

/**
 * Say honestly that no lint can express this, which is NOT the same as an empty one.
 *
 * "The client must be a native iOS application"; or a rule ranging over `Acme.API` and
 * `Acme.React` together, which is not one lint and must not become two that can drift.
 * Without a way to record this the field gets satisfied with a bad predicate, which is
 * worse than none because it produces numbers — and a rule that lands here is usually a
 * product-strategy statement wearing a requirement's clothes. The routing was never the
 * failure; the failure was that it happened silently.
 */
export async function declareNotExpressible(
  root: string, input: { requirementId: string; reason: string } & ActorInput,
): Promise<{ ok: true; id: string; population: ServedPopulation } | Err> {
  const reason = input.reason?.trim();
  if (!reason) {
    return { error: "`not-expressible` needs a reason — it is the one basis nothing can check, so the argument is all a reader gets" };
  }
  const r = await readRequirement(root, input.requirementId);
  if (!r) return { error: `no requirement "${input.requirementId}"` };
  if (r.status === "retired") return { error: `${r.id} is retired` };
  const actor = requireActor(root, input);
  if (isErr(actor)) return actor;

  const current = (await readPopulations(root, { requirementId: r.id, state: "active" })).at(-1);
  // Replacing a real population with "no lint can express this" retires every member it
  // was counting, which is the narrowing move at its limit. Same gate, same reason.
  if (current?.basis === "lint" && isAgentActor(actor)) {
    return {
      error:
        `${r.id} already has a pinned population of ${current.members.length} member(s). Replacing `
        + "it with `not-expressible` drops all of them, which is narrowing at its limit — a "
        + "principal has to make that call.",
    };
  }
  const pin: PopulationPredicate = {
    id: mint(), requirementId: r.id, basis: "not-expressible", lint: [], witnesses: [],
    members: [], reason, state: "active", pinnedBy: actor, pinnedAt: now(),
    ...provenance(root),
    ...(current ? { supersedes: current.id } : {}),
  };
  // A PROVISIONAL pin never reaches the log — `sharePopulationPinned` short-circuits it to
  // `localOnly` — so it takes the local branch below and tries to supersede `current` with
  // a local write. When `current` arrived from the fold, `writeLocalPopulation` refuses to
  // touch it and THROWS, so re-pinning from a branch or a dirty tree rejected the promise
  // instead of returning an `Err`: an internal error to the caller, and the new pin lost.
  //
  // Refused, and it fails closed: the team's pin stays the one in force. Superseding it
  // needs an event, and a provisional observation is exactly what may not become one.
  if (current?.origin === "sync" && pin.provisional) {
    return {
      error:
        `${r.id} already has a population pinned by the team (${current.id}), and this pin is `
        + `provisional — taken off the default branch or on a dirty tree, so it is about `
        + `nobody's code and cannot supersede theirs. Pin again from a clean default branch.`,
    };
  }
  const d = disposition(await sharePopulationPinned(root, pin, current?.id));
  if ("error" in d) return d;
  if (d.local) {
    if (current) await writeLocalPopulation(root, { ...current, state: "superseded" });
    await writeLocalPopulation(root, pin);
  }
  return { ok: true, id: pin.id, population: await serve(root, pin) };
}

/**
 * A non-empty population falsifies a GAP, and then the record has to go.
 *
 * A gap claims no code that should conform exists yet; a lint that just enumerated members
 * has found some. Releasing is the safe direction — its failure mode is noise — so it is
 * automatic here exactly as it is after an audit. Granting never could be.
 */
async function settleGaps(root: string, pin: PopulationPredicate): Promise<string[]> {
  // A PROVISIONAL pin settles nothing, the second half of `shareX` holding it back. This
  // is `settleAcknowledgements`'s rule and its reason: releasing is a shared act, and
  // releasing on the strength of branch work un-silences a rule for the whole team on a
  // population that may never merge — citing a pin id no other clone can resolve.
  if (pin.provisional) return [];
  if (pin.basis !== "lint" || !pin.members.length) return [];
  const active = await readAcknowledgements(root, { requirementId: pin.requirementId, state: "active" });
  const released: string[] = [];
  for (const a of active) {
    if (a.basis !== "gap") continue;   // debt and a populated rule are consistent
    const done = await releaseAcknowledgement(
      root, a.id,
      `population ${pin.id} enumerated ${pin.members.length} member(s) — this was recorded as a gap, which claims there are none`,
      { principal: pin.pinnedBy.principal },
    );
    if (!isErr(done)) released.push(a.id);
  }
  return released;
}

// --- reading -----------------------------------------------------------------

/**
 * What a rule ranges over, with its history.
 *
 * `absent` is its own answer and must not read as anything else: a rule nobody has pinned
 * is one where *no code should conform to this yet* still means *I looked and did not find
 * any*, which is the assertion the whole record exists to replace.
 */
export async function populationFor(root: string, requirementId: string): Promise<{
  state: "absent" | "pinned" | "not-expressible";
  current?: ServedPopulation;
  history: PopulationPredicate[];
} | Err> {
  if (!(await readRequirement(root, requirementId))) return { error: `no requirement "${requirementId}"` };
  const all = await readPopulations(root, { requirementId });
  const current = all.filter((p) => p.state === "active").at(-1);
  if (!current) return { state: "absent", history: all };
  return {
    state: current.basis === "not-expressible" ? "not-expressible" : "pinned",
    current: await serve(root, current), history: all,
  };
}

/** Every pin whose lint has been edited since — the queue the pin exists to produce. */
export async function brokenPins(root: string): Promise<ServedPopulation[]> {
  // Ratified rules only, the way `conformance()`, `weakAssertions` and `auditQueue` filter:
  // a retired rule does not bind, so an edit to the lint that used to enumerate it is
  // nobody's work.
  const { readRequirements } = await import("./store.js");
  const inForce = new Set((await readRequirements(root, { status: "ratified" })).requirements.map((r) => r.id));
  const active = (await readPopulations(root, { state: "active" })).filter((p) => inForce.has(p.requirementId));
  const live = await liveFor(root, active);
  return active.map((p) => serveWith(root, p, live)).filter((p) => p.pinBroken || p.missing);
}
