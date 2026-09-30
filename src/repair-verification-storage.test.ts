import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { team, settle } from "./oracle.js";
import { shareFinding } from "./ops-shared.js";
import { repairRecords, postRepairSort, recordRepairEvidence } from "./ops/repairs.js";
import { SHARD_EXT } from "./eventlog.js";
import { emitEvent } from "./write.js";
import { resolveSidecar, sidecarIdentity } from "./sidecar-config.js";
import { findingKeyScope } from "./review-target.js";
import { findingScope } from "./shared-findings.js";
import { db } from "./db.js";
import { readRepairVerification, readFinding } from "./store.js";
import { issueClaimHash } from "./ruling-application.js";
import { RepairConnection } from "./verifier-boundary.js";
import { MATERIALIZER_VERSION, foldCount } from "./materialize.js";
import { isRepairVerificationState, repairVerificationHash, type RepairVerificationState, type RepairVerificationCapsule } from "./repair-verification.js";
import { findingsProjection } from "./shared-projections.js";

function verificationOf(result: unknown): RepairVerificationState {
  assert.ok(result && typeof result === "object" && "verification" in result);
  assert.ok(isRepairVerificationState(result.verification));
  return result.verification;
}

function shardBytes(path: string, scope: string): string {
  const hash = createHash("sha256");
  for (const name of readdirSync(join(path, scope)).filter(name => name.endsWith(SHARD_EXT)).sort()) {
    hash.update(name); hash.update(readFileSync(join(path, scope, name)));
  }
  return hash.digest("hex");
}
/** The fingerprint the previous materializer version wrote, so the next read must refold. */
function previousFingerprint(path: string, scope: string, identity: string): string {
  const hash = createHash("sha256").update(`v${MATERIALIZER_VERSION - 1}\0${identity}\0${scope}\0`);
  for (const name of readdirSync(join(path, scope)).filter(name => name.endsWith(SHARD_EXT)).sort()) {
    const st = statSync(join(path, scope, name), { bigint: true });
    hash.update(`${name}\0${st.size}\0${st.mtimeNs}\0`);
  }
  return hash.digest("hex");
}

test("repair verification replays unchanged shards after an upgrade and retains rejected attempts", async () => {
  const t = await team(["alice@acme.test", "bob@acme.test"]);
  try {
    const root = t.all[0]!.repo, peer = t.all[1]!.repo, cfg = resolveSidecar(root)!;
    const finding = await shareFinding(root, 7, { targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "negative credit accepted" }) as { id: string };
    assert.ok(finding.id);
    const scope = findingScope(findingKeyScope(cfg, 7));
    const claimId = `${finding.id}:original`, sha = "a".repeat(40);
    const sorted = await postRepairSort(root, 7, { source: "exact owner input-2", provenance: "owner-reviewed",
      classification: "implementation-defect", kind: "isolated", coverage: [{ findingId: finding.id, claimIds: [claimId] }], restsOn: [], assessments: [], disagreements: [] });
    assert.ok("ok" in sorted && sorted.ok, JSON.stringify(sorted));
    const evidence = await recordRepairEvidence(root, 7, { sortId: sorted.id, witnessCommit: sha, baseCommit: sha, fixCommit: sha,
      coverage: [{ findingId: finding.id, claimIds: [claimId], result: "unknown", reason: "commit unavailable", claimResults: [{ claimId, result: "unknown", reason: "commit unavailable" }] }],
      reproducer: [], regression: [], inspected: [], noCheckReason: "required commit unavailable", rulingIds: [], attribution: [] });
    assert.ok("ok" in evidence && evidence.ok, JSON.stringify(evidence));
    const source = await repairRecords(root, 7);
    assert.ok("records" in source && source.records);
    const orchestrator = new RepairConnection("alice@acme.test").identity();
    const target = (await readFinding(root, finding.id))!;
    const capsule: RepairVerificationCapsule = { scope, claims: source.records.claims, sort: source.records.sorts[0]!.input,
      evidence: source.records.evidence[0]!.input, rulingContext: "no ruling required by this mechanical fixture", orchestrator,
      targets: [{ findingId: finding.id, openEpoch: target.openEpoch!, claimHash: issueClaimHash("finding", target) }],
      code: { witnessCommit: sha, baseCommit: sha, fixCommit: sha, touched: [], availability: "unknown", reason: "commit unavailable" } };
    const request = { id: "upgrade-request", capsule, capsuleHash: repairVerificationHash(capsule) };
    await emitEvent(cfg.path, scope, { principal: "alice@acme.test" }, "repair.verification-requested", request.id, { ...request });
    const attempt = await emitEvent(cfg.path, scope, { principal: "alice@acme.test" }, "repair.verification-recorded", "anonymous", { id: "anonymous" });
    await settle(t);
    const initial = verificationOf(await repairRecords(root, 7));
    assert.equal(initial.requests.length, 1);
    assert.ok(initial.rejected.some(rejection => rejection.eventId === attempt.id));
    const other = verificationOf(await repairRecords(peer, 7));
    assert.deepEqual(other, initial);
    const bytes = shardBytes(cfg.path, scope);
    db(root).prepare("DELETE FROM repair_verifications WHERE scope = ?").run(scope);
    db(root).prepare("UPDATE shared_scope SET fingerprint = ? WHERE scope = ?").run(previousFingerprint(cfg.path, scope, sidecarIdentity(cfg)), scope);
    const before = foldCount();
    const upgraded = verificationOf(await repairRecords(root, 7));
    assert.ok(foldCount() > before, "new materializer refolds the unchanged scope");
    assert.deepEqual(upgraded, initial);
    assert.equal(shardBytes(cfg.path, scope), bytes);
    assert.equal(upgraded.runs.length, 0, "a run that names no verifier stays rejected");
    const again = foldCount();
    await repairRecords(root, 7);
    assert.equal(foldCount(), again, "ordinary cache reads do not refold the log");
    db(root).prepare("UPDATE repair_verifications SET body = ? WHERE scope = ?").run(JSON.stringify({ requests: "malformed", runs: [], arbitrations: [], applications: [], rejected: [] }), scope);
    assert.throws(() => readRepairVerification(root, scope), /malformed/);
    assert.throws(() => findingsProjection.read(db(root), scope), /repair verifications/);
  } finally { t.dispose(); }
});
