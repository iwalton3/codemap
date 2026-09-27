import { test } from "node:test";
import assert from "node:assert/strict";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bindCodexReaderHost, mintCodexReaderSubmission, verifyCodexReaderReceipt } from "./codex-reader.js";
import { codexCliVerifierFixture, codexVerifierRow } from "./test-codex-verifier.js";

function fixture(purpose: "issue-application" | "operation-signoff" = "issue-application") {
  const f = codexCliVerifierFixture();
  const tool = purpose === "issue-application" ? "submit_application_verdict" : "submit_operation_signoff_verdict";
  const body = { verdict: "sound", rationale: "the actual ruling defeats this premise" };
  const args = { requestId: "reader-request", ...body };
  f.options.requestTool = tool;
  const cap = mintCodexReaderSubmission({ ...f.options, tool, arguments: args }, f.options.transcriptDir);
  assert.ok(!("error" in cap));
  const nativeHost = bindCodexReaderHost(cap, purpose, args.requestId, JSON.stringify(body));
  assert.equal(typeof nativeHost, "string");
  f.completed();
  const item = f.child.at(-1)!.payload.item;
  item.arguments = args;
  item.result = { content: [{ type: "text", text: JSON.stringify({ ok: true, held: true, receipt: "held-token" }, null, 2) }] };
  f.save();
  const input = { nativeHost: nativeHost as string, purpose, requestId: args.requestId,
    prompt: "[opaque accepted]", body, receipt: "held-token", agentId: "child", callId: f.options.requestMeta.callId, dir: f.options.transcriptDir };
  return { ...f, input, item, cap, args, body };
}

for (const purpose of ["issue-application", "operation-signoff"] as const) test(`native ${purpose} reader binds the held tool result and exact launch`, () => {
  const f = fixture(purpose);
  try { assert.deepEqual(verifyCodexReaderReceipt(f.input), { agentId: "child", callId: "claim-call", session: "child",
    launch: "spawn-call", launchedAt: "2026-09-26T19:04:55.292Z" }); }
  finally { f.clean(); }
});

test("native host binding rejects serialized lookalikes and wrong receipt purposes/content", () => {
  const f = fixture();
  try {
    assert.equal(typeof bindCodexReaderHost({ nativeReaderSubmission: true }, f.input.purpose, f.input.requestId, JSON.stringify(f.body)), "object");
    for (const [purpose, request, body] of [["operation-signoff", f.input.requestId, f.body],
      [f.input.purpose, "another", f.body], [f.input.purpose, f.input.requestId, { ...f.body, rationale: "changed" }]])
      assert.equal(typeof bindCodexReaderHost(f.cap, purpose as string, request as string, JSON.stringify(body)), "object");
  } finally { f.clean(); }
});

const inputChanges = {
  "child": { agentId: "other" }, "call": { callId: "other" }, "brief": { prompt: "rewritten" },
  "request": { requestId: "other" }, "receipt": { receipt: "other" }, "purpose": { purpose: "operation-signoff" },
  "body": { body: { verdict: "unsound", rationale: "changed" } }, "host": { nativeHost: "{}" },
};
for (const [name, change] of Object.entries(inputChanges)) test(`native reader rejects changed ${name}`, () => {
  const f = fixture(); try { assert.ok("error" in verifyCodexReaderReceipt({ ...f.input, ...change })); } finally { f.clean(); }
});

const mutations: Record<string, (f: ReturnType<typeof fixture>) => void> = {
  "arguments": f => { f.item.arguments.rationale = "different"; },
  "result receipt": f => { f.item.result.content[0].text = JSON.stringify({ ok: true, held: true, receipt: "different" }, null, 2); },
  "failed result": f => { f.item.result.content[0].text = JSON.stringify({ error: "refused" }, null, 2); },
  "tool": f => { f.item.tool = "submit_operation_signoff_verdict"; },
  "server": f => { f.item.server = "other"; },
  "duplicate completed item": f => { f.child.push(structuredClone(f.child.at(-1)!)); },
  "inherited history": f => { f.child[0]!.payload.forked_from_id = "other"; },
  "launch history": f => { f.parent[1]!.payload.arguments = JSON.stringify({ task_name: "verifier", fork_turns: "all", message: f.input.prompt }); },
  "child task": f => { const m = f.child.find(r => r.payload.type === "agent_message")!; m.payload.content[1].encrypted_content = "changed"; },
  "followup": f => { f.parent.push(codexVerifierRow("response_item", { type: "function_call", name: "send_message", call_id: "followup", arguments: JSON.stringify({ target: "verifier", message: "agree" }) })); },
  "additional task": f => { f.child.push(codexVerifierRow("event_msg", { type: "task_started", turn_id: "another" })); },
};
for (const [name, mutate] of Object.entries(mutations)) test(`native reader rechecks ${name} after holding`, () => {
  const f = fixture(); try { mutate(f); f.save(); assert.ok("error" in verifyCodexReaderReceipt(f.input)); } finally { f.clean(); }
});

test("native reader refuses torn provenance and later source loss", () => {
  const f = fixture();
  try {
    const file = join(f.options.transcriptDir, "rollout-child.jsonl");
    writeFileSync(file, "{torn\n"); assert.ok("error" in verifyCodexReaderReceipt(f.input));
    f.save(); unlinkSync(file); assert.ok("error" in verifyCodexReaderReceipt(f.input));
  } finally { f.clean(); }
});

test("fresh sibling readers retain distinct actual caller sessions", () => {
  const first = fixture(), second = fixture();
  try {
    const host = JSON.parse(second.input.nativeHost);
    host.requestMeta.threadId = "sibling";
    host.requestMeta["x-codex-turn-metadata"].thread_id = "sibling";
    second.input.nativeHost = JSON.stringify(host);
    second.input.agentId = "sibling";
    second.child[0]!.payload.id = "sibling";
    second.child.at(-1)!.payload.thread_id = "sibling";
    second.save();
    renameSync(join(second.options.transcriptDir, "rollout-child.jsonl"), join(second.options.transcriptDir, "rollout-sibling.jsonl"));
    const a = verifyCodexReaderReceipt(first.input), b = verifyCodexReaderReceipt(second.input);
    assert.ok(!("error" in a)); assert.ok(!("error" in b));
    assert.notEqual(a.session, b.session);
    assert.equal(JSON.parse(first.input.nativeHost).requestMeta.sessionId, JSON.parse(second.input.nativeHost).requestMeta.sessionId);
  } finally { first.clean(); second.clean(); }
});
