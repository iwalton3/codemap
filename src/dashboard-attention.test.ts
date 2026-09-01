/**
 * `attention` is a claim about the UNIVERSE, not about two of its subsystems.
 *
 * The dashboard summed docs and bugs only, so the landing page rendered its green
 * "nothing stale — docs and bugs are current with the code" while the standard had
 * problems nobody had adjudicated, scrubs past their deadline and specs waiting on a
 * ratifier, findings waiting on a person, and a FORKED writer id. Every one of those is
 * something a human has to do, and the one number the page tells you to drive to zero
 * could not see any of them.
 *
 * The baseline assertion in each test below is the mutation check: a fresh universe reads
 * zero, so a test that finds `attention` nonzero after one act has watched that act cause
 * it, rather than passing because the number was never zero.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { indexBlob } from "./repo.js";
import { writeStore, writeLocalFinding } from "./store.js";
import type { State } from "./schema.js";
import { discard } from "./test-tmp.js";
import { draftSpec, addOperation, listRequirements } from "./requirements.js";
import { ratifyReviewed } from "./test-approve.js";
import { recordAudit } from "./audits.js";
import { acknowledgeDebt } from "./acknowledgements.js";
import { raiseProblem } from "./problems.js";
import { dashboard } from "./ops.js";
import { findingBacklog } from "./ops-shared.js";
import type { SharedFinding } from "./shared-findings.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const SRC = "export function creditLine(cents) { return cents * 2; }\n";
const AGENT = { agent: true, model: "claude-opus-5" } as const;

const git = (root: string, ...args: string[]) => spawnSync("git", args, { cwd: root });

async function universe() {
  const root = mkdtempSync(join(tmpdir(), "codemap-dash-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "izzie@x.com");
  git(root, "config", "user.name", "izzie");
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/credit.js"), SRC, "utf8");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  const indexed = await indexBlob(SRC, "src/credit.js");
  await writeStore(root, indexed, state);
  return { root, anchors: indexed.map((a) => a.id) };
}

const ok = <T>(r: T): Exclude<T, { error: string }> => {
  assert.ok(!(r && typeof r === "object" && "error" in (r as object)), `unexpected error: ${(r as any)?.error}`);
  return r as Exclude<T, { error: string }>;
};

/** A ratified rule the code violates, audited, and raised as an un-adjudicated problem. */
async function raiseOne(root: string, anchors: string[]) {
  const sp = ok(await draftSpec(root, { title: "Credit currency policy" }));
  ok(await addOperation(root, {
    specId: sp.id, kind: "add_requirement", rationale: "policy §4 was never written down",
    reversibility: "reversible", title: "Credit line currency", section: "Credit/Limits",
    statement: "All credit lines are in USD.", provenance: "credit policy §4",
  }));
  ok(await ratifyReviewed(root, sp.id));
  const rule = (await listRequirements(root))[0]!;
  const audit = ok(await recordAudit(root, {
    requirementId: rule.id, outcome: "nonconformant",
    finding: "creditLine doubles the amount and never checks currency",
    evidence: { read: anchors }, ...AGENT,
  }));
  const problem = ok(await raiseProblem(root, { auditId: audit.id, summary: "creditLine does not enforce USD", ...AGENT }));
  return { rule, audit, problem };
}

/** The docs-and-bugs half — everything `attention` used to be, and nothing else. */
const docsAndBugs = (d: Awaited<ReturnType<typeof dashboard>>) =>
  d.docs.stale + d.docs.dangling + d.bugs.possiblyFixed + d.openQuestions + d.tripwires.fired.length + d.reverted;

test("an un-adjudicated problem reaches `attention`, which docs-and-bugs cannot see", async () => {
  const { root, anchors } = await universe();
  try {
    const before = await dashboard(root);
    assert.equal(before.attention, 0, "the baseline must be zero, or nothing below is watching a change");

    await raiseOne(root, anchors);

    const after = await dashboard(root);
    assert.equal(after.standard?.queues.awaitingAdjudication, 1, "the problem is in the standard's queue");
    // Ratifying a rule that nothing yet watches puts it past its coverage deadline the
    // same moment, so this act lands TWO items. Asserted exactly rather than as `>= 1`:
    // a rule with no pointer is overdue immediately, and a reader of this test who did
    // not know that would read the 2 as a double count.
    assert.equal(after.standard?.overdue.scrubs, 1, "a ratified rule with nothing watching it is overdue at once");
    assert.equal(docsAndBugs(after), 0, "and nothing about docs or bugs moved — this is the blind spot itself");
    assert.equal(after.attention, 2, "so `attention` has to come from the standard, or the green banner lies");
  } finally { discard(root); }
});

test("`attention` counts every standard queue, and counts the acknowledgement queue once", async () => {
  const { root, anchors } = await universe();
  try {
    const { rule } = await raiseOne(root, anchors);
    // A silencer whose release condition ran out, which is the ordinary way one goes
    // overdue. It is here because the double-count assertion below is VACUOUS without
    // it: `acknowledgementsDue` is 0 in an untouched universe, so summing it twice
    // changes nothing and the guard passes while guarding nothing. Confirmed by
    // reinstating the double count and watching this test stay green.
    ok(await acknowledgeDebt(root, {
      requirementId: rule.id, rationale: "the EUR path stays until the settlement rewrite",
      priority: "medium", revalidateBy: "2020-01-01",
    }));

    const d = await dashboard(root);
    const s = d.standard!;
    assert.ok(s.overdue.acknowledgements > 0, "or the alias below is summed against zero and proves nothing");

    // The structural half. A queue added to `standardStatus` and not to
    // `attentionFromStandard` is a queue the landing page silently stops counting — the
    // exact defect this file exists for, one subsystem down. Adding a key here without
    // deciding whether it belongs in the sum is the mistake, so the key set is pinned.
    assert.deepEqual(Object.keys(s.queues).sort(), [
      "acknowledgementsDue", "actionableProblems", "awaitingAdjudication",
      "pendingSpecs", "promotableAudits", "settledWithoutAdjudication",
    ], "a new queue must be added to `attentionFromStandard` (or excluded on purpose) before it is added here");

    // `acknowledgementsDue` and `overdue.acknowledgements` are ONE number computed once,
    // deliberately — `standardStatus` says so. Summing both double-counts those rows.
    assert.equal(s.queues.acknowledgementsDue, s.overdue.acknowledgements, "these are the same rows");
    const naive = s.overdue.scrubs + s.overdue.acknowledgements
      + Object.values(s.queues).reduce((n, v) => n + v, 0);
    const counted = s.overdue.scrubs + s.overdue.acknowledgements
      + s.queues.pendingSpecs + s.queues.awaitingAdjudication + s.queues.actionableProblems
      + s.queues.promotableAudits + s.queues.settledWithoutAdjudication;
    assert.equal(d.attention - docsAndBugs(d), counted, "`attention` counts every queue above");
    assert.equal(naive - counted, s.queues.acknowledgementsDue, "and the naive sum is exactly one alias too many");
  } finally { discard(root); }
});

test("a branch with no base to diff against is ONE attention item; the trunk is none", async () => {
  const { root } = await universe();
  try {
    const onTrunk = await dashboard(root);
    assert.equal(onTrunk.branch.onTrunk, true);
    assert.equal(onTrunk.branch.noBase, false, "there is no branch to review on the trunk, so nothing is missing");
    assert.equal(onTrunk.attention, 0);

    git(root, "checkout", "-qb", "feat/x");
    const onBranch = await dashboard(root);
    assert.equal(onBranch.branch.onTrunk, false);
    assert.equal(onBranch.branch.base, null, "nothing has been snapshotted, so `diff` has no base side");
    assert.equal(onBranch.branch.noBase, true);
    // ONE item, not one per unusable snapshot: the reader's job is a single act
    // (`codemap snapshot`) however many rows are behind it.
    assert.equal(onBranch.attention, 1, "the diff surface being unusable is itself the thing to fix");
  } finally { discard(root); }
});

/** A local finding, hand-built. `promoted` is what makes `needsHumanAck` true. */
const finding = (id: string, promoted: boolean, over: Partial<SharedFinding> = {}): SharedFinding => ({
  id, target: { kind: "anchor", id: "a_1" }, text: "creditLine doubles the amount",
  author: { principal: "izzie@x.com" }, createdAt: "2026-08-01T00:00:00Z",
  state: "created", corroboration: [], thread: [], revisions: [],
  ...(promoted ? { promotion: { at: "2026-08-02T00:00:00Z", by: { principal: "izzie@x.com" } } } : {}),
  ...over,
} as SharedFinding);

test("an open finding IS the queue now; only a backlogged one is set aside", async () => {
  const { root } = await universe();
  try {
    const empty = await dashboard(root);
    assert.equal(empty.review.findings.total, 0);
    assert.equal(empty.review.sidecar, null, "no sidecar is an ordinary state, not an error");
    assert.equal(empty.attention, 0, "the baseline the two writes below are measured against");

    // Written straight to the local table, which is where a finding filed with no sidecar
    // lives — so this exercises the count on the store shape the rollup actually reads,
    // rather than on a sidecar fixture that would test the fold instead.
    //
    // This test used to assert an open finding counted for NOTHING, and the backlog
    // deliberately changes that: an undisposed finding whose witnessed code still stands
    // is precisely the debt, and treating it as free is the habit that let 97 of them
    // accumulate. What is set aside is a CARRY, because somebody decided it.
    await writeLocalFinding(root, finding("f_open", false), 7);
    const open = await dashboard(root);
    assert.equal(open.review.findings.total, 1, "counted as workload");
    assert.equal(open.review.findings.waiting, 0, "nobody is blocked on it…");
    assert.equal(open.attention, 1, "…and it is still somebody's to dispose of");

    await writeLocalFinding(root, finding("f_promoted", true), 7);
    const waiting = await dashboard(root);
    assert.equal(waiting.review.findings.total, 2);
    assert.equal(waiting.review.findings.waiting, 1, "promoted — a person has to look at it");
    // TWO, not three: `needsAck` is a property of a finding the backlog already counts,
    // so summing it beside the buckets would make one record two items.
    assert.equal(waiting.attention, 2, "one item per finding, however many things are true of it");
  } finally { discard(root); }
});

test("the dashboard's attention and the backlog's are ONE number, not two", async () => {
  // This is the defect this whole file exists for, reappearing one subsystem over. The
  // landing page summed docs and bugs while the standard and the sidecar were in trouble;
  // it then grew a `review` card whose count could not see an expired backlog deadline, so
  // `attention: 0` on a store whose backlog said 5. Two rollups of one pile disagree the
  // moment either changes, so the dashboard reads the backlog's own number.
  const { root, anchors } = await universe();
  try {
    const { readAnchorStore } = await import("./store.js");
    const a = (await readAnchorStore(root)).anchors[0]!;
    const id = anchors[0]!, hash = a.bodyHash;
    const clean = await dashboard(root);
    assert.equal(clean.attention, 0, "the baseline the writes below are measured against");

    const w = { anchorId: id, bodyHash: hash };
    const by = { principal: "izzie@x.com" };
    // One of each kind the backlog counts, and one it deliberately does not.
    await writeLocalFinding(root, finding("f_live", false, { target: { kind: "anchor", id }, witness: w }), 1);
    await writeLocalFinding(root, finding("f_due", false, {
      target: { kind: "anchor", id }, witness: w,
      backlogged: { until: "2020-01-01", reason: "slated for replacement", by, at: "2019-01-01T00:00:00Z" },
    }), 1);
    await writeLocalFinding(root, finding("f_sleep", false, {
      target: { kind: "anchor", id }, witness: w,
      backlogged: { until: "2099-01-01", reason: "not now", by, at: "2026-01-01T00:00:00Z", witness: w },
    }), 1);

    const d = await dashboard(root);
    const b = await findingBacklog(root);
    assert.equal(b.attention, 2, "the live one and the expired deadline — never the sleeping one");
    assert.equal(d.review.backlog?.attention, b.attention, "the dashboard reports the backlog's own count");
    assert.equal(d.attention, b.attention, "and drives the banner with it, so the two can never disagree");
    // The trap the old shape fell into: `needsAck` findings are already inside those
    // buckets, so counting them again would make one record two items.
    assert.equal(d.review.findings.total, 3, "all three are findings");
    assert.ok(d.attention < d.review.findings.total, "an open finding is a workload; only some of it is a queue");
  } finally { discard(root); }
});
