/**
 * Which walkthrough a surface shows, out of everyone's.
 *
 * `shared-walkthrough.test.ts` covers the fold — that two people mapping one pull
 * request is two readings and not a conflict. This covers the half above it: a page
 * renders ONE structure, so something has to choose, and the failure this was written
 * for is the choice that was never made. A teammate's walkthrough travelled, folded,
 * and landed in `shared_walkthrough`, while every surface that renders one read the
 * local blob — so the reader was told "no agent has walked this one" with it sitting
 * in their own store.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Actor } from "./schema.js";
import type { PrWalkthrough } from "./walkthrough.js";
import { publishWalkthrough } from "./shared-walkthrough.js";
import { walkthroughFor } from "./ops/shared.js";
import { writeWalkthrough } from "./store.js";
import { scopeFor, resolveSidecar } from "./sidecar-config.js";

const tmp = (t: string) => mkdtempSync(join(tmpdir(), `codemap-wr-${t}-`));

/** A universe whose identity is `izzie@x.com`, with a sidecar to publish into. */
function universe() {
  const root = tmp("repo");
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "izzie@x.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "izzie"], { cwd: root });
  mkdirSync(join(root, ".codemap"), { recursive: true });
  const side = tmp("side");
  writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
  return { root, side, cleanup: () => [root, side].forEach((r) => rmSync(r, { recursive: true, force: true })) };
}

const PR = 264;
const dana: Actor = { principal: "dana@x.com" };
const me: Actor = { principal: "izzie@x.com" };

const wt = (head: string, at: string, by = "an agent"): PrWalkthrough => ({
  pr: PR, head, at, by,
  features: [{ id: "f1", title: head, summary: "s", chapters: [{ id: "c1", title: "C", blocks: [], witnesses: [] }] }],
});

/** Publish into the sidecar under the universe-qualified scope the ops use. */
const publish = (u: { root: string; side: string }, actor: Actor, w: PrWalkthrough) =>
  publishWalkthrough(u.side, actor, w, scopeFor(resolveSidecar(u.root)!, "pr", PR));

test("a teammate's walkthrough is what the surface shows when you have none", async () => {
  const u = universe();
  try {
    await publish(u, dana, wt("head1", "2026-08-21T00:00:00Z"));
    const pick = (await walkthroughFor(u.root, PR, "head1"))!;
    assert.ok(pick, "a walkthrough exists — this is the case that used to answer null");
    assert.equal(pick.sharedBy, "dana@x.com", "attributed, so the reader knows whose reading it is");
    assert.equal(pick.walkthrough.head, "head1");
    assert.deepEqual(pick.others, []);
  } finally { u.cleanup(); }
});

test("your own reading is never labelled as somebody else's", async () => {
  const u = universe();
  try {
    await writeWalkthrough(u.root, String(PR), wt("head1", "2026-08-21T00:00:00Z"));
    const pick = (await walkthroughFor(u.root, PR, "head1"))!;
    assert.equal(pick.sharedBy, undefined);
  } finally { u.cleanup(); }
});

test("your own copy in the log is the same reading, not a second opinion", async () => {
  const u = universe();
  try {
    const w = wt("head1", "2026-08-21T00:00:00Z");
    await writeWalkthrough(u.root, String(PR), w);
    await publish(u, me, w); // what `pr_walkthrough` now does on every write
    const pick = (await walkthroughFor(u.root, PR, "head1"))!;
    assert.equal(pick.sharedBy, undefined, "still yours");
    assert.deepEqual(pick.others, [], "and not listed beside itself as another reading");
  } finally { u.cleanup(); }
});

test("yours wins over a teammate's at equal standing, and the other is named", async () => {
  const u = universe();
  try {
    // Hers is NEWER. Freshness does not displace your own reading of the same commit —
    // only a head mismatch does, because that one is about something else.
    await writeWalkthrough(u.root, String(PR), wt("head1", "2026-08-21T00:00:00Z"));
    await publish(u, dana, wt("head1", "2026-08-22T00:00:00Z"));
    const pick = (await walkthroughFor(u.root, PR, "head1"))!;
    assert.equal(pick.sharedBy, undefined, "yours");
    assert.deepEqual(pick.others, [{ by: "dana@x.com", head: "head1", mine: false }],
      "and hers is named rather than silently dropped");
  } finally { u.cleanup(); }
});

test("a teammate's reading of THIS head beats your reading of an older one", async () => {
  const u = universe();
  try {
    await writeWalkthrough(u.root, String(PR), wt("old", "2026-08-22T00:00:00Z"));
    await publish(u, dana, wt("head2", "2026-08-21T00:00:00Z"));
    const pick = (await walkthroughFor(u.root, PR, "head2"))!;
    // A walkthrough about another commit is not a worse reading, it is about something
    // else — the rule `currentWalkthrough` already enforces, applied to the choice.
    assert.equal(pick.sharedBy, "dana@x.com");
    assert.equal(pick.walkthrough.head, "head2");
    assert.deepEqual(pick.others, [{ by: "izzie@x.com", head: "old", mine: true }]);
  } finally { u.cleanup(); }
});

test("when nothing matches the head, yours is still shown — stale, as it always was", async () => {
  const u = universe();
  try {
    await writeWalkthrough(u.root, String(PR), wt("old", "2026-08-20T00:00:00Z"));
    await publish(u, dana, wt("older", "2026-08-22T00:00:00Z"));
    const pick = (await walkthroughFor(u.root, PR, "head3"))!;
    assert.equal(pick.sharedBy, undefined);
    assert.equal(pick.walkthrough.head, "old", "flagged headMoved by the caller, not hidden here");
  } finally { u.cleanup(); }
});

test("no walkthrough anywhere is still null, and a store with no sidecar still reads", async () => {
  const u = universe();
  try {
    assert.equal(await walkthroughFor(u.root, PR, "head1"), null);
  } finally { u.cleanup(); }

  const solo = tmp("solo");
  try {
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: solo });
    mkdirSync(join(solo, ".codemap"), { recursive: true });
    await writeWalkthrough(solo, String(PR), wt("head1", "2026-08-21T00:00:00Z"));
    const pick = (await walkthroughFor(solo, PR, "head1"))!;
    assert.equal(pick.walkthrough.head, "head1", "no sidecar is not an error — it is the ordinary case");
  } finally { rmSync(solo, { recursive: true, force: true }); }
});
