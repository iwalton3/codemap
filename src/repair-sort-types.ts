import type { Actor, BugWitness } from "./schema.js";

export interface RepairClaim { id: string; findingId: string; text: string; parentId?: string; eventId: string; actor: Actor; at: string; reason?: string; witness?: BugWitness; asFiled?: Record<string, unknown> }
export interface RepairCoverage { findingId: string; claimIds: string[] }
/** Who sorted, as the skill's own sort record reports it. Provenance to read, not a credential. */
export interface ReportedSorter { principal: string; session: string }
export interface ReportedSortReceipt { id: string; source: string; content: string }
export interface RepairAssessment { identity: ReportedSorter; classification: string; reason: string; receipt?: ReportedSortReceipt }
export interface RepairSortInput {
  id: string; prior?: string; reason?: string; classification: string; kind: "isolated" | "pattern";
  coverage: RepairCoverage[]; predicate?: string; sites?: string[]; refutationSubtype?: "factual" | "scope" | "assumed";
  restsOn: string[]; source: string; provenance: "owner-reviewed" | "dual-sorted";
  assessments: RepairAssessment[]; disagreements: { id: string; text: string }[];
  arbitration?: { addresses: string[]; reason: string; identity: ReportedSorter; receipt?: ReportedSortReceipt };
  /** A logged decisions answer this correction rests on: it settles competing corrections (R5). */
  ruling?: string;
}
