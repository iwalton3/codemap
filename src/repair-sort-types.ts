import type { Actor, BugWitness } from "./schema.js";

export interface RepairClaim { id: string; findingId: string; text: string; parentId?: string; eventId: string; actor: Actor; at: string; reason?: string; witness?: BugWitness; asFiled?: Record<string, unknown> }
export interface RepairCoverage { findingId: string; claimIds: string[] }
/** Who sorted, as the skill's own sort record reports it. Provenance to read, not a credential. */
export interface ReportedSorter { principal: string; session: string }
export interface ReportedSortReceipt { id: string; source: string; content: string }
export interface RepairAssessment { identity: ReportedSorter; classification: string; reason: string; receipt?: ReportedSortReceipt }
export interface RepairSortInput {
  id: string; prior?: string;
  /** Several sorts this one replaces at once (owner, O19); `prior` is the one-sort form. */
  priors?: string[];
  reason?: string; classification: string; kind: "isolated" | "pattern";
  coverage: RepairCoverage[]; predicate?: string; sites?: string[]; refutationSubtype?: "factual" | "scope" | "assumed";
  restsOn: string[]; source: string; provenance: "owner-reviewed" | "dual-sorted";
  assessments: RepairAssessment[]; disagreements: { id: string; text: string }[];
  arbitration?: { addresses: string[]; reason: string; identity: ReportedSorter; receipt?: ReportedSortReceipt };
  /** A logged decisions answer on why the sites or claims this correction removes are not instances (R5, plan 5.2). */
  ruling?: string;
  /** Stamped by `post_repair_sort`, never the caller: the transcript entry where /triage-review ran
   *  in a session this sort names. Its sorters are subagents of that one session, so the fold
   *  trusts the stamp in place of distinct sessions (owner, I13: "assumes the agent didn't cheat"). */
  execution?: RepairExecutionStamp;
}
export interface RepairExecutionStamp { skill: "triage-review"; session: string; entry: string }
