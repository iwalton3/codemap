/**
 * A shard that does not parse must never be silent.
 *
 * The hole these cover, measured on the code as it stood: `readShardLines` drops an
 * unparseable line by design — a torn append leaves one, and refusing the whole read
 * over it would mean a shared store that will not load because somebody closed a
 * laptop. But the rule had no upper bound, so a shard that was WHOLLY garbage yielded
 * no events and its scope answered `status: "complete"`. Every finding in it vanished
 * and every surface agreed the queue was clear.
 *
 * Three ends, and all three are needed: the reader blocks (so existing damage is
 * visible), the push refuses (so damage never enters the shared history), and the pull
 * refuses (so it never arrives from one).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Actor } from "./schema.js";
import { ensureSidecar, pull, push, sync } from "./sidecar.js";
import { createFinding, findingScope, readFindings } from "./shared-findings.js";
import { splitShard, scopeStatus, readScopeChecked, readShard, emitEvent, SHARD_EXT } from "./eventlog.js";
import { discard } from "./test-tmp.js";

const izzie: Actor = { principal: "izzie@x.com" };
const dana: Actor = { principal: "dana@x.com" };
const tmp = (tag: string) => mkdtempSync(join(tmpdir(), `codemap-${tag}-`));
const git = (root: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8" });

const NEW = { targetKind: "anchor" as const, targetId: "a_1", text: "evidence", comment: "the ask" };

/** The one shard `createFinding` wrote, as a path relative to the sidecar root. */
function shardOf(root: string, scope: string): string {
  const dir = join(root, scope);
  const name = readdirSync(dir).find((n) => n.endsWith(SHARD_EXT));
  assert.ok(name, `no shard under ${scope}`);
  return `${scope}/${name}`;
}

// --- what counts as damage ------------------------------------------------------

test("a torn tail is exempt, and only when the file actually ends mid-line", () => {
  const ev = JSON.stringify({
    id: "m1-a", kind: "x", subject: "s", actor: { principal: "p" }, at: "", after: [],
    writer: "w", writerPrev: "GENESIS", sidecarProtocol: 1, eventSchema: 1,
  });

  // A crash mid-append: the fragment is last AND the file does not end in a newline.
  const torn = splitShard(`${ev}\n{"id":"m1-b","ki`, "s.ndjson");
  assert.equal(torn.events.length, 1);
  assert.deepEqual(torn.damage, [], "a partial write is expected, not damage");

  // The SAME bytes with a newline after them were fully written, so nothing tore.
  const sealed = splitShard(`${ev}\n{"id":"m1-b","ki\n`, "s.ndjson");
  assert.equal(sealed.damage.length, 1);
  assert.equal(sealed.damage[0]!.line, 2, "1-based, so `sed -n 2p` finds it");

  // Mid-file, which is what a torn line BECOMES once anything is appended after it.
  const mid = splitShard(`${ev}\nnot json\n${ev.replace("m1-a", "m1-c")}\n`, "s.ndjson");
  assert.equal(mid.events.length, 2);
  assert.equal(mid.damage.length, 1);

  // The regression itself: one garbage line, no trailing newline, nothing else. The
  // torn-tail exemption must not swallow a whole shard.
  const whole = splitShard(`\x00\x01\x02 binary`, "s.ndjson");
  assert.equal(whole.events.length, 0);
  assert.equal(whole.damage.length, 1, "a wholly-garbage shard is damage, not a torn append");
});

test("a line that parses but fails the envelope check is dropped, NOT damage", () => {
  // The distinction is load-bearing: `wellFormed` exists so an event from a client this
  // build does not understand degrades instead of breaking the read. Counting one as
  // corruption would turn every version skew into a blocked scope.
  const r = splitShard(`{"id":"m1-a","kind":"x"}\n`, "s.ndjson");
  assert.equal(r.events.length, 0);
  assert.deepEqual(r.damage, []);
});

// --- the reader -----------------------------------------------------------------

test("a corrupt shard blocks its scope instead of emptying it", async () => {
  const root = tmp("corrupt-read");
  try {
    await ensureSidecar(root, izzie);
    const scope = findingScope(7);
    await createFinding(root, 7, izzie, NEW);
    const shard = shardOf(root, scope);

    const clean = await readScopeChecked(root, scope);
    assert.equal(clean.status, "complete");
    assert.equal(clean.events.length, 1, "the check could have failed — there IS an event here");

    // Not a torn tail: fully written, terminated, and in the middle of the file.
    const text = await readFile(join(root, shard), "utf8");
    writeFileSync(join(root, shard), `\x00\x01 garbage\n${text}`);

    const damaged = await readScopeChecked(root, scope);
    assert.equal(damaged.status, "blocked");
    assert.equal(damaged.diagnostic?.reason, "corrupt-shard");
    assert.deepEqual(damaged.diagnostic?.evidence, [`${shard}:1`]);
    assert.match(damaged.diagnostic!.detail, /deleting the damaged line/);
    // The readable half still comes back. A blocked scope is rendered
    // non-authoritative, never hidden — see `readScopeChecked`.
    assert.equal(damaged.events.length, 1);
  } finally { discard(root); }
});

test("damage outranks every other diagnostic, because it is the only one about the bytes", () => {
  const ahead = {
    id: "m1-a", kind: "x", subject: "s", actor: { principal: "p" }, at: "", after: [],
    writer: "w", writerPrev: "GENESIS", sidecarProtocol: 99, eventSchema: 99,
  };
  const both = scopeStatus([ahead as never], [], [{ shard: "s.ndjson", line: 2, sample: "x" }]);
  assert.equal(both.diagnostic?.reason, "corrupt-shard");
  // Mutation check: without the damage the SAME events report the protocol problem, so
  // the assertion above is about precedence and not about an empty branch.
  assert.equal(scopeStatus([ahead as never]).diagnostic?.reason, "protocol");
});

test("corruption cannot be acknowledged away — the repair is the line, not a decision", async () => {
  const root = tmp("corrupt-ack");
  try {
    await ensureSidecar(root, izzie);
    const scope = findingScope(9);
    await createFinding(root, 9, izzie, NEW);
    const shard = shardOf(root, scope);
    const text = await readFile(join(root, shard), "utf8");
    writeFileSync(join(root, shard), `nonsense\n${text}`);

    const before = await readScopeChecked(root, scope);
    assert.equal(before.status, "blocked");
    // A person acknowledging the exact evidence clears a fork or a duplicated id. It
    // must not clear this: those are ambiguities somebody has to arbitrate, and this is
    // bytes nobody can read — muting it restores the silence the check exists to end.
    const { acknowledgeScope } = await import("./eventlog.js");
    await acknowledgeScope(root, scope, izzie, before.diagnostic!);
    const after = await readScopeChecked(root, scope);
    assert.equal(after.status, "blocked");
    assert.equal(after.acknowledged, undefined);

  } finally { discard(root); }
});

// --- the append repair ----------------------------------------------------------

test("appending after a crash removes the partial line rather than sealing it in", async () => {
  const root = tmp("heal");
  try {
    await ensureSidecar(root, izzie);
    const scope = "notes/x";
    await emitEvent(root, scope, izzie, "note.one", "n1");
    const shard = join(root, shardOf(root, scope));

    // A process killed mid-append.
    appendFileSync(shard, `{"id":"m1-torn","ki`);
    await emitEvent(root, scope, izzie, "note.two", "n2");

    assert.deepEqual(splitShard(readFileSync(shard, "utf8"), "s").damage, [],
      "the fragment was dropped, not left mid-file where it is indistinguishable from corruption");
    assert.equal((await readShard(shard)).length, 2);
  } finally { discard(root); }
});

test("a whole event that merely lost its newline is KEPT, not truncated", async () => {
  const root = tmp("heal-keep");
  try {
    await ensureSidecar(root, izzie);
    const scope = "notes/y";
    await emitEvent(root, scope, izzie, "note.one", "n1");
    const shard = join(root, shardOf(root, scope));
    const line = readFileSync(shard, "utf8").trim();

    // Killed AFTER the JSON and before the terminator. It parses, every build has
    // counted it, and truncating it would delete a real event.
    appendFileSync(shard, line.replace(/"id":"[^"]+"/, '"id":"m1-late"'));
    await emitEvent(root, scope, izzie, "note.two", "n2");

    const ids = (await readShard(shard)).map((e) => e.id);
    assert.ok(ids.includes("m1-late"), "a readable event must survive the repair");
    assert.equal(ids.length, 3);
  } finally { discard(root); }
});

// --- the gates ------------------------------------------------------------------

test("push refuses to commit a shard that does not parse, and nothing leaves", async () => {
  const origin = tmp("origin"), root = tmp("push-gate");
  git(origin, "init", "-q", "--bare", "-b", "main");
  try {
    await ensureSidecar(root, izzie);
    git(root, "remote", "add", "origin", origin);
    await createFinding(root, 3, izzie, NEW);
    const shard = shardOf(root, findingScope(3));
    const text = readFileSync(join(root, shard), "utf8");
    writeFileSync(join(root, shard), `${text}garbage line\n`);

    const r = await push(root, "codemap: review state");
    assert.ok("error" in r, "the push must refuse");
    assert.match(r.error, /unreadable line/);
    assert.match(r.error, new RegExp(`${shard}:2`));
    assert.equal(git(origin, "rev-parse", "--verify", "--quiet", "main").status, 1,
      "the remote must still be empty");

    // Mutation check: the same push succeeds once the damage is gone, so the refusal
    // above is the gate and not some unrelated failure.
    writeFileSync(join(root, shard), text);
    const ok = await push(root, "codemap: review state");
    assert.ok(!("error" in ok) && ok.pushed);
  } finally { discard(origin); discard(root); }
});

test("pull refuses a damaged inbound shard and leaves the sidecar untouched", async () => {
  const origin = tmp("origin"), a = tmp("pull-a"), b = tmp("pull-b");
  git(origin, "init", "-q", "--bare", "-b", "main");
  try {
    for (const [r, who] of [[a, izzie], [b, dana]] as const) {
      await ensureSidecar(r, who);
      git(r, "remote", "add", "origin", origin);
    }
    await createFinding(a, 5, izzie, NEW);
    assert.ok(!("error" in await push(a, "izzie's finding")));
    // `sync`, not `pull`: a clone that has never committed its own scaffold cannot
    // merge — git refuses to overwrite untracked files — which is why `syncHeld`
    // commits first. That is the ordinary path a person takes.
    assert.ok(!("error" in await sync(b, dana)));
    assert.equal((await readFindings(b, 5)).size, 1);
    const aHead = git(a, "rev-parse", "HEAD").stdout.trim();

    // Damage introduced with raw git, which is the only way it can reach the remote
    // now — the push gate is what a codemap client would hit.
    await createFinding(b, 5, dana, { ...NEW, comment: "dana's" });
    const shard = shardOf(b, findingScope(5));
    writeFileSync(join(b, shard), `${readFileSync(join(b, shard), "utf8")}\x00 not json\n`);
    git(b, "add", "-A"); git(b, "commit", "-q", "-m", "raw");
    assert.equal(git(b, "push", "-q", "origin", "main").status, 0);

    const r = await pull(a, izzie);
    assert.ok("error" in r, "a genuinely broken sidecar must stop, not be made worse");
    assert.match(r.error, /not JSON/);
    assert.match(r.error, new RegExp(`${shard}:`), "and name the line, so it can be repaired where it was written");
    assert.match(r.error, /sidecar is untouched/);
    assert.equal(git(a, "rev-parse", "HEAD").stdout.trim(), aHead, "no merge happened");
    assert.equal(git(a, "status", "--porcelain").stdout.trim(), "", "and no half-merge was left behind");

    // The collateral is real and accepted: dana's GOOD finding was in the same push and
    // does not arrive either. Said out loud because it is the cost of the trade, not an
    // oversight — a shard is append-only, so the repair belongs where it was written.
    assert.equal((await readFindings(a, 5)).size, 1, "izzie's own finding, and nothing new");

    // Mutation check: once the damage is gone the same pull succeeds and brings it.
    writeFileSync(join(b, shard), readFileSync(join(b, shard), "utf8").replace(/\x00 not json\n/, ""));
    git(b, "add", "-A"); git(b, "commit", "-q", "-m", "repair"); git(b, "push", "-q", "origin", "main");
    const fixed = await pull(a, izzie);
    assert.ok(!("error" in fixed), `the repaired pull must succeed: ${(fixed as any).error}`);
    assert.equal((await readFindings(a, 5)).size, 2, "and dana's finding arrives");
  } finally { [origin, a, b].forEach(discard); }
});

/**
 * The repair must not be undone by the append-only restore.
 *
 * Two mechanisms, each right on its own. `erasedByMerge` puts back lines an incoming
 * history dropped, because a `git rm` is the one rewrite append-only cannot survive.
 * Deleting the damaged line is the ONLY repair a corrupt shard has. Together, the
 * repairer pushes the fix, every teammate's merge sees a deletion, restores it, and
 * pushes the damage back at them — the fix cannot be made to stick, and nothing says why.
 *
 * Found by RUNNING the oracle, not by reading either mechanism.
 */
test("deleting a damaged line survives a teammate's pull — the restore does not put it back", async () => {
  const origin = tmp("origin"), a = tmp("repair-a"), b = tmp("repair-b");
  git(origin, "init", "-q", "--bare", "-b", "main");
  try {
    for (const [r, who] of [[a, izzie], [b, dana]] as const) {
      await ensureSidecar(r, who);
      git(r, "remote", "add", "origin", origin);
    }
    await createFinding(a, 5, izzie, NEW);
    assert.ok(!("error" in await push(a, "izzie's finding")));
    assert.ok(!("error" in await sync(b, dana)));

    // Damage, introduced with raw git — the only way past the commit gate.
    const shard = shardOf(a, findingScope(5));
    const good = readFileSync(join(a, shard), "utf8");
    writeFileSync(join(a, shard), `${good}\x00 not json\n`);
    git(a, "add", "-A"); git(a, "commit", "-q", "-m", "damage"); git(a, "push", "-q", "origin", "main");

    // The repair, where the shard was written.
    writeFileSync(join(a, shard), good);
    assert.ok(!("error" in await push(a, "delete the damaged line")), "the repair is committable");

    const pulled = await sync(b, dana);
    assert.ok(!("error" in pulled), `dana's pull must succeed once it is repaired: ${(pulled as any).error}`);
    assert.deepEqual(splitShard(readFileSync(join(b, shard), "utf8"), "s").damage, [],
      "the restore must not resurrect a line no build can read");
    assert.equal((await readScopeChecked(b, findingScope(5))).status, "complete");

    // Mutation check: the restore still does its job for a REAL event. Drop izzie's
    // finding line with raw git and dana's pull must put it back.
    const line = readFileSync(join(a, shard), "utf8");
    writeFileSync(join(a, shard), "");
    git(a, "add", "-A"); git(a, "commit", "-q", "-m", "a git rm that looked like tidying");
    git(a, "push", "-q", "origin", "main");
    const restored = await sync(b, dana) as any;
    assert.equal(restored.error, undefined);
    assert.equal(readFileSync(join(b, shard), "utf8").trim(), line.trim(), "a real event IS restored");
  } finally { [origin, a, b].forEach(discard); }
});

test("`heal` does not claim to have acknowledged bytes nobody can read", async () => {
  // It writes an acknowledgement for every diagnostic it does not special-case, and
  // `scopeStatus` ignores one for this reason — so without the case, heal reported a
  // scope as healed while it stayed blocked, which is the shape of lie the whole
  // acknowledgement mechanism exists to prevent.
  const repo = tmp("heal-repo"), side = tmp("heal-side");
  try {
    git(repo, "init", "-q", "-b", "main");
    git(repo, "remote", "add", "origin", "https://github.com/acme/api.git");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, ".codemap"), { recursive: true });
    writeFileSync(join(repo, ".codemap", "sidecar"), side, "utf8");
    writeFileSync(join(repo, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    git(repo, "add", "-A"); git(repo, "commit", "-qm", "one");
    const ops = await import("./ops.js");
    await ops.init(repo);
    const { shareFinding, sharedHeal } = await import("./ops-shared.js");
    await shareFinding(repo, 5, { targetKind: "anchor", targetId: "a_1", text: "real thing" });

    // Discovered, not constructed: the universe key in a scope path is derived from the
    // origin URL and is not the string this test would guess.
    const { scopesOnDisk } = await import("./eventlog.js");
    const scope = (await scopesOnDisk(side)).find((x) => x.startsWith("findings/"))!;
    assert.ok(scope, "the finding was shared into some scope");
    const shard = shardOf(side, scope);
    writeFileSync(join(side, shard), `nonsense\n${readFileSync(join(side, shard), "utf8")}`);
    // COMMITTED, which is the realistic shape: damage arrives already in history, from a
    // pull or a hand-edit. Left uncommitted, heal's closing sync hits the commit gate
    // instead and reports the refusal — also correct, and also loud, but not what this
    // is about.
    git(side, "add", "-A"); git(side, "commit", "-q", "-m", "damage");
    assert.equal((await readScopeChecked(side, scope)).diagnostic?.reason, "corrupt-shard",
      "the check could have failed — set the scene first");

    const healed = await sharedHeal(repo) as any;
    assert.equal(healed.error, undefined, `heal itself must not fail: ${healed.error}`);
    assert.deepEqual(healed.acknowledged, [], "nothing was acknowledged");
    assert.deepEqual(healed.blocked.map((b: any) => b.scope), [scope], "it is reported as still blocked");
    assert.match(healed.blocked[0].reason, /deleting the damaged line/, "with the repair, not a shrug");
  } finally { [repo, side].forEach(discard); }
});
