import { randomUUID } from "node:crypto";

export interface VerifierIdentity {
  principal: string;
  harness: string;
  session: string;
  child?: string;
  model?: string;
}

export type TrustedVerifierContext =
  | { supported: true; identity: VerifierIdentity }
  | { supported: false; reason: string };

export interface RepairParticipant {
  identity: VerifierIdentity;
  role: "fixer" | "relayer";
}

export type BoundaryResult = { ok: true } | { ok: false; error: string };

/** Session identity survives reconnects; model is descriptive metadata. */
export function verifierIdentityKey(identity: VerifierIdentity): string {
  return JSON.stringify([identity.principal, identity.harness, identity.session, identity.child ?? null]);
}

export const REPAIR_VERIFIER_TOOLS: readonly string[] = Object.freeze([
  "repair_brief", "repair_evidence", "repair_verification", "repair_arbitration", "repair_request", "repair_apply_verification",
]);

export const REPAIR_SORTER_TOOLS: readonly string[] = Object.freeze(["repair_sort_brief", "repair_sort_assess", "repair_sort_arbitrate"]);

export interface RepairVerifierReceipt {
  id: string;
  identity: VerifierIdentity;
  identityKey: string;
  role: "repair-verifier" | "repair-sorter";
  connectionId: string;
  requestKey: string;
  content: string;
}

interface IssuedReceipt {
  serialized: string;
  provenance: () => BoundaryResult;
}

declare const sealCapabilityBrand: unique symbol;
export interface RepairSealCapability { readonly [sealCapabilityBrand]: true }
const sealCapabilities = new WeakMap<RepairSealCapability, {
  receipt: RepairVerifierReceipt;
  validate: () => BoundaryResult;
}>();

/** Opaque capabilities come only from a claimed boundary; tool JSON cannot recreate one. */
export function consumeRepairSealCapability(capability: RepairSealCapability): RepairVerifierReceipt | { error: string } {
  const issued = capability && typeof capability === "object" ? sealCapabilities.get(capability) : undefined;
  if (!issued) return { error: "unissued repair sealing capability" };
  const result = issued.validate();
  if (!result.ok) return { error: result.error };
  sealCapabilities.delete(capability);
  return structuredClone(issued.receipt);
}

function participantError(identity: VerifierIdentity, participants: readonly RepairParticipant[]): string | undefined {
  const participant = participants.find((p) => verifierIdentityKey(p.identity) === verifierIdentityKey(identity));
  return participant ? `repair verifier cannot reuse a ${participant.role} identity` : undefined;
}

const issuers = new WeakMap<RepairVerifierReceipts, (receipt: RepairVerifierReceipt, provenance: () => BoundaryResult) => RepairVerifierReceipt>();

/** In-process issuance registry, not a signature or a portable attestation. */
export class RepairVerifierReceipts {
  readonly #issued = new Map<string, IssuedReceipt>();

  constructor() {
    issuers.set(this, (receipt, provenance) => {
      this.#issued.set(receipt.id, { serialized: JSON.stringify(receipt), provenance });
      return structuredClone(receipt);
    });
  }

  validate(receipt: RepairVerifierReceipt, expected: {
    requestKey: string;
    content: string;
    participants: readonly RepairParticipant[];
  }): BoundaryResult {
    const issued = this.#issued.get(receipt.id);
    if (!issued || issued.serialized !== JSON.stringify(receipt)) {
      return { ok: false, error: "receipt was not issued here or was altered" };
    }
    if (receipt.requestKey !== expected.requestKey || receipt.content !== expected.content) {
      return { ok: false, error: "receipt does not bind this request and content" };
    }
    const provenance = issued.provenance();
    if (!provenance.ok) return provenance;
    const error = participantError(receipt.identity, expected.participants);
    return error ? { ok: false, error } : { ok: true };
  }
}

/** Construct only from an adapter's resolved context, never tool arguments. */
export class RepairVerifierBoundary {
  readonly connectionId = randomUUID();
  readonly #context: TrustedVerifierContext;
  readonly #participants: () => readonly RepairParticipant[];
  readonly #revalidate: () => BoundaryResult;
  readonly receipts: RepairVerifierReceipts;
  #domainActions = 0;
  #claimed = false;
  #role: "repair-verifier" | "repair-sorter" = "repair-verifier";
  #forbidden = false;
  #invalidReason?: string;

  constructor(options: {
    context: TrustedVerifierContext;
    participants: () => readonly RepairParticipant[];
    receipts?: RepairVerifierReceipts;
    revalidate?: () => BoundaryResult;
  }) {
    this.#context = structuredClone(options.context);
    this.#participants = options.participants;
    this.receipts = options.receipts ?? new RepairVerifierReceipts();
    this.#revalidate = options.revalidate ?? (() => ({ ok: true }));
  }

  claimedRole(): "repair-verifier" | "repair-sorter" | undefined { return this.#claimed ? this.#role : undefined; }

  invalidate(reason: string): void { this.#invalidReason ??= reason; }
  checkProvenance(): BoundaryResult { return this.#provenance(); }

  trustedIdentity(): VerifierIdentity | { error: string } {
    const checked = this.#provenance();
    if (!checked.ok) return { error: checked.error };
    return this.#context.supported ? structuredClone(this.#context.identity) : { error: "unsupported verifier context" };
  }

  claim(role: "repair-verifier" | "repair-sorter" = "repair-verifier"): BoundaryResult {
    if (!["repair-verifier", "repair-sorter"].includes(role)) return { ok: false, error: "unknown repair role" };
    if (this.#claimed) return { ok: false, error: "repair verifier role is already claimed" };
    if (this.#domainActions) return { ok: false, error: "repair verifier must claim before any domain action, including reads" };
    const eligible = this.#eligible();
    if (!eligible.ok) return eligible;
    this.#claimed = true;
    this.#role = role;
    return { ok: true };
  }

  /** The adapter excludes protocol negotiation, but counts every domain read/write. */
  enterDomainAction(tool: string): BoundaryResult {
    this.#domainActions++;
    if (!this.#claimed) return { ok: true };
    if (!(this.#role === "repair-sorter" ? REPAIR_SORTER_TOOLS : REPAIR_VERIFIER_TOOLS).includes(tool)) {
      this.#forbidden = true;
      return { ok: false, error: `repair verifier role forbids ${tool}` };
    }
    return this.#provenance();
  }

  sealReceipt(requestKey: string, content: string): RepairVerifierReceipt | { error: string } {
    const provenance = this.#provenance();
    if (!provenance.ok) return { error: provenance.error };
    if (typeof requestKey !== "string" || !requestKey.trim() || typeof content !== "string" || !content.trim()) {
      return { error: "receipt requires a nonempty request key and exact content" };
    }
    if (!this.#context.supported) return { error: "unsupported verifier context" };
    const identity = structuredClone(this.#context.identity);
    return issuers.get(this.receipts)!({
      id: randomUUID(), identity, identityKey: verifierIdentityKey(identity),
      role: this.#role, connectionId: this.connectionId, requestKey, content,
    }, () => this.#provenance());
  }

  sealCapability(requestKey: string, content: string): RepairSealCapability | { error: string } {
    const receipt = this.sealReceipt(requestKey, content);
    if ("error" in receipt) return receipt;
    const capability = Object.freeze({}) as RepairSealCapability;
    sealCapabilities.set(capability, { receipt, validate: () => this.receipts.validate(receipt, {
      requestKey, content, participants: this.#participants(),
    }) });
    return capability;
  }

  #eligible(): BoundaryResult {
    if (!this.#context.supported) return { ok: false, error: `unsupported verifier context: ${this.#context.reason}` };
    const identity = this.#context.identity;
    if (![identity.principal, identity.harness, identity.session].every((s) => typeof s === "string" && s.trim().length > 0)
      || (identity.child !== undefined && (typeof identity.child !== "string" || !identity.child.trim()))) {
      return { ok: false, error: "unsupported verifier context: incomplete session identity" };
    }
    const error = participantError(identity, this.#participants());
    if (error) return { ok: false, error };
    if (this.#invalidReason) return { ok: false, error: this.#invalidReason };
    return this.#revalidate();
  }

  #provenance(): BoundaryResult {
    if (!this.#claimed) return { ok: false, error: "connection has not claimed repair verifier role" };
    if (this.#forbidden) return { ok: false, error: "repair verifier attempted a forbidden domain action" };
    return this.#eligible();
  }
}
