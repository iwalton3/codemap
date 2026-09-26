import { createHash } from "node:crypto";
import { sortEvents, type LogEvent } from "./eventlog.js";
import { foldRepairRecords } from "./repair-records.js";
import type { RepairClaim, RepairSortInput, RepairEvidenceInput, RepairExecution, RepairCoverage } from "./repair-records.js";
import { verifierIdentityKey, type VerifierIdentity, type RepairParticipant } from "./verifier-boundary.js";

export type RepairVerdict = "fixed" | "factually-refuted" | "decision-needed" | "unknown";
import { verifyRepairSeal, type RepairVerificationSeal, type RepairSealProducer } from "./repair-seals.js";
export type { RepairVerificationSeal } from "./repair-seals.js";
export interface RepairVerificationCapsule {
  scope: string;
  targets: { findingId: string; openEpoch: string; claimHash: string }[];
  code: { witnessCommit: string; baseCommit: string; fixCommit: string; diff: string; availability: "available" | "unknown"; reason?: string };
  claims: RepairClaim[];
  sort: RepairSortInput;
  evidence: RepairEvidenceInput;
  rulingContext: string;
  orchestrator: VerifierIdentity;
}
export interface RepairVerificationRequest {
  id: string; capsule: RepairVerificationCapsule; capsuleHash: string; seal: RepairVerificationSeal;
}
export interface RepairClaimVerdict {
  findingId: string; claimId: string; verdict: RepairVerdict; reason: string;
  grade: "executable" | "inspection" | "none";
  executions: RepairExecution[];
  inspected: { source: string; commit: string; reasoning: string }[];
  noCheckReason?: string;
}
export interface RepairVerificationRun {
  id: string; requestId: string; capsuleHash: string; slot: 1 | 2;
  identity: VerifierIdentity; connectionId: string; results: RepairClaimVerdict[];
  seal: RepairVerificationSeal;
}
export interface RepairVerificationArbitration {
  id: string; requestId: string; capsuleHash: string;
  identity: VerifierIdentity; connectionId: string;
  runIds: [string, string];
  addresses: { findingId: string; claimId: string; reason: string; verdict: RepairVerdict }[];
  seal: RepairVerificationSeal;
}
export interface RepairVerificationApplication {
  id: string; requestId: string; capsuleHash: string; findingId: string; openEpoch: string; claimHash: string;
  outcome: "fixed" | "factually-refuted"; contextHash: string; reason: string; seal: RepairVerificationSeal;
}
export interface RepairVerificationRecords {
  producers: (RepairSealProducer & { principal: string })[]; requests: RepairVerificationRequest[]; runs: RepairVerificationRun[];
  arbitrations: RepairVerificationArbitration[]; applications: RepairVerificationApplication[]; rejected: { eventId: string; reason: string }[];
}
export interface RepairVerificationTrust {
  participants?: readonly RepairParticipant[];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export function repairVerificationHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value)) ?? "null").digest("hex");
}
/** The seal binds the event kind and subject, as well as every payload field. */
export function repairVerificationPayload(kind: string, subject: string, data: unknown): string {
  const { seal: _seal, ...unsigned } = data as Record<string, unknown>;
  return JSON.stringify(canonical({ kind, subject, data: unsigned }));
}
const text = (s: unknown): s is string => typeof s === "string" && !!s.trim();
const sha = (s: unknown) => typeof s === "string" && /^[a-f0-9]{40,64}$/.test(s);
const identityValid = (i: VerifierIdentity | undefined): i is VerifierIdentity => !!i && [i.principal, i.harness, i.session].every(text) && (i.child === undefined || text(i.child));
const verdicts = ["fixed", "factually-refuted", "decision-needed", "unknown"];
const key = (v: {findingId: string; claimId: string}) => JSON.stringify([v.findingId, v.claimId]);
const coverageKeys = (coverage: RepairCoverage[]) => coverage.flatMap(c => c.claimIds.map(claimId => key({ findingId: c.findingId, claimId })));
function independent(i: VerifierIdentity, c: RepairVerificationCapsule, trust: RepairVerificationTrust): boolean {
  return identityValid(i) && verifierIdentityKey(i) !== verifierIdentityKey(c.orchestrator)
    && !(trust.participants ?? []).some(p => verifierIdentityKey(p.identity) === verifierIdentityKey(i));
}
function resultError(r: RepairClaimVerdict, c: RepairVerificationCapsule): string | undefined {
  if (!r || !text(r.reason) || !verdicts.includes(r.verdict) || !["executable", "inspection", "none"].includes(r.grade)
    || !Array.isArray(r.executions) || !Array.isArray(r.inspected)) return "invalid claim verdict";
  if (!coverageKeys(c.sort.coverage).includes(key(r))) return "verdict exceeds immutable coverage";
  if (r.executions.some(x => !text(x.id) || !text(x.command) || !text(x.environment) || !sha(x.commit)
    || !["witness", "fix", "reversal", "mutation", "regression"].includes(x.phase)
    || !["passed", "failed", "unknown"].includes(x.outcome)
    || (x.outcome === "unknown" ? !text(x.reason) : !Number.isInteger(x.exitCode))
    || (x.outcome === "passed" && x.exitCode !== 0) || (x.outcome === "failed" && x.exitCode === 0))) return "execution requires an actual consistent result";
  if (r.inspected.some(x => !text(x.source) || ![c.evidence.witnessCommit, c.evidence.fixCommit].includes(x.commit) || !text(x.reasoning))) return "inspection must bind an exact witness or checked commit";
  if (r.verdict !== "fixed" && r.verdict !== "factually-refuted") return undefined;
  if (r.verdict === "factually-refuted") {
    const claim = c.claims.find(x => x.id === r.claimId && x.findingId === r.findingId);
    const original = claim?.parentId ? c.claims.find(x => x.id === claim.parentId && x.findingId === r.findingId) : claim;
    const sourceRef = original?.asFiled?.sourceRef;
    if (!sha(sourceRef) || sourceRef !== c.evidence.witnessCommit) return "factual refutation has unknown or mismatched immutable as-filed source provenance";
  }
  if (r.verdict === "factually-refuted" && c.sort.refutationSubtype === "scope") return "code evidence cannot refute a scope or requirement judgment";
  if (c.sort.kind === "pattern" && (!c.evidence.patternEnumeration || c.sort.sites?.some(site => (!c.evidence.patternEnumeration!.expected.includes(site) || !c.evidence.patternEnumeration!.actual.includes(site))))) return "pattern enumeration omits an original site";
  if (r.grade === "inspection") {
    if (!text(r.noCheckReason) || !r.inspected.length) return "inspection closure needs explicit no-check reason and inspected evidence";
    const requiredCommit = r.verdict === "factually-refuted" ? c.evidence.witnessCommit : c.evidence.fixCommit;
    if (!r.inspected.some(x => x.commit === requiredCommit)) return r.verdict === "factually-refuted"
      ? "factual refutation must independently inspect the as-filed witness commit"
      : "fixed verdict must independently inspect the fix commit";
    if ([...c.evidence.reproducer, ...c.evidence.changeFalsifier].some(x => x.outcome !== "unknown")) return "available executable evidence must be independently checked";
  } else if (r.grade === "executable") {
    const actual = r.executions.filter(x => x.outcome !== "unknown");
    const useful = [...c.evidence.reproducer, ...c.evidence.changeFalsifier];
    if (!useful.length || useful.some(x => !actual.some(y => y.id === x.id && y.command === x.command && y.commit === x.commit && y.phase === x.phase && y.environment === x.environment && y.mutation === x.mutation && repairVerificationHash(y.reversedHunks) === repairVerificationHash(x.reversedHunks) && y.outcome === x.outcome))) return "useful pinned evidence must be independently rerun; regression alone is insufficient";
    const requiredCommit = r.verdict === "factually-refuted" ? c.evidence.witnessCommit : c.evidence.fixCommit;
    if (!actual.some(x => x.commit === requiredCommit && x.phase !== "regression" && x.outcome === "passed")) return r.verdict === "factually-refuted"
      ? "factual refutation requires a useful passing independent execution at the as-filed witness"
      : "closure requires a useful passing execution at checked commit";
    if (r.verdict === "fixed" && (!actual.some(x => x.commit === c.evidence.witnessCommit && x.phase === "witness" && x.outcome === "failed")
      || !actual.some(x => x.commit === c.evidence.fixCommit && x.phase === "fix" && x.outcome === "passed")
      || !actual.some(x => ["reversal", "mutation"].includes(x.phase) && x.outcome === "failed"
        && (x.phase === "reversal" ? !!x.reversedHunks?.length : text(x.mutation))))) return "fixed executable evidence requires witness failure, fix success and a failing change falsifier";
  } else return "closure needs independent executable or explicit inspection evidence";
}

/** Seals are verified against producer trust supplied outside the event log. */
export function foldRepairVerification(events: LogEvent[], trust: RepairVerificationTrust = {}): RepairVerificationRecords {
  trust = {participants:[...(trust.participants ?? []), ...foldRepairRecords(events).participants.filter(p => p.input.trust === "native-session").map(p => p.input)]};
  const out: RepairVerificationRecords = { producers: [], requests: [], runs: [], arbitrations: [], applications: [], rejected: [] };
  const assigned = (who: VerifierIdentity, connectionId: string) => out.requests.some(r => verifierIdentityKey(r.capsule.orchestrator) === verifierIdentityKey(who) || r.seal.receipt.connectionId === connectionId)
    || out.runs.some(r => verifierIdentityKey(r.identity) === verifierIdentityKey(who) || r.connectionId === connectionId)
    || out.arbitrations.some(r => verifierIdentityKey(r.identity) === verifierIdentityKey(who) || r.connectionId === connectionId);
  const ordered = sortEvents(events);
  for (const e of ordered) {
    if (!["repair.verification-producer", "repair.verification-requested", "repair.verification-sealed", "repair.verification-arbitrated", "finding.repairApplied"].includes(e.kind)) continue;
    const d = e.data as unknown as RepairVerificationRequest & RepairVerificationRun & RepairVerificationArbitration & RepairVerificationApplication;
    let error: string | undefined;
    try {
      if (e.kind === "repair.verification-producer") {
        const producer = e.data as unknown as RepairSealProducer;
        if (!producer || !text(producer.producerKeyId) || producer.producerKeyId !== e.subject || !text(producer.publicKey)
          || producer.producerKeyId !== `repair_key_${createHash("sha256").update(producer.publicKey).digest("hex")}`) error = "invalid producer registration";
        else if (out.producers.some(x => x.producerKeyId === producer.producerKeyId && (x.publicKey !== producer.publicKey || x.principal !== e.actor.principal))) error = "producer registration cannot change";
        else if (!out.producers.some(x => x.producerKeyId === producer.producerKeyId)) out.producers.push({ ...producer, principal: e.actor.principal });
        if (error) out.rejected.push({eventId: e.id, reason: error});
        continue;
      }
      const producer = out.producers.find(x => x.producerKeyId === d?.seal?.producerKeyId && x.principal === e.actor.principal);
      const expectedIdentity = e.kind === "repair.verification-requested" ? d.capsule?.orchestrator : e.kind === "finding.repairApplied" ? out.requests.find(x => x.id === d.requestId)?.capsule.orchestrator : d.identity;
      if (!d || !text(d.id) || (e.kind === "finding.repairApplied" ? d.findingId !== e.subject : d.id !== e.subject) || !producer || !identityValid(expectedIdentity)
        || expectedIdentity.principal !== e.actor.principal
        || verifierIdentityKey(d.seal.receipt.identity) !== verifierIdentityKey(expectedIdentity)
        || (["repair.verification-sealed", "repair.verification-arbitrated"].includes(e.kind) && d.seal.receipt.connectionId !== d.connectionId)
        || !verifyRepairSeal(d.seal, {publicKey:producer.publicKey, requestKey:e.kind === "repair.verification-requested" ? d.id : d.requestId,
          content:repairVerificationPayload(e.kind, e.subject, d), participants:trust.participants ?? []}).ok) error = "missing, forged or untrusted durable seal";
      else if (e.kind === "repair.verification-requested") {
        const c = d.capsule;
        if (!c || !text(c.scope) || !text(c.rulingContext) || !identityValid(c.orchestrator) || !Array.isArray(c.claims) || !c.claims.length
          || !Array.isArray(c.targets) || !c.targets.length || c.targets.some(t => !text(t.findingId) || !text(t.openEpoch) || !text(t.claimHash))
          || !c.code || c.code.witnessCommit !== c.evidence.witnessCommit || c.code.baseCommit !== c.evidence.baseCommit || c.code.fixCommit !== c.evidence.fixCommit || typeof c.code.diff !== "string" || !["available", "unknown"].includes(c.code.availability) || (c.code.availability === "unknown" && !text(c.code.reason))
          || !c.sort || !c.evidence || c.evidence.sortId !== c.sort.id || !Array.isArray(c.sort.coverage) || !c.sort.coverage.length
          || ![c.evidence.witnessCommit, c.evidence.baseCommit, c.evidence.fixCommit].every(sha)
          || d.capsuleHash !== repairVerificationHash(c)) error = "invalid immutable request capsule";
        else if (coverageKeys(c.sort.coverage).some(k => !c.claims.some(claim => key({ findingId: claim.findingId, claimId: claim.id }) === k && text(claim.text)))
          || new Set(coverageKeys(c.sort.coverage)).size !== coverageKeys(c.sort.coverage).length) error = "request needs exact immutable claim coverage";
        else if ((trust.participants ?? []).some(p => verifierIdentityKey(p.identity) === verifierIdentityKey(c.orchestrator))) error = "orchestrator cannot be a repair participant";
        else if (repairVerificationSnapshotError(ordered.slice(0, ordered.indexOf(e)), c)) error = repairVerificationSnapshotError(ordered.slice(0, ordered.indexOf(e)), c);
        else if (out.requests.some(x => x.id === d.id)) error = "request is immutable";
        else if (assigned(c.orchestrator, d.seal.receipt.connectionId)) error = "fresh orchestrator cannot reuse another verification assignment";
        else out.requests.push(structuredClone(d));
      } else {
        const request = out.requests.find(x => x.id === d.requestId);
        if (!request || request.capsuleHash !== d.capsuleHash) error = "unknown or changed verification request";
        else if (e.kind === "finding.repairApplied") {
          error = d.seal.receipt.connectionId !== request.seal.receipt.connectionId ? "application must use original orchestrator connection" : repairVerificationApplicationError(out, d) ?? repairVerificationSnapshotError(ordered.slice(0, ordered.indexOf(e)), request.capsule);
          if (!error && out.applications.some(a => a.requestId === d.requestId && a.findingId === d.findingId && a.openEpoch === d.openEpoch)) error = "verification application is one-shot per finding epoch";
          if (!error) out.applications.push(structuredClone(d));
        }
        else if (!independent(d.identity, request.capsule, trust) || d.identity.principal !== e.actor.principal || !text(d.connectionId)) error = "verifier identity is not independent and producer-bound";
        else if (e.kind === "repair.verification-sealed") {
          const previous = out.runs.filter(x => x.requestId === d.requestId);
          if (![1, 2].includes(d.slot) || assigned(d.identity,d.connectionId) || previous.some(x => x.slot === d.slot || x.id === d.id || verifierIdentityKey(x.identity) === verifierIdentityKey(d.identity) || x.connectionId === d.connectionId)) error = "two blind slots require distinct fresh sessions and connections";
          else if (!Array.isArray(d.results) || !d.results.length || new Set(d.results.map(key)).size !== d.results.length) error = "run needs unique per-claim outcomes";
          else error = d.results.map(r => resultError(r, request.capsule)).find(Boolean);
          if (!error) out.runs.push(structuredClone(d));
        } else {
          const runs = out.runs.filter(x => x.requestId === d.requestId);
          if (assigned(d.identity,d.connectionId)) error = "arbitrator cannot reuse any prior verification assignment";
          else if (runs.length !== 2 || !Array.isArray(d.runIds) || d.runIds.length !== 2 || new Set(d.runIds).size !== 2 || runs.some(x => !d.runIds.includes(x.id))) error = "arbitration requires both sealed runs";
          else if (runs.some(x => verifierIdentityKey(x.identity) === verifierIdentityKey(d.identity) || x.connectionId === d.connectionId)) error = "arbitrator must be a third fresh identity";
          else {
            const conflicts = repairVerificationDisagreements(runs[0]!, runs[1]!);
            if (!conflicts.length || !Array.isArray(d.addresses) || d.addresses.length !== conflicts.length
              || new Set(d.addresses.map(key)).size !== d.addresses.length
              || conflicts.some(x => !d.addresses.some(a => key(a) === key(x) && text(a.reason) && !/^(agree|agreed|agreement|fixed|refuted|yes|no)[.! ]*$/i.test(a.reason) && verdicts.includes(a.verdict)))) error = "arbitration must substantively address every actual disagreement";
            else if (out.arbitrations.some(x => x.requestId === d.requestId || x.id === d.id)) error = "arbitration is immutable";
            else out.arbitrations.push(structuredClone(d));
          }
        }
      }
    } catch { error = "malformed verification event"; }
    if (error) out.rejected.push({ eventId: e.id, reason: error });
  }
  return out;
}

export function repairVerificationDisagreements(a: RepairVerificationRun, b: RepairVerificationRun): {findingId: string; claimId: string}[] {
  const all = new Map([...a.results, ...b.results].map(r => [key(r), { findingId: r.findingId, claimId: r.claimId }]));
  return [...all.values()].filter(r => a.results.find(x => key(x) === key(r))?.verdict !== b.results.find(x => key(x) === key(r))?.verdict);
}
export function repairVerificationDecision(records: RepairVerificationRecords, requestId: string, findingId: string): { verdict: RepairVerdict; complete: boolean; grade: "executable" | "inspection" | "none"; reasons: string[] } {
  const request = records.requests.find(x => x.id === requestId);
  const runs = records.runs.filter(x => x.requestId === requestId);
  const unresolved = (reason: string) => ({ verdict: "unknown" as const, complete: false, grade: "none" as const, reasons: [reason] });
  if (!request || runs.length !== 2) return unresolved("two sealed independent runs are required");
  const claims = request.capsule.claims.filter(x => x.findingId === findingId);
  if (!claims.length) return unresolved("finding is outside immutable request");
  const arbitration = records.arbitrations.find(x => x.requestId === requestId);
  const classification = request.capsule.sort.classification;
  if (!["mechanical", "implementation-defect", "invalid", "factual-refutation"].includes(classification)
    || request.capsule.sort.refutationSubtype === "scope") return {verdict:"decision-needed",complete:false,grade:"none",reasons:["sort requires a requirement or scope decision"]};
  const outcomes: RepairVerdict[] = [];
  let inspection = false;
  for (const claim of claims) {
    const a = runs[0]!.results.find(x => x.findingId === findingId && x.claimId === claim.id);
    const b = runs[1]!.results.find(x => x.findingId === findingId && x.claimId === claim.id);
    if (!a || !b) return unresolved("partial coverage cannot resolve a whole finding");
    const result = a.verdict === b.verdict ? a.verdict : arbitration?.addresses.find(x => x.findingId === findingId && x.claimId === claim.id)?.verdict;
    if (!result) return unresolved("disagreement awaits substantive arbitration");
    if ((result === "fixed" || result === "factually-refuted") && ![a, b].every(x => x.grade !== "none" && (x.verdict === "fixed" || x.verdict === "factually-refuted"))) return unresolved("arbitration cannot manufacture missing independent repair evidence");
    if ((result === "fixed" || result === "factually-refuted") && a.verdict !== b.verdict) {
      const requiredCommit = result === "factually-refuted" ? request.capsule.evidence.witnessCommit : request.capsule.evidence.fixCommit;
      if (![a, b].every(x => x.grade === "inspection" ? x.inspected.some(i => i.commit === requiredCommit)
        : x.executions.some(i => i.commit === requiredCommit && i.phase !== "regression" && i.outcome === "passed"))) return unresolved("arbitration cannot substitute evidence from another commit");
    }
    inspection ||= a.grade === "inspection" || b.grade === "inspection";
    outcomes.push(result);
  }
  if (outcomes.includes("decision-needed")) return { verdict: "decision-needed", complete: false, grade: "none", reasons: ["requirement or scope decision remains"] };
  if (outcomes.includes("unknown")) return unresolved("unknown never closes or automatically reopens");
  return { verdict: outcomes.every(x => x === "factually-refuted") ? "factually-refuted" : "fixed", complete: true, grade: inspection ? "inspection" : "executable", reasons: [] };
}

export type RepairVerificationState = RepairVerificationRecords;
export const emptyRepairVerificationState = (): RepairVerificationState => ({ producers: [], requests: [], runs: [], arbitrations: [], applications: [], rejected: [] });
function sealShape(seal: RepairVerificationSeal): boolean {
  return !!seal && seal.version === 1 && text(seal.producerKeyId) && text(seal.publicKey) && text(seal.signature)
    && !!seal.receipt && identityValid(seal.receipt.identity) && seal.receipt.identityKey === verifierIdentityKey(seal.receipt.identity)
    && text(seal.receipt.id) && text(seal.receipt.connectionId) && text(seal.receipt.requestKey) && text(seal.receipt.content)
    && seal.receipt.role === "repair-verifier";
}
export function isRepairVerificationState(value: unknown): value is RepairVerificationState {
  try {
    const v = value as RepairVerificationState;
    return !!v && [v.producers, v.requests, v.runs, v.arbitrations, v.applications, v.rejected].every(Array.isArray)
      && v.producers.every(p => text(p.producerKeyId) && text(p.publicKey) && text(p.principal))
      && v.requests.every(r => text(r.id) && !!r.capsule && identityValid(r.capsule.orchestrator)
        && Array.isArray(r.capsule.claims) && Array.isArray(r.capsule.sort.coverage) && Array.isArray(r.capsule.evidence.coverage)
        && r.capsule.claims.every(c => text(c.id) && text(c.findingId) && text(c.text) && text(c.eventId))
        && r.capsule.sort.coverage.every(c => text(c.findingId) && Array.isArray(c.claimIds) && c.claimIds.every(text))
        && Array.isArray(r.capsule.targets) && r.capsule.targets.every(t => text(t.findingId) && text(t.openEpoch) && text(t.claimHash))
        && !!r.capsule.code && typeof r.capsule.code.diff === "string" && ["available", "unknown"].includes(r.capsule.code.availability)
        && [r.capsule.code.witnessCommit,r.capsule.code.baseCommit,r.capsule.code.fixCommit].every(sha)
        && text(r.capsule.scope) && text(r.capsule.rulingContext) && r.capsuleHash === repairVerificationHash(r.capsule) && sealShape(r.seal))
      && v.runs.every(r => text(r.id) && text(r.requestId) && text(r.capsuleHash) && identityValid(r.identity)
        && text(r.connectionId) && [1, 2].includes(r.slot) && Array.isArray(r.results) && sealShape(r.seal)
        && r.results.every(result => {
          const request = v.requests.find(q => q.id === r.requestId);
          return !!request && resultError(result, request.capsule) === undefined;
        }))
      && v.arbitrations.every(r => text(r.id) && text(r.requestId) && identityValid(r.identity) && Array.isArray(r.runIds) && r.runIds.length === 2 && r.runIds.every(text) && Array.isArray(r.addresses) && r.addresses.every(a => text(a.findingId) && text(a.claimId) && text(a.reason) && verdicts.includes(a.verdict)) && sealShape(r.seal))
      && v.applications.every(a => text(a.id) && text(a.requestId) && text(a.findingId) && text(a.openEpoch) && text(a.claimHash) && text(a.contextHash) && text(a.reason) && ["fixed", "factually-refuted"].includes(a.outcome) && sealShape(a.seal))
      && v.rejected.every(r => text(r.eventId) && text(r.reason));
  } catch { return false; }
}

/** Checks immutable verification binding; the application fold also checks current authority and code. */
export function repairVerificationApplicationError(records: RepairVerificationRecords, application: RepairVerificationApplication): string | undefined {
  const request = records.requests.find(x => x.id === application.requestId);
  const target = request?.capsule.targets.find(x => x.findingId === application.findingId);
  if (!request || request.capsuleHash !== application.capsuleHash || !target || target.openEpoch !== application.openEpoch || target.claimHash !== application.claimHash
    || application.contextHash !== repairVerificationHash(request.capsule.rulingContext) || !text(application.reason)) return "application does not bind immutable request and issue epoch";
  if (request.capsule.code.availability !== "available") return "checked code is unavailable";
  const decision = repairVerificationDecision(records, request.id, application.findingId);
  if (!decision.complete || decision.verdict !== application.outcome) return "application needs complete independent matching repair verdict";
}

export function repairVerificationSnapshotError(events: LogEvent[], capsule: RepairVerificationCapsule): string | undefined {
  const records = foldRepairRecords(events);
  const sort = records.sorts.find(s => s.input.id === capsule.sort.id);
  const evidence = records.evidence.find(s => s.input.id === capsule.evidence.id);
  if (!sort?.current || !sort.eligible || repairVerificationHash(sort.input) !== repairVerificationHash(capsule.sort)) return "request sort is missing, ineligible or changed";
  if (!evidence || evidence.staleReasons.length || repairVerificationHash(evidence.input) !== repairVerificationHash(capsule.evidence)) return "request evidence is missing, stale or changed";
  if (capsule.claims.some(c => !c.parentId && sha(c.asFiled?.sourceRef) && c.asFiled!.sourceRef !== capsule.evidence.witnessCommit)) return "witness commit conflicts with immutable as-filed source";
  const findings = new Set(capsule.sort.coverage.map(r => r.findingId));
  const claims = records.claims.filter(c => findings.has(c.findingId));
  if (repairVerificationHash(claims) !== repairVerificationHash(capsule.claims)) return "request must preserve exact original and decomposed claims";
}
