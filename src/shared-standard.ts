/**
 * The standard as shared state: what enters the log, and how it folds back.
 *
 * `docs/sidecar-architecture.md` is normative for shared state and this obeys it. The
 * rule that shapes everything below is its one-sentence version — **acts enter the log at
 * the moment they happen; everything derivable is a local projection.**
 *
 * So the events here are ACTS and nothing else:
 *
 *   spec.drafted · spec.operation · spec.ratified
 *   ack.granted · ack.released
 *   audit.recorded
 *   problem.raised · problem.adjudicated
 *
 * And the REQUIREMENTS are not among them. The standard is a projection of the ratified
 * specs, so a requirement is derived by replaying operations — which is exactly why its
 * id had to become a function of the operation that creates it (`requirementIdFor`). A
 * derived event has no honest actor and no honest causal position, and a deterministic
 * fold means every clone would mint its own copy.
 *
 * One scope per universe rather than one per record kind. The kinds cross-reference each
 * other constantly — a problem closes on an audit or on a ratified spec — and a fold sees
 * only its own scope's events, so splitting them would leave the derivations unable to
 * see their own inputs.
 *
 * **Witnesses are an observation of the ratifier's checkout**, carried on the ratification
 * event rather than recomputed per clone. A clone whose code differs then reads the rule
 * as recheck-due, which is the honest answer: the code it has is not the code the rule was
 * adopted against. Generalising this to a SET of accepted hashes, the way
 * `NodeCitation.acceptedHashes` already does per branch, is the obvious next move and is
 * deliberately not done here.
 */

import type {
  Acknowledgement, Actor, Audit, BugWitness, Operation, Problem, Requirement, Spec,
} from "./schema.js";
import { requirementIdFor } from "./schema.js";
import type { LogEvent } from "./eventlog.js";
import { emitEvent } from "./eventlog.js";

export const standardScope = (universe: string): string => `standard/${universe}`;

/** Everything one universe's standard scope folds to. */
export interface SharedStandard {
  specs: Spec[];
  operations: Operation[];
  requirements: Requirement[];
  acknowledgements: Acknowledgement[];
  audits: Audit[];
  problems: Problem[];
}

export const emptyStandard = (): SharedStandard => ({
  specs: [], operations: [], requirements: [], acknowledgements: [], audits: [], problems: [],
});

// --- writing -----------------------------------------------------------------

const put = (logRoot: string, scope: string, actor: Actor, kind: string, subject: string, data: Record<string, unknown>) =>
  emitEvent(logRoot, scope, actor, kind, subject, data);

export const publishSpecDrafted = (logRoot: string, scope: string, actor: Actor, spec: Spec) =>
  put(logRoot, scope, actor, "spec.drafted", spec.id, { spec });

export const publishOperation = (logRoot: string, scope: string, actor: Actor, op: Operation) =>
  put(logRoot, scope, actor, "spec.operation", op.specId, { operation: op });

/**
 * The ratification, carrying the witnesses the ratifier observed.
 *
 * The event is subject-keyed on the SPEC, not on any requirement: adopting a spec is one
 * act, and splitting it per operation would let a clone fold half an argument.
 */
export const publishSpecRatified = (
  logRoot: string, scope: string, actor: Actor, specId: string, at: string,
  witnesses: Record<string, BugWitness[]>,
) => put(logRoot, scope, actor, "spec.ratified", specId, { at, witnesses });

export const publishAckGranted = (logRoot: string, scope: string, actor: Actor, ack: Acknowledgement) =>
  put(logRoot, scope, actor, "ack.granted", ack.id, { ack });

export const publishAckReleased = (
  logRoot: string, scope: string, actor: Actor, id: string, at: string, reason: string,
) => put(logRoot, scope, actor, "ack.released", id, { at, reason });

export const publishAudit = (logRoot: string, scope: string, actor: Actor, audit: Audit) =>
  put(logRoot, scope, actor, "audit.recorded", audit.requirementId, { audit });

export const publishProblemRaised = (logRoot: string, scope: string, actor: Actor, problem: Problem) =>
  put(logRoot, scope, actor, "problem.raised", problem.id, { problem });

export const publishAdjudication = (
  logRoot: string, scope: string, actor: Actor, id: string,
  disposition: string, reason: string, at: string,
) => put(logRoot, scope, actor, "problem.adjudicated", id, { disposition, reason, at });

// --- folding -----------------------------------------------------------------

const obj = (d: unknown, k: string): any => (d && typeof d === "object" ? (d as any)[k] : undefined);
const str = (d: unknown, k: string): string | undefined => {
  const v = obj(d, k);
  return typeof v === "string" ? v : undefined;
};

/**
 * Replay one universe's standard.
 *
 * Events arrive in the log's total order, which is what makes this deterministic: every
 * clone sees the same sequence and applies the same operations to the same base. Anything
 * that would need a local observation — live hashes, whether the code conforms now — is
 * NOT computed here; it is derived at read time from rows the projection wrote.
 *
 * Unknown kinds are skipped rather than refused: a newer clone may write an act this
 * build does not model, and folding what it does understand is better than answering
 * nothing. What it must never do is drop a row it cannot PARSE — see `CorruptProjection`.
 */
export function foldStandard(events: LogEvent[]): SharedStandard {
  const specs = new Map<string, Spec>();
  const operations = new Map<string, Operation>();
  const requirements = new Map<string, Requirement>();
  const acknowledgements = new Map<string, Acknowledgement>();
  const audits = new Map<string, Audit>();
  const problems = new Map<string, Problem>();

  for (const e of events) {
    switch (e.kind) {
      case "spec.drafted": {
        const spec = obj(e.data, "spec") as Spec | undefined;
        if (spec?.id) specs.set(spec.id, { ...spec, status: "draft", origin: "sync" });
        break;
      }
      case "spec.operation": {
        const op = obj(e.data, "operation") as Operation | undefined;
        if (op?.id) operations.set(op.id, { ...op, origin: "sync" });
        break;
      }
      case "spec.ratified": {
        const sp = specs.get(e.subject);
        // A ratification for a spec this fold never saw drafted is not fatal: the drafting
        // shard may simply not have arrived yet, and the next sync completes it.
        if (!sp || sp.status === "ratified") break;
        const at = str(e.data, "at") ?? e.at;
        const witnesses = (obj(e.data, "witnesses") ?? {}) as Record<string, BugWitness[]>;
        specs.set(sp.id, { ...sp, status: "ratified", ratifiedBy: e.actor, ratifiedAt: at });
        const mine = [...operations.values()]
          .filter((o) => o.specId === sp.id)
          .sort((a, b) => a.ord - b.ord);
        for (const op of mine) applyOperation(requirements, op, sp, e.actor, at, witnesses[op.id] ?? []);
        break;
      }
      case "ack.granted": {
        const ack = obj(e.data, "ack") as Acknowledgement | undefined;
        if (!ack?.id) break;
        // DEBT is an admission with an owner, so an agent may not grant one — the same
        // rule `acknowledgeDebt` enforces, restated where a remote clone can see it. A
        // GAP from an agent is legitimate: an auditor classifying ahead of adoption is
        // the intended caller, and a gap admits nothing.
        if (ack.basis === "debt" && e.actor.via) break;
        acknowledgements.set(ack.id, { ...ack, state: "active", origin: "sync" });
        break;
      }
      case "ack.released": {
        const a = acknowledgements.get(e.subject);
        if (!a || a.state === "released") break;
        acknowledgements.set(a.id, {
          ...a, state: "released", releasedBy: e.actor,
          releasedAt: str(e.data, "at") ?? e.at, releasedReason: str(e.data, "reason") ?? "",
        });
        break;
      }
      case "audit.recorded": {
        const audit = obj(e.data, "audit") as Audit | undefined;
        if (!audit?.id) break;
        // Provisional work is about somebody's branch, not about the codebase. `shareAudit`
        // will not send one; this binds a client that did.
        if (audit.provisional) break;
        // Non-vacuity, restated at the fold. A `conformant` audit that touched no code
        // certifies nothing, and this is the only place that binds a writer whose tool
        // did not check — which is the one path by which `conformant` could be reached
        // without a code-backed audit.
        const ev = audit.evidence ?? {};
        if (audit.outcome === "conformant" && !(ev.read?.length || ev.ran?.length)) break;
        audits.set(audit.id, { ...audit, origin: "sync" });
        break;
      }
      case "problem.raised": {
        const p = obj(e.data, "problem") as Problem | undefined;
        if (!p?.id) break;
        // Raised state only, and EVERY adjudication field is stripped rather than just
        // the verdict: a payload carrying `adjudicatedBy` with no `disposition` would
        // otherwise fold to a problem that names a decider who never decided. Dropping
        // the verdict alone was the first version of this, and the test below is what
        // found it. See `docs/requirements-architecture.md`.
        // Same rule as the audit it rests on: a problem is exactly as shareable as its
        // evidence, and branch-local work is nobody else's.
        if (p.provisional) break;
        const { disposition, adjudicatedBy, adjudicatedAt, adjudicationReason, ...raised } = p;
        problems.set(p.id, { ...raised, origin: "sync" });
        break;
      }
      case "problem.adjudicated": {
        const p = problems.get(e.subject);
        if (!p || p.disposition) break;
        // The fold must not be more permissive than the tool: adjudication is a
        // principal's act, and a remote clone sees only this row.
        if (e.actor.via) break;
        const disposition = str(e.data, "disposition");
        if (!disposition) break;
        problems.set(p.id, {
          ...p, disposition: disposition as Problem["disposition"],
          adjudicatedBy: e.actor, adjudicatedAt: str(e.data, "at") ?? e.at,
          adjudicationReason: str(e.data, "reason") ?? "",
        });
        break;
      }
      default: break;
    }
  }

  return {
    specs: [...specs.values()], operations: [...operations.values()],
    requirements: [...requirements.values()], acknowledgements: [...acknowledgements.values()],
    audits: [...audits.values()], problems: [...problems.values()],
  };
}

/** The same application `ratifySpec` performs locally, over folded state. */
function applyOperation(
  requirements: Map<string, Requirement>, op: Operation, sp: Spec,
  who: Actor, at: string, witnesses: BugWitness[],
): void {
  if (op.kind === "add_requirement") {
    // The operation event was published when the operation was ADDED, before anything
    // bound a requirement to it — so the id is derived here rather than read off a field
    // that is legitimately absent. This is the whole reason it is a function of `op.id`.
    const id = requirementIdFor(op.id);
    requirements.set(id, {
      id, title: op.title!, section: op.section!, statement: op.statement!,
      provenance: op.provenance!, status: "ratified", cites: op.cites ?? [], witnesses,
      author: sp.author, createdAt: at, introducedBy: sp.id,
      ratifiedBy: who, ratifiedAt: at, origin: "sync",
    });
    return;
  }
  const r = op.requirementId ? requirements.get(op.requirementId) : undefined;
  if (!r) return;
  if (op.kind === "retire_requirement") {
    requirements.set(r.id, { ...r, status: "retired", retiredBy: who, retiredAt: at });
    return;
  }
  requirements.set(r.id, {
    ...r, statement: op.statement!, ratifiedBy: who, ratifiedAt: at,
    amendedBy: [...(r.amendedBy ?? []), sp.id], witnesses,
  });
}
