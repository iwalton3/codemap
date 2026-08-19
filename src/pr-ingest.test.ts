import { test } from "node:test";
import assert from "node:assert/strict";
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
