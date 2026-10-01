/**
 * The shape every decisions and standard event must have, checked once where it enters a fold
 * and by the sidecar transport before a commit or a pull (plan 1.2).
 *
 * A wrong shape is NEWER (owner, batch 1): skipped on read, refused by the door, and it blocks
 * pushes until an upgrade. This checks types and the fields a conforming build always writes —
 * never that a field is absent — so a teammate one version ahead, whose events carry a field
 * this build does not know, still reads. An unknown kind is skipped, not checked.
 *
 * What depends on other events (an answer to a question that does not exist) is not a shape;
 * the fold refuses it and `validation.ts judge` decides what the refusal means.
 */
import type { LogEvent } from "./eventlog.js";

type Check = (v: unknown) => boolean;
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text: Check = (v) => typeof v === "string" && v.trim().length > 0;
const string: Check = (v) => typeof v === "string";
const opt = (c: Check): Check => (v) => v === undefined || c(v);
const list = (c: Check): Check => (v) => Array.isArray(v) && v.every(c);
const record = (fields: Record<string, Check>): Check => (v) =>
  obj(v) && Object.entries(fields).every(([k, c]) => c(v[k]));
const anyObj: Check = obj;
const bool: Check = (v) => typeof v === "boolean";

/** A decision as `checkDecision` reads it, typed far enough that the check itself cannot throw. */
const decision = record({
  id: text, round: text, ref: string, kind: string,
  payload: record({ question: string, options: list(record({ label: string })) }),
  options: list(record({ label: string, effects: list(anyObj) })),
});
const mapping = record({ decision: text, option: (v) => v === null || text(v) });
const issues = opt(list(anyObj));

/** The fields each live decisions kind must carry, by type. Dev-era shapes fail here. */
const DECISION_SHAPES: Record<string, Check> = {
  // `publication: 2` is how every round and confirm has been written since round ids became
  // event ids; one without it is a dev-era posting (plan 1.2).
  "decision.round.posted": record({
    publication: (v) => v === 2,
    round: record({ id: text, source: text, universe: opt(string), questionnaire: opt(anyObj), notes: opt(list(string)) }),
    decisions: list(decision),
  }),
  "decision.confirm.posted": record({
    publication: (v) => v === 2, round: text,
    decision: (v) => decision(v) && record({ confirms: record({ answer: text, readings: list(list(mapping)) }) })(v),
  }),
  "decision.question.logged": record({
    session: text, toolUseId: text, answeredAt: text, rounds: (v) => list(text)(v) && (v as unknown[]).length > 0,
    bound: (v) => obj(v) && Object.values(v).every(text),
    questions: list(record({ question: string, options: list(record({ label: string })) })),
    answers: anyObj, transcript: opt(string),
  }),
  "decision.answer.recorded": record({
    decision: text, hash: text, relayedBy: opt(text),
    via: record({ kind: (v) => v === "question" || v === "message" || v === "unverified" || v === "direct" }),
  }),
  "decision.answer.revised": record({
    decision: text, hash: text,
    via: (v) => record({ kind: (k) => k === "direct" || k === "revision-relay" })(v)
      && ((v as { kind: string }).kind !== "revision-relay"
        || record({ proof: record({ answer: string, question: opt(anyObj) }) })(v)),
    // A revision without the answers it revises is wrong-shaped (owner, batch 6 default 6).
    // A resolution's correction names no findings; the fold reads an absent list as empty.
    revision: record({ of: list(text), findings: opt(list(string)), issues, resolves: opt(anyObj) }),
    list: opt(anyObj),
  }),
  "decision.questionnaire.submitted": record({
    round: text,
    staged: record({ attemptId: text, payloadHash: text, questionnaireId: text, answers: list(anyObj), listApprovals: list(anyObj) }),
  }),
  "decision.comparison.nominated": record({
    answers: (v) => list(text)(v) && (v as unknown[]).length === 2, findings: list(text), issues, reason: text,
  }),
  "decision.comparison.requested": record({
    request: record({ id: text, left: anyObj, right: anyObj, issues: list(anyObj), contextHash: text }),
  }),
  "decision.comparison.judged": record({ judgment: record({ requestId: text, reader: anyObj }), proof: anyObj }),
  "decision.comparison.resolved": record({ resolution: record({ requestId: text, human: anyObj }), proof: anyObj }),
  "decision.withdrawn": record({
    decision: text, reason: text, knownAnswers: list(text), answer: opt(text), relay: opt(text), review: opt(anyObj),
  }),
  "decision.reading.recorded": record({
    answer: text, asks: opt(string),
    reader: record({ agent: text, launchedAt: text, brief: text, unclear: opt(string), verdict: opt(list(mapping)),
      manifest: opt(list(anyObj)), verified: record({ session: text }) }),
    session: record({ maps: list(mapping), reading: opt(string) }),
  }),
};

const operation = record({
  id: text, specId: text, kind: text,
  requirementId: opt(string), title: opt(string), section: opt(string), statement: opt(string),
  fromSection: opt(string), toSection: opt(string), provenance: opt(string), criterion: opt(string),
  falsifier: opt(string), evidenceKind: opt(string), targetOperationId: opt(string), rationale: opt(string),
  evidence: opt(string), context: opt(record({ requirementId: string, statement: string })),
  revisions: opt(list(anyObj)), removed: opt(record({ reason: opt(string) })),
});

/** The standard's kinds, by the types the fold dereferences (the `?.trim()` sites among them). */
const STANDARD_SHAPES: Record<string, Check> = {
  "spec.drafted": record({ spec: record({ id: text, title: string, createdAt: text }) }),
  "spec.operation": record({ operation }),
  "spec.revised": record({ spec: record({ id: text, title: string, narrative: opt(string), revisions: opt(list(anyObj)) }) }),
  "spec.operation.revised": record({ operation }),
  "spec.operation.removed": record({ operation }),
  "spec.operation-signoff-applied": record({ capsule: anyObj }),
  "spec.reviewed": record({ witness: record({ id: text, specId: text, operationId: opt(string), content: anyObj }), at: opt(string) }),
  "spec.ratified": record({ at: opt(string), witnesses: opt(anyObj), operations: opt(list(text)) }),
  "spec.withdrawn": record({ at: opt(string), reason: string }),
  "ack.granted": record({ ack: record({ id: text, basis: text, rationale: string, priority: string, revalidateBy: string, operationId: opt(string) }) }),
  "ack.released": record({ at: opt(string), reason: opt(string) }),
  "audit.recorded": record({ audit: record({ id: text, requirementId: text, trigger: opt(string), observations: opt(list(anyObj)), provisional: opt(bool) }) }),
  "vacuity.checked": record({ check: record({ id: text, criterionId: text, verdict: string, method: opt(string), witnesses: opt(list(anyObj)) }) }),
  "pointer.declared": record({ pointer: record({ id: text, requirementId: text, rationale: string, target: record({ kind: string }), witnesses: opt(list(anyObj)), operationId: opt(string), state: opt(string) }) }),
  "pointer.restated": record({ at: opt(string), witnesses: list(anyObj) }),
  "pointer.retired": record({ at: opt(string), reason: string }),
  "population.pinned": record({ pin: record({ id: text, requirementId: text, basis: string, members: list(record({ id: string, state: string })), reason: opt(string), provisional: opt(bool) }), supersedes: opt(string) }),
  "scrub.policy": record({ policy: anyObj }),
  "problem.raised": record({ problem: record({ id: text }) }),
  "problem.adjudicated": record({ disposition: string, reason: string, at: opt(string) }),
};

const check = (shapes: Record<string, Check>, e: LogEvent): string | null => {
  const shape = shapes[e.kind];
  if (!shape) return null;
  if (typeof e.subject !== "string") return "its subject is not text";
  return shape(e.data) ? null : `its data is not the shape a ${e.kind} is written in`;
};

/** Why a decisions event is wrong-shaped, or null. Unknown kinds are not checked. */
export const decisionEventShape = (e: LogEvent): string | null => check(DECISION_SHAPES, e);

/** Why a standard event is wrong-shaped, or null. Unknown kinds are not checked. */
export const standardEventShape = (e: LogEvent): string | null => check(STANDARD_SHAPES, e);

/** The shape check for whatever scope a shard belongs to, or null for a scope without one. */
export function shapeCheckFor(scope: string): ((e: LogEvent) => string | null) | null {
  if (scope.startsWith("decisions/")) return decisionEventShape;
  if (scope.startsWith("standard/") || scope.startsWith("law/")) return standardEventShape;
  return null;
}
