/**
 * Claude Code transcripts as the harness writes them, for tests that drive the real MCP server and
 * must hand codemap the session file it would find on disk. Shapes measured 2026-09-23..10-06.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AskedQuestion } from "./schema.js";

const lines = (rows: object[]) => rows.map((x) => JSON.stringify(x)).join("\n") + "\n";
let n = 0;

/** One top-level session file, appended to as the session goes. */
export function sessionFile(dir: string, session: string) {
  const file = join(dir, `${session}.jsonl`);
  const add = (...rows: object[]) => appendFileSync(file, lines(rows));
  return {
    /** A codemap MCP call and the result the server really returned (`content` as the reply carried it). */
    tool(name: string, input: unknown, content: unknown) {
      const id = `toolu_mcp_${++n}`, at = new Date().toISOString();
      add({ type: "assistant", uuid: `t-${id}`, isSidechain: false, timestamp: at, message: { content: [{ type: "tool_use", id, name: `mcp__codemap__${name}`, input }] } },
        { type: "user", uuid: `tr-${id}`, isSidechain: false, timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: id, content }] }, toolUseResult: content });
    },
    /** `AskUserQuestion` and the person's pick, answered `afterMs` from now. */
    ask(questions: AskedQuestion[], answers: Record<string, string | string[]>, afterMs = 1000) {
      const id = `toolu_ask_${++n}`, at = new Date(Date.now() + afterMs).toISOString();
      add({ type: "assistant", uuid: `a-${id}`, isSidechain: false, timestamp: at, message: { content: [{ type: "tool_use", id, name: "AskUserQuestion", input: { questions } }] } },
        { type: "user", uuid: `r-${id}`, isSidechain: false, timestamp: at, sourceToolAssistantUUID: `a-${id}`, message: { content: [{ type: "tool_result", tool_use_id: id, content: "answered" }] }, toolUseResult: { questions, answers } });
      return id;
    },
  };
}

/**
 * A reader subagent launched from `session` with `prompt` that made its own `tool` call with
 * `input` and got `result` — the launch in the parent's file, the call in its own sidechain.
 */
export function readerTranscript(dir: string, session: string, agentId: string, prompt: string, tool: string, input: unknown, result: unknown) {
  const launch = `launch_${agentId}`, callId = `toolu_${agentId}`;
  mkdirSync(join(dir, session, "subagents"), { recursive: true });
  writeFileSync(join(dir, session, "subagents", `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "general-purpose", toolUseId: launch }));
  writeFileSync(join(dir, session, "subagents", `agent-${agentId}.jsonl`), lines([
    { type: "user", isSidechain: true, agentId, sessionId: session, message: { role: "user", content: prompt } },
    { type: "assistant", isSidechain: true, agentId, sessionId: session, message: { content: [{ type: "tool_use", id: callId, name: `mcp__codemap__${tool}`, input }] } },
    { type: "user", isSidechain: true, agentId, sessionId: session, message: { content: [{ type: "tool_result", tool_use_id: callId, content: JSON.stringify(result) }] } },
  ]));
  appendFileSync(join(dir, `${session}.jsonl`), lines([
    { type: "assistant", isSidechain: false, timestamp: new Date().toISOString(), message: { content: [{ type: "tool_use", id: launch, name: "Agent", input: { prompt, subagent_type: "general-purpose" } }] } },
    { type: "user", isSidechain: false, message: { content: [{ type: "tool_result", tool_use_id: launch, content: "launched" }] }, toolUseResult: { agentId } },
  ]));
  return callId;
}
