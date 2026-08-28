/**
 * Audits, and the conformance classification they decide (COD-29).
 * `docs/requirements-architecture.md` is normative; this implements it.
 *
 * An audit records that somebody checked a rule against the code, and **what they did**.
 * It is produced whether or not anything was found, because a positive audit is the only
 * record that can do two jobs nothing else can:
 *
 *  1. **Close a gap.** A gap has no code to witness, so it cannot drift and would
 *     otherwise outlive its truth in silence. A positive audit is the event that says the
 *     code now exists and conforms.
 *  2. **Make a regression detectable.** Once a rule has been met, a later failure is a
 *     problem rather than a gap that was always there.
 *
 * The non-vacuity rule is enforced here rather than asked for. A positive audit has an
 * EFFECT — it closes a gap and silences the mechanism that would have caught the thing —
 * so *"I checked and it conforms"* from an actor that did not really check manufactures
 * confidence and disables the detector at the same time. Prompt wording cannot fix that:
 * steering is not merely ignorable, it may never be sent (see the note above the tool table
 * in `mcp.ts`). So an audit that records nothing about what it read or ran cannot claim an
 * outcome, and doc-only evidence does not reach `conformant`.
 *
 * Not built: the problem record a nonconformant audit should file, and the population
 * predicate — without which "no code should conform to this yet" means "I looked and did
 * not find any".
 */

import { randomBytes } from "node:crypto";
import type {
  Actor, Audit, AuditEvidence, AuditOutcome, AuditTrigger, BugWitness, Requirement,
} from "./schema.js";
import { AUDIT_TRIGGERS, COVERING_TRIGGERS } from "./schema.js";
import {
  readAcknowledgements, readAudits, readPointers, readRequirement, readRequirements,
  workHas, writeLocalAudit,
} from "./store.js";
import { liveHashes, witnessDrift, realDrift } from "./reviews.js";
import { currentBranch, headCommit, isDirty, isGitRepo, onDefaultBranch } from "./git.js";
import { requireActor } from "./identity.js";
import { universeKey } from "./sidecar-config.js";
import type { ActorInput } from "./identity.js";
import { disposition, shareAudit } from "./standard-publish.js";
import { releaseAcknowledgement, type ServedAcknowledgement } from "./acknowledgements.js";

const mint = () => "au_" + randomBytes(6).toString("hex");
const now = () => new Date().toISOString();

export type Err = { error: string };
const isErr = (x: unknown): x is Err => !!x && typeof x === "object" && "error" in (x as object);

const OUTCOMES: AuditOutcome[] = ["conformant", "nonconformant", "indeterminate"];

/**
 * Did the auditor touch the code, as opposed to only reading about it?
 *
 * The distinction is load-bearing rather than descriptive: a doc-only pass inherits the
 * doc's errors and fails SILENTLY, yielding a pass rather than a flag. COD-27's incurious
 * map-backed agent is the nearest measurement, and it must be read carefully — its
 * instructions told it not to double-check in order to save tokens, so the incuriosity was
 * bought rather than inherent. The general lesson is the useful one: **verification effort
 * is a policy setting, and economising on it buys a silent pass.** Here, economising simply
 * does not buy the state change.
 */
const touchedCode = (e: AuditEvidence): boolean =>
  // A command that FAILED is evidence of non-conformance, never of conformance. Counting
  // any nonempty `ran` let `{ command: "false", passed: false }` certify a rule.
  //
  // And it must NAME the command: `{ passed: true }` alone records nothing that was run,
  // so it is the vacuous audit wearing the shape of evidence — and where the requirement
  // cites code, `read` picks those citations up as witnesses and the result reads as
  // code-backed. `recordAudit` refuses such an entry outright rather than quietly
  // declining to count it, so the caller learns what the field is for.
  !!(e.read?.length || e.ran?.some((r) => r.passed && !!r.command?.trim()));

/** Any evidence at all — enough to file a finding, not enough to certify one. */
const hasEvidence = (e: AuditEvidence): boolean => touchedCode(e) || !!e.consulted?.length;

export interface ServedAudit extends Audit {
  /**
   * The code this audit examined has moved since. The audit is not wrong — it was true of
   * the code it read — but it no longer speaks about what is there now.
   */
  superseded: boolean;
  drifted: string[];
}

async function serve(root: string, a: Audit): Promise<ServedAudit> {
  if (!a.witnesses.length) return { ...a, superseded: false, drifted: [] };
  const live = await liveHashes(root, a.witnesses.map((w: BugWitness) => w.anchorId));
  const changes = realDrift(witnessDrift(a.witnesses, live));
  return { ...a, superseded: changes.length > 0, drifted: changes.map((c) => c.anchorId) };
}

// --- recording ---------------------------------------------------------------

/**
 * Record an audit. Open to any actor — establishing conformance is exactly what an
 * auditor agent is for, and this record makes no adjudication.
 *
 * The refusals are about EVIDENCE, in both directions:
 *
 *  - `conformant` needs code touched. Doc-only is recorded as `indeterminate` territory,
 *    never as a certification.
 *  - `nonconformant` needs evidence too. *"I could not verify this"* is not a
 *    non-conformance, it is an unverified requirement, and absence of evidence must never
 *    file — without that gate this becomes the 138-false-positives problem again.
 *  - `indeterminate` is the quiet bucket, and the only outcome that may carry nothing.
 */
export async function recordAudit(
  root: string,
  input: {
    requirementId: string; outcome: AuditOutcome; finding: string; evidence?: AuditEvidence;
    promotedFrom?: string; trigger?: AuditTrigger;
    observations?: { pointerId: string; firing: boolean }[];
  } & ActorInput,
): Promise<{ ok: true; id: string; audit: Audit; released: string[] } | Err> {
  if (!OUTCOMES.includes(input.outcome)) return { error: `outcome must be one of ${OUTCOMES.join(" | ")}` };
  const trigger: AuditTrigger = input.trigger ?? "ad-hoc";
  if (!AUDIT_TRIGGERS.includes(trigger)) return { error: `trigger must be one of ${AUDIT_TRIGGERS.join(" | ")}` };
  const finding = input.finding?.trim();
  if (!finding) return { error: "an audit needs a finding — what you concluded, in your own words" };
  const r = await readRequirement(root, input.requirementId);
  if (!r) return { error: `no requirement "${input.requirementId}"` };

  const evidence: AuditEvidence = input.evidence ?? {};
  if ((evidence.ran ?? []).some((r) => !r?.command?.trim())) {
    return {
      error:
        "every entry in `evidence.ran` needs the `command` you actually ran. An entry with "
        + "only `passed` records nothing, and a positive audit that records nothing is not a "
        + "positive audit — it closes a gap and silences the detector on the strength of an "
        + "empty claim.",
    };
  }
  // Witness the cited code as well as what was read. `touchedCode` accepts `ran` alone,
  // and an audit built only from `evidence.read` then had NO witnesses — so nothing could
  // ever supersede it and `conformant` became permanent, surviving a rewrite of the very
  // code it certified. That is "unknown must never render as conformant" failing in the
  // one direction the design forbids.
  const read = [...new Set([...(evidence.read ?? []), ...r.cites])];
  if (input.outcome === "conformant" && !touchedCode(evidence)) {
    return {
      error:
        "a `conformant` audit must record code it READ or a command it RAN. Consulting "
        + "documentation is not enough: a stale or missing doc yields a pass rather than a "
        + "flag, so a doc-only check certifies nothing. Record `evidence.read` / "
        + "`evidence.ran`, or file this as `indeterminate`.",
    };
  }
  if (input.outcome === "conformant" && !read.length) {
    return {
      error:
        "a `conformant` audit needs something that could later invalidate it — anchors in "
        + "`evidence.read`, or a requirement that cites code. With neither, nothing can ever "
        + "supersede the claim and it would read as verified for ever. A claim nothing can "
        + "invalidate is not a claim.",
    };
  }
  if (input.outcome === "nonconformant" && !hasEvidence(evidence)) {
    return {
      error:
        "a `nonconformant` audit needs demonstrated non-conformance. \"I could not verify "
        + "this\" is an unverified requirement, not a violation — file it as `indeterminate`, "
        + "which is the quieter bucket it belongs in.",
    };
  }

  // Only what the CALLER supplied. This validated the merged list, `r.cites` included, so
  // a rule whose cited symbol had been renamed — which changes the anchor id, and is
  // ordinary in the target codebase — could never be audited again in any outcome, not even
  // `indeterminate`, "the quiet bucket, and the only outcome that may carry nothing". The
  // rule was then pinned at `unknown` for good, and the error named ids the caller had not
  // passed. A citation that left the tree is what `ServedRequirement.missing` reports and
  // what a `sha256:absent` witness records; it is not a malformed audit.
  const supplied = evidence.read ?? [];
  if (supplied.length) {
    let have: Set<string>;
    try { have = workHas(root, supplied); } catch { have = new Set(); }
    const unknown = supplied.filter((id) => !have.has(id));
    if (unknown.length) return { error: `unknown anchor(s) in evidence.read: ${unknown.join(", ")}` };
  }

  const actor = requireActor(root, input);
  if (isErr(actor)) return actor;
  const live = read.length ? await liveHashes(root, read) : null;
  // Off the default branch this is about somebody's work in progress, not about the
  // codebase — so it is recorded and never broadcast. See `standard-publish.ts`.
  //
  // A DIRTY TREE is the same thing wearing the branch's name: the witnesses come off the
  // filesystem while `commit` records an unchanged HEAD, so sharing it attributes
  // uncommitted work to a commit that does not contain it. codemap has shipped this exact
  // confusion once already, as the dirty-snapshot witness (COD-3).
  // A COVERING audit resets the rule's coverage deadline, which is the quieting direction,
  // so it has to say what every active pointer was doing — no omissions and no phantoms,
  // and no pointer twice. Without that, "I looked" buys a fresh period on a self-report,
  // and a repeated observation reaches `minObservations` from a single call.
  const observations = input.observations ?? [];
  if (COVERING_TRIGGERS.includes(trigger)) {
    // A retired rule is not on the schedule, so there is no deadline for a covering audit
    // to reset. An `ad-hoc` or `differential` audit of one is still allowed: that is
    // history, and refusing it would lose an observation somebody actually made.
    if (r.status === "retired") return { error: `${r.id} is retired — a rule that does not bind is not on the schedule` };
    const active = await readPointers(root, { requirementId: r.id, state: "active" });
    const seen = new Set(observations.map((o) => o.pointerId));
    const missed = active.filter((p) => !seen.has(p.id));
    if (missed.length) {
      return {
        error:
          `a \`${trigger}\` audit resets this rule's coverage deadline, so it must say what all `
          + `${active.length} of its active pointer(s) were doing — missing ${missed.map((p) => p.id).join(", ")}. `
          + `A rule with nothing watching it observes nothing, and recording that is the finding.`,
      };
    }
    const phantom = observations.filter((o) => !active.some((p) => p.id === o.pointerId));
    if (phantom.length) return { error: `observed pointer(s) that are not active on ${r.id}: ${phantom.map((o) => o.pointerId).join(", ")}` };
    if (seen.size !== observations.length) {
      return { error: "the same pointer is observed twice — one look counted as several is how a rate stops being a rate" };
    }
  } else if (observations.length) {
    // A differential or ad-hoc audit looked at what MOVED, not at the whole watching
    // apparatus, so letting it carry observations would feed the coverage rate from a pass
    // that never covered anything — and reset nothing, which is the honest half.
    return { error: `\`observations\` belong to a ${COVERING_TRIGGERS.join(" or ")} audit; a \`${trigger}\` one covers what moved, not what did not` };
  }
  if (observations.some((o) => typeof o.firing !== "boolean")) {
    return { error: "every observation needs `firing: true|false` — that boolean IS the history a rate is derived from" };
  }

  const provisional = !onDefaultBranch(root) || (isGitRepo(root) && isDirty(root));
  const audit: Audit = {
    id: mint(), requirementId: r.id, universe: universeKey(root), outcome: input.outcome, evidence, finding,
    witnesses: read.map((id) => ({ anchorId: id, bodyHash: live?.get(id) ?? "sha256:absent" })),
    auditor: actor, at: now(), trigger,
    ...(observations.length ? { observations } : {}),
    commit: isGitRepo(root) ? headCommit(root) : null,
    branch: isGitRepo(root) ? currentBranch(root) : null,
    ...(provisional ? { provisional: true } : {}),
    ...(input.promotedFrom ? { promotedFrom: input.promotedFrom } : {}),
  };
  const d = disposition(await shareAudit(root, audit));
  if ("error" in d) return d;
  if (d.local) await writeLocalAudit(root, audit);
  return { ok: true, id: audit.id, audit, released: await settleAcknowledgements(root, audit) };
}

/**
 * An audit result can falsify what an acknowledgement asserts, and then the record has to
 * go — a silencer nobody rechecks is how a standard comes to look satisfied.
 *
 * Releasing is the safe direction (its failure mode is noise), so this is automatic where
 * granting never could be.
 */
async function settleAcknowledgements(root: string, audit: Audit): Promise<string[]> {
  // A provisional audit settles NOTHING. Releasing is a shared act, and releasing on the
  // strength of branch work would un-silence a rule for the whole team on evidence that
  // may never merge — and cite an audit id no other clone can resolve. The audit itself
  // stays local; this is the second half of that, and it was missing.
  if (audit.provisional) return [];
  const active = await readAcknowledgements(root, { requirementId: audit.requirementId, state: "active" });
  const released: string[] = [];
  for (const a of active) {
    // A conformant audit pays both: the work is done, whatever the record said.
    // A nonconformant one falsifies a GAP specifically — a gap claims no code that should
    // conform exists, and the audit just found some that does not. Debt survives it,
    // because debt and non-conformance are consistent by construction.
    const falsified = audit.outcome === "conformant"
      || (audit.outcome === "nonconformant" && a.basis === "gap");
    if (!falsified) continue;
    const reason = audit.outcome === "conformant"
      ? `audit ${audit.id} found the rule met`
      : `audit ${audit.id} found code that does not conform — this was recorded as a gap, which claims there is none`;
    const done = await releaseAcknowledgement(root, a.id, reason, { principal: audit.auditor.principal });
    if (!isErr(done)) released.push(a.id);
  }
  return released;
}

// --- reading -----------------------------------------------------------------

/**
 * Provisional findings whose evidence still holds on the codebase.
 *
 * The question this answers is what becomes of a branch audit after the branch merges,
 * and the tempting answers are both wrong. Publishing every provisional failure on merge
 * floods the team with findings that were fixed before they ever landed. Concluding
 * anything from the commit being an ANCESTOR of the default branch is unsound in the
 * other direction: a commit being in history does not mean the code is still that way,
 * because a later commit on the same branch may have fixed it.
 *
 * The sound discriminator is the one this codebase already uses everywhere — **the
 * witnesses**. If the hashes the audit recorded still match live code, the exact source it
 * examined is verbatim present, so the finding still holds and it is evidence rather than
 * inference. If they differ, the audit is superseded and says nothing; it falls away
 * silently, which is precisely the no-noise answer for the fixed case.
 *
 * Note what is NOT here: nothing about merging ever makes anything `conformant`. Only a
 * positive audit does that, so there is no path by which code passes by having landed.
 *
 * Derived, so nobody has to remember; and promotion is an explicit act, because
 * broadcasting a finding to the team without a decision is the thing being avoided.
 */
export async function promotableAudits(root: string): Promise<ServedAudit[]> {
  if (!onDefaultBranch(root)) return [];
  const all = await readAudits(root);
  const alreadyPromoted = new Set(all.map((a) => a.promotedFrom).filter(Boolean) as string[]);
  const out: ServedAudit[] = [];
  for (const a of all) {
    if (!a.provisional || a.outcome !== "nonconformant" || !a.witnesses.length) continue;
    // A promoted finding stays non-superseded for ever — the code it cited is exactly
    // what is there — so without this it would offer itself again on every read.
    if (alreadyPromoted.has(a.id)) continue;
    const served = await serve(root, a);
    if (!served.superseded) out.push(served);
  }
  return out;
}

/**
 * Re-record a provisional finding as an observation of the codebase.
 *
 * A NEW audit rather than a rewrite of the old one: the original was taken on a branch and
 * saying otherwise would falsify its own record. What is fresh here is the claim that the
 * same evidence applies to the default branch — which `promotableAudits` has just
 * established from the hashes rather than from anybody's assertion.
 */
export async function promoteProvisionalAudit(
  root: string, auditId: string, input: ActorInput = {},
): Promise<{ ok: true; id: string; audit: Audit } | Err> {
  if (!onDefaultBranch(root)) {
    return { error: "promotion is a claim about the codebase, so it must be made from the default branch" };
  }
  const original = (await readAudits(root)).find((a) => a.id === auditId);
  if (!original) return { error: `no audit "${auditId}"` };
  if (!original.provisional) return { error: `${auditId} is already an audit of the codebase` };
  if (original.outcome !== "nonconformant") {
    return { error: `only a nonconformant finding is promotable — nothing about a merge makes code conformant` };
  }
  const served = await serve(root, original);
  if (served.superseded || !original.witnesses.length) {
    return {
      error:
        `${auditId} examined code that has since changed, so it says nothing about what is here now. `
        + `Re-audit rather than promote: concluding from the merge alone is how a finding survives its own fix.`,
    };
  }
  return recordAudit(root, {
    ...input, promotedFrom: original.id,
    requirementId: original.requirementId, outcome: "nonconformant",
    finding: `${original.finding} (promoted from provisional audit ${original.id} on ${original.branch ?? "a branch"}; the cited code is unchanged)`,
    evidence: original.evidence,
  });
}

export async function auditsFor(root: string, requirementId: string): Promise<ServedAudit[]> {
  const rows = await readAudits(root, { requirementId });
  return Promise.all(rows.map((a) => serve(root, a)));
}

/**
 * What state the system is in relative to a rule.
 *
 * Four states, and the fourth is the dangerous one: **`unknown` must never render as
 * `conformant`**. A standard that looks satisfied because it is merely unexamined is
 * confidence manufactured at scale — a vacuous test one level up — and at seeding scale
 * most harvested criteria land exactly there.
 *
 * The order of resolution matters and is not arbitrary:
 *
 *  1. A **live** nonconformant audit is the strongest thing anyone knows. Debt exists to
 *     silence it, so the acknowledgement decides how it reads, not the audit.
 *  2. An acknowledgement is the next word: somebody looked and decided to accept this.
 *  3. A **live** conformant audit reaches `conformant`.
 *  4. Everything else is `unknown` — including a SUPERSEDED conformant audit, because
 *     nobody has checked the code that is actually there. That the rule was once met is
 *     kept on the record rather than in the state, which is what makes a later failure a
 *     regression rather than a gap that was always there.
 */
export type Conformance = "conformant" | "gap" | "debt" | "unknown";

export interface RequirementConformance {
  requirement: Requirement;
  conformance: Conformance;
  acknowledgements: ServedAcknowledgement[];
  /** The most recent audit, whatever it said. */
  lastAudit?: ServedAudit;
  /** It was conformant once, and the code has moved since. */
  wasConformant: boolean;
}

export async function conformance(
  root: string, opts: { asOf?: string } = {},
): Promise<RequirementConformance[]> {
  const asOf = opts.asOf ?? now();
  // A retired rule is not part of the current standard, so counting it as unexamined
  // misstates how much of what is IN FORCE nobody has checked — retire fifty and
  // `silenced().unknown` jumps by fifty.
  const { requirements } = await readRequirements(root, { status: "ratified" });
  const { listAcknowledgements } = await import("./acknowledgements.js");
  const out: RequirementConformance[] = [];
  for (const requirement of requirements) {
    const acks = await listAcknowledgements(root, { requirementId: requirement.id, state: "active", asOf });
    const audits = await auditsFor(root, requirement.id);
    const last = audits[audits.length - 1];
    const live = audits.filter((a) => !a.superseded);
    const liveConformant = live.some((a) => a.outcome === "conformant");
    const liveNonconformant = live.some((a) => a.outcome === "nonconformant");
    const wasConformant = audits.some((a) => a.outcome === "conformant");

    const basis = acks.some((a) => a.basis === "debt") ? "debt"
      : acks.some((a) => a.basis === "gap") ? "gap"
        : undefined;

    const state: Conformance = basis ?? (liveNonconformant ? "unknown" : liveConformant ? "conformant" : "unknown");
    out.push({
      requirement, conformance: state, acknowledgements: acks,
      ...(last ? { lastAudit: last } : {}), wasConformant,
    });
  }
  return out;
}

/** How much of the standard is currently silenced, checked, or simply unexamined. */
export async function silenced(root: string, opts: { asOf?: string } = {}): Promise<{
  total: number; conformant: number; gap: number; debt: number; unknown: number;
  due: number; regressed: number;
}> {
  const rows = await conformance(root, opts);
  const { dueForRevalidation } = await import("./acknowledgements.js");
  const count = (c: Conformance) => rows.filter((r) => r.conformance === c).length;
  return {
    total: rows.length,
    conformant: count("conformant"),
    gap: count("gap"),
    debt: count("debt"),
    unknown: count("unknown"),
    due: (await dueForRevalidation(root, opts)).length,
    // Met once, and no longer known to be. The signal a never-audited rule cannot give.
    regressed: rows.filter((r) => r.wasConformant && r.conformance !== "conformant").length,
  };
}
