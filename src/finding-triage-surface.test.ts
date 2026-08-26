/**
 * The triage surface, as an agent actually reaches it.
 *
 * Every test here is a use-report from `docs/mcp-complaints.md`: an agent asked to
 * triage four findings on a pull request could not revise one, could not record a
 * re-rating anywhere filterable, and could not ask for the untriaged ones at all.
 * None of that was a missing capability — the fold has revised findings since it was
 * written — so what is checked here is REACHABILITY and the honesty of the refusals,
 * not the underlying operations, which have their own tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as shared from "./ops-shared.js";
import { reviseOn, closeFinding, reviewQueue, commentOn } from "./ops.js";
import { readFinding, writeLocalFinding, writeStore } from "./store.js";
import { indexBlob } from "./repo.js";
import type { State } from "./schema.js";
import type { SharedFinding } from "./shared-findings.js";
import { discard } from "./test-tmp.js";

const git = (root: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8" });

const tmp = (t: string) => mkdtempSync(join(tmpdir(), `codemap-fts-${t}-`));

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;

/**
 * A universe with an identity, a sidecar, and an anchor index — `reviewQueue` reads
 * the index to mark a target the tree no longer has, so an uninitialized store is not
 * a lighter fixture, it is a different error.
 */
async function universe() {
  const root = tmp("repo");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "izzie@x.com");
  git(root, "config", "user.name", "izzie");
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  const src = "export function transfer(cents: number) {\n  return cents;\n}\n";
  writeFileSync(join(root, "src/pay.ts"), src, "utf8");
  await writeStore(root, await indexBlob(src, "src/pay.ts"), state);
  const side = tmp("side");
  writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
  return { root, side, cleanup: () => [root, side].forEach((r) => discard(r)) };
}

const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]!; }
  try { await fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; } }
};

const NEW = { targetKind: "anchor" as const, targetId: "a_1", text: "evidence", comment: "the ask", severity: "high" as const };

/** As an agent — which is what decides a new finding opens at `issued`. */
const asAgent = (fn: () => Promise<void>) => withEnv({ CODEMAP_AGENT_MODEL: "claude-opus-5" }, fn);
/** The same, naming the model — `reviewerKey` treats a model as part of the reviewer. */
const withModel = (model: string, fn: () => Promise<unknown>) =>
  withEnv({ CODEMAP_AGENT_MODEL: model }, async () => { await fn(); });

const localFinding = (id: string, over: Partial<SharedFinding> = {}): SharedFinding => ({
  id, target: { kind: "anchor", id: "a_local" }, text: "filed here",
  author: { principal: "izzie@x.com" }, createdAt: "2026-01-01T00:00:00Z",
  state: "created", corroboration: [], thread: [], revisions: [], ...over,
});

// ---------------------------------------------------------------------------
// Complaint 1 & 2 — an agent could not revise a shared finding, and the error
// named the one store it had not asked about.
// ---------------------------------------------------------------------------

test("one revise verb reaches a TEAM finding, not only a local annotation", async () => {
  const u = await universe();
  try {
    await asAgent(async () => {
      const r = await shared.shareFinding(u.root, 269, NEW) as { id: string };
      assert.equal((await readFinding(u.root, r.id))!.state, "issued", "an agent files a proposal");

      const out = await reviseOn(u.root, {
        id: r.id, severity: "medium",
        comment: "The by-id branch has no tenant predicate — `pay.ts:12` queries on id alone.",
      });
      assert.ok(!out.error, `revise refused: ${out.error}`);

      const f = (await readFinding(u.root, r.id))!;
      assert.equal(f.severity, "medium", "the re-rate is on the RECORD, filterable");
      assert.match(f.comment!, /tenant predicate/);
      assert.equal(f.revisions.length, 1, "and the previous wording is kept");
      assert.equal(f.revisions[0]!.was.severity, "high");
    });
  } finally { u.cleanup(); }
});

test("an unknown id names every namespace it could have come from", async () => {
  const u = await universe();
  try {
    const out = await reviseOn(u.root, { id: "f_nope", comment: "x" });
    // The complaint: `no annotation "f_…"` answered about the one store the caller
    // had not asked about, and read as "that kind of id is not supported here".
    assert.match(String(out.error), /no finding or annotation "f_nope"/);
    assert.match(String(out.error), /shared_findings/);
  } finally { u.cleanup(); }
});

test("an agent may write up a person's raw finding — until somebody stands behind it", async () => {
  const u = await universe();
  try {
    // Filed by a PERSON, so it opens at `created`. This is the case the ratchet used to
    // refuse, and refusing it was backwards: a human's one-liner carries no severity, no
    // line and no remedy, and it is exactly what an agent that has just read the code is
    // there to supply. Keyed on filing state, the findings an agent could write up were
    // the ones an agent had already written.
    const r = await shared.shareFinding(u.root, 269, NEW) as { id: string };
    await asAgent(async () => {
      const ok = await reviseOn(u.root, { id: r.id, severity: "low", line: 42 });
      assert.ok(!ok.error, String(ok.error));
      assert.equal((await readFinding(u.root, r.id))!.severity, "low", "the write-up lands");
      assert.equal((await readFinding(u.root, r.id))!.line, 42);
    });

    // Now somebody stands behind it. THE GATE IS THE NUMBER, not the prose. What a
    // finding SAYS is the text that gets published and acted on, and an agent that has
    // just re-read the code is the one placed to correct it — leaving a wrong summary
    // standing with a note below it is worse for the reader, and `revisions` keeps the
    // old wording regardless. What it is WORTH is somebody's judgement and stays theirs.
    await shared.corroborateFinding(u.root, 269, r.id, "confirm", "read it, it is real");
    await asAgent(async () => {
      const words = await reviseOn(u.root, { id: r.id, comment: "sharper submitter-facing version" });
      assert.ok(!words.error, String(words.error));
      assert.equal((await readFinding(u.root, r.id))!.comment, "sharper submitter-facing version",
        "the description is replaced, not appended to");

      const rate = await reviseOn(u.root, { id: r.id, severity: "critical" });
      assert.match(String(rate.error), /confirmed the finding/);
      assert.match(String(rate.error), /description/, "and it names what the agent CAN still rewrite");
      assert.equal((await readFinding(u.root, r.id))!.severity, "low", "the number did not move");
    });
  } finally { u.cleanup(); }
});

test("an agent closes what nobody has confirmed, and only asks once somebody has", async () => {
  const u = await universe();
  try {
    // AGENT-filed, so nobody has stood behind it in either sense.
    let open!: { id: string };
    await asAgent(async () => { open = await shared.shareFinding(u.root, 269, NEW) as { id: string }; });
    const held = await shared.shareFinding(u.root, 269, { ...NEW, text: "second" }) as { id: string };
    await shared.corroborateFinding(u.root, 269, held.id, "confirm", "real");
    // Filed by a PERSON and unconfirmed: not an agent's to retire either, so it asks.
    const theirs = await shared.shareFinding(u.root, 269, { ...NEW, text: "third" }) as { id: string };

    await asAgent(async () => {
      // Triage. A queue of unconfirmed false positives that only a person may clear is a
      // queue nobody clears, so refuting its OWN unstood-behind finding straight to the
      // closed section is the agent's job — the half the gate was never meant to cover.
      const a = await shared.closeFinding(u.root, 269, open.id, "refuted", "the guard is two lines up");
      assert.ok(!("error" in a), JSON.stringify(a));
      assert.equal((await readFinding(u.root, open.id))!.state, "refuted");

      const t = await shared.closeFinding(u.root, 269, theirs.id, "refuted", "not reachable") as { asked?: string };
      assert.equal(t.asked, "refute", "a person's own report is not an agent's to retire");
      assert.equal((await readFinding(u.root, theirs.id))!.state, "created", "it stays open, with the ask on it");

      // ASKED, not refused: the conclusion is recorded where a person can approve it from
      // the row, instead of being turned away and written into a thread comment.
      const b = await shared.closeFinding(u.root, 269, held.id, "refuted", "same") as { error?: string; asked?: string };
      assert.equal(b.error, undefined);
      assert.equal(b.asked, "refute");
      const heldNow = (await readFinding(u.root, held.id))!;
      assert.equal(heldNow.state, "created", "confirmed findings keep their person-gate");
      assert.equal(heldNow.pending?.ask, "refute", "and the badge reads `refuted pending`");
      assert.equal(heldNow.pending?.rationale, "same");

      // And `resolved` claims the CODE was fixed, which is never an agent's to write —
      // it asks even on a finding the agent filed itself and nobody has confirmed.
      const c = await shared.closeFinding(u.root, 269, open.id, "resolved", "fixed") as { asked?: string };
      assert.equal(c.asked, "resolve", "an agent does not get to declare a defect fixed");
    });
  } finally { u.cleanup(); }
});

test("a local finding revises through the same verb, with the same trail", async () => {
  const u = await universe();
  try {
    await writeLocalFinding(u.root, localFinding("f_local", { severity: "high", comment: "as filed" }), 269);
    const out = await reviseOn(u.root, { id: "f_local", severity: "low", comment: "The retry loop drops the last batch." });
    assert.ok(!out.error, String(out.error));
    const f = (await readFinding(u.root, "f_local"))!;
    assert.equal(f.severity, "low");
    assert.equal(f.revisions.length, 1);
    assert.equal(f.revisions[0]!.was.comment, "as filed");
  } finally { u.cleanup(); }
});

test("a finding already on the pull request refuses the edit that would diverge from it", async () => {
  const u = await universe();
  try {
    await asAgent(async () => {
      const r = await shared.shareFinding(u.root, 269, NEW) as { id: string };
      await shared.recordPublished(u.root, 269, r.id, { url: "https://github.com/a/b/pull/269#discussion_r1" });
      const out = await reviseOn(u.root, { id: r.id, comment: "Different wording entirely." });
      assert.match(String(out.error), /already on PR 269/);
      assert.match(String(out.error), /allowPostEdit/, "and says how to override it deliberately");
    });
  } finally { u.cleanup(); }
});

test("a field the shared fold cannot record is named, not dropped", async () => {
  const u = await universe();
  try {
    await asAgent(async () => {
      const r = await shared.shareFinding(u.root, 269, NEW) as { id: string };
      // `finding.revised` folds text/comment/severity/category/sourceRef/line. A
      // re-witness is not among them, and it is the ONE route past the written-
      // against-a-different-body gate — an agent that thinks it ran stops looking.
      const out = await reviseOn(u.root, { id: r.id, severity: "low", ref: "HEAD", publishPath: "src/pay.ts" });
      assert.ok(!out.error, String(out.error));
      assert.match(String(out.note), /ref is not recorded/);
      assert.match(String(out.note), /publishPath is a local publishing field/);
      assert.equal((await readFinding(u.root, r.id))!.severity, "low", "and what it COULD record still landed");
    });
  } finally { u.cleanup(); }
});

// ---------------------------------------------------------------------------
// Complaint 3 — reporting back dropped the structured verdict, so a re-rate
// survived only as prose in `detail`.
// ---------------------------------------------------------------------------

test("reporting back puts the corrected comment and severity on the record, not in prose", async () => {
  const u = await universe();
  try {
    await asAgent(async () => {
      const r = await shared.shareFinding(u.root, 269, NEW) as { id: string };
      const out = await closeFinding(u.root, {
        id: r.id, result: "answered", detail: "traced both branches; the write side is guarded",
        severity: "medium", line: 88,
        comment: "The by-id branch has no tenant predicate — `pay.ts:12` queries on id alone.",
      });
      assert.ok(!out.error, String(out.error));

      const f = (await readFinding(u.root, r.id))!;
      assert.ok(f.outcome, "the outcome is still recorded");
      assert.equal(f.severity, "medium", "and the re-rate is a FIELD — the complaint was that it stayed `high`");
      assert.equal(f.line, 88);
      assert.match(f.comment!, /tenant predicate/);
    });
  } finally { u.cleanup(); }
});

test("a report whose re-rate the ratchet refuses says so rather than reporting success", async () => {
  const u = await universe();
  try {
    const r = await shared.shareFinding(u.root, 269, NEW) as { id: string };
    await shared.corroborateFinding(u.root, 269, r.id, "confirm", "somebody stood behind it");
    await asAgent(async () => {
      const out = await closeFinding(u.root, {
        id: r.id, result: "answered", detail: "looked into it", severity: "low",
      });
      assert.ok(!out.error, "the outcome itself is recorded — that part an agent may do");
      assert.match(String(out.note), /NOT changed/);
      assert.equal((await readFinding(u.root, r.id))!.severity, "high");
      assert.ok((await readFinding(u.root, r.id))!.outcome, "and the report survived the refusal");
    });
  } finally { u.cleanup(); }
});

test("reporting back needs no assignment — the ordinary path never creates one", async () => {
  const u = await universe();
  try {
    // report_defect -> publish -> the submitter fixes it -> report back. There is no
    // assignment step anywhere in that, so requiring one refused the case `close_finding`
    // names in its own description, for a reason no caller could satisfy.
    await writeLocalFinding(u.root, localFinding("f_mine", { severity: "high" }), 269);
    await asAgent(async () => {
      const out = await closeFinding(u.root, {
        id: "f_mine", result: "answered", detail: "verified fixed upstream in 6965b31f",
      });
      assert.ok(!out.error, String(out.error));
      assert.equal((await readFinding(u.root, "f_mine"))!.outcome!.result, "answered");
    });
  } finally { u.cleanup(); }
});

// ---------------------------------------------------------------------------
// Complaint 4 — the queue excludes exactly what needs triage.
// ---------------------------------------------------------------------------

test("the untriaged are askable, which the human queue can never show", async () => {
  const u = await universe();
  try {
    await asAgent(async () => {
      const untouched = await shared.shareFinding(u.root, 269, NEW) as { id: string };
      const looked = await shared.shareFinding(u.root, 269, { ...NEW, text: "second" }) as { id: string };
      await shared.corroborateFinding(u.root, 269, looked.id, "confirm", "read it");

      const q = await shared.sharedFindings(u.root, 269, { queue: true }) as { findings: { id: string }[] };
      assert.deepEqual(q.findings.map((f) => f.id), [looked.id],
        "confirming is what PUTS a finding in the queue — so the queue cannot answer `what is untriaged`");

      const t = await shared.sharedFindings(u.root, 269, { tier: "unconfirmed" }) as
        { findings: { id: string }[]; tiers: Record<string, number> };
      assert.deepEqual(t.findings.map((f) => f.id), [untouched.id]);
      assert.equal(t.tiers.unconfirmed, 1, "and the counts are on every answer, not only the filtered one");
      assert.equal(t.tiers.confirmed, 1);
    });
  } finally { u.cleanup(); }
});

// ---------------------------------------------------------------------------
// Complaint 5 — two vocabularies for one axis, and no way to ask about one PR.
// ---------------------------------------------------------------------------

test("`findings` answers about ONE pull request, in either vocabulary", async () => {
  const u = await universe();
  try {
    await writeLocalFinding(u.root, localFinding("f_269a"), 269);
    await writeLocalFinding(u.root, localFinding("f_269b", { corroboration: [
      { actor: { principal: "dana@x.com" }, verdict: "confirm", at: "2026-01-02T00:00:00Z", rationale: "read it", independent: true },
    ] }), 269);
    await writeLocalFinding(u.root, localFinding("f_271a"), 271);

    const ids = async (opts: Record<string, unknown>) =>
      ((await reviewQueue(u.root, { assignedOnly: false, brief: true, ...opts }) as
        { queue: { id: string }[] }).queue).map((q) => q.id).sort();

    assert.deepEqual(await ids({}), ["f_269a", "f_269b", "f_271a"]);
    assert.deepEqual(await ids({ pr: "269" }), ["f_269a", "f_269b"], "one pull request, from the STORED pr");
    // The complaint: `disposition` and `tier` name one axis, so either word has to
    // select the same rows — otherwise the answer depends on which list you came from.
    assert.deepEqual(await ids({ pr: "269", tier: "unconfirmed" }), ["f_269a"]);
    assert.deepEqual(await ids({ pr: "269", disposition: "open" }), ["f_269a"]);
    assert.deepEqual(await ids({ pr: "269", tier: "confirmed" }), ["f_269b"]);
  } finally { u.cleanup(); }
});

test("every finding row carries the tier, so one word reads both lists", async () => {
  const u = await universe();
  try {
    await writeLocalFinding(u.root, localFinding("f_1", { state: "invalid" }), 269);
    const q = await reviewQueue(u.root, { assignedOnly: false, brief: true, includeResolved: true }) as
      { queue: { id: string; tier?: string; disposition?: string }[] };
    const row = q.queue.find((r) => r.id === "f_1")!;
    // `invalid` flattens to disposition `open` — the tier is taken from the record
    // BEFORE that flattening, which is the whole reason it is not derived from it.
    assert.equal(row.tier, "settled");
    assert.equal(row.disposition, "open");
  } finally { u.cleanup(); }
});

// ---------------------------------------------------------------------------
// `withdraw`: the ask that is not a verdict
// ---------------------------------------------------------------------------

test("a true-but-duplicate finding can be retired without calling it false", async () => {
  const u = await universe();
  try {
    const r = await shared.shareFinding(u.root, 269, NEW) as { id: string };
    await asAgent(async () => {
      const { requestHuman } = await import("./ops.js");
      const out = await requestHuman(u.root, {
        id: r.id, action: "withdraw",
        rationale: "the claim is TRUE and confirmed; f_other covers the same defect on the same anchor",
      }) as Record<string, unknown>;
      assert.ok(!out.error, String(out.error));

      // It reaches the person's queue as `withdraw`. The fold guard is the half that
      // matters: a word added to the type but not to the guard is an event every reader
      // silently drops, and the request would vanish rather than fail.
      const f = (await shared.sharedFindings(u.root, 269) as { findings: { id: string; pending?: { ask: string } }[] })
        .findings.find((x) => x.id === r.id)!;
      assert.equal(f.pending?.ask, "withdraw");
    });
    // And it is still an ASK — an agent may not retire the record itself, which is the
    // gate that stops a confirmed finding being lost by one wrong call.
    assert.notEqual((await readFinding(u.root, r.id))!.state, "withdrawn");
  } finally { u.cleanup(); }
});

test("every ask a writer can emit is one the fold accepts", async () => {
  const { ASKS, isAsk } = await import("./shared-findings.js");
  // The two folds spelled this list out separately and drifted is the failure mode:
  // `withdraw` in the enum and absent from a guard reads as "accepted, then ignored".
  for (const a of ASKS) assert.ok(isAsk(a), `${a} is emittable but not foldable`);
  assert.ok(!isAsk("retire"), "and the guard is a guard, not a pass-through");
} );

// ---------------------------------------------------------------------------
// Complaint §6 — "was real, and has been fixed" had no word, so people wrote
// `refuted` and turned real defects into false positives.
// ---------------------------------------------------------------------------

test("a confirmed finding the submitter fixed can say so — without being called false", async () => {
  const u = await universe();
  try {
    const r = await shared.shareFinding(u.root, 269, NEW) as { id: string };
    await shared.corroborateFinding(u.root, 269, r.id, "confirm", "read it, it is real");

    await asAgent(async () => {
      // THE CASE. The finding is confirmed, so revising it is gated — and this is not a
      // revision. Recording what happened to the code adds a fact and rewrites nobody's
      // claim, so it goes through whatever the gate says.
      const { recordRemediation } = await import("./ops.js");
      const out = await recordRemediation(u.root, r.id, "fixed-on-branch", {
        detail: "fixed in 6965b31f; verified in the diff", ref: "6965b31f",
      });
      assert.ok(!out.error, String(out.error));
    });

    const f = (await readFinding(u.root, r.id))!;
    assert.equal(f.remediation!.state, "fixed-on-branch");
    assert.equal(f.remediation!.ref, "6965b31f", "the ref is what makes it checkable rather than asserted");
    // The two axes stay orthogonal, which is the whole point: the claim is still TRUE.
    assert.equal(f.state, "created", "recording a fix is not closing it");
    assert.ok(f.corroboration.some((c) => c.verdict === "confirm"), "and it is still confirmed, not refuted");
  } finally { u.cleanup(); }
});

test("the two axes are separately filterable — confirmed-and-outstanding is not confirmed-and-fixed", async () => {
  const u = await universe();
  try {
    const done = await shared.shareFinding(u.root, 269, NEW) as { id: string };
    const open = await shared.shareFinding(u.root, 269, { ...NEW, text: "still broken" }) as { id: string };
    for (const id of [done.id, open.id]) await shared.corroborateFinding(u.root, 269, id, "confirm", "real");
    const { recordRemediation } = await import("./ops.js");
    await recordRemediation(u.root, done.id, "fixed-on-default", { detail: "merged" });

    const all = await shared.sharedFindings(u.root, 269, { tier: "confirmed" }) as { findings: { id: string }[] };
    assert.equal(all.findings.length, 2, "both are confirmed — which is exactly what tier cannot separate");

    const left = await shared.sharedFindings(u.root, 269, { tier: "confirmed", remediation: "outstanding" }) as
      { findings: { id: string; remediation: string }[] };
    assert.deepEqual(left.findings.map((f) => f.id), [open.id], "what still needs doing, in one query");
    assert.equal(left.findings[0]!.remediation, "outstanding", "unset reads as outstanding — the same fact");

    const fixed = await shared.sharedFindings(u.root, 269, { remediation: "fixed-on-default" }) as { findings: { id: string }[] };
    assert.deepEqual(fixed.findings.map((f) => f.id), [done.id]);
  } finally { u.cleanup(); }
});

test("`findings` carries the same axis, so neither list needs the other's vocabulary", async () => {
  const u = await universe();
  try {
    await writeLocalFinding(u.root, localFinding("f_fixed"), 269);
    await writeLocalFinding(u.root, localFinding("f_open"), 269);
    const { recordRemediation } = await import("./ops.js");
    await recordRemediation(u.root, "f_fixed", "fixed-on-branch", { detail: "on the branch only" });

    const ids = async (opts: Record<string, unknown>) =>
      ((await reviewQueue(u.root, { assignedOnly: false, brief: true, ...opts }) as
        { queue: { id: string }[] }).queue).map((q) => q.id).sort();
    assert.deepEqual(await ids({ pr: "269", remediation: "fixed-on-branch" }), ["f_fixed"]);
    // The distinction that was previously a sentence somebody had to read: the mainline
    // still carries this defect, so a linked bug must NOT be closed.
    assert.deepEqual(await ids({ pr: "269", remediation: "fixed-on-default" }), []);
    assert.deepEqual(await ids({ pr: "269", remediation: "outstanding" }), ["f_open"]);
  } finally { u.cleanup(); }
});

// ---------------------------------------------------------------------------
// The shared page lists this store's own findings too, so its buttons have to
// work on them. `resolve` answered `no finding finding_… on pr <scope>`.
// ---------------------------------------------------------------------------

test("every lifecycle act works on a finding the fold does not own", async () => {
  const u = await universe();
  try {
    const { setFindingState, promoteOn, corroborateOn, requestHuman, commentOn } = await import("./ops.js");
    await writeLocalFinding(u.root, localFinding("f_local", { state: "issued" }), 264);

    // Each of these used to be sent to the LOG, which has never heard of a local row —
    // so the error named the one place the finding could not be. On the real store every
    // row of PR 264 was local, so this was every button on the page.
    const ok = (r: unknown) => assert.ok(!(r as { error?: string }).error, String((r as { error?: string }).error));
    ok(await commentOn(u.root, { id: "f_local", body: "looked at it" }));
    ok(await corroborateOn(u.root, { id: "f_local", verdict: "confirm", rationale: "read the code" }));
    ok(await promoteOn(u.root, "f_local"));
    ok(await requestHuman(u.root, { id: "f_local", action: "resolve", rationale: "fixed upstream" }));

    const f = (await readFinding(u.root, "f_local"))!;
    assert.equal(f.thread.length, 1);
    assert.equal(f.corroboration.length, 1);
    assert.ok(f.promotion);
    assert.equal(f.pending!.ask, "resolve");

    // And the ratchet is the SAME rule: this one is confirmed now, so an agent's close
    // becomes an ASK — being local does not buy an agent a weaker gate, nor a different
    // answer from the shared path.
    await asAgent(async () => {
      const no = await setFindingState(u.root, { id: "f_local", state: "resolved", reason: "done" }) as { asked?: string; note?: string };
      assert.equal(no.asked, "resolve");
      assert.match(String(no.note), /pending/);
      assert.equal((await readFinding(u.root, "f_local"))!.state, "issued", "and nothing moved");
    });
    const yes = await setFindingState(u.root, { id: "f_local", state: "resolved", reason: "closed from the shared view" });
    assert.ok(!yes.error, String(yes.error));
    const done = (await readFinding(u.root, "f_local"))!;
    assert.equal(done.state, "resolved");
    assert.equal(done.closed!.reason, "closed from the shared view");
    assert.equal(done.pending, undefined, "the ask is answered by the act it asked for");
  } finally { u.cleanup(); }
});

/**
 * `close_finding` is named for closing and, until now, could not close.
 *
 * There was no MCP tool that set a finding's state at all — `setFindingState` was
 * reachable only from a web POST — and the description promised the pending-ask
 * conversion anyway. An agent following it passed a `state` the schema did not declare,
 * `violates()` validates enums and not unknown keys, so the field was dropped silently
 * and the call returned `ok: true` having queued nothing. That is the zero-`request_human`
 * failure the ask conversion exists to end, recreated by its own documentation.
 *
 * Found by a Fable 5 review of the agent-facing surface.
 */
test("close_finding can actually close, and the ask conversion is reachable from it", async () => {
  const u = await universe();
  try {
    // The schema has to DECLARE it, or an agent reading the description sends a field the
    // server drops on the floor. Asserted against the SOURCE, the way `ops-reach.test.ts`
    // does — `mcp.ts` exports no tool table, and the declaration is what matters.
    const { readFileSync } = await import("node:fs");
    const mcp = readFileSync("src/mcp.ts", "utf8");
    const close = mcp.slice(mcp.indexOf('name: "close_finding"'));
    const schema = close.slice(close.indexOf("inputSchema"), close.indexOf("mutates:"));
    assert.match(schema, /\bstate:\s*\{/, "`state` is declared, so it survives validation");
    assert.match(schema, /"refuted"/, "and its enum carries the closing states");

    // Agent-filed and unconfirmed: it just happens.
    let mine!: { id: string };
    await asAgent(async () => { mine = await shared.shareFinding(u.root, 269, NEW) as { id: string }; });
    await asAgent(async () => {
      const r = await closeFinding(u.root, { id: mine.id, result: "answered", detail: "not reachable", state: "refuted" }) as
        { ok?: boolean; state?: string; applied?: string[] };
      assert.equal(r.state, "refuted");
      assert.ok(r.applied?.includes("state"));
    });
    assert.equal((await readFinding(u.root, mine.id))!.state, "refuted");

    // Person-filed: the same call becomes an ask, carrying `detail` as the reason.
    const theirs = await shared.shareFinding(u.root, 269, { ...NEW, text: "theirs" }) as { id: string };
    await asAgent(async () => {
      const r = await closeFinding(u.root, { id: theirs.id, result: "fixed", detail: "fixed at head abc123", state: "resolved" }) as
        { asked?: string; applied?: string[] };
      assert.equal(r.asked, "resolve", "recorded as an ask, not dropped");
      assert.ok(r.applied?.includes("ask"));
    });
    const t = (await readFinding(u.root, theirs.id))!;
    assert.equal(t.state, "created", "nothing moved");
    assert.equal(t.pending?.ask, "resolve");
    assert.equal(t.pending?.rationale, "fixed at head abc123");
    assert.equal(t.remediation?.state, "fixed-on-branch", "and `fixed` set the remediation for free");
  } finally { u.cleanup(); }
});

/**
 * A rejected comment must not land half a call.
 *
 * `checkComment` ran AFTER the outcome, corroboration and remediation were written, so a
 * verdict-lead comment returned a bare error over three events that had already
 * happened — and the natural response to an error is to retry, which re-emits
 * `finding.outcome`. The tool's own response shape drove the duplication the audit
 * measured on PR 270.
 */
test("a refused comment is refused before anything is written", async () => {
  const u = await universe();
  try {
    const f = await shared.shareFinding(u.root, 269, NEW) as { id: string };
    const before = (await readFinding(u.root, f.id))!;
    await asAgent(async () => {
      const r = await closeFinding(u.root, {
        id: f.id, result: "fixed", detail: "d",
        comment: "CONFIRMED — the by-id branch has no tenant predicate",
      }) as { error?: string };
      assert.ok(r.error, "refused");
    });
    const after = (await readFinding(u.root, f.id))!;
    assert.equal(after.outcomes?.length ?? 0, before.outcomes?.length ?? 0, "no outcome was recorded");
    assert.equal(after.remediation, before.remediation, "and no remediation");
  } finally { u.cleanup(); }
});

/**
 * The local branch had none of the guarantees the descriptions promise unconditionally.
 *
 * "Local" is not an edge case: it is every finding before `unify-findings`/`sync`, and
 * everything on a machine with no sidecar. Reported by a Fable 5 review of the surface.
 */
test("a local finding gets the same envelope and the same severity gate", async () => {
  const u = await universe();
  try {
    const { writeLocalFinding } = await import("./store.js");
    const base = {
      id: "f_loc2", target: { kind: "anchor" as const, id: "a_1" }, text: "t", comment: "c",
      severity: "high" as const, author: { principal: "izzie@x.com" }, createdAt: "2026-01-01T00:00:00Z",
      state: "created" as const, corroboration: [], thread: [], revisions: [], outcomes: [], asks: [],
    };
    await writeLocalFinding(u.root, base as never, 269);

    // Unconfirmed: the write-up lands, envelope included.
    await asAgent(async () => {
      const r = await closeFinding(u.root, { id: "f_loc2", result: "answered", detail: "read it", severity: "low" }) as
        { ok?: boolean; applied?: string[]; refused?: unknown[] };
      assert.equal(r.ok, true);
      assert.ok(r.applied?.includes("severity"), `applied: ${JSON.stringify(r.applied)}`);
      assert.equal(r.refused, undefined);
    });
    assert.equal((await readFinding(u.root, "f_loc2"))!.severity, "low");

    // Now somebody stands behind it — and the gate is the SAME one, not absent.
    await shared.corroborateFinding(u.root, 269, "f_loc2", "confirm", "real").catch(() => null);
    const withConfirm = (await readFinding(u.root, "f_loc2"))!;
    withConfirm.corroboration = [{ actor: { principal: "dana@x.com" }, verdict: "confirm", at: "2026-01-02T00:00:00Z", rationale: "r", independent: true } as never];
    await writeLocalFinding(u.root, withConfirm, 269);

    await asAgent(async () => {
      const r = await closeFinding(u.root, { id: "f_loc2", result: "answered", detail: "again", severity: "critical" }) as
        { ok?: boolean; refused?: { field: string }[] };
      assert.equal(r.ok, false, "`ok` is false when a field was refused — it is not a 'the call happened' flag");
      assert.deepEqual(r.refused?.map((x) => x.field), ["severity"]);
    });
    assert.equal((await readFinding(u.root, "f_loc2"))!.severity, "low", "the number a person stood behind did not move");
  } finally { u.cleanup(); }
});

/** And `result:"fixed"` sets the remediation on this branch too — the §8 trap. */
test("a local finding reported fixed is not left counted as open", async () => {
  const u = await universe();
  try {
    const { writeLocalFinding } = await import("./store.js");
    await writeLocalFinding(u.root, {
      id: "f_loc3", target: { kind: "anchor" as const, id: "a_1" }, text: "t", comment: "c",
      author: { principal: "izzie@x.com" }, createdAt: "2026-01-01T00:00:00Z",
      state: "created" as const, corroboration: [], thread: [], revisions: [], outcomes: [], asks: [],
    } as never, 269);
    await asAgent(async () => {
      await closeFinding(u.root, { id: "f_loc3", result: "fixed", detail: "fixed at head abc", files: ["a.cs"] });
    });
    assert.equal((await readFinding(u.root, "f_loc3"))!.remediation?.state, "fixed-on-branch");
  } finally { u.cleanup(); }
});

/** A closed finding an agent finds live again has a word for it now. */
test("an agent asks to REOPEN rather than writing it in the thread", async () => {
  const u = await universe();
  try {
    let mine!: { id: string };
    await asAgent(async () => { mine = await shared.shareFinding(u.root, 269, NEW) as { id: string }; });
    await asAgent(async () => { await closeFinding(u.root, { id: mine.id, result: "answered", detail: "not real", state: "refuted" }); });
    assert.equal((await readFinding(u.root, mine.id))!.state, "refuted");

    await asAgent(async () => {
      const r = await closeFinding(u.root, {
        id: mine.id, result: "answered", detail: "the submitter force-pushed the guard away; it is live again",
        state: "created",
      }) as { asked?: string };
      assert.equal(r.asked, "reopen", "reopening is a person's, and now it is sayable");
    });
    const f = (await readFinding(u.root, mine.id))!;
    assert.equal(f.state, "refuted", "still closed until a person acts");
    assert.equal(f.pending?.ask, "reopen");
    assert.match(f.pending!.rationale, /force-pushed/);
  } finally { u.cleanup(); }
});

/**
 * One rule for recording a verdict, whichever local writer runs.
 *
 * Three writers did it three ways: `closeLocalFinding` appended without dedupe (so a
 * multi-round verification stacked duplicate confirms and inflated the counts a reader
 * triages by), `reviseLocalFinding` deduped by PRINCIPAL — clobbering the same person's
 * other model's verdict, the precise thing `reviewerKey` exists to prevent — and only
 * `corroborateLocalFinding` matched the fold. Two also hardcoded `independent: false`.
 * Found by a Fable 5 review (§9).
 */
test("a local verdict is recorded per REVIEWER, whichever verb records it", async () => {
  const u = await universe();
  try {
    const { writeLocalFinding } = await import("./store.js");
    const { corroborateLocalFinding } = await import("./ops/annotations.js");
    await writeLocalFinding(u.root, {
      id: "f_v1", target: { kind: "anchor" as const, id: "a_1" }, text: "t", comment: "c",
      author: { principal: "dana@x.com" }, createdAt: "2026-01-01T00:00:00Z",
      state: "created" as const, corroboration: [], thread: [], revisions: [], outcomes: [], asks: [],
    } as never, 269);

    // The same principal, two models: two opinions, never collapsed.
    await withModel("claude-opus-5", () => corroborateLocalFinding(u.root, "f_v1", "confirm", "opus read it"));
    await withModel("claude-sonnet-5", () => corroborateLocalFinding(u.root, "f_v1", "refute", "sonnet disagrees"));
    let f = (await readFinding(u.root, "f_v1"))!;
    assert.equal(f.corroboration.length, 2, "one entry per reviewer, and a model is part of the reviewer");

    // `close_finding` re-verifying: replaces ITS OWN, does not stack a duplicate.
    await withModel("claude-opus-5", () => closeFinding(u.root, {
      id: "f_v1", result: "answered", detail: "opus, round 2", disposition: "confirmed" as never,
    }));
    f = (await readFinding(u.root, "f_v1"))!;
    assert.equal(f.corroboration.length, 2, "still two — a re-review is not a second reviewer");
    const opus = f.corroboration.find((c) => c.actor.via?.model === "claude-opus-5")!;
    assert.equal(opus.rationale, "opus, round 2", "its own entry moved");
    assert.equal(opus.independent, true, "and independence is COMPUTED — dana filed it, izzie's agent confirmed it");
  } finally { u.cleanup(); }
});

/**
 * An annotation has no remediation axis, so passing one did nothing and said nothing —
 * the §8 trap on a third path. A caller that says a defect is fixed must not be told
 * that landed when it did not.
 */
test("remediation on an annotation-backed finding is refused, not dropped", async () => {
  const u = await universe();
  try {
    const { writeAnnotations } = await import("./store.js");
    await writeAnnotations(u.root, [{
      id: "n_assigned", kind: "finding", target: { kind: "anchor", id: "a_1" },
      text: "t", comment: "c", author: "izzie", createdCommit: null, resolved: false, revisions: [],
      assignment: { kind: "investigate", by: "izzie", at: "2026-01-01T00:00:00Z" },
    } as never]);
    const { closeAssignment } = await import("./ops/annotations.js");
    const r = await closeAssignment(u.root, {
      id: "n_assigned", result: "fixed", detail: "fixed at head abc", remediation: "fixed-on-branch",
    } as never) as { ok?: boolean; applied?: string[]; refused?: { field: string }[] };
    assert.equal(r.ok, false, "it did not do everything it was asked");
    assert.deepEqual(r.refused?.map((x) => x.field), ["remediation"]);
    assert.ok(r.applied?.includes("outcome"), "and it says what DID land");
  } finally { u.cleanup(); }
});

// --- a verdict is a claim about CODE, and now it says which ------------------------

/**
 * The guard for the failure that inverted five verdicts on `Acme.React`.
 *
 * A triage pass re-read every finding against whatever `@work` pointed at — `document-ui`,
 * a branch that PREDATED the pull request under review — and refuted five findings for
 * being "not present". They merged to main the next day; one refutation reads exactly
 * inverted from what the code says. `sourceRef` recorded the discrepancy faithfully and
 * nothing looked at it.
 *
 * The test is local: the finding was witnessed at `sourceRef`, so a checkout that does
 * not CONTAIN that commit is missing the code the finding is about.
 */
test("a verdict formed on a tree that lacks the finding's code is refused", async () => {
  const u = await universe();
  try {
    // Two commits, then a checkout rolled back to the FIRST — the shape `document-ui`
    // was in: a tree that predates the code the finding is about.
    const g = (...a: string[]) => spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=t", ...a], { cwd: u.root, encoding: "utf8" });
    g("add", "-A"); g("commit", "-q", "-m", "base");
    writeFileSync(join(u.root, "later.txt"), "the code the finding is about\n", "utf8");
    g("add", "-A"); g("commit", "-q", "-m", "the commit the finding was written against");
    const later = g("rev-parse", "HEAD").stdout.trim();

    const f = await shared.shareFinding(u.root, 269, { ...NEW, sourceRef: later } as never) as { id: string };
    g("checkout", "-q", "HEAD~1");

    const r = await shared.corroborateFinding(u.root, 269, f.id, "refute", "not present in this tree") as { error?: string };
    assert.match(String(r.error), /does not contain/);
    assert.match(String(r.error), /different tree/, "and it says what went wrong, not just that it refused");
    assert.match(String(r.error), /anyway/, "and names the override");

    // The override exists for the reviewer who read the right code another way.
    const ok = await shared.corroborateFinding(u.root, 269, f.id, "refute", "read it at its own ref", { anyway: true }) as { error?: string };
    assert.equal(ok.error, undefined);
  } finally { u.cleanup(); }
});

/**
 * And a verdict that CANNOT be grounded says so rather than passing silently.
 *
 * 29 of 43 records on that universe carried no `sourceRef` at all, which is why the
 * error was invisible: there was nothing to check and nothing saying so.
 */
test("a verdict on a finding with no witness ref is recorded, and reported as ungrounded", async () => {
  const u = await universe();
  try {
    const f = await shared.shareFinding(u.root, 269, NEW) as { id: string };
    const r = await shared.corroborateFinding(u.root, 269, f.id, "confirm", "read it") as
      { error?: string; grounded?: boolean; note?: string };
    assert.equal(r.error, undefined, "absence of evidence is not evidence — it is not refused");
    assert.equal(r.grounded, false);
    assert.match(String(r.note), /records no ref/);
  } finally { u.cleanup(); }
});

/** Every verdict now stamps the commit it was formed on — the field whose absence hid this. */
test("a verdict records the commit it was formed on", async () => {
  const u = await universe();
  try {
    const g = (...a: string[]) => spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=t", ...a], { cwd: u.root, encoding: "utf8" });
    g("add", "-A"); g("commit", "-q", "-m", "base");
    const head = g("rev-parse", "HEAD").stdout.trim();
    const f = await shared.shareFinding(u.root, 269, NEW) as { id: string };
    await shared.corroborateFinding(u.root, 269, f.id, "confirm", "read it");
    const row = (await readFinding(u.root, f.id))!;
    assert.equal(row.corroboration[0]!.ref, head, "the reviewer's own head, on the record");
  } finally { u.cleanup(); }
});

/**
 * A truncated id says "does not exist" about a record that does.
 *
 * Findings render as `f_00mt8zvn7m-cc017f2546` and the prefix is the natural thing to
 * copy — it is the distinctive half and the suffix looks like a checksum. The refusal
 * asserted the record was not there. It was; the id was half of one. Cost an agent four
 * failed calls (`docs/mcp-complaints.md` § workflow-issues §3).
 */
test("a truncated finding id is answered with the whole one", async () => {
  const u = await universe();
  try {
    const f = await shared.shareFinding(u.root, 269, NEW) as { id: string };
    const half = f.id.slice(0, f.id.indexOf("-"));
    assert.notEqual(half, f.id, "the fixture really is a prefix");

    const r = await commentOn(u.root, { id: half, body: "x" }) as { error: string };
    assert.match(r.error, /did you mean/);
    assert.ok(r.error.includes(f.id), "and it names the id in full, so it can be copied");
  } finally { u.cleanup(); }
});

/** An ambiguous prefix must not resolve to one — it says which ones it is the start of. */
test("a prefix matching several says so rather than picking", async () => {
  const u = await universe();
  try {
    const { writeLocalFinding } = await import("./store.js");
    const base = {
      target: { kind: "anchor" as const, id: "a_1" }, text: "t", comment: "c",
      author: { principal: "izzie@x.com" }, createdAt: "2026-01-01T00:00:00Z",
      state: "created" as const, corroboration: [], thread: [], revisions: [], outcomes: [], asks: [],
    };
    await writeLocalFinding(u.root, { ...base, id: "f_prefix_aaaa" } as never, 269);
    await writeLocalFinding(u.root, { ...base, id: "f_prefix_bbbb" } as never, 269);

    const r = await commentOn(u.root, { id: "f_prefix", body: "x" }) as { error: string };
    assert.match(r.error, /the start of 2/);
    assert.ok(r.error.includes("f_prefix_aaaa") && r.error.includes("f_prefix_bbbb"));
  } finally { u.cleanup(); }
});

/** And a genuinely unknown id is still just unknown — no invented suggestion. */
test("an id that is nobody's prefix gets no suggestion", async () => {
  const u = await universe();
  try {
    const r = await commentOn(u.root, { id: "f_nothing_like_this", body: "x" }) as { error: string };
    assert.match(r.error, /no finding or bug/);
    assert.doesNotMatch(r.error, /did you mean|the start of/);
  } finally { u.cleanup(); }
});

// --- promoting an annotation, the verb whose absence made pointers parallel ---------

/**
 * A pointer that turns out to be a defect becomes the finding, keeping its id.
 *
 * `defer_finding` (finding -> bug) was the only promotion in the tool. There was no way
 * to say "this pointer was real", so the route was to file a SECOND record and resolve
 * the first — losing the id, the history, the original author and the filing time, and
 * leaving the team's `shared_note` copy pointing at an id nothing tracks. That happened
 * six times in one afternoon on `Acme.React`.
 */
test("a pointer promotes to a finding, keeping its id and its authorship", async () => {
  const u = await universe();
  try {
    const { annotate, promoteAnnotation } = await import("./ops.js");
    const { readAnchorStore, readAnnotations } = await import("./store.js");
    const anchorId = (await readAnchorStore(u.root)).anchors[0]!.id;
    const p = await annotate(u.root, {
      targetKind: "anchor", targetId: anchorId, kind: "pointer", author: "dana",
      text: "watch out: the retry here is not idempotent", severity: "high", category: "Logic", line: 2,
    }) as { id: string };

    const r = await promoteAnnotation(u.root, p.id, "269") as { ok?: boolean; was?: string; error?: string };
    assert.ok(r.ok, r.error ?? "");
    assert.equal(r.was, "pointer");

    const f = (await readFinding(u.root, p.id, { pr: "269" }))!;
    assert.equal(f.id, p.id, "the SAME id — the team's copy still points at something");
    // `filed` carries WHEN it was originally raised, which is the evidence that this is a
    // republication of something already said rather than a new claim today. The
    // principal is the machine's resolved actor, not the free-text `author` label — the
    // rule `actorOf` states: a name is not a principal, and inventing one would put a
    // person's identity on a record they did not make.
    assert.ok(f.filed, "it records that it was filed earlier, not raised now");
    assert.ok(f.filed!.at <= f.createdAt, "and the original time, not the promotion's");
    assert.equal(f.severity, "high");
    assert.equal(f.line, 2);
    assert.match(f.text, /not idempotent/);

    // It MOVED: two records for one defect is what this avoids.
    assert.equal((await readAnnotations(u.root)).annotations.find((a) => a.id === p.id), undefined);
  } finally { u.cleanup(); }
});

/** The pull request is never inferred — an annotation carries none. */
test("promoting without a pull request is refused, not guessed", async () => {
  const u = await universe();
  try {
    const { annotate, promoteAnnotation } = await import("./ops.js");
    const { readAnchorStore } = await import("./store.js");
    const anchorId = (await readAnchorStore(u.root)).anchors[0]!.id;
    const p = await annotate(u.root, { targetKind: "anchor", targetId: anchorId, kind: "pointer", text: "x", author: "izzie" }) as { id: string };
    const r = await promoteAnnotation(u.root, p.id, "") as { error: string };
    assert.match(r.error, /which pull request/);
    assert.match(r.error, /wrong review/, "and it says why guessing is not on offer");
  } finally { u.cleanup(); }
});

/** An unknown id gets the same prefix suggestion every other id refusal gives. */
test("promoting an unknown id suggests the whole one", async () => {
  const u = await universe();
  try {
    const { annotate, promoteAnnotation } = await import("./ops.js");
    const { readAnchorStore } = await import("./store.js");
    const anchorId = (await readAnchorStore(u.root)).anchors[0]!.id;
    await annotate(u.root, { targetKind: "anchor", targetId: anchorId, kind: "pointer", text: "x", author: "izzie" });
    const r = await promoteAnnotation(u.root, "nope_nothing", "269") as { error: string };
    assert.match(r.error, /no annotation/);
    assert.match(r.error, /defer_finding/, "and points at the neighbouring verb rather than leaving a dead end");
  } finally { u.cleanup(); }
});
