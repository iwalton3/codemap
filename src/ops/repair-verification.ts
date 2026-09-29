/**
 * Independent repair verification — the ops. The fold and the evidence bar are in
 * `repair-verification.ts`; who counts as whom is `verifier-boundary.ts`.
 *
 * Two ways to be a verifier (owner, 2026-09-28): a DEDICATED session, whose connection claims the
 * role before anything else and then submits directly; or a SUBAGENT an agent launches with the
 * exact launch prompt `repair_brief` issues, whose submission is held on this machine until the
 * session that launched it records it with `record_repair_verification`, which checks the
 * subagent's own transcript. A subagent the fixer launched counts, at a weaker grade.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requireActor } from "../identity.js";
import { sidecarWriteDoor, resolveSidecar, sidecarIdentity } from "../sidecar-config.js";
import { findingKeyScope } from "../review-target.js";
import { findingScope, foldFindings, isClosed, type SharedFinding } from "../shared-findings.js";
import { findingsProjection } from "../shared-projections.js";
import { readCached } from "../materialize.js";
import { emitEventChecked, readScopeChecked, type LogEvent } from "../eventlog.js";
import { foldRepairRecords } from "../repair-records.js";
import { decisionScope, foldDecisions, answerHasCurrentAuthority, intentCandidates, comparisonRestricts, heldFindings, heldIssues } from "../shared-decisions.js";
import { canonicalIssueKey } from "../decision-issues.js";
import { workEligibility } from "./decision-holds.js";
import { issueClaimHash } from "../ruling-application.js";
import { gitBin } from "../git.js";
import { readRepairVerification } from "../store.js";
import { canonical, isUnverified, readSubagentCall, transcriptDir } from "../transcript.js";
import { saveReaderRequest, readerRequest, holdReaderReceipt, readerReceipts, settleReaderReceipt, type ReaderPurpose } from "../reader-local.js";
import { verifierIdentityKey, type RepairConnection, type VerifierIdentity } from "../verifier-boundary.js";
import {
  foldRepairVerification, repairVerificationHash, repairVerificationDecision, repairVerificationDisagreements,
  type RepairVerificationCapsule, type RepairVerificationRun, type RepairVerificationArbitration,
  type RepairVerificationApplication, type RepairClaimVerdict,
} from "../repair-verification.js";

const runGit = promisify(execFile);
/** A dedicated verifier connection holds one job; asking for another is refused. */
const jobs = new WeakMap<RepairConnection, string>();

export async function repairVerificationRecords(root: string, review: number | string) {
  const cfg = resolveSidecar(root);
  if (!cfg) return { error: "repair verification requires a configured sidecar" };
  const scope = findingScope(findingKeyScope(cfg, review));
  const cached = await readCached(root, cfg.path, scope, sidecarIdentity(cfg), foldFindings, findingsProjection);
  return { scope, status: cached.status, diagnostic: cached.diagnostic, records: readRepairVerification(root, scope) };
}

async function rulingContext(root: string, review: number | string, findings: SharedFinding[], rulingIds: string[]): Promise<{ value: string } | { error: string }> {
  const door = sidecarWriteDoor(root);
  if (!door.cfg) return { error: door.error ?? "sidecar unavailable" };
  const cfg = door.cfg;
  const source = await readScopeChecked(cfg.path, decisionScope(cfg.universe));
  if (source.status !== "complete") return { error: "ruling scope is blocked; no repair authority can be issued" };
  const state = foldDecisions(source.events);
  const refs = findings.map((f) => ({ kind: "finding" as const, universe: cfg.universe, review: String(review), scope: findingScope(findingKeyScope(cfg, review)), id: f.id }));
  const open = new Set(findings.filter((f) => !isClosed(f.state)).map((f) => f.id));
  const openKeys = new Set(refs.filter((ref) => open.has(ref.id)).map(canonicalIssueKey));
  const legacy = heldFindings(state, (id) => open.has(id));
  const typed = heldIssues(state, (key) => openKeys.has(key));
  const candidates = intentCandidates(state);
  const eligibility = refs.map((ref) => {
    const exactLegacy = (legacy.get(ref.id) ?? []).filter((hold) => {
      if (hold.why !== "comparison" || !hold.answers) return true;
      const candidate = candidates.find((c) => c.answers.slice().sort().join("\0") === hold.answers!.slice().sort().join("\0") && c.findings.includes(ref.id));
      return !candidate || comparisonRestricts(state, candidate, ref);
    });
    const held = [...exactLegacy, ...(typed.get(canonicalIssueKey(ref)) ?? [])];
    const finding = findings.find((f) => f.id === ref.id)!;
    return { findingId: ref.id, work: workEligibility({ held }, finding.assignment), ...(held.length ? { assignment: finding.assignment } : {}) };
  });
  const blocked = eligibility.find((e) => !e.work.allowed);
  if (blocked) return { error: `repair verification is held: ${blocked.work.reason ?? blocked.findingId}` };
  for (const id of rulingIds) {
    const pair = state.decisions.flatMap((d) => d.answers.map((a) => ({ d, a }))).find((x) => x.a.id === id);
    if (!pair || !pair.a.verified || pair.a.cancelled || pair.a.withdrawn || pair.a.sourceAnswer || pair.a.resolvedOutBy || pair.a.elsewhere || pair.a.revisionInvalid || pair.d.withdrawn
      || pair.d.withdrawals?.some((w) => w.state === "conflict")) return { error: `ruling ${id} has no current verified authority` };
    for (const ref of refs) {
      if (!answerHasCurrentAuthority(pair.d, pair.a, ref)
        || candidates.some((c) => c.answers.includes(id) && comparisonRestricts(state, c, ref))) return { error: `ruling ${id} is held or does not govern ${ref.id}` };
    }
  }
  // Conservative: any change to the decisions projection invalidates an application.
  return { value: JSON.stringify({ decisions: state, eligibility }) };
}

async function capsule(root: string, review: number | string, events: LogEvent[], input: { sortId: string; evidenceId: string }, orchestrator: VerifierIdentity, applyingRequest?: string): Promise<RepairVerificationCapsule | { error: string }> {
  const repairs = foldRepairRecords(events);
  const sort = repairs.sorts.find((s) => s.input.id === input.sortId);
  const evidence = repairs.evidence.find((e) => e.input.id === input.evidenceId);
  if (!sort?.current || !sort.eligible) return { error: `sort is not currently eligible: ${sort?.holds.join("; ") ?? "missing"}` };
  if (!evidence || evidence.input.sortId !== sort.input.id || evidence.staleReasons.length) return { error: "evidence is missing, stale, or bound to another sort" };
  const findings = foldFindings(events);
  const applied = applyingRequest ? foldRepairVerification(events).applications.filter((a) => a.requestId === applyingRequest) : [];
  const targets: RepairVerificationCapsule["targets"] = [];
  for (const ref of sort.input.coverage) {
    const f = findings.get(ref.findingId);
    if (!f || f.contested?.length || !f.openEpoch || (isClosed(f.state) && !applied.some((a) => a.findingId === f.id && a.openEpoch === f.openEpoch && a.claimHash === issueClaimHash("finding", f)))) return { error: "verification targets must be current uncontested open canonical findings" };
    targets.push({ findingId: f.id, openEpoch: f.openEpoch, claimHash: issueClaimHash("finding", f) });
  }
  const context = await rulingContext(root, review, targets.map((t) => findings.get(t.findingId)!), evidence.input.rulingIds);
  if ("error" in context) return context;
  const cfg = resolveSidecar(root)!;
  const code: RepairVerificationCapsule["code"] = { witnessCommit: evidence.input.witnessCommit, baseCommit: evidence.input.baseCommit,
    fixCommit: evidence.input.fixCommit, diff: "", availability: "available" };
  try {
    for (const sha of [code.witnessCommit, code.baseCommit, code.fixCommit]) await runGit(gitBin(), ["cat-file", "-e", `${sha}^{commit}`], { cwd: root });
    code.diff = (await runGit(gitBin(), ["diff", "--no-color", "--no-ext-diff", "--no-textconv", code.baseCommit, code.fixCommit, "--"], { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout;
  } catch { code.availability = "unknown"; code.reason = "one or more pinned commits or their diff are unavailable in this clone"; }
  return { scope: findingScope(findingKeyScope(cfg, review)), targets, code,
    claims: repairs.claims.filter((c) => targets.some((t) => t.findingId === c.findingId)), sort: structuredClone(sort.input),
    evidence: structuredClone(evidence.input), rulingContext: context.value, orchestrator: structuredClone(orchestrator) };
}

/** Append one verification act, refused unless the fold would accept it exactly as written. */
async function append(root: string, review: number | string, identity: VerifierIdentity,
  produce: (events: LogEvent[]) => Promise<{ kind: string; subject: string; data: Record<string, unknown> } | { error: string }>) {
  const door = sidecarWriteDoor(root);
  if (!door.cfg) return { error: door.error ?? "repair verification requires a configured sidecar" };
  const cfg = door.cfg;
  if (!existsSync(join(cfg.path, ".git"))) return { error: "repair verification requires an existing synced sidecar" };
  const actor = requireActor(root);
  if ("error" in actor) return actor;
  if (actor.principal !== identity.principal) return { error: "this work belongs to another principal" };
  const scope = findingScope(findingKeyScope(cfg, review));
  const emitted = await emitEventChecked(cfg.path, scope, actor, async (events) => {
    if ((await readScopeChecked(cfg.path, scope)).status !== "complete") return { error: "repair scope is blocked" };
    return produce(events);
  }, (events, minted) => {
    const refused = foldRepairVerification(events).rejected.map((r) => ({ id: r.eventId, why: r.reason }));
    if (minted.kind === "finding.repairApplied" && foldFindings(events).get(minted.subject)?.closed?.eventId !== minted.id)
      refused.push({ id: minted.id, why: "canonical finding application refused current claim, epoch or authority" });
    return { refused };
  });
  if ("error" in emitted) return emitted;
  const refreshed = await repairVerificationRecords(root, review);
  if ("error" in refreshed) return refreshed;
  const r = refreshed.records;
  return { ok: true, eventId: emitted.id, id: emitted.subject, status: refreshed.status,
    ...(emitted.kind === "repair.verification-requested" ? { request: r.requests.find((x) => x.id === emitted.subject) }
      : emitted.kind === "repair.verification-recorded" ? { run: r.runs.find((x) => x.id === emitted.subject) }
      : emitted.kind === "repair.verification-arbitrated" ? { arbitration: r.arbitrations.find((x) => x.id === emitted.subject) }
      : { application: r.applications.find((x) => x.findingId === emitted.subject && x.id === (emitted.data as { id: string }).id) }) };
}

export async function requestRepairVerification(root: string, review: number | string, input: { sortId: string; evidenceId: string }, connection: RepairConnection) {
  input = structuredClone(input);
  const identity = connection.identity();
  const id = `rv_${randomUUID()}`;
  return append(root, review, identity, async (events) => {
    const frozen = await capsule(root, review, events, input, identity);
    if ("error" in frozen) return frozen;
    return { kind: "repair.verification-requested", subject: id, data: { id, capsule: frozen, capsuleHash: repairVerificationHash(frozen) } };
  });
}

type Job = { requestId: string; role: "verifier" | "arbitrator"; slot?: 1 | 2 };
const jobKey = (j: Job) => `${j.requestId}#${j.role}${j.slot ?? ""}`;
const purposeOf = (j: Job): ReaderPurpose => (j.role === "verifier" ? "repair-verification" : "repair-arbitration");
/** What a subagent verifier is launched with — exactly this, so the transcript can prove it. */
export const repairLaunchPrompt = (review: number | string, j: Job) =>
  `Run the instructions from codemap MCP tool repair_brief with ${canonical({ review: String(review), requestId: j.requestId, role: j.role, ...(j.slot ? { slot: j.slot } : {}) })}.`;

/**
 * The work open to a verifier on a review, BLIND: request ids and which jobs are open, never a
 * verdict, the evidence or the fixer's conclusions. It is what a claimed verifier session (the
 * `codemap-verify` skill, grant G1) reads first, now that `repair_records` is off its allowlist.
 */
export async function pendingRepairJobs(root: string, review: number | string) {
  const source = await repairVerificationRecords(root, review);
  if ("error" in source) return source;
  if (source.status !== "complete") return { error: "repair scope is blocked" };
  const applied = new Set(source.records.applications.map((a) => a.requestId));
  const jobs = source.records.requests.filter((r) => !applied.has(r.id)).flatMap((r) => {
    const runs = source.records.runs.filter((x) => x.requestId === r.id);
    const arbitrated = source.records.arbitrations.some((x) => x.requestId === r.id);
    const open: Job[] = ([1, 2] as const).filter((slot) => !runs.some((x) => x.slot === slot)).map((slot) => ({ requestId: r.id, role: "verifier" as const, slot }));
    if (runs.length === 2 && !arbitrated && repairVerificationDisagreements(runs[0]!, runs[1]!).length) open.push({ requestId: r.id, role: "arbitrator" });
    return open;
  });
  return { review: String(review), jobs };
}

export async function repairVerificationBrief(root: string, review: number | string, input: Job, connection: RepairConnection) {
  if (!["verifier", "arbitrator"].includes(input.role)) return { error: "unknown repair verification role" };
  if (input.role === "verifier" && ![1, 2].includes(input.slot!)) return { error: "a verifier brief is for one slot, 1 or 2" };
  const job: Job = { requestId: input.requestId, role: input.role, ...(input.role === "verifier" ? { slot: input.slot } : {}) };
  const source = await repairVerificationRecords(root, review);
  if ("error" in source) return source;
  if (source.status !== "complete") return { error: "repair scope is blocked" };
  const request = source.records.requests.find((r) => r.id === job.requestId);
  if (!request) return { error: "unknown repair verification request" };
  const runs = source.records.runs.filter((r) => r.requestId === request.id);
  if (job.role === "arbitrator" && runs.length !== 2) return { error: "arbitration requires both runs" };
  if (job.role === "arbitrator" && !repairVerificationDisagreements(runs[0]!, runs[1]!).length) return { error: "no actual disagreement needs arbitration" };
  if (job.role === "verifier" && runs.some((r) => r.slot === job.slot)) return { error: "that slot already has its run" };
  if (connection.claimed()) {
    const held = jobs.get(connection);
    if (held && held !== jobKey(job)) return { error: "this verifier connection already holds another job" };
    jobs.set(connection, jobKey(job));
  }
  const launch = repairLaunchPrompt(review, job);
  const saved = saveReaderRequest(root, { purpose: purposeOf(job), requestId: jobKey(job) }, launch);
  if ("error" in saved) return saved;
  const c = request.capsule;
  // Blind: no other verdict, and none of the fixer's conclusions — only what they pinned to run.
  const neutral = { scope: c.scope, targets: c.targets, code: c.code,
    claims: c.claims.map(({ id, findingId, text, parentId, witness, asFiled }) => ({ id, findingId, text, parentId, witness, asFiled })),
    sort: { id: c.sort.id, classification: c.sort.classification, kind: c.sort.kind, coverage: c.sort.coverage,
      predicate: c.sort.predicate, sites: c.sort.sites, refutationSubtype: c.sort.refutationSubtype, restsOn: c.sort.restsOn },
    evidence: { id: c.evidence.id, witnessCommit: c.evidence.witnessCommit, baseCommit: c.evidence.baseCommit, fixCommit: c.evidence.fixCommit,
      checks: [...new Set(c.evidence.reproducer.map((x) => x.command))], regression: c.evidence.regression.map(({ command, commit }) => ({ command, commit })),
      patternEnumeration: c.evidence.patternEnumeration, inspected: c.evidence.inspected.map(({ source, commit }) => ({ source, commit })),
      noCheckReason: c.evidence.noCheckReason, rulingIds: c.evidence.rulingIds, attribution: c.evidence.attribution },
    rulingContext: c.rulingContext };
  return { requestId: request.id, capsuleHash: request.capsuleHash, capsule: neutral, launch,
    ...(job.role === "arbitrator" ? { runs } : {}),
    instruction: "Independently assess only the original claims against the pinned code. For \"fixed\", run each "
      + "check yourself: it must FAIL at the witness commit (phase witness) and PASS at the fix commit (phase fix), and "
      + "you record both results. To refute (\"factually-refuted\", or \"invalid\" when the sort says the reviewer "
      + "assumed), first state in `basis` whether and why each pinned check actually tests the claim; if it does not, "
      + "you cannot refute on it. Then run it at the witness commit (the old code) and record it passing. If no check "
      + "can be run, grade \"inspection\" with a no-check reason. A requirement or scope judgment is "
      + `decision-needed. Then call ${job.role === "verifier" ? "repair_verification" : "repair_arbitration"}. `
      + `To hand this job to a subagent instead, launch it with exactly: ${launch}` };
}

/** A claimed connection's own work, or a subagent's held until its launcher records it. */
async function submit(root: string, review: number | string, job: Job, body: Record<string, unknown>, connection: RepairConnection,
  produce: (identity: VerifierIdentity) => (events: LogEvent[]) => Promise<{ kind: string; subject: string; data: Record<string, unknown> } | { error: string }>) {
  if (connection.claimed()) {
    if (jobs.get(connection) !== jobKey(job)) return { error: "read this job's brief (repair_brief) on this connection first" };
    return append(root, review, connection.identity(), produce(connection.identity()));
  }
  if (!readerRequest(root, { purpose: purposeOf(job), requestId: jobKey(job) })) return { error: "no brief was issued for this job; call repair_brief first" };
  const receipt = randomUUID();
  const held = holdReaderReceipt(root, { purpose: purposeOf(job), requestId: jobKey(job) }, receipt, JSON.stringify({ body, session: connection.session }));
  if ("error" in held) return held;
  return { ok: true as const, held: true as const, receipt,
    next: "held on this machine: the session that launched you records it with record_repair_verification, giving your agent id and this call's id" };
}

export async function submitRepairVerification(root: string, review: number | string, input: { requestId: string; slot: 1 | 2; results: RepairClaimVerdict[] }, connection: RepairConnection) {
  input = structuredClone(input);
  const job: Job = { requestId: input.requestId, role: "verifier", slot: input.slot };
  return submit(root, review, job, { results: input.results }, connection, (identity) => async (events) => {
    const request = foldRepairVerification(events).requests.find((r) => r.id === input.requestId);
    if (!request) return { error: "unknown request" };
    const data: RepairVerificationRun = { id: `run_${randomUUID()}`, requestId: request.id, capsuleHash: request.capsuleHash, slot: input.slot, identity, results: input.results };
    return { kind: "repair.verification-recorded", subject: data.id, data: { ...data } };
  });
}

export async function arbitrateRepairVerification(root: string, review: number | string, input: { requestId: string; runIds: [string, string]; addresses: RepairVerificationArbitration["addresses"] }, connection: RepairConnection) {
  input = structuredClone(input);
  const job: Job = { requestId: input.requestId, role: "arbitrator" };
  return submit(root, review, job, { runIds: input.runIds, addresses: input.addresses }, connection, (identity) => async (events) => {
    const request = foldRepairVerification(events).requests.find((r) => r.id === input.requestId);
    if (!request) return { error: "unknown request" };
    const data: RepairVerificationArbitration = { id: `arb_${randomUUID()}`, requestId: request.id, capsuleHash: request.capsuleHash, identity, runIds: input.runIds, addresses: input.addresses };
    return { kind: "repair.verification-arbitrated", subject: data.id, data: { ...data } };
  });
}

/**
 * Record a subagent's held verification or arbitration. Its transcript must show it was launched
 * with exactly the issued prompt, made the submit call with exactly what was held, and got the
 * held receipt back. Recorded as the subagent — `child` — on the connection it submitted on.
 */
export async function recordRepairVerification(root: string, review: number | string,
  input: { requestId: string; role: "verifier" | "arbitrator"; slot?: 1 | 2; receipt: string; agentId: string; callId: string }, dir: string = transcriptDir()) {
  const job: Job = { requestId: input.requestId, role: input.role, ...(input.role === "verifier" ? { slot: input.slot } : {}) };
  const key = { purpose: purposeOf(job), requestId: jobKey(job) };
  const launch = readerRequest(root, key);
  const held = readerReceipts(root, key).find((r) => r.receipt === input.receipt);
  if (!launch || !held || held.state !== "pending") return { error: "no pending held submission with that receipt for this job" };
  const { body, session } = JSON.parse(held.body) as { body: Record<string, unknown>; session: string };
  const call = readSubagentCall(input.agentId, input.callId, job.role === "verifier" ? /(^|__)repair_verification$/ : /(^|__)repair_arbitration$/, dir);
  if (isUnverified(call)) return { pending: true as const, reason: call.unverified };
  const expected = { review: String(review), requestId: job.requestId, ...(job.slot ? { slot: job.slot } : {}), ...body };
  const reason = call.reader.prompt !== launch ? "the subagent was not launched with exactly the issued prompt"
    : canonical({ ...call.input, review: String(call.input?.review) }) !== canonical(expected) ? "the subagent's submission differs from what was held"
    : call.result?.receipt !== input.receipt ? "the subagent's call did not return this receipt" : undefined;
  if (reason) {
    settleReaderReceipt(root, key, input.receipt, "invalid", reason, input.callId);
    return { error: reason };
  }
  const actor = requireActor(root);
  if ("error" in actor) return actor;
  const identity: VerifierIdentity = { principal: actor.principal, harness: "claude-subagent", session, child: input.agentId };
  const recorded = await append(root, review, identity, async (events) => {
    const request = foldRepairVerification(events).requests.find((r) => r.id === job.requestId);
    if (!request) return { error: "unknown request" };
    if (job.role === "verifier") {
      const data: RepairVerificationRun = { id: `run_${randomUUID()}`, requestId: request.id, capsuleHash: request.capsuleHash, slot: job.slot!, identity, results: body.results as RepairClaimVerdict[] };
      return { kind: "repair.verification-recorded", subject: data.id, data: { ...data } };
    }
    const data: RepairVerificationArbitration = { id: `arb_${randomUUID()}`, requestId: request.id, capsuleHash: request.capsuleHash, identity,
      runIds: body.runIds as [string, string], addresses: body.addresses as RepairVerificationArbitration["addresses"] };
    return { kind: "repair.verification-arbitrated", subject: data.id, data: { ...data } };
  });
  if (!("error" in recorded)) settleReaderReceipt(root, key, input.receipt, "recorded", undefined, input.callId);
  return recorded;
}

export async function applyRepairVerification(root: string, review: number | string, input: { requestId: string; findingId: string; reason: string }, connection: RepairConnection) {
  input = structuredClone(input);
  const identity = connection.identity();
  return append(root, review, identity, async (events) => {
    const records = foldRepairVerification(events);
    const request = records.requests.find((r) => r.id === input.requestId);
    if (!request) return { error: "unknown repair verification request" };
    const current = await capsule(root, review, events, { sortId: request.capsule.sort.id, evidenceId: request.capsule.evidence.id }, request.capsule.orchestrator, request.id);
    if ("error" in current) return current;
    if (repairVerificationHash(current) !== request.capsuleHash) return { error: "verification is stale: canonical claim, sort, evidence, code availability or ruling context changed" };
    const target = current.targets.find((t) => t.findingId === input.findingId);
    if (!target) return { error: "finding is outside immutable request" };
    const decision = repairVerificationDecision(records, request.id, target.findingId);
    if (!decision.complete || !["fixed", "factually-refuted", "invalid"].includes(decision.verdict)) return { error: decision.reasons.join("; ") || "no complete independent verdict" };
    if ([...records.runs, ...records.arbitrations].some((x) => x.requestId === request.id && verifierIdentityKey(x.identity) === verifierIdentityKey(identity)))
      return { error: "a verifier cannot apply the verdict it gave" };
    const data: RepairVerificationApplication = { id: `apply_${randomUUID()}`, requestId: request.id, capsuleHash: request.capsuleHash,
      findingId: target.findingId, openEpoch: target.openEpoch, claimHash: target.claimHash, outcome: decision.verdict as "fixed" | "factually-refuted" | "invalid",
      contextHash: repairVerificationHash(current.rulingContext), reason: input.reason, identity };
    return { kind: "finding.repairApplied", subject: target.findingId, data: { ...data } };
  });
}
