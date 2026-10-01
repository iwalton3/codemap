/**
 * Every shared write enters here (docs/PROPOSAL-online-only-sync.md). Routed by who is asking
 * and where the sidecar sends things:
 *
 * - the calling session has a transaction open: checked against the tip plus its own staged
 *   acts, and STAGED;
 * - the sidecar has a remote: synced inline — its check runs against the remote tip, and the
 *   act lands there or the caller is told why not;
 * - no remote: appended to local history, which is then the only serializer there is.
 *
 * Above `eventlog.ts` and `sidecar.ts` because it needs both, and they must not need it.
 */
import {
  appendBatch, appendChecked, FOLDED_AT_THE_DOOR, type AdmissionCheck, type DoorFold, type LogEvent,
} from "./eventlog.js";
import { syncLinear, transportsRemotely } from "./sidecar.js";
import { stageBatch, stageChecked, syncBatch } from "./sync-engine.js";
import { sessionRow } from "./sync-queue.js";
import { currentSession } from "./sync-session.js";
import { arrived } from "./arrivals.js";
import type { Actor } from "./schema.js";

/**
 * Check, fold and write one act. `check` sees the scope as the act will land on it and may
 * decide it is already there (`existing`) or refuse it; `fold`, when given, is the scope's
 * fold asked about the minted event, envelope and all.
 */
export async function emitEventChecked(
  logRoot: string, scope: string, actor: Actor, check: AdmissionCheck, fold?: DoorFold,
): Promise<LogEvent | { error: string }> {
  const guarded: AdmissionCheck = async (events) => {
    const admission = await check(events);
    if (!fold && !("error" in admission) && !("existing" in admission) && FOLDED_AT_THE_DOOR.test(scope))
      throw new Error(`a write to ${scope} must be folded at the door`);
    return admission;
  };
  const { session } = currentSession();
  if (sessionRow(logRoot, session)?.tx) return stageChecked(logRoot, session, scope, actor, guarded, fold);
  if (!transportsRemotely(logRoot)) return appendChecked(logRoot, scope, actor, guarded, fold);
  const r = await syncLinear(logRoot, session, { actor, inline: { scope, actor, check: guarded, fold } });
  if ("error" in r) return { error: r.error };
  if (!r.event) throw new Error("an inline sync returned no event");
  if (r.gained) await arrived(logRoot);
  return r.event;
}

export async function emitEvent(
  logRoot: string, scope: string, actor: Actor, kind: string, subject: string, data?: Record<string, unknown>,
  fold?: DoorFold,
): Promise<LogEvent> {
  const result = await emitEventChecked(logRoot, scope, actor, async () => ({ kind, subject, data }), fold);
  if ("error" in result) throw new Error(result.error);
  return result;
}

/** Many acts by one writer, all or none. Unchecked, like `emitEvent` without a fold. */
export async function emitEvents(
  logRoot: string, scope: string, actor: Actor,
  items: { kind: string; subject: string; data?: Record<string, unknown> }[],
): Promise<LogEvent[]> {
  if (!items.length) return [];
  const { session } = currentSession();
  if (sessionRow(logRoot, session)?.tx) return stageBatch(logRoot, session, scope, actor, items);
  if (transportsRemotely(logRoot)) return syncBatch(logRoot, scope, actor, items);
  return appendBatch(logRoot, scope, actor, items);
}
