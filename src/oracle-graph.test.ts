/**
 * Workflow 8 — the wiring travels, and a reordering reaches a person.
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
 * - **The queue fires on a real reorder**, not a planted projection. The unit test
 *   plants rows; this makes two clones actually disagree.
 *
 * The six properties run after every step.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { team, who, whileApart, settle, rewriteHistory, type Team } from "./oracle.js";
import { Ledger, checkAlways, checkSettled } from "./oracle-properties.js";
import { document, connect, flow, eventMatrix } from "./ops.js";
import { publishLocalDocs, publishLocalGraph, sharedGraph, sharedSync } from "./ops-shared.js";
import { queueDivergedWiring, DIVERGED_WIRING_CATEGORY } from "./ops/graph.js";
import { readAnnotations } from "./store.js";

const OWNER = "izzie@acme.test";
const MATE = "ben@acme.test";

const openWiringItems = async (repo: string): Promise<string[]> =>
  (await readAnnotations(repo)).annotations
    .filter((a) => a.category === DIVERGED_WIRING_CATEGORY && !a.resolved)
    .map((a) => a.target.id);

test("a flow one person wrote is walkable by another, and a reorder reaches the queue", async () => {
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

    // 3 — THE CONTROL. Ordinary sequential wiring is a fast-forward: nothing to look at.
    await step("ben rewires it having SEEN izzie's — a fast-forward, nothing queued", async () => {
      const c = await connect(ben.repo, {
        edges: [{ from: "n_post", to: "n_intake", type: "step_of", order: 0 }],
      }) as { shareError?: string };
      assert.equal(c.shareError, undefined, `ben's wiring did not publish: ${c.shareError}`);
      await settle(t);
      await checkSettled(t, ledger);

      for (const m of [izzie, ben]) {
        assert.deepEqual(await openWiringItems(m.repo), [], `${m.actor.principal} was asked to look at a decision`);
      }
    });

    // 4 — the case the queue exists for, and it is NOT concurrency detection: what is
    //     wrong is the CLOCK. Manufactured, because two clones in one process share a
    //     real one.
    //
    //     Rewritten BEFORE the push, deliberately. Rewriting history that has already
    //     travelled makes two versions of one event id, which blocks the scope — correct,
    //     covered by workflow 4, and not what this step is about. Here the rewritten line
    //     is the only version anyone ever sees.
    await step("a publication carries an earlier clock than the one it saw", async () => {
      await settle(t);
      // Both rewire the SAME node, so their publications compete. Izzie first; ben has
      // pulled her work in the settle above, so his is the causally later one.
      const a = await connect(izzie.repo, {
        edges: [{ from: "n_post", to: "n_intake", type: "touches" }],
      }) as { shareError?: string };
      assert.equal(a.shareError, undefined, `izzie's wiring did not publish: ${a.shareError}`);
      const b = await connect(ben.repo, {
        edges: [{ from: "n_post", to: "n_intake", type: "depends_on" }],
      }) as { shareError?: string };
      assert.equal(b.shareError, undefined, `ben's wiring did not publish: ${b.shareError}`);

      // Ben's laptop is years slow. His event is still unpushed, so this is the only
      // version that will ever exist.
      let moved = 0;
      rewriteHistory(ben, "a slow clock", (paths, sidecar) => {
        for (const p of paths.filter((x) => x.startsWith("graph/"))) {
          const file = join(sidecar, p);
          const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
          // ONLY THE LAST LINE — the event just written and not yet pushed. Rewriting
          // any earlier one changes bytes the other clone already holds, which is two
          // versions of one id and blocks the scope. That is correct behaviour and
          // workflow 4's subject; here it would just hide what this step is testing.
          const last = lines.length - 1;
          if (last < 0 || JSON.parse(lines[last]!).actor?.principal !== MATE) continue;
          writeFileSync(file, lines.map((l, i) => {
            if (i !== last) return l;
            moved++;
            return JSON.stringify({ ...JSON.parse(l), at: "2020-01-01T00:00:00.000Z" });
          }).join("\n") + "\n");
        }
      });
      assert.ok(moved > 0, "the rewrite moved a clock — otherwise the step below proves nothing");

      await settle(t);
      await checkSettled(t, ledger);
    });

    await step("both clones queue it, and both name the writer whose decision lost", async () => {
      for (const m of [izzie, ben]) {
        const g = await sharedGraph(m.repo) as any;
        assert.equal(g.error, undefined, `${m.actor.principal} cannot read the shared graph: ${g.error}`);
        assert.ok(
          g.reordered.length > 0,
          `${m.actor.principal} does not see the reorder — a write lost to a clock with nobody told`,
        );
        // DERIVED identically on every clone, which is exactly why the queue item is
        // local and never mirrored: one team fact, not one shared question per machine.
        const items = await openWiringItems(m.repo);
        assert.deepEqual(items, ["n_post"], `${m.actor.principal} was not asked to look at it`);
        const text = (await readAnnotations(m.repo)).annotations
          .find((a) => a.category === DIVERGED_WIRING_CATEGORY && !a.resolved)!.text;
        assert.match(text, /causally later/, "the item says WHY it matters, not just that it happened");
        assert.match(text, new RegExp(MATE), "and names the writer whose decision lost to a clock");
      }
    });

    await step("a repair closes it on both machines, with no shared lifecycle", async () => {
      // The repair is an ordinary publication carrying a commit — no special authority.
      // Every clone's fold stops reporting the divergence and each closes its own item,
      // which is what makes a LOCAL derived item correct rather than merely cheaper.
      const c = await connect(izzie.repo, {
        edges: [{ from: "n_post", to: "n_intake", type: "depends_on" }],
      }) as { added: number; shareError?: string };
      assert.equal(c.added, 1, "the repair is a real change — a no-op publishes nothing and settles nothing");
      assert.equal(c.shareError, undefined, `the repair did not publish: ${c.shareError}`);
      await settle(t);
      // `settle` syncs, and `sharedSync` runs the queue pass — but run it once more so a
      // failure here is about the reverse pass rather than about sync ordering.
      for (const m of [izzie, ben]) await queueDivergedWiring(m.repo);
      await checkSettled(t, ledger);

      for (const m of [izzie, ben]) {
        assert.deepEqual(
          await openWiringItems(m.repo), [],
          `${m.actor.principal}'s item outlived the divergence its own text promised it would go with`,
        );
      }
    });

    await step("and ben's flow still walks after all of it", async () => {
      // The whole point, re-checked at the end: the repair chain must not have left the
      // flow unwalkable on the machine that did not make it.
      const f = await flow(ben.repo, "n_intake") as any;
      assert.equal(f.error, undefined, `ben lost the flow: ${f.error}`);
      assert.ok(f.steps.length >= 1, "with its steps");
    });
    await step("a BLOCKED scope neither files nor closes — it is not evidence", async () => {
      // Found by getting a rewrite wrong: rewriting history that has already travelled
      // makes two versions of one event id, and the scope blocks. Correct, and workflow
      // 4's subject — what matters HERE is what the queue does about it. A blocked scope
      // is explicitly not something to act on, so filing from one invents work and
      // CLOSING from one retires a real divergence because a scope nobody may read
      // simply stopped reporting it. The second is the dangerous direction.
      // A fresh divergence FIRST, so there is an open item for a wrong guard to close.
      // Without one this step passes whether the guard exists or not — the mutation
      // check is what showed that, and it is the shape the oracle notes warn about.
      await connect(izzie.repo, { edges: [{ from: "n_take", to: "n_intake", type: "depends_on" }] });
      await connect(ben.repo, { edges: [{ from: "n_take", to: "n_intake", type: "calls_api" }] });
      rewriteHistory(ben, "another slow clock", (paths, sidecar) => {
        for (const p2 of paths.filter((x) => x.startsWith("graph/"))) {
          const file = join(sidecar, p2);
          const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
          const last = lines.length - 1;
          if (last < 0 || JSON.parse(lines[last]!).actor?.principal !== MATE) continue;
          writeFileSync(file, lines.map((l, i) => (
            i === last ? JSON.stringify({ ...JSON.parse(l), at: "2020-01-01T00:00:00.000Z" }) : l
          )).join("\n") + "\n");
        }
      });
      await settle(t);
      const before = await openWiringItems(ben.repo);
      assert.deepEqual(before, ["n_take"], "an item is open, which is what a wrong guard would retire");

      rewriteHistory(ben, "corrupt a shard that already travelled", (paths, sidecar) => {
        const p2 = paths.find((x) => x.startsWith("graph/"));
        assert.ok(p2, "ben has a graph shard to corrupt");
        const file = join(sidecar, p2!);
        const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
        // The FIRST line — long since pushed, so izzie holds the original bytes.
        writeFileSync(file, lines.map((l, i) => (
          i === 0 ? JSON.stringify({ ...JSON.parse(l), at: "1999-01-01T00:00:00.000Z" }) : l
        )).join("\n") + "\n");
      });
      await settle(t);

      const g = await sharedGraph(ben.repo) as any;
      assert.notEqual(g.scope, undefined, "the scope reports itself non-authoritative");
      const r = await queueDivergedWiring(ben.repo) as any;
      assert.deepEqual(
        { filed: r.filed, closed: r.closed }, { filed: 0, closed: 0 },
        "a scope nobody may read must not create work, and must not retire any either",
      );
      assert.deepEqual(
        await openWiringItems(ben.repo), before,
        "the open item SURVIVES — a scope nobody may read did not stop reporting it, it stopped being readable",
      );
    });

  } finally {
    t.dispose();
  }
});
