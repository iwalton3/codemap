/**
 * Drive `dist/mcp.js` over stdio: initialize, then each call in order; resolves with each
 * call's text content. Shared by the tests that must go through the real tool surface.
 */
import { spawn } from "node:child_process";

export function rpc(root: string, calls: { name: string; arguments: Record<string, unknown> }[]) {
  return new Promise<string[]>((resolve, reject) => {
    const p = spawn("node", ["dist/mcp.js", root], { stdio: ["pipe", "pipe", "ignore"] });
    const out: string[] = []; let buf = ""; let i = 0; let asked = false;
    const timer = setTimeout(() => { p.kill(); reject(new Error("mcp did not answer")); }, 20000);
    // Resolve on the child's EXIT, not on `kill()` returning. The server holds
    // `.codemap/codemap.db` open for its whole life, and the caller's next statement is a
    // `discard(root)`: on POSIX that unlinks an open file happily, on Windows it is EPERM
    // and the test fails in teardown after every assertion has passed.
    p.on("close", (code) => {
      clearTimeout(timer);
      if (asked) resolve(out);
      else reject(new Error(`mcp exited early (code ${code}) after ${out.length}/${calls.length} calls`));
    });
    const next = () => {
      if (i >= calls.length) { asked = true; p.kill(); return; }
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i + 2, method: "tools/call", params: calls[i++] }) + "\n");
    };
    p.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n"); buf = lines.pop()!;
      for (const l of lines) {
        if (!l.trim()) continue;
        const r = JSON.parse(l) as { id: number; result?: { content?: { text?: string }[] } };
        if (r.id === 1) { next(); continue; }
        out.push(r.result?.content?.[0]?.text ?? JSON.stringify(r));
        next();
      }
    });
    p.on("error", reject);
    p.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "surface-test", version: "1" } },
    }) + "\n");
  });
}
