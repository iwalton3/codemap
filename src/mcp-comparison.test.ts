import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { team } from "./oracle.js";
import { rpc } from "./test-mcp.js";

const names = ["comparison_detail", "request_comparison", "comparison_reader_brief",
  "submit_comparison_judgment", "record_comparison_judgment", "comparison_resolution_brief", "resolve_comparison",
  "execute_approved_decision_withdrawal", "decision_revision_relay_brief", "record_relayed_decision_revision"];

function toolsList(root: string): Promise<{ name: string; inputSchema: any }[]> {
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
      catch (error) { reject(error); }
      child.kill();
    });
    child.on("error", reject);
    child.on("close", () => clearTimeout(timer));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
  });
}

test("comparison tools expose exact reader and human routes without an agent web shortcut", async () => {
  const t = await team(["ana@acme.test"]);
  try {
    const root = t.all[0]!.repo;
    const tools = await toolsList(root);
    for (const name of names) assert.equal(tools.filter((x) => x.name === name).length, 1, name);
    const resolution = tools.find((x) => x.name === "resolve_comparison")!;
    assert.ok(resolution.inputSchema.required.includes("toolUseId"));
    assert.equal(resolution.inputSchema.properties.source, undefined);
    const withdrawal = tools.find((x) => x.name === "execute_approved_decision_withdrawal")!;
    assert.deepEqual(withdrawal.inputSchema.required, ["decision", "reason", "approval"]);
    assert.deepEqual(tools.find((x) => x.name === "record_relayed_decision_revision")?.inputSchema.required,
      ["decision", "revises", "findings", "session", "toolUseId"]);
    const out = await rpc(root, [
      { name: "comparison_detail", arguments: { id: "missing" } },
      { name: "request_comparison", arguments: { answers: ["a", "b"] } },
      { name: "comparison_reader_brief", arguments: { id: "missing" } },
      { name: "resolve_comparison", arguments: { request: "missing", preserve: "a", rationale: "x",
        shownHash: "x", executionsHash: "x", session: "s", toolUseId: "t", source: "web" } },
      { name: "execute_approved_decision_withdrawal", arguments: { decision: "missing", reason: "retract", approval: "missing" } },
      { name: "decision_revision_relay_brief", arguments: { decision: "missing", revises: ["a"], findings: [] } },
      { name: "record_relayed_decision_revision", arguments: { decision: "missing", revises: ["a"], findings: [], session: "s", toolUseId: "t" } },
    ]);
    assert.match(out[0]!, /no comparison missing/);
    assert.match(out[1]!, /not a current independent comparison candidate/);
    assert.match(out[2]!, /no comparison missing/);
    assert.match(out[3]!, /unknown parameter.*source/);
    assert.match(out[4]!, /no decision missing/);
    assert.match(out[5]!, /no current decision for this relay/);
    assert.match(out[6]!, /no current decision for this relay/);
  } finally { t.dispose(); }
});
