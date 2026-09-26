import type { VerifierIdentity } from "./verifier-boundary.js";

declare const participationCapability: unique symbol;
export interface RepairParticipationCapability {
  readonly [participationCapability]: true;
}

const identities = new WeakMap<object, VerifierIdentity>();

/** Issued by the host adapter from request metadata, never from tool arguments. */
export function issueRepairParticipation(identity: VerifierIdentity): RepairParticipationCapability {
  if (![identity.principal, identity.harness, identity.session].every((value) => typeof value === "string" && !!value.trim())
    || (identity.child !== undefined && (typeof identity.child !== "string" || !identity.child.trim()))) {
    throw new Error("repair participation requires a resolved native session identity");
  }
  const token = Object.freeze({}) as RepairParticipationCapability;
  identities.set(token, structuredClone(identity));
  return token;
}

/** A serializable identity is descriptive data; only this process's capability proves admission. */
export function repairParticipationIdentity(capability: unknown, principal: string | null): VerifierIdentity | undefined {
  if (!capability || typeof capability !== "object" || typeof principal !== "string") return undefined;
  const identity = identities.get(capability);
  return identity?.principal === principal ? structuredClone(identity) : undefined;
}
