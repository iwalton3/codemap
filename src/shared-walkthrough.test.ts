import { test } from "node:test";
import { testEvent } from "./test-events.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor } from "./schema.js";
import type { PrWalkthrough } from "./walkthrough.js";
import { sortEvents, type LogEvent } from "./eventlog.js";
import {
  publishWalkthrough, readWalkthroughs, foldWalkthroughs,
  currentWalkthrough, staleWalkthroughs,
} from "./shared-walkthrough.js";
import { discard } from "./test-tmp.js";

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
  } finally { discard(root); }
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
  } finally { discard(root); }
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
  } finally { discard(root); }
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
  } finally { discard(root); }
});

test("pull requests are isolated", async () => {
  const root = tmp();
  try {
    await publishWalkthrough(root, izzie, wt(264, "a"));
    await publishWalkthrough(root, izzie, wt(227, "b"));
    assert.equal((await readWalkthroughs(root, 264)).length, 1);
    assert.equal((await readWalkthroughs(root, 999)).length, 0);
  } finally { discard(root); }
});

test("a second write records what the writer had already seen", async () => {
  // The causal handle: without it, "wrote it without seeing yours" and "wrote it
  // having read yours" are indistinguishable.
  const root = tmp();
  try {
    const first = await publishWalkthrough(root, izzie, wt(264, "h"));
    const second = await publishWalkthrough(root, dana, wt(264, "h"));
    // Empty, not absent: `after` is a mandatory list since the protocol-1 freeze, so
    // "saw nothing" and "did not say" are no longer the same value.
    assert.deepEqual(first.after, [], "nothing to have seen");
    // A list, because a writer apart from two others holds two heads and one id
    // cannot name both. Here there is exactly one.
    assert.deepEqual(second.after, [first.id]);
  } finally { discard(root); }
});

// --- the fold's actual contract ------------------------------------------------

const ev = (id: string, actor: Actor, w: PrWalkthrough, after?: string): LogEvent =>
  testEvent({ id, kind: "walkthrough.published", subject: `pr-${w.pr}`, actor, ...(after ? { after: [after] } : {}), data: { walkthrough: w as never } });

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

/**
 * The event that took a pull-request page down permanently.
 *
 * One `walkthrough.published` on `Acme.API` PR 269 carried the agent's `WalkInput` —
 * `{title, blocks}`, no id and no witnesses — where the BUILT walkthrough belonged.
 * `PrWalkthrough` and `WalkInput` are close enough structurally that TypeScript never
 * sees the substitution, and every publish path crosses a JSON boundary that erases the
 * difference. `staleChapters` then read `c.witnesses.some` and `/api/pr/story` 500'd
 * with "Cannot read properties of undefined" — for good, because the log is append-only
 * and the fold had checked only the envelope.
 *
 * Skipped, not repaired: the fold's existing rule for a malformed event, and it means
 * the next materialization drops the row on every machine without rewriting history.
 */
test("a walkthrough published as unbuilt INPUT is skipped, not folded", () => {
  const unbuilt = {
    pr: 269, head: "headsha", at: "2026-08-25T03:16:05.158Z", by: "agent",
    features: [{ id: "f1", title: "F", summary: "s", chapters: [{ title: "C", blocks: [] }] }],
  } as unknown as PrWalkthrough;
  const bad = ev("0000000009-bad", izzie, unbuilt);
  assert.deepEqual(foldWalkthroughs([bad]), [], "a chapter with no witnesses can never go stale — it is not a walkthrough");
});

/** And a good one beside it still folds — the guard is about the shape, not the author. */
test("the malformed event does not take a valid one down with it", () => {
  const unbuilt = {
    pr: 269, head: "headsha", at: "2026-08-25T03:16:05.158Z", by: "agent",
    features: [{ id: "f1", title: "F", summary: "s", chapters: [{ title: "C", blocks: [] }] }],
  } as unknown as PrWalkthrough;
  const folded = foldWalkthroughs(sortEvents([
    ev("0000000009-bad", izzie, unbuilt),
    ev("0000000010-ok", dana, wt(269, "headsha", "dana's read")),
  ]));
  assert.deepEqual(folded.map((f) => f.actor.principal), ["dana@x.com"]);
});

/** The same shape refused at the publish boundary, so it cannot enter a log again. */
test("publishing the input rather than the built walkthrough is refused", async () => {
  const dirs = [mkdtempSync(join(tmpdir(), "codemap-swr-")), mkdtempSync(join(tmpdir(), "codemap-sws-"))];
  const [root, side] = dirs as [string, string];
  try {
    const { spawnSync } = await import("node:child_process");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    spawnSync("git", ["config", "user.email", "izzie@x.com"], { cwd: root });
    spawnSync("git", ["config", "user.name", "izzie"], { cwd: root });
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: side });
    mkdirSync(join(root, ".codemap"), { recursive: true });
    writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");

    const shared = await import("./ops-shared.js");
    const unbuilt = {
      pr: 269, head: "headsha", at: "2026-08-25T03:16:05.158Z", by: "agent",
      features: [{ id: "f1", title: "F", summary: "s", chapters: [{ title: "C", blocks: [] }] }],
    } as unknown as PrWalkthrough;
    const r = await shared.shareWalkthrough(root, unbuilt) as { error?: string };
    assert.match(r.error ?? "", /INPUT, not a built walkthrough/);
    assert.match(r.error ?? "", /pr_walkthrough/, "and it names the verb that builds it");

    // The valid one still publishes — a guard that refuses everything proves nothing.
    const ok = await shared.shareWalkthrough(root, wt(269, "headsha")) as { error?: string; ok?: true };
    assert.ok(ok.ok, ok.error ?? "");
  } finally { dirs.forEach((d) => discard(d)); }
});

/** And the READ survives one anyway — a local row reaches it without passing either guard. */
test("staleChapters does not throw on a chapter with no witnesses", async () => {
  const { staleChapters } = await import("./walkthrough.js");
  const unbuilt = {
    pr: 269, head: "headsha", at: "2026-08-25T03:16:05.158Z", by: "agent",
    features: [{ id: "f1", title: "F", summary: "s", chapters: [{ title: "C", blocks: [] }] }],
  } as unknown as PrWalkthrough;
  assert.deepEqual(staleChapters(unbuilt, new Map() as never), [], "it cannot be judged, and saying so is not crashing");
});
