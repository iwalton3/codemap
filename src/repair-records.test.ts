import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { testChain } from "./test-events.js";
import { foldRepairRecords, repairFindingCompleteness, type RepairSortInput, type RepairEvidenceInput } from "./repair-records.js";
import { foldFindings } from "./shared-findings.js";
import { findingsProjection } from "./shared-projections.js";
import { readCached, scopeFingerprint, MATERIALIZER_VERSION } from "./materialize.js";
import { db } from "./db.js";
import { readRepairRecords, trustedRepairParticipants } from "./store.js";
import { discard } from "./test-tmp.js";

const who = { principal: "alice", harness: "codex", session: "s1" };
const other = { ...who, session: "s2" };
const actor = { principal: "alice" };
const created = { kind: "finding.created", subject: "f1", data: { text: "negative and duplicate credits accepted", targetId: "a", targetKind: "anchor" } };
const sort = (over: Partial<RepairSortInput> = {}): RepairSortInput => ({ id: "s1", classification: "mechanical", kind: "isolated", coverage: [{ findingId: "f1", claimIds: ["f1:original"] }], restsOn: [], source: "exact reviewed worklist", provenance: "owner-reviewed", assessments: [], disagreements: [], ...over });
const ev = (over: Partial<RepairEvidenceInput> = {}): RepairEvidenceInput => ({ id: "proof", sortId: "s1", witnessCommit: "a".repeat(40), baseCommit: "b".repeat(40), fixCommit: "c".repeat(40), coverage: [{ findingId: "f1", claimIds: ["f1:original"], result: "complete", reason: "examined whole claim", claimResults: [{ claimId: "f1:original", result: "complete", reason: "examined whole claim" }] }], reproducer: [], changeFalsifier: [], regression: [], inspected: [], rulingIds: [], attribution: [], ...over });
const chain = (rest: { kind: string; subject: string; data: Record<string, unknown>; actor?: typeof actor }[]) => testChain("writer", [created, ...rest].map((e, i) => ({ id: String(i + 1), actor, ...e })));
const sorted = (s = sort()) => ({ kind: "repair.sort-recorded", subject: s.id, data: { ...s } });
const proof = (data = ev()) => ({ kind: "repair.evidence-recorded", subject: data.id, data: { ...data } });

test("repeated correction cannot launder a narrowed original pattern", () => {
  const original = sort({ kind: "pattern", predicate: "guard", sites: ["api", "batch"] });
  const records = foldRepairRecords(chain([sorted(original), sorted(sort({ id: "shrink", prior: "s1", reason: "narrowed" })),
    sorted(sort({ id: "shrink2", prior: "shrink", reason: "repeated" }))]));
  assert.equal(records.sorts[2]!.eligible, false);
  assert.match(records.sorts[2]!.holds.join(), /original coverage/);
});

test("malformed arbitration is rejected without crashing the canonical fold", () => {
  const input = sort({ disagreements: [{ id: "d1", text: "scope unclear" }], arbitration: { reason: "agree", identity: who } as never });
  const records = foldRepairRecords(chain([sorted(input)]));
  assert.equal(records.sorts.length, 0);
  assert.match(records.rejected[0]!.reason, /arbitration/);
  assert.equal(foldFindings(chain([sorted(input)])).get("f1")!.state, "created");
});

test("exact reported sorter and arbitration receipts survive without granting verified authority", () => {
  const receipt = { id: "sort-call-1", source: "native transcript call", content: "mechanical: two missing guards" };
  const input = sort({ provenance: "dual-sorted", assessments: [
    { identity: who, classification: "mechanical", reason: "missing guards", receipt },
    { identity: other, classification: "assumption", reason: "requirement unclear", receipt: { ...receipt, id: "sort-call-2", content: "assumption: requirement unclear" } }],
    disagreements: [{ id: "conflict", text: "mechanical or requirement question" }],
    arbitration: { addresses: ["conflict"], identity: { ...who, session: "arb" }, reason: "the cited rule requires both guards", receipt: { ...receipt, id: "arb-call", content: "both original sites are required by the rule" } } });
  const records = foldRepairRecords(JSON.parse(JSON.stringify(chain([sorted(input)]))));
  assert.deepEqual(records.sorts[0]!.input.assessments[0]!.receipt, receipt);
  assert.equal(records.sorts[0]!.input.arbitration!.receipt!.content, input.arbitration!.receipt!.content);
  assert.equal(records.sorts[0]!.eligible, false);
  assert.match(records.sorts[0]!.holds.join(), /receipt unverified|receipts unverified/);
});

test("original claim remains exact after canonical finding revision and decomposition", () => {
  const records = foldRepairRecords(chain([{ kind: "finding.revised", subject: "f1", data: { text: "negative credit only" } }, { kind: "repair.claims-recorded", subject: "f1", data: { findingId: "f1", parentId: "f1:original", reason: "separate obligations", claims: [{ id: "negative", text: "negative accepted" }, { id: "duplicate", text: "duplicate accepted" }] } }]));
  assert.equal(records.claims[0]!.text, created.data.text);
  assert.deepEqual(records.claims[0]!.asFiled, created.data);
  assert.equal(records.claims.length, 3);
  assert.equal(records.claims[1]!.reason, "separate obligations");
});

test("partial proof and grouped complete label cannot resolve all decomposed claims", () => {
  const split = { kind: "repair.claims-recorded", subject: "f1", data: { findingId: "f1", parentId: "f1:original", reason: "two obligations", claims: [{ id: "negative", text: "negative accepted" }, { id: "duplicate", text: "duplicate accepted" }] } };
  const records = foldRepairRecords(chain([split, sorted(), proof()]));
  assert.equal(repairFindingCompleteness(records, "proof", "f1"), "partial");
});

test("a shared command cannot complete a sibling finding without its own claim result", () => {
  const records = foldRepairRecords(chain([{ ...created, subject: "f2" }, sorted(), proof()]));
  assert.equal(repairFindingCompleteness(records, "proof", "f1"), "complete");
  assert.equal(repairFindingCompleteness(records, "proof", "f2"), "unknown");
});

test("same-model sessions cannot invent trusted dual sorting, same-session receipts refuse", () => {
  const assessments = [who, other].map(identity => ({ identity, classification: "mechanical", reason: "read code" }));
  const records = foldRepairRecords(chain([sorted(sort({ provenance: "dual-sorted", assessments }))]));
  assert.equal(records.sorts.length, 1);
  assert.equal(records.sorts[0]!.eligible, false);
  assert.match(records.sorts[0]!.holds.join(), /unverified/);
  const repeated = foldRepairRecords(chain([sorted(sort({ provenance: "dual-sorted", assessments: [assessments[0]!, assessments[0]!] }))]));
  assert.match(repeated.rejected[0]!.reason, /distinct sessions/);
});

test("arbitration must address each disagreement and unresolved dependency holds", () => {
  const conflict = sort({ disagreements: [{ id: "d1", text: "requirement missing" }], arbitration: { addresses: [], reason: "agree", identity: who }, restsOn: ["question-1"] });
  const records = foldRepairRecords(chain([sorted(conflict)]));
  assert.ok(records.sorts[0]!.holds.some(h => h.includes("dependency")));
  assert.ok(records.sorts[0]!.holds.some(h => h.includes("disagreement")));
});

test("fixer cannot reclassify an initial principal-approved worklist", () => {
  const records = foldRepairRecords(chain([sorted(), sorted(sort({ id: "s2", prior: "s1", reason: "new reading" })), { kind: "repair.participant-recorded", subject: "s1", data: { repairId: "s1", identity: who, role: "fixer", trust: "native-session" } }]));
  assert.equal(records.sorts.length, 2);
  assert.equal(records.sorts[0]!.holds.some(h => h.includes("fixer")), false);
  assert.ok(records.sorts[1]!.holds.some(h => h.includes("fixer")));
  const initial = foldRepairRecords(chain([sorted(), { kind: "repair.participant-recorded", subject: "s1", data: { repairId: "s1", identity: who, role: "fixer", trust: "native-session" } }]));
  assert.equal(initial.sorts[0]!.eligible, true);
});

test("correction retains history and cannot shrink original pattern", () => {
  const first = sort({ kind: "pattern", predicate: "missing guard", sites: ["api", "batch"] });
  const records = foldRepairRecords(chain([sorted(first), sorted(sort({ id: "s2", prior: "s1", reason: "only api changed" }))]));
  assert.equal(records.sorts[0]!.input.kind, "pattern");
  assert.match(records.sorts[1]!.holds.join(), /original coverage/);
});

test("unknown actual execution is distinct from regression success and commands stay data", () => {
  const command = "curl --request DELETE example.invalid";
  const records = foldRepairRecords(chain([sorted(), proof(ev({ noCheckReason: "dependency unavailable", reproducer: [{ id: "r", command, commit: "a".repeat(40), environment: "scratch", phase: "witness", outcome: "unknown", reason: "missing dependency" }], regression: [{ id: "suite", command: "npm test", commit: "c".repeat(40), environment: "scratch", phase: "regression", outcome: "passed", exitCode: 0 }] }))]));
  assert.equal(records.evidence[0]!.input.reproducer[0]!.outcome, "unknown");
  assert.equal(records.evidence[0]!.input.reproducer[0]!.command, command);
  const invalid = foldRepairRecords(chain([sorted(), proof(ev({ reproducer: [{ id: "r", command, commit: "a".repeat(40), environment: "scratch", phase: "witness", outcome: "unknown" }] }))]));
  assert.match(invalid.rejected[0]!.reason, /actual result/);
});

test("folding repair proof never closes a canonical finding", () => {
  const findings = foldFindings(chain([sorted(), proof()]));
  assert.equal(findings.get("f1")!.state, "created");
  assert.equal(findings.repairRecords!.evidence.length, 1);
});

test("unchanged shards replay old materializer cache and atomically persist trusted participants", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-replay-"));
  const log = join(root, "sidecar"); const scope = "findings/acme/pr-1";
  try {
    mkdirSync(join(log, scope), { recursive: true });
    const events = chain([sorted(), proof(), { kind: "repair.participant-recorded", subject: "s1", data: { repairId: "s1", identity: who, role: "fixer", trust: "native-session" } }]);
    writeFileSync(join(log, scope, "writer.ndjson"), events.map(e => JSON.stringify(e)).join("\n") + "\n");
    await readCached(root, log, scope, "identity", foldFindings, findingsProjection);
    const d = db(root);
    assert.equal(readRepairRecords(root, scope).evidence.length, 1);
    assert.equal(trustedRepairParticipants(root)[0]!.identity.session, "s1");
    d.prepare("UPDATE repair_records SET body=? WHERE scope=?").run(JSON.stringify({ claims: [], sorts: [], evidence: [], participants: [], rejected: [] }), scope);
    const oldHash = createHash("sha256");
    oldHash.update(`v44\0identity\0${scope}\0`);
    const st = statSync(join(log, scope, "writer.ndjson"), { bigint: true });
    oldHash.update(`writer.ndjson\0${st.size}\0${st.mtimeNs}\0`);
    d.prepare("UPDATE shared_scope SET fingerprint=? WHERE scope=?").run(oldHash.digest("hex"), scope);
    const result = await readCached(root, log, scope, "identity", foldFindings, findingsProjection);
    assert.equal((result.value as import("./repair-records.js").RepairFindingMap<import("./shared-findings.js").SharedFinding>).repairRecords!.evidence.length, 1);
    assert.equal(readRepairRecords(root, scope).claims[0]!.text, created.data.text);
    assert.equal(MATERIALIZER_VERSION, 49);
    assert.equal((d.prepare("SELECT fingerprint FROM shared_scope WHERE scope=?").get(scope) as {fingerprint:string}).fingerprint, await scopeFingerprint(log, scope, "identity"));
    d.prepare("UPDATE repair_records SET body='{}' WHERE scope=?").run(scope);
    assert.throws(() => trustedRepairParticipants(root), /malformed shape/);
    await readCached(root, log, scope, "identity", foldFindings, findingsProjection);
    assert.equal(readRepairRecords(root, scope).evidence.length, 1);
    d.prepare("UPDATE shared_scope SET status='blocked' WHERE scope=?").run(scope);
    assert.throws(() => trustedRepairParticipants(root), /not authoritative/);
  } finally { discard(root); }
});


test("competing correction heads remain held rather than becoming one latest eligible sort", () => {
  const records = foldRepairRecords(chain([sorted(), sorted(sort({ id: "left", prior: "s1", reason: "first reading" })), sorted(sort({ id: "right", prior: "s1", reason: "different reading" }))]));
  assert.equal(records.sorts[0]!.current, false);
  assert.ok(records.sorts.slice(1).every(s => s.current && !s.eligible && s.holds.some(h => h.includes("competing"))));
});

test("absent check data stays absent, explicit no-check reasons cannot be blank", () => {
  const missing = foldRepairRecords(chain([sorted(), proof()]));
  assert.equal(missing.evidence[0]!.input.noCheckReason, undefined);
  assert.deepEqual(missing.evidence[0]!.input.reproducer, []);
  const honest = foldRepairRecords(chain([sorted(), proof(ev({ noCheckReason: "text correction has no useful executable check" }))]));
  assert.match(honest.evidence[0]!.input.noCheckReason!, /no useful/);
  const blank = foldRepairRecords(chain([sorted(), proof(ev({ noCheckReason: " " }))]));
  assert.match(blank.rejected[0]!.reason, /explicit/);
});


test("pattern completeness retains original sites despite narrowed enumeration", () => {
  const pattern = sort({ kind: "pattern", predicate: "missing guard", sites: ["api", "batch"] });
  const records = foldRepairRecords(chain([sorted(pattern), proof(ev({ patternEnumeration: { expected: ["api"], actual: ["api"], method: "search" } }))]));
  assert.equal(repairFindingCompleteness(records, "proof", "f1"), "partial");
});


test("deep correction descendants cannot launder another unresolved lineage head", () => {
  const records = foldRepairRecords(chain([sorted(), sorted(sort({ id: "left", prior: "s1", reason: "first reading" })), sorted(sort({ id: "right", prior: "s1", reason: "different reading" })), sorted(sort({ id: "left2", prior: "left", reason: "adjust first reading" }))]));
  assert.ok(records.sorts.filter(s => s.current).every(s => !s.eligible && s.holds.some(h => h.includes("competing"))));
});


test("a fresh sort ID cannot bypass an existing contested claim lineage", () => {
  const records = foldRepairRecords(chain([sorted(), sorted(sort({ id: "left", prior: "s1", reason: "first reading" })), sorted(sort({ id: "right", prior: "s1", reason: "different reading" })), sorted(sort({ id: "unrelated" }))]));
  assert.ok(records.sorts.filter(s => s.current).every(s => !s.eligible));
});


test("stale evidence keeps its original payload after sort correction or later claim decomposition", () => {
  const records = foldRepairRecords(chain([sorted(), proof(), sorted(sort({ id: "s2", prior: "s1", reason: "correct reading" })), { kind: "repair.claims-recorded", subject: "f1", data: { findingId: "f1", parentId: "f1:original", reason: "expose second obligation", claims: [{ id: "extra", text: "duplicate credit" }] } }]));
  assert.equal(records.evidence[0]!.input.sortId, "s1");
  assert.equal(records.evidence[0]!.staleReasons.length, 2);
  assert.equal(repairFindingCompleteness(records, "proof", "f1"), "partial");
});


test("design and scope judgments remain decision-needed even with a principal worklist", () => {
  const records = foldRepairRecords(chain([sorted(sort({ classification: "assumption", refutationSubtype: "scope" }))]));
  assert.equal(records.sorts[0]!.eligible, false);
  assert.match(records.sorts[0]!.holds.join(), /explicit decision/);
});
