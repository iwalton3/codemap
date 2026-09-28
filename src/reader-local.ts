/** Local reader requests and successful submit receipts, keyed by purpose and request ID.
 * These rows are machine-local transcript correlation state, not shared decision events.
 * The older answer-keyed tables remain for already issued interpretation briefs. */
import { db, tx } from "./db.js";

export type ReaderPurpose = "answer-interpretation" | "pair-comparison" | "issue-application" | "operation-signoff" | "repair-verification" | "repair-arbitration" | "withdrawal-review";
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
  ["answer-interpretation", "pair-comparison", "issue-application", "operation-signoff", "repair-verification", "repair-arbitration", "withdrawal-review"].includes(purpose)
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

/** Enumerate immutable requests for one purpose, newest issuance first. */
export function readerRequests(root: string, purpose: ReaderPurpose): { requestId: string; body: string }[] {
  return db(root).prepare("SELECT request_id AS requestId, body FROM reader_work_requests WHERE purpose = ? ORDER BY rowid DESC")
    .all(purpose) as { requestId: string; body: string }[];
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


/** Compatibility path for interpretation briefs issued before purpose-keyed requests. */
export type LegacyVerdictState = "pending" | "recorded" | "invalid" | "superseded";
export interface LegacyReaderVerdict {
  seq: number; answer: string; verdict: string; heldAt: string;
  state: LegacyVerdictState; why?: string; call?: string; receipt?: string;
  knownReplacements?: string[];
}

export function legacyReaderRequest(root: string, answer: string): string | undefined {
  const row = db(root).prepare("SELECT body FROM reader_requests WHERE answer = ?")
    .get(answer) as { body: string } | undefined;
  return row?.body;
}

export function legacyReaderVerdicts(root: string, answer: string): LegacyReaderVerdict[] {
  const rows = db(root).prepare("SELECT seq, answer, verdict, held_at AS heldAt, state, why, call, receipt, known_replacements AS knownJson FROM reader_verdicts WHERE answer = ? ORDER BY seq")
    .all(answer) as (Omit<LegacyReaderVerdict, "knownReplacements"> & {
      why: string | null; call: string | null; receipt: string | null; knownJson: string | null;
    })[];
  return rows.map(({ knownJson, why, call, receipt, ...row }) => ({ ...row,
    ...(why ? { why } : {}), ...(call ? { call } : {}), ...(receipt ? { receipt } : {}),
    ...(knownJson ? { knownReplacements: JSON.parse(knownJson) as string[] } : {}),
  }));
}

export function holdLegacyReaderVerdict(root: string, answer: string, verdict: string, receipt: string,
  heldAt = new Date().toISOString()): void {
  db(root).prepare("INSERT INTO reader_verdicts(answer, verdict, held_at, state, receipt) VALUES(?, ?, ?, 'pending', ?)")
    .run(answer, verdict, heldAt, receipt);
}

export function pendingLegacyReaderAnswers(root: string): string[] {
  return (db(root).prepare("SELECT DISTINCT answer FROM reader_verdicts WHERE state = 'pending'")
    .all() as { answer: string }[]).map((row) => row.answer);
}

export function settleLegacyReaderVerdict(root: string, seq: number, state: LegacyVerdictState,
  why?: string, call?: string): void {
  db(root).prepare("UPDATE reader_verdicts SET state = ?, why = ?, call = COALESCE(?, call) WHERE seq = ?")
    .run(state, why ?? null, call ?? null, seq);
}

export function noteLegacyReaderVerdict(root: string, seq: number, why: string): void {
  db(root).prepare("UPDATE reader_verdicts SET why = ? WHERE seq = ?").run(why, seq);
}
