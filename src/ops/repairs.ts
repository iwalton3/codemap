import { repairCodeLifecycle } from "../repair-lifecycle.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonical } from "../canonical.js";
import { requireActor, isAgentActor } from "../identity.js";
import { sidecarWriteDoor, resolveSidecar, sidecarIdentity } from "../sidecar-config.js";
import { findingKeyScope } from "../review-target.js";
import { findingScope, foldFindings, type SharedFinding } from "../shared-findings.js";
import { findingsProjection } from "../shared-projections.js";
import { readCached } from "../materialize.js";
import { readScopeChecked } from "../eventlog.js";
import { emitEventChecked } from "../write.js";
import { emptyRepairRecords, foldRepairRecords, repairFindingCompleteness, type RepairFindingMap, type RepairSortInput, type RepairEvidenceInput, type RepairRecords } from "../repair-records.js";
import type { RepairConnection } from "../verifier-boundary.js";
import { earlierUnfavourableRuns, emptyRepairVerificationState, isRepairVerificationState, repairVerificationDecision, repairVerificationHash } from "../repair-verification.js";
import { issueClaimHash } from "../ruling-application.js";
import { decisionsView } from "./decision-holds.js";
import { citedRulings } from "./repair-verification.js";

/** Reads the same scope/cache as canonical findings; no ordinary read parses the log. */
export async function repairRecords(root: string, review: number | string) {
  const cfg = resolveSidecar(root);
  if (!cfg) return { error: "repair records require a configured sidecar" };
  const scope = findingScope(findingKeyScope(cfg, review));
  const cached = await readCached(root, cfg.path, scope, sidecarIdentity(cfg), foldFindings, findingsProjection);
  const records = structuredClone((cached.value as RepairFindingMap<SharedFinding>).repairRecords ?? emptyRepairRecords());
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
        if (decisions.unknown || repairVerificationHash(context.rulings) !== repairVerificationHash(citedRulings(decisions.s, request.capsule.evidence.rulingIds))) staleReasons.push("a cited ruling changed or is unknown");
      } catch { staleReasons.push("ruling context cannot be compared; separate application must recheck it"); }
    }
    if (!sort?.current || !sort.eligible || repairVerificationHash(sort.input) !== repairVerificationHash(request.capsule.sort)) staleReasons.push("sort changed or is held");
    if (!evidence || evidence.staleReasons.length || repairVerificationHash(evidence.input) !== repairVerificationHash(request.capsule.evidence)) staleReasons.push("evidence changed or is stale");
    if (repairVerificationHash(records.claims.filter(c => ids.includes(c.findingId))) !== repairVerificationHash(request.capsule.claims)) staleReasons.push("immutable claim coverage changed");
    return ids.map(findingId => {
      const finding = cached.value.get(findingId);
      const target = request.capsule.targets.find(t => t.findingId === findingId)!;
      const claimChanged = !finding || finding.openEpoch !== target.openEpoch || issueClaimHash("finding", finding) !== target.claimHash;
      return { requestId: request.id, findingId, ...repairVerificationDecision(verification, request.id, findingId),
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
    const code = finding && result.complete && (result.verdict === "fixed" || result.verdict === "factually-refuted" || result.verdict === "invalid")
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
      : result.verdict === "invalid" ? "invalid"
      : code?.landing === "landed" ? "verified-repair-landed" : "verified-at-commit";
    return { findingId: result.findingId, requestId: result.requestId, state, grade: result.grade,
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

async function append(root: string, review: number | string, kind: string, subject: string, data: Record<string, unknown>,
  recorded?: (records: RepairRecords) => boolean) {
  data = structuredClone(data);
  const door = sidecarWriteDoor(root);
  if (!door.cfg) return { error: door.error ?? "repair records require a configured sidecar" };
  const cfg = door.cfg;
  if (!existsSync(join(cfg.path, ".git"))) return { error: "repair records require an existing sidecar; run sync first" };
  const actor = requireActor(root);
  if ("error" in actor) return actor;
  const scope = findingScope(findingKeyScope(cfg, review));
  const current = await repairRecords(root, review);
  if (current.error !== undefined) return { error: current.error };
  if (current.status === "blocked") return { error: "repair scope is blocked; records remain visible but cannot authorize a write" };
  if (recorded?.(current.records)) return { ...current, ok: true as const, id: subject, alreadyRecorded: true };
  const event = await emitEventChecked(cfg.path, scope, actor, async () => {
    const checked = await readScopeChecked(cfg.path, scope);
    if (checked.status === "blocked") return { error: "repair scope became blocked before append" };
    return { kind, subject, data };
  }, (events) => ({ refused: foldRepairRecords(events).rejected.map((r) => ({ id: r.eventId, why: r.reason })) }));
  if ("error" in event) return event;
  const result = await repairRecords(root, review);
  if (result.error !== undefined) return { error: result.error };
  return { ...result, ok: true as const, id: subject, eventId: event.id };
}

/**
 * Record ids are codemap's, derived from the content: a caller-chosen id collides across
 * sessions, and the fold keeps whichever duplicate folds first — so evidence citing `s1`
 * attached to another session's `s1` after a sync. Content-derived also makes a retry of the
 * same record idempotent instead of minting a second, competing one.
 */
/**
 * A repair record's id, from its content AND who wrote it (B16: F1, F54). Without the actor an
 * owner re-posting an agent's identical sort got `alreadyRecorded`, so the owner's authorship
 * never entered the log and the hold on an agent's owner-reviewed sort stayed for ever.
 */
const contentId = (prefix: string, review: number | string, data: unknown, actor: { principal: string; via?: unknown }): string =>
  prefix + createHash("sha256").update(canonical({ review: String(review), data,
    by: { principal: actor.principal, agent: isAgentActor(actor as import("../schema.js").Actor) } })).digest("hex").slice(0, 20);
const callerId = (what: string) => ({ error: `codemap assigns a ${what}'s id; leave \`id\` out and use the id it returns` });

export async function postRepairSort(root: string, review: number | string, sort: Omit<RepairSortInput, "id">) {
  sort = structuredClone(sort);
  if (!sort || !Array.isArray(sort.assessments) || sort.assessments.some(a => !a || typeof a !== "object")) return { error: "sort requires assessment records" };
  if ("id" in sort) return callerId("sort");
  if (sort.ruling !== undefined) {
    // The cross-scope half of R5: the cited answer is a verified, standing ruling in the decisions log.
    const view = await decisionsView(root);
    const a = view.s.decisions.flatMap((d) => d.answers).find((x) => x.id === sort.ruling);
    if (!a || !a.verified || a.sourceAnswer || a.withdrawn || a.cancelled)
      return { error: `ruling ${String(sort.ruling)} is not a verified, standing answer in this universe's decisions log` };
  }
  const actor = requireActor(root);
  if ("error" in actor) return actor;
  const id = contentId("rs_", review, sort, actor);
  return append(root, review, "repair.sort-recorded", id, { ...sort, id }, (r) => r.sorts.some(s => s.input.id === id));
}

export async function recordRepairClaims(root: string, review: number | string,
  input: { findingId: string; parentId: string; reason: string; claims: { text: string }[] }) {
  if (!Array.isArray(input?.claims) || input.claims.some(c => !c || typeof c !== "object")) return { error: "claims must be objects with text" };
  if (input.claims.some(c => "id" in c)) return callerId("claim");
  const actor = requireActor(root);
  if ("error" in actor) return actor;
  const claims = input.claims.map((c, i) => ({ id: `${input.findingId}:${contentId("c_", review, { findingId: input.findingId, parentId: input.parentId, reason: input.reason, i, text: c.text }, actor)}`, text: c.text }));
  const out = await append(root, review, "repair.claims-recorded", input.findingId, { ...input, claims },
    (r) => claims.every(c => r.claims.some(x => x.id === c.id)));
  return "ok" in out ? { ...out, claims } : out;
}

/** Commands are recorded verbatim as data. This operation never runs them. */
export async function recordRepairEvidence(root: string, review: number | string, evidence: Omit<RepairEvidenceInput, "id">) {
  if (evidence && "id" in evidence) return callerId("evidence record");
  const actor = requireActor(root);
  if ("error" in actor) return actor;
  const id = contentId("re_", review, evidence, actor);
  return append(root, review, "repair.evidence-recorded", id, { ...evidence, id }, (r) => r.evidence.some(e => e.input.id === id));
}

