/**
 * Close-out across universes (plan 2026-10-20-reader-incident-followups, Phase 0): a review that
 * spans two repos should cost one verifier per slot and one round, not one per repo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepairConnection } from "./verifier-boundary.js";
import { repairBatchBrief, submitRepairVerification, recordRepairVerification, applyRepairVerification } from "./ops/repair-verification.js";
import { postRepairSort } from "./ops/repairs.js";
import { releaseRuledSort, releaseReaderBrief } from "./ops/repair-release.js";
import { rpc } from "./test-mcp.js";
import { postRound, answerDirect, readerBrief, relayAnswer } from "./ops/decisions.js";
import { applicationReaderBrief } from "./ops/ruling-application.js";
import { operationSignoffQuestion, operationSignoffReaderBrief } from "./ops/operation-signoff.js";
import { PLAN_ONLY, SIGN_OPERATION } from "./operation-signoff.js";
import { draftSpec, addOperation } from "./requirements.js";
import { decisionsView } from "./ops/decision-holds.js";
import { readFinding } from "./store.js";
import { discard } from "./test-tmp.js";
import { twoUniverses, repairable, fixedBy, batchTranscript, PRINCIPAL } from "./test-universes.js";

const ok = (v: unknown) => assert.equal((v as { error?: string }).error, undefined, JSON.stringify(v));

test("P1: one subagent carrying both universes' slot-1 launch lines verifies both, and each records", async () => {
  const w = await twoUniverses();
  const dir = mkdtempSync(join(tmpdir(), "codemap-xu-tx-"));
  try {
    const orchestrator = new RepairConnection(PRINCIPAL);
    const jobs = [];
    for (const u of [w.api, w.settlement]) {
      const r = await repairable(u, orchestrator);
      const batch = await repairBatchBrief(u.root, 7, { role: "verifier", slot: 1 }, orchestrator) as { launch: string };
      ok(batch);
      const results = fixedBy(u, r.finding);
      const held = await submitRepairVerification(u.root, 7, { requestId: r.requestId, slot: 1, results }, orchestrator) as { held: boolean; receipt: string };
      assert.equal(held.held, true, JSON.stringify(held));
      // The settlement call carries `universe`, as a real verifier's must; the api one is the primary.
      jobs.push({ u, r, launch: batch.launch, held, input: { review: "7", requestId: r.requestId, slot: 1, results, ...(u === w.settlement ? { universe: "settlement" } : {}) } });
    }
    // Non-vacuous: a prompt holding only api's line does not verify settlement's job.
    const short = mkdtempSync(join(tmpdir(), "codemap-xu-tx-"));
    try {
      batchTranscript(short, "a9000002", `Verify api only.\n${jobs[0]!.launch}\n`, [{ input: jobs[1]!.input, result: jobs[1]!.held }]);
      assert.match(String((await recordRepairVerification(w.settlement.root, 7, { requestId: jobs[1]!.r.requestId, role: "verifier", slot: 1, receipt: jobs[1]!.held.receipt }, short) as { error?: string }).error),
        /exactly the issued prompt/);
    } finally { discard(short); }
    batchTranscript(dir, "a9000001", `Verify the fixes on this cross-repo review.\n${jobs[0]!.launch}\n${jobs[1]!.launch}\n`,
      jobs.map((j) => ({ input: j.input, result: j.held })));
    for (const j of jobs) {
      ok(await recordRepairVerification(j.u.root, 7, { requestId: j.r.requestId, role: "verifier", slot: 1, receipt: j.held.receipt }, dir));
      ok(await applyRepairVerification(j.u.root, 7, { requestId: j.r.requestId, findingId: j.r.finding, reason: "one verifier for the cluster" }, orchestrator));
      assert.equal((await readFinding(j.u.root, j.r.finding, { pr: 7 }))!.state, "resolved", j.u.id);
    }
  } finally { discard(dir); w.dispose(); }
});

test("P2: one round posted in one universe releases a held sort in the other through its issue effect", async () => {
  const w = await twoUniverses();
  try {
    const orchestrator = new RepairConnection(PRINCIPAL);
    const api = await repairable(w.api, orchestrator), settlement = await repairable(w.settlement, orchestrator);
    const issues = [api.ref, settlement.ref];
    ok(await postRound(w.api.root, { round: { id: "R1", source: "cross-repo review" }, decisions: [{ id: "d1", round: "R1", ref: "D1", kind: "options",
      payload: { question: `D1: fix ${api.finding} and ${settlement.finding}?`, options: [{ label: "Fix both" }, { label: "Neither" }] },
      options: [{ label: "Fix both", effects: [{ findings: [], issues, on: "unblock" }] }, { label: "Neither", effects: [{ findings: [], issues, on: "settle", as: "refuted" }] }] }] }));
    ok(await answerDirect(w.api.root, { decision: "d1", option: "Fix both" }));
    const decision = (await decisionsView(w.settlement.root)).s.decisions.find((d) => d.label === "d1")!.id;
    const held = await postRepairSort(w.settlement.root, 7, { prior: settlement.sortId, reason: "rests on the cross-repo question", classification: "design-defect",
      kind: "isolated", source: "approved owner worklist", stakes: "low", coverage: [{ findingId: settlement.finding, claimIds: [`${settlement.finding}:original`] }],
      restsOn: [`decision:${decision}`], provenance: "owner-reviewed", assessments: [], disagreements: [] }) as { id: string };
    ok(held);
    const released = await releaseRuledSort(w.settlement.root, 7, { sort: held.id }) as { id: string; records: { sorts: { input: { id: string; provenance: string }; eligible: boolean; holds: string[] }[] } };
    ok(released);
    const s = released.records.sorts.find((x) => x.input.id === released.id)!;
    assert.equal(s.input.provenance, "ruled");
    assert.equal(s.eligible, true, s.holds.join());
  } finally { w.dispose(); }
});

/** Calls through the real MCP server on the workspace; each reply parsed. */
async function mcp(manifest: string, dir: string, calls: { name: string; arguments: Record<string, unknown> }[]) {
  const replies = await rpc(manifest, calls, { env: { CODEMAP_TRANSCRIPT_DIR: dir } });
  return replies.map((r) => { try { return JSON.parse(r); } catch { return { error: r }; } });
}

for (const carries of [true, false]) {
  const form = carries ? "carry `universe`" : "omit `universe`";
  test(`F10: a settlement verifier's MCP calls ${form}, and it records`, async () => {
    const w = await twoUniverses();
    const dir = mkdtempSync(join(tmpdir(), "codemap-xu-tx-"));
    try {
      const orchestrator = new RepairConnection(PRINCIPAL);
      const r = await repairable(w.settlement, orchestrator);
      const batch = await repairBatchBrief(w.settlement.root, 7, { role: "verifier", slot: 1 }, orchestrator) as { batch: string; launch: string };
      ok(batch);
      const u = carries ? { universe: "settlement" } : {};
      const submit = { review: "7", requestId: r.requestId, slot: 1, results: fixedBy(w.settlement, r.finding), ...u };
      const [brief, held] = await mcp(w.manifest, dir, [{ name: "repair_batch_brief", arguments: { review: "7", batch: batch.batch, ...u } },
        { name: "repair_verification", arguments: submit }]);
      ok(brief);
      assert.equal(brief.universe, "settlement", "the brief names its universe");
      assert.equal(held.held, true, JSON.stringify(held));
      batchTranscript(dir, "a9100001", `Verify.\n${batch.launch}\n`, [{ input: submit, result: held }]);
      const [recorded] = await mcp(w.manifest, dir, [{ name: "record_repair_verification", arguments: { review: "7", requestId: r.requestId, role: "verifier", slot: 1, receipt: held.receipt, ...u } }]);
      ok(recorded);
      assert.ok(recorded.run, JSON.stringify(recorded));
    } finally { discard(dir); w.dispose(); }
  });

  test(`F10: settlement release readers' MCP calls ${form}, and the release records`, async () => {
    const w = await twoUniverses();
    const dir = mkdtempSync(join(tmpdir(), "codemap-xu-tx-"));
    try {
      const orchestrator = new RepairConnection(PRINCIPAL);
      const s = await repairable(w.settlement, orchestrator);
      ok(await postRound(w.settlement.root, { round: { id: "R1", source: "review" }, decisions: [{ id: "d1", round: "R1", ref: "D1", kind: "options",
        payload: { question: `D1: fix ${s.finding}?`, options: [{ label: "Fix" }, { label: "No" }] },
        options: [{ label: "Fix", effects: [{ findings: [], issues: [s.ref], on: "unblock" }] }, { label: "No", effects: [{ findings: [], issues: [s.ref], on: "settle", as: "refuted" }] }] }] }));
      ok(await answerDirect(w.settlement.root, { decision: "d1", option: "Fix" }));
      const decision = (await decisionsView(w.settlement.root)).s.decisions.find((d) => d.label === "d1")!.id;
      const held = await postRepairSort(w.settlement.root, 7, { prior: s.sortId, reason: "rests on D1", classification: "design-defect", kind: "isolated",
        source: "approved owner worklist", stakes: "low", coverage: [{ findingId: s.finding, claimIds: [`${s.finding}:original`] }],
        restsOn: [`decision:${decision}`], provenance: "owner-reviewed", assessments: [], disagreements: [] }) as { id: string };
      ok(held);
      const u = carries ? { universe: "settlement" } : {};
      const readers = [];
      for (const slot of [1, 2] as const) {
        const brief = await releaseReaderBrief(w.settlement.root, 7, { sort: held.id, slot }) as { requestId: string; prompt: string };
        ok(brief);
        const submit = { requestId: brief.requestId, verdict: "yes", rationale: "the ruling settles the fix", ...u };
        const [verdict] = await mcp(w.manifest, dir, [{ name: "submit_release_verdict", arguments: submit }]);
        assert.equal(verdict.held, true, JSON.stringify(verdict));
        batchTranscript(dir, `a920000${slot}`, brief.prompt, [{ input: submit, result: verdict }], "submit_release_verdict");
        readers.push({ requestId: brief.requestId, receipt: verdict.receipt });
      }
      const [released] = await mcp(w.manifest, dir, [{ name: "release_held_sort", arguments: { review: "7", sort: held.id, readers, ...u } }]);
      ok(released);
      assert.ok(released.id, JSON.stringify(released).slice(0, 400));
    } finally { discard(dir); w.dispose(); }
  });
}

/** A round in settlement on its finding, answered directly: what the decision readers read. */
async function ruledInSettlement(w: Awaited<ReturnType<typeof twoUniverses>>) {
  const orchestrator = new RepairConnection(PRINCIPAL);
  const s = await repairable(w.settlement, orchestrator);
  ok(await postRound(w.settlement.root, { round: { id: "R1", source: "review" }, decisions: [{ id: "d1", round: "R1", ref: "D1", kind: "options",
    payload: { question: `D1: does ${s.finding} remain a defect?`, options: [{ label: "Not a defect" }, { label: "Real, fix it" }] },
    options: [{ label: "Not a defect", effects: [{ findings: [s.finding], on: "settle", as: "refuted" }] }, { label: "Real, fix it", effects: [{ findings: [s.finding], on: "unblock" }] }] }] }));
  const answer = await answerDirect(w.settlement.root, { decision: "d1", option: "Not a defect" }) as { answer: string };
  ok(answer);
  return { ...s, answer: answer.answer };
}

for (const carries of [true, false]) {
  const form = carries ? "carry `universe`" : "omit `universe`";
  const u = carries ? { universe: "settlement" } : {};

  test(`F10: a settlement application reader's MCP calls ${form}, and it records`, async () => {
    const w = await twoUniverses();
    const dir = mkdtempSync(join(tmpdir(), "codemap-xu-tx-"));
    try {
      const s = await ruledInSettlement(w);
      const brief = await applicationReaderBrief(w.settlement.root, { issue: { kind: "finding", universe: s.ref.universe, id: s.finding, review: 7 }, answerId: s.answer, slot: 1 }, dir) as { requestId: string; prompt: string };
      ok(brief);
      const submit = { requestId: brief.requestId, verdict: "sound", rationale: "The person rejects the premise.", ...u };
      const [held] = await mcp(w.manifest, dir, [{ name: "submit_application_verdict", arguments: submit }]);
      assert.equal(held.held, true, JSON.stringify(held));
      batchTranscript(dir, "a9300001", brief.prompt, [{ input: submit, result: held }], "submit_application_verdict");
      const [recorded] = await mcp(w.manifest, dir, [{ name: "record_application_verdict", arguments: { requestId: brief.requestId, receipt: held.receipt, ...u } }]);
      assert.equal(recorded.recorded, true, JSON.stringify(recorded));
    } finally { discard(dir); w.dispose(); }
  });

  test(`F10: a settlement operation sign-off reader's MCP calls ${form}, and it records`, async () => {
    const w = await twoUniverses();
    const dir = mkdtempSync(join(tmpdir(), "codemap-xu-tx-"));
    try {
      const root = w.settlement.root;
      const spec = await draftSpec(root, { title: "Credit policy", narrative: "Approval context" }) as { id: string };
      ok(spec);
      const op = await addOperation(root, { specId: spec.id, kind: "add_requirement", title: "Credit limit", statement: "Do not exceed approved credit.", section: "Credit", provenance: "Owner", rationale: "Bound exposure", reversibility: "reversible" }) as { id: string };
      ok(op);
      const question = await operationSignoffQuestion(root, { operationId: op.id }) as { payload: any };
      ok(question);
      ok(await postRound(root, { round: { id: "R1", source: "operation" }, decisions: [{ id: "d1", round: "R1", ref: "D1", kind: "options", payload: question.payload,
        options: [{ label: SIGN_OPERATION, effects: [] }, { label: PLAN_ONLY, effects: [] }] }] }));
      const answer = await answerDirect(root, { decision: "d1", option: SIGN_OPERATION }) as { answer: string };
      ok(answer);
      const brief = await operationSignoffReaderBrief(root, { operationId: op.id, answerId: answer.answer }) as { requestId: string; prompt: string };
      ok(brief);
      const submit = { requestId: brief.requestId, verdict: "sound", rationale: "The human approves the full exact operation.", ...u };
      const [held] = await mcp(w.manifest, dir, [{ name: "submit_operation_signoff_verdict", arguments: submit }]);
      assert.equal(held.held, true, JSON.stringify(held));
      batchTranscript(dir, "a9400001", brief.prompt, [{ input: submit, result: held }], "submit_operation_signoff_verdict");
      const [recorded] = await mcp(w.manifest, dir, [{ name: "record_operation_signoff_verdict", arguments: { requestId: brief.requestId, receipt: held.receipt, ...u } }]);
      assert.equal(recorded.recorded, true, JSON.stringify(recorded));
    } finally { discard(dir); w.dispose(); }
  });
}

test("F10: an answer reader's submit_verdict and record_reading without `universe` reach the universe that issued its brief", async () => {
  const w = await twoUniverses();
  const dir = mkdtempSync(join(tmpdir(), "codemap-xu-tx-"));
  try {
    const s = await repairable(w.settlement, new RepairConnection(PRINCIPAL));
    ok(await postRound(w.settlement.root, { round: { id: "R1", source: "review" }, decisions: [{ id: "d1", round: "R1", ref: "D1", kind: "options",
      payload: { question: `D1: does ${s.finding} remain a defect?`, options: [{ label: "Not a defect" }, { label: "Real, fix it" }] },
      options: [{ label: "Not a defect", effects: [{ findings: [s.finding], on: "settle", as: "refuted" }] }, { label: "Real, fix it", effects: [{ findings: [s.finding], on: "unblock" }] }] }] }));
    const words = await relayAnswer(w.settlement.root, { round: "R1", decision: "d1", words: "it is not a defect" }) as { answer: string };
    ok(words);
    const decision = (await decisionsView(w.settlement.root)).s.decisions.find((d) => d.label === "d1")!.id;
    const answer = { ...s, answer: words.answer };
    const brief = await readerBrief(w.settlement.root, { answer: answer.answer, maps: [{ decision, option: "Not a defect" }] }) as { request: string; prompt: string };
    ok(brief);
    // Recording an answer reader also needs the asking session's transcript (decision-ops.test.ts);
    // routing is what F6 changed, so this pins that each call lands where the brief was issued.
    const [held] = await mcp(w.manifest, dir, [{ name: "submit_verdict", arguments: { answer: answer.answer, request: brief.request, verdict: "D1 → Not a defect" } }]);
    assert.equal(held.held, true, JSON.stringify(held));
    const [routed, explicit, primary] = await mcp(w.manifest, dir, [
      { name: "record_reading", arguments: { answer: answer.answer } },
      { name: "record_reading", arguments: { answer: answer.answer, universe: "settlement" } },
      { name: "record_reading", arguments: { answer: answer.answer, universe: "api" } }]);
    assert.deepEqual(routed, explicit);
    assert.notDeepEqual(routed, primary, "only settlement holds the verdict, so the routing is observable");
  } finally { discard(dir); w.dispose(); }
});

test("F16: repair_batch_brief with `workspace` returns every universe's slot-1 batch in one answer, and one subagent on its lines records both", async () => {
  const w = await twoUniverses();
  const dir = mkdtempSync(join(tmpdir(), "codemap-xu-tx-"));
  try {
    const orchestrator = new RepairConnection(PRINCIPAL);
    const jobs = [{ u: w.api, r: await repairable(w.api, orchestrator) }, { u: w.settlement, r: await repairable(w.settlement, orchestrator) }];
    const [both, none] = await mcp(w.manifest, dir, [{ name: "repair_batch_brief", arguments: { review: "7", role: "verifier", slot: 1, workspace: true } },
      { name: "repair_batch_brief", arguments: { review: "7", role: "verifier", slot: 2, workspace: true } }]);
    ok(both);
    assert.deepEqual(both.batches.map((b: { universe: string }) => b.universe), ["api", "settlement"]);
    assert.equal(both.universe, undefined, "a workspace answer is not stamped with one universe");
    assert.match(String(none.error), /no universe has an open slot 2/, "low stakes: no slot 2 anywhere");
    const calls = [];
    for (const { u, r } of jobs) {
      const results = fixedBy(u, r.finding);
      const input = { review: "7", requestId: r.requestId, slot: 1, results, universe: u.id };
      const held = await submitRepairVerification(u.root, 7, { requestId: r.requestId, slot: 1, results }, orchestrator) as { held: boolean; receipt: string };
      assert.equal(held.held, true, JSON.stringify(held));
      calls.push({ u, r, input, held });
    }
    batchTranscript(dir, "a9500001", `Verify the cluster.\n${both.launch}\n`, calls.map((c) => ({ input: c.input, result: c.held })));
    for (const c of calls) ok(await recordRepairVerification(c.u.root, 7, { requestId: c.r.requestId, role: "verifier", slot: 1, receipt: c.held.receipt }, dir));
  } finally { discard(dir); w.dispose(); }
});
