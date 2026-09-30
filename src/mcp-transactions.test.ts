/**
 * The MCP surface of the linear sync (plan 4.1): a transaction stages, every call from a
 * session holding staged writes carries a reminder, `sync` lands it all or none, and a
 * session that ends with writes staged has them attempted as it goes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { team, settle } from "./oracle.js";
import { listBugs } from "./ops/bugs.js";
import { rpc } from "./test-mcp.js";

// A drive-by defect is a shared BUG, and needs nothing but an anchor the seed has.
const defect = (title: string) => ({ name: "report_defect", arguments: {
  context: { kind: "drive_by", rationale: "noticed while testing" }, title, anchors: ["src/pay.ts#transfer"],
  text: `checked transfer: ${title}`, comment: "see title",
} });
const texts = async (m: { repo: string }) =>
  ((await listBugs(m.repo)) as { bugs?: { title?: string }[] }).bugs?.map((b) => b.title) ?? [];

test("an MCP transaction stages, reminds on every call, and lands in one sync", async () => {
  const t = await team(["ana@acme.test", "ben@acme.test"]);
  try {
    const [ana, ben] = t.all as [typeof t.all[0], typeof t.all[0]];
    const [begun, filed, listed, synced] = await rpc(ana.repo,
      [{ name: "begin", arguments: {} }, defect("staged, then synced"), { name: "staged", arguments: {} }, { name: "sync", arguments: {} }],
      { env: { CODEMAP_AGENT_MODEL: "claude-test" } });
    assert.match(begun!, /"ok": true/);
    assert.match(filed!, /1 shared write\(s\) staged by this session and not yet synced/, "the call that staged it says so");
    assert.equal(JSON.parse(listed!).staged.length, 1);
    assert.doesNotMatch(synced!, /"error"/, synced!);
    assert.doesNotMatch(synced!, /staged by this session/, "and once it has landed, the reminder stops");
    await settle(t);
    assert.ok((await texts(ben)).includes("staged, then synced"), "the teammate has it");
  } finally { t.dispose(); }
});

test("an MCP session that ends with writes staged has them attempted as it goes", async () => {
  const t = await team(["ana@acme.test", "ben@acme.test"]);
  try {
    const [ana, ben] = t.all as [typeof t.all[0], typeof t.all[0]];
    // Not `rpc`, which kills the server: here the client closes the connection, as a harness does.
    await new Promise<void>((resolve, reject) => {
      const p = spawn("node", ["dist/mcp.js", ana.repo], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, CODEMAP_AGENT_MODEL: "claude-test" } });
      let buf = "", n = 0;
      const calls = [{ name: "begin", arguments: {} }, defect("left staged when the session ended")];
      const send = (id: number, method: string, params: unknown) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      p.stdout.on("data", (d) => {
        buf += d;
        const lines = buf.split("\n"); buf = lines.pop()!;
        for (const l of lines) {
          if (!l.trim()) continue;
          if (n < calls.length) send(n + 2, "tools/call", calls[n++]);
          else p.stdin.end();
        }
      });
      p.on("close", () => resolve());
      p.on("error", reject);
      send(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    });
    await settle(t);
    assert.ok((await texts(ben)).includes("left staged when the session ended"), "attempted on close, and it landed");
  } finally { t.dispose(); }
});
