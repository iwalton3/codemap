/**
 * What the spec page is told about an operation sign-off (B9: F41). A sign-off of text the
 * operation no longer says is history, not an exact sign-off: it must not render as one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { draftSpec, addOperation, reviseOperation, getSpec } from "./requirements.js";
import { writeLocalProposalWitness } from "./store.js";
import { operationContent, type ProposalWitness } from "./schema.js";
import { discard } from "./test-tmp.js";

test("B9: a sign-off of an earlier text is served as not current", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-signoff-view-"));
  try {
    for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "bob@acme.test"], ["config", "user.name", "Bob"]]) {
      assert.equal(spawnSync("git", args, { cwd: root }).status, 0);
    }
    mkdirSync(join(root, ".codemap"));
    writeFileSync(join(root, "code.ts"), "export const credit = 1;\n");
    spawnSync("git", ["add", "-A"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "seed"], { cwd: root });
    const spec = await draftSpec(root, { title: "Credit approval" });
    assert.ok("id" in spec);
    const op = await addOperation(root, { specId: spec.id, kind: "add_requirement", title: "Credit bound", section: "Credit",
      statement: "Bound credit.", provenance: "Owner", rationale: "Exposure", reversibility: "reversible" });
    assert.ok("operation" in op);
    await writeLocalProposalWitness(root, { id: "signed", specId: spec.id, operationId: op.id, reviewer: { principal: "alice@acme.test" },
      at: "2026-09-26T12:00:00Z", content: operationContent(op.operation), application: { ruling: { answerId: "a" } } } as ProposalWitness);
    const fresh = await getSpec(root, spec.id);
    assert.ok(!("error" in fresh));
    assert.equal(fresh.operationSignoffs[0]!.current, true);
    const revised = await reviseOperation(root, { operationId: op.id, statement: "Changed credit bound.", reason: "tighter" });
    assert.ok(!("error" in revised), JSON.stringify(revised));
    const after = await getSpec(root, spec.id);
    assert.ok(!("error" in after));
    assert.equal(after.operationSignoffs[0]!.current, false, "the signed text is no longer the operation's text");
  } finally { discard(root); }
});
