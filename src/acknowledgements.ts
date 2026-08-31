/**
 * Acknowledgements, and the conformance classification they answer (COD-29).
 * `docs/requirements-architecture.md` is normative; this implements it.
 *
 * An acknowledgement says *the rule stands, we know it is not met, do not raise it*. It is
 * the record that makes adopting a standard against an existing codebase survivable —
 * ratifying a rule otherwise turns every existing violation into a filed problem at that
 * instant, which is the principal-time arithmetic failing on day one.
 *
 * It is also a **silencer**, which makes it the thing most worth reaching for under
 * deadline, so the shape of the guards matters more here than anywhere else in the model:
 *
 *  - **A `gap` may only be minted before ratification**, against an operation in a DRAFT
 *    spec. There is no path to one afterwards, which is enforced by the mint taking an
 *    operation id rather than a requirement id. Filing a gap in response to a raised
 *    problem would be the laundering pattern arriving through a third door — not *amend
 *    the rule to match the code*, but *declare the rule not yet applicable*.
 *  - **`debt` is post-hoc and principal-granted**, at the cost of a waiver, because it is
 *    an admission with an owner.
 *  - **Gate what silences, never what unsilences.** Releasing is open to any actor: its
 *    failure mode is noise, and noise is recoverable. Granting is what needs the gate.
 *
 * The conformance classification these feed lives in `audits.ts`, one layer up, because it
 * depends on audits too — and a gap is RELEASED by a positive audit rather than from here.
 *
 * Not built, and named so their absence is legible: the problem record these silence, and
 * the population predicate, which is what will give a gap an honest magnitude.
 */

import { randomBytes } from "node:crypto";
import type {
  Acknowledgement, AcknowledgementPriority, Actor,
} from "./schema.js";
import { ACK_PRIORITIES, ISO_DATE, parseAsOf } from "./schema.js";
import {
  readAcknowledgement, readAcknowledgements, readOperations, readRequirement,
  readSpec, writeLocalAcknowledgement,
} from "./store.js";
import { isAgentActor, requireActor } from "./identity.js";
import type { ActorInput } from "./identity.js";
import { disposition, shareAckGranted, shareAckReleased } from "./standard-publish.js";

const mint = () => "ack_" + randomBytes(6).toString("hex");
const now = () => new Date().toISOString();

export type Err = { error: string };
const isErr = (x: unknown): x is Err => !!x && typeof x === "object" && "error" in (x as object);

// From `schema.ts`, so the fold checks the same two things — see `ACK_PRIORITIES`.
const PRIORITIES = ACK_PRIORITIES;

/** An acknowledgement as served: the record plus what is DERIVED about it. */
export interface ServedAcknowledgement extends Acknowledgement {
  /**
   * Past its revalidate-by date. Derived at read time, never stored — a stored status is
   * a field, and a field is something a writer can satisfy.
   *
   * This is not an expiry: nothing is released automatically, because releasing would
   * silently un-silence a rule nobody has looked at. It means *somebody looks again*,
   * which is the only property the effective-date idea actually had.
   */
  revalidateDue: boolean;
}

const serve = (a: Acknowledgement, asOf: string): ServedAcknowledgement => ({
  ...a,
  revalidateDue: a.state === "active" && a.revalidateBy <= asOf,
});

function principal(root: string, input: ActorInput, verb: string): Actor | Err {
  const a = requireActor(root, input);
  if (isErr(a)) return a;
  if (isAgentActor(a)) {
    return {
      error:
        `${verb} is a principal's act and this session is an agent acting for ${a.principal}. `
        + `An agent may establish that the code does not conform; accepting that it will stay `
        + `that way is an admission with an owner. Ask ${a.principal} to ${verb}.`,
    };
  }
  return a;
}

function checkCommon(input: { rationale?: string; priority?: string; revalidateBy?: string }): Err | null {
  if (!input.rationale?.trim()) return { error: "an acknowledgement needs a rationale — it is a record of a decision, not a mute button" };
  if (!PRIORITIES.includes(input.priority as AcknowledgementPriority)) {
    return { error: `priority must be one of ${PRIORITIES.join(" | ")}` };
  }
  if (!input.revalidateBy || !ISO_DATE.test(input.revalidateBy)) {
    return {
      error:
        "an acknowledgement needs `revalidateBy` (an ISO date). It is the release condition, "
        + "and the only one: a work item may be linked as evidence but never as the condition, "
        + "because a ticket closed as won't-do, moved or deleted leaves the acknowledgement "
        + "silencing the audit permanently and silently.",
    };
  }
  return null;
}

// --- granting ----------------------------------------------------------------

/**
 * Acknowledge a **gap** — no code that should conform exists yet.
 *
 * Raised against an operation while its spec is still a draft, so holes get poked while
 * the thing is still a proposal. There is no path to one after ratification, and that
 * is the point rather than an ergonomic accident.
 *
 * Open to any actor: an auditor agent classifying ahead of adoption is exactly the
 * intended caller, and this is the one acknowledgement that admits nothing — it says the
 * work has not been done, not that we accept it never will be.
 */
export async function acknowledgeGap(
  root: string,
  input: {
    operationId: string; rationale: string; priority: AcknowledgementPriority;
    revalidateBy: string; workItem?: string;
  } & ActorInput,
): Promise<{ ok: true; id: string; acknowledgement: Acknowledgement } | Err> {
  const bad = checkCommon(input);
  if (bad) return bad;
  const ops = await readOperations(root);
  const op = ops.find((o) => o.id === input.operationId);
  if (!op) return { error: `no operation "${input.operationId}"` };
  // A gap says NO CODE THAT SHOULD CONFORM EXISTS YET, which can only be true of a rule
  // that does not exist yet either. Allowing one against an `amend_statement` re-opened the
  // door the mint-time asymmetry closes: draft a second spec amending a ratified rule, gap
  // the amendment, ratify, and the binding attaches an agent's gap to a rule the team has
  // been living under — post-ratification laundering by another route.
  if (op.kind !== "add_requirement") {
    return {
      error:
        `${op.id} is a \`${op.kind}\` on an existing rule, and a gap claims there is no code `
        + `that should conform yet — which cannot be true of a rule already in force. After `
        + `adoption the honest records are a problem, or debt granted by a principal.`,
    };
  }
  const sp = await readSpec(root, op.specId);
  if (!sp) return { error: `operation ${op.id} points at missing spec ${op.specId}` };
  if (sp.status !== "draft") {
    return {
      error:
        `${sp.id} is ${sp.status} — a gap may only be raised while the spec is still a draft. `
        + `After adoption the honest records are a problem (the code does not conform) or a debt `
        + `acknowledgement granted by a principal. Declaring a ratified rule not-yet-applicable `
        + `is how an audit gets cleared without anything being decided.`,
    };
  }
  const actor = requireActor(root, input);
  if (isErr(actor)) return actor;

  const a: Acknowledgement = {
    id: mint(), basis: "gap", operationId: op.id,
    rationale: input.rationale.trim(), priority: input.priority,
    revalidateBy: input.revalidateBy, ...(input.workItem ? { workItem: input.workItem } : {}),
    // PENDING, not active. A pre-approved gap is part of the argument a principal is being
    // asked to adopt, so it silences nothing until that argument is accepted — and then it
    // does so in the same act that creates the rule. A spec nobody ratifies leaves behind
    // no silencer nobody approved. See `AcknowledgementState`.
    state: "pending", grantedBy: actor, grantedAt: now(),
  };
  const d = disposition(await shareAckGranted(root, a));
  if ("error" in d) return d;
  if (d.local) await writeLocalAcknowledgement(root, a);
  return { ok: true, id: a.id, acknowledgement: a };
}

/**
 * Acknowledge **debt** — conforming code should exist, does not, and we are living with it.
 *
 * Principal-granted, at the cost of a waiver. This is the disposition the design would
 * otherwise lack, and lacking it is what pushes a deadline-pressed session into amending
 * the requirement so it agrees with the code.
 */
export async function acknowledgeDebt(
  root: string,
  input: {
    requirementId: string; rationale: string; priority: AcknowledgementPriority;
    revalidateBy: string; workItem?: string;
  } & ActorInput,
): Promise<{ ok: true; id: string; acknowledgement: Acknowledgement } | Err> {
  const bad = checkCommon(input);
  if (bad) return bad;
  const who = principal(root, input, "acknowledge debt");
  if (isErr(who)) return who;
  const r = await readRequirement(root, input.requirementId);
  if (!r) return { error: `no requirement "${input.requirementId}"` };
  if (r.status === "retired") return { error: `${r.id} is retired — nothing is owed against a withdrawn rule` };

  const a: Acknowledgement = {
    id: mint(), basis: "debt", requirementId: r.id,
    rationale: input.rationale.trim(), priority: input.priority,
    revalidateBy: input.revalidateBy, ...(input.workItem ? { workItem: input.workItem } : {}),
    state: "active", grantedBy: who, grantedAt: now(),
  };
  const d = disposition(await shareAckGranted(root, a));
  if ("error" in d) return d;
  if (d.local) await writeLocalAcknowledgement(root, a);
  return { ok: true, id: a.id, acknowledgement: a };
}

/**
 * Bind a spec's gap acknowledgements to the requirements its operations produced.
 *
 * Called on the LOCAL path at ratification. `foldStandard` does the same binding from the
 * same derivation (`requirementIdFor`), so a shared acknowledgement needs no second event
 * to find its rule — see `shared-standard.ts`'s `spec.ratified` case, which is where that
 * became true rather than merely claimed here. Before this a gap names an operation, because the
 * rule does not exist yet; afterwards it has to name the rule, or nothing asking "what is
 * silencing this requirement" would find it.
 */
export async function bindGapsForSpec(root: string, specId: string): Promise<number> {
  const ops = await readOperations(root, { specId });
  let bound = 0;
  for (const op of ops) {
    if (!op.requirementId) continue;
    for (const a of await readAcknowledgements(root, { operationId: op.id })) {
      if (a.requirementId) continue;
      // Binding and activating are ONE step, which is what "atomic with ratification"
      // means: the gap becomes a live silencer at the moment the rule it silences comes
      // into force, and never before. A released one stays released — adopting the spec
      // does not resurrect an acceptance somebody withdrew.
      if (a.state === "released") continue;
      await writeLocalAcknowledgement(root, { ...a, requirementId: op.requirementId, state: "active" });
      bound++;
    }
  }
  return bound;
}

/**
 * Release an acknowledgement — it no longer silences anything.
 *
 * Open to ANY actor, deliberately. Gate what silences, never what unsilences: granting
 * hides a fact, and its failure mode is a standard that looks satisfied; releasing
 * reveals one, and its failure mode is noise. Noise is recoverable.
 *
 * A reason is still required, because the next person to look needs to know whether the
 * work was done or the acknowledgement was simply wrong.
 */
export async function releaseAcknowledgement(
  root: string, id: string, reason: string, input: ActorInput = {},
): Promise<{ ok: true; acknowledgement: Acknowledgement } | Err> {
  if (!reason?.trim()) return { error: "releasing an acknowledgement needs a reason — was the work done, or was the record wrong?" };
  const a = await readAcknowledgement(root, id);
  if (!a) return { error: `no acknowledgement "${id}"` };
  if (a.state === "released") return { error: `${id} is already released` };
  const actor = requireActor(root, input);
  if (isErr(actor)) return actor;
  const at = now();
  const next: Acknowledgement = {
    ...a, state: "released", releasedBy: actor, releasedAt: at, releasedReason: reason.trim(),
  };
  // The basis picks the scope — a gap released into the evidence half would leave its
  // grant in the law half, and a clone folding only law would read it active for ever.
  const d = disposition(await shareAckReleased(root, a.id, at, reason.trim(), a.basis));
  if ("error" in d) return d;
  if (d.local) await writeLocalAcknowledgement(root, next);
  return { ok: true, acknowledgement: next };
}

// --- reading -----------------------------------------------------------------

export async function listAcknowledgements(
  root: string,
  opts: { requirementId?: string; state?: Acknowledgement["state"]; asOf?: string } = {},
): Promise<ServedAcknowledgement[]> {
  const asOf = parseAsOf(opts.asOf).at;
  const rows = await readAcknowledgements(root, { requirementId: opts.requirementId, state: opts.state });
  return rows.map((a) => serve(a, asOf));
}

/** The revalidation queue: active acknowledgements now past their date, worst first. */
export async function dueForRevalidation(
  root: string, opts: { asOf?: string } = {},
): Promise<ServedAcknowledgement[]> {
  const asOf = parseAsOf(opts.asOf).at;
  const rank: Record<AcknowledgementPriority, number> = { high: 0, medium: 1, low: 2 };
  return (await readAcknowledgements(root, { state: "active" }))
    .map((a) => serve(a, asOf))
    .filter((a) => a.revalidateDue)
    .sort((x, y) => rank[x.priority] - rank[y.priority] || x.revalidateBy.localeCompare(y.revalidateBy));
}
