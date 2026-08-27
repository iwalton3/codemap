/**
 * Requirements — the upstream half of the double gradient (COD-29).
 *
 * A doc explains code, so it is DOWNSTREAM and must cite what it explains; that
 * citation is what makes its staleness detectable. A requirement is UPSTREAM: it is
 * true because somebody with authority decided it, and the code exists to satisfy it.
 * The two have inverted truthmakers, so they get separate records and separate verbs.
 *
 * Three rules hold this module together, and each exists because breaking it
 * reintroduces the defect the record was created to prevent:
 *
 *  1. **No in-place edit.** Nothing here changes a ratified `statement` except
 *     `ratifyAmendment`. There is no `updateRequirement`, deliberately — an edit path
 *     is how "the code drifted" becomes "rewrite the rule to match the code".
 *  2. **Authorship is open; adoption is not.** Any actor may propose. Only a principal
 *     may ratify, reject or retire, and that is a REFUSAL here rather than a line in a
 *     tool description (COD-24: unenforced steering does not reach the consumer, and a
 *     description may not even be sent — see the note above the tool table in mcp.ts).
 *  3. **Nothing in this file computes a status from code.** `recheckDue` is derived at
 *     read time and is a signal ABOUT THE CODE. A requirement has no `stale`, and no
 *     state a reader could clear by editing the statement.
 *
 * Not built yet, and named so their absence is legible: the discrepancy record, the
 * waiver, and the sidecar scope that makes any of this shared. Until the last one lands
 * these are local rows — which is why `ratify` is not yet a claim a teammate can read.
 */

import { randomBytes } from "node:crypto";
import type { Actor, Amendment, AmendmentKind, BugWitness, Requirement } from "./schema.js";
import {
  readAmendment, readAmendments, readRequirement, readRequirements,
  requirementSectionCounts, workHas, writeLocalAmendment, writeLocalRequirement,
} from "./store.js";
import { liveHashes, witnessDrift, realDrift } from "./reviews.js";
import { ABSENT_HASH } from "./normalize.js";
import { isAgentActor, requireActor } from "./identity.js";
import type { ActorInput } from "./identity.js";

const mint = (p: string) => p + randomBytes(6).toString("hex");
const now = () => new Date().toISOString();

export type Err = { error: string };
const isErr = (x: unknown): x is Err => !!x && typeof x === "object" && "error" in (x as object);

/**
 * A requirement as served: the record, plus what is DERIVED about it.
 *
 * `recheckDue` is the whole reason this wrapper exists rather than returning the row.
 * It is not a status and it is not stored — storing it would make it a field, and a
 * field is something an editor can satisfy.
 */
export interface ServedRequirement extends Requirement {
  /**
   * Cited code has moved since ratification. Says the code changed, NOT that the rule
   * is wrong or the record is degraded: somebody should re-check conformance.
   */
  recheckDue: boolean;
  /** Which anchors moved, for a reader who wants to go look. */
  drifted: string[];
  /** Cited anchors that are no longer in the index at all. */
  missing: string[];
}

/**
 * Principal gate. An agent acting for a person is NOT that person for this purpose:
 * `Actor.via` is set, and adoption is the one act that cannot be delegated because it
 * is the act that produces accountability (COD-17 — accountability, never evidence).
 */
function principal(root: string, input: ActorInput, verb: string): Actor | Err {
  const a = requireActor(root, input);
  if (isErr(a)) return a;
  if (isAgentActor(a)) {
    return {
      error:
        `${verb} is a principal's act and this session is an agent acting for ${a.principal}. `
        + `An agent may author and propose; adopting is what makes a claim binding, and it `
        + `cannot be delegated. Ask ${a.principal} to ${verb}.`,
    };
  }
  return a;
}

/**
 * A section is a `/`-delimited path, normalized so that trivially different spellings of
 * one place cannot become two places: segments trimmed, internal whitespace collapsed,
 * empty segments dropped.
 */
function normalizeSection(raw: string): string {
  return raw.split("/").map((seg) => seg.trim().replace(/\s+/g, " ")).filter(Boolean).join("/");
}

/**
 * Refuse a section that differs from an existing one only by case.
 *
 * This is the failure mode free-text grouping actually has, and it is silent: "Credit"
 * and "credit" render as two sections, each looking complete, and nothing anywhere
 * reports that a rule is filed in the wrong one. Normalization above cannot fix it,
 * because both spellings are already normal.
 *
 * Deliberately NOT fuzzy. Matching "Credit Lines" against "Credit" would refuse
 * legitimately new sections, and a guard that cries wolf is turned off. Case and
 * whitespace are the mechanical cases, so they are the ones enforced.
 */
async function checkSection(root: string, section: string): Promise<Err | null> {
  const existing = await requirementSectionCounts(root);
  const clash = existing.find((e) => e.section.toLowerCase() === section.toLowerCase() && e.section !== section);
  return clash
    ? { error: `section "${section}" differs from the existing "${clash.section}" (${clash.count} requirement(s)) only by case — use that one, or pick a genuinely different name` }
    : null;
}

/** Cited anchors must exist WHEN CITED — an empty citation list is fine, a wrong one is not. */
function checkCitations(root: string, cites: string[]): Err | null {
  if (!cites.length) return null;
  let have: Set<string>;
  try {
    have = workHas(root, cites);
  } catch {
    return { error: "this universe is not indexed yet — run `init` before citing anchors" };
  }
  const missing = cites.filter((c) => !have.has(c));
  return missing.length
    ? { error: `unknown anchor(s): ${missing.join(", ")} — a requirement may cite nothing, but not something that does not exist` }
    : null;
}

/** Hashes of the cited code, snapshotted at the moment of adoption. */
async function witness(root: string, cites: string[]): Promise<BugWitness[]> {
  if (!cites.length) return [];
  const live = await liveHashes(root, cites);
  return cites.map((id) => ({ anchorId: id, bodyHash: live.get(id) ?? "sha256:absent" }));
}

async function serve(root: string, r: Requirement): Promise<ServedRequirement> {
  // An unratified requirement has no witnesses, so nothing can have drifted from it.
  // Answering `recheckDue: true` there would be reporting drift from a baseline that
  // was never taken.
  if (!r.witnesses.length) return { ...r, recheckDue: false, drifted: [], missing: [] };
  const live = await liveHashes(root, r.witnesses.map((w) => w.anchorId));
  // `realDrift` filters the changes a normalized re-hash explains away, so a cosmetic
  // edit does not send a reader back to a rule that is still satisfied.
  const changes = realDrift(witnessDrift(r.witnesses, live));
  // `now === ABSENT_HASH` is how `witnessDrift` says the symbol is not in the index —
  // which for a requirement is the more interesting half: cited code that VANISHED is a
  // stronger signal about conformance than cited code that merely changed.
  const missing = changes.filter((c) => c.now === ABSENT_HASH).map((c) => c.anchorId);
  const drifted = changes.filter((c) => c.now !== ABSENT_HASH).map((c) => c.anchorId);
  return { ...r, recheckDue: changes.length > 0, drifted, missing };
}

// --- authoring ---------------------------------------------------------------

/**
 * Propose a requirement. Any actor — agent, human, CI job.
 *
 * It lands `proposed`, which is USABLE and carries no authority. That is what stops the
 * ratification queue becoming a blocker: the queue may run behind without stopping
 * anybody, so the pressure that produces bulk approval never builds. Block laundering on
 * ratification, never work.
 */
export async function proposeRequirement(
  root: string,
  input: { title: string; section: string; statement: string; provenance: string; cites?: string[] } & ActorInput,
): Promise<{ ok: true; id: string; requirement: Requirement } | Err> {
  const statement = input.statement?.trim();
  const provenance = input.provenance?.trim();
  const title = input.title?.trim();
  const section = normalizeSection(input.section ?? "");
  if (!statement) return { error: "a requirement needs a statement" };
  if (!title) return { error: "a requirement needs a title — the name a queue row and an index show" };
  if (!section) {
    return {
      error:
        "a requirement needs a `section` — a `/`-delimited path saying where it files "
        + "(\"Credit/Limits\", \"Settlement/Float\"). Optional organization is no organization, "
        + "and a few hundred unsectioned rules is a heap nothing can be read out of.",
    };
  }
  const clash = await checkSection(root, section);
  if (clash) return clash;
  if (!provenance) {
    return {
      error:
        "a requirement needs `provenance` — where the rule comes from (a contract term, an "
        + "IATA standard, a credit policy, a customer's demand, or our own past choice). It is "
        + "what tells a reader which rules are immovable and which are ours to revisit; a rule "
        + "with no stated source reads as arbitrary and gets worked around.",
    };
  }
  const actor = requireActor(root, input);
  if (isErr(actor)) return actor;
  const cites = input.cites ?? [];
  const bad = checkCitations(root, cites);
  if (bad) return bad;

  const r: Requirement = {
    id: mint("r_"), title, section, statement, provenance, status: "proposed",
    cites, witnesses: [], author: actor, createdAt: now(),
  };
  await writeLocalRequirement(root, r);
  return { ok: true, id: r.id, requirement: r };
}

/**
 * Propose a change to a requirement. Any actor.
 *
 * `kind` is not decoration: it makes the proposer state which side it thinks moves
 * without letting it decide. `requirement-misstated` is the highest-value record the
 * system can hold — the rule did not change, our statement of it was incomplete — and
 * the resilience-engineering literature is emphatic that this gap is frequently not a
 * defect at all. Nothing here makes it harder to file than the others.
 */
export async function proposeAmendment(
  root: string,
  input: {
    requirementId: string; kind: AmendmentKind; rationale: string;
    statement?: string; evidence?: string;
  } & ActorInput,
): Promise<{ ok: true; id: string; amendment: Amendment } | Err> {
  const r = await readRequirement(root, input.requirementId);
  if (!r) return { error: `no requirement "${input.requirementId}"` };
  if (r.status === "retired") return { error: `${r.id} is retired — propose a new requirement rather than amending a withdrawn one` };
  const rationale = input.rationale?.trim();
  if (!rationale) return { error: "an amendment needs a rationale — what provoked it" };

  const statement = input.statement?.trim();
  if (input.kind === "code-wrong") {
    // There is no new text: the claim is that the rule stands and the code violates it.
    // Accepting a statement here would quietly turn "fix the code" into an edit of the
    // rule, which is the exact substitution this whole record kind exists to prevent.
    if (statement) {
      return { error: "`code-wrong` says the rule stands and the code violates it — it takes no `statement`. To propose new text, the kind is `requirement-changed` or `requirement-misstated`." };
    }
  } else if (!statement) {
    return { error: `kind "${input.kind}" proposes new text and needs a \`statement\`` };
  } else if (statement === r.statement) {
    return { error: "the proposed statement is identical to the current one" };
  }

  const actor = requireActor(root, input);
  if (isErr(actor)) return actor;
  const a: Amendment = {
    id: mint("am_"), requirementId: r.id, kind: input.kind,
    ...(statement ? { statement } : {}),
    rationale, ...(input.evidence ? { evidence: input.evidence } : {}),
    status: "pending", author: actor, createdAt: now(),
  };
  await writeLocalAmendment(root, a);
  return { ok: true, id: a.id, amendment: a };
}

// --- adoption (principal only) -----------------------------------------------

/** Adopt a proposed requirement. The act that makes it binding. */
export async function ratifyRequirement(
  root: string, id: string, input: ActorInput = {},
): Promise<{ ok: true; requirement: Requirement } | Err> {
  const who = principal(root, input, "ratify");
  if (isErr(who)) return who;
  const r = await readRequirement(root, id);
  if (!r) return { error: `no requirement "${id}"` };
  if (r.status === "ratified") return { error: `${id} is already ratified` };
  if (r.status === "retired") return { error: `${id} is retired` };

  const next: Requirement = {
    ...r, status: "ratified", ratifiedBy: who, ratifiedAt: now(),
    witnesses: await witness(root, r.cites),
  };
  await writeLocalRequirement(root, next);
  return { ok: true, requirement: next };
}

/**
 * Adopt an amendment — the only path by which a ratified statement changes.
 *
 * A `code-wrong` amendment ratifies to "the rule stands": the statement is untouched and
 * the follow-up is a defect against the code. The discrepancy record will give that a
 * queue; today it is a recorded adjudication and nothing more, which is honest and is
 * better than routing it somewhere that would read as the rule having moved.
 */
export async function ratifyAmendment(
  root: string, amendmentId: string, input: ActorInput = {},
): Promise<{ ok: true; requirement: Requirement; amendment: Amendment; statementChanged: boolean } | Err> {
  const who = principal(root, input, "ratify");
  if (isErr(who)) return who;
  const a = await readAmendment(root, amendmentId);
  if (!a) return { error: `no amendment "${amendmentId}"` };
  if (a.status !== "pending") return { error: `${amendmentId} is already ${a.status}` };
  const r = await readRequirement(root, a.requirementId);
  if (!r) return { error: `amendment ${amendmentId} points at missing requirement ${a.requirementId}` };

  const at = now();
  const decided: Amendment = { ...a, status: "ratified", ratifiedBy: who, ratifiedAt: at };
  await writeLocalAmendment(root, decided);

  if (a.kind === "code-wrong") {
    await writeLocalRequirement(root, { ...r, witnesses: await witness(root, r.cites) });
    const refreshed = (await readRequirement(root, r.id))!;
    return { ok: true, requirement: refreshed, amendment: decided, statementChanged: false };
  }

  // Adopting new text re-baselines the witnesses: the principal has just looked, so the
  // current code is what the ratified rule was adopted against. Leaving the old hashes
  // would serve the fresh ratification as already recheck-due.
  const next: Requirement = {
    ...r, statement: a.statement!, status: "ratified",
    ratifiedBy: who, ratifiedAt: at, witnesses: await witness(root, r.cites),
  };
  await writeLocalRequirement(root, next);
  return { ok: true, requirement: next, amendment: decided, statementChanged: true };
}

export async function rejectAmendment(
  root: string, amendmentId: string, reason: string, input: ActorInput = {},
): Promise<{ ok: true; amendment: Amendment } | Err> {
  const who = principal(root, input, "reject an amendment");
  if (isErr(who)) return who;
  if (!reason?.trim()) return { error: "rejecting an amendment needs a reason — the proposer has to learn something" };
  const a = await readAmendment(root, amendmentId);
  if (!a) return { error: `no amendment "${amendmentId}"` };
  if (a.status !== "pending") return { error: `${amendmentId} is already ${a.status}` };
  const next: Amendment = { ...a, status: "rejected", rejectedBy: who, rejectedAt: now(), rejectedReason: reason.trim() };
  await writeLocalAmendment(root, next);
  return { ok: true, amendment: next };
}

/**
 * Withdraw a requirement. Principal-only for the same reason `ratify` is, and for one
 * more: retire-and-recreate is the obvious way around "no in-place edit", so it has to
 * be gated by whoever the edit path is gated by or the gate is decorative.
 */
export async function retireRequirement(
  root: string, id: string, input: ActorInput = {},
): Promise<{ ok: true; requirement: Requirement } | Err> {
  const who = principal(root, input, "retire a requirement");
  if (isErr(who)) return who;
  const r = await readRequirement(root, id);
  if (!r) return { error: `no requirement "${id}"` };
  if (r.status === "retired") return { error: `${id} is already retired` };
  const next: Requirement = { ...r, status: "retired", retiredBy: who, retiredAt: now() };
  await writeLocalRequirement(root, next);
  return { ok: true, requirement: next };
}

/**
 * Re-file or rename a requirement. Touches organization only — never the statement.
 *
 * Gated like the adoption verbs once a requirement is RATIFIED, and the reason is not
 * symmetry: a title is what most readers read, so retitling a binding rule to agree with
 * the code is laundering that leaves the statement untouched and therefore leaves the
 * amendment trail empty. Before ratification nothing is binding, so the author may still
 * fix their own filing.
 */
export async function reorganizeRequirement(
  root: string, id: string, changes: { title?: string; section?: string }, input: ActorInput = {},
): Promise<{ ok: true; requirement: Requirement } | Err> {
  const r = await readRequirement(root, id);
  if (!r) return { error: `no requirement "${id}"` };

  const actor = requireActor(root, input);
  if (isErr(actor)) return actor;
  const ownProposal = r.status === "proposed" && actor.principal === r.author.principal;
  if (!ownProposal) {
    const who = principal(root, input, "re-file a ratified requirement");
    if (isErr(who)) return who;
  }

  const title = changes.title === undefined ? r.title : changes.title.trim();
  const section = changes.section === undefined ? r.section : normalizeSection(changes.section);
  if (!title) return { error: "a requirement needs a title" };
  if (!section) return { error: "a requirement needs a section" };
  if (title === r.title && section === r.section) return { error: "nothing to change" };
  if (section !== r.section) {
    const clash = await checkSection(root, section);
    if (clash) return clash;
  }

  const next: Requirement = { ...r, title, section };
  await writeLocalRequirement(root, next);
  return { ok: true, requirement: next };
}

// --- reading -----------------------------------------------------------------

/** The section index — what a reader opens before any individual rule. */
export async function requirementSections(root: string): Promise<{ section: string; count: number }[]> {
  return requirementSectionCounts(root);
}

export async function listRequirements(
  root: string, opts: { status?: Requirement["status"]; section?: string } = {},
): Promise<ServedRequirement[]> {
  const { requirements } = await readRequirements(root, opts);
  return Promise.all(requirements.map((r) => serve(root, r)));
}

export async function getRequirement(
  root: string, id: string,
): Promise<{ requirement: ServedRequirement; amendments: Amendment[] } | Err> {
  const r = await readRequirement(root, id);
  if (!r) return { error: `no requirement "${id}"` };
  return { requirement: await serve(root, r), amendments: await readAmendments(root, { requirementId: id }) };
}

/**
 * The ratification queue — what a principal has to dispose of.
 *
 * Carries the blast radius with each row (current text, proposed text, and what else
 * hangs off the requirement) because the whole trade is that a principal reads N
 * requirement diffs instead of 5,000 lines of code. If disposing of one means leaving
 * this surface to go find the cited code or the provoking evidence, the trade fails at
 * its last step and the process reverts to reading code.
 */
export async function pendingAmendments(root: string): Promise<{
  amendment: Amendment;
  requirement: ServedRequirement;
  /** How many other amendments are pending against the same requirement. */
  alsoPending: number;
}[]> {
  const pending = await readAmendments(root, { status: "pending" });
  const counts = new Map<string, number>();
  for (const a of pending) counts.set(a.requirementId, (counts.get(a.requirementId) ?? 0) + 1);

  const served = new Map<string, ServedRequirement>();
  const out: { amendment: Amendment; requirement: ServedRequirement; alsoPending: number }[] = [];
  for (const a of pending) {
    let r = served.get(a.requirementId);
    if (!r) {
      const row = await readRequirement(root, a.requirementId);
      // A pending amendment whose requirement is gone is not renderable, and dropping it
      // silently would hide it from the only queue that would surface it. It cannot
      // happen through this module — nothing deletes a requirement — so if it appears,
      // it came from somewhere that should be found rather than tolerated.
      if (!row) throw new Error(`amendment ${a.id} points at missing requirement ${a.requirementId}`);
      r = await serve(root, row);
      served.set(a.requirementId, r);
    }
    out.push({ amendment: a, requirement: r, alsoPending: (counts.get(a.requirementId) ?? 1) - 1 });
  }
  return out;
}
