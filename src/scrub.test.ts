/**
 * The scrub: coverage on a schedule, and the rates that come out of it.
 *
 * The thing most at risk of being vacuous here is the rate itself. `pathology` is null
 * below `minObservations`, so a test that records one scrub and asserts "no pathology" is
 * satisfied by an implementation that never reports one at all. Every rate assertion below
 * therefore has a matching case that DOES fire, and the never/always pair is tested
 * together so an implementation collapsing them is visible.
 *
 * Every guard is mutation-checked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { indexBlob } from "./repo.js";
import { writeStore, writeNode, readAnchorStore } from "./store.js";
import type { LogicalNode, State } from "./schema.js";
import { discard } from "./test-tmp.js";
import { draftSpec, addOperation, ratifySpec } from "./requirements.js";
import { declarePointer } from "./pointers.js";
import { setScrubPolicy, scrubPlan, pointerRates, scrubsFor, baselinePlan } from "./scrub.js";
import { recordAudit } from "./audits.js";

/**
 * A scrub is an AUDIT with a covering trigger — one record, one lifecycle. What stays
 * separate is the QUEUE: `scrubPlan` selects on a coverage deadline per target, and the
 * differential queue selects on staleness. A differential audit therefore does not satisfy
 * a scrub unless its evidence is proven against the default branch.
 */
const scrub = (
  root: string,
  input: { requirementId: string; finding: string; observations?: { pointerId: string; firing: boolean }[] },
) => recordAudit(root, {
  requirementId: input.requirementId, outcome: "indeterminate", finding: input.finding,
  trigger: "scrub", ...(input.observations ? { observations: input.observations } : {}),
});

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const SRC = "export function creditLine(cents) { return cents; }\n";
const DAY = 86_400_000;

const ok = <T>(r: T): Exclude<T, { error: string }> => {
  assert.ok(!(r && typeof r === "object" && "error" in (r as object)), `unexpected error: ${(r as any)?.error}`);
  return r as Exclude<T, { error: string }>;
};
const err = (r: unknown): string => {
  assert.ok(r && typeof r === "object" && "error" in (r as object), `expected a refusal, got ${JSON.stringify(r)}`);
  return (r as { error: string }).error;
};

async function universe() {
  const root = mkdtempSync(join(tmpdir(), "codemap-scrub-"));
  for (const a of [["init", "-q", "-b", "main"], ["config", "user.email", "izzie@x.com"], ["config", "user.name", "izzie"]]) {
    spawnSync("git", a, { cwd: root });
  }
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/credit.js"), SRC, "utf8");
  const anchors = await indexBlob(SRC, "src/credit.js");
  await writeStore(root, anchors, state);
  const doc: LogicalNode = {
    id: "n_credit", type: "concept", title: "How credit limits work",
    summary: "", anchors: anchors.map((a) => a.id), body: "",
  };
  await writeNode(root, doc);
  // COMMITTED, on the default branch. Branch work resets no coverage deadline, so an
  // uncommitted fixture makes every audit provisional and every clock assertion vacuous.
  spawnSync("git", ["add", "-A"], { cwd: root });
  spawnSync("git", ["commit", "-qm", "base"], { cwd: root });
  return { root, doc: doc.id };
}

async function rule(root: string, title: string, section: string) {
  const sp = ok(await draftSpec(root, { title }));
  ok(await addOperation(root, {
    specId: sp.id, kind: "add_requirement", rationale: "policy", reversibility: "reversible",
    title, section, statement: `${title} holds.`, provenance: "policy",
  }));
  const rat = ok(await ratifySpec(root, sp.id));
  return rat.applied!.find((o) => o.kind === "add_requirement")!.requirementId!;
}

test("no stated policy is a FINDING, not a default", async () => {
  const u = await universe();
  try {
    await rule(u.root, "Capped", "Credit");
    const plan = await scrubPlan(u.root);
    assert.equal(plan.policy, null, "an unstated schedule is `whenever somebody remembers`");
    assert.equal(plan.perDay, null, "and its cost is unbudgeted, which is the point");
    assert.equal(plan.population, 1);
    assert.equal(plan.neverScrubbed, 1);
    assert.equal(plan.due.length, 1, "with no period, everything is due");

    ok(await setScrubPolicy(u.root, { coverageDays: 30 }));
    const after = await scrubPlan(u.root);
    assert.equal(after.policy!.coverageDays, 30);
    assert.equal(after.policy!.minObservations, 3, "a sane default, not 1");
    // The AVERAGE, not a ceiling: `Math.ceil` would report one rule every 30 days as "1 a
    // day", thirty times the real workload. What must I do today is `due.length`.
    assert.equal(after.perDay, 0.03);
  } finally { discard(u.root); }
});

test("a policy that cannot do its job is refused", async () => {
  const u = await universe();
  try {
    assert.match(err(await setScrubPolicy(u.root, { coverageDays: 0 })), /positive number of days/);
    assert.match(err(await setScrubPolicy(u.root, { coverageDays: -3 })), /positive number of days/);
    // A rate from a single look is not a rate. Allowing 1 would let the scrub commit the
    // exact error it exists to catch — a confident verdict from a check that could not
    // have produced one.
    assert.match(err(await setScrubPolicy(u.root, { coverageDays: 30, minObservations: 1 })), /at least 2/);
    ok(await setScrubPolicy(u.root, { coverageDays: 30, minObservations: 2 }));
  } finally { discard(u.root); }
});

test("the budget scales with the population, which is what makes the cost visible", async () => {
  const u = await universe();
  try {
    for (const n of [1, 2, 3, 4, 5, 6, 7]) await rule(u.root, `Rule ${n}`, `S${n}`);
    ok(await setScrubPolicy(u.root, { coverageDays: 2 }));
    const plan = await scrubPlan(u.root);
    assert.equal(plan.population, 7);
    assert.equal(plan.perDay, 3.5, "7 rules covered every 2 days costs 3.5 a day on average");
  } finally { discard(u.root); }
});

test("a covering audit must say what every active pointer was doing — a reset clock needs evidence", async () => {
  const u = await universe();
  try {
    const rid = await rule(u.root, "Capped", "Credit");
    const p = ok(await declarePointer(u.root, {
      requirementId: rid, targetKind: "node", targetId: u.doc, rationale: "the doc",
    }));

    assert.match(err(await scrub(u.root, { requirementId: rid, finding: "looked" })),
      /must say what all 1 of its active pointer/);
    // The real pointer IS observed here: a phantom alongside an omission trips the
    // omission check first, and the test then proves nothing about phantoms.
    assert.match(err(await scrub(u.root, { requirementId: rid, finding: "looked", observations: [{ pointerId: p.id, firing: false }, { pointerId: "pt_nope", firing: false }] })), /not active on/);
    // A scrub that records nothing is the vacuous check this mechanism exists to detect,
    // one level up.
    assert.match(err(await scrub(u.root, { requirementId: rid, finding: "  ", observations: [{ pointerId: p.id, firing: false }] })), /needs a finding/);

    ok(await scrub(u.root, { requirementId: rid, finding: "the doc still describes what the rule is about", observations: [{ pointerId: p.id, firing: false }] }));
    assert.equal((await scrubsFor(u.root, rid)).length, 1);
  } finally { discard(u.root); }
});

test("a rule with nothing watching it can be scrubbed, and that IS the finding", async () => {
  const u = await universe();
  try {
    const rid = await rule(u.root, "Capped", "Credit");
    // Unwatched is the requirement-side twin of `unknown`. Refusing to scrub it would make
    // the one class of rule that most needs looking at the one nobody can record having
    // looked at.
    ok(await scrub(u.root, { requirementId: rid, finding: "nothing watches this rule at all" }));
    assert.equal((await scrubsFor(u.root, rid)).length, 1);
  } finally { discard(u.root); }
});

/**
 * The two symmetric pathologies, tested TOGETHER.
 *
 * Apart, either one passes against an implementation that collapses them — a detector that
 * reported everything as `never-fires` would satisfy a never-fires test on its own.
 */
test("never-fires and always-fires are both derived, and only past minObservations", async () => {
  const u = await universe();
  try {
    ok(await setScrubPolicy(u.root, { coverageDays: 30, minObservations: 3 }));
    const quiet = await rule(u.root, "Quiet", "S1");
    const noisy = await rule(u.root, "Noisy", "S2");
    const qp = ok(await declarePointer(u.root, { requirementId: quiet, targetKind: "node", targetId: u.doc, rationale: "r" }));
    const np = ok(await declarePointer(u.root, { requirementId: noisy, targetKind: "node", targetId: u.doc, rationale: "r" }));

    for (let i = 0; i < 2; i++) {
      ok(await scrub(u.root, { requirementId: quiet, finding: "looked", observations: [{ pointerId: qp.id, firing: false }] }));
      ok(await scrub(u.root, { requirementId: noisy, finding: "looked", observations: [{ pointerId: np.id, firing: true }] }));
    }
    // Two observations is below the floor: a rate from two looks is not a rate, and the
    // absence here is what stops the scrub failing at its own standard.
    assert.deepEqual((await pointerRates(u.root)).map((r) => r.pathology), [null, null]);
    assert.deepEqual((await scrubPlan(u.root)).pathologies, []);

    ok(await scrub(u.root, { requirementId: quiet, finding: "looked", observations: [{ pointerId: qp.id, firing: false }] }));
    ok(await scrub(u.root, { requirementId: noisy, finding: "looked", observations: [{ pointerId: np.id, firing: true }] }));

    const rates = await pointerRates(u.root);
    const q = rates.find((r) => r.pointerId === qp.id)!;
    const n = rates.find((r) => r.pointerId === np.id)!;
    assert.deepEqual([q.observations, q.fired, q.pathology], [3, 0, "never-fires"], "false calm: it looks like coverage and is not");
    assert.deepEqual([n.observations, n.fired, n.pathology], [3, 3, "always-fires"], "cry-wolf");

    // A pointer that sometimes fires is doing its job and is not a pathology — without
    // this, `pathology` could be a constant and both assertions above would still pass.
    const mixed = await rule(u.root, "Mixed", "S3");
    const mp = ok(await declarePointer(u.root, { requirementId: mixed, targetKind: "node", targetId: u.doc, rationale: "r" }));
    for (const firing of [true, false, true]) {
      ok(await scrub(u.root, { requirementId: mixed, finding: "looked", observations: [{ pointerId: mp.id, firing }] }));
    }
    assert.equal((await pointerRates(u.root)).find((r) => r.pointerId === mp.id)!.pathology, null);
    assert.deepEqual((await scrubPlan(u.root)).pathologies.map((p) => p.pathology).sort(),
      ["always-fires", "never-fires"]);
  } finally { discard(u.root); }
});

test("no rate is reportable at all without a stated policy", async () => {
  const u = await universe();
  try {
    const rid = await rule(u.root, "Capped", "Credit");
    const p = ok(await declarePointer(u.root, { requirementId: rid, targetKind: "node", targetId: u.doc, rationale: "r" }));
    for (let i = 0; i < 5; i++) {
      ok(await scrub(u.root, { requirementId: rid, finding: "looked", observations: [{ pointerId: p.id, firing: false }] }));
    }
    // Five quiet observations, and still no verdict: `minObservations` comes from the
    // policy, and an unstated policy states no floor. Reporting a pathology against a
    // threshold nobody set is the unbudgeted-schedule failure wearing a verdict.
    const rates = await pointerRates(u.root);
    assert.equal(rates[0]!.observations, 5);
    assert.equal(rates[0]!.pathology, null);

    ok(await setScrubPolicy(u.root, { coverageDays: 30, minObservations: 3 }));
    assert.equal((await pointerRates(u.root))[0]!.pathology, "never-fires");
  } finally { discard(u.root); }
});

/**
 * Coverage is the property being guaranteed, so the order is least-recently-looked-at and
 * never "whatever moved" — a scrub driven by movement covers exactly what differential
 * audit already covers, and leaves the blind spot it exists for untouched.
 */
test("the queue is ordered by neglect, and a scrub removes a rule from it until T passes", async () => {
  const u = await universe();
  try {
    ok(await setScrubPolicy(u.root, { coverageDays: 30 }));
    const a = await rule(u.root, "Alpha", "S1");
    const b = await rule(u.root, "Beta", "S2");
    ok(await scrub(u.root, { requirementId: a, finding: "looked" }));

    const plan = await scrubPlan(u.root);
    assert.deepEqual(plan.due.map((d) => d.requirementId), [b], "only the never-looked-at rule is due");
    assert.equal(plan.neverScrubbed, 1);

    // Thirty-one days on, the scrubbed one is due again: coverage is a period, not a tick.
    const later = new Date(Date.now() + 31 * DAY).toISOString();
    const aged = await scrubPlan(u.root, { asOf: later });
    assert.deepEqual(aged.due.map((d) => d.requirementId).sort(), [a, b].sort());
    // Never-scrubbed sorts ahead of merely-overdue.
    assert.equal(aged.due[0]!.requirementId, b);
    assert.equal(aged.due[0]!.daysSince, null);
  } finally { discard(u.root); }
});

test("a retired rule leaves the schedule entirely", async () => {
  const u = await universe();
  try {
    ok(await setScrubPolicy(u.root, { coverageDays: 30 }));
    const rid = await rule(u.root, "Capped", "Credit");
    assert.equal((await scrubPlan(u.root)).population, 1);

    const sp = ok(await draftSpec(u.root, { title: "retire" }));
    ok(await addOperation(u.root, {
      specId: sp.id, kind: "retire_requirement", rationale: "superseded",
      reversibility: "reversible", requirementId: rid,
    }));
    ok(await ratifySpec(u.root, sp.id));

    const plan = await scrubPlan(u.root);
    assert.equal(plan.population, 0, "a rule that does not bind is not on the schedule");
    assert.deepEqual(plan.due, []);
    // A COVERING audit of a retired rule is refused — there is no deadline to reset. An
    // ad-hoc one is still allowed: that is history, and losing it helps nobody.
    assert.match(err(await scrub(u.root, { requirementId: rid, finding: "x" })), /retired/);
    ok(await recordAudit(u.root, { requirementId: rid, outcome: "indeterminate", finding: "for the record" }));
  } finally { discard(u.root); }
});

test("a pathology is about a live pointer on a rule in force, not about history", async () => {
  const u = await universe();
  try {
    ok(await setScrubPolicy(u.root, { coverageDays: 30, minObservations: 2 }));
    const rid = await rule(u.root, "Capped", "Credit");
    const p = ok(await declarePointer(u.root, { requirementId: rid, targetKind: "node", targetId: u.doc, rationale: "r" }));
    for (let i = 0; i < 2; i++) {
      ok(await scrub(u.root, { requirementId: rid, finding: "looked", observations: [{ pointerId: p.id, firing: false }] }));
    }
    assert.deepEqual((await scrubPlan(u.root)).pathologies.map((x) => x.pointerId), [p.id]);

    // Retiring the pointer ends the claim. The rate stays on the record — that IS the
    // history — but a retired pointer is not watching anything, so calling it a pathology
    // asks somebody to act on a dead record.
    const { retirePointer } = await import("./pointers.js");
    ok(await retirePointer(u.root, { id: p.id, reason: "replaced by a lint" }));
    assert.deepEqual((await scrubPlan(u.root)).pathologies, []);
    assert.equal((await pointerRates(u.root)).find((x) => x.pointerId === p.id)!.observations, 2,
      "the history is kept — a rate is derived from it, and deleting it would destroy the evidence");
  } finally { discard(u.root); }
});

/**
 * One look counted as several defeats `minObservations` through the door it does not watch.
 *
 * Three copies of one observation reaches the default floor from a SINGLE call and reports
 * a pathology — which is precisely the error the floor exists to prevent, so a duplicate is
 * refused for the reason `checkMembers` refuses a duplicate member.
 */
/**
 * The counterexample two reviewers found, and Izzie's repair for it.
 *
 * With ONE deadline per requirement, differential activity starved the scrub: pointer A
 * moving every 29 days produced a differential audit every 29 days, each of which reset the
 * rule's single timestamp, so pointer B was never examined while the schedule reported the
 * rule as covered. *Everything is covered every T* failed quietly, and quietly is the whole
 * problem — a scrub exists to find what looks fine every time you look at it.
 *
 * The deadline is now the POINTER's, so A's look resets A and nothing else.
 */
test("a pointer that keeps moving cannot cover the one beside it that never does", async () => {
  const u = await universe();
  try {
    ok(await setScrubPolicy(u.root, { coverageDays: 30, minObservations: 2 }));
    const r = await rule(u.root, "Capped", "Credit");
    const store = await readAnchorStore(u.root);
    const a = ok(await declarePointer(u.root, {
      requirementId: r, targetKind: "anchor", targetId: store.anchors[0]!.id, rationale: "moves often",
    }));
    const b = ok(await declarePointer(u.root, {
      requirementId: r, targetKind: "node", targetId: u.doc, rationale: "never moves",
    }));

    // A differential audit of A alone — the ordinary shape: something changed, so somebody
    // looked at what watches it.
    ok(await recordAudit(u.root, {
      requirementId: r, outcome: "indeterminate", finding: "checked what the diff touched",
      trigger: "differential", observations: [{ pointerId: a.id, firing: true }],
    }));

    const plan = await scrubPlan(u.root);
    const due = plan.due.find((x) => x.requirementId === r);
    assert.ok(due, "the rule is still due — B has never been looked at, so the rule is not covered");
    assert.equal(due.lastScrubbed, null, "the OLDEST pointer decides, and B has no date at all");
    assert.deepEqual(due.stale.map((x) => x.pointerId), [b.id],
      "and it names the pointer that actually needs looking at, not the whole rule");

    // A scrub covers both, and only then does the rule leave the queue.
    ok(await recordAudit(u.root, {
      requirementId: r, outcome: "indeterminate", finding: "swept", trigger: "scrub",
      observations: [{ pointerId: a.id, firing: false }, { pointerId: b.id, firing: false }],
    }));
    assert.equal((await scrubPlan(u.root)).due.find((x) => x.requirementId === r), undefined,
      "covered now, because everything watching it has been looked at");
  } finally { discard(u.root); }
});

test("a differential audit may name the subset it looked at, and an ad-hoc one may not", async () => {
  const u = await universe();
  try {
    const r = await rule(u.root, "Capped", "Credit");
    const store = await readAnchorStore(u.root);
    const a = ok(await declarePointer(u.root, {
      requirementId: r, targetKind: "anchor", targetId: store.anchors[0]!.id, rationale: "watched",
    }));
    ok(await declarePointer(u.root, {
      requirementId: r, targetKind: "node", targetId: u.doc, rationale: "also watched",
    }));

    // A SUBSET is fine — it looked at what moved and says so. A covering audit is still
    // held to the whole list, because it is the one claiming to have covered the rule.
    ok(await recordAudit(u.root, {
      requirementId: r, outcome: "indeterminate", finding: "what the diff touched",
      trigger: "differential", observations: [{ pointerId: a.id, firing: true }],
    }));
    const partial = await recordAudit(u.root, {
      requirementId: r, outcome: "indeterminate", finding: "swept", trigger: "scrub",
      observations: [{ pointerId: a.id, firing: true }],
    });
    assert.match((partial as { error: string }).error, /must say what all 2 of its active pointer\(s\) were doing/);

    // `ad-hoc` still carries none: nobody asked what it would look at, so what it reports
    // is not evidence of coverage.
    const adhoc = await recordAudit(u.root, {
      requirementId: r, outcome: "indeterminate", finding: "had a look",
      observations: [{ pointerId: a.id, firing: true }],
    });
    assert.match((adhoc as { error: string }).error, /nobody asked what an `ad-hoc` one would look at/);
  } finally { discard(u.root); }
});

test("the same pointer observed twice in one scrub is refused", async () => {
  const u = await universe();
  try {
    ok(await setScrubPolicy(u.root, { coverageDays: 30, minObservations: 3 }));
    const rid = await rule(u.root, "Capped", "Credit");
    const p = ok(await declarePointer(u.root, { requirementId: rid, targetKind: "node", targetId: u.doc, rationale: "r" }));

    assert.match(err(await scrub(u.root, { requirementId: rid, finding: "looked", observations: [{ pointerId: p.id, firing: false }, { pointerId: p.id, firing: false }, { pointerId: p.id, firing: false }] })), /observed twice/);
    // And a real single observation still lands, so the refusal is not "nothing works".
    ok(await scrub(u.root, { requirementId: rid, finding: "looked", observations: [{ pointerId: p.id, firing: false }] }));
    assert.equal((await pointerRates(u.root))[0]!.observations, 1);
    assert.equal((await pointerRates(u.root))[0]!.pathology, null, "one look is still one look");
  } finally { discard(u.root); }
});
