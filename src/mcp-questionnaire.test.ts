import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { team } from "./oracle.js";
import { rpc } from "./test-mcp.js";

function toolsList(root: string): Promise<{ name: string; inputSchema: { required?: string[] } }[]> {
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

test("questionnaire MCP list/detail/status/wait are discoverable and route to local projected reads", async () => {
  const t = await team(["ana@acme.test"]);
  try {
    const root = t.all[0]!.repo;
    const tools = await toolsList(root);
    for (const name of ["questionnaire_list", "questionnaire_detail", "questionnaire_status", "questionnaire_wait"]) {
      assert.equal(tools.filter((x) => x.name === name).length, 1, name);
    }
    assert.deepEqual(tools.find((x) => x.name === "questionnaire_wait")?.inputSchema.required, ["id", "cursor", "timeoutMs"]);
    const results = await rpc(root, [
      { name: "questionnaire_list", arguments: {} },
      { name: "questionnaire_detail", arguments: { id: "missing" } },
      { name: "questionnaire_status", arguments: { id: "missing" } },
      { name: "questionnaire_wait", arguments: { id: "missing", cursor: "invalid", timeoutMs: 0 } },
    ]);
    assert.match(results[0]!, /questionnaires/);
    assert.match(results[1]!, /no questionnaire missing/);
    assert.match(results[2]!, /no questionnaire missing/);
    assert.match(results[3]!, /wait needs the cursor/);
  } finally { t.dispose(); }
});
