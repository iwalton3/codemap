import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor } from "./schema.js";
import type { PrWalkthrough } from "./walkthrough.js";
import { sortEvents, type LogEvent } from "./eventlog.js";
import {
  publishWalkthrough, readWalkthroughs, foldWalkthroughs,
  currentWalkthrough, staleWalkthroughs,
} from "./shared-walkthrough.js";

const izzie: Actor = { principal: "izzie@x.com" };
const dana: Actor = { principal: "dana@x.com" };
const izzieAgent: Actor = { principal: "izzie@x.com", via: { kind: "agent", model: "claude-opus-5" } };

const wt = (pr: number, head: string, title = "Feature"): PrWalkthrough => ({
  pr, head, at: "2026-08-21T00:00:00Z", by: "someone",
  features: [{ id: "f1", title, summary: "s", chapters: [{ id: "c1", title: "C", blocks: [], witnesses: [] }] }],
});

const tmp = () => mkdtempSync(join(tmpdir(), "codemap-sw-"));

test("a walkthrough published by one person is readable by another", async () => {
  const root = tmp();
  try {
    await publishWalkthrough(root, izzie, wt(264, "headsha"));
    const all = await readWalkthroughs(root, 264);
    assert.equal(all.length, 1);
    assert.equal(all[0]!.actor.principal, "izzie@x.com");
    assert.equal(all[0]!.walkthrough.head, "headsha");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("two people mapping one PR is two readings, not a conflict", async () => {
  // Picking a winner silently would throw away work somebody actually did.
  const root = tmp();
  try {
    await publishWalkthrough(root, izzie, wt(264, "headsha", "izzie's read"));
    await publishWalkthrough(root, dana, wt(264, "headsha", "dana's read"));
    const all = await readWalkthroughs(root, 264);
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((s) => s.actor.principal).sort(), ["dana@x.com", "izzie@x.com"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("re-publishing supersedes only your OWN earlier walkthrough", async () => {
  const root = tmp();
  try {
    await publishWalkthrough(root, izzie, wt(264, "headsha", "first"));
    await publishWalkthrough(root, dana, wt(264, "headsha", "dana's"));
    await publishWalkthrough(root, izzie, wt(264, "headsha", "revised"));
    const all = await readWalkthroughs(root, 264);
    assert.equal(all.length, 2, "still one per author");
    const mine = all.find((s) => s.actor.principal === "izzie@x.com")!;
    assert.equal(mine.walkthrough.features[0]!.title, "revised");
    assert.equal(all.find((s) => s.actor.principal === "dana@x.com")!.walkthrough.features[0]!.title, "dana's");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an agent publishes as its principal, not as a separate author", async () => {
  const root = tmp();
  try {
    await publishWalkthrough(root, izzie, wt(264, "headsha", "by hand"));
    await publishWalkthrough(root, izzieAgent, wt(264, "headsha", "by agent"));
    const all = await readWalkthroughs(root, 264);
    assert.equal(all.length, 1, "one person, one walkthrough");
    assert.equal(all[0]!.walkthrough.features[0]!.title, "by agent");
    assert.equal(all[0]!.actor.via?.model, "claude-opus-5", "and it records which model wrote it");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pull requests are isolated", async () => {
  const root = tmp();
  try {
    await publishWalkthrough(root, izzie, wt(264, "a"));
    await publishWalkthrough(root, izzie, wt(227, "b"));
    assert.equal((await readWalkthroughs(root, 264)).length, 1);
    assert.equal((await readWalkthroughs(root, 999)).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a second write records what the writer had already seen", async () => {
  // The causal handle: without it, "wrote it without seeing yours" and "wrote it
  // having read yours" are indistinguishable.
  const root = tmp();
  try {
    const first = await publishWalkthrough(root, izzie, wt(264, "h"));
    const second = await publishWalkthrough(root, dana, wt(264, "h"));
    assert.equal(first.after, undefined, "nothing to have seen");
    assert.equal(second.after, first.id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- the fold's actual contract ------------------------------------------------

const ev = (id: string, actor: Actor, w: PrWalkthrough, after?: string): LogEvent =>
  ({ id, kind: "walkthrough.published", subject: `pr-${w.pr}`, actor, at: "2026-08-21T00:00:00Z", ...(after ? { after } : {}), data: { walkthrough: w as never } });

test("the fold is order-independent — every reader lands on the same state", () => {
  const a = ev("0000000001-aa", izzie, wt(264, "h", "first"));
  const b = ev("0000000002-bb", izzie, wt(264, "h", "second"), a.id);
  const c = ev("0000000003-cc", dana, wt(264, "h", "dana"));
  const shuffles = [[a, b, c], [c, b, a], [b, c, a], [c, a, b]];
  const results = shuffles.map((s) =>
    foldWalkthroughs(sortEvents(s)).map((x) => `${x.actor.principal}:${x.walkthrough.features[0]!.title}`).sort().join("|"));
  assert.equal(new Set(results).size, 1, `all folds must agree, got ${JSON.stringify(results)}`);
  assert.equal(results[0], "dana@x.com:dana|izzie@x.com:second");
});

test("a revision arriving before its predecessor still wins, because causality says so", () => {
  // dana's clock is fast; izzie's revision has a lower id but names the first as
  // `after`. A pure id sort would leave the ORIGINAL standing.
  const first = ev("0000000005-zz", izzie, wt(264, "h", "first"));
  const revision = ev("0000000002-aa", izzie, wt(264, "h", "revised"), first.id);
  const folded = foldWalkthroughs(sortEvents([revision, first]));
  assert.equal(folded[0]!.walkthrough.features[0]!.title, "revised");
});

test("a malformed event is skipped, not fatal", () => {
  // It reached us through somebody else's client; refusing to load is worse.
  const bad = { id: "0000000001-aa", kind: "walkthrough.published", subject: "pr-264", actor: izzie, at: "x", data: {} } as LogEvent;
  const good = ev("0000000002-bb", dana, wt(264, "h"));
  assert.equal(foldWalkthroughs([bad, good]).length, 1);
});

test("an unrelated event kind is ignored", () => {
  const other = { id: "0000000001-aa", kind: "finding.created", subject: "f_1", actor: izzie, at: "x" } as LogEvent;
  assert.deepEqual(foldWalkthroughs([other]), []);
});

// --- head matching: the reason sharing these is safe ---------------------------

test("only a walkthrough about THIS head is current", () => {
  const all = foldWalkthroughs([ev("0000000001-aa", izzie, wt(264, "old")), ev("0000000002-bb", dana, wt(264, "new"))]);
  assert.equal(currentWalkthrough(all, "new")?.actor.principal, "dana@x.com");
  assert.equal(currentWalkthrough(all, "unknown"), undefined, "never fall back to one about another commit");
});

test("walkthroughs about another commit are reported as stale rather than hidden", () => {
  const all = foldWalkthroughs([ev("0000000001-aa", izzie, wt(264, "old")), ev("0000000002-bb", dana, wt(264, "new"))]);
  assert.deepEqual(staleWalkthroughs(all, "new").map((s) => s.actor.principal), ["izzie@x.com"]);
});

test("between two current walkthroughs the newest wins, by the shared order", () => {
  const all = foldWalkthroughs([ev("0000000001-aa", izzie, wt(264, "h")), ev("0000000009-zz", dana, wt(264, "h"))]);
  assert.equal(currentWalkthrough(all, "h")?.actor.principal, "dana@x.com");
});
