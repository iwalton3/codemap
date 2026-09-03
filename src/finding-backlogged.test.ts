/**
 * The backlog — a finding that is real, is not being fixed now, and comes back.
 *
 * The state between "blocks the merge" and "confirmed bug", which had no record. Measured
 * across two live universes: 97 findings still open on pull requests that had merged, 46
 * of them still exactly true of the trunk, and 41 of those 46 with no disposition of any
 * kind. The seven deferrals anybody HAD recorded had no deadline at all —
 * the escape hatch was prose, including one reading "deferred to bug_7a5b29e71285 so it
 * survives the PR closing", which is the bug queue being used as a holding pen.
 *
 * Every test drives `foldFindings` on hand-built events, because that is the only way
 * this project has ever found a guard-in-one-end defect (CLAUDE.md § the sidecar). The
 * fold is the authority: a write-time check protects the honest writer and nobody else.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { foldFindings, needsHumanAck } from "./shared-findings.js";
import type { LogEvent } from "./eventlog.js";
import type { Actor, BugWitness } from "./schema.js";

const PERSON: Actor = { principal: "izzie@x.com" };
const AGENT: Actor = { principal: "izzie@x.com", via: { kind: "agent", model: "claude-opus-5" } };
const W: BugWitness = { anchorId: "a_1", bodyHash: "h2:aaaa:sha256:bbbb" };

let seq = 0;
const ev = (kind: string, actor: Actor, data: Record<string, unknown>): LogEvent =>
  ({ id: `e${++seq}`, kind, subject: "f_1", actor, at: "2026-09-01T00:00:00Z", data } as unknown as LogEvent);

const created = (over: Record<string, unknown> = {}) =>
  ev("finding.created", AGENT, { targetKind: "anchor", targetId: "a_1", text: "real thing", ...over });

const fold = (...events: LogEvent[]) => foldFindings(events).get("f_1")!;

test("backlogging needs a deadline, and the fold is what enforces it", () => {
  const ok = fold(created(), ev("finding.backlogged", PERSON, {
    until: "2026-11-01", reason: "CreditLineDomain is slated for replacement", witness: W,
  }));
  assert.equal(ok.backlogged?.until, "2026-11-01");
  assert.equal(ok.backlogged?.reason, "CreditLineDomain is slated for replacement");
  assert.deepEqual(ok.backlogged?.witness, W, "the code as it stood when somebody said 'not now'");

  // Each of these would never wake. `acknowledgements` refuses the same
  // shape for the same reason: a record that silences something permanently and silently
  // is worse than no record, and every deferral in the measured data was in this state.
  assert.equal(fold(created(), ev("finding.backlogged", PERSON, { reason: "not now", witness: W })).backlogged,
    undefined, "no date at all");
  assert.equal(fold(created(), ev("finding.backlogged", PERSON, { until: "soon", reason: "not now" })).backlogged,
    undefined, "a date that is not a date");
  assert.equal(fold(created(), ev("finding.backlogged", PERSON, { until: "2026-11-01" })).backlogged,
    undefined, "no reason — it is a record of a decision, not a mute button");
});

test("an agent may not backlog a finding, and may not bring one back either", () => {
  // The queue-clearing move, from both sides. With a backlog this size, deferral is the
  // cheapest way to empty a queue — which is exactly why `debt` is principal-granted one
  // subsystem over, and the argument transfers unchanged.
  assert.equal(fold(created(), ev("finding.backlogged", AGENT, { until: "2026-11-01", reason: "not now", witness: W })).backlogged,
    undefined, "an agent's attempt is dropped by the fold, not merely refused by the tool");

  const granted = ev("finding.backlogged", PERSON, { until: "2026-11-01", reason: "r" });
  const after = fold(created(), granted, ev("finding.backlogReleased", AGENT, { reason: "clearing the queue" }));
  assert.equal(after.backlogged?.until, "2026-11-01", "and an agent cannot end one a person granted");

  const byPerson = fold(created(), granted, ev("finding.backlogReleased", PERSON, { reason: "doing it now" }));
  assert.equal(byPerson.backlogged, undefined, "…while the person who granted it can");
});

test("a later deadline supersedes an earlier one; the ref is evidence, never the condition", () => {
  const pushed = fold(created(),
    ev("finding.backlogged", PERSON, { until: "2026-11-01", reason: "first" }),
    ev("finding.backlogged", PERSON, { until: "2027-01-01", reason: "pushed out" }));
  assert.equal(pushed.backlogged?.until, "2027-01-01");
  assert.equal(pushed.backlogged?.reason, "pushed out");

  // A Jira issue rides along as evidence. It is NOT what brings it back — a ticket
  // closed as won't-do, moved or deleted must not be able to silence this forever.
  const withRef = fold(created(), ev("finding.backlogged", PERSON, {
    until: "2026-11-01", reason: "r", system: "jira", key: "ACME-742",
  }));
  assert.equal(withRef.backlogged?.ref?.key, "ACME-742");
  assert.equal(withRef.backlogged?.until, "2026-11-01", "the date is still the condition");
});

test("an AGENT may attach a missing witness, but never over one that exists", () => {
  // The bucket nothing else can touch: 19% of the measured backlog has no witness, so no
  // drift question can be asked about it at all. Repair is evidence, not a disposition,
  // which is why this is the one act here an agent may perform.
  const repaired = fold(created(), ev("finding.rewitnessed", AGENT, { witness: W }));
  assert.deepEqual(repaired.witness, W);
  assert.equal(repaired.witnessAttached?.by.via?.kind, "agent",
    "and it is marked, because it cannot testify about the code at filing time");

  const original: BugWitness = { anchorId: "a_orig", bodyHash: "h2:orig:sha256:orig" };
  const untouched = fold(created({ witness: original }), ev("finding.rewitnessed", AGENT, { witness: W }));
  assert.deepEqual(untouched.witness, original,
    "replacing a witness re-baselines every drift answer that depends on it");
  assert.equal(untouched.witnessAttached, undefined, "and the marker must not appear either");

  assert.equal(fold(created(), ev("finding.rewitnessed", AGENT, { witness: { anchorId: "a_1" } })).witness,
    undefined, "half a witness is not a witness");
});

test("bringing a finding back needs a reason at BOTH ends", () => {
  // The writer refused an empty one and the fold did not — so a buggy or older client
  // could un-backlog a finding with no record of why, and every clone would apply it.
  const granted = ev("finding.backlogged", PERSON, { until: "2027-01-01", reason: "r" });
  const bare = fold(created(), granted, ev("finding.backlogReleased", PERSON, {}));
  assert.equal(bare.backlogged?.until, "2027-01-01", "a reasonless release is dropped, not applied");

  const proper = fold(created(), granted, ev("finding.backlogReleased", PERSON, { reason: "doing it now" }));
  assert.equal(proper.backlogged, undefined);
});

test("a witness attached later arms a backlog that had none to wake on", () => {
  // A backlog may be granted with no witness — the deadline is the guaranteed condition
  // and the anchor may already have gone. But a finding repaired afterwards could then
  // never wake on drift AT ALL, losing the half of the release condition that is the
  // reason to prefer this over an acknowledgement.
  const f = fold(created(),
    ev("finding.backlogged", PERSON, { until: "2027-01-01", reason: "later" }),
    ev("finding.rewitnessed", AGENT, { witness: W }));
  assert.deepEqual(f.backlogged?.witness, W, "the deferral can now be woken by an edit");
  assert.deepEqual(f.witness, W);

  // Never over one that was taken when the decision was made — that IS the baseline.
  const original: BugWitness = { anchorId: "a_1", bodyHash: "h2:orig:sha256:orig" };
  const kept = fold(created(),
    ev("finding.backlogged", PERSON, { until: "2027-01-01", reason: "later", witness: original }),
    ev("finding.rewitnessed", AGENT, { witness: W }));
  assert.deepEqual(kept.backlogged?.witness, original, "the decision's own witness stands");
});

test("the FOLD refuses a witness that is not the finding's own target", () => {
  // The tool refused this and the fold did not, which is the guard-at-one-end shape the
  // contract forbids: a hostile or buggy client could point every replaying clone's drift
  // answers at code the finding was never about, and a wrong witness is worse than none —
  // none is visibly `unjudgeable`, this looks settled.
  const wrong: BugWitness = { anchorId: "a_unrelated", bodyHash: "h2:w:sha256:w" };
  const f = fold(created(), ev("finding.rewitnessed", AGENT, { witness: wrong }));
  assert.equal(f.witness, undefined, "the mismatched repair is dropped");
  assert.equal(f.witnessAttached, undefined, "and it leaves no marker claiming one happened");

  // On a backlog it drops only the WITNESS: the deadline is the guaranteed release
  // condition and a decision somebody made must not be lost over a bad optional field.
  const b = fold(created(), ev("finding.backlogged", PERSON, { until: "2027-01-01", reason: "later", witness: wrong }));
  assert.equal(b.backlogged?.until, "2027-01-01", "the decision stands");
  assert.equal(b.backlogged?.witness, undefined, "with no early wake it cannot honestly offer");
});

test("a finding that becomes a bug stops asking — ack and assignment go with it", () => {
  // `finding.promotedToBug` says in words that "the finding stops asking for a decision;
  // its successor is asking", and neither `needsHumanAck` nor the fold implemented it. So
  // a promoted finding kept its ack badge, kept counting in the PR page's open count and
  // the dashboard's `findings.waiting`, and stayed in `review_queue` on an assignment
  // whose owner had already changed.
  const f = fold(created(),
    ev("finding.corroborated", PERSON, { verdict: "confirm", rationale: "real" }),
    ev("finding.assigned", PERSON, { kind: "investigate", note: "look again" }),
    ev("finding.promotedToBug", PERSON, { bug: "bug_1" }));
  assert.equal(f.bug, "bug_1");
  assert.equal(f.assignment, undefined, "the outstanding ask transferred with the obligation");
  assert.equal(needsHumanAck(f), false, "and it is not asking any more");

  // Without the bug, both stand — or the assertions above pass for the wrong reason.
  const still = fold(created(),
    ev("finding.corroborated", PERSON, { verdict: "confirm", rationale: "real" }),
    ev("finding.assigned", PERSON, { kind: "investigate", note: "look again" }));
  assert.equal(still.assignment?.kind, "investigate");
  assert.equal(needsHumanAck(still), true);
});
