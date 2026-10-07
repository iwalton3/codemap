import { findingRepairPresentations } from "./repair-presentation.js";
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
import { lookupFinding, readStoreMeta, rulingApplicationsForAnswer, writeStoreMeta } from "../store.js";
import { resolveSidecar } from "../sidecar-config.js";
import { canonicalIssueKey, resolveDecisionIssue, type CanonicalIssueReference } from "../decision-issues.js";
import {
  CONFIRM_NO, CONFIRM_YES, NONE, canonicalMaps, briefManifest, briefListing, briefRefusal, readingRefusal, readerBrief as briefFor, bindRefusal, checkDecision, checkQuestionnaireDecisions, confirmPayload, confirmState, confirmedWords, decisionHash, logQuestionEvent,
  mapsKey, named, namedIssues, possiblySuperseded, postConfirmEvent, postRoundEvent, validMaps, loggedQuestionOnce,
  revisionRelayQuestion, withdrawalQuestion, withdrawalBriefContent, withdrawalBriefHash, withdrawalReviewRefusal, WITHDRAW_IT, type WithdrawalReview, type WithdrawalReviewReceipt, standingForIssue, checkListRevision, listRevisionItemIds, parseListRelayAnswer, type ListRevision,
  readingsInDispute, intentCandidates, nominateComparisonEvent, recordAnswerEvent, submitQuestionnaireEvent, recordReadingEvent, ruledNotCarriedOut, standing, standingForFinding, waitingOnMe, awaitingReading, parked, withdrawDecisionEvent, reviseAnswerEvent, rulerOf,
  type AnswerVia, type BriefEntry, type FoldedDecision, type Mapping, type SharedDecisions,
} from "../shared-decisions.js";
import { decisionsView } from "./decision-holds.js";
import { findAskCalls, findMessages, findVerdictCalls, isUnverified, readCall, readMessage, readReader, readReceiptCall, readSubagentCall, sameQuestion, sessionHolding, soleAskCall, transcriptDir, verdictGraceMs } from "../transcript.js";
import type { PersonMessage, Unverified } from "../transcript.js";
import { saveReaderRequest, readerRequest, readerRequests, holdReaderReceipt, readerReceipts, settleReaderReceipt,
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

/** A caller label resolves only while it names one publication. Exact provenance wins. */
const roundMatches = (s: SharedDecisions, id: string) => {
  const exact = s.rounds.find((r) => r.id === id);
  return exact ? [exact] : s.rounds.filter((r) => r.label === id || r.questionnaire?.id === id);
};
const decisionMatches = (s: SharedDecisions, id: string) => {
  const exact = s.decisions.find((d) => d.id === id);
  return exact ? [exact] : s.decisions.filter((d) => d.label === id);
};
const ambiguous = (kind: string, id: string, matches: { id: string }[]) =>
  `${kind} ${id} is ambiguous; use one exact identity: ${matches.map((x) => x.id).join(", ")}`;
const resolveMaps = (s: SharedDecisions, input: Mapping[] | undefined): Mapping[] | { error: string } => {
  if (!Array.isArray(input)) return [];
  const result: Mapping[] = [];
  for (const mapping of input) {
    const matches = decisionMatches(s, mapping?.decision);
    if (matches.length > 1) return { error: ambiguous("decision", mapping.decision, matches) };
    result.push({ ...mapping, decision: matches[0]?.id ?? mapping?.decision });
  }
  return result;
};

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
  }
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
      if (rulerOf(sources[0]!).principal === rulerOf(sources[1]!).principal)
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
    // A decision names findings by codemap id, and only ones codemap holds (owner, 2026-09-23:
    // "Yes, refuse unrecorded"). Record findings before posting the round.
    for (const o of d.options) for (const e of o.effects) for (const f of e.findings) {
      const found = lookupFinding(root, f);
      if (!found) return `decision ${d.ref} names ${f}, which is not a finding this store holds — record it first with report_finding, then post the decision round`;
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
    if (d.follows && decisionMatches(existing, d.follows).length !== 1)
      return decisionMatches(existing, d.follows).length > 1
        ? ambiguous("decision", d.follows, decisionMatches(existing, d.follows))
        : `decision ${d.ref} follows ${d.follows}, which is not posted`;
  }
  return null;
}

/** Post a round of decisions, each with the exact `AskUserQuestion` payload it will be asked with. */
export async function postRound(root: string, r: NewRound, via: Via = {}, dir: string = transcriptDir()) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  await recordHeld(root, b, dir);
  if ((r?.round as any)?.prevalidated !== undefined) return { error: "prevalidated is historical provenance only — record findings and repair sorts separately before posting the round" };
  const bad = await checkRound(root, r);
  if (bad) return { error: bad };
  const before = (await decisionsView(root)).s;
  const decisions = r.decisions.map((d) => d.follows
    ? { ...d, follows: decisionMatches(before, d.follows)[0]!.id } : d);
  const event = await postRoundEvent(b.cfg.path, b.cfg.universe, b.actor, { ...r.round, universe: b.cfg.universe }, decisions);
  if ("error" in event) return event;
  const { s } = await decisionsView(root);
  return {
    ok: true, round: event.id, label: r.round.id,
    ...(r.round.questionnaire ? { questionnaire: {
      id: event.id, label: r.round.questionnaire.id,
      version: questionnaireVersion(r.round.questionnaire),
      link: `/#/u/${encodeURIComponent(b.cfg.universe)}/decisions/${encodeURIComponent(event.id)}/`,
      retrieve: `questionnaire_detail(${JSON.stringify(event.id)}) or open the link after sidecar sync`,
    } } : {}),
    // What to ask with, verbatim — a paraphrase reads as unverified (C14).
    ask: r.decisions.map((d) => ({ decision: `${event.id}:${d.id}`, label: d.id, ref: d.ref,
      payload: s.decisions.find((x) => x.id === `${event.id}:${d.id}`)?.payload ?? d.payload })),
    ...alreadyRuled(before, decisions),
  };
}

/**
 * The standing rulings on anything these new questions act on — so an agent asking again
 * knows it was already ruled on before the person is asked (owner, R1: "I want an agent to
 * know the question had already been ruled on when asking the user again").
 */
function alreadyRuled(s: SharedDecisions, posted: Decision[]) {
  const out: { issue: string; decision: string; ref: string; answer: string; by: string; words: string }[] = [];
  const seen = new Set<string>();
  for (const p of posted) {
    for (const d of s.decisions) {
      if (d.withdrawn) continue;
      const rulings = [
        ...named(p).filter((f) => named(d).includes(f)).map((f) => ({ issue: f, a: standingForFinding(d, f) })),
        ...namedIssues(p).filter((i) => namedIssues(d).some((x) => canonicalIssueKey(x) === canonicalIssueKey(i)))
          .map((i) => ({ issue: `${i.kind} ${i.id}`, a: standingForIssue(d, i) })),
      ];
      for (const { issue, a } of rulings) {
        if (!a || !a.verified || seen.has(`${issue}\0${a.id}`)) continue;
        seen.add(`${issue}\0${a.id}`);
        out.push({ issue, decision: d.id, ref: d.ref, answer: a.id, by: rulerOf(a).principal, words: a.words });
      }
    }
  }
  return out.length ? { alreadyRuled: out, note: "these issues already have a standing ruling; asking again does not replace it unless the person revises or withdraws it" } : {};
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
  const questionnaires = v.s.rounds.filter((r) => r.questionnaire);
  const exact = questionnaires.find((r) => r.id === id);
  const matches = exact ? [exact] : questionnaires.filter((r) => r.label === id || r.questionnaire?.id === id);
  if (matches.length > 1) return { error: ambiguous("questionnaire", id, matches), status: v.status };
  const round = matches[0];
  if (!round?.questionnaire) return { error: `no questionnaire ${id}`, status: v.status };
  return detailOf(v, round, principal);
}

/** One questionnaire's detail from a view already built — the list reads every questionnaire
 *  from ONE view rather than a view per questionnaire. */
function detailOf(v: Awaited<ReturnType<typeof decisionsView>>, round: DecisionRound, principal?: string) {
  const q = round.questionnaire!;
  const questions = q.sections.flatMap((section) => section.questions);
  const records = questions.map((question) => {
    const d = v.s.decisions.find((x) => x.round === round.id && (x.label ?? x.id) === question.id);
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
  return { id: round.id, label: q.id, round: round.id, questionnaire: q, version: questionnaireVersion(q),
    status: v.status, questions: records, progress,
    comparisons: intentCandidates(v.s).filter((candidate) => candidate.decisions.some((decision) =>
      v.s.decisions.find((d) => d.id === decision)?.round === round.id)),
    comparisonRecords: comparisonSummaries(v.s).filter((comparison) => comparison.decisions.some((decision) =>
      v.s.decisions.find((d) => d.id === decision)?.round === round.id)) };
}

const PRESENCE = "web_presence";
/** How recent a page poll must be to count as "open": three of its 15-second polls. */
const OPEN_WITHIN_MS = 45_000;
/** The page polls the questionnaire list; that poll is the presence signal (plan Phase 4.4). */
export function noteWebPresence(root: string, principal: string | null): void {
  writeStoreMeta(root, PRESENCE, { at: new Date().toISOString(), principal });
}
export function webPresence(root: string): { open: boolean; lastSeen?: string; principal?: string | null } {
  const seen = readStoreMeta<{ at: string; principal: string | null }>(root, PRESENCE);
  if (!seen) return { open: false };
  return { open: Date.now() - Date.parse(seen.at) < OPEN_WITHIN_MS, lastSeen: seen.at, principal: seen.principal };
}

export async function questionnaireList(root: string, principal?: string) {
  const v = await decisionsView(root);
  const questionnaires = v.s.rounds.filter((r) => r.questionnaire).map((r) => {
    const detail = detailOf(v, r, principal);
    return { id: detail.id, label: detail.label, round: detail.round, title: detail.questionnaire.title,
      recipient: detail.questionnaire.recipient, version: detail.version, progress: detail.progress };
  });
  return { status: v.status, questionnaires, codemapOpen: webPresence(root) };
}

/** Selected answers are staged together, then admitted under the sidecar append lock. */
export async function submitQuestionnaire(root: string,
  input: { round: string; submission: SubmissionDraft }, via: Via = {}) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  const w = await writable(root);
  if ("error" in w) return w;
  const matches = roundMatches(w.s, input?.round);
  if (matches.length > 1) return { error: ambiguous("round", input.round, matches) };
  const round = matches[0];
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
  return { ok: true as const, questionnaire: round!.id, label: q.id, round: round!.id,
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
  const matches = roundMatches(s, id);
  if (matches.length > 1) return { error: ambiguous("round", id, matches), ...v.status };
  const round = matches[0];
  if (!round) return { error: `no round ${id}`, ...v.status };
  id = round.id;
  const byId = new Map(s.decisions.map((x) => [x.id, x]));
  const mine = (x: { round: string }) => x.round === id;
  const findings = [...new Set(s.decisions.filter(mine).flatMap(named))];
  const cfg = resolveSidecar(root);
  const repairFindings: import("../shared-findings.js").SharedFinding[] = [];
  const heldMarks = await Promise.all(findings.map(async (finding) => {
    const issue = cfg ? await resolveDecisionIssue(root, { kind: "finding", universe: cfg.universe, id: finding }) : null;
    if (issue?.ok) { if (issue.ref.kind === "finding") repairFindings.push(issue.issue as import("../shared-findings.js").SharedFinding); return { finding, ...v.issueMark(issue.ref) }; }
    return { finding, ...v.mark(finding), ...(issue && issue.reason === "ambiguous"
      ? { ambiguity: issue.error } : {}) };
  }));
  for (const ref of s.decisions.filter(mine).flatMap(namedIssues)) {
    if (ref.kind !== "finding") continue;
    const issue = await resolveDecisionIssue(root, ref);
    if (issue.ok && issue.ref.kind === "finding" && !repairFindings.some(f => f.id === issue.issue.id && f.pr === (issue.issue as import("../shared-findings.js").SharedFinding).pr))
      repairFindings.push(issue.issue as import("../shared-findings.js").SharedFinding);
  }
  return {
    ...v.status,
    round,
    repairs: [...(await findingRepairPresentations(root, repairFindings)).entries()].map(([key, repair]) => ({ key, ...repair })),
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
  if (rulerOf(left.a).principal === rulerOf(right.a).principal) return { error: "comparison is between independent principals; a same-principal correction is not a conflict" };
  const current = ({ d, a }: typeof left) => !a.cancelled && !a.resolvedOutBy && !a.elsewhere && !d.answers.some((other) =>
    other !== a && other.verified && rulerOf(other).principal === rulerOf(a).principal
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
  if ("error" in e) return e;
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
  if ("error" in e) return { decision: d.id, ref: d.ref, recorded: false as const, why: e.error };
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
 * says why. A confirm is a posted decision like any other, so it is answered here too. With no
 * `toolUseId` the call is found by the rounds' payloads; an ambiguous find is refused, not guessed.
 */
export async function logQuestion(root: string, input: { session?: string; toolUseId?: string; round: string | string[] }, via: Via = {}, dir: string = transcriptDir()) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  await recordHeld(root, b, dir);
  // From the caller, and required: the transcript cannot say which round a call was for, and
  // an identical question in another round must not take the answer (owner, B1.4; P2.4).
  const named = [...new Set((Array.isArray(input.round) ? input.round : [input.round]).filter((r) => typeof r === "string" && r.trim()))];
  if (!named.length) return { error: "log_question needs the round (or rounds) the call was asked for" };
  const w = await writable(root);
  if ("error" in w) return w;
  const before = w.s;
  let toolUseId = input.toolUseId, session: string | Unverified | undefined = input.session;
  if (toolUseId === undefined) {
    // The agent cannot see its call's id (I12), so the call is found by what it asked.
    const asked = named.map((id) => roundMatches(before, id));
    const hit = asked.findIndex((m) => m.length !== 1);
    if (hit >= 0) return { error: asked[hit]!.length ? ambiguous("round", named[hit]!, asked[hit]!) : `no round ${named[hit]}` };
    const rs = asked.map((m) => m[0]!);
    const since = rs.map((r) => r.at).sort()[0]!;
    const found = findAskCalls(before.decisions.filter((d) => rs.some((r) => r.id === d.round)).map((d) => d.payload), since, dir, input.session);
    if (isUnverified(found)) return { ok: false, unverified: found.unverified, note: "nothing was written" };
    const fresh = found.filter((c) => !before.questions.some((q) => loggedQuestionOnce(q) === loggedQuestionOnce(c)));
    // Every candidate already logged: the newest is a retry, which records only what is missing.
    const pick = fresh.length ? fresh : found.slice(-1);
    if (!pick.length) return { ok: false, unverified: `no AskUserQuestion call after ${named.join(", ")} was posted asks any of its questions`, note: "nothing was written: ask with the `ask` payloads post_round returned, verbatim" };
    if (pick.length > 1) return { error: `${pick.length} unlogged AskUserQuestion calls ask questions of ${named.join(", ")}: ${pick.map((c) => c.toolUseId).join(", ")}. Which one is meant cannot be told; log each by its toolUseId (nothing was written)` };
    ({ toolUseId, session } = pick[0]!);
  }
  session ??= sessionHolding(toolUseId, dir);
  if (isUnverified(session)) return { ok: false, unverified: session.unverified, note: "nothing was written" };
  const call = readCall(session, toolUseId, dir);
  if (isUnverified(call)) return { ok: false, unverified: call.unverified, note: "nothing was written; relay_answer can still record the words as an unverified answer, which only unblocks" };
  const refused: { question: string; why: string }[] = [];
  // A named round posted after the call was answered refuses only that round (S0.8(d)).
  const rounds: DecisionRound[] = [];
  for (const id of named) {
    const matches = roundMatches(before, id);
    if (matches.length > 1) return { error: ambiguous("round", id, matches) };
    const r = matches[0];
    if (!r) return { error: `no round ${id}` };
    if (!(Date.parse(call.at) > Date.parse(r.at))) refused.push({ question: `(round ${id})`, why: `the call was answered at ${call.at}, and round ${id} was posted at ${r.at}: an answer binds only to a question posted before it` });
    else rounds.push(r);
  }
  // A retry of a call already logged records whichever of its answers are missing — a crash
  // between logging and recording must not strand them (H6.1). Its bindings were decided then.
  const prior = before.questions.find((q) => loggedQuestionOnce(q) === loggedQuestionOnce(call));
  if (prior && rounds.some((r) => !prior.rounds.some((id) => id === r.id || id === r.label)))
    return { error: `call ${toolUseId} is already logged for ${prior.rounds.join(", ")}` };
  const bound: Record<string, string> = {};
  for (const q of call.questions) {
    const hits = rounds.filter((r) => before.decisions.some((d) => d.round === r.id && sameQuestion(q, d.payload)));
    if (hits.length > 1) refused.push({ question: q.question, why: `it is the posted question of more than one round you named (${hits.map((r) => r.label ?? r.id).join(", ")}), so which one it answers cannot be told` });
    else if (hits.length) bound[q.question] = hits[0]!.id;
  }
  if (!rounds.length) return { error: refused.map((x) => x.why).join("; ") + " (nothing was written)" };
  const loggedEvent = prior ?? await logQuestionEvent(b.cfg.path, b.cfg.universe, b.actor, {
    session: call.session, toolUseId: call.toolUseId, questions: call.questions, answers: call.answers, transcript: session,
    rounds: rounds.map((r) => r.id), bound, answeredAt: call.at,
  });
  if ("error" in loggedEvent) return loggedEvent;
  const logged = loggedEvent.id;
  const binding = prior?.bound ?? bound;
  const once = loggedQuestionOnce(call);
  const answered = [];
  for (const d of before.decisions) {
    // A replaced question is answered too: the fold keeps an answer given before the
    // later question was posted, whenever it is recorded.
    const bound = binding[d.payload.question];
    const boundRound = bound === d.round || (bound !== undefined && roundMatches(before, bound).length === 1
      && roundMatches(before, bound)[0]!.id === d.round);
    if (!boundRound || !call.questions.some((q) => sameQuestion(q, d.payload)) || call.answers[d.payload.question] === undefined) continue;
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
 * Relay the person's typed reply. Codemap copies their WHOLE message (R16), found by its whole
 * words or named by its entry id, so a relay can never carry part of it. A message the transcript cannot confirm is recorded only
 * from `words`, as unverified: it unblocks and settles nothing (C8).
 */
export async function relayAnswer(root: string, input: { round: string; decision: string; session?: string; entryId?: string; words?: string; relayedBy?: string }, via: Via = {}, dir: string = transcriptDir()) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  await recordHeld(root, b, dir);
  const w = await writable(root);
  if ("error" in w) return w;
  const matches = decisionMatches(w.s, input.decision);
  if (matches.length > 1) return { error: ambiguous("decision", input.decision, matches) };
  const d = matches[0];
  if (!d) return { error: `no decision ${input.decision}` };
  // The context the agent says it was answering, which the reader checks against the transcript (H5).
  if (input.round !== d.round && input.round !== w.s.rounds.find((r) => r.id === d.round)?.label)
    return { error: `decision ${d.id} is in round ${d.round}, not ${String(input.round)}: say which round and question you asked` };
  let m: PersonMessage | Unverified;
  if (input.entryId === undefined) {
    if (!input.words?.trim()) return { error: "relay_answer needs the person's words (their whole message, as typed)" };
    // The agent can quote the message but not name it (I12): find it by its whole words.
    const since = w.s.rounds.find((r) => r.id === d.round)?.at ?? d.postedAt;
    const hits = findMessages(input.words, since, dir, input.session);
    if (!isUnverified(hits) && hits.length > 1) return { error: `${hits.length} messages typed after ${d.round} was posted are exactly these words: ${hits.map((x) => x.entryId).join(", ")}. Which one is meant cannot be told; pass its entryId (nothing was written)` };
    m = isUnverified(hits) ? hits : hits[0] ?? { unverified: `no message typed after ${d.round} was posted is exactly these words, whole` };
  } else {
    const session = input.session ?? sessionHolding(input.entryId, dir);
    m = isUnverified(session) ? session : readMessage(session, input.entryId, dir);
  }
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

const graceMs = verdictGraceMs;

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
  const resolvedMaps = resolveMaps(s, input?.maps);
  if ("error" in resolvedMaps) return resolvedMaps;
  const maps = validMaps(resolvedMaps);
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
    const written = await recordReadingEvent(b.cfg.path, b.cfg.universe, b.actor, {
      answer, session: { ...(req.reading ? { reading: req.reading } : {}), maps: req.maps },
      reader: { agent: r.agentId, verdict: v.maps, ...(v.unclear ? { unclear: v.unclear } : {}), launchedAt: r.launchedAt, brief: req.brief, manifest: req.manifest, verified: { session: r.session, toolUseId: r.toolUseId, call: call.callId,
        ...(h.requestId ? { requestId: h.requestId } : {}), ...(h.receipt ? { receipt: h.receipt } : {}) } },
      ...(req.asks ? { asks: req.asks } : {}),
    });
    if ("error" in written) { bad(written.error); return; }
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
    const resolvedMaps = resolveMaps(s, input?.maps);
    if ("error" in resolvedMaps) return resolvedMaps;
    const maps = validMaps(resolvedMaps);
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
  const event = await postConfirmEvent(b.cfg.path, b.cfg.universe, b.actor, decision);
  if ("error" in event) return { error: `the confirm could not be posted: ${event.error}` };
  const after = (await decisionsView(root)).s.decisions.find((y) => y.id === event.id);
  if (!after || after.confirms?.invalid) return { ok: false, posted: event.id, why: `the fold does not accept it as a confirm${after?.confirms?.invalid ? `: ${after.confirms.invalid}` : ""} — it stays visible but cannot act; ask a valid question` };
  return { ok: true, confirm: event.id, label: id, ref, round: d.round, ask: after.payload, note: `ask this verbatim with AskUserQuestion, then log_question the call with round ${d.round}` };
}

/** The person answering on the page. Never an agent (R18). */
export async function answerDirect(root: string, input: { decision: string; option?: string; park?: string; words?: string; checked?: string[] }, via: Via = {}) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  if (isAgentActor(b.actor)) return { error: "answering on a person's behalf is not an agent's act: ask with AskUserQuestion and log_question it" };
  await recordHeld(root, b, transcriptDir());
  const w = await writable(root);
  if ("error" in w) return w;
  const matches = decisionMatches(w.s, input.decision);
  if (matches.length > 1) return { error: ambiguous("decision", input.decision, matches) };
  const d = matches[0];
  if (!d) return { error: `no decision ${input.decision}` };
  if (d.cancellation) return { error: d.cancellation.reason, cancelledBy: d.cancellation.by };
  if (d.withdrawn) return { error: `question ${d.ref} was withdrawn: ${d.withdrawn.reason}`, withdrawnBy: d.withdrawn.id };
  // A colleague whose answer stood through the withdrawal may still re-answer (owner, O2).
  const stood = d.answers.some((a) => !a.withdrawn && !a.cancelled && a.verified && !a.sourceAnswer && rulerOf(a).principal === b.actor.principal);
  if (d.answers.some((a) => a.withdrawn) && !stood) return { error: `${d.ref} has a withdrawn ruling; ask a fresh question` };
  const { decision: _d, ...rest } = input;
  return { ok: true, ...(await record(root, b, d, { kind: "direct", ...rest })) };
}

export { decisionHash, CONFIRM_YES, CONFIRM_NO };

/** Withdraw an unanswered question or this principal's answered ruling. The act is
 *  preserved in the decision log; the projection retires its authority and pending readings. */
/** `agentId` and `callId` are optional: the reader's call is found by its receipt (I10, as I12). */
export interface WithdrawalReaderRef { requestId: string; receipt: string; agentId?: string; callId?: string }

/**
 * Withdraw a question or a ruling (owner, 2026-09-28: "Readers for unanswered, me for rulings,
 * allow relay via verified question system"). A person withdraws their own ruling, or an
 * unanswered question, directly. An agent withdraws an unanswered question only with two
 * readers' verdicts (`review`, see `withdrawalReaderBrief`), and a ruling only as the person's
 * "Withdraw it" answer to the question `reportRuling` posted (`relay`). The fold decides.
 */
export async function withdrawDecision(root: string, input: { decision: string; answer?: string; reason: string;
  relay?: string; review?: { readers: WithdrawalReaderRef[]; arbitrator?: WithdrawalReaderRef } }, via: Via = {}, dir: string = transcriptDir()) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  const w = await writable(root);
  if ("error" in w) return w;
  const matches = decisionMatches(w.s, input?.decision);
  if (matches.length > 1) return { error: ambiguous("decision", String(input?.decision), matches) };
  const d = matches[0];
  if (!d) return { error: `no decision ${String(input?.decision)}` };
  if (typeof input.reason !== "string" || !input.reason.trim()) return { error: "withdrawal needs a reason" };
  const reason = input.reason.trim();
  const sources = d.answers.filter((a) => a.verified && !a.sourceAnswer);
  if (!input.answer && sources.length) return { error: `${d.ref} has a submitted answer; name the exact answer to withdraw its ruling` };
  let review: WithdrawalReview | undefined;
  if (isAgentActor(b.actor) && !input.answer) {
    if (!input.review) return { error: "an agent withdraws an unanswered question with two readers' verdicts (withdrawal_reader_brief)" };
    const checked = verifiedWithdrawalReview(root, d, reason, input.review, dir);
    if ("error" in checked) return checked;
    review = checked;
  }
  if (isAgentActor(b.actor) && input.answer && !input.relay)
    return { error: "an agent cannot retire a ruling: report it (report_ruling) and relay the person's answer" };
  const relays = input.relay ? decisionMatches(w.s, input.relay) : [];
  if (input.relay && relays.length !== 1) return { error: relays.length ? ambiguous("decision", input.relay, relays) : `no question ${input.relay}` };
  const relay = relays[0]?.id;
  const e = await withdrawDecisionEvent(b.cfg.path, b.cfg.universe, b.actor,
    { decision: d.id, ...(input.answer ? { answer: input.answer } : {}), reason, knownAnswers: sources.map((a) => a.id),
      ...(relay ? { relay } : {}), ...(review ? { review } : {}) });
  if ("error" in e) return e;
  return { ok: true as const, withdrawal: e.id, decision: d.id, ...(input.answer ? { answer: input.answer } : {}) };
}

/**
 * Report a ruling an agent suspects is wrong or in conflict: posts the verified question that
 * asks its principal whether to withdraw it. Ask it verbatim; their "Withdraw it" answer is what
 * lets `withdraw_decision` retire the ruling (with `relay`). Nothing is withdrawn here.
 */
export async function reportRuling(root: string, input: { decision: string; answer: string; reason: string }, via: Via = {}) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  const w = await writable(root);
  if ("error" in w) return w;
  const found = decisionMatches(w.s, input?.decision);
  if (found.length > 1) return { error: ambiguous("decision", String(input?.decision), found) };
  const d = found[0];
  const ruling = d?.answers.find((a) => a.id === input?.answer && a.verified && !a.sourceAnswer && !a.withdrawn);
  if (!d || !ruling) return { error: "report_ruling needs an exact decision and one of its current verified answers" };
  if (typeof input.reason !== "string" || !input.reason.trim()) return { error: "say what looks wrong or conflicting" };
  const id = `report-${randomUUID()}`;
  const question = withdrawalQuestion(d, ruling, input.reason.trim(), "D1");
  const decision: Decision = { id: "withdraw", round: id, ref: "D1", kind: "options", payload: question,
    options: question.options.map((o) => ({ label: o.label, effects: [] })) };
  const event = await postRoundEvent(b.cfg.path, b.cfg.universe, b.actor, { id, source: "report_ruling", universe: b.cfg.universe }, [decision]);
  if ("error" in event) return event;
  return { ok: true as const, round: event.id, relay: `${event.id}:withdraw`, ask: question,
    next: `ask the person this question verbatim (log_question), or send them to the decisions page; on "${WITHDRAW_IT}", call withdraw_decision with relay` };
}

/** The frozen brief a withdrawal reader is launched with; `slot` 3 arbitrates two disagreeing readers. */
export async function withdrawalReaderBrief(root: string, input: { decision: string; reason: string; slot: 1 | 2 | 3; readers?: WithdrawalReaderRef[] }, dir: string = transcriptDir()) {
  const view = await decisionsView(root);
  const found = decisionMatches(view.s, input?.decision);
  if (found.length > 1) return { error: ambiguous("decision", String(input?.decision), found) };
  const d = found[0];
  if (!d) return { error: `no decision ${String(input?.decision)}` };
  if (d.answers.some((a) => a.verified && !a.sourceAnswer)) return { error: `${d.ref} is answered; its ruling is withdrawn by its principal, not by readers` };
  if (![1, 2, 3].includes(input.slot) || !input.reason?.trim()) return { error: "a withdrawal brief needs the reason and slot 1, 2 or 3 (the arbitrator)" };
  let rationales: string[] | undefined;
  if (input.slot === 3) {
    const readers = (input.readers ?? []).map((ref) => withdrawalReceipt(root, ref, dir));
    const bad = readers.find((r) => "error" in r);
    if (readers.length !== 2 || bad) return { error: bad && "error" in bad ? bad.error : "the arbitrator reads both readers' recorded verdicts" };
    rationales = readers.map((r) => (r as WithdrawalReviewReceipt).rationale);
  }
  const content = withdrawalBriefContent(d, input.reason.trim(), rationales);
  const requestId = "withdrawal_" + withdrawalBriefHash({ content, slot: input.slot }).slice(7, 39);
  const prompt = JSON.stringify({ requestId, ...content,
    task: "Decide, blind to any other reader, whether this unanswered question should be withdrawn for the reason given: sound if the reason holds and nothing the question asks is still needed, unsound otherwise. Call submit_withdrawal_verdict with this requestId, sound or unsound, and your rationale." });
  const saved = saveReaderRequest(root, { purpose: "withdrawal-review", requestId }, prompt);
  if ("error" in saved) return saved;
  return { ok: true as const, requestId, prompt };
}

export function submitWithdrawalVerdict(root: string, input: { requestId: string; verdict: "sound" | "unsound"; rationale: string }) {
  if (!readerRequest(root, { purpose: "withdrawal-review", requestId: input?.requestId })) return { error: "no withdrawal brief with that request id" };
  if (input.verdict !== "sound" && input.verdict !== "unsound") return { error: "verdict must be sound or unsound" };
  if (typeof input.rationale !== "string" || !input.rationale.trim()) return { error: "the reader must explain its verdict" };
  const receipt = randomUUID();
  const held = holdReaderReceipt(root, { purpose: "withdrawal-review", requestId: input.requestId }, receipt, JSON.stringify({ verdict: input.verdict, rationale: input.rationale }));
  return "error" in held ? held : { ok: true as const, held: true as const, receipt };
}

/** A reader's held verdict, checked against its own transcript: the exact brief, the exact call. */
function withdrawalReceipt(root: string, ref: WithdrawalReaderRef, dir: string): WithdrawalReviewReceipt | { error: string } {
  const key = { purpose: "withdrawal-review" as const, requestId: ref?.requestId };
  const prompt = readerRequest(root, key);
  const held = readerReceipts(root, key).find((r) => r.receipt === ref.receipt);
  if (!prompt || !held || (held.state !== "pending" && held.state !== "recorded")) return { error: `no held withdrawal verdict ${ref?.receipt}` };
  const body = JSON.parse(held.body) as { verdict: "sound" | "unsound"; rationale: string };
  const tool = /(^|__)submit_withdrawal_verdict$/;
  const call = ref.agentId && ref.callId ? readSubagentCall(ref.agentId, ref.callId, tool, dir) : readReceiptCall(tool, ref.receipt, held.heldAt, dir);
  if ("pending" in call) return { error: `${call.pending}: its call is not on disk yet — withdraw again in a moment` };
  if (isUnverified(call)) return { error: call.unverified };
  if (call.reader.prompt !== prompt) return { error: "the reader was not launched with exactly the issued withdrawal brief" };
  if (call.input?.requestId !== ref.requestId || call.input?.verdict !== body.verdict || call.input?.rationale !== body.rationale || call.result?.receipt !== ref.receipt)
    return { error: "the reader's own call does not match the held verdict" };
  const content = JSON.parse(prompt) as Record<string, unknown>;
  const { requestId: _r, task: _t, ...brief } = content;
  return { id: ref.receipt, session: call.reader.session, launch: call.reader.toolUseId, briefHash: withdrawalBriefHash(brief), verdict: body.verdict, rationale: body.rationale };
}

function verifiedWithdrawalReview(root: string, d: FoldedDecision, reason: string, input: { readers: WithdrawalReaderRef[]; arbitrator?: WithdrawalReaderRef }, dir: string): WithdrawalReview | { error: string } {
  if (!Array.isArray(input?.readers)) return { error: "review needs its readers" };
  const readers = input.readers.map((ref) => withdrawalReceipt(root, ref, dir));
  const bad = readers.find((r) => "error" in r);
  if (bad) return bad as { error: string };
  const arbitrator = input.arbitrator ? withdrawalReceipt(root, input.arbitrator, dir) : undefined;
  if (arbitrator && "error" in arbitrator) return arbitrator;
  const review: WithdrawalReview = { readers: readers as WithdrawalReviewReceipt[], ...(arbitrator ? { arbitrator } : {}) };
  const why = withdrawalReviewRefusal(d, reason, review);
  return why ? { error: why } : review;
}

/** Give an agent the exact question that a later transcript must prove was shown. */
export async function revisionRelayBrief(root: string,
  input: { decision: string; revises: string[]; findings: string[]; issues?: CanonicalIssueReference[] }, via: Via = {}) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  if (!isAgentActor(b.actor)) return { error: "relay revision brief is for the verifying agent" };
  const view = await decisionsView(root);
  const matches = decisionMatches(view.s, input.decision);
  if (matches.length > 1) return { error: ambiguous("decision", String(input.decision), matches) };
  const d = matches[0];
  if (!d || d.withdrawn || d.answers.some((a) => a.withdrawn))
    return { error: "no current decision for this relay" };
  const sources = input.revises?.map((id) => d.answers.find((a) => a.id === id));
  if (!sources?.length || sources.some((a) => !a?.verified || a.sourceAnswer || a.cancelled))
    return { error: "relay revision needs exact current verified source answers" };
  const scope = { findings: input.findings ?? [], ...(input.issues?.length ? { issues: input.issues } : {}) };
  if (d.presentation?.question.kind === "list" && !listRevisionItemIds(d, scope).length)
    return { error: "list revision needs selected items in its exact scope" };
  return { ok: true as const, decision: d.id, revises: input.revises, scope,
    question: revisionRelayQuestion(d, sources as FoldedDecision["answers"], b.actor.principal, scope) };
}

/** Record a human's correction from the exact AskUserQuestion transcript, even if the
 * recording machine pulled other events after the person answered. */
export async function reviseDecisionRelayed(root: string,
  input: { decision: string; revises: string[]; findings: string[]; issues?: CanonicalIssueReference[];
    session?: string; toolUseId?: string }, via: Via = {}, dir: string = transcriptDir()) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  if (!isAgentActor(b.actor)) return { error: "a relay revision is recorded by the verifying agent" };
  const w = await writable(root);
  if ("error" in w) return w;
  const matches = decisionMatches(w.s, input.decision);
  if (matches.length > 1) return { error: ambiguous("decision", String(input.decision), matches) };
  const d = matches[0];
  if (!d || d.withdrawn) return { error: "no current decision for this relay" };
  const sources = input.revises?.map((id) => d.answers.find((a) => a.id === id));
  if (!sources?.length || sources.some((a) => !a?.verified || a.sourceAnswer || a.cancelled))
    return { error: "relay revision needs exact current verified source answers" };
  const scope = { findings: input.findings ?? [], ...(input.issues?.length ? { issues: input.issues } : {}) };
  const expected = revisionRelayQuestion(d, sources as NonNullable<typeof sources[number]>[], b.actor.principal, scope);
  // The agent cannot see the call's id (I12): find the call that asked `expected`, which names
  // the source answers and so was asked after the last of them was recorded.
  const at = input.toolUseId ? { session: input.session ?? sessionHolding(input.toolUseId, dir), toolUseId: input.toolUseId }
    : soleAskCall(expected, sources.map((a) => a!.at).sort().at(-1)!, dir, input.session);
  if ("error" in at) return at;
  if (isUnverified(at.session)) return { error: at.session.unverified };
  const call = readCall(at.session, at.toolUseId, dir);
  if (isUnverified(call)) return { error: call.unverified };
  if (call.questions.length !== 1 || !sameQuestion(call.questions[0]!, expected))
    return { error: "human was not shown the exact predecessor, affected scope and new action" };
  const answer = call.answers[expected.question];
  if (typeof answer !== "string" || !answer.trim()) return { error: "revision needs one exact human response" };
  const proof = { session: call.session, toolUseId: call.toolUseId, entryId: call.entryId,
    answeredAt: call.at, question: call.questions[0]!, answer };
  const isList = d.presentation?.question.kind === "list";
  const parsed = isList ? parseListRelayAnswer(answer) : null;
  if (isList && !parsed) return { error: "list relay answer must approve all or give exact per-item correction JSON" };
  const list = parsed ? { items: listRevisionItemIds(d, scope), ...parsed } : undefined;
  const event = await reviseAnswerEvent(b.cfg.path, b.cfg.universe, b.actor, {
    decision: d.id, hash: d.hash, via: { kind: "revision-relay", proof },
    ...(list ? { list } : {}),
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
  resolves?: { answers: [string, string]; priorResolution: string; shownHash: string };
  option?: string; words?: string; list?: ListRevision }, via: Via = {}) {
  const b = bindDecisions(root, via);
  if ("error" in b) return b;
  if (isAgentActor(b.actor)) return { error: "revision needs the principal's own act" };
  const w = await writable(root);
  if ("error" in w) return w;
  const matches = decisionMatches(w.s, input?.decision);
  if (matches.length > 1) return { error: ambiguous("decision", String(input?.decision), matches) };
  const d = matches[0];
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
  const listError = checkListRevision(d, { findings: input.findings, issues }, input.list);
  if (listError) return { error: listError };
  const listQuestion = d.presentation?.question;
  const isList = listQuestion?.kind === "list";
  if (isList ? input.option !== undefined || input.words !== undefined
    : !!input.option === !!input.words) return { error: "revision needs the exact list answer or one option or new words" };
  if (input.option && !d.options.some((o) => o.label === input.option)) return { error: `${input.option} is not an option of ${d.ref}` };
  if (input.words !== undefined && !input.words.trim()) return { error: "revision words must be nonempty" };
  const marked = isList ? new Set(input.list!.marked.map((item) => item.itemId)) : undefined;
  const checked = isList ? listQuestion.items.filter((item) => marked!.has(item.id)).map((item) => item.text) : [];
  const viaAnswer = isList
    ? { kind: "direct" as const, checked: checked.length ? checked : [d.options.find((o) => o.approveAll)!.label] }
    : input.option ? { kind: "direct" as const, option: input.option } : { kind: "direct" as const, words: input.words! };
  const event = await reviseAnswerEvent(b.cfg.path, b.cfg.universe, b.actor,
    { decision: d.id, hash: d.hash, via: viaAnswer,
      ...(isList ? { list: input.list } : {}),
      revision: { of: input.revises, findings: input.findings,
        ...(issues.length ? { issues } : {}),
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
