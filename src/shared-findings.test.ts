import { test } from "node:test";
import { testEvent } from "./test-events.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor } from "./schema.js";
import { sortEvents, readScope, type LogEvent } from "./eventlog.js";
import {
  createFinding, corroborate, comment, promote, request, setState, recordOutcome,
  markPosted, markUpstreamed, promoteToBug, readFindings, foldFindings, findingScope,
  needsHumanAck, mayTransition, ackQueue, alreadyPosted, isClosed, findingTier, byReadingOrder,
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

test("an agent may NOT close a finding a person raised", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, 264, izzie, NEW);
    const r = await setState(root, 264, opus, id, "resolved") as { error: string };
    assert.match(r.error, /request it instead|only request/);
    assert.equal((await one(root)).state, "created", "and the state is untouched");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("once anything confirms it, an agent may no longer close it", async () => {
  const root = tmp();
  try {
    const id = await createFinding(root, 264, opus, NEW);
    await corroborate(root, 264, dana, id, "confirm", "reproduced");
    const r = await setState(root, 264, fable, id, "invalid") as { error: string };
    assert.match(r.error, /needs a person/);
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
  assert.equal(mayTransition(issued, opus, "resolved"), false, "not a terminal an agent may write");
  const created = { ...issued, state: "created" as FindingState };
  assert.equal(mayTransition(created, opus, "invalid"), false, "`created` is the floor");
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
