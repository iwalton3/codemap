import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { testChain } from "./test-events.js";
import { foldRepairRecords, repairFindingCompleteness, releaseBriefContent, releaseBriefHash, type ReleaseReceipt, type RepairSortInput, type RepairEvidenceInput } from "./repair-records.js";
import { foldFindings } from "./shared-findings.js";
import { referencesFor } from "./eventlog.js";
import { findingsProjection } from "./shared-projections.js";
import { readCached, scopeFingerprint, MATERIALIZER_VERSION } from "./materialize.js";
import { db } from "./db.js";
import { readRepairRecords } from "./store.js";
import { discard } from "./test-tmp.js";

/** A sorter as the skill's sort reports it. */
const who = { principal: "alice", session: "s1" };
const other = { ...who, session: "s2" };
const actor = { principal: "alice" };
const agent = { principal: "alice", via: { kind: "agent" as const, model: "m" } };
const created = { kind: "finding.created", subject: "f1", data: { text: "negative and duplicate credits accepted", targetId: "a", targetKind: "anchor" } };
const sort = (over: Partial<RepairSortInput> = {}): RepairSortInput => ({ id: "s1", classification: "mechanical", kind: "isolated", coverage: [{ findingId: "f1", claimIds: ["f1:original"] }], restsOn: [], source: "exact reviewed worklist", provenance: "owner-reviewed", stakes: "high", assessments: [], disagreements: [], ...over });
const ev = (over: Partial<RepairEvidenceInput> = {}): RepairEvidenceInput => ({ id: "proof", sortId: "s1", witnessCommit: "a".repeat(40), baseCommit: "b".repeat(40), fixCommit: "c".repeat(40), coverage: [{ findingId: "f1", claimIds: ["f1:original"], result: "complete", reason: "examined whole claim", claimResults: [{ claimId: "f1:original", result: "complete", reason: "examined whole claim" }] }], reproducer: [], regression: [], inspected: [], rulingIds: [], attribution: [], ...over });
const chain = (rest: { kind: string; subject: string; data: Record<string, unknown>; actor?: { principal: string }; eventSchema?: number }[]) => testChain("writer", [created, ...rest].map((e, i) => ({ id: String(i + 1), actor, ...e })));
const sorted = (s = sort(), by: { principal: string; via?: { kind: "agent"; model: string } } = actor) => ({ kind: "repair.sort-recorded", subject: s.id, data: { ...s }, actor: by });
const proof = (data = ev()) => ({ kind: "repair.evidence-recorded", subject: data.id, data: { ...data } });

test("repeated correction cannot launder a narrowed original pattern", () => {
  const original = sort({ kind: "pattern", predicate: "guard", sites: ["api", "batch"] });
  const records = foldRepairRecords(chain([sorted(original), sorted(sort({ id: "shrink", prior: "s1", reason: "narrowed" })),
    sorted(sort({ id: "shrink2", prior: "shrink", reason: "repeated" }))]));
  assert.deepEqual(records.sorts.map((s) => [s.input.id, s.current]), [["s1", true]]);
  assert.match(records.rejected[0]!.reason, /removes api, batch from s1 needs a logged ruling/);
  assert.match(records.rejected[1]!.reason, /predecessor/, "a refused correction is nothing to build on");
});

test("malformed arbitration is rejected without crashing the canonical fold", () => {
  const input = sort({ disagreements: [{ id: "d1", text: "scope unclear" }], arbitration: { reason: "agree", identity: who } as never });
  const records = foldRepairRecords(chain([sorted(input)]));
  assert.equal(records.sorts.length, 0);
  assert.match(records.rejected[0]!.reason, /arbitration/);
  assert.equal(foldFindings(chain([sorted(input)])).get("f1")!.state, "created");
});

test("the skill's two-sorter sort, arbitrated where they disagree, makes a repair eligible and keeps its reported receipts", () => {
  const receipt = { id: "sort-call-1", source: "native transcript call", content: "mechanical: two missing guards" };
  const input = sort({ provenance: "dual-sorted", assessments: [
    { identity: who, classification: "mechanical", reason: "missing guards", receipt },
    { identity: other, classification: "assumption", reason: "requirement unclear", receipt: { ...receipt, id: "sort-call-2", content: "assumption: requirement unclear" } }],
    disagreements: [{ id: "conflict", text: "mechanical or requirement question" }],
    arbitration: { addresses: ["conflict"], identity: { ...who, session: "arb" }, reason: "the cited rule requires both guards", receipt: { ...receipt, id: "arb-call", content: "both original sites are required by the rule" } } });
  const records = foldRepairRecords(JSON.parse(JSON.stringify(chain([sorted(input)]))));
  assert.deepEqual(records.sorts[0]!.input.assessments[0]!.receipt, receipt);
  assert.equal(records.sorts[0]!.input.arbitration!.receipt!.content, input.arbitration!.receipt!.content);
  assert.equal(records.sorts[0]!.eligible, true, records.sorts[0]!.holds.join());
  const unarbitrated = foldRepairRecords(chain([sorted({ ...input, arbitration: undefined })]));
  assert.match(unarbitrated.sorts[0]!.holds.join(), /requires arbitration/);
  const sameArbitrator = foldRepairRecords(chain([sorted({ ...input, arbitration: { ...input.arbitration!, identity: who } })]));
  assert.match(sameArbitrator.sorts[0]!.holds.join(), /third reader/);
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

test("two sorters who agree make a sort eligible; one session sorting twice is refused", () => {
  // Owner: "2 blind isn't needed for the skill's findings sort" — the sort is the skill's, posted.
  const assessments = [who, other].map(identity => ({ identity, classification: "mechanical", reason: "read code" }));
  const records = foldRepairRecords(chain([sorted(sort({ provenance: "dual-sorted", assessments }), agent)]));
  assert.equal(records.sorts.length, 1);
  assert.equal(records.sorts[0]!.eligible, true, records.sorts[0]!.holds.join());
  const repeated = foldRepairRecords(chain([sorted(sort({ provenance: "dual-sorted", assessments: [assessments[0]!, assessments[0]!] }))]));
  assert.match(repeated.rejected[0]!.reason, /two independent sorters/);
});

test("D4: sorters are independent by identity key — a session and its subagent, or two subagents, sort apart", () => {
  // Owner, D4: one reader-independence key across withdrawal, application and repair sorts.
  const mk = (child: string | undefined, classification = "mechanical") => ({ identity: { ...who, ...(child !== undefined ? { child } : {}) }, classification, reason: "read code" });
  const pair = foldRepairRecords(chain([sorted(sort({ provenance: "dual-sorted", assessments: [mk(undefined), mk("a1234567")] }), agent)]));
  assert.deepEqual(pair.rejected, []);
  assert.equal(pair.sorts[0]!.eligible, true, pair.sorts[0]!.holds.join());
  const twice = foldRepairRecords(chain([sorted(sort({ provenance: "dual-sorted", assessments: [mk(undefined), mk(undefined)] }), agent)]));
  assert.match(twice.rejected[0]!.reason, /two independent sorters/, "one reader sorting twice");
  const arbitrated = (child: string | undefined) => foldRepairRecords(chain([sorted(sort({ provenance: "dual-sorted",
    assessments: [mk("a1"), mk("a2", "assumption")], disagreements: [{ id: "d", text: "which" }],
    arbitration: { addresses: ["d"], identity: { ...who, ...(child ? { child } : {}) }, reason: "the code says" } }), agent)]));
  assert.equal(arbitrated("a3").sorts[0]!.eligible, true, arbitrated("a3").sorts[0]!.holds.join());
  assert.match(arbitrated("a1").sorts[0]!.holds.join(), /third reader/);
  const blank = foldRepairRecords(chain([sorted(sort({ provenance: "dual-sorted", assessments: [mk(""), mk("a1")] }), agent)]));
  assert.match(blank.rejected[0]!.reason, /provenance/, "a child, when given, is an id");
});

test("C-2 (D2): a ruling no longer releases what a held sort rests on — a free label or a decision entry", () => {
  for (const entry of ["D1", "decision:d1"]) {
    const held = sort({ classification: "design-defect", restsOn: [entry] });
    const freed = sort({ id: "next", prior: "s1", reason: "ruled", restsOn: [], classification: "implementation-defect", ruling: "ans1" });
    const records = foldRepairRecords(chain([sorted(held), sorted(freed)]));
    assert.match(records.rejected[0]?.reason ?? "", /released only by its ruling \(release_ruled_sort\) or two readers/, entry);
    assert.equal(records.sorts.find(s => s.input.id === "next"), undefined);
  }
});

test("Q2: a free label is re-pointed to its decision for free, and stays held; dropping it any other way is refused", () => {
  const held = sort({ classification: "design-defect", restsOn: ["D1"] });
  const repointed = foldRepairRecords(chain([sorted(held), sorted(sort({ id: "next", prior: "s1", reason: "D1 is d1", classification: "design-defect", restsOn: ["decision:d1"] }))]));
  assert.deepEqual(repointed.rejected, []);
  assert.match(repointed.sorts.find(s => s.input.id === "next")!.holds.join(), /dependency remains/);
  const dropped = foldRepairRecords(chain([sorted(held), sorted(sort({ id: "next", prior: "s1", reason: "gone", classification: "design-defect", restsOn: ["other"] }))]));
  assert.match(dropped.rejected[0]?.reason ?? "", /released only by its ruling \(release_ruled_sort\) or two readers/);
  const bare = foldRepairRecords(chain([sorted(sort({ restsOn: ["decision:"] }))]));
  assert.match(bare.rejected[0]?.reason ?? "", /names its decision/);
});

test("D2: two readers' yes on the exact brief release a held sort; anything less is refused", () => {
  const held = sort({ classification: "design-defect", restsOn: ["decision:d1", "label"] });
  const rulings = [{ decision: "d1", answer: "ans1", question: "D1: which guard?", words: "Both guards" }];
  const claims = [{ id: "f1:original", findingId: "f1", text: created.data.text, asFiled: created.data }];
  const briefHash = releaseBriefHash(releaseBriefContent(held, claims, rulings));
  const reader = (n: number, over: Partial<ReleaseReceipt> = {}): ReleaseReceipt => ({ id: `rc${n}`, request: `rq${n}`, principal: "alice", session: "parent",
    launch: `toolu_l${n}`, briefHash, verdict: "yes", rationale: "the ruling picks one direction", ...over });
  const release = (readers: ReleaseReceipt[], over: Partial<RepairSortInput> = {}) => sort({ id: "next", prior: "s1", reason: "released",
    classification: "implementation-defect", restsOn: ["label"], provenance: "released", release: { rulings, readers }, ...over });
  const run = (s: RepairSortInput, rest: Parameters<typeof chain>[0] = []) => foldRepairRecords(chain([sorted(held), sorted(s, agent), ...rest]));
  const ok = run(release([reader(1), reader(2)]));
  assert.deepEqual(ok.rejected, []);
  assert.deepEqual(ok.sorts.find(s => s.input.id === "next")!.holds, ["requirement or ruling dependency remains explicit"], "the free label still holds it");
  const clean = foldRepairRecords(chain([sorted(sort({ classification: "design-defect", restsOn: ["decision:d1"] })),
    sorted(sort({ id: "next", prior: "s1", reason: "released", classification: "implementation-defect", restsOn: [], provenance: "released", release: { rulings, readers: [reader(1), reader(2)] } }), agent)]));
  assert.equal(clean.sorts.find(s => s.input.id === "next")!.eligible, true, clean.sorts.map(s => s.holds).join("|"));
  const refused = (s: RepairSortInput, why: RegExp, rest: Parameters<typeof chain>[0] = []) => assert.match(run(s, rest).rejected[0]?.reason ?? "(accepted)", why);
  refused(release([reader(1), reader(2, { verdict: "no" })]), /both readers' yes/);
  refused(release([reader(1), reader(2, { launch: "toolu_l1" })]), /independently launched/);
  refused(release([reader(1), reader(2, { briefHash: "sha256:other" })]), /exact brief/);
  refused(release([reader(1), reader(2)], { restsOn: [] }), /drops decision entries only/, );
  refused(release([reader(1), reader(2)], { classification: "design-defect" }), /mechanical or implementation-defect/);
  refused(release([reader(1), reader(2)], { coverage: [] }), /coverage/);
  refused(release([reader(1)]), /two readers/);
  refused(sort({ id: "next", prior: "s1", reason: "r", restsOn: ["label"], classification: "implementation-defect", provenance: "released" }), /carries the release/);
  refused(sort({ id: "next", prior: "s1", reason: "r", restsOn: ["decision:d1", "label"], release: { rulings, readers: [reader(1), reader(2)] } }), /only to a released or ruled sort/);
  // Evidence carries the release's rulings, so verification re-checks their authority.
  const ev2 = (rulingIds: string[]) => proof(ev({ id: "proof2", sortId: "next", rulingIds }));
  const cleanChain = (rulingIds: string[]) => foldRepairRecords(chain([sorted(sort({ classification: "design-defect", restsOn: ["decision:d1"] })),
    sorted(sort({ id: "next", prior: "s1", reason: "released", classification: "implementation-defect", restsOn: [], provenance: "released", release: { rulings, readers: [reader(1), reader(2)] } }), agent), ev2(rulingIds)]));
  assert.match(cleanChain([]).rejected[0]?.reason ?? "", /ans1.*rulingIds/);
  assert.deepEqual(cleanChain(["ans1"]).rejected, []);
  // R2: a ruled release has the same shape and no readers; whether the ruling covers the sort is
  // the decisions log's, checked by `repairSortReferences` (repair-ops.test.ts).
  const ruled = (over: Partial<RepairSortInput> = {}) => sort({ id: "next", prior: "s1", reason: "ruled", classification: "implementation-defect",
    restsOn: ["label"], provenance: "ruled", release: { rulings }, ...over });
  assert.deepEqual(run(ruled()).rejected, []);
  refused(ruled({ release: { rulings, readers: [reader(1), reader(2)] } }), /no readers/);
  refused(ruled({ restsOn: [] }), /drops decision entries only/);
  refused(ruled({ coverage: [] }), /coverage/);
  refused(ruled({ release: { rulings: [] } }), /one ruling/);
  refused(ruled({ assessments: [{ identity: who, classification: "mechanical", reason: "r" }] }), /its rulings alone/);
});

test("A8 (D2): a decision entry and a release ruling must exist in the decisions log, checked at the door and on read", async () => {
  const check = referencesFor("findings/acme/api/pr-7")!;
  const decisions = testChain("w", [
    { id: "r1", kind: "decision.round.posted", subject: "R1", actor, data: { decisions: [{ id: "d1" }] } },
    { id: "ans1", kind: "decision.answer.recorded", subject: "r1:d1", actor, data: { decision: "r1:d1" } }]);
  const read = { read: async (s: string) => (s === "decisions/acme/api" ? decisions : []), scopes: async () => ["decisions/acme/api"] };
  const event = (data: Record<string, unknown>) => testChain("w", [{ id: "e1", kind: "repair.sort-recorded", subject: "s", actor, data }])[0]!;
  const why = async (data: Record<string, unknown>) => (await check("findings/acme/api/pr-7", event(data), [], read)).map(r => r.why);
  assert.deepEqual(await why({ restsOn: ["decision:r1:d1", "free label"] }), []);
  assert.deepEqual(await why({ restsOn: ["decision:r1:d9"] }), ["no decision r1:d9 in the decisions log"]);
  const release = (answer: string) => ({ restsOn: [], release: { rulings: [{ decision: "r1:d1", answer }] } });
  assert.deepEqual(await why(release("ans1")), []);
  assert.deepEqual(await why(release("ans9")), ["no answer ans9 to r1:d1 in the decisions log"]);
});

/** Written by a build before EVENT_SCHEMA 6: a sort from before stakes existed. */
const before6 = <T extends object>(e: T) => ({ ...e, eventSchema: 5 });

test("V1: a correction may raise stakes and never lower them; a sort without stakes is high", () => {
  const corrected = (first: Partial<RepairSortInput>, next: Partial<RepairSortInput>) =>
    foldRepairRecords(chain([before6(sorted(sort(first))), sorted(sort({ id: "s2", prior: "s1", reason: "restaked", ...next }))])).rejected.map(r => r.reason);
  assert.deepEqual(corrected({ stakes: "low" }, { stakes: "high" }), []);
  assert.deepEqual(corrected({ stakes: "low" }, { stakes: "low" }), []);
  assert.deepEqual(corrected({ stakes: undefined }, { stakes: "high" }), [], "absent is high, so high is no change");
  assert.match(corrected({ stakes: "high" }, { stakes: "low" }).join(), /raise stakes, never lower/);
  assert.match(corrected({ stakes: undefined }, { stakes: "low" }).join(), /only a dual-sorted correction/);
  assert.match(foldRepairRecords(chain([sorted(sort({ stakes: "medium" as never }))])).rejected[0]?.reason ?? "", /high or low/);
});

test("2a: a sort posted under schema 6 states its stakes; one stamped earlier stays valid; codemap's ruled release inherits none", () => {
  const reasons = (...evs: Parameters<typeof chain>[0]) => foldRepairRecords(chain(evs)).rejected.map(r => r.reason);
  assert.match(reasons(sorted(sort({ stakes: undefined }))).join(), /states its stakes/);
  assert.match(reasons(sorted(sort({ stakes: undefined, provenance: "dual-sorted", assessments: [
    { identity: who, classification: "mechanical", reason: "a" }, { identity: other, classification: "mechanical", reason: "b" }] }))).join(), /states its stakes/);
  assert.deepEqual(reasons(before6(sorted(sort({ stakes: undefined })))), [], "grandfathered: the same event at schema 5 is valid");
  // A held sort from before stakes, released on its ruling under schema 6: the release copies the
  // prior's stakes, absent included, and must not be refused for it.
  const held = sort({ stakes: undefined, restsOn: ["decision:d1"] });
  const ruled = { ...sort({ id: "s2", prior: "s1", reason: "released by ruling", classification: "implementation-defect", provenance: "ruled", stakes: undefined }),
    release: { rulings: [{ decision: "d1", answer: "ans1", question: "D1", words: "fix it" }] } };
  assert.deepEqual(reasons(before6(sorted(held)), sorted(ruled as RepairSortInput)), []);
});

test("F15: fresh dual sorters may set low on a sort that never had stakes; its own readers, one reader, or an explicit high may not", () => {
  const s3 = { ...who, session: "s3" }, s4 = { ...who, session: "s4" };
  const dual = (a: typeof who, b: typeof who, over: Partial<RepairSortInput> = {}) => sort({ provenance: "dual-sorted", assessments: [
    { identity: a, classification: "mechanical", reason: "a" }, { identity: b, classification: "mechanical", reason: "b" }], ...over });
  const lower = (prior: RepairSortInput, next: RepairSortInput, stamp = (e: ReturnType<typeof sorted>) => e) =>
    foldRepairRecords(chain([before6(sorted(prior)), stamp(sorted({ ...next, id: "s2", prior: "s1", reason: "stakes set", stakes: "low" }))])).rejected.map(r => r.reason);
  const unset = dual(who, other, { stakes: undefined });
  assert.deepEqual(lower(unset, dual(s3, s4)), [], "two fresh sorters set it");
  assert.match(lower(unset, dual(who, s3)).join(), /new reading/, "one of the prior's sorters may not");
  assert.match(lower(unset, sort()).join(), /only a dual-sorted correction/, "an owner-reviewed correction may not");
  assert.match(lower(dual(who, other, { stakes: "high" }), dual(s3, s4)).join(), /raise stakes, never lower/, "an explicit high stays");
  assert.match(lower(unset, dual(s3, s4), before6).join(), /only a dual-sorted correction/, "the way down binds only events written under schema 6");
});

test("arbitration must address each disagreement and unresolved dependency holds", () => {
  const conflict = sort({ disagreements: [{ id: "d1", text: "requirement missing" }], arbitration: { addresses: [], reason: "agree", identity: who }, restsOn: ["question-1"] });
  const records = foldRepairRecords(chain([sorted(conflict)]));
  assert.ok(records.sorts[0]!.holds.some(h => h.includes("dependency")));
  assert.ok(records.sorts[0]!.holds.some(h => h.includes("disagreement")));
});

test("correction retains history and cannot shrink original pattern", () => {
  const first = sort({ kind: "pattern", predicate: "missing guard", sites: ["api", "batch"] });
  const records = foldRepairRecords(chain([sorted(first), sorted(sort({ id: "s2", prior: "s1", reason: "only api changed" }))]));
  assert.equal(records.sorts[0]!.input.kind, "pattern");
  assert.equal(records.sorts.length, 1);
  assert.match(records.rejected[0]!.reason, /needs a logged ruling/);
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

test("unchanged shards replay old materializer cache and atomically persist repair records", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-replay-"));
  const log = join(root, "sidecar"); const scope = "findings/acme/pr-1";
  try {
    mkdirSync(join(log, scope), { recursive: true });
    const events = chain([sorted(), proof()]);
    writeFileSync(join(log, scope, "events.ndjson"), events.map(e => JSON.stringify(e)).join("\n") + "\n");
    await readCached(root, log, scope, "identity", foldFindings, findingsProjection);
    const d = db(root);
    assert.equal(readRepairRecords(root, scope).evidence.length, 1);
    d.prepare("UPDATE repair_records SET body=? WHERE scope=?").run(JSON.stringify({ claims: [], sorts: [], evidence: [], rejected: [] }), scope);
    const oldHash = createHash("sha256");
    oldHash.update(`v44\0identity\0${scope}\0`);
    const st = statSync(join(log, scope, "events.ndjson"), { bigint: true });
    oldHash.update(`events.ndjson\0${st.size}\0${st.mtimeNs}\0`);
    d.prepare("UPDATE shared_scope SET fingerprint=? WHERE scope=?").run(oldHash.digest("hex"), scope);
    const result = await readCached(root, log, scope, "identity", foldFindings, findingsProjection);
    assert.equal((result.value as import("./repair-records.js").RepairFindingMap<import("./shared-findings.js").SharedFinding>).repairRecords!.evidence.length, 1);
    assert.equal(readRepairRecords(root, scope).claims[0]!.text, created.data.text);
    assert.equal(MATERIALIZER_VERSION, 60);
    assert.equal((d.prepare("SELECT fingerprint FROM shared_scope WHERE scope=?").get(scope) as {fingerprint:string}).fingerprint, await scopeFingerprint(log, scope, "identity"));
    d.prepare("UPDATE repair_records SET body='{}' WHERE scope=?").run(scope);
    assert.throws(() => readRepairRecords(root, scope), /malformed shape/);
  } finally { discard(root); }
});


test("5.2: a later correction supersedes the one it names, even a person's; one naming an older sort is refused as stale", () => {
  const records = foldRepairRecords(chain([sorted(), sorted(sort({ id: "left", prior: "s1", reason: "first reading" })),
    sorted(sort({ id: "later", prior: "left", reason: "a better reading" }), agent), sorted(sort({ id: "right", prior: "s1", reason: "different reading" }), agent)]));
  const by = (id: string) => records.sorts.find((s) => s.input.id === id);
  assert.equal(by("later")!.current, true); assert.ok(!by("later")!.holds.some((h) => /supersed|compet/.test(h)), by("later")!.holds.join());
  assert.equal(by("left")!.current, false, "an agent's correction supersedes a person's without asking (owner, batch 1)");
  assert.equal(by("right"), undefined);
  assert.match(records.rejected[0]!.reason, /stale correction: s1 was already corrected by left/);
});

// Kill-table K3 (plan 5.3; .git/triage/2026-09-29-pre-merge-final-review/repro/r1.mjs, F3).
test("K3: a correction that removes its predecessor's sites is refused without a cited ruling and lands with one; adding sites is free", () => {
  const pattern = (over: Partial<RepairSortInput>) => sort({ kind: "pattern", predicate: "p", classification: "implementation-defect", ...over });
  const O = sorted(pattern({ id: "s0", sites: ["a.ts"] }));
  const S1 = sorted(pattern({ id: "s1", prior: "s0", reason: "missed b.ts and c.ts", sites: ["a.ts", "b.ts", "c.ts"] }));
  const S2 = (over: Partial<RepairSortInput> = {}) => sorted(pattern({ id: "s2", prior: "s1", reason: "narrow", sites: ["a.ts"], ...over }));
  const refused = foldRepairRecords(chain([O, S1, S2()]));
  assert.deepEqual(refused.rejected.map((r) => r.reason), ["a correction that removes b.ts, c.ts from s1 needs a logged ruling citing why they are not instances"]);
  assert.deepEqual(refused.sorts.filter((s) => s.current).map((s) => s.input.id), ["s1"], "s1's three sites stay the closure bar's list");
  const ruled = foldRepairRecords(chain([O, S1, S2({ ruling: "ans_1" })]));
  assert.deepEqual(ruled.rejected, []);
  const s2 = ruled.sorts.find((s) => s.input.id === "s2")!;
  assert.ok(s2.current && s2.eligible, s2.holds.join());
  const grown = foldRepairRecords(chain([O, S1, S2({ reason: "found d.ts", sites: ["a.ts", "b.ts", "c.ts", "d.ts"] })]));
  assert.deepEqual(grown.rejected, []);
  assert.ok(grown.sorts.find((s) => s.input.id === "s2")!.eligible);
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


test("a fresh sort ID cannot bypass the current sort of its claims", () => {
  const records = foldRepairRecords(chain([sorted(sort({ kind: "pattern", predicate: "p", sites: ["api", "batch"] })), sorted(sort({ id: "unrelated" }), agent)]));
  assert.deepEqual(records.sorts.map((s) => s.input.id), ["s1"]);
  assert.match(records.rejected[0]!.reason, /already sorted by s1: correct it by naming it as prior/);
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

test("B15: a correction may ADD a site the original missed; dropping one needs a ruling", () => {
  const first = sort({ kind: "pattern", predicate: "missing guard", sites: ["api", "batch"] });
  const grown = foldRepairRecords(chain([sorted(first), sorted(sort({ id: "s2", prior: "s1", reason: "found a third", kind: "pattern", predicate: "missing guard", sites: ["api", "batch", "cli"] }))]));
  assert.ok(grown.sorts[1]!.eligible, grown.sorts[1]!.holds.join("; "));
  const shrunk = foldRepairRecords(chain([sorted(first), sorted(sort({ id: "s2", prior: "s1", reason: "only api", kind: "pattern", predicate: "missing guard", sites: ["api", "cli"] }))]));
  assert.match(shrunk.rejected[0]!.reason, /removes batch from s1/);
});

test("F13: evidence whose own runs could never meet the bar is refused under schema 6; the same evidence stamped earlier stays valid", () => {
  const W = "a".repeat(40), F = "c".repeat(40);
  const run = (command: string, commit: string, phase: RepairEvidenceInput["reproducer"][number]["phase"], outcome: "passed" | "failed", extra = {}) =>
    ({ id: `${phase}-${command}`, command, commit, environment: "scratch", phase, outcome, exitCode: outcome === "passed" ? 0 : 1, ...extra });
  const why = (reproducer: RepairEvidenceInput["reproducer"], s = sort(), stamp = (e: ReturnType<typeof proof>) => e as ReturnType<typeof proof> & { eventSchema?: number }) =>
    foldRepairRecords(chain([sorted(s), stamp(proof(ev({ reproducer })))])).rejected.map(r => r.reason).join();
  const CHECK = "npx playwright test guard.spec.ts";
  assert.equal(why([run(CHECK, W, "witness", "failed"), run(CHECK, F, "fix", "passed")]), "", "the positive every refusal below varies");
  // C3: the fix run written as a reference to the witness run's command, and a check passing at both commits.
  assert.match(why([run(CHECK, W, "witness", "failed"), run(`same command as ${CHECK}`, F, "fix", "passed")]), /cannot meet the bar/);
  assert.match(why([run(CHECK, W, "witness", "passed"), run(CHECK, F, "fix", "passed")]), /cannot meet the bar: a fix needs it failing/);
  assert.equal(why([run(CHECK, W, "witness", "passed"), run(CHECK, F, "fix", "passed")], sort(), before6), "", "grandfathered");
  // A refutation's check passes at the witness: the bar's other half.
  assert.equal(why([run(CHECK, W, "witness", "passed")], sort({ classification: "factual-refutation", refutationSubtype: "factual" })), "");
  assert.match(why([run(CHECK, W, "witness", "failed")], sort({ classification: "factual-refutation", refutationSubtype: "factual" })), /refutation needs it passing at the witness/);
  // A mutation run stands in for the witness red: a missing test has nothing to fail at the witness.
  const mutated = run(CHECK, F, "mutation", "failed", { mutation: { site: "auth.ts:12", change: "ValidIssuer widened to any issuer" } });
  assert.equal(why([mutated, run(CHECK, F, "fix", "passed")]), "");
  assert.match(why([{ ...mutated, mutation: undefined }, run(CHECK, F, "fix", "passed")]), /names the site it mutates/);
  assert.match(why([{ ...mutated, commit: W }, run(CHECK, F, "fix", "passed")]), /at the fix commit/);
  assert.match(why([mutated, run(CHECK, F, "fix", "passed")], sort(), before6), /execution phase is required/, "a build before schema 6 never wrote one");
});
