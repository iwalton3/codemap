/**
 * The transcript reader. Every fixture below mirrors a shape measured in a real Claude Code
 * transcript on 2026-09-23 (docs/decision-rounds-worked-cases.md): the call's `tool_use`, its
 * paired `user` result with `toolUseResult`, a person's typed message (`origin.kind: human`),
 * a queued command whose origin sits on the ATTACHMENT, a goal continuation and a subagent
 * hand-back. Each negative is paired with the positive it would otherwise pass vacuously.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyAnswer, isUnverified, readCall, readMessage, transcriptDir } from "./transcript.js";
import type { AskedQuestion } from "./schema.js";

const S = "0f0e0d0c-aaaa-bbbb-cccc-000000000001";
const Q1: AskedQuestion = { question: "Is F14 a real defect?", header: "F14", options: [{ label: "Not a defect", description: "close as refuted" }, { label: "Real, fix it" }], multiSelect: false };
const Q2: AskedQuestion = { question: "Check any to rule on separately", header: "Bulk", options: [{ label: "Keep" }, { label: "Keep both" }, { label: "None — approve all" }], multiSelect: true };

const call = (id: string, questions: unknown, over: Record<string, unknown> = {}) => ({
  type: "assistant", uuid: `a-${id}`, isSidechain: false,
  message: { content: [{ type: "text", text: "asking" }, { type: "tool_use", id, name: "AskUserQuestion", input: { questions } }] }, ...over,
});
const result = (id: string, questions: unknown, answers: unknown, over: Record<string, unknown> = {}) => ({
  type: "user", uuid: `r-${id}`, isSidechain: false, sourceToolAssistantUUID: `a-${id}`,
  message: { content: [{ type: "tool_result", tool_use_id: id, content: "The user answered: …" }] },
  timestamp: "2026-09-23T10:00:00.000Z", toolUseResult: { questions, answers }, ...over,
});

function transcript(lines: unknown[], session = S): string {
  const dir = mkdtempSync(join(tmpdir(), "codemap-transcript-"));
  writeFileSync(join(dir, `${session}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n{\"torn\":");
  return dir;
}

test("a call is read from its structured result, and a false multiSelect the result drops still matches", () => {
  const dropped = { ...Q1 }; delete dropped.multiSelect;
  const dir = transcript([call("t1", [Q1]), result("t1", [dropped], { [Q1.question]: "Not a defect" })]);
  const r = readCall(S, "t1", dir);
  assert.ok(!isUnverified(r), JSON.stringify(r));
  assert.equal(r.entryId, "r-t1");
  assert.equal(r.at, "2026-09-23T10:00:00.000Z", "when the person answered, which binds it to questions posted before");
  assert.deepEqual(r.answers, { [Q1.question]: "Not a defect" });
  assert.equal(r.questions[0]!.multiSelect, false);
});

test("a multi-select answer is a list, and typed Other text is one more element", () => {
  const dir = transcript([call("t2", [Q2]), result("t2", [Q2], { [Q2.question]: ["Keep both", "I want to talk about the tag"] })]);
  const r = readCall(S, "t2", dir);
  assert.ok(!isUnverified(r));
  assert.deepEqual(classifyAnswer(Q2, r.answers[Q2.question]!), [
    { kind: "label", label: "Keep both" },
    { kind: "words", words: "I want to talk about the tag" },
  ]);
});

test("the four answer shapes are told apart, and the longest label wins", () => {
  assert.deepEqual(classifyAnswer(Q1, "Real, fix it"), [{ kind: "label", label: "Real, fix it" }]);
  assert.deepEqual(classifyAnswer(Q1, "Only if it is cheap"), [{ kind: "words", words: "Only if it is cheap" }]);
  assert.deepEqual(classifyAnswer(Q1, "Not a defect — but log it"), [{ kind: "label+words", label: "Not a defect", words: "but log it" }]);
  assert.deepEqual(classifyAnswer(Q2, ["Keep both, then tag", "Keep"]), [
    { kind: "label+words", label: "Keep both", words: "then tag" },
    { kind: "label", label: "Keep" },
  ]);
});

test("what could not be checked reads unverified, each for its own reason", () => {
  const good = [call("t3", [Q1]), result("t3", [Q1], { [Q1.question]: "Not a defect" })];
  assert.ok(!isUnverified(readCall(S, "t3", transcript(good))));   // the positive the rest vary
  const cases: [string, unknown[], string?][] = [
    ["no such call", good.slice(0, 1)],
    ["result text only", [call("t3", [Q1]), { ...result("t3", [Q1], {}), toolUseResult: undefined }]],
    ["a different question in the result", [call("t3", [Q1]), result("t3", [{ ...Q1, question: "Is F15 real?" }], {})]],
    ["an answer keyed by an unasked question", [call("t3", [Q1]), result("t3", [Q1], { "Something else?": "yes" })]],
    ["a result from a sidechain", [call("t3", [Q1]), result("t3", [Q1], { [Q1.question]: "Not a defect" }, { isSidechain: true })]],
    ["a result naming another call", [call("t3", [Q1]), result("t3", [Q1], { [Q1.question]: "Not a defect" }, { sourceToolAssistantUUID: "a-other" })]],
    ["a result carrying an origin", [call("t3", [Q1]), result("t3", [Q1], { [Q1.question]: "Not a defect" }, { origin: { kind: "peer" } })]],
    ["a result with no timestamp", [call("t3", [Q1]), result("t3", [Q1], { [Q1.question]: "Not a defect" }, { timestamp: undefined })]],
    ["another tool's call", [{ ...call("t3", [Q1]), message: { content: [{ type: "tool_use", id: "t3", name: "Bash", input: {} }] } }]],
  ];
  for (const [name, lines] of cases) {
    const r = readCall(S, "t3", transcript(lines));
    assert.ok(isUnverified(r), `${name} should be unverified`);
  }
  assert.ok(isUnverified(readCall(S, "t3", join(tmpdir(), "codemap-no-such-dir"))), "a missing transcript");
  // The traversal lands on a real transcript, so only the id check can refuse it.
  assert.ok(isUnverified(readCall(`x/../${S}`, "t3", transcript(good))), "a session id that is a path");
});

const typed = (uuid: string, text: unknown, origin: unknown, over: Record<string, unknown> = {}) =>
  ({ type: "user", uuid, isSidechain: false, origin, promptSource: "typed", timestamp: "2026-09-23T10:00:00.000Z", message: { role: "user", content: text }, ...over });
const queued = (uuid: string, prompt: unknown, origin: unknown) =>
  ({ type: "attachment", uuid, isSidechain: false, timestamp: "2026-09-23T10:00:00.000Z", attachment: { type: "queued_command", prompt, commandMode: "prompt", origin } });

test("the person's words: typed, queued and an accepted suggestion count; goals, peers and bare queue operations do not", () => {
  const dir = transcript([
    typed("m1", "D2 A", { kind: "human" }),
    typed("m2", [{ type: "text", text: "D2 A" }], { kind: "human" }, { promptSource: "suggestion_accepted" }),
    queued("m3", "D3 park 2026-10-15", { kind: "human" }),
    queued("m4", "Goal set: keep going", { kind: "auto-continuation" }),
    typed("m5", "D2 A", { kind: "peer", from: "agent-1" }),
    { type: "queue-operation", uuid: "m6", operation: "enqueue", content: "D2 A" },
    typed("m7", "D2 A", undefined),
    queued("m8", "D2 A", undefined),
    typed("m9", "D2 A", { kind: "human" }, { isSidechain: true }),
  ]);
  for (const id of ["m1", "m2", "m3"]) assert.ok(!isUnverified(readMessage(S, id, dir)), `${id} is the person's`);
  for (const id of ["m4", "m5", "m6", "m7", "m8", "m9"]) assert.ok(isUnverified(readMessage(S, id, dir)), `${id} is not the person's`);
});

test("a message is returned whole, so a relay can never carry part of it", () => {
  const dir = transcript([typed("w1", "do not run the tests", { kind: "human" })]);
  const r = readMessage(S, "w1", dir);
  assert.ok(!isUnverified(r));
  assert.equal(r.text, "do not run the tests");
  assert.equal(r.at, "2026-09-23T10:00:00.000Z");
  assert.ok(isUnverified(readMessage(S, "w2", transcript([typed("w2", "D1 A", { kind: "human" }, { timestamp: undefined })]))), "no timestamp, no binding");
});

test("the transcript directory is the cwd with every non-alphanumeric turned into a dash", () => {
  const prev = process.env.CODEMAP_TRANSCRIPT_DIR;
  delete process.env.CODEMAP_TRANSCRIPT_DIR;
  try {
    assert.ok(transcriptDir("/home/me/Desktop/codemap").endsWith(join(".claude", "projects", "-home-me-Desktop-codemap")));
  } finally {
    if (prev !== undefined) process.env.CODEMAP_TRANSCRIPT_DIR = prev;
  }
});

test("the session holding an id is found among top-level transcripts only", async () => {
  const { sessionHolding } = await import("./transcript.js");
  const { mkdirSync } = await import("node:fs");
  const dir = transcript([call("tx", [Q1])]);
  mkdirSync(join(dir, S, "subagents"), { recursive: true });
  writeFileSync(join(dir, S, "subagents", "agent-1.jsonl"), JSON.stringify(call("only-in-subagent", [Q1])) + "\n");
  assert.equal(sessionHolding("tx", dir), S);
  assert.ok(isUnverified(sessionHolding("only-in-subagent", dir)), "a subagent's transcript is never the session");
  assert.ok(isUnverified(sessionHolding("nowhere", dir)));
  assert.ok(isUnverified(sessionHolding("../x", dir)), "an id that is not an id");
});
