/**
 * Workflow 7 — two people disagree about what a symbol is worth.
 *
 * What this adds over `shared-triage.test.ts`, which already pins every merge rule
 * against hand-built events: the rules are only useful if a real pair of clones,
 * writing through the real ops and syncing through the real transport, reach them.
 * `whileApart` is what makes that honest — it produces CAUSAL concurrency from the
 * causal vector, not two writes that merely happened close together.
 *
 * The arc is the one the design is about:
 *
 *   1. Both mark the same symbol, apart, and agree. Nothing happens — the control.
 *   2. Both mark another, apart, across the business-critical line. The higher value
 *      holds everywhere and a person is asked to settle it.
 *   3. Somebody settles it by marking again HAVING SEEN both. The contest goes.
 *
 * The six properties run after every step, so a fold that reached a row it does not
 * own, or two clones disagreeing, fails here rather than on somebody's machine.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { team, who, whileApart, settle, type Team } from "./oracle.js";
import { Ledger, checkAlways, checkSettled } from "./oracle-properties.js";
import { setTriage, queueContestedTriage } from "./ops.js";
import { sharedTriage, contestedTriage } from "./ops-shared.js";
import { triageStatus } from "./triage.js";
import { readAnnotations, readAnchorStore } from "./store.js";
import { CONTESTED_TRIAGE_CATEGORY } from "./ops/triage.js";

const OWNER = "izzie@acme.test";
const MATE = "ben@acme.test";

/** An anchor id both clones agree on — the seed is identical, so the ids are too. */
async function anchorFor(repo: string, symbol: string): Promise<string> {
  const a = (await readAnchorStore(repo)).anchors.find((x) => x.symbolPath.join(".") === symbol);
  assert.ok(a, `the seed no longer has ${symbol} — pick another symbol, not another assertion`);
  return a!.id;
}

const openContests = async (repo: string): Promise<string[]> =>
  (await readAnnotations(repo)).annotations
    .filter((a) => a.category === CONTESTED_TRIAGE_CATEGORY && !a.resolved)
    .map((a) => a.target.id);

test("two people disagree about stakes, and only the expensive disagreement reaches a person", async () => {
  const t: Team = await team([OWNER, MATE]);
  const ledger = new Ledger();
  const step = async (what: string, fn: () => Promise<void>) => {
    await fn();
    try { await checkAlways(t, ledger); }
    catch (e) { throw new Error(`after "${what}": ${(e as Error).message}`); }
  };

  try {
    const izzie = who(t, OWNER), ben = who(t, MATE);
    const transfer = await anchorFor(izzie.repo, "transfer");
    const refund = await anchorFor(izzie.repo, "refund");
    assert.equal(await anchorFor(ben.repo, "transfer"), transfer, "both clones mint the same id");

    // 1 — THE CONTROL. Concurrent, and agreeing. If this filed a queue item, the
    //     escalation would be firing on ordinary use and step 2 would prove nothing.
    await step("both mark the same symbol, apart, and agree", async () => {
      await whileApart(
        t,
        OWNER, (m) => setTriage(m.repo, {
          targetKind: "anchor", targetId: refund, importance: "important",
          source: "human", reason: "user-visible",
        }),
        MATE, (m) => setTriage(m.repo, {
          targetKind: "anchor", targetId: refund, importance: "important",
          source: "human", reason: "refunds are watched",
        }),
      );
      await checkSettled(t, ledger);

      for (const m of [izzie, ben]) {
        assert.equal((await triageStatus(m.repo, { kind: "anchor", id: refund })).importance, "important");
      }
      const c = await contestedTriage(izzie.repo) as any;
      assert.equal(c.count, 0, "agreeing is not a conflict, however concurrent");

      // Both receipts are kept even so — per-field provenance is required either way,
      // and "who else said this" is what makes a mark trustable.
      const shared = await sharedTriage(izzie.repo, "anchor", refund) as any;
      assert.deepEqual(
        (shared.marks[0].importance.alsoSaid ?? []).map((x: any) => x.by), [MATE],
        "the other person's identical mark is retained, not collapsed away",
      );
    });

    // 2 — the expensive one.
    await step("and disagree about another, across the business-critical line", async () => {
      await whileApart(
        t,
        OWNER, (m) => setTriage(m.repo, {
          targetKind: "anchor", targetId: transfer, importance: "low",
          source: "human", reason: "guarded upstream",
        }),
        MATE, (m) => setTriage(m.repo, {
          targetKind: "anchor", targetId: transfer, importance: "business-critical",
          source: "human", reason: "money moves through here",
        }),
      );
      await checkSettled(t, ledger);

      // The higher value holds on BOTH machines while it is open: ranking something
      // too high costs somebody a few minutes, and too low costs the thing this
      // project exists to prevent.
      for (const m of [izzie, ben]) {
        assert.equal(
          (await triageStatus(m.repo, { kind: "anchor", id: transfer })).importance, "business-critical",
          `${m.actor.principal} under-ranked a symbol while the disagreement is open`,
        );
      }

      const c = await contestedTriage(izzie.repo) as any;
      assert.equal(c.count, 1, "and this one IS worth interrupting for");
      assert.equal(c.marks[0].target.id, transfer);
      assert.deepEqual(
        (c.marks[0].importance.alsoSaid ?? []).map((x: any) => x.value), ["low"],
        "the queue item can name the other side, or there is nothing to settle",
      );
    });

    await step("a person is asked to settle it, once", async () => {
      const first = await queueContestedTriage(izzie.repo) as any;
      assert.equal(first.filed, 1, "filed into the same review queue `ackHole` uses");
      assert.deepEqual(await openContests(izzie.repo), [transfer]);

      // Idempotent. The escalation is entered by STATE, so it runs on every sync — one
      // that re-asked each time would bury the answer under its own repetitions.
      const again = await queueContestedTriage(izzie.repo) as any;
      assert.deepEqual(
        { filed: again.filed, revised: again.revised, alreadyQueued: again.alreadyQueued },
        { filed: 0, revised: 0, alreadyQueued: 1 },
        "a second pass over unchanged evidence must not re-ask",
      );
      assert.equal((await openContests(izzie.repo)).length, 1);
    });

    await step("izzie settles it by marking again, having seen both sides", async () => {
      // The whole point of the rule: causally-seen supersedes. She has now folded both
      // marks, so hers is a decision rather than a third opinion — and it lands even
      // though it LOWERS, because a person owns lowering.
      const r = await setTriage(izzie.repo, {
        targetKind: "anchor", targetId: transfer, importance: "important",
        source: "human", reason: "settled: guarded, but it is still money",
      }) as any;
      assert.equal(r.error, undefined, `settle failed: ${r.error}`);
      await settle(t);
      await checkSettled(t, ledger);

      for (const m of [izzie, ben]) {
        assert.equal(
          (await triageStatus(m.repo, { kind: "anchor", id: transfer })).importance, "important",
          `${m.actor.principal} did not receive the settlement`,
        );
      }
      assert.equal((await contestedTriage(ben.repo) as any).count, 0, "the disagreement is over on both sides");
    });
  } finally {
    t.dispose();
  }
});
