/**
 * Independent repair verification — the ops. The fold and the evidence bar are in
 * `repair-verification.ts`; who counts as whom is `verifier-boundary.ts`.
 *
 * Two ways to be a verifier (owner, 2026-09-28): a DEDICATED session, whose connection claims the
 * role before anything else and then submits directly; or a SUBAGENT an agent launches with the
 * exact launch prompt `repair_brief` issues — or with any prompt holding, on a line of its own,
 * the launch line of a `repair_batch_brief` that lists the job (plan 2026-10-19 4.2: reviewers
 * verify; the rest of the prompt is trusted, an accepted gap) — whose submission is held on this
 * machine until the session that launched it records it with `record_repair_verification`, which
 * checks the subagent's own transcript. Whoever launched it, there is no second grade (R2,
 * docs/repair-verification.md).
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requireActor, resolvePrincipal } from "../identity.js";
import { sidecarWriteDoor, resolveSidecar, sidecarIdentity } from "../sidecar-config.js";
import { findingKeyScope, topicOf } from "../review-target.js";
import { findingScope, foldFindings, isClosed, isStandingBehind, type SharedFinding } from "../shared-findings.js";
import { cachedBugs } from "../bugs-publish.js";
import { filedFindings, leftoverId } from "../leftover-findings.js";
import { foldTopicsReport, topicsScope } from "../shared-topics.js";
import { readAnchorStore } from "../store.js";
import { bodyHashAtCommit } from "../snapshots.js";
import { findingsProjection } from "../shared-projections.js";
import { readCached } from "../materialize.js";
import { readScopeChecked, type LogEvent } from "../eventlog.js";
import { emitEventChecked } from "../write.js";
import { foldRepairRecords, type RepairFindingMap } from "../repair-records.js";
import { readDecisionLog, foldDecisions, answerHasCurrentAuthority, answerRestricted, comparisonHoldApplies, intentCandidates, heldFindings, heldIssues } from "../shared-decisions.js";
import { canonicalIssueKey } from "../decision-issues.js";
import { decisionsAbsence, workEligibility } from "./decision-holds.js";
import { issueClaimHash } from "../ruling-application.js";
import { gitBin } from "../git.js";
import { calledBefore, canonical, isUnverified, readReceiptCall, transcriptDir } from "../transcript.js";
import { saveReaderRequest, readerRequest, readerRequests, holdReaderReceipt, readerReceipts, settleReaderReceipt, type ReaderPurpose } from "../reader-local.js";
import { verifierIdentityKey, type RepairConnection, type VerifierIdentity } from "../verifier-boundary.js";
import {
  foldRepairVerification, repairVerificationHash, repairVerificationDecision, repairVerificationDisagreements,
  isRepairVerificationState, emptyRepairVerificationState, resultError, slotsFor, leftoversOf, derivesCheck, derivedCheckError, type RepairLeftover,
  type RepairVerificationCapsule, type RepairVerificationRun, type RepairVerificationArbitration,
  type RepairVerificationApplication, type RepairClaimVerdict, type RepairVerificationRecords,
} from "../repair-verification.js";

const runGit = promisify(execFile);
/** A dedicated verifier connection holds one job, or one batch's jobs; asking for others is refused. */
const jobs = new WeakMap<RepairConnection, string[]>();
/** This connection as it acts in `root`'s universe (F36). */
const identityIn = (connection: RepairConnection, root: string): VerifierIdentity => connection.identity(resolvePrincipal(root) ?? connection.principal);

export async function repairVerificationRecords(root: string, review: number | string) {
  const cfg = resolveSidecar(root);
  if (!cfg) return { error: "repair verification requires a configured sidecar" };
  const scope = findingScope(findingKeyScope(cfg, review));
  const cached = await readCached(root, cfg.path, scope, sidecarIdentity(cfg), foldFindings, findingsProjection);
  // The value readCached SERVED, never a separate DB read (B5: F31): when it declines to write —
  // a missing or re-pointed sidecar — there is no row, and the read threw.
  const served = (cached.value as RepairFindingMap<SharedFinding>).repairVerification;
  return { scope, status: cached.status, diagnostic: cached.diagnostic,
    records: isRepairVerificationState(served) ? served : emptyRepairVerificationState() };
}

async function rulingContext(root: string, review: number | string, findings: SharedFinding[], rulingIds: string[]): Promise<{ value: string } | { error: string }> {
  const door = sidecarWriteDoor(root);
  if (!door.cfg) return { error: door.error ?? "sidecar unavailable" };
  const cfg = door.cfg;
  const absent = decisionsAbsence(root, cfg);
  if (absent) return { error: `ruling scope is blocked; no repair authority can be issued: ${absent.detail}` };
  const source = await readDecisionLog(cfg.path);
  if (source.status !== "complete") return { error: "ruling scope is blocked; no repair authority can be issued" };
  const state = foldDecisions(source.events);
  const refs = findings.map((f) => ({ kind: "finding" as const, universe: cfg.universe, review: String(review), scope: findingScope(findingKeyScope(cfg, review)), id: f.id }));
  const open = new Set(findings.filter((f) => !isClosed(f.state)).map((f) => f.id));
  const openKeys = new Set(refs.filter((ref) => open.has(ref.id)).map(canonicalIssueKey));
  const legacy = heldFindings(state, cfg.universe, (id) => open.has(id));
  const typed = heldIssues(state, (key) => openKeys.has(key));
  const candidates = intentCandidates(state);
  const eligibility = refs.map((ref) => {
    const exactLegacy = (legacy.get(ref.id) ?? []).filter((hold) => comparisonHoldApplies(state, hold, ref, candidates));
    const held = [...exactLegacy, ...(typed.get(canonicalIssueKey(ref)) ?? [])];
    const finding = findings.find((f) => f.id === ref.id)!;
    return { findingId: ref.id, work: workEligibility({ held }, finding.assignment), ...(held.length ? { assignment: finding.assignment } : {}) };
  });
  const blocked = eligibility.find((e) => !e.work.allowed);
  if (blocked) return { error: `repair verification is held: ${blocked.work.reason ?? blocked.findingId}` };
  for (const id of rulingIds) {
    const pair = state.decisions.flatMap((d) => d.answers.map((a) => ({ d, a }))).find((x) => x.a.id === id);
    if (!pair || !pair.a.verified || pair.a.cancelled || pair.a.withdrawn || pair.a.sourceAnswer || pair.a.resolvedOutBy || pair.a.elsewhere || pair.a.revisionInvalid || pair.d.withdrawn) return { error: `ruling ${id} has no current verified authority` };
    for (const ref of refs) {
      if (!answerHasCurrentAuthority(pair.d, pair.a, ref)
        || answerRestricted(state, id, ref, candidates)) return { error: `ruling ${id} is held or does not govern ${ref.id}` };
    }
  }
  // Only the rulings this repair CITES (D4: F19, F46). The whole decisions state made any decision
  // anywhere in the universe stale every verification. Holds and eligibility are left out on
  // purpose: `capsule` re-runs this at application and refuses on a new hold above, so freezing
  // them bought nothing but staleness. Do not put them back.
  return { value: JSON.stringify({ rulings: citedRulings(state, rulingIds) }) };
}

/**
 * What a capsule freezes about each ruling it cites: the exact answer to the exact question, and
 * their text — the verifier judges whether the ruling decides the claim, so it must read it (I5).
 */
export function citedRulings(state: { decisions: { id: string; hash: string; payload: { question: string }; answers: { id: string; responseHash: string; words: string }[] }[] }, ids: readonly string[]) {
  return [...ids].sort().map((id) => {
    const d = state.decisions.find((x) => x.answers.some((a) => a.id === id));
    const a = d?.answers.find((x) => x.id === id);
    return { id, decision: d?.id ?? null, questionHash: d?.hash ?? null, responseHash: a?.responseHash ?? null,
      question: d?.payload.question ?? null, words: a?.words ?? null };
  });
}

/**
 * What the capsule freezes of the code (B12: F23, F49): the commit pair and the touched blob ids,
 * never diff bytes — those depend on the clone's git config and object count (abbreviation), so
 * a capsule made on one clone could never be applied on another.
 */
async function touchedBlobs(root: string, base: string, fix: string): Promise<{ path: string; before: string; after: string }[]> {
  const out = (await runGit(gitBin(), ["diff", "--raw", "--no-abbrev", "-z", "--no-renames", base, fix, "--"], { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout;
  const parts = out.split("\0").filter((x) => x.length);
  const touched: { path: string; before: string; after: string }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [, , before, after] = parts[i]!.replace(/^:/, "").split(" ");
    touched.push({ path: parts[i + 1]!, before: before!, after: after! });
  }
  return touched.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
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
    if (!f || !f.openEpoch || (isClosed(f.state) && !applied.some((a) => a.findingId === f.id && a.openEpoch === f.openEpoch && a.claimHash === issueClaimHash("finding", f)))) return { error: "verification targets must be current open canonical findings" };
    targets.push({ findingId: f.id, openEpoch: f.openEpoch, claimHash: issueClaimHash("finding", f) });
  }
  const context = await rulingContext(root, review, targets.map((t) => findings.get(t.findingId)!), evidence.input.rulingIds);
  if ("error" in context) return context;
  const cfg = resolveSidecar(root)!;
  const code: RepairVerificationCapsule["code"] = { witnessCommit: evidence.input.witnessCommit, baseCommit: evidence.input.baseCommit,
    fixCommit: evidence.input.fixCommit, touched: [], availability: "available" };
  // Refused rather than frozen as "unknown" (owner, 2026-10-06, A5): such a request could never
  // be applied. Not a verdict on the finding. `availability` stays for requests made before.
  for (const sha of [code.witnessCommit, code.baseCommit, code.fixCommit]) {
    try { await runGit(gitBin(), ["cat-file", "-e", `${sha}^{commit}`], { cwd: root }); }
    catch { return { error: `pinned commit ${sha} is not in this clone: fetch it, then request again` }; }
  }
  try { code.touched = await touchedBlobs(root, code.baseCommit, code.fixCommit); }
  catch { return { error: "the diff between the pinned base and fix commits cannot be read in this clone" }; }
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
  // The verification rules are the findings door's, so replay applies them too.
  const emitted = await emitEventChecked(cfg.path, scope, actor, async (events) => {
    if ((await readScopeChecked(cfg.path, scope)).status !== "complete") return { error: "repair scope is blocked" };
    return produce(events);
  });
  if ("error" in emitted) return emitted;
  const refreshed = await repairVerificationRecords(root, review);
  if ("error" in refreshed) return refreshed;
  const r = refreshed.records;
  return { ok: true, eventId: emitted.id, id: emitted.subject, status: refreshed.status,
    // A request's capsule is the whole frozen review; its hash is what binds later acts (F7).
    ...(emitted.kind === "repair.verification-requested" ? { capsuleHash: r.requests.find((x) => x.id === emitted.subject)?.capsuleHash }
      : emitted.kind === "repair.verification-recorded" ? { run: r.runs.find((x) => x.id === emitted.subject) }
      : emitted.kind === "repair.verification-arbitrated" ? { arbitration: r.arbitrations.find((x) => x.id === emitted.subject) }
      : { application: r.applications.find((x) => x.findingId === emitted.subject && x.id === (emitted.data as { id: string }).id) }) };
}

export async function requestRepairVerification(root: string, review: number | string, input: { sortId: string; evidenceId: string }, connection: RepairConnection) {
  input = structuredClone(input);
  const identity = identityIn(connection, root);
  const id = `rv_${randomUUID()}`;
  let stakes: RepairVerificationCapsule["sort"]["stakes"] | "unset" = "unset";
  const made = await append(root, review, identity, async (events) => {
    const frozen = await capsule(root, review, events, input, identity);
    if ("error" in frozen) return frozen;
    stakes = frozen.sort.stakes;
    return { kind: "repair.verification-requested", subject: id, data: { id, capsule: frozen, capsuleHash: repairVerificationHash(frozen) } };
  });
  // Answered, not refused: the backlog's sorts predate stakes (owner: "support both modalities").
  return "ok" in made && stakes === undefined ? { ...made, note: "this sort has no stakes, so it reads as high and needs two verifier slots. If it is low, set that first with a dual-sorted correction by fresh sorters, then request again." } : made;
}

type Job = { requestId: string; role: "verifier" | "arbitrator"; slot?: 1 | 2 };
const jobKey = (j: Job) => `${j.requestId}#${j.role}${j.slot ?? ""}`;
const purposeOf = (j: Job): ReaderPurpose => (j.role === "verifier" ? "repair-verification" : "repair-arbitration");
/** What a subagent verifier is launched with — exactly this, so the transcript can prove it. */
export const repairLaunchPrompt = (review: number | string, j: Job) =>
  `Run the instructions from codemap MCP tool repair_brief with ${canonical({ review: String(review), requestId: j.requestId, role: j.role, ...(j.slot ? { slot: j.slot } : {}) })}.`;

/** One subagent's share of a round's verification: every open job of one role and slot (4.1). */
interface Batch { review: string; role: "verifier" | "arbitrator"; slot?: 1 | 2; jobs: Job[] }
const BATCH = "batch:";
/** The line a batch subagent's launch prompt holds, whole and on a line of its own (4.2). */
export const repairBatchLaunchLine = (review: number | string, batch: string) =>
  `Run the instructions from codemap MCP tool repair_batch_brief with ${canonical({ review: String(review), batch })}.`;
function savedBatch(root: string, id: string): Batch | undefined {
  for (const purpose of ["repair-verification", "repair-arbitration"] as const) {
    const body = readerRequest(root, { purpose, requestId: BATCH + id });
    if (body) return JSON.parse(body) as Batch;
  }
}
/** Launched with exactly this job's prompt, or with a prompt holding the launch line of a batch listing it. */
function launchedFor(root: string, review: number | string, job: Job, launch: string, prompt: string): boolean {
  if (prompt === launch) return true;
  const lines = new Set(prompt.split("\n").map((l) => l.trim()));
  return readerRequests(root, purposeOf(job)).some((r) => r.requestId.startsWith(BATCH)
    && (JSON.parse(r.body) as Batch).jobs.some((j) => jobKey(j) === jobKey(job))
    && lines.has(repairBatchLaunchLine(review, r.requestId.slice(BATCH.length))));
}

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
    const open: Job[] = slotsFor(r.capsule).filter((slot) => !runs.some((x) => x.slot === slot)).map((slot) => ({ requestId: r.id, role: "verifier" as const, slot }));
    if (runs.length === 2 && !arbitrated && repairVerificationDisagreements(runs[0]!, runs[1]!).length) open.push({ requestId: r.id, role: "arbitrator" });
    return open;
  });
  return { review: String(review), jobs };
}

export async function repairVerificationBrief(root: string, review: number | string, input: Job & { derived?: string }, connection: RepairConnection) {
  if (!["verifier", "arbitrator"].includes(input.role)) return { error: "unknown repair verification role" };
  if (input.role === "verifier" && ![1, 2].includes(input.slot!)) return { error: "a verifier brief is for one slot, 1 or 2" };
  const job: Job = { requestId: input.requestId, role: input.role, ...(input.role === "verifier" ? { slot: input.slot } : {}) };
  const source = await repairVerificationRecords(root, review);
  if ("error" in source) return source;
  if (source.status !== "complete") return { error: "repair scope is blocked" };
  const brief = jobBrief(root, source.records, job, connection, input.derived);
  if ("error" in brief) return brief;
  if (connection.claimed()) {
    const held = jobs.get(connection);
    if (held && (held.length !== 1 || held[0] !== jobKey(job))) return { error: "this verifier connection already holds another job" };
    jobs.set(connection, [jobKey(job)]);
  }
  const launch = repairLaunchPrompt(review, job);
  const saved = saveReaderRequest(root, { purpose: purposeOf(job), requestId: jobKey(job) }, launch);
  if ("error" in saved) return saved;
  return { ...brief, launch, instruction: `${brief.instruction} To hand this job to a subagent instead, launch it with exactly: ${launch}` };
}

/**
 * One brief for a round's verification (plan 2026-10-19 4.1): every open job of one role and slot
 * on the review — or of the `requests` named — each entry exactly the brief `repair_brief` gives.
 * A low-stakes request has no slot 2, so it appears in slot 1's batch only. Results are submitted
 * per request, as from a single brief, so every per-request rule of the fold is unchanged. Called
 * with `batch` it re-reads an issued batch: what the subagent launched with its line does.
 */
export async function repairBatchBrief(root: string, review: number | string,
  input: { role?: "verifier" | "arbitrator"; slot?: 1 | 2; requests?: string[]; batch?: string; derived?: Record<string, string> }, connection: RepairConnection) {
  const source = await repairVerificationRecords(root, review);
  if ("error" in source) return source;
  if (source.status !== "complete") return { error: "repair scope is blocked" };
  let batch: Batch, id: string;
  if (input?.batch !== undefined) {
    const saved = savedBatch(root, input.batch);
    if (!saved || saved.review !== String(review)) return { error: `no batch ${String(input.batch)} was issued on review ${String(review)}` };
    batch = saved; id = input.batch;
  } else {
    if (input?.role !== "verifier" && input?.role !== "arbitrator") return { error: "a batch is for verifiers (with slot 1 or 2) or the arbitrator" };
    if (input.role === "verifier" && input.slot !== 1 && input.slot !== 2) return { error: "a verifier batch is for one slot, 1 or 2" };
    const pending = await pendingRepairJobs(root, review);
    if (!("jobs" in pending)) return { error: pending.error ?? "repair scope is unreadable" };
    const open = pending.jobs.filter((j) => j.role === input.role && (input.role === "arbitrator" || j.slot === input.slot)
      && (!input.requests || input.requests.includes(j.requestId)));
    if (!open.length) return { error: input.role === "verifier" ? `no request on review ${String(review)} has an open slot ${input.slot}` : "no request needs arbitration" };
    batch = { review: String(review), role: input.role, ...(input.role === "verifier" ? { slot: input.slot } : {}),
      jobs: [...open].sort((a, b) => (a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0)) };
    id = `rb_${repairVerificationHash(batch).slice(0, 24)}`;
    const saved = saveReaderRequest(root, { purpose: purposeOf(batch.jobs[0]!), requestId: BATCH + id }, JSON.stringify(batch));
    if ("error" in saved) return saved;
  }
  const keys = batch.jobs.map(jobKey);
  if (connection.claimed()) {
    const held = jobs.get(connection);
    if (held && held.join("\n") !== keys.join("\n")) return { error: "this verifier connection already holds another job" };
    jobs.set(connection, keys);
  }
  const entries = [];
  for (const job of batch.jobs) {
    // Each job's own request too, so its submission is held and recorded exactly as a single brief's.
    const saved = saveReaderRequest(root, { purpose: purposeOf(job), requestId: jobKey(job) }, repairLaunchPrompt(review, job));
    if ("error" in saved) return saved;
    const brief = jobBrief(root, source.records, job, connection, input?.derived?.[job.requestId]);
    entries.push("error" in brief ? { requestId: job.requestId, skip: brief.error } : brief);
  }
  const launch = repairBatchLaunchLine(review, id);
  return { batch: id, role: batch.role, ...(batch.slot ? { slot: batch.slot } : {}), launch, entries,
    instruction: `Do each entry's instruction, on its own request: one ${batch.role === "verifier" ? `repair_verification per request, slot ${batch.slot}` : "repair_arbitration per request"}. An entry with \`skip\` needs nothing from you. `
      + "An entry at `stage: derive` is two steps: submit its derived check, then read this batch again for the rest, passing each receipt it returned as `derived: { <requestId>: <receipt> }`. "
      + `To hand this batch to a subagent, put this line, whole and on a line of its own, in its launch prompt: ${launch}` };
}

/**
 * Every universe's batch for one role and slot of a review that spans repos (F16): one call, so
 * the coordinator can put every launch line in ONE subagent's prompt — one verifier per slot for
 * the cluster, not one per universe. A universe with no open job for that slot is left out.
 * Batches are still per universe; it is the subagent that spans them.
 */
export async function workspaceRepairBatchBriefs(universes: { id: string; root: string }[], review: number | string,
  input: { role?: "verifier" | "arbitrator"; slot?: 1 | 2 }, connection: RepairConnection,
  locked: <T>(root: string, fn: () => Promise<T>) => Promise<T> = (_root, fn) => fn()) {
  if (connection.claimed()) return { error: "a dedicated verifier connection holds one batch; the workspace form is for the session that launches verifiers" };
  const batches = [], skipped = [];
  for (const u of universes) {
    const b = await locked(u.root, () => repairBatchBrief(u.root, review, { role: input?.role, slot: input?.slot }, connection));
    if ("batch" in b) batches.push({ universe: u.id, ...b });
    else skipped.push({ universe: u.id, reason: String(b.error) });
  }
  if (!batches.length) return { error: `no universe has an open ${input?.role === "arbitrator" ? "arbitration" : `slot ${input?.slot}`} on review ${String(review)}`, skipped };
  const lines = batches.map((b) => b.launch);
  return { review: String(review), batches, skipped, launch: lines.join("\n"),
    instruction: `Launch ONE subagent for this ${input?.role === "arbitrator" ? "arbitration" : `slot`} with every line of \`launch\`, each whole and on a line of its own, in its prompt; `
      + "it does each batch's entries, passing that batch's `universe` on its calls. Launch slot 1 and slot 2 as different subagents." };
}

/**
 * Slot 2's derived check (F18), local, under the job's own key so a launcher's routing finds it (F6).
 * A claimed connection is the verifier, so its check is saved once per connection and the op
 * enforces the order. An unclaimed connection is shared by a launcher and every subagent it starts,
 * so there the check is HELD like a verdict, any number per job: only its receipt, which the record
 * ties to one agent's transcript, says who derived it and when (C2).
 */
type Derived = { command: string; rationale: string; receipt?: string };
const deriveKey = (job: Job) => ({ purpose: purposeOf(job), requestId: `${jobKey(job)}:derive` });
const ownDerivedKey = (job: Job, session: string) => ({ purpose: purposeOf(job), requestId: `${jobKey(job)}:derived:${session}` });
function derivedFor(root: string, job: Job, connection: RepairConnection, receipt: unknown): Derived | undefined {
  if (connection.claimed()) {
    const body = readerRequest(root, ownDerivedKey(job, connection.session));
    return body ? JSON.parse(body) as Derived : undefined;
  }
  const held = typeof receipt === "string" ? readerReceipts(root, deriveKey(job)).find((r) => r.receipt === receipt && r.state !== "cancelled") : undefined;
  if (!held) return undefined;
  const { command, rationale } = JSON.parse(held.body) as Derived;
  return { command, rationale, receipt: held.receipt };
}
/** A brief result (one job's, or a batch's entries) that carried this request's evidence. */
const carriesEvidence = (requestId: string) => (v: unknown): boolean => typeof v === "string"
  ? v.includes(requestId) && /\\*"evidence\\*"\s*:/.test(v)
  : !!v && typeof v === "object" && (((v as any).requestId === requestId && (v as any).capsule?.evidence !== undefined)
    || Object.values(v as object).some((x) => carriesEvidence(requestId)(x)));

/** One job's blind brief: what the verifier reads, and nothing it may not. */
function jobBrief(root: string, records: RepairVerificationRecords, job: Job, connection: RepairConnection, derivedReceipt?: unknown) {
  const request = records.requests.find((r) => r.id === job.requestId);
  if (!request) return { error: "unknown repair verification request" };
  const runs = records.runs.filter((r) => r.requestId === request.id);
  if (job.role === "arbitrator" && runs.length !== 2) return { error: "arbitration requires both runs" };
  if (job.role === "arbitrator" && !repairVerificationDisagreements(runs[0]!, runs[1]!).length) return { error: "no actual disagreement needs arbitration" };
  if (job.role === "verifier" && !slotsFor(request.capsule).includes(job.slot!)) return { error: `a low-stakes request has one verifier: slot 1` };
  if (job.role === "verifier" && runs.some((r) => r.slot === job.slot)) return { error: "that slot already has its run" };
  const c = request.capsule;
  const derives = job.role === "verifier" && derivesCheck(c, job.slot!);
  const derived = derives ? derivedFor(root, job, connection, derivedReceipt) : undefined;
  if (derives && !derived) {
    if (!connection.claimed()) {
      const saved = saveReaderRequest(root, deriveKey(job), jobKey(job));
      if ("error" in saved) return saved;
    }
    // F18, step 1 of 2: the claim and the code, and nothing of the fixer's — not even what it pinned.
    return { requestId: request.id, capsuleHash: request.capsuleHash, stage: "derive" as const,
      capsule: { scope: c.scope, targets: c.targets, code: { witnessCommit: c.code.witnessCommit, baseCommit: c.code.baseCommit, fixCommit: c.code.fixCommit },
        claims: c.claims.map(({ id, findingId, text, parentId, witness, asFiled }) => ({ id, findingId, text, parentId, witness, asFiled })),
        sort: { id: c.sort.id, classification: c.sort.classification, kind: c.sort.kind, coverage: c.sort.coverage, predicate: c.sort.predicate, sites: c.sort.sites } },
      instruction: "Step 1 of 2 — you are slot 2 of a high-stakes request, the second opinion. From the claims and the code at the pinned commits alone, "
        + "write the check YOU would run to test each claim: a command that fails at the witness commit if the claim is true and passes at the fix if it was fixed. "
        + "You are not shown the fixer's evidence yet, on purpose. Call repair_derived_check with this requestId, slot 2, the command and why it tests the claims; "
        + "then read this brief again — it will carry the fixer's evidence and the rest of the instructions. If repair_derived_check returns a `receipt`, "
        + "pass it as `derived` when you read the brief again (in a batch: `derived: { <requestId>: <receipt> }`); without it you are given this step again." };
  }
  // Blind: no other verdict, and none of the fixer's conclusions — only what they pinned to run.
  const neutral = { scope: c.scope, targets: c.targets, code: c.code,
    claims: c.claims.map(({ id, findingId, text, parentId, witness, asFiled }) => ({ id, findingId, text, parentId, witness, asFiled })),
    sort: { id: c.sort.id, classification: c.sort.classification, kind: c.sort.kind, coverage: c.sort.coverage,
      predicate: c.sort.predicate, sites: c.sort.sites, refutationSubtype: c.sort.refutationSubtype, restsOn: c.sort.restsOn,
      ...(c.sort.testGap ? { testGap: true } : {}),
      ...(c.sort.ruling ? { ruling: c.sort.ruling } : {}), ...(c.sort.release ? { release: { rulings: c.sort.release.rulings } } : {}) },
    evidence: { id: c.evidence.id, witnessCommit: c.evidence.witnessCommit, baseCommit: c.evidence.baseCommit, fixCommit: c.evidence.fixCommit,
      checks: [...new Set(c.evidence.reproducer.map((x) => x.command))], regression: c.evidence.regression.map(({ command, commit }) => ({ command, commit })),
      inspected: c.evidence.inspected.map(({ source, commit }) => ({ source, commit })),
      noCheckReason: c.evidence.noCheckReason, rulingIds: c.evidence.rulingIds, attribution: c.evidence.attribution,
      ...(c.evidence.siteBugs?.length ? { siteBugs: c.evidence.siteBugs } : {}),
      ...(c.evidence.reproducer.some((x) => x.phase === "mutation")
        ? { mutations: c.evidence.reproducer.filter((x) => x.phase === "mutation").map(({ command, mutation }) => ({ command, ...mutation })) } : {}) },
    rulingContext: c.rulingContext };
  return { requestId: request.id, capsuleHash: request.capsuleHash, capsule: neutral,
    ...(job.role === "arbitrator" ? { runs } : {}), ...(derived ? { stage: "verify" as const, derivedCheck: derived } : {}),
    instruction: (derived ? `Step 2 of 2. Run your derived check (\`${derived.command}\`) at the witness and at the fix as well, and submit it as \`derivedCheck: { command, executions${derived.receipt ? ", receipt" : ""} }\` beside your results. ` : "")
      + "Independently assess only the original claims against the pinned code. Where the sort cites a `ruling`, or was "
      + "released on rulings (`release.rulings`; their text is in `rulingContext`), first judge whether those rulings decide the claim as it is now classified; if they "
      + "do not, the verdict is decision-needed. Work in a scratch worktree "
      + "at the pinned commits (`git worktree add <scratch> <commit>`), never in anyone's live checkout — a fresh, clean one for each "
      + "commit, so nothing one run wrote (a test file, a build output) is in the tree another runs in. For \"fixed\", run each "
      + "check yourself: it must FAIL at the witness commit (phase witness) and PASS at the fix commit (phase fix), and "
      + "you record both results. A witness failure counts only as the claim's failure: a check that finds no test to run "
      + "(\"No tests found\", a spec file absent at the witness) is not a red. Where the sort is marked `testGap` (its sorters read "
      + "the claims as a missing test), a mutation run stands in for that red: apply the named change at the fix commit, run the command and "
      + "record it failing (phase mutation, with `mutation` naming the site and change) beside its pass at the fix without the "
      + "change, and say in `reason` whether that mutation tests this claim. To refute (\"factually-refuted\", or \"invalid\" when the sort says the reviewer "
      + "assumed), first state in `basis` whether and why each pinned check actually tests the claim; if it does not, "
      + "you cannot refute on it. Then run it at the witness commit (the old code) and record it passing. If no check "
      + "can be run, grade \"inspection\" with a no-check reason. For a pattern, give every sorted site a "
      + "disposition: fixed, or — for a site the evidence lists under `siteBugs` — filed, with that bug id. "
      + "A requirement or scope judgment is "
      + `decision-needed. Then call ${job.role === "verifier" ? "repair_verification" : "repair_arbitration"}.` };
}

/**
 * F18, between the two steps of slot 2's brief on a high-stakes request: the check its verifier
 * derived from the claim alone, which the run must submit. On a claimed connection it is saved once,
 * before the evidence is served; on an unclaimed one it is held, and the record checks from the
 * subagent's transcript that the same agent derived it before it read the evidence (C2). The fold
 * cannot see either (an accepted gap, docs/repair-verification.md).
 */
export async function submitDerivedCheck(root: string, review: number | string, input: { requestId: string; slot: 2; command: string; rationale: string }, connection: RepairConnection) {
  const job: Job = { requestId: input?.requestId, role: "verifier", slot: input?.slot };
  const source = await repairVerificationRecords(root, review);
  if ("error" in source) return source;
  const request = source.records.requests.find((r) => r.id === job.requestId);
  if (!request) return { error: "unknown repair verification request" };
  if (!derivesCheck(request.capsule, job.slot!)) return { error: "only slot 2 of a high-stakes request derives its own check" };
  if (source.records.runs.some((r) => r.requestId === request.id && r.slot === 2)) return { error: "that slot already has its run" };
  if (typeof input.command !== "string" || !input.command.trim() || typeof input.rationale !== "string" || !input.rationale.trim())
    return { error: "a derived check is a command and why it tests the claims" };
  if (connection.claimed()) {
    if (!jobs.get(connection)?.includes(jobKey(job))) return { error: "read this job's brief (repair_brief, or repair_batch_brief) on this connection first" };
    const saved = saveReaderRequest(root, ownDerivedKey(job, connection.session), JSON.stringify({ command: input.command, rationale: input.rationale }));
    if ("error" in saved) return { error: "a derived check is written once, before the evidence: this job already has one" };
    return { ok: true as const, next: "read your brief again (repair_brief, or repair_batch_brief with your batch): it now carries the fixer's evidence" };
  }
  if (!readerRequest(root, { purpose: purposeOf(job), requestId: jobKey(job) }) || !readerRequest(root, deriveKey(job)))
    return { error: "no brief was issued for this job; call repair_brief first" };
  const receipt = randomUUID();
  const held = holdReaderReceipt(root, deriveKey(job), receipt, JSON.stringify({ command: input.command, rationale: input.rationale, session: connection.session }));
  if ("error" in held) return held;
  return { ok: true as const, held: true as const, receipt,
    next: `read your brief again with \`derived: "${receipt}"\` (repair_brief), or \`derived: { "${job.requestId}": "${receipt}" }\` (repair_batch_brief with your batch): it then carries the fixer's evidence. Submit this receipt as \`derivedCheck.receipt\` with your results.` };
}

/**
 * Each site a result files as a bug (plan 3.4): the bug exists, is still open, came from this
 * finding with its filer and confirmation (3.5), and cites a symbol in the site's own file.
 * Checked by the op at submission and again at application; the fold sees only that the field
 * is there (R4's accepted gap — the bug lives in another scope).
 */
export async function siteBugRefusal(root: string, events: LogEvent[], results: Pick<RepairClaimVerdict, "findingId" | "sites">[]): Promise<string | undefined> {
  const filed = (Array.isArray(results) ? results : []).flatMap((r) => (Array.isArray(r?.sites) ? r.sites : [])
    .filter((s) => s?.bug !== undefined).map((s) => ({ findingId: r.findingId, site: s.site, bug: s.bug! })));
  if (!filed.length) return undefined;
  const cfg = resolveSidecar(root);
  if (!cfg) return "a site bug needs this universe's sidecar";
  const bugs = (await cachedBugs(root, cfg)).value;
  const findings = foldFindings(events);
  const files = new Map((await readAnchorStore(root)).anchors.map((a) => [a.id, a.file]));
  for (const { findingId, site, bug: id } of filed) {
    const bug = bugs.get(id), f = findings.get(findingId);
    if (!bug) return `site ${site}: no bug ${id}`;
    if (isClosed(bug.state)) return `site ${site}: bug ${id} is closed, and a site bug must still be open at closure`;
    if (!f || bug.from?.finding !== findingId || bug.author.principal !== f.author?.principal)
      return `site ${site}: bug ${id} was not filed from ${findingId} with its filer (file_site_bug)`;
    const behind = f.corroboration.filter((c) => isStandingBehind(c.verdict));
    if (!behind.every((c) => bug.corroboration.some((x) => x.actor.principal === c.actor.principal && x.verdict === c.verdict)))
      return `site ${site}: bug ${id} does not carry ${findingId}'s confirmation`;
    if (!bug.anchors.some((a) => !a.removed && files.get(a.anchorId) === site)) return `site ${site}: bug ${id} cites no symbol in ${site}`;
  }
  return undefined;
}

/** A claimed connection's own work, or a subagent's held until its launcher records it. */
async function submit(root: string, review: number | string, job: Job, body: Record<string, unknown>, connection: RepairConnection,
  produce: (identity: VerifierIdentity) => (events: LogEvent[]) => Promise<{ kind: string; subject: string; data: Record<string, unknown> } | { error: string }>) {
  if (connection.claimed()) {
    if (!jobs.get(connection)?.includes(jobKey(job))) return { error: "read this job's brief (repair_brief, or repair_batch_brief) on this connection first" };
    return append(root, review, identityIn(connection, root), produce(identityIn(connection, root)));
  }
  if (!readerRequest(root, { purpose: purposeOf(job), requestId: jobKey(job) })) return { error: "no brief was issued for this job; call repair_brief first" };
  const receipt = randomUUID();
  const held = holdReaderReceipt(root, { purpose: purposeOf(job), requestId: jobKey(job) }, receipt, JSON.stringify({ body, session: connection.session }));
  if ("error" in held) return held;
  return { ok: true as const, held: true as const, receipt,
    next: "held on this machine: the session that launched you records it with record_repair_verification, giving your agent id and this call's id" };
}

export async function submitRepairVerification(root: string, review: number | string, input: { requestId: string; slot: 1 | 2; results: RepairClaimVerdict[]; leftovers?: RepairLeftover[];
  derivedCheck?: NonNullable<RepairVerificationRun["derivedCheck"]> & { receipt?: string } }, connection: RepairConnection) {
  input = structuredClone(input);
  // Validated BEFORE holding (G8: F37): a subagent otherwise got a held receipt for results the
  // fold would reject, and learned it only when its launcher tried to record them.
  if (!Array.isArray(input?.results) || !input.results.length) return { error: "results: one verdict per claim you checked" };
  const source = await repairVerificationRecords(root, review);
  if ("error" in source) return source;
  const request = source.records.requests.find((r) => r.id === input.requestId);
  if (!request) return { error: "unknown repair verification request" };
  const invalid = input.results.map((r) => resultError(r, request.capsule)).find(Boolean);
  if (invalid) return { error: invalid };
  if (input.leftovers !== undefined && (!Array.isArray(input.leftovers) || input.leftovers.some((x) => !x || (x.kind !== "problem" && x.kind !== "note") || typeof x.text !== "string" || !x.text.trim())))
    return { error: "leftovers: each { kind: problem | note, text } — a problem becomes a new, narrower finding when this is applied; a note stays on the closure" };
  const job: Job = { requestId: input.requestId, role: "verifier", slot: input.slot };
  if (derivesCheck(request.capsule, input.slot)) {
    const written = derivedFor(root, job, connection, input.derivedCheck?.receipt);
    if (!written) return { error: connection.claimed() ? "slot 2 of a high-stakes request derives its own check first: call repair_derived_check, then read the brief again"
      : "slot 2 of a high-stakes request derives its own check first: call repair_derived_check, read the brief again with its receipt, and submit that receipt as derivedCheck.receipt" };
    if (input.derivedCheck?.command !== written.command) return { error: `submit the check you derived — \`${written.command}\` — as derivedCheck, with its runs at the witness and the fix` };
    const why = derivedCheckError(input.derivedCheck, request.capsule);
    if (why) return { error: why };
  } else if (input.derivedCheck !== undefined) return { error: "only slot 2 of a high-stakes request carries a derived check" };
  // Held as given, an empty list included: the record compares the subagent's call to this exactly.
  const extra = { ...(input.leftovers !== undefined ? { leftovers: input.leftovers } : {}), ...(input.derivedCheck ? { derivedCheck: input.derivedCheck } : {}) };
  return submit(root, review, job, { results: input.results, ...extra }, connection, (identity) => async (events) => {
    const request = foldRepairVerification(events).requests.find((r) => r.id === input.requestId);
    if (!request) return { error: "unknown request" };
    const sites = await siteBugRefusal(root, events, input.results);
    if (sites) return { error: sites };
    const data: RepairVerificationRun = { id: `run_${randomUUID()}`, requestId: request.id, capsuleHash: request.capsuleHash, slot: input.slot, identity, results: input.results,
      ...extra, ...(input.derivedCheck ? { derivedCheck: withoutReceipt(input.derivedCheck) } : {}) };
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

/** The derive receipt is a local token with no meaning to teammates; it never reaches the log. */
const withoutReceipt = (d: NonNullable<RepairVerificationRun["derivedCheck"]> & { receipt?: string }) => { const { receipt: _r, ...rest } = d; return rest; };

/** `universe` only routes the MCP call, and the receipt is already in that universe's store; any
 *  other key the held submission lacks still refuses. */
const withoutUniverse = (input: any) => { const { universe: _u, ...rest } = input ?? {}; return rest; };

/**
 * Record a subagent's held verification or arbitration. Its transcript must show it was launched
 * with exactly the issued prompt, made the submit call with exactly what was held, and got the
 * held receipt back. The call is found from the receipt (`readReceiptCall`): `pending` only while
 * it may still be on its way to disk, an error once it does not pass — re-checked on every record, never spent. Recorded as the
 * subagent — `child` — on the connection it submitted on.
 */
export async function recordRepairVerification(root: string, review: number | string,
  input: { requestId: string; role: "verifier" | "arbitrator"; slot?: 1 | 2; receipt: string }, dir: string = transcriptDir()) {
  const job: Job = { requestId: input.requestId, role: input.role, ...(input.role === "verifier" ? { slot: input.slot } : {}) };
  const key = { purpose: purposeOf(job), requestId: jobKey(job) };
  const launch = readerRequest(root, key);
  const held = readerReceipts(root, key).find((r) => r.receipt === input.receipt);
  if (!launch || !held) return { error: "no held submission with that receipt for this job" };
  if (held.state !== "pending" && held.state !== "invalid") return { error: `reader receipt is ${held.state}${held.why ? `: ${held.why}` : ""}` };
  const { body, session } = JSON.parse(held.body) as { body: Record<string, unknown>; session: string };
  const call = readReceiptCall(job.role === "verifier" ? /(^|__)repair_verification$/ : /(^|__)repair_arbitration$/, input.receipt, held.heldAt, dir);
  if ("pending" in call) return { pending: true as const, reason: call.pending };
  if (isUnverified(call)) {
    settleReaderReceipt(root, key, input.receipt, "invalid", call.unverified);
    return { error: call.unverified };
  }
  const expected = { review: String(review), requestId: job.requestId, ...(job.slot ? { slot: job.slot } : {}), ...body };
  let reason: string | undefined = !launchedFor(root, review, job, launch, call.reader.prompt) ? "the subagent was not launched with exactly the issued prompt, or one holding its batch's launch line"
    : canonical({ ...withoutUniverse(call.input), review: String(call.input?.review) }) !== canonical(expected) ? "the subagent's submission differs from what was held"
    : call.result?.receipt !== input.receipt ? "the subagent's call did not return this receipt" : undefined;
  // Slot 2's derived check (C2): the same agent derived it, before any brief showed it the evidence.
  let derive: { key: ReturnType<typeof deriveKey>; receipt: string; callId: string } | undefined;
  if (!reason && job.role === "verifier") {
    const source = await repairVerificationRecords(root, review);
    if ("error" in source) return source;
    const request = source.records.requests.find((r) => r.id === job.requestId);
    if (request && derivesCheck(request.capsule, job.slot!)) {
      const receipt = (body.derivedCheck as { receipt?: unknown } | undefined)?.receipt;
      const dheld = typeof receipt === "string" ? readerReceipts(root, deriveKey(job)).find((r) => r.receipt === receipt) : undefined;
      const found = dheld ? readReceiptCall(/(^|__)repair_derived_check$/, dheld.receipt, dheld.heldAt, dir) : undefined;
      if (found && "pending" in found) return { pending: true as const, reason: `its derived check: ${found.pending}` };
      reason = !dheld || !found ? "slot 2's run names no derived check held for this job: the verifier derives its own (repair_derived_check)"
        : isUnverified(found) ? `its derived check: ${found.unverified}`
        : found.agentId !== call.agentId ? "slot 2's derived check was written by another agent: the verifier derives its own"
        : found.input?.command !== (JSON.parse(dheld.body) as Derived).command ? "the derive call's command differs from what was held"
        : !calledBefore(call.agentId, call.reader.session, found.callId, /(^|__)repair_(batch_)?brief$/, carriesEvidence(job.requestId), dir)
          ? "the verifier read the fixer's evidence before it derived its own check" : undefined;
      if (!reason) derive = { key: deriveKey(job), receipt: dheld!.receipt, callId: (found as { callId: string }).callId };
    }
  }
  if (reason) {
    settleReaderReceipt(root, key, input.receipt, "invalid", reason, call.callId);
    return { error: reason };
  }
  const actor = requireActor(root);
  if ("error" in actor) return actor;
  const identity: VerifierIdentity = { principal: actor.principal, harness: "claude-subagent", session, child: call.agentId };
  const recorded = await append(root, review, identity, async (events) => {
    const request = foldRepairVerification(events).requests.find((r) => r.id === job.requestId);
    if (!request) return { error: "unknown request" };
    if (job.role === "verifier") {
      const sites = await siteBugRefusal(root, events, body.results as RepairClaimVerdict[]);
      if (sites) return { error: sites };
      const data: RepairVerificationRun = { id: `run_${randomUUID()}`, requestId: request.id, capsuleHash: request.capsuleHash, slot: job.slot!, identity, results: body.results as RepairClaimVerdict[],
        ...(body.leftovers ? { leftovers: body.leftovers as RepairLeftover[] } : {}),
        ...(body.derivedCheck ? { derivedCheck: withoutReceipt(body.derivedCheck as NonNullable<RepairVerificationRun["derivedCheck"]>) } : {}) };
      return { kind: "repair.verification-recorded", subject: data.id, data: { ...data } };
    }
    const data: RepairVerificationArbitration = { id: `arb_${randomUUID()}`, requestId: request.id, capsuleHash: request.capsuleHash, identity,
      runIds: body.runIds as [string, string], addresses: body.addresses as RepairVerificationArbitration["addresses"] };
    return { kind: "repair.verification-arbitrated", subject: data.id, data: { ...data } };
  });
  if (!("error" in recorded)) {
    settleReaderReceipt(root, key, input.receipt, "recorded", undefined, call.callId);
    if (derive) settleReaderReceipt(root, derive.key, derive.receipt, "recorded", undefined, derive.callId);
  }
  return recorded;
}

export async function applyRepairVerification(root: string, review: number | string, input: { requestId: string; findingId: string; reason: string }, connection: RepairConnection) {
  input = structuredClone(input);
  const identity = identityIn(connection, root);
  let filed: string[] = [];
  const applied = await append(root, review, identity, async (events) => {
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
    // "Still open at closure": a site bug closed since the runs means the site is neither.
    const sites = await siteBugRefusal(root, events, records.runs.filter((x) => x.requestId === request.id).flatMap((x) => x.results.filter((r) => r.findingId === target.findingId)));
    if (sites) return { error: sites };
    const leftovers = leftoversOf(records.runs.filter((x) => x.requestId === request.id));
    // The request's first application makes its problems findings, in the fold (C4); this op gives
    // it what the fold cannot compute: the parent's anchor at the fix commit, or the topic's hold.
    const extra: Pick<RepairVerificationApplication, "leftoverWitness" | "leftoversHeld"> = {};
    const parent = filedFindings(events).find((x) => x.id === target.findingId)?.data;
    filed = [];
    if (!records.applications.some((a) => a.requestId === request.id) && leftovers.problems.length && parent) {
      const slug = topicOf(String(review)), cfg = resolveSidecar(root);
      const retired = slug !== null && !!cfg
        && foldTopicsReport((await readScopeChecked(cfg.path, topicsScope(cfg.universe))).events).value.find((t) => t.slug === slug)?.status === "retired";
      if (retired) extra.leftoversHeld = "topic-retired";
      else {
        filed = leftovers.problems.map((text) => leftoverId(request.id, text));
        if (parent.targetKind === "anchor") {
          // No witness rather than a wrong one: a commit whose snapshot is refused, or that no longer holds the anchor.
          const bodyHash = await bodyHashAtCommit(root, request.capsule.evidence.fixCommit, String(parent.targetId)).catch(() => undefined);
          if (bodyHash) extra.leftoverWitness = { anchorId: String(parent.targetId), bodyHash };
        }
      }
    }
    const data: RepairVerificationApplication = { id: `apply_${randomUUID()}`, requestId: request.id, capsuleHash: request.capsuleHash,
      findingId: target.findingId, openEpoch: target.openEpoch, claimHash: target.claimHash, outcome: decision.verdict as "fixed" | "factually-refuted" | "invalid",
      contextHash: repairVerificationHash(current.rulingContext), reason: input.reason, identity, leftovers, ...extra };
    return { kind: "finding.repairApplied", subject: target.findingId, data: { ...data } };
  });
  if (!("ok" in applied) || !filed.length) return applied;
  await repairVerificationRecords(root, review);   // re-folds the scope, so a read sees them
  return { ...applied, filed };
}
