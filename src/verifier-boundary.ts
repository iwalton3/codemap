import { randomUUID } from "node:crypto";

/**
 * Who did a piece of repair work, as codemap can tell it (owner rulings, 2026-09-28).
 *
 * `session` is the MCP CONNECTION the work arrived on — one per agent session, held in memory
 * for the connection's life. A subagent shares its parent's connection, so a subagent's work
 * carries its parent's `session` plus `child` (the subagent id `readReader` verified). Only grants
 * verify (R2: a claimed verifier connection, or a subagent on the controlled prompt path); codemap
 * does not pretend to know who the fixer is.
 */
export interface VerifierIdentity {
  principal: string;
  harness: "mcp" | "claude-subagent";
  session: string;
  child?: string;
}

export type BoundaryResult = { ok: true } | { ok: false; error: string };

/** The one reader-independence key (owner, D4): two participants are independent when theirs differ. */
export function verifierIdentityKey(identity: Pick<VerifierIdentity, "principal" | "session" | "child">): string {
  return JSON.stringify([identity.principal, identity.session, identity.child ?? null]);
}

/** The work a claimed verifier connection may do; anything else ends the claim. `pull` brings in
 *  a request made on another clone (owner, D1); what it receives is readable through none of these. */
export const REPAIR_VERIFIER_TOOLS: readonly string[] = Object.freeze([
  "pull", "repair_pending", "repair_brief", "repair_verification", "repair_arbitration",
]);

/**
 * One MCP connection's repair standing. A dedicated verifier session claims the role before
 * any other codemap call; the claim is held here, never stored, and dies with the connection
 * (owner: "keep the claim in memory for the life of the connection, and drop the table and the
 * permanent taint rules"). An unclaimed connection is an ordinary agent session: it can fix,
 * relay, request and apply, and it can launch subagent verifiers.
 */
export class RepairConnection {
  readonly session = randomUUID();
  #domainActions = 0;
  #claimed = false;

  constructor(readonly principal: string) {}

  /** The connection's identity in one universe. The session and the claim span every universe the
   *  connection serves; the principal is that universe's own (F36: two repos, two git identities). */
  identity(principal: string = this.principal): VerifierIdentity { return { principal, harness: "mcp", session: this.session }; }
  claimed(): boolean { return this.#claimed; }

  claim(): BoundaryResult {
    if (this.#claimed) return { ok: false, error: "this connection has already claimed the verifier role" };
    if (this.#domainActions) return { ok: false, error: "a verifier must claim before any other codemap call on its connection: this session has already worked here" };
    this.#claimed = true;
    return { ok: true };
  }

  /** Every tool but the claim counts; a claimed connection is refused anything outside the role. */
  enter(tool: string): BoundaryResult {
    if (tool === "claim_verifier") return { ok: true };
    if (this.#claimed && !REPAIR_VERIFIER_TOOLS.includes(tool)) return { ok: false, error: `the verifier role does not allow ${tool}` };
    this.#domainActions++;
    return { ok: true };
  }
}
