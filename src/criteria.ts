/**
 * Acceptance criteria and the vacuity checks that keep them honest (COD-29, COD-18).
 * `docs/requirements-architecture.md` is normative; this implements it.
 *
 * The second citation relation lives here. `Requirement.cites` is the code a rule is
 * ABOUT — staleness means *that code moved*. `AcceptanceCriterion.assertedBy` is the check
 * that WOULD FAIL if the rule stopped holding — staleness means *the build is red*.
 * Snapshot versus live, and codemap only ever observes the first half: it runs nothing, so
 * what it watches is the assertion's own normalized hash.
 *
 * That is not a limitation being apologised for, it is the mechanism. The designed scrub
 * catches *never fires* and *always fires*; the one thing it cannot catch is **fired → was
 * edited → now quiet**, which is the detector being modified by the change it exists to
 * detect. A hash pin on the assertion is exactly that witness, and it is why `assertionMoved`
 * is derived here rather than stored.
 *
 * Nothing in this module runs a test or a lint, and nothing here concludes conformance from
 * one. A criterion raises or lowers how much an audit's evidence is worth; only
 * `recordAudit` says whether the code conforms.
 */

import { randomBytes } from "node:crypto";
import type {
  AcceptanceCriterion, BugWitness, EvidenceKind, Vacuity, VacuityCheck,
} from "./schema.js";
import {
  readCriteria, readCriterion, readRequirement, readRequirements, readVacuityChecks,
  writeLocalVacuityCheck,
} from "./store.js";
import { liveHashes, witnessDrift, realDrift } from "./reviews.js";
import { requireActor } from "./identity.js";
import type { ActorInput } from "./identity.js";
import { disposition, shareVacuityCheck } from "./standard-publish.js";

const mint = () => "vc_" + randomBytes(6).toString("hex");
const now = () => new Date().toISOString();

export type Err = { error: string };
const isErr = (x: unknown): x is Err => !!x && typeof x === "object" && "error" in (x as object);

const VERDICTS: VacuityCheck["verdict"][] = ["demonstrated", "vacuous", "wrong-layer"];

export interface ServedVacuityCheck extends VacuityCheck {
  /**
   * The assertion this check examined has moved since, so it says nothing about the check
   * that is there now. The same rule `ServedAudit.superseded` follows, and here it is the
   * whole reason vacuity is a record rather than a flag: a stored `demonstrated` would
   * survive a rewrite of the very lint it certified.
   */
  superseded: boolean;
  drifted: string[];
}

export interface ServedCriterion extends AcceptanceCriterion {
  /**
   * What anybody has established about whether this assertion CAN fail.
   *
   * Derived from the latest **live** check, and `unchecked` when there is none — which
   * includes the case where every check has been superseded by the assertion moving. That
   * is the point: `unchecked` must never render as `demonstrated`, exactly as
   * `Conformance.unknown` must never render as `conformant` one level up.
   */
  vacuity: Vacuity;
  /** The check the verdict came from, absent when nobody has looked. */
  lastCheck?: ServedVacuityCheck;
  /**
   * The assertion's own code changed since ratification — the DETECTOR moved.
   *
   * Distinct from the requirement being recheck-due, and a stronger signal: the rule's
   * subject changing means the claim may no longer hold, while the check changing means
   * the thing that would have told you has itself been rewritten.
   */
  assertionMoved: boolean;
  drifted: string[];
  /** No `assertedBy` at all — a criterion still waiting for its check. */
  unasserted: boolean;
}

async function serveCheck(root: string, v: VacuityCheck): Promise<ServedVacuityCheck> {
  if (!v.witnesses.length) return { ...v, superseded: false, drifted: [] };
  const live = await liveHashes(root, v.witnesses.map((w: BugWitness) => w.anchorId));
  const changes = realDrift(witnessDrift(v.witnesses, live));
  return { ...v, superseded: changes.length > 0, drifted: changes.map((c) => c.anchorId) };
}

export async function serve(root: string, c: AcceptanceCriterion): Promise<ServedCriterion> {
  const checks = await Promise.all(
    (await readVacuityChecks(root, { criterionId: c.id })).map((v) => serveCheck(root, v)),
  );
  const live = checks.filter((v) => !v.superseded);
  const last = live[live.length - 1];

  const unasserted = c.assertedBy.length === 0;
  if (!c.witnesses.length) {
    return {
      ...c, vacuity: last?.verdict ?? "unchecked", ...(last ? { lastCheck: last } : {}),
      assertionMoved: false, drifted: [], unasserted,
    };
  }
  const liveHash = await liveHashes(root, c.witnesses.map((w: BugWitness) => w.anchorId));
  const changes = realDrift(witnessDrift(c.witnesses, liveHash));
  return {
    ...c, vacuity: last?.verdict ?? "unchecked", ...(last ? { lastCheck: last } : {}),
    assertionMoved: changes.length > 0, drifted: changes.map((x) => x.anchorId), unasserted,
  };
}

// --- reading -----------------------------------------------------------------

export async function criteriaFor(root: string, requirementId: string): Promise<ServedCriterion[]> {
  const rows = await readCriteria(root, { requirementId });
  return Promise.all(rows.map((c) => serve(root, c)));
}

export async function getCriterion(root: string, id: string): Promise<ServedCriterion | Err> {
  const c = await readCriterion(root, id);
  if (!c) return { error: `no criterion "${id}"` };
  return serve(root, c);
}

export async function listCriteria(
  root: string, opts: { evidenceKind?: EvidenceKind } = {},
): Promise<ServedCriterion[]> {
  const rows = await readCriteria(root, opts);
  return Promise.all(rows.map((c) => serve(root, c)));
}

/**
 * The criteria nobody can currently lean on, and why — the queue this record exists for.
 *
 * Three ways an assertion fails to assert, kept apart because the remedy differs: nobody
 * has tried to break it, somebody tried and it cannot fail, or it fails somewhere that
 * cannot observe the violation. A `wrong-layer` check is real work pointed at the wrong
 * place; a `vacuous` one is not work at all.
 */
export async function weakAssertions(root: string): Promise<{
  unchecked: ServedCriterion[]; vacuous: ServedCriterion[]; wrongLayer: ServedCriterion[];
  unasserted: ServedCriterion[]; moved: ServedCriterion[];
}> {
  // Ratified rules only, for the reason `conformance()` and the diff rollup filter the
  // same way: a retired rule does not bind, so the soundness of its check is nobody's
  // work. A queue that lists them is asking for effort on a dead rule.
  const inForce = new Set((await readRequirements(root, { status: "ratified" })).requirements.map((r) => r.id));
  const all = (await listCriteria(root)).filter((c) => inForce.has(c.requirementId));
  return {
    unchecked: all.filter((c) => c.vacuity === "unchecked" && !c.unasserted),
    vacuous: all.filter((c) => c.vacuity === "vacuous"),
    wrongLayer: all.filter((c) => c.vacuity === "wrong-layer"),
    unasserted: all.filter((c) => c.unasserted),
    // The detector moved. Whatever anybody established about it was established about
    // code that is no longer there, which is why these read `unchecked` above too.
    moved: all.filter((c) => c.assertionMoved),
  };
}

// --- recording ---------------------------------------------------------------

/**
 * Record that somebody tried to make an assertion fail, and what happened.
 *
 * Open to any actor, gated on EVIDENCE — the same shape and the same argument as
 * `recordAudit`, and the codex review that wanted `recordAudit` to refuse an agent was
 * correctly refuted for this reason: verifying a check is exactly what an auditor agent is
 * for, and the gate is what was DONE, not who did it.
 *
 * The gate is one-sided on purpose. `demonstrated` is the silencing direction — it makes a
 * check trustworthy, which is what lets an audit lean on it — so it must say what was
 * broken and what went red. `vacuous` and `wrong-layer` weaken a criterion, whose failure
 * mode is noise, and gating what unsilences is the mistake the acknowledgement gates
 * already avoid.
 */
export async function recordVacuityCheck(
  root: string,
  input: { criterionId: string; verdict: VacuityCheck["verdict"]; method?: string } & ActorInput,
): Promise<{ ok: true; id: string; check: VacuityCheck } | Err> {
  if (!VERDICTS.includes(input.verdict)) {
    return {
      error:
        `verdict must be one of ${VERDICTS.join(" | ")}. There is no way to record `
        + `"unchecked" — that is the absence of a check, not a finding, and writing one `
        + `would let an actor clear a real verdict by asserting ignorance.`,
    };
  }
  const c = await readCriterion(root, input.criterionId);
  if (!c) return { error: `no criterion "${input.criterionId}"` };

  const method = input.method?.trim();
  if (input.verdict === "demonstrated" && !method) {
    return {
      error:
        "a `demonstrated` verdict needs a `method` — what you broke and what went red. It is "
        + "the claim that makes this check trustworthy enough for an audit to lean on, and "
        + "\"I checked and it can fail\" from an actor that did not really check manufactures "
        + "exactly the confidence the record exists to supply.",
    };
  }
  if (input.verdict === "demonstrated" && !c.assertedBy.length) {
    return {
      error:
        `${c.id} has no \`assertedBy\` — there is no check to demonstrate. A criterion with no `
        + `assertion is one waiting for its check, and calling that non-vacuous is the empty `
        + `population reading as green.`,
    };
  }
  const actor = requireActor(root, input);
  if (isErr(actor)) return actor;

  // Witness what was EXAMINED, which is the criterion's assertion as it stands now — not
  // the hashes frozen at ratification. If the assertion has already moved, this check is
  // about the current code and the ratification witnesses are the stale pair.
  const live = c.assertedBy.length ? await liveHashes(root, c.assertedBy) : new Map<string, string>();
  const check: VacuityCheck = {
    id: mint(), criterionId: c.id, verdict: input.verdict, method: method ?? "",
    witnesses: c.assertedBy.map((id) => ({ anchorId: id, bodyHash: live.get(id) ?? "sha256:absent" })),
    checkedBy: actor, at: now(),
  };

  const d = disposition(await shareVacuityCheck(root, check));
  if ("error" in d) return d;
  if (d.local) await writeLocalVacuityCheck(root, check);
  return { ok: true, id: check.id, check };
}

/**
 * Whether a criterion is strong enough for an audit to rest on it, as one word.
 *
 * Not a gate and deliberately not wired into `recordAudit`: an audit's outcome is about
 * the CODE, and refusing to record one because its criterion is weak would lose the
 * observation entirely. What this does is let a reader see that a green check certifies
 * nothing — which is the whole of COD-18's warning, that `asserted_by` converts *nobody
 * edited the cited code* into *green as of the last build*.
 */
export function assertionStrength(c: ServedCriterion): "sound" | "moved" | "weak" | "none" {
  if (c.unasserted) return "none";
  // `moved` OUTRANKS a live demonstration, and that ordering is deliberate. A criterion
  // can be both — somebody demonstrates the check that is there NOW, while the ratified
  // baseline is older code — and answering `sound` there would say the ratifier's approval
  // still covers a check that has since been rewritten. Demonstrating a rewritten lint can
  // fail does not establish it still detects THIS rule's violation; that is the
  // `wrong-layer` question, and nobody re-asked it. Both raw fields are on the record, so
  // a caller that wants the other reading has it.
  if (c.assertionMoved) return "moved";
  return c.vacuity === "demonstrated" ? "sound" : "weak";
}

/** Every requirement's criteria, for the surfaces that render a rule with its checks. */
export async function criteriaSummary(root: string, requirementId: string): Promise<{
  criteria: ServedCriterion[]; asserted: number; sound: number;
} | Err> {
  if (!(await readRequirement(root, requirementId))) return { error: `no requirement "${requirementId}"` };
  const criteria = await criteriaFor(root, requirementId);
  return {
    criteria,
    asserted: criteria.filter((c) => !c.unasserted).length,
    sound: criteria.filter((c) => assertionStrength(c) === "sound").length,
  };
}
