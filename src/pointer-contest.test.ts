/**
 * Two auditors re-baselining one pointer from two branches.
 *
 * A re-baseline REWRITES a value, which is the one shape in the shared design that can
 * genuinely conflict — everything else is append-only or a latch. The fold resolved it to
 * whoever folded last, silently, and in load-bearing code (a pricing engine is the case
 * that prompted this) the discarded side is an observation of the other direction the
 * codebase is being taken in. Both are correct. Keeping the residue is not arbitration;
 * it is handing whoever audits next the context that was being thrown away.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scenario, who, concurrently, settle, type Scenario } from "./scenario.js";
import { readScope } from "./eventlog.js";
import { foldStandard, standardScope, publishPointerDeclared, publishPointerRestated } from "./shared-standard.js";
import type { BugWitness } from "./schema.js";

const U = "acme/api";
const SCOPE = standardScope(U);
const BASE: BugWitness[] = [{ anchorId: "a_credit", bodyHash: "h2:d0:sha256:aaa" }];

const pointerOf = async (s: Scenario, principal: string) =>
  foldStandard(await readScope(who(s, principal).sidecar, SCOPE)).pointers[0]!;

async function team(fn: (s: Scenario) => Promise<void>) {
  const s = await scenario(["izzie@x.com", "dana@x.com"]);
  try {
    const izzie = who(s, "izzie@x.com");
    await publishPointerDeclared(izzie.sidecar, SCOPE, izzie.actor, {
      id: "pt_1", requirementId: "r_x", universe: U,
      target: { kind: "anchor", id: "a_credit" },
      rationale: "the one function that applies the cap",
      witnesses: BASE, state: "active",
      declaredBy: izzie.actor, declaredAt: "2026-08-11T00:00:00.000Z",
    });
    await settle(s);
    await fn(s);
  } finally { s.dispose(); }
}

test("two auditors re-baselining one pointer apart is CONTESTED, not last-writer-wins", async () => {
  await team(async (s) => {
    await concurrently(
      s,
      "izzie@x.com", (p) => publishPointerRestated(p.sidecar, SCOPE, p.actor, "pt_1", "2026-08-12T00:00:00.000Z",
        [{ anchorId: "a_credit", bodyHash: "h2:d0:sha256:izzie" }]),
      "dana@x.com", (p) => publishPointerRestated(p.sidecar, SCOPE, p.actor, "pt_1", "2026-08-12T00:00:01.000Z",
        [{ anchorId: "a_credit", bodyHash: "h2:d0:sha256:dana" }]),
    );
    await settle(s);

    for (const p of ["izzie@x.com", "dana@x.com"]) {
      const pt = await pointerOf(s, p);
      const c = (pt.contested ?? []).find((x) => x.field === "witnesses");
      assert.ok(c, `${p} folded no contest — the other auditor's baseline was thrown away`);
      // Both sides survive, and each names WHO, because that is the context the residue
      // exists to hand over. A conflict whose sides are anonymous is one nobody acts on.
      const sides = [c!.held.by, c!.incoming.by].sort();
      assert.deepEqual(sides, ["dana@x.com", "izzie@x.com"]);
    }
  });
});

test("…and two auditors who agree raise NOTHING — the residue is not noise", async () => {
  // The trap this guards: `applyRevision` compares with `===`, so a witness ARRAY is
  // never equal to an identical one. Without an order-insensitive comparator every
  // concurrent restate contests, including the ordinary case where both auditors
  // baselined the same code and agree completely — the eager failure that trains people
  // to clear the state without reading it.
  await team(async (s) => {
    const same: BugWitness[] = [
      { anchorId: "a_credit", bodyHash: "h2:d0:sha256:agreed" },
      { anchorId: "a_other", bodyHash: "h2:d0:sha256:agreed2" },
    ];
    await concurrently(
      s,
      "izzie@x.com", (p) => publishPointerRestated(p.sidecar, SCOPE, p.actor, "pt_1", "2026-08-12T00:00:00.000Z", same),
      // Same set, opposite order — `watched()` makes no ordering promise, so order must
      // not decide whether two auditors are held to disagree.
      "dana@x.com", (p) => publishPointerRestated(p.sidecar, SCOPE, p.actor, "pt_1", "2026-08-12T00:00:01.000Z", [...same].reverse()),
    );
    await settle(s);
    const pt = await pointerOf(s, "izzie@x.com");
    assert.deepEqual(pt.contested ?? [], [], "agreeing is not conflict");
  });
});
