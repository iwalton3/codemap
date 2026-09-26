/** Machine-local admission history; reconnecting never makes a used session fresh. */
import { db } from "./db.js";
import { verifierIdentityKey, type BoundaryResult, type VerifierIdentity } from "./verifier-boundary.js";

export interface VerifierSessionActivity {
  connectionId: string;
  kind: "domain" | "claimed" | "tainted";
  firstAction?: string;
}

export function verifierSessionActivity(root: string, identity: VerifierIdentity): VerifierSessionActivity | undefined {
  const row = db(root).prepare("SELECT connection_id AS connectionId, kind, first_action AS firstAction FROM verifier_session_activity WHERE identity_key = ?")
    .get(verifierIdentityKey(identity)) as (VerifierSessionActivity & { firstAction: string | null }) | undefined;
  if (!row) return undefined;
  return { connectionId: row.connectionId, kind: row.kind, ...(row.firstAction ? { firstAction: row.firstAction } : {}) };
}

/** One unique insert arbitrates simultaneous connections without a read/write race. */
export function claimVerifierSession(root: string, identity: VerifierIdentity, connectionId: string): BoundaryResult {
  const inserted = db(root).prepare("INSERT INTO verifier_session_activity(identity_key, connection_id, kind) VALUES(?, ?, 'claimed') ON CONFLICT(identity_key) DO NOTHING")
    .run(verifierIdentityKey(identity), connectionId).changes;
  return inserted === 1 ? { ok: true } : { ok: false, error: "repair verifier session has prior domain activity or a prior role claim" };
}

/** Call before ordinary domain dispatch, including a handler that may refuse the action. */
export function recordVerifierDomain(root: string, identity: VerifierIdentity, connectionId: string, firstAction?: string): BoundaryResult {
  const d = db(root);
  // The conditional conflict update decides and records admission in one statement.
  const result = d.prepare("INSERT INTO verifier_session_activity(identity_key, connection_id, kind, first_action) VALUES(?, ?, 'domain', ?) ON CONFLICT(identity_key) DO UPDATE SET kind = CASE WHEN kind = 'domain' THEN 'domain' ELSE 'tainted' END RETURNING kind")
    .get(verifierIdentityKey(identity), connectionId, firstAction ?? null) as { kind: VerifierSessionActivity["kind"] };
  return result.kind === "domain" ? { ok: true } : { ok: false, error: "repair verifier session cannot resume ordinary domain actions after claiming its role" };
}

/** A forbidden attempt invalidates receipts from the owning verifier connection. */
export function taintVerifierSession(root: string, identity: VerifierIdentity, connectionId: string): void {
  db(root).prepare("UPDATE verifier_session_activity SET kind = 'tainted' WHERE identity_key = ? AND connection_id = ? AND kind = 'claimed'")
    .run(verifierIdentityKey(identity), connectionId);
}
