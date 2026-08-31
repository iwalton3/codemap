/**
 * Requirements, specs and the fold that turns one into the other (COD-29).
 * `docs/requirements-architecture.md` is normative; this implements it.
 *
 * A doc explains code, so it is DOWNSTREAM and must cite what it explains; that citation
 * is what makes its staleness detectable. A requirement is UPSTREAM: it is true because
 * somebody with authority decided it, and the code exists to satisfy it. The two have
 * inverted truthmakers, so they get separate records and separate verbs.
 *
 * Four rules hold this module together, and each exists because breaking it reintroduces
 * the defect the record was created to prevent:
 *
 *  1. **The standard is a projection of the ratified specs.** Nothing writes a requirement
 *     except `ratifySpec` applying an operation. There is no `updateRequirement`, and no
 *     second cheaper path for a one-line change — a single amendment is a spec with one
 *     operation. Two paths to amend means the cheap one is the real policy.
 *  2. **Authorship is open; adoption is not.** Any actor may draft and propose. Only a
 *     principal may ratify, and that is a REFUSAL here rather than a line in a tool
 *     description (COD-24, and a description may not even be sent — see the note above the
 *     tool table in `mcp.ts`).
 *  3. **Every operation carries the state it was written against, and the fold verifies
 *     it.** An instruction with no context applies cleanly to the wrong thing.
 *  4. **Nothing here computes a status from code.** `recheckDue` is derived at read time
 *     and is a signal ABOUT THE CODE. A requirement has no `stale`, and no state a reader
 *     could clear by editing the statement.
 *  5. **Immutability attaches at RATIFICATION, not at drafting.** Rule 1 is about the
 *     STANDARD, and reading it as covering a proposal is what left a draft with no
 *     correction path at all. A draft binds nothing, so `reviseSpec`, `reviseOperation`,
 *     `removeOperation` and author-withdrawal exist and are open to any actor — and every
 *     one of them is refused the moment `status != draft`, here and in `foldStandard`.
 *     See § *Correcting a draft* below and `docs/requirements-architecture.md`.
 */

import { randomBytes } from "node:crypto";
import type {
  AcceptanceCriterion, Acknowledgement, Actor, Audit, BugWitness, EvidenceKind, Operation,
  OperationKind, Pointer, Problem, ProposalWitness, Requirement, Reversibility, SignOffAxis, Spec,
} from "./schema.js";
import {
  contentDiff, criterionIdFor, EVIDENCE_KINDS, framingContent, movedSection, normalizeSection,
  operationContent, requirementIdFor, SIGN_OFF_AXES, witnessHash,
} from "./schema.js";
import { universeKey } from "./sidecar-config.js";
import {
  readAcknowledgements, readAudits, readCriteria, readOperations, readPopulations, readProblems,
  readOperation, readProposalWitnesses, readRequirement, readRequirements, readSpec, readSpecs,
  readVacuityChecks, writeLocalProposalWitness,
  readPointers, requirementSectionCounts, writeLocalCriterion, writeLocalOperation,
  writeLocalRequirement, writeLocalSpec, deleteLocalCriterion, deleteLocalRequirement,
} from "./store.js";
import { liveHashes, liveIndex, witnessDrift, realDrift } from "./reviews.js";
import { ABSENT_HASH } from "./normalize.js";
import { isAgentActor, requireActor, resolvePrincipal } from "./identity.js";
import type { ActorInput } from "./identity.js";
import {
  disposition, shareOperation, shareOperationRemoved, shareOperationRevised, shareSpecDrafted,
  relianceEverywhere,
  shareSpecRatified, shareSpecReviewed, shareSpecRevised, shareSpecWithdrawn, type Shared,
} from "./standard-publish.js";
import { reviewComplete, reviewGap, type ReviewGap } from "./shared-standard.js";

const mint = (p: string) => p + randomBytes(6).toString("hex");

const now = () => new Date().toISOString();

export type Err = { error: string };
const isErr = (x: unknown): x is Err => !!x && typeof x === "object" && "error" in (x as object);

const REVERSIBILITY: Reversibility[] = ["reversible", "irreversible", "unknown"];

/**
 * A requirement as served: the record, plus what is DERIVED about it.
 *
 * `recheckDue` is the whole reason this wrapper exists rather than returning the row. It
 * is not a status and it is not stored — storing it would make it a field, and a field is
 * something an editor can satisfy.
 */
export interface ServedRequirement extends Requirement {
  /**
   * Cited code has moved since ratification. Says the code changed, NOT that the rule is
   * wrong or the record is degraded: somebody should re-check conformance.
   */
  recheckDue: boolean;
  drifted: string[];
  /** Cited anchors no longer in the index at all — the stronger conformance signal. */
  missing: string[];
  /**
   * Some operation that shaped this rule was declared irreversible.
   *
   * Surfaced on the requirement and not only on the spec that introduced it, because it
   * constrains the FUTURE: the next amendment may be unimplementable, or implementable
   * only at further cost, and whoever opens one has to see that before drafting.
   */
  irreversible: boolean;
}

/**
 * Principal gate. An agent acting for a person is NOT that person here: `Actor.via` is
 * set, and adoption is the one act that cannot be delegated, because it is the act that
 * produces accountability (COD-17 — accountability, never evidence).
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
 * Refuse a section differing from an existing one only by case.
 *
 * This is the failure mode free-text grouping actually has, and it is silent: "Credit" and
 * "credit" render as two sections, each looking complete, and nothing reports that a rule
 * is filed in the wrong one. Normalization cannot fix it — both spellings are already
 * normal. Deliberately NOT fuzzy: matching "Credit Lines" against "Credit" would refuse
 * legitimately new sections, and a guard that cries wolf is turned off.
 */
async function checkSection(root: string, section: string, alsoInPlay: string[] = []): Promise<Err | null> {
  const existing = await requirementSectionCounts(root);
  const clash = existing.find((e) => e.section.toLowerCase() === section.toLowerCase() && e.section !== section);
  if (clash) {
    return { error: `section "${section}" differs from the existing "${clash.section}" (${clash.count} requirement(s)) only by case — use that one, or pick a genuinely different name` };
  }
  // Sections THIS spec is introducing have no rows yet, so comparing against the store
  // alone lets one spec open "Credit/Limits" and "credit/limits" in the same breath —
  // the exact silent split the guard exists to prevent, walking straight past it.
  const sibling = alsoInPlay.find((x) => x.toLowerCase() === section.toLowerCase() && x !== section);
  return sibling
    ? { error: `section "${section}" differs from "${sibling}", which this same spec already introduces, only by case — pick one` }
    : null;
}

/** The sections a spec's `add_requirement` operations bring into existence. */
const sectionsIntroducedBy = (ops: Operation[]): string[] =>
  ops.filter((o) => o.kind === "add_requirement" && o.section).map((o) => o.section!);

/**
 * Refuse a section move that cannot mean what it says.
 *
 * The collision rule is exact rather than conservative, and it has to be: moved rules land
 * at `to + suffix`, so the only real hazard is a produced path an existing rule already
 * occupies — two rules from different origins silently sharing one heading, which is the
 * conflation a section index exists to prevent. Refusing every landing inside an occupied
 * subtree would also refuse `Credit` → `Risk` beside an untouched `Risk/Legacy`, which is
 * an ordinary re-parent, and a guard that cries wolf is turned off (see `checkSection`).
 */
async function checkMove(
  root: string, from: string, to: string, alsoInSpec: Operation[] = [],
): Promise<Err | null> {
  // A section this same spec introduces counts on BOTH sides. It has no row yet, so a
  // store-only view refuses a legitimate "create the rules, then move the subtree" spec
  // and — the direction that matters — misses a move that lands on top of a heading the
  // spec itself is opening, which is the merge this refuses everywhere else.
  const sibling = sectionsIntroducedBy(alsoInSpec);
  const moving = (sec: string) => sec === from || sec.startsWith(`${from}/`);
  const { requirements } = await readRequirements(root, { section: from });
  if (!requirements.length && !sibling.some(moving)) {
    return {
      error:
        `no section "${from}" — nothing files there, so there is nothing to move. Sections are `
        + `derived from the rules filed in them; check the spelling against \`requirement_sections\`.`,
    };
  }
  const existing = await requirementSectionCounts(root);
  const produced = new Set(
    [...requirements.map((r) => r.section), ...sibling.filter(moving)].map((sec) => movedSection(sec, from, to)),
  );
  // A section inside the moving subtree is about to be VACATED, so it is never a collision
  // with itself — `A` → `A/B` produces `A/B`, and any rule already at `A/B` is under `A`
  // and moves too. Only a path that stays put can be landed on.
  const occupied = [
    ...existing.filter((e) => !moving(e.section)).map((e) => ({ section: e.section, who: `${e.count} rule(s) already file` })),
    ...sibling.filter((sec) => !moving(sec)).map((sec) => ({ section: sec, who: "this same spec opens" })),
  ];
  const collision = occupied.find((e) => produced.has(e.section));
  if (collision) {
    return {
      error:
        `moving "${from}" to "${to}" would land rules in "${collision.section}", where `
        + `${collision.who}. That MERGES two sections: the standard's index is how a reader finds `
        + `the rule governing an area, and two origins under one heading is what makes it stop `
        + `answering. Move to a path nothing occupies, or re-file the rules individually so each `
        + `move is a decision somebody made.`,
    };
  }
  // The case-variant guard, done HERE rather than through `checkSection`, because that one
  // compares against every existing heading — including the subtree being moved. Under it
  // `credit` → `Credit` is refused as a case variant of itself, and that rename is the
  // documented REPAIR for the split `checkSection` exists to warn about. Only a heading
  // that stays put can be the thing `to` is confusable with.
  const variant = occupied.find((e) => e.section.toLowerCase() === to.toLowerCase() && e.section !== to);
  if (variant) {
    return {
      error:
        `"${to}" differs from "${variant.section}" (${variant.who}) only by case — two spellings `
        + `of one place render as two sections, each looking complete. Use that one, or pick a `
        + `genuinely different name.`,
    };
  }
  // Two moves whose subtrees overlap apply in `ord` order and the second one reads the
  // output of the first, so the rendering a principal approved shows neither where the
  // rules end up nor that the order decided it. Same hazard as two amendments on one rule.
  const overlap = alsoInSpec.find((o) =>
    o.kind === "move_section" && !!o.fromSection
    && (o.fromSection === from || from.startsWith(`${o.fromSection}/`) || o.fromSection.startsWith(`${from}/`)));
  if (overlap) {
    return {
      error:
        `${overlap.id} already moves "${overlap.fromSection}" in this spec, and "${from}" overlaps it. `
        + `Two overlapping moves apply in order and the second sees the first's output, so the `
        + `before/after a reviewer reads is not what lands. Say the whole re-organization as one move.`,
    };
  }
  return null;
}

/**
 * Hashes of the cited code, snapshotted at the moment of adoption.
 *
 * Every caller passes `[]` today — a rule is upstream of code and a criterion's detector is
 * a pointer, so neither has a body to baseline. Kept as the seam rather than inlined,
 * because the witness payload rides on the ratification EVENT and changing its shape is a
 * fold change. `checkCitations`, the gate that stood beside this, went with the citations.
 */
async function witness(root: string, cites: string[]): Promise<BugWitness[]> {
  if (!cites.length) return [];
  const { live, absent } = await liveIndex(root, cites);
  // `checkCitations` gates every path here, so an absent id means the tree moved between
  // the two calls. Recorded rather than thrown — but `sha256:absent` is the hash that
  // cannot drift, so it must not pass silently.
  if (absent.length) throw new Error(`anchor(s) left the tree between validation and witnessing: ${absent.join(", ")}`);
  return cites.map((id) => ({ anchorId: id, bodyHash: live.get(id)! }));
}

async function serve(root: string, r: Requirement): Promise<ServedRequirement> {
  const ops = await readOperations(root, { requirementId: r.id });
  const irreversible = ops.some((o) => o.reversibility === "irreversible");

  // Staleness comes from the POINTERS, because a requirement cites nothing. A rule is
  // upstream of code and does not point down at an implementation; where the code is
  // lives in auditor-maintained pointers, which is also the only record that knows WHICH
  // REPOSITORY it is talking about.
  //
  // This universe's pointers only. The standard is workspace-scoped and a rule may be
  // watched in several universes, but their anchors are not in this store and cannot be
  // hashed from here — so a rule watched only elsewhere reads `recheckDue: false` HERE,
  // which is honest: this checkout has nothing to say about it. A pointer written before
  // the split carries no universe and is this one's by construction.
  const mine = universeKey(root);
  const pointers = (await readPointers(root, { requirementId: r.id, state: "active" }))
    .filter((p) => !p.universe || p.universe === mine);
  const witnesses = pointers.flatMap((p) => p.witnesses);
  // Nothing watching it here, so nothing can have drifted. A rule with no pointer at all
  // can never rise — that is the `unwatched` half of the audit queue, reported there
  // rather than disguised as calm freshness.
  if (!witnesses.length) return { ...r, recheckDue: false, drifted: [], missing: [], irreversible };
  const live = await liveHashes(root, witnesses.map((w: BugWitness) => w.anchorId));
  // `realDrift` drops the changes a scheme difference explains away, so a re-normalization
  // does not send every reader back to a rule that is still satisfied.
  const changes = realDrift(witnessDrift(witnesses, live));
  const missing = [...new Set(changes.filter((c) => c.now === ABSENT_HASH).map((c) => c.anchorId))];
  const drifted = [...new Set(changes.filter((c) => c.now !== ABSENT_HASH).map((c) => c.anchorId))];
  return { ...r, recheckDue: changes.length > 0, drifted, missing, irreversible };
}

// --- authoring ---------------------------------------------------------------

/** Open a spec. Any actor — agent, human, CI job. */
export async function draftSpec(
  root: string, input: { title: string; narrative?: string } & ActorInput,
): Promise<{ ok: true; id: string; spec: Spec } | Err> {
  const title = input.title?.trim();
  if (!title) return { error: "a spec needs a title" };
  const actor = requireActor(root, input);
  if (isErr(actor)) return actor;
  const sp: Spec = {
    id: mint("sp_"), title, ...(input.narrative?.trim() ? { narrative: input.narrative.trim() } : {}),
    status: "draft", author: actor, createdAt: now(),
  };
  const d = disposition(await shareSpecDrafted(root, sp));
  if ("error" in d) return d;
  if (d.local) await writeLocalSpec(root, sp);
  return { ok: true, id: sp.id, spec: sp };
}

/** The authored fields of an operation — the set `add_operation` and `revise_operation` share. */
export interface OperationInput {
  kind: OperationKind; rationale: string; reversibility: Reversibility;
  requirementId?: string; title?: string; section?: string; statement?: string;
  provenance?: string; cites?: string[]; evidence?: string;
  criterion?: string; falsifier?: string; evidenceKind?: EvidenceKind;
  targetOperationId?: string;
  fromSection?: string; toSection?: string;
}

/**
 * Validate an operation's fields against the standard as it stands and against the rest of
 * the spec, and produce the payload plus the context it was written against.
 *
 * ONE function for authoring and for revising, and that is a rule rather than tidiness: a
 * revision running a weaker set of checks would be a second, cheaper path to an operation
 * the first path refuses, which is the exact shape `docs/requirements-architecture.md`
 * gives for why there is no `updateRequirement`. `excluding` names the operation being
 * revised, which must not count as its own sibling in the case-clash, move-collision and
 * one-operation-per-rule checks.
 */
async function operationPayload(
  root: string, sp: Spec, input: OperationInput, excluding?: string,
): Promise<{ payload: Partial<Operation>; context?: Operation["context"] } | Err> {
  const rationale = input.rationale?.trim();
  if (!rationale) return { error: "an operation needs a rationale — what provoked it" };
  if (!REVERSIBILITY.includes(input.reversibility)) {
    return {
      error:
        "an operation needs `reversibility` (reversible | irreversible | unknown). It is "
        + "declared before ratification because it changes the decision — a rule whose "
        + "implementation cannot be undone is also a rule that is harder to amend later.",
    };
  }
  const siblings = (await readOperations(root, { specId: sp.id })).filter((o) => o.id !== excluding);
  const statement = input.statement?.trim();
  let payload: Partial<Operation> = {};
  let context: Operation["context"];

  if (input.kind === "add_requirement") {
    const title = input.title?.trim();
    const section = normalizeSection(input.section ?? "");
    const provenance = input.provenance?.trim();
    if (!statement) return { error: "`add_requirement` needs a statement" };
    if (!title) return { error: "a requirement needs a title — the name a queue row and an index show" };
    if (!section) {
      return {
        error:
          "a requirement needs a `section` — a `/`-delimited path saying where it files "
          + "(\"Credit/Limits\", \"Settlement/Float\"). Optional organization is no organization, "
          + "and a few hundred unsectioned rules is a heap nothing can be read out of.",
      };
    }
    if (!provenance) {
      return {
        error:
          "a requirement needs `provenance` — where the rule comes from (a contract term, an "
          + "IATA standard, a credit policy, a customer's demand, or our own past choice). It is "
          + "what tells a reader which rules are immovable and which are ours to revisit.",
      };
    }
    const clash = await checkSection(root, section, sectionsIntroducedBy(siblings));
    if (clash) return clash;
    // Refused rather than ignored. An author who passes citations has a model of what a
    // requirement is, and silently dropping them would leave that model intact and the
    // rule looking connected to code it is not connected to.
    if (input.cites?.length) {
      return {
        error:
          "a requirement cites nothing — a rule is upstream of code, so it does not point down "
          + "at an implementation, and one governing several repositories could not be witnessed "
          + "from any single checkout anyway. Say where the code is with `declare_pointer`, which "
          + "names one universe and carries its own baseline; that is also what makes the rule "
          + "rise for re-audit when the code moves. See docs/cross-universe-standard.md.",
      };
    }
    payload = { title, section, statement, provenance };
  } else if (input.kind === "add_criterion") {
    const criterion = input.criterion?.trim();
    const falsifier = input.falsifier?.trim();
    if (!criterion) return { error: "`add_criterion` needs a `criterion` — what must be true, concretely" };
    if (!falsifier) {
      return {
        error:
          "`add_criterion` needs a `falsifier` — the observation that would show the criterion "
          + "is NOT met. It is the part authors skip and the part that does the work: if you "
          + "cannot write what would refute it, it is prose rather than a criterion, and you "
          + "have found that out now, while the rule is still cheap to change.",
      };
    }
    // The laziest vacuous form, and the only one a machine can see: a "falsifier" that
    // restates the criterion asserts nothing about what failure would look like. Everything
    // past this is a reader's job, which is why `VacuityCheck` exists.
    if (falsifier.replace(/\W+/g, "").toLowerCase() === criterion.replace(/\W+/g, "").toLowerCase()) {
      return { error: "the falsifier restates the criterion — say what OBSERVATION would show it is not met" };
    }
    if (!EVIDENCE_KINDS.includes(input.evidenceKind as EvidenceKind)) {
      return {
        error:
          `\`evidenceKind\` must be one of ${EVIDENCE_KINDS.join(" | ")}. The list is closed on `
          + "purpose. `attestation` is the last resort and weak by construction — reaching for it "
          + "for anything that can be rendered, captured or run is skipping the evidence rather "
          + "than choosing a type.",
      };
    }
    // Target: a rule that already stands, or one this same draft is about to create. The
    // second case is the authoring flow the playbook actually describes — criteria are
    // written WITH the rule, in one reviewed artifact — and the rule has no id yet, so the
    // operation is named instead. `Acknowledgement.operationId` solved this same shape.
    if (input.targetOperationId) {
      const target = siblings.find((o) => o.id === input.targetOperationId);
      if (!target) return { error: `no operation "${input.targetOperationId}" in ${sp.id}` };
      if (target.kind !== "add_requirement") {
        return { error: `${target.id} is a ${target.kind} — a criterion attaches to the rule an \`add_requirement\` creates` };
      }
      payload = { criterion, falsifier, evidenceKind: input.evidenceKind, targetOperationId: target.id };
    } else {
      if (!input.requirementId) {
        return { error: "`add_criterion` needs a `requirementId`, or a `targetOperationId` naming an `add_requirement` in this spec" };
      }
      const r = await readRequirement(root, input.requirementId);
      if (!r) return { error: `no requirement "${input.requirementId}"` };
      if (r.status === "retired") return { error: `${r.id} is retired` };
      // Context still applies: a criterion written against a statement that has since been
      // amended states what discharges a rule nobody has now. It does NOT take the
      // one-operation-per-rule refusal below — a rule legitimately gets several criteria,
      // and they do not overwrite one another the way two amendments would.
      context = { requirementId: r.id, statement: r.statement };
      payload = { criterion, falsifier, evidenceKind: input.evidenceKind, requirementId: r.id };
    }
  } else if (input.kind === "move_section") {
    const from = normalizeSection(input.fromSection ?? "");
    const to = normalizeSection(input.toSection ?? "");
    if (!from || !to) {
      return { error: "`move_section` needs `fromSection` and `toSection` — `/`-delimited paths naming the subtree and where it lands" };
    }
    if (from === to) return { error: "the destination is the source — nothing to move" };
    const bad = await checkMove(root, from, to, siblings);
    if (bad) return bad;
    payload = { fromSection: from, toSection: to };
  } else {
    if (!input.requirementId) return { error: `kind "${input.kind}" needs a \`requirementId\`` };
    const r = await readRequirement(root, input.requirementId);
    if (!r) return { error: `no requirement "${input.requirementId}"` };
    if (r.status === "retired") return { error: `${r.id} is retired` };
    // ONE operation per rule per spec. Every operation captures `context` from the stored
    // row, so a second one against the same rule captures the SAME pre-spec text: both
    // validate at ratification, both render with an identical `before`, both read as
    // `adoptable`, and then they apply in `ord` order and the last one silently wins. The
    // principal is shown two contradictory rewrites each claiming to apply to the current
    // statement, and approves an outcome the rendering never displayed — which is the one
    // thing "review N operations instead of 5,000 lines" has to get right.
    const already = siblings.find((o) => o.requirementId === r.id && o.kind !== "add_criterion");
    if (already) {
      return {
        error:
          `${sp.id} already has an operation against ${r.id} (${already.id}). A spec carries one `
          + `operation per rule: a second is written against the same base as the first, so it `
          + `would render as if the first had not happened and then overwrite it. Amend `
          + `${already.id} to say what you want the rule to end up saying.`,
      };
    }
    if (input.kind === "amend_statement") {
      if (!statement) return { error: "`amend_statement` needs the new `statement`" };
      if (statement === r.statement) return { error: "the proposed statement is identical to the current one" };
      payload = { statement };
    }
    // The state this was written against. Verified at ratification, so an operation
    // drafted before another spec changed the same rule is refused rather than applied
    // to a base its author never saw.
    context = { requirementId: r.id, statement: r.statement };
    payload = { ...payload, requirementId: r.id };
  }
  return { payload, context };
}

/**
 * Add an operation to a draft spec. Any actor.
 *
 * `rationale` and `reversibility` are required per operation, not per spec. That is the
 * structural defence against the drift both legislative drafting and ITIL change records
 * document: with the rationale attached to the operation there is no free-floating prose
 * to disagree with what actually lands.
 */
export async function addOperation(
  root: string, input: { specId: string } & OperationInput & ActorInput,
): Promise<{ ok: true; id: string; operation: Operation } | Err> {
  const sp = await readSpec(root, input.specId);
  if (!sp) return { error: `no spec "${input.specId}"` };
  if (sp.status !== "draft") return { error: `${sp.id} is ${sp.status} — operations may only be added to a draft` };

  const built = await operationPayload(root, sp, input);
  if (isErr(built)) return built;
  const actor = requireActor(root, input);
  if (isErr(actor)) return actor;

  // Next FREE position, not the count. A removed operation keeps its `ord` — the tombstone
  // is what stops two operations claiming one position, and a count would hand the reused
  // number straight back, leaving the fold's sort to break the tie differently per clone.
  const taken = await readOperations(root, { specId: sp.id, includeRemoved: true });
  const op: Operation = {
    id: mint("op_"), specId: sp.id, kind: input.kind, ...built.payload,
    rationale: input.rationale.trim(), ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(built.context ? { context: built.context } : {}),
    reversibility: input.reversibility,
    ord: taken.reduce((n, o) => Math.max(n, o.ord + 1), 0),
  } as Operation;
  const d = disposition(await shareOperation(root, op));
  if ("error" in d) return d;
  if (d.local) await writeLocalOperation(root, op);
  return { ok: true, id: op.id, operation: op };
}

// --- correcting a draft ------------------------------------------------------

/**
 * Why a draft has a correction path at all, and why a ratified spec still does not.
 *
 * **Immutability attaches at RATIFICATION, not at drafting.** The argument the design
 * makes for write-once — *"removing a ratified act destroys the audit trail of the thing
 * most worth auditing"* — is about a spec that already binds something. A draft binds
 * nothing: no requirement exists, no acknowledgement is active, no audit can rest on it.
 * COD-29's principle is that the asymmetry is in ADOPTION, not in authorship, and every
 * neighbouring record already has this path — `revise_finding` exists precisely because
 * findings are filed before they are understood, and a proposal is filed under exactly the
 * same conditions.
 *
 * What was actually costing something: an agent that mis-stated its own proposal had to put
 * the correction in a COMMENT, so the ratifier read the wrong framing first (the narrative
 * is what renders), then a retraction, then a retraction of the retraction. And the
 * asymmetry ran backwards — `acknowledge_gap` lets an agent ADD a silencer that constrains
 * what the ratifier is approving, while nothing let it REMOVE an operation it had come to
 * believe was wrong.
 *
 * Three rules hold this section, and each is a refusal below rather than a line in a tool
 * description (COD-24):
 *
 *  1. **Draft only.** Every verb here refuses once `status !== "draft"`, and the fold
 *     refuses the same event for the same reason, because a row reaching a teammate's clone
 *     was never seen by their MCP call.
 *  2. **Correcting is authoring, so it is open to any actor** — the same gate `draft_spec`
 *     and `add_operation` carry. Withdrawal is the exception: it destroys a record rather
 *     than restating one.
 *  3. **Mutate the current text, keep the old one underneath.** The ratifier's trade is
 *     reading ONE current text; a correction chain they have to reassemble is that trade
 *     failing at its last step. The prior wording is not lost — it is in `revisions`, and
 *     on a shared store the events are the long version.
 */

/** Fields a revision changed, with what they said before. Empty means nothing moved. */
const changedFields = <T extends object>(before: T, after: T, keys: (keyof T)[]): Partial<T> => {
  const was: Partial<T> = {};
  for (const k of keys) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) was[k] = before[k];
  return was;
};

/** Correct a draft's title or narrative. Any actor; refused once it is ratified. */
export async function reviseSpec(
  root: string, input: { specId: string; title?: string; narrative?: string; reason?: string } & ActorInput,
): Promise<{ ok: true; spec: Spec } | Err> {
  const sp = await readSpec(root, input.specId);
  if (!sp) return { error: `no spec "${input.specId}"` };
  if (sp.status !== "draft") {
    return {
      error:
        `${sp.id} is ${sp.status} — a proposal may be corrected while it is a draft and never `
        + `after. Immutability attaches when a claim becomes binding: the standard is a `
        + `projection of the ratified specs, so editing one now would rewrite the record of an `
        + `act somebody performed. Amend the rule with a new spec instead.`,
    };
  }
  const actor = requireActor(root, input);
  if (isErr(actor)) return actor;

  const title = input.title === undefined ? sp.title : input.title.trim();
  if (!title) return { error: "a spec needs a title" };
  const narrative = input.narrative === undefined ? sp.narrative : input.narrative.trim() || undefined;
  const was = changedFields(sp, { ...sp, title, narrative }, ["title", "narrative"]);
  if (!Object.keys(was).length) return { error: "nothing to change" };

  const at = now();
  const reason = input.reason?.trim();
  const next: Spec = {
    ...sp, title, ...(narrative ? { narrative } : {}),
    revisions: [...(sp.revisions ?? []), { at, by: actor, was, ...(reason ? { reason } : {}) }],
  };
  if (!narrative) delete next.narrative;
  const d = disposition(await shareSpecRevised(root, next, at));
  if ("error" in d) return d;
  if (d.local) await writeLocalSpec(root, next);
  return { ok: true, spec: next };
}

/**
 * Correct one operation on a draft spec. Any actor; refused once the spec is ratified.
 *
 * The whole payload is re-validated by `operationPayload`, so a revision can never produce
 * an operation `add_operation` would have refused. `kind` is deliberately not revisable —
 * see `Operation.revisions`.
 */
export async function reviseOperation(
  root: string, input: { operationId: string; reason?: string } & Partial<OperationInput> & ActorInput,
): Promise<{ ok: true; operation: Operation } | Err> {
  const op = await readOperation(root, input.operationId);
  if (!op) return { error: `no operation "${input.operationId}"` };
  if (op.removed) return { error: `${op.id} was removed from ${op.specId} — add the operation you meant instead` };
  const sp = await readSpec(root, op.specId);
  if (!sp) return { error: `operation ${op.id} points at missing spec ${op.specId}` };
  if (sp.status !== "draft") {
    return {
      error:
        `${sp.id} is ${sp.status} — an operation may be corrected while its spec is a draft and `
        + `never after. Once adopted it is the act that produced a rule, and rewriting it would `
        + `rewrite the standard's own provenance. Amend the rule with a new spec instead.`,
    };
  }
  if (input.kind !== undefined && input.kind !== op.kind) {
    return {
      error:
        `${op.id} is a \`${op.kind}\` and revision does not change that — a different kind is a `
        + `different operation, validated against fields this one was never written with. `
        + `\`remove_operation\` this one and add the one you meant.`,
    };
  }
  const blocked = await attachedByOthers(root, op, input);
  if (blocked) return blocked;
  const actor = requireActor(root, input);
  if (isErr(actor)) return actor;

  // Every field the caller did not name keeps its current value, so a revision that means to
  // fix a typo in one statement cannot blank a rationale by omission.
  // An optional field set to "" is set to NOTHING. `operationContent` omits both `undefined`
  // and `""`, so the two are the same text to every reader and to every witness — but
  // `changedFields` compares raw values and saw `undefined -> ""` as a change. The tool then
  // appended a revision, published, and answered `{ok: true}`; the fold computed
  // `moved=false, grew=true` and refused the event. A false success, and the exact
  // divergence the biconditional exists to close, arriving from the other side.
  const blank = (v: string | undefined) => (v?.trim() ? v : undefined);
  const merged: OperationInput = {
    kind: op.kind,
    rationale: input.rationale ?? op.rationale,
    reversibility: input.reversibility ?? op.reversibility,
    requirementId: input.requirementId ?? op.requirementId,
    title: blank(input.title ?? op.title),
    section: blank(input.section ?? op.section),
    statement: blank(input.statement ?? op.statement),
    provenance: blank(input.provenance ?? op.provenance),
    cites: input.cites,
    evidence: blank(input.evidence ?? op.evidence),
    criterion: blank(input.criterion ?? op.criterion),
    falsifier: blank(input.falsifier ?? op.falsifier),
    evidenceKind: input.evidenceKind ?? op.evidenceKind,
    targetOperationId: input.targetOperationId ?? op.targetOperationId,
    fromSection: blank(input.fromSection ?? op.fromSection),
    toSection: blank(input.toSection ?? op.toSection),
  };
  const built = await operationPayload(root, sp, merged, op.id);
  if (isErr(built)) return built;

  const candidate: Operation = {
    ...op,
    // The stale halves of the previous payload go with it: a `move_section` revised from an
    // `amend_statement`'s fields would otherwise keep the old `statement`, and the rendering
    // would show a field the operation no longer acts on.
    title: undefined, section: undefined, statement: undefined, provenance: undefined,
    criterion: undefined, falsifier: undefined, evidenceKind: undefined,
    requirementId: undefined, targetOperationId: undefined, fromSection: undefined, toSection: undefined,
    ...built.payload,
    rationale: merged.rationale.trim(),
    evidence: merged.evidence,
    context: built.context,
    reversibility: merged.reversibility,
  };
  const was = changedFields(op, candidate, [
    "title", "section", "statement", "provenance", "rationale", "evidence", "reversibility",
    "criterion", "falsifier", "evidenceKind", "requirementId", "targetOperationId",
    "fromSection", "toSection", "context",
  ]);
  if (!Object.keys(was).length) return { error: "nothing to change" };

  const at = now();
  const why = input.reason?.trim();
  const next = prune({
    ...candidate,
    revisions: [...(op.revisions ?? []), { at, by: actor, was, ...(why ? { reason: why } : {}) }],
  });
  const d = disposition(await shareOperationRevised(root, next));
  if ("error" in d) return d;
  if (d.local) await writeLocalOperation(root, next);
  return { ok: true, operation: next };
}

/** Drop the keys a revision cleared, so a serialized operation has no `"title": undefined`. */
const prune = (op: Operation): Operation =>
  Object.fromEntries(Object.entries(op).filter(([, v]) => v !== undefined)) as Operation;

/**
 * Refuse to rewrite or pull an operation somebody ELSE has built on.
 *
 * Reference-count discipline, at the threshold a draft warrants — the same machinery
 * `withdrawSpec` uses on a ratified spec, one rung lower. A pending gap is another actor's
 * approval artifact chained to this exact operation, and a comment is their reading of it;
 * either one silently losing its subject is the orphan the count exists to prevent. Your
 * OWN gap and your own comment do not block you: releasing the gap is a verb you already
 * have, and it is your record to move.
 */
async function attachedByOthers(
  root: string, op: Operation, input: ActorInput,
): Promise<Err | null> {
  const actor = requireActor(root, input);
  if (isErr(actor)) return actor;
  const gaps = (await readAcknowledgements(root, { operationId: op.id }))
    .filter((a) => a.state !== "released" && a.grantedBy?.principal !== actor.principal);
  if (gaps.length) {
    return {
      error:
        `${op.id} carries ${gaps.length} acknowledgement(s) granted by somebody else `
        + `(${gaps.map((a) => a.id).join(", ")}), which approve THIS operation and bind when the `
        + `spec is adopted. Changing or pulling it out from under them would leave an approval `
        + `of something nobody can read. Ask them to release it, or leave the operation and say `
        + `what you think in a comment.`,
    };
  }
  const said = await commentsByOthers(root, op.id, actor.principal);
  if (said) return said;
  return null;
}

/**
 * Somebody else's comments on a proposal, which are their record and not yours to erase.
 *
 * Read through the notes store, which is a DIFFERENT sidecar scope from the standard — so
 * this is a check the tool can make and the fold cannot. Two consequences, stated rather
 * than papered over. It is TOCTOU across clones exactly as the reliance count already is
 * (`withdrawSpec` says so), and a client that skipped it would land a withdrawal the fold
 * does not re-refuse. That failure is benign in a way the acknowledgement half is not:
 * withdrawal is not a delete, so the spec row, its operations and every comment on them
 * survive it — what a comment loses is a live proposal to be about, never its own record.
 * Teaching `foldStandard` to read the notes scope would make one entity's fold depend on
 * another's, which `docs/cross-universe-standard.md` § *The fold cannot be split in two*
 * is the argument against.
 *
 * With no sidecar there is no comment store at all, so there is nothing to protect.
 */
async function commentsByOthers(root: string, targetId: string, mine: string): Promise<Err | null> {
  const { sharedNotes } = await import("./ops-shared.js");
  const r = await sharedNotes(root, targetId) as
    { notes?: { id: string; by: string; answers?: { by: string }[] }[]; error?: string };
  if (r.error || !r.notes?.length) return null;
  const theirs = r.notes.filter((n) => n.by !== mine || n.answers?.some((a) => a.by !== mine));
  return theirs.length
    ? {
      error:
        `${targetId} carries ${theirs.length} comment(s) from somebody else `
        + `(${theirs.slice(0, 3).map((n) => n.id).join(", ")}). Taking it back now leaves their `
        + `reading of a proposal nobody can open. Answer them first — \`answer_shared_note\` — `
        + `and let a principal withdraw it if it still has to go.`,
    }
    : null;
}

/**
 * Pull an operation out of a draft. Any actor; refused once the spec is ratified.
 *
 * This is the verb whose absence made the asymmetry run backwards: `acknowledge_gap` is
 * agent-callable against a draft operation, so an agent could ADD a silencer constraining
 * what a ratifier was approving, and could not REMOVE an operation it had come to believe
 * was wrong. The operation is TOMBSTONED rather than deleted — see `Operation.removed`.
 */
export async function removeOperation(
  root: string, input: { operationId: string; reason: string } & ActorInput,
): Promise<{ ok: true; operation: Operation } | Err> {
  const op = await readOperation(root, input.operationId);
  if (!op) return { error: `no operation "${input.operationId}"` };
  if (op.removed) return { error: `${op.id} is already removed from ${op.specId}` };
  const reason = input.reason?.trim();
  if (!reason) return { error: "a removal needs a `reason` — the ratifier is reading a proposal that changed shape" };
  const sp = await readSpec(root, op.specId);
  if (!sp) return { error: `operation ${op.id} points at missing spec ${op.specId}` };
  if (sp.status !== "draft") {
    return {
      error:
        `${sp.id} is ${sp.status} — an operation may be pulled while its spec is a draft and `
        + `never after. Once adopted it is the act that produced a rule; taking it out of the `
        + `log would leave a requirement nothing accounts for. Retire the rule with a new spec.`,
    };
  }
  const blocked = await attachedByOthers(root, op, input);
  if (blocked) return blocked;
  const actor = requireActor(root, input);
  if (isErr(actor)) return actor;

  // A criterion in this same spec that named this operation as its target would be left
  // pointing at nothing, and it renders as adoptable right up to the ratification that
  // drops it. Same shape as the reliance count, inside one draft.
  const dependents = (await readOperations(root, { specId: sp.id }))
    .filter((o) => o.targetOperationId === op.id);
  if (dependents.length) {
    return {
      error:
        `${op.id} is the target of ${dependents.map((o) => o.id).join(", ")} in this same spec — `
        + `a criterion attaches to the rule this operation creates, so removing it leaves the `
        + `criterion with no rule. Remove or re-target ${dependents.length === 1 ? "it" : "them"} first.`,
    };
  }
  // Your OWN pending gap goes with the operation it approved, released rather than deleted,
  // for the same reason `withdrawSpec` releases one: the grant really happened, and what
  // stops existing is the rule it was about. Somebody else's already refused above.
  const next: Operation = { ...op, removed: { at: now(), by: actor, reason } };
  const d = disposition(await shareOperationRemoved(root, next));
  if ("error" in d) return d;
  if (d.local) await writeLocalOperation(root, next);

  // AFTER the removal is durable, and that order is the fix. Releasing first meant a share
  // that failed — or a fold that refused the removal, which it can, because the merged log
  // sees dependents this machine cannot — left the release durable EVERYWHERE while the
  // operation stayed live: a ratifier looking at an unsilenced operation whose approval
  // artifact had been destroyed, with a reason naming a removal that never happened.
  // `withdrawSpec` already had it this way round.
  const { releaseAcknowledgement } = await import("./acknowledgements.js");
  for (const a of await readAcknowledgements(root, { operationId: op.id })) {
    if (a.state === "released") continue;
    const r = await releaseAcknowledgement(root, a.id, `${op.id} was removed from ${sp.id}`, input);
    // Reported rather than discarded: a silencer that outlives the operation it approved is
    // the orphan the reference count exists to prevent, and swallowing the refusal is how
    // nobody would learn of it.
    if (isErr(r)) return { error: `${op.id} was removed, but its acknowledgement ${a.id} could not be released: ${r.error}` };
  }
  return { ok: true, operation: next };
}

// --- the reviewer's witness --------------------------------------------------

/**
 * Why ratification needs a signature over the PROPOSAL, not only over the standard.
 *
 * `ratifySpec` checks every operation against the standard as it now stands — retired
 * rules, moved bases, vanished assertions, merged sections. Every one of those asks
 * whether the WORLD moved under the proposal. Nothing asked whether the proposal moved
 * under the reviewer, and with `revise_operation` open to any actor (which is the right
 * call — the asymmetry is in adoption, not authorship) an operation can change between the
 * reading and the click.
 *
 * Three properties do the work, and each is a choice that could have gone otherwise:
 *
 *  1. **A CONTENT hash, never a counter or a timestamp.** Revising a draft and revising it
 *     back to identical text must not invalidate anybody's review, because nothing they
 *     read changed. It is also what lets the refusal render WHICH field moved and from
 *     what — and cheap re-review is the only thing that actually prevents the
 *     rubber-stamping COD-29 names as the risk. A version counter would give you neither.
 *  2. **REFUSED at ratify, warned during review.** Adoption is all-or-nothing, so one
 *     signature covers every operation whether the reviewer looked or not; a warning at
 *     that boundary is precisely the "paragraph asking you to be careful" COD-24 says does
 *     not survive deadline pressure. `getSpec` carries the same gap as a warning, which is
 *     where being told is useful because there is still something to do about it.
 *  3. **Sign-off is a PRINCIPAL's act.** Not symmetry with ratification — necessity. If an
 *     agent could write its principal's witness, an agent would sign off twelve operations
 *     and the principal would then ratify having read none, which is the gate voiding
 *     itself in one step.
 *
 * The witness is keyed on the RATIFIER's principal. Somebody else having read the proposal
 * is not the ratifier having read it: adoption is the act that produces accountability.
 */

/** Everything one reviewer has left to approve on a proposal as it now stands. */
async function gapFor(root: string, sp: Spec, reviewer: string): Promise<ReviewGap> {
  const ops = await readOperations(root, { specId: sp.id });
  return reviewGap(sp, ops, await readProposalWitnesses(root, { specId: sp.id }), reviewer);
}

/**
 * Take the team's changes before deciding anything. Step one of the review loop.
 *
 * Not a precondition bolted onto ratification — a step, and the difference is what the
 * reviewer sees. Law is workspace-scoped (`docs/cross-universe-standard.md`), so ratifying
 * on a stale fold binds the team against a standard state teammates have already moved
 * past. If the pull brings a revision in, the witness goes stale and the refusal fires
 * immediately afterwards; that is CORRECT, and it reads as the tool breaking unless the
 * pull, the diff and the re-signing are one flow. So they are.
 *
 * A pull that fails is REPORTED and does not stop the read. A network failure must not
 * make the standard unreviewable, and a caller told the pull failed can decide what that
 * is worth; a caller told nothing would be reviewing a stale proposal believing otherwise.
 */
async function pullFirst(root: string): Promise<{ pulled: boolean; note?: string }> {
  const { sharedPull } = await import("./ops-shared.js");
  try {
    const r = await sharedPull(root) as { error?: string };
    if (r.error) return { pulled: false, note: r.error };
    return { pulled: true };
  } catch (e: any) {
    return { pulled: false, note: `pull failed: ${e?.message ?? e}` };
  }
}

/**
 * The review loop, steps one and two: take what the team has, then show what has changed
 * since you last looked.
 */
export async function reviewProposal(
  root: string, specId: string,
): Promise<{ spec: Spec; review: ReviewGap; complete: boolean; pull: { pulled: boolean; note?: string } } | Err> {
  const pull = await pullFirst(root);
  const sp = await readSpec(root, specId);
  if (!sp) return { error: `no spec "${specId}"` };
  // A READ, so it resolves the principal rather than requiring one: a map you cannot look
  // at without configuring git would be a worse tool for no gain (`requireActor`'s rule).
  // The review state is about a person, so with no principal there is nobody to report on.
  const who = resolvePrincipal(root);
  if (!who) {
    return { error: "no principal — set `git config user.email`, since a review is a record of who read what" };
  }
  const review = await gapFor(root, sp, who);
  return { spec: sp, review, complete: reviewComplete(review), pull };
}

/** Write one witness, having re-read the subject after a pull. */
async function witnessOne(
  root: string, sp: Spec, reviewer: Actor, op: Operation | null,
  bulk?: ProposalWitness["bulk"],
): Promise<{ ok: true; witness: ProposalWitness } | Err> {
  const content = op ? operationContent(op) : framingContent(sp);
  const w: ProposalWitness = {
    id: mint("rw_"), specId: sp.id, ...(op ? { operationId: op.id } : {}),
    reviewer, at: now(), content, ...(bulk ? { bulk } : {}),
  };
  const d = disposition(await shareSpecReviewed(root, w));
  if ("error" in d) return d;
  if (d.local) await writeLocalProposalWitness(root, w);
  return { ok: true, witness: w };
}

/**
 * Pull, then refuse if the pull moved what is about to be signed.
 *
 * Without this the sign-off would witness text the reviewer never read: they pull as part
 * of signing, a teammate's revision arrives in the same breath, and the witness records
 * the NEW content under their name. The refusal carries the diff, so the answer is to read
 * the change rather than to guess what moved.
 */
async function reReadAfterPull(
  root: string, specId: string, before: Map<string, Record<string, string>>,
): Promise<Err | { spec: Spec }> {
  const sp = await readSpec(root, specId);
  if (!sp) return { error: `no spec "${specId}"` };
  const ops = await readOperations(root, { specId });
  const after = new Map<string, Record<string, string>>([
    ["", framingContent(sp)], ...ops.map((o) => [o.id, operationContent(o)] as const),
  ]);
  for (const [id, was] of before) {
    const nowContent = after.get(id);
    if (!nowContent) {
      return { error: `${id} was removed from ${specId} while you were signing it off — re-read the proposal (\`review_proposal\`) before approving what is left` };
    }
    if (witnessHash(was) !== witnessHash(nowContent)) {
      const changed = contentDiff(was, nowContent).map((c) => c.field).join(", ");
      return {
        error:
          `${id === "" ? `${specId}'s framing` : id} changed while you were signing it off — the pull `
          + `brought in an edit to ${changed}. Signing now would record that you read text you have `
          + `not seen. Re-read it with \`review_proposal\`, then sign off.`,
      };
    }
  }
  return { spec: sp };
}

/** The state a sign-off saw BEFORE its pull, so a change during the pull is detectable. */
async function contentBefore(
  root: string, specId: string, ids: (string | null)[],
): Promise<Map<string, Record<string, string>>> {
  const sp = await readSpec(root, specId);
  const ops = await readOperations(root, { specId });
  const out = new Map<string, Record<string, string>>();
  for (const id of ids) {
    if (id === null) { if (sp) out.set("", framingContent(sp)); continue; }
    const op = ops.find((o) => o.id === id);
    if (op) out.set(op.id, operationContent(op));
  }
  return out;
}

/** Sign off ONE operation: you read this text, at this version. */
export async function signOffOperation(
  root: string, input: { operationId: string } & ActorInput,
): Promise<{ ok: true; witness: ProposalWitness } | Err> {
  const op0 = await readOperation(root, input.operationId);
  if (!op0) return { error: `no operation "${input.operationId}"` };
  const who = principal(root, input, "sign off on a proposal");
  if (isErr(who)) return who;
  const before = await contentBefore(root, op0.specId, [op0.id]);
  await pullFirst(root);
  const re = await reReadAfterPull(root, op0.specId, before);
  if (isErr(re)) return re;
  if (re.spec.status !== "draft") return { error: `${re.spec.id} is ${re.spec.status} — there is nothing left to review` };
  const op = (await readOperations(root, { specId: op0.specId })).find((o) => o.id === op0.id);
  if (!op) return { error: `${input.operationId} is no longer in ${op0.specId}` };
  return witnessOne(root, re.spec, who, op);
}

/** Sign off the spec's FRAMING — its title and the narrative every operation is read under. */
export async function signOffFraming(
  root: string, input: { specId: string } & ActorInput,
): Promise<{ ok: true; witness: ProposalWitness } | Err> {
  const who = principal(root, input, "sign off on a proposal");
  if (isErr(who)) return who;
  const before = await contentBefore(root, input.specId, [null]);
  if (!before.size) return { error: `no spec "${input.specId}"` };
  await pullFirst(root);
  const re = await reReadAfterPull(root, input.specId, before);
  if (isErr(re)) return re;
  if (re.spec.status !== "draft") return { error: `${re.spec.id} is ${re.spec.status} — there is nothing left to review` };
  return witnessOne(root, re.spec, who, null);
}

/**
 * Where an operation files in the STANDARD — the axis a reviewer who owns an area asks by.
 *
 * Derived rather than stored: an `add_requirement` says where it files, and every other
 * kind operates on a rule that already has a section. A `move_section` files under the
 * subtree it moves, which is the heading somebody watching that area would look under.
 */
async function standardSectionOf(root: string, op: Operation): Promise<string> {
  if (op.kind === "add_requirement") return op.section ?? "";
  if (op.kind === "move_section") return op.fromSection ?? "";
  const rid = op.requirementId ?? op.context?.requirementId;
  if (!rid) return "";
  return (await readRequirement(root, rid))?.section ?? "";
}

/**
 * Sign off a whole GROUP at once — and say how many, so the bulk act reads as bulk.
 *
 * `count` is required and must match, which is the only part of this that is a guard
 * rather than a convenience. Twelve witnesses written by one call claim twelve operations
 * were read; that claim is true or it is not, and the one thing the system can do about it
 * is make the size of the claim impossible to not notice at the moment it is made. A
 * caller that thought it was signing three and is told it would sign twelve has learned
 * something; one that passes twelve has said twelve out loud.
 *
 * Two axes, because a spec's sections are NOT the standard's sections (COD-29, bill versus
 * code). `standard` groups by where each operation lands in the taxonomy. `spec` groups by
 * the proposal's own order — and today that is ONE group, the whole spec, because a spec's
 * internal hierarchy is narrative and nothing stores it. Deriving a finer spec-side
 * grouping would be inventing a hierarchy nobody authored, so the axis exists, answers
 * honestly, and has one group until a spec's own sections become a thing that is written
 * down.
 */
export async function signOffSection(
  root: string, input: { specId: string; axis: SignOffAxis; section?: string; count: number } & ActorInput,
): Promise<{ ok: true; signed: number; group: string; witnesses: ProposalWitness[] } | Err> {
  if (!SIGN_OFF_AXES.includes(input.axis)) {
    return { error: `\`axis\` must be one of ${SIGN_OFF_AXES.join(" | ")} — a spec's sections are not the standard's sections, so a group has to say which it means` };
  }
  const who = principal(root, input, "sign off on a proposal");
  if (isErr(who)) return who;
  const sp0 = await readSpec(root, input.specId);
  if (!sp0) return { error: `no spec "${input.specId}"` };

  const pick = async (): Promise<{ ops: Operation[]; group: string } | Err> => {
    const ops = await readOperations(root, { specId: input.specId });
    if (input.axis === "spec") {
      if (input.section && input.section !== input.specId) {
        return {
          error:
            `\`axis: "spec"\` has one group — the proposal itself — because a spec's internal `
            + `hierarchy is narrative and nothing stores it. Leave \`section\` out, or use `
            + `\`axis: "standard"\` to sign off one heading of the standard at a time.`,
        };
      }
      return { ops, group: input.specId };
    }
    const section = normalizeSection(input.section ?? "");
    if (!section) return { error: "`axis: \"standard\"` needs a `section` — the heading you are signing off, e.g. \"Credit/Limits\"" };
    const members: Operation[] = [];
    for (const op of ops) if (await standardSectionOf(root, op) === section) members.push(op);
    if (!members.length) {
      return { error: `no operation in ${input.specId} files under "${section}" — check the spelling against the operations the spec actually carries` };
    }
    return { ops: members, group: section };
  };

  const chosen = await pick();
  if (isErr(chosen)) return chosen;
  if (input.count !== chosen.ops.length) {
    return {
      error:
        `sign off ${chosen.ops.length} operation(s) in "${chosen.group}" — you said ${input.count}. `
        + `The count is required and checked because this writes one approval per operation: `
        + `${chosen.ops.length} witnesses each say an operation was read, and a bulk act has to `
        + `read as one at the moment it is made. Pass \`count: ${chosen.ops.length}\`, or sign them `
        + `off one at a time with \`sign_off_operation\`.`,
    };
  }

  const before = await contentBefore(root, input.specId, chosen.ops.map((o) => o.id));
  await pullFirst(root);
  const re = await reReadAfterPull(root, input.specId, before);
  if (isErr(re)) return re;
  if (re.spec.status !== "draft") return { error: `${re.spec.id} is ${re.spec.status} — there is nothing left to review` };

  const bulk = { axis: input.axis, group: chosen.group, count: chosen.ops.length };
  const live = await readOperations(root, { specId: input.specId });
  const witnesses: ProposalWitness[] = [];
  for (const op of chosen.ops) {
    const fresh = live.find((o) => o.id === op.id);
    if (!fresh) continue;
    const r = await witnessOne(root, re.spec, who, fresh, bulk);
    if (isErr(r)) return r;
    witnesses.push(r.witness);
  }
  return { ok: true, signed: witnesses.length, group: chosen.group, witnesses };
}

// --- adoption (principal only) -----------------------------------------------

/** One operation's disposition when the fold checked it. */
export interface OperationCheck {
  operation: Operation;
  ok: boolean;
  reason?: string;
}

/**
 * Adopt a spec: verify every operation, then apply them in order.
 *
 * **All or nothing.** A spec is an argument, and applying the half of it that still fits
 * yields a standard nobody approved — the held-back operations are often what makes the
 * applied ones coherent. Partial ratification, if it is ever wanted, has to be an explicit
 * reviewer choice with the remainder becoming a new spec, not a default of the fold.
 */
/**
 * What a ratification actually did.
 *
 * `applied: null` is the whole point of the shape: on the shared path the FOLD decides
 * whether the operations landed, and until this machine has folded the event it cannot
 * say. A caller that reads `applied` gets what really happened or nothing — never a list
 * of what was asked for, dressed as a list of what was done.
 */
export type Ratification =
  | { ok: true; spec: Spec; applied: Operation[] }
  | { ok: true; spec: Spec; applied: null; submitted: Operation[]; pending: string };

export async function ratifySpec(
  root: string, specId: string, input: ActorInput = {},
): Promise<Ratification | (Err & { checks?: OperationCheck[]; review?: ReviewGap })> {
  const who = principal(root, input, "ratify");
  if (isErr(who)) return who;
  // No pull HERE, and that is deliberate. Taking the team's changes is step one of the
  // review LOOP — `review_proposal` does it, and so does every sign-off, which is where a
  // fresh arrival can still be read before it is approved. A pull bolted onto adoption
  // would be the precondition the loop exists instead of, and it would change what a
  // ratification means: two clones racing for one rule would resolve by whoever fetched
  // last rather than by the fold, which is the arbiter that every clone agrees with.
  // The residual window (a teammate revises between your sign-off and your click) is
  // closed by `foldStandard`, which re-checks this same witness against the merged log.
  const sp = await readSpec(root, specId);
  if (!sp) return { error: `no spec "${specId}"` };
  if (sp.status !== "draft") return { error: `${specId} is already ${sp.status}` };

  const ops = await readOperations(root, { specId });
  if (!ops.length) return { error: `${specId} has no operations — there is nothing to adopt` };

  // Restated at adoption, not only in `addOperation`: a spec assembled by an older build
  // can still arrive here, and the per-operation context check below cannot catch this —
  // both duplicates hold the same pre-spec text, so both PASS and then the later one
  // overwrites the earlier silently. Adoption is all-or-nothing, so this refuses the spec.
  const targets = new Map<string, string>();
  for (const op of ops) {
    // Criteria are exempt, and it is not an oversight: two amendments against one rule
    // overwrite each other, two criteria on one rule do not. A rule with three acceptance
    // criteria is the ordinary case the playbook describes (`AC-1`…`AC-n` per cluster) and
    // refusing it here would make the natural authoring flow un-ratifiable.
    if (!op.requirementId || op.kind === "add_criterion") continue;
    const first = targets.get(op.requirementId);
    if (first) {
      return {
        error:
          `${specId} carries two operations against ${op.requirementId} (${first} and ${op.id}). `
          + `They were written against the same base, so the rendering a reviewer approved shows `
          + `neither the order they apply in nor the statement they end at. Fold them into one.`,
      };
    }
    targets.set(op.requirementId, op.id);
  }

  const checks: OperationCheck[] = [];
  for (const op of ops) {
    if (op.context) {
      const r = await readRequirement(root, op.context.requirementId);
      if (!r) { checks.push({ operation: op, ok: false, reason: `requirement ${op.context.requirementId} no longer exists` }); continue; }
      if (r.status === "retired") { checks.push({ operation: op, ok: false, reason: `${r.id} has been retired since this was written` }); continue; }
      if (r.statement !== op.context.statement) {
        checks.push({
          operation: op, ok: false,
          reason: `${r.id} has changed since this operation was written — it was drafted against "${op.context.statement}"`,
        });
        continue;
      }
    }
    if (op.kind === "add_requirement") {
      const siblings = sectionsIntroducedBy(ops.filter((o) => o.id !== op.id));
      const clash = await checkSection(root, op.section!, siblings);
      if (clash) { checks.push({ operation: op, ok: false, reason: clash.error }); continue; }
    }
    if (op.kind === "add_criterion") {
      // No citation check here any more: a criterion names no code. Where the check IS
      // lives in a detector `Pointer`, minted per universe against the criterion — and
      // `declarePointer` refuses an address that does not resolve, which is the same
      // guard one layer out and the only layer that can know which repo it is about.
      // A criterion attaching to a rule this same spec creates is only coherent if that
      // operation is still here — the reviewer approved them as one argument.
      if (op.targetOperationId && !ops.some((o) => o.id === op.targetOperationId)) {
        checks.push({ operation: op, ok: false, reason: `the \`add_requirement\` it attaches to (${op.targetOperationId}) is no longer in this spec` });
        continue;
      }
    }
    if (op.kind === "move_section") {
      // Re-checked here and not only at drafting: another spec may have moved, emptied or
      // occupied either end since. The source vanishing is the one that would otherwise
      // pass silently — a move that finds nothing to move applies cleanly and does nothing,
      // so the principal would be told a re-organization landed that never happened.
      const bad = await checkMove(root, op.fromSection!, op.toSection!, ops.filter((o) => o.id !== op.id));
      if (bad) { checks.push({ operation: op, ok: false, reason: bad.error }); continue; }
    }
    checks.push({ operation: op, ok: true });
  }

  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    return {
      error:
        `${specId} cannot be adopted: ${failed.length} of ${ops.length} operation(s) were written against a standard that has since moved. `
        + `Re-draft them against the current text. (${failed.map((f) => `${f.operation.id}: ${f.reason}`).join("; ")})`,
      checks,
    };
  }

  // The RATIFIER's own signature over the proposal's own text. Every check ABOVE this asks
  // whether the WORLD moved under the proposal; this is the one that asks whether the
  // proposal moved under the reviewer. REFUSED rather than warned, because adoption is
  // all-or-nothing: one signature covers every operation whether they looked at it or not,
  // and a warning at that boundary is the paragraph COD-24 says nobody reads.
  //
  // LAST, and that ordering is a decision. A spec that cannot be adopted at all — a moved
  // base, a merged section, two operations on one rule — should say so, rather than asking
  // somebody to go and read text that is about to be refused for a reason they cannot fix
  // by reading it.
  const review = await gapFor(root, sp, who.principal);
  if (!reviewComplete(review)) {
    const bits: string[] = [];
    if (review.framing) {
      bits.push(review.framing.state === "unwitnessed"
        ? "its title and narrative are unread"
        : `its title or narrative changed after you read them (${review.framing.changed?.map((c) => c.field).join(", ")})`);
    }
    if (review.unwitnessed.length) bits.push(`${review.unwitnessed.length} operation(s) you have never signed off`);
    if (review.moved.length) bits.push(`${review.moved.length} that changed since you did`);
    return {
      error:
        `${specId} cannot be adopted: ${bits.join(", ")}. Adoption is all-or-nothing, so your `
        + `signature would cover every operation in it. Run \`review_proposal\` to take the team's `
        + `changes and see exactly what moved, then sign off and ratify. `
        + `(${[...review.unwitnessed.map((u) => `${u.id}: unread`), ...review.moved.map((m) => `${m.id}: ${m.changed.map((c) => c.field).join("/")} changed`)].join("; ")})`,
      review,
    };
  }


  const at = now();

  // Witnesses are an observation of THIS checkout, so they ride on the ratification event
  // rather than being recomputed by every clone — see `shared-standard.ts`.
  const witnesses: Record<string, BugWitness[]> = {};
  for (const op of ops) {
    const cites = op.kind === "add_requirement"
      // A rule has no body to baseline: it is upstream of code, and what watches the code
      // is a pointer, which carries its own witnesses and names its own universe.
      ? []
      // A criterion witnesses nothing either, now that its detector is a pointer: the
      // pointer carries the witnesses, in the universe the check actually lives in.
      : op.kind === "add_criterion"
        ? []
        // A move's subject is a PATH, not code, so it witnesses nothing. It also names no
        // rule, and every branch below this one assumes one — which is the trap this
        // operation kind sets in each place that switches on the others by elimination.
        // An amendment or a retirement witnesses NOTHING. It used to witness the rule's
        // citations; a requirement has none now, and a rule is not the sort of thing that
        // has a body to baseline — the code it governs is watched by pointers, which carry
        // their own witnesses and their own universe.
        : [];
    witnesses[op.id] = await witness(root, cites);
  }
  const outcome = await shareSpecRatified(root, sp.id, at, witnesses, ops.map((o) => o.id));
  const shared = disposition(outcome);
  if ("error" in shared) return shared;

  // SHARED: this machine does not apply anything — the fold does, and it can REFUSE. Two
  // principals can each validate against the same statement and both append, because the
  // log is pull/push and never read on an ordinary read; the fold then marks the loser
  // `conflicted` and applies nothing from it. This used to push every operation onto
  // `applied` and return `ok: true` regardless, so a ratification the fold threw away was
  // indistinguishable from one it adopted — and `outcome.folded`, which is the thing that
  // knows, was computed and discarded.
  if (!shared.local) return sharedRatification(root, sp, ops, outcome, who, at);

  const applied: Operation[] = [];
  for (const op of ops) {
    let bound = op;
    if (op.kind === "add_requirement") {
      const r: Requirement = {
        id: requirementIdFor(op.id), title: op.title!, section: op.section!, statement: op.statement!,
        provenance: op.provenance!, status: "ratified",
        author: sp.author, createdAt: at,
        introducedBy: sp.id, ratifiedBy: who, ratifiedAt: at,
      };
      // Bind the operation to what it created, so `readOperations({requirementId})` is the
      // rule's whole history and `serve` can see an irreversible ancestor. The RETURNED
      // copy is bound too: it used to be the unbound original, so a caller that ratified a
      // spec and then wanted to audit the rule it had just adopted got `undefined` from the
      // one operation kind that creates one, and had to go re-find it by listing.
      bound = { ...op, requirementId: r.id };
      await writeLocalOperation(root, bound);
      await writeLocalRequirement(root, r);
    } else if (op.kind === "add_criterion") {
      // Resolve the target the same way the fold does. `targetOperationId` names an
      // `add_requirement` in this same spec, whose rule id is a function of its operation
      // id — which is the whole reason `requirementIdFor` is derived rather than random.
      const rid = op.targetOperationId ? requirementIdFor(op.targetOperationId) : op.requirementId!;
      const c: AcceptanceCriterion = {
        id: criterionIdFor(op.id), requirementId: rid,
        criterion: op.criterion!, falsifier: op.falsifier!, evidenceKind: op.evidenceKind!,
        author: sp.author, createdAt: at, introducedBy: op.id, specId: sp.id,
      };
      // Bind, for the reason `add_requirement` binds: without it `readOperations({requirementId})`
      // is not the rule's whole history, and a criterion added alongside its rule is attached
      // to an operation that names no requirement at all.
      bound = { ...op, requirementId: rid };
      await writeLocalOperation(root, bound);
      await writeLocalCriterion(root, c);
    } else if (op.kind === "move_section") {
      // Read fresh, in `ord` order with everything else, so a rule this same spec adds to
      // the subtree at an earlier ord moves with it.
      const { requirements: members } = await readRequirements(root, { section: op.fromSection! });
      for (const m of members) {
        await writeLocalRequirement(root, { ...m, section: movedSection(m.section, op.fromSection!, op.toSection!) });
      }
    } else {
      const r = (await readRequirement(root, op.requirementId!))!;
      const next: Requirement = op.kind === "retire_requirement"
        ? { ...r, status: "retired", retiredBy: who, retiredAt: at }
        : {
          ...r, statement: op.statement!, ratifiedBy: who, ratifiedAt: at,
          amendedBy: [...(r.amendedBy ?? []), sp.id],
        };
      await writeLocalRequirement(root, next);
    }
    applied.push(bound);
  }

  const next: Spec = { ...sp, status: "ratified", ratifiedBy: who, ratifiedAt: at };
  if (shared.local) await writeLocalSpec(root, next);
  // Gaps raised against this spec's operations named an operation, because the rule did
  // not exist yet. Bind them to what the operations produced, or nothing asking "what is
  // silencing this requirement" would ever find them.
  if (shared.local) {
    const { bindGapsForSpec } = await import("./acknowledgements.js");
    await bindGapsForSpec(root, sp.id);
    // And the detectors proposed with it. Same moment, same reason: a check becomes live
    // when the rule it discharges does, and never before.
    const { bindPointersForSpec } = await import("./pointers.js");
    await bindPointersForSpec(root, sp.id);
  }
  return { ok: true, spec: next, applied };
}

/**
 * What the FOLD did with a ratification, read back rather than assumed.
 *
 * Three outcomes, and the middle one is why this exists at all:
 *
 *  - folded and clean → the real applied operations, bound to the rules they created.
 *  - folded and `conflicted` → the act happened and applied NOTHING. That is a failure of
 *    adoption even though the append succeeded, so it must not return `ok`.
 *  - not folded here → appended and durable; this machine simply cannot say yet. Saying so
 *    is the honest answer, and it is not an error: `materializeStandard` documents that its
 *    failure is not failure of the write.
 */
async function sharedRatification(
  root: string, sp: Spec, submitted: Operation[], outcome: Shared, who: Actor, at: string,
): Promise<Ratification | Err> {
  const asked: Spec = { ...sp, status: "ratified", ratifiedBy: who, ratifiedAt: at };
  const folded = outcome.folded ? await readSpec(root, sp.id) : null;
  if (!folded || folded.status !== "ratified") {
    return {
      ok: true, spec: asked, applied: null, submitted,
      pending:
        `${sp.id} is appended to the shared log and durable, but this machine has not folded `
        + `it yet, so what it applied is not knowable here. Re-read the spec after the next sync.`,
    };
  }
  if (folded.conflicted) {
    return {
      error:
        `${sp.id} was ratified and the fold applied NOTHING from it: at least one operation was `
        + `written against a statement another clone's ratification had already changed. The `
        + `standard is unchanged. Do not retry — the ratification really happened, so the spec `
        + `is spent and cannot be adopted again. Draft a new spec against the current text.`,
    };
  }
  // Bound by the fold, which is the only writer on this path.
  return { ok: true, spec: folded, applied: await readOperations(root, { specId: sp.id }) };
}

/** One thing that has come to depend on a rule, and would be falsified by removing it. */
export interface Reliance {
  kind: "operation" | "acknowledgement" | "audit" | "problem" | "criterion" | "pointer" | "population" | "vacuity";
  id: string;
  /** The rule relied on. */
  requirementId: string;
  detail: string;
}

/**
 * What relies on the rules a spec introduced.
 *
 * Reliance is a REFERENCE COUNT, which is why which backout applies is decided by the
 * store rather than by the person asking. Two exclusions, and both are the point rather
 * than convenience: this spec's own operations and its own criteria are not reliance on
 * itself, and a gap chained to one of its operations is an approval of a rule that is
 * about to stop existing — it ends with the spec, which is the job withdrawal gives it.
 *
 * The list is longer than `docs/requirements-architecture.md` enumerates, and deliberately:
 * that passage was written when audits, acknowledgements and problems were the only things
 * that could cite a rule. Criteria, pointers and population pins all can now, and a
 * withdrawal that left one of them pointing at a rule nobody can read is the orphan the
 * reference count exists to prevent.
 */
export async function relianceOn(root: string, ops: Operation[]): Promise<Reliance[]> {
  const introduced = ops.filter((o) => o.kind === "add_requirement").map((o) => requirementIdFor(o.id));
  const own = new Set(ops.map((o) => o.id));
  const out: Reliance[] = [];
  for (const requirementId of introduced) {
    for (const o of await readOperations(root, { requirementId })) {
      if (own.has(o.id)) continue;
      out.push({ kind: "operation", id: o.id, requirementId, detail: `${o.kind} in ${o.specId}` });
    }
    for (const a of await readAcknowledgements(root, { requirementId })) {
      if (a.operationId && own.has(a.operationId)) continue;
      if (a.state === "released") continue;
      out.push({ kind: "acknowledgement", id: a.id, requirementId, detail: `${a.basis} (${a.state})` });
    }
    // PROVISIONAL rows do not count, in either. Reliance is the one place the tool and the
    // fold have to agree, and the fold cannot see them at all — `foldStandard` refuses a
    // provisional audit, problem or pin — so counting them here refuses a withdrawal on
    // evidence that exists on no other clone, naming an id no teammate can resolve. The
    // failure is safe (it refuses before appending) and it is still a divergence, which is
    // exactly what `sharing-boundary.test.ts` §BOTH_ENDS exists to keep out.
    for (const a of await readAudits(root, { requirementId })) {
      if (a.provisional) continue;
      out.push({ kind: "audit", id: a.id, requirementId, detail: a.outcome });
    }
    for (const pr of await readProblems(root, { requirementId })) {
      if (pr.provisional) continue;
      out.push({ kind: "problem", id: pr.id, requirementId, detail: "raised against this rule" });
    }
    for (const c of await readCriteria(root, { requirementId })) {
      if (own.has(c.introducedBy)) continue;
      out.push({ kind: "criterion", id: c.id, requirementId, detail: c.evidenceKind });
    }
    for (const p of await readPointers(root, { requirementId })) {
      out.push({ kind: "pointer", id: p.id, requirementId, detail: p.state });
    }
    for (const p of await readPopulations(root, { requirementId })) {
      if (p.provisional) continue;
      out.push({ kind: "population", id: p.id, requirementId, detail: p.state });
    }
  }
  // A vacuity check hangs off a CRITERION, not off a rule, so it is invisible to the loop
  // above — and the criteria a spec introduced are deleted along with its rules. Somebody
  // established whether that criterion's assertion can fail; withdrawing over it discards
  // the answer and leaves the check pointing at nothing.
  for (const o of ops) {
    if (o.kind !== "add_criterion") continue;
    const criterionId = criterionIdFor(o.id);
    for (const v of await readVacuityChecks(root, { criterionId })) {
      out.push({ kind: "vacuity", id: v.id, requirementId: o.requirementId ?? criterionId, detail: v.verdict });
    }
  }
  return out;
}

/**
 * Who may withdraw, and the one case where it is not a principal.
 *
 * The refusal `principal()` hands back — *"an agent may author and propose; adopting is
 * what makes a claim binding, and it cannot be delegated"* — is exactly right about a
 * RATIFIED spec and wrong about a draft. Withdrawing a draft adopts nothing and unbinds
 * nothing: no requirement exists, no acknowledgement is active, nothing can cite it. It is
 * the author taking back their own unratified proposal, which is authorship, and COD-29
 * puts authorship on the open side of the asymmetry.
 *
 * Two conditions, and both are here rather than in a description:
 *
 *  - **Its own author**, compared on the principal. An agent acting for the person who
 *    proposed it is that proposal's author; an agent acting for somebody else is not, and
 *    withdrawing a third party's proposal is not correcting your own mistake.
 *  - **Nothing of anybody else's is attached.** A pending gap is another actor's approval
 *    artifact and a comment is their reading; taking the proposal away destroys the
 *    subject of both. Same reference-count machinery `withdrawSpec` already applies to a
 *    ratified spec, at the lower threshold a draft warrants.
 *
 * A principal is refused none of this and needs no such check: `withdraw_spec` on a draft
 * has always been theirs.
 */
async function withdrawer(root: string, sp: Spec, input: ActorInput): Promise<Actor | Err> {
  const a = requireActor(root, input);
  if (isErr(a)) return a;
  if (!isAgentActor(a)) return a;
  if (sp.status !== "draft") {
    return {
      error:
        `withdrawing a ${sp.status} spec is a principal's act and this session is an agent acting `
        + `for ${a.principal}. A DRAFT is yours to take back — nothing applied, so nothing is `
        + `unbound — but ${sp.id} already ${sp.status === "ratified" ? "binds the standard" : "left draft"}, `
        + `and removing what it put there cannot be delegated. Ask ${a.principal} to withdraw it.`,
    };
  }
  if (sp.author.principal !== a.principal) {
    return {
      error:
        `${sp.id} was proposed by ${sp.author.principal} and this session is acting for `
        + `${a.principal}. An agent may take back its own principal's draft; withdrawing somebody `
        + `else's proposal is disposing of it, which is theirs or a principal's. Say what you `
        + `think in a comment instead.`,
    };
  }
  for (const op of await readOperations(root, { specId: sp.id })) {
    const blocked = await attachedByOthers(root, op, input);
    if (blocked) return blocked;
  }
  const said = await commentsByOthers(root, sp.id, a.principal);
  if (said) return said;
  return a;
}

/**
 * Withdraw a spec — the BEFORE-reliance half of backout.
 *
 * A draft may always be withdrawn: nothing has applied, so there is nothing to falsify,
 * and it is what ends a pre-approved gap's life along with the proposal it was attached to.
 *
 * A RATIFIED spec may be withdrawn only while its effects are still self-contained, and
 * `relianceOn` decides that rather than the caller. Two things it is not:
 *
 * - **It is not a delete.** The spec keeps its row and its ratification. Removing a ratified
 *   spec from the log would destroy the audit trail of the act most worth auditing; what
 *   comes out of the standard is what the spec PUT there.
 * - **It is not a revert.** A spec that amended, retired or re-filed something that already
 *   existed is refused outright, however little relies on it, because undoing it means
 *   restoring a statement together with the witnesses taken when it was adopted — and the
 *   row no longer holds them, the amendment re-baselined them. A "revert" would therefore
 *   re-baseline the old text against today's code as though the amendment had never
 *   happened, which is a fabricated observation on the most authoritative record here. A
 *   compensating spec restores the text as its own witnessed act, which is honest and is
 *   what `docs/requirements-architecture.md` means by repeal.
 */
export async function withdrawSpec(
  root: string, specId: string, input: { reason: string } & ActorInput,
): Promise<{ ok: true; spec: Spec; removed: string[] } | (Err & { reliance?: Reliance[] })> {
  const reason = input.reason?.trim();
  if (!reason) return { error: "a withdrawal needs a `reason` — it stays on the record as the act it is" };
  const sp = await readSpec(root, specId);
  if (!sp) return { error: `no spec "${specId}"` };
  if (sp.status === "withdrawn" || sp.status === "repealed") return { error: `${specId} is already ${sp.status}` };

  const who = await withdrawer(root, sp, input);
  if (isErr(who)) return who;

  const ops = await readOperations(root, { specId });
  if (sp.status === "ratified") {
    const changed = ops.find((o) => o.kind !== "add_requirement" && o.kind !== "add_criterion");
    if (changed) {
      return {
        error:
          `${specId} cannot be withdrawn: ${changed.id} is a ${changed.kind}, so it changed something `
          + `that already existed. Undoing that means restoring a statement AND the witnesses taken `
          + `when it was adopted, which the row no longer holds — the amendment re-baselined them — `
          + `so the restored text would be witnessed against today's code as if it had never been `
          + `amended. Repeal it instead: a new spec whose operations reverse this one's, which puts `
          + `the old text back as its own witnessed act.`,
      };
    }
    const reliance = await relianceOn(root, ops);
    if (reliance.length) {
      return {
        error:
          `${specId} cannot be withdrawn: ${reliance.length} thing(s) already rely on what it `
          + `introduced (${reliance.slice(0, 5).map((r) => `${r.kind} ${r.id}`).join(", ")}`
          + `${reliance.length > 5 ? ", …" : ""}). Withdrawal is mistake correction and is honest only `
          + `while nothing downstream is falsified. Repeal it instead: a new spec whose operations `
          + `reverse this one's.`,
        reliance,
      };
    }
  }

  const doomedIds = sp.status === "ratified"
    ? [
      ...ops.filter((o) => o.kind === "add_requirement").map((o) => requirementIdFor(o.id)),
      ...ops.filter((o) => o.kind === "add_criterion").map((o) => criterionIdFor(o.id)),
    ]
    : [];
  // EVERY repository, not just this one. `relianceOn` above counted what this universe can
  // see, and that is a verdict about one repo dressed as a verdict about the standard — the
  // rule leaves here and stays there, permanently, with nothing saying so. This reads every
  // standard scope on the sidecar and refuses if any is unsettled, because *cannot
  // determine* is a refusal. The scopes it read are pinned on the event; the fold checks
  // itself against that list. Only for a ratified spec: a draft applied nothing, so there is
  // nothing anywhere to rely on it.
  let checkedScopes: string[] = [];
  if (sp.status === "ratified") {
    const everywhere = await relianceEverywhere(root, doomedIds);
    if ("error" in everywhere) return everywhere;
    checkedScopes = everywhere.scopes;
  }

  const at = now();
  const outcome = await shareSpecWithdrawn(root, sp.id, at, reason, checkedScopes);
  const d = disposition(outcome);
  if ("error" in d) return d;
  const removed = doomedIds;
  if (!d.local) {
    // Three outcomes, and collapsing the middle two is the mistake `sharedRatification`
    // documents: the FOLD decides on this path and it can REFUSE, because the local
    // reference count cannot see a citation another clone appended concurrently. Reporting
    // a refusal as "not folded yet" would tell the caller to wait for a removal that is
    // never going to happen.
    const folded = await readSpec(root, sp.id);
    if (folded?.status === "withdrawn") return { ok: true, spec: folded, removed };
    if (outcome.shared && outcome.folded) {
      return {
        error:
          `${sp.id} was NOT withdrawn: this machine folded the log and something appended `
          + `elsewhere already relies on what the spec introduced — the local reference count `
          + `could not see it, because the log is pull/push and never read on an ordinary read. `
          + `The standard is unchanged and the spec stays ratified. Sync, then repeal it with a `
          + `compensating spec if it still needs to go.`,
      };
    }
    return {
      error:
        `${sp.id} is appended to the shared log and durable, but this machine has not folded it `
        + `yet, so what it removed is not knowable here. Re-read the spec after the next sync.`,
    };
  }

  // Guarded on status, the way the fold guards it: a DRAFT applied nothing, so there is
  // nothing of its to remove. The deletes would be harmless no-ops — `requirementIdFor` on
  // an operation that was never adopted names a row that does not exist — but two ends that
  // read differently is how one of them later stops meaning what the other does.
  if (sp.status === "ratified") {
    for (const op of ops) {
      if (op.kind === "add_requirement") await deleteLocalRequirement(root, requirementIdFor(op.id));
      if (op.kind === "add_criterion") await deleteLocalCriterion(root, criterionIdFor(op.id));
    }
  }
  // A gap chained to one of these operations approved a rule that will now never exist. It
  // is RELEASED rather than deleted, for the reason the spec is: the grant really happened.
  const { releaseAcknowledgement } = await import("./acknowledgements.js");
  for (const op of ops) {
    for (const a of await readAcknowledgements(root, { operationId: op.id })) {
      if (a.state !== "released") await releaseAcknowledgement(root, a.id, `${sp.id} was withdrawn`, input);
    }
  }
  // A detector PROPOSED with one of these operations, by the same argument. Withdrawal was
  // the exit from `pending` that nothing covered — ratification binds, and an operation
  // pulled from the draft retires AT ratification, but a spec that is never adopted at all
  // left the pointer pending for ever, watching a criterion that will never exist and
  // reachable by nothing. Retired rather than deleted: it really was proposed.
  const { retirePendingForSpec } = await import("./pointers.js");
  await retirePendingForSpec(root, sp.id, `${sp.id} was withdrawn`, who);
  const next: Spec = { ...sp, status: "withdrawn", withdrawnBy: who, withdrawnAt: at };
  await writeLocalSpec(root, next);
  return { ok: true, spec: next, removed };
}

/**
 * Re-file or rename a requirement. Organization only — never the statement.
 *
 * Principal-gated, and the reason is not symmetry: a title is what most readers read, so
 * retitling a binding rule to agree with the code launders it one field over, leaving the
 * statement untouched and the operation trail empty.
 */
export async function reorganizeRequirement(
  root: string, id: string, changes: { title?: string; section?: string }, input: ActorInput = {},
): Promise<{ ok: true; requirement: Requirement } | Err> {
  const who = principal(root, input, "re-file a requirement");
  if (isErr(who)) return who;
  const r = await readRequirement(root, id);
  if (!r) return { error: `no requirement "${id}"` };

  const title = changes.title === undefined ? r.title : changes.title.trim();
  const section = changes.section === undefined ? r.section : normalizeSection(changes.section);
  if (!title) return { error: "a requirement needs a title" };
  if (!section) return { error: "a requirement needs a section" };
  if (title === r.title && section === r.section) return { error: "nothing to change" };
  if (section !== r.section) {
    const clash = await checkSection(root, section);
    if (clash) return clash;
  }
  if (r.origin) {
    return {
      error:
        `${r.id} is the team's, and re-filing one shared rule has no shared act — writing it `
        + `locally would be erased by the next sync. Move the whole heading with a `
        + `\`move_section\` operation in a spec, or amend the rule so the re-filing is a `
        + `decision somebody ratified rather than one machine's edit.`,
    };
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

/**
 * One rule, and everything on the record about it.
 *
 * The AUDIT HISTORY is the half this used to omit, and omitting it made the record
 * answer the wrong question: a rule renders its conformance verdict, and the reader
 * who has to act on that verdict needs *when it was last looked at, by what, and what
 * has been silencing it* — which is the difference between a state and an account of
 * how it got there. None of it is a new record: audits, pointers, acknowledgements
 * and problems all already key on `requirementId`; nothing here was unqueryable, it
 * was just not on the one surface that reads a rule.
 *
 * Everything is read UNFILTERED — released acknowledgements, retired pointers,
 * superseded audits and all. This is a history, and a history that shows only what is
 * live is the one shape it must not take: a waiver somebody released is exactly the
 * thing a reader is looking for when they ask why a rule went quiet for six months.
 */
export async function getRequirement(
  root: string, id: string,
): Promise<{
  requirement: ServedRequirement; history: Operation[];
  audits: Audit[]; pointers: Pointer[]; acknowledgements: Acknowledgement[]; problems: Problem[];
} | Err> {
  const r = await readRequirement(root, id);
  if (!r) return { error: `no requirement "${id}"` };
  const [requirement, history, audits, pointers, acknowledgements, problems] = await Promise.all([
    serve(root, r),
    readOperations(root, { requirementId: id }),
    readAudits(root, { requirementId: id }),
    readPointers(root, { requirementId: id }),
    readAcknowledgements(root, { requirementId: id }),
    readProblems(root, { requirementId: id }),
  ]);
  // The CODEBASE's record. A provisional audit is an observation of somebody's branch and
  // is served separately, the same split `conformance({ about })` draws — an audit history
  // that mixes the two is the confusion the whole provisional mechanism exists to prevent.
  return {
    requirement, history, pointers, acknowledgements, problems,
    audits: audits.filter((a) => !a.provisional),
  };
}

/** One operation rendered for review: what it does, to what, and what it would produce. */
export interface RenderedOperation {
  operation: Operation;
  /** The rule as it stands. Absent for `add_requirement`, which has no before. */
  before?: ServedRequirement;
  /** The statement this operation would produce. Absent for a retirement. */
  after?: string;
  /**
   * The ground this operation was written against has moved; it cannot be adopted as
   * drafted. For most kinds that is `context` — the statement. For a `move_section`, whose
   * subject is a path rather than a rule, it is the ends of the move: `moves.blocked` says
   * which, and ratification refuses on the same test.
   */
  contextMoved: boolean;
  /**
   * Why, in the ratifier's words rather than a boolean — present whenever `contextMoved`
   * is set by something they cannot see from `before` and `after`.
   *
   * For a `move_section` it is `moves.blocked`, surfaced here too so one field answers the
   * question for every kind. For an `add_requirement` it is a section that now clashes by
   * case with one another spec has since introduced: `ratifySpec` re-checks that per
   * operation and refuses, and this rendering did not, so the button was enabled right up
   * to the refusal. That is the failure this surface exists to prevent — a principal told
   * they can dispose of a spec and then told they cannot goes back to reading code.
   */
  blockedBy?: string;
  /**
   * Gap acknowledgements already raised against this operation — a SILENCER that binds the
   * moment the spec is ratified.
   *
   * Rendered because the ratifier is the only person who can refuse it and could not see
   * it: a gap may only be minted while the spec is a draft, and ratification then binds it
   * to the rule the operation creates, so the rule arrives already classified `gap` rather
   * than `unknown` — on an agent's assertion that no code which should conform exists yet.
   * That assertion is not checkable until the population predicate is built. Approving the
   * rule is not approving the classification, and it was impossible to tell them apart.
   */
  silencedBy: Acknowledgement[];
  /**
   * What is watching the rule this operation changes — the DOWNWARD half of the pointer
   * relation, and the reason it is one relation and not two.
   *
   * Upward it populates the audit queue; downward it prices a proposal. A ratified
   * amendment means code that was conformant may not be any more, and the person deciding
   * is the one who cannot otherwise see how much is pointed at the rule they are about to
   * move. Absent for `add_requirement`, which has no rule to be watching yet.
   */
  watchedBy: Pointer[];
  /**
   * Detectors PROPOSED with this operation, binding if the spec is ratified.
   *
   * Served so the ratifier can SEE which check is meant to discharge a criterion. They
   * cannot sign it — the address is on a pointer and pointers are evidence, so it is not in
   * `operationContent` — and being on the page while they decide is what it gets instead.
   */
  proposedDetectors: Pointer[];
  /**
   * For `move_section`: the rules that would actually move, and where each lands.
   *
   * Rendered rather than left to the operation's two path fields because the trade this
   * surface exists for is "read N operations instead of 5,000 lines" — and the one thing a
   * principal cannot see from `Credit` → `Risk` is how much is filed under it. The set is
   * read LIVE, so a rule added to the subtree since drafting shows up here rather than
   * moving unannounced.
   */
  moves?: {
    from: string; to: string;
    /** Why it can no longer be applied, when `contextMoved` says it cannot. */
    blocked?: string;
    members: { id: string; title: string; from: string; to: string }[];
  };
}

/**
 * A spec rendered for a principal to dispose of.
 *
 * This is what replaces reading lines of code, and the whole trade is that a principal
 * reads N operations instead of 5,000 lines. If disposing of one means leaving this
 * surface to find the current text, the rationale or what else the rule touches, the trade
 * fails at its last step and the process reverts to reading code.
 */
export async function getSpec(
  root: string, specId: string,
): Promise<{
  spec: Spec; operations: RenderedOperation[]; adoptable: boolean; silenced: number;
  removed: Operation[]; review?: ReviewGap; signedOff: boolean;
  reviewers: { principal: string; signed: number }[];
} | Err> {
  const sp = await readSpec(root, specId);
  if (!sp) return { error: `no spec "${specId}"` };
  const ops = await readOperations(root, { specId });
  const operations: RenderedOperation[] = [];
  for (const op of ops) {
    const target = op.requirementId ? await readRequirement(root, op.requirementId) : null;
    const before = target ? await serve(root, target) : undefined;
    let contextMoved = !!op.context && (!target || target.statement !== op.context.statement);
    let blockedBy: string | undefined;
    let moves: RenderedOperation["moves"];
    // The same re-check ratification does, on the same subject. Only while it is a draft:
    // on a spec already disposed of this would report the standard as it is now against an
    // act that is history.
    if (op.kind === "add_requirement" && sp.status === "draft") {
      const clash = await checkSection(root, op.section!, sectionsIntroducedBy(ops.filter((o) => o.id !== op.id)));
      if (clash) { contextMoved = true; blockedBy = clash.error; }
    }
    if (op.kind === "move_section") {
      // A move carries no `context` — its subject is a path — so the check above cannot
      // see that its ends have shifted, and the spec would render `adoptable` right up to
      // the ratification that refuses it. That is the failure this surface exists to
      // prevent: a principal who is told they can dispose of a spec and then cannot goes
      // back to reading code, which is the trade lost at its last step.
      const bad = await checkMove(root, op.fromSection!, op.toSection!, ops.filter((o) => o.id !== op.id));
      if (bad) { contextMoved = true; blockedBy = bad.error; }
      const { requirements: members } = await readRequirements(root, { section: op.fromSection! });
      moves = {
        from: op.fromSection!, to: op.toSection!,
        ...(bad ? { blocked: bad.error } : {}),
        members: members.map((m) => ({
          id: m.id, title: m.title, from: m.section,
          to: movedSection(m.section, op.fromSection!, op.toSection!),
        })),
      };
    }
    operations.push({
      operation: op,
      ...(before ? { before } : {}),
      ...(op.kind === "retire_requirement" || op.kind === "move_section" ? {} : { after: op.statement }),
      ...(moves ? { moves } : {}),
      contextMoved,
      ...(blockedBy ? { blockedBy } : {}),
      // PENDING, not active — and this is the surface that makes the distinction worth
      // having. A pre-approved gap silences nothing until this spec is adopted, so it is
      // pending right up to the moment the ratifier decides; reading only `active` here
      // would hide it from the one person who can refuse it, on the one screen where they
      // could. `released` is the state to exclude: somebody already withdrew that one.
      silencedBy: (await readAcknowledgements(root, { operationId: op.id }))
        .filter((a) => a.state !== "released"),
      watchedBy: target ? await readPointers(root, { requirementId: target.id, state: "active" }) : [],
      // The detectors PROPOSED with this operation. On the page while the ratifier decides,
      // which is the whole reason the verb exists: the check is not in `operationContent`,
      // so it is not signed — being seen is what it gets instead, and it cannot be that
      // without being served here.
      proposedDetectors: (await readPointers(root, { state: "pending" })).filter((p) => p.operationId === op.id),
    });
  }
  // The reader's OWN review gap, which is the WARNING half of the mechanism whose refusing
  // half is in `ratifySpec`. Here is where being told is useful, because there is still
  // something to do about it; at the ratify boundary there is only a click to block.
  const me = resolvePrincipal(root);
  const allWitnesses = await readProposalWitnesses(root, { specId });
  const review = me ? reviewGap(sp, ops, allWitnesses, me) : undefined;
  // And who else has read it, because "am I the only one who has looked at this" is the
  // question a ratifier asks next and could not answer from anywhere.
  const byReviewer = new Map<string, Set<string>>();
  for (const w of allWitnesses) {
    if (!byReviewer.has(w.reviewer.principal)) byReviewer.set(w.reviewer.principal, new Set());
    byReviewer.get(w.reviewer.principal)!.add(w.operationId ?? "");
  }

  return {
    spec: sp, operations,
    ...(review ? { review } : {}),
    reviewers: [...byReviewer].map(([p, subjects]) => ({ principal: p, signed: subjects.size })),
    // Served apart from `operations`, never mixed in. What the ratifier reads is what the
    // proposal now says; a pulled operation is history, and rendering it beside the live
    // ones would put back exactly the correction-chain the revision path exists to remove.
    // It is served at all because a proposal that changed shape under a reader is worth
    // seeing, and because the removal reason is the author's account of why.
    removed: await readOperations(root, { specId, includeRemoved: true }).then((all) => all.filter((o) => o.removed)),
    // A property of the PROPOSAL — do its operations still apply to the standard as it
    // stands — and deliberately not of the reader. Whether YOU have signed it off is a
    // different question with a different subject, and folding it in here would make one
    // spec adoptable for one person and not another under a name that reads like a fact
    // about the spec. `signedOff` is that second question, kept beside it.
    adoptable: sp.status === "draft" && ops.length > 0 && !operations.some((o) => o.contextMoved),
    // Both are required to ratify, and the browser disables its button on both. The
    // REFUSAL still lives in `ratifySpec` — a disabled button is a nicer way to be told,
    // never the thing that stops it.
    signedOff: !!review && reviewComplete(review),
    // Deliberately NOT folded into `adoptable`: a pre-attached gap is a thing to see and
    // decide about, not a defect in the spec. Refusing adoption over one would make the
    // silencer harder to raise than to ratify, which is backwards.
    silenced: operations.reduce((n, o) => n + o.silencedBy.length, 0),
  };
}

/** The ratification queue — every draft, oldest first. */
export async function pendingSpecs(
  root: string,
): Promise<{ spec: Spec; operations: number; irreversible: boolean; silenced: number }[]> {
  const drafts = await readSpecs(root, { status: "draft" });
  const out: { spec: Spec; operations: number; irreversible: boolean; silenced: number }[] = [];
  for (const spec of drafts) {
    const ops = await readOperations(root, { specId: spec.id });
    // Counted in the QUEUE, not only inside the spec: a gap binds at ratification and the
    // ratifier is the last person who can refuse it, so "this proposal arrives pre-silenced"
    // has to be visible before they open it. `irreversible` is here for the same reason.
    let silenced = 0;
    for (const op of ops) {
      silenced += (await readAcknowledgements(root, { operationId: op.id }))
        .filter((a) => a.state !== "released").length;
    }
    out.push({
      spec, operations: ops.length,
      irreversible: ops.some((o) => o.reversibility === "irreversible"), silenced,
    });
  }
  return out;
}
