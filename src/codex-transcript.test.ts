import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { codexSessionHolding, readCodexQuestion } from "./codex-transcript.js";
import { isUnverified, readReader } from "./transcript.js";
import { CODEX_CALL, CODEX_ENTRY, CODEX_SESSION, CODEX_TURN, codexReply, codexRows, codexTranscript } from "./test-codex-transcript.js";

test("native Codex async reply preserves exact questions, human act and source identity", () => {
  const t = codexTranscript(codexRows());
  try {
    const got = readCodexQuestion(CODEX_SESSION, CODEX_CALL, t.dir);
    assert.ok(!isUnverified(got), JSON.stringify(got));
    assert.equal(got.entryId, CODEX_ENTRY);
    assert.equal(got.at, "2026-09-26T18:00:02.000Z");
    assert.deepEqual(got.answers, { "D1: Is f_one invalid?": "Not a defect" });
    assert.deepEqual(got.questions, [{ question: "D1: Is f_one invalid?", options: [{ label: "Not a defect" }, { label: "Repair it" }], multiSelect: false }]);
    assert.equal(got.receipt?.harness, "codex");
    assert.equal(got.receipt?.turnId, CODEX_TURN);
    assert.equal(codexSessionHolding(CODEX_CALL, t.dir), CODEX_SESSION);
    assert.equal(codexSessionHolding(CODEX_ENTRY, t.dir), CODEX_SESSION);
    const dateDir = join(t.dir, "2026", "09", "26");
    mkdirSync(dateDir, { recursive: true });
    renameSync(t.file, join(dateDir, `rollout-date-${CODEX_SESSION}.jsonl`));
    assert.ok(!isUnverified(readCodexQuestion(CODEX_SESSION, CODEX_CALL, t.dir)));
  } finally { t.cleanup(); }
});

test("Codex acknowledgment, cleanup, auto-response, injected role and unknown formats cannot create an answer", () => {
  const t = codexTranscript(codexRows());
  try {
    const good = codexRows();
    const negative: [string, (rows: any[]) => void][] = [
      ["acknowledgment only", (r) => r.pop()],
      ["failed question", (r) => { r[3].payload.output = '{"accepted":false}'; }],
      ["missing display acknowledgment", (r) => { r.splice(3, 1); }],
      ["cleanup only", (r) => { r.pop(); r.push({ type: "event_msg", payload: { type: "serverRequest/resolved", requestId: CODEX_CALL } }); }],
      ["injected skill message", (r) => { r[4].payload.internal_chat_message_metadata_passthrough.content_item_kinds = ["agents_md.instructions"]; }],
      ["auto continuation", (r) => { r[4].payload.internal_chat_message_metadata_passthrough.content_item_kinds = ["auto-continuation"]; }],
      ["auto resolution arguments", (r) => { const a = JSON.parse(r[2].payload.arguments); a.autoResolutionMs = 1; r[2].payload.arguments = JSON.stringify(a); }],
      ["unknown version", (r) => { r[0].payload.cli_version = "next"; }],
      ["child session", (r) => { r[0].payload.thread_source = "subagent"; r[0].payload.parent_thread_id = "parent"; }],
      ["unknown originator", (r) => { r[0].payload.originator = "unknown"; }],
      ["wrong session", (r) => { r[0].payload.session_id = "wrong"; }],
      ["no turn", (r) => { r.splice(1, 1); }],
      ["wrong turn", (r) => { r[4].payload.internal_chat_message_metadata_passthrough.turn_id = "wrong"; }],
      ["missing human metadata", (r) => { delete r[4].payload.internal_chat_message_metadata_passthrough; }],
      ["wrong call", (r) => { r[4].payload.content[0].text = r[4].payload.content[0].text.replace(CODEX_CALL, "call_wrong"); }],
      ["changed question", (r) => { r[4].payload.content[0].text = r[4].payload.content[0].text.replace("f_one", "f_two"); }],
      ["duplicate call", (r) => { r.push(r[2]); }],
      ["missing act time", (r) => { delete r[4].timestamp; }],
      ["wrong creation time", (r) => { r[4].payload.internal_chat_message_metadata_passthrough.create_time += 100; }],
      ["reply before question", (r) => { const reply = r.pop(); r.splice(2, 0, reply); }],
      ["synchronous path", (r) => { r[2].payload.name = "request_user_input"; }],
    ];
    assert.ok(!isUnverified(readCodexQuestion(CODEX_SESSION, CODEX_CALL, t.dir)));
    for (const [name, mutate] of negative) {
      const rows = structuredClone(good);
      mutate(rows);
      t.write(rows);
      const got = readCodexQuestion(CODEX_SESSION, CODEX_CALL, t.dir);
      assert.ok(isUnverified(got), `${name}: ${JSON.stringify(got)}`);
      assert.match(got.unverified, /web questionnaire/);
    }
    t.write(good, '{"torn":');
    assert.ok(isUnverified(readCodexQuestion(CODEX_SESSION, CODEX_CALL, t.dir)), "a torn record does not grant authority");
    assert.ok(isUnverified(readCodexQuestion("../escape", CODEX_CALL, t.dir)));
    assert.ok(isUnverified(readCodexQuestion(CODEX_SESSION, CODEX_CALL, join(t.dir, "missing"))));
    assert.ok(isUnverified(codexSessionHolding("../escape", t.dir)));
  } finally { t.cleanup(); }
});

test("partial native replies stay separate and multiple replies require exact selection", () => {
  const questions = [{ title: "D1: F1?", options: ["Yes", "No"] }, { title: "D2: F2?", options: ["Yes", "No"] }];
  const all = codexRows(questions, ["Yes"]);
  const t = codexTranscript(all);
  try {
    const partial = readCodexQuestion(CODEX_SESSION, CODEX_CALL, t.dir);
    assert.ok(!isUnverified(partial));
    assert.equal(partial.questions.length, 2);
    assert.deepEqual(partial.answers, { "D1: F1?": "Yes" });
    all.push(codexReply(questions, ["No", "Yes"], "2026-09-26T18:00:03.000Z", "msg_second"));
    t.write(all);
    assert.ok(isUnverified(readCodexQuestion(CODEX_SESSION, CODEX_CALL, t.dir)));
    const first = readCodexQuestion(CODEX_SESSION, CODEX_CALL, t.dir, CODEX_ENTRY);
    const second = readCodexQuestion(CODEX_SESSION, CODEX_CALL, t.dir, "msg_second");
    assert.ok(!isUnverified(first)); assert.ok(!isUnverified(second));
    assert.deepEqual(first.answers, { "D1: F1?": "Yes" });
    assert.deepEqual(second.answers, { "D1: F1?": "No", "D2: F2?": "Yes" });
    assert.notEqual(first.receipt?.entryId, second.receipt?.entryId);
  } finally { t.cleanup(); }
});

test("a Codex child identity does not masquerade as supported reader provenance", () => {
  const got = readReader(CODEX_SESSION, "call_verdict");
  assert.ok(isUnverified(got));
  assert.match(got.unverified, /unsupported.*purpose-specific host binding/);
  assert.match(got.unverified, /bare native ID or outer exec receipt/);
});
