import { test } from "node:test";
import assert from "node:assert/strict";
import { testChain, testEvent } from "./test-events.js";
import { sortEvents, type LogEvent } from "./eventlog.js";
import { isLogDamage } from "./log-damage.js";
import { foldFindings, findingScope } from "./shared-findings.js";
import { foldBugs, bugScope } from "./shared-bugs.js";
import { canonicalIssueKey, type CanonicalIssueReference } from "./decision-issues.js";
import {
  applicationDisplayHash, applicationKey, issueClaimHash, validateApplicationCapsule,
  type ApplicationCapsuleV1,
} from "./ruling-application.js";

const agent = { principal: "alice@example.test", via: { kind: "agent" as const, model: "reader" } };
const human = { principal: "alice@example.test" };
const universe = "acme/api";

function fixture(kind: "finding" | "bug") {
  const id = kind === "finding" ? "f_1" : "bug_1";
  const ref: CanonicalIssueReference = kind === "finding"
    ? { kind, universe, id, review: "1", scope: findingScope(`${universe}/pr-1`) }
    : { kind, universe, id, scope: bugScope(universe) };
  const created = testEvent({
    id: "01", writer: "origin", kind: kind === "finding" ? "finding.created" : "bug.filed", subject: id,
    actor: agent,
    data: kind === "finding"
      ? { targetKind: "anchor", targetId: "a_1", text: "claim" }
      : { title: "claim", text: "claim", anchors: [] },
  });
  const fold = kind === "finding" ? foldFindings : foldBugs;
  const claimHash = issueClaimHash(kind, fold([created]).get(id)!);
  // The context the person was shown: the chosen option settles nothing about this issue, so
  // the ruling defeats its premise and closes it as invalid.
  const context = JSON.stringify({ payload: { question: `Is ${id} invalid?` }, options: [{ label: "Yes", effects: [] }], selected: ["Yes"], answerer: human.principal });
  const display = { question: `Is ${id} invalid?`, answer: `Yes, ${id} rests on an unsupported rule.`, context };
  const displayHash = applicationDisplayHash(display);
  const make = (rulingKey = "ruling_1", openEpoch = "01", openState: "created" | "issued" = "issued"): ApplicationCapsuleV1 => {
    const issueKey = canonicalIssueKey(ref);
    return {
      version: 3, outcome: "invalid", key: applicationKey(rulingKey, issueKey),
      issue: { ref, key: issueKey, openEpoch, openState, claimHash },
      ruling: {
        answerId: rulingKey, roundId: "round_1", questionId: "question_1",
        display, displayHash,
        authority: { checkedAt: "2026-09-25T00:00:00Z", sourceFingerprint: "sha256:source", status: "current", comparison: "clear" },
      },
      evidence: {
        directMention: id,
        readers: [{ id: "receipt_1", request: "request_1", launch: "launch_1", session: "session_1", by: agent,
          briefHash: "sha256:brief", manifestHash: "sha256:manifest", issueHash: claimHash,
          rulingHash: displayHash, verdict: "sound", rationale: "the answer defeats this claim" }],
      },
      reason: "Invalid under the human ruling",
    };
  };
  const app = (eventId: string, capsule: unknown, after: string[] = ["01"]): LogEvent => testEvent({
    id: eventId, writer: `application-${eventId}`, kind: `${kind}.rulingApplied`, subject: id,
    actor: agent, after, data: { capsule },
  });
  const state = (eventId: string, next: string, after: string[] = ["01"]): LogEvent => testEvent({
    id: eventId, writer: `state-${eventId}`, kind: `${kind}.stateChanged`, subject: id,
    actor: human, after, data: { state: next, reason: next },
  });
  const reopen = (eventId: string, closure: string): LogEvent => testEvent({
    id: eventId, writer: `reopen-${eventId}`, kind: `${kind}.reopened`, subject: id,
    actor: agent, after: [closure], data: { state: "created", observedClosure: closure },
  });
  return { id, ref, created, fold, make, app, state, reopen };
}

for (const kind of ["finding", "bug"] as const) {
  test(`${kind}: application closes once and a delayed duplicate cannot reclose after reopen`, () => {
    const f = fixture(kind);
    const cap = f.make();
    const events = [f.created, f.app("02", cap), f.reopen("03", "02"), f.app("04", cap)];
    const issue = f.fold(sortEvents(events)).get(f.id)!;
    assert.equal(issue.state, "created");
    assert.deepEqual(issue.applications?.map((a) => a.status), ["executed", "duplicate"]);
    assert.equal(issue.applications?.[0]?.eventId, "02");
    assert.equal(issue.applications?.[1]?.key, cap.key);
    assert.equal(issue.closed, undefined);
  });

  test(`${kind}: an application a concurrent close got to first spends nothing`, () => {
    // Owner: "spend only when a closure actually executes".
    const f = fixture(kind);
    const events = [f.created, f.state("02", "refuted"), f.app("03", f.make()), f.reopen("04", "02"),
      f.app("05", f.make("ruling_1", "04", "created"), ["04"])];
    const issue = f.fold(sortEvents(events)).get(f.id)!;
    assert.deepEqual(issue.applications?.map((a) => a.status), ["refused", "executed"]);
    assert.match(issue.applications?.[0]?.reason ?? "", /nothing was spent/);
    assert.equal(issue.closed?.eventId, "05", "the same ruling still closes the reopened issue");
  });

  test(`${kind}: a stale-epoch application after a reopen closes nothing and spends nothing`, () => {
    const f = fixture(kind);
    const stale = f.app("04", f.make("ruling_2"), ["01"]);
    const fresh = f.app("05", f.make("ruling_2", "03", "created"), ["03", "04"]);
    const issue = f.fold(sortEvents([f.created, f.app("02", f.make()), f.reopen("03", "02"), stale, fresh])).get(f.id)!;
    assert.deepEqual(issue.applications?.map((a) => a.status), ["executed", "refused", "executed"]);
    assert.equal(issue.state, "invalid");
    assert.equal(issue.closed?.eventId, "05");
  });

  test(`${kind}: an application that saw closure is refused and spends nothing`, () => {
    const f = fixture(kind);
    const stale = f.app("03", f.make(), ["02"]);
    const fresh = f.app("05", f.make("ruling_2", "04"), ["04"]);
    const issue = f.fold(sortEvents([f.created, f.state("02", "refuted"), stale,
      f.reopen("04", "02"), fresh])).get(f.id)!;
    assert.equal(issue.applications?.[0]?.status, "refused");
    assert.equal(issue.applications?.[1]?.status, "refused", "fresh capsule must match the reopened state too");
    assert.equal(issue.state, "created");
  });

  test(`${kind}: a genuinely new ruling can close the reopened issue`, () => {
    const f = fixture(kind);
    const fresh = f.make("ruling_2", "03", "created");
    const issue = f.fold(sortEvents([f.created, f.app("02", f.make()), f.reopen("03", "02"),
      f.app("04", fresh, ["03"]), f.app("05", f.make(), ["03"])])).get(f.id)!;
    assert.equal(issue.state, "invalid");
    assert.equal(issue.closed?.eventId, "04");
    assert.deepEqual(issue.applications?.map((a) => a.status), ["executed", "executed", "duplicate"]);
  });

  test(`${kind}: a pair key that is not its answer's cannot re-close a reopened issue`, () => {
    const f = fixture(kind);
    const rekeyed = f.make("ruling_1-again", "03", "created");
    rekeyed.ruling.answerId = "ruling_1";
    const issue = f.fold(sortEvents([f.created, f.app("02", f.make()), f.reopen("03", "02"),
      f.app("04", rekeyed, ["03"])])).get(f.id)!;
    assert.equal(issue.state, "created");
    assert.equal(issue.applications?.[1]?.status, "refused");
    assert.match(issue.applications?.[1]?.reason ?? "", /application key/);
  });

  test(`${kind}: malformed approval flag is preserved as refusal`, () => {
    const f = fixture(kind);
    const issue = f.fold([f.created, f.app("02", { approved: true })]).get(f.id)!;
    assert.equal(issue.state, "issued");
    assert.equal(issue.applications?.[0]?.status, "refused");
    assert.match(issue.applications?.[0]?.reason ?? "", /capsule version/);
  });
}

test("capsule checks correspondence and independent reader receipts", () => {
  const f = fixture("finding");
  const c = f.make();
  assert.ok("capsule" in validateApplicationCapsule(c, "finding", f.id));
  const wrongReview = structuredClone(c);
  if (wrongReview.issue.ref.kind === "finding") wrongReview.issue.ref.review = "2";
  assert.match((validateApplicationCapsule(wrongReview, "finding", f.id) as { error: string }).error, /identity/);
  const substring = structuredClone(c);
  substring.ruling.display = { question: "Is f_10 invalid?", answer: "Yes", context: c.ruling.display.context };
  substring.ruling.displayHash = applicationDisplayHash(substring.ruling.display);
  substring.evidence.readers[0]!.rulingHash = substring.ruling.displayHash;
  assert.match((validateApplicationCapsule(substring, "finding", f.id) as { error: string }).error, /not shown/);
  const linked = structuredClone(c);
  linked.evidence.directMention = "#/u/acme%2Fapi/shared/1/?f=f_1";
  linked.ruling.display.question = `Is ${linked.evidence.directMention} invalid?`;
  linked.ruling.displayHash = applicationDisplayHash(linked.ruling.display);
  linked.evidence.readers[0]!.rulingHash = linked.ruling.displayHash;
  assert.ok("capsule" in validateApplicationCapsule(linked, "finding", f.id));
  const changed = structuredClone(c);
  changed.evidence.readers[0]!.issueHash = "sha256:other";
  assert.match((validateApplicationCapsule(changed, "finding", f.id) as { error: string }).error, /unbound/);
  const indirect = structuredClone(c);
  delete indirect.evidence.directMention;
  indirect.evidence.readers.push({ ...indirect.evidence.readers[0]!, id: "receipt_2" });
  assert.match((validateApplicationCapsule(indirect, "finding", f.id) as { error: string }).error, /independently launched/);
});


test("acceptance capsule requires exact selected human disposition and preserves the consumed act", () => {
  const f = fixture("finding");
  const cap = f.make();
  cap.outcome = "accepted";
  cap.ruling.answerer = { principal: human.principal };
  cap.acceptance = { by: human, option: "Accept permanently", findingId: f.id };
  cap.ruling.display = { question: `Accept ${f.id} as real and deliberately not being fixed?`, answer: "Accept permanently",
    context: JSON.stringify({ answerer: human.principal, selected: ["Accept permanently"], options: [{ label: "Accept permanently", effects: [{ findings: [f.id], on: "settle", as: "accepted" }] }] }) };
  cap.ruling.displayHash = applicationDisplayHash(cap.ruling.display);
  cap.evidence.readers[0]!.rulingHash = cap.ruling.displayHash;
  assert.ok("capsule" in validateApplicationCapsule(cap, "finding", f.id));
  const accepted = f.fold([f.created, f.app("02", cap)]).get(f.id)!;
  assert.equal(accepted.state, "accepted");
  assert.deepEqual(accepted.closed?.by, human);
  assert.equal(f.fold([f.created, f.app("02", cap), f.reopen("03", "02"), f.app("04", cap)]).get(f.id)!.state, "created");
  // A capsule in a dev-era version is skipped, never locked on (owner, Q7: "fold or skip").
  const old = structuredClone(cap) as any; old.version = 1;
  assert.equal(f.fold([f.created, f.app("02", old)]).get(f.id)!.state, "issued");
  for (const mutate of [
    (c: any) => c.acceptance.by = agent,
    (c: any) => c.acceptance.findingId = "other",
    (c: any) => c.ruling.display.context = JSON.stringify({ selected: ["Plan only"], options: [{ label: "Accept permanently", effects: [{ findings: [f.id], on: "settle", as: "accepted" }] }] }),
    (c: any) => c.ruling.display.context = JSON.stringify({ selected: ["Accept permanently"], options: [{ label: "Accept permanently", effects: [{ findings: [f.id], on: "unblock" }] }] }),
  ]) {
    const bad = structuredClone(cap); mutate(bad);
    bad.ruling.displayHash = applicationDisplayHash(bad.ruling.display);
    bad.evidence.readers[0]!.rulingHash = bad.ruling.displayHash;
    assert.ok("error" in validateApplicationCapsule(bad, "finding", f.id));
    assert.equal(f.fold([f.created, f.app("02", bad)]).get(f.id)!.state, "issued");
  }
});

test("acceptance replay refuses malformed context and contradictory selected effects without crashing", () => {
  const f = fixture("finding");
  const make = (context: unknown) => {
    const c = f.make(); c.outcome = "accepted";
    c.acceptance = { by: human, option: "Accept", findingId: f.id };
    c.ruling.answerer = { principal: human.principal };
    c.ruling.display = { question: `Accept ${f.id}?`, answer: "Accept", context: JSON.stringify(context && typeof context === "object" ? { ...context, answerer: human.principal } : context) };
    c.ruling.displayHash = applicationDisplayHash(c.ruling.display);
    c.evidence.readers[0]!.rulingHash = c.ruling.displayHash;
    return c;
  };
  const effect = { findings: [f.id], on: "settle", as: "accepted" };
  const accept = { label: "Accept", effects: [effect] };
  const good = make({ selected: ["Accept"], options: [accept] });
  assert.equal(f.fold([f.created, f.app("02", good)]).get(f.id)!.state, "accepted");
  const malformed: unknown[] = [
    null, { selected: ["Accept"], options: {} }, { selected: ["Accept"], options: [null] },
    { selected: ["Accept"], options: [{ label: "Accept", effects: {} }] },
    { selected: ["Accept"], options: [{ label: "Accept", effects: [null] }] },
    { selected: ["Accept"], options: [{ label: "Accept", effects: [{ ...effect, findings: {} }] }] },
    { selected: ["Accept"], options: [{ label: "Accept", effects: [{ ...effect, issues: [null] }] }] },
    ...[{ label: "Refute", effects: [{ ...effect, as: "refuted" }] },
      { label: "Work", effects: [{ findings: [f.id], on: "unblock" }] },
      { label: "Also accept", effects: [effect] }].map(other => ({ selected: ["Accept", other.label], options: [accept, other] })),
  ];
  for (const context of malformed) {
    const bad = make(context);
    assert.ok("error" in validateApplicationCapsule(bad, "finding", f.id));
    const result = f.fold([f.created, f.app("02", bad)]).get(f.id)!;
    assert.equal(result.state, "issued");
    assert.equal(result.applications?.[0]?.status, "refused");
  }
  const stranger = structuredClone(good);
  stranger.acceptance!.by = { principal: "stranger@example.test" };
  assert.ok("error" in validateApplicationCapsule(stranger, "finding", f.id));
  assert.equal(f.fold([f.created, f.app("02", stranger)]).get(f.id)!.state, "issued");
  stranger.ruling.answerer = { principal: "stranger@example.test" };
  assert.ok("error" in validateApplicationCapsule(stranger, "finding", f.id), "answerer remains bound to the reader's hashed shown context");
  assert.equal(f.fold([f.created, f.app("02", stranger)]).get(f.id)!.state, "issued");
});

for (const kind of ["finding", "bug"] as const) {
  test(`${kind}: a ruling whose chosen option settles it as refuted closes it as refuted, not invalid`, () => {
    // Owner, batch 7: the one pathway oddity this merge fixes — decision closures record the outcome ruled.
    const f = fixture(kind);
    const cap = f.make();
    cap.outcome = "refuted";
    const effect = kind === "finding" ? { findings: [f.id], on: "settle", as: "refuted" } : { findings: [], issues: [f.ref], on: "settle", as: "refuted" };
    cap.ruling.display = { ...cap.ruling.display, context: JSON.stringify({ payload: {}, options: [{ label: "Refute", effects: [effect] }], selected: ["Refute"], answerer: human.principal }) };
    cap.ruling.displayHash = applicationDisplayHash(cap.ruling.display);
    cap.evidence.readers[0]!.rulingHash = cap.ruling.displayHash;
    assert.equal(f.fold([f.created, f.app("02", cap)]).get(f.id)!.state, "refuted");
    // An outcome the chosen option does not say is refused, whichever way it lies.
    for (const outcome of ["invalid", "accepted"] as const) {
      const wrong = structuredClone(cap); wrong.outcome = outcome;
      assert.ok("error" in validateApplicationCapsule(wrong, kind, f.id), outcome);
    }
  });
}

test("the fold binds an arbitrator to the two reader receipts it read, not only the op", () => {
  const f = fixture("finding");
  const cap = f.make();
  delete cap.evidence.directMention;
  const reader = cap.evidence.readers[0]!;
  cap.evidence.readers = [{ ...reader, verdict: "sound" }, { ...reader, id: "receipt_2", request: "request_2", launch: "launch_2", session: "session_2", verdict: "unsound" }];
  const arbitrator = { ...reader, id: "receipt_3", request: "request_3", launch: "launch_3", session: "session_3", verdict: "sound" as const };
  cap.evidence.arbitrator = { ...arbitrator, readerReceipts: ["receipt_1", "receipt_2"] };
  assert.ok("capsule" in validateApplicationCapsule(cap, "finding", f.id));
  for (const readerReceipts of [undefined, ["receipt_1", "receipt_x"], ["receipt_2", "receipt_1"]]) {
    const bad = structuredClone(cap); bad.evidence.arbitrator = { ...arbitrator, ...(readerReceipts ? { readerReceipts } : {}) };
    assert.match((validateApplicationCapsule(bad, "finding", f.id) as { error: string }).error, /did not read these two/, JSON.stringify(readerReceipts));
    assert.equal(f.fold([f.created, f.app("02", bad)]).get(f.id)!.state, "issued");
  }
});

test("D4: indirect readers launched from one session are independent by their launches", () => {
  const f = fixture("finding");
  const c = f.make();
  delete c.evidence.directMention;
  c.evidence.readers.push({ ...c.evidence.readers[0]!, id: "receipt_2", request: "request_2", launch: "launch_2" });
  assert.equal(c.evidence.readers[0]!.session, c.evidence.readers[1]!.session);
  const v = validateApplicationCapsule(c, "finding", f.id);
  assert.ok("capsule" in v, JSON.stringify(v));
});
