/**
 * Every review-topic op is reachable from the surface that needs it — and signing is NOT
 * reachable from MCP, because a topic is reviewed and signed by hand (owner: "scope to just
 * hand-reviews for now"), exactly as PR sign-off is web-only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ops = [...readFileSync("src/ops/topics.ts", "utf8").matchAll(/^export async function (\w+)/gm)].map((m) => m[1]!);
const calls = (file: string, op: string) => new RegExp(`\\bops\\.${op}\\(`).test(readFileSync(file, "utf8"));

/** Where each op must be reachable. `why` explains a surface it is deliberately absent from. */
const REACH: Record<string, { mcp: boolean; web: boolean; why?: string }> = {
  topicList: { mcp: true, web: true },
  topicDefine: { mcp: true, web: false, why: "an agent proposes a selector, or a person uses the CLI; the page reads and signs" },
  topicRevise: { mcp: true, web: false, why: "as topicDefine" },
  topicRetire: { mcp: true, web: false, why: "as topicDefine" },
  topicPacket: { mcp: true, web: false, why: "the agent's work packet; a person reads the walkthrough, not the packet" },
  topicWalkthroughSet: { mcp: true, web: false, why: "an agent writes walkthroughs" },
  topicWalkthroughGet: { mcp: true, web: true },
  topicCode: { mcp: false, web: true, why: "the page's per-symbol source; an agent has topic_packet" },
  topicStepMark: { mcp: false, web: true, why: "signing is a person's act" },
  topicChapterMark: { mcp: false, web: true, why: "signing is a person's act" },
  topicFindingContext: { mcp: false, web: false, why: "internal to report_defect's topic context" },
};

test("every topic op is reachable where it should be, and signing is web-only", () => {
  assert.deepEqual([...ops].sort(), Object.keys(REACH).sort(), "ops/topics.ts gained or lost an export — say where it is reachable");
  for (const [op, want] of Object.entries(REACH)) {
    assert.equal(calls("src/mcp.ts", op), want.mcp, `${op} on MCP should be ${want.mcp}${want.why ? ` (${want.why})` : ""}`);
    assert.equal(calls("src/serve.ts", op), want.web, `${op} on the web should be ${want.web}${want.why ? ` (${want.why})` : ""}`);
    if (!want.mcp || !want.web) assert.ok(want.why, `${op} is absent from a surface without a reason`);
  }
  // A served route nobody fetches is a dead half.
  const pages = readFileSync("web/topics.js", "utf8");
  for (const route of ["/api/topics", "/api/topic/walkthrough", "/api/topic/code", "/api/topic/step_mark", "/api/topic/chapter_mark"]) {
    assert.ok(pages.includes(`'${route}'`), `web/topics.js never calls ${route}`);
  }
});

test("the MCP topic tool dispatches every action it advertises", async () => {
  // F55: a renamed `case` left `ops.topicRetire(` in the file, so the text check above passed
  // while the advertised action failed. Call each one through the real stdio server.
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { init } = await import("./ops.js");
  const { rpc } = await import("./test-mcp.js");
  const { discard } = await import("./test-tmp.js");
  const base = mkdtempSync(join(tmpdir(), "codemap-topic-reach-"));
  try {
    const root = join(base, "repo");
    const git = (...a: string[]) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: root });
    mkdirSync(join(root, "src"), { recursive: true }); mkdirSync(join(root, ".codemap"));
    git("init", "-q", "-b", "main"); git("config", "user.email", "t@t");
    writeFileSync(join(root, "src/a.ts"), "export function a() {\n  return 1;\n}\n");
    writeFileSync(join(root, ".gitignore"), ".codemap/\n");
    writeFileSync(join(root, ".codemap", "sidecar"), join(base, "side"));
    git("add", "-A"); git("commit", "-qm", "one");
    await init(root);
    const out = await rpc(root, [
      { name: "topic", arguments: { action: "define", slug: "fees", title: "Fees", selector: { paths: ["src/**"] } } },
      { name: "topic", arguments: { action: "revise", slug: "fees", title: "Fee rules" } },
      { name: "topic", arguments: { action: "list" } },
      { name: "topic", arguments: { action: "retire", slug: "fees" } },
    ]);
    for (const [i, action] of ["define", "revise", "list", "retire"].entries()) {
      assert.doesNotMatch(out[i]!, /"error"|Error:/, `${action}: ${out[i]}`);
    }
    assert.match(out[2]!, /Fee rules/);
    assert.match(out[3]!, /"retired": true/);
  } finally { discard(base); }
});
