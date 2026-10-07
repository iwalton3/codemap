import type { Actor, BugWitness } from "./schema.js";
import { createHash } from "node:crypto";
import { canonical } from "./canonical.js";
import { sortEvents, type LogEvent } from "./eventlog.js";
import { verifierIdentityKey, type VerifierIdentity } from "./verifier-boundary.js";

export type { RepairClaim, RepairCoverage, ReportedSortReceipt, RepairAssessment, RepairSortInput, ReleaseRuling, ReleaseReceipt, RepairRelease } from "./repair-sort-types.js";
import type { RepairClaim, RepairCoverage, ReportedSortReceipt, RepairSortInput, ReleaseRuling, ReleaseReceipt } from "./repair-sort-types.js";
export interface RepairExecution {
  id: string; command: string; commit: string; environment: string;
  phase: "witness" | "fix" | "regression";
  outcome: "passed" | "failed" | "unknown"; exitCode?: number; stdout?: string; stderr?: string; reason?: string;
}
export interface RepairEvidenceInput {
  id: string; sortId: string; witnessCommit: string; baseCommit: string; fixCommit: string;
  coverage: (RepairCoverage & { result: "complete" | "partial" | "unknown"; reason: string; claimResults: { claimId: string; result: "complete" | "partial" | "unknown"; reason: string }[] })[];
  reproducer: RepairExecution[]; regression: RepairExecution[];
  patternEnumeration?: { expected: string[]; actual: string[]; method: string };
  /** Pattern sites the fixer filed with `file_site_bug` instead of fixing. The blind verifier
   *  must report such a site by its bug id and cannot look bugs up, so the brief carries these
   *  (owner, I14 (a): it learns which sites were not fixed). */
  siteBugs?: { findingId: string; site: string; bug: string }[];
  inspected: { source: string; commit: string; reasoning: string }[]; noCheckReason?: string;
  rulingIds: string[]; attribution: { file: string; hunk: string; claimIds: string[] }[];
}
export interface Recorded<T> { input: T; eventId: string; actor: Actor; at: string }
export interface RepairRecords {
  claims: RepairClaim[]; sorts: (Recorded<RepairSortInput> & { eligible: boolean; current: boolean; holds: string[] })[];
  evidence: (Recorded<RepairEvidenceInput> & { staleReasons: string[] })[];
  rejected: { eventId: string; reason: string }[];
}
export type RepairFindingMap<T> = Map<string, T> & { repairRecords?: RepairRecords; repairVerification?: unknown };
export const emptyRepairRecords = (): RepairRecords => ({ claims: [], sorts: [], evidence: [], rejected: [] });
const nonempty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const identity = (v: VerifierIdentity | undefined): boolean => !!v && v.harness === "mcp" && v.child === undefined && [v.principal, v.session].every(nonempty);
const reported = (v: { principal: string; session: string; child?: string } | undefined): boolean => !!v && nonempty(v.principal) && nonempty(v.session)
  && (v.child === undefined || nonempty(v.child));
const unique = (xs: string[]) => new Set(xs).size === xs.length;
const commit = (v: string) => /^[a-f0-9]{40,64}$/.test(v);
const receiptValid = (v: ReportedSortReceipt | undefined) => v === undefined || !!v && [v.id, v.source, v.content].every(nonempty);

/** A `restsOn` entry naming the question that decides the sort (owner, D2); anything else is a free label. */
export const DECISION_ENTRY = "decision:";
export const decisionOfEntry = (x: string): string | undefined => x.startsWith(DECISION_ENTRY) && x.length > DECISION_ENTRY.length ? x.slice(DECISION_ENTRY.length) : undefined;

/**
 * What a release reader reads: the held sort, its claims as filed, and the rulings — nothing of
 * the fixer's (owner, D2). One builder for the op that issues the brief and the fold that checks
 * the readers read it.
 */
export const releaseBriefContent = (prior: Pick<RepairSortInput, "id">, claims: Pick<RepairClaim, "id" | "findingId" | "text" | "asFiled">[], rulings: ReleaseRuling[]) => ({
  purpose: "release-held-sort", sort: prior.id,
  claims: claims.map(({ id, findingId, text, asFiled }) => ({ id, findingId, text, ...(asFiled ? { asFiled } : {}) })),
  rulings: rulings.map(({ decision, answer, question, words }) => ({ decision, answer, question, words })),
});
export const releaseBriefHash = (content: unknown): string => "sha256:" + createHash("sha256").update(canonical(content)).digest("hex");

/**
 * Kinds this fold does not read. RETIRED ones were removed from the design and are skipped, never
 * shown as rejected (plan 3.1: the fixer model went with the grant model, R2); the verification
 * kinds belong to `foldRepairVerification`.
 */
export const RETIRED_REPAIR_KINDS: readonly string[] = ["repair.participant-recorded", "repair.verification-producer", "repair.verification-sealed"];
const VERIFICATION_KINDS: readonly string[] = ["repair.verification-requested", "repair.verification-recorded", "repair.verification-arbitrated"];

/** Every sort a sort replaces: `prior`, and `priors` (owner, O19: "Let a sort name several it replaces"). */
export const priorsOf = (d: Pick<RepairSortInput, "prior" | "priors">): string[] =>
  [...(typeof d.prior === "string" ? [d.prior] : []), ...(Array.isArray(d.priors) ? d.priors : [])];

/** Original claims come from creation, never the finding's mutable current text. */
export function foldRepairRecords(input: LogEvent[]): RepairRecords {
  const out = emptyRepairRecords();
  const events = sortEvents(input);
  const record = <T>(e: LogEvent, data: T): Recorded<T> => ({ input: data, eventId: e.id, actor: e.actor, at: e.at });
  const coverageError = (refs: RepairCoverage[]): string | undefined => {
    if (!Array.isArray(refs) || !refs.length) return "coverage is required";
    for (const ref of refs) {
      if (!Array.isArray(ref.claimIds) || !ref.claimIds.length || !unique(ref.claimIds)) return "claim IDs must be nonempty and unique";
      if (ref.claimIds.some(id => !out.claims.some(c => c.id === id && c.findingId === ref.findingId))) return "coverage must cite immutable as-filed claims";
    }
    if (!unique(refs.map(r => r.findingId))) return "duplicate finding coverage";
  };
  const heads = () => out.sorts.filter(s => !out.sorts.some(next => priorsOf(next.input).includes(s.input.id)));
  const overlaps = (a: RepairSortInput, b: RepairSortInput) =>
    a.coverage.some(ref => b.coverage.some(own => own.findingId === ref.findingId && own.claimIds.some(id => ref.claimIds.includes(id))));
  // The log is linear, so corrections are sequential (plan 5.2): a correction names the CURRENT
  // sort of its claims as prior or is stale, and it supersedes that sort — except that removing
  // coverage the prior had needs a logged ruling on why those are not instances (owner, batch 5:
  // "Narrowing needs a ruling"). Dropping a `restsOn` entry is what releases a held sort, and only
  // two readers do that (`releaseError`, owner D2); a ruling alone releases nothing, or every sort
  // /triage-review holds on a free label could be freed by any ruling-cited reclassification. The
  // one free move is RE-POINTING free labels at the decision that will answer them (owner, Q2).
  const sequenceError = (d: RepairSortInput): string | undefined => {
    const current = heads(), named = priorsOf(d);
    const stale = named.find(p => !current.some(s => s.input.id === p));
    if (stale)
      return `stale correction: ${stale} was already corrected by ${out.sorts.find(s => priorsOf(s.input).includes(stale))!.input.id}; name the current sort as prior`;
    const rival = current.find(s => !named.includes(s.input.id) && overlaps(s.input, d));
    if (rival) return `these claims are already sorted by ${rival.input.id}: correct it by naming it as prior`;
    for (const prior of named.map(p => out.sorts.find(s => s.input.id === p)!.input)) {
      const claims = prior.coverage.flatMap(ref => ref.claimIds.filter(id => !d.coverage.some(own => own.findingId === ref.findingId && own.claimIds.includes(id))));
      const sites = (prior.sites ?? []).filter(site => !(d.sites ?? []).includes(site));
      if (!nonempty(d.ruling) && (claims.length || sites.length))
        return `a correction that removes ${[...claims, ...sites].join(", ")} from ${prior.id} needs a logged ruling citing why they are not instances`;
      const dropped = prior.restsOn.filter(x => !d.restsOn.includes(x));
      if (!dropped.length || d.provenance === "released") continue;
      const repointed = dropped.every(x => !decisionOfEntry(x)) && d.restsOn.some(x => !!decisionOfEntry(x) && !prior.restsOn.includes(x));
      if (!repointed) return `a correction that drops ${dropped.join(", ")} from what ${prior.id} rests on is released only by two readers (release_held_sort); a free label may be re-pointed to the decision:<id> that answers it`;
    }
  };
  // Owner, D2: "If two readers agree on a solid implementation direction approved by clear
  // rulings, it gets unblocked for autonomous fixing" — and, unanimous, with no arbitrator.
  const releaseError = (d: RepairSortInput): string | undefined => {
    const r = d.release;
    if (d.provenance !== "released") return r === undefined ? undefined : "a release belongs only to a released sort";
    const named = priorsOf(d);
    const prior = named.length === 1 ? out.sorts.find(s => s.input.id === named[0])?.input : undefined;
    if (!prior || !r || typeof r !== "object") return "a released sort names the one held sort it releases, and carries the release";
    if (!["mechanical", "implementation-defect"].includes(d.classification)) return "a release settles a sort only as mechanical or implementation-defect";
    if (d.assessments.length || d.disagreements.length || d.arbitration || d.ruling !== undefined || d.refutationSubtype !== undefined)
      return "a released sort's provenance is its two readers alone";
    const shape = (s: RepairSortInput) => canonical({ coverage: s.coverage, kind: s.kind, predicate: s.predicate ?? null, sites: s.sites ?? null });
    if (shape(d) !== shape(prior)) return "a release keeps the held sort's coverage, kind, predicate and sites";
    if (!Array.isArray(r.rulings) || !r.rulings.length || r.rulings.some(x => !x || ![x.decision, x.answer, x.question, x.words].every(nonempty))
      || !unique(r.rulings.map(x => x.decision))) return "a release names one ruling, with its question and words, for each decision it drops";
    const dropped = prior.restsOn.filter(x => !d.restsOn.includes(x));
    if (d.restsOn.some(x => !prior.restsOn.includes(x)) || !dropped.length || dropped.some(x => !decisionOfEntry(x)))
      return "a release drops decision entries only, and adds nothing: re-point a free label to its decision first";
    if (canonical(dropped.map(decisionOfEntry).sort()) !== canonical(r.rulings.map(x => x.decision).sort()))
      return "a release carries exactly the rulings on the decision entries it drops";
    const claims = out.claims.filter(c => prior.coverage.some(ref => ref.findingId === c.findingId && ref.claimIds.includes(c.id)));
    const brief = releaseBriefHash(releaseBriefContent(prior, claims, r.rulings));
    const readers = r.readers as ReleaseReceipt[];
    if (!Array.isArray(readers) || readers.length !== 2 || readers.some(x => !x || ![x.id, x.request, x.principal, x.session, x.launch, x.rationale].every(nonempty)
      || (x.verdict !== "yes" && x.verdict !== "no") || x.briefHash !== brief)) return "a release needs two readers' receipts on this exact brief";
    const [a, b] = readers as [ReleaseReceipt, ReleaseReceipt];
    const key = (x: ReleaseReceipt) => verifierIdentityKey({ principal: x.principal, session: x.session, child: x.launch });
    if (key(a) === key(b) || a.launch === b.launch || a.id === b.id) return "the two release readers were not independently launched";
    if (a.verdict !== "yes" || b.verdict !== "yes") return "a release needs both readers' yes; there is no arbitrator";
  };
  for (const e of events) {
    const d = e.data as any;
    if (e.kind === "finding.created" && nonempty(d?.text) && nonempty(d.targetId) && ["anchor", "node"].includes(d.targetKind) && !out.claims.some(c => c.findingId === e.subject)) {
      out.claims.push({ id: `${e.subject}:original`, findingId: e.subject, text: d.text, eventId: e.id, actor: e.actor, at: e.at,
        asFiled: structuredClone(d), ...(d.witness ? { witness: d.witness } : {}) });
    }
    if (!e.kind.startsWith("repair.") || RETIRED_REPAIR_KINDS.includes(e.kind) || VERIFICATION_KINDS.includes(e.kind)) continue;
    let error: string | undefined;
    try {
      if (e.kind === "repair.claims-recorded") {
        const parent = out.claims.find(c => c.id === d.parentId && c.findingId === d.findingId && !c.parentId);
        if (!parent || !nonempty(d.reason) || !Array.isArray(d.claims) || !d.claims.length) error = "claim decomposition needs an original parent and reason";
        else if (d.claims.some((c: any) => !nonempty(c.id) || !nonempty(c.text) || out.claims.some(p => p.id === c.id)) || !unique(d.claims.map((c: any) => c.id))) error = "claim decomposition cannot replace existing claims";
        else for (const c of d.claims) out.claims.push({ id: c.id, text: c.text, findingId: parent.findingId, parentId: parent.id, eventId: e.id, actor: e.actor, at: e.at, reason: d.reason });
      } else if (e.kind === "repair.sort-recorded") {
        const data = d as RepairSortInput;
        error = coverageError(data.coverage);
        if (!error && (!nonempty(data.id) || data.id !== e.subject || out.sorts.some(s => s.input.id === data.id) || !nonempty(data.classification) || !["isolated", "pattern"].includes(data.kind))) error = "invalid or duplicate sort";
        if (!error && (!Array.isArray(data.restsOn) || !Array.isArray(data.disagreements) || !Array.isArray(data.assessments) || data.assessments.some(a => !reported(a.identity) || !nonempty(a.reason) || !nonempty(a.classification)))) error = "invalid sort provenance";
        if (!error && (data.restsOn.some(x => !nonempty(x)) || data.disagreements.some(x => !x || !nonempty(x.id) || !nonempty(x.text)) || !unique(data.disagreements.map(x => x.id)))) error = "invalid sort dependencies or disagreement";
        if (!error && data.arbitration && (!Array.isArray(data.arbitration.addresses) || data.arbitration.addresses.some(x => !nonempty(x)) || !nonempty(data.arbitration.reason) || !reported(data.arbitration.identity))) error = "arbitration needs addressed disagreements and provenance";
        if (!error && data.sites !== undefined && (!Array.isArray(data.sites) || data.sites.some(x => !nonempty(x)))) error = "sites must be explicit strings";
        if (!error && (data.assessments.some(a => !receiptValid(a.receipt)) || !receiptValid(data.arbitration?.receipt))) error = "reported receipt needs exact content and source";
        if (!error && !["owner-reviewed", "dual-sorted", "released"].includes(data.provenance)) error = "unknown sort provenance";
        if (!error && data.restsOn.some(x => x.startsWith(DECISION_ENTRY) && !decisionOfEntry(x))) error = "a decision entry names its decision: decision:<id>";
        if (!error && data.provenance === "dual-sorted" && data.assessments.length !== 2) error = "dual sorting needs two sorters";
        if (!error && data.provenance === "dual-sorted" && new Set(data.assessments.map(a => verifierIdentityKey(a.identity))).size < 2) error = "dual sorting needs two independent sorters: their identities (session and subagent) must differ";
        if (!error && data.priors !== undefined && (!Array.isArray(data.priors) || !data.priors.length || data.priors.some(p => !nonempty(p)) || !unique(priorsOf(data)))) error = "priors must name distinct sorts";
        if (!error && priorsOf(data).length && (!nonempty(data.reason) || priorsOf(data).some(p => !out.sorts.some(s => s.input.id === p)))) error = "correction needs predecessor and reason";
        if (!error && data.ruling !== undefined && (!nonempty(data.ruling) || !priorsOf(data).length)) error = "a cited ruling belongs to a correction: it names a logged answer and a prior sort";
        if (!error && data.kind === "pattern" && (!nonempty(data.predicate) || !data.sites?.length || !unique(data.sites))) error = "pattern needs predicate and original sites";
        if (!error) error = releaseError(data);
        if (!error) error = sequenceError(data);
        if (!error) out.sorts.push({ ...record(e, data), eligible: false, current: true, holds: [] });
      } else if (e.kind === "repair.evidence-recorded") {
        const data = d as RepairEvidenceInput;
        error = coverageError(data.coverage);
        const sort = out.sorts.find(s => s.input.id === data.sortId);
        if (!error && (!sort || !nonempty(data.id) || data.id !== e.subject || out.evidence.some(p => p.input.id === data.id) || ![data.witnessCommit, data.baseCommit, data.fixCommit].every(commit))) error = "evidence needs existing sort and immutable commits";
        if (!error && data.coverage.some(c => !["complete", "partial", "unknown"].includes(c.result) || !nonempty(c.reason) || c.claimIds.some(id => !sort!.input.coverage.some(r => r.findingId === c.findingId && r.claimIds.includes(id))))) error = "evidence exceeds sorted coverage or omits result reason";
        if (!error && ![data.reproducer, data.regression, data.inspected, data.rulingIds, data.attribution].every(Array.isArray)) error = "structured evidence fields are required";
        if (!error && [...data.reproducer, ...data.regression].some(x => !nonempty(x.command) || !commit(x.commit) || !nonempty(x.environment) || !["passed", "failed", "unknown"].includes(x.outcome) || (x.outcome === "unknown" ? !nonempty(x.reason) : !Number.isInteger(x.exitCode)))) error = "execution needs actual result or explicit unknown reason";
        if (!error && data.coverage.some(c => !Array.isArray(c.claimResults) || !unique(c.claimResults.map(r => r.claimId)) || c.claimResults.some(r => !c.claimIds.includes(r.claimId) || !["complete", "partial", "unknown"].includes(r.result) || !nonempty(r.reason)))) error = "per-claim outcomes must cite covered claims and explicit reasons";
        if (!error && [...data.reproducer, ...data.regression].some(x => !["witness", "fix", "regression"].includes(x.phase))) error = "execution phase is required";
        if (!error && data.reproducer.some(x => !["witness", "fix"].includes(x.phase))) error = "reproducer runs distinguish witness from fix";
        if (!error && data.regression.some(x => x.phase !== "regression")) error = "regression runs have a separate phase";
        if (!error && !unique(data.rulingIds)) error = "ruling IDs must be unique";
        if (!error && data.rulingIds.some(x => !nonempty(x))) error = "ruling IDs must be nonempty";
        // So the blind brief carries every ruling the sort rests on, and verification re-checks
        // their authority at request and at application (I2, D2).
        const rests = [...(nonempty(sort?.input.ruling) ? [sort!.input.ruling] : []), ...(sort?.input.release?.rulings ?? []).map(x => x.answer)];
        const unlisted = rests.find(x => !data.rulingIds.includes(x));
        if (!error && unlisted) error = `evidence for a sort that rests on ruling ${unlisted} must list it in rulingIds`;
        if (!error && data.attribution.some(x => !nonempty(x.file) || !nonempty(x.hunk) || !Array.isArray(x.claimIds) || x.claimIds.some(id => !data.coverage.some(c => c.claimIds.includes(id))))) error = "attribution must cite covered claims";
        const pe = data.patternEnumeration;
        if (!error && pe && (!nonempty(pe.method) || !Array.isArray(pe.expected) || !Array.isArray(pe.actual)
          || !unique(pe.expected) || !unique(pe.actual) || [...pe.expected, ...pe.actual].some(x => !nonempty(x))))
          error = "pattern enumeration needs method and unique sites";
        const sb = data.siteBugs;
        if (!error && sb !== undefined && (!Array.isArray(sb) || sb.some(x => !x || ![x.findingId, x.site, x.bug].every(nonempty)
          || !sort!.input.coverage.some(r => r.findingId === x.findingId) || !(sort!.input.sites ?? []).includes(x.site))
          || !unique(sb.map(x => `${x.findingId}\0${x.site}`))))
          error = "a site bug names a covered finding and one of the sort's sites, once";
        if (!error && data.noCheckReason !== undefined && !nonempty(data.noCheckReason)) error = "no-check reason must be explicit";
        if (!error && data.inspected.some(x => !nonempty(x.source) || !commit(x.commit) || !nonempty(x.reasoning))) error = "inspection needs pinned source and reasoning";
        if (!error) out.evidence.push({ ...record(e, data), staleReasons: [] });
      } else error = "unknown repair event";
    } catch { error = "malformed repair event"; }
    if (error) out.rejected.push({ eventId: e.id, reason: error });
  }
  const current = heads();
  for (const sort of out.sorts) {
    const d = sort.input;
    sort.current = current.includes(sort);
    if (!sort.current) sort.holds.push("superseded sort retained as history");
    if (d.provenance === "dual-sorted") {
      const disagreement = new Set(d.assessments.map(a => a.classification)).size > 1;
      if (disagreement && !d.disagreements.length) sort.holds.push("sorter classification disagreement is not recorded");
      if (!disagreement && d.assessments.some(a => a.classification !== d.classification)) sort.holds.push("sort classification does not match the sorters' classification");
      if (disagreement && !d.arbitration) sort.holds.push("sorter classification disagreement requires arbitration");
      if (d.arbitration && d.assessments.some(a => verifierIdentityKey(a.identity) === verifierIdentityKey(d.arbitration!.identity))) sort.holds.push("the arbitrator must be a third reader");
    }
    if (d.provenance === "owner-reviewed" && (!nonempty(d.source) || sort.actor.via?.kind === "agent")) sort.holds.push("owner worklist requires principal authorship and exact source");
    // A reviewer's refuted assumption ("invalid, assumed") closes through verification too (R4); an
    // assumption IN THE CODE is a real finding, never invalid (owner, batch 8, 5).
    if (!["mechanical", "implementation-defect"].includes(d.classification) && !(d.refutationSubtype === "factual" && ["invalid", "factual-refutation"].includes(d.classification))
      && !(d.refutationSubtype === "assumed" && d.classification === "invalid")) sort.holds.push("classification requires an explicit decision or factual basis");
    if (d.refutationSubtype === "scope") sort.holds.push("scope judgment cannot be settled as factual refutation");
    if (d.restsOn.length) sort.holds.push("requirement or ruling dependency remains explicit");
    if (d.disagreements.length && (!d.arbitration || !nonempty(d.arbitration.reason) || !reported(d.arbitration.identity) || d.disagreements.some(x => !d.arbitration!.addresses.includes(x.id)))) sort.holds.push("unaddressed sort disagreement");
    sort.eligible = !sort.holds.length;
  }
  for (const evidence of out.evidence) {
    const sort = out.sorts.find(s => s.input.id === evidence.input.sortId)!;
    if (!sort.current) evidence.staleReasons.push("evidence references a superseded sort");
    const atEvidence = events.findIndex(e => e.id === evidence.eventId);
    if (out.claims.some(claim => evidence.input.coverage.some(ref => ref.findingId === claim.findingId) && events.findIndex(e => e.id === claim.eventId) > atEvidence)) evidence.staleReasons.push("claim decomposition was recorded after this evidence");
  }
  return out;
}

export function repairFindingCompleteness(records: RepairRecords, evidenceId: string, findingId: string): "complete" | "partial" | "unknown" {
  const evidence = records.evidence.find(e => e.input.id === evidenceId)?.input;
  const ref = evidence?.coverage.find(c => c.findingId === findingId);
  if (!ref || ref.result === "unknown") return "unknown";
  const sort = records.sorts.find(s => s.input.id === evidence!.sortId)?.input;
  if (sort?.kind === "pattern") {
    const enumeration = evidence!.patternEnumeration;
    if (!enumeration) return "unknown";
    if (sort.sites!.some(site => !enumeration.expected.includes(site) || !enumeration.actual.includes(site))) return "partial";
  }
  const claims = records.claims.filter(c => c.findingId === findingId);
  return ref.result === "complete" && claims.every(c => ref.claimResults.some(r => r.claimId === c.id && r.result === "complete")) ? "complete" : "partial";
}


export function isRepairRecords(value: unknown): value is RepairRecords {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<RepairRecords>;
  return Array.isArray(v.claims) && Array.isArray(v.sorts) && Array.isArray(v.evidence) && Array.isArray(v.rejected)
    && v.claims.every(c => !!c && nonempty(c.id) && nonempty(c.findingId) && nonempty(c.text))
    && v.sorts.every(s => !!s && !!s.input && Array.isArray(s.input.coverage) && Array.isArray(s.holds) && typeof s.current === "boolean" && typeof s.eligible === "boolean")
    && v.evidence.every(e => !!e && !!e.input && Array.isArray(e.input.coverage) && Array.isArray(e.staleReasons))
    && v.rejected.every(r => !!r && nonempty(r.eventId) && nonempty(r.reason));
}
