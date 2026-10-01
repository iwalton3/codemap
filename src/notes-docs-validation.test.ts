/**
 * Validation for the notes and docs scopes (plan 3.1, 3.2): a staged act replays against the
 * tip and is refused when the tip no longer meets its precondition; a refused LINEAR event
 * read back is damage and a merge-era one is skipped; a note on a proposal names law that must
 * exist (docs/sidecar-references.md, rows 84-85).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scenario, who, settle } from "./scenario.js";
import { readScope } from "./eventlog.js";
import { begin, syncSession, staged } from "./sync-engine.js";
import { createNote, resolveNote, notesForTarget, foldNotes, noteScope, bucketFor } from "./shared-notes.js";
import { publishDocVersion, readDocs, foldDocs, docScope } from "./shared-docs.js";
import { isLogDamage } from "./log-damage.js";
import { lockoutOf } from "./lockout.js";
import { testEvent } from "./test-events.js";
import { appendUnfolded } from "./test-door.js";
import { discard } from "./test-tmp.js";

const U = "acme/api";
const NOTE = { targetKind: "anchor" as const, targetId: "a_1", kind: "question" as const, text: "why does this round twice?" };

test("closing a note a teammate closed first lands as agreement at replay; the first close stands (P-identical)", async () => {
  const s = await scenario(["ana@x.com", "ben@x.com"]);
  try {
    const ana = who(s, "ana@x.com"), ben = who(s, "ben@x.com");
    const id = await createNote(ana.sidecar, U, ana.actor, NOTE);
    await settle(s);
    begin(ana.sidecar);
    await resolveNote(ana.sidecar, U, "a_1", ana.actor, id, true, "answered in the doc");
    await resolveNote(ben.sidecar, U, "a_1", ben.actor, id, true, "not a real question");
    const r = await syncSession(ana.sidecar, ana.actor);
    assert.ok(!("error" in r), `the same resulting state is not a conflict: ${JSON.stringify(r)}`);
    await settle(s);
    for (const p of [ana, ben]) {
      const n = (await notesForTarget(p.sidecar, U, "a_1"))[0]!;
      assert.equal(n.resolved?.reason, "not a real question", "one close, ben's");
      assert.deepEqual(n.agreements?.map((a) => a.by.principal), ["ana@x.com"], "ana's is her agreement");
      assert.equal(lockoutOf(p.sidecar), null);
    }
  } finally { s.dispose(); }
});

const DOC = { nodeId: "n_pay", type: "concept", title: "Payments", summary: "s", body: "ana's", citations: [{ anchorId: "a_1", acceptedHashes: [] }] };

test("a version id a teammate wrote first is refused at replay, and its author is told", async () => {
  const s = await scenario(["ana@x.com", "ben@x.com"]);
  try {
    const ana = who(s, "ana@x.com"), ben = who(s, "ben@x.com");
    begin(ana.sidecar);
    await publishDocVersion(ana.sidecar, U, ana.actor, { ...DOC, versionId: "nv_1" });
    await publishDocVersion(ben.sidecar, U, ben.actor, { ...DOC, body: "ben's", versionId: "nv_1" });
    const r = await syncSession(ana.sidecar, ana.actor);
    assert.ok("error" in r, "ana's version replays against ben's");
    assert.deepEqual(r.conflicts?.map((c) => c.kind), ["doc.version"]);
    assert.match(r.conflicts![0]!.why, /version nv_1 is already written/);
    assert.equal(staged(ana.sidecar).length, 1, "and it stays staged for her");
    await settle(s).catch(() => {});
    for (const p of [ana, ben]) {
      assert.equal((await readDocs(p.sidecar, U)).get("n_pay")!.versions[0]!.body, "ben's", "one version, ben's");
      assert.equal(lockoutOf(p.sidecar), null);
    }
    const onRemote = await readScope(ben.sidecar, docScope(U));
    assert.equal(onRemote.filter((e) => e.kind === "doc.version").length, 1, "the refused version never reached the remote");
  } finally { s.dispose(); }
});

test("on read: a refused LINEAR note or doc event is damage, a merge-era one is skipped", () => {
  const created = testEvent({ id: "e1", kind: "note.created", subject: "n1", data: NOTE, seq: 1 });
  const orphan = { kind: "note.answered", subject: "n_missing", data: { body: "hi" } };
  assert.throws(() => foldNotes([created, testEvent({ id: "e2", ...orphan, seq: 2 })]),
    (e: unknown) => isLogDamage(e) && e.entry.id === "e2" && /no note n_missing/.test(e.entry.why));
  assert.equal(foldNotes([created, testEvent({ id: "e2", ...orphan })]).size, 1, "no seq: dropped, as the merge-era fold did");

  const version = testEvent({ id: "e1", kind: "doc.version", subject: "n1", seq: 1,
    data: { version: { versionId: "nv1", nodeId: "n1", type: "concept", citations: [{ anchorId: "a_1", acceptedHashes: [] }] } } });
  const accept = { kind: "doc.accepted", subject: "n1", data: { versionId: "nv_missing", anchorId: "a_1", bodyHash: "h" } };
  assert.throws(() => foldDocs([version, testEvent({ id: "e2", ...accept, seq: 2 })]),
    (e: unknown) => isLogDamage(e) && e.entry.id === "e2" && /no version nv_missing/.test(e.entry.why));
  assert.equal(foldDocs([version, testEvent({ id: "e2", ...accept })]).get("n1")!.unmatched?.[0]?.why, "no-version",
    "no seq: retained as the merge-era fold did");
});

test("a note on a proposal names a spec or operation that has been drafted", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-ndv-"));
  const izzie = { principal: "izzie@x.com" };
  try {
    await assert.rejects(createNote(root, U, izzie, { targetKind: "spec", targetId: "sp_1", text: "too broad" }), /no spec sp_1 has been drafted/);
    await assert.rejects(createNote(root, U, izzie, { targetKind: "operation", targetId: "op_1", text: "where is T+1 from" }), /no operation op_1 has been drafted/);

    await appendUnfolded(root, "law/standard", izzie, "spec.drafted", "sp_1", { spec: { id: "sp_1" } });
    // A pre-split store keeps law in the universe's evidence scope.
    await appendUnfolded(root, `standard/${U}`, izzie, "spec.operation", "sp_1", { operation: { id: "op_1", specId: "sp_1" } });
    await createNote(root, U, izzie, { targetKind: "spec", targetId: "sp_1", text: "too broad" });
    await createNote(root, U, izzie, { targetKind: "operation", targetId: "op_1", text: "where is T+1 from" });
    assert.equal((await notesForTarget(root, U, "op_1")).length, 1);

    // A node with no published doc is local, not a foreign key (owner, Q2).
    await createNote(root, U, izzie, { targetKind: "node", targetId: "n_unpublished", text: "x" });
    assert.equal((await notesForTarget(root, U, "n_unpublished")).length, 1);
  } finally { discard(root); }
});
