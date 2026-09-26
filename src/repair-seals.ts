import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import {
  consumeRepairSealCapability, verifierIdentityKey,
  type BoundaryResult, type RepairParticipant, type RepairSealCapability, type RepairVerifierReceipt,
} from "./verifier-boundary.js";

export interface RepairSigningKey { publicKey: string; privateKey: string }
export interface RepairSealProducer { producerKeyId: string; publicKey: string }
export interface RepairVerificationSeal extends RepairSealProducer {
  version: 1;
  receipt: RepairVerifierReceipt;
  signature: string;
}

const DOMAIN = "codemap.repair-verification-seal.v1";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const keyId = (publicKey: string) => `repair_key_${createHash("sha256").update(publicKey).digest("hex")}`;
const signedBytes = (value: Omit<RepairVerificationSeal, "signature">) => Buffer.from(canonical({ domain: DOMAIN, ...value }));

/** Keys attest issuance by this local producer, not the authenticity of an arbitrary native harness. */
export class RepairSealService {
  readonly #key: RepairSigningKey;
  constructor(storage: { loadKey: () => RepairSigningKey | undefined; saveKey: (key: RepairSigningKey) => void }) {
    const stored = storage.loadKey();
    if (stored) {
      const privateKey = createPrivateKey(stored.privateKey);
      const publicKey = createPublicKey(stored.publicKey);
      if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519"
        || createPublicKey(stored.privateKey).export({ type: "spki", format: "pem" }) !== stored.publicKey) {
        throw new Error("stored repair producer key is invalid; refusing replacement");
      }
      this.#key = structuredClone(stored);
    } else {
      const pair = generateKeyPairSync("ed25519");
      this.#key = { publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
        privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
      storage.saveKey(structuredClone(this.#key));
    }
  }

  publicProducer(): RepairSealProducer {
    return { producerKeyId: keyId(this.#key.publicKey), publicKey: this.#key.publicKey };
  }

  seal(capability: RepairSealCapability): RepairVerificationSeal | { error: string } {
    const receipt = consumeRepairSealCapability(capability);
    if ("error" in receipt) return receipt;
    const envelope: Omit<RepairVerificationSeal, "signature"> = { version: 1, ...this.publicProducer(), receipt };
    return { ...envelope, signature: sign(null, signedBytes(envelope), this.#key.privateKey).toString("base64") };
  }
}

/** Replay requires a registered expected key, never the envelope's self-declared key alone. */
export function verifyRepairSeal(seal: RepairVerificationSeal, expected: {
  publicKey: string;
  requestKey: string;
  content: string;
  participants: readonly RepairParticipant[];
  role?: "repair-verifier" | "repair-sorter";
}): BoundaryResult {
  try {
    if (!seal || seal.version !== 1 || seal.publicKey !== expected.publicKey || seal.producerKeyId !== keyId(expected.publicKey)) {
      return { ok: false, error: "repair seal producer is not registered for this receipt" };
    }
    const receipt = seal.receipt;
    if (!receipt || receipt.role !== (expected.role ?? "repair-verifier") || !receipt.id || !receipt.connectionId
      || !receipt.identity || ![receipt.identity.principal, receipt.identity.harness, receipt.identity.session].every(v => typeof v === "string" && v.trim())
      || (receipt.identity.child !== undefined && (typeof receipt.identity.child !== "string" || !receipt.identity.child.trim()))
      || receipt.identityKey !== verifierIdentityKey(receipt.identity)) {
      return { ok: false, error: "repair seal has incomplete verifier identity or role" };
    }
    if (receipt.requestKey !== expected.requestKey || receipt.content !== expected.content) {
      return { ok: false, error: "repair seal does not bind this request and exact content" };
    }
    if (expected.participants.some(p => verifierIdentityKey(p.identity) === receipt.identityKey)) {
      return { ok: false, error: "repair seal identity participated as fixer or relayer" };
    }
    const { signature, ...envelope } = seal;
    const publicKey = createPublicKey(expected.publicKey);
    if (publicKey.asymmetricKeyType !== "ed25519" || typeof signature !== "string"
      || !/^[A-Za-z0-9+/]{86}==$/.test(signature)
      || !verify(null, signedBytes(envelope), publicKey, Buffer.from(signature, "base64"))) {
      return { ok: false, error: "repair seal signature is invalid" };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "repair seal is malformed" };
  }
}
