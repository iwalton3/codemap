import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { team, settle } from "./oracle.js";
import { shareFinding } from "./ops-shared.js";
import { repairRecords, postRepairSort, recordRepairEvidence, recordRepairParticipant } from "./ops/repairs.js";
import { issueRepairParticipation } from "./repair-participation.js";
import { emitEvent, SHARD_EXT } from "./eventlog.js";
import { resolveSidecar, sidecarIdentity } from "./sidecar-config.js";
import { findingKeyScope } from "./review-target.js";
import { findingScope } from "./shared-findings.js";
import { db } from "./db.js";
import { readRepairSigningKey, saveRepairSigningKey, readRepairVerification, readFinding } from "./store.js";
import { RepairSealService } from "./repair-seals.js";
import { issueClaimHash } from "./ruling-application.js";
import { RepairVerifierBoundary } from "./verifier-boundary.js";
import { MATERIALIZER_VERSION, foldCount } from "./materialize.js";
import { isRepairVerificationState, repairVerificationHash, repairVerificationPayload, type RepairVerificationState, type RepairVerificationCapsule } from "./repair-verification.js";
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
function version45Fingerprint(path: string, scope: string, identity: string): string {
  const hash = createHash("sha256").update(`v45\0${identity}\0${scope}\0`);
  for (const name of readdirSync(join(path, scope)).filter(name => name.endsWith(SHARD_EXT)).sort()) {
    const st = statSync(join(path, scope, name), { bigint: true });
    hash.update(`${name}\0${st.size}\0${st.mtimeNs}\0`);
  }
  return hash.digest("hex");
}

test("repair verification replays unchanged version45 shards and retains rejected unsigned attempts", async () => {
  const t = await team(["alice@acme.test", "bob@acme.test"]);
  try {
    assert.equal(MATERIALIZER_VERSION, 49);
    const root = t.all[0]!.repo, peer = t.all[1]!.repo, cfg = resolveSidecar(root)!;
    const finding = await shareFinding(root, 7, { targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "negative credit accepted" }) as { id: string };
    assert.ok(finding.id);
    const scope = findingScope(findingKeyScope(cfg, 7));
    const service = new RepairSealService({ loadKey: () => readRepairSigningKey(root), saveKey: key => saveRepairSigningKey(root, key) });
    const producer = service.publicProducer();
    await emitEvent(cfg.path, scope, { principal: "alice@acme.test" }, "repair.verification-producer", producer.producerKeyId, { ...producer });
    const claimId = `${finding.id}:original`, sha = "a".repeat(40);
    const sorted = await postRepairSort(root, 7, { id: "upgrade-sort", source: "exact owner input-2", provenance: "owner-reviewed",
      classification: "implementation-defect", kind: "isolated", coverage: [{ findingId: finding.id, claimIds: [claimId] }], restsOn: [], assessments: [], disagreements: [] });
    assert.ok("ok" in sorted && sorted.ok, JSON.stringify(sorted));
    const evidence = await recordRepairEvidence(root, 7, { id: "upgrade-evidence", sortId: "upgrade-sort", witnessCommit: sha, baseCommit: sha, fixCommit: sha,
      coverage: [{ findingId: finding.id, claimIds: [claimId], result: "unknown", reason: "commit unavailable", claimResults: [{ claimId, result: "unknown", reason: "commit unavailable" }] }],
      reproducer: [], changeFalsifier: [], regression: [], inspected: [], noCheckReason: "required commit unavailable", rulingIds: [], attribution: [] });
    assert.ok("ok" in evidence && evidence.ok, JSON.stringify(evidence));
    const participant = await recordRepairParticipant(root, 7, { repairId: "upgrade-sort", role: "fixer" },
      issueRepairParticipation({ principal: "alice@acme.test", harness: "codex", session: "upgrade-fixer" }));
    assert.ok("ok" in participant && participant.ok, JSON.stringify(participant));
    const source = await repairRecords(root, 7);
    assert.ok("records" in source && source.records);
    const orchestrator = { principal: "alice@acme.test", harness: "codex", session: "upgrade-orchestrator" };
    const target = (await readFinding(root, finding.id))!;
    const capsule: RepairVerificationCapsule = { scope, claims: source.records.claims, sort: source.records.sorts[0]!.input,
      evidence: source.records.evidence[0]!.input, rulingContext: "no ruling required by this mechanical fixture", orchestrator,
      targets: [{ findingId: finding.id, openEpoch: target.openEpoch!, claimHash: issueClaimHash("finding", target) }],
      code: { witnessCommit: sha, baseCommit: sha, fixCommit: sha, diff: "", availability: "unknown", reason: "commit unavailable" } };
    const request = { id: "upgrade-request", capsule, capsuleHash: repairVerificationHash(capsule) };
    const boundary = new RepairVerifierBoundary({ context: { supported: true, identity: orchestrator }, participants: () => [] });
    assert.equal(boundary.claim().ok, true);
    const capability = boundary.sealCapability(request.id, repairVerificationPayload("repair.verification-requested", request.id, request));
    assert.ok(!("error" in capability));
    const seal = service.seal(capability);
    assert.ok(!("error" in seal));
    await emitEvent(cfg.path, scope, { principal: "alice@acme.test" }, "repair.verification-requested", request.id, { ...request, seal });
    const attempt = await emitEvent(cfg.path, scope, { principal: "alice@acme.test" }, "repair.verification-sealed", "unsigned", { id: "unsigned" });
    await settle(t);
    const initial = verificationOf(await repairRecords(root, 7));
    assert.equal(initial.producers.length, 1);
    assert.equal(initial.requests.length, 1, "the portable sealed request is accepted before upgrade");
    assert.ok(initial.rejected.some(rejection => rejection.eventId === attempt.id));
    const other = verificationOf(await repairRecords(peer, 7));
    assert.deepEqual(other, initial);
    assert.equal(readRepairSigningKey(peer), undefined, "the private signing key never syncs");
    const bytes = shardBytes(cfg.path, scope);
    db(root).prepare("DELETE FROM repair_verifications WHERE scope = ?").run(scope);
    db(root).prepare("UPDATE shared_scope SET fingerprint = ? WHERE scope = ?").run(version45Fingerprint(cfg.path, scope, sidecarIdentity(cfg)), scope);
    const before = foldCount();
    const upgraded = verificationOf(await repairRecords(root, 7));
    assert.ok(foldCount() > before, "new materializer refolds the unchanged scope");
    assert.deepEqual(upgraded, initial);
    assert.equal(shardBytes(cfg.path, scope), bytes);
    assert.equal(upgraded.runs.length, 0, "unsigned closure evidence stays rejected");
    const again = foldCount();
    await repairRecords(root, 7);
    assert.equal(foldCount(), again, "ordinary cache reads do not refold the log");
    db(root).prepare("UPDATE repair_verifications SET body = ? WHERE scope = ?").run(JSON.stringify({ producers: [], requests: "malformed", runs: [], arbitrations: [], rejected: [] }), scope);
    assert.throws(() => readRepairVerification(root, scope), /malformed/);
    assert.throws(() => findingsProjection.read(db(root), scope), /repair verifications/);
  } finally { t.dispose(); }
});

test("the local repair producer key survives reopen and refuses malformed or replacement secrets", async () => {
  const t = await team(["alice@acme.test"]);
  try {
    const root = t.all[0]!.repo;
    assert.equal(readRepairSigningKey(root), undefined);
    const first = new RepairSealService({ loadKey: () => readRepairSigningKey(root), saveKey: key => saveRepairSigningKey(root, key) });
    const second = new RepairSealService({ loadKey: () => readRepairSigningKey(root), saveKey: key => saveRepairSigningKey(root, key) });
    assert.deepEqual(second.publicProducer(), first.publicProducer());
    const key = readRepairSigningKey(root)!;
    saveRepairSigningKey(root, key);
    assert.throws(() => saveRepairSigningKey(root, { publicKey: "different", privateKey: "different" }), /cannot be replaced/);
    db(root).prepare("UPDATE meta SET v = ? WHERE k = 'repair-verification-producer-key'").run(JSON.stringify({ publicKey: 4 }));
    assert.throws(() => readRepairSigningKey(root), /malformed/);
  } finally { t.dispose(); }
});
