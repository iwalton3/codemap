import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
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
    // No `git config user.email` here on purpose: `ensureSidecar` configures the
    // sidecar's own identity, and setting it in the harness masked R1 for years.
    await ensureSidecar(r, who);
    git(r, "remote", "add", "origin", origin);
  }
  return { origin, a, b, cleanup: () => [origin, a, b].forEach((r) => rmSync(r, { recursive: true, force: true })) };
}

/** Every file the team's remote actually holds. */
const onRemote = (origin: string): string[] =>
  spawnSync("git", ["ls-tree", "-r", "--name-only", "main"], { cwd: origin, encoding: "utf8" })
    .stdout.split("\n").map((l) => l.trim()).filter(Boolean);

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

// --- R1: a sync that loses a finding is worse than no sync at all ----------------

test("a sidecar configures its own committer identity and signs nothing", async () => {
  // Half of R1 at the source. A sidecar is a machine artifact, so it must not
  // inherit a global `commit.gpgsign=true` whose key git cannot use — that made
  // every commit fail while sync went on reporting success.
  const root = tmp("ident");
  try {
    await ensureSidecar(root, izzie);
    // `--local` specifically: reading the effective value would pass on an inherited
    // global and prove nothing about what this code wrote.
    const local = (k: string) => git(root, "config", "--local", "--get", k).stdout.trim();
    assert.equal(local("commit.gpgsign"), "false", "signing is off in the sidecar's own config");
    assert.equal(local("user.email"), izzie.principal, "and it commits as the person who owns it");
    assert.ok(local("user.name"), "with a name, which git also demands");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a commit that cannot succeed fails the sync instead of reporting a push", async () => {
  // R1, reproduced. When the commit fails the shards stay staged, the merge still
  // succeeds, and `git push HEAD:branch` pushes a tip the remote already has — which
  // exits 0. So sync returned `pushed: true` and the finding never left the machine,
  // and every later sync repeated it.
  //
  // A failing pre-commit hook stands in for the original trigger (an unusable signing
  // key) because `ensureSidecar` now repairs the signing config on every sync — which
  // is the source fix working, and would quietly undo the sabotage.
  const t = await team();
  try {
    const hooks = join(t.a, "..", "hooks-" + process.pid);
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(hooks, "pre-commit"), 0o755);
    git(t.a, "config", "core.hooksPath", hooks);

    await createFinding(t.a, "pr-1", izzie, NEW);
    const r = await sync(t.a, izzie) as { error?: string; pushed?: boolean };

    assert.ok(r.error, "sync reports the failure");
    assert.match(r.error!, /commit failed/i);
    assert.notEqual(r.pushed, true, "and never claims to have pushed");
    assert.deepEqual(onRemote(t.origin), [], "nothing reached the remote, which is the point");

    // CONTROL — the same finding, the same sync, with the commit working. Without
    // this the test above passes just as well against a sync that always fails.
    git(t.a, "config", "--unset", "core.hooksPath");
    const ok = await sync(t.a, izzie) as { error?: string; pushed?: boolean; committed?: boolean };
    assert.equal(ok.error, undefined, "the control sync succeeds");
    assert.equal(ok.pushed, true);
    assert.equal(ok.committed, true, "and says it had something of its own to send");
    assert.ok(onRemote(t.origin).some((f) => f.startsWith("findings/pr-1/")), "the finding is on the remote now");

    rmSync(hooks, { recursive: true, force: true });
  } finally { t.cleanup(); }
});

test("a sync with nothing of its own to send says so rather than claiming a push", async () => {
  // The obvious phrasing of the R1 fix — "a no-op push must not report as pushed" —
  // is wrong, and this pins the distinction. `pushed` asserts the remote holds our
  // commits, which is honestly true here; `committed` is what says whether this sync
  // had anything of its own. Conflating them would trade a lie for a false alarm.
  const t = await team();
  try {
    const first = await sync(t.a, izzie) as { committed?: boolean };
    const again = await sync(t.a, izzie) as { error?: string; pushed?: boolean; committed?: boolean };
    assert.equal(again.error, undefined);
    assert.equal(again.pushed, true, "the remote does contain our commits");
    assert.equal(again.committed, false, "but this sync committed nothing");
    assert.ok(first !== undefined);
  } finally { t.cleanup(); }
});

// --- G3: once state is pushed, nothing deletes it -------------------------------

test("a shard deleted on one clone is restored, not propagated", async () => {
  // The one live hole in "nothing is deleted once pushed": shards are append-only by
  // convention and nothing enforced it, so `git rm` on any clone travelled to every
  // teammate as a clean, silent merge.
  const t = await team();
  try {
    await createFinding(t.a, "pr-1", izzie, NEW);
    await sync(t.a, izzie);
    await sync(t.b, dana);           // dana now holds izzie's finding
    const shard = onRemote(t.origin).find((f) => f.startsWith("findings/pr-1/"))!;
    assert.ok(shard, "the finding is on the remote to begin with");

    // Somebody rewrites history the one way append-only cannot survive. Sync first,
    // so the deletion pushes as a fast-forward rather than being rejected.
    await sync(t.a, izzie);
    git(t.a, "rm", "-q", shard);
    git(t.a, "commit", "-q", "-m", "drop a shard");
    git(t.a, "push", "-q", "origin", "HEAD:main");
    assert.equal(onRemote(t.origin).includes(shard), false, "the deletion really is on the remote");

    const r = await sync(t.b, dana) as { error?: string; restored?: { path: string; events: number }[] };
    assert.equal(r.error, undefined, "the pull still succeeds — refusing would wedge it forever");
    assert.equal(r.restored?.length, 1, "and it reports what it put back");
    assert.equal(r.restored![0]!.path, shard);
    assert.ok(r.restored![0]!.events >= 1);

    assert.equal((await readFindings(t.b, "pr-1")).size, 1, "dana still has the finding");
    assert.ok(onRemote(t.origin).includes(shard), "and the restore reached the team");
  } finally { t.cleanup(); }
});

test("an ordinary pull restores nothing", async () => {
  // CONTROL. Without it, an audit that flagged every merge — or one that restored
  // unconditionally — would pass the test above just as well.
  const t = await team();
  try {
    await createFinding(t.a, "pr-1", izzie, NEW);
    await sync(t.a, izzie);
    const r = await sync(t.b, dana) as { error?: string; restored?: unknown; gained: number };
    assert.equal(r.error, undefined);
    assert.equal(r.restored, undefined, "a normal pull is not an erasure");
    assert.ok(r.gained > 0, "and it did actually gain the events, so the path ran");
  } finally { t.cleanup(); }
});

test("an event added and deleted before we ever fetch is still recovered", async () => {
  // The endpoint-diff version of this audit missed exactly this: dana never holds the
  // event, so it is absent from her pre-merge tip AND from the merged tip, the diff is
  // empty, and the loss is invisible. Only scanning the incoming history sees it.
  // Verified against git: `diff --numstat base..HEAD` prints nothing for add-then-delete.
  const t = await team();
  try {
    await createFinding(t.a, "pr-1", izzie, NEW);
    await sync(t.a, izzie);
    const shard = onRemote(t.origin).find((f) => f.startsWith("findings/pr-1/"))!;
    git(t.a, "rm", "-q", shard);
    git(t.a, "commit", "-q", "-m", "drop a shard");
    git(t.a, "push", "-q", "origin", "HEAD:main");

    // dana's FIRST ever sync — she fetches the add and the delete in one go.
    const r = await sync(t.b, dana) as { error?: string; restored?: { path: string; events: number }[] };
    assert.equal(r.error, undefined);
    assert.equal(r.restored?.length, 1, "the deletion is seen even though both ends lack the event");
    assert.equal((await readFindings(t.b, "pr-1")).size, 1, "and dana ends up with the finding");
  } finally { t.cleanup(); }
});

test("a shard that loses one line keeps its other lines, and gains the new one", async () => {
  // Partial deletion, which a whole-file repair would pass by restoring the pre-merge
  // file wholesale — and would then discard whatever was appended alongside.
  const t = await team();
  try {
    await createFinding(t.a, "pr-1", izzie, NEW);
    await createFinding(t.a, "pr-1", izzie, { ...NEW, targetId: "a_2" });
    await sync(t.a, izzie);
    await sync(t.b, dana);
    await sync(t.a, izzie);   // dana's sync moved the remote; catch up so the push lands
    const shard = onRemote(t.origin).find((f) => f.startsWith("findings/pr-1/"))!;

    // Drop one event and append another, in the same shard, in one commit.
    const path = join(t.a, shard);
    const kept = readFileSync(path, "utf8").split("\n").filter(Boolean);
    assert.ok(kept.length >= 2, "two events to work with");
    writeFileSync(path, kept.slice(1).join("\n") + "\n", "utf8");
    git(t.a, "commit", "-qam", "drop one line");
    git(t.a, "push", "-q", "origin", "HEAD:main");

    const r = await sync(t.b, dana) as { error?: string; restored?: { events: number }[] };
    assert.equal(r.error, undefined);
    assert.equal(r.restored?.length, 1);
    assert.equal(r.restored![0]!.events, 1, "exactly the one line that went missing");

    const lines = readFileSync(join(t.b, shard), "utf8").split("\n").filter(Boolean);
    assert.equal(new Set(lines).size, kept.length, "every event is back, exactly once");
    assert.equal((await readFindings(t.b, "pr-1")).size, 2, "and both findings resolve");
  } finally { t.cleanup(); }
});

test("a merge that adds to a shard is not mistaken for an erasure", async () => {
  // CONTROL. Two people appending concurrently must not look like a deletion — an
  // audit comparing totals rather than per-shard content would fire here.
  const t = await team();
  try {
    await createFinding(t.a, "pr-1", izzie, NEW);
    await createFinding(t.b, "pr-1", dana, { ...NEW, targetId: "a_2" });
    await sync(t.a, izzie);
    const r = await sync(t.b, dana) as { error?: string; restored?: unknown };
    assert.equal(r.error, undefined);
    assert.equal(r.restored, undefined, "concurrent appends are not deletions");
    assert.equal((await readFindings(t.b, "pr-1")).size, 2, "and both findings survive");
  } finally { t.cleanup(); }
});

test("push refuses when the remote already holds a peer this build cannot read", async () => {
  // `pull` gates the merge and covers the sync path, since sync pulls first. This
  // covers `push` on its own, which is exported and reachable without a pull.
  const t = await team();
  try {
    const m = currentManifest("kai@x.com");
    writeFileSync(
      join(t.b, MANIFEST_DIR, principalKey("kai@x.com") + ".json"),
      JSON.stringify({ ...m, anchorScheme: m.anchorScheme + 1 }), "utf8",
    );
    await sync(t.b, dana);          // kai's manifest is now on the remote

    await createFinding(t.a, "pr-1", izzie, NEW);
    git(t.a, "fetch", "-q", "origin");   // the gate reads the tracking ref, not the tree
    const r = await push(t.a, "m", { actor: izzie }) as { error?: string };
    assert.ok(r.error, "must refuse");
    assert.match(r.error!, /ANCHOR_SCHEME/);
  } finally { t.cleanup(); }
});

test("push into a remote it agrees with is not gated", async () => {
  // CONTROL. Without it the test above passes against a gate that refuses every push,
  // and against one that fires on our OWN tree — which would wedge the whole team the
  // moment a single teammate upgraded.
  const t = await team();
  try {
    await sync(t.b, dana);
    await createFinding(t.a, "pr-1", izzie, NEW);
    git(t.a, "fetch", "-q", "origin");
    const r = await push(t.a, "m", { actor: izzie }) as { error?: string; pushed?: boolean };
    assert.equal(r.error, undefined, "an agreeing peer pushes normally");
    assert.equal(r.pushed, true);
    assert.ok(onRemote(t.origin).some((f) => f.startsWith("findings/pr-1/")));
  } finally { t.cleanup(); }
});

test("your own newer machine gates this one, but your own older machine does not", async () => {
  // One person on two machines writes ONE manifest file from both, and skipping "my
  // own entry" outright left that supported case ungated on the pull AND the push:
  // the stale machine merged the newer log and could publish old-scheme events into
  // it. The direction is what decides it.
  const mine = currentManifest("izzie@x.com");

  const ahead = checkManifest({ ...mine, anchorScheme: mine.anchorScheme + 1 }, mine);
  assert.ok(ahead?.fatal, "a newer copy of my own manifest stops this machine");
  assert.match(ahead!.message, /ANCHOR_SCHEME/);

  // CONTROLS. Without these the rule reads as "never trust your own manifest", which
  // would refuse the upgrade path — the normal way a machine writes over its own
  // older claim — and would fire on every ordinary sync.
  assert.equal(checkManifest({ ...mine, anchorScheme: mine.anchorScheme - 1 }, mine), null,
    "an older copy is this machine upgrading over its own claim");
  assert.equal(checkManifest({ ...mine }, mine), null, "and an identical one says nothing");
});
