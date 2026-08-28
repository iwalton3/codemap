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
  Actor, BugWitness, Operation, OperationKind, Requirement, Reversibility, Spec,
} from "./schema.js";
import { requirementIdFor } from "./schema.js";
import {
  readOperations, readRequirement, readRequirements, readSpec, readSpecs,
  requirementSectionCounts, workHas, writeLocalOperation, writeLocalRequirement, writeLocalSpec,
} from "./store.js";
import { liveHashes, witnessDrift, realDrift } from "./reviews.js";
import { ABSENT_HASH } from "./normalize.js";
import { isAgentActor, requireActor } from "./identity.js";
import type { ActorInput } from "./identity.js";
import {
  disposition, shareOperation, shareSpecDrafted, shareSpecRatified,
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
 * A section is a `/`-delimited path, normalized so trivially different spellings of one
 * place cannot become two places.
 */
function normalizeSection(raw: string): string {
  return raw.split("/").map((seg) => seg.trim().replace(/\s+/g, " ")).filter(Boolean).join("/");
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
      .find((o) => o.requirementId === r.id);
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
export async function ratifySpec(
  root: string, specId: string, input: ActorInput = {},
): Promise<{ ok: true; spec: Spec; applied: Operation[] } | (Err & { checks?: OperationCheck[] })> {
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
    if (!op.requirementId) continue;
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
      : (await readRequirement(root, op.requirementId!))?.cites ?? [];
    witnesses[op.id] = await witness(root, cites);
  }
  const shared = disposition(await shareSpecRatified(root, sp.id, at, witnesses, ops.map((o) => o.id)));
  if ("error" in shared) return shared;

  const applied: Operation[] = [];
  for (const op of ops) {
    // Shared: the fold applies the operations, and writing rows here would be erased by
    // the next sync. The loop still runs so the caller gets what was applied.
    if (!shared.local) { applied.push(op); continue; }
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
        `${r.id} is the team's, and re-filing has no shared act yet — a section move or rename `
        + `belongs in a spec as an operation, which is not built (see `
        + `docs/requirements-architecture.md). Writing it locally would be erased by the next sync.`,
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
  /** The context has moved; this operation cannot be adopted as drafted. */
  contextMoved: boolean;
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
): Promise<{ spec: Spec; operations: RenderedOperation[]; adoptable: boolean } | Err> {
  const sp = await readSpec(root, specId);
  if (!sp) return { error: `no spec "${specId}"` };
  const ops = await readOperations(root, { specId });
  const operations: RenderedOperation[] = [];
  for (const op of ops) {
    const target = op.requirementId ? await readRequirement(root, op.requirementId) : null;
    const before = target ? await serve(root, target) : undefined;
    const contextMoved = !!op.context && (!target || target.statement !== op.context.statement);
    operations.push({
      operation: op,
      ...(before ? { before } : {}),
      ...(op.kind === "retire_requirement" ? {} : { after: op.statement }),
      contextMoved,
    });
  }
  return {
    spec: sp, operations,
    adoptable: sp.status === "draft" && ops.length > 0 && !operations.some((o) => o.contextMoved),
  };
}

/** The ratification queue — every draft, oldest first. */
export async function pendingSpecs(root: string): Promise<{ spec: Spec; operations: number; irreversible: boolean }[]> {
  const drafts = await readSpecs(root, { status: "draft" });
  const out: { spec: Spec; operations: number; irreversible: boolean }[] = [];
  for (const spec of drafts) {
    const ops = await readOperations(root, { specId: spec.id });
    out.push({ spec, operations: ops.length, irreversible: ops.some((o) => o.reversibility === "irreversible") });
  }
  return out;
}
