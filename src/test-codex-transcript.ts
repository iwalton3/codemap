import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CODEX_ROLLOUT_VERSION } from "./codex-transcript.js";
import { discard } from "./test-tmp.js";

export const CODEX_SESSION = "00000000-0000-7000-8000-000000000001";
export const CODEX_CALL = "call_probe";
export const CODEX_ENTRY = "msg_probe";
export const CODEX_TURN = "00000000-0000-7000-8000-000000000002";

export function codexCall(questions: { title: string; options?: string[] }[], at = "2026-09-26T18:00:00.000Z") {
  return { timestamp: at, type: "response_item", payload: { type: "function_call", name: "request_user_input_async",
    call_id: CODEX_CALL, arguments: JSON.stringify({ questions }) } };
}

export function codexReply(questions: { title: string }[], answers: string[], at = "2026-09-26T18:00:02.000Z", entryId = CODEX_ENTRY) {
  const items = answers.map((answer, index) => ({ questionItemId: JSON.stringify(["request_user_input_async", CODEX_CALL, index]), question: questions[index]!.title, answer }));
  return { timestamp: at, type: "response_item", payload: { type: "message", id: entryId, role: "user",
    content: [{ type: "input_text", text: `<send_user_message_question_reply>\n${JSON.stringify(items)}\n</send_user_message_question_reply>` }],
    internal_chat_message_metadata_passthrough: { turn_id: CODEX_TURN, create_time: Date.parse(at) / 1000, content_item_kinds: ["user.text"] } } };
}

export function codexRows(questions = [{ title: "D1: Is f_one invalid?", options: ["Not a defect", "Repair it"] }], answers = ["Not a defect"]) {
  return [
    { timestamp: "2026-09-26T17:59:59.000Z", type: "session_meta", payload: { id: CODEX_SESSION, session_id: CODEX_SESSION,
      cli_version: CODEX_ROLLOUT_VERSION, creator_user_id: "user_synthetic", originator: "Codex Desktop", source: "vscode", thread_source: "user" } },
    { timestamp: "2026-09-26T17:59:59.000Z", type: "event_msg", payload: { type: "task_started", turn_id: CODEX_TURN } },
    codexCall(questions),
    { timestamp: "2026-09-26T18:00:01.000Z", type: "response_item", payload: { type: "function_call_output", call_id: CODEX_CALL, output: "{\"accepted\":true}" } },
    codexReply(questions, answers),
  ];
}

export function codexTranscript(initial: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "codemap-codex-transcript-"));
  const file = join(dir, `rollout-2026-09-26T14-00-00-${CODEX_SESSION}.jsonl`);
  const write = (rows: unknown[], tail = "") => writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n" + tail);
  write(initial);
  return { dir, file, write, cleanup: () => discard(dir) };
}
