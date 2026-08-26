import { test } from "node:test";
import { testEvent } from "./test-events.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor } from "./schema.js";
import { sortEvents, readScope, type LogEvent } from "./eventlog.js";
import {
  createFinding, corroborate, comment, promote, request, setState, recordOutcome, declineAsk,
  markPosted, markUpstreamed, promoteToBug, readFindings, foldFindings, findingScope,
  needsHumanAck, mayTransition, mayRevise, ackQueue, alreadyPosted, isClosed, findingTier, byReadingOrder,
  type SharedFinding, type FindingState,
} from "./shared-findings.js";

const izzie: Actor = { principal: "izzie@x.com" };
const dana: Actor = { principal: "dana@x.com" };
const opus: Actor = { principal: "izzie@x.com", via: { kind: "agent", model: "claude-opus-5" } };
const fable: Actor = { principal: "izzie@x.com", via: { kind: "agent", model: "claude-fable-5" } };
const danasAgent: Actor = { principal: "dana@x.com", via: { kind: "agent", model: "claude-opus-5" } };

const tmp = () => mkdtempSync(join(tmpdir(), "codemap-sf-"));
const NEW = { targetKind: "anchor" as const, targetId: "a_1", text: "evidence", comment: "the ask" };

const one = async (root: string, pr = 264) => [...(await readFindings(root, pr)).values()][0]!;

// --- opening state follows authorship, from `via` ------------------------------

test("a person's finding opens as `created` — writing it IS the assertion", async () => {
  const root = tmp();
  try {
    await createFinding(root, 264, izzie, NEW);
    assert.equal((await one(root)).state, "created");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an agent's finding opens as `issued` — a proposal awaiting triage", async () => {
  const root = tmp();
  try {
    await createFinding(root, 264, opus, NEW);
    const f = await one(root);
    assert.equal(f.state, "issued");
    assert.equal(f.author.via?.model, "claude-opus-5", "and it records which model raised it");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- the ratchet ---------------------------------------------------------------

test("an agent may promote its own proposal to `created`", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, 264, opus, NEW);
    assert.ok(!("error" in (await setState(root, 264, fable, id, "created"))));
    assert.equal((await one(root)).state, "created");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an agent may kill a proposal nobody has stood behind", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, 264, opus, NEW);
    assert.ok(!("error" in (await setState(root, 264, fable, id, "invalid"))));
    assert.equal((await one(root)).state, "invalid");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an agent closing a finding a person raised is recorded as an ASK, not refused", async () => {
  // The guarantee is unchanged — the state does not move. What changed is the answer:
  // an agent told "no" goes looking for another verb, and the one it reaches for is
  // prose. Fifteen of fifteen thread comments in the production sidecar are state
  // changes written as remarks, against zero `request_human` asks ever recorded.
  const root = tmp();
  try {
    const id = await createFinding(root, 264, izzie, NEW);
    const r = await setState(root, 264, opus, id, "resolved", "fixed at head abc123") as { asked?: string; error?: string };
    assert.equal(r.error, undefined);
    assert.equal(r.asked, "resolve");
    const f = await one(root);
    assert.equal(f.state, "created", "the state is untouched — that is the whole point of the gate");
    assert.equal(f.pending?.ask, "resolve", "and it is on the RECORD, so the badge says `fixed pending`");
    assert.equal(f.pending?.rationale, "fixed at head abc123");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("once anything confirms it, an agent asks rather than closes", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, 264, opus, NEW);
    await corroborate(root, 264, dana, id, "confirm", "reproduced");
    const r = await setState(root, 264, fable, id, "invalid") as { asked?: string };
    assert.equal(r.asked, "invalidate");
    const f = await one(root);
    assert.equal(f.state, "issued", "an agent's own finding opens at `issued`, and stays there");
    assert.equal(f.pending?.ask, "invalidate");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** An agent's OWN unconfirmed finding is still its own to close — that is triage. */
test("an agent still closes its own unconfirmed finding outright", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, 264, opus, NEW);
    const r = await setState(root, 264, fable, id, "refuted", "not reachable") as { asked?: string };
    assert.equal(r.asked, undefined, "no ask — it just happens");
    const f = await one(root);
    assert.equal(f.state, "refuted");
    assert.equal(f.pending, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a person may close anything", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, 264, opus, NEW);
    await corroborate(root, 264, dana, id, "confirm", "yes");
    assert.ok(!("error" in (await setState(root, 264, izzie, id, "resolved", "fixed in abc123"))));
    const f = await one(root);
    assert.equal(f.state, "resolved");
    assert.equal(f.closed?.reason, "fixed in abc123");
    assert.ok(isClosed(f.state));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("THE FOLD enforces the ratchet, not just the write path", () => {
  // A write-time check protects the honest writer and nobody else. This event is
  // what an older or buggy client would emit; every reader must ignore it.
  const created = testEvent({ id: "0000000001-a", kind: "finding.created", subject: "f1", actor: izzie, data: { targetKind: "anchor", targetId: "a_1", text: "e" } });
  const forged = testEvent({ id: "0000000002-b", kind: "finding.stateChanged", subject: "f1", actor: opus, data: { state: "resolved" } });
  const f = foldFindings([created, forged]).get("f1")!;
  assert.equal(f.state, "created", "an agent cannot close a person's finding, however the event was produced");
});

// --- corroboration: a set, never a scalar --------------------------------------

test("corroboration keeps every opinion — disagreement is the signal", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, 264, opus, NEW);
    await corroborate(root, 264, dana, id, "confirm", "reproduced on staging");
    await corroborate(root, 264, izzie, id, "refute", "guarded upstream");
    const f = await one(root);
    assert.equal(f.corroboration.length, 2);
    assert.deepEqual(f.corroboration.map((c) => c.verdict).sort(), ["confirm", "refute"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("one entry per actor — a re-review replaces its own opinion, nobody else's", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, 264, izzie, NEW);
    await corroborate(root, 264, dana, id, "unsure", "not sure");
    await corroborate(root, 264, dana, id, "confirm", "now sure");
    const f = await one(root);
    assert.equal(f.corroboration.length, 1);
    assert.equal(f.corroboration[0]!.verdict, "confirm");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an agent's corroboration of its own principal's finding is not independent", async () => {
  // Otherwise "confirmed by three models" means one person's agent agreeing with
  // itself, which is the failure that would quietly erode trust in the queue.
  const root = tmp();
  try {
    const id = await createFinding(root, 264, izzie, NEW);
    await corroborate(root, 264, opus, id, "confirm", "looks right");
    assert.equal((await one(root)).corroboration[0]!.independent, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("another person's agent IS independent", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, 264, izzie, NEW);
    await corroborate(root, 264, danasAgent, id, "confirm", "reproduced");
    assert.equal((await one(root)).corroboration[0]!.independent, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- the derived ack gate -------------------------------------------------------

test("needsHumanAck is an OR over a latch and a grow-only set", () => {
  const base = { corroboration: [], promotion: undefined } as unknown as SharedFinding;
  assert.equal(needsHumanAck(base), false);
  assert.equal(needsHumanAck({ ...base, promotion: { at: "t", by: izzie } }), true);
  assert.equal(needsHumanAck({ ...base, corroboration: [{ actor: dana, verdict: "confirm", at: "t", rationale: "", independent: true }] }), true);
  assert.equal(needsHumanAck({ ...base, corroboration: [{ actor: dana, verdict: "refute", at: "t", rationale: "", independent: true }] }), false, "a refutation is not an ask");
});

test("promotion is a latch — surfacing twice is not a state change", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, 264, opus, NEW);
    await promote(root, 264, izzie, id);
    const first = (await one(root)).promotion!.at;
    await promote(root, 264, dana, id);
    const f = await one(root);
    assert.equal(f.promotion!.at, first, "the first promotion stands");
    assert.equal(f.promotion!.by.principal, "izzie@x.com");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("promotion does NOT gate another person's agent from triaging", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, 264, izzie, NEW);
    await promote(root, 264, izzie, id);
    await corroborate(root, 264, danasAgent, id, "refute", "handled by the guard above");
    assert.equal((await one(root)).corroboration.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- requests: the ack queue ----------------------------------------------------

test("an agent that may not act may still ask, and the ask lands in the queue", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, 264, izzie, NEW);
    await request(root, 264, opus, id, "resolve", "fixed by the rewrite in abc123");
    const f = await one(root);
    assert.equal(f.pending?.ask, "resolve");
    assert.equal(f.pending?.by.via?.model, "claude-opus-5");
    assert.equal(ackQueue([f]).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a second ask replaces the first, and the superseded one stays in the log", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, 264, izzie, NEW);
    await request(root, 264, opus, id, "refute", "not reachable");
    await request(root, 264, fable, id, "resolve", "actually it is fixed");
    assert.equal((await one(root)).pending?.ask, "resolve");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("acting on an ask clears it", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, 264, izzie, NEW);
    await request(root, 264, opus, id, "resolve", "fixed");
    await setState(root, 264, izzie, id, "resolved", "agreed");
    const f = await one(root);
    assert.equal(f.pending, undefined);
    assert.equal(ackQueue([f]).length, 0, "closed findings leave the queue");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an agent reports, a human resolves — outcome does not close anything", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, 264, izzie, NEW);
    await recordOutcome(root, 264, opus, id, "fixed", "guard added", ["src/pay.cs"]);
    const f = await one(root);
    assert.equal(f.outcome?.result, "fixed");
    assert.deepEqual(f.outcome?.files, ["src/pay.cs"]);
    assert.equal(f.state, "created", "still open — reporting is not resolving");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- threads --------------------------------------------------------------------

test("a thread is append-only and keeps every voice in order", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, 264, izzie, NEW);
    const a = await comment(root, 264, dana, id, "is this reachable?");
    await comment(root, 264, opus, id, "yes, via the webhook path", a.id);
    const f = await one(root);
    assert.equal(f.thread.length, 2);
    assert.equal(f.thread[1]!.inReplyTo, a.id);
    assert.equal(f.thread[1]!.actor.via?.model, "claude-opus-5");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- external refs and bug promotion --------------------------------------------

test("posting is a latch — the duplicate publish this log exists to prevent", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, 264, izzie, NEW);
    await markPosted(root, 264, izzie, id, { key: "1", url: "https://gh/1" });
    await markPosted(root, 264, dana, id, { key: "2", url: "https://gh/2" });
    const f = await one(root);
    assert.equal(f.posted?.url, "https://gh/1", "the first post is the record");
    assert.equal(alreadyPosted([f]).size, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("upstreaming records the ticket without closing the finding", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, 264, izzie, NEW);
    await markUpstreamed(root, 264, izzie, id, { key: "ABC-123", url: "https://jira/ABC-123" });
    const f = await one(root);
    assert.equal(f.upstream?.key, "ABC-123");
    assert.equal(f.state, "created", "tracked in JIRA is not fixed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("promoting to a bug cross-links and hands over the obligation", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, 264, izzie, NEW);
    await promote(root, 264, izzie, id);
    await promoteToBug(root, 264, izzie, id, "b_31a");
    const f = await one(root);
    assert.equal(f.bug, "b_31a");
    assert.equal(f.state, "created", "the finding survives — the PR history should still show it was raised");
    assert.equal(ackQueue([f]).length, 0, "its successor is asking now, not it");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- the fold's contract ---------------------------------------------------------

test("the fold is order-independent", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, 264, opus, NEW);
    await corroborate(root, 264, dana, id, "confirm", "yes");
    await promote(root, 264, izzie, id);
    await comment(root, 264, dana, id, "note");
    const raw = await readScope(root, findingScope(264));
    assert.equal(raw.length, 4, "four events to shuffle");
    const shuffles = [raw, [...raw].reverse(), [raw[2]!, raw[0]!, raw[3]!, raw[1]!]];
    const shapes = shuffles.map((s) => {
      const f = foldFindings(sortEvents(s)).get(id)!;
      return `${f.state}|${f.corroboration.length}|${!!f.promotion}|${f.thread.length}`;
    });
    assert.equal(new Set(shapes).size, 1, `folds must agree, got ${JSON.stringify(shapes)}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an event about an unknown finding is ignored, not fatal", () => {
  const orphan = testEvent({ id: "0000000001-a", kind: "finding.commented", subject: "nope", actor: izzie, data: { body: "hi" } });
  assert.equal(foldFindings([orphan]).size, 0);
});

test("a malformed creation is skipped", () => {
  const bad = testEvent({ id: "0000000001-a", kind: "finding.created", subject: "f1", actor: izzie, data: { text: "no target" } });
  assert.equal(foldFindings([bad]).size, 0);
});

test("mayTransition is the single rule both the fold and the writer use", () => {
  const issued = { state: "issued" as FindingState, corroboration: [], promotion: undefined } as unknown as SharedFinding;
  assert.equal(mayTransition(issued, izzie, "resolved"), true, "people may do anything");
  assert.equal(mayTransition(issued, opus, "created"), true);
  assert.equal(mayTransition(issued, opus, "invalid"), true);
  assert.equal(mayTransition(issued, opus, "refuted"), true);
  assert.equal(mayTransition(issued, opus, "resolved"), false,
    "`resolved` claims the CODE was fixed, which is not a claim about the report");

  // THE GATE IS CONFIRMATION, not who filed it or what state it opened in. A finding a
  // PERSON files opens at `created`, so keying on state made a human's unreviewed
  // one-liner — the likeliest false positive, and the one an agent is best placed to
  // check — the one thing an agent could not close.
  const created = { ...issued, state: "created" as FindingState };
  assert.equal(mayTransition(created, opus, "invalid"), true, "unconfirmed and agent-filed: an agent may close it");
  assert.equal(mayTransition(created, opus, "refuted"), true);

  // AND WHO FILED IT is now half the gate. A person's own report is not an agent's to
  // retire, whatever it later concluded — it asks instead, and `setState` records that
  // ask rather than erroring, which is what answers the old objection to this rule:
  // an agent CAN still say a human's one-liner is invalid, it just cannot bury it.
  const humanFiled = { ...created, author: izzie } as unknown as SharedFinding;
  assert.equal(mayTransition(humanFiled, opus, "invalid"), false, "a person filed it");
  assert.equal(mayTransition(humanFiled, opus, "created"), true, "but reopening it is not burying it");

  const confirmed = {
    ...created,
    corroboration: [{ actor: izzie, verdict: "confirm", at: "2026-01-01T00:00:00Z", rationale: "r", independent: true }],
  } as unknown as SharedFinding;
  assert.equal(mayTransition(confirmed, opus, "refuted"), false, "somebody stood behind it — a person closes it");
  assert.equal(mayTransition(confirmed, izzie, "refuted"), true, "and that person still may");

  // PROMOTION IS NOT A GATE. It means "this is real, the team should know" — a measure
  // of triage, and an optional one. Gating on it made saying a finding matters the act
  // that froze it, which is backwards.
  const promoted = { ...created, promotion: { at: "2026-01-01T00:00:00Z", by: izzie } } as unknown as SharedFinding;
  assert.equal(mayTransition(promoted, opus, "invalid"), true, "promotion says it matters, not that it is settled");

  // Reopening is a person's call even unconfirmed: whoever closed it wrote a reason.
  const closed = { ...issued, state: "refuted" as FindingState };
  assert.equal(mayTransition(closed, opus, "created"), false);
});

test("mayRevise is that same gate, so a human's raw note can be written up", () => {
  const created = { state: "created" as FindingState, corroboration: [], promotion: undefined } as unknown as SharedFinding;
  // The case the old rule refused: a person's one-line finding carries no severity, no
  // line and no remedy, and an agent that has just read the code is best placed to
  // supply them. Keyed on `state !== "issued"` the findings an agent could write up
  // were exactly the ones an agent had already written.
  assert.equal(mayRevise(created, opus), true);
  const confirmed = {
    ...created,
    corroboration: [{ actor: izzie, verdict: "confirm", at: "2026-01-01T00:00:00Z", rationale: "r", independent: true }],
  } as unknown as SharedFinding;
  // ALWAYS, now. What a finding SAYS is the text that gets published and acted on, and
  // leaving a wrong summary standing with a correction three entries below it is worse
  // for the reader than replacing it. Nothing is lost: `revisions` keeps every prior
  // wording. The judgements — severity, state, whether it is real — stay gated.
  assert.equal(mayRevise(confirmed, opus), true, "a confirmed finding's description is still improvable");
  assert.equal(mayRevise(confirmed, izzie), true, "and a person may always");
});

// --- reading order -----------------------------------------------------------

const tiered = (state: FindingState, verdicts: ("confirm" | "refute")[], severity?: string) => ({
  state,
  corroboration: verdicts.map((verdict) => ({
    actor: { principal: "x@y.z" }, verdict, at: "2026-01-01T00:00:00Z", rationale: "r", independent: false,
  })),
  severity: severity as never,
  createdAt: "2026-01-01T00:00:00Z",
});

test("a finding's tier is how settled it is, not when it was filed", () => {
  assert.equal(findingTier(tiered("created", ["confirm"])), "confirmed");
  assert.equal(findingTier(tiered("issued", [])), "unconfirmed");
  assert.equal(findingTier(tiered("created", ["refute"])), "doubted", "open but refuted is not just unconfirmed");
  assert.equal(findingTier(tiered("refuted", [])), "doubted");
  assert.equal(findingTier(tiered("withdrawn", [])), "doubted", "kept out of settled — a person reopens these");
  assert.equal(findingTier(tiered("resolved", [])), "settled");
  assert.equal(findingTier(tiered("invalid", [])), "settled");
});

test("disagreement ranks with the confirmed, not with the doubted", () => {
  // Two reviewers disagreeing is the case most needing a person; burying it under
  // the ones nobody has looked at is the opposite of what the ordering is for.
  assert.equal(findingTier(tiered("created", ["confirm", "refute"])), "confirmed");
});

test("the reading order is tier, then severity, then oldest first", () => {
  const list = [
    tiered("resolved", [], "critical"),
    tiered("created", [], "low"),
    tiered("created", ["confirm"], "medium"),
    tiered("refuted", [], "critical"),
    tiered("created", ["confirm"], "critical"),
  ];
  const order = [...list].sort(byReadingOrder).map((f) => `${findingTier(f)}/${f.severity}`);
  assert.deepEqual(order, [
    "confirmed/critical", "confirmed/medium", "unconfirmed/low", "doubted/critical", "settled/critical",
  ], "a resolved critical sorts below an unconfirmed low — settledness outranks severity");
});

test("within a tier the oldest is first, so nothing waits unseen", () => {
  const older = { ...tiered("created", ["confirm"], "high"), createdAt: "2026-01-01T00:00:00Z" };
  const newer = { ...tiered("created", ["confirm"], "high"), createdAt: "2026-06-01T00:00:00Z" };
  assert.deepEqual([newer, older].sort(byReadingOrder).map((f) => f.createdAt), [older.createdAt, newer.createdAt]);
});

/**
 * Promoting a finding takes it OUT of the untriaged pile.
 *
 * `unconfirmed` is documented as "filed, and nobody has weighed in", and it is the tier
 * a reader is told to check for what still needs triage. Promotion is a person weighing
 * in — "this is real, the team should know" — so a promoted finding sitting in that pile
 * said the opposite of what had just happened, and hid it in the one list nobody is
 * meant to skim. Reported from the shared view: clicking promote left it in
 * `unconfirmed`.
 */
test("promoting a finding moves it out of the untriaged tier", () => {
  const base = { state: "issued" as FindingState, corroboration: [] } as unknown as SharedFinding;
  assert.equal(findingTier(base), "unconfirmed");

  const promoted = { ...base, promotion: { at: "2026-01-01T00:00:00Z", by: izzie } } as unknown as SharedFinding;
  assert.equal(findingTier(promoted), "confirmed", "a person said it is real");

  // A person promoting outranks an agent refuting — the corroboration is still on the
  // record and still rendered, but the tier follows the person.
  const alsoRefuted = {
    ...promoted,
    corroboration: [{ actor: opus, verdict: "refute", at: "2026-01-02T00:00:00Z", rationale: "r", independent: true }],
  } as unknown as SharedFinding;
  assert.equal(findingTier(alsoRefuted), "confirmed");

  // And closing still wins over both: a promoted finding that got fixed is settled.
  assert.equal(findingTier({ ...promoted, state: "resolved" } as unknown as SharedFinding), "settled");
});

// --- the history, and why a banner is not a record --------------------------------

/**
 * Rounds are real, and a single field lost them.
 *
 * `finding.outcome` was last-write-wins: on `Acme.API` PR 270 an eight-round
 * verification overwrote itself, leaving 37 of 59 reports unreachable — 53k characters
 * of investigation, including the verification that mattered, buried under a later
 * bookkeeping note. Measured in `docs/finding-event-shape-audit.md`.
 */
test("every report is kept, and the field still says where it got to", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, 264, opus, NEW);
    await recordOutcome(root, 264, opus, id, "answered", "round 1: confirmed at head aaa");
    await recordOutcome(root, 264, opus, id, "answered", "round 2: submitter says fixed");
    await recordOutcome(root, 264, opus, id, "fixed", "round 3: verified at head ccc");

    const f = await one(root);
    assert.deepEqual(f.outcomes?.map((o) => o!.detail), [
      "round 1: confirmed at head aaa",
      "round 2: submitter says fixed",
      "round 3: verified at head ccc",
    ], "oldest first, nothing overwritten");
    assert.equal(f.outcome?.detail, "round 3: verified at head ccc", "and the field is the latest");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * An ask is a banner, and a banner vanishes the moment somebody accepts it — taking the
 * REASON with it. A finding closed on an agent's recommendation kept no record of the
 * recommendation, so "why is this resolved" was answerable only from the raw log.
 */
test("accepting an ask keeps the reason it was asked for", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, 264, izzie, NEW);
    // The agent concludes; the gate turns it into an ask (izzie filed it).
    await setState(root, 264, opus, id, "refuted", "the guard is two lines up, at Startup.cs:88");
    const asked = await one(root);
    assert.equal(asked.pending?.ask, "refute");
    assert.equal(asked.asks?.length, 1);

    // Izzie accepts, saying nothing of her own.
    await setState(root, 264, izzie, id, "refuted");
    const done = await one(root);
    assert.equal(done.state, "refuted");
    assert.equal(done.pending, undefined, "the banner is gone");
    assert.equal(done.asks?.[0]?.settled?.as, "applied", "but the ask is settled, not erased");
    assert.equal(done.asks?.[0]?.rationale, "the guard is two lines up, at Startup.cs:88");
    assert.equal(done.closed?.reason, "the guard is two lines up, at Startup.cs:88",
      "and the close carries the reason it was granted for, rather than the bare state word");
    assert.equal(done.closed?.grantedAsk?.by.principal, "izzie@x.com");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** A person's own words win over the ask's when they give some. */
test("a person's own closing reason is not overwritten by the ask", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, 264, izzie, NEW);
    await setState(root, 264, opus, id, "refuted", "agent's reasoning");
    await setState(root, 264, izzie, id, "refuted", "I checked it myself");
    const f = await one(root);
    assert.equal(f.closed?.reason, "I checked it myself");
    assert.equal(f.closed?.grantedAsk?.rationale, "agent's reasoning", "and the ask is still attributed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** A second ask supersedes the first, and the first keeps its rationale. */
test("a superseded ask is settled, not lost", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, 264, izzie, NEW);
    await setState(root, 264, opus, id, "refuted", "first read: not reachable");
    await setState(root, 264, opus, id, "resolved", "second read: it was reachable, and is now fixed");
    const f = await one(root);
    assert.equal(f.asks?.length, 2);
    assert.equal(f.asks?.[0]?.settled?.as, "superseded");
    assert.equal(f.asks?.[0]?.rationale, "first read: not reachable");
    assert.equal(f.pending?.ask, "resolve", "and the open one is the latest");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * Declining an ask had no verb, so saying no left the badge and the queue entry standing.
 *
 * `pending` cleared only on the act it asked for; the web's "answer instead" posts a
 * comment, which touches neither. A finding nobody is waiting on that sits in
 * `waitingOnYou` indefinitely is how a queue stops being trusted. Found by a Fable 5
 * review of the agent-facing surface (#7).
 */
test("declining an ask clears the badge and the queue, and keeps the reason", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, 264, izzie, NEW);
    await setState(root, 264, opus, id, "refuted", "not reachable from the controller");
    assert.equal((await one(root)).pending?.ask, "refute");
    assert.equal(ackQueue([await one(root)]).length, 1, "and it IS in the queue while open");

    await declineAsk(root, 264, izzie, id, "it is reachable — see Startup.cs:88");
    const f = await one(root);
    assert.equal(f.pending, undefined, "the badge is gone");
    assert.equal(ackQueue([f]).length, 0, "and so is the queue entry");
    assert.equal(f.asks?.[0]?.settled?.as, "declined");
    assert.equal(f.asks?.[0]?.settled?.reason, "it is reachable — see Startup.cs:88");
    assert.equal(f.asks?.[0]?.rationale, "not reachable from the controller", "both sides of the disagreement survive");
    assert.equal(f.state, "created", "declining is not closing");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** An ask is a request to a person, so an agent cannot answer its own. */
test("an agent may not decline an ask", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, 264, izzie, NEW);
    await setState(root, 264, opus, id, "refuted", "not reachable");
    await declineAsk(root, 264, opus, id, "changed my mind");
    const f = await one(root);
    assert.equal(f.pending?.ask, "refute", "the fold ignores it — a write-time check only binds the honest writer");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** And a decline with no reason is not an answer. */
test("declining without a reason is dropped", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, 264, izzie, NEW);
    await setState(root, 264, opus, id, "refuted", "not reachable");
    await declineAsk(root, 264, izzie, id, "");
    assert.equal((await one(root)).pending?.ask, "refute");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
