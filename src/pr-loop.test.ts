import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { State } from "./schema.js";
import { writeStore, readAnnotations } from "./store.js";
import { annotate, assignAnnotation, reviewQueue, closeAssignment, resolveAnnotation } from "./ops.js";
import { indexBlob } from "./repo.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codemap-loop-"));
  mkdirSync(join(root, "src"));
  const src = "export function transfer(cents: number) {\n  if (cents < 0) throw new Error('neg');\n  return cents;\n}\n";
  writeFileSync(join(root, "src/pay.ts"), src);
  const anchors = await indexBlob(src, "src/pay.ts");
  await writeStore(root, anchors, state);
  const id = anchors.find((a) => a.symbolPath.join(".") === "transfer")!.id;
  const r = await annotate(root, { targetKind: "anchor", targetId: id, text: "negative amounts are only guarded here", kind: "finding", severity: "high", category: "Logic", line: 2, author: "me" }) as any;
  return { root, anchorId: id, annId: r.id as string };
}

test("an unassigned finding is not in the agent's queue", async () => {
  const { root } = await fixture();
  try {
    assert.deepEqual((await reviewQueue(root)).queue, [], "raising a finding records it; it does not ask for anything");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("assigning hands it over with the symbol's current source attached", async () => {
  const { root, annId } = await fixture();
  try {
    await assignAnnotation(root, { id: annId, kind: "investigate", by: "me" });
    const { queue } = await reviewQueue(root);
    assert.equal(queue.length, 1);
    assert.equal(queue[0]!.assignment.kind, "investigate");
    assert.equal(queue[0]!.file, "src/pay.ts");
    assert.match(queue[0]!.symbol!, /transfer/);
    assert.match(queue[0]!.code!, /throw new Error/, "the agent gets the code, not just a pointer to it");
    assert.equal(queue[0]!.line, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a fix spanning more than one file is refused, with what to do instead", async () => {
  const { root, annId } = await fixture();
  try {
    await assignAnnotation(root, { id: annId, kind: "fix" });
    const r = await closeAssignment(root, { id: annId, result: "fixed", detail: "guarded both call sites", files: ["src/pay.ts", "src/ledger.ts"] }) as any;
    assert.ok(r.error, "a two-file fix must not be accepted");
    assert.match(r.error, /one file/);
    assert.equal((await readAnnotations(root)).annotations[0]!.outcome, undefined, "and nothing is recorded");

    // declining with a reason IS the useful answer
    const ok = await closeAssignment(root, { id: annId, result: "declined", detail: "needs a matching guard in ledger.ts — two files" }) as any;
    assert.ok(ok.ok);
    assert.equal((await readAnnotations(root)).annotations[0]!.outcome!.result, "declined");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reporting back does not resolve the finding — the human closes it", async () => {
  const { root, annId } = await fixture();
  try {
    await assignAnnotation(root, { id: annId, kind: "fix" });
    const r = await closeAssignment(root, { id: annId, result: "fixed", detail: "added the guard", files: ["src/pay.ts"] }) as any;
    assert.equal(r.awaitingHuman, true);

    const ann = (await readAnnotations(root)).annotations[0]!;
    assert.equal(ann.outcome!.result, "fixed");
    assert.notEqual(ann.resolved, true, "an agent must not mark its own work accepted");

    // and it leaves the agent's queue, because it is now waiting on a person
    assert.deepEqual((await reviewQueue(root)).queue, []);
    assert.equal((await reviewQueue(root, { includeAnswered: true })).queue.length, 1);

    await resolveAnnotation(root, annId, true);
    assert.equal((await readAnnotations(root)).annotations[0]!.resolved, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("re-assigning an answered finding asks again and drops the stale answer", async () => {
  const { root, annId } = await fixture();
  try {
    await assignAnnotation(root, { id: annId, kind: "investigate" });
    await closeAssignment(root, { id: annId, result: "answered", detail: "looks fine to me" });
    await assignAnnotation(root, { id: annId, kind: "fix", note: "not convinced — guard it" });

    const ann = (await readAnnotations(root)).annotations[0]!;
    assert.equal(ann.outcome, undefined, "the previous answer no longer stands");
    assert.equal(ann.assignment!.kind, "fix");
    assert.equal((await reviewQueue(root)).queue.length, 1, "and it is back on the agent's queue");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a resolved finding cannot be assigned", async () => {
  const { root, annId } = await fixture();
  try {
    await resolveAnnotation(root, annId, true);
    const r = await assignAnnotation(root, { id: annId, kind: "fix" }) as any;
    assert.ok(r.error);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
