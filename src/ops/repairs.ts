import { repairCodeLifecycle } from "../repair-lifecycle.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { requireActor } from "../identity.js";
import { sidecarWriteDoor, resolveSidecar, sidecarIdentity } from "../sidecar-config.js";
import { findingKeyScope } from "../review-target.js";
import { findingScope, foldFindings, type SharedFinding } from "../shared-findings.js";
import { findingsProjection } from "../shared-projections.js";
import { readCached } from "../materialize.js";
import { emitEventChecked, readScopeChecked, GENESIS, SIDECAR_PROTOCOL, EVENT_SCHEMA, type LogEvent } from "../eventlog.js";
import { emptyRepairRecords, foldRepairRecords, repairFindingCompleteness, type RepairFindingMap, type RepairSortInput, type RepairEvidenceInput } from "../repair-records.js";
import type { RepairConnection } from "../verifier-boundary.js";
import { earlierUnfavourableRuns, emptyRepairVerificationState, isRepairVerificationState, repairVerificationDecision, repairVerificationHash } from "../repair-verification.js";
import { issueClaimHash } from "../ruling-application.js";
import { decisionsView } from "./decision-holds.js";

/** Reads the same scope/cache as canonical findings; no ordinary read parses the log. */
export async function repairRecords(root: string, review: number | string) {
  const cfg = resolveSidecar(root);
  if (!cfg) return { error: "repair records require a configured sidecar" };
  const scope = findingScope(findingKeyScope(cfg, review));
  const cached = await readCached(root, cfg.path, scope, sidecarIdentity(cfg), foldFindings, findingsProjection);
  const records = structuredClone((cached.value as RepairFindingMap<SharedFinding>).repairRecords ?? emptyRepairRecords());
  const participants = records.participants.map(p => p.input);
  const projectedVerification = (cached.value as RepairFindingMap<SharedFinding>).repairVerification;
  if (projectedVerification !== undefined && !isRepairVerificationState(projectedVerification)) throw new Error("repair verification projection has a malformed shape");
  const verification = isRepairVerificationState(projectedVerification) ? projectedVerification : emptyRepairVerificationState();
  const decisions = verification.requests.length ? await decisionsView(root) : undefined;
  const verificationResults = verification.requests.flatMap(request => {
    const sort = records.sorts.find(s => s.input.id === request.capsule.sort.id);
    const evidence = records.evidence.find(e => e.input.id === request.capsule.evidence.id);
    const ids = request.capsule.targets.map(t => t.findingId);
    const staleReasons: string[] = cached.status === "blocked" ? ["repair scope is blocked; current proof is unknown"] : [];
    if (decisions) {
      try {
        const context = JSON.parse(request.capsule.rulingContext);
        if (decisions.unknown || repairVerificationHash(context.decisions) !== repairVerificationHash(decisions.s)) staleReasons.push("ruling context changed or is unknown");
      } catch { staleReasons.push("ruling context cannot be compared; separate application must recheck it"); }
    }
    if (!sort?.current || !sort.eligible || repairVerificationHash(sort.input) !== repairVerificationHash(request.capsule.sort)) staleReasons.push("sort changed or is held");
    if (!evidence || evidence.staleReasons.length || repairVerificationHash(evidence.input) !== repairVerificationHash(request.capsule.evidence)) staleReasons.push("evidence changed or is stale");
    if (repairVerificationHash(records.claims.filter(c => ids.includes(c.findingId))) !== repairVerificationHash(request.capsule.claims)) staleReasons.push("immutable claim coverage changed");
    return ids.map(findingId => {
      const finding = cached.value.get(findingId);
      const target = request.capsule.targets.find(t => t.findingId === findingId)!;
      const claimChanged = !finding || finding.openEpoch !== target.openEpoch || issueClaimHash("finding", finding) !== target.claimHash;
      return { requestId: request.id, findingId, ...repairVerificationDecision(verification, request.id, findingId, participants),
        historicalClosure: finding?.repairClosure?.requestId === request.id ? finding.repairClosure : undefined,
        staleReasons: [...staleReasons, ...(claimChanged ? ["current finding claim or opening changed"] : [])] };
    });
  });
  const coverage = Object.fromEntries(records.evidence.map(e => {
    const sort = records.sorts.find(s => s.input.id === e.input.sortId);
    return [e.input.id, (sort?.input.coverage ?? e.input.coverage).map(ref => ({ findingId: ref.findingId,
      completeness: repairFindingCompleteness(records, e.input.id, ref.findingId) }))];
  }));
  const historicalClosures = [...cached.value.values()].flatMap(finding => finding.repairClosure
    ? [{ findingId: finding.id, state: finding.state, ...finding.repairClosure }] : []);
  const lifecycles = await Promise.all(verificationResults.map(async result => {
    const request = verification.requests.find(r => r.id === result.requestId)!;
    const finding = cached.value.get(result.findingId);
    const code = finding && result.complete && (result.verdict === "fixed" || result.verdict === "factually-refuted")
      ? await repairCodeLifecycle(root, finding, { ...request.capsule.evidence,
        inspected: [...request.capsule.evidence.inspected,
          ...verification.runs.filter(r => r.requestId === result.requestId).flatMap(r => r.results
            .filter(v => v.findingId === result.findingId).flatMap(v => v.inspected))],
        attribution: [...request.capsule.evidence.attribution, ...(request.capsule.sort.sites ?? [])
          .map(file => ({ file, hunk: "pattern boundary", claimIds: [] }))] }, result.verdict) : undefined;
    const attention = [...result.staleReasons, ...(result.historicalClosure?.attention ?? []),
      ...(code?.source === "moved" || code?.defaultSource === "moved" ? code.reasons : [])];
    const state = result.verdict === "decision-needed" ? "decision-needed"
      : !result.complete ? (coverage[request.capsule.evidence.id]?.some(c => c.findingId === result.findingId && c.completeness === "partial") ? "partly-repaired" : "unknown")
      : result.verdict === "factually-refuted" ? "factually-refuted"
      : code?.landing === "landed" ? "verified-repair-landed" : "verified-at-commit";
    return { findingId: result.findingId, requestId: result.requestId, state, grade: result.grade,
      launchedByParticipant: result.launchedByParticipant,
      earlierUnfavourable: earlierUnfavourableRuns(verification, result.requestId).map(r => ({ requestId: r.requestId, runId: r.id,
        verdicts: r.results.filter(v => v.findingId === result.findingId).map(v => v.verdict) })),
      applied: !!result.historicalClosure, code, attention,
      currentProof: result.complete && !attention.length && code?.source === "unchanged" && code?.defaultSource !== "moved" && code?.defaultSource !== "unknown",
      verifiers: verification.runs.filter(r => r.requestId === result.requestId).map(r => r.identity),
      rulingIds: request.capsule.evidence.rulingIds,
      claims: request.capsule.claims.filter(c => c.findingId === result.findingId),
      evidenceId: request.capsule.evidence.id };
  }));
  return { scope, status: cached.status, diagnostic: cached.diagnostic,
    records, coverage, verification, verificationResults, historicalClosures, lifecycles,
    closure: "independent-verification-requires-separate-application" as const };
}

async function append(root: string, review: number | string, kind: string, subject: string, data: Record<string, unknown>) {
  data = structuredClone(data);
  const door = sidecarWriteDoor(root);
  if (!door.cfg) return { error: door.error ?? "repair records require a configured sidecar" };
  const cfg = door.cfg;
  if (!existsSync(join(cfg.path, ".git"))) return { error: "repair records require an existing sidecar; run sync first" };
  const actor = requireActor(root);
  if ("error" in actor) return actor;
  const scope = findingScope(findingKeyScope(cfg, review));
  const current = await repairRecords(root, review);
  if ("error" in current) return current;
  if (current.status === "blocked") return { error: "repair scope is blocked; records remain visible but cannot authorize a write" };
  const event = await emitEventChecked(cfg.path, scope, actor, async (events) => {
    const checked = await readScopeChecked(cfg.path, scope);
    if (checked.status === "blocked") return { error: "repair scope became blocked before append" };
    const candidate: LogEvent = { id: randomUUID(), kind, subject, data,
      actor, at: new Date().toISOString(), after: events.map((e) => e.id),
      writer: "repair-admission", writerPrev: GENESIS, sidecarProtocol: SIDECAR_PROTOCOL, eventSchema: EVENT_SCHEMA };
    const folded = foldRepairRecords([...events, candidate]);
    const refused = folded.rejected.find((r) => r.eventId === candidate.id);
    return refused ? { error: refused.reason } : { kind, subject, data };
  });
  if ("error" in event) return event;
  const result = await repairRecords(root, review);
  return { ok: true, id: subject, eventId: event.id, ...result };
}

export async function postRepairSort(root: string, review: number | string, sort: RepairSortInput) {
  sort = structuredClone(sort);
  if (!sort || !Array.isArray(sort.assessments) || sort.assessments.some(a => !a || typeof a !== "object")) return { error: "sort requires assessment records" };
  return append(root, review, "repair.sort-recorded", sort?.id, { ...sort });
}

export async function recordRepairClaims(root: string, review: number | string,
  input: { findingId: string; parentId: string; reason: string; claims: { id: string; text: string }[] }) {
  return append(root, review, "repair.claims-recorded", input.findingId, { ...input });
}

/** Commands are recorded verbatim as data. This operation never runs them. */
export async function recordRepairEvidence(root: string, review: number | string, evidence: RepairEvidenceInput) {
  return append(root, review, "repair.evidence-recorded", evidence?.id, { ...evidence });
}

/** The identity is this MCP connection's, never a tool argument (see `verifier-boundary.ts`). */
export async function recordRepairParticipant(root: string, review: number | string,
  input: { repairId: string; role: "fixer" | "relayer" }, connection: RepairConnection) {
  const actor = requireActor(root);
  if ("error" in actor) return actor;
  if (connection.principal !== actor.principal) return { error: "this connection belongs to another principal" };
  return append(root, review, "repair.participant-recorded", input.repairId, { ...input, identity: connection.identity() });
}
