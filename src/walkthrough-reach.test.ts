/**
 * Which walkthrough a surface shows, out of everyone's.
 *
 * `shared-walkthrough.test.ts` covers the fold — that two people mapping one pull
 * request is two readings and not a conflict. This covers the half above it: a page
 * renders ONE structure, so something has to choose, and the failure this was written
 * for is the choice that was never made. A teammate's walkthrough travelled, folded,
 * and landed in the parallel `shared_walkthrough`, while every surface that renders one
 * read the local `meta` blob — so the reader was told "no agent has walked this one"
 * with it sitting in their own store. Both halves are rows in `walkthroughs` now, so
 * what is left here is the choosing, and the two things one table turns on: adoption of
 * your own published copy, and the legacy blob's migration.
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
import { writeLocalWalkthrough, readWalkthroughsFor } from "./store.js";
import { db } from "./db.js";
import { sharedWalkthroughs, shareWalkthrough } from "./ops-shared.js";
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
    await writeLocalWalkthrough(u.root, String(PR), wt("head1", "2026-08-21T00:00:00Z"));
    const pick = (await walkthroughFor(u.root, PR, "head1"))!;
    assert.equal(pick.sharedBy, undefined);
  } finally { u.cleanup(); }
});

test("your own copy in the log is the same reading, not a second opinion", async () => {
  const u = universe();
  try {
    const w = wt("head1", "2026-08-21T00:00:00Z");
    await writeLocalWalkthrough(u.root, String(PR), w);
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
    await writeLocalWalkthrough(u.root, String(PR), wt("head1", "2026-08-21T00:00:00Z"));
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
    await writeLocalWalkthrough(u.root, String(PR), wt("old", "2026-08-22T00:00:00Z"));
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
    await writeLocalWalkthrough(u.root, String(PR), wt("old", "2026-08-20T00:00:00Z"));
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
    await writeLocalWalkthrough(solo, String(PR), wt("head1", "2026-08-21T00:00:00Z"));
    const pick = (await walkthroughFor(solo, PR, "head1"))!;
    assert.equal(pick.walkthrough.head, "head1", "no sidecar is not an error — it is the ordinary case");
  } finally { rmSync(solo, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// One table: adoption, and the legacy blob
// ---------------------------------------------------------------------------

test("publishing your own walkthrough adopts the local row rather than adding one", async () => {
  const u = universe();
  try {
    const w = wt("head1", "2026-08-21T00:00:00Z");
    await writeLocalWalkthrough(u.root, String(PR), w);
    await publish(u, me, w);
    await sharedWalkthroughs(u.root, PR); // what a sync does: fold the scope into the table

    const rows = db(u.root).prepare("SELECT author, source_scope FROM walkthroughs WHERE pr = ?")
      .all(String(PR)) as unknown as { author: string; source_scope: string | null }[];
    // The whole point of `(pr, author)`: your published copy IS your row. Two tables
    // could not express that, which is why your own reading came back twice.
    assert.equal(rows.length, 1, "one reading, one row");
    assert.equal(rows[0]!.author, "izzie@x.com");
    assert.ok(rows[0]!.source_scope, "adopted — it carries the origin now");
  } finally { u.cleanup(); }
});

test("a legacy blob becomes rows, unattributed, and publishing is what names the author", async () => {
  const u = universe();
  try {
    // The store as an older build left it: `meta["pr_walkthrough"]`, one per PR.
    const legacy = wt("head1", "2026-08-21T00:00:00Z", "an agent");
    db(u.root).prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('pr_walkthrough', ?)")
      .run(JSON.stringify({ schemaVersion: 1, walkthroughs: { [String(PR)]: legacy } }));
    // Re-open: `db()` caches per root, so the migration runs on the next process. Drive
    // it directly rather than pretending — what is under test is the mapping.
    const { migrateWalkthroughBlobForTest } = await import("./db.js");
    migrateWalkthroughBlobForTest(u.root);

    const rows = await readWalkthroughsFor(u.root, PR);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.walkthrough.head, "head1");
    // A `PrWalkthrough`'s `by` is free text ("an agent"), not a principal. Attributing
    // every historical reading to whoever upgrades first is the failure the triage and
    // bugs migrations refuse for the same reason.
    assert.equal(rows[0]!.author, "", "unattributed, not guessed");
    assert.equal(rows[0]!.origin, undefined, "and local — migrating is not publishing");
    const left = db(u.root).prepare("SELECT COUNT(*) c FROM meta WHERE k = 'pr_walkthrough'").get() as { c: number };
    assert.equal(left.c, 0, "the blob is gone, so a second open has nothing to re-import");

    // It is still YOURS to a reader — nothing published it — even with no principal.
    assert.equal((await walkthroughFor(u.root, PR, "head1"))!.sharedBy, undefined);

    // Publishing is the act that knows who, and it stamps the row BEFORE the fold comes
    // back — otherwise the folded row cannot adopt it and your own reading appears
    // twice, once as yours and once as a stranger's.
    await shareWalkthrough(u.root, legacy);
    const after = db(u.root).prepare("SELECT author, source_scope FROM walkthroughs WHERE pr = ?")
      .all(String(PR)) as unknown as { author: string; source_scope: string | null }[];
    assert.equal(after.length, 1, "one row, not one per attribution state");
    assert.equal(after[0]!.author, "izzie@x.com");
    assert.ok(after[0]!.source_scope);
  } finally { u.cleanup(); }
});
