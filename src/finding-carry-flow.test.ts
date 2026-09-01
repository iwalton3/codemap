/**
 * The carry, end to end, through the verbs a caller actually reaches.
 *
 * The fold tests (`finding-carry.test.ts`) drive hand-built events, which is the only way
 * to check a guard binds every reader. What they cannot see is the path in front of it:
 * whether the op refuses an agent BEFORE emitting, whether a carry on a log-owned finding
 * survives materialization, and whether the backlog moves the record into the right
 * bucket afterwards. Every one of those was unexercised — the shared path had never been
 * run at all, only folded.
 *
 * Both stores, because one canonical table holds this machine's own findings beside the
 * team's and the verbs dispatch on the record. A test that only used local rows would
 * pass while the sidecar half answered `no finding … on pr <scope>`, which is the defect
 * this dispatch exists to prevent and which shipped once already.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { indexBlob } from "./repo.js";
import { writeStore, writeLocalFinding, readFinding } from "./store.js";
import type { State } from "./schema.js";
import type { SharedFinding } from "./shared-findings.js";
import { carryOn, releaseCarryOn, rewitnessOn } from "./ops.js";
import { shareFinding, findingBacklog } from "./ops-shared.js";
import { discard } from "./test-tmp.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const SRC = "export function creditLine(cents) {\n  return cents * 2;\n}\n";

const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]!; }
  try { await fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; } }
};
/** What an MCP session is. The gate under test is exactly this difference. */
const asAgent = (fn: () => Promise<void>) => withEnv({ CODEMAP_AGENT_MODEL: "claude-opus-5" }, fn);
const asPerson = (fn: () => Promise<void>) => withEnv({ CODEMAP_AGENT_MODEL: undefined }, fn);

/** A universe with an identity, a sidecar and an index — everything the verbs need. */
async function universe() {
  const root = mkdtempSync(join(tmpdir(), "codemap-carryflow-"));
  const git = (...a: string[]) => spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=izzie", ...a], { cwd: root });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "izzie@x.com");
  git("config", "user.name", "izzie");
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/credit.js"), SRC, "utf8");
  const anchors = await indexBlob(SRC, "src/credit.js");
  await writeStore(root, anchors, state);
  const side = mkdtempSync(join(tmpdir(), "codemap-carryflow-side-"));
  writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
  return { root, side, id: anchors[0]!.id, hash: anchors[0]!.bodyHash, cleanup: () => { discard(root); discard(side); } };
}

const err = (r: unknown): string | undefined => (r as { error?: string })?.error;

const local = (id: string, over: Partial<SharedFinding> = {}): SharedFinding => ({
  id, target: { kind: "anchor", id: "a_x" }, text: "creditLine doubles the amount",
  author: { principal: "izzie@x.com" }, createdAt: "2026-08-01T00:00:00Z",
  state: "created", corroboration: [], thread: [], revisions: [], ...over,
} as SharedFinding);

test("an agent is refused a carry on a SHARED finding, and on a local one", async () => {
  const u = await universe();
  try {
    let sharedId = "";
    await asAgent(async () => {
      const f = await shareFinding(u.root, 7, { targetKind: "anchor", targetId: u.id, text: "real thing" }) as { id?: string };
      sharedId = f.id!;
      const r = await carryOn(u.root, { id: sharedId, until: "2027-01-01", reason: "not now" });
      assert.match(String(err(r)), /person's decision/, "refused in words, before anything is emitted");
    });
    // And the refusal is not merely a message: nothing was written.
    assert.equal((await readFinding(u.root, sharedId))?.carry, undefined, "no carry reached the record");

    await writeLocalFinding(u.root, local("f_local", { target: { kind: "anchor", id: u.id } }), 7);
    await asAgent(async () => {
      const r = await carryOn(u.root, { id: "f_local", until: "2027-01-01", reason: "not now" });
      assert.match(String(err(r)), /person's decision/, "the local path gates too — it has no fold behind it");
    });
    assert.equal((await readFinding(u.root, "f_local"))?.carry, undefined);
  } finally { u.cleanup(); }
});

test("a person carries a SHARED finding, it survives the fold, and the backlog moves it", async () => {
  const u = await universe();
  try {
    let id = "";
    await asAgent(async () => {
      id = ((await shareFinding(u.root, 7, { targetKind: "anchor", targetId: u.id, text: "real thing" })) as { id: string }).id;
    });
    const before = await findingBacklog(u.root, { asOf: "2026-09-01" });
    assert.ok(before.live.some((r) => r.id === id) || before.unjudgeable.some((r) => r.id === id), "it starts as ordinary debt");

    await asPerson(async () => {
      const r = await carryOn(u.root, { id, until: "2027-01-01", reason: "CreditLineDomain is slated for replacement" });
      assert.equal(err(r), undefined, `carry refused: ${err(r)}`);
    });

    // Read back through the STORE, which is the projection the fold wrote — not the
    // op's return value, which would pass even if nothing materialized.
    const rec = await readFinding(u.root, id);
    assert.equal(rec?.carry?.until, "2027-01-01", "the carry survived the round trip through the log");
    assert.equal(rec?.carry?.by.via, undefined, "and is recorded as a person's, with no agent in it");

    const after = await findingBacklog(u.root, { asOf: "2026-09-01" });
    assert.ok(after.sleeping.some((r) => r.id === id), "the backlog now holds it as a decision, not as debt");
    assert.ok(!after.live.some((r) => r.id === id));
    assert.equal(after.attention, 0, "and it is out of what anybody owes");
  } finally { u.cleanup(); }
});

test("only a person ends a carry, and the finding returns to the queue", async () => {
  const u = await universe();
  try {
    await writeLocalFinding(u.root, local("f_1", { target: { kind: "anchor", id: u.id }, witness: { anchorId: u.id, bodyHash: u.hash } }), 7);
    await asPerson(async () => {
      assert.equal(err(await carryOn(u.root, { id: "f_1", until: "2027-01-01", reason: "not now" })), undefined);
    });
    await asAgent(async () => {
      assert.match(String(err(await releaseCarryOn(u.root, "f_1", "clearing the queue"))), /person's/);
    });
    assert.ok((await readFinding(u.root, "f_1"))?.carry, "an agent's release changed nothing");

    await asPerson(async () => {
      assert.equal(err(await releaseCarryOn(u.root, "f_1", "doing it now")), undefined);
    });
    assert.equal((await readFinding(u.root, "f_1"))?.carry, undefined);
    const b = await findingBacklog(u.root, { asOf: "2026-09-01" });
    assert.ok(b.live.some((r) => r.id === "f_1"), "and it is back in the queue it left");
  } finally { u.cleanup(); }
});

test("an AGENT repairs a witness, and that is what moves it out of `unjudgeable`", async () => {
  // The one act here an agent may perform, and the bucket nothing else can touch — 19%
  // of the measured backlog. If this path does not work, that share is permanent.
  const u = await universe();
  try {
    await writeLocalFinding(u.root, local("f_blind", { target: { kind: "anchor", id: u.id } }), 7);
    const before = await findingBacklog(u.root, { asOf: "2026-09-01" });
    assert.deepEqual(before.unjudgeable.map((r) => r.id), ["f_blind"], "nothing can judge it yet");

    await asAgent(async () => {
      const r = await rewitnessOn(u.root, "f_blind");
      assert.equal(err(r), undefined, `rewitness refused: ${err(r)}`);
    });

    const rec = await readFinding(u.root, "f_blind");
    assert.equal(rec?.witness?.bodyHash, u.hash, "witnessed at the code as it stands now");
    assert.equal(rec?.witnessAttached?.by.via?.kind, "agent",
      "and marked, because it cannot testify about the code when the finding was filed");

    const after = await findingBacklog(u.root, { asOf: "2026-09-01" });
    assert.deepEqual(after.live.map((r) => r.id), ["f_blind"], "now it is judgeable, and it is live");
    assert.deepEqual(after.unjudgeable, []);

    // Twice is refused: re-baselining a witness silently moves every drift answer.
    await asAgent(async () => {
      assert.match(String(err(await rewitnessOn(u.root, "f_blind"))), /already has a witness/);
    });
  } finally { u.cleanup(); }
});

test("the release condition is required at the OP, not only at the fold", async () => {
  const u = await universe();
  try {
    await writeLocalFinding(u.root, local("f_1", { target: { kind: "anchor", id: u.id } }), 7);
    await asPerson(async () => {
      assert.match(String(err(await carryOn(u.root, { id: "f_1", until: "", reason: "not now" }))), /needs `until`/);
      assert.match(String(err(await carryOn(u.root, { id: "f_1", until: "soon", reason: "not now" }))), /needs `until`/);
      assert.match(String(err(await carryOn(u.root, { id: "f_1", until: "2027-01-01", reason: "  " }))), /needs a reason/);
    });
    assert.equal((await readFinding(u.root, "f_1"))?.carry, undefined, "none of those wrote anything");
  } finally { u.cleanup(); }
});
