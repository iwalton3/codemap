/**
 * Workflow 8 — the wiring travels, and push order decides whose is served.
 *
 * What this adds over `shared-graph.test.ts`, which pins every fold rule against
 * hand-built events: the rules are only worth anything if two real clones, writing
 * through the real ops and syncing through the real transport, reach them. Three things
 * only a whole-chain run can show:
 *
 * - **A second person can WALK a flow they did not write.** That was the last inverted
 *   WALL, and the reason the flow-walker — a headline reviewer feature — was
 *   single-player. It is not a fold property; it is `flow()` resolving a teammate's
 *   `step_of` edges against this clone's own anchors.
 * - **The `orphan` claim.** A teammate's node arriving unwired used to be reported as
 *   "nothing folds this, nothing projects it". No unit test could see it, because it
 *   needs a node from one machine and a graph on another.
 * - **Push order, through the real transport.** A publication staged with a slow clock
 *   and pushed second is what every clone serves (owner, Q6).
 *
 * The six properties run after every step.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { team, who, settle, type Team } from "./oracle.js";
import { Ledger, checkAlways, checkSettled } from "./oracle-properties.js";
import { document, connect, flow, eventMatrix } from "./ops.js";
import { publishLocalDocs, publishLocalGraph, sharedSync } from "./ops-shared.js";
import { readGraph } from "./store.js";
import { begin, dropOp, staged, syncSession } from "./sync-engine.js";
import { stage } from "./sync-queue.js";
import { currentSession } from "./sync-session.js";

const OWNER = "izzie@acme.test";
const MATE = "ben@acme.test";

const edgesFrom = async (repo: string, node: string): Promise<string[]> =>
  (await readGraph(repo)).edges.filter((e) => e.from === node).map((e) => e.type).sort();

test("a flow one person wrote is walkable by another, and the later push is served", async () => {
  const t: Team = await team([OWNER, MATE]);
  const ledger = new Ledger();
  const step = async (what: string, fn: () => Promise<void>) => {
    await fn();
    try { await checkAlways(t, ledger); }
    catch (e) { throw new Error(`after "${what}": ${(e as Error).message}`); }
  };

  try {
    const izzie = who(t, OWNER), ben = who(t, MATE);

    // 1 — izzie documents a flow and wires it. `process`/`step` docs were REFUSED until
    //     edges travelled, so this step failing is the wall coming back.
    await step("izzie writes a flow and wires its steps", async () => {
      const mk = async (id: string, type: string, title: string, anchor: string) => {
        const r = await document(izzie.repo, {
          id, type: type as any, title, summary: `${title} step`, anchors: [anchor],
        }) as { error?: string };
        assert.equal(r.error, undefined, `document ${id} failed: ${r.error}`);
      };
      await mk("n_intake", "process", "Intake", "src/pay.ts#transfer");
      await mk("n_take", "step", "Take", "src/pay.ts#transfer");
      await mk("n_post", "step", "Post", "src/ledger.ts#Ledger.post");

      const c = await connect(izzie.repo, {
        edges: [
          { from: "n_take", to: "n_intake", type: "step_of", order: 0 },
          { from: "n_post", to: "n_intake", type: "step_of", order: 1 },
        ],
      }) as { added: number; shareError?: string };
      assert.equal(c.added, 2, "both steps wired");
      assert.equal(c.shareError, undefined, `wiring did not publish: ${c.shareError}`);

      const d = await publishLocalDocs(izzie.repo) as { skipped?: { flows: number } };
      assert.equal(d.skipped?.flows ?? 0, 0, "a flow is no longer skipped at the publish surface");
      // `connect` already published and handed ownership to the log, so the genesis
      // tool has nothing left to do. Asserted rather than skipped: a non-zero here would
      // mean the wiring stayed in the local partition, which is what made a later
      // removal resolve for everybody except the person who decided it.
      const g = await publishLocalGraph(izzie.repo) as { wouldPublish?: number; published?: number };
      assert.equal(g.published ?? 0, 0, "connect published it; nothing is left behind locally");
      const { readLocalGraph } = await import("./store.js");
      assert.deepEqual((await readLocalGraph(izzie.repo)).edges, [], "the log owns the wiring now");

      // Materialize before the properties run. `publishLocalDocs` APPENDS and does not
      // fold, so between the two the local row is byte-identical to a shared version
      // and carries no origin yet — which is exactly what OWNERSHIP is watching for.
      // The fold adopts it (`docsProjection`'s adoption rule), and a sync is what runs
      // the fold. A real transient, not a false positive: a reader in that window would
      // see the doc as purely local.
      await sharedSync(izzie.repo);
    });

    await settle(t);
    await checkSettled(t, ledger);

    // 2 — THE WALL, retired. This is the assertion the whole workflow exists for.
    await step("ben walks a flow he did not write, against his OWN checkout", async () => {
      const f = await flow(ben.repo, "n_intake") as any;
      assert.equal(f.error, undefined, `ben cannot open the flow: ${f.error}`);
      assert.deepEqual(
        f.steps.map((s: any) => s.title), ["Take", "Post"],
        "the steps arrive IN ORDER — a flow is a node with forced cardinality, and an "
        + "unordered one is not the same flow",
      );
      // The point of a walk: live code at every step, resolved in BEN's index. If this
      // were carried in the payload it would be izzie's copy of the source.
      assert.ok(
        f.steps.every((s: any) => (s.anchors ?? []).length > 0),
        "and every step cites code ben can open",
      );
    });

    await step("and his event matrix does not call izzie's node an orphan", async () => {
      // The live defect this work started from: `edges` had no provenance columns, so a
      // teammate's doc arrived with its citations and none of its wiring, and the matrix
      // reported "nothing folds this, nothing projects it" — a confident false claim.
      const m = await eventMatrix(ben.repo) as any;
      const orphaned = (m.events ?? []).filter((e: any) => e.orphan).map((e: any) => e.title);
      assert.ok(
        !orphaned.includes("Intake"),
        `the flow ben received is reported as an orphan: ${orphaned.join(", ")}`,
      );
    });

    // 3 — ordinary sequential wiring.
    await step("ben rewires it having SEEN izzie's, and both serve his", async () => {
      const c = await connect(ben.repo, {
        edges: [{ from: "n_post", to: "n_intake", type: "step_of", order: 0 }],
      }) as { shareError?: string };
      assert.equal(c.shareError, undefined, `ben's wiring did not publish: ${c.shareError}`);
      await settle(t);
      await checkSettled(t, ledger);

      for (const m of [izzie, ben]) assert.deepEqual(await edgesFrom(m.repo, "n_post"), ["step_of"]);
    });

    // 4 — the clock decides nothing. Manufactured, because two clones in one process share
    //     a real one; rewritten while staged, so the slow version is the only one that exists.
    await step("a publication pushed later, with an earlier clock, is what both serve", async () => {
      await settle(t);
      // Both rewire the SAME node, so their publications compete. Izzie pushes first; ben's
      // is staged without her touches edge, and replaces the set when it lands.
      const a = await connect(izzie.repo, {
        edges: [{ from: "n_post", to: "n_intake", type: "touches" }],
      }) as { shareError?: string };
      assert.equal(a.shareError, undefined, `izzie's wiring did not publish: ${a.shareError}`);
      // Ben's laptop is years slow. His act is staged, not yet pushed, so the version with
      // the slow clock is the only one that will ever exist: drop it and append it again
      // with that clock — the two moves the queue allows.
      begin(ben.sidecar);
      const b = await connect(ben.repo, {
        edges: [{ from: "n_post", to: "n_intake", type: "depends_on" }],
      }) as { shareError?: string };
      assert.equal(b.shareError, undefined, `ben's wiring did not stage: ${b.shareError}`);
      let moved = 0;
      for (const op of staged(ben.sidecar).filter((o) => o.scope.startsWith("graph/") && o.event.actor.principal === MATE)) {
        dropOp(ben.sidecar, op.event.id);
        stage(ben.sidecar, currentSession().session, op.scope, { ...op.event, at: "2020-01-01T00:00:00.000Z" });
        moved++;
      }
      assert.ok(moved > 0, "the rewrite moved a clock — otherwise the step below proves nothing");
      const pushed = await syncSession(ben.sidecar, ben.actor);
      assert.ok(!("error" in pushed), JSON.stringify(pushed));

      await settle(t);
      await checkSettled(t, ledger);
      for (const m of [izzie, ben]) {
        assert.deepEqual(await edgesFrom(m.repo, "n_post"), ["depends_on", "step_of"],
          `${m.actor.principal} serves the earlier clock, not the later push`);
      }
    });

    await step("and ben's flow still walks after all of it", async () => {
      const f = await flow(ben.repo, "n_intake") as any;
      assert.equal(f.error, undefined, `ben lost the flow: ${f.error}`);
      assert.ok(f.steps.length >= 1, "with its steps");
    });
  } finally {
    t.dispose();
  }
});
