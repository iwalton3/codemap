/**
 * An agent writing through MCP must be recorded as an agent.
 *
 * The ratchet — a person may do anything, an agent may only propose — is enforced
 * in the fold, against `actor.via`. But `via` was set only from
 * CODEMAP_AGENT_MODEL / CODEMAP_AGENT_HARNESS, and nothing in this repository sets
 * either: the harness would have to. So every write an agent made through the MCP
 * server was attributed to the PERSON, which made the ratchet inert on the one
 * surface agents actually use — free to close findings a human never saw, and
 * counted as independent corroboration of its own work.
 *
 * `mcp.ts` calls `markAgentSession()` at startup because that surface is an agent
 * by construction. These tests pin both halves: that the mark takes effect, and
 * that `mcp.ts` still makes the call.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveActor, markAgentSession, clearAgentSession, isAgentActor, isIndependent } from "./identity.js";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "codemap-mcpid-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "izzie@x.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "izzie"], { cwd: root });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("the MCP server marks itself as an agent session", () => {
  // Read rather than executed: importing mcp.ts starts a stdio server. The call is
  // one line and deleting it silently restores the bug, so its presence is the
  // thing worth asserting.
  const src = readFileSync("src/mcp.ts", "utf8");
  assert.match(src, /markAgentSession\(\)/, "mcp.ts must mark its session — the ratchet depends on it");
  assert.match(src, /import \{ markAgentSession \} from "\.\/identity\.js"/);
});

test("a marked session is an agent even with no model in the environment", () => {
  const r = repo();
  const saved = { m: process.env.CODEMAP_AGENT_MODEL, h: process.env.CODEMAP_AGENT_HARNESS };
  delete process.env.CODEMAP_AGENT_MODEL;
  delete process.env.CODEMAP_AGENT_HARNESS;
  try {
    // This is the state the MCP server actually runs in: a git identity, and no
    // agent env vars, because nothing sets them.
    markAgentSession();
    const a = resolveActor(r.root);
    assert.ok(a, "still attributable to a person");
    assert.equal(a.principal, "izzie@x.com", "the principal is ALWAYS the human");
    assert.ok(isAgentActor(a), "and the act is the agent's");
    assert.equal(a.via?.model, undefined, "a model is never guessed — absent is honest");
  } finally {
    // The latch is PROCESS-wide and the suite shares one process, so a test that
    // marks the session has to give it back — see `clearAgentSession`.
    clearAgentSession();
    if (saved.m !== undefined) process.env.CODEMAP_AGENT_MODEL = saved.m;
    if (saved.h !== undefined) process.env.CODEMAP_AGENT_HARNESS = saved.h;
    r.cleanup();
  }
});

test("an agent's support of its own principal's finding is still not independent", () => {
  // The reason `via` has to be right: corroboration compares PRINCIPALS, so this
  // only holds if the agent's principal is the human it acts for — which is what
  // marking the session preserves, rather than inventing a separate identity.
  const r = repo();
  try {
    markAgentSession();
    const agent = resolveActor(r.root);
    assert.ok(agent);
    assert.equal(isIndependent(agent, { principal: "izzie@x.com" }), false,
      "one person's agent cannot corroborate that person's own finding");
    assert.equal(isIndependent(agent, { principal: "dana@x.com" }), true);
  } finally { clearAgentSession(); r.cleanup(); }
});
