/**
 * The tool-surface ergonomics fixes, at the layer that actually does the work.
 *
 * Each of these closes a defect an agent hits mid-task rather than a wrong answer:
 * a record it holds an id for and cannot read, an identity silently replaced with a
 * literal, and two flagship reads that had no way to ask for less.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { document, annotate, reviewQueue, flow } from "./ops.js";
import { markReviewed, markReviewedBatch } from "./reviews.js";
import { readReviews, writeStore } from "./store.js";
import { indexBlob } from "./repo.js";
import type { State } from "./schema.js";
import { discard } from "./test-tmp.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;

const LINES = (n: number) => Array.from({ length: n }, (_, i) => `  const step${i} = ${i} + cents;`).join("\n");
const SRC = `export function charge(cents) {
${LINES(40)}
  return cents;
}
export function refund(cents) {
${LINES(40)}
  return -cents;
}
`;

async function universe() {
  const root = mkdtempSync(join(tmpdir(), "codemap-tools-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/pay.js"), SRC, "utf8");
  const indexed = await indexBlob(SRC, "src/pay.js");
  await writeStore(root, indexed, state);
  return { root, anchors: indexed.map((a) => a.id), cleanup: () => discard(root) };
}

// ---------------------------------------------------------------------------
// An id you were handed must be dereferenceable.
// ---------------------------------------------------------------------------

test("a finding id can be read back on its own, without re-paging the list", async () => {
  const u = await universe();
  try {
    const ids: string[] = [];
    for (const [i, aid] of u.anchors.entries()) {
      const a = await annotate(u.root, {
        targetKind: "anchor", targetId: aid, kind: "question",
        text: `question number ${i}`,
      }) as { id: string };
      ids.push(a.id);
    }
    const all = await reviewQueue(u.root, { assignedOnly: false }) as any;
    assert.equal(all.queue.length, 2, "both are on the map");

    const one = await reviewQueue(u.root, { assignedOnly: false, ids: [ids[1]!] }) as any;
    assert.equal(one.queue.length, 1, "restricted to exactly the id asked for");
    assert.equal(one.queue[0].id, ids[1]);
    assert.match(one.queue[0].textPreview, /question number 1/);

    // The path the `shared_findings` description now names: id + brief:false is
    // how you read ONE record in full instead of taking the whole set.
    const infull = await reviewQueue(u.root, { assignedOnly: false, ids: [ids[1]!], brief: false }) as any;
    assert.equal(infull.queue.length, 1);
    assert.match(infull.queue[0].text, /question number 1/, "the full record, not a preview");
  } finally { u.cleanup(); }
});

test("an id lookup still finds a record somebody has resolved", async () => {
  // The failure this guards: you hold an id, ask for it, and are told nothing
  // exists — because a filter meant for LISTING was applied to a dereference.
  const u = await universe();
  try {
    const a = await annotate(u.root, {
      targetKind: "anchor", targetId: u.anchors[0]!, kind: "question", text: "answered already",
    }) as { id: string };
    const { resolveAnnotation } = await import("./ops.js");
    await resolveAnnotation(u.root, a.id);

    const listed = await reviewQueue(u.root, { assignedOnly: false }) as any;
    assert.equal(listed.queue.length, 0, "correctly absent from the default LIST");
    const got = await reviewQueue(u.root, { assignedOnly: false, ids: [a.id], includeResolved: true }) as any;
    assert.equal(got.queue.length, 1, "and still reachable by id");
  } finally { u.cleanup(); }
});

// ---------------------------------------------------------------------------
// Who did it.
// ---------------------------------------------------------------------------

test("an omitted reviewer resolves to the actor's identity, not a literal", async () => {
  const u = await universe();
  try {
    await document(u.root, {
      id: "payments", type: "module", title: "Payments", summary: "charge and refund",
      anchors: u.anchors,
    });
    process.env.CODEMAP_AGENT_MODEL = "claude-opus-5";
    try {
      // Exactly what `sanity_check` now passes: reviewer undefined, actor agent.
      await markReviewed(u.root, {
        targetKind: "node", targetId: "payments", level: "logical",
        reviewer: undefined, actor: "agent",
      });
    } finally { delete process.env.CODEMAP_AGENT_MODEL; }

    const { reviews } = await readReviews(u.root);
    const r = reviews.find((x) => x.target.id === "payments")!;
    assert.ok(r, "the review was recorded");
    assert.notEqual(r.reviewer, "agent",
      "the literal is what the old sanity_check wrote — it names nobody");
    assert.match(r.reviewer!, /claude-opus-5/, "the model that did it is on the record");
    assert.equal(r.actor, "agent", "and agent-ness is still carried by `actor`");
  } finally { u.cleanup(); }
});

// ---------------------------------------------------------------------------
// Asking for less.
// ---------------------------------------------------------------------------

test("flow brief drops the inlined source and keeps the shape", async () => {
  const u = await universe();
  try {
    await document(u.root, {
      id: "checkout", type: "process", title: "Checkout", summary: "take money",
      anchors: u.anchors,
      steps: [
        { id: "s-charge", title: "Charge", summary: "take the money", anchors: [u.anchors[0]!] },
        { id: "s-refund", title: "Refund", summary: "give it back", anchors: [u.anchors[1]!] },
      ] as never,
    });

    const full = await flow(u.root, "checkout") as any;
    const lean = await flow(u.root, "checkout", { brief: true }) as any;
    assert.equal(full.steps.length, 2, "the fixture really has steps to walk");

    const anchorsOf = (f: any) => f.steps.flatMap((s: any) => s.anchors);
    assert.ok(anchorsOf(full).some((a: any) => typeof a.code === "string" && a.code.includes("cents")),
      "the full form inlines source — otherwise this test proves nothing");
    assert.ok(anchorsOf(lean).every((a: any) => !("code" in a)), "brief inlines none of it");

    // The shape a caller orients by must survive.
    for (const s of lean.steps) {
      assert.ok(s.title && s.summary && Array.isArray(s.anchors) && s.review);
      for (const a of s.anchors) assert.ok(a.file && a.symbol, "still says WHICH code");
    }
    assert.ok(JSON.stringify(lean).length * 2 < JSON.stringify(full).length,
      "and it is materially smaller, not merely different");
  } finally { u.cleanup(); }
});

// ---------------------------------------------------------------------------
// Reviewing a pull request must witness the code that was READ.
// ---------------------------------------------------------------------------

test("a batch review at a ref witnesses that commit, not the working tree", async () => {
  const u = await universe();
  try {
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "user.email=t@x.com", "-c", "user.name=t", ...args], { cwd: u.root, encoding: "utf8" });
    git("add", "-A"); git("commit", "-q", "-m", "head");
    const head = git("rev-parse", "HEAD").stdout.trim();
    assert.ok(head, "the fixture has a commit to witness at");
    const { snapshotAt } = await import("./ops.js");
    await snapshotAt(u.root, head);

    // Now the working tree diverges — the situation a PR review is always in.
    // Deliberately NOT reindexing: `reindex` on a dirty tree re-caches HEAD's
    // snapshot from the working tree, which is the separate defect covered below.
    writeFileSync(join(u.root, "src/pay.js"), SRC.replace("return cents;", "return cents * 3;"), "utf8");

    await markReviewedBatch(u.root, u.anchors, { level: "code", actor: "agent", ref: head });
    const { reviews } = await readReviews(u.root);
    const marks = reviews.filter((r) => u.anchors.includes(r.target.id));
    assert.equal(marks.length, u.anchors.length, "every anchor in the batch was marked in ONE call");

    // The witness must be the ref's body. Compare against what @work holds now:
    // if they were equal the test could not tell the two apart.
    const { liveHashes } = await import("./reviews.js");
    const atHead = await liveHashes(u.root, u.anchors, head);
    const atWork = await liveHashes(u.root, u.anchors);
    const changed = u.anchors.find((id) => atHead.get(id) !== atWork.get(id))!;
    assert.ok(changed, "the working tree really did diverge — otherwise this proves nothing");

    const w = marks.find((r) => r.target.id === changed)!.witnesses!
      .find((x) => x.anchorId === changed)!;
    assert.equal(w.bodyHash, atHead.get(changed), "witnessed the ref");
    assert.notEqual(w.bodyHash, atWork.get(changed), "and NOT the working tree");
  } finally { u.cleanup(); }
});

test("witnessing at a ref refuses a snapshot indexed from a dirty tree", async () => {
  // `reindex` re-caches HEAD's snapshot from the WORKING TREE and labels it dirty
  // (`dirtySnapshot: true`). Nothing on the witnessing path read that label, so a
  // reindex on a dirty checkout silently replaced the head's bodies with the
  // working tree's — and a later `review(ref: head)` then recorded exactly the body
  // the `ref` was passed to avoid. `diff` already refuses this snapshot (COD-3);
  // this is the same refusal one layer over.
  const u = await universe();
  try {
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "user.email=t@x.com", "-c", "user.name=t", ...args], { cwd: u.root, encoding: "utf8" });
    git("add", "-A"); git("commit", "-q", "-m", "head");
    const head = git("rev-parse", "HEAD").stdout.trim();
    const { snapshotAt, reindex } = await import("./ops.js");
    await snapshotAt(u.root, head);

    // Clean snapshot: witnessing works.
    await markReviewedBatch(u.root, u.anchors, { level: "code", actor: "agent", ref: head });

    writeFileSync(join(u.root, "src/pay.js"), SRC.replace("return cents;", "return cents * 3;"), "utf8");
    const r = await reindex(u.root) as any;
    assert.equal(r.dirtySnapshot, true, "reindex knows it cached a dirty tree under this sha");

    await assert.rejects(
      () => markReviewedBatch(u.root, u.anchors, { level: "code", actor: "agent", ref: head }),
      /uncommitted changes/,
      "and witnessing against it is now refused rather than silently wrong",
    );
  } finally { u.cleanup(); }
});
