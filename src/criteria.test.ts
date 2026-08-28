/**
 * Acceptance criteria, and the three ways an assertion fails to assert.
 *
 * The subject here is a mechanism whose whole job is to REFUSE things, so the file is
 * built the way `requirements.test.ts` is: prove the positive case first, then prove the
 * negative is refused, so a removed guard fails a test rather than letting the file assert
 * nothing. Every guard below is mutation-checked.
 *
 * The one that is easiest to get vacuously right is `assertionMoved`: it is derived from
 * live hashes, so a test that never edits the code proves only that nothing drifted when
 * nothing changed. Each test that asserts `false` here also edits and re-asserts `true`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { indexBlob } from "./repo.js";
import { writeStore, readCriteria } from "./store.js";
import type { State } from "./schema.js";
import { discard } from "./test-tmp.js";
import { draftSpec, addOperation, ratifySpec } from "./requirements.js";
import { criteriaFor, recordVacuityCheck, weakAssertions, assertionStrength } from "./criteria.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const RULE_SRC = "export function creditLine(cents) { return cents; }\n";
const TEST_SRC = "export function assertCreditLineCapped() { return true; }\n";

/**
 * Two files on purpose: the rule's SUBJECT and the CHECK that asserts it.
 *
 * They have to be separately editable, because the entire claim this record makes is that
 * those are different anchor sets answering different questions. A fixture with one file
 * would make `cites` and `assertedBy` move together and every distinction below vacuous.
 */
async function universe() {
  const root = mkdtempSync(join(tmpdir(), "codemap-crit-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "izzie@x.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "izzie"], { cwd: root });
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/credit.js"), RULE_SRC, "utf8");
  writeFileSync(join(root, "src/credit.lint.js"), TEST_SRC, "utf8");
  const rule = await indexBlob(RULE_SRC, "src/credit.js");
  const check = await indexBlob(TEST_SRC, "src/credit.lint.js");
  await writeStore(root, [...rule, ...check], state);
  return { root, rule: rule.map((a) => a.id), check: check.map((a) => a.id) };
}

async function editCheck(root: string, src: string) {
  writeFileSync(join(root, "src/credit.lint.js"), src, "utf8");
  const rule = await indexBlob(RULE_SRC, "src/credit.js");
  const check = await indexBlob(src, "src/credit.lint.js");
  await writeStore(root, [...rule, ...check], state);
}

const ok = <T>(r: T): Exclude<T, { error: string }> => {
  assert.ok(!(r && typeof r === "object" && "error" in (r as object)), `unexpected error: ${(r as any)?.error}`);
  return r as Exclude<T, { error: string }>;
};
const err = (r: unknown): string => {
  assert.ok(r && typeof r === "object" && "error" in (r as object), `expected a refusal, got ${JSON.stringify(r)}`);
  return (r as { error: string }).error;
};

/** A ratified rule with one criterion asserted by the lint file. */
async function ruleWithCriterion(root: string, cites: string[], assertedBy: string[]) {
  const sp = ok(await draftSpec(root, { title: "Credit limits" }));
  const add = ok(await addOperation(root, {
    specId: sp.id, kind: "add_requirement", rationale: "policy",
    reversibility: "reversible", title: "Credit line is capped", section: "Credit/Limits",
    statement: "A credit line never exceeds the approved limit.", provenance: "credit policy",
  }));
  ok(await addOperation(root, {
    specId: sp.id, kind: "add_criterion", rationale: "policy", reversibility: "reversible",
    targetOperationId: add.id, criterion: "A line above the limit is rejected.",
    falsifier: "A line above the limit is accepted and persisted.",
    evidenceKind: "lint-test", assertedBy,
  }));
  const rat = ok(await ratifySpec(root, sp.id));
  const rid = rat.applied!.find((o) => o.kind === "add_requirement")!.requirementId!;
  return { requirementId: rid, criterion: (await criteriaFor(root, rid))[0]! };
}

test("a criterion attaches to the rule its own spec creates, and witnesses the CHECK", async () => {
  const u = await universe();
  try {
    const { requirementId, criterion } = await ruleWithCriterion(u.root, u.rule, u.check);

    assert.equal(criterion.requirementId, requirementId, "bound to the rule the same spec created");
    assert.equal(criterion.evidenceKind, "lint-test");
    assert.deepEqual(criterion.assertedBy, u.check);
    // The witnesses are of the ASSERTION, not of the rule's subject. If they were the
    // subject's, editing the check below would not move them and the whole relation
    // would collapse into a second copy of `cites`.
    assert.deepEqual(criterion.witnesses.map((w) => w.anchorId), u.check);
    assert.equal(criterion.assertionMoved, false);
    assert.equal(criterion.vacuity, "unchecked", "nobody has tried to break it yet");
    assert.equal(assertionStrength(criterion), "weak");

    // Edit the CHECK. The rule's subject is untouched, and the detector still moves.
    await editCheck(u.root, "export function assertCreditLineCapped() { return 1 === 1; }\n");
    const after = (await criteriaFor(u.root, requirementId))[0]!;
    assert.equal(after.assertionMoved, true, "the detector moved");
    assert.deepEqual(after.drifted, u.check);
    assert.equal(assertionStrength(after), "moved");
  } finally { discard(u.root); }
});

test("a falsifier is required, and one that restates the criterion is refused", async () => {
  const u = await universe();
  try {
    const sp = ok(await draftSpec(u.root, { title: "s" }));
    const add = ok(await addOperation(u.root, {
      specId: sp.id, kind: "add_requirement", rationale: "r", reversibility: "reversible",
      title: "t", section: "Credit", statement: "st", provenance: "p",
    }));
    const base = {
      specId: sp.id, kind: "add_criterion" as const, rationale: "r",
      reversibility: "reversible" as const, targetOperationId: add.id,
      evidenceKind: "lint-test" as const, assertedBy: u.check,
    };

    assert.match(err(await addOperation(u.root, { ...base, criterion: "A line above the limit is rejected." })),
      /falsifier/, "no falsifier at all");
    // The laziest vacuous form and the only one a machine can see. Punctuation and case
    // differ, so this also pins that the comparison is normalized rather than literal.
    assert.match(err(await addOperation(u.root, {
      ...base, criterion: "A line above the limit is rejected.",
      falsifier: "a line above the limit is REJECTED",
    })), /restates the criterion/);
    // And the real one lands.
    ok(await addOperation(u.root, {
      ...base, criterion: "A line above the limit is rejected.",
      falsifier: "A line above the limit is accepted and persisted.",
    }));
  } finally { discard(u.root); }
});

test("the evidence kind is a closed list", async () => {
  const u = await universe();
  try {
    const sp = ok(await draftSpec(u.root, { title: "s" }));
    const add = ok(await addOperation(u.root, {
      specId: sp.id, kind: "add_requirement", rationale: "r", reversibility: "reversible",
      title: "t", section: "Credit", statement: "st", provenance: "p",
    }));
    const base = {
      specId: sp.id, kind: "add_criterion" as const, rationale: "r", reversibility: "reversible" as const,
      targetOperationId: add.id, criterion: "c", falsifier: "f", assertedBy: u.check,
    };
    assert.match(err(await addOperation(u.root, { ...base })), /evidenceKind/, "absent is refused");
    assert.match(err(await addOperation(u.root, { ...base, evidenceKind: "unit-test" as never })),
      /evidenceKind/, "a plausible-sounding kind that is not on the list is refused");
    ok(await addOperation(u.root, { ...base, evidenceKind: "characterization-test" }));
  } finally { discard(u.root); }
});

test("a rule may carry several criteria in one spec — they do not overwrite each other", async () => {
  const u = await universe();
  try {
    const sp = ok(await draftSpec(u.root, { title: "s" }));
    const add = ok(await addOperation(u.root, {
      specId: sp.id, kind: "add_requirement", rationale: "r", reversibility: "reversible",
      title: "t", section: "Credit", statement: "st", provenance: "p",
    }));
    for (const n of [1, 2, 3]) {
      ok(await addOperation(u.root, {
        specId: sp.id, kind: "add_criterion", rationale: "r", reversibility: "reversible",
        targetOperationId: add.id, criterion: `criterion ${n}`, falsifier: `refuted ${n}`,
        evidenceKind: "automated-test", assertedBy: u.check,
      }));
    }
    // The one-operation-per-rule refusal exists because two AMENDMENTS render as if the
    // other had not happened and then silently overwrite. Criteria accumulate, so
    // applying that refusal here would make the playbook's ordinary AC-1…AC-n shape
    // un-ratifiable. Both halves are pinned: it ratifies, and all three survive.
    const rat = ok(await ratifySpec(u.root, sp.id));
    const rid = rat.applied!.find((o) => o.kind === "add_requirement")!.requirementId!;
    const cs = await criteriaFor(u.root, rid);
    assert.equal(cs.length, 3);
    assert.deepEqual(cs.map((c) => c.criterion).sort(), ["criterion 1", "criterion 2", "criterion 3"]);
    assert.equal(new Set(cs.map((c) => c.id)).size, 3, "distinct ids — derived from the operation, not the rule");
  } finally { discard(u.root); }
});

/**
 * Criteria added to a rule that ALREADY STANDS — which is the case the `targets` exemption
 * is actually about, and the one the same-spec test above cannot reach.
 *
 * When a criterion names its rule through `targetOperationId`, the operation carries no
 * `requirementId` until ratification binds it, so both duplicate-target refusals skip it
 * for free and the exemption is never consulted. Naming an existing rule directly is what
 * puts `requirementId` on the operation at authoring time — and then the refusal written
 * for two competing AMENDMENTS would refuse an ordinary AC-1/AC-2 pair.
 */
test("two criteria on a standing rule ratify, and do not block an amendment beside them", async () => {
  const u = await universe();
  try {
    const { requirementId } = await ruleWithCriterion(u.root, u.rule, u.check);

    const sp = ok(await draftSpec(u.root, { title: "More criteria" }));
    for (const n of [2, 3]) {
      ok(await addOperation(u.root, {
        specId: sp.id, kind: "add_criterion", rationale: "r", reversibility: "reversible",
        requirementId, criterion: `criterion ${n}`, falsifier: `refuted ${n}`,
        evidenceKind: "automated-test", assertedBy: u.check,
      }));
    }
    // And an amendment to the SAME rule in the same spec is still allowed — a criterion
    // must not consume the one-operation-per-rule slot that exists to stop two rewrites
    // overwriting each other.
    ok(await addOperation(u.root, {
      specId: sp.id, kind: "amend_statement", rationale: "r", reversibility: "reversible",
      requirementId, statement: "A credit line never exceeds the approved limit, ever.",
    }));

    ok(await ratifySpec(u.root, sp.id));
    const cs = await criteriaFor(u.root, requirementId);
    assert.equal(cs.length, 3, "the original plus both new ones");
    assert.deepEqual(cs.map((c) => c.criterion).sort(),
      ["A line above the limit is rejected.", "criterion 2", "criterion 3"]);
  } finally { discard(u.root); }
});

test("`demonstrated` needs a method; the verdicts that WEAKEN a criterion do not", async () => {
  const u = await universe();
  try {
    const { requirementId, criterion } = await ruleWithCriterion(u.root, u.rule, u.check);

    assert.match(err(await recordVacuityCheck(u.root, { criterionId: criterion.id, verdict: "demonstrated" })),
      /method/, "the silencing direction is evidence-gated");
    // Unsilencing is open, and that asymmetry is the point — gating it would gate what
    // makes a weak check visible.
    ok(await recordVacuityCheck(u.root, { criterionId: criterion.id, verdict: "wrong-layer" }));
    assert.equal((await criteriaFor(u.root, requirementId))[0]!.vacuity, "wrong-layer");

    ok(await recordVacuityCheck(u.root, {
      criterionId: criterion.id, verdict: "demonstrated",
      method: "inverted the cap comparison; the lint went red on 4 sites",
    }));
    const served = (await criteriaFor(u.root, requirementId))[0]!;
    assert.equal(served.vacuity, "demonstrated", "the latest live verdict wins");
    assert.equal(assertionStrength(served), "sound");
  } finally { discard(u.root); }
});

test("editing the assertion supersedes what anybody established about it", async () => {
  const u = await universe();
  try {
    const { requirementId, criterion } = await ruleWithCriterion(u.root, u.rule, u.check);
    ok(await recordVacuityCheck(u.root, {
      criterionId: criterion.id, verdict: "demonstrated", method: "broke it; it went red",
    }));
    assert.equal((await criteriaFor(u.root, requirementId))[0]!.vacuity, "demonstrated");

    // The whole reason vacuity is a RECORD and not a stored field: a `demonstrated` flag
    // would survive a rewrite of the very lint it certifies, which is the pathology
    // `assertedBy` exists to catch, reintroduced one level up.
    // A REAL edit. A comment-only change would not supersede anything — normalized hashing
    // is comment-stripped on purpose, so cosmetic edits do not flip a hash — and writing
    // one here is how this test first passed while asserting nothing.
    await editCheck(u.root, "export function assertCreditLineCapped() { return false; }\n");
    const after = (await criteriaFor(u.root, requirementId))[0]!;
    assert.equal(after.vacuity, "unchecked", "the demonstration was about code that is gone");
    assert.equal(after.assertionMoved, true);
    assert.notEqual(assertionStrength(after), "sound");
  } finally { discard(u.root); }
});

test("a criterion with no assertion cannot be demonstrated, and is not counted as checked", async () => {
  const u = await universe();
  try {
    // Legitimate: a criterion is written before the code exists, so an empty `assertedBy`
    // is a rule waiting for its check rather than a malformed record.
    const { requirementId, criterion } = await ruleWithCriterion(u.root, u.rule, []);
    assert.equal(criterion.unasserted, true);
    assert.equal(assertionStrength(criterion), "none");

    assert.match(err(await recordVacuityCheck(u.root, {
      criterionId: criterion.id, verdict: "demonstrated", method: "I ran it",
    })), /no check to demonstrate/, "an empty population reading as green is the default failure here");

    const weak = await weakAssertions(u.root);
    assert.deepEqual(weak.unasserted.map((c) => c.id), [criterion.id]);
    assert.deepEqual(weak.unchecked.map((c) => c.id), [], "unasserted is its own bucket, not folded into unchecked");

    // Retiring the rule empties the queue: a rule that no longer binds makes the soundness
    // of its check nobody's work, the same call `conformance()` and the diff rollup make.
    const sp = ok(await draftSpec(u.root, { title: "retire it" }));
    ok(await addOperation(u.root, {
      specId: sp.id, kind: "retire_requirement", rationale: "superseded",
      reversibility: "reversible", requirementId,
    }));
    ok(await ratifySpec(u.root, sp.id));
    const after = await weakAssertions(u.root);
    assert.deepEqual(after.unasserted, [], "a retired rule's criteria leave the queue");
  } finally { discard(u.root); }
});

test("there is no way to record `unchecked` — ignorance cannot clear a verdict", async () => {
  const u = await universe();
  try {
    const { requirementId, criterion } = await ruleWithCriterion(u.root, u.rule, u.check);
    ok(await recordVacuityCheck(u.root, { criterionId: criterion.id, verdict: "vacuous" }));
    assert.match(err(await recordVacuityCheck(u.root, { criterionId: criterion.id, verdict: "unchecked" as never })),
      /verdict must be one of/);
    assert.equal((await criteriaFor(u.root, requirementId))[0]!.vacuity, "vacuous", "the real verdict stands");
  } finally { discard(u.root); }
});

test("a criterion is created ONLY by ratification — a draft spec makes none", async () => {
  const u = await universe();
  try {
    const sp = ok(await draftSpec(u.root, { title: "s" }));
    const add = ok(await addOperation(u.root, {
      specId: sp.id, kind: "add_requirement", rationale: "r", reversibility: "reversible",
      title: "t", section: "Credit", statement: "st", provenance: "p",
    }));
    ok(await addOperation(u.root, {
      specId: sp.id, kind: "add_criterion", rationale: "r", reversibility: "reversible",
      targetOperationId: add.id, criterion: "c", falsifier: "f",
      evidenceKind: "lint-test", assertedBy: u.check,
    }));
    // Declaring what discharges a rule can NARROW it, which is the silencing direction,
    // so there is no authoring path that is not a ratification.
    assert.deepEqual(await readCriteria(u.root), [], "nothing exists while the spec is a draft");
    ok(await ratifySpec(u.root, sp.id));
    assert.equal((await readCriteria(u.root)).length, 1);
  } finally { discard(u.root); }
});

/**
 * The branch diff reaches a rule through its CHECK, not only through its subject.
 *
 * This is the signal the rollup could not give before: a change that rewrites a lint but
 * touches nothing the rule cites is exactly the edit that quietens a detector invisibly,
 * and rolling up on `cites` alone would omit it.
 */
test("a diff that rewrites only the CHECK still raises the rule", async () => {
  const u = await universe();
  try {
    const { requirementId } = await ruleWithCriterion(u.root, u.rule, u.check);
    const { readAnchorStore, writeSnapshot } = await import("./store.js");
    const { computeDiff } = await import("./diff.js");

    const base = (await readAnchorStore(u.root)).anchors;
    await writeSnapshot(u.root, "base_sha", "main", base, "2026-08-01T00:00:00Z");
    // Rewrite the LINT only. `src/credit.js` — everything the rule cites — is untouched.
    await editCheck(u.root, "export function assertCreditLineCapped() { return false; }\n");
    const head = (await readAnchorStore(u.root)).anchors;
    await writeSnapshot(u.root, "head_sha", "feature", head, "2026-08-01T01:00:00Z");

    const r = await computeDiff(u.root, "base_sha", "head_sha");
    assert.ok(!("error" in r), "expected a diff result");
    if ("error" in r) return;

    const row = r.impact.requirements.find((x) => x.id === requirementId);
    assert.ok(row, "the rule is raised even though this diff touches nothing it cites");
    assert.deepEqual(row.anchors, [], "and it is raised for the RIGHT reason — no cited code moved");
    assert.equal(row.assertionsMoved.length, 1);
    assert.equal(row.assertionsMoved[0]!.evidenceKind, "lint-test");
    assert.deepEqual(row.assertionsMoved[0]!.anchors, u.check);
  } finally { discard(u.root); }
});
