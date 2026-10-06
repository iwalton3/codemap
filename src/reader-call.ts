/**
 * A reader subagent's submit call, checked against the brief it was issued and the verdict held
 * for it. Shared by ruling application and operation sign-off, which each carried a copy.
 */
import { isUnverified, readReceiptCall, readSubagentCall, type ReaderAgent } from "./transcript.js";

export interface VerifiedCall { agentId: string; callId: string; session: string; launch: string; launchedAt: string }
export interface ReaderExpectation {
  tool: RegExp; what: string; prompt: string; requestId: string; receipt: string;
  body: { verdict: string; rationale: string };
}

function check(found: { agentId: string; callId: string; reader: ReaderAgent; input: any; result: any }, e: ReaderExpectation): VerifiedCall | { error: string } {
  if (found.reader.prompt !== e.prompt) return { error: `reader launch did not use the exact issued ${e.what} brief` };
  if (found.input?.requestId !== e.requestId || found.input?.verdict !== e.body.verdict || found.input?.rationale !== e.body.rationale)
    return { error: "reader's submitted verdict differs from the held receipt" };
  if (found.result?.ok !== true || found.result?.held !== true || found.result?.receipt !== e.receipt)
    return { error: "reader's successful submit receipt was not found" };
  return { agentId: found.agentId, callId: found.callId, session: found.reader.session, launch: found.reader.toolUseId, launchedAt: found.reader.launchedAt };
}

/** Re-check a call already recorded under these ids. */
export function verifyReaderCall(e: ReaderExpectation, agentId: string, callId: string, dir?: string): VerifiedCall | { error: string } {
  const found = readSubagentCall(agentId, callId, e.tool, dir);
  return isUnverified(found) ? { error: found.unverified } : check({ agentId, callId, ...found }, e);
}

/** Find the call that returned the held receipt; `pending` only within the grace (`readReceiptCall`). */
export function locateReaderCall(e: ReaderExpectation, heldAt: string, dir?: string): VerifiedCall | { error: string } | { pending: string } {
  const found = readReceiptCall(e.tool, e.receipt, heldAt, dir);
  if ("pending" in found) return found;
  return isUnverified(found) ? { error: found.unverified } : check(found, e);
}

/** A retry of a record that already landed answers with the same reference the first success did:
 *  a caller whose first response was lost still needs both ids for the apply that follows. */
export function recordedAgain(e: ReaderExpectation, heldAt: string, recordedCall: string | undefined, dir?: string) {
  const again = locateReaderCall(e, heldAt, dir);
  if ("callId" in again && again.callId === recordedCall)
    return { ok: true as const, recorded: true as const, existing: true as const, agentId: again.agentId, callId: again.callId };
  const why = "error" in again ? again.error : "pending" in again ? again.pending : `call ${again.callId} returned it`;
  return { error: `the reader was recorded from call ${recordedCall}, which cannot be read back here: ${why}` };
}
