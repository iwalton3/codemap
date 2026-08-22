import { test } from "node:test";
import assert from "node:assert/strict";
import { scenario, who, step, settle, type Scenario } from "./scenario.js";
import { createFinding, revise, readFindings, ackQueue } from "./shared-findings.js";

const PR = "acme/api/pr-264";
const NEW = { targetKind: "anchor" as const, targetId: "a_1", text: "the original text", comment: "the original ask", severity: "medium" as const };

/**
 * Three people write while apart, and one of them has seen only some of the others.
 *
 * `concurrently` manufactures a clean two-way split; this is the messier shape a
 * real team produces, and the one that separates "was this event ordered before
 * mine?" from "did I see it?". Those two questions have the same answer for two
 * writers and different answers for three.
 *
 *   dana   revises and stays offline
 *   alice  revises and pushes            — concurrent with dana
 *   bob    pulls (gets alice, not dana) and revises
 *   dana   finally pushes
 *
 * dana's event was minted FIRST, so its id sorts first and the topological sort
 * places it at a lower fold index than alice's. bob's `after` names alice's
 * event, whose index is higher — so an index comparison concludes bob saw dana,
 * which he provably did not: dana's event was not on any remote when bob wrote.
 */
async function threeWay(fn: (s: Scenario, id: string) => Promise<void>) {
  const s = await scenario(["alice@x.com", "bob@x.com", "dana@x.com"]);
  try {
    const alice = who(s, "alice@x.com");
    const id = await createFinding(alice.sidecar, PR, alice.actor, NEW);
    await settle(s);

    const dana = who(s, "dana@x.com");
    await revise(dana.sidecar, PR, dana.actor, id, { severity: "low" });      // stays put

    await revise(alice.sidecar, PR, alice.actor, id, { severity: "critical" });
    await step(s, "alice@x.com");                                            // pushes

    await step(s, "bob@x.com");                                              // pulls alice only
    const bob = who(s, "bob@x.com");
    const bobSees = await readFindings(bob.sidecar, PR);
    assert.equal(bobSees.get(id)!.severity, "critical", "bob has alice's write");
    assert.equal(bobSees.get(id)!.contested, undefined, "and nothing to see from dana");
    await revise(bob.sidecar, PR, bob.actor, id, { severity: "high" });

    await settle(s);                                                          // dana's arrives
    await fn(s, id);
  } finally { s.dispose(); }
}

/**
 * The write bob could not have seen must still be a disagreement.
 *
 * Nothing here is destroyed either way — every value survives in `revisions[]` —
 * but `contested` is the ONLY mechanism that asks a person to arbitrate. A
 * three-way split that resolves itself silently is the failure this whole
 * design exists to prevent, and it looks identical to consensus.
 */
test("a write nobody could have seen is still contested", async () => {
  await threeWay(async (s, id) => {
    for (const p of s.all) {
      const f = (await readFindings(p.sidecar, PR)).get(id)!;
      assert.ok(f.contested?.length, `silently picked a winner for ${p.actor.principal}`);
      assert.equal(ackQueue([f]).length, 1, `nothing waiting on a person for ${p.actor.principal}`);
    }
  });
});

/**
 * And bob must not have SETTLED the disagreement between alice and dana.
 *
 * This is the sharper half: settling is a deliberate human act, and bob
 * performed it without ever being shown the choice. `revisions[]` keeps the
 * values, so the loss is not data — it is that the two people who actually
 * disagree are never told they do.
 */
test("a third party does not clear a contest they never saw", async () => {
  await threeWay(async (s, id) => {
    for (const p of s.all) {
      const f = (await readFindings(p.sidecar, PR)).get(id)!;
      const fields = (f.contested ?? []).map((c) => c.field);
      assert.ok(fields.includes("severity"), `bob cleared it for ${p.actor.principal}`);
      // Everyone folds the same events in the same order, so a disagreement that
      // is real for one person is real for all of them or the fold is broken.
      assert.deepEqual(
        [...new Set((f.contested ?? []).flatMap((c) => [c.held.by, c.incoming.by]))].sort(),
        ["alice@x.com", "bob@x.com", "dana@x.com"].filter((who_) =>
          (f.contested ?? []).some((c) => c.held.by === who_ || c.incoming.by === who_)),
        "participants",
      );
    }
  });
});

/**
 * Whoever settles it, it settles for everyone — the fix must not trade a silent
 * clear for an unclearable one. dana has now seen the whole disagreement, so her
 * restating a value is the ordinary way out, and it has to survive the replay.
 */
test("and a person who HAS seen it can still settle it", async () => {
  await threeWay(async (s, id) => {
    const dana = who(s, "dana@x.com");
    await revise(dana.sidecar, PR, dana.actor, id, { severity: "high" });
    await settle(s);
    for (const p of s.all) {
      const f = (await readFindings(p.sidecar, PR)).get(id)!;
      assert.equal(f.contested, undefined, `still contested for ${p.actor.principal}`);
      assert.equal(f.severity, "high");
      assert.equal(ackQueue([f]).length, 0, `still queued for ${p.actor.principal}`);
    }
  });
});
