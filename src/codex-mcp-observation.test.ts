import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { observeCodexCompletedMcp, type CodexMcpObservationExpectation } from "./codex-mcp-observation.js";

function fixture() {
  const expected: CodexMcpObservationExpectation = {
    clientVersion: "0.157.1", threadId: "scratch-child", sessionId: "scratch-parent", turnId: "scratch-turn",
    callId: "scratch-host-call", server: "scratch-production", tool: "claim_verifier", arguments: {},
    result: { content: [{ type: "text", text: '{"ok":false,"error":"unsupported context"}' }] },
  };
  const rows = [
    { type: "session_meta", payload: { id: expected.threadId, session_id: expected.sessionId,
      cli_version: "0.157.1", originator: "Codex Desktop" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: expected.turnId } },
    { type: "event_msg", payload: { type: "item_completed", thread_id: expected.threadId, turn_id: expected.turnId,
      started_at_ms: 1000, completed_at_ms: 1001, item: { type: "McpToolCall", id: expected.callId,
        server: expected.server, tool: expected.tool, arguments: {}, status: "completed", result: structuredClone(expected.result) } } },
  ];
  return { expected, rows: rows as Record<string, any>[], source: () => rows.map((row) => JSON.stringify(row)).join("\n") + "\n" };
}

test("measured completed MCP shape correlates exact host call and result without authority", () => {
  const f = fixture();
  const got = observeCodexCompletedMcp(f.source(), f.expected);
  assert.ok(got.matched);
  assert.equal(got.authority, false);
  assert.equal(got.diagnostic, true);
  assert.equal(got.callDigest, createHash("sha256").update(f.expected.callId).digest("hex"));
  assert.equal(got.resultDigest, createHash("sha256").update(JSON.stringify(f.expected.result)).digest("hex"));
  assert.ok(!JSON.stringify(got).includes(f.expected.threadId));
  assert.ok(!JSON.stringify(got).includes("unsupported context"));
});

const mutations: [string, (f: ReturnType<typeof fixture>) => void][] = [
  ["unknown client", (f) => { f.expected.clientVersion = "next"; }],
  ["unknown header version", (f) => { f.rows[0]!.payload.cli_version = "next"; }],
  ["wrong header thread", (f) => { f.rows[0]!.payload.id = "other"; }],
  ["wrong header parent", (f) => { f.rows[0]!.payload.session_id = "other"; }],
  ["duplicate header", (f) => { f.rows.push(f.rows[0]!); }],
  ["duplicate item identity", (f) => { f.rows.push(f.rows[2]!); }],
  ["item identity in unknown record", (f) => { f.rows.push({ type: "unknown", payload: { item: { id: f.expected.callId } } }); }],
  ["wrong completed thread", (f) => { f.rows[2]!.payload.thread_id = "other"; }],
  ["wrong completed turn", (f) => { f.rows[2]!.payload.turn_id = "other"; }],
  ["wrong tool", (f) => { f.rows[2]!.payload.item.tool = "other"; }],
  ["wrong server", (f) => { f.rows[2]!.payload.item.server = "other"; }],
  ["changed arguments", (f) => { f.rows[2]!.payload.item.arguments = { extra: true }; }],
  ["changed result", (f) => { f.rows[2]!.payload.item.result = { content: [] }; }],
  ["noncompleted status", (f) => { f.rows[2]!.payload.item.status = "in_progress"; }],
  ["unknown item type", (f) => { f.rows[2]!.payload.item.type = "CustomToolCall"; }],
  ["unknown completion event", (f) => { f.rows[2]!.payload.type = "item_started"; }],
  ["missing task turn", (f) => { f.rows.splice(1, 1); }],
  ["duplicate task turn", (f) => { f.rows.push(f.rows[1]!); }],
  ["completion before task", (f) => { [f.rows[1], f.rows[2]] = [f.rows[2]!, f.rows[1]!]; }],
  ["backward completion interval", (f) => { f.rows[2]!.payload.completed_at_ms = 999; }],
  ["missing timing", (f) => { delete f.rows[2]!.payload.started_at_ms; }],
  ["missing arguments", (f) => { delete f.rows[2]!.payload.item.arguments; }],
  ["missing result", (f) => { delete f.rows[2]!.payload.item.result; }],
];
for (const [name, mutate] of mutations) test(`diagnostic correlation refuses ${name}`, () => {
  const f = fixture();
  mutate(f);
  const got = observeCodexCompletedMcp(f.source(), f.expected);
  assert.equal(got.matched, false);
  assert.equal(got.authority, false);
});

test("torn, empty and unknown sources refuse without leaking source contents", () => {
  const f = fixture();
  for (const source of ["", f.source() + '{"private":"unfinished', f.source() + "\nnull", f.source() + "\n[]"] ) {
    const got = observeCodexCompletedMcp(source, f.expected);
    assert.equal(got.matched, false);
    assert.equal(got.authority, false);
    assert.ok(!JSON.stringify(got).includes("private"));
  }
});

test("historical frontend labels never grant frontend or freshness claims", () => {
  const f = fixture();
  f.rows[0]!.payload.originator = "unknown-current-frontend";
  f.rows[0]!.payload.creator_user_id = "synthetic-creator";
  f.rows.push({ type: "event_msg", payload: { type: "task_started", turn_id: "later-turn" } });
  const got = observeCodexCompletedMcp(f.source(), f.expected);
  assert.ok(got.matched);
  assert.equal(got.authority, false);
  assert.ok(!JSON.stringify(got).includes("synthetic-creator"));
});
