import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_ROLLOUT_VERSION } from "./codex-transcript.js";

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
