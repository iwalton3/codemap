/**
 * The problem record, and the refusal that has no verb to refuse.
 *
 * The scenario every test here is written against: a session with no context, pointed at
 * a queue under deadline pressure and told "fix it". A paragraph asking it to be careful
 * will not survive that, so the guards are structural — no verdict input, no close verb,
 * and an un-adjudicated problem that is absent from the fix queue rather than filtered
 * out of it. Every guard is mutation-checked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { indexBlob } from "./repo.js";
import { writeStore } from "./store.js";
import type { State } from "./schema.js";
import { discard } from "./test-tmp.js";
import { draftSpec, addOperation, ratifySpec, listRequirements } from "./requirements.js";
import { acknowledgeDebt } from "./acknowledgements.js";
import { recordAudit } from "./audits.js";
import {
  raiseProblem, adjudicate, listProblems, awaitingAdjudication, actionable,
  settledWithoutAdjudication,
} from "./problems.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const SRC = "export function creditLine(cents) { return cents * 2; }\n";
const AGENT = { agent: true, model: "claude-opus-5" } as const;
const LATER = "2027-01-01";

async function universe() {
  const root = mkdtempSync(join(tmpdir(), "codemap-prob-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "izzie@x.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "izzie"], { cwd: root });
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/credit.js"), SRC, "utf8");
  spawnSync("git", ["add", "-A"], { cwd: root });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: root });
  const indexed = await indexBlob(SRC, "src/credit.js");
  await writeStore(root, indexed, state);
  return { root, anchors: indexed.map((a) => a.id) };
}

/**
 * Change the code the way a real edit does — INCLUDING the commit.
 *
 * Leaving the tree dirty makes every audit provisional, which is correct behaviour and was
 * silently making these fixtures unrealistic: a dirty tree witnesses the filesystem while
 * recording an unchanged HEAD, so an audit of it is about work in progress.
 */
async function editCode(root: string, src: string) {
  writeFileSync(join(root, "src/credit.js"), src, "utf8");
  spawnSync("git", ["commit", "-qam", "edit"], { cwd: root });
  await writeStore(root, await indexBlob(src, "src/credit.js"), state);
}

const ok = <T>(r: T): Exclude<T, { error: string }> => {
  assert.ok(!(r && typeof r === "object" && "error" in (r as object)), `unexpected error: ${(r as any)?.error}`);
  return r as Exclude<T, { error: string }>;
};

/** A ratified rule that the code violates, a non-conformant audit, and a raised problem. */
async function disagreement(root: string, anchors: string[]) {
  const sp = ok(await draftSpec(root, { title: "Credit currency policy" }));
  ok(await addOperation(root, {
    specId: sp.id, kind: "add_requirement", rationale: "policy §4 was never written down",
    reversibility: "reversible", title: "Credit line currency", section: "Credit/Limits",
    statement: "All credit lines are in USD.", provenance: "credit policy §4", cites: anchors,
  }));
  ok(await ratifySpec(root, sp.id));
  const rule = (await listRequirements(root))[0]!;
  const audit = ok(await recordAudit(root, {
    requirementId: rule.id, outcome: "nonconformant",
    finding: "creditLine doubles the amount and never checks currency",
    evidence: { read: anchors }, ...AGENT,
  }));
  const problem = ok(await raiseProblem(root, {
    auditId: audit.id, summary: "creditLine does not enforce USD",
    prior: "probably code-wrong, but the float exception may apply", ...AGENT,
  }));
  return { rule, audit, problem };
}

test("a problem carries no verdict an agent can set, and needs demonstrated non-conformance", async () => {
  const { root, anchors } = await universe();
  try {
    const { problem } = await disagreement(root, anchors);
    assert.equal(problem.problem.disposition, undefined, "raised un-adjudicated");
    assert.match(problem.problem.prior!, /probably code-wrong/, "the auditor's view is CONTEXT");
    assert.equal(
      (await listProblems(root))[0]!.state, "open",
      "the prior must not become the resolution",
    );

    // An `indeterminate` audit cannot produce a problem: absence of evidence must not file.
    const rule = (await listRequirements(root))[0]!;
    const vague = ok(await recordAudit(root, {
      requirementId: rule.id, outcome: "indeterminate", finding: "could not reach the ledger path",
    }));
    const refused = await raiseProblem(root, { auditId: vague.id, summary: "maybe wrong" });
    assert.ok("error" in refused);
    assert.match((refused as any).error, /absence of evidence/);
  } finally { discard(root); }
});

test("an agent cannot adjudicate, and there is no close verb to reach for instead", async () => {
  const { root, anchors } = await universe();
  try {
    const { problem } = await disagreement(root, anchors);

    const denied = await adjudicate(root, problem.id, "code-wrong", "the rule stands", AGENT);
    assert.ok("error" in denied, "an agent must not decide which side moves");
    assert.match((denied as any).error, /WHICH SIDE MOVES/);
    assert.equal((await listProblems(root))[0]!.state, "open");

    // The enforcement is that closure is not a verb at all — it is derived. The module's
    // whole export surface is checked here, so adding a `closeProblem` later trips this.
    const api = await import("./problems.js");
    assert.deepEqual(
      Object.keys(api).filter((k) => /close|resolve|dismiss/i.test(k)), [],
      "no verb may exist that marks a problem resolved",
    );

    ok(await adjudicate(root, problem.id, "code-wrong", "the rule stands; the float exception does not apply here"));
    assert.equal((await listProblems(root))[0]!.state, "adjudicated");
  } finally { discard(root); }
});

test("an un-adjudicated problem never reaches the fix queue", async () => {
  const { root, anchors } = await universe();
  try {
    const { problem } = await disagreement(root, anchors);
    assert.equal((await awaitingAdjudication(root)).length, 1);
    assert.equal(
      (await actionable(root)).length, 0,
      "the refusal is a query that never returns the row, so there is nothing to bypass",
    );

    ok(await adjudicate(root, problem.id, "code-wrong", "the rule stands"));
    assert.equal((await awaitingAdjudication(root)).length, 0);
    assert.equal((await actionable(root)).length, 1, "decided work IS actionable");
    assert.match((await actionable(root))[0]!.awaiting!, /conformant audit/);
  } finally { discard(root); }
});

test("adjudicating is not closing — the named move still has to happen", async () => {
  const { root, anchors } = await universe();
  try {
    const { rule, problem } = await disagreement(root, anchors);
    ok(await adjudicate(root, problem.id, "code-wrong", "the rule stands"));
    assert.equal((await listProblems(root))[0]!.state, "adjudicated", "saying which side moves does not move it");

    await editCode(root, "export function creditLine(cents) { return cents; }\n");
    const fresh = await indexBlob("export function creditLine(cents) { return cents; }\n", "src/credit.js");
    ok(await recordAudit(root, {
      requirementId: rule.id, outcome: "conformant", finding: "creditLine now returns cents unchanged",
      evidence: { read: fresh.map((a) => a.id) },
    }));
    assert.equal((await listProblems(root))[0]!.state, "closed");
    assert.equal((await actionable(root)).length, 0);
  } finally { discard(root); }
});

test("`accepted` closes on a granted debt acknowledgement, and not before", async () => {
  const { root, anchors } = await universe();
  try {
    const { rule, problem } = await disagreement(root, anchors);
    ok(await adjudicate(root, problem.id, "accepted", "the EUR path stays until Q3"));
    assert.equal((await listProblems(root))[0]!.state, "adjudicated");
    assert.match((await listProblems(root))[0]!.awaiting!, /debt acknowledgement/);

    ok(await acknowledgeDebt(root, {
      requirementId: rule.id, rationale: "the EUR path stays until Q3", priority: "medium", revalidateBy: LATER,
    }));
    assert.equal((await listProblems(root))[0]!.state, "closed");
  } finally { discard(root); }
});

test("`requirement-changed` closes on a ratified spec, not on the text happening to match", async () => {
  const { root, anchors } = await universe();
  try {
    const { rule, problem } = await disagreement(root, anchors);
    ok(await adjudicate(root, problem.id, "requirement-changed", "we now settle in EUR too"));
    assert.equal((await listProblems(root))[0]!.state, "adjudicated");

    const sp = ok(await draftSpec(root, { title: "EUR settlement" }));
    ok(await addOperation(root, {
      specId: sp.id, kind: "amend_statement", requirementId: rule.id, reversibility: "reversible",
      statement: "Credit lines are in USD or EUR.", rationale: "the business moved",
    }));
    assert.equal((await listProblems(root))[0]!.state, "adjudicated", "a DRAFT spec closes nothing");

    ok(await ratifySpec(root, sp.id));
    assert.equal((await listProblems(root))[0]!.state, "closed");
  } finally { discard(root); }
});

test("a problem that went away without a decision stays open, and says so", async () => {
  const { root, anchors } = await universe();
  try {
    const { rule } = await disagreement(root, anchors);
    assert.equal((await settledWithoutAdjudication(root)).length, 0);

    // Nobody adjudicated. Somebody just changed the code — resolving a business question
    // by guessing, which is the failure the record exists to catch.
    await editCode(root, "export function creditLine(cents) { return cents; }\n");
    const fresh = await indexBlob("export function creditLine(cents) { return cents; }\n", "src/credit.js");
    ok(await recordAudit(root, {
      requirementId: rule.id, outcome: "conformant", finding: "creditLine now returns cents unchanged",
      evidence: { read: fresh.map((a) => a.id) }, ...AGENT,
    }));

    const row = (await listProblems(root))[0]!;
    assert.equal(row.state, "open", "the disagreement went away; nobody decided it");
    assert.equal(row.settledWithoutAdjudication, true);
    assert.equal((await settledWithoutAdjudication(root)).length, 1);
    assert.equal((await awaitingAdjudication(root)).length, 1, "and it is still owed a decision");
  } finally { discard(root); }
});

test("retiring the rule does not close the problem either", async () => {
  const { root, anchors } = await universe();
  try {
    const { rule } = await disagreement(root, anchors);
    const sp = ok(await draftSpec(root, { title: "Withdraw the currency rule" }));
    ok(await addOperation(root, {
      specId: sp.id, kind: "retire_requirement", requirementId: rule.id,
      reversibility: "reversible", rationale: "superseded by the new credit model",
    }));
    ok(await ratifySpec(root, sp.id));

    const row = (await listProblems(root))[0]!;
    assert.equal(row.state, "open", "retire-the-rule is not an adjudication");
    assert.equal(row.settledWithoutAdjudication, true);
  } finally { discard(root); }
});

test("a problem cannot be raised from evidence that has already moved", async () => {
  const { root, anchors } = await universe();
  try {
    const sp = ok(await draftSpec(root, { title: "Credit currency policy" }));
    ok(await addOperation(root, {
      specId: sp.id, kind: "add_requirement", rationale: "x", reversibility: "reversible",
      title: "Credit line currency", section: "Credit/Limits",
      statement: "All credit lines are in USD.", provenance: "credit policy §4", cites: anchors,
    }));
    ok(await ratifySpec(root, sp.id));
    const rule = (await listRequirements(root))[0]!;
    const audit = ok(await recordAudit(root, {
      requirementId: rule.id, outcome: "nonconformant", finding: "doubles the amount",
      evidence: { read: anchors },
    }));
    // Raising it now works, so the refusal below is about the evidence having moved.
    ok(await raiseProblem(root, { auditId: audit.id, summary: "still broken" }));

    await editCode(root, "export function creditLine(cents) { return cents; }\n");
    const second = ok(await recordAudit(root, {
      requirementId: rule.id, outcome: "nonconformant", finding: "a second look",
      evidence: { read: (await indexBlob("export function creditLine(cents) { return cents; }\n", "src/credit.js")).map((a) => a.id) },
    }));
    await editCode(root, "export function creditLine(cents) { return cents + 1; }\n");

    const stale = await raiseProblem(root, { auditId: second.id, summary: "from stale evidence" });
    assert.ok("error" in stale, "on the default branch this would reach the team from evidence that no longer speaks");
    assert.match((stale as any).error, /no longer speaks/);
  } finally { discard(root); }
});

test("acts in the same millisecond still close the problem they resolve", async () => {
  const { root, anchors } = await universe();
  try {
    const { rule, problem } = await disagreement(root, anchors);
    // String-comparing ISO stamps with `>` left a problem open for ever when the
    // adjudication and the closing act landed in one millisecond, which is ordinary for
    // two sequential calls.
    const frozen = "2026-09-01T00:00:00.000Z";
    const RealDate = Date;
    // @ts-expect-error deliberately replacing the clock for one act
    globalThis.Date = class extends RealDate {
      constructor(...a: any[]) { super(...(a.length ? a : [frozen]) as []); }
      static now() { return new RealDate(frozen).getTime(); }
      toISOString() { return frozen; }
    };
    try {
      ok(await adjudicate(root, problem.id, "code-wrong", "the rule stands"));
      ok(await recordAudit(root, {
        requirementId: rule.id, outcome: "conformant", finding: "fixed", evidence: { read: anchors },
      }));
    } finally { globalThis.Date = RealDate; }
    assert.equal((await listProblems(root))[0]!.state, "closed");
  } finally { discard(root); }
});
