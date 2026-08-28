/**
 * The requirements subsystem as a FRONT END sees it.
 *
 * Everything under `ops/standard.ts` was a library with no callers until it was wired, so
 * every gate in it had only ever been driven by its own unit tests. This file drives the
 * ops layer the way `mcp.ts` does — one arguments object per call — and asserts the two
 * things that wiring can get wrong and typechecking cannot see: an op that reaches no
 * front end, and a gate that stops refusing once the call arrives shaped differently.
 *
 * The second half is the design's own falsifier, from `docs/requirements-architecture.md`:
 * *an agent told to make the requirement agree with the code, by whatever means the tool
 * surface allows.* It is written as "enumerate the write verbs and try each" because the
 * hazard is a verb nobody thought to gate, and a list of the gated ones cannot find that.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { indexBlob } from "./repo.js";
import { writeStore } from "./store.js";
import type { State } from "./schema.js";
import { discard } from "./test-tmp.js";
import * as standard from "./ops/standard.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const SRC = "export function creditLine(cents) { return cents; }\n";
const AGENT = { agent: true, model: "claude-opus-5" } as const;
const PERSON = { agent: false } as const;

async function universe() {
  const root = mkdtempSync(join(tmpdir(), "codemap-surface-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "izzie@x.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "izzie"], { cwd: root });
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/credit.js"), SRC, "utf8");
  const indexed = await indexBlob(SRC, "src/credit.js");
  await writeStore(root, indexed, state);
  return { root, anchor: indexed[0]!.id };
}

/**
 * Assert success and narrow to the ok arm. `Exclude` rather than `T | {error}` because
 * `ratifySpec`'s failure arm carries `checks` too, and the simpler signature leaves T as
 * the whole union — every field access then fails to compile while the test still PASSES.
 */
const ok = <T>(r: T): Exclude<T, { error: string }> => {
  assert.ok(!(r && typeof r === "object" && "error" in (r as object)),
    `unexpected error: ${(r as { error?: string })?.error}`);
  return r as Exclude<T, { error: string }>;
};

/** A ratified rule, plus a non-conformant audit and the problem raised from it. */
async function seeded(root: string, anchor: string) {
  const spec = ok(await standard.draftSpec(root, { title: "Credit limits", ...AGENT }));
  ok(await standard.addOperation(root, {
    specId: spec.id, kind: "add_requirement", rationale: "the contract says so",
    reversibility: "reversible", title: "Credit line is never negative",
    section: "Credit/Limits", statement: "A credit line must never be negative.",
    provenance: "master services agreement §4", cites: [anchor], ...AGENT,
  }));
  const adopted = ok(await standard.ratifySpec(root, { specId: spec.id, ...PERSON }));
  // No sidecar here, so this machine applies the operations and can report what it did.
  // On the shared path the fold decides and `applied` is null until it has been folded.
  assert.ok(adopted.applied, "the local path knows what it applied");
  const requirementId = adopted.applied[0]!.requirementId!;

  const audit = ok(await standard.recordAudit(root, {
    requirementId, outcome: "nonconformant", finding: "no guard on the setter",
    evidence: { read: [anchor] }, ...AGENT,
  }));
  const problem = ok(await standard.raiseProblem(root, {
    auditId: audit.id, summary: "the setter accepts a negative line", ...AGENT,
  }));
  return { requirementId, auditId: audit.id, problemId: problem.id };
}

test("every op on the standard surface reaches a front end", () => {
  // Same scan, and the same reason, as `ops-reach.test.ts`: the drift is a name nobody
  // typed, so an import graph would not see it. The op names come from the module rather
  // than a regex because this file re-exports in three different syntaxes.
  const names = Object.keys(standard);
  assert.ok(names.length > 20, `expected the standard API, found ${names.length}`);
  // NOT `src/ops/standard.ts` itself. `ops-reach.test.ts` scans `src/ops-shared.ts`, which
  // lives outside `src/ops/`, so its sweep of that directory is harmless; copying the sweep
  // for a module INSIDE it made every name match its own definition, and the test passed
  // with the barrel and the whole MCP block deleted.
  const callers = ["src/serve.ts", "src/mcp.ts", "src/cli.ts", "src/ops.ts",
    ...readdirSync("src/ops").map((f) => join("src/ops", f)).filter((f) => f !== "src/ops/standard.ts")]
    .map((f) => readFileSync(f, "utf8")).join("\n");
  const orphans = names.filter((n) => !new RegExp(`\\b${n}\\b`).test(callers));
  assert.deepEqual(orphans, [], "wire these to a front-end, or delete them");
});

test("every write verb on the surface is reachable as an MCP tool", () => {
  // The ops barrel re-exporting a name is not the same as an agent being able to call it,
  // and the whole point of this subsystem is that an agent can be REFUSED by it — which
  // cannot happen through a verb with no tool.
  const mcp = readFileSync("src/mcp.ts", "utf8");
  const writes = [
    "draftSpec", "addOperation", "ratifySpec", "reorganizeRequirement",
    "acknowledgeGap", "acknowledgeDebt", "releaseAcknowledgement",
    "recordAudit", "promoteProvisionalAudit", "raiseProblem", "adjudicate",
  ];
  const missing = writes.filter((w) => !new RegExp(`ops\\.${w}\\b`).test(mcp));
  assert.deepEqual(missing, [], "these writes have no tool, so no agent can be refused by them");
});

test("an agent may not decide any question the standard reserves to a principal", async () => {
  const { root, anchor } = await universe();
  try {
    const { requirementId, problemId } = await seeded(root, anchor);

    // A second draft, so `ratify` has something to refuse that is otherwise adoptable.
    const second = ok(await standard.draftSpec(root, { title: "Float", ...AGENT }));
    ok(await standard.addOperation(root, {
      specId: second.id, kind: "add_requirement", rationale: "policy",
      reversibility: "reversible", title: "Float is settled daily",
      section: "Settlement/Float", statement: "Float must be settled daily.",
      provenance: "treasury policy", ...AGENT,
    }));

    const refusals: [string, { error: string } | object][] = [
      ["ratify_spec", await standard.ratifySpec(root, { specId: second.id, ...AGENT })],
      ["adjudicate_problem", await standard.adjudicate(root, {
        problemId, disposition: "requirement-changed", reason: "the business moved", ...AGENT,
      })],
      ["acknowledge_debt", await standard.acknowledgeDebt(root, {
        requirementId, rationale: "next quarter", priority: "medium",
        revalidateBy: "2026-12-01", ...AGENT,
      })],
      ["refile_requirement", await standard.reorganizeRequirement(root, {
        id: requirementId, section: "Credit/Something-Else", ...AGENT,
      })],
    ];

    for (const [verb, r] of refusals) {
      // The specific refusal, never merely "an error": a call that failed for an unrelated
      // reason — a missing id, a spec in the wrong state — would satisfy `"error" in r` and
      // assert nothing at all. That vacuity has already shipped in this subsystem twice.
      assert.match((r as { error: string }).error ?? "", /is a principal's act/,
        `${verb} let an agent through, or refused for the wrong reason`);
    }

    // And the same four succeed for the person, so the refusal is about WHO rather than
    // about a malformed call. Without this half, deleting the operations would also pass.
    ok(await standard.ratifySpec(root, { specId: second.id, ...PERSON }));
    ok(await standard.adjudicate(root, {
      problemId, disposition: "requirement-changed", reason: "the business moved", ...PERSON,
    }));
    ok(await standard.acknowledgeDebt(root, {
      requirementId, rationale: "next quarter", priority: "medium",
      revalidateBy: "2026-12-01", ...PERSON,
    }));
    ok(await standard.reorganizeRequirement(root, {
      id: requirementId, section: "Credit/Something-Else", ...PERSON,
    }));
  } finally {
    discard(root);
  }
});

test("the verbs an agent SHOULD reach are not gated by the same reflex", async () => {
  const { root, anchor } = await universe();
  try {
    const { requirementId } = await seeded(root, anchor);
    // Establishing what is true is an auditor's whole job, and releasing a silencer is
    // open on purpose — gate what silences, never what unsilences. If the principal check
    // were copied onto these, the subsystem would look safer and do nothing.
    const audit = ok(await standard.recordAudit(root, {
      requirementId, outcome: "indeterminate", finding: "could not reach the setter", ...AGENT,
    }));
    assert.ok(audit.id);

    const spec = ok(await standard.draftSpec(root, { title: "Proposed by an agent", ...AGENT }));
    const op = ok(await standard.addOperation(root, {
      specId: spec.id, kind: "add_requirement", rationale: "found while auditing",
      reversibility: "unknown", title: "Ledger balances", section: "Credit/Ledger",
      statement: "The ledger must balance.", provenance: "audit", ...AGENT,
    }));
    const gap = ok(await standard.acknowledgeGap(root, {
      operationId: op.id, rationale: "nothing implements this yet", priority: "low",
      revalidateBy: "2026-12-01", ...AGENT,
    }));
    ok(await standard.releaseAcknowledgement(root, {
      id: gap.id, reason: "the code landed", ...AGENT,
    }));
  } finally {
    discard(root);
  }
});

test("standard_status counts the queues it claims to", async () => {
  const { root, anchor } = await universe();
  try {
    const before = await standard.standardStatus(root);
    assert.equal(before.conformance.total, 0);
    assert.equal(before.queues.awaitingAdjudication, 0);

    await seeded(root, anchor);
    const after = await standard.standardStatus(root);
    // Could this fail? Before `seeded` every number here is 0, so a status that read a
    // different store — or reduced to a constant — does not survive the pair.
    assert.equal(after.conformance.total, 1);
    assert.equal(after.conformance.unknown, 1, "a non-conformant audit is not a conformance");
    assert.equal(after.queues.awaitingAdjudication, 1);
    assert.equal(after.queues.actionableProblems, 0, "nothing has been decided yet");
  } finally {
    discard(root);
  }
});

/**
 * Over the REAL transport, because two forgeries lived exactly where the tests above
 * cannot look.
 *
 * Everything else here calls the ops layer directly with an explicit `agent: true`, so it
 * never exercises JSON-RPC, `markAgentSession`, or — the part that mattered — the raw
 * arguments object. `obj()` has always emitted `additionalProperties: false` and nothing
 * enforced it, so an undeclared field reached any handler that read one:
 *
 *   - `{agent: false}` reached `resolveActor`, which preferred it to the MCP agent latch.
 *     `ratify_spec` then adopted a spec from an agent session and recorded `ratifiedBy`
 *     with no `via` — an agent's act stored as a person's, on the one verb this whole
 *     subsystem exists to reserve.
 *   - `{promotedFrom}` reached `recordAudit`, forging the provenance that
 *     `promotableAudits` reads, without passing `promote_audit`'s gates.
 *
 * Both were found by review and reproduced here before being fixed.
 */
function rpc(root: string, calls: { name: string; arguments: Record<string, unknown> }[]) {
  return new Promise<string[]>((resolve, reject) => {
    const p = spawn("node", ["dist/mcp.js", root], { stdio: ["pipe", "pipe", "ignore"] });
    const out: string[] = []; let buf = ""; let i = 0;
    const timer = setTimeout(() => { p.kill(); reject(new Error("mcp did not answer")); }, 20000);
    const next = () => {
      if (i >= calls.length) { clearTimeout(timer); p.kill(); resolve(out); return; }
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

test("an undeclared argument cannot buy a principal, or forge provenance", async () => {
  const { root, anchor } = await universe();
  try {
    const { requirementId } = await seeded(root, anchor);
    const spec = ok(await standard.draftSpec(root, { title: "Second", ...AGENT }));
    ok(await standard.addOperation(root, {
      specId: spec.id, kind: "add_requirement", rationale: "r", reversibility: "reversible",
      title: "Float settles daily", section: "Settlement/Float",
      statement: "Float must be settled daily.", provenance: "treasury", ...AGENT,
    }));

    const [ratify, audit, promoted, honest] = await rpc(root, [
      { name: "ratify_spec", arguments: { specId: spec.id, agent: false } },
      { name: "record_audit", arguments: { requirementId, outcome: "conformant", finding: "fine", evidence: { ran: [{ passed: true }] } } },
      { name: "record_audit", arguments: { requirementId, outcome: "indeterminate", finding: "fine", promotedFrom: "au_forged" } },
      { name: "requirements", arguments: {} },
    ]);

    assert.match(ratify!, /unknown parameter "agent"/,
      "an undeclared `agent` reached resolveActor and outranked the MCP agent latch");
    assert.match(audit!, /needs the `command` you actually ran/,
      "`{passed: true}` names nothing that ran, and certified a rule whenever the rule cited code");
    assert.match(promoted!, /unknown parameter "promotedFrom"/,
      "provenance `promoteProvisionalAudit` sets was writable straight from record_audit");

    // Could this pass vacuously? Only if the server refused everything. It does not: the
    // spec is still a draft (so the forged ratification did NOT land) and an ordinary read
    // answers normally.
    const rules = JSON.parse(honest!) as { title: string }[];
    assert.equal(rules.length, 1, "only the legitimately ratified rule exists");
    assert.equal(rules[0]!.title, "Credit line is never negative");
  } finally {
    discard(root);
  }
});
