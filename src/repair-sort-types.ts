import type { Actor, BugWitness } from "./schema.js";
import type { RepairVerificationSeal } from "./repair-seals.js";
import type { VerifierIdentity } from "./verifier-boundary.js";

export interface RepairClaim { id: string; findingId: string; text: string; parentId?: string; eventId: string; actor: Actor; at: string; reason?: string; witness?: BugWitness; asFiled?: Record<string, unknown> }
export interface RepairCoverage { findingId: string; claimIds: string[] }
export interface ReportedSortReceipt { id: string; source: string; content: string; scope?: string; seal?: RepairVerificationSeal }
export interface RepairAssessment { identity: VerifierIdentity; classification: string; reason: string; receipt?: ReportedSortReceipt }
export interface RepairSortInput {
  id: string; prior?: string; reason?: string; classification: string; kind: "isolated" | "pattern";
  coverage: RepairCoverage[]; predicate?: string; sites?: string[]; refutationSubtype?: "factual" | "scope";
  restsOn: string[]; source: string; provenance: "owner-reviewed" | "dual-sorted";
  assessments: RepairAssessment[]; disagreements: { id: string; text: string }[];
  arbitration?: { addresses: string[]; reason: string; identity: VerifierIdentity; receipt?: ReportedSortReceipt };
}
