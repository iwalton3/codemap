import { createHash } from "node:crypto";

export const CODEX_MCP_OBSERVATION_VERSION = "0.157.1";

export interface CodexMcpObservationExpectation {
  clientVersion: string;
  threadId: string;
  sessionId: string;
  turnId: string;
  callId: string;
  server: string;
  tool: string;
  arguments: unknown;
  result: unknown;
}

export type CodexMcpObservation = {
  diagnostic: true;
  authority: false;
} & ({ matched: false; reason: string } | {
  matched: true;
  version: typeof CODEX_MCP_OBSERVATION_VERSION;
  callDigest: string;
  threadDigest: string;
  sessionDigest: string;
  turnDigest: string;
  argumentDigest: string;
  resultDigest: string;
});

type Row = Record<string, any>;
const object = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const refuse = (reason: string): CodexMcpObservation => ({ diagnostic: true, authority: false, matched: false, reason });

/** Correlation only: historical header labels do not establish the current frontend or reader freshness. */
export function observeCodexCompletedMcp(rollout: string, expected: CodexMcpObservationExpectation): CodexMcpObservation {
  if (expected.clientVersion !== CODEX_MCP_OBSERVATION_VERSION) return refuse("unsupported observation client version");
  if ([expected.threadId, expected.sessionId, expected.turnId, expected.callId, expected.server, expected.tool]
    .some((value) => typeof value !== "string" || !value.trim())) return refuse("missing observation identity");
  try {
    const rows: unknown[] = rollout.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
    if (!rows.length || rows.some((row) => !object(row) || !object(row.payload))) return refuse("unknown rollout record");
    const records = rows as Row[];
    const header = records[0]!;
    if (header.type !== "session_meta" || records.filter((row) => row.type === "session_meta").length !== 1
      || header.payload.cli_version !== CODEX_MCP_OBSERVATION_VERSION
      || header.payload.id !== expected.threadId || header.payload.session_id !== expected.sessionId)
      return refuse("unsupported or mismatched observation header");
    const starts = records.filter((row) => row.type === "event_msg" && row.payload.type === "task_started"
      && row.payload.turn_id === expected.turnId);
    if (starts.length !== 1) return refuse("missing or ambiguous observed task turn");
    const matches = records.filter((row) => object(row.payload.item) && row.payload.item.id === expected.callId);
    if (matches.length !== 1) return refuse("missing or ambiguous observed MCP item");
    const record = matches[0]!;
    const p = record.payload;
    const item = p.item;
    if (record.type !== "event_msg" || p.type !== "item_completed" || item.type !== "McpToolCall"
      || item.status !== "completed" || item.server !== expected.server || item.tool !== expected.tool
      || p.thread_id !== expected.threadId || p.turn_id !== expected.turnId
      || records.indexOf(record) <= records.indexOf(starts[0]!)) return refuse("MCP item does not match the observed call and turn");
    if (!Number.isSafeInteger(p.started_at_ms) || !Number.isSafeInteger(p.completed_at_ms)
      || p.started_at_ms < 0 || p.completed_at_ms < p.started_at_ms) return refuse("invalid observed MCP completion interval");
    if (!object(item.arguments) || !object(item.result) || !object(expected.arguments) || !object(expected.result))
      return refuse("unknown observed MCP arguments or result");
    const argumentsText = JSON.stringify(item.arguments);
    const resultText = JSON.stringify(item.result);
    if (argumentsText !== JSON.stringify(expected.arguments) || resultText !== JSON.stringify(expected.result))
      return refuse("observed MCP arguments or result differ");
    return { diagnostic: true, authority: false, matched: true, version: CODEX_MCP_OBSERVATION_VERSION,
      callDigest: digest(expected.callId), threadDigest: digest(expected.threadId),
      sessionDigest: digest(expected.sessionId), turnDigest: digest(expected.turnId),
      argumentDigest: digest(argumentsText), resultDigest: digest(resultText) };
  } catch { return refuse("torn or unreadable observation source"); }
}
