import { test } from "node:test";
import assert from "node:assert/strict";
import { team, settle } from "./oracle.js";
import { shareFinding } from "./ops-shared.js";
import { postRepairSort, recordRepairClaims, recordRepairEvidence, repairRecords } from "./ops/repairs.js";
import { RepairConnection } from "./verifier-boundary.js";
import { repairFindingCompleteness, type RepairSortInput, type RepairEvidenceInput } from "./repair-records.js";
import { readFinding } from "./store.js";
import { rpc } from "./test-mcp.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ok = (v: unknown) => assert.equal((v as { error?: string }).error, undefined, JSON.stringify(v));
const sort = (findingId: string, claims: string[]): Omit<RepairSortInput, "id"> => ({ classification: "implementation-defect", kind: "isolated",
  source: "owner worklist: fix both independent obligations", coverage: [{ findingId, claimIds: [`${findingId}:original`, ...claims] }],
  restsOn: [], provenance: "owner-reviewed", assessments: [], disagreements: [] });
const sha = "a".repeat(40);

test("repair ops preserve original scope and sync partial evidence", async () => {
  const t = await team(["alice@acme.test", "bob@acme.test"]);
  try {
    const root = t.all[0]!.repo, peer = t.all[1]!.repo;
    const f = await shareFinding(root, 7, { targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "first and second obligations" }) as { id: string };
    ok(f);
    const claimed = await recordRepairClaims(root, 7, { findingId: f.id, parentId: `${f.id}:original`, reason: "separate independent clauses",
      claims: [{ text: "first obligation" }, { text: "second obligation" }] });
    ok(claimed);
    const [c1, c2] = (claimed as { claims: { id: string }[] }).claims.map(c => c.id) as [string, string];
    const posted = await postRepairSort(root, 7, sort(f.id, [c1, c2]));
    ok(posted);
    const sortId = (posted as { id: string }).id;
    const evidence: Omit<RepairEvidenceInput, "id"> = { sortId, witnessCommit: sha, baseCommit: sha, fixCommit: sha,
      coverage: [{ findingId: f.id, claimIds: [c1], result: "complete", reason: "first checked",
        claimResults: [{ claimId: c1, result: "complete", reason: "specific first claim" }] }],
      reproducer: [], regression: [{ id: "suite", command: "echo regression-only", commit: sha,
        environment: "isolated fixture", phase: "regression", outcome: "passed", exitCode: 0 }],
      inspected: [], noCheckReason: "no useful original reproducer supplied", rulingIds: [], attribution: [] };
    const pendingEvidence = recordRepairEvidence(root, 7, evidence);
    evidence.regression[0]!.command = "changed caller alias";
    const recorded = await pendingEvidence;
    ok(recorded);
    const evidenceId = (recorded as { id: string }).id;
    await settle(t);
    const ours = await repairRecords(root, 7), theirs = await repairRecords(peer, 7);
    assert.ok("records" in ours && ours.records && "records" in theirs && theirs.records);
    assert.deepEqual(ours.records, theirs.records);
    assert.equal(theirs.records.evidence[0]!.input.regression[0]!.command, "echo regression-only");
    assert.equal(repairFindingCompleteness(theirs.records, evidenceId, f.id), "partial");
    assert.equal(theirs.coverage![evidenceId]![0]!.completeness, "partial");
    assert.equal(theirs.records.claims[0]!.text, "first and second obligations");
    assert.notEqual((await readFinding(peer, f.id, { pr: 7 }))!.state, "resolved");
    assert.equal(theirs.records.sorts[0]!.eligible, true);
    const correction = await postRepairSort(root, 7, { ...sort(f.id, [c1, c2]), prior: sortId, reason: "a new classification" });
    assert.ok("records" in correction && correction.records && "id" in correction);
    const unruled = await postRepairSort(root, 7, { ...sort(f.id, [c1, c2]), prior: sortId, reason: "as ruled", ruling: "ans_that_does_not_exist" });
    assert.match(String((unruled as { error?: string }).error), /not a verified, standing answer/, "R5: the op checks the ruling exists");
    // A retry of the same record is the same record, not a second, competing sort.
    const again = await postRepairSort(root, 7, sort(f.id, [c1, c2]));
    assert.ok("alreadyRecorded" in again && again.alreadyRecorded && again.id === sortId, JSON.stringify(again));
    assert.equal(again.records.sorts.length, 2);
    const chosen = await postRepairSort(root, 7, { ...sort(f.id, [c1, c2]), id: "s1" } as Omit<RepairSortInput, "id">);
    assert.match((chosen as { error: string }).error, /codemap assigns/);
    const malformed = await recordRepairEvidence(root, 7, { ...evidence, regression: [{ ...evidence.regression[0]!, exitCode: undefined }] });
    assert.match((malformed as { error: string }).error, /execution/);
    const pointer = join(root, ".codemap", "sidecar"), original = readFileSync(pointer, "utf8");
    try {
      writeFileSync(pointer, join(root, "missing-sidecar"));
      const unavailable = await repairRecords(root, 7);
      assert.ok("records" in unavailable && unavailable.records);
      assert.equal(unavailable.status, "blocked");
      assert.equal(unavailable.records.evidence.length, 1);
      const refused = await postRepairSort(root, 7, { ...sort(f.id, [c1]), source: "unavailable" });
      assert.ok("error" in refused);
    } finally { writeFileSync(pointer, original); }
  } finally { t.dispose(); }
});

test("over MCP a connection that has worked cannot claim the verifier role; a claimed one cannot read the repair records", async () => {
  const t = await team(["alice@acme.test"]);
  try {
    const root = t.all[0]!.repo;
    const worked = await rpc(root, [{ name: "repair_records", arguments: { review: "7" } }, { name: "claim_verifier", arguments: {} }]);
    assert.doesNotMatch(worked[0]!, /^Error/);
    assert.match(worked[1]!, /before any other codemap call/);
    const verifier = await rpc(root, [{ name: "claim_verifier", arguments: {} }, { name: "repair_records", arguments: { review: "7" } }]);
    ok(JSON.parse(verifier[0]!));
    // B13: the records show the fixer's evidence and the other runs, which a blind verifier must not read.
    assert.match(verifier[1]!, /verifier role does not allow repair_records/);
  } finally { t.dispose(); }
});

test("B16: the same sort posted by an agent and then by its person are two records, so the person's authorship enters the log", async () => {
  const t = await team(["alice@acme.test"]);
  const before = process.env.CODEMAP_AGENT_MODEL;
  try {
    const root = t.all[0]!.repo;
    const f = await shareFinding(root, 7, { targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "one obligation" }) as { id: string };
    ok(f);
    const same = sort(f.id, []);
    process.env.CODEMAP_AGENT_MODEL = "claude-opus-5";
    const byAgent = await postRepairSort(root, 7, same) as { id: string; records: { sorts: { input: { id: string }; holds: string[] }[] } };
    ok(byAgent);
    assert.ok(byAgent.records.sorts.find(s => s.input.id === byAgent.id)!.holds.some(h => /principal authorship/.test(h)), "an agent's owner-reviewed sort is held");
    delete process.env.CODEMAP_AGENT_MODEL;
    const byPerson = await postRepairSort(root, 7, same) as { id: string; alreadyRecorded?: boolean };
    ok(byPerson);
    assert.notEqual(byPerson.id, byAgent.id, "not collapsed into the agent's record");
    assert.equal(byPerson.alreadyRecorded, undefined);
  } finally {
    if (before === undefined) delete process.env.CODEMAP_AGENT_MODEL; else process.env.CODEMAP_AGENT_MODEL = before;
    t.dispose();
  }
});
