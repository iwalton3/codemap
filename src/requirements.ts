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
 *
 * Not built, and named so their absence is legible: section move/rename operations,
 * withdrawal and repeal, the acknowledgement record, audits, the problem record, and the
 * sidecar scope that makes any of this shared. Until the last one, these are local rows.
 */

import { randomBytes } from "node:crypto";
import type {
  AcceptanceCriterion, Acknowledgement, Actor, BugWitness, EvidenceKind, Operation, OperationKind,
  Pointer, Requirement, Reversibility, Spec,
} from "./schema.js";
import { criterionIdFor, EVIDENCE_KINDS, movedSection, normalizeSection, requirementIdFor } from "./schema.js";
import {
  readAcknowledgements, readAudits, readCriteria, readOperations, readPopulations, readProblems,
  readRequirement, readRequirements, readSpec, readSpecs, readVacuityChecks,
  readPointers, requirementSectionCounts, workHas, writeLocalCriterion, writeLocalOperation,
  writeLocalRequirement, writeLocalSpec, deleteLocalCriterion, deleteLocalRequirement,
} from "./store.js";
import { liveHashes, witnessDrift, realDrift } from "./reviews.js";
import { ABSENT_HASH } from "./normalize.js";
import { isAgentActor, requireActor } from "./identity.js";
import type { ActorInput } from "./identity.js";
import {
  disposition, shareOperation, shareSpecDrafted, shareSpecRatified, shareSpecWithdrawn, type Shared,
} from "./standard-publish.js";

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
  const ops = await readOperations(root, { requirementId: r.id });
  const irreversible = ops.some((o) => o.reversibility === "irreversible");
  // An unwitnessed requirement has no baseline, so nothing can have drifted from it.
  // Answering `recheckDue: true` there would report drift from a snapshot never taken.
  if (!r.witnesses.length) return { ...r, recheckDue: false, drifted: [], missing: [], irreversible };
  const live = await liveHashes(root, r.witnesses.map((w: BugWitness) => w.anchorId));
  // `realDrift` drops the changes a scheme difference explains away, so a re-normalization
  // does not send every reader back to a rule that is still satisfied.
  const changes = realDrift(witnessDrift(r.witnesses, live));
  const missing = changes.filter((c) => c.now === ABSENT_HASH).map((c) => c.anchorId);
  const drifted = changes.filter((c) => c.now !== ABSENT_HASH).map((c) => c.anchorId);
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

/**
 * Add an operation to a draft spec. Any actor.
 *
 * `rationale` and `reversibility` are required per operation, not per spec. That is the
 * structural defence against the drift both legislative drafting and ITIL change records
 * document: with the rationale attached to the operation there is no free-floating prose
 * to disagree with what actually lands.
 */
export async function addOperation(
  root: string,
  input: {
    specId: string; kind: OperationKind; rationale: string; reversibility: Reversibility;
    requirementId?: string; title?: string; section?: string; statement?: string;
    provenance?: string; cites?: string[]; evidence?: string;
    criterion?: string; falsifier?: string; evidenceKind?: EvidenceKind;
    assertedBy?: string[]; targetOperationId?: string;
    fromSection?: string; toSection?: string;
  } & ActorInput,
): Promise<{ ok: true; id: string; operation: Operation } | Err> {
  const sp = await readSpec(root, input.specId);
  if (!sp) return { error: `no spec "${input.specId}"` };
  if (sp.status !== "draft") return { error: `${sp.id} is ${sp.status} — operations may only be added to a draft` };

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
  const actor = requireActor(root, input);
  if (isErr(actor)) return actor;

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
    const clash = await checkSection(root, section, sectionsIntroducedBy(await readOperations(root, { specId: sp.id })));
    if (clash) return clash;
    const bad = checkCitations(root, input.cites ?? []);
    if (bad) return bad;
    payload = { title, section, statement, provenance, cites: input.cites ?? [] };
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
    const bad = checkCitations(root, input.assertedBy ?? []);
    if (bad) return bad;

    // Target: a rule that already stands, or one this same draft is about to create. The
    // second case is the authoring flow the playbook actually describes — criteria are
    // written WITH the rule, in one reviewed artifact — and the rule has no id yet, so the
    // operation is named instead. `Acknowledgement.operationId` solved this same shape.
    if (input.targetOperationId) {
      const target = (await readOperations(root, { specId: sp.id }))
        .find((o) => o.id === input.targetOperationId);
      if (!target) return { error: `no operation "${input.targetOperationId}" in ${sp.id}` };
      if (target.kind !== "add_requirement") {
        return { error: `${target.id} is a ${target.kind} — a criterion attaches to the rule an \`add_requirement\` creates` };
      }
      payload = { criterion, falsifier, evidenceKind: input.evidenceKind, assertedBy: input.assertedBy ?? [], targetOperationId: target.id };
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
      payload = { criterion, falsifier, evidenceKind: input.evidenceKind, assertedBy: input.assertedBy ?? [], requirementId: r.id };
    }
  } else if (input.kind === "move_section") {
    const from = normalizeSection(input.fromSection ?? "");
    const to = normalizeSection(input.toSection ?? "");
    if (!from || !to) {
      return { error: "`move_section` needs `fromSection` and `toSection` — `/`-delimited paths naming the subtree and where it lands" };
    }
    if (from === to) return { error: "the destination is the source — nothing to move" };
    const bad = await checkMove(root, from, to, await readOperations(root, { specId: sp.id }));
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
    const already = (await readOperations(root, { specId: sp.id }))
      .find((o) => o.requirementId === r.id && o.kind !== "add_criterion");
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

  const existing = await readOperations(root, { specId: sp.id });
  const op: Operation = {
    id: mint("op_"), specId: sp.id, kind: input.kind, ...payload,
    rationale, ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(context ? { context } : {}),
    reversibility: input.reversibility, ord: existing.length,
  } as Operation;
  const d = disposition(await shareOperation(root, op));
  if ("error" in d) return d;
  if (d.local) await writeLocalOperation(root, op);
  return { ok: true, id: op.id, operation: op };
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
): Promise<Ratification | (Err & { checks?: OperationCheck[] })> {
  const who = principal(root, input, "ratify");
  if (isErr(who)) return who;
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
      // Citations were checked when the operation was drafted; a symbol can vanish
      // between then and now. Ratifying anyway baselines the witness as `sha256:absent`,
      // and every later comparison is absent-against-absent — so a rule citing code that
      // is GONE reads as settled for ever.
      const gone = checkCitations(root, op.cites ?? []);
      if (gone) { checks.push({ operation: op, ok: false, reason: gone.error }); continue; }
    }
    if (op.kind === "add_criterion") {
      // Same reason, on the assertion rather than the subject — and it bites harder here.
      // A criterion whose check has vanished baselines every witness `sha256:absent`, so
      // the detector reads as never having moved, for ever: the assertion is gone and the
      // rule looks exactly as asserted as it did the day it was ratified.
      const gone = checkCitations(root, op.assertedBy ?? []);
      if (gone) { checks.push({ operation: op, ok: false, reason: gone.error }); continue; }
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

  const at = now();

  // Witnesses are an observation of THIS checkout, so they ride on the ratification event
  // rather than being recomputed by every clone — see `shared-standard.ts`.
  const witnesses: Record<string, BugWitness[]> = {};
  for (const op of ops) {
    const cites = op.kind === "add_requirement"
      ? op.cites ?? []
      // A criterion witnesses its ASSERTION, not the rule's subject. Different sets and
      // different questions: `cites` going stale means the code moved, `assertedBy` going
      // stale means the DETECTOR moved — which is the pathology nothing else catches.
      : op.kind === "add_criterion"
        ? op.assertedBy ?? []
        // A move's subject is a PATH, not code, so it witnesses nothing. It also names no
        // rule, and every branch below this one assumes one — which is the trap this
        // operation kind sets in each place that switches on the others by elimination.
        : op.kind === "move_section"
          ? []
          : (await readRequirement(root, op.requirementId!))?.cites ?? [];
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
        provenance: op.provenance!, status: "ratified", cites: op.cites ?? [],
        witnesses: await witness(root, op.cites ?? []),
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
        assertedBy: op.assertedBy ?? [], witnesses: await witness(root, op.assertedBy ?? []),
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
          // Adopting new text re-baselines the witnesses: the principal has just looked, so
          // the current code is what the ratified rule was adopted against. Keeping the old
          // hashes would serve a fresh ratification as already recheck-due.
          witnesses: await witness(root, r.cites),
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
    for (const a of await readAudits(root, { requirementId })) {
      out.push({ kind: "audit", id: a.id, requirementId, detail: a.outcome });
    }
    for (const pr of await readProblems(root, { requirementId })) {
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
  const who = principal(root, input, "withdraw a spec");
  if (isErr(who)) return who;
  const reason = input.reason?.trim();
  if (!reason) return { error: "a withdrawal needs a `reason` — it stays on the record as the act it is" };
  const sp = await readSpec(root, specId);
  if (!sp) return { error: `no spec "${specId}"` };
  if (sp.status === "withdrawn" || sp.status === "repealed") return { error: `${specId} is already ${sp.status}` };

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

  const at = now();
  const outcome = await shareSpecWithdrawn(root, sp.id, at, reason);
  const d = disposition(outcome);
  if ("error" in d) return d;
  const removed = sp.status === "ratified"
    ? [
      ...ops.filter((o) => o.kind === "add_requirement").map((o) => requirementIdFor(o.id)),
      ...ops.filter((o) => o.kind === "add_criterion").map((o) => criterionIdFor(o.id)),
    ]
    : [];
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

export async function getRequirement(
  root: string, id: string,
): Promise<{ requirement: ServedRequirement; history: Operation[] } | Err> {
  const r = await readRequirement(root, id);
  if (!r) return { error: `no requirement "${id}"` };
  return { requirement: await serve(root, r), history: await readOperations(root, { requirementId: id }) };
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
): Promise<{ spec: Spec; operations: RenderedOperation[]; adoptable: boolean; silenced: number } | Err> {
  const sp = await readSpec(root, specId);
  if (!sp) return { error: `no spec "${specId}"` };
  const ops = await readOperations(root, { specId });
  const operations: RenderedOperation[] = [];
  for (const op of ops) {
    const target = op.requirementId ? await readRequirement(root, op.requirementId) : null;
    const before = target ? await serve(root, target) : undefined;
    let contextMoved = !!op.context && (!target || target.statement !== op.context.statement);
    let moves: RenderedOperation["moves"];
    if (op.kind === "move_section") {
      // A move carries no `context` — its subject is a path — so the check above cannot
      // see that its ends have shifted, and the spec would render `adoptable` right up to
      // the ratification that refuses it. That is the failure this surface exists to
      // prevent: a principal who is told they can dispose of a spec and then cannot goes
      // back to reading code, which is the trade lost at its last step.
      const bad = await checkMove(root, op.fromSection!, op.toSection!, ops.filter((o) => o.id !== op.id));
      if (bad) contextMoved = true;
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
      // PENDING, not active — and this is the surface that makes the distinction worth
      // having. A pre-approved gap silences nothing until this spec is adopted, so it is
      // pending right up to the moment the ratifier decides; reading only `active` here
      // would hide it from the one person who can refuse it, on the one screen where they
      // could. `released` is the state to exclude: somebody already withdrew that one.
      silencedBy: (await readAcknowledgements(root, { operationId: op.id }))
        .filter((a) => a.state !== "released"),
      watchedBy: target ? await readPointers(root, { requirementId: target.id, state: "active" }) : [],
    });
  }
  return {
    spec: sp, operations,
    adoptable: sp.status === "draft" && ops.length > 0 && !operations.some((o) => o.contextMoved),
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
