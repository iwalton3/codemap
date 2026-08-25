import { test } from "node:test";
import { testEvent } from "./test-events.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Actor } from "./schema.js";
import { sortEvents, type LogEvent } from "./eventlog.js";
import {
  createNote, answerNote, resolveNote, notesForTarget, allNotes, foldNotes,
  bucketFor, noteScope,
} from "./shared-notes.js";
import * as shared from "./ops-shared.js";
import { annotate } from "./ops.js";
import { resolveSidecar } from "./sidecar-config.js";

const izzie: Actor = { principal: "izzie@x.com" };
const dana: Actor = { principal: "dana@x.com" };
const opus: Actor = { principal: "izzie@x.com", via: { kind: "agent", model: "claude-opus-5" } };

const tmp = (t: string) => mkdtempSync(join(tmpdir(), `codemap-sn-${t}-`));
const U = "acme/api";

const NEW = { targetKind: "anchor" as const, targetId: "a_1", text: "why the obvious refactor here is wrong" };

// --- bucketing ------------------------------------------------------------------

test("a target's notes always land in one bucket, so a page view is one read", () => {
  assert.equal(bucketFor("a_1"), bucketFor("a_1"));
  assert.match(bucketFor("a_1"), /^[0-9a-f]{2}$/);
  assert.equal(noteScope(U, bucketFor("a_1")), `notes/${U}/${bucketFor("a_1")}`);
});

test("universes do not share a note scope", () => {
  assert.notEqual(noteScope("acme/api", "ab"), noteScope("acme/settlement", "ab"));
});

// --- the log ---------------------------------------------------------------------

test("a note is readable by its target", async () => {
  const root = tmp("log");
  try {
    const id = await createNote(root, U, izzie, NEW);
    const notes = await notesForTarget(root, U, "a_1");
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.id, id);
    assert.equal(notes[0]!.author.principal, "izzie@x.com");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("notes about other symbols do not leak into a target's list", async () => {
  const root = tmp("iso");
  try {
    await createNote(root, U, izzie, NEW);
    await createNote(root, U, izzie, { ...NEW, targetId: "a_2", text: "different symbol" });
    assert.equal((await notesForTarget(root, U, "a_1")).length, 1);
    assert.equal((await allNotes(root, U)).length, 2, "both are still in the universe");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("answers are append-only and keep every voice", async () => {
  const root = tmp("ans");
  try {
    const id = await createNote(root, U, izzie, { ...NEW, kind: "question", text: "is this reachable?" });
    await answerNote(root, U, "a_1", dana, id, "yes, via the webhook path");
    await answerNote(root, U, "a_1", opus, id, "and the retry loop");
    const n = (await notesForTarget(root, U, "a_1"))[0]!;
    assert.equal(n.answers.length, 2);
    assert.equal(n.answers[1]!.actor.via?.model, "claude-opus-5");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an agent may answer a question and may not declare it settled", async () => {
  // Same act, same rule, as closing a finding: enforced in the FOLD, so a client
  // that emits it anyway is ignored by every reader rather than just its own.
  const root = tmp("agent");
  try {
    const id = await createNote(root, U, izzie, { ...NEW, kind: "question" });
    await answerNote(root, U, "a_1", opus, id, "answered");
    await resolveNote(root, U, "a_1", opus, id, true);
    const n = (await notesForTarget(root, U, "a_1"))[0]!;
    assert.equal(n.answers.length, 1, "the answer landed");
    assert.equal(n.resolved, undefined, "the close did not");

    await resolveNote(root, U, "a_1", izzie, id, true, "documented in the node");
    assert.equal((await notesForTarget(root, U, "a_1"))[0]!.resolved?.by.principal, "izzie@x.com");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the fold is order-independent", () => {
  const ev = (id: string, kind: string, actor: Actor, data: Record<string, unknown>, after?: string): LogEvent =>
    testEvent({ id, kind, subject: "n_1", actor, ...(after ? { after: [after] } : {}), data });
  const a = ev("0000000001-a", "note.created", izzie, { targetKind: "anchor", targetId: "a_1", text: "x" });
  const b = ev("0000000002-b", "note.answered", dana, { body: "first" }, a.id);
  const c = ev("0000000003-c", "note.answered", izzie, { body: "second" }, b.id);
  const shapes = [[a, b, c], [c, b, a], [b, a, c]].map((s) => {
    const n = foldNotes(sortEvents(s)).get("n_1")!;
    return n.answers.map((x) => x.body).join("|");
  });
  assert.equal(new Set(shapes).size, 1, `folds must agree, got ${JSON.stringify(shapes)}`);
  assert.equal(shapes[0], "first|second");
});

// --- through ops, including the dual write ---------------------------------------

function universe() {
  const root = tmp("repo");
  const g = (...a: string[]) => spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=izzie", ...a], { cwd: root });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "izzie@x.com");
  g("config", "user.name", "izzie");
  mkdirSync(join(root, ".codemap"), { recursive: true });
  const side = tmp("side");
  writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
  return { root, side, cleanup: () => [root, side].forEach((r) => rmSync(r, { recursive: true, force: true })) };
}

/**
 * The universe key this store will actually use.
 *
 * `universe()` gives the repo no git remote, so `universeKey` takes its directory-name
 * fallback — a literal here would write the teammate's note into a universe no read of
 * this store ever looks at, and the test would pass for the wrong reason.
 */
const uKey = (root: string): string => resolveSidecar(root)!.universe;

test("no sidecar configured is not an error — mirroring is additive", async () => {
  const root = tmp("bare");
  try {
    assert.deepEqual(await shared.mirrorNote(root, NEW), { shared: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("annotating mirrors onto the sidecar, keyed by the same id", async () => {
  const u = universe();
  try {
    const { init } = await import("./ops.js");
    mkdirSync(join(u.root, "src"), { recursive: true });
    writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    await init(u.root);
    const { readAnchorStore } = await import("./store.js");
    const anchorId = (await readAnchorStore(u.root)).anchors[0]!.id;

    const r = await annotate(u.root, {
      targetKind: "anchor", targetId: anchorId, text: "costly to work out: the retry is not idempotent",
      kind: "note", author: "izzie",
    }) as { ok: true; id: string; shared?: boolean };
    assert.ok(r.ok);
    assert.equal(r.shared, true, "the local write also reached the sidecar");

    const out = await shared.sharedNotes(u.root, anchorId) as any;
    assert.equal(out.notes.length, 1);
    assert.equal(out.notes[0]!.id, r.id, "the same id on both sides — so publishing twice cannot duplicate it");
    assert.match(out.notes[0]!.text, /not idempotent/);
  } finally { u.cleanup(); }
});

test("publishing existing local notes is idempotent", async () => {
  const u = universe();
  try {
    const { init } = await import("./ops.js");
    mkdirSync(join(u.root, "src"), { recursive: true });
    writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    await init(u.root);
    const { readAnchorStore } = await import("./store.js");
    const anchorId = (await readAnchorStore(u.root)).anchors[0]!.id;
    await annotate(u.root, { targetKind: "anchor", targetId: anchorId, text: "one", kind: "note", author: "izzie" });

    // Already mirrored by the dual write, so a publish has nothing left to do.
    const dry = await shared.publishLocalNotes(u.root, { dryRun: true }) as any;
    assert.equal(dry.wouldPublish, 0);
    assert.equal(dry.alreadyShared, 1);

    const again = await shared.publishLocalNotes(u.root) as any;
    assert.equal(again.published, 0);
    assert.equal((await shared.sharedNotes(u.root, anchorId) as any).notes.length, 1, "never duplicated");
  } finally { u.cleanup(); }
});

test("an agent cannot resolve a shared question through ops either", async () => {
  const u = universe();
  try {
    const id = await createNote(u.side, "repo", izzie, { ...NEW, kind: "question" });
    process.env.CODEMAP_AGENT_MODEL = "claude-opus-5";
    try {
      const r = await shared.resolveSharedNote(u.root, "a_1", id, true) as { error: string };
      assert.match(r.error, /may answer a question, not declare it settled/);
    } finally { delete process.env.CODEMAP_AGENT_MODEL; }
  } finally { u.cleanup(); }
});

// --- retiring a doc whose subject is gone -----------------------------------------

test("retiring refuses while the cited code is still here", async () => {
  // A doc about code that is right there is not a doc whose subject was removed,
  // and tombstoning it would hide something true.
  const u = universe();
  try {
    const { init, document: documentNode } = await import("./ops.js");
    mkdirSync(join(u.root, "src"), { recursive: true });
    writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    await init(u.root);
    const { readAnchorStore } = await import("./store.js");
    const anchorId = (await readAnchorStore(u.root)).anchors[0]!.id;
    await documentNode(u.root, { type: "concept", title: "Seam", summary: "s", body: "b", anchors: [anchorId] });
    await shared.publishLocalDocs(u.root);

    const nodeId = [...(await shared.sharedDocs(u.root) as any).docs][0].nodeId;
    const r = await shared.retireSharedDoc(u.root, nodeId, "looks gone") as { error: string };
    assert.match(r.error, /still in this checkout/);
  } finally { u.cleanup(); }
});

test("an agent may not retire a doc — it is a closure", async () => {
  const u = universe();
  try {
    process.env.CODEMAP_AGENT_MODEL = "claude-opus-5";
    try {
      const r = await shared.retireSharedDoc(u.root, "n_x", "gone") as { error: string };
      assert.match(r.error, /may not/);
      assert.match(r.error, /shared note/, "and it says what the agent CAN do instead");
    } finally { delete process.env.CODEMAP_AGENT_MODEL; }
  } finally { u.cleanup(); }
});

test("retiring needs a reason", async () => {
  const u = universe();
  try {
    const r = await shared.retireSharedDoc(u.root, "n_x", "   ") as { error: string };
    assert.match(r.error, /say why/);
  } finally { u.cleanup(); }
});

test("a doc whose code is genuinely gone can be retired, and stays resolvable", async () => {
  const u = universe();
  try {
    const { init, document: documentNode } = await import("./ops.js");
    mkdirSync(join(u.root, "src"), { recursive: true });
    writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    await init(u.root);
    const { readAnchorStore } = await import("./store.js");
    const anchorId = (await readAnchorStore(u.root)).anchors[0]!.id;
    await documentNode(u.root, { type: "concept", title: "Seam", summary: "s", body: "b", anchors: [anchorId] });
    await shared.publishLocalDocs(u.root);
    const nodeId = [...(await shared.sharedDocs(u.root) as any).docs][0].nodeId;

    // The code goes away entirely, and so does any record of it.
    writeFileSync(join(u.root, "src", "pay.ts"), "export const nothing = 1;\n", "utf8");
    await init(u.root);

    const r = await shared.retireSharedDoc(u.root, nodeId, "the transfer entry point was deleted in v3") as any;
    assert.ok(r.ok, JSON.stringify(r));
    const after = (await shared.sharedDocs(u.root, { nodeId }) as any).docs[0];
    assert.equal(after.versions, 2, "a tombstone is a version, not a deletion");
    assert.equal(after.resolved.removed, true, "and it wins here, where the code is absent");
  } finally { u.cleanup(); }
});

/**
 * A tombstone's citations keep their accepted hashes.
 *
 * Not as an acceptance — `evalVersion`'s removed branch never reads them — but as
 * the derivation evidence behind the removal CLAIM. "This was removed" is an
 * inference from absence, and absence only means removal if the reader's index could
 * have resolved the id at all. Emptied, the tombstone reads as holding against every
 * index, including one whose build spells the same code's ids differently.
 * See docs/anchor-id-provenance.md §6.
 */
test("a retired doc's tombstone carries the evidence its claim rests on", async () => {
  const u = universe();
  try {
    const { init, document: documentNode } = await import("./ops.js");
    const { readAnchorStore } = await import("./store.js");
    const { resolveSidecar } = await import("./sidecar-config.js");
    const { readDocs } = await import("./shared-docs.js");

    mkdirSync(join(u.root, "src"), { recursive: true });
    writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    await init(u.root);
    const anchorId = (await readAnchorStore(u.root)).anchors[0]!.id;
    await documentNode(u.root, { type: "concept", title: "Seam", summary: "s", body: "b", anchors: [anchorId] });
    await shared.publishLocalDocs(u.root);
    const nodeId = [...(await shared.sharedDocs(u.root) as any).docs][0].nodeId;

    writeFileSync(join(u.root, "src", "pay.ts"), "export const nothing = 1;\n", "utf8");
    await init(u.root);
    const r = await shared.retireSharedDoc(u.root, nodeId, "the transfer entry point was deleted in v3") as any;
    assert.ok(r.ok, JSON.stringify(r));

    const cfg = resolveSidecar(u.root)!;
    const doc = (await readDocs(cfg.path, cfg.universe)).get(nodeId)!;
    const tomb = doc.versions.find((v) => v.removed);
    assert.ok(tomb, "retiring writes a tombstone version");
    assert.ok(tomb.citations[0]!.acceptedHashes.length > 0,
      "the tombstone must not empty the set — that is the only evidence it could resolve the id");
  } finally { u.cleanup(); }
});

// --- the queue is the TEAM's, not this machine's ----------------------------------

/**
 * `questions` called itself "the 'answer these to improve the docs' queue" and listed
 * only what this machine wrote. A teammate's question was therefore one that nobody on
 * any other machine was ever shown — on the single surface whose whole job is not to
 * lose it. Docs, bugs, findings, triage and walkthroughs all went canonical; notes were
 * the last kind whose reads stopped at the local store.
 */
test("a teammate's question is in the queue, and says whose it is", async () => {
  const u = universe();
  try {
    const { init, listQuestions } = await import("./ops.js");
    mkdirSync(join(u.root, "src"), { recursive: true });
    writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    await init(u.root);
    const id = await createNote(u.side, uKey(u.root), dana, { ...NEW, kind: "question", text: "why is the retry not idempotent?" });
    // Fold it the way a read does — the projection is what a query path is allowed
    // to consult, and `allNotes` folding 256 buckets is exactly what it may not do.
    await shared.sharedNotes(u.root, "a_1");

    const q = await listQuestions(u.root) as {
      total: number; open: number;
      questions: { id: string; text: string; author: string; shared: boolean }[];
    };
    assert.equal(q.total, 1, "the team's question is in the queue");
    assert.equal(q.open, 1);
    assert.equal(q.questions[0]!.id, id);
    assert.equal(q.questions[0]!.author, "dana@x.com", "attributed to whoever asked");
    assert.equal(q.questions[0]!.shared, true, "and marked as the team's, not this machine's");
  } finally { u.cleanup(); }
});

/** One question in two stores is ONE question — the mirror must not double the queue. */
test("a mirrored question is listed once, not twice", async () => {
  const u = universe();
  try {
    const { init, annotate: ann, listQuestions } = await import("./ops.js");
    mkdirSync(join(u.root, "src"), { recursive: true });
    writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    await init(u.root);
    const { readAnchorStore } = await import("./store.js");
    const anchorId = (await readAnchorStore(u.root)).anchors[0]!.id;
    const r = await ann(u.root, {
      targetKind: "anchor", targetId: anchorId, text: "does this retry ever double-charge?",
      kind: "question", author: "izzie",
    }) as { id: string; shared?: boolean };
    assert.equal(r.shared, true, "it did reach the sidecar — otherwise this proves nothing");
    await shared.sharedNotes(u.root, anchorId);

    const q = await listQuestions(u.root) as { total: number; questions: { id: string; shared: boolean }[] };
    assert.equal(q.total, 1, "the local row and its mirror are one question");
    assert.equal(q.questions[0]!.id, r.id);
    assert.equal(q.questions[0]!.shared, false, "the local copy wins — it is the one this store can close");
  } finally { u.cleanup(); }
});

/**
 * Closing a mirrored question used to write one store. The team's copy stayed open
 * forever, and `questions` on anybody else's machine kept listing an answered question
 * with nothing able to say it had been answered.
 */
test("a person closing a mirrored question closes the team's copy too", async () => {
  const u = universe();
  try {
    const { init, annotate: ann, resolveAnnotation } = await import("./ops.js");
    mkdirSync(join(u.root, "src"), { recursive: true });
    writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    await init(u.root);
    const { readAnchorStore } = await import("./store.js");
    const anchorId = (await readAnchorStore(u.root)).anchors[0]!.id;
    const r = await ann(u.root, {
      targetKind: "anchor", targetId: anchorId, text: "is the retry idempotent?", kind: "question", author: "izzie",
    }) as { id: string };

    const out = await resolveAnnotation(u.root, r.id, true) as { ok: true; shared?: boolean };
    assert.equal(out.shared, true, "the resolution reached the sidecar");

    const team = await shared.sharedNotes(u.root, anchorId) as { notes: { id: string; resolved?: unknown }[] };
    assert.ok(team.notes.find((n) => n.id === r.id)!.resolved, "and the team's copy is closed");
  } finally { u.cleanup(); }
});

/**
 * And an agent's close does NOT travel — but is not silent about it.
 *
 * `foldNotes` drops a `note.resolved` from an agent actor outright, so mirroring one
 * would append an event every reader ignores and report it as shared. Closing its own
 * local question is deliberate (`26a61d6`); closing it for the team is a person's act.
 */
test("an agent closes its own question locally and is told the team's is still open", async () => {
  const u = universe();
  try {
    const { init, annotate: ann, resolveAnnotation } = await import("./ops.js");
    mkdirSync(join(u.root, "src"), { recursive: true });
    writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    await init(u.root);
    const { readAnchorStore } = await import("./store.js");
    const anchorId = (await readAnchorStore(u.root)).anchors[0]!.id;
    const r = await ann(u.root, {
      targetKind: "anchor", targetId: anchorId, text: "which branch owns this?", kind: "question", author: "izzie",
    }) as { id: string };

    process.env.CODEMAP_AGENT_MODEL = "claude-opus-5";
    let out: { ok?: true; shared?: boolean; sharedNote?: string };
    try {
      out = await resolveAnnotation(u.root, r.id, true, { actor: "agent" }) as typeof out;
    } finally { delete process.env.CODEMAP_AGENT_MODEL; }
    assert.ok(out!.ok, "the local close still works — that is the loop resolve_question exists for");
    assert.equal(out!.shared, undefined, "it did not claim to share it");
    assert.match(out!.sharedNote ?? "", /still open for the team/);

    const team = await shared.sharedNotes(u.root, anchorId) as { notes: { id: string; resolved?: unknown }[] };
    assert.equal(team.notes.find((n) => n.id === r.id)!.resolved, undefined, "and it genuinely is still open");
  } finally { u.cleanup(); }
});

/** A teammate's question has no local row to close, so an agent is refused outright. */
test("an agent may not close the team's question, and is told what it can do", async () => {
  const u = universe();
  try {
    const { resolveAnnotation } = await import("./ops.js");
    const id = await createNote(u.side, uKey(u.root), dana, { ...NEW, kind: "question", text: "whose is this?" });
    await shared.sharedNotes(u.root, "a_1");
    process.env.CODEMAP_AGENT_MODEL = "claude-opus-5";
    try {
      const r = await resolveAnnotation(u.root, id, true, { actor: "agent" }) as { error: string };
      assert.match(r.error, /the team's question/);
      assert.match(r.error, /answer_shared_note/, "and it names the tool that IS allowed");
    } finally { delete process.env.CODEMAP_AGENT_MODEL; }
  } finally { u.cleanup(); }
});

/** A person can close it, which is the whole point of the queue listing it. */
test("a person closes the team's question through the same tool", async () => {
  const u = universe();
  try {
    const { init, resolveAnnotation, listQuestions } = await import("./ops.js");
    mkdirSync(join(u.root, "src"), { recursive: true });
    writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    await init(u.root);
    const id = await createNote(u.side, uKey(u.root), dana, { ...NEW, kind: "question", text: "whose is this?" });
    await shared.sharedNotes(u.root, "a_1");

    const r = await resolveAnnotation(u.root, id, true) as { ok?: true; shared?: boolean; error?: string };
    assert.ok(r.ok, r.error ?? "");
    assert.equal(r.shared, true);
    assert.equal((await listQuestions(u.root) as { open: number }).open, 0, "and it leaves the queue");
  } finally { u.cleanup(); }
});

/** An id in neither store still says which nothing it is. */
test("an id in neither store is still an unknown annotation", async () => {
  const u = universe();
  try {
    const { resolveAnnotation } = await import("./ops.js");
    const r = await resolveAnnotation(u.root, "note_nope", true) as { error: string };
    assert.match(r.error, /no annotation "note_nope"/);
  } finally { u.cleanup(); }
});

/**
 * A FINDING IS NOT A NOTE.
 *
 * `annotate(kind:"finding")` used to mirror one into the note store, so the note log
 * still carries them — 96 on the primary universe, 45 of which are also rows in
 * `findings`. Listing those here renders one finding twice on an anchor: once as a note
 * with no pull request, tier or thread, and once as the finding that has them.
 */
test("findings mirrored into the note store before they were canonical are not notes", async () => {
  const u = universe();
  try {
    const key = uKey(u.root);
    await createNote(u.side, key, izzie, { ...NEW, kind: "note", text: "the real note" });
    await createNote(u.side, key, izzie, { ...NEW, kind: "finding", text: "a pre-canonical finding" });

    const out = await shared.sharedNotes(u.root, "a_1") as
      { notes: { kind: string }[]; legacyFindings?: number; note?: string };
    assert.deepEqual(out.notes.map((n) => n.kind), ["note"], "the finding is not listed as a note");
    assert.equal(out.legacyFindings, 1, "but the reader is TOLD, not silently shown fewer rows");
    assert.match(out.note ?? "", /shared_findings/, "and told where they actually live");
  } finally { u.cleanup(); }
});

/**
 * `get_anchor` merged teammates' DOCS and returned local annotations only, so a
 * colleague's note on the very symbol being read was one navigation away, on a surface
 * nothing in the reply pointed at. The web anchor page had shown them for months.
 */
test("get_anchor carries the team's notes about the symbol", async () => {
  const u = universe();
  try {
    const { init, getAnchor } = await import("./ops.js");
    mkdirSync(join(u.root, "src"), { recursive: true });
    writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    await init(u.root);
    const { readAnchorStore } = await import("./store.js");
    const anchorId = (await readAnchorStore(u.root)).anchors[0]!.id;

    const key = uKey(u.root);
    await createNote(u.side, key, dana, {
      targetKind: "anchor", targetId: anchorId, kind: "note", text: "the retry here is not idempotent",
    });
    await createNote(u.side, key, dana, {
      targetKind: "anchor", targetId: anchorId, kind: "finding", text: "a pre-canonical finding",
    });
    await shared.sharedNotes(u.root, anchorId);

    const a = await getAnchor(u.root, anchorId) as
      { sharedNotes?: { text: string; by: string; kind: string }[] };
    assert.equal(a.sharedNotes?.length, 1, "the note, and not the pre-canonical finding beside it");
    assert.match(a.sharedNotes![0]!.text, /not idempotent/);
    assert.equal(a.sharedNotes![0]!.by, "dana@x.com", "and whose it is");
  } finally { u.cleanup(); }
});

/** A note this machine wrote is already in `annotations` — `sharedNotes` must not double it. */
test("get_anchor does not list your own note twice", async () => {
  const u = universe();
  try {
    const { init, annotate: ann, getAnchor } = await import("./ops.js");
    mkdirSync(join(u.root, "src"), { recursive: true });
    writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    await init(u.root);
    const { readAnchorStore } = await import("./store.js");
    const anchorId = (await readAnchorStore(u.root)).anchors[0]!.id;
    await ann(u.root, { targetKind: "anchor", targetId: anchorId, text: "mine", kind: "note", author: "izzie" });

    const a = await getAnchor(u.root, anchorId) as
      { annotations: unknown[]; sharedNotes?: unknown[] };
    assert.equal(a.annotations.length, 1);
    assert.equal(a.sharedNotes, undefined, "the mirror of your own note is not a second note");
  } finally { u.cleanup(); }
});

// --- a pointer is only worth anything AT the code ---------------------------------

/**
 * A `pointer` is a review AID — "watch out for X when reading this block" — and 34 of
 * the 44 on the primary universe carry a LINE. Its whole value is being pinned beside
 * the code while somebody reads the diff. Every pane that does that pinning
 * (`prStory`'s steps, `nodeReview`, `fileView`, `prAnchorCode`) read local annotations
 * only, so your own pointer showed at its line and a teammate's showed nowhere near the
 * code. `get_anchor` was the sole surface that had them, one navigation away.
 */
test("a teammate's pointer reaches the code-review pane, at its line", async () => {
  const u = universe();
  try {
    const { init, nodeReview, document: documentNode } = await import("./ops.js");
    mkdirSync(join(u.root, "src"), { recursive: true });
    writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c: number) {\n  return c;\n}\n", "utf8");
    await init(u.root);
    const { readAnchorStore } = await import("./store.js");
    const anchorId = (await readAnchorStore(u.root)).anchors[0]!.id;
    const node = await documentNode(u.root, {
      type: "concept", title: "Transfers", summary: "s", body: "b", anchors: [anchorId],
    }) as { id: string };

    await createNote(u.side, uKey(u.root), dana, {
      targetKind: "anchor", targetId: anchorId, kind: "pointer",
      text: "the retry above is not idempotent — check the ledger write", line: 2, category: "Money",
    });
    await shared.sharedNotes(u.root, anchorId);

    const r = await nodeReview(u.root, node.id) as
      { segments: { id: string; sharedNotes?: { text: string; by: string; line?: number; kind: string; category?: string }[] }[] };
    const seg = r.segments.find((s) => s.id === anchorId)!;
    assert.equal(seg.sharedNotes?.length, 1, "the team's pointer is on the segment");
    assert.equal(seg.sharedNotes![0]!.line, 2, "AT its line — that is the whole point of a pointer");
    assert.equal(seg.sharedNotes![0]!.by, "dana@x.com");
    assert.equal(seg.sharedNotes![0]!.category, "Money", "and it keeps the fields the pane renders");
  } finally { u.cleanup(); }
});

/** Your own is already in `annotations`; the mirror must not double it. */
test("your own pointer is not repeated as a team note", async () => {
  const u = universe();
  try {
    const { init, annotate: ann, nodeReview, document: documentNode } = await import("./ops.js");
    mkdirSync(join(u.root, "src"), { recursive: true });
    writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    await init(u.root);
    const { readAnchorStore } = await import("./store.js");
    const anchorId = (await readAnchorStore(u.root)).anchors[0]!.id;
    const node = await documentNode(u.root, {
      type: "concept", title: "Transfers", summary: "s", body: "b", anchors: [anchorId],
    }) as { id: string };
    await ann(u.root, {
      targetKind: "anchor", targetId: anchorId, text: "watch the retry", kind: "pointer", author: "izzie", line: 1,
    });

    const r = await nodeReview(u.root, node.id) as
      { segments: { id: string; annotations: unknown[]; sharedNotes?: unknown[] }[] };
    const seg = r.segments.find((s) => s.id === anchorId)!;
    assert.equal(seg.annotations.length, 1, "it is yours, and it is where it always was");
    assert.equal(seg.sharedNotes, undefined, "and its mirror is not a second pointer");
  } finally { u.cleanup(); }
});

/**
 * A finding is not pinned here even though the note log still holds pre-canonical
 * copies — those are rows in `findings` with a pull request, a tier and a thread, and
 * rendering the copy with none of that beside the code would be the double-render that
 * `shared_notes` already stopped.
 */
test("a pre-canonical finding in the note log is not pinned to the code", async () => {
  const u = universe();
  try {
    const { init, nodeReview, document: documentNode } = await import("./ops.js");
    mkdirSync(join(u.root, "src"), { recursive: true });
    writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    await init(u.root);
    const { readAnchorStore } = await import("./store.js");
    const anchorId = (await readAnchorStore(u.root)).anchors[0]!.id;
    const node = await documentNode(u.root, {
      type: "concept", title: "Transfers", summary: "s", body: "b", anchors: [anchorId],
    }) as { id: string };
    await createNote(u.side, uKey(u.root), dana, {
      targetKind: "anchor", targetId: anchorId, kind: "finding", text: "a pre-canonical finding", line: 1,
    });
    await createNote(u.side, uKey(u.root), dana, {
      targetKind: "anchor", targetId: anchorId, kind: "pointer", text: "a real pointer", line: 1,
    });
    await shared.sharedNotes(u.root, anchorId);

    const r = await nodeReview(u.root, node.id) as
      { segments: { id: string; sharedNotes?: { kind: string }[] }[] };
    const seg = r.segments.find((s) => s.id === anchorId)!;
    assert.deepEqual(seg.sharedNotes?.map((n) => n.kind), ["pointer"]);
  } finally { u.cleanup(); }
});
