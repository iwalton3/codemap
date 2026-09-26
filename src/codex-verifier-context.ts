import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CODEX_ROLLOUT_VERSION } from "./codex-harness.js";
import { verifierIdentityKey, type BoundaryResult, type TrustedVerifierContext, type VerifierIdentity } from "./verifier-boundary.js";

type Row = Record<string, any>;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const object = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const refuse = (reason: string): TrustedVerifierContext => ({ supported: false, reason: `Codex: ${reason}` });

export interface CodexVerifierContextOptions {
  principal: string | null;
  clientInfo: unknown;
  /** Host tools/call params._meta; never params.arguments. */
  requestMeta: unknown;
  transcriptDir: string;
}

/** Restrictive ledger lookup only; granting a role still requires the pinned client version. */
export function observedCodexVerifierIdentity(options: Pick<CodexVerifierContextOptions, "principal" | "clientInfo" | "requestMeta">): VerifierIdentity | undefined {
  const { principal, clientInfo, requestMeta } = options;
  if (typeof principal !== "string" || !principal.trim() || !object(clientInfo)
    || clientInfo.name !== "codex-mcp-client"
    || !object(requestMeta) || !id(requestMeta.threadId) || !id(requestMeta.sessionId)) return undefined;
  return { principal, harness: "codex", session: requestMeta.sessionId,
    ...(requestMeta.threadId !== requestMeta.sessionId ? { child: requestMeta.threadId } : {}) };
}

function files(dir: string, depth = 0): string[] {
  if (depth > 3) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) return [join(dir, entry.name)];
    if (entry.isDirectory() && /^\d{2,4}$/.test(entry.name)) return files(join(dir, entry.name), depth + 1);
    return [];
  });
}

function selected(allFiles: string[], session: string): Row[] {
  const matches = allFiles.filter((file) => file.endsWith(`-${session}.jsonl`));
  if (matches.length !== 1) throw new Error("missing or ambiguous session rollout");
  const rows = readFileSync(matches[0]!, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  if (!rows.length || rows.some((row) => !object(row))) throw new Error("unknown rollout record");
  return rows;
}

function header(rows: Row[], session: string, rootSession = session): Row {
  const p = rows[0]?.payload;
  if (rows.filter((r) => r.type === "session_meta").length !== 1 || rows[0]?.type !== "session_meta" || !object(p) || p.id !== session || p.session_id !== rootSession)
    throw new Error("session header does not match request identity");
  if (p.cli_version !== CODEX_ROLLOUT_VERSION || p.originator !== "Codex Desktop" || !id(p.creator_user_id)
    || !Number.isFinite(Date.parse(p.timestamp))) throw new Error("unsupported rollout header/version");
  return p;
}

function args(row: Row): Row {
  const parsed: unknown = JSON.parse(row.payload.arguments);
  if (!object(parsed)) throw new Error("unknown collaboration arguments");
  return parsed;
}

/** Version-specific local provenance; opaque initial prompt contents remain an accepted risk. */
export function resolveCodexVerifierContext(options: CodexVerifierContextOptions): TrustedVerifierContext {
  const { principal, clientInfo, requestMeta, transcriptDir } = options;
  if (typeof principal !== "string" || !principal.trim()) return refuse("missing resolved principal");
  if (!object(clientInfo) || clientInfo.name !== "codex-mcp-client" || clientInfo.version !== CODEX_ROLLOUT_VERSION)
    return refuse("unsupported MCP client/version");
  if (!object(requestMeta) || !id(requestMeta.threadId) || !id(requestMeta.sessionId) || !id(requestMeta.callId))
    return refuse("missing or invalid host request metadata");
  const childId = requestMeta.threadId;
  const parentId = requestMeta.sessionId;
  if (childId === parentId) return refuse("repair verifier requires a fresh child session");
  try {
    const allFiles = files(transcriptDir);
    const childRows = selected(allFiles, childId);
    const parentRows = selected(allFiles, parentId);
    const child = header(childRows, childId, parentId);
    const parent = header(parentRows, parentId);
    const spawn = child.source?.subagent?.thread_spawn;
    if (parent.source !== "vscode" || parent.thread_source !== "user" || parent.parent_thread_id !== undefined)
      return refuse("unsupported parent session");
    if (!object(spawn) || child.thread_source !== "subagent" || child.multi_agent_version !== "v2"
      || child.parent_thread_id !== parentId || spawn.parent_thread_id !== parentId || spawn.depth !== 1
      || typeof spawn.agent_path !== "string" || !/^\/root\/[a-z0-9_]+$/.test(spawn.agent_path)
      || child.agent_path !== spawn.agent_path || child.creator_user_id !== parent.creator_user_id)
      return refuse("child header does not bind the measured parent and agent path");
    if (child.forked_from_id !== undefined || child.subagent_history_start_ordinal !== undefined)
      return refuse("inherited child history is forbidden");
    const starts = childRows.filter((r) => r.type === "event_msg" && r.payload?.type === "task_started");
    const inputs = childRows.filter((r) => r.type === "response_item" && r.payload?.type === "message" && r.payload.role === "user");
    if (starts.length !== 1 || inputs.length !== 1 || childRows.some((r) => r.type === "event_msg" && r.payload?.type === "user_message"))
      return refuse("child received additional user input or another task turn");
    const initialTurn = starts[0]!.payload.turn_id;
    if (!id(initialTurn) || inputs[0]!.payload.internal_chat_message_metadata_passthrough?.turn_id !== initialTurn)
      return refuse("initial child input does not bind its task turn");
    const calls = parentRows.filter((r) => r.type === "response_item" && r.payload?.type === "function_call");
    const launches = calls.filter((r) => {
      if (r.payload.name !== "spawn_agent") return false;
      const a = args(r);
      return `/root/${a.task_name}` === spawn.agent_path;
    });
    if (launches.length !== 1) return refuse("missing or ambiguous child launch");
    const launch = launches[0]!;
    if (args(launch).fork_turns !== "none") return refuse("child launch did not explicitly exclude inherited turns");
    if (!id(launch.payload.call_id)) return refuse("invalid child launch call identity");
    const outputs = parentRows.filter((r) => r.type === "response_item" && r.payload?.type === "function_call_output"
      && r.payload.call_id === launch.payload.call_id);
    const output = outputs.length === 1 ? JSON.parse(outputs[0]!.payload.output) : undefined;
    if (!object(output) || output.task_name !== spawn.agent_path || output.error !== undefined)
      return refuse("child launch has no unique successful output");
    const launchedAt = Date.parse(launch.timestamp);
    const completedAt = Date.parse(outputs[0]!.timestamp);
    const childAt = Date.parse(child.timestamp);
    if (![launchedAt, completedAt].every(Number.isFinite) || childAt < launchedAt || childAt > completedAt)
      return refuse("child header is outside its launch interval");
    for (const call of calls) {
      if (!["followup_task", "send_message", "interrupt_agent"].includes(call.payload.name)) continue;
      const target = args(call).target;
      if (typeof target !== "string") return refuse("unknown collaboration target");
      if (target === spawn.agent_path || target === spawn.agent_path.slice("/root/".length) || target === childId)
        return refuse("child received a known follow-up or interruption");
    }
    // The current tools/call may not have flushed yet. Reject collisions when already present.
    for (const rows of [parentRows, childRows]) {
      const matching = rows.filter((r) => r.type === "response_item" && r.payload?.type === "function_call"
        && r.payload.call_id === requestMeta.callId);
      if (matching.length > 1 || (rows === parentRows && matching.length)) return refuse("request call identity is ambiguous or belongs to parent");
    }
    return { supported: true, identity: { principal, harness: "codex", session: parentId, child: childId } };
  } catch { return refuse("missing, unreadable, torn or unknown provenance record"); }
}

/** Re-read native provenance so later contamination also invalidates issued receipts. */
export function recheckCodexVerifierContext(context: TrustedVerifierContext, options: CodexVerifierContextOptions): BoundaryResult {
  if (!context.supported) return { ok: false, error: context.reason };
  const current = resolveCodexVerifierContext(options);
  if (!current.supported) return { ok: false, error: current.reason };
  return verifierIdentityKey(context.identity) === verifierIdentityKey(current.identity)
    ? { ok: true } : { ok: false, error: "Codex: verifier identity changed on this connection" };
}
