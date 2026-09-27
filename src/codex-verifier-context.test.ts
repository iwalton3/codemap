import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveCodexVerifierContext, resolveFreshCodexCliContext, recheckCodexVerifierContext, observedCodexVerifierIdentity, supportsCodexRepairHost } from "./codex-verifier-context.js";

import { codexVerifierFixture as fixture, codexCliVerifierFixture as cliFixture, codexVerifierRow as row } from "./test-codex-verifier.js";

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

test("measured CLI continuation binds active host metadata and exact completed requests with the same ledger identity", () => {
  const f = cliFixture();
  try {
    const context = resolveCodexVerifierContext(f.options);
    assert.deepEqual(context, { supported: true, identity: { principal: "repo-principal", harness: "codex", session: "parent", child: "child" } });
    f.completed();
    assert.deepEqual(recheckCodexVerifierContext(context, f.options), { ok: true });
    const fresh = resolveFreshCodexCliContext(f.options);
    assert.ok(fresh.supported);
    assert.equal(fresh.prompt, "[opaque accepted]");
    assert.equal(fresh.launch, "spawn-call");
    assert.equal(fresh.launchedAt, f.parent[1]!.timestamp);
    assert.deepEqual(observedCodexVerifierIdentity(f.options), observedCodexVerifierIdentity(fixtureIdentityOptions()));
  } finally { f.clean(); }
});

function fixtureIdentityOptions() {
  return { principal: "repo-principal", clientInfo: { name: "codex-mcp-client", version: "0.158.0-alpha.2.1" },
    requestMeta: { threadId: "child", sessionId: "parent" } };
}

const cliMutations: [string, (f: ReturnType<typeof cliFixture>) => void][] = [
  ["unmeasured parent157 child157 lineage", (f) => { f.parent[0]!.payload.cli_version = "0.157.1"; }],
  ["unmeasured child version", (f) => { f.child[0]!.payload.cli_version = "0.158.0-alpha.2.1"; }],
  ["missing active metadata", (f) => { delete (f.options.requestMeta as any)["x-codex-turn-metadata"]; }],
  ["active version mismatch", (f) => { f.options.requestMeta["x-codex-turn-metadata"].codex_version = "next"; }],
  ["active thread mismatch", (f) => { f.options.requestMeta["x-codex-turn-metadata"].thread_id = "other"; }],
  ["active session mismatch", (f) => { f.options.requestMeta["x-codex-turn-metadata"].session_id = "other"; }],
  ["active parent mismatch", (f) => { f.options.requestMeta["x-codex-turn-metadata"].parent_thread_id = "other"; }],
  ["active turn mismatch", (f) => { f.options.requestMeta["x-codex-turn-metadata"].turn_id = "other"; }],
  ["missing actual tool name", (f) => { f.options.requestTool = ""; }],
  ["active child source mismatch", (f) => { f.options.requestMeta["x-codex-turn-metadata"].thread_source = "user"; }],
  ["active child kind mismatch", (f) => { f.options.requestMeta["x-codex-turn-metadata"].subagent_kind = "other"; }],
  ["unmeasured agent child kind", (f) => { f.options.requestMeta["x-codex-turn-metadata"].subagent_kind = "agent"; }],
  ["missing agent task", (f) => { f.child.splice(3, 1); }],
  ["second agent task", (f) => { f.child.push(f.child[3]!); }],
  ["agent task prompt mismatch", (f) => { f.child[3]!.payload.content[1].encrypted_content = "other"; }],
  ["agent task turn mismatch", (f) => { f.child[3]!.payload.internal_chat_message_metadata_passthrough.turn_id = "other"; }],
  ["agent task recipient mismatch", (f) => { f.child[3]!.payload.recipient = "/root/other"; }],
  ["agent task author mismatch", (f) => { f.child[3]!.payload.author = "/root/other"; }],
  ["duplicate native completed item", (f) => { f.completed(); f.child.push(f.child[f.child.length - 1]!); }],
  ["native item belongs to parent", (f) => { f.completed(); f.parent.push(f.child.pop()!); }],
  ["native item wrong thread", (f) => { f.completed(); f.child.at(-1)!.payload.thread_id = "other"; }],
  ["native item wrong turn", (f) => { f.completed(); f.child.at(-1)!.payload.turn_id = "other"; }],
  ["native item wrong server", (f) => { f.completed(); f.child.at(-1)!.payload.item.server = "other"; }],
  ["native item wrong tool", (f) => { f.completed(); f.child.at(-1)!.payload.item.tool = "other"; }],
  ["native item incomplete", (f) => { f.completed(); f.child.at(-1)!.payload.item.status = "in_progress"; }],
  ["completion before task start", (f) => { f.completed(); f.child.splice(1, 0, f.child.pop()!); }],
  ["completion before initial agent task", (f) => { f.completed(); f.child.splice(3, 0, f.child.pop()!); }],
  ["completion interval predates task", (f) => { f.completed(); f.child.at(-1)!.payload.started_at_ms = 1; }],
  ["completion collides with outer custom call", (f) => { f.completed(); f.child.push(row("response_item", { type: "custom_tool_call", call_id: f.options.requestMeta.callId, name: "exec", input: "[synthetic]" })); }],
  ["native item changed arguments", (f) => { f.completed(); f.child.at(-1)!.payload.item.arguments = { injected: true }; }],
  ["native item changed result", (f) => { f.completed(); f.child.at(-1)!.payload.item.result = { content: [] }; }],
  ["missing completed native item", (f) => { f.completed(); f.child.pop(); }],
  ["duplicate trusted expectation", (f) => { f.completed(); f.options.completedRequests.push(f.options.completedRequests[0]!); }],
  ["completed metadata changed version", (f) => { const c = f.completed(); (c.requestMeta as any)["x-codex-turn-metadata"].codex_version = "other"; }],
  ["completed request identity changed", (f) => { const c = f.completed(); (c.requestMeta as any).callId = "other"; }],
  ["additional task", (f) => { f.child.push(f.child[1]!); }],
  ["inherited launch", (f) => { f.parent[1]!.payload.arguments = JSON.stringify({ task_name: "verifier", fork_turns: "all" }); }],
  ["follow-up contamination", (f) => { f.parent.push(row("response_item", { type: "function_call", name: "followup_task", call_id: "follow-up", arguments: JSON.stringify({ target: "verifier" }) })); }],
];
for (const [name, mutate] of cliMutations) test(`CLI role refuses ${name}`, () => {
  const f = cliFixture();
  try { mutate(f); f.save(); assert.equal(resolveCodexVerifierContext(f.options).supported, false); }
  finally { f.clean(); }
});

test("participation host gate preserves Desktop and admits only measured active CLI root and child metadata", () => {
  const f = cliFixture();
  try {
    assert.ok(supportsCodexRepairHost(f.options));
    assert.ok(supportsCodexRepairHost(fixtureIdentityOptions()));
    const root = { ...f.options, requestMeta: { threadId: "parent", sessionId: "parent", callId: "root-call",
      "x-codex-turn-metadata": { codex_version: "0.157.1", thread_id: "parent", session_id: "parent", turn_id: "root-turn", thread_source: "user" } } };
    assert.ok(supportsCodexRepairHost(root));
    assert.equal(resolveCodexVerifierContext({ ...root, requestTool: "claim_verifier" }).supported, false);
    for (const field of ["parent_thread_id", "subagent_kind"]) {
      const changed = structuredClone(root);
      (changed.requestMeta["x-codex-turn-metadata"] as any)[field] = "other";
      assert.equal(supportsCodexRepairHost(changed), false);
    }
    for (const field of ["codex_version", "thread_id", "session_id", "thread_source", "turn_id"]) {
      const changed = structuredClone(root);
      (changed.requestMeta["x-codex-turn-metadata"] as any)[field] = field === "turn_id" ? "" : "other";
      assert.equal(supportsCodexRepairHost(changed), false);
    }
    assert.equal(supportsCodexRepairHost({ clientInfo: { name: "codex-mcp-client", version: "next" }, requestMeta: root.requestMeta }), false);
  } finally { f.clean(); }
});

test("CLI provenance replay refuses torn source and completed result drift", () => {
  const f = cliFixture();
  try {
    const context = resolveCodexVerifierContext(f.options);
    f.completed();
    writeFileSync(join(f.options.transcriptDir, "rollout-child.jsonl"), "{torn");
    assert.equal(recheckCodexVerifierContext(context, f.options).ok, false);
    f.save();
    f.child.at(-1)!.payload.item.result.content[0].text = '{"ok":false}';
    f.save();
    assert.equal(recheckCodexVerifierContext(context, f.options).ok, false);
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
