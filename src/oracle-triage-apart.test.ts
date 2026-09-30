/**
 * Workflow 7 — two people mark what a symbol is worth while apart.
 *
 * What this adds over `shared-triage.test.ts`, which pins every rule against hand-built
 * events: two real clones, writing through the real ops and syncing through the real
 * transport. `whileApart` stages the first person's mark, lands the second's, then
 * replays the first — so the first person's mark is pushed LATER.
 *
 *   1. Both mark the same symbol, apart, and agree.
 *   2. Both mark another, apart, across the business-critical line. The later push stands
 *      on both machines, and nothing is queued for anyone (owner, Q6).
 *   3. The other marks again, having seen it. That later mark stands.
 *
 * The six properties run after every step.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { team, who, whileApart, settle, type Team } from "./oracle.js";
import { Ledger, checkAlways, checkSettled } from "./oracle-properties.js";
import { setTriage } from "./ops.js";
import { triageStatus } from "./triage.js";
import { readAnnotations, readAnchorStore } from "./store.js";

const OWNER = "izzie@acme.test";
const MATE = "ben@acme.test";

/** An anchor id both clones agree on — the seed is identical, so the ids are too. */
async function anchorFor(repo: string, symbol: string): Promise<string> {
  const a = (await readAnchorStore(repo)).anchors.find((x) => x.symbolPath.join(".") === symbol);
  assert.ok(a, `the seed no longer has ${symbol} — pick another symbol, not another assertion`);
  return a!.id;
}

test("two people mark stakes apart, and the later push stands everywhere", async () => {
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

    await step("both mark the same symbol, apart, and agree", async () => {
      await whileApart(
        t,
        OWNER, (m) => setTriage(m.repo, { targetKind: "anchor", targetId: refund, importance: "important", source: "human", reason: "user-visible" }),
        MATE, (m) => setTriage(m.repo, { targetKind: "anchor", targetId: refund, importance: "important", source: "human", reason: "refunds are watched" }),
      );
      await checkSettled(t, ledger);
      for (const m of [izzie, ben]) {
        assert.equal((await triageStatus(m.repo, { kind: "anchor", id: refund })).importance, "important");
      }
    });

    await step("and disagree about another, across the business-critical line", async () => {
      // Izzie's `low` is staged first and pushed second, so it is the later mark.
      await whileApart(
        t,
        OWNER, (m) => setTriage(m.repo, { targetKind: "anchor", targetId: transfer, importance: "low", source: "human", reason: "guarded upstream" }),
        MATE, (m) => setTriage(m.repo, { targetKind: "anchor", targetId: transfer, importance: "business-critical", source: "human", reason: "money moves through here" }),
      );
      await checkSettled(t, ledger);
      for (const m of [izzie, ben]) {
        assert.equal((await triageStatus(m.repo, { kind: "anchor", id: transfer })).importance, "low",
          `${m.actor.principal} does not serve the later push`);
        assert.deepEqual((await readAnnotations(m.repo)).annotations.filter((a) => a.author === "triage"), [],
          `the sync filed a question for ${m.actor.principal}`);
      }
    });

    await step("ben marks it again, having seen izzie's, and his stands", async () => {
      const r = await setTriage(ben.repo, {
        targetKind: "anchor", targetId: transfer, importance: "business-critical",
        source: "human", reason: "guarded, but it is still money",
      }) as any;
      assert.equal(r.error, undefined, `ben's mark failed: ${r.error}`);
      await settle(t);
      await checkSettled(t, ledger);
      for (const m of [izzie, ben]) {
        assert.equal((await triageStatus(m.repo, { kind: "anchor", id: transfer })).importance, "business-critical");
      }
    });
  } finally {
    t.dispose();
  }
});
