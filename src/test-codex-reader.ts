import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexCliVerifierFixture, codexVerifierRow } from "./test-codex-verifier.js";
import { mintCodexReaderSubmission } from "./codex-reader.js";
import { CODEX_CLI_ROLE_SERVER } from "./codex-harness.js";

export function nativeReaderFixture(prompt: string, tool: string, arguments_: Record<string, unknown>) {
  const f = codexCliVerifierFixture();
  f.options.requestTool = tool;
  f.parent[1]!.payload.arguments = JSON.stringify({ task_name: "verifier", fork_turns: "none", message: prompt });
  f.child.find(row => row.payload.type === "agent_message")!.payload.content[1].encrypted_content = prompt;
  f.save();
  const submission = mintCodexReaderSubmission({ ...f.options, tool, arguments: arguments_ }, f.options.transcriptDir);
  if ("error" in submission) throw new Error(submission.error);
  const completed = (receipt: string) => {
    f.child.push(codexVerifierRow("event_msg", { type: "item_completed", thread_id: "child", turn_id: "initial-turn",
      started_at_ms: 1790449496000, completed_at_ms: 1790449496001,
      item: { type: "McpToolCall", id: f.options.requestMeta.callId, server: CODEX_CLI_ROLE_SERVER,
        tool, arguments: arguments_, status: "completed",
        result: { content: [{ type: "text", text: JSON.stringify({ ok: true, held: true, receipt }, null, 2) }] } } }));
    f.save();
    return { requestId: arguments_.requestId as string, receipt, agentId: "child", callId: f.options.requestMeta.callId };
  };
  const eraseChild = () => writeFileSync(join(f.options.transcriptDir, "rollout-child.jsonl"), "{torn\n");
  return { ...f, submission, completed, eraseChild };
}
