import { test } from "node:test";
import assert from "node:assert/strict";
import { team, settle } from "./oracle.js";
import { shareFinding } from "./ops-shared.js";
import { postRepairSort, recordRepairClaims, recordRepairEvidence, recordRepairParticipant, repairRecords } from "./ops/repairs.js";
import { issueRepairParticipation } from "./repair-participation.js";
import { repairFindingCompleteness, type RepairSortInput, type RepairEvidenceInput } from "./repair-records.js";
import { readFinding, trustedRepairParticipants } from "./store.js";
import { rpc } from "./test-mcp.js";
import { codexVerifierFixture } from "./test-codex-verifier.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ok = (v: unknown) => assert.equal((v as { error?: string }).error, undefined, JSON.stringify(v));
const sort = (findingId: string): RepairSortInput => ({ id: "sort1", classification: "implementation-defect", kind: "isolated",
  source: "owner worklist: fix both independent obligations", coverage: [{ findingId, claimIds: [`${findingId}:original`, "c1", "c2"] }],
  restsOn: [], provenance: "owner-reviewed", assessments: [], disagreements: [] });
const sha = "a".repeat(40);

test("repair ops preserve original scope, sync partial evidence, and reject caller participant identity", async () => {
  const t = await team(["alice@acme.test", "bob@acme.test"]);
  try {
    const root = t.all[0]!.repo, peer = t.all[1]!.repo;
    const f = await shareFinding(root, 7, { targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "first and second obligations" }) as { id: string };
    ok(f);
    ok(await recordRepairClaims(root, 7, { findingId: f.id, parentId: `${f.id}:original`, reason: "separate independent clauses",
      claims: [{ id: "c1", text: "first obligation" }, { id: "c2", text: "second obligation" }] }));
    ok(await postRepairSort(root, 7, sort(f.id)));
    const evidence: RepairEvidenceInput = { id: "proof1", sortId: "sort1", witnessCommit: sha, baseCommit: sha, fixCommit: sha,
      coverage: [{ findingId: f.id, claimIds: ["c1"], result: "complete", reason: "first checked",
        claimResults: [{ claimId: "c1", result: "complete", reason: "specific first claim" }] }],
      reproducer: [], changeFalsifier: [], regression: [{ id: "suite", command: "echo regression-only", commit: sha,
        environment: "isolated fixture", phase: "regression", outcome: "passed", exitCode: 0 }],
      inspected: [], noCheckReason: "no useful original reproducer supplied", rulingIds: [], attribution: [] };
    const pendingEvidence = recordRepairEvidence(root, 7, evidence);
    evidence.regression[0]!.command = "changed caller alias";
    ok(await pendingEvidence);
    const invalid = await recordRepairParticipant(root, 7, { repairId: "sort1", role: "fixer" }, {} as never);
    assert.match((invalid as { error: string }).error, /server-resolved/);
    await settle(t);
    const ours = await repairRecords(root, 7), theirs = await repairRecords(peer, 7);
    assert.ok("records" in ours && ours.records && "records" in theirs && theirs.records);
    assert.deepEqual(ours.records, theirs.records);
    assert.equal(theirs.records.evidence[0]!.input.regression[0]!.command, "echo regression-only");
    assert.equal(repairFindingCompleteness(theirs.records, "proof1", f.id), "partial");
    assert.equal(theirs.coverage!.proof1![0]!.completeness, "partial");
    assert.equal(theirs.records.claims[0]!.text, "first and second obligations");
    assert.notEqual((await readFinding(peer, f.id, { pr: 7 }))!.state, "resolved");
    const capability = issueRepairParticipation({ principal: "alice@acme.test", harness: "codex", session: "fixer-session" });
    ok(await recordRepairParticipant(root, 7, { repairId: "sort1", role: "fixer" }, capability));
    await settle(t);
    assert.equal(trustedRepairParticipants(peer)[0]!.identity.session, "fixer-session");
    const after = await repairRecords(peer, 7);
    assert.ok("records" in after && after.records);
    assert.equal(after.records.sorts[0]!.eligible, true);
    const correction = await postRepairSort(root, 7, { ...sort(f.id), id: "fixer-correction", prior: "sort1", reason: "fixer proposes a new classification" });
    assert.ok("records" in correction && correction.records);
    assert.ok(correction.records.sorts.find(s => s.input.id === "fixer-correction")!.holds.some(h => h.includes("fixer")));
    const duplicate = await postRepairSort(root, 7, sort(f.id));
    assert.match((duplicate as { error: string }).error, /duplicate/);
    const malformed = await recordRepairEvidence(root, 7, { ...evidence, id: "bad", regression: [{ ...evidence.regression[0]!, exitCode: undefined }] });
    assert.match((malformed as { error: string }).error, /execution/);
    const pointer = join(root, ".codemap", "sidecar"), original = readFileSync(pointer, "utf8");
    try {
      writeFileSync(pointer, join(root, "missing-sidecar"));
      const unavailable = await repairRecords(root, 7);
      assert.ok("records" in unavailable && unavailable.records);
      assert.equal(unavailable.status, "blocked");
      assert.equal(unavailable.records.evidence.length, 1);
      const refused = await postRepairSort(root, 7, { ...sort(f.id), id: "unavailable" });
      assert.ok("error" in refused);
    } finally { writeFileSync(pointer, original); }
  } finally { t.dispose(); }
});

test("native MCP participation binds host metadata and excludes that identity from verifier claims", async () => {
  const t = await team(["alice@acme.test"]), f = codexVerifierFixture();
  try {
    const root = t.all[0]!.repo;
    const replies = await rpc(root, [{ name: "record_repair_participant", arguments: { review: "7", repairId: "repair1", role: "fixer" }, _meta: f.options.requestMeta }],
      { clientInfo: f.options.clientInfo, env: { CODEMAP_CODEX_TRANSCRIPT_DIR: f.options.transcriptDir } });
    ok(JSON.parse(replies[0]!));
    assert.deepEqual(trustedRepairParticipants(root), [{ identity: { principal: "alice@acme.test", harness: "codex", session: "parent", child: "child" }, role: "fixer" }]);
    const claim = await rpc(root, [{ name: "claim_verifier", arguments: {}, _meta: f.options.requestMeta }],
      { clientInfo: f.options.clientInfo, env: { CODEMAP_CODEX_TRANSCRIPT_DIR: f.options.transcriptDir } });
    assert.match(claim[0]!, /fixer|domain work/);
    const unmeasured = await rpc(root, [{ name: "record_repair_participant", arguments: { review: "7", repairId: "repair2", role: "relayer" },
      _meta: { threadId: "future-child", sessionId: "future-parent" } }],
      { clientInfo: { ...f.options.clientInfo, version: "future" } });
    assert.match(unmeasured[0]!, /native host session metadata/);
    assert.equal(trustedRepairParticipants(root).length, 1);
  } finally { f.clean(); t.dispose(); }
});
