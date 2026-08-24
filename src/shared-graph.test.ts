/**
 * The graph fold, rule by rule against `docs/plan-sharing-the-rest.md` §0.
 *
 * The design is deliberately cheap — wall-clock wins, and anything the ordering actually
 * changed goes to a queue — so the tests are about the two places cheap can go wrong:
 * picking differently on two clones, and losing a write without saying so.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { testEvent } from "./test-events.js";
import { sortEvents, type LogEvent } from "./eventlog.js";
import type { Actor } from "./schema.js";
import { foldGraph, divergedNodes, graphScope } from "./shared-graph.js";

const izzie: Actor = { principal: "izzie@x.com" };
const ben: Actor = { principal: "ben@x.com" };

interface Pub {
  id: string;
  by: Actor;
  writer?: string;
  after?: string[];
  at?: string;
  node?: string;
  edges?: { to: string; type: string; order?: number; generatedBy?: string }[];
}

const pub = (p: Pub): LogEvent => testEvent({
  id: p.id, kind: "graph.published", subject: p.node ?? "n_flow",
  actor: p.by, writer: p.writer ?? `w_${p.by.principal}`, after: p.after ?? [],
  at: p.at ?? "2026-08-24T00:00:00Z",
  data: { nodeId: p.node ?? "n_flow", commit: "c1", edges: p.edges ?? [] },
});

const fold = (e: LogEvent[]) => foldGraph(sortEvents(e));
const wiring = (e: LogEvent[]) => fold(e).get("n_flow");

test("the scope is per universe, not per branch or pull request", () => {
  // A graph outlives every branch that touches it, which is the whole difference from a
  // walkthrough. Stated as a test because the scope string is the identity.
  assert.equal(graphScope("acme-api"), "graph/acme-api");
});

// --- the unit is a node's whole outgoing set --------------------------------

test("a publication REPLACES that node's wiring, so a removed edge really goes", () => {
  const w = wiring([
    pub({ id: "0000000001-aa", by: izzie, at: "2026-08-24T01:00:00Z", edges: [
      { to: "n_a", type: "step_of", order: 0 }, { to: "n_b", type: "step_of", order: 1 },
    ] }),
    pub({ id: "0000000002-bb", by: izzie, after: ["0000000001-aa"], at: "2026-08-24T02:00:00Z", edges: [
      { to: "n_a", type: "step_of", order: 0 },
    ] }),
  ])!;
  assert.deepEqual(w.winner.edges.map((e) => e.to), ["n_a"], "dropping a step is a real change, not a no-op");
});

test("order survives, because a flow IS its cardinality", () => {
  const w = wiring([pub({ id: "0000000001-aa", by: izzie, edges: [
    { to: "n_b", type: "step_of", order: 1 }, { to: "n_a", type: "step_of", order: 0 },
  ] })])!;
  assert.deepEqual(
    w.winner.edges.map((e) => [e.to, e.order]), [["n_b", 1], ["n_a", 0]],
    "the ORDER field is carried; a flow with its steps unordered is not the same flow",
  );
});

test("analyzer output is refused at the FOLD, not only at the publish surface", () => {
  // The same both-ends rule `source: "graph"` triage obeys. Remote events come from
  // builds this one did not write, so a write-time check protects the honest writer and
  // nobody else — and an analyzer edge that travelled would be a copy no clone can
  // refresh, of something every clone regenerates exactly.
  const w = wiring([pub({ id: "0000000001-aa", by: izzie, edges: [
    { to: "n_a", type: "step_of" }, { to: "n_gen", type: "folds", generatedBy: "marten" },
  ] })])!;
  assert.deepEqual(w.winner.edges.map((e) => e.to), ["n_a"]);
});

// --- fast-forward, or queue it ----------------------------------------------

test("a plain sequence is a FAST-FORWARD — nothing for anyone to look at", () => {
  const events = [
    pub({ id: "0000000001-aa", by: izzie, at: "2026-08-24T01:00:00Z", edges: [{ to: "n_a", type: "step_of" }] }),
    pub({ id: "0000000002-bb", by: ben, writer: "w_b", after: ["0000000001-aa"], at: "2026-08-24T02:00:00Z",
      edges: [{ to: "n_b", type: "step_of" }] }),
  ];
  const w = wiring(events)!;
  assert.deepEqual(w.winner.edges.map((e) => e.to), ["n_b"], "ben saw izzie and rewired: his answer");
  assert.equal(w.reordered, undefined, "wall-clock and causal order agree, so there is nothing to queue");
  assert.deepEqual(divergedNodes(fold(events)), []);
});

test("a causally LATER write with an EARLIER clock is queued, and the clock still wins", () => {
  // The case the detector exists for, and the reason it is not "detect concurrency":
  // these two are causally ordered — ben saw izzie — so no concurrency test would fire.
  // What is wrong is the CLOCK, and the only way to see it is that the two orders
  // disagree about the winner.
  const events = [
    pub({ id: "0000000001-aa", by: izzie, at: "2026-08-24T09:00:00Z", edges: [{ to: "n_a", type: "step_of" }] }),
    // Ben's laptop is an hour slow. He saw izzie's write and replaced it.
    pub({ id: "0000000002-bb", by: ben, writer: "w_b", after: ["0000000001-aa"], at: "2026-08-24T08:00:00Z",
      edges: [{ to: "n_b", type: "step_of" }] }),
  ];
  const w = wiring(events)!;
  assert.deepEqual(w.winner.edges.map((e) => e.to), ["n_a"], "wall-clock is served, per the owner's rule");
  assert.ok(w.reordered, "and the disagreement is RECORDED, or ben's write vanishes with nobody told");
  assert.equal(w.reordered!.causal.actor.principal, "ben@x.com", "the queue can name whose write the order lost");
  assert.deepEqual(divergedNodes(fold(events)).map((x) => x.nodeId), ["n_flow"]);
});

test("concurrent writes are queued only when the two orders actually disagree", () => {
  // Two people wiring one node apart. Whether this is queued depends on whether the
  // clock and the canonical tie-break pick the same winner — which is the point: the
  // question is never "did they write concurrently", it is "did the ordering matter".
  const later = pub({ id: "0000000002-bb", by: ben, writer: "w_b", at: "2026-08-24T02:00:00Z",
    edges: [{ to: "n_b", type: "step_of" }] });
  const earlier = pub({ id: "0000000001-aa", by: izzie, at: "2026-08-24T01:00:00Z",
    edges: [{ to: "n_a", type: "step_of" }] });
  const w = wiring([earlier, later])!;
  assert.deepEqual(w.winner.edges.map((e) => e.to), ["n_b"], "the later clock wins");
  assert.equal(
    w.reordered, undefined,
    "canonical order puts the higher id last too, so both orders agree and this is a fast-forward",
  );
});

test("every clone picks the same winner when two writes share a timestamp", () => {
  // `at` alone is not a total order. Without the id tie-break two clones holding the
  // same events could serve different wiring, which is CONVERGENCE gone — the property
  // every other rule here is in service of.
  const same = "2026-08-24T01:00:00Z";
  const a = pub({ id: "0000000001-aa", by: izzie, at: same, edges: [{ to: "n_a", type: "step_of" }] });
  const b = pub({ id: "0000000002-bb", by: ben, writer: "w_b", at: same, edges: [{ to: "n_b", type: "step_of" }] });
  assert.deepEqual(wiring([a, b])!.winner.edges.map((e) => e.to), ["n_b"]);
  assert.deepEqual(wiring([b, a])!.winner.edges.map((e) => e.to), ["n_b"], "and the arrival order changes nothing");
});

// --- what is not a publication ----------------------------------------------

test("an event whose envelope and payload disagree about the node is refused", () => {
  // The subject is what the fold groups on and the payload is what it reads; a mismatch
  // would file one node's wiring under another's name.
  const bad = testEvent({
    id: "0000000001-aa", kind: "graph.published", subject: "n_flow", actor: izzie, writer: "w_i",
    data: { nodeId: "n_other", commit: "c1", edges: [{ to: "n_a", type: "step_of" }] },
  });
  assert.equal(fold([bad]).size, 0);
});

test("a node wired to nothing is a real answer, not an absent one", () => {
  // Publishing an empty set is how a flow's last step is removed. Dropping it as
  // "nothing to say" would make that unrepresentable and the removal silent.
  const w = wiring([
    pub({ id: "0000000001-aa", by: izzie, at: "2026-08-24T01:00:00Z", edges: [{ to: "n_a", type: "step_of" }] }),
    pub({ id: "0000000002-bb", by: izzie, after: ["0000000001-aa"], at: "2026-08-24T02:00:00Z", edges: [] }),
  ])!;
  assert.deepEqual(w.winner.edges, []);
});

// --- the ownership seam, which is where the data loss would be ---------------

test("a local edge write never reaches a teammate's edge", async () => {
  // `writeGraph` is a whole-list rewrite — correct while every row was local, and
  // destructive the moment one is not. This is the same seam that bit triage: a bare
  // `DELETE FROM edges` takes rows only the fold may own, with no event recording it,
  // and the next fold puts them back, so the damage appears and disappears depending on
  // when you look.
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { db } = await import("./db.js");
  const { writeGraph, readGraph, readLocalGraph } = await import("./store.js");

  const root = mkdtempSync(join(tmpdir(), "codemap-edges-"));
  try {
    mkdirSync(join(root, ".codemap"), { recursive: true });
    // A teammate's edge, written the way only the fold may: with a scope.
    db(root).prepare(
      "INSERT INTO edges(from_id,to_id,type,ord,generated_by,origin,source_scope) VALUES(?,?,?,?,?,?,?)",
    ).run("n_theirs", "n_step", "step_of", 0, null, "sync", "graph/acme-api");

    await writeGraph(root, { edges: [{ from: "n_mine", to: "n_a", type: "step_of" }] });
    await writeGraph(root, { edges: [{ from: "n_mine", to: "n_b", type: "step_of" }] });

    assert.deepEqual(
      (await readLocalGraph(root)).edges.map((e) => e.to), ["n_b"],
      "two local writes in a row — the DELETE runs every time, which a single write cannot show",
    );
    const merged = (await readGraph(root)).edges.map((e) => `${e.from}->${e.to}`).sort();
    assert.deepEqual(merged, ["n_mine->n_b", "n_theirs->n_step"], "and the teammate's edge is still there");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the merged read does not double an edge two people both drew", async () => {
  // The same edge from two sources is one edge. Without the dedupe every count the
  // catalog and the event matrix show would be inflated by whatever the team agreed on
  // — which is the wiring they are most likely to have both drawn.
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { db } = await import("./db.js");
  const { writeGraph, readGraph } = await import("./store.js");

  const root = mkdtempSync(join(tmpdir(), "codemap-dedupe-"));
  try {
    mkdirSync(join(root, ".codemap"), { recursive: true });
    db(root).prepare(
      "INSERT INTO edges(from_id,to_id,type,ord,generated_by,origin,source_scope) VALUES(?,?,?,?,?,?,?)",
    ).run("n_flow", "n_a", "step_of", 0, null, "sync", "graph/acme-api");
    await writeGraph(root, { edges: [{ from: "n_flow", to: "n_a", type: "step_of", order: 0 }] });

    assert.equal((await readGraph(root)).edges.length, 1, "one edge, drawn twice, is one edge");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a reordering reaches the review queue, and a repair closes it", async () => {
  // The end of the loop. The fold DETECTS a reorder; without this it shows up only if
  // somebody goes looking, which is the same as not detecting it.
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { db } = await import("./db.js");
  const { readAnnotations } = await import("./store.js");
  const { init, document: documentNode } = await import("./ops.js");
  const { queueDivergedWiring, DIVERGED_WIRING_CATEGORY } = await import("./ops/graph.js");
  const { graphProjection } = await import("./shared-projections.js");

  const root = mkdtempSync(join(tmpdir(), "codemap-wq-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/pay.ts"), "export function transfer(c: number) { return c; }\n");
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["add", "-A"], { cwd: root });
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"], { cwd: root });
    await init(root);
    const side = join(root, "side");
    mkdirSync(side, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: side });
    writeFileSync(join(root, ".codemap", "sidecar"), side);
    const doc = await documentNode(root, {
      id: "n_flow", type: "process", title: "Intake", summary: "s", body: "b",
      anchors: ["src/pay.ts#transfer"],
    }) as { error?: string };
    assert.equal(doc.error, undefined, `document failed: ${doc.error}`);

    // The fold's answer, planted: the clock and causality disagree about the winner.
    // From the resolver, not the basename: `universeKey` lower-cases, so a hand-built
    // scope string silently misses the one the ops use.
    const { resolveSidecar } = await import("./sidecar-config.js");
    const scope = `graph/${resolveSidecar(root)!.universe}`;
    const receipt = (who: string, at: string, id: string, to: string) => ({
      nodeId: "n_flow", commit: "c1", edges: [{ to, type: "step_of" as any }],
      actor: { principal: who }, at, eventId: id,
    });
    graphProjection.write(db(root), scope, new Map([["n_flow", {
      nodeId: "n_flow",
      winner: receipt("izzie@x", "2026-08-24T09:00:00Z", "e1", "n_a"),
      reordered: { causal: receipt("ben@x", "2026-08-24T08:00:00Z", "e2", "n_b") },
    }]]));
    db(root).prepare("INSERT INTO shared_scope(scope,fingerprint,folded_at,events,status) VALUES(?,?,?,?,?)")
      .run(scope, "planted", "now", 2, "complete");

    const first = await queueDivergedWiring(root) as any;
    assert.equal(first.filed, 1, "the reorder is filed where a person will see it");
    const items = (await readAnnotations(root)).annotations
      .filter((a) => a.category === DIVERGED_WIRING_CATEGORY && !a.resolved);
    assert.equal(items.length, 1);
    assert.match(items[0]!.text, /causally later/, "and the item says WHY it matters, not just that it happened");
    assert.match(items[0]!.text, /ben@x/, "naming the writer whose decision lost to a clock");

    // Idempotent: it runs on every sync, and one that re-asked would bury the answer.
    const again = await queueDivergedWiring(root) as any;
    assert.deepEqual({ f: again.filed, q: again.alreadyQueued }, { f: 0, q: 1 });

    // The repair: the fold stops reporting it, so the clone closes its own item.
    graphProjection.write(db(root), scope, new Map([["n_flow", {
      nodeId: "n_flow", winner: receipt("ben@x", "2026-08-24T10:00:00Z", "e3", "n_b"),
    }]]));
    const after = await queueDivergedWiring(root) as any;
    assert.equal(after.closed, 1, "a repair closes the item — its own text promises that");
    assert.equal(
      (await readAnnotations(root)).annotations
        .filter((a) => a.category === DIVERGED_WIRING_CATEGORY && !a.resolved).length, 0,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("deciding an answer and pushing it back resolves it for EVERYONE", async () => {
  // The owner's framing: this should work like pointing an agent at a merge conflict —
  // once corrected, the invalid state is resolved across the board. Three things have
  // to hold for that, and the first two were broken.
  //
  //   1. What you edit is what you can SEE. `connect` read only the local partition, so
  //      adding one edge to a node a teammate had wired published a set that never held
  //      their edges — silently dropping them. Measured: B added one edge and lost a
  //      STEP from B's own flow.
  //   2. You can say "not that". There was no removal at all, so a divergence could only
  //      be resolved by adding, which is accumulation rather than resolution.
  //   3. The answer lands everywhere, INCLUDING on the machine that decided it. A
  //      publication replaces the shared wiring, but the publisher's own local row would
  //      keep answering locally — so a removal resolved for everybody except them.
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { db } = await import("./db.js");
  const { readGraph, readLocalGraph } = await import("./store.js");
  const { init, document: documentNode, connect, disconnect } = await import("./ops.js");
  const { graphProjection } = await import("./shared-projections.js");
  const { resolveSidecar } = await import("./sidecar-config.js");

  const root = mkdtempSync(join(tmpdir(), "codemap-decide-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/pay.ts"), "export function transfer(c: number) { return c; }\n");
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["add", "-A"], { cwd: root });
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"], { cwd: root });
    await init(root);
    const side = join(root, "side");
    mkdirSync(side, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: side });
    writeFileSync(join(root, ".codemap", "sidecar"), side);
    for (const [id, type] of [["n_flow", "process"], ["n_a", "step"]] as const) {
      const r = await documentNode(root, {
        id, type: type as any, title: id, summary: "s", anchors: ["src/pay.ts#transfer"],
      }) as { error?: string };
      assert.equal(r.error, undefined, `document ${id} failed: ${r.error}`);
    }

    // A TEAMMATE's wiring, fold-owned — this clone holds no local row for it.
    const scope = `graph/${resolveSidecar(root)!.universe}`;
    graphProjection.write(db(root), scope, new Map([["n_a", {
      nodeId: "n_a", winner: {
        nodeId: "n_a", commit: "c1", edges: [{ to: "n_flow", type: "step_of" as any, order: 0 }],
        actor: { principal: "ben@x" }, at: "2026-08-24T01:00:00Z", eventId: "e1",
      },
    }]]));
    assert.deepEqual((await readLocalGraph(root)).edges, [], "nothing of this clone's own yet");

    // 1 — ADDING must not drop what you could see.
    const c = await connect(root, { edges: [{ from: "n_a", to: "n_flow", type: "touches" }] }) as any;
    assert.equal(c.shareError, undefined, `publish failed: ${c.shareError}`);
    assert.deepEqual(
      (await readGraph(root)).edges.filter((e) => e.from === "n_a").map((e) => e.type).sort(),
      ["step_of", "touches"],
      "the teammate's step_of survived an additive act — this is the bug that lost a flow step",
    );

    // 3 — and the publisher does not keep a private copy: the log owns it now.
    assert.deepEqual(
      (await readLocalGraph(root)).edges, [],
      "published wiring left the local partition, or a later removal resolves for everyone but you",
    );

    // 2 — SAYING NOT THAT, which is what resolving a divergence actually needs.
    const d = await disconnect(root, { from: "n_a", to: "n_flow", type: "step_of" }) as any;
    assert.equal(d.removed, 1, "a removal is expressible");
    assert.equal(d.shareError, undefined, `removal did not publish: ${d.shareError}`);
    assert.deepEqual(
      (await readGraph(root)).edges.filter((e) => e.from === "n_a").map((e) => e.type),
      ["touches"],
      "and it lands — the decided answer is the whole answer, on this machine too",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});
