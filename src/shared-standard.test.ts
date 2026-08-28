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
} from "./shared-standard.js";
import { requirementIdFor, type Acknowledgement, type Actor, type Audit, type Operation, type Problem, type Spec } from "./schema.js";

const izzie: Actor = { principal: "izzie@x.com" };
const opus: Actor = { principal: "izzie@x.com", via: { kind: "agent", model: "claude-opus-5" } };
const U = "acme/api";
const SCOPE = standardScope(U);

const tmp = (t: string) => mkdtempSync(join(tmpdir(), `codemap-ss-${t}-`));
const fold = async (root: string) => foldStandard(await readScope(root, SCOPE));

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
  statement: "All credit lines are in USD.", provenance: "credit policy §4", cites: [],
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

    await publishSpecRatified(root, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {
      op_1: [{ anchorId: "a_credit", bodyHash: "h1:sha256:abc" }],
    });

    const after = await fold(root);
    assert.equal(after.specs[0]!.status, "ratified");
    assert.equal(after.requirements.length, 1);
    const r = after.requirements[0]!;
    // Derived, not carried: the operation event was published before anything bound a
    // requirement to it, so a clone that only sees the log must compute the name itself.
    assert.equal(r.id, requirementIdFor("op_1"));
    assert.equal(r.statement, "All credit lines are in USD.");
    assert.equal(r.introducedBy, "sp_1");
    assert.deepEqual(r.witnesses, [{ anchorId: "a_credit", bodyHash: "h1:sha256:abc" }]);
    assert.equal(r.origin, "sync", "a folded row is marked as the team's");
  } finally { discard(root); }
});

test("the same events fold to the same standard, which is what lets two clones agree", async () => {
  const root = await log("determinism");
  try {
    await publishSpecDrafted(root, SCOPE, opus, SPEC);
    await publishOperation(root, SCOPE, opus, ADD);
    await publishSpecRatified(root, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {});
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
    const ack: Acknowledgement = {
      id: "ack_1", basis: "gap", operationId: "op_1", rationale: "nothing built yet",
      priority: "medium", revalidateBy: "2027-01-01", state: "active",
      grantedBy: opus, grantedAt: "2026-08-01T00:00:00.000Z",
    };
    await publishAckGranted(root, SCOPE, opus, ack);
    assert.equal((await fold(root)).acknowledgements[0]!.state, "active");

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
    await publishSpecRatified(root, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {});
    await publishAckGranted(root, SCOPE, opus, {
      id: "ack_1", basis: "gap", operationId: "op_1", rationale: "nothing built yet",
      priority: "medium", revalidateBy: "2027-01-01", state: "active",
      grantedBy: opus, grantedAt: "2026-08-01T00:00:00.000Z",
    });
    const value = await fold(root);
    assert.ok(value.requirements.length && value.acknowledgements.length, "the fixture must be non-empty or the round trip is vacuous");

    const d = db(store);
    standardProjection.write(d, SCOPE, value);
    assert.deepEqual(standardProjection.read(d, SCOPE), value, "read(write(x)) === x");

    // And it replaces only what it owns: a second write does not accumulate.
    standardProjection.write(d, SCOPE, value);
    assert.deepEqual(standardProjection.read(d, SCOPE), value);

    // Another universe's scope is untouched by this one's rows.
    assert.deepEqual(standardProjection.read(d, standardScope("acme/settlement")), {
      specs: [], operations: [], requirements: [], acknowledgements: [], audits: [], problems: [],
    });
  } finally { discard(root); discard(store); }
});

test("a spec ratifies once, so a replayed or duplicated event cannot apply it twice", async () => {
  const root = await log("idempotent");
  try {
    await publishSpecDrafted(root, SCOPE, opus, SPEC);
    await publishOperation(root, SCOPE, opus, ADD);
    await publishSpecRatified(root, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {});
    const once = await fold(root);

    // A second ratification of the same spec. A fold that applied it again would amend
    // the rule a second time, and `amendedBy` would grow on every sync — the shape of bug
    // that only appears after a clone has synced more than once.
    await publishSpecRatified(root, SCOPE, izzie, "sp_1", "2026-08-09T00:00:00.000Z", {});
    const twice = await fold(root);
    assert.deepEqual(twice.requirements, once.requirements, "applying a spec is idempotent");
    assert.equal(twice.specs[0]!.ratifiedAt, "2026-08-02T00:00:00.000Z", "and the first adoption is the one that counts");
  } finally { discard(root); }
});
