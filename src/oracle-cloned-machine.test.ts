import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { team, machine, syncOne, settle, cloneMachine, type Team, type Member } from "./oracle.js";
import { Ledger, checkAlways, checkSettled, verified } from "./oracle-properties.js";
import { shareFinding, sharedFindings, sharedHeal, publishLocalDocs, sharedDocs } from "./ops-shared.js";
import { document } from "./ops.js";
import { readScopeChecked, scopesOnDisk } from "./eventlog.js";

/**
 * WORKFLOW 3 — one person, two machines, one writer id.
 *
 * The case sharding cannot cover and `heal` exists for. Two ordinary clones write
 * different shards and cannot collide however concurrently they write; a fork needs
 * one writer id in two places, which is a restored backup, a synced home directory,
 * or a machine image — all things people really do.
 *
 * `ops-shared.test.ts` already covers the MECHANISM (union, rotate, acknowledge) on a
 * two-person fixture. What only a whole-universe run can show is the shape of the
 * event for everybody else: a third person is on this sidecar throughout, and the
 * question this test exists to answer is what the fork and its repair do to HIM.
 *
 * The answer turns out to be non-obvious in both directions, and both are asserted:
 *
 *   - while the fork is unpushed it is invisible to him, because a sync that fails
 *     closed pushes NOTHING;
 *   - once it lands he is not blocked either, because the acknowledgment is an EVENT
 *     and so it travels with the evidence it covers. One person looking at a fork
 *     clears it for every reader — which is only safe because the acknowledgment is
 *     keyed on the evidence, and the last step proves that by forking again.
 */

const IZZIE = "izzie@acme.test";
const BEN = "ben@acme.test";
const PR = 7;

/** The writer id a clone is currently appending under, or null before its first write. */
const writerOf = (m: Member): string | null => {
  try { return readFileSync(join(m.sidecar, ".git", "codemap-writer"), "utf8").trim(); }
  catch { return null; }
};

/** The scope's own verdict on itself — `blocked`, or `complete` and why. */
async function statusOf(m: Member, endsWith: string) {
  const scope = (await scopesOnDisk(m.sidecar)).find((s) => s.endsWith(endsWith));
  assert.ok(scope, `${m.machine} has no scope ending ${endsWith}`);
  return { scope: scope!, ...await readScopeChecked(m.sidecar, scope!) };
}

test("the cloned machine: a fork fails closed, heal keeps both writes, and one person's acknowledgment covers the team", async () => {
  // Izzie on two machines, Ben on one. `team` keys by MACHINE, so the two izzie
  // entries are two universes and not one map entry compared with itself.
  const t = await team([IZZIE, IZZIE, BEN]);
  const ledger = new Ledger();
  const step = async (what: string, fn: () => Promise<void>) => {
    await fn();
    try { await checkAlways(t, ledger); }
    catch (e) { throw new Error(`after "${what}": ${(e as Error).message}`); }
  };
  const settled = async (what: string) => {
    await settle(t);
    try { await checkSettled(t, ledger); }
    catch (e) { throw new Error(`after settling "${what}": ${(e as Error).message}`); }
  };

  try {
    const laptop = machine(t, "m0"), desktop = machine(t, "m1"), ben = machine(t, "m2");
    assert.equal(laptop.actor.principal, desktop.actor.principal, "one person, two machines");

    // 1 — the team works before anything is broken. Without this baseline a fork that
    // merely stopped everything would satisfy every later assertion.
    await step("izzie documents on the laptop", async () => {
      await verified(
        "document + publish",
        document(laptop.repo, {
          id: "n_settlement", type: "concept", title: "Settlement",
          summary: "how a batch is settled", anchors: ["src/settle.py#settle"],
        }).then(() => publishLocalDocs(laptop.repo)),
        async () => ((await sharedDocs(laptop.repo) as any).docs ?? []).length > 0,
      );
    });
    await settled("the baseline");

    await step("and ben can read it", async () => {
      const his = await sharedDocs(ben.repo) as any;
      assert.deepEqual(his.docs.map((d: any) => d.nodeId), ["n_settlement"]);
    });

    // 2 — the fork. A finding first, because `cloneMachine` copies a writer id and a
    // clone that has never appended has no id to copy; the restore-from-image story
    // needs the laptop to be a machine with a history.
    let forkedId = "";
    await step("the desktop is restored from an image of the laptop", async () => {
      await shareFinding(laptop.repo, PR, {
        targetKind: "anchor", targetId: "a_laptop", text: "filed from the laptop",
      });
      forkedId = writerOf(laptop)!;
      assert.ok(forkedId, "the laptop has a writer id to copy");
      assert.notEqual(writerOf(desktop), forkedId, "and the desktop does not hold it yet");

      cloneMachine(laptop, desktop);
      assert.equal(writerOf(desktop), forkedId, "now both machines are one writer");

      // Both write before either syncs, so both events open the same chain. THIS is
      // the fork — not the copy, which on its own is inert.
      await shareFinding(desktop.repo, PR, {
        targetKind: "anchor", targetId: "a_desktop", text: "filed from the desktop",
      });
    });

    // 3 — one wins, the other fails CLOSED.
    await step("the laptop syncs first, and the desktop cannot", async () => {
      const won = await syncOne(laptop) as any;
      assert.equal(won.error, undefined, `the first machine up syncs normally: ${won.error}`);

      const lost = await syncOne(desktop) as { error?: string };
      assert.ok(lost.error, "the second is refused rather than silently unioned");
      assert.match(lost.error!, new RegExp(forkedId), "the message names the writer id");
      assert.match(lost.error!, /two clones/, "and says what that means");
      assert.match(lost.error!, /codemap sidecar heal/, "and what to run");

      // FAILS CLOSED, and the message's "the sidecar is untouched" cuts BOTH ways: the
      // desktop's own write is still readable, and the laptop's has not arrived —
      // because a refused sync neither pushes nor merges. Asserting only the first half
      // would pass on a build that had half-merged and then given up, which is the
      // state this design refuses to leave anyone in.
      const mine = await sharedFindings(desktop.repo, PR) as any;
      assert.deepEqual(
        mine.findings.map((f: any) => f.text),
        ["filed from the desktop"],
        "its own write is intact, and it took nothing from the remote on the way out",
      );
    });

    // 4 — and it is nobody else's problem yet, because nothing was pushed.
    await step("ben is unaffected while the fork is unpushed", async () => {
      const r = await syncOne(ben) as any;
      assert.equal(r.error, undefined, `ben's sync is unaffected: ${r.error}`);
      assert.deepEqual(r.materialized.blocked, [], "no scope is blocked for him");
      const his = await sharedFindings(ben.repo, PR) as any;
      assert.deepEqual(
        his.findings.map((f: any) => f.text), ["filed from the laptop"],
        "he has the write that landed and not the one that did not — a failed sync pushes NOTHING",
      );
    });

    // 5 — the repair.
    await step("izzie heals the desktop", async () => {
      const before = writerOf(desktop);
      const r = await sharedHeal(desktop.repo) as any;
      assert.equal(r.error, undefined, `heal failed: ${r.error}`);

      assert.equal(r.resolved.length, 1, "one divided shard");
      assert.equal(r.resolved[0].events, 2, "unioned to BOTH sides' events, not resolved to one");
      assert.equal(r.rotated, writerOf(desktop), "the reported id is the one now on disk");
      assert.notEqual(r.rotated, before, "this clone held the forked id, so it rotated");
      assert.deepEqual(r.acknowledged.map((a: any) => a.reason), ["fork"]);
      assert.deepEqual(r.blocked, [], "nothing is left needing a human");

      // ONLY this clone. Rotating the innocent side would throw away a chain that was
      // never wrong, and it is the laptop that still carries the original id.
      assert.equal(writerOf(laptop), forkedId, "the laptop keeps the id it always had");
    });

    await settled("the repair");

    // 6 — the point of the whole mechanism.
    await step("both writes survive, on every machine", async () => {
      for (const m of t.all) {
        const f = await sharedFindings(m.repo, PR) as any;
        assert.deepEqual(
          f.findings.map((x: any) => x.text).sort(),
          ["filed from the desktop", "filed from the laptop"],
          `${m.machine} lost a write to the repair`,
        );
      }
    });

    // 7 — the non-obvious half, and the reason a third person is in this test.
    await step("ben never has to heal: the acknowledgment travelled", async () => {
      const his = await statusOf(ben, `pr-${PR}`);
      assert.equal(his.status, "complete", "his scope reads clean");
      // …and clean for the RIGHT reason. Without this the assertion above passes on a
      // build where the fork evidence was quietly dropped instead of acknowledged,
      // which is the failure mode the whole heal design exists to avoid.
      assert.equal(his.acknowledged, true, "because a person acknowledged it, not because it vanished");
      assert.equal(his.diagnostic?.reason, "fork", "and the evidence is still on the record");

      const r = await sharedHeal(ben.repo) as any;
      assert.equal(r.error, undefined);
      assert.deepEqual(r.resolved, [], "there is nothing left for him to union");
      assert.equal(r.rotated, undefined, "and the forked id was never his to rotate");
      assert.deepEqual(r.acknowledged, [], "nor anything left to acknowledge");
    });

    // 8 — THE CONTROL for step 7. An acknowledgment that covered the whole team
    // forever would be a mute, and every assertion in step 7 would read the same. It
    // is keyed on the evidence AND causally gated, so a SECOND fork is evidence the
    // first acknowledgment does not reach.
    //
    // Note what this step does NOT prove on its own: the refusal below comes from the
    // sync guard, which never consults an acknowledgment at all. Making
    // `evidenceDigest` a constant leaves this passing. The claim about the
    // acknowledgment is the NEXT step's — a second heal that finds new evidence to
    // acknowledge and a writer left to rotate — and that is where a mute would show.
    await step("a second fork is refused too", async () => {
      const rotated = writerOf(desktop)!;
      cloneMachine(desktop, laptop);
      assert.equal(writerOf(laptop), rotated, "now the laptop holds the desktop's new id");

      await shareFinding(desktop.repo, PR, { targetKind: "anchor", targetId: "a_d2", text: "desktop, again" });
      await shareFinding(laptop.repo, PR, { targetKind: "anchor", targetId: "a_l2", text: "laptop, again" });

      const first = await syncOne(desktop) as { error?: string };
      assert.equal(first.error, undefined, `the first machine up still syncs: ${first.error}`);
      const second = await syncOne(laptop) as { error?: string };
      assert.ok(second.error, "and the second is refused on evidence the old acknowledgment does not cover");
      assert.match(second.error!, new RegExp(rotated));
    });

    await step("and the second repair sees evidence the first acknowledgment does not cover", async () => {
      const r = await sharedHeal(laptop.repo) as any;
      assert.equal(r.error, undefined, `the second heal failed: ${r.error}`);
      // THE assertion that the acknowledgment is not a mute. Izzie's acknowledgment of
      // the first fork is in this clone's log and matched by nothing here: if it
      // covered this fork too the scope would read `complete`, `sharedHeal` would skip
      // the scope, and both of these would be empty.
      //
      // Measured while mutation-checking, and the reason this comment exists: it takes
      // removing BOTH of `acknowledged`'s gates to make this fail. A constant
      // `evidenceDigest` alone is caught by the causal check, and dropping the causal
      // check alone is caught by the digest. They are independently sufficient, so a
      // future reader finding one of them "redundant" is reading a passing test wrong.
      assert.deepEqual(r.acknowledged.map((a: any) => a.reason), ["fork"],
        "the second fork is evidence in its own right");
      // THREE, not two. The union is per SHARD, and this one is the rotated writer's —
      // it already carried the acknowledgment the first heal appended. That the two
      // findings both survive is asserted at the end, against what a reader sees.
      assert.equal(r.resolved[0]?.events, 3, "the whole shard is unioned, not just the forked pair");
      assert.ok(r.rotated, "and this time it is the laptop that rotates");
    });

    await settled("the second repair");

    await step("all four writes are on all three machines", async () => {
      for (const m of t.all) {
        const f = await sharedFindings(m.repo, PR) as any;
        assert.deepEqual(
          f.findings.map((x: any) => x.text).sort(),
          ["desktop, again", "filed from the desktop", "filed from the laptop", "laptop, again"],
          `${m.machine} is missing a write after two forks and two repairs`,
        );
      }
    });
  } finally { t.dispose(); }
});

test("an agent may not clear a fork, however ordinary the rest of the sequence was", async () => {
  // The gate is on the ACT, and it has to survive being reached at the end of a long
  // chain rather than on a fresh fixture — `sharedHeal` resolves its own actor, so a
  // scenario that got there by a different route is a different call.
  const t = await team([IZZIE, IZZIE]);
  try {
    const a = machine(t, "m0"), b = machine(t, "m1");
    await shareFinding(a.repo, PR, { targetKind: "anchor", targetId: "a_1", text: "one" });
    cloneMachine(a, b);
    await shareFinding(b.repo, PR, { targetKind: "anchor", targetId: "a_2", text: "two" });
    await syncOne(a);
    assert.ok((await syncOne(b) as { error?: string }).error, "precondition: b is forked");

    const previous = process.env.CODEMAP_AGENT_MODEL;
    process.env.CODEMAP_AGENT_MODEL = "claude-opus-5";
    try {
      const r = await sharedHeal(b.repo) as { error?: string };
      assert.ok(r.error, "refused");
      assert.match(r.error!, /agent may not/i);
    } finally {
      // Restore in `finally`: the suite shares one process, so a leaked env var makes
      // every later file's writes an agent's. See CLAUDE.md § "The suite runs in ONE
      // process".
      if (previous === undefined) delete process.env.CODEMAP_AGENT_MODEL;
      else process.env.CODEMAP_AGENT_MODEL = previous;
    }

    // And the fork is still there afterwards — a refusal that had healed anyway would
    // pass the assertion above.
    assert.ok((await syncOne(b) as { error?: string }).error, "the refusal changed nothing");
  } finally { t.dispose(); }
});
