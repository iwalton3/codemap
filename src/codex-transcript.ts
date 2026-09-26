import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AskedQuestion, CodexQuestionReceipt } from "./schema.js";
import type { TranscriptCall, Unverified } from "./transcript.js";

import { CODEX_ROLLOUT_VERSION } from "./codex-harness.js";
export { CODEX_ROLLOUT_VERSION, CODEX_READER_UNSUPPORTED } from "./codex-harness.js";
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
type Row = Record<string, any>;
const refused = (reason: string): Unverified => ({ unverified: `Codex: ${reason}; use the web questionnaire if this source cannot be verified` });

function files(dir: string, depth = 0): string[] {
  if (depth > 3) return [];
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) return [join(dir, entry.name)];
      if (entry.isDirectory() && /^\d{2,4}$/.test(entry.name)) return files(join(dir, entry.name), depth + 1);
      return [];
    });
  } catch { return []; }
}

function rows(file: string): Row[] | Unverified {
  try {
    const raw = readFileSync(file, "utf8");
    const parsed: Row[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (!row || typeof row !== "object" || Array.isArray(row)) return refused("unknown rollout record");
      parsed.push(row);
    }
    return parsed;
  } catch { return refused("missing, unreadable or torn rollout"); }
}

function header(all: Row[], session: string): Unverified | undefined {
  const meta = all[0];
  const p = meta?.payload;
  if (meta?.type !== "session_meta" || p?.id !== session || p?.session_id !== session)
    return refused("session header does not match the selected session");
  if (p.cli_version !== CODEX_ROLLOUT_VERSION) return refused(`unsupported rollout version ${String(p.cli_version)}`);
  if (typeof p.creator_user_id !== "string" || !ID.test(p.creator_user_id)) return refused("session has no source user identity");
  if (p.source !== "vscode" || p.originator !== "Codex Desktop" || p.thread_source !== "user" || p.parent_thread_id !== undefined)
    return refused("answer source is not a measured top-level user session");
  return undefined;
}

export function codexSessionHolding(id: string, dir: string): string | Unverified {
  if (!ID.test(id)) return refused("invalid call or entry id");
  const matches: string[] = [];
  for (const file of files(dir)) {
    const all = rows(file);
    if (!Array.isArray(all)) continue;
    const session = all[0]?.payload?.id;
    if (typeof session !== "string" || header(all, session)) continue;
    if (all.some((r) => r.type === "response_item" && (r.payload?.call_id === id || r.payload?.id === id))) matches.push(session);
  }
  return matches.length === 1 ? matches[0]! : refused(matches.length ? "identity appears in multiple sessions; select the exact session" : "no supported session holds that identity");
}

export function validCodexReceipt(value: unknown): value is CodexQuestionReceipt {
  const r = value as CodexQuestionReceipt | undefined;
  return !!r && r.harness === "codex" && r.version === CODEX_ROLLOUT_VERSION
    && [r.entryId, r.turnId, r.creatorUserId].every((id) => typeof id === "string" && ID.test(id));
}

export function readCodexQuestion(session: string, callId: string, dir: string, entryId?: string): TranscriptCall | Unverified {
  if (![session, callId, ...(entryId ? [entryId] : [])].every((id) => ID.test(id))) return refused("invalid source identity");
  const selected = files(dir).filter((file) => file.endsWith(`-${session}.jsonl`));
  if (selected.length !== 1) return refused("missing or ambiguous session rollout");
  const all = rows(selected[0]!);
  if (!Array.isArray(all)) return all;
  const badHeader = header(all, session);
  if (badHeader) return badHeader;
  const calls = all.filter((r) => r.type === "response_item" && r.payload?.type === "function_call" && r.payload.call_id === callId);
  if (calls.length !== 1) return refused("missing or duplicate question call");
  const call = calls[0]!;
  if (call.payload.name !== "request_user_input_async") return refused("unsupported question tool; synchronous and auto-resolved paths are not measured");
  let args: any;
  try { args = JSON.parse(call.payload.arguments); } catch { return refused("question arguments are not readable JSON"); }
  if (!args || Object.keys(args).some((key) => key !== "questions") || !Array.isArray(args.questions) || !args.questions.length || args.questions.some((q: any) => !q || Object.keys(q).some((key) => key !== "title" && key !== "options") || typeof q.title !== "string"
    || !q.title.trim() || (q.options !== undefined && (!Array.isArray(q.options) || !q.options.every((o: unknown) => typeof o === "string")))))
    return refused("unknown async question shape");
  const questions: AskedQuestion[] = args.questions.map((q: any) => ({ question: q.title, options: (q.options ?? []).map((label: string) => ({ label })), multiSelect: false }));
  if (new Set(questions.map((q) => q.question)).size !== questions.length) return refused("duplicate question text cannot identify an answer");
  const start = Date.parse(call.timestamp);
  if (!Number.isFinite(start)) return refused("question call has no valid timestamp");
  const outputs = all.filter((r) => r.type === "response_item" && r.payload?.type === "function_call_output" && r.payload.call_id === callId);
  let acknowledgment: any;
  try { acknowledgment = outputs.length === 1 ? JSON.parse(outputs[0]!.payload.output) : undefined; } catch { /* unsupported result */ }
  const displayedAt = Date.parse(outputs[0]?.timestamp);
  if (acknowledgment?.accepted !== true || Object.keys(acknowledgment).some((key) => key !== "accepted")
    || !Number.isFinite(displayedAt) || displayedAt < start) return refused("question has no measured successful display acknowledgment");
  const replies: { row: Row; answers: Record<string, string>; receipt: CodexQuestionReceipt; at: string }[] = [];
  for (let i = all.indexOf(call) + 1; i < all.length; i++) {
    const row = all[i]!;
    const p = row.payload;
    if (row.type !== "response_item" || p?.type !== "message" || p.role !== "user") continue;
    if (entryId && p.id !== entryId) continue;
    const content = p.content;
    if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "input_text" || typeof content[0].text !== "string") continue;
    const text = content[0].text as string;
    if (!text.startsWith("<send_user_message_question_reply>\n") || !text.endsWith("\n</send_user_message_question_reply>")) continue;
    let items: any;
    try { items = JSON.parse(text.slice("<send_user_message_question_reply>\n".length, -"\n</send_user_message_question_reply>".length)); }
    catch { return refused("unreadable question-reply envelope"); }
    if (!Array.isArray(items) || !items.length) return refused("empty or unknown question-reply envelope");
    const answers: Record<string, string> = {};
    let belongs = false;
    for (const item of items) {
      let key: any;
      try { key = JSON.parse(item.questionItemId); } catch { return refused("unreadable question-item identity"); }
      if (!Array.isArray(key) || key.length !== 3 || key[0] !== "request_user_input_async" || typeof key[1] !== "string" || !Number.isInteger(key[2]))
        return refused("unknown question-item identity");
      if (key[1] !== callId) continue;
      belongs = true;
      const q = questions[key[2]];
      if (!q || item.question !== q.question || typeof item.answer !== "string" || !item.answer.trim()
        || Object.hasOwn(answers, q.question)) return refused("answer does not match one exact shown question");
      Object.defineProperty(answers, q.question, { value: item.answer, enumerable: true });
    }
    if (!belongs) continue;
    const meta = p.internal_chat_message_metadata_passthrough;
    const at = Date.parse(row.timestamp);
    const created = typeof meta?.create_time === "number" ? meta.create_time * 1000 : NaN;
    if (!Array.isArray(meta?.content_item_kinds) || meta.content_item_kinds.length !== 1 || meta.content_item_kinds[0] !== "user.text"
      || typeof p.id !== "string" || !ID.test(p.id) || typeof meta.turn_id !== "string" || !ID.test(meta.turn_id)
      || !Number.isFinite(at) || !Number.isFinite(created) || Math.abs(created - at) >= 1000 || at <= displayedAt)
      return refused("reply lacks measured human-message provenance or act time");
    if (!all.slice(0, i).some((r) => r.type === "event_msg" && r.payload?.type === "task_started" && r.payload.turn_id === meta.turn_id))
      return refused("reply has no matching recorded turn");
    replies.push({ row, answers, at: row.timestamp, receipt: { harness: "codex", version: CODEX_ROLLOUT_VERSION,
      entryId: p.id, turnId: meta.turn_id, creatorUserId: all[0]!.payload.creator_user_id } });
  }
  if (replies.length !== 1) return refused(replies.length ? "multiple human replies; select the exact entryId" : "no linked human reply; acknowledgment or cleanup is not an answer");
  const reply = replies[0]!;
  return { session, toolUseId: callId, entryId: reply.receipt.entryId, at: reply.at, questions, answers: reply.answers, receipt: reply.receipt };
}
