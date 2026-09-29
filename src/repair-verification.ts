import { createHash } from "node:crypto";
import { sortEvents, type LogEvent } from "./eventlog.js";
import { canonical } from "./transcript.js";
import { foldRepairRecords } from "./repair-records.js";
import type { RepairClaim, RepairSortInput, RepairEvidenceInput, RepairExecution, RepairCoverage } from "./repair-records.js";
import { verifierIdentityKey, type VerifierIdentity } from "./verifier-boundary.js";

export type RepairVerdict = "fixed" | "factually-refuted" | "invalid" | "decision-needed" | "unknown";
export interface RepairVerificationCapsule {
  scope: string;
  targets: { findingId: string; openEpoch: string; claimHash: string }[];
  code: { witnessCommit: string; baseCommit: string; fixCommit: string; touched: { path: string; before: string; after: string }[]; availability: "available" | "unknown"; reason?: string };
  claims: RepairClaim[];
  sort: RepairSortInput;
  evidence: RepairEvidenceInput;
  rulingContext: string;
  orchestrator: VerifierIdentity;
}
export interface RepairVerificationRequest { id: string; capsule: RepairVerificationCapsule; capsuleHash: string }
export interface RepairClaimVerdict {
  findingId: string; claimId: string; verdict: RepairVerdict; reason: string;
  grade: "executable" | "inspection" | "none";
  executions: RepairExecution[];
  inspected: { source: string; commit: string; reasoning: string }[];
  noCheckReason?: string;
  /** Why the pinned check actually tests the claim — or that it does not (plan 3.3, "real basis"). */
  basis?: { tests: boolean; reason: string };
  /** A pattern's sites, from the SORT: each fixed (no bug) or filed as a bug (plan 3.4). */
  sites?: { site: string; bug?: string }[];
}
export interface RepairVerificationRun {
  id: string; requestId: string; capsuleHash: string; slot: 1 | 2; identity: VerifierIdentity; results: RepairClaimVerdict[];
}
export interface RepairVerificationArbitration {
  id: string; requestId: string; capsuleHash: string; identity: VerifierIdentity;
  runIds: [string, string];
  addresses: { findingId: string; claimId: string; reason: string; verdict: RepairVerdict }[];
}
export interface RepairVerificationApplication {
  id: string; requestId: string; capsuleHash: string; findingId: string; openEpoch: string; claimHash: string;
  outcome: "fixed" | "factually-refuted" | "invalid"; contextHash: string; reason: string; identity: VerifierIdentity;
}
export interface RepairVerificationRecords {
  requests: RepairVerificationRequest[]; runs: RepairVerificationRun[];
  arbitrations: RepairVerificationArbitration[]; applications: RepairVerificationApplication[]; rejected: { eventId: string; reason: string }[];
}

export const repairVerificationHash = (value: unknown): string => createHash("sha256").update(canonical(value) ?? "null").digest("hex");

const text = (s: unknown): s is string => typeof s === "string" && !!s.trim();
const sha = (s: unknown) => typeof s === "string" && /^[a-f0-9]{40,64}$/.test(s);
const identityValid = (i: VerifierIdentity | undefined): i is VerifierIdentity => !!i && [i.principal, i.session].every(text)
  && (i.harness === "mcp" ? i.child === undefined : i.harness === "claude-subagent" && text(i.child));
const verdicts = ["fixed", "factually-refuted", "invalid", "decision-needed", "unknown"];
const key = (v: { findingId: string; claimId: string }) => JSON.stringify([v.findingId, v.claimId]);
const coverageKeys = (coverage: RepairCoverage[]) => coverage.flatMap((c) => c.claimIds.map((claimId) => key({ findingId: c.findingId, claimId })));

/**
 * The evidence bar (owner, 2026-09-28, "Your approved bar only"): for "fixed", the verifier itself
 * observes a check fail at the witness and pass at the fix — the same command, both recorded by
 * the verifier, never an echo of the fixer's outcomes. Every check the fixer pinned is one the
 * verifier must run that way. A factual refutation needs an execution at the witness that passes.
 */
export function resultError(r: RepairClaimVerdict, c: RepairVerificationCapsule): string | undefined {
  if (!r || !text(r.reason) || !verdicts.includes(r.verdict) || !["executable", "inspection", "none"].includes(r.grade)
    || !Array.isArray(r.executions) || !Array.isArray(r.inspected)) return "invalid claim verdict";
  if (!coverageKeys(c.sort.coverage).includes(key(r))) return "verdict exceeds immutable coverage";
  if (r.executions.some((x) => !text(x.id) || !text(x.command) || !text(x.environment) || !sha(x.commit)
    || !["witness", "fix", "regression"].includes(x.phase) || !["passed", "failed", "unknown"].includes(x.outcome)
    || (x.outcome === "unknown" ? !text(x.reason) : !Number.isInteger(x.exitCode))
    || (x.outcome === "passed" && x.exitCode !== 0) || (x.outcome === "failed" && x.exitCode === 0))) return "execution requires an actual consistent result";
  if (r.inspected.some((x) => !text(x.source) || ![c.evidence.witnessCommit, c.evidence.fixCommit].includes(x.commit) || !text(x.reasoning))) return "inspection must bind the witness or fix commit";
  if (r.verdict !== "fixed" && r.verdict !== "factually-refuted" && r.verdict !== "invalid") return undefined;
  if (r.verdict !== "fixed" && c.sort.refutationSubtype === "scope") return "code evidence cannot refute a scope or requirement judgment";
  if (r.verdict === "invalid" && c.sort.refutationSubtype !== "assumed") return "only a reviewer's refuted assumption closes as invalid";
  if (r.verdict === "factually-refuted" && c.sort.refutationSubtype === "assumed") return "a refuted assumption closes as invalid, not as a factual refutation";
  const refutes = r.verdict !== "fixed";
  // Every site the arbitrated sort lists is fixed or filed as a bug — the sort is the coverage
  // authority, never the evidence's own enumeration (plan 3.4). The fold checks the field is
  // there; the op checks each bug (R4's accepted gap).
  if (c.sort.kind === "pattern" && r.verdict === "fixed") {
    const sites = c.sort.sites ?? [];
    if (!Array.isArray(r.sites) || r.sites.length !== sites.length || new Set(r.sites.map((s) => s?.site)).size !== sites.length
      || !sites.every((site) => r.sites!.some((s) => s?.site === site))) return "a pattern closes only with a disposition for every site its sort lists";
    if (r.sites.some((s) => s.bug !== undefined && !text(s.bug))) return "a site filed as a bug names the bug";
  }
  const observed = (command: string, commit: string, phase: string, outcome: string) =>
    r.executions.some((x) => x.command === command && x.commit === commit && x.phase === phase && x.outcome === outcome);
  // A check the fixer could not run (outcome unknown) pins nothing: inspection stays open.
  const pinned = [...new Set(c.evidence.reproducer.filter((x) => x.outcome !== "unknown").map((x) => x.command))];
  if (r.grade === "inspection") {
    if (!text(r.noCheckReason) || !r.inspected.length) return "inspection closure needs an explicit no-check reason and inspected evidence";
    const commit = refutes ? c.evidence.witnessCommit : c.evidence.fixCommit;
    if (!r.inspected.some((x) => x.commit === commit)) return refutes
      ? "a refutation must inspect the witness commit" : "fixed must inspect the fix commit";
    // A refuted assumption is often shown by reading, so it may inspect whatever was pinned (R4).
    if (pinned.length && r.verdict !== "invalid") return "the fixer pinned a check, so the verifier must run it rather than inspect";
    return undefined;
  }
  if (r.grade !== "executable") return "closure needs executable or explicit inspection evidence";
  if (refutes) {
    // Real basis (plan 3.3): the verifier says why the pinned check tests the claim, then runs it
    // at the OLD code, where it must show no defect. Any other passing command proves nothing.
    if (!r.basis || typeof r.basis.tests !== "boolean" || !text(r.basis.reason)) return "a refutation states whether and why the pinned check tests the claim";
    if (!r.basis.tests) return "a check that does not test the claim cannot refute it: inspect, or return unknown";
    if (!pinned.length) return "with no pinned check, a refutation is an inspection with a written reason";
    return pinned.every((command) => observed(command, c.evidence.witnessCommit, "witness", "passed"))
      ? undefined : "a refutation needs the verifier's own passing run of each pinned check at the witness commit";
  }
  const commands = pinned.length ? pinned : [...new Set(r.executions.map((x) => x.command))];
  const both = (command: string) => observed(command, c.evidence.witnessCommit, "witness", "failed") && observed(command, c.evidence.fixCommit, "fix", "passed");
  if (!commands.length || (pinned.length ? !pinned.every(both) : !commands.some(both)))
    return "fixed needs the verifier's own observation of the check failing at the witness and passing at the fix";
  return undefined;
}

export function foldRepairVerification(events: LogEvent[]): RepairVerificationRecords {
  const out = emptyRepairVerificationState();
  const ordered = sortEvents(events);
  for (const [at, e] of ordered.entries()) {
    if (!["repair.verification-requested", "repair.verification-recorded", "repair.verification-arbitrated", "finding.repairApplied"].includes(e.kind)) continue;
    const d = e.data as unknown as RepairVerificationRequest & RepairVerificationRun & RepairVerificationArbitration & RepairVerificationApplication;
    let error: string | undefined;
    try {
      const identity = e.kind === "repair.verification-requested" ? d?.capsule?.orchestrator : d?.identity;
      if (!d || !text(d.id) || (e.kind === "finding.repairApplied" ? d.findingId !== e.subject : d.id !== e.subject)
        || !identityValid(identity) || identity.principal !== e.actor.principal) error = "work must name the identity it arrived with";
      else if (e.kind === "repair.verification-requested") {
        const c = d.capsule;
        if (!text(c.scope) || !text(c.rulingContext) || !Array.isArray(c.claims) || !c.claims.length
          || !Array.isArray(c.targets) || !c.targets.length || c.targets.some((t) => !text(t.findingId) || !text(t.openEpoch) || !text(t.claimHash))
          || !c.code || c.code.witnessCommit !== c.evidence?.witnessCommit || c.code.baseCommit !== c.evidence.baseCommit || c.code.fixCommit !== c.evidence.fixCommit
          || !Array.isArray(c.code.touched) || c.code.touched.some((x) => !text(x?.path) || !sha(x.before) || !sha(x.after)) || !["available", "unknown"].includes(c.code.availability) || (c.code.availability === "unknown" && !text(c.code.reason))
          || !c.sort || c.evidence.sortId !== c.sort.id || !Array.isArray(c.sort.coverage) || !c.sort.coverage.length
          || ![c.evidence.witnessCommit, c.evidence.baseCommit, c.evidence.fixCommit].every(sha)
          || d.capsuleHash !== repairVerificationHash(c)) error = "invalid immutable request capsule";
        else if (coverageKeys(c.sort.coverage).some((k) => !c.claims.some((claim) => key({ findingId: claim.findingId, claimId: claim.id }) === k && text(claim.text)))
          || new Set(coverageKeys(c.sort.coverage)).size !== coverageKeys(c.sort.coverage).length) error = "request needs exact immutable claim coverage";
        else if (out.requests.some((x) => x.id === d.id)) error = "request is immutable";
        else error = repairVerificationSnapshotError(ordered.slice(0, at), c);
        if (!error) out.requests.push(structuredClone(d));
      } else {
        const request = out.requests.find((x) => x.id === d.requestId);
        if (!request || request.capsuleHash !== d.capsuleHash) error = "unknown or changed verification request";
        else if (e.kind === "finding.repairApplied") {
          const workers = [...out.runs.filter((x) => x.requestId === d.requestId), ...out.arbitrations.filter((x) => x.requestId === d.requestId)];
          if (workers.some((x) => verifierIdentityKey(x.identity) === verifierIdentityKey(d.identity))) error = "a verifier cannot apply the verdict it gave";
          else error = repairVerificationApplicationError(out, d) ?? repairVerificationSnapshotError(ordered.slice(0, at), request.capsule);
          // One-shot is spent in the FINDINGS arm, only when a closure actually happens (F34):
          // this fold cannot see whether the finding closed, and must not call that fold.
          if (!error) out.applications.push(structuredClone(d));
        } else {
          // What the fold can see (R2): the requester never verifies, and the two runs are distinct.
          if (verifierIdentityKey(d.identity) === verifierIdentityKey(request.capsule.orchestrator)) error = "the orchestrator cannot verify its own request";
          else if (e.kind === "repair.verification-recorded") {
            const previous = out.runs.filter((x) => x.requestId === d.requestId);
            if (![1, 2].includes(d.slot) || previous.some((x) => x.slot === d.slot || x.id === d.id || verifierIdentityKey(x.identity) === verifierIdentityKey(d.identity))) error = "each of the two blind slots needs its own verifier";
            else if (!Array.isArray(d.results) || !d.results.length || new Set(d.results.map(key)).size !== d.results.length) error = "run needs unique per-claim outcomes";
            else error = d.results.map((r) => resultError(r, request.capsule)).find(Boolean);
            if (!error) out.runs.push(structuredClone(d));
          } else {
            const runs = out.runs.filter((x) => x.requestId === d.requestId);
            if (runs.length !== 2 || !Array.isArray(d.runIds) || d.runIds.length !== 2 || new Set(d.runIds).size !== 2 || runs.some((x) => !d.runIds.includes(x.id))) error = "arbitration requires both runs";
            else if (runs.some((x) => verifierIdentityKey(x.identity) === verifierIdentityKey(d.identity))) error = "the arbitrator must be a third verifier";
            else {
              const conflicts = repairVerificationDisagreements(runs[0]!, runs[1]!);
              if (!conflicts.length || !Array.isArray(d.addresses) || d.addresses.length !== conflicts.length
                || new Set(d.addresses.map(key)).size !== d.addresses.length
                || conflicts.some((x) => !d.addresses.some((a) => key(a) === key(x) && text(a.reason) && !/^(agree|agreed|agreement|fixed|refuted|yes|no)[.! ]*$/i.test(a.reason) && verdicts.includes(a.verdict)))) error = "arbitration must substantively address every actual disagreement";
              else if (out.arbitrations.some((x) => x.requestId === d.requestId || x.id === d.id)) error = "arbitration is immutable";
              else out.arbitrations.push(structuredClone(d));
            }
          }
        }
      }
    } catch { error = "malformed verification event"; }
    if (error) out.rejected.push({ eventId: e.id, reason: error });
  }
  return out;
}

export function repairVerificationDisagreements(a: RepairVerificationRun, b: RepairVerificationRun): { findingId: string; claimId: string }[] {
  const all = new Map([...a.results, ...b.results].map((r) => [key(r), { findingId: r.findingId, claimId: r.claimId }]));
  return [...all.values()].filter((r) => a.results.find((x) => key(x) === key(r))?.verdict !== b.results.find((x) => key(x) === key(r))?.verdict);
}

export interface RepairDecision {
  verdict: RepairVerdict; complete: boolean; grade: "executable" | "inspection" | "none";
  reasons: string[];
}

export function repairVerificationDecision(records: RepairVerificationRecords, requestId: string, findingId: string): RepairDecision {
  const request = records.requests.find((x) => x.id === requestId);
  const runs = records.runs.filter((x) => x.requestId === requestId);
  const unresolved = (reason: string): RepairDecision => ({ verdict: "unknown", complete: false, grade: "none", reasons: [reason] });
  if (!request || runs.length !== 2) return unresolved("two independent runs are required");
  const claims = request.capsule.claims.filter((x) => x.findingId === findingId);
  if (!claims.length) return unresolved("finding is outside immutable request");
  const arbitration = records.arbitrations.find((x) => x.requestId === requestId);
  if (!["mechanical", "implementation-defect", "invalid", "factual-refutation"].includes(request.capsule.sort.classification)
    || request.capsule.sort.refutationSubtype === "scope") return { verdict: "decision-needed", complete: false, grade: "none", reasons: ["sort requires a requirement or scope decision"] };
  const outcomes: RepairVerdict[] = [];
  let inspection = false;
  for (const claim of claims) {
    const a = runs[0]!.results.find((x) => x.findingId === findingId && x.claimId === claim.id);
    const b = runs[1]!.results.find((x) => x.findingId === findingId && x.claimId === claim.id);
    if (!a || !b) return unresolved("partial coverage cannot resolve a whole finding");
    const result = a.verdict === b.verdict ? a.verdict : arbitration?.addresses.find((x) => x.findingId === findingId && x.claimId === claim.id)?.verdict;
    if (!result) return unresolved("disagreement awaits substantive arbitration");
    const closes = (v: RepairVerdict) => v === "fixed" || v === "factually-refuted" || v === "invalid";
    if (closes(result) && ![a, b].every((x) => x.grade !== "none" && closes(x.verdict))) return unresolved("arbitration cannot manufacture missing independent repair evidence");
    inspection ||= a.grade === "inspection" || b.grade === "inspection";
    outcomes.push(result);
  }
  if (outcomes.includes("decision-needed")) return { verdict: "decision-needed", complete: false, grade: "none", reasons: ["requirement or scope decision remains"] };
  if (outcomes.includes("unknown")) return unresolved("unknown never closes or automatically reopens");
  if (outcomes.includes("invalid") && !outcomes.every((x) => x === "invalid")) return unresolved("a finding's claims disagree on whether it was ever real");
  return { verdict: outcomes.every((x) => x === "factually-refuted") ? "factually-refuted" : outcomes.every((x) => x === "invalid") ? "invalid" : "fixed", complete: true,
    grade: inspection ? "inspection" : "executable", reasons: [] };
}

/**
 * Runs from EARLIER requests on the same fix that did not come back fixed — shown beside a new
 * request, so asking again cannot bury an unfavourable result (owner: "a new request on the
 * same fix shows the earlier unfavourable runs next to it"). Never shown in a verifier's brief.
 */
export function earlierUnfavourableRuns(records: RepairVerificationRecords, requestId: string): RepairVerificationRun[] {
  const request = records.requests.find((x) => x.id === requestId);
  if (!request) return [];
  const at = records.requests.indexOf(request);
  const earlier = new Set(records.requests.slice(0, at).filter((x) => x.capsule.evidence.fixCommit === request.capsule.evidence.fixCommit
    && x.capsule.sort.coverage.some((c) => request.capsule.sort.coverage.some((own) => own.findingId === c.findingId))).map((x) => x.id));
  return records.runs.filter((r) => earlier.has(r.requestId) && r.results.some((x) => x.verdict !== "fixed"));
}

export type RepairVerificationState = RepairVerificationRecords;
export const emptyRepairVerificationState = (): RepairVerificationState => ({ requests: [], runs: [], arbitrations: [], applications: [], rejected: [] });
export function isRepairVerificationState(value: unknown): value is RepairVerificationState {
  try {
    const v = value as RepairVerificationState;
    return !!v && [v.requests, v.runs, v.arbitrations, v.applications, v.rejected].every(Array.isArray)
      && v.requests.every((r) => text(r.id) && !!r.capsule && identityValid(r.capsule.orchestrator)
        && Array.isArray(r.capsule.claims) && Array.isArray(r.capsule.sort?.coverage) && Array.isArray(r.capsule.evidence?.coverage)
        && Array.isArray(r.capsule.targets) && !!r.capsule.code && Array.isArray(r.capsule.code.touched)
        && text(r.capsule.scope) && text(r.capsule.rulingContext) && r.capsuleHash === repairVerificationHash(r.capsule))
      && v.runs.every((r) => text(r.id) && text(r.requestId) && text(r.capsuleHash) && identityValid(r.identity) && [1, 2].includes(r.slot) && Array.isArray(r.results))
      && v.arbitrations.every((r) => text(r.id) && text(r.requestId) && identityValid(r.identity) && Array.isArray(r.runIds) && r.runIds.length === 2 && Array.isArray(r.addresses))
      && v.applications.every((a) => text(a.id) && text(a.requestId) && text(a.findingId) && text(a.openEpoch) && text(a.claimHash) && text(a.contextHash) && text(a.reason)
        && ["fixed", "factually-refuted", "invalid"].includes(a.outcome) && identityValid(a.identity))
      && v.rejected.every((r) => text(r.eventId) && text(r.reason));
  } catch { return false; }
}

/**
 * Checks the immutable verification binding, the capsule's RECORDED code availability, and a
 * complete matching verdict. Current ruling authority and the current code are checked only by the
 * op (`applyRepairVerification` re-derives the capsule); the findings fold adds the open epoch,
 * the claim hash and contest, and nothing about authority (B6: F30).
 */
export function repairVerificationApplicationError(records: RepairVerificationRecords, application: RepairVerificationApplication): string | undefined {
  const request = records.requests.find((x) => x.id === application.requestId);
  const target = request?.capsule.targets.find((x) => x.findingId === application.findingId);
  if (!request || request.capsuleHash !== application.capsuleHash || !target || target.openEpoch !== application.openEpoch || target.claimHash !== application.claimHash
    || application.contextHash !== repairVerificationHash(request.capsule.rulingContext) || !text(application.reason)) return "application does not bind immutable request and issue epoch";
  if (request.capsule.code.availability !== "available") return "checked code is unavailable";
  const decision = repairVerificationDecision(records, request.id, application.findingId);
  if (!decision.complete || decision.verdict !== application.outcome) return "application needs complete independent matching repair verdict";
}

export function repairVerificationSnapshotError(events: LogEvent[], capsule: RepairVerificationCapsule): string | undefined {
  const records = foldRepairRecords(events);
  const sort = records.sorts.find((s) => s.input.id === capsule.sort.id);
  const evidence = records.evidence.find((s) => s.input.id === capsule.evidence.id);
  if (!sort?.current || !sort.eligible || repairVerificationHash(sort.input) !== repairVerificationHash(capsule.sort)) return "request sort is missing, ineligible or changed";
  if (!evidence || evidence.staleReasons.length || repairVerificationHash(evidence.input) !== repairVerificationHash(capsule.evidence)) return "request evidence is missing, stale or changed";
  const findings = new Set(capsule.sort.coverage.map((r) => r.findingId));
  const claims = records.claims.filter((c) => findings.has(c.findingId));
  if (repairVerificationHash(claims) !== repairVerificationHash(capsule.claims)) return "request must preserve exact original and decomposed claims";
}
