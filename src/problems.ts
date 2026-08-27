/**
 * Problems and their adjudication (COD-29 §mechanism, §"the failure mode this exists to
 * stop"). `docs/requirements-architecture.md` is normative; this implements it.
 *
 * A problem says only that a ratified rule and the code do not agree. It is
 * **un-adjudicated by construction** — no verdict field an agent can set, and no input
 * that accepts one — because an agent can establish non-conformance and cannot establish
 * which side should move. The auditor's view is recorded as `prior`, which is context,
 * precisely so it does not have to be smuggled in as a resolution.
 *
 * **There is no `closeProblem`, and its absence is the enforcement.** The scenario the
 * whole record exists for is a new session with no context, pointed at a queue under
 * deadline pressure and told "fix it" — and a paragraph asking it to be careful will not
 * survive that. So closure is not a verb to refuse: it is DERIVED from whether the move
 * the adjudication named has actually happened.
 *
 *   code-wrong            → a conformant audit, after adjudication
 *   requirement-changed   → a ratified spec amending the rule, after adjudication
 *   requirement-misstated → the same
 *   accepted              → an active debt acknowledgement, granted after adjudication
 *
 * Which makes **adjudication and closure separate events**, and that separation is doing
 * real work: saying which side moves does not move it, so "adjudicate and forget" is
 * visible as an adjudicated problem that never closed.
 *
 * And the case worth catching rather than merely preventing: an UN-adjudicated problem
 * whose non-conformance has quietly disappeared. Somebody settled a business question by
 * changing code, which is exactly the failure this ticket describes. It is reported, not
 * hidden, and it never closes.
 */

import { randomBytes } from "node:crypto";
import type { Actor, Problem, ProblemDisposition } from "./schema.js";
import {
  readAcknowledgements, readAudits, readOperations, readProblem, readProblems,
  readRequirement, readSpec, writeLocalProblem,
} from "./store.js";
import { isAgentActor, requireActor } from "./identity.js";
import type { ActorInput } from "./identity.js";
import { auditsFor, type ServedAudit } from "./audits.js";

const mint = () => "pr_" + randomBytes(6).toString("hex");
const now = () => new Date().toISOString();

export type Err = { error: string };
const isErr = (x: unknown): x is Err => !!x && typeof x === "object" && "error" in (x as object);

const DISPOSITIONS: ProblemDisposition[] = [
  "code-wrong", "requirement-changed", "requirement-misstated", "accepted",
];

export type ProblemState = "open" | "adjudicated" | "closed";

export interface ServedProblem extends Problem {
  state: ProblemState;
  /** What still has to happen before this closes. Absent once it has. */
  awaiting?: string;
  /**
   * Nobody adjudicated, and the disagreement has gone away anyway — the code was changed,
   * or the rule retired, to settle a question that was never decided.
   *
   * This is the andon signal, and it is the reason the record does not simply close when
   * the non-conformance disappears: an agent under deadline resolving a business question
   * by guessing produces exactly this, and the guess is almost always "make it agree with
   * the code".
   */
  settledWithoutAdjudication: boolean;
}

function principal(root: string, input: ActorInput, verb: string): Actor | Err {
  const a = requireActor(root, input);
  if (isErr(a)) return a;
  if (isAgentActor(a)) {
    return {
      error:
        `${verb} is a principal's act and this session is an agent acting for ${a.principal}. `
        + `An agent may establish that the code and the rule disagree; deciding WHICH SIDE MOVES `
        + `is a business question, and the likeliest guess is to make the rule agree with the `
        + `code — which is the defect this record exists to prevent. Ask ${a.principal} to ${verb}.`,
    };
  }
  return a;
}

// --- raising -----------------------------------------------------------------

/**
 * Raise a problem from a non-conformant audit. Open to any actor — this is what an
 * auditor agent is for, and the record makes no adjudication.
 *
 * It takes an audit rather than free-standing prose, which is how *positive evidence
 * only* is enforced: the audit already had to record what was read or run, so a problem
 * cannot be filed on a suspicion.
 */
export async function raiseProblem(
  root: string,
  input: { auditId: string; summary: string; prior?: string } & ActorInput,
): Promise<{ ok: true; id: string; problem: Problem } | Err> {
  const summary = input.summary?.trim();
  if (!summary) return { error: "a problem needs a summary — what disagrees with what" };
  const audits = await readAudits(root);
  const audit = audits.find((a) => a.id === input.auditId);
  if (!audit) return { error: `no audit "${input.auditId}"` };
  if (audit.outcome !== "nonconformant") {
    return {
      error:
        `audit ${audit.id} is \`${audit.outcome}\` — a problem needs demonstrated `
        + `non-conformance. An \`indeterminate\` audit says nobody could verify the rule, which `
        + `is an unverified requirement rather than a violation; absence of evidence must never file.`,
    };
  }
  const dupe = (await readProblems(root, { requirementId: audit.requirementId }))
    .find((p) => p.auditId === audit.id);
  if (dupe) return { error: `${dupe.id} was already raised from audit ${audit.id}` };

  const actor = requireActor(root, input);
  if (isErr(actor)) return actor;
  const problem: Problem = {
    id: mint(), requirementId: audit.requirementId, auditId: audit.id, summary,
    ...(input.prior?.trim() ? { prior: input.prior.trim() } : {}),
    raisedBy: actor, raisedAt: now(),
  };
  await writeLocalProblem(root, problem);
  return { ok: true, id: problem.id, problem };
}

// --- adjudication (principal only) -------------------------------------------

/**
 * Say which side moves. The one act on this record that a principal must perform.
 *
 * It does not close anything — see the module header. Naming the direction is a decision;
 * the work still has to happen, and the record stays open until it does.
 */
export async function adjudicate(
  root: string, problemId: string, disposition: ProblemDisposition, reason: string,
  input: ActorInput = {},
): Promise<{ ok: true; problem: Problem } | Err> {
  if (!DISPOSITIONS.includes(disposition)) {
    return { error: `disposition must be one of ${DISPOSITIONS.join(" | ")}` };
  }
  if (!reason?.trim()) return { error: "adjudicating needs a reason — this is the record of a business decision" };
  const who = principal(root, input, "adjudicate a problem");
  if (isErr(who)) return who;
  const p = await readProblem(root, problemId);
  if (!p) return { error: `no problem "${problemId}"` };
  if (p.disposition) return { error: `${problemId} was already adjudicated as \`${p.disposition}\`` };

  const next: Problem = {
    ...p, disposition, adjudicatedBy: who, adjudicatedAt: now(), adjudicationReason: reason.trim(),
  };
  await writeLocalProblem(root, next);
  return { ok: true, problem: next };
}

// --- reading (state is derived, never stored) --------------------------------

/** Was the named move actually made, after it was named? */
async function moveMade(root: string, p: Problem, audits: ServedAudit[]): Promise<boolean> {
  const since = p.adjudicatedAt!;
  switch (p.disposition) {
    case "code-wrong":
      return audits.some((a) => a.outcome === "conformant" && !a.superseded && a.at > since);
    case "requirement-changed":
    case "requirement-misstated": {
      // A ratified spec that amended this rule after the decision. The operation is the
      // evidence, not the requirement's current text: text can match by coincidence.
      for (const op of await readOperations(root, { requirementId: p.requirementId })) {
        if (op.kind !== "amend_statement") continue;
        const sp = await readSpec(root, op.specId);
        if (sp?.status === "ratified" && (sp.ratifiedAt ?? "") > since) return true;
      }
      return false;
    }
    case "accepted":
      return (await readAcknowledgements(root, { requirementId: p.requirementId, state: "active" }))
        .some((a) => a.basis === "debt" && a.grantedAt > since);
    default:
      return false;
  }
}

const AWAITING: Record<ProblemDisposition, string> = {
  "code-wrong": "a conformant audit of the cited code",
  "requirement-changed": "a ratified spec amending the rule",
  "requirement-misstated": "a ratified spec clarifying the rule",
  "accepted": "a debt acknowledgement granted by a principal",
};

async function serve(root: string, p: Problem): Promise<ServedProblem> {
  const audits = await auditsFor(root, p.requirementId);
  if (!p.disposition) {
    // Un-adjudicated. It does NOT close when the disagreement evaporates: somebody
    // settled a business question by changing code or retiring the rule, and that is the
    // thing worth surfacing rather than tidying away.
    const r = await readRequirement(root, p.requirementId);
    const resolvedAnyway = r?.status === "retired"
      || audits.some((a) => a.outcome === "conformant" && !a.superseded && a.at > p.raisedAt);
    return {
      ...p, state: "open", awaiting: "a principal to say which side moves",
      settledWithoutAdjudication: !!resolvedAnyway,
    };
  }
  const done = await moveMade(root, p, audits);
  return {
    ...p, state: done ? "closed" : "adjudicated",
    ...(done ? {} : { awaiting: AWAITING[p.disposition] }),
    settledWithoutAdjudication: false,
  };
}

export async function listProblems(
  root: string, opts: { requirementId?: string } = {},
): Promise<ServedProblem[]> {
  const rows = await readProblems(root, opts);
  return Promise.all(rows.map((p) => serve(root, p)));
}

/**
 * The adjudication queue: problems nobody has decided.
 *
 * This is the ONLY queue an un-adjudicated problem appears in. It is deliberately not a
 * fix queue — putting it in one is what lets a session with no context resolve a business
 * question by guessing, which is the failure the record exists to stop.
 */
export async function awaitingAdjudication(root: string): Promise<ServedProblem[]> {
  const rows = await readProblems(root, { unadjudicated: true });
  return Promise.all(rows.map((p) => serve(root, p)));
}

/**
 * The fix queue — work that has been DECIDED and is owed.
 *
 * An un-adjudicated problem is structurally absent from it, which is the refusal stated
 * as a query rather than as a guard: there is nothing to bypass, because the row was
 * never in the result.
 */
export async function actionable(root: string): Promise<ServedProblem[]> {
  return (await listProblems(root)).filter((p) => p.state === "adjudicated");
}

/** Problems that went away without anyone deciding. The andon signal. */
export async function settledWithoutAdjudication(root: string): Promise<ServedProblem[]> {
  return (await listProblems(root)).filter((p) => p.settledWithoutAdjudication);
}
