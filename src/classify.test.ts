/**
 * What a read classifies, and when (review C17; owner: "Newer build is obviously new event types
 * or extra fields nothing currently cares about. Damage is an existing validator failing or
 * invalid json." Fields are detected by the version stamp — owner, 2026-10-01).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kindsFor, type LogEvent } from "./eventlog.js";
import { foldJudged, reportFor } from "./validation.js";
import { scanSidecar } from "./damage-scan.js";
import { foldDecisionsReport } from "./shared-decisions.js";
import "./shared-findings.js";
import "./shared-bugs.js";
import "./shared-notes.js";
import "./shared-docs.js";
import { MATERIALIZER_VERSION } from "./materializer-version.js";
import { MANIFEST_DIR } from "./sidecar.js";
import { testEvent } from "./test-events.js";
import { discard } from "./test-tmp.js";

const ev = (id: string, kind: string, subject: string, data: Record<string, unknown>, seq: number, after: string[] = []): LogEvent =>
  testEvent({ id, kind, subject, data, seq, after, actor: { principal: "alice@x.com" } });

/** The read's verdict: the newer ids, or the id it locks on. */
function verdict(scope: string, events: LogEvent[], report = reportFor(scope)!): { newer: string[] } | { lock: string } {
  try { return { newer: foldJudged(events, report, kindsFor(scope)).newer.map((r) => r.id) }; }
  catch (e) { return { lock: (e as { entry?: { id: string } }).entry?.id ?? String(e) }; }
}

test("an unknown kind is newer, on an existing subject or a new one, in every family", () => {
  const created = ev("e1", "finding.created", "F1", { text: "t", targetKind: "anchor", targetId: "a_1" }, 1);
  assert.deepEqual(verdict("findings/u/pr-1", [created, ev("e2", "finding.frobbed", "F1", { x: 1 }, 2)]), { newer: ["e2"] });
  assert.deepEqual(verdict("findings/u/pr-1", [ev("e3", "finding.imported", "F9", { x: 1 }, 1)]), { newer: ["e3"] });
  assert.deepEqual(verdict("bugs/u", [ev("e4", "bug.imported", "B9", { x: 1 }, 1)]), { newer: ["e4"] });
  assert.deepEqual(verdict("notes/u/00", [ev("e5", "note.imported", "N9", { x: 1 }, 1)]), { newer: ["e5"] });
  assert.deepEqual(verdict("decisions/u", [ev("d1", "decision.frobbed", "x", { a: 1 }, 1)], foldDecisionsReport), { newer: ["d1"] });
});

test("an envelope field this build does not read is newer, and so is a newer protocol", () => {
  const e = { ...ev("e1", "finding.created", "F1", { text: "t", targetKind: "anchor", targetId: "a_1" }, 1), shard: "x" } as LogEvent;
  assert.deepEqual(verdict("findings/u/pr-1", [e]), { newer: ["e1"] });
  const p = { ...ev("e2", "note.revised", "missing", { now: { text: "x" } }, 1), sidecarProtocol: 3 };
  assert.deepEqual(verdict("notes/x/00", [p]), { newer: ["e2"] }, "never folded, so never refused as damage");
});

test("a refusal that depends on a newer event by what it read is newer, not damage", () => {
  const events = [
    ev("e1", "finding.created", "F1", { text: "t", targetKind: "anchor", targetId: "a_1" }, 1),
    ev("e2", "finding.stateChanged", "F1", { state: "deferred", from: "created" }, 2, ["e1"]),
    ev("e3", "finding.stateChanged", "F1", { state: "resolved", from: "deferred", reason: "done" }, 3, ["e2"]),
  ];
  assert.deepEqual(verdict("findings/u/pr-1", events), { newer: ["e2", "e3"] });
});

test("a repaired entry is a known skip: no lock, no newer, so pushes go on", () => {
  const events = [ev("e1", "log.repaired", "F1", { kind: "finding.created", reason: "r", approvedBy: "p" }, 1)];
  assert.deepEqual(verdict("findings/u/pr-1", events), { newer: [] });
});

function sidecarWith(scope: string, lines: unknown[], manifestVersion?: number): string {
  const root = mkdtempSync(join(tmpdir(), "codemap-classify-"));
  mkdirSync(join(root, scope), { recursive: true });
  writeFileSync(join(root, scope, "events.ndjson"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  if (manifestVersion !== undefined) {
    mkdirSync(join(root, MANIFEST_DIR), { recursive: true });
    writeFileSync(join(root, MANIFEST_DIR, "bob.json"), JSON.stringify({ principal: "bob@x.com", anchorScheme: 3, hashScheme: 1, grammars: {}, materializerVersion: manifestVersion }));
  }
  return root;
}

test("a line that parses but fails the envelope: newer from a newer protocol, damage otherwise", async () => {
  const roots: string[] = [];
  try {
    const future = sidecarWith("notes/x", [{ sidecarProtocol: 3, id: "future" }]);
    roots.push(future);
    const a = await scanSidecar(future);
    assert.equal(a.damage, null);
    assert.deepEqual(a.newer.map((n) => n.id), ["future"]);
    const { writer: _w, ...broken } = ev("b1", "note.created", "N1", { text: "x" }, 1);
    const bad = sidecarWith("notes/x", [broken]);
    roots.push(bad);
    assert.equal((await scanSidecar(bad)).damage?.id, "b1");
  } finally { roots.forEach(discard); }
});

test("a validator failure is newer while a teammate's build is ahead, and damage once this one is not behind", async () => {
  const roots: string[] = [];
  try {
    const orphan = ev("e1", "note.revised", "missing", { now: { text: "x" }, was: { text: "y" } }, 1);
    const behind = sidecarWith("notes/x", [orphan], MATERIALIZER_VERSION + 1);
    roots.push(behind);
    const a = await scanSidecar(behind);
    assert.equal(a.damage, null);
    assert.deepEqual(a.newer.map((n) => n.id), ["e1"]);
    const level = sidecarWith("notes/x", [orphan], MATERIALIZER_VERSION);
    roots.push(level);
    assert.equal((await scanSidecar(level)).damage?.id, "e1");
  } finally { roots.forEach(discard); }
});

test("a dev-era decisions posting is skipped as older: no lock, and pushes are not blocked", () => {
  const round = ev("r1", "decision.round.posted", "R1", { round: { id: "R1", source: "s" }, decisions: [] }, 1);
  assert.deepEqual(verdict("decisions/u", [round], foldDecisionsReport), { newer: [] });
});

test("an analyzer doc version on the log is skipped, never damage (O25)", () => {
  const v = { versionId: "v1", nodeId: "n1", type: "concept", title: "t", summary: "", body: "", citations: [], createdAt: "2026-01-01T00:00:00Z", generatedBy: "marten" };
  assert.deepEqual(verdict("docs/u", [ev("e1", "doc.version", "n1", { version: v }, 1)]), { newer: [] });
});

test("C16: a refusal the log before it would not make is never damage; one it would make is", () => {
  const e1 = ev("e1", "note.created", "N1", { text: "x" }, 1), e2 = ev("e2", "note.created", "N2", { text: "y" }, 2);
  const vocab = { kinds: new Set(["note.created"]) };
  // A fold whose verdict on e1 changes once e2 exists — the defect class, not a real fold.
  const flips = (evs: LogEvent[]) => ({ value: null, refused: evs.some((e) => e.id === "e2") ? [{ id: "e1", kind: "note.created", why: "later", cls: "state" as const }] : [] });
  assert.deepEqual(foldJudged([e1, e2], flips, vocab).newer, []);
  const always = (evs: LogEvent[]) => ({ value: null, refused: evs.some((e) => e.id === "e1") ? [{ id: "e1", kind: "note.created", why: "bad", cls: "state" as const }] : [] });
  assert.throws(() => foldJudged([e1, e2], always, vocab), /damaged log entry e1/);
});

test("O30: a cross-scope reference is checked on read against the log before it", async () => {
  const { createFinding, promoteToBug } = await import("./shared-findings.js");
  const { fileBug } = await import("./shared-bugs.js");
  const { readFileSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "codemap-refs-"));
  try {
    const ana = { principal: "ana@x.com" };
    const f = await createFinding(root, "u/pr-1", ana, { targetKind: "anchor", targetId: "a_1", text: "t" });
    const b = await fileBug(root, "u", ana, { title: "b", text: "b", anchors: [] });
    await assert.rejects(promoteToBug(root, "u/pr-1", ana, f, "bug_nope"), /no bug bug_nope/, "the door refuses it");
    await promoteToBug(root, "u/pr-1", ana, f, b);
    assert.equal((await scanSidecar(root)).damage, null, "in order, it resolves");
    // The same events, the bug now filed AFTER the promotion that names it.
    const bugs = join(root, "bugs/u/events.ndjson");
    writeFileSync(bugs, readFileSync(bugs, "utf8").split("\n").filter(Boolean).map((l) => JSON.stringify({ ...JSON.parse(l), seq: 99 })).join("\n") + "\n");
    const d = (await scanSidecar(root)).damage;
    assert.equal(d?.kind, "finding.promotedToBug", "a reference that did not resolve in its prefix is damage");
  } finally { discard(root); }
});
