import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as ops from "../ops.js";
import { shareFinding, sharedFindings, findingRecord } from "../ops-shared.js";
import { readFinding } from "../store.js";
import { resolvePlaywright, launchPlaywright, startServer } from "./harness.js";
import { discard } from "../test-tmp.js";
import { RepairVerifierBoundary } from "../verifier-boundary.js";
import { RepairSealService } from "../repair-seals.js";
import { repairVerificationHash, repairVerificationPayload, type RepairVerificationCapsule } from "../repair-verification.js";
import { emitEvent } from "../eventlog.js";
import { requireActor } from "../identity.js";
import { issueClaimHash } from "../ruling-application.js";
import { issueRepairParticipation } from "../repair-participation.js";
import { decisionsView } from "../ops/decision-holds.js";

const pw = resolvePlaywright();
test("repair page retains original scope, separate evidence outcomes and the closure gate", {
  skip: pw ? false : "playwright not resolvable (set CODEMAP_E2E_PLAYWRIGHT)",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-repairs-ui-"));
  const side = mkdtempSync(join(tmpdir(), "codemap-repairs-ui-side-"));
  let browser: any, server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git("init", "-q", "-b", "main"); git("config", "user.email", "alice@x.test"); git("config", "user.name", "Alice");
    mkdirSync(join(root, ".codemap")); mkdirSync(join(root, "src"));
    writeFileSync(join(root, ".codemap", "sidecar"), side);
    writeFileSync(join(root, "src", "credits.ts"), "export function credit(n: number) { return n; }\n");
    git("add", "-A"); git("commit", "-qm", "seed");
    const commit = git("rev-parse", "HEAD");
    await ops.init(root);
    const search = await ops.search(root, "credit") as any;
    const finding = await shareFinding(root, 7, { targetKind: "anchor", targetId: search.anchors[0].id, text: "Negative credits and duplicate credits are accepted." }) as any;
    assert.ok(finding.id, JSON.stringify(finding));
    const initialState = (await readFinding(root, finding.id))?.state;
    const original = `${finding.id}:original`;
    const decomposition = await ops.recordRepairClaims(root, 7, { findingId: finding.id, parentId: original,
      reason: "Separate the two claims without removing the original.", claims: [{ id: "negative", text: "Negative credits are accepted." }, { id: "duplicate", text: "Duplicate credits are accepted." }] });
    assert.ok("ok" in decomposition && decomposition.ok, JSON.stringify(decomposition));
    const marker = join(root, "command-must-not-run");
    const sort = await ops.postRepairSort(root, 7, { id: "sort-first", classification: "implementation-defect", kind: "isolated",
      provenance: "owner-reviewed", source: "Owner-reviewed exact input-2 worklist", coverage: [{ findingId: finding.id, claimIds: [original, "negative", "duplicate"] }], restsOn: [], assessments: [], disagreements: [],
    });
    assert.ok("ok" in sort && sort.ok, JSON.stringify(sort));
    const revised = await ops.postRepairSort(root, 7, { id: "sort-correction", prior: "sort-first", reason: "A requirement dependency was overlooked.",
      classification: "design", kind: "isolated", provenance: "owner-reviewed", source: "Owner-reviewed correction",
      coverage: [{ findingId: finding.id, claimIds: [original, "negative", "duplicate"] }], restsOn: ["req-credit"], assessments: [],
      disagreements: [{ id: "conflict-scope", text: "The duplicate policy needs a ruling." }],
      arbitration: { addresses: ["conflict-scope"], reason: "Keep the dependency until the owner rules.", identity: { principal: "Alice", harness: "codex", session: "arbitrator-source" } },
    });
    assert.ok("ok" in revised && revised.ok, JSON.stringify(revised));
    const evidence = await ops.recordRepairEvidence(root, 7, { id: "partial-report", sortId: "sort-first",
      witnessCommit: commit, baseCommit: commit, fixCommit: commit,
      coverage: [{ findingId: finding.id, claimIds: [original, "negative"], result: "partial", reason: "Duplicate credits remain unchecked.", claimResults: [{ claimId: original, result: "partial", reason: "Duplicate credits remain unchecked." }, { claimId: "negative", result: "complete", reason: "The negative claim has a run." }] }],
      reproducer: [{ id: "repro", command: `touch ${marker}`, phase: "witness", commit, environment: "isolated scratch clone", outcome: "failed", exitCode: 1, stdout: "negative credit persists" }],
      changeFalsifier: [{ id: "falsifier", command: "node reversal-test.js", phase: "reversal", reversedHunks: ["guard"], commit, environment: "isolated scratch clone", outcome: "unknown", reason: "Required environment unavailable." }],
      regression: [{ id: "suite", command: "npm test", phase: "regression", commit, environment: "isolated scratch clone", outcome: "passed", exitCode: 0 }],
      inspected: [{ source: "src/credits.ts", commit, reasoning: "The source returns the input directly." }],
      noCheckReason: "No useful duplicate-credit fixture exists yet.", rulingIds: [], attribution: [],
    });
    assert.ok("ok" in evidence && evidence.ok, JSON.stringify(evidence));
    assert.equal(existsSync(marker), false, "recording a command must not execute it");
    const beforeVerification = await ops.repairRecords(root, 7);
    assert.ok("records" in beforeVerification && beforeVerification.records);
    const verificationFinding = await shareFinding(root, 7, { targetKind: "anchor", targetId: search.anchors[0].id, text: "Credit verification fixture requires an independent check." }) as { id: string };
    const verificationClaim = `${verificationFinding.id}:original`;
    const independentSort = { ...beforeVerification.records.sorts[0]!.input, id: "verification-sort", coverage: [{ findingId: verificationFinding.id, claimIds: [verificationClaim] }] };
    const independentSortResult = await ops.postRepairSort(root, 7, independentSort);
    assert.ok("ok" in independentSortResult && independentSortResult.ok, JSON.stringify(independentSortResult));
    const independentEvidence = { ...beforeVerification.records.evidence[0]!.input, id: "verification-evidence", sortId: independentSort.id,
      coverage: [{ findingId: verificationFinding.id, claimIds: [verificationClaim], result: "unknown" as const, reason: "Environment unavailable.", claimResults: [{ claimId: verificationClaim, result: "unknown" as const, reason: "Environment unavailable." }] }] };
    const independentEvidenceResult = await ops.recordRepairEvidence(root, 7, independentEvidence);
    assert.ok("ok" in independentEvidenceResult && independentEvidenceResult.ok, JSON.stringify(independentEvidenceResult));
    const records = await ops.repairRecords(root, 7);
    assert.ok("records" in records && records.records);
    const actor = requireActor(root);
    assert.ok(!("error" in actor));
    const participant = await ops.recordRepairParticipant(root, 7, { repairId: independentSort.id, role: "fixer" },
      issueRepairParticipation({ principal: actor.principal, harness: "codex", session: "browser-fixer" }));
    assert.ok("ok" in participant && participant.ok, JSON.stringify(participant));
    const service = new RepairSealService({ loadKey: () => undefined, saveKey: () => {} });
    const producer = service.publicProducer();
    await emitEvent(side, records.scope, actor, "repair.verification-producer", producer.producerKeyId, { ...producer });
    const orchestrator = { principal: actor.principal, harness: "codex", session: "browser-orchestrator" };
    const verificationTarget = (await readFinding(root, verificationFinding.id))!;
    const capsule: RepairVerificationCapsule = { scope: records.scope,
      targets: [{ findingId: verificationFinding.id, openEpoch: verificationTarget.openEpoch!, claimHash: issueClaimHash("finding", verificationTarget) }],
      code: { witnessCommit: commit, baseCommit: commit, fixCommit: commit, diff: "", availability: "available" },
      claims: records.records.claims.filter(claim => claim.findingId === verificationFinding.id), sort: independentSort, evidence: independentEvidence,
      rulingContext: JSON.stringify({ decisions: (await decisionsView(root)).s, eligibility: [] }), orchestrator };
    const request = { id: "browser-request", capsule, capsuleHash: repairVerificationHash(capsule) };
    const orchestratorBoundary = new RepairVerifierBoundary({ context: { supported: true, identity: orchestrator }, participants: () => [] });
    assert.equal(orchestratorBoundary.claim().ok, true);
    const requestCapability = orchestratorBoundary.sealCapability(request.id, repairVerificationPayload("repair.verification-requested", request.id, request));
    assert.ok(!("error" in requestCapability));
    const requestSeal = service.seal(requestCapability);
    assert.ok(!("error" in requestSeal));
    await emitEvent(side, records.scope, actor, "repair.verification-requested", request.id, { ...request, seal: requestSeal });
    const verifier = { principal: actor.principal, harness: "codex", session: "browser-verifier" };
    const boundary = new RepairVerifierBoundary({ context: { supported: true, identity: verifier }, participants: () => [] });
    assert.equal(boundary.claim().ok, true);
    const run = { id: "browser-run", requestId: request.id, capsuleHash: request.capsuleHash, slot: 1,
      identity: verifier, connectionId: boundary.connectionId, results: [{ findingId: verificationFinding.id, claimId: verificationClaim,
        verdict: "unknown", reason: "The independently requested environment is unavailable.", grade: "none", executions: [], inspected: [], noCheckReason: "No executable check could run." }] };
    const runCapability = boundary.sealCapability(request.id, repairVerificationPayload("repair.verification-sealed", run.id, run));
    assert.ok(!("error" in runCapability));
    const runSeal = service.seal(runCapability);
    assert.ok(!("error" in runSeal));
    await emitEvent(side, records.scope, actor, "repair.verification-sealed", run.id, { ...run, seal: runSeal });
    server = await startServer(root); browser = await launchPlaywright(pw);
    const universe = (await (await fetch(`${server.url}/api/universes`)).json() as any).primary;
    const served = await (await fetch(`${server.url}/api/repairs?u=${universe}&review=7`)).json() as any;
    assert.equal(served.records.evidence.length, 2);
    const page = await browser.newPage(), errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    page.on("console", (message: any) => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(`${server.url}/#/u/${universe}/repairs/7/`, { waitUntil: "networkidle" });
    await page.waitForSelector(".repair-evidence", { timeout: 10_000 });
    const text = await page.textContent("main");
    for (const expected of ["Negative credits and duplicate credits are accepted.", "sort-first", "sort-correction", "A requirement dependency was overlooked.", "The duplicate policy needs a ruling.", "Keep the dependency until the owner rules.", "reported partial", "Duplicate credits remain unchecked.",
      "Finding reproducer", "Change falsifier", "Regression runs", "failed · exit 1", "unknown", "Required environment unavailable.", "passed · exit 0",
      "weaker inspection grade", "No useful duplicate-credit fixture exists yet.", "Repair closure is gated", "partial coverage cannot resolve a whole finding"])
      assert.ok(text.includes(expected), `${expected} missing from ${text}`);
    for (const expected of ["browser-request", "Sealed verifier slot 1", "The independently requested environment is unavailable.", "incomplete bounded coverage", "Not applied."])
      assert.ok(text.includes(expected), `${expected} missing from ${text}`);
    assert.equal(text.includes("Stale verification:"), false, "the fresh canonical receipt is not already stale");
    const changed = await ops.postRepairSort(root, 7, { ...independentSort, id: "verification-sort-moved", prior: independentSort.id,
      reason: "New requirement context needs review.", classification: "design", restsOn: ["new-requirement"] });
    assert.ok("ok" in changed && changed.ok, JSON.stringify(changed));
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("text=Stale verification:", { timeout: 10_000 });
    const staleText = await page.textContent("main");
    assert.ok(staleText.includes("Historical evidence cannot establish current applicability."));
    assert.ok(staleText.includes("Sealed verifier slot 1"), "staleness retains the earlier independent run");
    const closureFinding = await shareFinding(root, 7, { targetKind: "anchor", targetId: search.anchors[0].id, text: "Independent historical closure fixture." }) as { id: string };
    const closureClaim = `${closureFinding.id}:original`;
    const closureSort = { ...independentSort, id: "closure-sort", coverage: [{ findingId: closureFinding.id, claimIds: [closureClaim] }] };
    const closureSortResult = await ops.postRepairSort(root, 7, closureSort);
    assert.ok("ok" in closureSortResult && closureSortResult.ok, JSON.stringify(closureSortResult));
    const closureEvidence = await ops.recordRepairEvidence(root, 7, { id: "closure-evidence", sortId: closureSort.id,
      witnessCommit: commit, baseCommit: commit, fixCommit: commit,
      coverage: [{ findingId: closureFinding.id, claimIds: [closureClaim], result: "complete", reason: "fixture scope inspected", claimResults: [{ claimId: closureClaim, result: "complete", reason: "fixture scope inspected" }] }],
      reproducer: [], changeFalsifier: [], regression: [], inspected: [], noCheckReason: "synthetic inspection fixture", rulingIds: [], attribution: [] });
    assert.ok("ok" in closureEvidence && closureEvidence.ok, JSON.stringify(closureEvidence));
    const fixer = await ops.recordRepairParticipant(root, 7, { repairId: closureSort.id, role: "fixer" },
      issueRepairParticipation({ principal: actor.principal, harness: "codex", session: "closure-fixer" }));
    assert.ok("ok" in fixer && fixer.ok, JSON.stringify(fixer));
    const makeHost = (session: string) => {
      const boundary = new RepairVerifierBoundary({ context: { supported: true, identity: { principal: actor.principal, harness: "codex", session } }, participants: () => [] });
      assert.equal(boundary.claim().ok, true);
      return { boundary };
    };
    const closureHost = makeHost("closure-orchestrator");
    const closureRequest = await ops.requestRepairVerification(root, 7, { sortId: closureSort.id, evidenceId: "closure-evidence" }, closureHost);
    assert.ok("request" in closureRequest && closureRequest.request, JSON.stringify(closureRequest));
    for (const slot of [1, 2] as const) {
      const verifierHost = makeHost(`closure-verifier-${slot}`);
      const brief = await ops.repairVerificationBrief(root, 7, { requestId: closureRequest.request.id, role: "verifier", slot }, verifierHost);
      assert.ok(!("error" in brief), JSON.stringify(brief));
      const submitted = await ops.submitRepairVerification(root, 7, { requestId: closureRequest.request.id, slot, results: [{ findingId: closureFinding.id, claimId: closureClaim,
        verdict: "fixed", grade: "inspection", reason: "Independent inspection of the fixture's exact source.", executions: [],
        inspected: [{ source: "src/credits.ts", commit, reasoning: "Synthetic independent source inspection." }], noCheckReason: "synthetic inspection fixture" }] }, verifierHost);
      assert.ok("ok" in submitted && submitted.ok, JSON.stringify(submitted));
    }
    const applied = await ops.applyRepairVerification(root, 7, { requestId: closureRequest.request.id, findingId: closureFinding.id, reason: "Two independent inspections cover the fixture." }, closureHost);
    assert.ok("ok" in applied && applied.ok, JSON.stringify(applied));
    assert.equal((await readFinding(root, closureFinding.id))?.state, "resolved");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".repair-lifecycle", { timeout: 10_000 });
    const landedLifecycle = await page.locator(".repair-lifecycle").filter({ hasText: closureFinding.id }).textContent();
    assert.ok(landedLifecycle.includes("verified-repair-landed"), landedLifecycle);
    assert.ok(landedLifecycle.includes("Exact checked commit " + commit), landedLifecycle);
    assert.ok(landedLifecycle.includes("weaker inspection grade"), landedLifecycle);
    const queue = await ops.reviewQueue(root, { assignedOnly: false }) as any;
    assert.equal(queue.queue.some((f: any) => f.id === closureFinding.id), false, "verified closure leaves the working catalogue");
    const historyQueue = await ops.reviewQueue(root, { assignedOnly: false, includeResolved: true }) as any;
    assert.equal(historyQueue.queue.find((f: any) => f.id === closureFinding.id).repair.lifecycles[0].state, "verified-repair-landed");
    const searchHistory = await ops.search(root, "Independent historical closure fixture") as any;
    assert.equal(searchHistory.findings[0].repair.lifecycles[0].code.checkedCommit, commit);
    const issueHistory = await findingRecord(root, 7, closureFinding.id) as any;
    assert.equal(issueHistory.repair.lifecycles[0].applied, true);
    const sharedHistory = await sharedFindings(root, 7) as any;
    assert.equal(sharedHistory.findings.find((f: any) => f.id === closureFinding.id).repair.lifecycles[0].state, "verified-repair-landed");
    await page.goto(`${server.url}/#/u/${universe}/shared/7/?f=${closureFinding.id}`, { waitUntil: "networkidle" });
    await page.waitForSelector(".repair-presentation .repair-lifecycle", { timeout: 10_000 });
    assert.ok((await page.textContent("main")).includes("Verified repair landed"));
    assert.ok((await page.textContent("main")).includes("Checked commit " + commit));
    await page.goto(`${server.url}/#/u/${universe}/search/?q=Independent%20historical%20closure%20fixture`, { waitUntil: "networkidle" });
    await page.waitForSelector(".repair-presentation .repair-lifecycle", { timeout: 10_000 });
    assert.ok((await page.textContent("main")).includes("Verified repair landed"));
    await page.goto(`${server.url}/#/u/${universe}/repairs/7/`, { waitUntil: "networkidle" });
    writeFileSync(join(root, "src", "credits.ts"), "export function credit(n: number) { return n + 1; }\n");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".repair-lifecycle-attention", { timeout: 10_000 });
    const driftLifecycle = await page.locator(".repair-lifecycle").filter({ hasText: closureFinding.id }).textContent();
    assert.ok(driftLifecycle.includes("source moved"), driftLifecycle);
    assert.ok(driftLifecycle.includes("Historical or incomplete proof"), driftLifecycle);
    assert.equal((await readFinding(root, closureFinding.id))?.state, "resolved", "source drift preserves the completed closure");
    const driftSearch = await ops.search(root, "Independent historical closure fixture") as any;
    assert.equal(driftSearch.findings[0].repair.lifecycles[0].currentProof, false);
    assert.ok(driftSearch.findings[0].repair.lifecycles[0].attention.some((reason: string) => reason.includes("source moved")));
    const lateParticipant = await ops.recordRepairParticipant(root, 7, { repairId: closureSort.id, role: "fixer" },
      issueRepairParticipation({ principal: actor.principal, harness: "codex", session: "closure-verifier-1" }));
    assert.ok("ok" in lateParticipant && lateParticipant.ok, JSON.stringify(lateParticipant));
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".repair-closure-attention", { timeout: 10_000 });
    const attentionText = await page.textContent("main");
    assert.ok(attentionText.includes("Recorded historical closure"));
    assert.ok(attentionText.includes("Closure needs attention:"));
    assert.equal((await readFinding(root, closureFinding.id))?.state, "resolved", "late participant provenance raises attention without silently undoing the completed act");
    const lateOrchestrator = await ops.recordRepairParticipant(root, 7, { repairId: closureSort.id, role: "relayer" },
      issueRepairParticipation({ principal: actor.principal, harness: "codex", session: "closure-orchestrator" }));
    assert.ok("ok" in lateOrchestrator && lateOrchestrator.ok, JSON.stringify(lateOrchestrator));
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".historical-repair-closure", { timeout: 10_000 });
    assert.equal(await page.locator(".verification-request").filter({ hasText: closureRequest.request.id }).count(), 0,
      "late orchestrator participation invalidates current verification request");
    assert.ok((await page.textContent(".historical-repair-closure")).includes(closureFinding.id),
      "historical closure remains visible even when its request is currently invalid");
    assert.equal((await readFinding(root, closureFinding.id))?.state, "resolved");
    assert.equal(await page.locator("main button").count(), 0, "evidence commands must not become executable controls");
    assert.deepEqual(errors, []);
    assert.equal(existsSync(marker), false, "reading evidence must not execute it");
    assert.equal((await readFinding(root, finding.id))?.state, initialState, "repair evidence cannot close the finding");
  } finally { await browser?.close(); server?.stop(); discard(root); discard(side); }
});
