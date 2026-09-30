/**
 * The lockout (plan 1.2; owner, batch 4: "it should basically lockout the entire application
 * until it is fixed"). Damage anywhere this machine can see stops every read and op, sync
 * included, names the entry, and clears only once nothing damaged is visible.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { team, settle } from "./oracle.js";
import { sharedSync, sharedPull, sharedFindings, sharedDocs } from "./ops-shared.js";
import { decisionRounds } from "./ops/decisions.js";
import { decisionScope } from "./shared-decisions.js";
import { universeKey } from "./sidecar-config.js";
import { appendUnfolded } from "./test-door.js";
import { lockoutOf, LockedOut } from "./lockout.js";
import { lockoutGate } from "./lockout-gate.js";
import { findDamage } from "./damage-scan.js";
import { rpc } from "./test-mcp.js";
import { spawnSync } from "node:child_process";

/**
 * A well-formed answer to a decision nobody posted, appended the way a build without the door
 * would: a linear event its fold refuses on a failed reference — damage (owner, batch 1). A
 * wrong SHAPE would be newer instead, which blocks pushes and does not lock.
 */
async function damage(sidecar: string, repo: string): Promise<string> {
  const e = await appendUnfolded(sidecar, decisionScope(universeKey(repo)), { principal: "ana@acme.test" },
    "decision.answer.recorded", "d_nobody_posted", { decision: "d_nobody_posted", hash: "h", via: { kind: "direct", option: "x" } });
  return e.id;
}

test("damage in a scope nothing has folded locks every read, in a scope it is not in, naming the entry", async () => {
  const t = await team(["ana@acme.test"]);
  try {
    const ana = t.all[0]!;
    const id = await damage(ana.sidecar, ana.repo);
    // A findings read never folds `decisions/`: without the scan at open, it would carry on.
    const locked = await lockoutGate([ana.repo]);
    assert.ok(locked instanceof LockedOut, "the first gate a process passes scans every scope");
    assert.equal(locked!.lockout.entry.id, id);
    assert.match(locked!.message, /decision\.answer\.recorded/);
    assert.match(locked!.message, /docs\/log-repair\.md/);
    assert.ok(locked!.lockout.entry.shard?.startsWith("decisions/"), "it names the shard");
    assert.ok(locked!.lockout.entry.line, "and the line");
    // The flag is the sidecar's, in its git dir: every store on that sidecar sees it.
    assert.equal(lockoutOf(ana.sidecar)?.entry.id, id);
    await assert.rejects(sharedFindings(ana.repo, 1), LockedOut);
  } finally { t.dispose(); }
});

test("a read that folds damage locks the store, and every other read then refuses", async () => {
  const t = await team(["ana@acme.test"]);
  try {
    const ana = t.all[0]!;
    const id = await damage(ana.sidecar, ana.repo);
    await assert.rejects(decisionRounds(ana.repo), (e: unknown) => e instanceof LockedOut && e.lockout.entry.id === id);
    // The docs log: a read that never folds `decisions/`, so only the lock can stop it.
    await assert.rejects(sharedDocs(ana.repo), LockedOut, "a read of another scope refuses too");
  } finally { t.dispose(); }
});

test("sync refuses while damage is visible, and a locked sync clears the lock once it is repaired", async () => {
  const t = await team(["ana@acme.test"]);
  try {
    const ana = t.all[0]!;
    await damage(ana.sidecar, ana.repo);
    const refused = await sharedSync(ana.repo) as { error?: string };
    assert.match(refused.error ?? "", /refusing to commit|locked/, "no more entries onto a possibly broken store");
    assert.ok(lockoutOf(ana.sidecar), "and the store is locked");
    // The repair: the damaged line out of the working tree (it was never committed).
    const scope = decisionScope(universeKey(ana.repo));
    for (const f of spawnSync("git", ["ls-files", "--others", "--modified", scope], { cwd: ana.sidecar, encoding: "utf8" }).stdout.split("\n").filter(Boolean)) {
      const lines = readFileSync(join(ana.sidecar, f), "utf8").split("\n").filter((l) => l && !l.includes("d_nobody_posted"));
      writeFileSync(join(ana.sidecar, f), lines.map((l) => l + "\n").join(""));
    }
    assert.equal(await findDamage(ana.sidecar), null);
    const synced = await sharedSync(ana.repo) as { error?: string; ok?: boolean };
    assert.equal(synced.error, undefined);
    assert.equal(lockoutOf(ana.sidecar), null, "the lock clears once nothing damaged is visible here or on the fetched tip");
  } finally { t.dispose(); }
});

test("a pull that would bring damage is refused and locks the clone that refused it", async () => {
  const t = await team(["ana@acme.test", "ben@acme.test"]);
  try {
    const [ana, ben] = t.all as [typeof t.all[0], typeof t.all[0]];
    await settle(t);
    // Ana's clone publishes a wrong-shaped entry the way a broken build would: straight to git.
    await damage(ana.sidecar, ana.repo);
    for (const args of [["add", "-A"], ["-c", "user.email=a@x", "-c", "user.name=a", "commit", "-qm", "broken build"], ["push", "-q", "origin", "HEAD"]])
      assert.equal(spawnSync("git", args, { cwd: ana.sidecar }).status, 0, args.join(" "));
    // Bytes that parse are taken and judged: the fold refuses the entry, and the app locks.
    const pulled = await sharedPull(ben.repo) as { error?: string };
    assert.match(pulled.error ?? "", /codemap is locked/);
    assert.ok(lockoutOf(ben.sidecar), "damage in an incoming pull locks the app as well (owner, batch 8)");
    // The repair lands on the remote; ben's locked clone takes it and the lock clears — the
    // damage arrived in his tree, so it has to be able to leave the same way.
    const scope = decisionScope(universeKey(ana.repo));
    for (const f of spawnSync("git", ["ls-files", scope], { cwd: ana.sidecar, encoding: "utf8" }).stdout.split("\n").filter(Boolean)) {
      const lines = readFileSync(join(ana.sidecar, f), "utf8").split("\n").filter((l) => l && !l.includes("d_nobody_posted"));
      writeFileSync(join(ana.sidecar, f), lines.map((l) => l + "\n").join(""));
    }
    for (const args of [["-c", "user.email=a@x", "-c", "user.name=a", "commit", "-qam", "repair"], ["push", "-q", "origin", "HEAD"]])
      assert.equal(spawnSync("git", args, { cwd: ana.sidecar }).status, 0, args.join(" "));
    const released = await sharedSync(ben.repo) as { error?: string };
    assert.equal(released.error, undefined, "the repaired tip releases the clone that took the damage");
    assert.equal(lockoutOf(ben.sidecar), null);
  } finally { t.dispose(); }
});

test("every MCP tool but sync and pull answers the lockout", async () => {
  const t = await team(["ana@acme.test"]);
  try {
    const ana = t.all[0]!;
    const id = await damage(ana.sidecar, ana.repo);
    const [outline, questionnaires] = await rpc(ana.repo, [
      { name: "outline", arguments: {} },
      { name: "questionnaire_list", arguments: {} },
    ]);
    for (const text of [outline!, questionnaires!]) {
      assert.match(text, /codemap is locked/);
      assert.ok(text.includes(id));
    }
  } finally { t.dispose(); }
});

test("the read-only check names the damage and writes no flag", async () => {
  const t = await team(["ana@acme.test"]);
  try {
    const ana = t.all[0]!;
    const id = await damage(ana.sidecar, ana.repo);
    assert.equal((await findDamage(ana.sidecar))?.id, id);
    assert.equal(lockoutOf(ana.sidecar), null);
    assert.equal(existsSync(join(ana.sidecar, ".git", "codemap-lockout.json")), false);
  } finally { t.dispose(); }
});
