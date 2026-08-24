import { test } from "node:test";
import assert from "node:assert/strict";
import { team, who, whileApart, settle } from "./oracle.js";
import { Ledger, checkSettled } from "./oracle-properties.js";
import { shareFinding, sharedFindings, corroborateFinding, publishLocalDocs, sharedDocs } from "./ops-shared.js";
import { document } from "./ops.js";
import { readScope, scopesOnDisk, sortEvents, causality } from "./eventlog.js";

/**
 * WORKFLOW 2, the causal half — two people writing with nobody's news in hand.
 *
 * The other half, two real PROCESSES contending for one sidecar lock, is
 * `oracle-race.test.ts` and cannot be done from here: two `await`s in one process share
 * a lock owner and never contend. This is the complementary case, and it is the one
 * that matters for MEANING rather than for safety — whether two writes that neither saw
 * are recognised as unordered, and what the fold does with them.
 *
 * The first test is the CONTROL for `whileApart` itself. A helper that quietly produced
 * ordered writes would leave every scenario built on it asserting about a conflict that
 * never happened, and it would pass — which is why the concurrency is measured from the
 * log's own causal vector rather than assumed from the shape of the code.
 */

const ANA = "ana@acme.test";
const BEN = "ben@acme.test";
const PR = 12;

/** The findings scope's events, in canonical order, with `saw` over them. */
async function causalityOf(m: { sidecar: string }, endsWith: string) {
  const scope = (await scopesOnDisk(m.sidecar)).find((s) => s.endsWith(endsWith));
  assert.ok(scope, `no scope ending ${endsWith}`);
  const events = sortEvents(await readScope(m.sidecar, scope!));
  return { events, ...causality(events) };
}

test("whileApart really does produce writes neither side saw", async () => {
  const t = await team([ANA, BEN]);
  try {
    await whileApart(
      t,
      ANA, (m) => shareFinding(m.repo, PR, { targetKind: "anchor", targetId: "a_1", text: "ana's" }),
      BEN, (m) => shareFinding(m.repo, PR, { targetKind: "anchor", targetId: "a_2", text: "ben's" }),
    );

    const { events, saw } = await causalityOf(who(t, ANA), `pr-${PR}`);
    const mine = events.find((e) => e.actor.principal === ANA);
    const theirs = events.find((e) => e.actor.principal === BEN);
    assert.ok(mine && theirs, `both writes are in the log: ${events.map((e) => e.actor.principal).join(", ")}`);

    // THE CONTROL. Neither reaches the other, which is the log's own definition of
    // concurrent — and the only definition it has. Without this the helper could be
    // settling between the two writes and every scenario built on it would be testing
    // an ordinary sequence.
    assert.equal(saw(mine!.id, theirs!.id), false, "ana's write did not see ben's");
    assert.equal(saw(theirs!.id, mine!.id), false, "and ben's did not see ana's");

    // …and the counter-control: a write made AFTER a settle does see what came before,
    // so `saw` is not simply always false.
    await settle(t);
    await shareFinding(who(t, ANA).repo, PR, { targetKind: "anchor", targetId: "a_3", text: "ana's, later" });
    await settle(t);
    const after = await causalityOf(who(t, ANA), `pr-${PR}`);
    const later = after.events.find((e) => (e.data as { text?: string })?.text === "ana's, later");
    assert.ok(later, "the later write is there");
    assert.equal(after.saw(later!.id, theirs!.id), true, "a write made after a sync HAS seen the other side");
  } finally { t.dispose(); }
});

test("two people writing apart both land, and everyone converges", async () => {
  const t = await team([ANA, BEN]);
  const ledger = new Ledger();
  try {
    await whileApart(
      t,
      ANA, (m) => document(m.repo, {
        id: "n_transfer", type: "concept", title: "Transfer",
        summary: "moves money", anchors: ["src/pay.ts#transfer"],
      }).then(() => publishLocalDocs(m.repo)),
      BEN, (m) => document(m.repo, {
        id: "n_settle", type: "concept", title: "Settle",
        summary: "sums a batch", anchors: ["src/settle.py#settle"],
      }).then(() => publishLocalDocs(m.repo)),
    );
    await checkSettled(t, ledger);

    // Two docs about two different symbols are not a conflict — they are two people
    // working. Both must survive on both machines.
    for (const m of t.all) {
      assert.deepEqual(
        (await sharedDocs(m.repo) as any).docs.map((d: any) => d.nodeId).sort(),
        ["n_settle", "n_transfer"],
        `${m.machine} is missing somebody's doc`,
      );
    }
  } finally { t.dispose(); }
});

test("two verdicts on one finding, neither having seen the other, both survive", async () => {
  // The shape that actually tests the fold: same subject, no ordering between them. A
  // fold that let one verdict replace the other would look perfectly convergent — both
  // clones would agree on the surviving one — so convergence alone cannot catch it.
  // What catches it is counting.
  const t = await team([ANA, BEN]);
  const ledger = new Ledger();
  try {
    const ana = who(t, ANA), ben = who(t, BEN);
    const filed = await shareFinding(ana.repo, PR, {
      targetKind: "anchor", targetId: "a_1", text: "the guard rejects an empty string but not whitespace",
    }) as { id: string };
    await settle(t);

    await whileApart(
      t,
      ANA, (m) => corroborateFinding(m.repo, PR, filed.id, "confirm", "whitespace is the common case in imports"),
      BEN, (m) => corroborateFinding(m.repo, PR, filed.id, "refute", "the caller trims before it gets here"),
    );
    await checkSettled(t, ledger);

    for (const m of t.all) {
      const f = (await sharedFindings(m.repo, PR) as any).findings.find((x: any) => x.id === filed.id);
      assert.ok(f, `${m.machine} lost the finding itself`);
      assert.deepEqual(
        (f.corroboration ?? []).map((c: any) => c.verdict).sort(), ["confirm", "refute"],
        `${m.machine} kept only one of two verdicts nothing ordered — a disagreement is data, not a race to be won`,
      );
    }
  } finally { t.dispose(); }
});
