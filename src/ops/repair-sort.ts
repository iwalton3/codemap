import { verifierSessionActivity } from "../verifier-local.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { requireActor } from "../identity.js";
import { sidecarWriteDoor } from "../sidecar-config.js";
import { findingKeyScope } from "../review-target.js";
import { findingScope } from "../shared-findings.js";
import { emitEventChecked, readScopeChecked } from "../eventlog.js";
import { readCached } from "../materialize.js";
import { foldFindings, type SharedFinding } from "../shared-findings.js";
import { findingsProjection } from "../shared-projections.js";
import { sidecarIdentity, resolveSidecar } from "../sidecar-config.js";
import { isRepairVerificationState, emptyRepairVerificationState } from "../repair-verification.js";
import { emptyRepairRecords } from "../repair-records.js";
import { foldRepairRecords, type RepairSortInput, type RepairAssessment, type RepairClaim, type RepairFindingMap } from "../repair-records.js";
import { repairSortPayload, repairSortProposal, repairSortProducers, repairSortReceiptHolds } from "../repair-sort.js";
import { RepairSealService } from "../repair-seals.js";
import { readRepairSigningKey, saveRepairSigningKey } from "../store.js";
import { verifierIdentityKey, type RepairVerifierBoundary, type VerifierIdentity } from "../verifier-boundary.js";
export interface RepairSortHost { boundary: RepairVerifierBoundary }
const issuedBoundaries = new Map<string, RepairVerifierBoundary>();
export function currentSortReceiptError(root: string, sort: RepairSortInput): string | undefined {
  for (const opinion of [...sort.assessments, ...(sort.arbitration ? [sort.arbitration] : [])]) {
    const receipt = opinion.receipt?.seal?.receipt;
    if (receipt && (!receipt.identity || ![receipt.identity.principal, receipt.identity.harness, receipt.identity.session, receipt.connectionId].every(v => typeof v === "string" && v.trim()))) return "sorter receipt has incomplete identity or connection";
    const activity = receipt ? verifierSessionActivity(root, receipt.identity) : undefined;
    if (activity && (activity.kind !== "claimed" || activity.connectionId !== receipt!.connectionId)) return "sorter session has prior domain activity, a different claim or a forbidden action";
    const boundary = issuedBoundaries.get(opinion.receipt?.seal?.receipt.id ?? "");
    if (boundary) { const result = boundary.checkProvenance(); if (!result.ok) return result.error; }
  }
}
const briefs = new WeakMap<RepairVerifierBoundary, { sort: RepairSortInput; claims: RepairClaim[]; review: string; root: string; role: "sorter" | "arbitrator"; submitted: boolean }>();
const service = (root: string) => new RepairSealService({ loadKey: () => readRepairSigningKey(root), saveKey: key => saveRepairSigningKey(root, key) });
function identity(root: string, host: RepairSortHost): VerifierIdentity | { error: string } {
  if (!host?.boundary) return { error: "sort assessment requires a trusted fresh sorter boundary" };
  if (host.boundary.claimedRole() !== "repair-sorter") return { error: "sort assessment requires the sorter role claim" };
  const who = host.boundary.trustedIdentity();
  if ("error" in who) return who;
  const actor = requireActor(root);
  return "error" in actor ? actor : actor.principal === who.principal ? who : { error: "sorter identity does not match local actor" };
}
export async function repairSortBrief(root: string, review: number | string, input: { sort: RepairSortInput; role: "sorter" | "arbitrator" }, host: RepairSortHost) {
  const who = identity(root, host);
  if ("error" in who) return who;
  if (!["sorter", "arbitrator"].includes(input.role)) return { error: "unknown sort assessment role" };
  if (briefs.has(host.boundary)) return { error: "sorter session already received a bounded assessment brief" };
  const cfg = resolveSidecar(root);
  if (!cfg) return { error: "sort brief requires a configured sidecar" };
  const scope = findingScope(findingKeyScope(cfg, review));
  const cached = await readCached(root, cfg.path, scope, sidecarIdentity(cfg), foldFindings, findingsProjection);
  const projected = cached.value as RepairFindingMap<SharedFinding>;
  const source = { scope, status: cached.status, records: projected.repairRecords ?? emptyRepairRecords(), verification: isRepairVerificationState(projected.repairVerification) ? projected.repairVerification : emptyRepairVerificationState() };
  if (source.status !== "complete") return { error: "repair scope is blocked" };
  const sort = structuredClone(input.sort);
  const claims = source.records.claims;
  if (sort.provenance !== "dual-sorted" || !Array.isArray(sort.coverage) || !sort.coverage.length
    || sort.coverage.some(r => !Array.isArray(r.claimIds) || !r.claimIds.length || r.claimIds.some(id => !claims.some(c => c.id === id && c.findingId === r.findingId)))) return { error: "sort brief requires dual-sorted proposal with immutable original claim coverage" };
  if (source.records.participants.some(p => verifierIdentityKey(p.input.identity) === verifierIdentityKey(who))) return { error: "fixer or relayer cannot assess its repair sort" };
  if (input.role === "arbitrator") {
    const checked = { ...sort, arbitration: undefined };
    const holds = repairSortReceiptHolds(checked, claims, source.verification.producers.map(p => ({ kind: "repair.verification-producer", subject: p.producerKeyId, actor: { principal: p.principal }, data: p }) as never), source.records.participants.map(p => p.input)).filter(h => !h.includes("requires arbitration"));
    if (holds.length || !sort.disagreements.length || sort.assessments.some(a => verifierIdentityKey(a.identity) === verifierIdentityKey(who))) return { error: "arbitrator requires both independently sealed assessments and an actual recorded conflict" };
  }
  briefs.set(host.boundary, { sort, claims: structuredClone(claims), review: String(review), root, role: input.role, submitted: false });
  return { ...repairSortProposal(sort, claims), ...(input.role === "arbitrator" ? { assessments: sort.assessments } : {}),
    instruction: "Assess the immutable claim and exact proposed classification independently. An unanswered requirement or scope choice remains decision-needed. Arbitration must explain how the chosen classification resolves each conflict." };
}
async function seal(root: string, review: number | string, opinion: RepairAssessment | NonNullable<RepairSortInput["arbitration"]>, host: RepairSortHost, role: "sorter" | "arbitrator") {
  const who = identity(root, host);
  if ("error" in who) return who;
  const brief = briefs.get(host.boundary);
  if (!brief || brief.root !== root || brief.review !== String(review) || brief.role !== role || brief.submitted) return { error: "assessment needs its own unused exact bounded brief" };
  const door = sidecarWriteDoor(root);
  if (!door.cfg || !existsSync(join(door.cfg.path, ".git"))) return { error: door.error ?? "sort assessment requires an existing synced sidecar" };
  const actor = requireActor(root);
  if ("error" in actor) return actor;
  const scope = findingScope(findingKeyScope(door.cfg, review));
  const producer = service(root).publicProducer();
  const registered = await emitEventChecked(door.cfg.path, scope, actor, async events => {
    if ((await readScopeChecked(door.cfg!.path, scope)).status !== "complete") return { error: "repair scope is blocked" };
    const repairs = foldRepairRecords(events);
    if (JSON.stringify(repairSortProposal(brief.sort, repairs.claims)) !== JSON.stringify(repairSortProposal(brief.sort, brief.claims))) return { error: "immutable claim brief changed before assessment" };
    if (repairs.participants.some(p => verifierIdentityKey(p.input.identity) === verifierIdentityKey(who))) return { error: "sort assessor participated as fixer or relayer" };
    const existing = repairSortProducers(events).find(p => p.producerKeyId === producer.producerKeyId);
    if (existing && existing.principal !== who.principal) return { error: "local repair producer belongs to another principal" };
    return existing ? { existing: events.find(e => e.kind === "repair.verification-producer" && e.subject === producer.producerKeyId)! }
      : { kind: "repair.verification-producer", subject: producer.producerKeyId, data: { ...producer } };
  });
  if ("error" in registered) return registered;
  const content = repairSortPayload(brief.sort, brief.claims, opinion, role, scope);
  const capability = host.boundary.sealCapability(`${scope}\0${brief.sort.id}`, content);
  if ("error" in capability) return capability;
  const sealed = service(root).seal(capability);
  if ("error" in sealed) return sealed;
  if (sealed.receipt.role !== "repair-sorter") return { error: "sort assessment requires the sorter role claim" };
  brief.submitted = true;
  issuedBoundaries.set(sealed.receipt.id, host.boundary);
  return { ok: true, assessment: { ...opinion, receipt: { id: sealed.receipt.id, source: "server-bound independent sort assessment", scope, content, seal: sealed } } };
}
export async function submitRepairSortAssessment(root: string, review: number | string, input: { classification: string; reason: string }, host: RepairSortHost) {
  const who = identity(root, host);
  if ("error" in who) return who;
  if (![input.classification, input.reason].every(v => typeof v === "string" && v.trim())) return { error: "classification and substantive reasoning are required" };
  return seal(root, review, { identity: who, classification: input.classification, reason: input.reason }, host, "sorter");
}
export async function arbitrateRepairSort(root: string, review: number | string, input: { addresses: string[]; reason: string }, host: RepairSortHost) {
  const who = identity(root, host);
  if ("error" in who) return who;
  const brief = briefs.get(host.boundary);
  if (!brief || !Array.isArray(input.addresses) || brief.sort.disagreements.some(d => !input.addresses.includes(d.id))
    || typeof input.reason !== "string" || !input.reason.trim() || /^(agree|agreement|approved|accept|yes|ok)[.!\s]*$/i.test(input.reason.trim())) return { error: "arbitration must substantively address every recorded conflict" };
  return seal(root, review, { identity: who, addresses: input.addresses, reason: input.reason }, host, "arbitrator");
}
