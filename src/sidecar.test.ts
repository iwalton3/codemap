import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { Actor } from "./schema.js";
import { ensureSidecar, pull, sync, checkManifest, checkPeers, countEvents, currentManifest, readManifests, withSidecarLock, MANIFEST_DIR } from "./sidecar.js";
import { createFinding, corroborate, comment, readFindings, needsHumanAck } from "./shared-findings.js";
import { publishWalkthrough, readWalkthroughs } from "./shared-walkthrough.js";
import { principalKey } from "./eventlog.js";
import { discard } from "./test-tmp.js";
import { begin, syncSession } from "./sync-engine.js";

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
  return { origin, a, b, cleanup: () => [origin, a, b].forEach((r) => discard(r)) };
}

/** Every file the team's remote actually holds. */
const onRemote = (origin: string): string[] =>
  spawnSync("git", ["ls-tree", "-r", "--name-only", "main"], { cwd: origin, encoding: "utf8" })
    .stdout.split("\n").map((l) => l.trim()).filter(Boolean);

const NEW = { targetKind: "anchor" as const, targetId: "a_1", text: "evidence", comment: "the ask" };

// --- setup ----------------------------------------------------------------------

test("a sidecar is a git repo, plus the writer's manifest", async () => {
  const root = tmp("solo");
  try {
    const r = await ensureSidecar(root, izzie);
    assert.ok(!("error" in r) && r.created);
    assert.ok(existsSync(join(root, ".git")));
    const ms = await readManifests(root);
    assert.equal(ms.length, 1);
    assert.equal(ms[0]!.principal, "izzie@x.com");
    assert.equal(ms[0]!.anchorScheme, currentManifest("x").anchorScheme);
    assert.ok(!("error" in (await ensureSidecar(root, izzie))), "idempotent");
  } finally { discard(root); }
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
  } finally { discard(root); }
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

test("a push that loses the race is replayed on the winner's tip, and lands", async () => {
  const t = await team();
  const c = tmp("c");
  try {
    await createFinding(t.a, 264, izzie, NEW);
    await sync(t.b, dana);
    // Someone else's commit, ready to land the instant b's push starts: a plain clone
    // appends one well-formed event line and commits it.
    git(c, "clone", "-q", t.origin, ".");
    const shard = onRemote(t.origin).find((f) => f.startsWith("findings/264/"))!;
    const line = JSON.parse(readFileSync(join(c, shard), "utf8").trim().split("\n")[0]!);
    writeFileSync(join(c, shard), readFileSync(join(c, shard), "utf8")
      + JSON.stringify({ ...line, id: "0zzzzzzzzz-racer", kind: "finding.commented", data: { body: "the winner" }, seq: 999 }) + "\n");
    git(c, "commit", "-qam", "the winner");
    const mark = join(c, "raced");
    writeFileSync(join(t.b, ".git", "hooks", "pre-push"),
      `#!/bin/sh\n[ -f '${mark}' ] && exit 0\ntouch '${mark}'\ngit -C '${c}' push -q origin HEAD:main\n`);
    chmodSync(join(t.b, ".git", "hooks", "pre-push"), 0o755);

    begin(t.b);
    await createFinding(t.b, 264, dana, { ...NEW, targetId: "a_2" });
    const r = await syncSession(t.b, dana);
    assert.ok(!("error" in r), JSON.stringify(r));
    assert.ok(existsSync(mark), "precondition: the winner really did push first");
    assert.ok(r.retries >= 1, `expected the lost race to be retried, got ${r.retries}`);
    assert.ok(r.pushed);
    const events = readFileSync(join(t.b, shard), "utf8").trim().split("\n").map((l) => JSON.parse(l).id as string);
    assert.ok(events.indexOf("0zzzzzzzzz-racer") >= 0, "the winner's event is on the tip");
    assert.equal((await readFindings(t.b, 264)).size, 2, "and b's own landed after it");
  } finally { t.cleanup(); discard(c); }
});

test("a fetch that meets another process's ref lock waits for it, and is not an unreachable remote", async () => {
  // Two codemap processes share a clone (the web server and an MCP session), and two fetches
  // at once collide on git's ref lock. The loser read as "could not reach the sidecar remote".
  const t = await team();
  try {
    await createFinding(t.a, 264, izzie, NEW);
    await sync(t.a, izzie);
    await sync(t.b, dana);
    await createFinding(t.a, 265, izzie, NEW);
    await sync(t.a, izzie);
    const lock = join(t.b, ".git", "refs", "remotes", "origin", "main.lock");
    writeFileSync(lock, "");
    // Node, not sh: windows-latest has no sh on PATH.
    spawn(process.execPath, ["-e", `setTimeout(() => require("fs").rmSync(${JSON.stringify(lock)}, { force: true }), 300)`], { stdio: "ignore" });
    const r = await sync(t.b, dana);
    assert.ok(!("error" in r), JSON.stringify(r));
    assert.equal(r.gained, 1, "and the pull it was part of arrived");
  } finally { t.cleanup(); }
});

test("a document that is not an event survives the reset a lost race causes", async () => {
  // A provisional audit is a file in the tree that the next sync commits. The retry after a
  // lost race resets to the winner's tip, which deleted the file the first attempt committed:
  // `publishProvisionalAudit` had answered `published: true` and nothing ever arrived.
  const t = await team();
  const c = tmp("c");
  try {
    await createFinding(t.a, 264, izzie, NEW);
    await sync(t.b, dana);
    git(c, "clone", "-q", t.origin, ".");
    writeFileSync(join(c, "winner.txt"), "the winner\n");
    git(c, "add", "-A"); git(c, "commit", "-qm", "the winner");
    const mark = join(c, "raced");
    writeFileSync(join(t.b, ".git", "hooks", "pre-push"),
      `#!/bin/sh\n[ -f '${mark}' ] && exit 0\ntouch '${mark}'\ngit -C '${c}' push -q origin HEAD:main\n`);
    chmodSync(join(t.b, ".git", "hooks", "pre-push"), 0o755);

    const doc = "provisional/u/" + "0".repeat(40) + "/audit_1.json";
    mkdirSync(join(t.b, doc, ".."), { recursive: true });
    writeFileSync(join(t.b, doc), "{\"id\":\"audit_1\"}\n");
    const r = await sync(t.b, dana);
    assert.ok(!("error" in r), JSON.stringify(r));
    assert.ok(existsSync(mark) && r.retries >= 1, "precondition: the first push lost the race");
    assert.ok(!r.joined, "a lost race diverges from the tip; it is not a join of unrelated history");
    assert.ok(onRemote(t.origin).includes("winner.txt"), "the winner's commit is on the tip");
    assert.ok(onRemote(t.origin).includes(doc), "and so is the document");
  } finally { t.cleanup(); discard(c); }
});

// "a shared writer id fails the sync closed" lived here. Nothing merges any more, so a
// shared writer id is one chain in push order; `oracle-cloned-machine.test.ts` proves it harmless.

test("one person on two machines is two shards, and nothing conflicts", async () => {
  // CONTROL: one person's two clones are two sessions on one log, and both land.
  const t = await team();
  try {
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
    const id = await createFinding(t.a, 264, izzie, NEW);
    await corroborate(t.a, 264, izzie, id, "confirm", "n/a");
    await sync(t.a, izzie);
    const r = await sync(t.b, dana) as { gained: number };
    // The two acts, and the materializer version izzie's first sync logged (materializer-log.ts).
    assert.equal(r.gained, 3);
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
  } finally { discard(root); }
});

// --- one machine, one sidecar, one writer at a time ------------------------------

/**
 * `sync` is fetch + reset + replay + commit + push against a working tree.
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
  } finally { t.cleanup(); discard(other); }
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
  } finally { discard(root); }
});

test("a commit that cannot succeed fails the sync instead of reporting a push", async () => {
  // R1, reproduced. When the commit fails the shards stay staged, and
  // `git push HEAD:branch` pushes a tip the remote already has — which exits 0. So sync returned `pushed: true` and the finding never left the machine,
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

    // The write syncs inline, so the failing commit fails the WRITE, and its caller is told.
    await assert.rejects(createFinding(t.a, "pr-1", izzie, NEW), /commit failed/i);
    assert.deepEqual(onRemote(t.origin), [], "nothing reached the remote, which is the point");

    // CONTROL — the same finding, with the commit working. Without this the test above
    // passes just as well against a write that always fails.
    git(t.a, "config", "--unset", "core.hooksPath");
    await createFinding(t.a, "pr-1", izzie, NEW);
    assert.ok(onRemote(t.origin).some((f) => f.startsWith("findings/pr-1/")), "the finding is on the remote now");

    discard(hooks);
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

// --- G3 lived here: a pull restored events another clone's history had erased. A linear pull
// takes the tip as it is, and a deletion pushed with raw git is tampering, which the owner ruled
// out of scope (docs/PROPOSAL-online-only-sync.md). A clone's OWN unsynced or hand-edited
// events are what a sync must not destroy; `sync-engine.test.ts` covers that.

test("a sync refuses when the remote already holds a peer this build cannot read", async () => {
  const t = await team();
  try {
    const m = currentManifest("kai@x.com");
    writeFileSync(
      join(t.b, MANIFEST_DIR, principalKey("kai@x.com") + ".json"),
      JSON.stringify({ ...m, anchorScheme: m.anchorScheme + 1 }), "utf8",
    );
    await sync(t.b, dana);          // kai's manifest is now on the remote

    // Writes sync inline, so the gate meets the write itself.
    await assert.rejects(createFinding(t.a, "pr-1", izzie, NEW), /ANCHOR_SCHEME/);
    const r = await sync(t.a, izzie) as { error?: string };
    assert.ok(r.error, "and a bare sync refuses too");
    assert.match(r.error!, /ANCHOR_SCHEME/);
  } finally { t.cleanup(); }
});

test("a sync into a remote it agrees with is not gated", async () => {
  // CONTROL. Without it the test above passes against a gate that refuses every sync,
  // and against one that fires on our OWN tree — which would wedge the whole team the
  // moment a single teammate upgraded.
  const t = await team();
  try {
    await sync(t.b, dana);
    await createFinding(t.a, "pr-1", izzie, NEW);
    git(t.a, "fetch", "-q", "origin");
    const r = await sync(t.a, izzie) as { error?: string; pushed?: boolean };
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
