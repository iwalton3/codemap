import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveSidecar, sidecarIdentity } from "./sidecar-config.js";
import { SHARD_EXT } from "./eventlog.js";
import { foldCount } from "./materialize.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimVerifierSession, taintVerifierSession } from "./verifier-local.js";
import { team, settle } from "./oracle.js";
import { shareFinding } from "./ops-shared.js";
import { postRepairSort, repairRecords, recordRepairParticipant, recordRepairEvidence } from "./ops/repairs.js";
import { requestRepairVerification } from "./ops/repair-verification.js";
import { repairSortBrief, submitRepairSortAssessment, arbitrateRepairSort } from "./ops/repair-sort.js";
import { RepairVerifierBoundary } from "./verifier-boundary.js";
import { issueRepairParticipation } from "./repair-participation.js";
import type { RepairSortInput, RepairAssessment } from "./repair-records.js";
import { db } from "./db.js";
const ok = (v: unknown) => assert.equal((v as { error?: string }).error, undefined, JSON.stringify(v));
function host(principal: string, session: string) {
  const boundary = new RepairVerifierBoundary({ context: { supported: true, identity: { principal, harness: "codex", session, model: "same" } }, participants: () => [] });
  assert.equal(boundary.claim("repair-sorter").ok, true);
  return { boundary };
}
const proposal = (findingId: string): RepairSortInput => ({ id: "dual", classification: "mechanical", kind: "isolated", coverage: [{ findingId, claimIds: [`${findingId}:original`] }], restsOn: [], source: "review round", provenance: "dual-sorted", assessments: [], disagreements: [] });
async function assess(root: string, sort: RepairSortInput, session: string, classification = "mechanical") {
  const h = host("alice@acme.test", session);
  ok(await repairSortBrief(root, 7, { sort, role: "sorter" }, h));
  const result = await submitRepairSortAssessment(root, 7, { classification, reason: "The original claim cites the missing guard in both paths." }, h);
  ok(result);
  return { host: h, assessment: (result as { assessment: RepairAssessment }).assessment };
}

test("two same-model sorter seals replay to a peer and old unchanged-shard caches refold", async () => {
  const t = await team(["alice@acme.test", "bob@acme.test"]);
  try {
    const root = t.all[0]!.repo, peer = t.all[1]!.repo;
    const finding = await shareFinding(root, 7, { targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "guard absent" }) as { id: string }; ok(finding);
    const s = proposal(finding.id);
    const first = await assess(root, s, "first"), second = await assess(root, s, "second");
    s.assessments = [first.assessment, second.assessment];
    ok(await postRepairSort(root, 7, s));
    const ours = await repairRecords(root, 7); assert.ok("records" in ours && ours.records); assert.equal(ours.records.sorts[0]!.eligible, true);
    await settle(t);
    const theirs = await repairRecords(peer, 7); assert.ok("records" in theirs && theirs.records); assert.deepEqual(theirs.records, ours.records);
    const cfg = resolveSidecar(peer)!;
    const old = createHash("sha256").update(`v46\0${sidecarIdentity(cfg)}\0${theirs.scope}\0`);
    for (const name of readdirSync(join(cfg.path, theirs.scope)).filter(n => n.endsWith(SHARD_EXT)).sort()) {
      const st = statSync(join(cfg.path, theirs.scope, name), { bigint: true }); old.update(`${name}\0${st.size}\0${st.mtimeNs}\0`);
    }
    db(peer).prepare("UPDATE shared_scope SET fingerprint = ? WHERE scope = ?").run(old.digest("hex"), theirs.scope);
    const before = foldCount();
    const refolded = await repairRecords(peer, 7); assert.ok("records" in refolded && refolded.records); assert.equal(refolded.records.sorts[0]!.eligible, true); assert.ok(foldCount() > before);
    const cross = await postRepairSort(root, 8, s); assert.match((cross as { error: string }).error, /another review scope/);
  } finally { t.dispose(); }
});

test("sorter disagreement stays held until distinct arbitration; durable role taint holds later verification", async () => {
  const t = await team(["alice@acme.test"]);
  try {
    const root = t.all[0]!.repo;
    const finding = await shareFinding(root, 7, { targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "guard absent" }) as { id: string }; ok(finding);
    const s = proposal(finding.id);
    const first = await assess(root, s, "first"), second = await assess(root, s, "second", "assumption");
    s.assessments = [first.assessment, second.assessment]; s.disagreements = [{ id: "kind", text: "mechanical or unanswered assumption" }];
    const arb = host("alice@acme.test", "arb"); ok(await repairSortBrief(root, 7, { sort: s, role: "arbitrator" }, arb));
    assert.match((await arbitrateRepairSort(root, 7, { addresses: ["kind"], reason: "agree" }, arb) as { error: string }).error, /substantively/);
    const verdict = await arbitrateRepairSort(root, 7, { addresses: ["kind"], reason: "The as-filed claim already names the established missing guard; no requirement choice is introduced by restoring it." }, arb); ok(verdict);
    s.arbitration = (verdict as { assessment: NonNullable<RepairSortInput["arbitration"]> }).assessment;
    ok(await postRepairSort(root, 7, s));
    const state = await repairRecords(root, 7); assert.ok("records" in state && state.records); assert.equal(state.records.sorts[0]!.eligible, true);
    ok(await recordRepairParticipant(root, 7, { repairId: s.id, role: "fixer" }, issueRepairParticipation({ principal: "alice@acme.test", harness: "codex", session: "actual-fixer" })));
    const sha = "a".repeat(40);
    ok(await recordRepairEvidence(root, 7, { id: "proof", sortId: s.id, witnessCommit: sha, baseCommit: sha, fixCommit: sha,
      coverage: [{ findingId: finding.id, claimIds: [`${finding.id}:original`], result: "complete", reason: "checked original claim", claimResults: [{ claimId: `${finding.id}:original`, result: "complete", reason: "whole claim inspected" }] }],
      reproducer: [], changeFalsifier: [], regression: [], inspected: [], rulingIds: [], attribution: [], noCheckReason: "No executable check in this synthetic fixture." }));
    const receipt = first.assessment.receipt!.seal!.receipt;
    assert.equal(claimVerifierSession(root, receipt.identity, receipt.connectionId).ok, true);
    taintVerifierSession(root, receipt.identity, receipt.connectionId);
    assert.match((await postRepairSort(root, 7, { ...s, id: "durably-tainted" }) as { error: string }).error, /sorter session.*forbidden/);
    const attention = await repairRecords(root, 7); assert.ok("records" in attention && attention.records);
    assert.equal(attention.records.sorts.find(x => x.input.id === s.id)!.eligible, false);
    assert.match(attention.records.sorts.find(x => x.input.id === s.id)!.holds.join(" "), /forbidden/);
    const orchestrator = new RepairVerifierBoundary({ context: { supported: true, identity: { principal: "alice@acme.test", harness: "codex", session: "orchestrator" } }, participants: () => [] });
    orchestrator.claim();
    assert.match((await requestRepairVerification(root, 7, { sortId: s.id, evidenceId: "proof" }, { boundary: orchestrator }) as { error: string }).error, /sort.*not currently eligible.*forbidden/);
    first.host.boundary.enterDomainAction("annotate");
    assert.match((await postRepairSort(root, 7, { ...s, id: "tainted" }) as { error: string }).error, /forbidden/);
  } finally { t.dispose(); }
});

test("fixer cannot gain sorter authority and sorter connection cannot become verifier", async () => {
  const t = await team(["alice@acme.test"]);
  try {
    const root = t.all[0]!.repo;
    const finding = await shareFinding(root, 7, { targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "guard absent" }) as { id: string }; ok(finding);
    const s = proposal(finding.id);
    ok(await recordRepairParticipant(root, 7, { repairId: s.id, role: "fixer" }, issueRepairParticipation({ principal: "alice@acme.test", harness: "codex", session: "fixer" })));
    assert.match((await repairSortBrief(root, 7, { sort: s, role: "sorter" }, host("alice@acme.test", "fixer")) as { error: string }).error, /fixer/);
    const h = host("alice@acme.test", "sorter"); assert.equal(h.boundary.enterDomainAction("repair_request").ok, false);
    const verifier = new RepairVerifierBoundary({ context: { supported: true, identity: { principal: "alice@acme.test", harness: "codex", session: "verifier" } }, participants: () => [] }); verifier.claim();
    assert.match((await repairSortBrief(root, 7, { sort: s, role: "sorter" }, { boundary: verifier }) as { error: string }).error, /sorter role/);
  } finally { t.dispose(); }
});

test("a different process cannot post receipts after the sorter's durable role taint", async () => {
  const { spawnSync } = await import("node:child_process");
  const t = await team(["alice@acme.test"]);
  try {
    const root = t.all[0]!.repo;
    const f = await shareFinding(root, 7, { targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "guard absent" }) as { id: string }; ok(f);
    const s = proposal(f.id);
    const script = `
      import { RepairVerifierBoundary } from ${JSON.stringify(new URL("./verifier-boundary.js", import.meta.url).href)};
import { repairSortBrief, submitRepairSortAssessment } from ${JSON.stringify(new URL("./ops/repair-sort.js", import.meta.url).href)};
      import { claimVerifierSession, taintVerifierSession } from ${JSON.stringify(new URL("./verifier-local.js", import.meta.url).href)};
      const root = process.argv[1], sort = JSON.parse(process.argv[2]), session = process.argv[3];
      const identity = { principal: 'alice@acme.test', harness: 'codex', session };
      const boundary = new RepairVerifierBoundary({ context: { supported: true, identity }, participants: () => [] });
      boundary.claim('repair-sorter');
      if (!claimVerifierSession(root, identity, boundary.connectionId).ok) throw Error('session claim refused');
      const host = { boundary };
      const brief = await repairSortBrief(root, 7, { sort, role: 'sorter' }, host);
      if (brief.error) throw Error(brief.error);
      const result = await submitRepairSortAssessment(root, 7, { classification: 'mechanical', reason: 'The original claim establishes the missing guard without an unanswered requirement.' }, host);
      if (result.error) throw Error(result.error);
      boundary.enterDomainAction('annotate');
      taintVerifierSession(root, identity, boundary.connectionId);
      process.stdout.write(JSON.stringify(result.assessment));
    `;
    for (const session of ["process-first", "process-second"]) {
      const child = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script, root, JSON.stringify(s), session], { encoding: "utf8" });
      assert.equal(child.status, 0, child.stderr);
      s.assessments.push(JSON.parse(child.stdout));
    }
    const posted = await postRepairSort(root, 7, s);
    assert.match((posted as { error: string }).error, /sorter session.*forbidden/);
    const state = await repairRecords(root, 7); assert.ok("records" in state && state.records); assert.equal(state.records.sorts.length, 0);
  } finally { t.dispose(); }
});
