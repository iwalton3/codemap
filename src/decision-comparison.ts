/** Pure semantic-comparison evidence and authority. Event admission and storage live elsewhere. */
import { createHash } from "node:crypto";
import { canonical, codeUnitOrder } from "./canonical.js";

export interface CanonicalIssue {
  universe: string; kind: "finding" | "bug" | "decision"; scope: string; id: string;
}
export interface AnswerSource {
  answerId: string; version: string; principal: string;
  questionId: string; questionVersion: string;
  /** Exact human-visible question, option descriptions, item context and action meaning. */
  display: { prompt: string; context?: string; answerFormat: string; options?: unknown[]; items?: unknown[]; action?: string };
  words: string;
}
export interface ComparisonRequest {
  id: string; left: AnswerSource; right: AnswerSource; issues: CanonicalIssue[];
  /** Hash of both complete answer sources and the canonical affected issue scope. */
  contextHash: string;
}
export type ComparisonVerdict = "equivalent" | "incompatible" | "unclear";
export interface ReaderJudgment {
  id: string; requestId: string; contextHash: string; issues: CanonicalIssue[];
  answerVersions: [string, string]; verdict: ComparisonVerdict; rationale: string;
  reader: { principal: string; agent: string; session: string; request: string; receipt: string };
  at: string;
}
export interface HumanResolution {
  id: string; requestId: string; contextHash: string; issues: CanonicalIssue[];
  answerVersions: [string, string]; preserve: string;
  /** Correct one earlier resolution by exact id. An independent resolution omits this. */
  revises?: string;
  /** What the person saw when correcting a prior resolution. */
  shownResolution?: { id: string; preserve: string; receipt: string };
  rationale: string; at: string;
  human: { principal: string; session: string; request: string; receipt: string; shownHash: string };
}
export interface ComparisonProjection {
  state: "pending" | "equivalent" | "incompatible" | "unclear" | "disputed" | "resolved";
  /** Only a resolved human choice selects an answer. */
  preservedAnswer?: string;
  acceptedJudgments: ReaderJudgment[];
  acceptedResolutions: HumanResolution[];
  history: { id: string; kind: "judgment" | "resolution"; state: "accepted" | "invalidated" | "refused"; reason?: string }[];
  /** Pending, unclear, incompatible and disputed all restrict dependent work. */
  restrictsWork: boolean;
}
export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const nonempty = (x: unknown): x is string => typeof x === "string" && !!x.trim();
const hash = (x: unknown) => createHash("sha256").update(canonical(x)).digest("hex");
const issueKey = (x: CanonicalIssue) => `${x.universe}\0${x.kind}\0${x.scope}\0${x.id}`;
const issueScope = (xs: CanonicalIssue[]) => xs.map(issueKey).sort();
const sameScope = (x: CanonicalIssue[], y: CanonicalIssue[]) => Array.isArray(x) && Array.isArray(y)
  && x.every((i) => i && nonempty(i.universe) && nonempty(i.scope) && nonempty(i.id))
  && JSON.stringify(issueScope(x)) === JSON.stringify(issueScope(y));
const versions = (x: [string, string]) => Array.isArray(x) && x.length === 2
  && x.every(nonempty) ? [...x].sort().join("\0") : "invalid";
const requestedVersions = (r: ComparisonRequest): [string, string] =>
  [`${r.left.answerId}\0${r.left.version}`, `${r.right.answerId}\0${r.right.version}`];
const complete = (s: AnswerSource) => nonempty(s.answerId) && nonempty(s.version) && nonempty(s.principal)
  && nonempty(s.questionId) && nonempty(s.questionVersion) && nonempty(s.words)
  && obj(s.display) && nonempty(s.display.prompt) && nonempty(s.display.answerFormat)
  && (s.display.context === undefined || typeof s.display.context === "string")
  && (s.display.action === undefined || typeof s.display.action === "string")
  && (s.display.options === undefined || Array.isArray(s.display.options))
  && (s.display.items === undefined || Array.isArray(s.display.items));

/** The hash binds all visible meaning, even when labels or effect tuples happen to match. */
export function comparisonContextHash(input: Pick<ComparisonRequest, "left" | "right" | "issues">): string {
  const sources = [input.left, input.right].sort((a, b) => codeUnitOrder(a.answerId, b.answerId));
  return hash({ sources, issues: issueScope(input.issues) });
}

export function validateComparisonRequest(r: ComparisonRequest): Validation<ComparisonRequest> {
  const errors: string[] = [];
  if (!nonempty(r.id) || !complete(r.left) || !complete(r.right)) errors.push("request needs exact answer versions and complete displayed source context");
  if (r.left.answerId === r.right.answerId || r.left.principal === r.right.principal)
    errors.push("comparison needs distinct answers from independent principals");
  if (!Array.isArray(r.issues) || !r.issues.length || r.issues.some((x) => !x || !nonempty(x.universe)
    || !["finding", "bug", "decision"].includes(x.kind) || !nonempty(x.scope) || !nonempty(x.id)))
    errors.push("comparison needs canonical affected issues");
  else if (new Set(r.issues.map(issueKey)).size !== r.issues.length) errors.push("affected issues repeat");
  if (!errors.length && r.contextHash !== comparisonContextHash(r)) errors.push("comparison context hash does not match the complete sources and scope");
  return errors.length ? { ok: false, errors } : { ok: true, value: r };
}

/** Derive from a set, without treating event array order as a verdict or a human timestamp. */
export function deriveComparison(r: ComparisonRequest, current: Record<string, string | undefined>,
  judgments: ReaderJudgment[], resolutions: HumanResolution[]): Validation<ComparisonProjection> {
  const valid = validateComparisonRequest(r);
  if (!valid.ok) return valid;
  const history: ComparisonProjection["history"] = [];
  const stale = current[r.left.answerId] !== r.left.version || current[r.right.answerId] !== r.right.version;
  const pair = versions(requestedVersions(r));
  const acceptedJudgments: ReaderJudgment[] = [];
  const readerCounts = new Map<string, number>();
  const judgmentIds = new Map<string, number>();
  for (const j of judgments) {
    if (nonempty(j.reader?.agent)) readerCounts.set(j.reader.agent, (readerCounts.get(j.reader.agent) ?? 0) + 1);
    if (nonempty(j.id)) judgmentIds.set(j.id, (judgmentIds.get(j.id) ?? 0) + 1);
  }
  for (const j of judgments) {
    let reason: string | undefined;
    if (stale) reason = "an answer version changed";
    else if (j.requestId !== r.id || j.contextHash !== r.contextHash || !sameScope(j.issues, r.issues)
      || versions(j.answerVersions) !== pair) reason = "judgment does not match exact request, versions and issue scope";
    else if (!["equivalent", "incompatible", "unclear"].includes(j.verdict) || !nonempty(j.rationale)
      || !nonempty(j.id) || !nonempty(j.at) || !nonempty(j.reader?.principal) || !nonempty(j.reader?.agent)
      || !nonempty(j.reader?.session) || !nonempty(j.reader?.request) || !nonempty(j.reader?.receipt)
      || [r.left.principal, r.right.principal].includes(j.reader.principal)) reason = "judgment needs an independent reader and logged rationale/receipt";
    else if (readerCounts.get(j.reader.agent)! > 1 || judgmentIds.get(j.id)! > 1) reason = "one reader or event id supplied multiple judgments";
    if (reason) history.push({ id: j.id, kind: "judgment", state: stale ? "invalidated" : "refused", reason });
    else { acceptedJudgments.push(j); history.push({ id: j.id, kind: "judgment", state: "accepted" }); }
  }
  const verdicts = new Set(acceptedJudgments.map((j) => j.verdict));
  let state: ComparisonProjection["state"] = !verdicts.size ? "pending"
    : verdicts.has("equivalent") && verdicts.has("incompatible") ? "disputed"
      : verdicts.has("unclear") ? "unclear"
        : verdicts.has("incompatible") ? "incompatible" : "equivalent";
  const acceptedResolutions: HumanResolution[] = [];
  const byId = new Map<string, HumanResolution>();
  const resolutionCounts = new Map<string, number>();
  for (const h of resolutions) if (nonempty(h.id)) resolutionCounts.set(h.id, (resolutionCounts.get(h.id) ?? 0) + 1);
  for (const h of resolutions) {
    let reason: string | undefined;
    if (stale) reason = "an answer version changed";
    else if (h.requestId !== r.id || h.contextHash !== r.contextHash || !sameScope(h.issues, r.issues)
      || versions(h.answerVersions) !== pair || ![r.left.answerId, r.right.answerId].includes(h.preserve))
      reason = "resolution does not match exact alternatives, versions and scope";
    else if (!nonempty(h.id) || !nonempty(h.rationale) || !nonempty(h.at)
      || !nonempty(h.human?.principal) || !nonempty(h.human?.session) || !nonempty(h.human?.request)
      || !nonempty(h.human?.receipt) || !nonempty(h.human?.shownHash)
      || !h.human.shownHash.startsWith("resolution:v1:"))
      reason = "resolution needs an explicit human act shown the complete context";
    else if (state !== "incompatible" && state !== "disputed") reason = "human resolution requires an incompatible or disputed reader judgment";
    else if (resolutionCounts.get(h.id)! > 1) reason = "resolution id repeats";
    if (reason) history.push({ id: h.id, kind: "resolution", state: stale ? "invalidated" : "refused", reason });
    else { acceptedResolutions.push(h); byId.set(h.id, h); history.push({ id: h.id, kind: "resolution", state: "accepted" }); }
  }
  // Validate correction chains against the whole set. Broken or cyclic links grant nothing.
  let changed = true;
  while (changed) {
    changed = false;
    for (const h of acceptedResolutions) if (h.revises && byId.has(h.id)) {
      const prior = byId.get(h.revises);
      const seen = new Set<string>();
      let cursor: HumanResolution | undefined = h;
      while (cursor && !seen.has(cursor.id)) { seen.add(cursor.id); cursor = cursor.revises ? byId.get(cursor.revises) : undefined; }
      const cycle = !!cursor;
      if (!prior || prior.id === h.id || prior.human.principal !== h.human.principal || cycle
        || h.shownResolution?.id !== prior.id || h.shownResolution.preserve !== prior.preserve
        || h.shownResolution.receipt !== prior.human.receipt) {
        const row = history.find((x) => x.id === h.id && x.kind === "resolution")!;
        row.state = "refused"; row.reason = "correction must name a prior resolution shown to the same principal";
        byId.delete(h.id); changed = true;
      }
    }
  }
  const corrected = new Set([...byId.values()].map((h) => h.revises).filter((id): id is string => !!id));
  const finalResolutions = acceptedResolutions.filter((h) => byId.has(h.id));
  const frontier = finalResolutions.filter((h) => !corrected.has(h.id));
  const choices = new Set(frontier.map((h) => h.preserve));
  let preservedAnswer: string | undefined;
  if (frontier.length && choices.size === 1) { state = "resolved"; preservedAnswer = frontier[0]!.preserve; }
  else if (choices.size > 1) state = "disputed";
  return { ok: true, value: { state, ...(preservedAnswer ? { preservedAnswer } : {}),
    acceptedJudgments, acceptedResolutions: finalResolutions, history,
    restrictsWork: state !== "equivalent" && state !== "resolved" } };
}
