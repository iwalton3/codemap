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
import { classifyAnswer, findAskCalls, findCarriers, findMessages, isUnverified, readCall, readMessage, transcriptDir } from "./transcript.js";
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

// --- carriers (owner, D1; Q1, Q4) ---------------------------------------------------------------

const QD: AskedQuestion = { question: "D1: fix?", options: [{ label: "Yes" }, { label: "No" }] };
const ask = (id: string, ts: string) => ({ type: "assistant", uuid: `a-${id}`, timestamp: ts, message: { content: [{ type: "tool_use", name: "AskUserQuestion", id, input: { questions: [QD] } }] } });
const said = (uuid: string, ts: string, text = "D1 B") => ({ type: "user", uuid, origin: { kind: "human" }, timestamp: ts, message: { content: text } });
/** A codemap tool call and its MCP result, as a top-level transcript holds it (measured: `[{type:"text", text:<JSON>}]`). */
const tool = (name: string, id: string, ts: string, out: unknown) => {
  const content = [{ type: "text", text: JSON.stringify(out) }];
  return [{ type: "assistant", uuid: `t-${id}`, timestamp: ts, message: { content: [{ type: "tool_use", name: `mcp__codemap__${name}`, id, input: {} }] } },
    { type: "user", uuid: `tr-${id}`, timestamp: ts, message: { content: [{ type: "tool_result", tool_use_id: id, content }] }, toolUseResult: content }];
};
const files = (sessions: Record<string, unknown[]>) => {
  const dir = mkdtempSync(join(tmpdir(), "codemap-carriers-"));
  for (const [s, lines] of Object.entries(sessions)) writeFileSync(join(dir, `${s}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return dir;
};
const SINCE = "2026-10-06T12:00:00Z";
const carriersOf = async (round: string) => (await import("./ops/decisions.js")).roundCarriers(round);
const asked = async (dir: string, round = "ev1") => {
  const c = findCarriers(await carriersOf(round), SINCE, dir);
  return isUnverified(c) ? c : { calls: (findAskCalls([QD], c, SINCE, dir) as { toolUseId: string }[]).map((x) => x.toolUseId), messages: findMessages("D1 B", c, SINCE, dir).map((m) => m.entryId) };
};

test("A-1 (D1): a session never handed the round is not searched — its call and its person's words are not found", async () => {
  const dir = files({ other: [ask("other-call", "2026-10-06T12:01:00Z"), said("m1", "2026-10-06T12:02:00Z")] });
  assert.deepEqual(findCarriers(await carriersOf("ev1"), SINCE, dir), []);
  const posted = files({ other: [ask("other-call", "2026-10-06T12:01:00Z"), said("m1", "2026-10-06T12:02:00Z")],
    mine: [...tool("post_round", "p1", "2026-10-06T12:00:30Z", { ok: true, round: "ev1" }), ask("mine-call", "2026-10-06T12:03:00Z"), said("m2", "2026-10-06T12:04:00Z")] });
  assert.deepEqual(await asked(posted), { calls: ["mine-call"], messages: ["m2"] }, "the session that posted it is, and it alone");
});

test("A-3 (Q4): reading the round with decision_round carries it — only for what comes after the read", async () => {
  const dir = files({ resumed: [ask("before-read", "2026-10-06T12:01:00Z"),
    ...tool("decision_round", "dr1", "2026-10-06T12:02:00Z", { round: { id: "ev1", label: "R1" } }), ask("after-read", "2026-10-06T12:03:00Z")] });
  assert.deepEqual((await asked(dir) as { calls: string[] }).calls, ["after-read"]);
  const other = files({ s: [...tool("decision_round", "dr1", "2026-10-06T12:02:00Z", { round: { id: "ev2", label: "R2" } }), ask("after", "2026-10-06T12:03:00Z")] });
  assert.deepEqual(findCarriers(await carriersOf("ev1"), SINCE, other), [], "a read of another round carries nothing");
  const survey = files({ s: [...tool("decision_rounds", "drs", "2026-10-06T12:02:00Z", { round: { id: "ev1" } }), ask("after", "2026-10-06T12:03:00Z")] });
  assert.deepEqual(findCarriers(await carriersOf("ev1"), SINCE, survey), [], "the decision_rounds survey is not a read of one round");
});

test("D1: a carrier only in a subagent's file fails closed; carriers in two sessions find the call in the one that has it", async () => {
  const { mkdirSync } = await import("node:fs");
  const dir = files({ parent: [ask("call", "2026-10-06T12:03:00Z")] });
  mkdirSync(join(dir, "parent", "subagents"), { recursive: true });
  writeFileSync(join(dir, "parent", "subagents", "agent-a1234567.jsonl"), tool("post_round", "p1", "2026-10-06T12:01:00Z", { round: "ev1" }).map((l) => JSON.stringify(l)).join("\n") + "\n");
  assert.deepEqual(findCarriers(await carriersOf("ev1"), SINCE, dir), []);
  const two = files({ a: [...tool("post_round", "p1", "2026-10-06T12:01:00Z", { round: "ev1" }), ask("in-a", "2026-10-06T12:03:00Z")],
    b: [...tool("decision_round", "d1", "2026-10-06T12:01:00Z", { round: { id: "ev1" } })] });
  assert.deepEqual((await asked(two) as { calls: string[] }).calls, ["in-a"]);
});

test("Q1: confirm_reading in this session carries the words' round, though another session posted it", async () => {
  const dir = files({ a: [...tool("post_round", "p1", "2026-10-06T12:01:00Z", { round: "ev1" })],
    b: [...tool("confirm_reading", "c1", "2026-10-06T12:05:00Z", { ok: true, confirm: "x", round: "ev1" }), ask("confirm-call", "2026-10-06T12:06:00Z")] });
  assert.deepEqual((await asked(dir) as { calls: string[] }).calls, ["confirm-call"]);
});

test("D1: a named id is checked inside the carried scope, never machine-wide", async () => {
  const dir = files({ a: [ask("before", "2026-10-06T12:00:40Z"), ...tool("post_round", "p1", "2026-10-06T12:01:00Z", { round: "ev1" }), ask("after", "2026-10-06T12:03:00Z")],
    elsewhere: [ask("stranger", "2026-10-06T12:03:00Z")] });
  const c = findCarriers(await carriersOf("ev1"), SINCE, dir, "after");
  assert.ok(!isUnverified(c) && c[0]!.session === "a" && c[0]!.hit !== undefined);
  assert.ok(isUnverified(findCarriers(await carriersOf("ev1"), SINCE, dir, "stranger")), "another session's call");
  assert.ok(isUnverified(findCarriers(await carriersOf("ev1"), SINCE, dir, "before")), "a call before the carrier");
  assert.ok(isUnverified(findCarriers(await carriersOf("ev1"), SINCE, dir, "../x")), "an id that is not an id");
});

test("old structured successful-held results remain eligible for unique legacy rows", async () => {
  const { findVerdictCalls } = await import("./transcript.js");
  const dir = transcript([
    { type: "assistant", isSidechain: false, message: { content: [{ type: "tool_use", id: "v1", name: "mcp__codemap__submit_verdict", input: { answer: "a1", verdict: "D1 → A" } }] } },
    { type: "user", isSidechain: false, toolUseResult: { ok: true, held: true }, message: { content: [{ type: "tool_result", tool_use_id: "v1", content: "{\"ok\":true,\"held\":true}" }] } },
  ]);
  assert.equal(findVerdictCalls("a1", "D1 → A", 0, dir)[0]?.result, "legacy-held");
  const refused = transcript([
    { type: "assistant", isSidechain: false, message: { content: [{ type: "tool_use", id: "v2", name: "mcp__codemap__submit_verdict", input: { answer: "a1", verdict: "D1 → A" } }] } },
    { type: "user", isSidechain: false, toolUseResult: { ok: false, refused: "not held" }, message: { content: [{ type: "tool_result", tool_use_id: "v2", content: "held" }] } },
  ]);
  assert.equal(findVerdictCalls("a1", "D1 → A", 0, refused)[0]?.result, "failed", "structured refusal outranks a misleading text result");
});

test("submit_verdict calls pair with their own successful result and receipt", async () => {
  const { findVerdictCalls } = await import("./transcript.js");
  const { mkdirSync } = await import("node:fs");
  const dir = transcript([]), sub = join(dir, S, "subagents");
  mkdirSync(sub, { recursive: true });
  const agent = "a12345678";
  const base = { isSidechain: true, agentId: agent, sessionId: S };
  const call = (id: string) => ({ ...base, type: "assistant", timestamp: "2026-09-24T00:00:00Z", message: { content: [{ type: "tool_use", id, name: "mcp__codemap__submit_verdict", input: { answer: "a1", verdict: "D1 → A" } }] } });
  const result = (id: string, content: string) => ({ ...base, type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
  const file = join(sub, `agent-${agent}.jsonl`);
  writeFileSync(file, [call("refused"), result("refused", JSON.stringify({ ok: false, refused: "bad" })),
    call("held"), result("held", JSON.stringify({ ok: true, held: true, receipt: "opaque-1" })),
    call("delayed"), result("wrong-call", JSON.stringify({ ok: true, held: true, receipt: "opaque-2" }))]
    .map((x) => JSON.stringify(x)).join("\n") + "\n");
  const found = findVerdictCalls("a1", "D1 → A", 0, dir);
  assert.deepEqual(found.map((x) => [x.callId, x.result, x.receipt]),
    [["refused", "failed", undefined], ["held", "held", "opaque-1"], ["delayed", "missing", undefined]]);
});
