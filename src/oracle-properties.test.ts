import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { team, who, settle, type Team } from "./oracle.js";
import { Ledger, checkAlways, checkSettled, converged, ownership, readsDoNotFold, stable, shuffled } from "./oracle-properties.js";
import { document } from "./ops.js";
import { publishLocalDocs, sharedDocs } from "./ops-shared.js";
import { docScope } from "./shared-docs.js";
import { universeKey } from "./sidecar-config.js";
import { db } from "./db.js";
import { emitEvent } from "./eventlog.js";

const A = "ana@acme.test";
const B = "ben@acme.test";

const withTeam = async (fn: (t: Team) => Promise<void>) => {
  const t = await team([A, B]);
  try { await fn(t); } finally { t.dispose(); }
};

/** A minimal real chain: A documents something, publishes it, everyone syncs. */
async function published(t: Team): Promise<void> {
  const a = who(t, A);
  await document(a.repo, {
    id: "n_transfer", type: "concept", title: "Transfer",
    summary: "moves money", anchors: ["src/pay.ts#transfer"], body: "The guard runs first.",
  });
  await publishLocalDocs(a.repo);
  await settle(t);
}

test("the six properties hold over an ordinary publish-and-sync", async () => {
  await withTeam(async (t) => {
    const ledger = new Ledger();
    await checkAlways(t, ledger);
    await published(t);
    await checkSettled(t, ledger);
  });
});

// --- each property must be able to FAIL, or it is decoration -----------------------

test("PROJECTION fires when the stored rows are not what the log says", async () => {
  await withTeam(async (t) => {
    const b = who(t, B);
    await published(t);
    await converged(t); // precondition

    // Valid JSON, current fingerprint, wrong content — the shape that matters,
    // because nothing about it looks damaged. Comparing clone against clone would
    // never see it: both fold the same log. Only reading the ROWS does.
    const scope = docScope(universeKey(b.repo));
    const changed = db(b.repo).prepare(
      "UPDATE node_versions SET body = ? WHERE source_scope = ?",
    ).run("silently rewritten", scope);
    assert.ok(Number(changed.changes) > 0, "precondition: the fold owns rows here");

    await assert.rejects(() => converged(t), /PROJECTION violated/);
  });
});

test("CONVERGENCE fires when one clone's log is not the other's", async () => {
  await withTeam(async (t) => {
    await published(t);
    await converged(t); // precondition: they agree right now

    // Reach past the ops and damage one clone's shard directly. Nothing else in the
    // system can produce divergence on demand, and a property nobody has watched fail
    // is a property nobody knows the shape of.
    const b = who(t, B);
    const scope = join(b.sidecar, docScope(universeKey(b.repo)));
    const shard = readdirSync(scope).find((f) => f.endsWith(".ndjson"))!;
    const lines = readFileSync(join(scope, shard), "utf8").trimEnd().split("\n");
    writeFileSync(join(scope, shard), lines.slice(0, -1).join("\n") + "\n", "utf8");

    // Re-fold B so its ROWS agree with its damaged log. Without this the projection
    // check fires first and this test would pass on the wrong violation — B would be
    // internally inconsistent rather than merely different from A.
    db(b.repo).prepare("DELETE FROM shared_scope WHERE scope = ?").run(docScope(universeKey(b.repo)));
    await sharedDocs(b.repo);

    await assert.rejects(() => converged(t), /CONVERGENCE violated/);
  });
});

test("NO LOSS fires when a clone stops holding an event it held", async () => {
  await withTeam(async (t) => {
    const ledger = new Ledger();
    await published(t);
    await ledger.observe(t); // it held them here

    const b = who(t, B);
    const scope = join(b.sidecar, docScope(universeKey(b.repo)));
    const shard = readdirSync(scope).find((f) => f.endsWith(".ndjson"))!;
    writeFileSync(join(scope, shard), "", "utf8");

    await assert.rejects(() => ledger.observe(t), /NO LOSS violated/);
  });
});

test("OWNERSHIP fires when a local write reaches a fold-owned row", async () => {
  await withTeam(async (t) => {
    const b = who(t, B);
    await published(t);
    await ownership(b); // precondition: B's adopted rows match the log

    // Exactly what a careless local write would do: change the content of a row the
    // fold owns. The next fold puts it back, so the damage is invisible except in
    // the window between — which is why this needs an invariant rather than a test.
    db(b.repo).prepare("UPDATE node_versions SET body = ? WHERE origin IS NOT NULL").run("locally rewritten");

    await assert.rejects(() => ownership(b), /OWNERSHIP violated/);
  });
});

test("COMPLETENESS fires when a read has to fold", async () => {
  await withTeam(async (t) => {
    const a = who(t, A);
    await published(t);
    await readsDoNotFold(t); // precondition: reads are answered from rows

    // An event appended behind materialization's back: the scope's fingerprint moves,
    // so the next ordinary read has no choice but to fold. This is the shape of the
    // real defect — any write path that forgets to materialize looks exactly like it.
    await emitEvent(a.sidecar, docScope(universeKey(a.repo)), a.actor, "doc.version", "n_late", {
      version: {
        versionId: "nv_late", nodeId: "n_late", type: "concept", title: "Late",
        summary: "s", body: "b", citations: [], createdAt: new Date().toISOString(),
        createdCommit: null, createdBranch: null,
      },
    });

    await assert.rejects(() => readsDoNotFold(t), /COMPLETENESS violated/);
  });
});

// --- the checks the checks depend on ------------------------------------------------

test("stable() distinguishes Maps, or every convergence check passes vacuously", async () => {
  // The trap this exists for: the folds return `Map`s and `JSON.stringify(new Map())`
  // is `{}`. Compare folded values with bare stringify and two clones holding
  // completely different docs compare EQUAL — the oracle would report convergence on
  // a system that had none, forever, and look green doing it.
  assert.notEqual(stable(new Map([["a", 1]])), stable(new Map([["a", 2]])));
  assert.notEqual(stable(new Map([["a", 1]])), stable(new Map()));
  // ...while genuinely equal values compare equal whatever order they were built in.
  assert.equal(stable(new Map([["a", 1], ["b", 2]])), stable(new Map([["b", 2], ["a", 1]])));
  assert.equal(stable({ x: 1, y: 2 }), stable({ y: 2, x: 1 }));
});

test("shuffled() actually permutes, or determinism passes vacuously", async () => {
  const items = Array.from({ length: 12 }, (_, i) => i);
  const permutations = new Set([1, 2, 3, 4].map((seed) => shuffled(items, seed).join(",")));
  assert.ok(permutations.size > 1, "different seeds must give different orders");
  assert.ok(!permutations.has(items.join(",")) || permutations.size > 1, "and not merely the identity");
  // Same seed, same permutation — a failure has to reproduce from the seed alone.
  assert.equal(shuffled(items, 7).join(","), shuffled(items, 7).join(","));
  assert.deepEqual(shuffled(items, 3).slice().sort((a, b) => a - b), items, "nothing is lost or duplicated");
});
