/** Checked ruling application and machine-local, transcript-backed application readers. */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requireActor } from "../identity.js";
import { sidecarWriteDoor, sidecarIdentity } from "../sidecar-config.js";
import { resolveDecisionIssue, canonicalIssueKey, type IssueReference, type ResolvedIssue } from "../decision-issues.js";
import { readScopeChecked, emitEventChecked, type LogEvent } from "../eventlog.js";
import { foldFindings, isClosed, type SharedFinding } from "../shared-findings.js";
import { readCached } from "../materialize.js";
import { findingsProjection } from "../shared-projections.js";
import { foldBugs, type SharedBug } from "../shared-bugs.js";
import { decisionScope, foldDecisions, intentCandidates, comparisonRestricts, namedIssues, answerHasCurrentAuthority, type FoldedAnswer, type FoldedDecision } from "../shared-decisions.js";
import { saveReaderRequest, readerRequest, holdReaderReceipt, readerReceipts, settleReaderReceipt } from "../reader-local.js";
import { readReader, isUnverified, transcriptDir } from "../transcript.js";
import {
  applicationDisplayHash, applicationKey, issueClaimHash, validateApplicationCapsule,
  type ApplicationCapsuleV1, type ApplicationReaderReceipt,
} from "../ruling-application.js";
import { materializeBugs } from "../bugs-publish.js";
import { lookupFinding } from "../store.js";

const PURPOSE = "issue-application" as const;
const digest = (value: unknown): string => "sha256:" + createHash("sha256").update(JSON.stringify(value)).digest("hex");
const word = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

interface Context {
  target: ResolvedIssue;
  issue: SharedFinding | SharedBug;
  decision: FoldedDecision;
  answer: FoldedAnswer;
  display: ApplicationCapsuleV1["ruling"]["display"];
  displayHash: string;
  claimHash: string;
  directMention?: string;
  decisionFingerprint: string;
}

const shownExactLink = (shown: string, ref: Extract<ResolvedIssue, { ref: { kind: "finding" } }>["ref"]): string | undefined => {
  for (const candidate of shown.match(/(?:https?:\/\/|\/#\/)\S+/g) ?? []) {
    const link = candidate.replace(/[),.;]+$/, "");
    try {
      const url = new URL(link, "https://codemap.invalid/");
      const [path, query] = url.hash.slice(1).split("?", 2);
      const match = /^\/u\/([^/]+)\/shared\/([^/]+)\//.exec(path ?? "");
      if (match && decodeURIComponent(match[1]!) === ref.universe && decodeURIComponent(match[2]!) === ref.review
        && new URLSearchParams(query).get("f") === ref.id) return link;
    } catch { /* malformed shown link */ }
  }
  return undefined;
};
const shownExactId = (shown: string, id: string): boolean => {
  let at = shown.indexOf(id);
  while (at >= 0) {
    const before = shown[at - 1], after = shown[at + id.length];
    if ((!before || !/[A-Za-z0-9_]/.test(before)) && (!after || !/[A-Za-z0-9_]/.test(after))) return true;
    at = shown.indexOf(id, at + 1);
  }
  return false;
};

async function context(root: string, input: { issue: IssueReference; answerId: string }): Promise<Context | { error: string }> {
  const resolved = await resolveDecisionIssue(root, input.issue);
  if (!resolved.ok) return { error: resolved.error };
  const door = sidecarWriteDoor(root);
  if (!door.cfg) return { error: door.error ?? "a shared sidecar is required for ruling application" };
  if (door.cfg.universe !== resolved.ref.universe) return { error: "the sidecar is bound to another universe" };
  const target = await readScopeChecked(door.cfg.path, resolved.ref.scope);
  if (target.status !== "complete") return { error: `the issue scope is blocked: ${target.diagnostic?.detail ?? "unreadable"}` };
  const issue = resolved.ref.kind === "finding"
    ? foldFindings(target.events).get(resolved.ref.id)
    : foldBugs(target.events).get(resolved.ref.id);
  if (!issue) return { error: "the projected issue is missing from its authoritative scope" };
  if (isClosed(issue.state)) return { error: "already closed" };
  if (!issue.openEpoch) return { error: "the issue has no open-state event identity" };
  const source = await readScopeChecked(door.cfg.path, decisionScope(door.cfg.universe));
  if (source.status !== "complete") return { error: `the ruling scope is blocked: ${source.diagnostic?.detail ?? "unreadable"}` };
  const decisions = foldDecisions(source.events);
  const pair = decisions.decisions.flatMap((d) => d.answers.map((a) => ({ d, a }))).find((x) => x.a.id === input.answerId);
  if (!pair) return { error: `no ruling answer ${input.answerId}` };
  const { d, a } = pair;
  if (!a.verified || a.sourceAnswer || a.cancelled || a.withdrawn || a.resolvedOutBy || a.elsewhere || a.revisionInvalid || d.withdrawn)
    return { error: `answer ${a.id} has no current verified authority` };
  if (resolved.ref.kind === "bug" && !namedIssues(d).some((ref) => canonicalIssueKey(ref) === resolved.key))
    return { error: "the ruling does not name this exact bug" };
  const declaredFinding = resolved.ref.kind === "finding"
    && d.options.some((o) => o.effects.some((e) => e.findings.includes(resolved.ref.id)));
  const authorityScope = resolved.ref.kind === "bug" || declaredFinding ? resolved.ref
    : { kind: "decision" as const, universe: door.cfg.universe,
      scope: decisionScope(door.cfg.universe), id: d.id };
  if (!answerHasCurrentAuthority(d, a, authorityScope))
    return { error: `answer ${a.id} is not a current ruling for this issue` };
  if (d.withdrawals?.some((w) => w.state === "conflict")) return { error: "ruling withdrawal is in conflict" };
  if (intentCandidates(decisions).some((c) => {
    if (!c.answers.includes(a.id)) return false;
    const issueOverlaps = resolved.ref.kind === "bug"
      ? c.issues?.some((ref) => canonicalIssueKey(ref) === resolved.key)
      : c.findings.includes(resolved.ref.id);
    const decisionOverlaps = c.decisionScope?.includes(d.id);
    return (issueOverlaps && comparisonRestricts(decisions, c, resolved.ref))
      || (!issueOverlaps && decisionOverlaps && comparisonRestricts(decisions, c, authorityScope));
  })) return { error: "ruling awaits independent comparison or human resolution" };
  const selected = d.payload.options.filter((option) => a.options.includes(option.label));
  const display = { question: d.payload.question, answer: [a.words, ...selected.map((option) => option.description ?? "")].filter(Boolean).join("\n"),
    context: JSON.stringify({ payload: d.payload, options: d.options }) };
  const claimHash = issueClaimHash(resolved.ref.kind, issue);
  const questionOrAnswer = `${display.question}\n${display.answer}`;
  const findingLookup = resolved.ref.kind === "finding" ? lookupFinding(root, resolved.ref.id) : undefined;
  const unambiguous = !findingLookup || !("ambiguous" in findingLookup);
  const directMention = resolved.ref.kind === "finding"
    ? shownExactLink(questionOrAnswer, resolved.ref) ?? (unambiguous && shownExactId(questionOrAnswer, resolved.ref.id) ? resolved.ref.id : undefined)
    : shownExactId(questionOrAnswer, resolved.ref.id) ? resolved.ref.id : undefined;
  return { target: resolved, issue, decision: d, answer: a, display, displayHash: applicationDisplayHash(display),
    claimHash, directMention, decisionFingerprint: digest(source.events.map((e) => [e.id, e.kind, e.data])) };
}

export interface ApplicationReceiptRef { requestId: string; receipt: string; agentId: string; callId: string }

interface Brief {
  requestId: string;
  answerId: string;
  issueKey: string;
  claimHash: string;
  displayHash: string;
  role: "reader" | "arbitrator";
  slot: number;
  prompt: string;
  issuedAt: string;
  readerReceipts?: string[];
}
const parsedBrief = (root: string, requestId: string): Brief | undefined => {
  const raw = readerRequest(root, { purpose: PURPOSE, requestId });
  if (!raw) return undefined;
  try { return JSON.parse(raw) as Brief; } catch { return undefined; }
};

/** The full frozen claim and ruling. Each independent launch has its own slot and request ID. */
export async function applicationReaderBrief(root: string, input: { issue: IssueReference; answerId: string; role?: "reader" | "arbitrator"; slot: number; readers?: ApplicationReceiptRef[] }, dir = transcriptDir()) {
  const c = await context(root, input);
  if ("error" in c) return c;
  const role = input.role ?? "reader";
  if ((role === "reader" && input.slot !== 1 && input.slot !== 2) || (role === "arbitrator" && input.slot !== 3))
    return { error: "reader slots are 1 or 2; the arbitrator uses slot 3" };
  let rationales: { request: string; verdict: string; rationale: string }[] | undefined;
  if (role === "arbitrator") {
    if (!Array.isArray(input.readers) || input.readers.length !== 2) return { error: "arbitration needs two recorded reader receipts" };
    const checked = input.readers.map((ref) => verifiedReceipt(root, ref, dir));
    if (checked.some((x) => "error" in x)) return { error: "arbitration needs two authentic recorded reader receipts" };
    const pair = checked as Exclude<(typeof checked)[number], { error: string }>[];
    if (pair.some((x) => x.brief.role !== "reader" || x.brief.issueKey !== c.target.key || x.brief.answerId !== c.answer.id
      || x.brief.claimHash !== c.claimHash || x.brief.displayHash !== c.displayHash)
      || new Set(pair.map((x) => x.call.session)).size !== 2
      || new Set(pair.map((x) => x.call.launch)).size !== 2
      || pair.filter((x) => x.body.verdict === "sound").length !== 1)
      return { error: "arbitration requires independent current readers in disagreement" };
    rationales = pair.map((x) => ({ request: x.brief.requestId, verdict: x.body.verdict, rationale: x.body.rationale }));
  }
  const claim = c.target.ref.kind === "finding"
    ? { target: (c.issue as SharedFinding).target, text: (c.issue as SharedFinding).text,
      comment: (c.issue as SharedFinding).comment, severity: (c.issue as SharedFinding).severity,
      category: (c.issue as SharedFinding).category, line: (c.issue as SharedFinding).line,
      witness: (c.issue as SharedFinding).witness }
    : { title: (c.issue as SharedBug).title, text: (c.issue as SharedBug).text,
      severity: (c.issue as SharedBug).severity, category: (c.issue as SharedBug).category,
      anchors: (c.issue as SharedBug).anchors };
  const requestId = "application_reader_" + digest([c.target.key, input.answerId, role, input.slot,
    c.issue.openEpoch, c.issue.state, claim, c.claimHash, c.displayHash, input.readers?.map((r) => r.receipt), rationales]).slice(7);
  const prompt = JSON.stringify({
    purpose: PURPOSE, requestId, role, slot: input.slot,
    issue: { ref: c.target.ref, state: c.issue.state, openEpoch: c.issue.openEpoch, claimHash: c.claimHash, claim },
    ruling: { round: c.decision.round, question: c.decision.payload, options: c.decision.options,
      answerId: c.answer.id, words: c.answer.words, displayed: c.display },
    rationales, readerReceipts: role === "arbitrator" ? input.readers?.map((r) => r.receipt) : undefined,
    task: role === "reader"
      ? "Independently judge whether this human ruling defeats the issue's premise. Call submit_application_verdict with this requestId, verdict sound or unsound, and your rationale."
      : "Read both independent reader rationales supplied with the request. Decide whether the ruling soundly defeats this issue; call submit_application_verdict.",
  });
  const prior = parsedBrief(root, requestId);
  const brief: Brief = { requestId, answerId: input.answerId, issueKey: c.target.key, claimHash: c.claimHash,
    displayHash: c.displayHash, role, slot: input.slot, prompt, issuedAt: prior?.issuedAt ?? new Date().toISOString(),
    ...(role === "arbitrator" ? { readerReceipts: input.readers!.map((r) => r.receipt) } : {}) };
  const saved = saveReaderRequest(root, { purpose: PURPOSE, requestId }, JSON.stringify(brief));
  if ("error" in saved) return saved;
  return { ok: true as const, requestId, prompt, existing: !saved.saved, directMention: !!c.directMention };
}

/** The reader submits its own verdict; it is only held until its successful tool call is verified. */
export function submitApplicationVerdict(root: string, input: { requestId: string; verdict: "sound" | "unsound"; rationale: string }) {
  const brief = parsedBrief(root, input.requestId);
  if (!brief) return { error: "no application reader brief with that request ID" };
  if (input.verdict !== "sound" && input.verdict !== "unsound") return { error: "verdict must be sound or unsound" };
  if (!word(input.rationale)) return { error: "the reader must explain its verdict" };
  const receipt = randomUUID();
  const held = holdReaderReceipt(root, { purpose: PURPOSE, requestId: input.requestId }, receipt,
    JSON.stringify({ verdict: input.verdict, rationale: input.rationale }));
  if ("error" in held) return held;
  return { ok: true as const, held: true as const, receipt };
}

interface VerifiedCall { agentId: string; callId: string; session: string; launch: string; launchedAt: string }
const resultObject = (v: unknown): any => {
  if (v && typeof v === "object") {
    if (Array.isArray(v)) return resultObject(v.find((x) => x?.type === "text")?.text);
    if ((v as any).content && !(v as any).held) return resultObject((v as any).content);
    return v;
  }
  if (typeof v === "string") { try { return resultObject(JSON.parse(v)); } catch { return undefined; } }
  return undefined;
};
function verifyCall(brief: Brief, receipt: string, body: { verdict: string; rationale: string }, agentId: string, callId: string, dir: string): VerifiedCall | { error: string } {
  const reader = readReader(agentId, callId, dir);
  if (isUnverified(reader)) return { error: reader.unverified };
  if (reader.prompt !== brief.prompt) return { error: "reader launch did not use the exact issued application brief" };
  let lines: any[];
  try { lines = readFileSync(join(dir, reader.session, "subagents", `agent-${agentId}.jsonl`), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch { return { error: "reader transcript is unreadable" }; }
  const calls = lines.filter((e) => e.type === "assistant" && e.isSidechain === true && e.agentId === agentId)
    .flatMap((e) => (e.message?.content ?? []).filter((x: any) => x?.type === "tool_use" && x.id === callId).map((x: any) => ({ e, x })));
  if (calls.length !== 1 || !/(^|__)submit_application_verdict$/.test(calls[0]!.x.name ?? "")) return { error: "reader's application submit call was not found uniquely" };
  const submitted = calls[0]!.x.input;
  if (submitted?.requestId !== brief.requestId || submitted?.verdict !== body.verdict || submitted?.rationale !== body.rationale)
    return { error: "reader's submitted verdict differs from the held receipt" };
  const results = lines.filter((e) => e.type === "user" && e.isSidechain === true && e.agentId === agentId
    && Array.isArray(e.message?.content) && e.message.content.some((x: any) => x?.type === "tool_result" && x.tool_use_id === callId));
  if (results.length !== 1) return { error: "reader's submit call has no unique result" };
  const result = results[0]!;
  const blocks = Array.isArray(result.message?.content) ? result.message.content.filter((x: any) => x?.type === "tool_result") : [];
  if (blocks.length !== 1) return { error: "reader submit result is ambiguous" };
  const parsed = resultObject(result.toolUseResult) ?? resultObject(blocks[0]!.content);
  if (parsed?.ok !== true || parsed?.held !== true || parsed?.receipt !== receipt)
    return { error: "reader's successful submit receipt was not found" };
  return { agentId, callId, session: reader.session, launch: reader.toolUseId, launchedAt: reader.launchedAt };
}

function verifiedReceipt(root: string, ref: ApplicationReceiptRef, dir: string):
  | { brief: Brief; body: { verdict: "sound" | "unsound"; rationale: string }; call: VerifiedCall; ref: ApplicationReceiptRef }
  | { error: string } {
  const brief = parsedBrief(root, ref.requestId);
  if (!brief) return { error: "application reader brief is missing" };
  const held = readerReceipts(root, { purpose: PURPOSE, requestId: ref.requestId }).find((x) => x.receipt === ref.receipt);
  if (!held || held.state !== "recorded" || held.call !== ref.callId) return { error: "application reader receipt is not recorded and verified" };
  let body: { verdict: "sound" | "unsound"; rationale: string };
  try { body = JSON.parse(held.body); } catch { return { error: "application reader receipt is malformed" }; }
  if ((body.verdict !== "sound" && body.verdict !== "unsound") || !word(body.rationale))
    return { error: "application reader receipt has no valid verdict" };
  const call = verifyCall(brief, held.receipt, body, ref.agentId, ref.callId, dir);
  if ("error" in call) return call;
  return { brief, body, call, ref };
}

/** Verify the held call/result and launch, then mark this machine-local receipt recorded. */
export function recordApplicationVerdict(root: string, input: { requestId: string; receipt: string; agentId: string; callId: string }, dir = transcriptDir()) {
  const brief = parsedBrief(root, input.requestId);
  if (!brief) return { error: "no application reader brief with that request ID" };
  const held = readerReceipts(root, { purpose: PURPOSE, requestId: input.requestId }).find((x) => x.receipt === input.receipt);
  if (!held) return { error: "no held application reader receipt" };
  if (held.state === "recorded") return held.call === input.callId ? { ok: true as const, recorded: true as const, existing: true as const } : { error: "receipt was recorded from another call" };
  if (held.state !== "pending") return { error: `reader receipt is ${held.state}: ${held.why ?? "not actionable"}` };
  let body: { verdict: string; rationale: string };
  try { body = JSON.parse(held.body); } catch { return { error: "application reader receipt is malformed" }; }
  const verified = verifyCall(brief, held.receipt, body, input.agentId, input.callId, dir);
  if ("error" in verified) return { pending: true as const, reason: verified.error };
  const settled = settleReaderReceipt(root, { purpose: PURPOSE, requestId: input.requestId }, input.receipt, "recorded", undefined, input.callId);
  if ("error" in settled) return settled;
  return { ok: true as const, recorded: true as const, agentId: verified.agentId, session: verified.session };
}

/** One target-scope act is both closure and permanent consumption receipt. */
export async function applyRuling(root: string, input: { issue: IssueReference; answerId: string; readers: ApplicationReceiptRef[]; arbitrator?: ApplicationReceiptRef }, dir = transcriptDir()) {
  const door = sidecarWriteDoor(root);
  if (!door.cfg) return { error: door.error ?? "a shared sidecar is required for ruling application" };
  const actor = requireActor(root, { agent: true });
  if ("error" in actor) return actor;
  const resolved = await resolveDecisionIssue(root, input.issue);
  if (!resolved.ok) return { error: resolved.error };
  const event = await emitEventChecked(door.cfg.path, resolved.ref.scope, actor, async (events) => {
    const rawTarget = resolved.ref.kind === "finding" ? foldFindings(events).get(resolved.ref.id) : foldBugs(events).get(resolved.ref.id);
    const pairKey = applicationKey(input.answerId, resolved.key);
    const prior = rawTarget?.applications?.find((a) => a.key === pairKey && a.status === "executed");
    if (prior) {
      const existing = events.find((e) => e.id === prior.eventId);
      return existing ? { existing } : { error: "recorded application receipt is missing from the log" };
    }
    const c = await context(root, input);
    if ("error" in c) return c;
    if (c.target.key !== resolved.key || c.target.ref.scope !== resolved.ref.scope) return { error: "issue identity changed before append" };
    const target = resolved.ref.kind === "finding" ? foldFindings(events).get(resolved.ref.id) : foldBugs(events).get(resolved.ref.id);
    if (!target || target.openEpoch !== c.issue.openEpoch || issueClaimHash(resolved.ref.kind, target) !== c.claimHash)
      return { error: "issue changed before append; obtain a fresh application brief" };
    const key = applicationKey(c.answer.id, c.target.key);
    if (isClosed(target.state)) return { error: "already closed" };
    const direct = !!c.directMention;
    if (!Array.isArray(input.readers) || input.readers.length !== (direct ? 1 : 2)) return { error: `application needs ${direct ? "one" : "two"} independent sound reader${direct ? "" : "s"}` };
    const refs = [...input.readers, ...(input.arbitrator ? [input.arbitrator] : [])];
    const verified: { brief: Brief; body: { verdict: "sound" | "unsound"; rationale: string }; call: VerifiedCall; ref: ApplicationReceiptRef }[] = [];
    for (const ref of refs) {
      const v = verifiedReceipt(root, ref, dir);
      if ("error" in v) return v;
      if (v.brief.answerId !== c.answer.id || v.brief.issueKey !== c.target.key || v.brief.claimHash !== c.claimHash || v.brief.displayHash !== c.displayHash)
        return { error: "application reader brief belongs to another issue/ruling version" };
      verified.push(v);
    }
    if (new Set(verified.map((x) => x.call.session)).size !== verified.length || new Set(verified.map((x) => x.call.launch)).size !== verified.length)
      return { error: "application readers were not independently launched" };
    if (verified.slice(0, input.readers.length).some((x) => x.brief.role !== "reader")
      || (input.arbitrator && verified.at(-1)?.brief.role !== "arbitrator")) return { error: "application reader roles do not match their requests" };
    if (input.arbitrator && JSON.stringify(verified.at(-1)?.brief.readerReceipts) !== JSON.stringify(input.readers.map((r) => r.receipt)))
      return { error: "arbitrator did not read these exact two reader receipts" };
    const receipts = (xs: typeof verified): ApplicationReaderReceipt[] => xs.map((x) => ({
      id: x.ref.receipt, request: x.ref.requestId, launch: x.call.launch, session: x.call.session,
      by: { principal: actor.principal, via: { kind: "agent", harness: "subagent" } },
      briefHash: digest(x.brief.prompt), manifestHash: digest([x.brief.issueKey, x.brief.claimHash, x.brief.displayHash]),
      issueHash: c.claimHash, rulingHash: c.displayHash, verdict: x.body.verdict, rationale: x.body.rationale,
    }));
    const readers = receipts(verified.slice(0, input.readers.length));
    const arbitrator = input.arbitrator ? receipts(verified.slice(-1))[0] : undefined;
    const capsule: ApplicationCapsuleV1 = {
      version: 1, key,
      issue: { ref: c.target.ref, key: c.target.key, openEpoch: target.openEpoch!, openState: target.state as "issued" | "created", claimHash: c.claimHash },
      ruling: { key: c.answer.id, answerId: c.answer.id, answerEvent: c.answer.id, roundId: c.decision.round, questionId: c.decision.id,
        display: c.display, displayHash: c.displayHash,
        authority: { checkedAt: new Date().toISOString(), sourceFingerprint: c.decisionFingerprint, status: "current", comparison: "clear" } },
      evidence: { ...(c.directMention ? { directMention: c.directMention } : {}), readers, ...(arbitrator ? { arbitrator } : {}) },
      reason: `The ruling ${c.answer.id} defeats this issue's premise: ${[...readers, ...(arbitrator ? [arbitrator] : [])].map((x) => x.rationale).join("; ")}`,
    };
    const checked = validateApplicationCapsule(capsule, resolved.ref.kind, resolved.ref.id);
    if ("error" in checked) return { error: checked.error };
    return { kind: `${resolved.ref.kind}.rulingApplied`, subject: resolved.ref.id, data: { capsule } };
  });
  if ("error" in event) return event;
  let materialized = false;
  if (resolved.ref.kind === "finding") {
    try {
      await readCached(root, door.cfg.path, resolved.ref.scope, sidecarIdentity(door.cfg), foldFindings, findingsProjection);
      materialized = true;
    } catch { /* event is durable; sync can rebuild the projection */ }
  } else materialized = await materializeBugs(root, door.cfg);
  return { ok: true as const, application: event.id, issue: resolved.ref, materialized };
}
