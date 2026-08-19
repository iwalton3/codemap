import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { State } from "./schema.js";
import { writeStore, readAnnotations, writeAnnotations } from "./store.js";
import { withLock } from "./lock.js";
import { annotate, assignAnnotation, reviewQueue, closeAssignment, resolveAnnotation, escalateAnnotation, anchorAnnotations } from "./ops.js";
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

test("the annotation blob is a whole-file read-modify-write — an interleave loses UNRELATED records", async () => {
  // Not a hypothetical: this is the exact shape of `closeAssignment`, `annotate`
  // and `resolveAnnotation` — read the whole blob, mutate, write the whole blob.
  // Interleaved, the loser does not lose a field, it loses somebody else's
  // annotation. The interleave is hand-rolled so the test is deterministic.
  const { root, anchorId } = await fixture();
  const asAgentSees = (await readAnnotations(root)).annotations;          // agent reads

  await annotate(root, { targetKind: "anchor", targetId: anchorId, text: "a human's note", kind: "note", author: "human" });
  await writeAnnotations(root, asAgentSees);                              // agent writes its stale copy

  const after = (await readAnnotations(root)).annotations;
  assert.equal(after.length, 1);
  assert.equal(after.find((a) => a.text === "a human's note"), undefined,
    "this is the lost update the write lock exists to prevent");
});

test("under the lock, a close and a concurrent annotate both survive", async () => {
  // `close_finding` was the one MCP write tool missing from `MUTATING`, so it was
  // the only one that could run the race above against a human's `/api/annotate`.
  const { root, anchorId, annId } = await fixture();
  await assignAnnotation(root, { id: annId, kind: "investigate", by: "me" });

  await Promise.all([
    withLock(root, () => closeAssignment(root, { id: annId, result: "answered", detail: "not reachable", by: "agent" })),
    withLock(root, () => annotate(root, { targetKind: "anchor", targetId: anchorId, text: "a human's note", kind: "note", author: "human" })),
  ]);

  const anns = (await readAnnotations(root)).annotations;
  assert.equal(anns.length, 2, "neither write may drop the other");
  assert.ok(anns.find((a) => a.id === annId)!.outcome, "the agent's outcome landed");
  assert.ok(anns.find((a) => a.text === "a human's note"), "and the human's annotation is still there");
});

test("raising a finding to the maintainer is a separate act from writing or resolving one", async () => {
  const { root, anchorId, annId } = await fixture();

  // the fixture's finding is the human's own — there is nothing to elect
  const own = await escalateAnnotation(root, { id: annId }) as any;
  assert.ok(own.error, "a finding you wrote is already yours to publish");

  const a = await annotate(root, {
    targetKind: "anchor", targetId: anchorId, text: "agent thinks this overflows",
    kind: "finding", severity: "high", author: "agent:pr-first-pass",
  }) as any;
  const find = async () => (await readAnnotations(root)).annotations.find((x) => x.id === a.id)!;
  assert.equal((await find()).escalated, undefined, "an agent's finding starts unraised");

  assert.equal((await escalateAnnotation(root, { id: a.id, by: "izzie" }) as any).ok, true);
  assert.equal((await find()).escalated!.by, "izzie");

  // and it can be taken back
  assert.equal((await escalateAnnotation(root, { id: a.id, escalate: false }) as any).ok, true);
  assert.equal((await find()).escalated, undefined);

  // a resolved finding is not something to send to anybody
  await resolveAnnotation(root, a.id, true);
  assert.ok((await escalateAnnotation(root, { id: a.id }) as any).error);
});

test("an annotation write reports the anchor's findings, so one symbol can be refreshed", async () => {
  // Raising, handing off, resolving and raising to the maintainer all reloaded the
  // whole PR story to learn what happened to one finding. Each write now says which
  // anchor it landed on; `anchorAnnotations` is what the caller refreshes with.
  const { root, anchorId, annId } = await fixture();

  const before = await anchorAnnotations(root, anchorId);
  assert.equal(before.length, 1);

  const raised = await annotate(root, {
    targetKind: "anchor", targetId: anchorId, text: "second", kind: "finding", author: "human",
  }) as any;
  assert.deepEqual(raised.target, { kind: "anchor", id: anchorId }, "the write says where it landed");

  const assigned = await assignAnnotation(root, { id: annId, kind: "investigate", by: "me" }) as any;
  assert.deepEqual(assigned.target, { kind: "anchor", id: anchorId });

  const resolved = await resolveAnnotation(root, raised.id, true) as any;
  assert.deepEqual(resolved.target, { kind: "anchor", id: anchorId });

  const after = await anchorAnnotations(root, anchorId);
  assert.equal(after.length, 2, "both findings, with their current state");
  assert.ok(after.find((a) => a.id === annId)!.assignment, "the handoff is visible");
  assert.equal(after.find((a) => a.id === raised.id)!.resolved, true);

  // and nothing from another anchor leaks in
  assert.ok(after.every((a) => a.target.id === anchorId));
});
