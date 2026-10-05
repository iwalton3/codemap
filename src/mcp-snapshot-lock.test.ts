/**
 * A read that can BUILD a snapshot is a write, and runs under the universe lock (review round
 * 2026-10-05, R27; owner: flag each tool). Behavioural, through the real stdio server: while this
 * process holds the lock, every flagged call must answer only after it is released — and an
 * unflagged control must answer before, or the timing below proves nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { init } from "./ops.js";
import { withLock } from "./lock.js";
import { rpc } from "./test-mcp.js";
import { discard } from "./test-tmp.js";

test("tools that build a snapshot wait for the universe lock; a plain read does not", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-mcp-lock-"));
  try {
    const git = (...a: string[]) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: root });
    git("init", "-q", "-b", "main");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/a.ts"), "export function a() {\n  return 1;\n}\n");
    writeFileSync(join(root, ".gitignore"), ".codemap/\n");
    git("add", "-A"); git("commit", "-qm", "one");
    await init(root);

    const flagged = [
      { name: "diff", arguments: { base: "HEAD" } },
      { name: "diff_doc", arguments: { base: "HEAD", id: "n_none" } },
      { name: "pr_walkthrough_get", arguments: { pr: "1" } },
      { name: "finding_backlog", arguments: {} },
      { name: "context", arguments: { refs: ["src/a.ts"], at: "HEAD" } },
      { name: "search", arguments: { query: "a", at: "HEAD" } },
      { name: "get_anchor", arguments: { id: "a_none", at: "HEAD" } },
      { name: "get_node", arguments: { id: "n_none", at: "HEAD" } },
    ];
    const control = { name: "search", arguments: { query: "a" } };

    const HOLD = 6_000;
    let released = 0;
    const answered = new Map<string, number>();
    const call = (c: { name: string; arguments: Record<string, unknown> }, key: string) =>
      rpc(root, [c], { onReply: () => { answered.set(key, Date.now()); } });
    const holding = withLock(root, () => new Promise<void>((r) => setTimeout(r, HOLD))).then(() => { released = Date.now(); });
    // Give the hold a moment to take the lock before anyone asks.
    await new Promise((r) => setTimeout(r, 200));
    await Promise.all([holding, call(control, "control"), ...flagged.map((c) => call(c, c.name))]);

    assert.ok(answered.get("control")! < released, "the control answered under the held lock — otherwise this timing proves nothing");
    const early = flagged.filter((c) => !(answered.get(c.name)! >= released)).map((c) => c.name);
    assert.deepEqual(early, [], "these answered while the lock was held, so a snapshot they build is written outside it");
  } finally { discard(root); }
});
