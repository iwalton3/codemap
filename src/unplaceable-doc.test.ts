/**
 * Clearing a doc whose citations this build cannot place.
 *
 * `ackHole` refuses — an incomparable absence is not evidence of absence, and
 * hiding is the direction with no recovery — but the refusal files the work instead
 * of returning an error, so the doc is queued rather than stuck. See
 * docs/anchor-id-provenance.md § "Clearing a doc nobody can place".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DerivationTag, LogicalNode } from "./schema.js";
import { hashTokens } from "./normalize.js";
import { anchorIndex } from "./anchor-resolve.js";
import { spawnSync } from "node:child_process";
import { writeNode, writeAnnotations, readAnchorStore, readAnnotations, loadNodes, readSnapshot } from "./store.js";
import { init, ackHole, reviewQueue, closeAssignment, snapshotAt, UNPLACEABLE_CATEGORY } from "./ops.js";

const THEIRS: DerivationTag = {
  anchorScheme: 3, hashScheme: 2, parserIntegrity: "p".repeat(64), grammarDigest: "f".repeat(64),
};

const node = (over: Partial<LogicalNode> = {}): LogicalNode => ({
  id: "n_pay", type: "process", title: "Payments seam", summary: "s", body: "b",
  anchors: ["a_theirs"], ...over,
} as LogicalNode);

/**
 * A repo with a real index, holding a doc that cites an id this build could not
 * have minted. `writeNode` takes the index its citations are captured against,
 * which is the only way to produce the interesting input: this build cannot mint a
 * foreign id, so no amount of driving the real API gets there.
 */
async function repo() {
  const root = mkdtempSync(join(tmpdir(), "codemap-unplaceable-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/pay.ts"), "export function transfer(c: number) { return c; }\n");
  await init(root);
  return root;
}

const foreign = () => anchorIndex(
  new Map([["a_theirs", hashTokens(["body"], THEIRS)]]),
  { tags: [THEIRS], anyUntagged: false },
);

test("acking a hole nobody can see files the question instead of refusing", async () => {
  const root = await repo();
  try {
    await writeNode(root, node(), { hashes: foreign(), commit: "c0ffee", branch: "main" });
    assert.equal((await loadNodes(root)).find((n) => n.id === "n_pay")!.status, "unverifiable",
      "precondition: this build cannot place the citation");

    const r = await ackHole(root, "n_pay") as any;
    assert.ok(r.error, "the removal is still refused — nobody established the code is gone");
    assert.equal(r.status, "unverifiable");
    assert.ok(r.queued, "…but the attempt is work now, not an error");

    const q = (await readAnnotations(root)).annotations.find((a) => a.id === r.queued)!;
    assert.equal(q.kind, "question");
    assert.equal(q.category, UNPLACEABLE_CATEGORY);
    assert.deepEqual(q.target, { kind: "node", id: "n_pay" });
    assert.equal(q.assignment?.kind, "investigate", "handed to an agent");
    // The address the recovery arc takes as input.
    assert.match(q.text, /a_theirs/);
    assert.match(q.text, /c0ffee/, "the commit it was written at — where to go looking");
    assert.match(q.text, /minted under/, "and what derivation minted the ids");

    const inQueue = (await reviewQueue(root)).queue.find((x) => x.id === r.queued);
    assert.ok(inQueue, "and it is in the queue an agent already reads");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an answered question is not re-asked, and a changed doc revises the one open item", async () => {
  const root = await repo();
  try {
    await writeNode(root, node(), { hashes: foreign(), commit: "c0ffee", branch: "main" });
    const first = await ackHole(root, "n_pay") as any;

    // The agent reports back. Now it is waiting on a person, and `review_queue`
    // hides it by default — so calling it "queued" would point at nothing.
    await closeAssignment(root, { id: first.queued, result: "answered", detail: "the file was split in two; both halves are live" });
    const answered = await ackHole(root, "n_pay") as any;
    assert.equal(answered.alreadyAnswered, true);
    assert.equal(answered.alreadyQueued, undefined);
    assert.ok((await readAnnotations(root)).annotations.find((a) => a.id === first.queued)!.outcome,
      "and the answer nobody has read is still there");

    // A new version, citing something else this build cannot place. The ids in the
    // open question now describe a doc that no longer wins.
    const other = anchorIndex(new Map([["a_elsewhere", hashTokens(["b2"], THEIRS)]]), { tags: [THEIRS], anyUntagged: false });
    await writeNode(root, node({ anchors: ["a_elsewhere"], body: "rewritten" }), { hashes: other, commit: "beef", branch: "main" });

    const again = await ackHole(root, "n_pay") as any;
    assert.equal(again.queued, first.queued, "still one investigation per doc");
    assert.equal(again.revised, true);
    const q = (await readAnnotations(root)).annotations.find((a) => a.id === first.queued)!;
    assert.match(q.text, /a_elsewhere/, "it describes the version that wins now");
    assert.doesNotMatch(q.text, /a_theirs/);
    assert.ok(q.revisions?.length, "and what it used to say is kept");
    assert.equal(q.outcome, undefined, "the stale answer is cleared — it answered a different question");
    assert.equal(q.assignment?.kind, "investigate", "and it is asked again");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rewording the question does not throw away an answer", async () => {
  // The revise loop keys on an EVIDENCE digest, not on the rendered text. Comparing
  // prose would make a copy edit read as new evidence — revising an answered item
  // and re-assigning it, which clears the outcome nobody has read.
  const root = await repo();
  try {
    await writeNode(root, node(), { hashes: foreign(), commit: "c0ffee", branch: "main" });
    const first = await ackHole(root, "n_pay") as any;
    await closeAssignment(root, { id: first.queued, result: "answered", detail: "split in two; both halves live" });

    const store = await readAnnotations(root);
    const q = store.annotations.find((a) => a.id === first.queued)!;
    const key = /\[evidence ([0-9a-f]{12})\]/.exec(q.text)![1]!;
    // Every word except the key line rewritten, as a copy edit would.
    q.text = `Completely different wording.\n\n[evidence ${key}]`;
    await writeAnnotations(root, store.annotations);

    const again = await ackHole(root, "n_pay") as any;
    assert.equal(again.alreadyAnswered, true, "same evidence — still waiting on a person");
    assert.equal(again.revised, undefined);
    assert.ok((await readAnnotations(root)).annotations.find((a) => a.id === first.queued)!.outcome,
      "and the answer survived the rewording");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("asking twice does not queue it twice", async () => {
  // A HASH_SCHEME bump made 985 of 985 docs unverifiable at once. The queue is
  // entered by an ACT so it is bounded by attempts — which is worth nothing if one
  // node accumulates an entry per attempt.
  const root = await repo();
  try {
    await writeNode(root, node(), { hashes: foreign(), commit: "c0ffee", branch: "main" });
    const first = await ackHole(root, "n_pay") as any;
    const second = await ackHole(root, "n_pay") as any;
    assert.equal(second.queued, first.queued);
    assert.equal(second.alreadyQueued, true);
    assert.equal((await readAnnotations(root)).annotations.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a doc with live code and one foreign id is not queued — it needs a new version", async () => {
  // `unverifiable` does not mean nothing resolved: a citation that resolves and
  // matches is skipped silently, so a doc with live code and one foreign id lands
  // in the same status. Retiring that would hide code sitting in front of the
  // reader, and investigating it is the wrong ask — the answer is a new version.
  const root = await repo();
  try {
    const live = (await readAnchorStore(root)).anchors[0]!;
    const mixed = anchorIndex(
      new Map([["a_theirs", hashTokens(["body"], THEIRS)], [live.id, live.bodyHash]]),
      { tags: [THEIRS], anyUntagged: false },
    );
    await writeNode(root, node({ anchors: ["a_theirs", live.id] }), { hashes: mixed, commit: "c0ffee", branch: "main" });
    assert.equal((await loadNodes(root)).find((n) => n.id === "n_pay")!.status, "unverifiable",
      "precondition: one foreign id, one that resolves");

    const r = await ackHole(root, "n_pay") as any;
    assert.ok(r.error);
    assert.match(r.error, /still in this checkout/);
    assert.match(r.error, /write a new version/);
    assert.equal(r.queued, undefined, "and it is not an investigation");
    assert.deepEqual((await readAnnotations(root)).annotations, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("one absent citation does not license retiring the ones nobody could place", async () => {
  // The bug this guard exists for. `evalVersion` ranks dangling over unverifiable,
  // so a version with one gone citation and one foreign one reads `dangling` — and
  // the tombstone is built from the DANGLING ones alone, dropping the citation
  // nobody could place. That retires the whole doc on the comparable subset while
  // the code behind the foreign id may be sitting right there.
  const root = await repo();
  try {
    const live = (await readAnchorStore(root)).anchors[0]!;
    const mixed = anchorIndex(
      new Map([["a_theirs", hashTokens(["body"], THEIRS)], [live.id, live.bodyHash]]),
      { tags: [THEIRS], anyUntagged: false },
    );
    await writeNode(root, node({ anchors: ["a_theirs", live.id] }), { hashes: mixed, commit: "c0ffee", branch: "main" });
    // …and now the placeable one really is gone.
    writeFileSync(join(root, "src/pay.ts"), "export function moved(c: number) { return c; }\n");
    await init(root);
    assert.equal((await loadNodes(root)).find((n) => n.id === "n_pay")!.status, "dangling",
      "precondition: the headline status is dangling, which is what used to permit the write");

    const r = await ackHole(root, "n_pay") as any;
    assert.ok(r.error, "no tombstone while anything is unplaceable");
    assert.ok(r.queued, "queued instead");
    const q = (await readAnnotations(root)).annotations.find((a) => a.id === r.queued)!;
    assert.match(q.text, /a_theirs/, "it asks about the one nobody can place…");
    assert.doesNotMatch(q.text, new RegExp(live.id), "…and not about the one that is decidably gone");
    assert.ok((await loadNodes(root)).find((n) => n.id === "n_pay"),
      "the doc is still on the map — hiding it is the direction with no recovery");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a real hole is still acked, and the doc really is retired", async () => {
  // The control. Without it, "the refusal files work" would pass just as well if
  // every ack were refused — and asserting only the RETURN would pass if the
  // tombstone were never written.
  const root = await repo();
  try {
    const id = (await readAnchorStore(root)).anchors[0]!.id;
    await writeNode(root, node({ anchors: [id] }));
    writeFileSync(join(root, "src/pay.ts"), "export function moved(c: number) { return c; }\n");
    await init(root);

    const r = await ackHole(root, "n_pay") as any;
    assert.equal(r.ok, true, "this build minted that id, so its absence is real");
    assert.deepEqual(r.removedAnchors, [id]);
    assert.equal(r.queued, undefined);
    assert.deepEqual((await readAnnotations(root)).annotations, [], "and nothing was queued");
    assert.equal((await loadNodes(root)).find((n) => n.id === "n_pay"), undefined,
      "the tombstone was actually written and actually wins — the doc is off this branch's map");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a commit that is not HEAD can be indexed without checking it out", async () => {
  // The queue item tells an agent to do this when no locator survived, so the tool
  // has to actually reach a commit other than the one on disk.
  const root = await repo();
  try {
    const git = (...a: string[]) =>
      spawnSync("git", ["-c", "user.email=t@x", "-c", "user.name=t", ...a], { cwd: root, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-qm", "first");
    const first = git("rev-parse", "HEAD").stdout.trim();
    writeFileSync(join(root, "src/pay.ts"), "export function renamed(c: number) { return c; }\n");
    git("commit", "-qam", "second");

    const r = await snapshotAt(root, first) as any;
    assert.equal(r.ok, true);
    assert.equal(r.ref, first);
    assert.ok(r.anchors > 0, "it read the tree at that commit, not the one on disk");
    const snap = await readSnapshot(root, first);
    assert.ok(snap!.some((a) => a.symbolPath.join(".") === "transfer"),
      "the symbol as it was there — which is the whole point of asking a commit you are not on");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
