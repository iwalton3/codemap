/**
 * The hard cutover (plan 7.2, 7.2b): the migration writes a tripwire that builds from before the
 * linear log refuse, and this build exempts exactly it; a sidecar still holding per-writer shards
 * is neither synced nor folded by this build — migrate it first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { discard } from "./test-tmp.js";
import { join } from "node:path";
import { scenario, who } from "./scenario.js";
import { readScopeChecked, splitShard, SENTINEL_MANIFEST_BYTES, SENTINEL_MANIFEST_PATH, TRIPWIRE_BYTES, TRIPWIRE_PATH } from "./eventlog.js";
import { readManifests, sync } from "./sidecar.js";
import { readCached } from "./materialize.js";
import { findingScope, foldFindings, createFinding } from "./shared-findings.js";
import { findingsProjection } from "./shared-projections.js";
import { lockoutOf } from "./lockout.js";
import { scanForDamage } from "./damage-scan.js";
import { spawnSync } from "node:child_process";
import { testEvent } from "./test-events.js";

const PR = "acme/api/pr-3";
const stores: string[] = [];

test("a sidecar still holding per-writer shards: sync refuses and a read does not fold it", async () => {
  const s = await scenario(["ana@x.com"]);
  try {
    const ana = who(s, "ana@x.com");
    await createFinding(ana.sidecar, PR, ana.actor, { targetKind: "anchor", targetId: "a_1", text: "linear" });
    const store = mkdtempSync(join(tmpdir(), "codemap-cutover-store-"));
    stores.push(store);
    // A per-writer shard, as a build before the linear log writes one.
    writeFileSync(join(ana.sidecar, findingScope(PR), "w_0123456789abcdef.ndjson"),
      JSON.stringify(testEvent({ id: "0000000001-old", kind: "finding.created", subject: "f_old", data: { targetKind: "anchor", targetId: "a_2", text: "old" } })) + "\n");
    const r = await sync(ana.sidecar, ana.actor);
    assert.ok("error" in r && /never reached the team's sidecar before it was migrated \(first: \S+ 0000000001-old\)/.test(r.error), JSON.stringify(r));
    assert.ok(existsSync(join(ana.sidecar, findingScope(PR), "w_0123456789abcdef.ndjson")), "the old shard is left where it was");
    const read = await readCached(store, ana.sidecar, findingScope(PR), "id2", foldFindings, findingsProjection);
    assert.equal(read.status, "blocked");
    assert.equal(read.diagnostic?.reason, "unmigrated");
    assert.ok(![...read.value.values()].some((f) => f.id === "f_old"), "the old shard was not folded");
    assert.equal(lockoutOf(ana.sidecar), null, "unmigrated is not damage");
  } finally { s.dispose(); stores.forEach((d) => discard(d)); }
});

test("the tripwire reads as nothing to this build, and anything else at its path is damage", async () => {
  assert.deepEqual(splitShard(TRIPWIRE_BYTES, TRIPWIRE_PATH), { events: [], damage: [], malformed: [] });
  assert.equal(splitShard(TRIPWIRE_BYTES + "more\n", TRIPWIRE_PATH).damage.length, 2, "other bytes there are damage");
  assert.equal(splitShard(TRIPWIRE_BYTES, "notes/x/events.ndjson").damage.length, 1, "and so are those bytes anywhere else");
  const s = await scenario(["ana@x.com"]);
  try {
    const ana = who(s, "ana@x.com");
    mkdirSync(join(ana.sidecar, "linear-log"), { recursive: true });
    writeFileSync(join(ana.sidecar, TRIPWIRE_PATH), TRIPWIRE_BYTES);
    const r = await sync(ana.sidecar, ana.actor);
    assert.ok(!("error" in r), JSON.stringify(r));
    assert.equal((await readScopeChecked(ana.sidecar, "linear-log")).status, "complete");
    assert.equal(lockoutOf(ana.sidecar), null);
  } finally { s.dispose(); }
});

test("the sentinel manifest is no peer to this build, and anything else at its path is one", async () => {
  const s = await scenario(["ana@x.com"]);
  try {
    const ana = who(s, "ana@x.com");
    writeFileSync(join(ana.sidecar, SENTINEL_MANIFEST_PATH), SENTINEL_MANIFEST_BYTES);
    const r = await sync(ana.sidecar, ana.actor);
    assert.ok(!("error" in r), JSON.stringify(r));
    assert.ok(!(await readManifests(ana.sidecar)).some((m) => m.anchorScheme === 0));
    // Edited, it is an ordinary manifest from a peer on another scheme, and stops the sync.
    writeFileSync(join(ana.sidecar, SENTINEL_MANIFEST_PATH), SENTINEL_MANIFEST_BYTES.replace("upgrade codemap", "upgrade codemap!"));
    assert.ok((await readManifests(ana.sidecar)).some((m) => m.anchorScheme === 0));
  } finally { s.dispose(); }
});

test("an upgraded clone whose old events all reached the migrated remote moves to its tip", async () => {
  const s = await scenario(["ana@x.com"]);
  try {
    const ana = who(s, "ana@x.com");
    await createFinding(ana.sidecar, PR, ana.actor, { targetKind: "anchor", targetId: "a_1", text: "migrated" });
    // The same event as an old build left it in this clone: a per-writer shard, without `seq`.
    const line = readFileSync(join(ana.sidecar, findingScope(PR), "events.ndjson"), "utf8").split("\n")[0]!;
    const { seq: _seq, ...old } = JSON.parse(line);
    const legacy = join(ana.sidecar, findingScope(PR), "w_0123456789abcdef.ndjson");
    writeFileSync(legacy, JSON.stringify(old) + "\n");
    const r = await sync(ana.sidecar, ana.actor);
    assert.ok(!("error" in r), JSON.stringify(r));
    assert.ok(!existsSync(legacy), "the per-writer shard is gone with the move to the tip");
  } finally { s.dispose(); }
});

test("a clone checked out with core.autocrlf=true reads the markers as markers, not damage", async () => {
  const s = await scenario(["ana@x.com"]);
  const clone = mkdtempSync(join(tmpdir(), "codemap-crlf-"));
  try {
    const ana = who(s, "ana@x.com");
    mkdirSync(join(ana.sidecar, "linear-log"), { recursive: true });
    writeFileSync(join(ana.sidecar, TRIPWIRE_PATH), TRIPWIRE_BYTES);
    writeFileSync(join(ana.sidecar, SENTINEL_MANIFEST_PATH), SENTINEL_MANIFEST_BYTES);
    await createFinding(ana.sidecar, PR, ana.actor, { targetKind: "anchor", targetId: "a_1", text: "one" });
    const win = join(clone, "w");
    spawnSync("git", ["-c", "core.autocrlf=true", "clone", "-q", s.origin, win]);
    spawnSync("git", ["config", "core.autocrlf", "true"], { cwd: win });
    const r = await sync(win, { principal: "win@x.com" });
    assert.ok(!("error" in r), JSON.stringify(r));
    await scanForDamage(win);
    assert.equal(lockoutOf(win), null);
    assert.ok(!(await readManifests(win)).some((m) => m.anchorScheme === 0), "the sentinel is still the sentinel");
  } finally { s.dispose(); discard(clone); }
});

test("an existing clone whose old events the migration DROPPED still moves to the migrated tip (plan C2: ancestry)", async () => {
  const s = await scenario(["ana@x.com"]);
  const m = mkdtempSync(join(tmpdir(), "codemap-migrator-"));
  const git = (cwd: string, ...a: string[]) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" });
  try {
    const ana = who(s, "ana@x.com");
    // What a build before the linear log pushed: a per-writer shard, with an event the migration will drop.
    const legacy = join(findingScope(PR), "w_0123456789abcdef.ndjson");
    mkdirSync(join(ana.sidecar, findingScope(PR)), { recursive: true });
    writeFileSync(join(ana.sidecar, legacy), JSON.stringify(testEvent({ id: "0000000001-dropped", kind: "graph.published", subject: "mh-x" })) + "\n");
    git(ana.sidecar, "add", "-A"); git(ana.sidecar, "commit", "-qm", "old build"); git(ana.sidecar, "push", "-q", "origin", "HEAD:main");
    // The migration, elsewhere: the shard goes, the event with it.
    git(tmpdir(), "clone", "-q", s.origin, join(m, "c"));
    git(join(m, "c"), "rm", "-q", legacy); git(join(m, "c"), "commit", "-qm", "migrate"); git(join(m, "c"), "push", "-q", "origin", "HEAD:main");
    const r = await sync(ana.sidecar, ana.actor);
    assert.ok(!("error" in r), JSON.stringify(r));
    assert.ok(!existsSync(join(ana.sidecar, legacy)), "the old shard went with the move to the tip");
  } finally { s.dispose(); discard(m); }
});
