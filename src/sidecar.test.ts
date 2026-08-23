import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Actor } from "./schema.js";
import { ensureSidecar, pull, push, sync, checkManifest, checkPeers, countEvents, currentManifest, readManifests, withSidecarLock, MANIFEST_DIR, ATTRIBUTES } from "./sidecar.js";
import { createFinding, corroborate, comment, readFindings, needsHumanAck } from "./shared-findings.js";
import { publishWalkthrough, readWalkthroughs } from "./shared-walkthrough.js";
import { principalKey } from "./eventlog.js";

const izzie: Actor = { principal: "izzie@x.com" };
const dana: Actor = { principal: "dana@x.com" };

const git = (root: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8" });

const tmp = (tag: string) => mkdtempSync(join(tmpdir(), `codemap-${tag}-`));

/** A bare repo standing in for the team's remote, plus two people's clones. */
async function team() {
  const origin = tmp("origin");
  git(origin, "init", "-q", "--bare", "-b", "main");
  const a = tmp("a"), b = tmp("b");
  for (const [r, who] of [[a, izzie], [b, dana]] as const) {
    await ensureSidecar(r, who);
    git(r, "config", "user.email", "t@t");
    git(r, "config", "user.name", "t");
    git(r, "remote", "add", "origin", origin);
  }
  return { origin, a, b, cleanup: () => [origin, a, b].forEach((r) => rmSync(r, { recursive: true, force: true })) };
}

const NEW = { targetKind: "anchor" as const, targetId: "a_1", text: "evidence", comment: "the ask" };

// --- setup ----------------------------------------------------------------------

test("a sidecar is a git repo with the union driver and the writer's manifest", async () => {
  const root = tmp("solo");
  try {
    const r = await ensureSidecar(root, izzie);
    assert.ok(!("error" in r) && r.created);
    assert.ok(existsSync(join(root, ".git")));
    assert.match(readFileSync(join(root, ATTRIBUTES), "utf8"), /\*\.ndjson merge=union/);
    const ms = await readManifests(root);
    assert.equal(ms.length, 1);
    assert.equal(ms[0]!.principal, "izzie@x.com");
    assert.equal(ms[0]!.anchorScheme, currentManifest("x").anchorScheme);
    assert.ok(!("error" in (await ensureSidecar(root, izzie))), "idempotent");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("with no remote, everything still works — the design is offline-first", async () => {
  const root = tmp("offline");
  try {
    await ensureSidecar(root, izzie);
    git(root, "config", "user.email", "t@t"); git(root, "config", "user.name", "t");
    await createFinding(root, 264, izzie, NEW);
    const r = await sync(root, izzie);
    assert.ok(!("error" in r), JSON.stringify(r));
    assert.equal((await readFindings(root, 264)).size, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- the property the whole design rests on --------------------------------------

test("two people working independently converge on the same state", async () => {
  const t = await team();
  try {
    const fa = await createFinding(t.a, 264, izzie, { ...NEW, text: "izzie's finding" });
    await sync(t.a, izzie);

    const fb = await createFinding(t.b, 264, dana, { ...NEW, targetId: "a_2", text: "dana's finding" });
    const rb = await sync(t.b, dana);
    assert.ok(!("error" in rb), JSON.stringify(rb));

    await sync(t.a, izzie); // izzie picks up dana's

    const A = await readFindings(t.a, 264);
    const B = await readFindings(t.b, 264);
    assert.equal(A.size, 2, "both findings on both sides");
    assert.equal(B.size, 2);
    assert.deepEqual([...A.keys()].sort(), [fa, fb].sort());
    assert.deepEqual([...A.keys()].sort(), [...B.keys()].sort());
  } finally { t.cleanup(); }
});

test("a push rejected by someone else's push retries and succeeds", async () => {
  const t = await team();
  try {
    await createFinding(t.a, 264, izzie, NEW);
    await sync(t.a, izzie);
    // b never pulled, so its push is a non-fast-forward until the retry pulls.
    await createFinding(t.b, 264, dana, { ...NEW, targetId: "a_2" });
    git(t.b, "add", "-A"); git(t.b, "commit", "-q", "-m", "b's work");
    const r = await push(t.b, "retry me") as { pushed: boolean; retries: number };
    assert.ok(r.pushed, "the retry loop is what makes a one-button sync honest");
    assert.ok(r.retries >= 1, `expected at least one retry, got ${r.retries}`);
    assert.equal((await readFindings(t.b, 264)).size, 2, "and it gained the other side's work");
  } finally { t.cleanup(); }
});

test("one person on two machines — the case sharding does not cover — merges by union", async () => {
  const t = await team();
  try {
    // Same principal, so both write the SAME shard file. Only merge=union saves this.
    const f1 = await createFinding(t.a, 264, izzie, { ...NEW, text: "from the laptop" });
    await sync(t.a, izzie);
    const f2 = await createFinding(t.b, 264, izzie, { ...NEW, targetId: "a_2", text: "from the desktop" });
    await sync(t.b, dana);
    await sync(t.a, izzie);
    const A = await readFindings(t.a, 264);
    assert.equal(A.size, 2, "neither machine's work was lost");
    assert.deepEqual([...A.keys()].sort(), [f1, f2].sort());
  } finally { t.cleanup(); }
});

test("a full review conversation survives the round trip", async () => {
  const t = await team();
  try {
    const id = await createFinding(t.a, 264, izzie, NEW);
    await sync(t.a, izzie);
    await sync(t.b, dana);

    await corroborate(t.b, 264, dana, id, "confirm", "reproduced on staging");
    await comment(t.b, 264, dana, id, "is this reachable from the webhook?");
    await sync(t.b, dana);
    await sync(t.a, izzie);

    const f = (await readFindings(t.a, 264)).get(id)!;
    assert.equal(f.corroboration.length, 1);
    assert.equal(f.corroboration[0]!.actor.principal, "dana@x.com");
    assert.equal(f.corroboration[0]!.independent, true, "a different person is a real second opinion");
    assert.equal(f.thread.length, 1);
    assert.equal(needsHumanAck(f), true, "a confirmation puts it in izzie's queue");
  } finally { t.cleanup(); }
});

test("walkthroughs ride the same loop", async () => {
  const t = await team();
  try {
    await publishWalkthrough(t.a, izzie, {
      pr: 264, head: "headsha", at: "t", by: "izzie",
      features: [{ id: "f1", title: "Payments seam", summary: "s", chapters: [] }],
    });
    await sync(t.a, izzie);
    await sync(t.b, dana);
    const all = await readWalkthroughs(t.b, 264);
    assert.equal(all.length, 1);
    assert.equal(all[0]!.walkthrough.features[0]!.title, "Payments seam");
  } finally { t.cleanup(); }
});

test("a sync gained-count reports what actually arrived", async () => {
  const t = await team();
  try {
    await createFinding(t.a, 264, izzie, NEW);
    await corroborate(t.a, 264, izzie, "f_x", "confirm", "n/a"); // event about an unknown id, still an event
    await sync(t.a, izzie);
    const r = await sync(t.b, dana) as { gained: number };
    assert.equal(r.gained, 2);
  } finally { t.cleanup(); }
});

// --- the compatibility contract ---------------------------------------------------

test("a different ANCHOR_SCHEME is fatal — every finding would mis-target", () => {
  const mine = currentManifest("izzie@x.com");
  const theirs = { ...mine, principal: "dana@x.com", anchorScheme: mine.anchorScheme + 1 };
  const r = checkManifest(theirs, mine)!;
  assert.equal(r.fatal, true);
  assert.match(r.message, /ANCHOR_SCHEME/);
  assert.match(r.message, /do not exist here/);
});

test("a different HASH_SCHEME warns rather than refusing", () => {
  // Refusing would lock the team out mid-rollout for a case the unverifiable-witness
  // machinery already handles gracefully. That machinery exists for exactly this.
  const mine = currentManifest("izzie@x.com");
  const r = checkManifest({ ...mine, principal: "dana@x.com", hashScheme: mine.hashScheme + 1 }, mine)!;
  assert.equal(r.fatal, false);
  assert.match(r.message, /unverifiable/);
});

test("a different grammar version warns — bodies hash differently", () => {
  const mine = currentManifest("izzie@x.com");
  const theirs = { ...mine, principal: "dana@x.com", grammars: { ...mine.grammars, c_sharp: "0.0.1" } };
  const r = checkManifest(theirs, mine)!;
  assert.equal(r.fatal, false);
  assert.match(r.message, /c_sharp/);
});

test("matching manifests are silent, and my own entry is never a mismatch", () => {
  const mine = currentManifest("izzie@x.com");
  assert.equal(checkManifest({ ...mine, principal: "dana@x.com" }, mine), null, "same schemes, different person");
  assert.equal(checkManifest(mine, mine), null, "my own entry is skipped");
  assert.equal(checkPeers([], mine), null, "an empty team says nothing");
});

test("a fatal manifest mismatch stops the pull", async () => {
  const t = await team();
  try {
    await createFinding(t.a, 264, izzie, NEW);
    // A THIRD teammate is on a newer codemap. Written into a's tree rather than
    // tampering with izzie's own file, because `ensureSidecar` rewrites the caller's
    // manifest on every sync — correctly, since it states what THIS codemap writes.
    const m = currentManifest("kai@x.com");
    writeFileSync(
      join(t.a, MANIFEST_DIR, principalKey("kai@x.com") + ".json"),
      JSON.stringify({ ...m, anchorScheme: m.anchorScheme + 1 }), "utf8",
    );
    await sync(t.a, izzie);
    // Checked against the FETCHED ref, so dana refuses before merging anything.
    const r = await pull(t.b, dana) as { error: string };
    assert.ok(r.error, "must refuse");
    assert.match(r.error, /ANCHOR_SCHEME/);
    assert.equal((await readFindings(t.b, 264)).size, 0, "and nothing was merged in");
  } finally { t.cleanup(); }
});

test("countEvents counts event lines and ignores everything else", async () => {
  const root = tmp("count");
  try {
    await ensureSidecar(root, izzie);
    assert.equal(await countEvents(root), 0, "the manifest and attributes are not events");
    git(root, "config", "user.email", "t@t"); git(root, "config", "user.name", "t");
    await createFinding(root, 264, izzie, NEW);
    assert.equal(await countEvents(root), 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- one machine, one sidecar, one writer at a time ------------------------------

/**
 * `sync` is `git add -A` + commit + fetch + merge + push against a working tree.
 * Two of those at once in one repository is index.lock contention at best; nothing
 * serialized them before (the HTTP path takes no lock, MCP locks the universe
 * rather than the sidecar, the CLI takes none).
 */
test("two holders of one sidecar's lock do not overlap", async () => {
  const t = await team();
  try {
    let running = 0, overlapped = false;
    const hold = () => withSidecarLock(t.a, async () => {
      running++;
      if (running > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 40));
      running--;
    });
    await Promise.all([hold(), hold()]);
    assert.equal(overlapped, false, "the second waited");
  } finally { t.cleanup(); }
});

test("`sync` takes that lock, so it waits for whoever is holding it", async () => {
  // NOT reentrant, deliberately: `sync` is a whole transaction and takes the lock
  // itself, so a caller must not wrap it. Wrapping it deadlocks for the full 30s
  // timeout — which is how this test was written the first time.
  const t = await team();
  try {
    await createFinding(t.a, "pr-1", izzie, { targetKind: "anchor", targetId: "a_1", text: "e", comment: "c" });
    let release = () => {};
    const held = new Promise<void>((r) => { release = r; });
    const holder = withSidecarLock(t.a, () => held);
    await new Promise((r) => setTimeout(r, 30));

    let done = false;
    const syncing = sync(t.a, izzie).then((r) => { done = true; return r; });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(done, false, "sync is waiting on the lock somebody else holds");

    release();
    await holder;
    const r = await syncing as { error?: string };
    assert.equal(r.error, undefined, "…and goes through once it is free");
  } finally { t.cleanup(); }
});

test("the lock is not inside the sidecar, so a sync cannot ship it to the team", async () => {
  // `commitLocal` is `git add -A`, and it skips only when `git status` is empty —
  // so a lock file anywhere under the sidecar would be committed AND would be
  // enough on its own to produce a commit containing nothing else.
  const t = await team();
  try {
    await createFinding(t.a, "pr-1", izzie, { targetKind: "anchor", targetId: "a_1", text: "e", comment: "c" });
    let sawInside: string[] = [];
    await withSidecarLock(t.a, async () => {
      // While the lock is HELD, nothing untracked may have appeared in the repo.
      sawInside = git(t.a, "status", "--porcelain", "--untracked-files=all").stdout
        .split("\n").filter((l) => l.includes(".lock"));
    });
    assert.deepEqual(sawInside, [], "no lock file inside the sidecar while the lock is held");
    await sync(t.a, izzie);
    const tracked = git(t.a, "ls-files").stdout.split("\n").filter((l) => l.includes(".lock"));
    assert.deepEqual(tracked, [], "and none committed");
  } finally { t.cleanup(); }
});

test("two different sidecars do not block each other", async () => {
  // The control: a lock keyed on the wrong thing — or on nothing — would serialize
  // unrelated repositories and this would still pass the two tests above.
  const t = await team();
  const other = tmp("other");
  try {
    let running = 0, both = false;
    const hold = (root: string) => withSidecarLock(root, async () => {
      running++;
      await new Promise((r) => setTimeout(r, 60));
      if (running > 1) both = true;
      running--;
    });
    await Promise.all([hold(t.a), hold(other)]);
    assert.equal(both, true, "they overlapped — the lock is per sidecar, not global");
  } finally { t.cleanup(); rmSync(other, { recursive: true, force: true }); }
});
