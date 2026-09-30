/**
 * Validation at replay for the triage, graph, reviews and walkthrough scopes (plan phase 3):
 * the door refuses what the fold refuses, a refused LINEAR event on read is damage (`state`,
 * `reference`) or newer (`shape`), and a merge-era one is skipped.
 *
 * Only triage has a precondition that can move — an agent claim must RAISE what is on record.
 * Graph, reviews and walkthrough stand on no prior state, so their tests are the shape and
 * policy refusals, the analyzer-node rule (owner, Q2), and that a node is not a foreign key.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { scenario, who, settle, asAgent } from "./scenario.js";
import { readScope, sortEvents, type LogEvent } from "./eventlog.js";
import { begin, syncSession, staged } from "./sync-engine.js";
import { emitEvent } from "./write.js";
import { appendUnfolded } from "./test-door.js";
import { LogDamage } from "./log-damage.js";
import { lockoutOf } from "./lockout.js";
import { testEvent } from "./test-events.js";
import { assertTriage, assertTriageBatch, foldTriage, foldTriageReport, isTombstone, triageScope, triageSubject } from "./shared-triage.js";
import { foldGraph, graphScope, publishWiring } from "./shared-graph.js";
import { foldReviewLinks, foldReviewLinksReport, linkReview, reviewScope } from "./shared-reviews.js";
import { foldWalkthroughs, foldWalkthroughsReport, publishWalkthrough, walkthroughScope } from "./shared-walkthrough.js";
import type { PrWalkthrough } from "./walkthrough.js";
import type { Actor } from "./schema.js";
import { discard } from "./test-tmp.js";

const U = "acme-api";
const izzie: Actor = { principal: "izzie@x.com" };
const opus: Actor = { principal: "izzie@x.com", via: { kind: "agent", model: "m" } };
const tmp = () => mkdtempSync(join(tmpdir(), "codemap-tgv-"));
const mark = (importance: "low" | "important" | "business-critical", source: "human" | "agent" | "graph" = "human") =>
  ({ targetKind: "anchor" as const, targetId: "a_1", importance, source, witnesses: [] });

// --- triage: the precondition that moves ------------------------------------------------

test("an agent claim a person has since out-ranked is refused at replay, and its author is told", async () => {
  const s = await scenario(["ana@x.com", "ben@x.com"]);
  try {
    const ana = who(s, "ana@x.com"), ben = who(s, "ben@x.com");
    const scope = triageScope(U);
    begin(ana.sidecar);
    // Nothing on record: `important` raises, so staging admits it.
    await assertTriage(ana.sidecar, scope, asAgent(ana, "m"), mark("important", "agent"));
    await assertTriage(ben.sidecar, scope, ben.actor, mark("business-critical"));
    const r = await syncSession(ana.sidecar, ana.actor);
    assert.ok("error" in r, "ana's agent claim replays after ben's mark");
    assert.deepEqual(r.conflicts?.map((c) => c.kind), ["triage.asserted"]);
    assert.match(r.conflicts![0]!.why, /agents may only ESCALATE it, never lower/);
    assert.equal(staged(ana.sidecar).length, 1, "and it stays staged for her");
    await settle(s).catch(() => {});
    for (const p of [ana, ben]) {
      const t = foldTriage(await readScope(p.sidecar, scope)).get(triageSubject("anchor", "a_1"))!;
      assert.ok(!isTombstone(t) && t.importance.effective.value === "business-critical");
      assert.equal(lockoutOf(p.sidecar), null);
    }
    assert.equal((await readScope(ben.sidecar, scope)).length, 1, "the refused claim never reached the remote");
  } finally { s.dispose(); }
});

test("a refusal is judged where the claim STANDS: a later mark does not make an earlier claim damage", () => {
  // The fold ratchets agent claims against the final human baseline, so a report taken from
  // it would call this claim refused — and every reader of a linear log would lock on it.
  const claim = testEvent({ id: "e1", seq: 1, kind: "triage.asserted", subject: "anchor:a_1", actor: opus, data: mark("important", "agent") });
  const later = testEvent({ id: "e2", seq: 2, kind: "triage.asserted", subject: "anchor:a_1", actor: izzie, after: [], data: mark("business-critical") });
  assert.deepEqual(foldTriageReport([claim, later]).refused, []);
  assert.doesNotThrow(() => foldTriage([claim, later]));
});

test("an agent clear and graph-sourced stakes: refused at the door, damage when planted linear, skipped merge-era", async () => {
  const root = tmp();
  try {
    const scope = triageScope(U);
    await assertTriage(root, scope, izzie, mark("important"));
    await assert.rejects(assertTriage(root, scope, izzie, mark("low", "graph")), /does not travel/);
    await assert.rejects(emitEvent(root, scope, izzie, "triage.asserted", "anchor:a_1", mark("low", "graph")), /does not travel/);
    await assert.rejects(emitEvent(root, scope, opus, "triage.cleared", "anchor:a_1", { targetKind: "anchor", targetId: "a_1", present: false }),
      /an agent may only raise/);
    const planted = await appendUnfolded(root, scope, opus, "triage.cleared", "anchor:a_1", { targetKind: "anchor", targetId: "a_1", present: false });
    await assert.rejects(async () => foldTriage(await readScope(root, scope)), LogDamage);
    const mergeEra = (await readScope(root, scope)).map(({ seq: _, ...e }) => e as LogEvent);
    assert.equal(mergeEra.some((e) => e.id === planted.id), true);
    assert.doesNotThrow(() => foldTriage(sortEvents(mergeEra)), "a merge-era refusal is dropped, as the merge-era fold did");
  } finally { discard(root); }
});

test("a batch with one claim that does not raise lands nothing — all or none, as at replay", async () => {
  const root = tmp();
  try {
    const scope = triageScope(U);
    await assertTriage(root, scope, izzie, mark("business-critical"));
    await assert.rejects(assertTriageBatch(root, scope, opus, [
      { ...mark("business-critical", "agent"), targetId: "a_2" },
      { ...mark("low", "agent") },
    ]), /agents may only ESCALATE/);
    assert.equal((await readScope(root, scope)).length, 1);
  } finally { discard(root); }
});

test("a node target is not a foreign key: stakes on a node nobody published land", async () => {
  const root = tmp();
  try {
    await assertTriage(root, triageScope(U), izzie, { targetKind: "node", targetId: "never-published", importance: "low", source: "human", witnesses: [] });
    assert.equal(foldTriage(await readScope(root, triageScope(U))).size, 1);
  } finally { discard(root); }
});

// --- graph: the analyzer rule, both ends -------------------------------------------------

test("an analyzer node's wiring is refused at the door, damage when planted linear, dropped merge-era", async () => {
  const root = tmp();
  try {
    const scope = graphScope(U);
    const wiring = { nodeId: "mst-hold-open", edges: [{ to: "tr-hold-approved", type: "from_state" }] };
    await assert.rejects(emitEvent(root, scope, izzie, "graph.published", "mst-hold-open", wiring), /analyzer node/);
    await assert.rejects(publishWiring(root, scope, izzie, { nodeId: "mst-hold-open", commit: null, edges: [] }), /analyzer node/);
    assert.equal((await readScope(root, scope)).length, 0);
    await publishWiring(root, scope, izzie, { nodeId: "transfer", commit: null, edges: [{ from: "transfer", to: "mh-capture", type: "calls" }] });
    const planted = await appendUnfolded(root, scope, izzie, "graph.published", "mst-hold-open", wiring);
    await assert.rejects(async () => foldGraph(await readScope(root, scope)), LogDamage);
    // Owner, Q2: "Drop them" — a merge-era one is not applied either.
    const mergeEra = (await readScope(root, scope)).map(({ seq: _, ...e }) => e as LogEvent);
    assert.ok(mergeEra.some((e) => e.id === planted.id));
    assert.deepEqual([...foldGraph(sortEvents(mergeEra)).keys()], ["transfer"],
      "and an edge TO an analyzer node is not a foreign key");
  } finally { discard(root); }
});

test("an analyzer-generated edge is refused at the door and is damage when planted linear", async () => {
  const root = tmp();
  try {
    const scope = graphScope(U);
    const data = { nodeId: "n1", edges: [{ to: "x", type: "folds", generatedBy: "marten" }] };
    await assert.rejects(emitEvent(root, scope, izzie, "graph.published", "n1", data), /analyzer-generated edges/);
    await appendUnfolded(root, scope, izzie, "graph.published", "n1", data);
    await assert.rejects(async () => foldGraph(await readScope(root, scope)), LogDamage);
  } finally { discard(root); }
});

test("`connect` and the backfill never offer an analyzer node's wiring, and keep it local", async () => {
  const root = tmp(), side = tmp();
  const git = (...args: string[]) => spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8" });
  try {
    git("init", "-q", "-b", "main"); git("config", "user.email", "izzie@x.com"); git("config", "user.name", "izzie");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "pay.ts"), "export function transfer(c) { return c; }\n", "utf8");
    git("add", "-A"); git("commit", "-qm", "seed");
    const { init, document, connect } = await import("./ops.js");
    const { readAnchorStore, writeNode, readLocalGraph } = await import("./store.js");
    await init(root);
    writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
    const anchor = (await readAnchorStore(root)).anchors[0]!.id;
    await document(root, { id: "a", type: "concept", title: "a", summary: "s", body: "b", anchors: [anchor] });
    // Generated by the store's own word, with an id outside the analyzer namespace: the
    // store's `generatedBy` is the authority the op reads.
    await writeNode(root, { id: "gen-hold", type: "aggregate", title: "Hold", summary: "s", body: "", anchors: [anchor], generatedBy: "marten" });
    await writeNode(root, { id: "mst-hold-open", type: "state", title: "Open", summary: "s", body: "", anchors: [anchor], generatedBy: "marten" });

    const r = await connect(root, { edges: [
      { from: "gen-hold", to: "a", type: "depends_on" },
      { from: "mst-hold-open", to: "a", type: "depends_on" },
      { from: "a", to: "mst-hold-open", type: "depends_on" },
    ] }) as { shared?: boolean; localOnly?: string[]; shareError?: string };
    assert.equal(r.shareError, undefined);
    assert.equal(r.shared, true, "a's wiring went");
    assert.deepEqual(r.localOnly?.sort(), ["gen-hold", "mst-hold-open"], "and the analyzer nodes' did not, and it says so");
    const { resolveSidecar } = await import("./sidecar-config.js");
    const subjects = (await readScope(side, graphScope(resolveSidecar(root)!.universe))).map((e) => e.subject);
    assert.deepEqual(subjects, ["a"]);
    const local = (await readLocalGraph(root)).edges.map((e) => e.from).sort();
    assert.deepEqual(local, ["gen-hold", "mst-hold-open"], "their wiring stays on this machine rather than being cleared");

    const shared = await import("./ops-shared.js");
    const dry = await shared.publishLocalGraph(root, { dryRun: true }) as unknown as Record<string, number>;
    assert.equal(dry.wouldPublish, 0, "the hub does not count them as work");
    assert.equal(dry.skippedAnalyzerSource, 2, "and reports them rather than dropping them silently");
  } finally { discard(root); discard(side); }
});

// --- reviews and walkthroughs: shapes only ---------------------------------------------

test("a review link that is not a pull request number is refused, and on read is newer, not damage", async () => {
  const root = tmp();
  try {
    await assert.rejects(linkReview(root, U, izzie, "abc", "feat"), /pull request number/);
    await linkReview(root, U, izzie, "12", "feat");
    await linkReview(root, U, izzie, "12", "feat");   // the same link again: a no-op (owner, Q5)
    await appendUnfolded(root, reviewScope(U), izzie, "review.linked", "pr-abc", { pr: "abc", branch: "feat" });
    const events = await readScope(root, reviewScope(U));
    assert.deepEqual(foldReviewLinks(events), [{ pr: "12", branch: "feat" }], "reads carry on without it");
    assert.deepEqual(foldReviewLinksReport(events).refused.map((r) => r.cls), ["shape"]);
  } finally { discard(root); }
});

test("an unbuilt walkthrough is refused at the door, and on read is newer, not damage", async () => {
  const root = tmp();
  try {
    const unbuilt = { pr: 269, head: "h", features: [{ chapters: [{ title: "C", blocks: [] }] }] } as unknown as PrWalkthrough;
    await assert.rejects(publishWalkthrough(root, izzie, unbuilt, `${U}/pr-269`), /not a built walkthrough/);
    await appendUnfolded(root, walkthroughScope(`${U}/pr-269`), izzie, "walkthrough.published", "pr-269", { walkthrough: unbuilt as unknown as Record<string, unknown> });
    const events = await readScope(root, walkthroughScope(`${U}/pr-269`));
    assert.deepEqual(foldWalkthroughs(events), []);
    assert.deepEqual(foldWalkthroughsReport(events).refused.map((r) => r.cls), ["shape"]);
  } finally { discard(root); }
});
