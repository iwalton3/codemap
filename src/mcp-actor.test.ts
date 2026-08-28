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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveActor, markAgentSession, clearAgentSession, isAgentActor, isIndependent } from "./identity.js";
import { discard } from "./test-tmp.js";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "codemap-mcpid-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "izzie@x.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "izzie"], { cwd: root });
  return { root, cleanup: () => discard(root) };
}

test("the MCP server marks itself as an agent session", () => {
  // Read rather than executed: importing mcp.ts starts a stdio server. The call is
  // one line and deleting it silently restores the bug, so its presence is the
  // thing worth asserting.
  const src = readFileSync("src/mcp.ts", "utf8");
  assert.match(src, /markAgentSession\(\)/, "mcp.ts must mark its session — the ratchet depends on it");
  // The NAME must come from identity.js — not the exact import line. Pinning the
  // whole line failed the moment a second identity import was added beside it,
  // which is a true statement about the file and not a regression.
  assert.match(src, /import \{[^}]*\bmarkAgentSession\b[^}]*\} from "\.\/identity\.js"/);
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

test("THE AGENT LATCH IS A RATCHET — a caller-supplied flag cannot clear it", () => {
  // `resolveActor` read `input.agent ?? (agentSession || …)`, so an explicit `agent: false`
  // beat the latch. No MCP tool declares that field and nothing enforced the schemas'
  // `additionalProperties: false`, so one undeclared boolean in a tool call bought a
  // principal: `ratify_spec {agent: false}` adopted a spec from an agent session and stored
  // `ratifiedBy` with no `via`. `mcp.ts` now also refuses undeclared parameters, which is a
  // second and independent defence — this pins the one underneath it, because a test that
  // only drives the transport passes on either.
  const r = repo();
  try {
    markAgentSession();
    const forged = resolveActor(r.root, { agent: false });
    assert.ok(forged);
    assert.ok(isAgentActor(forged), "a session that is an agent stays one, whatever it claims");
  } finally { clearAgentSession(); r.cleanup(); }
});

test("and off the latch, an explicit `agent: false` is still honoured", () => {
  // The other half, or the test above passes by pinning the flag to nothing: a CLI caller
  // who says it is a person must still resolve as one.
  const r = repo();
  try {
    const person = resolveActor(r.root, { agent: false });
    assert.ok(person);
    assert.equal(isAgentActor(person), false);
  } finally { r.cleanup(); }
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
