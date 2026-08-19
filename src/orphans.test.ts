import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { annotate, reindex, orphanedWork, getAnchor, reviewQueue, assignAnnotation } from "./ops.js";
import { readAnnotations } from "./store.js";

/**
 * A reindex used to delete anchors the new index did not produce, taking every
 * finding on them with it. That is not an edge case: an anchor id is
 * file + symbol path + signature, so a rename, a deletion, or a change to an
 * overload's parameter list is enough — and the overloads in an event-sourced
 * codebase (`Apply(SomeEvent)`) are exactly the code people file findings about.
 *
 * It had already destroyed a batch of findings once when this was written.
 */
const write = (root: string, body: string) => writeFileSync(join(root, "src/pay.ts"), body);

async function repo() {
  const root = mkdtempSync(join(tmpdir(), "codemap-orphan-"));
  mkdirSync(join(root, "src"));
  write(root, "export function transfer(cents: number) {\n  return cents;\n}\n");
  await reindex(root);
  return root;
}

test("a reindex that drops an anchor somebody filed against does not lose it", async () => {
  const root = await repo();
  try {
    const anchors = (await import("./store.js")).readAnchorStore;
    const id = (await anchors(root)).anchors.find((a) => a.symbolPath.join(".") === "transfer")!.id;
    const f = await annotate(root, {
      targetKind: "anchor", targetId: id, text: "no guard on negatives",
      comment: "`transfer` accepts negative cents", kind: "finding", severity: "high", author: "me",
    }) as { id: string };

    // rename the symbol — a new anchor id, and the old one gone from the tree
    write(root, "export function transferFunds(cents: number) {\n  return cents;\n}\n");
    const r = await reindex(root) as { orphans?: { retained: number } };
    assert.equal(r.orphans?.retained, 1, "the reindex says what it stranded");

    // the finding is untouched and its target is still readable
    const ann = (await readAnnotations(root)).annotations.find((a) => a.id === f.id)!;
    assert.equal(ann.target.id, id, "nothing rewrote the finding");
    const a = await getAnchor(root, id) as any;
    assert.equal(a.error, undefined, "the target still resolves");
    assert.equal(a.orphaned, true);
    assert.match(a.orphanedNote, /no longer in the working tree/);
    assert.match(a.orphanedNote, /may exist on a branch/, "…and does not claim it was deleted");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the sweep says what broke, and whether it can be recovered", async () => {
  const root = await repo();
  try {
    const { readAnchorStore } = await import("./store.js");
    const id = (await readAnchorStore(root)).anchors[0]!.id;
    await annotate(root, {
      targetKind: "anchor", targetId: id, text: "e", comment: "the credit gate is not enforced",
      kind: "finding", author: "me",
    });
    assert.equal((await orphanedWork(root)).total, 0, "nothing is broken yet");

    write(root, "export function transferFunds(cents: number) {\n  return cents;\n}\n");
    await reindex(root);

    const o = await orphanedWork(root);
    assert.equal(o.total, 1);
    assert.equal((o.retained[0] as any).file, "src/pay.ts", "with the file it was in");
    assert.match((o.retained[0] as any).symbol, /transfer/);
    assert.match((o.retained[0] as any).label, /credit gate/, "and enough of the finding to recognise it");
    assert.equal(o.lost.length, 0, "retained, not lost — the distinction is the point");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a symbol that comes back is live code again, not a retained ghost", async () => {
  // A branch checked out, a revert, a rename undone. Leaving the retained copy
  // beside the live one would give two answers to what the id means.
  const root = await repo();
  try {
    const { readAnchorStore } = await import("./store.js");
    const id = (await readAnchorStore(root)).anchors[0]!.id;
    await annotate(root, { targetKind: "anchor", targetId: id, text: "e", comment: "c", kind: "finding", author: "me" });

    write(root, "export function transferFunds(cents: number) {\n  return cents;\n}\n");
    await reindex(root);
    assert.equal((await orphanedWork(root)).total, 1);

    write(root, "export function transfer(cents: number) {\n  return cents;\n}\n");
    const back = await reindex(root) as { orphans?: { recovered: number } };
    assert.equal(back.orphans?.recovered, 1);
    assert.equal((await orphanedWork(root)).total, 0);
    assert.equal(((await getAnchor(root, id)) as any).orphaned, undefined, "it is ordinary live code again");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a dangling target is flagged in the queue rather than served silently", async () => {
  // `review_queue` returned a target that `annotate` and `get_anchor` both rejected,
  // with nothing marking it dead — so an agent could work from it and never find out.
  const root = await repo();
  try {
    const { readAnchorStore } = await import("./store.js");
    const id = (await readAnchorStore(root)).anchors[0]!.id;
    const f = await annotate(root, { targetKind: "anchor", targetId: id, text: "e", comment: "c", kind: "finding", author: "me" }) as { id: string };
    await assignAnnotation(root, { id: f.id, kind: "investigate", by: "me" });

    assert.equal((await reviewQueue(root)).queue[0]!.targetResolved, undefined, "live targets say nothing");

    write(root, "export function transferFunds(cents: number) {\n  return cents;\n}\n");
    await reindex(root);

    const q = (await reviewQueue(root)).queue[0]!;
    assert.equal(q.targetResolved, false);
    assert.equal(q.targetAt, "@orphan", "and where the last record of it is");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an orphaned anchor can still be filed against, so stranded work is reachable", async () => {
  // Re-filing against code the tree no longer has is exactly what someone needs when
  // a reindex has stranded a finding. Refusing it leaves the work unreachable rather
  // than safe — one pointer could not be re-issued as a finding for this reason.
  const root = await repo();
  try {
    const { readAnchorStore } = await import("./store.js");
    const id = (await readAnchorStore(root)).anchors[0]!.id;
    await annotate(root, { targetKind: "anchor", targetId: id, text: "e", comment: "c", kind: "pointer", author: "me" });

    write(root, "export function transferFunds(cents: number) {\n  return cents;\n}\n");
    await reindex(root);

    const re = await annotate(root, {
      targetKind: "anchor", targetId: id, text: "supersedes the pointer",
      comment: "the credit gate is not enforced", kind: "finding", author: "me",
    }) as any;
    assert.ok(!re.error, re.error);
    const ann = (await readAnnotations(root)).annotations.find((a) => a.id === re.id)!;
    assert.equal(ann.sourceRef, "@orphan", "and it says the body it witnessed is the last one anybody saw");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
