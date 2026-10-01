/**
 * Transactions and sessions over the linear sync (plan 2.4, 2.5). `sidecar.ts` owns the
 * transport — fetch, replay, push; this owns who a write belongs to and when it syncs.
 *
 * - A single act with no transaction open syncs inline (`emitEventChecked`).
 * - `begin` opens a transaction for the calling session: its acts are checked against the
 *   tip plus its own staged acts, then STAGED; `sync` pushes them all or none.
 * - A refused transaction stays staged. Its session drops ops or appends more, and syncs again.
 * - A session that is gone has its staged ops attempted by whoever notices; a refusal then
 *   becomes a local conflict, shown on the next open on this machine.
 */
import {
  atTip, causalHeads, doorFor, EVENT_SCHEMA, writeDoor, maxSeq, mintId, readScope, registerOverlay, SIDECAR_PROTOCOL, sortEvents, writerFor,
  type AdmissionCheck, type DoorFold, type LogEvent, type StagedEvent,
} from "./eventlog.js";
import { withSidecarLock } from "./lock.js";
import {
  conflicts, drop, forgetSession, pending, sessionRow, sessionsWithPending, setTx, stage, type QueuedOp,
} from "./sync-queue.js";
import { currentSession, overlaySuppressed, sessionGone, withoutOverlay } from "./sync-session.js";
import { syncLinear, type LinearOutcome } from "./sidecar.js";
import { arrived } from "./arrivals.js";
import type { Actor } from "./schema.js";

type Check = AdmissionCheck;

/**
 * The session's own staged events for a scope, placed after the tip as they would land. What
 * a session reads on top of the log (plan 2.4: "a caller reads its own staged acts").
 */
export async function overlayFor(logRoot: string, scope: string, events: LogEvent[], session = currentSession().session): Promise<LogEvent[]> {
  const mine = pending(logRoot, session).filter((o) => o.scope === scope && o.state === "staged");
  if (!mine.length) return [];
  const writer = await writerFor(logRoot);
  let top = await maxSeq(logRoot);
  const door = doorFor(logRoot, scope);
  const out: LogEvent[] = [];
  for (const o of mine) {
    const e = atTip([...events, ...out], writer, top, o.event);
    // Only what would land. A refused transaction stays staged for its author to repair, and
    // folding its refused act into their reads would halt the fold — a lockout for a race.
    // Checked against the tip alone: the door may read other scopes, and they must not
    // recurse into this overlay.
    if (await withoutOverlay(() => refused(door, [...events, ...out], e))) continue;
    out.push(e);
    top++;
  }
  return out;
}

registerOverlay({
  active: (logRoot, scope) => !overlaySuppressed()
    && pending(logRoot, currentSession().session).some((o) => o.scope === scope && o.state === "staged"),
  events: (logRoot, scope, tip) => overlayFor(logRoot, scope, tip),
});

async function refused(fold: DoorFold | undefined, events: LogEvent[], e: LogEvent): Promise<string | null> {
  if (!fold) return null;
  try {
    const verdict = await fold(sortEvents([...events, e]), e);
    return verdict.refused.find((r) => r.id === e.id)?.why ?? null;
  } catch (err) {
    const entry = (err as { entry?: { id?: string; why?: string } } | null)?.entry;
    if (entry?.id === e.id) return entry.why ?? "the fold refuses it";
    throw err;
  }
}

/**
 * Stage one act inside an open transaction: checked and folded against the tip plus this
 * session's staged acts, so a refusal the fold can already see comes back now. Replay at sync
 * checks it again against whatever the tip has become.
 */
export async function stageChecked(
  logRoot: string, session: string, scope: string, actor: Actor, check: Check, fold?: DoorFold,
): Promise<LogEvent | { error: string }> {
  return withSidecarLock(logRoot, async () => {
    // Tip plus this session's staged acts: `readScope` carries the overlay.
    const events = await readScope(logRoot, scope);
    const admission = await check(events);
    if ("error" in admission) return admission;
    if ("existing" in admission) return admission.existing;
    const staged: StagedEvent = {
      sidecarProtocol: SIDECAR_PROTOCOL, eventSchema: EVENT_SCHEMA, id: mintId(), kind: admission.kind,
      subject: admission.subject, actor, at: new Date().toISOString(), after: causalHeads(events),
      ...(admission.data ? { data: admission.data } : {}),
    };
    const top = Math.max(await maxSeq(logRoot), ...events.map((e) => e.seq ?? 0));
    const e = atTip(events, await writerFor(logRoot), top, staged);
    const why = await refused(writeDoor(logRoot, scope, fold), events, e);
    if (why) return { error: why };
    stage(logRoot, session, scope, staged);
    return e;
  });
}

type Item = { kind: string; subject: string; data?: Record<string, unknown> };

function stagedFrom(actor: Actor, it: Item, after: string[]): StagedEvent {
  return {
    sidecarProtocol: SIDECAR_PROTOCOL, eventSchema: EVENT_SCHEMA, id: mintId(), kind: it.kind, subject: it.subject,
    actor, at: new Date().toISOString(), after, ...(it.data ? { data: it.data } : {}),
  };
}

/** Stage a batch inside an open transaction. */
export async function stageBatch(logRoot: string, session: string, scope: string, actor: Actor, items: Item[]): Promise<LogEvent[]> {
  return withSidecarLock(logRoot, async () => {
    const events = await readScope(logRoot, scope);
    const writer = await writerFor(logRoot);
    let top = Math.max(await maxSeq(logRoot), ...events.map((e) => e.seq ?? 0));
    // Each act after the first names the one before it: its author composed it knowing that one.
    let after = causalHeads(events);
    return items.map((it) => {
      const staged = stagedFrom(actor, it, after);
      after = [staged.id];
      stage(logRoot, session, scope, staged);
      const e = atTip(events, writer, top++, staged);
      events.push(e);
      return e;
    });
  });
}

/**
 * A batch outside a transaction: one all-or-nothing sync of just these items, under a session
 * of their own so nothing else the caller staged rides along. On failure they are dropped —
 * the caller is told, and a retry must not find a stale copy waiting.
 */
export async function syncBatch(logRoot: string, scope: string, actor: Actor, items: Item[]): Promise<LogEvent[]> {
  const batch = `${currentSession().session}#batch-${mintId()}`;
  // Each act after the first names the one before it: its author composed it knowing that one.
  let after = causalHeads(await readScope(logRoot, scope));
  const staged = items.map((it) => { const s = stagedFrom(actor, it, after); after = [s.id]; return s; });
  for (const s of staged) stage(logRoot, batch, scope, s);
  const r = await syncLinear(logRoot, batch, { actor });
  if ("error" in r) {
    // An ambiguous push failure keeps its ops `inflight` for the next sync to confirm; anything
    // still merely staged was never sent.
    for (const s of staged) drop(logRoot, batch, s.id);
    throw new Error(r.error);
  }
  if (r.gained) await arrived(logRoot);
  const ids = new Set(staged.map((s) => s.id));
  return (await readScope(logRoot, scope)).filter((e) => ids.has(e.id));
}

// ---- Transactions ----------------------------------------------------------------------

export function begin(logRoot: string, s = currentSession()): { ok: true; session: string; staged: number } {
  setTx(logRoot, s.session, s.kind, true);
  return { ok: true, session: s.session, staged: pending(logRoot, s.session).length };
}

/** Push the session's staged ops, all or none, and close its transaction if they landed. */
export async function syncSession(logRoot: string, actor?: Actor, s = currentSession()): Promise<LinearOutcome> {
  const r = await syncLinear(logRoot, s.session, { actor });
  if (!("error" in r)) setTx(logRoot, s.session, s.kind, false);
  return r;
}

/**
 * Drop every staged op of the session and close its transaction. An op whose failed push could
 * not be settled (C7) may already have landed: it is named in `mayHaveLanded`, never a bare ok.
 */
export function discard(logRoot: string, s = currentSession()): { ok: true; dropped: number; mayHaveLanded?: string[] } {
  let dropped = 0;
  const unknown: string[] = [];
  for (const op of pending(logRoot, s.session)) {
    const r = drop(logRoot, s.session, op.event.id);
    if (!r) continue;
    dropped++;
    if (r.mayHaveLanded) unknown.push(op.event.id);
  }
  setTx(logRoot, s.session, s.kind, false);
  return { ok: true, dropped, ...(unknown.length ? { mayHaveLanded: unknown } : {}) };
}

/** Drop one staged op of the session (or dismiss a local conflict). Appending is `emit`. */
export function dropOp(logRoot: string, eventId: string, s = currentSession()): { ok: boolean; mayHaveLanded?: true } {
  const r = drop(logRoot, s.session, eventId) || drop(logRoot, null, eventId);
  return { ok: !!r, ...(r && r.mayHaveLanded ? { mayHaveLanded: true as const } : {}) };
}

export function staged(logRoot: string, s = currentSession()): QueuedOp[] {
  return pending(logRoot, s.session);
}

/** What the next open on this machine shows: writes refused after their session was gone. */
export function localConflicts(logRoot: string): QueuedOp[] {
  return conflicts(logRoot);
}

// ---- Sessions that are gone (plan 2.5) ---------------------------------------------------

/**
 * Attempt every gone session's staged ops, each session all-or-nothing. A refusal becomes a
 * local conflict; an unreachable remote leaves them staged for the next attempt.
 */
export async function attemptGone(logRoot: string, now = Date.now()): Promise<{ session: string; outcome: string }[]> {
  const out: { session: string; outcome: string }[] = [];
  for (const session of sessionsWithPending(logRoot)) {
    const base = session.split("#")[0]!;
    if (!sessionGone(base, sessionRow(logRoot, base), now)) continue;
    const r = await syncLinear(logRoot, session, { conflictOnRefusal: true });
    out.push({ session, outcome: "error" in r ? (r.conflicts ? "conflict" : `left staged: ${r.error}`) : "landed" });
    if (!("error" in r) || r.conflicts) forgetSession(logRoot, base);
  }
  return out;
}

/** The calling session is ending: attempt what it staged, as a gone session would be. */
export async function closeSession(logRoot: string, session: string): Promise<LinearOutcome | null> {
  if (!pending(logRoot, session).length) { forgetSession(logRoot, session); return null; }
  const r = await syncLinear(logRoot, session, { conflictOnRefusal: true });
  forgetSession(logRoot, session);
  return r;
}
