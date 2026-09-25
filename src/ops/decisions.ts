/**
 * Decision rounds: posting questions, recording what the person answered, and reading their
 * typed words onto options. The fold and the rulings are in `shared-decisions.ts`; the rulings
 * verbatim in docs/decision-rounds-worked-cases.md and the review rounds' `owner.md` files.
 *
 * Nothing here closes a finding: no answer closes one (owner, 2026-09-23). A ruling is carried
 * out by the verifier (I9) or by a person in session.
 *
 * Verification happens HERE, on the machine that asked — the transcript never travels
 * (owner: "verification needs to happen before it ends up in the fold").
 */
import { createHash, randomUUID } from "node:crypto";
import { isAgentActor } from "../identity.js";
import { bindDecisions, type Bound, type Via } from "../ops-shared.js";
import { lookupFinding, readStoreMeta, rulingApplicationsForAnswer, SIDECAR_LINEAGE, type SidecarMark } from "../store.js";
import { resolveSidecar } from "../sidecar-config.js";
import { canonicalIssueKey, resolveDecisionIssue, type CanonicalIssueReference } from "../decision-issues.js";
import {
  CONFIRM_NO, CONFIRM_YES, NONE, canonicalMaps, briefManifest, briefListing, briefRefusal, readingRefusal, readerBrief as briefFor, bindRefusal, checkDecision, checkQuestionnaireDecisions, confirmPayload, confirmState, confirmedWords, decisionHash, logQuestionEvent,
  mapsKey, named, namedIssues, possiblySuperseded, postConfirmEvent, postRoundEvent, validMaps,
  approveDecisionWithdrawalEvent, presentDecisionRevisionEvent, revisionRelayQuestion, withdrawalScope, standingForIssue,
  readingsInDispute, intentCandidates, nominateComparisonEvent, recordAnswerEvent, submitQuestionnaireEvent, recordReadingEvent, ruledNotCarriedOut, standing, standingForFinding, waitingOnMe, awaitingReading, parked, withdrawDecisionEvent, reviseAnswerEvent,
  type AnswerVia, type BriefEntry, type FoldedDecision, type Mapping, type SharedDecisions,
} from "../shared-decisions.js";
import { decisionsView } from "./decision-holds.js";
import { findVerdictCalls, isUnverified, readCall, readMessage, readReader, sameQuestion, sessionHolding, transcriptDir } from "../transcript.js";
import { saveReaderRequest, readerRequests, holdReaderReceipt, readerReceipts, settleReaderReceipt,
  legacyReaderRequest, legacyReaderVerdicts, holdLegacyReaderVerdict, pendingLegacyReaderAnswers,
  settleLegacyReaderVerdict, noteLegacyReaderVerdict, type LegacyReaderVerdict } from "../reader-local.js";
import type { AskedQuestion, Decision, DecisionRound } from "../schema.js";
import { questionnaireVersion, stageSubmission, type SubmissionDraft } from "../questionnaire.js";
import type { ScopeStatus } from "../eventlog.js";

/** Today by UTC date, for the views: parks are dated, and the fold holds no clock. Taken once
 *  per response, so a park cannot drop out of both views at midnight (owner, P3.2 (8)). */
const today = () => new Date().toISOString().slice(0, 10);

/** A write onto a scope the fold cannot read would be decided against rows that may be wrong. */
async function writable(root: string): Promise<{ s: SharedDecisions } | { error: string; status: ScopeStatus }> {
  const v = await decisionsView(root);
  if (v.status.status === "blocked") return { error: `the decisions log is blocked, so nothing is written: ${v.status.diagnostic?.detail ?? "unreadable"}`, status: v.status };
  return { s: v.s };
}

// --- posting ---------------------------------------------------------------------------

export interface NewRound { round: Omit<DecisionRound, "postedBy" | "at" | "universe" | "prevalidated">; decisions: Decision[] }

/** What posting refuses, shared by `postRound` and the import. */
export async function checkRound(root: string, r: NewRound): Promise<string | null> {
  const w = await writable(root);
  if ("error" in w) return w.error;
  const existing = w.s;
  if (!r?.round || typeof r.round.id !== "string" || !r.round.id.trim() || typeof r.round.source !== "string" || !r.round.source.trim()) return "a round needs an id and a source";
  if (!Array.isArray(r.decisions) || !r.decisions.length) return "a round needs at least one decision";
  if (r.round.questionnaire) {
    const qError = checkQuestionnaireDecisions(r.round.questionnaire, r.decisions);
    if (qError) return qError;
    if (existing.rounds.some((round) => round.questionnaire?.id === r.round.questionnaire!.id
      || round.id === r.round.questionnaire!.id || round.questionnaire?.id === r.round.id))
      return `questionnaire ${r.round.questionnaire.id} collides with a published questionnaire or round ID`;
  }
  if (existing.rounds.some((x) => x.id === r.round.id)) return `round ${r.round.id} is already posted; a changed question is a new decision in a new round`;
  const refs = new Set<string>(), ids = new Set<string>();
  for (const d of r.decisions) {
    if (d?.round !== r.round.id) return `decision ${String(d?.id)} names round ${String(d?.round)}, not ${r.round.id}`;
    const bad = checkDecision(d);
    if (bad) return `decision ${d.ref ?? d.id}: ${bad}`;
    if (d.resolves) {
      const pair = d.resolves.answers;
      const sources = pair.map((id) => existing.decisions.flatMap((x) => x.answers).find((a) => a.id === id));
      if (sources.some((a) => !a?.verified) || sources.some((a) => !d.payload.question.includes(JSON.stringify(a!.words))))
        return `decision ${d.ref}: a resolution must show both exact verified human answers`;
      if (sources[0]!.by.principal === sources[1]!.by.principal)
        return `decision ${d.ref}: a resolution needs rulings from two different people`;
      // Semantic conflicts can cross questions and escape the mechanical candidate list.
      // The agent must compare the exact source intent before asking the person.
    }
    if ((d.options as unknown as { closesOnAnswer?: unknown }[]).some((o) => o.closesOnAnswer !== undefined)) return `decision ${d.ref}: closesOnAnswer is gone — no answer closes a finding itself; a settle waits for the verifier`;
    // A reader's verdict names an option on one line, `D<n> → <label>` (owner, S0.8(c)). Asked
    // here and not in the fold, which must never drop a question already posted.
    const arrow = d.options.find((o) => /\n|→|->/.test(o.label));
    if (arrow) return `decision ${d.ref}: option "${arrow.label}" contains a newline or an arrow, so a reader's verdict line could not name it`;
    if (refs.has(d.ref)) return `two decisions in one round share the ref ${d.ref}`;
    refs.add(d.ref);
    // The fold keeps the first of two, so the second would be asked with the first's payload (bulk 8).
    if (ids.has(d.id)) return `two decisions in one round share the id ${d.id}`;
    ids.add(d.id);
    if (existing.decisions.some((x) => x.id === d.id)) return `decision ${d.id} is already posted`;
    // A decision names findings by codemap id, and only ones codemap holds (owner, 2026-09-23:
    // "Yes, refuse unrecorded"). Findings a round's own sort produced come in by import.
    for (const o of d.options) for (const e of o.effects) for (const f of e.findings) {
      const found = lookupFinding(root, f);
      if (!found) return `decision ${d.ref} names ${f}, which is not a finding this store holds — record it first (a skill round's findings come in through import_round)`;
      if ("ambiguous" in found) return `decision ${d.ref} names ${f}, which is a finding under more than one review (${found.ambiguous.join(", ")}), so a ruling on it could reach the wrong one`;
      // On this map only, the team's clones could not carry a ruling on it out (bulk 10).
      if (!found.finding.origin) return `decision ${d.ref} names ${f}, which is on this map only — publish it first (\`codemap unify-findings\`)`;
    }
    for (const o of d.options) for (const e of o.effects) for (const issue of e.issues ?? []) {
      const found = await resolveDecisionIssue(root, issue);
      if (!found.ok) return `decision ${d.ref}: ${found.error}`;
      if (canonicalIssueKey(found.ref) !== canonicalIssueKey(issue)) return `decision ${d.ref}: ${issue.id} did not resolve to the stated scope`;
    }
    if (d.supersedes) return `decision ${d.ref}: automatic question supersession is retired; use follows for context and withdraw a question explicitly`;
    if (d.follows && !existing.decisions.some((x) => x.id === d.follows))
      return `decision ${d.ref} follows ${d.follows}, which is not posted`;
  }
  return null;
}

/** Post a round of decisions, each with the exact `AskUserQuestion` payload it will be asked with. */
export async function postRound(root: string, r: NewRound, via: Via = {}, dir: string = transcriptDir()) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  await recordHeld(root, b, dir);
  if ((r?.round as any)?.prevalidated !== undefined) return { error: "only import_round marks a round pre-validated — it comes from a skill's sort of two sorters and an arbitrator" };
  const bad = await checkRound(root, r);
  if (bad) return { error: bad };
  await postRoundEvent(b.cfg.path, b.cfg.universe, b.actor, { ...r.round, universe: b.cfg.universe }, r.decisions);
  const { s } = await decisionsView(root);
  return {
    ok: true, round: r.round.id,
    ...(r.round.questionnaire ? { questionnaire: {
      id: r.round.questionnaire.id,
      version: questionnaireVersion(r.round.questionnaire),
      link: `/#/u/${encodeURIComponent(b.cfg.universe)}/decisions/${encodeURIComponent(r.round.id)}/`,
      retrieve: `questionnaire_detail(${JSON.stringify(r.round.questionnaire.id)}) or open the link after sidecar sync`,
    } } : {}),
    // What to ask with, verbatim — a paraphrase reads as unverified (C14).
    ask: r.decisions.map((d) => ({ decision: d.id, ref: d.ref, payload: s.decisions.find((x) => x.id === d.id)?.payload ?? d.payload })),
  };
}

/** Post a round the import built. Not exported to any surface: see `import_round`. The mark
 *  is provenance only — it closes nothing (owner, 2026-09-23). */
export async function postPrevalidated(root: string, b: Bound, r: NewRound, prevalidated: DecisionRound["prevalidated"]) {
  const bad = await checkRound(root, r);
  if (bad) return { error: bad };
  await postRoundEvent(b.cfg.path, b.cfg.universe, b.actor, { ...r.round, universe: b.cfg.universe, ...(prevalidated ? { prevalidated } : {}) }, r.decisions);
  return { ok: true as const, round: r.round.id };
}

const comparisonSummaries = (s: SharedDecisions) => s.comparisons.map((comparison) => ({
  id: comparison.request.id,
  state: comparison.projection.state,
  answers: [comparison.request.left.answerId, comparison.request.right.answerId] as [string, string],
  decisions: [comparison.request.left.questionId, comparison.request.right.questionId] as [string, string],
  issues: comparison.request.issues,
  restrictsWork: comparison.projection.restrictsWork,
}));

/** Published questionnaire, exact answers and per-principal completion. */
export async function questionnaireDetail(root: string, id: string, principal?: string) {
  const v = await decisionsView(root);
  const round = v.s.rounds.find((r) => r.questionnaire?.id === id || r.id === id);
  const q = round?.questionnaire;
  if (!round || !q) return { error: `no questionnaire ${id}`, status: v.status };
  const questions = q.sections.flatMap((section) => section.questions);
  const records = questions.map((question) => {
    const d = v.s.decisions.find((x) => x.round === round.id && x.id === question.id);
    return { questionId: question.id, decision: d?.id, withdrawn: !!d?.withdrawn,
      answers: d?.answers.filter((a) => a.verified && !a.sourceAnswer).map((a) => ({
        id: a.id, principal: a.by.principal, at: a.givenAt,
        source: a.questionnaire ?? { via: a.via, words: a.words },
        cancelled: a.cancelled, withdrawn: a.withdrawn, verified: a.verified,
      })) ?? [] };
  });
  const people = new Set([...(q.recipient ? [q.recipient] : []), ...(principal ? [principal] : []),
    ...records.flatMap((r) => r.answers.map((a) => a.principal))]);
  const progress = [...people].map((person) => {
    const submitted = records.filter((r) => !r.withdrawn && r.answers.some((a) => a.principal === person
      && !a.withdrawn && !a.cancelled)).map((r) => r.questionId);
    const withdrawn = records.filter((r) => r.withdrawn || (!submitted.includes(r.questionId)
      && r.answers.some((a) => a.principal === person && a.withdrawn))).map((r) => r.questionId);
    const unanswered = records.filter((r) => !submitted.includes(r.questionId)
      && !withdrawn.includes(r.questionId)).map((r) => r.questionId);
    return { principal: person, submitted, withdrawn, unanswered,
      counts: { submitted: submitted.length, withdrawn: withdrawn.length, unanswered: unanswered.length } };
  });
  return { id: q.id, round: round.id, questionnaire: q, version: questionnaireVersion(q),
    status: v.status, questions: records, progress,
    comparisons: intentCandidates(v.s).filter((candidate) => candidate.decisions.some((decision) =>
      v.s.decisions.find((d) => d.id === decision)?.round === round.id)),
    comparisonRecords: comparisonSummaries(v.s).filter((comparison) => comparison.decisions.some((decision) =>
      v.s.decisions.find((d) => d.id === decision)?.round === round.id)) };
}

export async function questionnaireList(root: string, principal?: string) {
  const v = await decisionsView(root);
  const entries = await Promise.all(v.s.rounds.filter((r) => r.questionnaire).map(async (r) => {
    const detail = await questionnaireDetail(root, r.id, principal);
    if ("error" in detail) return null;
    return { id: detail.id, round: detail.round, title: detail.questionnaire.title,
      recipient: detail.questionnaire.recipient, version: detail.version, progress: detail.progress };
  }));
  return { status: v.status, questionnaires: entries.filter((x) => x !== null) };
}

/** Selected answers are staged together, then admitted under the sidecar append lock. */
export async function submitQuestionnaire(root: string,
  input: { round: string; submission: SubmissionDraft }, via: Via = {}) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  const w = await writable(root);
  if ("error" in w) return w;
  const round = w.s.rounds.find((r) => r.id === input?.round);
  const q = round?.questionnaire;
  if (!q) return { error: `no published questionnaire on round ${String(input?.round)}` };
  const staged = stageSubmission(q, input.submission);
  if (!staged.ok) return { error: staged.errors.join("; ") };
  const event = await submitQuestionnaireEvent(b.cfg.path, b.cfg.universe, b.actor, round!.id, staged.value);
  if ("error" in event) return event;
  const after = await decisionsView(root);
  const answers = after.s.decisions.flatMap((d) => d.answers)
    .filter((a) => a.questionnaire?.submission === event.id)
    .map((a) => ({ id: a.id, questionId: a.questionnaire!.questionId,
      corrections: a.questionnaire!.corrections ?? [], approvals: a.questionnaire!.approvals ?? [] }));
  return { ok: true as const, questionnaire: q.id, round: round!.id,
    submission: event.id, attemptId: staged.value.attemptId, answers };
}

// --- reading ---------------------------------------------------------------------------

/** Every decision whose ruling verified words may yet overturn (plan A3). */
const superseding = (s: SharedDecisions) => s.decisions.flatMap((d) => {
  const p = possiblySuperseded(d, new Map(s.decisions.map((x) => [x.id, x])));
  return p.length ? [{ decision: d.id, round: d.round, ref: d.ref, words: p }] : [];
});

/** Unread words a reader's verdict is held for, marked so a verdict nobody records is visible. */
function withHeld<T extends { answer: string }>(root: string, list: T[]): (T & { verdict?: string })[] {
  let held: Map<string, string | undefined>;
  try {
    held = new Map();
    for (const item of list) {
      const pending = heldFor(root, item.answer).find((h) => h.state === "pending");
      if (pending) held.set(item.answer, pending.why);
    }
  } catch { return list; }
  return list.map((u) => (held.has(u.answer) ? { ...u, verdict: held.get(u.answer) ?? "a reader's verdict is held; record_reading records it" } : u));
}

/**
 * Every round, and the three things the person reads (owner, 2026-09-23). A read DEGRADES: a
 * broken or missing sidecar serves the rows this store holds, marked `blocked` (P3.2 (7)).
 */
export async function decisionRounds(root: string) {
  const v = await decisionsView(root);
  const { s } = v, now = today();
  return {
    ...v.status,
    rounds: s.rounds.map((r) => ({ ...r, decisions: s.decisions.filter((d) => d.round === r.id).length })),
    waitingOnYou: waitingOnMe(s, now),
    ruledNotCarriedOut: ruledNotCarriedOut(s, v.isOpen),
    readingsInDispute: readingsInDispute(s),
    intentCandidates: intentCandidates(s),
    comparisons: comparisonSummaries(s),
    parked: parked(s, now),
    possiblySuperseded: superseding(s),
    // Waiting on an agent, not on the person: shown so it is not mistaken for nothing.
    awaitingReading: withHeld(root, awaitingReading(s)),
  };
}

/** One round: its decisions with their payloads, answers and holds. */
export async function decisionRound(root: string, id: string) {
  const v = await decisionsView(root);
  const { s } = v, now = today();
  const round = s.rounds.find((r) => r.id === id);
  if (!round) return { error: `no round ${id}`, ...v.status };
  const byId = new Map(s.decisions.map((x) => [x.id, x]));
  const mine = (x: { round: string }) => x.round === id;
  const findings = [...new Set(s.decisions.filter(mine).flatMap(named))];
  const cfg = resolveSidecar(root);
  const heldMarks = await Promise.all(findings.map(async (finding) => {
    const issue = cfg ? await resolveDecisionIssue(root, { kind: "finding", universe: cfg.universe, id: finding }) : null;
    if (issue?.ok) return { finding, ...v.issueMark(issue.ref) };
    return { finding, ...v.mark(finding), ...(issue && issue.reason === "ambiguous"
      ? { ambiguity: issue.error } : {}) };
  }));
  return {
    ...v.status,
    round,
    comparisons: comparisonSummaries(s).filter((comparison) => comparison.decisions.some((decision) =>
      s.decisions.find((d) => d.id === decision)?.round === id)),
    decisions: s.decisions.filter(mine).map((d) => ({
      ...d, standing: standing(d) ?? null,
      answers: d.answers.map((a) => ({ ...a, executions: rulingApplicationsForAnswer(root, a.sourceAnswer ?? a.id) })),
      currentByFinding: Object.fromEntries(named(d).map((f) => [f, standingForFinding(d, f)?.id ?? null])),
      currentByIssue: namedIssues(d).map((issue) => ({ issue, answer: standingForIssue(d, issue)?.id ?? null })),
      possiblySuperseded: possiblySuperseded(d, byId),
      ...(d.confirms ? { confirm: { state: confirmState(byId, d)!, of: confirmedWords(byId, d)?.d.ref ?? null } } : {}),
    })),
    held: heldMarks.filter((h) => h.held || h.possiblySuperseded),
    waitingOnYou: waitingOnMe(s, now).filter(mine),
    ruledNotCarriedOut: ruledNotCarriedOut(s, v.isOpen).filter(mine),
    readingsInDispute: readingsInDispute(s).filter(mine),
    intentCandidates: intentCandidates(s).filter((c) => c.decisions.some((decisionId) => s.decisions.find((d) => d.id === decisionId)?.round === id)),
    parked: parked(s, now).filter(mine),
    awaitingReading: withHeld(root, awaitingReading(s).filter(mine)),
  };
}

/** An opaque content cursor. Returning the whole projected record on change means a late
 * arrival cannot be skipped because its given time precedes the last response. */
export async function decisionStatus(root: string, id: string, cursor?: string) {
  const detail = await decisionRound(root, id);
  if ("error" in detail) return detail;
  const cfg = resolveSidecar(root);
  const lineage = readStoreMeta<SidecarMark>(root, SIDECAR_LINEAGE)?.lineage;
  const stored = cfg && readStoreMeta<{ at: string; lineage?: string; mode: string; blocked: unknown[] }>(root, `sidecar_sync:${cfg.universe}`);
  const lastSync = stored && lineage && stored.lineage === lineage ? stored : null;
  const { status, diagnostic, ...content } = detail;
  const nextCursor = createHash("sha256").update(JSON.stringify({ status, diagnostic, content })).digest("hex");
  return { ok: true as const, id, cursor: nextCursor, changed: cursor !== nextCursor,
    lastSync, requiresSync: true as const, ...detail };
}

/** Wait only for a LOCAL projected change. Remote answers arrive through explicit sync. */
export async function waitDecisionStatus(root: string, id: string, cursor: string, timeoutMs: number) {
  if (!/^[a-f0-9]{64}$/.test(cursor)) return { error: "wait needs the cursor returned by decision status" };
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) return { error: "wait must be between 0 and 60000 milliseconds" };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await decisionStatus(root, id, cursor);
    if ("error" in status || status.status === "blocked" || status.changed) return status;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ...status, timedOut: true as const };
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, remaining)));
  }
}

/** Nominate a pair whose semantic overlap the declared question/finding links miss.
 * This adds a comparison hold; it never resolves one or authorizes an application. */
export async function nominateComparison(root: string,
  input: { answers: [string, string]; findings?: string[]; issues?: CanonicalIssueReference[]; reason: string }, via: Via = {}) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  const w = await writable(root);
  if ("error" in w) return w;
  const ids = input?.answers;
  if (!Array.isArray(ids) || ids.length !== 2 || ids[0] === ids[1]
    || !ids.every((id) => typeof id === "string" && id.trim())) return { error: "name two distinct exact answer ids" };
  if (!input.reason?.trim()) return { error: "explain the semantic overlap being nominated" };
  const findings = input.findings ?? [], issues = input.issues ?? [];
  if (!Array.isArray(findings) || !findings.every((id) => typeof id === "string" && id.trim())
    || new Set(findings).size !== findings.length || !Array.isArray(issues) || (!findings.length && !issues.length))
    return { error: "name distinct exact finding IDs or canonical issues in the affected scope" };
  const issueKeys = new Set<string>();
  for (const issue of issues) {
    const resolved = await resolveDecisionIssue(root, issue);
    if (!resolved.ok) return { error: resolved.error };
    const key = canonicalIssueKey(resolved.ref);
    if (key !== canonicalIssueKey(issue) || issueKeys.has(key)) return { error: `${issue.id} has a duplicate or mismatched issue scope` };
    issueKeys.add(key);
  }
  const pair = ids.map((id) => found(w.s, id));
  if (pair.some((x) => !x?.a.verified || x.a.sourceAnswer)) return { error: "both answers must be verified original response ids" };
  const [left, right] = pair as [{ d: FoldedDecision; a: FoldedDecision["answers"][number] }, { d: FoldedDecision; a: FoldedDecision["answers"][number] }];
  if (left.a.by.principal === right.a.by.principal) return { error: "comparison is between independent principals; a same-principal correction is not a conflict" };
  const current = ({ d, a }: typeof left) => !a.cancelled && !a.resolvedOutBy && !a.elsewhere && !d.answers.some((other) =>
    other !== a && other.verified && other.by.principal === a.by.principal
      && (Date.parse(other.givenAt) > Date.parse(a.givenAt)
        || (other.givenAt === a.givenAt && other.seq > a.seq)));
  if (!pair.every((x) => current(x!))) return { error: "a named answer is no longer current; nominate the current response instead" };
  const scope = new Set([...named(left.d), ...named(right.d)]);
  for (const id of findings) {
    if (!scope.has(id)) return { error: `${id} is outside both questions' stated issue scope` };
    const target = lookupFinding(root, id);
    if (!target || "ambiguous" in target) return { error: `${id} is not an unambiguous finding in this store` };
  }
  const typedScope = new Set([...namedIssues(left.d), ...namedIssues(right.d)].map(canonicalIssueKey));
  for (const key of issueKeys) if (!typedScope.has(key)) return { error: "an issue is outside both questions stated issue scope" };
  const automatic = intentCandidates(w.s).find((candidate) => ids.every((id) => candidate.answers.includes(id))
    && findings.every((id) => candidate.findings.includes(id))
    && [...issueKeys].every((key) => candidate.issues?.some((issue) => canonicalIssueKey(issue) === key)));
  if (automatic) return { ok: true as const, alreadyCandidate: true as const, candidate: automatic };
  const existing = [...(left.d.nominations ?? []), ...(right.d.nominations ?? [])].find((n) =>
    n.answers.length === 2 && ids.every((id) => n.answers.includes(id))
      && findings.every((id) => n.findings.includes(id))
      && [...issueKeys].every((key) => n.issues?.some((issue) => canonicalIssueKey(issue) === key)));
  if (existing) return { ok: true as const, nomination: existing.id, existing: true as const };
  const e = await nominateComparisonEvent(b.cfg.path, b.cfg.universe, b.actor,
    { answers: ids, findings, ...(issues.length ? { issues } : {}), reason: input.reason.trim() });
  const after = await decisionsView(root);
  const candidate = intentCandidates(after.s).find((x) => x.nomination?.id === e.id);
  if (!candidate) return { error: "the fold did not accept the nomination; it remains in the log for inspection", nomination: e.id };
  return { ok: true as const, nomination: e.id, candidate };
}

// --- answering -------------------------------------------------------------------------

const found = (s: SharedDecisions, answer: string) => {
  for (const d of s.decisions) { const a = d.answers.find((x) => x.id === answer); if (a) return { d, a }; }
  return undefined;
};

async function record(root: string, b: Bound, d: FoldedDecision, via: AnswerVia, relayedBy?: string) {
  if (d.withdrawn || d.answers.some((a) => a.withdrawn))
    return { decision: d.id, ref: d.ref, recorded: false as const, why: `${d.ref} has a withdrawal; ask a fresh question` };
  const { s } = await decisionsView(root);
  const e = await recordAnswerEvent(b.cfg.path, b.cfg.universe, b.actor, { decision: d.id, hash: d.hash, via, ...(relayedBy ? { relayedBy } : {}) });
  return outcome(root, d, e.id);
}

/** What the fold made of answer `id` on `d`, as the caller reads it. */
async function outcome(root: string, d: Pick<FoldedDecision, "id" | "ref">, id: string) {
  const { s } = await decisionsView(root);
  const now = s.decisions.find((x) => x.id === d.id);
  const a = now?.answers.find((x) => x.id === id);
  // The fold dropped it: say so rather than report an answer nobody will see.
  if (!now || !a) return { decision: d.id, ref: d.ref, recorded: false as const, why: "the fold did not accept this answer (check its question, source time, or verification)" };
  const top = standing(now);
  return {
    decision: d.id, ref: d.ref, recorded: true as const, answer: id, verified: a.verified, standing: top?.id === a.id,
    ...(now.confirms ? { confirm: confirmOutcome(s, now, a) } : {}),
    ...(!a.verified && top?.verified ? { note: "unconfirmed, after a verified ruling: it is shown to the person and never applied over their ruling" } : {}),
    ...(a.free ? { awaitsReading: true } : {}),
    ruled: a.ruled, ...(a.unruled.length ? { waitingOnYou: a.unruled } : {}),
    ...(a.separately?.length ? { askSeparately: a.separately } : {}),
    ...(a.park ? { parked: a.park } : {}), ...(a.flags ? { flags: a.flags } : {}),
  };
}

/** What an answer on a confirm did to the words it asks about. */
function confirmOutcome(s: SharedDecisions, c: FoldedDecision, a: FoldedDecision["answers"][number]): string {
  if (c.cancellation) return `cancelled: ${c.cancellation.reason}; this answer cannot revive the reading`;
  if (c.confirms!.invalid) return `not a confirm codemap can verify (${c.confirms!.invalid}): this answer binds nothing — ask for a new confirm`;
  const t = confirmedWords(new Map(s.decisions.map((x) => [x.id, x])), c);
  if (a.free) return "their own words on the confirm: have a reader read them (reader_brief, then record_reading), like any typed reply";
  if (!t) return "the words it asks about are no longer an answer here";
  if (t.a.confirmed?.answer === a.id) return "bound: the reading is ruled, as of when they typed the words";
  if (a.options[0] === CONFIRM_NO) return `rejected: the ruling on ${t.d.ref} stands, flagged — re-ask ${t.d.ref} (the person must answer a fresh question)`;
  return "not the latest pick on those words, or they were bound another way: this binds nothing";
}

/**
 * Log an `AskUserQuestion` call from this session's transcript, and record it as the answer to
 * every decision whose exact payload it carries, in the rounds it was asked for. The default
 * path for relaying the person's answers (owner, R13). An unverifiable call writes nothing and
 * says why. A confirm is a posted decision like any other, so it is answered here too.
 */
export async function logQuestion(root: string, input: { session?: string; toolUseId: string; round: string | string[] }, via: Via = {}, dir: string = transcriptDir()) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  await recordHeld(root, b, dir);
  // From the caller, and required: the transcript cannot say which round a call was for, and
  // an identical question in another round must not take the answer (owner, B1.4; P2.4).
  const named = [...new Set((Array.isArray(input.round) ? input.round : [input.round]).filter((r) => typeof r === "string" && r.trim()))];
  if (!named.length) return { error: "log_question needs the round (or rounds) the call was asked for" };
  const session = input.session ?? sessionHolding(input.toolUseId, dir);
  if (isUnverified(session)) return { ok: false, unverified: session.unverified, note: "nothing was written" };
  const call = readCall(session, input.toolUseId, dir);
  if (isUnverified(call)) return { ok: false, unverified: call.unverified, note: "nothing was written; relay_answer can still record the words as an unverified answer, which only unblocks" };
  const w = await writable(root);
  if ("error" in w) return w;
  const before = w.s;
  const refused: { question: string; why: string }[] = [];
  // A named round posted after the call was answered refuses only that round (S0.8(d)).
  const rounds: DecisionRound[] = [];
  for (const id of named) {
    const r = before.rounds.find((x) => x.id === id);
    if (!r) return { error: `no round ${id}` };
    if (!(Date.parse(call.at) > Date.parse(r.at))) refused.push({ question: `(round ${id})`, why: `the call was answered at ${call.at}, and round ${id} was posted at ${r.at}: an answer binds only to a question posted before it` });
    else rounds.push(r);
  }
  // A retry of a call already logged records whichever of its answers are missing — a crash
  // between logging and recording must not strand them (H6.1). Its bindings were decided then.
  const prior = before.questions.find((q) => q.toolUseId === input.toolUseId && q.session === session);
  if (prior && named.some((r) => !prior.rounds.includes(r))) return { error: `call ${input.toolUseId} is already logged for ${prior.rounds.join(", ")}` };
  const bound: Record<string, string> = {};
  for (const q of call.questions) {
    const hits = rounds.filter((r) => before.decisions.some((d) => d.round === r.id && sameQuestion(q, d.payload)));
    if (hits.length > 1) refused.push({ question: q.question, why: `it is the posted question of more than one round you named (${hits.map((r) => r.id).join(", ")}), so which one it answers cannot be told` });
    else if (hits.length) bound[q.question] = hits[0]!.id;
  }
  if (!rounds.length) return { error: refused.map((x) => x.why).join("; ") + " (nothing was written)" };
  const logged = prior?.id ?? (await logQuestionEvent(b.cfg.path, b.cfg.universe, b.actor, {
    session: call.session, toolUseId: call.toolUseId, questions: call.questions, answers: call.answers, transcript: session,
    rounds: named, bound, answeredAt: call.at,
  })).id;
  const binding = prior?.bound ?? bound;
  const once = `q:${call.session}\0${call.toolUseId}`;
  const answered = [];
  for (const d of before.decisions) {
    // A replaced question is answered too: the fold keeps an answer given before the
    // later question was posted, whenever it is recorded.
    if (binding[d.payload.question] !== d.round || !call.questions.some((q) => sameQuestion(q, d.payload)) || call.answers[d.payload.question] === undefined) continue;
    // Judged per decision: a round can grow after it is posted.
    if (!(Date.parse(call.at) > Date.parse(d.postedAt))) { refused.push({ question: d.payload.question, why: `the call was answered at ${call.at}, and ${d.ref} was posted at ${d.postedAt || "an unknown time"}: an answer binds only to a question posted before it` }); continue; }
    const had = d.answers.find((a) => a.once === once);
    // Answered once: the retry records nothing new (B1.4).
    if (had) answered.push({ decision: d.id, ref: d.ref, recorded: false as const, already: had.id });
    else answered.push(await record(root, b, d, { kind: "question", question: logged }));
  }
  return {
    ok: true, logged, ...(prior ? { retried: true } : {}), answered,
    ...(refused.length ? { refused } : {}),
    ...(answered.length ? {} : { note: `logged; no decision in ${named.join(", ")} carries these questions, so nothing was answered` }),
  };
}

/**
 * Relay the person's typed reply. Codemap copies their WHOLE message by its entry id (R16), so
 * a relay can never carry part of it. A message the transcript cannot confirm is recorded only
 * from `words`, as unverified: it unblocks and settles nothing (C8).
 */
export async function relayAnswer(root: string, input: { round: string; decision: string; session?: string; entryId: string; words?: string; relayedBy?: string }, via: Via = {}, dir: string = transcriptDir()) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  await recordHeld(root, b, dir);
  const w = await writable(root);
  if ("error" in w) return w;
  const d = w.s.decisions.find((x) => x.id === input.decision);
  if (!d) return { error: `no decision ${input.decision}` };
  // The context the agent says it was answering, which the reader checks against the transcript (H5).
  if (input.round !== d.round) return { error: `decision ${d.id} is in round ${d.round}, not ${String(input.round)}: say which round and question you asked` };
  const session = input.session ?? sessionHolding(input.entryId, dir);
  const m = isUnverified(session) ? session : readMessage(session, input.entryId, dir);
  if (isUnverified(m)) {
    if (!input.words?.trim()) return { ok: false, unverified: m.unverified, note: "nothing was written; pass the words to record them as an unverified answer, which only unblocks" };
    return { ok: true, ...(await record(root, b, d, { kind: "unverified", words: input.words }, input.relayedBy)), unverifiedBecause: m.unverified };
  }
  if (!(Date.parse(m.at) > Date.parse(d.postedAt))) {
    return { error: `the message was typed at ${m.at}, and ${d.ref} was posted at ${d.postedAt || "an unknown time"}: words bind only to a question posted before them (nothing was written)` };
  }
  const had = d.answers.find((a) => a.once === `m:${m.session}\0${m.entryId}`);
  if (had) return { ok: true, decision: d.id, ref: d.ref, recorded: false as const, already: had.id, note: "this message already answers this decision" };
  return { ok: true, ...(await record(root, b, d, { kind: "message", session: m.session, entryId: m.entryId, text: m.text, at: m.at, round: d.round }, input.relayedBy ?? m.session)) };
}

const ARROW = /^\s*(D\d+)\s*(?:→|->)\s*(.+?)\s*$/;
const UNCLEAR = /^\s*unclear:\s*(.+?)\s*$/i;

/**
 * The reader's verdict, from its own report (owner, P2.1 + S0.8(c)): one line per pick,
 * `D<n> → <label>` (`->` also), `D<n> → (none)` for words that fit no option there, or one
 * `unclear: <why>`. Other lines are the reader's prose and are ignored. Anything it cannot
 * resolve exactly is refused, so a reader's typo never becomes a dispute the person must settle.
 * `listed` is the questions the reader's brief listed.
 */
export function parseVerdict(report: string, listed: Pick<FoldedDecision, "id" | "ref" | "options">[], round: string): { maps: Mapping[]; unclear?: string } | { error: string } {
  const maps: Mapping[] = [];
  const unclear: string[] = [];
  // Only the report's final block is the verdict (R6): a line quoted in the reader's prose is not.
  const lines = report.split("\n");
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  let start = lines.length;
  while (start > 0 && (UNCLEAR.test(lines[start - 1]!) || ARROW.test(lines[start - 1]!))) start--;
  for (const line of lines.slice(start)) {
    const u = UNCLEAR.exec(line);
    if (u) { unclear.push(u[1]!); continue; }
    const m = ARROW.exec(line)!;
    // Resolved against the questions the reader's brief listed, as it was shown (owner, Q2.1).
    const ts = listed.filter((d) => d.ref === m[1]);
    // Two questions posted with one ref: which it names cannot be told (owner, P2.1 (4)).
    if (ts.length > 1) return { error: `the reader's line "${line.trim()}" names ${m[1]}, which two questions in round ${round} share: it is ambiguous` };
    const t = ts[0];
    if (!t) return { error: `the reader's line "${line.trim()}" names ${m[1]}, which is not a question the reader's brief listed for round ${round}` };
    const label = m[2]!;
    if (label !== NONE && !t.options.some((o) => o.label === label)) return { error: `the reader's line "${line.trim()}" names "${label}", which is not an option of ${t.ref} (${t.options.map((o) => o.label).join(" / ")})` };
    maps.push({ decision: t.id, option: label === NONE ? null : label });
  }
  if (unclear.length && maps.length) return { error: "the reader's report says both unclear and a mapping: which is it?" };
  if (unclear.length > 1) return { error: "the reader's report says unclear more than once" };
  if (unclear.length) return { maps: [], unclear: unclear[0]! };
  if (!maps.length) return { error: "the reader's report does not end with a verdict (`D<n> → <option>`, `D<n> → (none)`, or `unclear: <why>`)" };
  return { maps };
}

// --- the reader records its own verdict (owner, Q2.2 "Reader records it") -------------------
//
// The agent's reading is taken when it asks for the brief, before any reader exists, and the
// brief is then fixed. The reader ends by calling `submit_verdict` itself; codemap HOLDS it on
// this machine, because a call is written to its transcript only after it returns. The next
// decisions call here that may write checks each held verdict against the reader's own
// transcript and only then writes it to the shared log; the first held verdict that verifies
// counts. Guards overreach and honest mistakes, not a deceptive parent (owner, after the plan).
// Two gaps are left open and documented (Q3.2, Q4.1): an agent can stop a reader before it
// submits and launch another, and a parent can build the brief — it is deterministic — and
// launch a reader before asking codemap for it.

/** How long a held verdict may go unfound on disk before it is invalid. The call reaches its
 *  transcript ~12 ms after it returns (measured 2026-09-24). */
const graceMs = () => Number(process.env.CODEMAP_VERDICT_GRACE_MS ?? 60_000);

interface ReaderRequest { answer: string; maps: Mapping[]; reading?: string; asks?: string; brief: string; manifest?: BriefEntry[]; issuedAt: string; requestId?: string; responseHash?: string }
type HeldState = "pending" | "recorded" | "invalid" | "superseded";
interface HeldVerdict extends LegacyReaderVerdict { requestId?: string }
export const interpretationRequestId = (input: { answer: string; responseHash?: string; brief: string;
  manifest: BriefEntry[]; maps: Mapping[]; reading?: string; asks?: string }): string =>
  `read_${createHash("sha256").update(JSON.stringify({ answer: input.answer,
    responseHash: input.responseHash, brief: input.brief, manifest: input.manifest, maps: input.maps,
    reading: input.reading ?? null, asks: input.asks ?? null })).digest("hex").slice(0, 24)}`;
const interpretationKey = (requestId: string) => ({ purpose: "answer-interpretation" as const, requestId });
const newRequests = (root: string): ReaderRequest[] => readerRequests(root, "answer-interpretation")
  .map(({ requestId, body }) => ({ ...JSON.parse(body) as ReaderRequest, requestId }));
const legacyRequestOf = (root: string, answer: string): ReaderRequest | undefined => {
  const legacy = legacyReaderRequest(root, answer);
  return legacy ? JSON.parse(legacy) : undefined;
};
const requestOf = (root: string, answer: string, requestId?: string): ReaderRequest | undefined => {
  const fresh = newRequests(root).find((r) => r.answer === answer && (!requestId || r.requestId === requestId));
  return fresh || (requestId ? undefined : legacyRequestOf(root, answer));
};
const heldFor = (root: string, answer: string): HeldVerdict[] => {
  const legacy: HeldVerdict[] = legacyReaderVerdicts(root, answer);
  const current = newRequests(root).filter((r) => r.answer === answer).flatMap((request) =>
    readerReceipts(root, interpretationKey(request.requestId!)).map((row) => ({
      seq: row.seq, answer, verdict: (JSON.parse(row.body) as { verdict: string }).verdict,
      heldAt: row.heldAt, state: row.state === "cancelled" ? "superseded" as const : row.state,
      ...(row.why ? { why: row.why } : {}), ...(row.call ? { call: row.call } : {}),
      receipt: row.receipt, requestId: request.requestId,
    })));
  return [...legacy, ...current].sort((x, y) => x.heldAt.localeCompare(y.heldAt) || (x.requestId ? 1 : -1));
};
const settle = (root: string, held: HeldVerdict, state: HeldState, why?: string, call?: string) =>
  held.requestId && held.receipt
    ? settleReaderReceipt(root, interpretationKey(held.requestId), held.receipt,
      state === "superseded" ? "cancelled" : state === "pending" ? "invalid" : state, why, call)
    : settleLegacyReaderVerdict(root, held.seq, state, why, call);

/**
 * The exact prompt to launch a reader with, for answer `answer` (owner, P1.4), and the moment
 * your own reading of the words is taken (Q2.2): before any reader exists. Issued once and then
 * fixed — asking again returns the same brief, and a different reading is refused — until the
 * round changes under it and no verdict is held for it.
 */
export async function readerBrief(root: string, input: { answer: string; maps: Mapping[]; reading?: string; asks?: string }) {
  const { s } = await decisionsView(root);
  const x = found(s, input?.answer);
  if (!x) return { error: `no answer ${String(input?.answer)}` };
  const { d, a } = x;
  if (a.cancelled) return { error: a.cancelled.reason, cancelledBy: a.cancelled.by };
  if (d.kind === "words") return { error: `${d.ref} takes words: they are the answer, never read` };
  if (!a.free || a.elsewhere) return { error: `answer ${a.id} is not words waiting for a reading` };
  if (a.reading) return { error: `answer ${a.id} is already read (${a.reading.id}): one reading per answer` };
  // Never read (H6.8): after a verified ruling, unconfirmed words are shown to the person, not bound.
  if (!a.verified && standing(d)?.verified) return { error: `answer ${a.id} is unconfirmed and came after ${d.ref}'s verified ruling: it is shown to the person, never read` };
  const maps = validMaps(input?.maps);
  if (!maps) return { error: "maps is your own reading of the words, at least one line: [{ decision, option | null }] — taken now, before any reader exists" };
  const byId = new Map(s.decisions.map((y) => [y.id, y]));
  const why = bindRefusal(byId, d, a, maps);
  if (why) return { error: `your reading cannot bind: ${why}` };
  const note = `launch a NEW general-purpose subagent (not a fork) with exactly this as its prompt, and send it nothing else. It calls submit_verdict itself; then record_reading(${a.id}) records its verdict — any later decisions call here does too`;
  const baseBrief = briefFor(byId, d, a);
  const manifest = briefManifest(byId, d, a);
  const requestId = interpretationRequestId({ answer: a.id, responseHash: a.responseHash,
    brief: baseBrief, manifest, maps, reading: input.reading, asks: input.asks });
  const brief = baseBrief.replace("with `answer:", 'with `request: "' + requestId + '"`, `answer:');
  const prev = requestOf(root, a.id);
  if (prev && prev.brief.replace(/with `request: "[^"]+"`, `answer:/, "with `answer:") === baseBrief
    && JSON.stringify(prev.manifest ?? []) === JSON.stringify(manifest)
    && prev.responseHash === a.responseHash && mapsKey(prev.maps) !== mapsKey(maps))
    return { error: `your reading of ${a.id} was taken when its brief was issued (${prev.issuedAt}), and a reader may have read since: it cannot change` };
  if (prev && (prev.requestId === requestId || (!prev.requestId && prev.brief === baseBrief
    && !briefRefusal(byId, d, a, prev.brief, [], prev.manifest)))) {
    if (mapsKey(prev.maps) !== mapsKey(maps)) return { error: `your reading of ${a.id} was taken when its brief was issued (${prev.issuedAt}), and a reader may have read since: it cannot change` };
    return { ok: true, answer: a.id, ...(prev.requestId ? { request: prev.requestId } : {}), prompt: prev.brief, existing: true, note };
  }
  if (prev && heldFor(root, a.id).some((h) => h.state === "pending")) return { error: `the round changed under the brief issued for ${a.id}, but a reader's verdict is held for it: record_reading first` };
  const req: ReaderRequest = { answer: a.id, maps, ...(input.reading ? { reading: input.reading } : {}),
    ...(input.asks ? { asks: input.asks } : {}), brief, manifest, issuedAt: new Date().toISOString(),
    responseHash: a.responseHash };
  const saved = saveReaderRequest(root, interpretationKey(requestId), JSON.stringify(req));
  if ("error" in saved) return saved;
  return { ok: true, answer: a.id, request: requestId, prompt: brief, note };
}

/**
 * The reader's own verdict (owner, Q2.2): called BY the reader subagent, never its parent. It
 * is parsed against the brief as issued and HELD on this machine — it writes nothing to the
 * log. Refused once an earlier reader's verdict for the answer has been recorded.
 */
export async function submitVerdict(root: string, input: { answer: string; verdict: string; request?: string }, via: Via = {}, dir: string = transcriptDir()) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  await recordHeld(root, b, dir);
  const w = await writable(root);
  if ("error" in w) return w;
  const x = found(w.s, input?.answer);
  if (!x) return { error: `no answer ${String(input?.answer)}` };
  const { d, a } = x;
  if (a.cancelled) return { error: a.cancelled.reason, cancelledBy: a.cancelled.by };
  if (a.reading) return { ok: false, refused: `answer ${a.id} is already read: an earlier reader's verdict counts, one reading per answer` };
  const currentReq = requestOf(root, a.id);
  const req = input.request ? requestOf(root, a.id, input.request) : currentReq;
  if (!req) return { ok: false, refused: `no reader_brief was issued for ${a.id} on this machine` };
  if (req.requestId !== currentReq?.requestId)
    return { ok: false, refused: `reader request ${String(input.request)} is no longer the current brief for ${a.id}` };
  if (typeof input.verdict !== "string") return { ok: false, refused: "verdict is your verdict lines, as text" };
  const byId = new Map(w.s.decisions.map((y) => [y.id, y]));
  const listed = briefListing(byId, d, a, req.brief, req.manifest);
  if (typeof listed === "string") return { ok: false, refused: `the brief you were given no longer matches the round (${listed}): stop; your parent must ask for a new brief` };
  const v = parseVerdict(input.verdict, listed, d.round);
  if ("error" in v) return { ok: false, refused: v.error, note: "not held: correct the verdict and call submit_verdict again" };
  const why = v.unclear ? null : bindRefusal(byId, d, a, v.maps);
  if (why) return { ok: false, refused: `that verdict cannot bind: ${why}`, note: "not held: correct the verdict and call submit_verdict again" };
  const receipt = randomUUID();
  if (req.requestId) {
    const held = holdReaderReceipt(root, interpretationKey(req.requestId), receipt,
      JSON.stringify({ answer: a.id, verdict: input.verdict }));
    if ("error" in held) return held;
  } else {
    holdLegacyReaderVerdict(root, a.id, input.verdict, receipt);
  }
  return { ok: true, held: true, receipt, ...(req.requestId ? { request: req.requestId } : {}),
    note: "held on this machine; codemap records it once it finds this call in your own transcript. You are done: stop now." };
}

/** Records every held verdict that now verifies — the "next call" of Q2.2. Asked first by every
 *  decisions op an agent reaches that may write. Never fails its caller. */
async function recordHeld(root: string, b: Bound, dir: string): Promise<void> {
  let answers: string[];
  try {
    answers = [...new Set([
      ...pendingLegacyReaderAnswers(root),
      ...newRequests(root).filter((r) => readerReceipts(root, interpretationKey(r.requestId!)).some((h) => h.state === "pending"))
        .map((r) => r.answer),
    ])];
  } catch { return; }
  for (const answer of answers) {
    try { await settleAnswer(root, b, answer, dir); } catch { /* left pending: the next call tries again */ }
  }
}

/**
 * Settles `answer`'s held verdicts, first held first. A verdict whose call is not on disk yet
 * keeps its place, so everything held after it waits (Codex plan review, 5); invalid means its
 * call was found and failed a check, or was never found within the grace.
 */
async function settleAnswer(root: string, b: Bound, answer: string, dir: string): Promise<void> {
  const w = await writable(root);
  if ("error" in w) return;
  const held = heldFor(root, answer), x = found(w.s, answer);
  const pending = held.filter((h) => h.state === "pending");
  if (!x) { for (const h of pending) settle(root, h, "invalid", `answer ${answer} is no longer words here`); return; }
  if (x.a.cancelled) { for (const h of pending) settle(root, h, "invalid", x.a.cancelled.reason); return; }
  if (x.a.reading) { for (const h of pending) settle(root, h, "superseded", `answer ${answer} is already read (${x.a.reading.id})`); return; }
  const { d, a } = x;
  const byId = new Map(w.s.decisions.map((y) => [y.id, y]));
  const claimed = new Set(held.map((h) => h.call).filter(Boolean));
  for (const h of pending) {
    const req = h.requestId ? requestOf(root, answer, h.requestId) : legacyRequestOf(root, answer) ?? requestOf(root, answer);
    if (!req) { settle(root, h, "invalid", "the exact issued reader request is missing"); continue; }
    const calls = findVerdictCalls(answer, h.verdict, 0, dir).filter((c) => !claimed.has(c.callId));
    const matches = h.receipt ? calls.filter((c) => c.result === "held" && c.receipt === h.receipt)
      : calls.filter((c) => c.result === "legacy-held");
    const call = matches.length === 1 ? matches[0] : undefined;
    if (!h.receipt && matches.length > 1) {
      noteLegacyReaderVerdict(root, h.seq,
        "legacy verdict has multiple successful-held calls; its reader cannot be identified — re-ask with a fresh question");
      return;
    }
    if (!call) {
      if (Date.now() - Date.parse(h.heldAt) > graceMs()) {
        settle(root, h, "invalid", h.receipt ? "its successful submit_verdict result and receipt were not found in this machine's transcripts"
          : "legacy verdict has no unique successful-held call/result pair; re-ask the reader");
        continue;
      }
      return;   // a missing or ambiguous result keeps the first slot through the grace
    }
    claimed.add(call.callId);
    const bad = (why: string) => settle(root, h, "invalid", why, call.callId);
    if (!call.agentId) { bad(`submitted from session ${call.session}'s own conversation, not by a reader subagent`); continue; }
    const r = readReader(call.agentId, call.callId, dir);
    if (isUnverified(r)) { bad(r.unverified); continue; }
    // Exact, at C14's strength: the one check that the reader never saw your reading (P1.4).
    if (r.prompt !== req.brief) { bad(`subagent ${r.agentId} was not launched with the brief issued for ${answer}`); continue; }
    // Only an accepted reading counts, so this is the one a reader can have used (owner, P1.2).
    const other = w.s.decisions.flatMap((y) => y.answers).find((y) => y.reading?.reader.agent === r.agentId);
    if (other) { bad(`subagent ${r.agentId} already read answer ${other.id}: one reader reads one answer`); continue; }
    const listed = briefListing(byId, d, a, req.brief, req.manifest);
    const v = typeof listed === "string" ? { error: listed } : parseVerdict(h.verdict, listed, d.round);
    if ("error" in v) { bad(v.error); continue; }
    const why = readingRefusal(byId, d, a, { verdict: v.maps, unclear: v.unclear, session: req.maps,
      launchedAt: r.launchedAt, brief: req.brief, manifest: req.manifest });
    if (why) { bad(why); continue; }
    await recordReadingEvent(b.cfg.path, b.cfg.universe, b.actor, {
      answer, ...(h.knownReplacements ? { knownReplacements: h.knownReplacements } : {}), session: { ...(req.reading ? { reading: req.reading } : {}), maps: req.maps },
      reader: { agent: r.agentId, verdict: v.maps, ...(v.unclear ? { unclear: v.unclear } : {}), launchedAt: r.launchedAt, brief: req.brief, manifest: req.manifest, verified: { session: r.session, toolUseId: r.toolUseId, call: call.callId,
        ...(h.requestId ? { requestId: h.requestId } : {}), ...(h.receipt ? { receipt: h.receipt } : {}) } },
      ...(req.asks ? { asks: req.asks } : {}),
    });
    const after = found((await decisionsView(root)).s, answer);
    if (!after?.a.reading) { bad("the fold did not accept it: the decisions log changed while it was being recorded"); return; }
    settle(root, h, "recorded", undefined, call.callId);
    for (const rest of pending.slice(pending.indexOf(h) + 1)) settle(root, rest, "superseded", "an earlier held verdict was recorded");
    return;
  }
}

/**
 * Record the reader's held verdict for `answer` now (C17, C19; plan B1, B2; Q2.2) — the explicit
 * call when nothing else follows. Codemap finds the reader's own `submit_verdict` call on this
 * machine and checks it: a subagent launched after the words with exactly the issued brief, not
 * a fork, sent nothing before it submitted, reading one answer. Agree and it binds, disagree and
 * it waits for the person, unclear and it waits for the person.
 */
export async function recordReading(root: string, input: { answer: string }, via: Via = {}, dir: string = transcriptDir()) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  await recordHeld(root, b, dir);
  const w = await writable(root);
  if ("error" in w) return w;
  const x = found(w.s, input?.answer);
  if (!x) return { error: `no answer ${String(input?.answer)}` };
  if (x.a.cancelled) return { ok: false, cancelled: true, cancelledBy: x.a.cancelled.by, note: x.a.cancelled.reason };
  const r = x.a.reading;
  if (r) {
    return {
      ok: true, recorded: true, agree: r.agree, reader: r.reader.maps,
      ...(r.agree ? {} : { note: r.unclear ? "unclear, so nothing binds and it waits for the person — re-ask the original question" : "the reader and your reading disagree, so nothing binds and it waits for the person — confirm_reading offers them the reading(s)" }),
    };
  }
  const held = heldFor(root, x.a.id);
  if (held.some((h) => h.state === "pending")) {
    const legacy = held.find((h) => h.state === "pending" && !h.receipt && h.why);
    return { ok: false, pending: true, ...(legacy ? { legacyUnverified: true } : {}),
      note: legacy?.why ?? "a reader's verdict is held, and its call is not in the transcript yet: call record_reading again in a moment" };
  }
  if (!held.length) return { ok: false, note: `no verdict is held for ${x.a.id}: the reader calls submit_verdict itself — launch one with reader_brief's prompt` };
  return { ok: false, invalid: held.map((h) => ({ state: h.state, why: h.why })), note: "no held verdict verified, so no reader was used: launch a new one with reader_brief's prompt" };
}

/** A confirm's id, from the words and its whole posted text: two clones' wordings of one reading
 *  are two decisions, so an answer bound to one is never dropped for the other (Q2.3 (1)). */
export const confirmId = (answer: string, d: Pick<Decision, "kind" | "payload" | "options">): string =>
  `cf_${createHash("sha256").update(`${answer}\0${decisionHash(d)}`).digest("hex").slice(0, 16)}`;

/**
 * Post the confirm-this-reading question for words a ruling may not yet reflect (the impl-2
 * discussion; P2.1 (1)): a decision in the words' own round, with codemap's text, which holds
 * what its readings would rule on and waits on the person until it is answered. Ask it
 * verbatim, then `log_question` the call with that round. Yes (or Reading n) binds the reading
 * as of when they typed the words; "No — ask me again" records the rejection; their own words
 * under Other are read by a reader like any reply and carry none of this meaning.
 */
export async function confirmReading(root: string, input: { answer: string; maps?: Mapping[] }, via: Via = {}, dir: string = transcriptDir()) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  await recordHeld(root, b, dir);
  const w = await writable(root);
  if ("error" in w) return w;
  const s = w.s, byId = new Map(s.decisions.map((y) => [y.id, y]));
  const x = found(s, input?.answer);
  if (!x) return { error: `no answer ${String(input?.answer)}` };
  const { d, a } = x;
  if (a.cancelled) return { error: a.cancelled.reason, cancelledBy: a.cancelled.by };
  if (d.confirms) return { error: `${d.ref} is itself a confirm: words on it are read like any other reply (reader_brief, then record_reading)` };
  if (d.kind === "words") return { error: `${d.ref} takes words: they are the answer, never read onto options` };
  if (!a.free || a.elsewhere) return { error: `answer ${a.id} is not words waiting for a binding` };
  // An unclear reading has no mapping to confirm: re-ask the question (owner, "Agreed").
  if (a.reading?.unclear) return { error: `the reader could not tell which question these words answer (${a.reading.unclear}): re-ask ${d.ref} itself` };
  let readings: Mapping[][];
  // A session side that cannot bind is not offered: the reader's reading alone (Q2.2, Step 6 part 7).
  if (a.reading && !a.reading.agree) readings = bindRefusal(byId, d, a, a.reading.session.maps) ? [a.reading.reader.maps] : [a.reading.reader.maps, a.reading.session.maps];
  else {
    const maps = validMaps(input?.maps);
    if (!maps) return { error: "give your own reading of their words as maps: [{ decision, option | null }]" };
    if ((a.rejected ?? []).some((r) => mapsKey(r) === mapsKey(maps))) return { error: "the person already said this reading is not what they meant: re-ask the original question" };
    readings = [maps];
  }
  for (const r of readings) {
    const why = bindRefusal(byId, d, a, r);
    if (why) return { error: `that reading cannot bind: ${why}` };
    for (const id of new Set(r.map((m) => m.decision))) {
      const t = byId.get(id)!;
      if (s.decisions.filter((y) => y.round === d.round && y.ref === t.ref).length > 1) return { error: `${t.ref} names two questions in round ${d.round}, so a line naming it is ambiguous (P2.1 (4))` };
    }
  }
  readings = readings.map(canonicalMaps);
  const key = readings.map(mapsKey).join("\n--\n");
  // Asked again: the open confirm, never a second question and a second hold.
  const open = s.decisions.find((c) => c.confirms?.answer === a.id && c.confirms.readings.map(mapsKey).join("\n--\n") === key && confirmState(byId, c) === "open");
  if (open) return { ok: true, confirm: open.id, ref: open.ref, round: open.round, ask: open.payload, existing: true, note: `already posted: ask it verbatim, then log_question the call with round ${d.round}` };
  const ref = `D${Math.max(0, ...s.decisions.filter((y) => y.round === d.round).map((y) => Number(y.ref.slice(1)))) + 1}`;
  const payload = confirmPayload(byId, d, a, readings, ref);
  const posted = { round: d.round, ref, kind: "options" as const, payload, options: payload.options.map((o) => ({ label: o.label, effects: [] })), confirms: { answer: a.id, readings } };
  const id = confirmId(a.id, posted), decision = { id, ...posted };
  const bad = checkDecision(decision);
  if (bad) return { error: `the confirm could not be posted: ${bad}` };
  await postConfirmEvent(b.cfg.path, b.cfg.universe, b.actor, decision);
  const after = (await decisionsView(root)).s.decisions.find((y) => y.id === id);
  if (!after || after.confirms?.invalid) return { ok: false, posted: id, why: `the fold does not accept it as a confirm${after?.confirms?.invalid ? `: ${after.confirms.invalid}` : ""} — it stays visible but cannot act; ask a valid question` };
  return { ok: true, confirm: id, ref, round: d.round, ask: after.payload, note: `ask this verbatim with AskUserQuestion, then log_question the call with round ${d.round}` };
}

/** The person answering on the page. Never an agent (R18). */
export async function answerDirect(root: string, input: { decision: string; option?: string; park?: string; words?: string; checked?: string[] }, via: Via = {}) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  if (isAgentActor(b.actor)) return { error: "answering on a person's behalf is not an agent's act: ask with AskUserQuestion and log_question it" };
  await recordHeld(root, b, transcriptDir());
  const w = await writable(root);
  if ("error" in w) return w;
  const d = w.s.decisions.find((x) => x.id === input.decision);
  if (!d) return { error: `no decision ${input.decision}` };
  if (d.cancellation) return { error: d.cancellation.reason, cancelledBy: d.cancellation.by };
  if (d.withdrawn) return { error: `question ${d.ref} was withdrawn: ${d.withdrawn.reason}`, withdrawnBy: d.withdrawn.id };
  if (d.answers.some((a) => a.withdrawn)) return { error: `${d.ref} has a withdrawn ruling; ask a fresh question` };
  const { decision: _d, ...rest } = input;
  return { ok: true, ...(await record(root, b, d, { kind: "direct", ...rest })) };
}

export { decisionHash, CONFIRM_YES, CONFIRM_NO };

/** Withdraw an unanswered question or this principal's answered ruling. The act is
 *  preserved in the decision log; the projection retires its authority and pending readings. */
export async function withdrawDecision(root: string, input: { decision: string; answer?: string; reason: string; approval?: string }, via: Via = {}) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  if (isAgentActor(b.actor) && !input.approval) return { error: "agent withdrawal needs exact recorded human approval" };
  const w = await writable(root);
  if ("error" in w) return w;
  const d = w.s.decisions.find((x) => x.id === input?.decision);
  if (!d) return { error: `no decision ${String(input?.decision)}` };
  if (d.withdrawn) return { error: `${d.ref} is already withdrawn (${d.withdrawn.id})` };
  if (typeof input.reason !== "string" || !input.reason.trim()) return { error: "withdrawal needs a reason" };
  const sources = d.answers.filter((a) => a.verified && !a.sourceAnswer);
  if (input.answer) {
    const a = sources.find((x) => x.id === input.answer);
    if (!a) return { error: `${input.answer} is not a verified source answer on ${d.ref}` };
    if (a.by.principal !== b.actor.principal) return { error: "withdrawing another principal's answer requires conflict resolution" };
    if (sources.some((x) => x.by.principal !== b.actor.principal)) return { error: "independent answers require conflict resolution before withdrawal" };
    if (a.withdrawn) return { error: `${input.answer} was already withdrawn (${a.withdrawn.by})` };
  } else if (sources.length) return { error: `${d.ref} has a submitted answer; name the exact answer to withdraw its ruling` };
  const e = await withdrawDecisionEvent(b.cfg.path, b.cfg.universe, b.actor,
    { decision: d.id, ...(input.answer ? { answer: input.answer } : {}), reason: input.reason.trim(),
      knownAnswers: sources.map((a) => a.id), scope: withdrawalScope(d),
      ...(input.approval ? { approval: input.approval } : {}) });
  if ("error" in e) return e;
  const after = (await decisionsView(root)).s.decisions.find((x) => x.id === d.id);
  const accepted = input.answer ? after?.answers.find((a) => a.id === input.answer)?.withdrawn?.by === e.id : after?.withdrawn?.id === e.id;
  if (!accepted) return { error: "the fold did not accept this withdrawal; its event remains available for inspection", withdrawal: e.id };
  return { ok: true as const, withdrawal: e.id, decision: d.id, ...(input.answer ? { answer: input.answer } : {}) };
}

/** Record the person's approval of one exact withdrawal; an agent may cite this act later. */
export async function approveDecisionWithdrawal(root: string,
  input: { decision: string; answer?: string; reason: string }, via: Via = {}) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  if (isAgentActor(b.actor)) return { error: "withdrawal approval needs the principal's own act" };
  const w = await writable(root);
  if ("error" in w) return w;
  const d = w.s.decisions.find((x) => x.id === input.decision);
  if (!d || !input.reason?.trim()) return { error: "approval needs an exact decision and reason" };
  const sources = d.answers.filter((a) => a.verified && !a.sourceAnswer);
  const e = await approveDecisionWithdrawalEvent(b.cfg.path, b.cfg.universe, b.actor, {
    decision: d.id, ...(input.answer ? { answer: input.answer } : {}), reason: input.reason.trim(),
    scope: withdrawalScope(d), knownAnswers: sources.map((a) => a.id), sourceReceipt: randomUUID(),
  });
  if ("error" in e) return e;
  return { ok: true as const, approval: e.id, decision: d.id, scope: withdrawalScope(d) };
}

/** Freeze exactly which earlier source and action this principal saw before revising it. */
export async function presentDecisionRevision(root: string,
  input: { decision: string; revises: string[]; findings: string[]; issues?: CanonicalIssueReference[] }, via: Via = {}) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  if (isAgentActor(b.actor)) return { error: "revision presentation needs the principal's own act" };
  const w = await writable(root);
  if ("error" in w) return w;
  const d = w.s.decisions.find((x) => x.id === input.decision);
  if (!d) return { error: `no decision ${input.decision}` };
  const e = await presentDecisionRevisionEvent(b.cfg.path, b.cfg.universe, b.actor, {
    decision: d.id, revises: input.revises, scope: { findings: input.findings, ...(input.issues?.length ? { issues: input.issues } : {}) },
    sourceReceipt: randomUUID(),
  });
  if ("error" in e) return e;
  return { ok: true as const, presentation: e.id,
    contextHash: (e.data as any).contextHash as string, displayed: e.data };
}

/** Give an agent the exact question that a later transcript must prove was shown. */
export async function revisionRelayBrief(root: string,
  input: { decision: string; revises: string[]; findings: string[]; issues?: CanonicalIssueReference[] }, via: Via = {}) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  if (!isAgentActor(b.actor)) return { error: "relay revision brief is for the verifying agent" };
  const view = await decisionsView(root);
  const d = view.s.decisions.find((x) => x.id === input.decision);
  if (!d || d.withdrawn || d.answers.some((a) => a.withdrawn))
    return { error: "no current decision for this relay" };
  const sources = input.revises?.map((id) => d.answers.find((a) => a.id === id));
  if (!sources?.length || sources.some((a) => !a?.verified || a.sourceAnswer || a.cancelled))
    return { error: "relay revision needs exact current verified source answers" };
  const scope = { findings: input.findings ?? [], ...(input.issues?.length ? { issues: input.issues } : {}) };
  return { ok: true as const, decision: d.id, revises: input.revises, scope,
    question: revisionRelayQuestion(d, sources as FoldedDecision["answers"], b.actor.principal, scope) };
}

/** Record a human's correction from the exact AskUserQuestion transcript, even if the
 * recording machine pulled other events after the person answered. */
export async function reviseDecisionRelayed(root: string,
  input: { decision: string; revises: string[]; findings: string[]; issues?: CanonicalIssueReference[];
    session: string; toolUseId: string }, via: Via = {}, dir: string = transcriptDir()) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  if (!isAgentActor(b.actor)) return { error: "a relay revision is recorded by the verifying agent" };
  const w = await writable(root);
  if ("error" in w) return w;
  const d = w.s.decisions.find((x) => x.id === input.decision);
  if (!d || d.withdrawn) return { error: "no current decision for this relay" };
  const sources = input.revises?.map((id) => d.answers.find((a) => a.id === id));
  if (!sources?.length || sources.some((a) => !a?.verified || a.sourceAnswer || a.cancelled))
    return { error: "relay revision needs exact current verified source answers" };
  const scope = { findings: input.findings ?? [], ...(input.issues?.length ? { issues: input.issues } : {}) };
  const expected = revisionRelayQuestion(d, sources as NonNullable<typeof sources[number]>[], b.actor.principal, scope);
  const call = readCall(input.session, input.toolUseId, dir);
  if (isUnverified(call)) return { error: call.unverified };
  if (call.questions.length !== 1 || !sameQuestion(call.questions[0]!, expected))
    return { error: "human was not shown the exact predecessor, affected scope and new action" };
  const answer = call.answers[expected.question];
  if (typeof answer !== "string" || !answer.trim()) return { error: "revision needs one exact human response" };
  const proof = { session: call.session, toolUseId: call.toolUseId, entryId: call.entryId,
    answeredAt: call.at, question: call.questions[0]!, answer };
  const event = await reviseAnswerEvent(b.cfg.path, b.cfg.universe, b.actor, {
    decision: d.id, hash: d.hash, via: { kind: "revision-relay", proof },
    revision: { of: input.revises, findings: scope.findings,
      ...(input.issues?.length ? { issues: input.issues } : {}) },
  });
  if ("error" in event) return event;
  const result = await outcome(root, d, event.id);
  const after = (await decisionsView(root)).s.decisions.find((x) => x.id === d.id);
  const accepted = after?.answers.find((a) => a.id === event.id);
  if (!result.recorded || accepted?.revisionInvalid)
    return { error: accepted?.revisionInvalid ?? result.why, revision: event.id };
  return { ok: true as const, revision: event.id, givenAt: call.at,
    sourceReceipt: call.entryId, standing: scope.findings.every((f) => standingForFinding(after!, f)?.id === event.id)
      && (input.issues ?? []).every((issue) => standingForIssue(after!, issue)?.id === event.id) };
}

/** Explicitly correct named source answers for named findings; untouched findings keep
 * their earlier answer. Other principals' answers require a conflict resolution act. */
export async function reviseDecision(root: string, input: { decision: string; revises: string[];
  findings: string[]; issues?: CanonicalIssueReference[];
  seen?: { presentation: string; contextHash: string };
  resolves?: { answers: [string, string]; priorResolution: string; shownHash: string };
  option?: string; words?: string }, via: Via = {}) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  if (isAgentActor(b.actor)) return { error: "revision needs the principal's own act" };
  const w = await writable(root);
  if ("error" in w) return w;
  const d = w.s.decisions.find((x) => x.id === input?.decision);
  if (!d) return { error: `no decision ${String(input?.decision)}` };
  if (d.withdrawn || d.answers.some((a) => a.withdrawn)) return { error: `${d.ref} was withdrawn; ask a fresh question` };
  const issues = input.issues ?? [];
  if (!Array.isArray(input.revises) || !input.revises.length || new Set(input.revises).size !== input.revises.length
    || !Array.isArray(input.findings) || new Set(input.findings).size !== input.findings.length
    || !Array.isArray(issues) || new Set(issues.map(canonicalIssueKey)).size !== issues.length
    || !input.findings.every((f) => named(d).length ? named(d).includes(f) : d.kind === "words" && f === d.id)
    || !issues.every((issue) => namedIssues(d).some((named) => canonicalIssueKey(named) === canonicalIssueKey(issue)))
    || (!input.resolves && !input.findings.length && !issues.length))
    return { error: "revision needs exact source answer ids and named canonical scope" };
  const sources = input.revises.map((id) => d.answers.find((a) => a.id === id));
  if (sources.some((a) => !a?.verified || a.sourceAnswer || (a.via !== "direct" && a.via !== "questionnaire") || a.cancelled))
    return { error: "revision sources must be current verified direct or questionnaire answers" };
  if (sources.some((a) => a!.by.principal !== b.actor.principal) && !input.seen)
    return { error: "cross-principal revision needs the exact presented source receipt" };
  if (!!input.option === !!input.words) return { error: "revision needs exactly one option or new words" };
  if (input.option && !d.options.some((o) => o.label === input.option)) return { error: `${input.option} is not an option of ${d.ref}` };
  if (input.words !== undefined && !input.words.trim()) return { error: "revision words must be nonempty" };
  const viaAnswer = input.option ? { kind: "direct" as const, option: input.option } : { kind: "direct" as const, words: input.words! };
  const event = await reviseAnswerEvent(b.cfg.path, b.cfg.universe, b.actor,
    { decision: d.id, hash: d.hash, via: viaAnswer,
      revision: { of: input.revises, findings: input.findings,
        ...(issues.length ? { issues } : {}), ...(input.seen ? { seen: input.seen } : {}),
        ...(input.resolves ? { resolves: input.resolves } : {}) } });
  if ("error" in event) return event;
  const result = await outcome(root, d, event.id);
  if (!result.recorded) return { error: result.why, revision: event.id };
  const after = (await decisionsView(root)).s.decisions.find((x) => x.id === d.id);
  const scopedStanding = after && (input.resolves ? standing(after)?.id === event.id : [
    ...input.findings.map((finding) => standingForFinding(after, finding)?.id === event.id),
    ...issues.map((issue) => standingForIssue(after, issue)?.id === event.id),
  ].every(Boolean));
  return { ok: true as const, revision: event.id, ...result, standing: !!scopedStanding };
}
