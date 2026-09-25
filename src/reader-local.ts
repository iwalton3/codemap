/** Local reader requests and successful submit receipts, keyed by purpose and request ID.
 * These rows are machine-local transcript correlation state, not shared decision events.
 * The older answer-keyed tables remain for already issued interpretation briefs. */
import { db, tx } from "./db.js";

export type ReaderPurpose = "answer-interpretation" | "pair-comparison" | "issue-application";
export type ReaderReceiptState = "pending" | "recorded" | "invalid" | "cancelled";
export interface ReaderKey { purpose: ReaderPurpose; requestId: string }
export interface ReaderReceipt extends ReaderKey {
  seq: number;
  receipt: string;
  body: string;
  heldAt: string;
  state: ReaderReceiptState;
  why?: string;
  call?: string;
}

const validKey = ({ purpose, requestId }: ReaderKey): boolean =>
  ["answer-interpretation", "pair-comparison", "issue-application"].includes(purpose)
  && !!requestId && requestId.trim() === requestId;

/** An issued brief is immutable under its exact key. A changed brief needs a new request ID. */
export function saveReaderRequest(root: string, key: ReaderKey, body: string): { saved: boolean } | { error: string } {
  if (!validKey(key) || !body) return { error: "a reader request needs a valid purpose, exact request ID and body" };
  const d = db(root);
  let result: { saved: boolean } | { error: string } = { saved: false };
  tx(d, () => {
    const prior = d.prepare("SELECT body FROM reader_work_requests WHERE purpose = ? AND request_id = ?")
      .get(key.purpose, key.requestId) as { body: string } | undefined;
    if (prior) {
      result = prior.body === body ? { saved: false } : { error: "that reader request ID was already issued with different content" };
      return;
    }
    d.prepare("INSERT INTO reader_work_requests(purpose, request_id, body) VALUES(?, ?, ?)")
      .run(key.purpose, key.requestId, body);
    result = { saved: true };
  });
  return result;
}

export function readerRequest(root: string, key: ReaderKey): string | undefined {
  if (!validKey(key)) return undefined;
  const row = db(root).prepare("SELECT body FROM reader_work_requests WHERE purpose = ? AND request_id = ?")
    .get(key.purpose, key.requestId) as { body: string } | undefined;
  return row?.body;
}

/** The receipt token identifies one successful submit-call result across all purposes.
 * This stores the claim for later transcript verification; it does not verify it. */
export function holdReaderReceipt(
  root: string, key: ReaderKey, receipt: string, body: string, heldAt = new Date().toISOString(),
): { held: boolean; seq: number } | { error: string } {
  if (!validKey(key) || !receipt?.trim() || !body || !Number.isFinite(Date.parse(heldAt)))
    return { error: "a held reader receipt needs an exact request, receipt, body and time" };
  const d = db(root);
  let result: { held: boolean; seq: number } | { error: string } = { error: "reader request is missing" };
  tx(d, () => {
    const request = d.prepare("SELECT 1 AS found FROM reader_work_requests WHERE purpose = ? AND request_id = ?")
      .get(key.purpose, key.requestId);
    if (!request) return;
    const prior = d.prepare("SELECT seq, purpose, request_id AS requestId, body FROM reader_work_receipts WHERE receipt = ?")
      .get(receipt) as { seq: number; purpose: string; requestId: string; body: string } | undefined;
    if (prior) {
      result = prior.purpose === key.purpose && prior.requestId === key.requestId && prior.body === body
        ? { held: false, seq: prior.seq }
        : { error: "that reader receipt already belongs to a different request or content" };
      return;
    }
    const write = d.prepare("INSERT INTO reader_work_receipts(purpose, request_id, receipt, body, held_at, state) VALUES(?, ?, ?, ?, ?, 'pending')")
      .run(key.purpose, key.requestId, receipt, body, heldAt);
    result = { held: true, seq: Number(write.lastInsertRowid) };
  });
  return result;
}

export function readerReceipts(root: string, key: ReaderKey): ReaderReceipt[] {
  if (!validKey(key)) return [];
  return (db(root).prepare("SELECT seq, purpose, request_id AS requestId, receipt, body, held_at AS heldAt, state, why, call FROM reader_work_receipts WHERE purpose = ? AND request_id = ? ORDER BY seq")
    .all(key.purpose, key.requestId) as unknown as (ReaderReceipt & { why: string | null; call: string | null })[])
    .map(({ why, call, ...row }) => ({ ...row, ...(why ? { why } : {}), ...(call ? { call } : {}) }));
}

/** Called only after an external transcript check has reached a verdict. */
export function settleReaderReceipt(
  root: string, key: ReaderKey, receipt: string, state: Exclude<ReaderReceiptState, "pending">,
  why?: string, call?: string,
): { settled: boolean } | { error: string } {
  if (!validKey(key) || !receipt?.trim() || !["recorded", "invalid", "cancelled"].includes(state))
    return { error: "invalid reader receipt settlement" };
  const d = db(root);
  const changed = d.prepare("UPDATE reader_work_receipts SET state = ?, why = ?, call = ? WHERE purpose = ? AND request_id = ? AND receipt = ? AND state = 'pending'")
    .run(state, why ?? null, call ?? null, key.purpose, key.requestId, receipt).changes;
  return { settled: changed === 1 };
}
