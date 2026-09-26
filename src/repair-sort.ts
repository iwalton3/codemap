import { createHash } from "node:crypto";
import type { LogEvent } from "./eventlog.js";
import type { RepairClaim, RepairSortInput, RepairAssessment } from "./repair-sort-types.js";
import { verifyRepairSeal, type RepairSealProducer } from "./repair-seals.js";
import { verifierIdentityKey, type RepairParticipant } from "./verifier-boundary.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function repairSortProposal(sort: RepairSortInput, claims: RepairClaim[]) {
  const { assessments: _assessments, arbitration: _arbitration, disagreements: _disagreements, ...proposal } = sort;
  return { proposal, claims: claims.filter(c => sort.coverage.some(r => r.findingId === c.findingId)).map(({ id, findingId, text, parentId, witness, asFiled, eventId }) => ({ id, findingId, text, parentId, witness, asFiled, eventId })) };
}
export function repairSortPayload(sort: RepairSortInput, claims: RepairClaim[], assessment: RepairAssessment | NonNullable<RepairSortInput["arbitration"]>, role: "sorter" | "arbitrator", scope = assessment.receipt?.scope) {
  const { receipt: _receipt, ...opinion } = assessment;
  return canonical({ domain: "codemap.repair-sort.v1", scope, ...repairSortProposal(sort, claims), role, opinion,
    ...(role === "arbitrator" ? { assessments: sort.assessments, disagreements: sort.disagreements } : {}) });
}
export function repairSortProducers(events: LogEvent[]): (RepairSealProducer & { principal: string })[] {
  const producers: (RepairSealProducer & { principal: string })[] = [];
  for (const e of events) if (e.kind === "repair.verification-producer") {
    const d = e.data as unknown as RepairSealProducer;
    if (typeof d?.publicKey !== "string" || !d.publicKey || d.producerKeyId !== e.subject
      || d.producerKeyId !== `repair_key_${createHash("sha256").update(d.publicKey).digest("hex")}`) continue;
    if (!producers.some(p => p.producerKeyId === d.producerKeyId)) producers.push({ ...d, principal: e.actor.principal });
  }
  return producers;
}
export function repairSortReceiptHolds(sort: RepairSortInput, claims: RepairClaim[], events: LogEvent[], participants: RepairParticipant[]): string[] {
  const holds: string[] = [];
  const producers = repairSortProducers(events);
  const valid = (opinion: RepairAssessment | NonNullable<RepairSortInput["arbitration"]>, role: "sorter" | "arbitrator") => {
    const seal = opinion.receipt?.seal;
    const producer = producers.find(p => p.producerKeyId === seal?.producerKeyId && p.principal === opinion.identity.principal);
    return !!seal && !!opinion.receipt?.scope && !!producer && verifierIdentityKey(seal.receipt.identity) === verifierIdentityKey(opinion.identity)
      && opinion.receipt!.id === seal.receipt.id && opinion.receipt!.content === repairSortPayload(sort, claims, opinion, role)
      && verifyRepairSeal(seal, { publicKey: producer.publicKey, requestKey: `${opinion.receipt!.scope}\0${sort.id}`, content: opinion.receipt!.content, participants, role: "repair-sorter" }).ok;
  };
  if (sort.provenance === "dual-sorted") {
    if (sort.assessments.length !== 2 || sort.assessments.some(a => !valid(a, "sorter"))
      || new Set(sort.assessments.map(a => a.receipt?.seal?.receipt.connectionId)).size !== 2) holds.push("sorter receipts unverified; identities are reported provenance only");
    const disagreement = new Set(sort.assessments.map(a => a.classification)).size > 1;
    if (disagreement && !sort.disagreements.length) holds.push("sorter classification disagreement is not recorded");
    if (!disagreement && sort.assessments.some(a => a.classification !== sort.classification)) holds.push("sort classification does not match independently assessed classification");
    if (disagreement && !sort.arbitration) holds.push("sorter classification disagreement requires arbitration");
  }
  if (sort.arbitration) {
    const arb = sort.arbitration;
    if (!valid(arb, "arbitrator") || sort.assessments.length !== 2 || sort.assessments.some(a => !valid(a, "sorter"))
      || sort.assessments.some(a => verifierIdentityKey(a.identity) === verifierIdentityKey(arb.identity)
        || a.receipt?.seal?.receipt.connectionId === arb.receipt?.seal?.receipt.connectionId)
      || !sort.disagreements.length || /^(agree|agreement|approved|accept|yes|ok)[.!\s]*$/i.test(arb.reason.trim())) holds.push("arbitration receipt unverified or does not independently address a conflict");
  }
  return holds;
}
