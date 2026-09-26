import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { team } from "./oracle.js";
import { universeKey } from "./sidecar-config.js";
import { rpc } from "./test-mcp.js";

const expected = ["application_reader_brief", "submit_application_verdict", "record_application_verdict", "apply_ruling"];

function listTools(root: string): Promise<{ name: string; description: string; inputSchema: any }[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/mcp.js", root], { stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "", done = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error("MCP tools/list timed out")); }, 20_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const at = buffer.indexOf("\n");
      if (at < 0 || done) return;
      done = true;
      try { resolve(JSON.parse(buffer.slice(0, at)).result.tools); }
      catch (e) { reject(e); }
      child.kill();
    });
    child.on("error", reject);
    child.on("close", () => clearTimeout(timer));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
  });
}

test("MCP advertises the four application verbs with exact issue and reader receipt fields", async () => {
  const t = await team(["ana@acme.test"]);
  try {
    const root = t.all[0]!.repo;
    const listed = await listTools(root);
    for (const name of expected) {
      const tool = listed.find((x) => x.name === name);
      assert.ok(tool, `${name} is missing from tools/list`);
      assert.equal(listed.filter((x) => x.name === name).length, 1);
      assert.ok(tool.description.length > 100, `${name} has no workflow guidance`);
    }
    const brief = listed.find((x) => x.name === "application_reader_brief")!;
    const apply = listed.find((x) => x.name === "apply_ruling")!;
    const submit = listed.find((x) => x.name === "submit_application_verdict")!;
    const record = listed.find((x) => x.name === "record_application_verdict")!;
    assert.deepEqual(brief.inputSchema.required, ["issue", "answerId", "slot"]);
    assert.deepEqual(apply.inputSchema.required, ["issue", "answerId", "readers"]);
    assert.deepEqual(apply.inputSchema.properties.issue.required, ["kind", "universe", "id", "scope"]);
    assert.deepEqual(apply.inputSchema.properties.readers.items.required, ["requestId", "receipt", "agentId", "callId"]);
    assert.deepEqual(record.inputSchema.required, ["requestId", "receipt", "agentId", "callId"]);
    assert.deepEqual(submit.inputSchema.properties.verdict.enum, ["sound", "unsound"]);
    assert.match(apply.description, /one sound reader/);
    assert.match(apply.description, /two independent readers/);
    assert.match(apply.description, /transcript never closes|missing transcript never closes/);
  } finally { t.dispose(); }
});

test("MCP routes all four verbs to refusals and rejects undeclared authority flags", async () => {
  const t = await team(["ana@acme.test"]);
  try {
    const root = t.all[0]!.repo;
    const universe = universeKey(root);
    const issue = { kind: "finding", universe, id: "f_missing", scope: `findings/${universe}/pr-7`, review: "7" };
    const out = await rpc(root, [
      { name: "application_reader_brief", arguments: { issue, answerId: "answer_missing", slot: 1 } },
      { name: "submit_application_verdict", arguments: { requestId: "missing", verdict: "sound", rationale: "reviewed" } },
      { name: "record_application_verdict", arguments: { requestId: "missing", receipt: "r", agentId: "a12345678", callId: "c" } },
      { name: "apply_ruling", arguments: { issue, answerId: "answer_missing", readers: [] } },
      { name: "apply_ruling", arguments: { issue, answerId: "answer_missing", readers: [], agent: false } },
    ]);
    assert.equal(out.length, 5);
    assert.match(out[0]!, /no finding f_missing under the requested review or scope/);
    assert.match(out[1]!, /no application reader brief/);
    assert.match(out[2]!, /no application reader brief/);
    assert.match(out[3]!, /no finding f_missing under the requested review or scope/);
    assert.match(out[4]!, /unknown parameter.*agent/);
  } finally { t.dispose(); }
});


test("MCP operation sign-off surface preserves narrow receipt inputs and refuses authority impersonation", async () => {
  const t = await team(["ana@acme.test"]);
  try {
    const root = t.all[0]!.repo;
    const listed = await listTools(root);
    const names = ["operation_signoff_question", "operation_signoff_reader_brief", "submit_operation_signoff_verdict", "record_operation_signoff_verdict", "apply_operation_signoff"];
    for (const name of names) assert.equal(listed.filter(x => x.name === name).length, 1, name);
    const apply = listed.find(x => x.name === "apply_operation_signoff")!;
    assert.deepEqual(apply.inputSchema.required, ["operationId", "answerId", "reader"]);
    assert.deepEqual(apply.inputSchema.properties.reader.required, ["requestId", "receipt", "agentId", "callId"]);
    assert.equal(apply.inputSchema.properties.principal, undefined);
    assert.match(apply.description, /never approves framing/);
    const out = await rpc(root, [
      { name: "operation_signoff_question", arguments: { operationId: "missing" } },
      { name: "operation_signoff_reader_brief", arguments: { operationId: "missing", answerId: "missing" } },
      { name: "submit_operation_signoff_verdict", arguments: { requestId: "missing", verdict: "sound", rationale: "read" } },
      { name: "record_operation_signoff_verdict", arguments: { requestId: "missing", receipt: "r", agentId: "a12345678", callId: "c" } },
      { name: "apply_operation_signoff", arguments: { operationId: "missing", answerId: "missing", reader: { requestId: "missing", receipt: "r", agentId: "a12345678", callId: "c" }, principal: "alice@other.test" } },
    ]);
    assert.equal(out.length, 5);
    assert.match(out[0] ?? "", /draft operation|configured sidecar/);
    assert.match(JSON.stringify(out[4]), /principal|unknown|undeclared|unexpected/);
  } finally { t.dispose(); }
});
