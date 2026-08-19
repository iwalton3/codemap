import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { State } from "./schema.js";
import { writeStore, readAnnotations, writeAnnotations, writeSnapshot } from "./store.js";
import { withLock } from "./lock.js";
import { annotate, assignAnnotation, reviewQueue, closeAssignment, resolveAnnotation, escalateAnnotation, anchorAnnotations, reviseAnnotation, withdrawAnnotation } from "./ops.js";
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
  const r = await annotate(root, { targetKind: "anchor", targetId: id, text: "negative amounts are only guarded here", comment: "`transfer` guards negatives at pay.ts:2 only; the by-id path does not. Add the same check.", kind: "finding", severity: "high", category: "Logic", line: 2, author: "me" }) as any;
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
    const { queue } = await reviewQueue(root, { brief: false });
    assert.equal(queue.length, 1);
    assert.equal(queue[0]!.assignment!.kind, "investigate");
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
    comment: "`transfer` sums into an int32; a large batch overflows silently.",
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
    targetKind: "anchor", targetId: anchorId, text: "second", comment: "second", kind: "finding", author: "human",
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

test("an agent cannot record an outcome on a finding the human closed meanwhile", async () => {
  // `assignAnnotation` refuses a resolved annotation for the same reason. An agent
  // holding a queue read from before the close would otherwise stamp an outcome over
  // the record of what happened at close time — and `reviewQueue` filters resolved
  // items out, so the write would be invisible afterwards.
  const { root, annId } = await fixture();
  await assignAnnotation(root, { id: annId, kind: "investigate", by: "me" });
  await resolveAnnotation(root, annId, true);

  const r = await closeAssignment(root, { id: annId, result: "answered", detail: "late", by: "agent" }) as any;
  assert.ok(r.error, "closing a resolved finding is refused");
  assert.match(r.error, /resolved/i);
  assert.equal((await readAnnotations(root)).annotations.find((a) => a.id === annId)!.outcome, undefined);
});

// ---------------------------------------------------------------------------
// The submitter-facing half of a finding
// ---------------------------------------------------------------------------

test("a finding must carry the short version, written when the evidence is", async () => {
  const { root, anchorId } = await fixture();
  try {
    // Twelve findings in the session that motivated this were filed with rich
    // evidence and no short form, because none was asked for — and all twelve were
    // then rewritten by hand for GitHub. Optional means skipped.
    const bare = await annotate(root, {
      targetKind: "anchor", targetId: anchorId, text: "no tenant predicate on the by-id branch", kind: "finding",
    }) as any;
    assert.match(bare.error, /needs `comment`/);

    // notes and pointers are not claims aimed at anybody, so they carry no such duty
    for (const kind of ["note", "pointer", "question"] as const) {
      const r = await annotate(root, { targetKind: "anchor", targetId: anchorId, text: "x", kind }) as any;
      assert.ok(r.ok, kind);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an over-long comment is refused, never truncated", async () => {
  const { root, anchorId } = await fixture();
  try {
    // A comment cut at the cap loses its LAST sentence, which by the contract is the
    // ask — the one part the person fixing it actually needs.
    const r = await annotate(root, {
      targetKind: "anchor", targetId: anchorId, text: "evidence", kind: "finding",
      comment: "x".repeat(801),
    }) as any;
    assert.match(r.error, /801 characters.*cap is 800/);
    assert.match(r.error, /`text`/, "and says where the investigation belongs");
    assert.equal((await anchorAnnotations(root, anchorId)).length, 1, "nothing was stored");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a finding can be corrected, and what it used to say survives", async () => {
  const { root, annId } = await fixture();
  try {
    // Findings are filed before they are understood: the correction has to be
    // visible AS a correction, which is when you most want to see what changed.
    const r = await reviseAnnotation(root, {
      id: annId, by: "agent:verify", disposition: "rerated", severity: "medium",
      comment: "Real, but narrower than filed: the by-id branch is unreachable without the operator claim.",
    }) as any;
    assert.deepEqual(r.changed.sort(), ["comment", "disposition", "severity"]);

    const a = (await readAnnotations(root)).annotations.find((x) => x.id === annId)!;
    assert.equal(a.disposition, "rerated");
    assert.equal(a.severity, "medium");
    assert.equal(a.revisions!.length, 1);
    assert.equal(a.revisions![0]!.by, "agent:verify");
    assert.equal(a.revisions![0]!.was.severity, "high", "what it was filed as is still readable");
    assert.match(a.revisions![0]!.was.comment!, /by-id path does not/);

    // a revision that changes nothing does not manufacture history
    const noop = await reviseAnnotation(root, { id: annId, disposition: "rerated" }) as any;
    assert.deepEqual(noop.changed, []);
    assert.equal((await readAnnotations(root)).annotations.find((x) => x.id === annId)!.revisions!.length, 1);

    assert.match((await reviseAnnotation(root, { id: annId, disposition: "bogus" as never }) as any).error, /unknown disposition/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("revising something the submitter can already see is refused by default", async () => {
  const { root, annId } = await fixture();
  try {
    const store = await readAnnotations(root);
    store.annotations.find((a) => a.id === annId)!.postedRef = { pr: 264, at: "now", placement: "inline", url: "https://x/1" };
    await writeAnnotations(root, store.annotations);

    // The map and the pull request disagreeing about what was said is bad in a
    // specific way: the PR is the copy the other person is acting on.
    const r = await reviseAnnotation(root, { id: annId, comment: "actually never mind" }) as any;
    assert.match(r.error, /already posted to PR #264/);

    const forced = await reviseAnnotation(root, { id: annId, comment: "actually never mind", allowPostEdit: true }) as any;
    assert.deepEqual(forced.changed, ["comment"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("withdrawing keeps a finding on the map and off the pull request", async () => {
  const { root, annId } = await fixture();
  try {
    // Distinct from resolving: it may still be true and still worth having.
    assert.equal((await withdrawAnnotation(root, { id: annId, by: "izzie", reason: "duplicate of finding_x, already on the PR" }) as any).withdrawn, true);
    const a = () => readAnnotations(root).then((s) => s.annotations.find((x) => x.id === annId)!);
    assert.equal((await a()).withdrawn!.by, "izzie");
    // The reason IS the record: "withdrawn" alone is indistinguishable from
    // "forgotten", and the usual reason names what superseded it.
    assert.match((await a()).withdrawn!.reason!, /duplicate of finding_x/);
    assert.equal((await a()).resolved, false, "withdrawn is not closed");

    assert.equal((await withdrawAnnotation(root, { id: annId, withdraw: false }) as any).withdrawn, false);
    assert.equal((await a()).withdrawn, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reporting back can carry the short version, and records what it displaced", async () => {
  const { root, annId } = await fixture();
  try {
    await assignAnnotation(root, { id: annId, kind: "investigate", by: "me" });
    // `result` is what the AGENT DID; `disposition` is what turned out to be TRUE.
    // A false positive is `answered` + `refuted` — the agent did answer.
    const r = await closeAssignment(root, {
      id: annId, result: "answered", detail: "traced every caller; the receiver cannot be null here",
      disposition: "refuted", comment: "Withdrawing this — it is an extension method, so a null receiver cannot throw.",
    }) as any;
    assert.equal(r.disposition, "refuted");

    const a = (await readAnnotations(root)).annotations.find((x) => x.id === annId)!;
    assert.equal(a.outcome!.result, "answered");
    assert.equal(a.revisions!.length, 1, "the investigation changing the answer leaves the same trail");
    assert.match(a.revisions![0]!.was.comment!, /by-id path does not/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the queue is brief by default, because the full form could not be read at all", async () => {
  const { root, annId } = await fixture();
  try {
    // The first real call returned 100,882 characters and blew the token limit
    // outright: it inlines every anchor's source. The work could not start until it
    // had been dumped to a file and mined with jq.
    await assignAnnotation(root, { id: annId, kind: "investigate", by: "me" });
    const brief = await reviewQueue(root);
    assert.equal(brief.queue.length, 1);
    assert.equal((brief.queue[0] as any).code, undefined, "no source inlined");
    assert.equal(brief.queue[0]!.text, undefined);
    assert.match(brief.queue[0]!.textPreview!, /negative amounts/);
    assert.equal(brief.queue[0]!.disposition, "confirmed", "a human writing it IS the assertion");
    assert.equal(brief.queue[0]!.publishState, "approved", "a human wrote it, so it is theirs to publish");
    assert.match(brief.hint!, /brief:false/);

    assert.match((await reviewQueue(root, { brief: false })).queue[0]!.code!, /throw new Error/);

    // and it can be filtered and paged, which is what makes 248 items workable
    assert.equal((await reviewQueue(root, { disposition: "confirmed" })).queue.length, 1);
    assert.equal((await reviewQueue(root, { disposition: "open" })).queue.length, 0);
    assert.equal((await reviewQueue(root, { publishState: "local" })).queue.length, 0);
    const paged = await reviewQueue(root, { limit: 1, offset: 1 });
    assert.equal(paged.queue.length, 0);
    assert.equal(paged.total, 1, "the count is of everything, not of the page");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a finding records the body it was written against, and which ref that was", async () => {
  // An anchor id is path+symbol with no ref: the same `EmailTemplateService` on
  // every branch. That is what lets a review mark survive a rebase, and it is also
  // how a finding written while reading one branch lands on an anchor another
  // branch's review reads. The witness is what tells those apart afterwards.
  const { root, anchorId } = await fixture();
  try {
    const live = await annotate(root, {
      targetKind: "anchor", targetId: anchorId, text: "e", comment: "c", kind: "finding", author: "me",
    }) as any;
    const of = async (id: string) => (await readAnnotations(root)).annotations.find((a) => a.id === id)!;
    const fromWork = await of(live.id);
    assert.equal(fromWork.sourceRef, "@work", "the working tree, said out loud");
    assert.match(fromWork.witness!.bodyHash, /^sha256:/);
    assert.equal(fromWork.witness!.anchorId, anchorId);

    // ...and a finding raised against a branch snapshot witnesses THAT body
    const branchSrc = "export function transfer(cents: number) {\n  return cents * 2;\n}\n";
    const branch = await indexBlob(branchSrc, "src/pay.ts");
    await writeSnapshot(root, "prhead", "feature/x", branch, "2026-08-19T00:00:00Z");
    const onBranch = await annotate(root, {
      targetKind: "anchor", targetId: anchorId, text: "e", comment: "c", kind: "finding", author: "me", ref: "prhead",
    }) as any;
    const filed = await of(onBranch.id);
    assert.equal(filed.sourceRef, "prhead");
    assert.equal(filed.witness!.bodyHash, branch.find((a) => a.id === anchorId)!.bodyHash);
    assert.notEqual(filed.witness!.bodyHash, fromWork.witness!.bodyHash,
      "the two findings sit on the SAME anchor and witness different bodies — which is the whole point");

    // re-reading at a ref re-witnesses, which is how a blocked finding is cleared
    const revised = await reviseAnnotation(root, { id: live.id, ref: "prhead", by: "me" }) as any;
    assert.deepEqual(revised.changed, ["witness"]);
    const after = await of(live.id);
    assert.equal(after.sourceRef, "prhead");
    assert.equal(after.revisions![0]!.was.sourceRef, "@work", "and what it used to be witnessed against survives");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a published finding nobody was assigned is still findable", async () => {
  // `review_queue` lists what a human asked an agent to act on, so an assignment is
  // what puts something in it. A finding raised by `annotate` and posted to GitHub
  // had no assignment — and so appeared in no query at all, which is a hole under
  // the idempotency rule even though the dedupe itself reads `postedRef`.
  const { root, anchorId, annId } = await fixture();
  try {
    const loose = await annotate(root, {
      targetKind: "anchor", targetId: anchorId, text: "capacity guard", comment: "no capacity guard",
      kind: "finding", disposition: "confirmed", author: "human",
    }) as any;
    const store = await readAnnotations(root);
    store.annotations.find((a) => a.id === loose.id)!.postedRef =
      { pr: 264, at: "now", placement: "inline", commentId: 3816014418, url: "https://x/c" };
    await writeAnnotations(root, store.annotations);

    await assignAnnotation(root, { id: annId, kind: "investigate", by: "me" });
    const queue = await reviewQueue(root);
    assert.deepEqual(queue.queue.map((q) => q.id), [annId], "the assignment queue is unchanged");

    const all = await reviewQueue(root, { assignedOnly: false });
    assert.equal(all.total, 2);
    const posted = await reviewQueue(root, { assignedOnly: false, publishState: "posted" });
    assert.deepEqual(posted.queue.map((q) => q.id), [loose.id]);
    assert.equal(posted.queue[0]!.postedRef!.commentId, 3816014418, "with the comment it landed in");
    assert.equal(posted.queue[0]!.assignment, undefined, "and no assignment invented for it");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("what triage concluded outranks what the finding was called", async () => {
  // Six pointers on the first real batch carried `disposition: confirmed` and a
  // finished submitter-facing comment, and not one was ever OFFERED for publishing.
  // The highest-rated item in the whole review was invisible. A declined finding is
  // a decision; an unoffered one is a hole.
  const { root, anchorId } = await fixture();
  try {
    const p = await annotate(root, {
      targetKind: "anchor", targetId: anchorId, text: "watch the credit gate when reviewing this",
      kind: "pointer", author: "agent:pr-first-pass",
    }) as any;
    const of = async () => (await readAnnotations(root)).annotations.find((a) => a.id === p.id)!;
    assert.equal((await of()).disposition, "open", "an agent's is a proposal awaiting triage");

    // ...and triage can promote it, without it having to be re-filed as a `finding`
    await reviseAnnotation(root, { id: p.id, disposition: "confirmed", comment: "the credit gate is not enforced", by: "me" });
    assert.equal((await of()).disposition, "confirmed");
    assert.equal((await of()).kind, "pointer", "the kind it was filed under is history, not a verdict");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a field sent empty is cleared; one not sent at all is left alone", async () => {
  // These were the same case, so clearing a `publishPath` in the editor silently kept
  // the old one while the form showed it gone — and the comment would then have
  // published against a file nobody chose.
  const { root, annId } = await fixture();
  try {
    const of = async () => (await readAnnotations(root)).annotations.find((a) => a.id === annId)!;
    await reviseAnnotation(root, { id: annId, publishPath: "src/pay.ts", publishLine: 12, by: "me" });
    assert.equal((await of()).publishPath, "src/pay.ts");

    // not mentioned → untouched
    await reviseAnnotation(root, { id: annId, disposition: "confirmed", by: "me" });
    assert.equal((await of()).publishPath, "src/pay.ts");

    // sent empty → gone, and the old value is kept in the revision
    const r = await reviseAnnotation(root, { id: annId, publishPath: "", by: "me" }) as any;
    assert.deepEqual(r.changed, ["publishPath"]);
    const a = await of();
    assert.equal(a.publishPath, undefined);
    assert.equal(a.revisions!.at(-1)!.was.publishPath, "src/pay.ts");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an agent may close the question it answered, not the finding it reported on", async () => {
  // `close_finding` refuses to resolve, on the grounds that reporting and agreeing it
  // is closed are different acts. `resolve_question` took any annotation id, so the
  // same agent could reach the same state through the next door along — and
  // `resolved` also keeps a finding off the pull request for good, so it doubles as a
  // way to suppress one silently.
  const { root, anchorId, annId } = await fixture();
  try {
    const q = await annotate(root, {
      targetKind: "anchor", targetId: anchorId, text: "is the retry intended?", kind: "question", author: "agent:x",
    }) as any;

    const denied = await resolveAnnotation(root, annId, true, { actor: "agent" }) as any;
    assert.match(denied.error, /not a question/);
    assert.match(denied.error, /close_finding/, "and says what to do instead");
    assert.equal((await readAnnotations(root)).annotations.find((a) => a.id === annId)!.resolved, false);

    assert.equal((await resolveAnnotation(root, q.id, true, { actor: "agent" }) as any).ok, true, "its own question is fine");
    // the human keeps the full power — this is about who is acting, not about the kind
    assert.equal((await resolveAnnotation(root, annId, true) as any).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
