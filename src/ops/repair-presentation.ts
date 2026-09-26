import { normalizeFindingKey } from "../review-target.js";
import type { SharedFinding } from "../shared-findings.js";
import { repairRecords } from "./repairs.js";

export type RepairLifecycle = NonNullable<Awaited<ReturnType<typeof repairRecords>>["lifecycles"]>[number];

/** Review-qualified keys keep identical IDs on different reviews separate. */
export const repairPresentationKey = (finding: Pick<SharedFinding, "id" | "pr">) => JSON.stringify([finding.pr, finding.id]);

export async function findingRepairPresentations(root: string, findings: SharedFinding[]) {
  const result = new Map<string, { status: string; diagnostic?: string; state: string; claim: string; unresolvedScope: string[]; lifecycles: RepairLifecycle[]; executions: SharedFinding["applications"]; historicalClosure: SharedFinding["repairClosure"] }>();
  const reviews = [...new Set(findings.filter(f => {
    try { return !!f.pr && normalizeFindingKey(f.pr) === f.pr; } catch { return false; }
  }).map(f => f.pr!))];
  const details = new Map(await Promise.all(reviews.map(async review => [review, await repairRecords(root, review)] as const)));
  for (const finding of findings) {
    const detail = details.get(finding.pr!);
    const executed = finding.applications?.some(a => a.status === "executed" && a.eventId === finding.closed?.eventId);
    const state = finding.state === "accepted" ? "human-accepted" : executed ? "human-ruling-applied"
      : finding.backlogged ? "backlogged" : finding.state === "created" || finding.state === "issued" ? "open" : finding.state;
    result.set(repairPresentationKey(finding), {
      status: detail && "status" in detail ? (detail.status ?? "unavailable") : "unavailable",
      diagnostic: detail && "diagnostic" in detail ? detail.diagnostic?.detail : detail?.error,
      state, claim: finding.comment ?? finding.text, unresolvedScope: finding.state === "created" || finding.state === "issued" ? [finding.comment ?? finding.text] : [],
      lifecycles: detail && "lifecycles" in detail ? (detail.lifecycles ?? []).filter(l => l.findingId === finding.id) : [],
      executions: finding.applications ?? [], historicalClosure: finding.repairClosure,
    });
  }
  return result;
}
