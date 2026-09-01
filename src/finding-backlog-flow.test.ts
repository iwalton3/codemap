/**
 * Backlogging, end to end, through the verbs a caller actually reaches.
 *
 * The fold tests (`finding-backlogged.test.ts`) drive hand-built events, the only way
 * to check a guard binds every reader. What they cannot see is the path in front of it:
 * whether the op refuses an agent BEFORE emitting, whether backlogging a log-owned finding
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
import { backlogOn, releaseBacklogOn, rewitnessOn } from "./ops.js";
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

test("an agent may not backlog a SHARED finding, nor a local one", async () => {
  const u = await universe();
  try {
    let sharedId = "";
    await asAgent(async () => {
      const f = await shareFinding(u.root, 7, { targetKind: "anchor", targetId: u.id, text: "real thing" }) as { id?: string };
      sharedId = f.id!;
      const r = await backlogOn(u.root, { id: sharedId, until: "2027-01-01", reason: "not now" });
      assert.match(String(err(r)), /person's decision/, "refused in words, before anything is emitted");
    });
    // And the refusal is not merely a message: nothing was written.
    assert.equal((await readFinding(u.root, sharedId))?.backlogged, undefined, "nothing reached the record");

    await writeLocalFinding(u.root, local("f_local", { target: { kind: "anchor", id: u.id } }), 7);
    await asAgent(async () => {
      const r = await backlogOn(u.root, { id: "f_local", until: "2027-01-01", reason: "not now" });
      assert.match(String(err(r)), /person's decision/, "the local path gates too — it has no fold behind it");
    });
    assert.equal((await readFinding(u.root, "f_local"))?.backlogged, undefined);
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
      const r = await backlogOn(u.root, { id, until: "2027-01-01", reason: "CreditLineDomain is slated for replacement" });
      assert.equal(err(r), undefined, `backlogging refused: ${err(r)}`);
    });

    // Read back through the STORE, which is the projection the fold wrote — not the
    // op's return value, which would pass even if nothing materialized.
    const rec = await readFinding(u.root, id);
    assert.equal(rec?.backlogged?.until, "2027-01-01", "it survived the round trip through the log");
    assert.equal(rec?.backlogged?.by.via, undefined, "and is recorded as a person's, with no agent in it");

    const after = await findingBacklog(u.root, { asOf: "2026-09-01" });
    assert.ok(after.sleeping.some((r) => r.id === id), "the backlog now holds it as a decision, not as debt");
    assert.ok(!after.live.some((r) => r.id === id));
    assert.equal(after.attention, 0, "and it is out of what anybody owes");
  } finally { u.cleanup(); }
});

test("only a person brings one back, and the finding returns to the queue", async () => {
  const u = await universe();
  try {
    await writeLocalFinding(u.root, local("f_1", { target: { kind: "anchor", id: u.id }, witness: { anchorId: u.id, bodyHash: u.hash } }), 7);
    await asPerson(async () => {
      assert.equal(err(await backlogOn(u.root, { id: "f_1", until: "2027-01-01", reason: "not now" })), undefined);
    });
    await asAgent(async () => {
      assert.match(String(err(await releaseBacklogOn(u.root, "f_1", "clearing the queue"))), /person's/);
    });
    assert.ok((await readFinding(u.root, "f_1"))?.backlogged, "an agent's release changed nothing");

    await asPerson(async () => {
      assert.equal(err(await releaseBacklogOn(u.root, "f_1", "doing it now")), undefined);
    });
    assert.equal((await readFinding(u.root, "f_1"))?.backlogged, undefined);
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
      assert.match(String(err(await backlogOn(u.root, { id: "f_1", until: "", reason: "not now" }))), /needs `until`/);
      assert.match(String(err(await backlogOn(u.root, { id: "f_1", until: "soon", reason: "not now" }))), /needs `until`/);
      assert.match(String(err(await backlogOn(u.root, { id: "f_1", until: "2027-01-01", reason: "  " }))), /needs a reason/);
    });
    assert.equal((await readFinding(u.root, "f_1"))?.backlogged, undefined, "none of those wrote anything");
  } finally { u.cleanup(); }
});

test("re-evaluate puts the finding in the queue an agent already reads", async () => {
  // `finding.assigned` was folded from the day the record existed and had NO emitter, no
  // op and no tool — `findingAsQueueEntry` mapped an assignment into `review_queue` and
  // nothing could ever put one there. This is that dead half, and the test drives it end
  // to end rather than checking the event: the point is that an agent finds the work.
  const u = await universe();
  try {
    const { reevaluateOn } = await import("./ops.js");
    const { reviewQueue } = await import("./ops.js");
    await writeLocalFinding(u.root, local("f_1", { target: { kind: "anchor", id: u.id } }), 7);

    const before = await reviewQueue(u.root, { brief: true });
    assert.equal(before.queue.filter((i: { id: string }) => i.id === "f_1").length, 0, "nothing has been asked for yet");

    await asPerson(async () => {
      assert.equal(err(await reevaluateOn(u.root, "f_1")), undefined);
    });

    const after = await reviewQueue(u.root, { brief: true });
    const item = after.queue.find((i: { id: string }) => i.id === "f_1") as { assignment?: { kind: string; note?: string } } | undefined;
    assert.ok(item, "the finding is now work an agent has been handed");
    assert.equal(item!.assignment?.kind, "investigate");
    assert.match(String(item!.assignment?.note), /re-witness it if it has none/,
      "and the ask says what a fresh look means, so it is not just 'look again'");

    // THE HALF THAT WAS BROKEN. `reviewQueue` keeps an item only while
    // `includeAnswered || !outcome`, so a finding somebody had already reported on was
    // handed back and landed in NO queue — silently, and for exactly the case the button
    // exists for ("I think this was fixed, but somebody should check"). The local path
    // cleared the stale answer and the fold did not, so the two stores disagreed.
    const answered = await universe();
    try {
      const { closeFinding } = await import("./ops.js");
      let sid = "";
      await asAgent(async () => {
        sid = ((await shareFinding(answered.root, 9, { targetKind: "anchor", targetId: answered.id, text: "real thing" })) as { id: string }).id;
        // Through the ordinary verb an agent reports with, so the outcome is recorded the
        // way one actually gets there.
        const r = await closeFinding(answered.root, { id: sid, result: "fixed", detail: "fixed it last week", files: ["src/credit.js"] });
        assert.ok(!r.error, `reporting an outcome failed: ${r.error}`);
      });
      assert.ok((await readFinding(answered.root, sid))?.outcome, "it has an answer standing");
      await asPerson(async () => { await reevaluateOn(answered.root, sid); });
      const rec = await readFinding(answered.root, sid);
      assert.equal(rec?.outcome, undefined, "a fresh ask clears the answer that no longer stands");
      assert.equal((rec?.outcomes ?? []).length, 1, "…and keeps the history, which is not unsaid");
      const q = await reviewQueue(answered.root, { brief: true });
      assert.ok(q.queue.some((i: { id: string }) => i.id === sid), "so the agent can actually see it");
    } finally { answered.cleanup(); }

    // Ungated: it asks a question rather than answering one, so an agent may ask too.
    await asAgent(async () => {
      assert.equal(err(await reevaluateOn(u.root, "f_1")), undefined, "not a disposition, so not gated");
    });
    // And it does not dispose of anything.
    const rec = await readFinding(u.root, "f_1");
    assert.equal(rec?.state, "created", "still open");
    assert.equal(rec?.backlogged, undefined, "still not backlogged");
  } finally { u.cleanup(); }
});

test("the same request produces the same deadline on both stores", async () => {
  // `checkBacklogInput` trimmed to VALIDATE and the two paths then wrote different
  // things: the shared one trimmed again, the local one wrote the raw value — and
  // " 2027-01-01" sorts below every digit, so an identical request made a finding due
  // for ever locally and asleep until 2027 on the team's copy.
  const u = await universe();
  try {
    let sharedId = "";
    await asAgent(async () => {
      sharedId = ((await shareFinding(u.root, 7, { targetKind: "anchor", targetId: u.id, text: "shared one" })) as { id: string }).id;
    });
    await writeLocalFinding(u.root, local("f_local", { target: { kind: "anchor", id: u.id } }), 7);

    await asPerson(async () => {
      for (const id of [sharedId, "f_local"]) {
        assert.equal(err(await backlogOn(u.root, { id, until: " 2027-01-01 ", reason: "  later  " })), undefined);
      }
    });
    for (const id of [sharedId, "f_local"]) {
      const rec = await readFinding(u.root, id);
      assert.equal(rec?.backlogged?.until, "2027-01-01", `${id} stored an untrimmed deadline`);
      assert.equal(rec?.backlogged?.reason, "later");
    }
    const b = await findingBacklog(u.root, { asOf: "2026-09-01" });
    assert.equal(b.due.length, 0, "neither is due — the leading space would have made one due for ever");
    assert.equal(b.sleeping.length, 2, "both asleep until 2027");
  } finally { u.cleanup(); }
});

test("re-witnessing may not point a finding's drift at unrelated code", async () => {
  // A wrong witness is worse than none: none is visibly `unjudgeable`, this looks
  // settled while answering drift about code the finding was never about.
  const u = await universe();
  try {
    await writeLocalFinding(u.root, local("f_1", { target: { kind: "anchor", id: u.id } }), 7);
    await asAgent(async () => {
      const r = await rewitnessOn(u.root, "f_1", { anchorId: "a_somewhere_else" });
      assert.match(String(err(r)), /is filed on/, "refused, and the message names the right anchor");
    });
    assert.equal((await readFinding(u.root, "f_1"))?.witness, undefined, "nothing was attached");
    await asAgent(async () => {
      assert.equal(err(await rewitnessOn(u.root, "f_1", { anchorId: u.id })), undefined, "its own target is fine");
    });
    assert.equal((await readFinding(u.root, "f_1"))?.witness?.anchorId, u.id);
  } finally { u.cleanup(); }
});

test("a finding that became a bug leaves the backlog", async () => {
  // `promotedToBug` leaves the state open on purpose, so filtering on state alone kept a
  // finding that had taken one of the two exits in `live` — labelled "never disposed of",
  // counted in `attention`, and unclearable except by asserting something nobody checked.
  const u = await universe();
  try {
    let id = "";
    await asAgent(async () => {
      id = ((await shareFinding(u.root, 7, { targetKind: "anchor", targetId: u.id, text: "a real defect" })) as { id: string }).id;
    });
    assert.equal((await findingBacklog(u.root, { asOf: "2026-09-01" })).attention, 1, "it starts as debt");

    const { deferFinding } = await import("./ops.js");
    await asPerson(async () => {
      const r = await deferFinding(u.root, id);
      assert.ok(!r.error, `filing the bug failed: ${r.error}`);
    });
    assert.ok((await readFinding(u.root, id))?.bug, "the finding still exists and names its bug");
    const b = await findingBacklog(u.root, { asOf: "2026-09-01" });
    assert.equal(b.attention, 0, "and it is out of the backlog — the bug queue tracks it now");
    assert.deepEqual(b.live, []);
  } finally { u.cleanup(); }
});

test("the backlog read MATERIALIZES, so a version bump can actually reach it", async () => {
  // `MATERIALIZER_VERSION` 19 is enforced by `scopeFingerprint`, which only anything
  // going through `ensureMaterialized` consults. `findingBacklog` read the canonical
  // table RAW — so an upgraded store whose shards had not moved would have served rows
  // its old build folded, with no `backlogged` on them, for ever. The bump was necessary
  // and not sufficient, and nothing would have said so.
  const u = await universe();
  try {
    const { foldCount } = await import("./materialize.js");
    let id = "";
    await asAgent(async () => {
      id = ((await shareFinding(u.root, 7, { targetKind: "anchor", targetId: u.id, text: "real thing" })) as { id: string }).id;
    });
    await findingBacklog(u.root, { asOf: "2026-09-01" });   // fold once, cache it
    const settled = foldCount();
    await findingBacklog(u.root, { asOf: "2026-09-01" });
    assert.equal(foldCount(), settled, "an unchanged scope is answered from rows, not refolded");

    // Now the log moves under it — which is the shape a pull, or an upgrade's changed
    // fingerprint, produces. The read must notice.
    await asPerson(async () => {
      assert.equal(err(await backlogOn(u.root, { id, until: "2027-01-01", reason: "later" })), undefined);
    });
    const b = await findingBacklog(u.root, { asOf: "2026-09-01" });
    assert.ok(b.sleeping.some((r) => r.id === id), "the read reflects the log, not a stale projection");
  } finally { u.cleanup(); }
});
