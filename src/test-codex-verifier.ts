import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_ROLLOUT_VERSION } from "./codex-harness.js";
import { CODEX_CLI_ROLE_VERSION, CODEX_CLI_ROLE_SERVER } from "./codex-harness.js";
import type { CodexCompletedVerifierRequest } from "./codex-verifier-context.js";

type Row = Record<string, any>;
export const codexVerifierRow = (type: string, payload: Row, timestamp = "2026-09-26T19:04:55.292Z") => ({ type, timestamp, payload });
export function codexVerifierFixture() {
  const dir = mkdtempSync(join(tmpdir(), "codemap-codex-verifier-"));
  const parent: Row[] = [codexVerifierRow("session_meta", { id: "parent", session_id: "parent", creator_user_id: "user", originator: "Codex Desktop",
    cli_version: CODEX_ROLLOUT_VERSION, source: "vscode", thread_source: "user", timestamp: "2026-09-26T19:00:00.000Z" }),
  codexVerifierRow("response_item", { type: "function_call", name: "spawn_agent", call_id: "spawn-call", arguments: JSON.stringify({ task_name: "verifier", fork_turns: "none", message: "[opaque accepted]" }) }),
  codexVerifierRow("response_item", { type: "function_call_output", call_id: "spawn-call", output: JSON.stringify({ task_name: "/root/verifier" }) }, "2026-09-26T19:04:55.435Z")];
  const child: Row[] = [codexVerifierRow("session_meta", { id: "child", session_id: "parent", creator_user_id: "user", originator: "Codex Desktop",
    cli_version: CODEX_ROLLOUT_VERSION, timestamp: "2026-09-26T19:04:55.296Z", parent_thread_id: "parent", agent_path: "/root/verifier",
    source: { subagent: { thread_spawn: { parent_thread_id: "parent", depth: 1, agent_path: "/root/verifier", agent_nickname: "Fixture", agent_role: null } } },
    thread_source: "subagent", multi_agent_version: "v2", history_mode: "paginated" }),
    codexVerifierRow("event_msg", { type: "task_started", turn_id: "initial-turn" }),
    codexVerifierRow("response_item", { type: "message", role: "user", id: "initial-message", content: [{ type: "input_text", text: "[opaque accepted]" }],
      internal_chat_message_metadata_passthrough: { turn_id: "initial-turn", create_time: 1790449495.3, content_item_kinds: ["user.text"] } })];
  const options = { principal: "repo-principal", clientInfo: { name: "codex-mcp-client", version: CODEX_ROLLOUT_VERSION },
    requestMeta: { threadId: "child", sessionId: "parent", callId: "claim-call" }, transcriptDir: dir };
  const save = () => { writeFileSync(join(dir, "rollout-parent.jsonl"), parent.map((r) => JSON.stringify(r)).join("\n") + "\n");
    writeFileSync(join(dir, "rollout-child.jsonl"), child.map((r) => JSON.stringify(r)).join("\n") + "\n"); };
  save();
  return { parent, child, options, save, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

export function codexCliVerifierFixture() {
  const base = codexVerifierFixture();
  base.child[0]!.payload.cli_version = CODEX_CLI_ROLE_VERSION;
  const requestMeta = { ...base.options.requestMeta, "x-codex-turn-metadata": {
    codex_version: CODEX_CLI_ROLE_VERSION, thread_id: "child", session_id: "parent", parent_thread_id: "parent", turn_id: "initial-turn",
    thread_source: "subagent", subagent_kind: "thread_spawn",
  } };
  base.child.push(codexVerifierRow("response_item", { type: "agent_message", author: "/root", recipient: "/root/verifier",
    content: [{ type: "input_text", text: "Message Type: NEW_TASK" }, { type: "encrypted_content", encrypted_content: "[opaque accepted]" }],
    internal_chat_message_metadata_passthrough: { turn_id: "initial-turn" } }));
  const options = { ...base.options, clientInfo: { name: "codex-mcp-client", version: CODEX_CLI_ROLE_VERSION },
    requestMeta, requestTool: "claim_verifier", completedRequests: [] as CodexCompletedVerifierRequest[] };
  const completed = (): CodexCompletedVerifierRequest => {
    const item = { type: "McpToolCall", id: requestMeta.callId, server: CODEX_CLI_ROLE_SERVER,
      tool: options.requestTool, arguments: {}, status: "completed",
      result: { content: [{ type: "text", text: '{"ok":true}' }] } };
    base.child.push(codexVerifierRow("event_msg", { type: "item_completed", thread_id: "child", turn_id: "initial-turn",
      started_at_ms: 1790449496000, completed_at_ms: 1790449496001, item }));
    const expectation = { requestMeta: structuredClone(requestMeta), tool: item.tool,
      arguments: structuredClone(item.arguments), result: structuredClone(item.result) };
    options.completedRequests.push(expectation);
    base.save();
    return expectation;
  };
  base.save();
  return { ...base, options, completed };
}
