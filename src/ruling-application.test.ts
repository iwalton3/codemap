import { test } from "node:test";
import assert from "node:assert/strict";
import { testChain, testEvent } from "./test-events.js";
import { sortEvents, type LogEvent } from "./eventlog.js";
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
  const display = { question: `Is ${id} invalid?`, answer: `Yes, ${id} rests on an unsupported rule.`, context: "full ruling context" };
  const displayHash = applicationDisplayHash(display);
  const make = (rulingKey = "ruling_1", openEpoch = "01", openState: "created" | "issued" = "issued"): ApplicationCapsuleV1 => {
    const issueKey = canonicalIssueKey(ref);
    return {
      version: 1, key: applicationKey(rulingKey, issueKey),
      issue: { ref, key: issueKey, openEpoch, openState, claimHash },
      ruling: {
        key: rulingKey, answerId: "answer_1", answerEvent: "answer_event_1", roundId: "round_1", questionId: "question_1",
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

  test(`${kind}: concurrent ordinary close does not refund act-time application`, () => {
    const f = fixture(kind);
    const cap = f.make();
    const events = [f.created, f.state("02", "refuted"), f.app("03", cap), f.reopen("04", "02"), f.app("05", cap)];
    const issue = f.fold(sortEvents(events)).get(f.id)!;
    assert.equal(issue.state, "created", "reopen of the ordinary close remains in force");
    assert.deepEqual(issue.applications?.map((a) => a.status), ["executed", "duplicate"]);
    assert.equal(issue.applications?.[0]?.eventId, "03", "the application was valid on its own clone");
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
  substring.ruling.display = { question: "Is f_10 invalid?", answer: "Yes", context: "context" };
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
