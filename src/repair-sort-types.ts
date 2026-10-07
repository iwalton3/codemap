import type { Actor, BugWitness } from "./schema.js";

export interface RepairClaim { id: string; findingId: string; text: string; parentId?: string; eventId: string; actor: Actor; at: string; reason?: string; witness?: BugWitness; asFiled?: Record<string, unknown> }
export interface RepairCoverage { findingId: string; claimIds: string[] }
/** Who sorted, as the skill's own sort record reports it. Provenance to read, not a credential:
 *  `session` is the posting MCP connection's, `child` the subagent id the caller reports (D4). */
export interface ReportedSorter { principal: string; session: string; child?: string }
export interface ReportedSortReceipt { id: string; source: string; content: string }
export interface RepairAssessment { identity: ReportedSorter; classification: string; reason: string; receipt?: ReportedSortReceipt }
export interface RepairSortInput {
  id: string; prior?: string;
  /** Several sorts this one replaces at once (owner, O19); `prior` is the one-sort form. */
  priors?: string[];
  reason?: string; classification: string; kind: "isolated" | "pattern";
  coverage: RepairCoverage[]; predicate?: string; sites?: string[]; refutationSubtype?: "factual" | "scope" | "assumed";
  /** What the sort waits on: a free label, or `decision:<decision id>` — the question that decides it (owner, D2). */
  restsOn: string[]; source: string; provenance: "owner-reviewed" | "dual-sorted" | "released";
  assessments: RepairAssessment[]; disagreements: { id: string; text: string }[];
  arbitration?: { addresses: string[]; reason: string; identity: ReportedSorter; receipt?: ReportedSortReceipt };
  /** A logged decisions answer on why the sites or claims this correction removes are not instances (R5, plan 5.2). */
  ruling?: string;
  /** Only on a `released` sort, built by `release_held_sort`: the rulings that answered its decision entries, and two readers who found them a solid direction (owner, D2). */
  release?: RepairRelease;
}
export interface ReleaseRuling { decision: string; answer: string; question: string; words: string }
export interface ReleaseReceipt { id: string; request: string; principal: string; session: string; launch: string; briefHash: string; verdict: "yes" | "no"; rationale: string }
export interface RepairRelease { rulings: ReleaseRuling[]; readers: ReleaseReceipt[] }
