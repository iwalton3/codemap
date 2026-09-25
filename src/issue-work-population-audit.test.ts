import { test } from "node:test";
import assert from "node:assert/strict";
import { team } from "./oracle.js";
import { shareFinding, reassignFinding, reportOnFinding, sharedFindings, findingBacklog } from "./ops-shared.js";
import { postRound } from "./ops/decisions.js";
import { closeFinding as closeFindingOp } from "./ops.js";
import { readFinding } from "./store.js";
import { reviewQueue } from "./ops/annotations.js";
import { decisionsView } from "./ops/decision-holds.js";
import { resolveDecisionIssue } from "./decision-issues.js";
import { universeKey } from "./sidecar-config.js";

test("typed finding restriction withholds assigned work and refuses a fixed outcome", async () => {
  const t = await team(["ana@acme.test"]);
  try {
    const root = t.all[0]!.repo;
    const filed = await shareFinding(root, 7, {
      targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "transfer accepts a bad amount",
    }) as any;
    assert.equal(filed.ok, true, JSON.stringify(filed));
    const resolved = await resolveDecisionIssue(root, {
      kind: "finding", universe: universeKey(root), review: 7, id: filed.id,
    });
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    if (!resolved.ok) return;
    const assigned = await reassignFinding(root, 7, filed.id, { kind: "fix" }) as any;
    assert.equal(assigned.ok, true, JSON.stringify(assigned));
    const unrelated = await shareFinding(root, 7, {
      targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "a separate transfer concern",
    }) as any;
    assert.equal(unrelated.ok, true, JSON.stringify(unrelated));
    const unrelatedAssignment = await reassignFinding(root, 7, unrelated.id, { kind: "fix" }) as any;
    assert.equal(unrelatedAssignment.ok, true, JSON.stringify(unrelatedAssignment));

    const decision = {
      id: "typed-finding", round: "R1", ref: "D1", kind: "options" as const,
      payload: { question: `D1: settle ${filed.id}?`, options: [
        { label: "Invalid", description: "The premise is false" },
        { label: "Repair", description: "Fix the code" },
      ] },
      options: [
        { label: "Invalid", effects: [{ findings: [], issues: [resolved.ref], on: "settle" as const, as: "refuted" as const }] },
        { label: "Repair", effects: [{ findings: [], issues: [resolved.ref], on: "unblock" as const }] },
      ],
    };
    const posted = await postRound(root, { round: { id: "R1", source: "audit" }, decisions: [decision] }) as any;
    assert.equal(posted.ok, true, JSON.stringify(posted));
    const view = await decisionsView(root);
    assert.equal(view.issueWork(resolved.ref).allowed, false, "the canonical typed hold is active");

    const listing = await sharedFindings(root, 7) as any;
    assert.ok(listing.findings.find((item: any) => item.id === filed.id)?.held?.length, "shared listing marks the exact finding as held");
    const backlog = await findingBacklog(root) as any;
    const backlogRow = Object.values(backlog).flatMap((value: any) => Array.isArray(value) ? value : [])
      .find((item: any) => item.id === filed.id) as any;
    assert.equal(backlogRow?.work?.allowed, false, "backlog row keeps the typed work restriction visible");
    const row = await readFinding(root, filed.id, { pr: "7" });
    assert.equal(row?.origin?.scope, resolved.ref.scope, "generic actions read a store row with canonical provenance");
    const queue = await reviewQueue(root);
    assert.ok(queue.queue.some((item) => item.id === unrelated.id), "unrelated assigned work remains offered");
    const offeredForWork = queue.queue.some((item) => item.id === filed.id);
    const reported = await reportOnFinding(root, 7, filed.id, "fixed", "Repaired the code", ["src/pay.ts"]) as any;
    const genericReport = await closeFindingOp(root, { id: filed.id, result: "fixed", detail: "Repaired the code", files: ["src/pay.ts"] }) as any;
    assert.deepEqual({ offeredForWork, fixedOutcomeRefused: !!reported.error, genericFixedOutcomeRefused: !!genericReport.error },
      { offeredForWork: false, fixedOutcomeRefused: true, genericFixedOutcomeRefused: true });
    const unrelatedReport = await reportOnFinding(root, 7, unrelated.id, "fixed", "Repaired separate concern", ["src/pay.ts"]) as any;
    assert.equal(unrelatedReport.ok, true, JSON.stringify(unrelatedReport));
  } finally {
    t.dispose();
  }
});
