/** Exact pair comparison admission. The fold, not the caller, decides authority. */
import { createHash, randomUUID } from "node:crypto";
import { bindDecisions, type Via } from "../ops-shared.js";
import { decisionsView } from "./decision-holds.js";
import { canonicalIssueKey, resolveDecisionIssue, type CanonicalIssueReference } from "../decision-issues.js";
import { decisionScope, foldDecisions, intentCandidates, comparisonRequestFor, comparisonBriefText, comparisonCurrentVersions, comparisonSourcesCurrent,
  type FoldedComparison } from "../shared-decisions.js";
import { emitEventChecked } from "../eventlog.js";
import { isAgentActor } from "../identity.js";
import { saveReaderRequest, readerRequest, holdReaderReceipt, readerReceipts,
  settleReaderReceipt } from "../reader-local.js";
import { findComparisonCalls, isUnverified, readCall, readReader, sameQuestion,
  transcriptDir } from "../transcript.js";
import { rulingApplicationsForAnswer } from "../store.js";
import { comparisonContextHash, deriveComparison, type CanonicalIssue,
  type ComparisonVerdict, type HumanResolution, type ReaderJudgment } from "../decision-comparison.js";
import type { AskedQuestion } from "../schema.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const pairKey = (ids: [string, string]) => [...ids].sort().join("\0");
const pairOf = (comparison: FoldedComparison): [string, string] =>
  [comparison.request.left.answerId, comparison.request.right.answerId];
const versionsOf = (comparison: FoldedComparison): [string, string] =>
  [`${comparison.request.left.answerId}\0${comparison.request.left.version}`,
    `${comparison.request.right.answerId}\0${comparison.request.right.version}`];
const complete = (comparison: FoldedComparison) => !comparison.projection.history.some((entry) => entry.state === "refused");

export async function comparisonDetail(root: string, id: string) {
  const v = await decisionsView(root);
  const comparison = v.s.comparisons.find((x) => x.request.id === id);
  if (!comparison) return { error: `no comparison ${id}`, status: v.status };
  const executions = [comparison.request.left.answerId, comparison.request.right.answerId]
    .flatMap((answer) => rulingApplicationsForAnswer(root, answer));
  return { ...v.status, comparison, executions,
    sourceChronology: [comparison.request.left, comparison.request.right].map((source) => {
      const answer = v.s.decisions.flatMap((d) => d.answers).find((a) => a.id === source.answerId);
      return { answer: source.answerId, givenAt: answer?.givenAt ?? null, recordedAt: answer?.at ?? null };
    }) };
}

/** The requested scope is canonical and may be narrower than a candidate's total scope. */
export async function requestComparison(root: string,
  input: { answers: [string, string]; issues?: CanonicalIssueReference[] }, via: Via = {}) {
  const bound = bindDecisions(root, via);
  if ("error" in bound) return bound;
  const view = await decisionsView(root);
  if (view.status.status === "blocked") return { error: "the decisions log is blocked" };
  if (!Array.isArray(input?.answers) || input.answers.length !== 2 || input.answers[0] === input.answers[1])
    return { error: "request two distinct exact answer IDs" };
  const candidate = intentCandidates(view.s).find((x) => pairKey(x.answers) === pairKey(input.answers));
  if (!candidate) return { error: "those answers are not a current independent comparison candidate; nominate their overlap first" };
  const requested: CanonicalIssue[] = [];
  if (input.issues?.length) {
    for (const issue of input.issues) {
      const resolved = await resolveDecisionIssue(root, issue);
      if (!resolved.ok) return { error: resolved.error };
      if (canonicalIssueKey(resolved.ref) !== canonicalIssueKey(issue)) return { error: "issue reference must be canonical" };
      requested.push(resolved.ref);
    }
  } else {
    requested.push(...(candidate.issues ?? []));
    for (const id of candidate.findings) {
      const resolved = await resolveDecisionIssue(root, { kind: "finding", universe: bound.cfg.universe, id });
      if (!resolved.ok) return { error: resolved.error };
      requested.push(resolved.ref);
    }
  }
  if (!requested.length) for (const id of candidate.decisionScope ?? [])
    requested.push({ kind: "decision", universe: bound.cfg.universe, scope: decisionScope(bound.cfg.universe), id });
  if (!requested.length || new Set(requested.map((x) => `${x.kind}\0${x.scope}\0${x.id}`)).size !== requested.length)
    return { error: "comparison requires distinct canonical affected scope" };
  const ids = [...input.answers].sort() as [string, string];
  const source = comparisonRequestFor(view.s, "draft", ids, requested);
  if (!source) return { error: "both exact verified answer sources are required" };
  const id = `cmp_${hash({ pair: ids, scope: requested.map((x) => [x.kind, x.scope, x.id]).sort(),
    versions: [source.left.version, source.right.version] }).slice(0, 24)}`;
  const result = await emitEventChecked(bound.cfg.path, decisionScope(bound.cfg.universe), bound.actor, async (events) => {
    const current = foldDecisions(events);
    const existing = events.find((e) => e.kind === "decision.comparison.requested" && e.subject === id);
    if (existing) return { existing };
    const nowCandidate = intentCandidates(current).find((x) => pairKey(x.answers) === pairKey(ids));
    if (!nowCandidate) return { error: "comparison candidate changed before append" };
    const each = requested.every((issue) => issue.kind === "decision"
      ? nowCandidate.decisionScope?.includes(issue.id)
      : issue.kind === "finding" ? nowCandidate.findings.includes(issue.id)
          || (nowCandidate.issues ?? []).some((ref) => canonicalIssueKey(ref) === canonicalIssueKey(issue as CanonicalIssueReference))
        : (nowCandidate.issues ?? []).some((ref) => canonicalIssueKey(ref) === canonicalIssueKey(issue as CanonicalIssueReference)));
    if (!each) return { error: "affected issue scope changed before append" };
    const request = comparisonRequestFor(current, id, ids, requested);
    if (!request || request.contextHash !== source.contextHash)
      return { error: "answer source changed before comparison request" };
    return { kind: "decision.comparison.requested", subject: id, data: { request } };
  });
  if ("error" in result) return result;
  const after = await comparisonDetail(root, id);
  if ("error" in after) return { error: `comparison ${id} was not accepted on replay: ${after.error}`, event: result.id };
  return { ok: true as const, id, event: result.id, ...after };
}

/** Freeze the full reader prompt locally under its exact purpose/request key. */
export async function comparisonBrief(root: string, id: string) {
  const detail = await comparisonDetail(root, id);
  if ("error" in detail) return detail;
  if (detail.comparison.projection.state === "resolved") return { error: "comparison already has a human resolution" };
  const prompt = comparisonBriefText(detail.comparison.request);
  const saved = saveReaderRequest(root, { purpose: "pair-comparison", requestId: id }, prompt);
  if ("error" in saved) return saved;
  return { ok: true as const, id, prompt,
    note: "Launch one new independent reader with exactly this prompt. It calls submit_comparison_judgment itself; then record_comparison_judgment verifies its transcript receipt." };
}

/** Called by the independent reader; result is held until its own call/result is on disk. */
export async function submitComparisonJudgment(root: string,
  input: { request: string; verdict: ComparisonVerdict; rationale: string }, via: Via = {}) {
  const bound = bindDecisions(root, via);
  if ("error" in bound) return bound;
  const detail = await comparisonDetail(root, input?.request);
  if ("error" in detail) return detail;
  if (!readerRequest(root, { purpose: "pair-comparison", requestId: input.request }))
    return { error: "this machine issued no exact pair-comparison brief" };
  if (!["equivalent", "incompatible", "unclear"].includes(input.verdict) || !input.rationale?.trim())
    return { error: "judgment needs equivalent, incompatible or unclear and a rationale" };
  const receipt = randomUUID();
  const body = JSON.stringify({ verdict: input.verdict, rationale: input.rationale, principal: bound.actor.principal });
  const held = holdReaderReceipt(root, { purpose: "pair-comparison", requestId: input.request }, receipt, body);
  if ("error" in held) return held;
  return { ok: true as const, held: true as const, receipt,
    note: "Held locally; the requesting agent calls record_comparison_judgment after this tool result appears in the reader transcript." };
}

export async function recordComparisonJudgment(root: string, input: { request: string },
  via: Via = {}, dir: string = transcriptDir()) {
  const bound = bindDecisions(root, via);
  if ("error" in bound) return bound;
  const detail = await comparisonDetail(root, input?.request);
  if ("error" in detail) return detail;
  const key = { purpose: "pair-comparison" as const, requestId: input.request };
  const brief = readerRequest(root, key);
  if (!brief || brief !== comparisonBriefText(detail.comparison.request))
    return { error: "issued comparison brief differs from the exact current request" };
  const pending = readerReceipts(root, key).filter((x) => x.state === "pending");
  for (const held of pending) {
    const body = JSON.parse(held.body) as { verdict: ComparisonVerdict; rationale: string; principal: string };
    const calls = findComparisonCalls(input.request, body.verdict, body.rationale, dir)
      .filter((x) => x.result === "held" && x.receipt === held.receipt);
    if (calls.length !== 1 || !calls[0]!.agentId) continue;
    const call = calls[0]!;
    const reader = readReader(call.agentId!, call.callId, dir);
    if (isUnverified(reader) || reader.prompt !== brief || reader.session !== call.session) {
      settleReaderReceipt(root, key, held.receipt, "invalid", isUnverified(reader) ? reader.unverified : "reader did not receive the exact brief", call.callId);
      continue;
    }
    const comparison = detail.comparison;
    const proof = { purpose: "pair-comparison", requestId: input.request, contextHash: comparison.request.contextHash,
      brief, receipt: held.receipt, agent: reader.agentId, session: reader.session,
      launch: reader.toolUseId, toolUseId: reader.toolUseId, call: call.callId, result: "held" };
    const judgment: Omit<ReaderJudgment, "id" | "at"> = {
      requestId: input.request, contextHash: comparison.request.contextHash, issues: comparison.request.issues,
      answerVersions: versionsOf(comparison), verdict: body.verdict, rationale: body.rationale,
      reader: { principal: body.principal, agent: reader.agentId, session: reader.session,
        request: reader.toolUseId, receipt: held.receipt },
    };
    const event = await emitEventChecked(bound.cfg.path, decisionScope(bound.cfg.universe), bound.actor, async (events) => {
      const current = foldDecisions(events).comparisons.find((x) => x.request.id === input.request);
      if (!current || current.request.contextHash !== comparison.request.contextHash
        || current.projection.state === "resolved") return { error: "comparison changed before judgment append" };
      const old = events.find((e) => e.kind === "decision.comparison.judged"
        && (e.data as any)?.proof?.receipt === held.receipt);
      if (old) return { existing: old };
      const trial: ReaderJudgment = { ...judgment, id: `trial_${held.receipt}`, at: new Date().toISOString() };
      const folded = foldDecisions(events);
      if (!comparisonSourcesCurrent(folded, current.request)) return { error: "an answer version changed before judgment append" };
      const currentVersions = comparisonCurrentVersions(folded, current.request);
      const result = deriveComparison(current.request, currentVersions, [...current.judgments, trial], current.resolutions);
      if (!result.ok || !result.value.acceptedJudgments.some((x) => x.id === trial.id))
        return { error: "judgment is not independent or does not match the current comparison" };
      return { kind: "decision.comparison.judged", subject: input.request, data: { judgment, proof } };
    });
    if ("error" in event) return event;
    settleReaderReceipt(root, key, held.receipt, "recorded", undefined, call.callId);
    return { ok: true as const, recorded: true as const, event: event.id,
      comparison: (await comparisonDetail(root, input.request)) };
  }
  return { ok: false as const, pending: pending.length > 0,
    note: pending.length ? "The reader's successful call/result is not yet verified in this machine's transcript" : "No pending reader judgment; issue a brief and have an independent reader submit one" };
}

const resolutionExecutions = (root: string, comparison: FoldedComparison) =>
  pairOf(comparison).flatMap((answer) => rulingApplicationsForAnswer(root, answer));
const resolutionShown = (root: string, comparison: FoldedComparison) =>
  ({ request: comparison.request, judgments: comparison.projection.acceptedJudgments,
    resolutions: comparison.projection.acceptedResolutions,
    executions: resolutionExecutions(root, comparison) });

export async function comparisonResolutionBrief(root: string, id: string) {
  const detail = await comparisonDetail(root, id);
  if ("error" in detail) return detail;
  const shown = resolutionShown(root, detail.comparison);
  const question: AskedQuestion = { question: JSON.stringify(shown),
    options: [detail.comparison.request.left, detail.comparison.request.right].map((source) =>
      ({ label: `Preserve ${source.answerId}`, description: `Preserve the full ruling from ${source.principal}: ${source.words}` })) };
  return { ok: true as const, id, shown, shownHash: detail.comparison.request.contextHash,
    executionsHash: hash(shown.executions), question };
}

/** A verified question result or authenticated human web act chooses one exact alternative. */
export async function resolveComparison(root: string,
  input: { request: string; preserve: string; rationale: string; shownHash: string; executionsHash: string;
    revises?: string; shownResolution?: HumanResolution["shownResolution"];
    source: "web" | "question"; session?: string; toolUseId?: string },
  via: Via = {}, dir: string = transcriptDir()) {
  const bound = bindDecisions(root, via);
  if ("error" in bound) return bound;
  const detail = await comparisonDetail(root, input?.request);
  if ("error" in detail) return detail;
  const comparison = detail.comparison;
  if (![comparison.request.left.answerId, comparison.request.right.answerId].includes(input.preserve)
    || !input.rationale?.trim() || input.shownHash !== comparison.request.contextHash)
    return { error: "resolution needs one exact shown alternative, its context hash and a rationale" };
  const brief = await comparisonResolutionBrief(root, input.request);
  if (!("question" in brief)) return brief;
  if (input.executionsHash !== brief.executionsHash) return { error: "executed closure receipts changed; review the comparison again" };
  let session: string, request: string, receipt: string;
  if (input.source === "web") {
    if (isAgentActor(bound.actor)) return { error: "web resolution needs the principal's own act" };
    session = "web"; request = input.request; receipt = randomUUID();
  } else if (input.source === "question") {
    if (!input.session || !input.toolUseId) return { error: "a question resolution needs exact session and AskUserQuestion call" };
    const call = readCall(input.session, input.toolUseId, dir);
    if (isUnverified(call)) return { error: call.unverified };
    if (call.questions.length !== 1 || !sameQuestion(call.questions[0]!, brief.question)
      || call.answers[brief.question.question] !== `Preserve ${input.preserve}`)
      return { error: "human question did not show the exact alternatives and receive the named choice" };
    session = call.session; request = call.toolUseId; receipt = call.entryId;
  } else return { error: "resolution source must be web or verified question" };
  const resolution: Omit<HumanResolution, "id" | "at"> = {
    requestId: input.request, contextHash: comparison.request.contextHash, issues: comparison.request.issues,
    answerVersions: versionsOf(comparison), preserve: input.preserve,
    ...(input.revises ? { revises: input.revises, shownResolution: input.shownResolution } : {}),
    rationale: input.rationale,
    human: { principal: bound.actor.principal, session, request, receipt, shownHash: input.shownHash },
  };
  const proof = { purpose: "human-comparison", source: input.source, principal: bound.actor.principal,
    contextHash: comparison.request.contextHash, shownHash: input.shownHash,
    receipt, session, toolUseId: input.toolUseId, shown: brief.shown,
    executionsHash: brief.executionsHash };
  const event = await emitEventChecked(bound.cfg.path, decisionScope(bound.cfg.universe), bound.actor, async (events) => {
    const current = foldDecisions(events).comparisons.find((x) => x.request.id === input.request);
    if (!current || current.request.contextHash !== comparison.request.contextHash)
      return { error: "comparison changed before resolution append" };
    if (hash(resolutionExecutions(root, current)) !== input.executionsHash)
      return { error: "executed closure receipts changed before resolution append" };
    const folded = foldDecisions(events);
    if (!comparisonSourcesCurrent(folded, current.request)) return { error: "an answer version changed before resolution append" };
    const versions = comparisonCurrentVersions(folded, current.request);
    const trial = { ...resolution, id: `trial_${receipt}`, at: new Date().toISOString() } as HumanResolution;
    const projected = deriveComparison(current.request, versions, current.judgments, [...current.resolutions, trial]);
    if (!projected.ok || !projected.value.acceptedResolutions.some((x) => x.id === trial.id))
      return { error: "comparison has no established judgment or this correction does not match the authority frontier" };
    return { kind: "decision.comparison.resolved", subject: input.request, data: { resolution, proof } };
  });
  if ("error" in event) return event;
  return { ok: true as const, event: event.id, comparison: await comparisonDetail(root, input.request) };
}
