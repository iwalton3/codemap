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
import { releaseRuledSort } from "./ops/repair-release.js";
import { postRound, answerDirect } from "./ops/decisions.js";
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
