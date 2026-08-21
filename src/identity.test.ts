import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Actor } from "./schema.js";
import { resolveActor, resolvePrincipal, requireActor, isAgentActor, isIndependent, actorLabel } from "./identity.js";

function repoWithEmail(email: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "codemap-id-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  // --local so the machine's global git config cannot leak in and make the
  // no-identity case pass by accident.
  if (email) spawnSync("git", ["config", "--local", "user.email", email], { cwd: root });
  else spawnSync("git", ["config", "--local", "--unset-all", "user.email"], { cwd: root });
  return root;
}

const withEnv = (vars: Record<string, string | undefined>, fn: () => void) => {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};

test("a principal comes from git, and an override beats it", () => {
  const root = repoWithEmail("izzie@example.com");
  try {
    withEnv({ CODEMAP_PRINCIPAL: undefined }, () => {
      assert.equal(resolvePrincipal(root), "izzie@example.com");
    });
    withEnv({ CODEMAP_PRINCIPAL: "someone@else.com" }, () => {
      assert.equal(resolvePrincipal(root), "someone@else.com");
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a human acts as themselves — no `via`", () => {
  const root = repoWithEmail("izzie@example.com");
  try {
    withEnv({ CODEMAP_PRINCIPAL: undefined, CODEMAP_AGENT_MODEL: undefined, CODEMAP_AGENT_HARNESS: undefined }, () => {
      const a = resolveActor(root)!;
      assert.equal(a.principal, "izzie@example.com");
      assert.equal(a.via, undefined);
      assert.equal(isAgentActor(a), false);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an agent acts ON BEHALF OF a person — the principal is still a person", () => {
  const root = repoWithEmail("izzie@example.com");
  try {
    withEnv({ CODEMAP_PRINCIPAL: undefined, CODEMAP_AGENT_MODEL: undefined, CODEMAP_AGENT_HARNESS: undefined }, () => {
      const a = resolveActor(root, { agent: true, model: "claude-opus-5", harness: "claude-code" })!;
      assert.equal(a.principal, "izzie@example.com", "never the agent");
      assert.equal(a.via?.model, "claude-opus-5");
      assert.equal(a.via?.harness, "claude-code");
      assert.equal(isAgentActor(a), true);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a harness that sets the env is an agent session without anyone passing a flag", () => {
  const root = repoWithEmail("izzie@example.com");
  try {
    withEnv({ CODEMAP_PRINCIPAL: undefined, CODEMAP_AGENT_MODEL: "claude-fable-5", CODEMAP_AGENT_HARNESS: undefined }, () => {
      const a = resolveActor(root)!;
      assert.equal(isAgentActor(a), true, "an MCP server started by a harness is never a person typing");
      assert.equal(a.via?.model, "claude-fable-5");
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a model id is never invented — `agent` with no model says so honestly", () => {
  const root = repoWithEmail("izzie@example.com");
  try {
    withEnv({ CODEMAP_PRINCIPAL: undefined, CODEMAP_AGENT_MODEL: undefined, CODEMAP_AGENT_HARNESS: undefined }, () => {
      const a = resolveActor(root, { agent: true })!;
      assert.equal(isAgentActor(a), true);
      assert.equal(a.via?.model, undefined, "a model that does not know its own id must not guess one");
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("no git identity yields null, never a placeholder principal", () => {
  // A fabricated "unknown" would make every unattributed action the SAME person,
  // so the no-self-verify check would pass by collision — the worst outcome.
  const root = repoWithEmail(null);
  try {
    withEnv({ CODEMAP_PRINCIPAL: undefined, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }, () => {
      assert.equal(resolveActor(root), null);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- the rule this exists to make enforceable ---------------------------------

const human = (p: string): Actor => ({ principal: p });
const agentFor = (p: string, model: string): Actor => ({ principal: p, via: { kind: "agent", model } });

test("two different people are independent witnesses", () => {
  assert.equal(isIndependent(human("izzie@x.com"), human("dana@x.com")), true);
});

test("a person is not independent of themselves", () => {
  assert.equal(isIndependent(human("izzie@x.com"), human("izzie@x.com")), false);
});

test("an agent is not independent of the person running it, whatever the model", () => {
  // Otherwise "three models confirmed it" means one human's agent agreeing with
  // itself three times, which is the failure that would quietly erode the queue.
  assert.equal(isIndependent(human("izzie@x.com"), agentFor("izzie@x.com", "claude-opus-5")), false);
  assert.equal(isIndependent(agentFor("izzie@x.com", "claude-opus-5"), agentFor("izzie@x.com", "claude-fable-5")), false);
});

test("agents run by different people ARE independent", () => {
  assert.equal(isIndependent(agentFor("izzie@x.com", "claude-opus-5"), agentFor("dana@x.com", "claude-opus-5")), true);
});

test("an unattributed record is never independent — absence is not a second opinion", () => {
  assert.equal(isIndependent(undefined, human("izzie@x.com")), false);
  assert.equal(isIndependent(human("izzie@x.com"), undefined), false);
});

test("a write that records attribution is REFUSED when there is nobody to name", () => {
  // Fails rather than degrades: who made a record is not recoverable later from
  // anywhere, so the cost of stopping is a config line and the cost of proceeding
  // is a record nobody can ever stand behind.
  const root = repoWithEmail(null);
  try {
    withEnv({ CODEMAP_PRINCIPAL: undefined, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }, () => {
      const r = requireActor(root) as { error: string };
      assert.ok(r.error, "must refuse");
      assert.match(r.error, /git config user\.email/, "and must say how to fix it");
      assert.match(r.error, /Reading the map needs none of this/, "reads are not gated on this");
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("with an identity set, the same write is allowed", () => {
  const root = repoWithEmail("izzie@example.com");
  try {
    withEnv({ CODEMAP_PRINCIPAL: undefined }, () => {
      const r = requireActor(root);
      assert.ok(!("error" in r));
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the label names the person, and the model when one acted for them", () => {
  assert.equal(actorLabel(human("izzie@x.com")), "izzie@x.com");
  assert.equal(actorLabel(agentFor("izzie@x.com", "claude-opus-5")), "izzie@x.com (claude-opus-5)");
});
