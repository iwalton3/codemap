import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveCodexVerifierContext, recheckCodexVerifierContext, observedCodexVerifierIdentity } from "./codex-verifier-context.js";

import { codexVerifierFixture as fixture, codexVerifierRow as row } from "./test-codex-verifier.js";

test("measured fresh-child provenance supports an unflushed claim and stable replay", () => {
  const f = fixture();
  try {
    const context = resolveCodexVerifierContext(f.options);
    assert.deepEqual(context, { supported: true, identity: { principal: "repo-principal", harness: "codex", session: "parent", child: "child" } });
    assert.deepEqual(recheckCodexVerifierContext(context, f.options), { ok: true });
    assert.deepEqual(observedCodexVerifierIdentity({ ...f.options, requestMeta: { threadId: "parent", sessionId: "parent" } }),
      { principal: "repo-principal", harness: "codex", session: "parent" });
  } finally { f.clean(); }
});

test("fresh sessions sharing a parent/model remain distinct", () => {
  const f = fixture();
  try {
    const first = observedCodexVerifierIdentity(f.options);
    const second = observedCodexVerifierIdentity({ ...f.options, requestMeta: { threadId: "child-two", sessionId: "parent" } });
    assert.notDeepEqual(first, second);
  } finally { f.clean(); }
});

const mutations: [string, (f: ReturnType<typeof fixture>) => void][] = [
  ["missing initial task", (f) => { f.child.splice(1, 1); }],
  ["missing initial input", (f) => { f.child.pop(); }],
  ["initial turn mismatch", (f) => { f.child[2]!.payload.internal_chat_message_metadata_passthrough.turn_id = "other"; }],
  ["direct second user input", (f) => { f.child.push(f.child[2]!); }],
  ["another task turn", (f) => { f.child.push(f.child[1]!); }],
  ["direct user event", (f) => { f.child.push(row("event_msg", { type: "user_message" })); }],
  ["errored launch output", (f) => { f.parent[2]!.payload.output = JSON.stringify({ task_name: "/root/verifier", error: "failure" }); }],
  ["duplicate child header", (f) => { f.child.push(f.child[0]!); }],
  ["wrong child session id", (f) => { f.child[0]!.payload.session_id = "child"; }],
  ["unknown client", (f) => { f.options.clientInfo.version = "next"; }],
  ["missing caller", (f) => { f.options.requestMeta.threadId = ""; }],
  ["top-level caller", (f) => { f.options.requestMeta.threadId = "parent"; }],
  ["wrong parent", (f) => { f.child[0]!.payload.parent_thread_id = "other"; }],
  ["wrong depth", (f) => { f.child[0]!.payload.source.subagent.thread_spawn.depth = 2; }],
  ["unsupported child version", (f) => { f.child[0]!.payload.cli_version = "next"; }],
  ["inherited header", (f) => { f.child[0]!.payload.forked_from_id = "parent"; }],
  ["inherited ordinal", (f) => { f.child[0]!.payload.subagent_history_start_ordinal = 3; }],
  ["inherited launch", (f) => { f.parent[1]!.payload.arguments = JSON.stringify({ task_name: "verifier", fork_turns: "all" }); }],
  ["unknown launch arguments", (f) => { f.parent[1]!.payload.arguments = "encrypted"; }],
  ["duplicate launch", (f) => { f.parent.push(f.parent[1]!); }],
  ["missing launch acknowledgment", (f) => { f.parent.pop(); }],
  ["wrong output path", (f) => { f.parent[2]!.payload.output = JSON.stringify({ task_name: "/root/other" }); }],
  ["wrong source user", (f) => { f.child[0]!.payload.creator_user_id = "other"; }],
  ["child predates launch", (f) => { f.child[0]!.payload.timestamp = "2026-09-26T19:00:00.000Z"; }],
  ["caller call belongs to parent", (f) => { f.options.requestMeta.callId = "spawn-call"; }],
];
for (const [name, mutate] of mutations) test(`refuses ${name}`, () => {
  const f = fixture();
  try { mutate(f); f.save(); assert.equal(resolveCodexVerifierContext(f.options).supported, false); }
  finally { f.clean(); }
});

for (const name of ["followup_task", "send_message", "interrupt_agent"]) {
  for (const target of ["verifier", "/root/verifier", "child"]) test(`replay refuses ${name} to ${target}`, () => {
    const f = fixture();
    try {
      const initial = resolveCodexVerifierContext(f.options);
      assert.equal(initial.supported, true);
      f.parent.push(row("response_item", { type: "function_call", name, call_id: "later-call", arguments: JSON.stringify({ target, message: "[opaque]" }) }));
      f.save();
      assert.equal(recheckCodexVerifierContext(initial, f.options).ok, false);
    } finally { f.clean(); }
  });
}

test("refuses missing/torn/ambiguous local records and request identity swaps", () => {
  const f = fixture();
  try {
    const context = resolveCodexVerifierContext(f.options);
    assert.equal(recheckCodexVerifierContext(context, { ...f.options, principal: "different" }).ok, false);
    writeFileSync(join(f.options.transcriptDir, "rollout-child.jsonl"), "{torn");
    assert.equal(resolveCodexVerifierContext(f.options).supported, false);
    f.save();
    writeFileSync(join(f.options.transcriptDir, "rollout-duplicate-child.jsonl"), "{}");
    assert.equal(resolveCodexVerifierContext(f.options).supported, false);
    rmSync(join(f.options.transcriptDir, "rollout-duplicate-child.jsonl"));
    rmSync(join(f.options.transcriptDir, "rollout-parent.jsonl"));
    assert.equal(resolveCodexVerifierContext(f.options).supported, false);
  } finally { f.clean(); }
});
