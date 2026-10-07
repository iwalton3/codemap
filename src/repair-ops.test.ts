import { test } from "node:test";
import assert from "node:assert/strict";
import { team, settle } from "./oracle.js";
import { shareFinding } from "./ops-shared.js";
import { postRepairSort, recordRepairClaims, recordRepairEvidence, repairRecords } from "./ops/repairs.js";
import { releaseReaderBrief, submitReleaseVerdict, releaseHeldSort } from "./ops/repair-release.js";
import { readerTranscript } from "./test-transcripts.js";
import { RepairConnection } from "./verifier-boundary.js";
import { repairFindingCompleteness, type RepairSortInput, type RepairEvidenceInput } from "./repair-records.js";
import { readFinding } from "./store.js";
import { rpc } from "./test-mcp.js";
import { postRound, answerDirect } from "./ops/decisions.js";
import { decisionsView } from "./ops/decision-holds.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

test("D4 through the op: the connection fills each sorter's session; a caller's session is refused", async () => {
  const t = await team(["alice@acme.test"]);
  try {
    const root = t.all[0]!.repo;
    const f = await shareFinding(root, 7, { targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "a guard is missing" }) as { id: string };
    ok(f);
    const conn = new RepairConnection("alice@acme.test");
    const dual = (children: (string | undefined)[], text: string): Omit<RepairSortInput, "id"> => ({ ...sort(f.id, []), source: text, provenance: "dual-sorted",
      assessments: children.map((child, i) => ({ identity: { principal: "alice@acme.test", ...(child ? { child } : {}) } as never, classification: "implementation-defect", reason: `sorter ${i}` })) });
    const posted = await postRepairSort(root, 7, dual([undefined, "a1234567"], "the session and its subagent"), conn) as any;
    ok(posted);
    const s = posted.records.sorts.find((x: any) => x.input.id === posted.id);
    assert.deepEqual(s.input.assessments.map((a: any) => a.identity), [{ principal: "alice@acme.test", session: conn.session },
      { principal: "alice@acme.test", session: conn.session, child: "a1234567" }]);
    assert.equal(s.eligible, true, s.holds.join());
    const twice = await postRepairSort(root, 7, { ...dual([undefined, undefined], "one reader twice"), prior: posted.id, reason: "next" }, conn) as any;
    assert.match(String(twice.error), /two independent sorters/);
    const named = await postRepairSort(root, 7, { ...dual(["a1", "a2"], "named"), prior: posted.id, reason: "next",
      assessments: [{ identity: { principal: "alice@acme.test", session: "mine" }, classification: "implementation-defect", reason: "r" }] } as never, conn) as any;
    assert.match(String(named.error), /leave `session` out/);
    const offline = await postRepairSort(root, 7, { ...dual(["a1", "a2"], "no connection"), prior: posted.id, reason: "next" }) as any;
    assert.match(String(offline.error), /over MCP/);
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

test("K3 through the op: a correction removing a site is refused without a ruling, lands citing a logged answer, and adding a site is free", async () => {
  const t = await team(["alice@acme.test"]);
  try {
    const root = t.all[0]!.repo;
    const f = await shareFinding(root, 7, { targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "same guard missing in three files" }) as { id: string };
    ok(f);
    const pattern = (sites: string[]) => ({ ...sort(f.id, []), kind: "pattern" as const, predicate: "missing guard", sites });
    const s0 = await postRepairSort(root, 7, pattern(["a.ts"])) as { id: string };
    ok(s0);
    const s1 = await postRepairSort(root, 7, { ...pattern(["a.ts", "b.ts", "c.ts"]), prior: s0.id, reason: "missed b.ts and c.ts" }) as { id: string };
    ok(s1);
    const narrow = { ...pattern(["a.ts"]), prior: s1.id, reason: "b.ts and c.ts only look alike" };
    const refused = await postRepairSort(root, 7, narrow);
    assert.match(String((refused as { error?: string }).error), /removes b\.ts, c\.ts from .* needs a logged ruling/);
    ok(await postRound(root, { round: { id: "R-sites", source: "the owner, on the pattern's sites" }, decisions: [{ id: "D-sites", round: "R-sites", ref: "D1", kind: "words",
      payload: { question: "D1: are b.ts and c.ts instances of the missing guard?", options: [{ label: "No" }, { label: "Yes" }] }, options: [{ label: "No", effects: [] }, { label: "Yes", effects: [] }] }] }));
    ok(await answerDirect(root, { decision: "D-sites", option: "No" }));
    const answer = (await decisionsView(root)).s.decisions.flatMap((d) => d.answers).find((a) => a.verified && !a.withdrawn)!;
    assert.ok(answer, "a verified, standing answer to cite");
    const ruled = await postRepairSort(root, 7, { ...narrow, ruling: answer.id }) as { id: string; records: { sorts: { input: { id: string }; current: boolean }[] } };
    ok(ruled);
    assert.deepEqual(ruled.records.sorts.filter(s => s.current).map(s => s.input.id), [ruled.id]);
    ok(await postRepairSort(root, 7, { ...pattern(["a.ts", "d.ts"]), prior: ruled.id, reason: "d.ts has it too" }));
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
    // Not collapsed into the agent's record: it reaches the fold, which refuses a second sort of
    // sorted claims (plan 5.2). The person's authorship enters the log as a correction of it.
    const repost = await postRepairSort(root, 7, same) as { error?: string; alreadyRecorded?: boolean };
    assert.equal(repost.alreadyRecorded, undefined);
    assert.match(String(repost.error), /already sorted by/);
    const byPerson = await postRepairSort(root, 7, { ...same, prior: byAgent.id, reason: "owner reviewed" }) as { id: string; records: { sorts: { input: { id: string }; eligible: boolean; current: boolean }[] } };
    ok(byPerson);
    const mine = byPerson.records.sorts.find(s => s.input.id === byPerson.id)!;
    assert.ok(mine.current && mine.eligible);
  } finally {
    if (before === undefined) delete process.env.CODEMAP_AGENT_MODEL; else process.env.CODEMAP_AGENT_MODEL = before;
    t.dispose();
  }
});

test("O19: one sort may replace several current sorts at once, and they all stop being current", async () => {
  const t = await team(["alice@acme.test"]);
  try {
    const root = t.all[0]!.repo;
    const f1 = await shareFinding(root, 7, { targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "one" }) as { id: string };
    const f2 = await shareFinding(root, 7, { targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "two" }) as { id: string };
    const a = await postRepairSort(root, 7, sort(f1.id, [])) as { id: string };
    const b = await postRepairSort(root, 7, sort(f2.id, [])) as { id: string };
    ok(a); ok(b);
    const merged = await postRepairSort(root, 7, { ...sort(f1.id, []), coverage: [...sort(f1.id, []).coverage, ...sort(f2.id, []).coverage],
      priors: [a.id, b.id], reason: "one defect, sorted twice" }) as { id: string; records: { sorts: { input: { id: string }; current: boolean }[] } };
    ok(merged);
    assert.deepEqual(merged.records.sorts.filter((s) => s.current).map((s) => s.input.id), [merged.id]);
  } finally { t.dispose(); }
});

test("D2 through the op: a held sort re-pointed to its decision is released by two readers' yes; a no keeps it held", async () => {
  const t = await team(["alice@acme.test"]);
  const dir = mkdtempSync(join(tmpdir(), "codemap-release-tx-"));
  try {
    const root = t.all[0]!.repo;
    ok(await postRound(root, { round: { id: "R-dir", source: "the owner, on the guard" }, decisions: [{ id: "D-dir", round: "R-dir", ref: "D1", kind: "words",
      payload: { question: "D1: which guard does transfer need?", options: [{ label: "Both" }, { label: "Neither" }] }, options: [{ label: "Both", effects: [] }, { label: "Neither", effects: [] }] }] }));
    ok(await answerDirect(root, { decision: "D-dir", option: "Both" }));
    const decision = (await decisionsView(root)).s.decisions.find((d) => (d.label ?? d.id) === "D-dir")!.id;
    const heldFor = async (text: string) => {
      const f = await shareFinding(root, 7, { targetKind: "anchor", targetId: `src/pay.ts#${text}`, text }) as { id: string };
      ok(f);
      const held = await postRepairSort(root, 7, { ...sort(f.id, []), classification: "design-defect", restsOn: ["D1"] }) as { id: string };
      ok(held);
      assert.match(String((await releaseReaderBrief(root, 7, { sort: held.id, slot: 1 }) as { error?: string }).error), /rests on no decision entry/);
      const repointed = await postRepairSort(root, 7, { ...sort(f.id, []), classification: "design-defect", restsOn: [`decision:${decision}`], prior: held.id, reason: "D1 is this decision" }) as { id: string };
      ok(repointed);
      return repointed.id;
    };
    const read = async (sortId: string, verdicts: ["yes" | "no", "yes" | "no"], agents: [string, string]) => {
      const refs = [];
      for (const slot of [1, 2] as const) {
        const brief = await releaseReaderBrief(root, 7, { sort: sortId, slot }) as { requestId: string; prompt: string };
        ok(brief);
        assert.match(brief.prompt, /which guard does transfer need/);
        const verdict = { requestId: brief.requestId, verdict: verdicts[slot - 1]!, rationale: `slot ${slot}` };
        const held = submitReleaseVerdict(root, verdict) as { receipt: string };
        ok(held);
        readerTranscript(dir, "5e55a0a0-0000-0000-0000-00000000000" + agents[slot - 1]!.slice(-1), agents[slot - 1]!, brief.prompt, "submit_release_verdict", verdict, held);
        refs.push({ requestId: brief.requestId, receipt: held.receipt });
      }
      return refs;
    };
    const yes = await heldFor("guarded");
    const released = await releaseHeldSort(root, 7, { sort: yes, readers: await read(yes, ["yes", "yes"], ["a1111111", "a2222222"]) }, dir) as any;
    ok(released);
    const s = released.records.sorts.find((x: any) => x.input.id === released.id);
    assert.equal(s.input.provenance, "released");
    assert.deepEqual(s.input.restsOn, []);
    assert.equal(s.eligible, true, s.holds.join());
    const no = await heldFor("unguarded");
    const refused = await releaseHeldSort(root, 7, { sort: no, readers: await read(no, ["yes", "no"], ["a3333333", "a4444444"]) }, dir) as { error?: string };
    assert.match(String(refused.error), /stays held/);
    assert.match(String((await postRepairSort(root, 7, { ...sort("x", []), provenance: "released" } as never) as { error?: string }).error), /release_held_sort/);
  } finally { t.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
