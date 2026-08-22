import { test } from "node:test";
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
    ({ id, kind, subject: "n_1", actor, at: "t", ...(after ? { after } : {}), data });
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
