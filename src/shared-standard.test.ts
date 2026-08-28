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
    assert.deepEqual(r.witnesses, [{ anchorId: "a_credit", bodyHash: "h1:sha256:abc" }]);
    assert.equal(r.origin, "sync", "a folded row is marked as the team's");
  } finally { discard(root); }
});

test("the same events fold to the same standard, which is what lets two clones agree", async () => {
  const root = await log("determinism");
  try {
    await publishSpecDrafted(root, SCOPE, opus, SPEC);
    await publishOperation(root, SCOPE, opus, ADD);
    await publishSpecRatified(root, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {}, ["op_1"]);
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
    await publishSpecRatified(root, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {}, ["op_1"]);
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
    await publishSpecRatified(root, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {}, ["op_1"]);
    const once = await fold(root);

    // A second ratification of the same spec. A fold that applied it again would amend
    // the rule a second time, and `amendedBy` would grow on every sync — the shape of bug
    // that only appears after a clone has synced more than once.
    await publishSpecRatified(root, SCOPE, izzie, "sp_1", "2026-08-09T00:00:00.000Z", {}, ["op_1"]);
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
    await publishAckGranted(root, SCOPE, opus, {
      ...base, id: "ack_2", basis: "gap", operationId: "op_1", requirementId: undefined, grantedBy: opus,
    });
    assert.equal((await fold(root)).acknowledgements.length, 1);

    await publishAckGranted(root, SCOPE, izzie, { ...base, id: "ack_3", grantedBy: izzie });
    assert.equal((await fold(root)).acknowledgements.length, 2, "a principal's debt binds");
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

    // `indeterminate` is the quiet bucket and may carry nothing, so the gate is about the
    // OUTCOME rather than about evidence being present.
    await publishAudit(root, SCOPE, opus, { ...base, id: "au_3", outcome: "indeterminate" });
    assert.equal((await fold(root)).audits.length, 2);
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
    await publishSpecRatified(root, SCOPE, opus, "sp_1", "2026-08-02T00:00:00.000Z", {}, ["op_1"]);
    const f = await fold(root);
    assert.equal(f.requirements.length, 0, "adoption is a principal's act on every clone, not only on the one that ran the tool");
    assert.equal(f.specs[0]!.status, "draft");

    await publishSpecRatified(root, SCOPE, izzie, "sp_1", "2026-08-03T00:00:00.000Z", {}, ["op_1"]);
    assert.equal((await fold(root)).requirements.length, 1, "and a principal's does bind");
  } finally { discard(root); }
});

test("the fold refuses a spec adopted against a base that had already moved", async () => {
  const root = await log("foldcontext");
  try {
    await publishSpecDrafted(root, SCOPE, opus, SPEC);
    await publishOperation(root, SCOPE, opus, ADD);
    await publishSpecRatified(root, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {}, ["op_1"]);
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
    await publishSpecRatified(root, SCOPE, izzie, "sp_a", "2026-08-03T00:00:00.000Z", {}, ["op_a"]);
    assert.match((await fold(root)).requirements[0]!.statement, /settlement float/);

    await publishSpecRatified(root, SCOPE, izzie, "sp_b", "2026-08-04T00:00:00.000Z", {}, ["op_b"]);
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
    await publishSpecRatified(root, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {}, ["op_1"]);

    const f = await fold(root);
    assert.equal(f.requirements.length, 1, "only what was pinned");
    assert.equal(f.requirements[0]!.id, requirementIdFor("op_1"));
  } finally { discard(root); }
});
