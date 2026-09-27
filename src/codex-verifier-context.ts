import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CODEX_ROLLOUT_VERSION, CODEX_CLI_ROLE_VERSION, CODEX_CLI_ROLE_SERVER } from "./codex-harness.js";
import { verifierIdentityKey, type BoundaryResult, type TrustedVerifierContext, type VerifierIdentity } from "./verifier-boundary.js";

type Row = Record<string, any>;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const object = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const refuse = (reason: string): { supported: false; reason: string } => ({ supported: false, reason: `Codex: ${reason}` });

export interface CodexVerifierContextOptions {
  principal: string | null;
  clientInfo: unknown;
  /** Host tools/call params._meta; never params.arguments. */
  requestMeta: unknown;
  transcriptDir: string;
  /** Actual tools/call name, supplied by the dispatcher rather than tool arguments. */
  requestTool?: string;
  /** Prior completed dispatcher requests and their actual emitted MCP results. */
  completedRequests?: readonly CodexCompletedVerifierRequest[];
}

export interface CodexCompletedVerifierRequest {
  requestMeta: unknown;
  tool: string;
  arguments: unknown;
  result: unknown;
}

function cliMetadata(meta: unknown, child: string, parent: string, turn: string): meta is Row {
  if (!object(meta) || meta.threadId !== child || meta.sessionId !== parent || !id(meta.callId)) return false;
  const active = meta["x-codex-turn-metadata"];
  return object(active) && active.codex_version === CODEX_CLI_ROLE_VERSION
    && active.thread_id === child && active.session_id === parent && active.parent_thread_id === parent
    && active.turn_id === turn && active.thread_source === "subagent" && active.subagent_kind === "thread_spawn";
}

/** Active host format gate for participation; this alone never grants a verifier role. */
export function supportsCodexRepairHost(options: Pick<CodexVerifierContextOptions, "clientInfo" | "requestMeta">): boolean {
  const { clientInfo, requestMeta } = options;
  if (!object(clientInfo) || clientInfo.name !== "codex-mcp-client") return false;
  if (clientInfo.version === CODEX_ROLLOUT_VERSION) return true;
  if (clientInfo.version !== CODEX_CLI_ROLE_VERSION || !object(requestMeta)
    || !id(requestMeta.threadId) || !id(requestMeta.sessionId) || !id(requestMeta.callId)) return false;
  const active = requestMeta["x-codex-turn-metadata"];
  if (!object(active) || !id(active.turn_id) || active.codex_version !== CODEX_CLI_ROLE_VERSION
    || active.thread_id !== requestMeta.threadId || active.session_id !== requestMeta.sessionId) return false;
  return requestMeta.threadId === requestMeta.sessionId
    ? active.parent_thread_id === undefined && active.subagent_kind === undefined && active.thread_source === "user"
    : cliMetadata(requestMeta, requestMeta.threadId, requestMeta.sessionId, active.turn_id);
}

function cliItem(parentRows: Row[], childRows: Row[], meta: Row, tool: string, turn: string, required: boolean): Row | undefined {
  const matches = (rows: Row[]) => rows.filter((r) => r.payload?.item?.id === meta.callId
    || (r.type === "response_item" && r.payload?.call_id === meta.callId));
  const parentMatches = matches(parentRows);
  const childMatches = matches(childRows);
  if (parentMatches.length || childMatches.length > 1 || (required && childMatches.length !== 1))
    throw new Error("missing, duplicate or parent-owned CLI request item");
  if (!childMatches.length) return undefined;
  const r = childMatches[0]!;
  const p = r.payload;
  const item = p?.item;
  const initialRows = childRows.filter((row) => (row.type === "event_msg" && row.payload?.type === "task_started")
    || (row.type === "response_item" && row.payload?.type === "agent_message"));
  const initialTimes = initialRows.map((row) => Date.parse(row.timestamp));
  if (r.type !== "event_msg" || p.type !== "item_completed" || !object(item) || item.type !== "McpToolCall"
    || item.status !== "completed" || item.server !== CODEX_CLI_ROLE_SERVER || item.tool !== tool
    || p.thread_id !== meta.threadId || p.turn_id !== turn || !object(item.arguments) || !object(item.result)
    || !Number.isSafeInteger(p.started_at_ms) || !Number.isSafeInteger(p.completed_at_ms)
    || p.started_at_ms < 0 || p.completed_at_ms < p.started_at_ms
    || initialRows.length !== 2 || initialTimes.some((time) => !Number.isFinite(time))
    || initialRows.some((row) => childRows.indexOf(row) >= childRows.indexOf(r))
    || p.started_at_ms < Math.max(Date.parse(childRows[0]!.payload.timestamp), ...initialTimes))
    throw new Error("CLI request item does not match active host request");
  return item;
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

function header(rows: Row[], session: string, rootSession = session, version = CODEX_ROLLOUT_VERSION): Row {
  const p = rows[0]?.payload;
  if (rows.filter((r) => r.type === "session_meta").length !== 1 || rows[0]?.type !== "session_meta" || !object(p) || p.id !== session || p.session_id !== rootSession)
    throw new Error("session header does not match request identity");
  if (p.cli_version !== version || p.originator !== "Codex Desktop" || !id(p.creator_user_id)
    || !Number.isFinite(Date.parse(p.timestamp))) throw new Error("unsupported rollout header/version");
  return p;
}

function args(row: Row): Row {
  const parsed: unknown = JSON.parse(row.payload.arguments);
  if (!object(parsed)) throw new Error("unknown collaboration arguments");
  return parsed;
}

export type FreshCodexCliContext = { supported: true; identity: VerifierIdentity; prompt: string; launchedAt: string; launch: string }
  | { supported: false; reason: string };

/** Shares provenance checks with roles, but does not issue a role or a receipt. */
export function resolveFreshCodexCliContext(options: CodexVerifierContextOptions): FreshCodexCliContext {
  if (!object(options.clientInfo) || options.clientInfo.version !== CODEX_CLI_ROLE_VERSION)
    return { supported: false, reason: "Codex: fresh CLI context requires the measured CLI profile" };
  return resolveCodexProvenance(options);
}

/** Version-specific local provenance; opaque initial prompt contents remain an accepted risk. */
export function resolveCodexVerifierContext(options: CodexVerifierContextOptions): TrustedVerifierContext {
  const resolved = resolveCodexProvenance(options);
  return resolved.supported ? { supported: true, identity: resolved.identity } : resolved;
}

function resolveCodexProvenance(options: CodexVerifierContextOptions): FreshCodexCliContext {
  const { principal, clientInfo, requestMeta, transcriptDir } = options;
  if (typeof principal !== "string" || !principal.trim()) return refuse("missing resolved principal");
  if (!object(clientInfo) || clientInfo.name !== "codex-mcp-client"
    || ![CODEX_ROLLOUT_VERSION, CODEX_CLI_ROLE_VERSION].includes(clientInfo.version))
    return refuse("unsupported MCP client/version");
  const cli = clientInfo.version === CODEX_CLI_ROLE_VERSION;
  if (!object(requestMeta) || !id(requestMeta.threadId) || !id(requestMeta.sessionId) || !id(requestMeta.callId))
    return refuse("missing or invalid host request metadata");
  const childId = requestMeta.threadId;
  const parentId = requestMeta.sessionId;
  if (childId === parentId) return refuse("repair verifier requires a fresh child session");
  try {
    const allFiles = files(transcriptDir);
    const childRows = selected(allFiles, childId);
    const parentRows = selected(allFiles, parentId);
    const child = header(childRows, childId, parentId, cli ? CODEX_CLI_ROLE_VERSION : CODEX_ROLLOUT_VERSION);
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
    if (cli && (!cliMetadata(requestMeta, childId, parentId, initialTurn)
      || typeof options.requestTool !== "string" || !options.requestTool.trim()))
      return refuse("CLI active host metadata does not bind the measured version and initial task");
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
    const launchPrompt = args(launch).message;
    if (cli) {
      const tasks = childRows.filter((r) => r.type === "response_item" && r.payload?.type === "agent_message");
      const task = tasks[0]?.payload;
      if (tasks.length !== 1 || !object(task) || task.author !== "/root" || task.recipient !== spawn.agent_path
        || task.internal_chat_message_metadata_passthrough?.turn_id !== initialTurn
        || !Array.isArray(task.content) || task.content.length !== 2
        || task.content[0]?.type !== "input_text" || typeof task.content[0].text !== "string"
        || task.content[1]?.type !== "encrypted_content" || typeof launchPrompt !== "string"
        || task.content[1].encrypted_content !== launchPrompt)
        return refuse("CLI initial agent task does not bind its unique launch and turn");
    }
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
    if (cli) {
      cliItem(parentRows, childRows, requestMeta, options.requestTool!, initialTurn, false);
      const seen = new Set<string>();
      for (const completed of options.completedRequests ?? []) {
        if (!cliMetadata(completed.requestMeta, childId, parentId, initialTurn)
          || typeof completed.tool !== "string" || !completed.tool.trim()
          || !object(completed.arguments) || !object(completed.result))
          return refuse("invalid trusted completed CLI request");
        if (seen.has(completed.requestMeta.callId)) return refuse("duplicate trusted completed CLI request");
        seen.add(completed.requestMeta.callId);
        const item = cliItem(parentRows, childRows, completed.requestMeta, completed.tool, initialTurn, true)!;
        if (JSON.stringify(item.arguments) !== JSON.stringify(completed.arguments)
          || JSON.stringify(item.result) !== JSON.stringify(completed.result))
          return refuse("completed CLI request arguments or result changed");
      }
    }
    return { supported: true, identity: { principal, harness: "codex", session: parentId, child: childId },
      prompt: typeof launchPrompt === "string" ? launchPrompt : "", launchedAt: launch.timestamp, launch: launch.payload.call_id };
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
