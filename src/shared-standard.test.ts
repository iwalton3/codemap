/**
 * The standard as shared state: what the log carries, and what a clone that only ever
 * sees the log is allowed to believe.
 *
 * The two tests that matter most here are the ones about the FOLD refusing things. A
 * remote clone never saw the MCP call — it sees a row — so any rule enforced only in the
 * tool is not enforced for anybody but its author. The fold must not be more permissive
 * than the tool, and these prove it is not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readScope } from "./eventlog.js";
import { ensureSidecar } from "./sidecar.js";
import { db } from "./db.js";
import { discard } from "./test-tmp.js";
import { standardProjection } from "./shared-projections.js";
import {
  foldStandard, standardScope, publishSpecDrafted, publishOperation, publishSpecRatified,
  publishAckGranted, publishAckReleased, publishAudit, publishProblemRaised, publishAdjudication,
  publishVacuityCheck, publishPointerDeclared, publishPointerRestated, publishPointerRetired,
  publishPopulationPinned, publishScrubPolicy, publishSpecWithdrawn, publishOperationRevised,
  publishSpecReviewed, publishOperationRemoved, emptyStandard,
} from "./shared-standard.js";
import { ratifyWithReview } from "./test-approve.js";
import { criterionIdFor, requirementIdFor, framingContent, operationContent, type Acknowledgement, type Actor, type Audit, type Operation, type Pointer, type Problem, type Spec } from "./schema.js";

const izzie: Actor = { principal: "izzie@x.com" };
const opus: Actor = { principal: "izzie@x.com", via: { kind: "agent", model: "claude-opus-5" } };
const U = "acme/api";
const SCOPE = standardScope(U);

const tmp = (t: string) => mkdtempSync(join(tmpdir(), `codemap-ss-${t}-`));
/**
 * The fold, answering as THIS universe.
 *
 * `myScope` is not decoration: a ratified spec's withdrawal now applies only where the
 * withdrawer said it had checked, and a fold that does not know which repository it is
 * cannot tell — so it refuses. See `withdraw` below and `relianceEverywhere`.
 */
const fold = async (root: string) => foldStandard(await readScope(root, SCOPE), { myScope: SCOPE });

/**
 * Withdraw, pinning THIS scope as checked — what `withdrawSpec` does after reading every
 * standard scope on the sidecar and finding each settled and clean. A test that publishes
 * without the pin is testing the un-checked case, which has its own test below.
 */
const withdraw = (root: string, actor: typeof izzie, specId: string, at: string, reason: string) =>
  publishSpecWithdrawn(root, SCOPE, actor, specId, at, reason, [SCOPE]);

async function log(t: string) {
  const root = tmp(t);
  await ensureSidecar(root, izzie);
  return root;
}

const SPEC: Spec = {
  id: "sp_1", title: "Credit currency policy", status: "draft",
  author: opus, createdAt: "2026-08-01T00:00:00.000Z",
};
const ADD: Operation = {
  id: "op_1", specId: "sp_1", kind: "add_requirement", ord: 0,
  title: "Credit line currency", section: "Credit/Limits",
  statement: "All credit lines are in USD.", provenance: "credit policy §4",
  rationale: "policy §4 was never written down", reversibility: "reversible",
};

test("a universe's standard has its own scope", () => {
  assert.equal(standardScope("acme/api"), "standard/acme/api");
  assert.notEqual(standardScope("acme/api"), standardScope("acme/settlement"));
});

test("a requirement appears only when the spec is ratified, under an id every clone derives", async () => {
  const root = await log("ratify");
  try {
    await publishSpecDrafted(root, SCOPE, opus, SPEC);
    await publishOperation(root, SCOPE, opus, ADD);

    const draft = await fold(root);
    assert.equal(draft.specs[0]!.status, "draft");
    assert.equal(draft.requirements.length, 0, "a draft spec writes nothing to the standard");

    await ratifyWithReview(root, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {
      op_1: [{ anchorId: "a_credit", bodyHash: "h1:sha256:abc" }],
    }, ["op_1"]);

    const after = await fold(root);
    assert.equal(after.specs[0]!.status, "ratified");
    assert.equal(after.requirements.length, 1);
    const r = after.requirements[0]!;
    // Derived, not carried: the operation event was published before anything bound a
    // requirement to it, so a clone that only sees the log must compute the name itself.
    assert.equal(r.id, requirementIdFor("op_1"));
    assert.equal(r.statement, "All credit lines are in USD.");
    assert.equal(r.introducedBy, "sp_1");
    assert.ok(!("witnesses" in r), "a rule has no baseline of its own — its pointers carry one");
    assert.equal(r.origin, "sync", "a folded row is marked as the team's");
  } finally { discard(root); }
});

test("the same events fold to the same standard, which is what lets two clones agree", async () => {
  const root = await log("determinism");
  try {
    await publishSpecDrafted(root, SCOPE, opus, SPEC);
    await publishOperation(root, SCOPE, opus, ADD);
    await ratifyWithReview(root, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {}, ["op_1"]);
    const events = await readScope(root, SCOPE);
    assert.deepEqual(foldStandard(events), foldStandard(events));
    // And it could have failed: an empty log folds to something different.
    assert.notDeepEqual(foldStandard(events), foldStandard([]));
  } finally { discard(root); }
});

test("THE FOLD REFUSES AN AGENT'S ADJUDICATION, because a remote clone sees only the row", async () => {
  const root = await log("adjudicate");
  try {
    const audit: Audit = {
      id: "au_1", requirementId: "r_x", outcome: "nonconformant",
      evidence: { read: ["a_credit"] }, witnesses: [], finding: "does not enforce USD",
      auditor: opus, at: "2026-08-03T00:00:00.000Z",
    };
    const problem: Problem = {
      id: "pr_1", requirementId: "r_x", auditId: "au_1",
      summary: "creditLine does not enforce USD", raisedBy: opus, raisedAt: "2026-08-03T00:00:01.000Z",
    };
    await publishAudit(root, SCOPE, opus, audit);
    await publishProblemRaised(root, SCOPE, opus, problem);
    assert.equal((await fold(root)).problems[0]!.disposition, undefined);

    // An AGENT appends a well-formed adjudication. The tool would have refused it; the
    // fold is the only thing standing between that row and every other clone.
    await publishAdjudication(root, SCOPE, opus, "pr_1", "code-wrong", "the rule stands", "2026-08-04T00:00:00.000Z");
    assert.equal(
      (await fold(root)).problems[0]!.disposition, undefined,
      "an agent-authored adjudication must not bind anybody",
    );

    // The same act by a PRINCIPAL does bind — so the refusal is about the actor and not
    // about the event being unreadable.
    await publishAdjudication(root, SCOPE, izzie, "pr_1", "code-wrong", "the rule stands", "2026-08-05T00:00:00.000Z");
    const p = (await fold(root)).problems[0]!;
    assert.equal(p.disposition, "code-wrong");
    assert.equal(p.adjudicatedBy!.principal, "izzie@x.com");
  } finally { discard(root); }
});

/**
 * A verdict nobody defined takes a business question off the queue, on every clone.
 *
 * `adjudicate` checks the disposition against `PROBLEM_DISPOSITIONS` and refuses an empty
 * reason; the fold checked neither, so a client that skipped them bound everybody else.
 * The damage is not cosmetic and it is silent: any non-empty string counts as adjudicated,
 * so the problem leaves `awaitingAdjudication`, `moveMade`'s switch falls through to
 * `false`, and `AWAITING[…]` is undefined — the question is off the principal's queue and
 * in the fix queue for ever with nothing saying what would close it.
 */
test("THE FOLD REFUSES A VERDICT THAT IS NOT ONE, and a decision with no reason", async () => {
  const root = await log("verdict");
  try {
    await publishAudit(root, SCOPE, opus, {
      id: "au_1", requirementId: "r_x", outcome: "nonconformant", evidence: { read: ["a_1"] },
      witnesses: [], finding: "no currency check", auditor: opus, at: "2026-08-03T00:00:00.000Z",
    });
    await publishProblemRaised(root, SCOPE, opus, {
      id: "pr_1", requirementId: "r_x", auditId: "au_1",
      summary: "the rule says USD and nothing enforces one",
      raisedBy: opus, raisedAt: "2026-08-03T00:00:01.000Z",
    });

    await publishAdjudication(root, SCOPE, izzie, "pr_1", "fine, ignore it", "we discussed it", "2026-08-04T00:00:00.000Z");
    assert.equal((await fold(root)).problems[0]!.disposition, undefined,
      "an unrecognised verdict still reads as adjudicated everywhere downstream");

    await publishAdjudication(root, SCOPE, izzie, "pr_1", "code-wrong", "   ", "2026-08-05T00:00:00.000Z");
    assert.equal((await fold(root)).problems[0]!.disposition, undefined,
      "a decision with no reason leaves a later reader only the verb");

    // And the well-formed act from the same actor lands, so neither refusal above is the
    // fold simply declining to read the event.
    await publishAdjudication(root, SCOPE, izzie, "pr_1", "requirement-misstated", "the rule was always about settled float", "2026-08-06T00:00:00.000Z");
    const p = (await fold(root)).problems[0]!;
    assert.equal(p.disposition, "requirement-misstated");
    assert.equal(p.adjudicationReason, "the rule was always about settled float");
  } finally { discard(root); }
});

test("a disposition smuggled into a raise payload is dropped", async () => {
  const root = await log("smuggle");
  try {
    await publishAudit(root, SCOPE, opus, {
      id: "au_1", requirementId: "r_x", outcome: "nonconformant", evidence: { read: ["a_1"] },
      witnesses: [], finding: "no", auditor: opus, at: "2026-08-03T00:00:00.000Z",
    });
    await publishProblemRaised(root, SCOPE, opus, {
      id: "pr_1", requirementId: "r_x", auditId: "au_1", summary: "smuggled",
      raisedBy: opus, raisedAt: "2026-08-03T00:00:01.000Z",
      disposition: "code-wrong", adjudicatedBy: opus, adjudicatedAt: "2026-08-03T00:00:01.000Z",
    } as Problem);

    const p = (await fold(root)).problems[0]!;
    assert.equal(p.disposition, undefined, "a raise carries no verdict, whatever the payload says");
    // Every adjudication field, not only the verdict. Stripping `disposition` alone left
    // a problem naming a decider who never decided, which is how this test earned its keep.
    assert.equal(p.adjudicatedBy, undefined);
    assert.equal(p.adjudicatedAt, undefined);
    assert.equal(p.adjudicationReason, undefined);
  } finally { discard(root); }
});

test("an acknowledgement grants and releases across the log", async () => {
  const root = await log("ack");
  try {
    // The draft and its operation first: a gap names the operation it was raised against,
    // and the fold verifies that rather than trusting the record.
    await publishSpecDrafted(root, SCOPE, opus, SPEC);
    await publishOperation(root, SCOPE, opus, ADD);
    const ack: Acknowledgement = {
      id: "ack_1", basis: "gap", operationId: "op_1", rationale: "nothing built yet",
      priority: "medium", revalidateBy: "2027-01-01", state: "active",
      grantedBy: opus, grantedAt: "2026-08-01T00:00:00.000Z",
    };
    await publishAckGranted(root, SCOPE, opus, ack);
    // PENDING: a gap is part of an argument nobody has adopted yet, so it silences nothing
    // until ratification binds it — in the same act that creates the rule.
    assert.equal((await fold(root)).acknowledgements[0]!.state, "pending");

    await publishAckReleased(root, SCOPE, izzie, "ack_1", "2026-08-06T00:00:00.000Z", "the endpoints now key");
    const a = (await fold(root)).acknowledgements[0]!;
    assert.equal(a.state, "released");
    assert.equal(a.releasedReason, "the endpoints now key");
  } finally { discard(root); }
});

test("the projection round-trips what the fold produced", async () => {
  const root = await log("projection");
  const store = tmp("store");
  try {
    await publishSpecDrafted(root, SCOPE, opus, SPEC);
    await publishOperation(root, SCOPE, opus, ADD);
    // The gap is granted while the spec is still a DRAFT — the only time one can be — and
    // ratification then binds it to the rule the operation produced. Granting it after the
    // ratification, as this fixture used to, is the post-hoc mint the fold now refuses.
    await publishAckGranted(root, SCOPE, opus, {
      id: "ack_1", basis: "gap", operationId: "op_1", rationale: "nothing built yet",
      priority: "medium", revalidateBy: "2027-01-01", state: "active",
      grantedBy: opus, grantedAt: "2026-08-01T00:00:00.000Z",
    });
    await ratifyWithReview(root, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {}, ["op_1"]);
    const value = await fold(root);
    assert.ok(value.requirements.length && value.acknowledgements.length, "the fixture must be non-empty or the round trip is vacuous");

    const d = db(store);
    standardProjection.write(d, SCOPE, value);
    assert.deepEqual(standardProjection.read(d, SCOPE), value, "read(write(x)) === x");

    // And it replaces only what it owns: a second write does not accumulate.
    standardProjection.write(d, SCOPE, value);
    assert.deepEqual(standardProjection.read(d, SCOPE), value);

    // Another universe's scope is untouched by this one's rows.
    assert.deepEqual(standardProjection.read(d, standardScope("acme/settlement")), emptyStandard());
  } finally { discard(root); discard(store); }
});

test("a spec ratifies once, so a replayed or duplicated event cannot apply it twice", async () => {
  const root = await log("idempotent");
  try {
    await publishSpecDrafted(root, SCOPE, opus, SPEC);
    await publishOperation(root, SCOPE, opus, ADD);
    await ratifyWithReview(root, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {}, ["op_1"]);
    const once = await fold(root);

    // A second ratification of the same spec. A fold that applied it again would amend
    // the rule a second time, and `amendedBy` would grow on every sync — the shape of bug
    // that only appears after a clone has synced more than once.
    await ratifyWithReview(root, SCOPE, izzie, "sp_1", "2026-08-09T00:00:00.000Z", {}, ["op_1"]);
    const twice = await fold(root);
    assert.deepEqual(twice.requirements, once.requirements, "applying a spec is idempotent");
    assert.equal(twice.specs[0]!.ratifiedAt, "2026-08-02T00:00:00.000Z", "and the first adoption is the one that counts");
  } finally { discard(root); }
});

/**
 * The three gates below existed in the tools and NOT in the fold, which means they bound
 * only the machine that ran them. `sharing-boundary.test.ts` states the rule this file
 * broke: a publish check binds writers who ask, and the fold is the only gate that binds a
 * writer this build did not write — an older client, a hand-written line, a future one
 * that forgets.
 */
test("the fold refuses an agent's debt acknowledgement", async () => {
  const root = await log("ackgate");
  try {
    const base = {
      id: "ack_1", basis: "debt" as const, requirementId: "r_x", rationale: "living with it",
      priority: "high" as const, revalidateBy: "2027-01-01", state: "active" as const,
      grantedAt: "2026-08-01T00:00:00.000Z",
    };
    await publishAckGranted(root, SCOPE, opus, { ...base, grantedBy: opus });
    assert.equal(
      (await fold(root)).acknowledgements.length, 0,
      "accepting non-conformance is an admission with an owner; an agent has none",
    );

    // A gap from an agent IS legitimate — an auditor classifying ahead of adoption is the
    // intended caller — so the refusal must be about the basis, not about the actor alone.
    // The draft spec and its operation have to be in the log for that: a gap names the
    // OPERATION it was raised against, and the fold checks it rather than taking the
    // record's word. This test used to publish neither and assert the gap bound anyway.
    await publishSpecDrafted(root, SCOPE, opus, SPEC);
    await publishOperation(root, SCOPE, opus, ADD);
    await publishAckGranted(root, SCOPE, opus, {
      ...base, id: "ack_2", basis: "gap", operationId: ADD.id, requirementId: undefined, grantedBy: opus,
    });
    assert.equal((await fold(root)).acknowledgements.length, 1);

    await publishAckGranted(root, SCOPE, izzie, { ...base, id: "ack_3", grantedBy: izzie });
    assert.equal((await fold(root)).acknowledgements.length, 2, "a principal's debt binds");
  } finally { discard(root); }
});

test("THE FOLD REFUSES A GAP MINTED AFTER RATIFICATION, which is the third laundering door", async () => {
  // Not "amend the rule to match the code" but "declare the rule not yet applicable".
  // `acknowledgeGap` closes it by taking an operation in a DRAFT spec — and the schema
  // calls that "structural rather than advisory" — but the fold took the record's word,
  // so a client that appended the row directly had it accepted by every clone and
  // `conformance()` reported a binding rule as `gap`.
  const root = await log("gapmint");
  try {
    const base = {
      basis: "gap" as const, rationale: "nothing implements it yet", priority: "low" as const,
      revalidateBy: "2027-01-01", state: "active" as const,
      grantedAt: "2026-08-01T00:00:00.000Z", grantedBy: opus,
    };
    await publishSpecDrafted(root, SCOPE, opus, SPEC);
    await publishOperation(root, SCOPE, opus, ADD);

    // No operation at all, aimed straight at a rule — the shape the local path cannot mint.
    await publishAckGranted(root, SCOPE, opus, {
      ...base, id: "ack_bare", requirementId: requirementIdFor(ADD.id),
    });
    assert.equal((await fold(root)).acknowledgements.length, 0,
      "a gap that names no operation was minted by something that skipped the gate");

    // Before ratification: legitimate.
    await publishAckGranted(root, SCOPE, opus, { ...base, id: "ack_before", operationId: ADD.id });
    assert.equal((await fold(root)).acknowledgements.length, 1);

    await ratifyWithReview(root, SCOPE, izzie, SPEC.id, "2026-08-02T00:00:00.000Z", {}, [ADD.id]);
    assert.equal((await fold(root)).requirements.length, 1, "the rule is now binding");

    // After ratification, naming the very same operation: refused.
    await publishAckGranted(root, SCOPE, opus, { ...base, id: "ack_after", operationId: ADD.id });
    assert.equal((await fold(root)).acknowledgements.length, 1,
      "once the rule binds, `gap` is no longer an available answer — that is the asymmetry");

    // And the route `acknowledgements.ts` names outright: draft a SECOND spec amending the
    // now-ratified rule, gap the amendment, ratify. The amendment is an operation on a
    // draft spec, so only the operation's KIND stands between that and a binding rule
    // reported as `gap` on an agent's say-so.
    const amend: Operation = {
      id: "op_2", specId: "sp_2", kind: "amend_statement", ord: 0,
      requirementId: requirementIdFor(ADD.id), statement: "All credit lines are in USD or EUR.",
      rationale: "the business moved", reversibility: "reversible",
    };
    await publishSpecDrafted(root, SCOPE, opus, { ...SPEC, id: "sp_2", title: "Currency amendment" });
    await publishOperation(root, SCOPE, opus, amend);
    await publishAckGranted(root, SCOPE, opus, { ...base, id: "ack_amend", operationId: amend.id });
    assert.equal((await fold(root)).acknowledgements.length, 1,
      "a gap may only be raised against the operation that INTRODUCES a rule, never one amending it");
  } finally { discard(root); }
});

test("the fold refuses a conformant audit that touched no code", async () => {
  const root = await log("auditgate");
  try {
    const base: Audit = {
      id: "au_1", requirementId: "r_x", outcome: "conformant", evidence: {},
      witnesses: [], finding: "looks fine to me", auditor: opus, at: "2026-08-03T00:00:00.000Z",
    };
    await publishAudit(root, SCOPE, opus, base);
    assert.equal(
      (await fold(root)).audits.length, 0,
      "a doc-only or evidence-free certification must not reach `conformant` from anywhere",
    );

    await publishAudit(root, SCOPE, opus, {
      ...base, id: "au_2", evidence: { read: ["a_credit"] },
      witnesses: [{ anchorId: "a_credit", bodyHash: "h1:sha256:abc" }],
    });
    assert.equal((await fold(root)).audits.length, 1, "one that read code does bind");

    // A command that FAILED is evidence of NON-conformance, and this end used to count any
    // nonempty `ran` — so `false` certified a rule for every clone while `audits.ts` refused
    // the identical audit locally. The case the original test never reached: it checked an
    // absent `ran` and a present `read`, so the difference between the two ends was invisible.
    await publishAudit(root, SCOPE, opus, {
      ...base, id: "au_3", evidence: { ran: [{ command: "false", passed: false }] },
    });
    assert.equal(
      (await fold(root)).audits.length, 1,
      "a failed command is not a certification — the fold must not be laxer than `touchedCode`",
    );

    // Nor may it omit the command. `{passed: true}` names nothing that ran, and where the
    // requirement cites code the citations become witnesses, so the result reads as
    // code-backed. `recordAudit` refuses this outright; the fold has no such second check,
    // so its copy of the predicate is the only thing standing here.
    await publishAudit(root, SCOPE, opus, {
      ...base, id: "au_4", evidence: { ran: [{ passed: true } as never] },
    });
    assert.equal(
      (await fold(root)).audits.length, 1,
      "an entry with no command records nothing, and a positive audit that records nothing is not one",
    );

    // A passing command and NO WITNESSES. This used to bind, and the assertion here said
    // so — `touchedCode` accepts `ran` alone, so nothing at this end asked what could later
    // move under the claim. `serveWith` treats an empty witness list as never-superseded,
    // so `conformant` was PERMANENT on every clone and survived a rewrite of the code the
    // command was run against. `recordAudit` has always refused it; this end had not.
    await publishAudit(root, SCOPE, opus, {
      ...base, id: "au_5", evidence: { ran: [{ command: "npm test", passed: true }] },
    });
    assert.equal(
      (await fold(root)).audits.length, 1,
      "a claim nothing can ever invalidate is not a claim, at the fold as at the writer",
    );

    await publishAudit(root, SCOPE, opus, {
      ...base, id: "au_5b", evidence: { read: ["a_credit"], ran: [{ command: "npm test", passed: true }] },
      witnesses: [{ anchorId: "a_credit", bodyHash: "h1:sha256:abc" }],
    });
    assert.equal((await fold(root)).audits.length, 2, "a command that PASSED, over code that can move, does bind");

    // Absence of evidence must never FILE either. "I could not verify this" is an
    // unverified requirement, not a violation — the 138-false-positives gate, restated
    // where it binds a writer whose tool never applied it.
    await publishAudit(root, SCOPE, opus, { ...base, id: "au_nc", outcome: "nonconformant", evidence: {} });
    assert.equal((await fold(root)).audits.length, 2, "a non-conformance nobody demonstrated is not one");

    await publishAudit(root, SCOPE, opus, {
      ...base, id: "au_nc2", outcome: "nonconformant", evidence: { consulted: ["the settlement doc"] },
    });
    assert.equal((await fold(root)).audits.length, 3, "doc-only is enough to FILE, and never enough to certify");

    // `indeterminate` is the quiet bucket and may carry nothing, so the gate is about the
    // OUTCOME rather than about evidence being present.
    await publishAudit(root, SCOPE, opus, { ...base, id: "au_6", outcome: "indeterminate" });
    assert.equal((await fold(root)).audits.length, 4);
  } finally { discard(root); }
});

test("the fold drops provisional work, which is never the team's", async () => {
  const root = await log("provgate");
  try {
    await publishAudit(root, SCOPE, opus, {
      id: "au_1", requirementId: "r_x", outcome: "nonconformant", evidence: { read: ["a_1"] },
      witnesses: [], finding: "broken on my branch", auditor: opus,
      at: "2026-08-03T00:00:00.000Z", provisional: true,
    });
    await publishProblemRaised(root, SCOPE, opus, {
      id: "pr_1", requirementId: "r_x", auditId: "au_1", summary: "branch-local",
      raisedBy: opus, raisedAt: "2026-08-03T00:00:01.000Z", provisional: true,
    });
    const f = await fold(root);
    assert.equal(f.audits.length, 0, "a branch audit is about work in progress, not the codebase");
    assert.equal(f.problems.length, 0, "and so is a problem raised from one");
  } finally { discard(root); }
});

test("the fold refuses an agent's ratification", async () => {
  const root = await log("ratifygate");
  try {
    await publishSpecDrafted(root, SCOPE, opus, SPEC);
    await publishOperation(root, SCOPE, opus, ADD);
    // Reviewed by the PERSON, ratified by the agent — so the only thing left to refuse
    // this is the agent gate under test. Letting the agent sign off too would make the
    // test pass for two reasons and pin neither.
    await ratifyWithReview(root, SCOPE, opus, "sp_1", "2026-08-02T00:00:00.000Z", {}, ["op_1"], izzie);
    const f = await fold(root);
    assert.equal(f.requirements.length, 0, "adoption is a principal's act on every clone, not only on the one that ran the tool");
    assert.equal(f.specs[0]!.status, "draft");

    await ratifyWithReview(root, SCOPE, izzie, "sp_1", "2026-08-03T00:00:00.000Z", {}, ["op_1"]);
    assert.equal((await fold(root)).requirements.length, 1, "and a principal's does bind");
  } finally { discard(root); }
});

test("the fold refuses a spec adopted against a base that had already moved", async () => {
  const root = await log("foldcontext");
  try {
    await publishSpecDrafted(root, SCOPE, opus, SPEC);
    await publishOperation(root, SCOPE, opus, ADD);
    await ratifyWithReview(root, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {}, ["op_1"]);
    const rid = requirementIdFor("op_1");

    // Two principals, each drafting against "All credit lines are in USD." on their own
    // clone. The local check passes for BOTH — the log is pull/push and is never read on
    // an ordinary read — so the fold is the only thing that can catch it.
    const amend = (id: string, statement: string): Operation => ({
      id, specId: id.replace("op", "sp"), kind: "amend_statement", ord: 0, requirementId: rid,
      statement, rationale: "r", reversibility: "reversible",
      context: { requirementId: rid, statement: "All credit lines are in USD." },
    });
    for (const [sid, oid, text] of [["sp_a", "op_a", "USD, except settlement float."], ["sp_b", "op_b", "USD and EUR."]] as const) {
      await publishSpecDrafted(root, SCOPE, izzie, { ...SPEC, id: sid, title: sid });
      await publishOperation(root, SCOPE, izzie, amend(oid, text));
    }
    await ratifyWithReview(root, SCOPE, izzie, "sp_a", "2026-08-03T00:00:00.000Z", {}, ["op_a"]);
    assert.match((await fold(root)).requirements[0]!.statement, /settlement float/);

    await ratifyWithReview(root, SCOPE, izzie, "sp_b", "2026-08-04T00:00:00.000Z", {}, ["op_b"]);
    const after = await fold(root);
    assert.match(
      after.requirements[0]!.statement, /settlement float/,
      "B was drafted against text A has since replaced; applying it would erase an amendment a principal ratified",
    );
    assert.equal(after.specs.find((x) => x.id === "sp_b")!.conflicted, true, "and the spec says why nothing landed");
  } finally { discard(root); }
});

test("a ratification adopts exactly the operations it pinned", async () => {
  const root = await log("pinned");
  try {
    await publishSpecDrafted(root, SCOPE, opus, SPEC);
    await publishOperation(root, SCOPE, opus, ADD);
    // An operation from an un-synced clone, landing before the ratification in the log's
    // total order. Collecting by specId at replay time would adopt it, though the principal
    // never saw it in the diff they approved.
    await publishOperation(root, SCOPE, opus, {
      ...ADD, id: "op_sneak", ord: 1, title: "Unapproved", section: "Credit/Other",
      statement: "Something nobody reviewed.",
    });
    await ratifyWithReview(root, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {}, ["op_1"]);

    const f = await fold(root);
    assert.equal(f.requirements.length, 1, "only what was pinned");
    assert.equal(f.requirements[0]!.id, requirementIdFor("op_1"));
  } finally { discard(root); }
});

const ADD_CRITERION: Operation = {
  id: "op_2", specId: "sp_1", kind: "add_criterion", ord: 1, targetOperationId: "op_1",
  criterion: "Every credit line row stores USD.", falsifier: "A row exists in another currency.",
  evidenceKind: "lint-test",
  rationale: "so the rule has a detector", reversibility: "reversible",
};

/**
 * A criterion is DERIVED by replaying operations, exactly as a requirement is.
 *
 * That is why `criterionIdFor` is a function of the operation: the fold mints it on every
 * clone independently, and a random id would give each machine its own name for the same
 * criterion — a failure invisible locally, where there is only ever one clone.
 */
test("a ratified add_criterion folds to a criterion, under an id every clone derives", async () => {
  const root = await log("criterion");
  try {
    await publishSpecDrafted(root, SCOPE, opus, SPEC);
    await publishOperation(root, SCOPE, opus, ADD);
    await publishOperation(root, SCOPE, opus, ADD_CRITERION);

    assert.equal((await fold(root)).criteria.length, 0, "a draft spec writes no criteria either");

    await ratifyWithReview(root, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {
      // The criterion witnesses its ASSERTION; the requirement witnesses the rule's code.
      op_1: [{ anchorId: "a_credit", bodyHash: "h1:sha256:abc" }],
      op_2: [{ anchorId: "a_lint", bodyHash: "h1:sha256:def" }],
    }, ["op_1", "op_2"]);

    const after = await fold(root);
    assert.equal(after.criteria.length, 1);
    const c = after.criteria[0]!;
    assert.equal(c.id, criterionIdFor("op_2"));
    assert.equal(c.requirementId, requirementIdFor("op_1"), "bound to the rule its own spec created");
    assert.equal(c.falsifier, "A row exists in another currency.");
    // No witnesses ON the criterion any more: the check's address is a detector `Pointer`,
    // which carries them in the universe the check actually lives in.
    assert.equal((c as { witnesses?: unknown }).witnesses, undefined);
    // And the operation row is bound too, or `readOperations({requirementId})` is not the
    // rule's whole history on any clone that folded it.
    assert.equal(after.operations.find((o) => o.id === "op_2")!.requirementId, requirementIdFor("op_1"));
  } finally { discard(root); }
});

/**
 * The evidence gate on a demonstration, at the end that binds every clone.
 *
 * `recordVacuityCheck` refuses this, but the tool binds only writers who ask — an older
 * client, a hand-written line, a future build. This subsystem has shipped that mistake
 * four times (see `sharing-boundary.test.ts` §BOTH_ENDS), always in this direction.
 */
/** A ratified spec that really creates the criterion the checks below are about. */
async function withCriterion(root: string): Promise<string> {
  await publishSpecDrafted(root, SCOPE, opus, SPEC);
  await publishOperation(root, SCOPE, opus, ADD);
  await publishOperation(root, SCOPE, opus, ADD_CRITERION);
  await ratifyWithReview(root, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {
    op_2: [{ anchorId: "a_lint", bodyHash: "h1:sha256:def" }],
  }, ["op_1", "op_2"]);
  return criterionIdFor("op_2");
}

test("the fold drops a `demonstrated` vacuity check that records no method", async () => {
  const root = await log("vacuity");
  try {
    // A REAL criterion: a check against an id nothing created is a verdict about nothing,
    // and the fold now refuses it — which would make every assertion below pass for the
    // wrong reason.
    const criterionId = await withCriterion(root);
    const base = {
      criterionId, witnesses: [{ anchorId: "a_lint", bodyHash: "h1:sha256:def" }],
      checkedBy: opus, at: "2026-08-03T00:00:00.000Z",
    };
    await publishVacuityCheck(root, SCOPE, opus, { ...base, id: "vc_1", verdict: "demonstrated", method: "" });
    assert.deepEqual((await fold(root)).vacuityChecks, [], "a demonstration recording nothing is not a demonstration");

    // A verdict that WEAKENS a criterion needs no method — its failure mode is noise, and
    // gating it would gate what unsilences.
    await publishVacuityCheck(root, SCOPE, opus, { ...base, id: "vc_2", verdict: "vacuous", method: "" });
    assert.deepEqual((await fold(root)).vacuityChecks.map((v) => v.id), ["vc_2"]);

    // And a real demonstration lands.
    await publishVacuityCheck(root, SCOPE, opus, {
      ...base, id: "vc_3", verdict: "demonstrated", method: "inverted the currency check; 3 sites went red",
    });
    assert.deepEqual((await fold(root)).vacuityChecks.map((v) => v.id), ["vc_2", "vc_3"]);

    // A verdict this build does not model is dropped rather than folded as something else.
    await publishVacuityCheck(root, SCOPE, opus, { ...base, id: "vc_4", verdict: "fine" as never, method: "x" });
    assert.deepEqual((await fold(root)).vacuityChecks.map((v) => v.id), ["vc_2", "vc_3"]);
  } finally { discard(root); }
});

const PTR = {
  id: "pt_1", requirementId: "r_x", target: { kind: "node" as const, id: "n_credit" },
  rationale: "the doc describing the pattern",
  witnesses: [{ anchorId: "a_credit", bodyHash: "h1:sha256:abc" }],
  state: "active" as const, declaredBy: opus, declaredAt: "2026-08-11T00:00:00.000Z",
};

/**
 * Pointers ARE acts, unlike requirements and criteria — somebody decided where to look,
 * so there is an honest actor and an honest causal position and they enter the log
 * directly rather than being derived by replaying operations.
 */
test("a pointer folds through its three acts, and the guards bind at this end too", async () => {
  const root = await log("pointer");
  try {
    await publishPointerDeclared(root, SCOPE, opus, PTR);
    let p = (await fold(root)).pointers;
    assert.equal(p.length, 1);
    assert.equal(p[0]!.state, "active");
    assert.equal(p[0]!.origin, "sync");

    await publishPointerRestated(root, SCOPE, izzie, "pt_1", "2026-08-12T00:00:00.000Z",
      [{ anchorId: "a_credit", bodyHash: "h1:sha256:NEW" }]);
    p = (await fold(root)).pointers;
    assert.deepEqual(p[0]!.witnesses, [{ anchorId: "a_credit", bodyHash: "h1:sha256:NEW" }]);
    assert.equal(p[0]!.restatedBy?.principal, izzie.principal);

    // A retirement with no reason is a rule quietly losing what watches it, which is how a
    // standard comes to look settled. Refused in the tool AND here — the tool binds only
    // writers who ask, and this subsystem has shipped the one-end version four times.
    await publishPointerRetired(root, SCOPE, opus, "pt_1", "2026-08-13T00:00:00.000Z", "  ");
    assert.equal((await fold(root)).pointers[0]!.state, "active", "still watching");

    await publishPointerRetired(root, SCOPE, opus, "pt_1", "2026-08-13T00:00:00.000Z", "the doc was folded away");
    p = (await fold(root)).pointers;
    assert.equal(p[0]!.state, "retired");
    assert.equal(p[0]!.retiredReason, "the doc was folded away");
  } finally { discard(root); }
});

test("the fold refuses a pointer nobody can evaluate, and one that arrives pre-retired", async () => {
  const root = await log("pointer-guards");
  try {
    await publishPointerDeclared(root, SCOPE, opus, { ...PTR, id: "pt_mute", rationale: "   " });
    assert.deepEqual((await fold(root)).pointers.map((x) => x.id), [], "no rationale, nothing to judge");

    await publishPointerDeclared(root, SCOPE, opus, { ...PTR, id: "pt_bad", target: { kind: "spec" as never, id: "x" } });
    assert.deepEqual((await fold(root)).pointers.map((x) => x.id), [], "a target kind this build does not model");

    // A `declared` event carrying retirement fields would fold to a pointer that never
    // watched anything and cannot be retired again — the partial-strip shape that let
    // `problem.raised` name a decider who never decided.
    await publishPointerDeclared(root, SCOPE, opus, {
      ...PTR, id: "pt_sneaky", state: "retired" as never,
      retiredBy: opus, retiredAt: "2026-08-01T00:00:00.000Z", retiredReason: "pre-retired",
    });
    const p = (await fold(root)).pointers;
    assert.deepEqual(p.map((x) => x.id), ["pt_sneaky"]);
    assert.equal(p[0]!.state, "active", "declaring is declaring, whatever the payload said");
    assert.equal(p[0]!.retiredReason, undefined, "and every retirement field is stripped, not just the state");
  } finally { discard(root); }
});

const POP = {
  id: "pop_1", requirementId: "r_x", basis: "lint" as const, lint: ["a_lint"],
  witnesses: [{ anchorId: "a_lint", bodyHash: "h1:sha256:abc" }],
  members: [{ id: "GET /orders", state: "conforms" as const }, { id: "GET /invoices", state: "violates" as const }],
  state: "active" as const, pinnedBy: izzie, pinnedAt: "2026-08-14T00:00:00.000Z",
};

test("a population pin folds, and supersedes the one it names in the same act", async () => {
  const root = await log("population");
  try {
    await publishPopulationPinned(root, SCOPE, izzie, POP);
    assert.deepEqual((await fold(root)).populations.map((p) => [p.id, p.state]), [["pop_1", "active"]]);

    // Superseding rides WITH the pin. Two events would let a clone fold half of it and
    // hold two active populations for one rule.
    const wider = {
      ...POP, id: "pop_2", pinnedAt: "2026-08-15T00:00:00.000Z",
      members: [...POP.members, { id: "GET /credits", state: "violates" as const }],
    };
    await publishPopulationPinned(root, SCOPE, izzie, wider, "pop_1");
    const after = (await fold(root)).populations;
    assert.deepEqual(after.map((p) => [p.id, p.state]), [["pop_1", "superseded"], ["pop_2", "active"]]);
  } finally { discard(root); }
});

/**
 * The two gates that only this end can enforce.
 *
 * An empty lint pin is green reading as conformant; a NARROWING re-pin by an agent can flip
 * debt into a gap, which is silencing. `pinPopulation` refuses both — and the tool binds
 * only writers who ask, which is the one-end mistake this subsystem has shipped four times.
 */
test("the fold refuses an empty pin, and an agent narrowing a population", async () => {
  const root = await log("population-guards");
  try {
    await publishPopulationPinned(root, SCOPE, izzie, { ...POP, id: "pop_empty", members: [] });
    assert.deepEqual((await fold(root)).populations.map((p) => p.id), [], "zero members is green, and green reads as conformant");

    await publishPopulationPinned(root, SCOPE, izzie, { ...POP, id: "pop_bad", members: [{ id: "x", state: "maybe" as never }] });
    assert.deepEqual((await fold(root)).populations.map((p) => p.id), [], "a member state this build does not model");

    await publishPopulationPinned(root, SCOPE, izzie, {
      ...POP, id: "pop_mute", basis: "not-expressible", lint: [], witnesses: [], members: [], reason: "  ",
    });
    assert.deepEqual((await fold(root)).populations.map((p) => p.id), [], "the one basis nothing can check needs its argument");

    await publishPopulationPinned(root, SCOPE, izzie, POP);
    assert.deepEqual((await fold(root)).populations.map((p) => p.id), ["pop_1"], "and a real one lands");

    // An AGENT dropping the violating member. Decided here from the two member lists the
    // writer had, not from the writer's word about what it was doing.
    await publishPopulationPinned(root, SCOPE, opus, {
      ...POP, id: "pop_narrow", pinnedAt: "2026-08-16T00:00:00.000Z",
      members: [{ id: "GET /orders", state: "conforms" as const }],
    }, "pop_1");
    let p = (await fold(root)).populations;
    assert.deepEqual(p.map((x) => [x.id, x.state]), [["pop_1", "active"]], "narrowing is a principal's act");

    // The same agent WIDENING is fine — gate what silences, never what unsilences.
    await publishPopulationPinned(root, SCOPE, opus, {
      ...POP, id: "pop_wide", pinnedAt: "2026-08-17T00:00:00.000Z",
      members: [...POP.members, { id: "GET /credits", state: "violates" as const }],
    }, "pop_1");
    p = (await fold(root)).populations;
    assert.deepEqual(p.map((x) => [x.id, x.state]), [["pop_1", "superseded"], ["pop_wide", "active"]]);
  } finally { discard(root); }
});

/**
 * A scrub is an AUDIT with a covering trigger, so the gates ride on `audit.recorded`.
 * There is no second event and no second table — two records both meaning "somebody checked
 * this rule" is how one of them stops participating in conformance.
 */
test("a covering audit folds, and the fold restates the gates the tool cannot bind", async () => {
  const root = await log("scrub");
  try {
    const base = {
      id: "sc_1", requirementId: "r_x", outcome: "indeterminate" as const, evidence: {},
      observations: [] as { pointerId: string; firing: boolean }[],
      finding: "looked; nothing watches it", trigger: "scrub" as const,
      witnesses: [], auditor: opus, at: "2026-08-18T00:00:00.000Z",
    };
    await publishAudit(root, SCOPE, opus, base);
    assert.deepEqual((await fold(root)).scrubs.map((s) => s.id), ["sc_1"]);

    // A scrub that records nothing is the vacuous check this mechanism exists to detect,
    // one level up. Refused at both ends.
    await publishAudit(root, SCOPE, opus, { ...base, id: "sc_mute", finding: "   " });
    assert.deepEqual((await fold(root)).scrubs.map((s) => s.id), ["sc_1"]);

    await publishAudit(root, SCOPE, opus, { ...base, id: "sc_bad", trigger: "invented" as never });
    assert.deepEqual((await fold(root)).scrubs.map((s) => s.id), ["sc_1"]);

    // And the observation gate, which needs a pointer to exist to be meaningful: a scrub
    // that skips an ACTIVE pointer buys a fresh coverage period without having looked at
    // it. The fold reads the pointer state from its OWN map — the team's view of what was
    // active, not the writer's account of it.
    await publishPointerDeclared(root, SCOPE, opus, { ...PTR, id: "pt_w", requirementId: "r_x" });
    await publishAudit(root, SCOPE, opus, { ...base, id: "sc_skip", at: "2026-08-19T00:00:00.000Z" });
    assert.deepEqual((await fold(root)).scrubs.map((s) => s.id), ["sc_1"], "an omitted pointer is an unlooked-at rule");

    await publishAudit(root, SCOPE, opus, {
      ...base, id: "sc_full", at: "2026-08-20T00:00:00.000Z",
      observations: [{ pointerId: "pt_w", firing: true }],
    });
    assert.deepEqual((await fold(root)).scrubs.map((s) => s.id), ["sc_1", "sc_full"]);
  } finally { discard(root); }
});

test("the scrub policy is one decision, and one that cannot do its job is dropped", async () => {
  const root = await log("scrub-policy");
  try {
    assert.equal((await fold(root)).scrubPolicy, null, "unstated is its own answer");

    await publishScrubPolicy(root, SCOPE, izzie, { coverageDays: 0, minObservations: 3, setBy: izzie, setAt: "2026-08-18T00:00:00.000Z" });
    assert.equal((await fold(root)).scrubPolicy, null, "a period of zero covers nothing");

    await publishScrubPolicy(root, SCOPE, izzie, { coverageDays: 30, minObservations: 1, setBy: izzie, setAt: "2026-08-18T00:00:00.000Z" });
    assert.equal((await fold(root)).scrubPolicy, null, "a rate from one look is not a rate");

    await publishScrubPolicy(root, SCOPE, izzie, { coverageDays: 30, minObservations: 3, setBy: izzie, setAt: "2026-08-19T00:00:00.000Z" });
    assert.equal((await fold(root)).scrubPolicy!.coverageDays, 30);

    // A policy is a decision and two of them is no policy — the last one wins.
    await publishScrubPolicy(root, SCOPE, izzie, { coverageDays: 7, minObservations: 5, setBy: izzie, setAt: "2026-08-20T00:00:00.000Z" });
    const p = (await fold(root)).scrubPolicy!;
    assert.deepEqual([p.coverageDays, p.minObservations], [7, 5]);
  } finally { discard(root); }
});

/**
 * The fold must find the pin being replaced ITSELF, never take the writer's word for it.
 *
 * This is the shape the `ack.granted` case already names — *"the fold took the record's
 * word for it"* — arriving at the newest record in the subsystem. An event that simply
 * omits `supersedes` was accepted verbatim: the narrowing gate never ran, and the rule was
 * left holding TWO active populations, which is a state nothing else models.
 */
test("an agent cannot narrow a population by omitting what it supersedes", async () => {
  const root = await log("population-supersede");
  try {
    await publishPopulationPinned(root, SCOPE, izzie, POP);
    assert.deepEqual((await fold(root)).populations.map((p) => [p.id, p.state]), [["pop_1", "active"]]);

    // No `supersedes`, and the member list drops the violating one. Under a fold that
    // trusts the field, this lands active beside pop_1 with the gate never consulted.
    await publishPopulationPinned(root, SCOPE, opus, {
      ...POP, id: "pop_sneak", pinnedAt: "2026-08-20T00:00:00.000Z",
      members: [{ id: "GET /orders", state: "conforms" as const }],
    });
    const p = (await fold(root)).populations;
    assert.deepEqual(p.map((x) => [x.id, x.state]), [["pop_1", "active"]],
      "narrowing is a principal's act however the event describes itself");
  } finally { discard(root); }
});

/**
 * And one rule never holds two active populations, whatever order the shards arrive in.
 *
 * A superseding event can fold BEFORE the pin it names — an un-synced clone's shard sorts
 * where the log puts it, not where the writer expected — which is the same ordering hazard
 * `spec.ratified` pins its operation list against.
 */
test("a rule holds exactly one active population, whatever order the events arrive in", async () => {
  const root = await log("population-order");
  try {
    // The superseding pin arrives FIRST, naming a pin this fold has not seen.
    await publishPopulationPinned(root, SCOPE, izzie, {
      ...POP, id: "pop_late", pinnedAt: "2026-08-20T00:00:00.000Z",
      members: [...POP.members, { id: "GET /credits", state: "violates" as const }],
    }, "pop_1");
    await publishPopulationPinned(root, SCOPE, izzie, POP);

    const active = (await fold(root)).populations.filter((p) => p.state === "active");
    assert.equal(active.length, 1, "two active populations for one rule is a state nothing models");
  } finally { discard(root); }
});

test("the fold blocks an agent erasing a populated rule by declaring it inexpressible", async () => {
  const root = await log("population-inexpressible");
  try {
    await publishPopulationPinned(root, SCOPE, izzie, POP);
    // Replacing a lint pin of 2 members with "no lint can express this" drops both — it is
    // narrowing at its limit, and it reaches the gate through a different door than a
    // shorter member list does.
    await publishPopulationPinned(root, SCOPE, opus, {
      ...POP, id: "pop_ne", basis: "not-expressible", lint: [], witnesses: [], members: [],
      reason: "spans two repos", pinnedAt: "2026-08-21T00:00:00.000Z",
    });
    assert.deepEqual((await fold(root)).populations.map((p) => [p.id, p.state]), [["pop_1", "active"]]);

    // A principal may, and then it is the active one.
    await publishPopulationPinned(root, SCOPE, izzie, {
      ...POP, id: "pop_ne2", basis: "not-expressible", lint: [], witnesses: [], members: [],
      reason: "spans two repos", pinnedAt: "2026-08-22T00:00:00.000Z",
    });
    assert.deepEqual((await fold(root)).populations.map((p) => [p.id, p.state]),
      [["pop_1", "superseded"], ["pop_ne2", "active"]]);
  } finally { discard(root); }
});

test("the fold refuses a covering audit observing pointers that are not on the rule", async () => {
  const root = await log("scrub-phantom");
  try {
    await publishPointerDeclared(root, SCOPE, opus, { ...PTR, id: "pt_mine", requirementId: "r_x" });
    await publishPointerDeclared(root, SCOPE, opus, { ...PTR, id: "pt_other", requirementId: "r_other" });
    const base = {
      id: "sc_1", requirementId: "r_x", finding: "looked", outcome: "indeterminate" as const,
      evidence: {}, witnesses: [], trigger: "scrub" as const, auditor: opus, at: "2026-08-23T00:00:00.000Z",
    };
    // A phantom fabricates history for a pointer on ANOTHER rule: `pointerRates` tallies by
    // pointer id and takes the rule from the first scrub that mentions it.
    await publishAudit(root, SCOPE, opus, {
      ...base, observations: [{ pointerId: "pt_mine", firing: false }, { pointerId: "pt_other", firing: true }],
    });
    assert.deepEqual((await fold(root)).scrubs.map((s) => s.id), []);

    // The same pointer twice reaches `minObservations` from one look.
    await publishAudit(root, SCOPE, opus, {
      ...base, id: "sc_dup",
      observations: [{ pointerId: "pt_mine", firing: false }, { pointerId: "pt_mine", firing: false }],
    });
    assert.deepEqual((await fold(root)).scrubs.map((s) => s.id), []);

    await publishAudit(root, SCOPE, opus, { ...base, id: "sc_ok", observations: [{ pointerId: "pt_mine", firing: false }] });
    assert.deepEqual((await fold(root)).scrubs.map((s) => s.id), ["sc_ok"]);
  } finally { discard(root); }
});

test("the fold refuses a vacuity check about a criterion nothing created, or one that can never be superseded", async () => {
  const root = await log("vacuity-subject");
  try {
    const criterionId = await withCriterion(root);
    const base = { witnesses: [{ anchorId: "a_lint", bodyHash: "h1:sha256:def" }], checkedBy: opus, at: "2026-08-03T00:00:00.000Z" };

    // A verdict about nothing: `criteriaFor` would never surface it and nothing could ever
    // supersede it, so it would sit in the log for ever looking like a demonstration.
    await publishVacuityCheck(root, SCOPE, opus, { ...base, id: "vc_ghost", criterionId: "ac_nothing", verdict: "demonstrated", method: "broke it" });
    assert.deepEqual((await fold(root)).vacuityChecks.map((v) => v.id), []);

    // A `demonstrated` check with NO witnesses can never go superseded — `serveCheck`
    // reads an empty witness list as nothing to drift from — so it would certify a check
    // across every later rewrite of that check. That is the pathology the pin exists for.
    await publishVacuityCheck(root, SCOPE, opus, { ...base, id: "vc_eternal", criterionId, verdict: "demonstrated", method: "broke it", witnesses: [] });
    assert.deepEqual((await fold(root)).vacuityChecks.map((v) => v.id), []);

    // The weakening verdicts need no witnesses: they take nothing on trust.
    await publishVacuityCheck(root, SCOPE, opus, { ...base, id: "vc_weak", criterionId, verdict: "vacuous", method: "", witnesses: [] });
    assert.deepEqual((await fold(root)).vacuityChecks.map((v) => v.id), ["vc_weak"]);
  } finally { discard(root); }
});

/**
 * A criterion this end cannot read takes the WHOLE ratification with it, and used not to.
 *
 * This test asserted the opposite until 2026-08-30 — "refusing the criterion must not
 * refuse the spec" — and that was the divergence, not the rule. `ratifySpec` collects an
 * `OperationCheck` per operation and returns an ERROR if any one fails
 * (`requirements.ts:1212`), so locally one unusable operation refuses the entire adoption;
 * only the fold applied the survivors. The end that binds every clone was the permissive
 * one, which is the shape CLAUDE.md records a dozen times.
 *
 * `conflicted` rather than an error because the fold cannot return one: the ratification
 * really happened and the honest record says so — the same treatment a moved base and an
 * unsigned adoption already get, three lines above in the same branch.
 */
test("a criterion the fold cannot read refuses the whole ratification, not just itself", async () => {
  const root = await log("criterion-weak");
  try {
    for (const [id, bad] of [
      ["op_same", { criterion: "A line above the limit is rejected.", falsifier: "a line above the limit is REJECTED" }],
      ["op_kind", { evidenceKind: "invented-kind" as never }],
      ["op_ghost", { targetOperationId: "op_missing" }],
    ] as const) {
      const root2 = await log(`cw-${id}`);
      await publishSpecDrafted(root2, SCOPE, opus, SPEC);
      await publishOperation(root2, SCOPE, opus, ADD);
      await publishOperation(root2, SCOPE, opus, { ...ADD_CRITERION, ...bad });
      await ratifyWithReview(root2, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {}, ["op_1", "op_2"]);
      const s = await fold(root2);
      assert.deepEqual(s.criteria.map((c) => c.id), [], `${id} should not fold`);
      assert.equal(s.specs[0]!.conflicted, true, `${id} must MARK the adoption, not pass it off as clean`);
      assert.equal(s.requirements.length, 0, `${id} takes the rule with it — adoption is all-or-nothing`);
      discard(root2);
    }
  } finally { discard(root); }
});

/**
 * Ratification ACTIVATES the pre-approved gap, at the end that binds every clone.
 *
 * `bindGapsForSpec` does it locally; without the same step here a teammate's clone folds
 * the ratification, binds the gap to the rule and leaves it `pending` for ever — a silencer
 * the principal approved that silences nothing, which is the mirror of the bug this state
 * was introduced to fix and just as invisible.
 */
test("the fold activates a pre-approved gap in the same act that adopts its rule", async () => {
  const root = await log("gap-atomic");
  try {
    await publishSpecDrafted(root, SCOPE, opus, SPEC);
    await publishOperation(root, SCOPE, opus, ADD);
    await publishAckGranted(root, SCOPE, opus, {
      id: "ack_1", basis: "gap", operationId: "op_1", rationale: "nothing implements it yet",
      priority: "medium", revalidateBy: "2027-01-01", state: "active",
      grantedBy: opus, grantedAt: "2026-08-01T00:00:00.000Z",
    });
    // PENDING however the event described itself — the payload said `active`.
    let a = (await fold(root)).acknowledgements[0]!;
    assert.equal(a.state, "pending");
    assert.equal(a.requirementId, undefined);

    await ratifyWithReview(root, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {}, ["op_1"]);
    a = (await fold(root)).acknowledgements[0]!;
    assert.equal(a.state, "active", "adopted in the same act that created the rule");
    assert.equal(a.requirementId, requirementIdFor("op_1"), "and bound to it");
  } finally { discard(root); }
});

/** The events that put `ADD`'s rule into the standard, in order. */
async function ratified(root: string, extra: Operation[] = []) {
  await publishSpecDrafted(root, SCOPE, opus, SPEC);
  await publishOperation(root, SCOPE, opus, ADD);
  for (const o of extra) await publishOperation(root, SCOPE, opus, o);
  await ratifyWithReview(root, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {},
    ["op_1", ...extra.map((o) => o.id)]);
}

test("THE FOLD REFUSES A WITHDRAWAL A LATER EVENT CITES, however the log happens to sort", async () => {
  // A citation appended on another clone can sort AFTER the withdrawal — the two are
  // concurrent and neither writer saw the other. `foldReliance` reads state built from
  // events already folded, so it cannot see this one; only the look-ahead can. Without it
  // the rule is deleted here and the audit that cites it lands on nothing, on every clone.
  const root = await log("withdraw-race");
  try {
    await ratified(root);
    await withdraw(root, izzie, "sp_1", "2026-08-03T00:00:00.000Z", "never adopted");
    // Ordered after the withdrawal, and about the rule it was about to remove.
    const audit: Audit = {
      id: "au_1", requirementId: requirementIdFor("op_1"), outcome: "indeterminate",
      evidence: {}, witnesses: [], finding: "could not reach the handler",
      auditor: opus, at: "2026-08-03T00:00:01.000Z",
    };
    await publishAudit(root, SCOPE, opus, audit);

    const after = await fold(root);
    assert.equal(after.requirements.length, 1, "the withdrawal lost the race — removing is the quieting act");
    assert.equal(after.specs[0]!.status, "ratified", "and it did not take effect");
    assert.equal(after.audits.length, 1, "while the citation stands");
  } finally { discard(root); }
});

test("the same withdrawal with nothing citing it DOES apply — so the refusal above is not blanket", async () => {
  const root = await log("withdraw-clean");
  try {
    await ratified(root);
    // With no reason first. `withdrawSpec` refuses one — "it stays on the record as the act
    // it is" — and the fold did not, so a client that skipped the field removed rules from
    // every clone's standard with nothing saying why.
    await withdraw(root, izzie, "sp_1", "2026-08-03T00:00:00.000Z", "   ");
    assert.equal((await fold(root)).specs[0]!.status, "ratified",
      "a withdrawal with no reason on the record is not a withdrawal");

    await withdraw(root, izzie, "sp_1", "2026-08-03T00:00:00.000Z", "never adopted");
    const after = await fold(root);
    assert.equal(after.requirements.length, 0);
    assert.equal(after.specs[0]!.status, "withdrawn");
    assert.equal(after.specs[0]!.withdrawnBy!.principal, izzie.principal);
  } finally { discard(root); }
});

test("THE FOLD REFUSES WITHDRAWING A SPEC THAT AMENDED SOMETHING — that case is repeal", async () => {
  const root = await log("withdraw-amend");
  try {
    // The rule this spec amends has to exist first, so it comes from its own spec.
    await ratified(root);
    const amender: Spec = { ...SPEC, id: "sp_2", title: "widen it" };
    const amend: Operation = {
      id: "op_2", specId: "sp_2", kind: "amend_statement", ord: 0,
      requirementId: requirementIdFor("op_1"), statement: "All credit lines are in USD or EUR.",
      context: { requirementId: requirementIdFor("op_1"), statement: "All credit lines are in USD." },
      rationale: "EU launch", reversibility: "reversible",
    };
    await publishSpecDrafted(root, SCOPE, opus, amender);
    await publishOperation(root, SCOPE, opus, amend);
    await ratifyWithReview(root, SCOPE, izzie, "sp_2", "2026-08-03T00:00:00.000Z", {}, ["op_2"]);
    assert.equal((await fold(root)).requirements[0]!.statement, "All credit lines are in USD or EUR.");

    // Nothing cites the amending spec at all, so this refusal is about the operation KIND.
    await withdraw(root, izzie, "sp_2", "2026-08-04T00:00:00.000Z", "EU launch slipped");
    const after = await fold(root);
    assert.equal(after.specs.find((s) => s.id === "sp_2")!.status, "ratified", "refused");
    assert.equal(after.requirements[0]!.statement, "All credit lines are in USD or EUR.",
      "and no statement was restored against witnesses the amendment had already re-baselined");
  } finally { discard(root); }
});

test("a vacuity check on the spec's own criterion blocks its withdrawal", async () => {
  // The criteria a spec introduced are deleted with it, and a vacuity check hangs off a
  // CRITERION rather than a rule — so it is invisible to a reliance scan that walks
  // requirement ids, which is what both halves originally did. Somebody established
  // whether that assertion can fail; withdrawing over it discards the answer.
  const root = await log("withdraw-vacuity");
  try {
    const criterionId = await withCriterion(root);
    await publishVacuityCheck(root, SCOPE, opus, {
      id: "vc_1", criterionId, witnesses: [{ anchorId: "a_lint", bodyHash: "h1:sha256:def" }],
      checkedBy: opus, at: "2026-08-03T00:00:00.000Z", verdict: "vacuous", method: "",
    });
    await withdraw(root, izzie, "sp_1", "2026-08-04T00:00:00.000Z", "never adopted");

    const after = await fold(root);
    assert.equal(after.specs[0]!.status, "ratified", "refused");
    assert.equal(after.criteria.length, 1, "and the criterion the check is about is still there");
  } finally { discard(root); }
});

test("THE FOLD REFUSES A WITHDRAWAL IT CANNOT SEE THE EVIDENCE FOR", async () => {
  // The one failure in the two-scope split that answers WRONGLY rather than incompletely.
  // Withdrawal is permitted only when nothing relies on what a spec introduced, and
  // reliance is counted from audits, pointers, populations, problems and criteria — all
  // of which live in the EVIDENCE scope. A fold that cannot read that half does not find
  // less reliance; it finds NONE, and lets the withdrawal through.
  const root = await log("withdraw-no-evidence");
  try {
    await ratified(root);
    await withdraw(root, izzie, "sp_1", "2026-08-04T00:00:00.000Z", "never adopted");
    const events = await readScope(root, SCOPE);

    // With the evidence half readable — nothing relies on it, so it applies. This is the
    // control: without it the assertion below would pass against a fold that refuses
    // every withdrawal.
    assert.equal(foldStandard(events, { myScope: SCOPE }).specs[0]!.status, "withdrawn");

    // And with the evidence half unreadable, the same log must NOT decide it.
    const blind = foldStandard(events, { evidence: false, myScope: SCOPE });
    assert.equal(blind.specs[0]!.status, "ratified", "refused rather than permitted");
    assert.equal(blind.requirements.length, 1, "and nothing it introduced was removed");
  } finally { discard(root); }
});

/**
 * Adoption is ALL-OR-NOTHING at this end too, and it was not.
 *
 * `applyOperation` skips an operation it cannot apply. In a bare loop each skip is silent,
 * so a spec carrying one malformed operation folded `ratified` and NOT `conflicted` with
 * every OTHER operation applied — a partial application on the one surface whose promise
 * is that adoption is all-or-nothing, and invisible from either side: the spec looks
 * adopted and the missing rule looks like it was never proposed.
 *
 * The criterion here aims at ITSELF. `addOperation` refuses that, and `case "spec.operation"`
 * stores an operation verbatim, so it is exactly what a teammate's clone can hold and this
 * end never saw refused.
 *
 * The second half is the one that makes the first mean anything: the SAME ratification
 * without the malformed operation still applies in full. Without it this passes with the
 * fold refusing every ratification there is.
 */
test("the fold refuses a ratification it cannot apply WHOLE, rather than adopting the rest", async () => {
  const SELF: Operation = {
    id: "op_self", specId: "sp_1", kind: "add_criterion", ord: 1,
    targetOperationId: "op_self", criterion: "it holds", falsifier: "it does not hold",
    evidenceKind: "attestation",
    rationale: "aimed at itself", reversibility: "reversible",
  };
  const root = await log("whole");
  try {
    await publishSpecDrafted(root, SCOPE, opus, SPEC);
    await publishOperation(root, SCOPE, opus, ADD);
    await publishOperation(root, SCOPE, opus, SELF);
    await ratifyWithReview(root, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {}, ["op_1", "op_self"]);
    const s = await fold(root);
    assert.equal(s.specs[0]!.status, "ratified", "the ratification happened and the record says so");
    assert.equal(s.specs[0]!.conflicted, true, "but it is marked, the way a moved base is");
    assert.equal(s.requirements.length, 0, "and NOTHING applied — not the operations that were fine");
    assert.equal(s.criteria.length, 0);
  } finally { discard(root); }

  const clean = await log("whole-ok");
  try {
    await publishSpecDrafted(clean, SCOPE, opus, SPEC);
    await publishOperation(clean, SCOPE, opus, ADD);
    await ratifyWithReview(clean, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {}, ["op_1"]);
    const s = await fold(clean);
    assert.equal(s.specs[0]!.conflicted, undefined, "an ordinary ratification is untouched by the check");
    assert.equal(s.requirements.length, 1, "and still applies");
  } finally { discard(clean); }
});

/**
 * A revision that moved nothing is not a revision.
 *
 * `reviseOperation` refuses one — `changedFields` comes back empty and it answers "nothing
 * to change" — and this end did not, so a client could append an entry whose `was` is empty
 * and every clone would render "corrected 1× — <reason>" over text that never moved. With
 * `reason` on the entry that is a sentence of prose describing an act nobody performed.
 *
 * The real correction beside it is the mutation guard: refusing everything would pass the
 * first assertion just as well.
 */
/**
 * A rewrite and its revision entry arrive TOGETHER, or not at all.
 *
 * Three cases, and the middle one is a regression this guard itself caused on 2026-08-31.
 * `changedFields` records `was[k] = before[k]`, which for a field being SET for the first
 * time is `undefined` — a key JSON drops. A guard reading the writer's `was` therefore
 * discarded a real correction that added an absent `evidence`: the tool answered
 * `{ok: true}`, the fold wrote nothing, and on a sidecar store the correction existed
 * nowhere. Comparing `operationContent` asks the operation what it SAYS instead of asking
 * the writer what they claim to have changed.
 */
test("a rewrite without its revision entry is refused, and a first-time field still folds", async () => {
  const root = await log("biconditional");
  try {
    await publishSpecDrafted(root, SCOPE, opus, SPEC);
    await publishOperation(root, SCOPE, opus, ADD);

    // Rewrite, no entry: the text a ratifier signed would move with nothing recording it.
    await publishOperationRevised(root, SCOPE, opus, { ...ADD, statement: "Silently different." });
    assert.equal((await fold(root)).operations[0]!.statement, ADD.statement, "a silent rewrite is not a correction");

    // Setting a field that was ABSENT. `was` is `{ evidence: undefined }` in memory and
    // `{}` once it has been through the log — the shape that broke this.
    await publishOperationRevised(root, SCOPE, opus, {
      ...ADD, evidence: "COD-31",
      revisions: [{ at: "2026-08-02T00:00:00.000Z", by: opus, was: { evidence: undefined }, reason: "links the ticket" }],
    });
    const s = await fold(root);
    assert.equal(s.operations[0]!.evidence, "COD-31", "a first-time value is a real change and must land");
    assert.equal((s.operations[0]!.revisions ?? []).length, 1);
  } finally { discard(root); }
});

/**
 * The two arms that validated nothing, and the one whose failure is unrecoverable.
 *
 * `case "spec.operation"` stores an operation verbatim, so an empty `add_requirement` folded
 * to a ratified rule with every field undefined. `shared-projections.ts` binds `r.section`
 * against `section TEXT NOT NULL` and `node:sqlite` throws on an undefined bind — so the
 * merged fold then failed on every later read, permanently, from a log nobody can edit.
 */
test("the fold refuses an operation with nothing in it, rather than ratifying a blank rule", async () => {
  for (const [what, bad] of [
    ["an empty add_requirement", { id: "op_empty", kind: "add_requirement", ord: 1 }],
    ["an amend that would blank a rule", { id: "op_blank", kind: "amend_statement", ord: 1, requirementId: requirementIdFor("op_1"), statement: "  " }],
  ] as const) {
    const root = await log("blank");
    try {
      await publishSpecDrafted(root, SCOPE, opus, SPEC);
      await publishOperation(root, SCOPE, opus, ADD);
      await publishOperation(root, SCOPE, opus, { ...bad, specId: "sp_1", rationale: "x", reversibility: "reversible" } as Operation);
      await ratifyWithReview(root, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {}, ["op_1", bad.id]);
      const s = await fold(root);
      assert.equal(s.specs[0]!.conflicted, true, `${what} must mark the adoption`);
      assert.equal(s.requirements.length, 0, `${what} must not land a rule with undefined columns`);
    } finally { discard(root); }
  }
});

/**
 * A ratification does not adopt an operation somebody WITHDREW.
 *
 * `readOperations` drops a tombstone by default, so `ratifySpec` can never adopt one and
 * this end could. `ratifySpec` deliberately does not pull, so the sequence needs no bad
 * actor: Bob removes an operation, Alice ratifies from a clone that has not synced and pins
 * it, and the withdrawn rule is created on every clone. It even reads as reviewed —
 * `operationContent` omits `removed`, so the witness still matches.
 */
test("a ratification refuses an operation that was withdrawn from the proposal", async () => {
  const DEAD: Operation = {
    ...ADD, id: "op_dead", ord: 1, title: "Withdrawn rule", statement: "Nobody adopted this.",
    removed: { at: "2026-08-01T12:00:00.000Z", by: opus, reason: "second thoughts" },
  };
  // BOTH arms of `mine`, because they fail differently and the pinned one is separately
  // protected: filtering there makes the count differ from `pinned`, which the existing
  // length check already turns into `conflicted`. The UNPINNED arm — an older ratification
  // event, or any writer that omits the list — has no such backstop, and is where a
  // withdrawn operation is adopted outright.
  const pinned = await log("tombstone-pinned");
  try {
    await publishSpecDrafted(pinned, SCOPE, opus, SPEC);
    await publishOperation(pinned, SCOPE, opus, ADD);
    await publishOperation(pinned, SCOPE, opus, DEAD);
    await ratifyWithReview(pinned, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {}, ["op_1", "op_dead"]);
    const s = await fold(pinned);
    assert.ok(!s.requirements.some((r) => r.title === "Withdrawn rule"), "a withdrawn operation must not become a rule");
    assert.equal(s.specs[0]!.conflicted, true, "and pinning one is a proposal that cannot be adopted as pinned");
  } finally { discard(pinned); }

  const loose = await log("tombstone-loose");
  try {
    await publishSpecDrafted(loose, SCOPE, opus, SPEC);
    await publishOperation(loose, SCOPE, opus, ADD);
    await publishOperation(loose, SCOPE, opus, DEAD);
    // Signed and ratified with NO pinned list, so `mine` comes from the fallback.
    await publishSpecReviewed(loose, SCOPE, izzie, {
      id: "w_f", specId: "sp_1", reviewer: izzie, at: "2026-08-02T00:00:00.000Z", content: framingContent(SPEC),
    });
    for (const op of [ADD, DEAD]) {
      await publishSpecReviewed(loose, SCOPE, izzie, {
        id: `w_${op.id}`, specId: "sp_1", operationId: op.id, reviewer: izzie,
        at: "2026-08-02T00:00:00.000Z", content: operationContent(op),
      });
    }
    await publishSpecRatified(loose, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {}, undefined as never);
    const s = await fold(loose);
    assert.deepEqual(s.requirements.map((r) => r.title), [ADD.title], "the live rule lands and the withdrawn one does not");
    assert.equal(s.specs[0]!.conflicted, undefined, "nothing is wrong with the proposal — the tombstone was simply never part of it");
  } finally { discard(loose); }
});

/**
 * An operation cannot be added to a spec that is no longer a draft.
 *
 * `addOperation` refuses it; this arm took the row verbatim. Bob, who has not pulled, adds
 * an `amend_statement` to a spec Alice already ratified. It never applies — and it is still
 * indistinguishable from an adopted operation in `readOperations({requirementId})`, which is
 * what `moveMade` in `problems.ts` reads: a problem CLOSES on an amendment that changed
 * nothing.
 */
test("the fold refuses an operation added to a spec that is already ratified", async () => {
  const root = await log("late-op");
  try {
    await publishSpecDrafted(root, SCOPE, opus, SPEC);
    await publishOperation(root, SCOPE, opus, ADD);
    await ratifyWithReview(root, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {}, ["op_1"]);
    await publishOperation(root, SCOPE, opus, {
      ...ADD, id: "op_late", ord: 1, kind: "amend_statement",
      requirementId: requirementIdFor("op_1"), statement: "Slipped in afterwards.",
    });
    assert.ok(!(await fold(root)).operations.some((o) => o.id === "op_late"), "the spec is spent; nothing more attaches to it");
  } finally { discard(root); }

  // And an operation on a spec still OPEN is stored, so the check is about status and not
  // about refusing late rows generally.
  const ok2 = await log("late-ok");
  try {
    await publishSpecDrafted(ok2, SCOPE, opus, SPEC);
    await publishOperation(ok2, SCOPE, opus, ADD);
    await publishOperation(ok2, SCOPE, opus, { ...ADD, id: "op_2", ord: 1, title: "Second", statement: "Also true." });
    assert.equal((await fold(ok2)).operations.length, 2);
  } finally { discard(ok2); }
});

/**
 * An acknowledgement with no release condition is a PERMANENT silencer.
 *
 * `checkCommon` refuses a missing rationale, priority or `revalidateBy`; the fold checked
 * none of them. A `debt` with no `revalidateBy` folds `active` on every clone and can never
 * surface again: `serve()` asks `a.revalidateBy <= asOf`, and `undefined <= "2026-…"` is
 * `false`, so `dueForRevalidation` never returns it. The rule stays quiet for ever — the
 * exact outcome the record exists to prevent.
 */
test("the fold refuses an acknowledgement with no release condition", async () => {
  const base = {
    id: "ack_1", basis: "debt" as const, requirementId: "req_1", rationale: "scheduled for Q4",
    priority: "high" as const, revalidateBy: "2027-01-01",
    grantedBy: izzie, grantedAt: "2026-08-01T00:00:00.000Z", state: "active" as const,
  };
  for (const [what, bad] of [
    ["no revalidateBy", { revalidateBy: undefined }],
    ["a revalidateBy that is not a date", { revalidateBy: "when we get to it" }],
    ["no priority", { priority: undefined }],
    ["no rationale", { rationale: "  " }],
  ] as const) {
    const root = await log("ack-bad");
    try {
      await publishAckGranted(root, SCOPE, izzie, { ...base, ...bad } as Acknowledgement);
      assert.equal((await fold(root)).acknowledgements.length, 0, `${what} must not fold`);
    } finally { discard(root); }
  }
  // The well-formed one folds, so the four above are refused for their field and not
  // because this path refuses everything.
  const good = await log("ack-good");
  try {
    await publishAckGranted(good, SCOPE, izzie, base as Acknowledgement);
    assert.equal((await fold(good)).acknowledgements.length, 1);
  } finally { discard(good); }
});

/**
 * Ratification binds a PENDING detector at the end that binds every clone.
 *
 * `bindPointersForSpec` does it locally. Without the same step here a teammate's clone
 * folds the adoption and leaves the detector `pending` for ever — a check nobody is
 * running, invisible to `criteriaFor` because every query that means "what is watching
 * this" asks for `active`. Exactly the shape the gap-binding hole had, which is why it
 * sits beside it in the same block.
 *
 * The pulled arm is the other half: a pointer whose operation was REMOVED from the draft
 * has no criterion coming, and leaving it pending would be an orphan nothing can bind.
 */
test("the fold binds a pending detector when the spec is adopted, and retires an orphaned one", async () => {
  const pending = (id: string, operationId: string): Pointer => ({
    id, requirementId: requirementIdFor("op_1"), criterionId: criterionIdFor(operationId),
    operationId, universe: U, target: { kind: "anchor", id: "a_lint" },
    rationale: "the lint", witnesses: [{ anchorId: "a_lint", bodyHash: "h1:sha256:def" }],
    state: "pending", declaredBy: opus, declaredAt: "2026-08-01T00:00:00.000Z",
  });
  const root = await log("bind-detector");
  try {
    await publishSpecDrafted(root, SCOPE, opus, SPEC);
    await publishOperation(root, SCOPE, opus, ADD);
    await publishOperation(root, SCOPE, opus, ADD_CRITERION);
    // A second criterion, proposed against while it was LIVE and pulled afterwards — the
    // only order this can really happen in, since `proposePointer` refuses a removed one.
    const doomed: Operation = {
      ...ADD_CRITERION, id: "op_3", ord: 2, criterion: "Something else.", falsifier: "It is not so.",
    };
    await publishOperation(root, SCOPE, opus, doomed);
    await publishPointerDeclared(root, SCOPE, opus, pending("pt_live", "op_2"));
    await publishPointerDeclared(root, SCOPE, opus, pending("pt_orphan", "op_3"));
    await publishOperationRemoved(root, SCOPE, opus, {
      ...doomed, removed: { at: "2026-08-01T12:00:00.000Z", by: opus, reason: "wrong check" },
    });

    let s = await fold(root);
    assert.deepEqual(s.pointers.map((p) => p.state).sort(), ["pending", "pending"], "nothing binds before adoption");

    await ratifyWithReview(root, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {}, ["op_1", "op_2"]);
    s = await fold(root);
    const byId = new Map(s.pointers.map((p) => [p.id, p]));
    assert.equal(byId.get("pt_live")!.state, "active", "adopted with its criterion");
    assert.equal(byId.get("pt_orphan")!.state, "retired", "and one whose operation was pulled is not left pending");
    assert.match(byId.get("pt_orphan")!.retiredReason!, /pulled from sp_1/);
  } finally { discard(root); }

  // A proposal folded AFTER its own ratification. Two orderings of the same two events used
  // to disagree — bound one way, silently dropped the other — so the author's store kept a
  // detector every clone had thrown away, decided by nothing but the merge tiebreak. Late is
  // not invalid: the criterion exists by then, which is when `declarePointer` would have been
  // the verb anyway.
  const late = await log("bind-late");
  try {
    await publishSpecDrafted(late, SCOPE, opus, SPEC);
    await publishOperation(late, SCOPE, opus, ADD);
    await publishOperation(late, SCOPE, opus, ADD_CRITERION);
    await ratifyWithReview(late, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {}, ["op_1", "op_2"]);
    await publishPointerDeclared(late, SCOPE, opus, pending("pt_late", "op_2"));
    const s = await fold(late);
    assert.equal(s.pointers.length, 1, "not dropped — the two orderings must agree");
    assert.equal(s.pointers[0]!.state, "active", "and it is an ordinary detector by then");
  } finally { discard(late); }

  // WITHDRAWAL is the other exit, and it was the one nothing covered: a spec never adopted
  // at all left its detectors pending for ever, against a criterion that will never exist.
  const gone = await log("bind-withdrawn");
  try {
    await publishSpecDrafted(gone, SCOPE, opus, SPEC);
    await publishOperation(gone, SCOPE, opus, ADD);
    await publishOperation(gone, SCOPE, opus, ADD_CRITERION);
    await publishPointerDeclared(gone, SCOPE, opus, pending("pt_x", "op_2"));
    await withdraw(gone, opus, "sp_1", "2026-08-02T00:00:00.000Z", "not ours to make");
    const s = await fold(gone);
    assert.equal(s.specs[0]!.status, "withdrawn");
    assert.equal(s.pointers[0]!.state, "retired", "the detector goes with the proposal");
    assert.match(s.pointers[0]!.retiredReason!, /withdrawn/);
  } finally { discard(gone); }
});

/**
 * A ratified spec leaves the standard on the clones the withdrawer CHECKED, and nowhere else.
 *
 * The withdrawal is LAW — one event in the workspace scope, replayed by every clone. The
 * reliance test under it is EVIDENCE, and evidence is per-universe by design, so this fold
 * sees one repository's audits and pointers and called the result a verdict about the
 * standard. Universe A refused on its audit; universe B had none, dropped the rule, and the
 * two standards diverged permanently with nothing anywhere saying so. No care inside this
 * function reaches it: the fold for A cannot see B.
 *
 * `withdrawSpec` therefore reads EVERY standard scope on the sidecar, refuses if any is
 * unsettled or unclean, and PINS what it read. This is the other half — a clone that was
 * not on that list refuses, and says so by going `conflicted` rather than silently keeping
 * the rule. Izzie's rule: clean everywhere, and undeterminable counts as not clean.
 */
test("a ratified withdrawal applies only where the withdrawer said it had checked", async () => {
  // NAMED, and it applies — the control, or the refusal below is a fold that refuses every
  // ratified withdrawal and the assertion proves nothing.
  const named = await log("withdraw-named");
  try {
    await ratified(named);
    await withdraw(named, izzie, "sp_1", "2026-08-04T00:00:00.000Z", "adopted in error");
    const s = await fold(named);
    assert.equal(s.specs[0]!.status, "withdrawn");
    assert.equal(s.requirements.length, 0);
    assert.equal(s.specs[0]!.conflicted, undefined);
  } finally { discard(named); }

  // NOT named — the withdrawer checked some other repository and never looked here. The
  // rule stays, and the spec says the log and this clone disagree.
  const other = await log("withdraw-elsewhere");
  try {
    await ratified(other);
    await publishSpecWithdrawn(other, SCOPE, izzie, "sp_1", "2026-08-04T00:00:00.000Z",
      "adopted in error", ["standard/acme.settlement"]);
    const s = await fold(other);
    assert.equal(s.specs[0]!.status, "ratified", "a claim made about another repository is not about this one");
    assert.equal(s.specs[0]!.conflicted, true, "and it is VISIBLE — the divergence this replaces was silent");
    assert.equal(s.requirements.length, 1, "the rule is still in this standard");
  } finally { discard(other); }

  // NO pin at all — a client that never checked anything, and the shape every withdrawal
  // written before this guard has. Same answer: cannot determine is not permission.
  const bare = await log("withdraw-unpinned");
  try {
    await ratified(bare);
    await publishSpecWithdrawn(bare, SCOPE, izzie, "sp_1", "2026-08-04T00:00:00.000Z", "adopted in error");
    const s = await fold(bare);
    assert.equal(s.specs[0]!.status, "ratified");
    assert.equal(s.specs[0]!.conflicted, true);
    assert.equal(s.requirements.length, 1);
  } finally { discard(bare); }

  // A fold that does not know WHICH repository it is cannot answer the question either.
  const blind = await log("withdraw-anonymous");
  try {
    await ratified(blind);
    await withdraw(blind, izzie, "sp_1", "2026-08-04T00:00:00.000Z", "adopted in error");
    const s = foldStandard(await readScope(blind, SCOPE));
    assert.equal(s.specs[0]!.status, "ratified", "no `myScope` is no answer, and no answer is a refusal");
  } finally { discard(blind); }

  // A DRAFT is untouched by any of this: it applied nothing, so nothing anywhere relies on
  // it and there is nothing to be clean about. Without this the guard would quietly take
  // the author's own take-back with it.
  const draft = await log("withdraw-draft-unpinned");
  try {
    await publishSpecDrafted(draft, SCOPE, opus, SPEC);
    await publishOperation(draft, SCOPE, opus, ADD);
    await publishSpecWithdrawn(draft, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", "second thoughts");
    assert.equal((await fold(draft)).specs[0]!.status, "withdrawn");
  } finally { discard(draft); }
});

/**
 * A WITHDRAWN spec cannot be ratified, and this arm tested the wrong thing.
 *
 * Every other spec arm in the fold gates on `status !== "draft"`; `spec.ratified` gated on
 * `=== "ratified"`, which catches a double-adopt and nothing else. `ratifySpec` refuses
 * anything but a draft and deliberately does NOT pull, so no bad actor is needed: Alice
 * withdraws the draft, Bob ratifies from a read taken before his pull, and the row lands
 * `ratified` while still carrying `withdrawnBy` — a spec that is both, and no verb undoes
 * it, because a second ratification breaks here and a fresh withdrawal must clear
 * `foldReliance`.
 */
test("the fold refuses to ratify a spec that was withdrawn", async () => {
  const root = await log("ratify-withdrawn");
  try {
    await publishSpecDrafted(root, SCOPE, opus, SPEC);
    await publishOperation(root, SCOPE, opus, ADD);
    await withdraw(root, izzie, "sp_1", "2026-08-02T00:00:00.000Z", "not ours to make");
    await ratifyWithReview(root, SCOPE, izzie, "sp_1", "2026-08-03T00:00:00.000Z", {}, ["op_1"]);
    const s = await fold(root);
    assert.equal(s.specs[0]!.status, "withdrawn", "the latch does not go backwards");
    assert.equal(s.specs[0]!.ratifiedAt, undefined, "and it is not both at once");
    assert.equal(s.requirements.length, 0);
  } finally { discard(root); }

  // The ordinary adoption still works, so this is about the STATUS and not about the arm
  // having been disabled.
  const fine = await log("ratify-draft");
  try {
    await publishSpecDrafted(fine, SCOPE, opus, SPEC);
    await publishOperation(fine, SCOPE, opus, ADD);
    await ratifyWithReview(fine, SCOPE, izzie, "sp_1", "2026-08-03T00:00:00.000Z", {}, ["op_1"]);
    assert.equal((await fold(fine)).requirements.length, 1);
  } finally { discard(fine); }
});

/**
 * One malformed event must not stop the standard folding — for ever, on every clone.
 *
 * `add_requirement`'s arm validated its fields because the hazard was found there; the
 * others did not. A `spec.drafted` with no title, or a `problem.raised` with no rule, binds
 * `undefined` into a NOT NULL column, and `node:sqlite` throws INSIDE `readCachedMerged`'s
 * transaction: rollback, the fingerprint never moves, and the standard never folds again on
 * any clone that pulls it — an unrecoverable state produced from an append-only log nobody
 * can edit.
 *
 * Two layers, and the second is the one that matters. The arms refuse what they know to
 * require; `bindable` in `shared-projections.ts` drops a row it cannot bind, so the NEXT
 * arm missing a check costs one record instead of the subsystem.
 *
 * The well-formed pair beside them is what stops this passing on a fold that refuses
 * everything — and the assertion that a LATER good event still folds is the actual claim:
 * the bad one did not poison the run.
 */
test("a malformed event is dropped, and the events after it still fold", async () => {
  const root = await log("unbindable");
  try {
    await publishSpecDrafted(root, SCOPE, opus, { id: "sp_bad", status: "draft", author: opus } as never);
    await publishProblemRaised(root, SCOPE, opus, { id: "pr_bad", state: "awaitingAdjudication" } as never);
    // A good spec AFTER the bad ones: if either had thrown, this would never be reached.
    await publishSpecDrafted(root, SCOPE, opus, SPEC);
    await publishOperation(root, SCOPE, opus, ADD);
    const s = await fold(root);
    assert.deepEqual(s.specs.map((x) => x.id), ["sp_1"], "the malformed spec is gone and the good one folded");
    assert.deepEqual(s.problems, [], "and a problem about no rule is not a problem");
    assert.equal(s.operations.length, 1);
  } finally { discard(root); }
});

test("the fold drops a revision that changed nothing, and keeps one that did", async () => {
  const root = await log("phantom");
  try {
    await publishSpecDrafted(root, SCOPE, opus, SPEC);
    await publishOperation(root, SCOPE, opus, ADD);
    await publishOperationRevised(root, SCOPE, opus, {
      ...ADD, revisions: [{ at: "2026-08-02T00:00:00.000Z", by: opus, was: {}, reason: "because" }],
    });
    let s = await fold(root);
    assert.equal((s.operations[0]!.revisions ?? []).length, 0, "no correction happened, so none is recorded");

    await publishOperationRevised(root, SCOPE, opus, {
      ...ADD, statement: "All credit lines are in USD or EUR.",
      revisions: [{ at: "2026-08-03T00:00:00.000Z", by: opus, was: { statement: ADD.statement }, reason: "EUR went live" }],
    });
    s = await fold(root);
    assert.equal(s.operations[0]!.statement, "All credit lines are in USD or EUR.");
    assert.equal(s.operations[0]!.revisions?.at(-1)?.reason, "EUR went live", "and a real one still carries its why");
  } finally { discard(root); }
});
