// Seen rules 1 and 2 removed (round 3, owner: "I don't see a reason to protect against hand
// written writes"). Each guarded only an event whose `after` claims it read less than its payload
// shows; round 2's O4 run showed neither guards a lost update. What must still hold: the fold
// refuses exactly what the door refuses (CLAUDE.md, "the rule that refuses a write is the rule that
// would refuse the event on read").
import { test } from "node:test";
import assert from "node:assert/strict";
import { findingScope, foldFindingsReport } from "./shared-findings.js";
import { bugScope, foldBugsReport } from "./shared-bugs.js";
import { decisionHash, decisionsDoor, foldDecisions, standingForFinding } from "./shared-decisions.js";
import { applicationDisplayHash, applicationKey, issueClaimHash } from "./ruling-application.js";
import { canonicalIssueKey } from "./decision-issues.js";
import { foldRepairRecords } from "./repair-records.js";
import { repairVerificationHash } from "./repair-verification.js";
import { testEvent } from "./test-events.js";
import { doorFor, sortEvents, type LogEvent } from "./eventlog.js";

const agent = { principal: "alice@x", via: { kind: "agent", model: "reader" } } as any;
const human = { principal: "bob@x" };

/** A ruling application to finding/bug `kind`, built as `applyRuling` builds it from `view`. */
function application(kind: "finding" | "bug") {
  const universe = "acme/api";
  const id = kind === "finding" ? "f_1" : "bug_1";
  const ref: any = kind === "finding"
    ? { kind, universe, id, review: "1", scope: findingScope(`${universe}/pr-1`) }
    : { kind, universe, id, scope: bugScope(universe) };
  let seq = 0;
  const ev = (eid: string, k: string, actor: any, after: string[], data: any) =>
    testEvent({ id: eid, writer: `w-${eid}`, seq: ++seq, kind: k, subject: id, actor, after, data });
  const created = ev("01", kind === "finding" ? "finding.created" : "bug.filed", agent, [],
    kind === "finding" ? { targetKind: "anchor", targetId: "a_1", text: "claim" } : { title: "claim", text: "claim", anchors: [] });
  const fold = (events: LogEvent[]) => (kind === "finding" ? foldFindingsReport(events) : foldBugsReport(events)) as
    { value: Map<string, any>; refused: { id: string; why: string }[] };
  const capsuleFrom = (view: LogEvent[]) => {
    const t = fold(sortEvents(view)).value.get(id);
    const issueKey = canonicalIssueKey(ref), claimHash = issueClaimHash(kind, t);
    const display = { question: `Is ${id} invalid?`, answer: `Yes, ${id} rests on an unsupported rule.`,
      context: JSON.stringify({ payload: { question: `Is ${id} invalid?` }, options: [{ label: "Yes", effects: [] }], selected: ["Yes"], answerer: human.principal }) };
    const displayHash = applicationDisplayHash(display);
    return { version: 3, outcome: "invalid", key: applicationKey("ruling_1", issueKey),
      issue: { ref, key: issueKey, openEpoch: t.openEpoch, openState: t.state, claimHash },
      ruling: { answerId: "ruling_1", roundId: "round_1", questionId: "question_1", display, displayHash,
        authority: { checkedAt: "2026-09-25T00:00:00Z", sourceFingerprint: "sha256:s", status: "current", comparison: "clear" } },
      evidence: { directMention: id, readers: [{ id: "rc_1", request: "rq_1", launch: "l_1", session: "s_1", by: agent,
        briefHash: "sha256:b", manifestHash: "sha256:m", issueHash: claimHash, rulingHash: displayHash, verdict: "sound", rationale: "defeats it" }] },
      reason: "Invalid under the human ruling" };
  };
  const apply = (capsule: unknown, after: string[]) => ev("A", `${kind}.rulingApplied`, agent, after, { capsule });
  const revise = (after: string[]) => ev("02", `${kind}.revised`, human, after, { was: { text: "claim" }, now: { text: "claim2" } });
  const outcome = (events: LogEvent[]) => {
    const r = fold(sortEvents(events));
    return { status: r.value.get(id)?.applications?.at(-1)?.status, refused: r.refused.find((x) => x.id === "A")?.why };
  };
  return { created, capsuleFrom, apply, revise, outcome };
}

for (const kind of ["finding", "bug"] as const) {
  test(`rule 1 gone (${kind}): an application judges the whole log before it, not what its after claims it read`, () => {
    const f = application(kind);
    // Its capsule matches the tip; `after` claims it read nothing.
    assert.deepEqual(f.outcome([f.created, f.apply(f.capsuleFrom([f.created]), [])]), { status: "executed", refused: undefined });
    // Its capsule is the revised claim; `after` stops before the revision.
    const r = f.revise(["01"]);
    assert.deepEqual(f.outcome([f.created, r, f.apply(f.capsuleFrom([f.created, r]), ["01"])]), { status: "executed", refused: undefined });
  });

  test(`rule 1 gone (${kind}): a teammate's revision landing before a staged application still refuses it`, () => {
    const f = application(kind);
    const capsule = f.capsuleFrom([f.created]);
    assert.equal(f.outcome([f.created, f.revise(["01"]), f.apply(capsule, ["01"])]).status, "refused");
  });
}

/** A repair-verification application, linear: each event's `after` is the one before it. */
function repair() {
  const actor = { principal: "owner" }, verifier = { principal: "verifier" };
  const identity = (session: string) => ({ principal: "verifier", harness: "mcp", session });
  const sort: any = { id: "sort", classification: "mechanical", kind: "isolated", coverage: [{ findingId: "f", claimIds: ["f:original"] }], restsOn: [], source: "owner reviewed exact guard", provenance: "owner-reviewed", assessments: [], disagreements: [] };
  const evidence: any = { id: "proof", sortId: "sort", witnessCommit: "a".repeat(40), baseCommit: "b".repeat(40), fixCommit: "c".repeat(40), coverage: [{ findingId: "f", claimIds: ["f:original"], result: "complete", reason: "whole claim", claimResults: [{ claimId: "f:original", result: "complete", reason: "whole claim" }] }], reproducer: [], regression: [], inspected: [], rulingIds: [], attribution: [] };
  const events: LogEvent[] = [];
  let seq = 0;
  const add = (id: string, kind: string, subject: string, data: any, by: any = actor, after = events.length ? [events.at(-1)!.id] : []) => {
    const e = testEvent({ id, writer: `w-${id}`, seq: ++seq, kind, subject, actor: by, after, data });
    events.push(e); return e;
  };
  add("created", "finding.created", "f", { text: "missing guard", targetId: "a", targetKind: "anchor", sourceRef: "a".repeat(40) });
  add("sort-event", "repair.sort-recorded", "sort", { ...sort });
  add("evidence-event", "repair.evidence-recorded", "proof", { ...evidence });
  const finding: any = foldFindingsReport(events).value.get("f");
  const c: any = { scope: "findings/acme/1", claims: foldRepairRecords(events).claims, sort, evidence, targets: [{ findingId: "f", openEpoch: finding.openEpoch, claimHash: issueClaimHash("finding", finding) }], code: { witnessCommit: evidence.witnessCommit, baseCommit: evidence.baseCommit, fixCommit: evidence.fixCommit, touched: [], availability: "available" }, rulingContext: "no holds", orchestrator: identity("orchestrator") };
  add("request", "repair.verification-requested", "request", { id: "request", capsule: c, capsuleHash: repairVerificationHash(c) }, verifier);
  for (const slot of [1, 2]) add(`run-${slot}`, "repair.verification-recorded", `run-${slot}`, { id: `run-${slot}`, requestId: "request", capsuleHash: repairVerificationHash(c), slot, identity: identity(`verifier-${slot}`),
    results: [{ findingId: "f", claimId: "f:original", verdict: "fixed", reason: "guard rejects negatives", grade: "inspection", executions: [], inspected: [{ source: "guard", commit: evidence.fixCommit, reasoning: "negative branch returns" }], noCheckReason: "no runnable target" }] }, verifier);
  const tip = events.at(-1)!.id;
  const data = { id: "application", requestId: "request", capsuleHash: repairVerificationHash(c), findingId: "f", openEpoch: finding.openEpoch, claimHash: issueClaimHash("finding", finding), outcome: "fixed", contextHash: repairVerificationHash(c.rulingContext), reason: "independent inspection covers exact whole claim", identity: identity("orchestrator") };
  const apply = (after: string[]) => add("A", "finding.repairApplied", "f", data, verifier, after);
  /** The read's state, and whether the registered findings door — what replay asks — refuses the act. */
  const judge = async () => {
    const sorted = sortEvents(events);
    const door = (await doorFor("/no-root", "findings/acme/1")!(sorted, sorted.find((e) => e.id === "A")!)).refused;
    return { state: (foldFindingsReport(sorted).value.get("f") as any).state, doorRefuses: door.some((x) => x.id === "A") };
  };
  return { add, apply, tip, sort, judge };
}

test("rule 1 gone (repair): an application whose after stops short is judged on the whole log", async () => {
  const f = repair();
  f.apply([]);
  assert.deepEqual(await f.judge(), { state: "resolved", doorRefuses: false });
});

test("O2: a teammate superseding the sort before a staged repair application — the read and the door agree", async () => {
  const f = repair();
  f.add("sort-2", "repair.sort-recorded", "sort-2", { ...f.sort, id: "sort-2", prior: "sort", reason: "new assessment" });
  f.apply([f.tip]);
  assert.deepEqual(await f.judge(), { state: "created", doorRefuses: true });
});

test("O2: a teammate decomposing the claim before a staged repair application — the read and the door agree", async () => {
  const f = repair();
  f.add("claims-2", "repair.claims-recorded", "f", { findingId: "f", parentId: "f:original", reason: "split", claims: [{ id: "f:second", text: "second guard" }] });
  f.apply([f.tip]);
  assert.deepEqual(await f.judge(), { state: "created", doorRefuses: true });
});

/** A decision question, alice's answer A, and a revision R of it. */
function revision() {
  const alice = { principal: "alice" }, bob = { principal: "bob" };
  const d1 = { id: "d1", round: "R1", ref: "D1", kind: "options",
    payload: { question: "D1: approve the fix for F3 and F7?", header: "H", options: [{ label: "Settle", description: "d" }, { label: "No", description: "d" }] },
    options: [{ label: "Settle", effects: [{ findings: ["F3"], on: "settle", as: "refuted" }, { findings: ["F7"], on: "unblock" }], recommended: true }, { label: "No", effects: [] }] };
  let seq = 0;
  const ev = (id: string, kind: string, actor: any, after: string[], data: any) =>
    testEvent({ id, writer: `w-${id}`, seq: ++seq, kind, subject: "s", actor, at: `2026-09-23T00:00:${String(seq).padStart(2, "0")}Z`, after, data });
  const round = ev("round", "decision.round.posted", alice, [], { round: { id: "R1", source: "plan-x", universe: "u" }, decisions: [d1], publication: 2 });
  const Q = "round:d1", hash = decisionHash(d1 as any);
  const answer = (after: string[]) => ev("A", "decision.answer.recorded", alice, after, { decision: Q, hash, via: { kind: "direct", option: "Settle" } });
  const revise = (by: any, after: string[]) => ev("R", "decision.answer.revised", by, after,
    { decision: Q, hash, via: { kind: "direct", option: "No" }, revision: { of: ["A"], findings: ["F3"] } });
  const judge = async (log: LogEvent[]) => {
    const events = sortEvents(log);
    const R = events.find((e) => e.id === "R")!;
    const door = (await decisionsDoor(events.slice(0, events.indexOf(R) + 1), R)).refused.some((x) => x.id === "R");
    let read: string;
    try {
      const d = foldDecisions(events).decisions[0]!;
      read = d.answers.find((a) => a.id === "R")?.revisionInvalid ? "invalid" : `stands: ${standingForFinding(d, "F3")?.id}`;
    } catch { read = "locks"; }
    return { door, read };
  };
  return { round, answer, revise, judge, alice, bob };
}

test("rule 2 gone: another person's revision is not refused for an after that omits what it revises", async () => {
  const w = revision();
  assert.deepEqual(await w.judge([w.round, w.answer(["round"]), w.revise(w.bob, ["round"])]), { door: false, read: "stands: R" });
  assert.deepEqual(await w.judge([w.round, w.answer(["round"]), w.revise(w.alice, ["round"])]), { door: false, read: "stands: R" });
});

test("a revision placed before the answer it revises: the read refuses what the door refuses", async () => {
  const w = revision();
  assert.deepEqual(await w.judge([w.round, w.revise(w.bob, ["round"]), w.answer(["round"])]), { door: true, read: "locks" });
});
