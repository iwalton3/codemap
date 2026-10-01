/**
 * Two auditors re-baselining one pointer.
 *
 * A re-baseline REWRITES a value. Under the merge-era log two auditors restating apart were
 * kept as a contest. The log is linear now (owner, D6: delete every hold keyed on "neither
 * writer saw the other"), so a restatement is a sequential act: one written after reading the
 * other supersedes it, and one replayed after a restatement its writer never read is refused
 * and its author told — the observation it would silently replace was never read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scenario, who, settle, inSequence, type Scenario } from "./scenario.js";
import { readScope } from "./eventlog.js";
import { begin, dropOp, staged, syncSession } from "./sync-engine.js";
import { foldStandard, standardScope, publishOperation, publishPointerDeclared, publishPointerRestated, publishSpecDrafted } from "./shared-standard.js";
import { requirementIdFor, type BugWitness } from "./schema.js";
import { ratifyWithReview } from "./test-approve.js";

const U = "acme/api";
const SCOPE = standardScope(U);
const BASE: BugWitness[] = [{ anchorId: "a_credit", bodyHash: "h2:d0:sha256:aaa" }];
const W = (h: string): BugWitness[] => [{ anchorId: "a_credit", bodyHash: `h2:d0:sha256:${h}` }];

const pointerOf = async (s: Scenario, principal: string) =>
  foldStandard(await readScope(who(s, principal).sidecar, SCOPE)).pointers[0]!;

async function team(fn: (s: Scenario) => Promise<void>) {
  const s = await scenario(["izzie@x.com", "dana@x.com"]);
  try {
    const izzie = who(s, "izzie@x.com");
    // An active pointer names a rule that exists (docs/sidecar-references.md, row 156).
    await publishSpecDrafted(izzie.sidecar, SCOPE, izzie.actor, { id: "sp_1", title: "T", status: "draft", author: izzie.actor, createdAt: "2026-08-01T00:00:00.000Z" });
    await publishOperation(izzie.sidecar, SCOPE, izzie.actor, { id: "op_1", specId: "sp_1", kind: "add_requirement", ord: 0, title: "Credit cap",
      section: "Credit", statement: "Credit is capped.", provenance: "p", rationale: "r", reversibility: "reversible" });
    await ratifyWithReview(izzie.sidecar, SCOPE, izzie.actor, "sp_1", "2026-08-02T00:00:00.000Z", {}, ["op_1"]);
    await publishPointerDeclared(izzie.sidecar, SCOPE, izzie.actor, {
      id: "pt_1", requirementId: requirementIdFor("op_1"), universe: U,
      target: { kind: "anchor", id: "a_credit" },
      rationale: "the one function that applies the cap",
      witnesses: BASE, state: "active",
      declaredBy: izzie.actor, declaredAt: "2026-08-11T00:00:00.000Z",
    });
    await settle(s);
    await fn(s);
  } finally { s.dispose(); }
}

test("a restatement replayed after one its writer never read is refused, and the one that landed stands", async () => {
  for (const mine of ["izzie"]) {  // different from dana's; identical to it is agreement (next test)
    await team(async (s) => {
      const izzie = who(s, "izzie@x.com"), dana = who(s, "dana@x.com");
      begin(izzie.sidecar);
      await publishPointerRestated(izzie.sidecar, SCOPE, izzie.actor, "pt_1", "2026-08-12T00:00:00.000Z", W(mine));
      await publishPointerRestated(dana.sidecar, SCOPE, dana.actor, "pt_1", "2026-08-12T00:00:01.000Z", W("dana"));
      const refused = await syncSession(izzie.sidecar, izzie.actor);
      assert.ok("error" in refused && refused.conflicts?.length, `izzie's restatement must be refused: ${JSON.stringify(refused)}`);
      assert.deepEqual(refused.conflicts!.map((c) => c.kind), ["pointer.restated"]);
      assert.match(refused.conflicts![0]!.why, /another restatement landed that this one did not see/);

      // Dropped, re-read, restated: sequential now, so it supersedes.
      assert.ok(dropOp(izzie.sidecar, staged(izzie.sidecar)[0]!.event.id).ok);
      await settle(s);
      await publishPointerRestated(izzie.sidecar, SCOPE, izzie.actor, "pt_1", "2026-08-12T00:00:02.000Z", W("izzie2"));
      await settle(s);
      for (const p of ["izzie@x.com", "dana@x.com"]) {
        const pt = await pointerOf(s, p);
        assert.deepEqual(pt.witnesses, W("izzie2"), `${p} folds the restatement made having read dana's`);
        assert.equal(pt.restatedBy?.principal, "izzie@x.com");
      }
    });
  }
});

test("a restatement made after reading the previous one supersedes it", async () => {
  await team(async (s) => {
    await inSequence(
      s,
      "izzie@x.com", (p) => publishPointerRestated(p.sidecar, SCOPE, p.actor, "pt_1", "2026-08-12T00:00:00.000Z", W("izzie")),
      "dana@x.com", (p) => publishPointerRestated(p.sidecar, SCOPE, p.actor, "pt_1", "2026-08-12T00:00:01.000Z", W("dana")),
    );
    for (const p of ["izzie@x.com", "dana@x.com"]) {
      const pt = await pointerOf(s, p);
      assert.deepEqual(pt.witnesses, W("dana"));
      assert.equal(pt.restatedBy?.principal, "dana@x.com");
    }
  });
});

test("a restatement with the witnesses that landed meanwhile is the restater's agreement, not a refusal (O9)", async () => {
  await team(async (s) => {
    const izzie = who(s, "izzie@x.com"), dana = who(s, "dana@x.com");
    begin(izzie.sidecar);
    await publishPointerRestated(izzie.sidecar, SCOPE, izzie.actor, "pt_1", "2026-08-12T00:00:00.000Z", W("dana"));
    await publishPointerRestated(dana.sidecar, SCOPE, dana.actor, "pt_1", "2026-08-12T00:00:01.000Z", W("dana"));
    const r = await syncSession(izzie.sidecar, izzie.actor);
    assert.ok(!("error" in r), JSON.stringify(r));
    await settle(s);
    for (const p of ["izzie@x.com", "dana@x.com"]) {
      const pt = await pointerOf(s, p);
      assert.equal(pt.restatedBy?.principal, "dana@x.com", "the state is dana's restatement");
      assert.deepEqual(pt.agreements?.map((a) => a.by.principal), ["izzie@x.com"]);
    }
  });
});
