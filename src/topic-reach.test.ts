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
