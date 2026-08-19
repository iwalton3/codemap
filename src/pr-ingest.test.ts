import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Anchor, State } from "./schema.js";
import { writeStore, writeSnapshot, readTriage } from "./store.js";
import { setTriage } from "./triage.js";
import { parseAgentLines, ingestAgentReview, type AgentLine } from "./pr-ingest.js";

test("parseAgentLines tolerates blanks and reports malformed lines without losing good ones", () => {
  const { lines, bad } = parseAgentLines([
    `{"kind":"finding","anchorId":"a_1","text":"boom","severity":"high"}`,
    ``,
    `{"kind":"triage","anchorId":"a_2","importance":"important","complexity":"deep"}`,
    `{not json`,
    `{"kind":"summary","batch":"b0","reviewed":2,"findings":1,"narrative":"n"}`,
  ].join("\n"));
  assert.equal(lines.length, 3);
  assert.equal(bad.length, 1);
  assert.equal(bad[0]!.line, 4);
});

test("ingest routes findings to annotate, triage to the ratchet, and rejects unanchored lines", async () => {
  const calls: any[] = [];
  const lines: AgentLine[] = [
    { kind: "finding", anchorId: "a_1", text: "missing tenant check", severity: "critical", category: "Tenant Safety", line: 42, evidence: "no AuthCheck" },
    { kind: "pointer", anchorId: "a_2", text: "confirm the rounding mode" },
    { kind: "finding", text: "orphan" },                       // no anchorId → rejected
    { kind: "finding", anchorId: "a_3" },                       // no text → rejected
    { kind: "summary", batch: "b0", reviewed: 3, findings: 2, narrative: "did things" },
  ];
  const r = await ingestAgentReview("/nonexistent", lines, {
    annotate: async (_root, input) => { calls.push(input); return {}; },
  }, { headRef: "deadbeef", dryRun: false });

  assert.equal(r.annotations, 2);
  assert.deepEqual(r.rejected.map((x) => x.why), ["no anchorId", "no text"]);
  assert.equal(r.summaries.length, 1);
  assert.equal(r.bySeverity.critical, 1);

  // the head ref must ride along or findings on branch-only symbols get rejected
  assert.equal(calls[0].ref, "deadbeef");
  assert.equal(calls[0].line, 42);
  assert.equal(calls[0].kind, "finding");
  assert.match(calls[0].text, /Evidence: no AuthCheck/);
});

test("re-ingesting the same findings adds nothing — a partial batch can be re-run safely", async () => {
  const calls: any[] = [];
  const lines: AgentLine[] = [
    { kind: "finding", anchorId: "a_1", text: "missing tenant check", severity: "critical", line: 42 },
    { kind: "pointer", anchorId: "a_2", text: "confirm the rounding mode" },
  ];
  const annotate = async (_root: string, input: any) => { calls.push(input); return {}; };

  const first = await ingestAgentReview("/nonexistent", lines, { annotate }, { headRef: "h" });
  assert.equal(first.annotations, 2);
  assert.equal(first.duplicates, 0);

  // second run, with the first run's output already in the map
  const existing = calls.map((c) => ({ targetId: c.targetId, line: c.line, kind: c.kind, text: c.text, author: c.author }));
  const second = await ingestAgentReview("/nonexistent", lines, { annotate, existing }, { headRef: "h" });
  assert.equal(second.annotations, 0, "ingest mints fresh ids, so without dedupe this doubles every finding");
  assert.equal(second.duplicates, 2);
  assert.equal(calls.length, 2, "and nothing new was written");
});

test("a finding that differs only in its line is NOT a duplicate", async () => {
  const calls: any[] = [];
  const annotate = async (_r: string, i: any) => { calls.push(i); return {}; };
  const a: AgentLine = { kind: "finding", anchorId: "a_1", text: "same words", line: 10 };
  const b: AgentLine = { kind: "finding", anchorId: "a_1", text: "same words", line: 99 };
  const r = await ingestAgentReview("/nonexistent", [a, b], { annotate }, { headRef: "h" });
  assert.equal(r.annotations, 2);
  assert.equal(r.duplicates, 0);
});

test("a medium-confidence finding says so in its text, so a human can weight it", async () => {
  const calls: any[] = [];
  await ingestAgentReview("/nonexistent", [
    { kind: "finding", anchorId: "a_1", text: "maybe wrong", confidence: "medium" },
  ], { annotate: async (_r, i) => { calls.push(i); return {}; } }, { headRef: "x" });
  assert.match(calls[0].text, /agent confidence: medium/);
});

test("a triage line the ratchet declines is reported as declined, not counted as applied", async () => {
  // Refusal is the COMMON case on a re-ingest, and unlike findings there was no
  // bucket revealing it — the operator was told a tier had been written when the
  // store was untouched.
  const root = mkdtempSync(join(tmpdir(), "codemap-ingest-"));
  try {
    const anchor: Anchor = { id: "a_1", file: "src/x.cs", symbolPath: ["X"], kind: "function", bodyHash: "sha256:OLD", lastVerifiedCommit: null };
    await writeStore(root, [anchor], { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State);
    await setTriage(root, { targetKind: "anchor", targetId: "a_1", importance: "business-critical", complexity: "deep", source: "human" });

    const r = await ingestAgentReview(root, [
      { kind: "triage", anchorId: "a_1", importance: "low", complexity: "rote" },   // lowering — refused
      { kind: "triage", anchorId: "a_1", importance: "business-critical", complexity: "deep" }, // no change — refused
    ], { annotate: async () => ({}) }, { headRef: "headsha", dryRun: false });

    assert.equal(r.triaged, 0, "a refusal is not an applied triage");
    assert.equal(r.triageRefused.length, 2);
    assert.match(r.triageRefused[0]!.why, /human-owned|ratchet/i);

    // the human's mark is untouched
    const t = (await readTriage(root)).triage.find((x) => x.target.id === "a_1")!;
    assert.equal(t.importance, "business-critical");
    assert.equal(t.source, "human");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an ingested triage proposal is witnessed against the PR head, not the working tree", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-ingest-"));
  try {
    await writeStore(root, [], { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State);  // symbol not on this branch
    await writeSnapshot(root, "headsha", "feature",
      [{ id: "a_new", file: "src/x.cs", symbolPath: ["X"], kind: "function", bodyHash: "sha256:NEW", lastVerifiedCommit: null }],
      "2026-08-19T00:00:00Z");

    const r = await ingestAgentReview(root, [
      { kind: "triage", anchorId: "a_new", importance: "important", complexity: "wiring" },
    ], { annotate: async () => ({}) }, { headRef: "headsha", dryRun: false });

    assert.equal(r.triaged, 1);
    const t = (await readTriage(root)).triage.find((x) => x.target.id === "a_new")!;
    assert.equal(t.witnesses[0]!.bodyHash, "sha256:NEW",
      "a symbol the branch ADDS must not be witnessed sha256:absent — that can never be told apart from drift");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
