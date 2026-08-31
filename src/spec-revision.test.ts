/**
 * A DRAFT spec has a correction path, and a ratified one still does not.
 *
 * The whole file is about a boundary: **immutability attaches at ratification, not at
 * drafting.** So every test comes in a pair — the correction works on a draft, and the
 * identical correction is refused once the spec binds something. A file that only proved
 * the refusals would pass with the feature deleted; one that only proved the corrections
 * would pass with the boundary deleted, which is the half that matters.
 *
 * Every refusal below is MUTATION-CHECKED: each one is paired with the positive case it
 * sits beside, so deleting the guard turns a passing negative into a failing one rather
 * than into a file that silently asserts nothing. Where a guard exists in BOTH the tool
 * and the fold, both ends are tested — a rule enforced only in the tool is not enforced
 * for anybody but its author (`sharing-boundary.test.ts` §BOTH_ENDS).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { indexBlob } from "./repo.js";
import { writeStore, readOperations, readSpec } from "./store.js";
import { requirementIdFor, type Actor, type Operation, type Spec, type State } from "./schema.js";
import { discard } from "./test-tmp.js";
import { ensureSidecar } from "./sidecar.js";
import { readScope } from "./eventlog.js";
import {
  draftSpec, addOperation, ratifySpec, withdrawSpec, reviseSpec, reviseOperation,
  removeOperation, getSpec, listRequirements,
} from "./requirements.js";
import { ratifyReviewed, signOffEverything, ratifyWithReview } from "./test-approve.js";
import { acknowledgeGap, listAcknowledgements } from "./acknowledgements.js";
import {
  foldStandard, standardScope, publishSpecDrafted, publishOperation, publishSpecRatified,
  publishSpecRevised, publishOperationRevised, publishOperationRemoved, publishSpecWithdrawn,
  publishAckGranted,
} from "./shared-standard.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const SRC = "export function creditLine(cents) { return cents; }\n";
const AGENT = { agent: true, model: "claude-opus-5" } as const;
const MATE = { principal: "mate@x.com", agent: true, model: "other-model" } as const;

const ok = <T>(r: T): Exclude<T, { error: string }> => {
  assert.ok(!(r && typeof r === "object" && "error" in (r as object)), `unexpected error: ${(r as any)?.error}`);
  return r as Exclude<T, { error: string }>;
};
const err = (r: unknown): string => {
  assert.ok(r && typeof r === "object" && "error" in (r as object), `expected a refusal, got ${JSON.stringify(r)}`);
  return (r as { error: string }).error;
};

const git = (root: string, ...a: string[]) => spawnSync("git", a, { cwd: root, encoding: "utf8" });

/**
 * Run one call as somebody else.
 *
 * `commentOn` resolves its own actor and takes no principal override — the same shape
 * CLAUDE.md records for `CODEMAP_AGENT_MODEL`, and safe for the same reason: the suite is
 * `--test-concurrency=1`, and this restores the variable in `finally`.
 */
async function as<T>(principal: string, fn: () => Promise<T>): Promise<T> {
  const had = process.env.CODEMAP_PRINCIPAL;
  process.env.CODEMAP_PRINCIPAL = principal;
  try { return await fn(); } finally {
    if (had === undefined) delete process.env.CODEMAP_PRINCIPAL; else process.env.CODEMAP_PRINCIPAL = had;
  }
}

/** A committed universe. `sidecar: true` gives it somewhere for events and notes to go. */
async function universe(opts: { sidecar?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "codemap-rev-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "izzie@x.com");
  git(root, "config", "user.name", "izzie");
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/credit.js"), SRC, "utf8");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
  let side: string | null = null;
  if (opts.sidecar) {
    side = mkdtempSync(join(tmpdir(), "codemap-revside-"));
    writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
  }
  await writeStore(root, await indexBlob(SRC, "src/credit.js"), state);
  return { root, side, cleanup: () => { discard(root); if (side) discard(side); } };
}

/** A draft with one `add_requirement` on it, proposed by an agent. */
async function drafted(root: string, title = "Credit currency policy") {
  const sp = ok(await draftSpec(root, { title, narrative: "written on branch feat/typo", ...AGENT }));
  const op = ok(await addOperation(root, {
    specId: sp.id, kind: "add_requirement", rationale: "policy §4 was never written down",
    reversibility: "reversible", title: "Credit line currency", section: "Credit/Limits",
    statement: "All credit lines are in USD.", provenance: "credit policy §4", ...AGENT,
  }));
  return { specId: sp.id, opId: op.id };
}

// --- the tool ----------------------------------------------------------------

test("an agent corrects its own draft's narrative, and the correction is what renders", async () => {
  const u = await universe();
  try {
    const { specId } = await drafted(u.root);
    const r = ok(await reviseSpec(u.root, { specId, narrative: "written on branch feat/credit", ...AGENT }));
    assert.equal(r.spec.narrative, "written on branch feat/credit");
    assert.equal(r.spec.title, "Credit currency policy", "a field nobody named keeps its value");

    // ONE current text, with the old one underneath. That is the whole choice: the
    // ratifier's trade is reading N operations instead of 5,000 lines, and a correction
    // chain they have to reassemble is that trade failing at its last step.
    const served = ok(await getSpec(u.root, specId));
    assert.equal(served.spec.narrative, "written on branch feat/credit");
    assert.equal(served.spec.revisions?.length, 1);
    assert.equal(served.spec.revisions![0]!.was.narrative, "written on branch feat/typo",
      "the prior wording is kept, not destroyed");
  } finally { u.cleanup(); }
});

test("the SAME correction is refused once the spec is ratified", async () => {
  const u = await universe();
  try {
    const { specId, opId } = await drafted(u.root);
    // The positive half first, so the refusal below cannot pass because the fixture is broken.
    ok(await reviseSpec(u.root, { specId, title: "Credit currency policy v2", ...AGENT }));
    ok(await ratifyReviewed(u.root, specId));

    assert.match(err(await reviseSpec(u.root, { specId, title: "quietly different", ...AGENT })),
      /ratified/, "a ratified spec is the act that produced a rule");
    assert.match(err(await reviseOperation(u.root, { operationId: opId, statement: "All credit lines are in EUR.", ...AGENT })),
      /ratified/);
    assert.match(err(await removeOperation(u.root, { operationId: opId, reason: "second thoughts", ...AGENT })),
      /ratified/);
    // And nothing moved: the standard still says what was adopted.
    assert.equal((await listRequirements(u.root))[0]!.statement, "All credit lines are in USD.");
    assert.equal((await readSpec(u.root, specId))!.title, "Credit currency policy v2");
  } finally { u.cleanup(); }
});

test("a revised operation is re-validated exactly as the authoring path validates it", async () => {
  const u = await universe();
  try {
    const { specId, opId } = await drafted(u.root);
    // Works: a real correction lands.
    assert.equal(ok(await reviseOperation(u.root, {
      operationId: opId, statement: "All credit lines are in USD or EUR.", ...AGENT,
    })).operation.statement, "All credit lines are in USD or EUR.");

    // And a revision cannot produce what `add_operation` would have refused. A blank
    // statement, a citation on a rule, and a falsifier restating its criterion are three
    // of the checks that would have to be re-implemented if this path had its own copy.
    assert.match(err(await reviseOperation(u.root, { operationId: opId, statement: "  ", ...AGENT })), /statement/);
    assert.match(err(await reviseOperation(u.root, { operationId: opId, cites: ["a_x"], ...AGENT })), /cites nothing/);

    const crit = ok(await addOperation(u.root, {
      specId, kind: "add_criterion", rationale: "how it is discharged", reversibility: "reversible",
      targetOperationId: opId, criterion: "every credit line row carries a USD currency id",
      falsifier: "a row exists with a non-USD currency id", evidenceKind: "lint-test", ...AGENT,
    }));
    assert.match(
      err(await reviseOperation(u.root, { operationId: crit.id, falsifier: "every credit line row carries a USD currency id!", ...AGENT })),
      /restates the criterion/,
    );
  } finally { u.cleanup(); }
});

/**
 * The revision's reason is a field of its own, and `rationale` is not it.
 *
 * Its absence had a measured cost. On the first real baseline every one of the SIX revised
 * operations narrated its own revision inside `rationale` — "REVISED to be rule-shaped
 * rather than convention-shaped…" — and none of the twenty-six unrevised ones did. The
 * rationale outlives the draft, so the story went into the durable field describing a text
 * nobody can read any more.
 *
 * The negative half is what makes the positive one mean something: a reason on its own is
 * NOT a revision, so this cannot pass by the field merely being accepted and dropped.
 */
test("a correction records WHY it was made, apart from the rule's own rationale", async () => {
  const u = await universe();
  try {
    const { specId, opId } = await drafted(u.root);

    const revised = ok(await reviseOperation(u.root, {
      operationId: opId, statement: "All credit lines are in USD or EUR.",
      reason: "the original named a wire format, which is a convention and not a rule",
      ...AGENT,
    }));
    const last = revised.operation.revisions!.at(-1)!;
    assert.match(last.reason!, /wire format/);
    assert.equal(last.was.statement, "All credit lines are in USD.", "and what it said before");
    assert.equal(revised.operation.rationale, "policy §4 was never written down",
      "the rule's standing justification is untouched — the story does not leak into it");

    const spec = ok(await reviseSpec(u.root, {
      specId, narrative: "written on branch feat/credit", reason: "the branch name was wrong", ...AGENT,
    }));
    assert.match(spec.spec.revisions!.at(-1)!.reason!, /branch name/);

    // A reason with nothing changed is not a revision, so nothing is appended to explain a
    // correction that never happened.
    assert.match(err(await reviseOperation(u.root, { operationId: opId, reason: "on reflection", ...AGENT })),
      /nothing to change/);
    assert.equal((await readOperations(u.root, { specId }))[0]!.revisions!.length, 1);
  } finally { u.cleanup(); }
});

/**
 * Setting an optional field to "" is setting it to NOTHING, and the tool used to disagree
 * with the fold about that.
 *
 * `operationContent` omits both `undefined` and `""`, so the two are the same text to every
 * reader and to every witness. `changedFields` compared raw values, saw `undefined -> ""` as
 * a change, appended a revision, published it and answered `{ok: true}` — and the fold then
 * computed `moved=false, grew=true` and refused the event. A false success, and the exact
 * divergence the biconditional was added to close, arriving from the other side.
 *
 * The real clear beside it is the control: blanking a field that HAD a value is a genuine
 * change and must still work.
 */
test("blanking an already-absent field is nothing to change; blanking a set one is not", async () => {
  const u = await universe();
  try {
    const { opId } = await drafted(u.root);
    assert.match(err(await reviseOperation(u.root, { operationId: opId, evidence: "", ...AGENT })),
      /nothing to change/, "the fold would have refused this, so the tool must not accept it");

    ok(await reviseOperation(u.root, { operationId: opId, evidence: "COD-31", ...AGENT }));
    const cleared = ok(await reviseOperation(u.root, { operationId: opId, evidence: "  ", ...AGENT }));
    assert.equal(cleared.operation.evidence, undefined, "and clearing a value that existed really clears it");
    assert.equal(cleared.operation.revisions!.at(-1)!.was.evidence, "COD-31");
  } finally { u.cleanup(); }
});

/**
 * A PULLED operation is not reliance, at the end that decides for every clone.
 *
 * `relianceOn` gets this free — `readOperations` drops a tombstone by default — and
 * `foldReliance` iterated the map, where tombstones live for ever. So an operation somebody
 * had already withdrawn from a draft refused a withdrawal the tool approved, with the wrong
 * diagnosis, permanently: a spent spec cannot be re-withdrawn, so the rule could never
 * leave the standard on any clone.
 *
 * The live arm is the control: a LIVE operation citing the rule must still block, or this
 * passes on a reliance check that counts nothing.
 */
test("a tombstoned operation is not reliance, and a live one still is", async () => {
  const scenario = async (removed: boolean) => {
    const root = await log(removed ? "reliance-dead" : "reliance-live");
    await publishSpecDrafted(root, SCOPE, opus, SPEC);
    await publishOperation(root, SCOPE, opus, ADD);
    await ratifyWithReview(root, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {}, ["op_1"]);
    // A SECOND draft whose operation cites the rule the first one created.
    const sp2: Spec = { ...SPEC, id: "sp_2", title: "Amend it" };
    const cite: Operation = {
      ...ADD, id: "op_cite", specId: "sp_2", ord: 0, kind: "amend_statement",
      requirementId: requirementIdFor("op_1"), statement: "All credit lines are in EUR.",
    };
    await publishSpecDrafted(root, SCOPE, opus, sp2);
    await publishOperation(root, SCOPE, opus, cite);
    if (removed) {
      await publishOperationRemoved(root, SCOPE, opus, {
        ...cite, removed: { at: "2026-08-02T12:00:00.000Z", by: opus, reason: "wrong spec" },
      });
    }
    await publishSpecWithdrawn(root, SCOPE, izzie, "sp_1", "2026-08-03T00:00:00.000Z", "adopted in error");
    const status = (await fold(root)).specs.find((x) => x.id === "sp_1")!.status;
    discard(root);
    return status;
  };

  assert.equal(await scenario(true), "withdrawn", "a pulled operation relies on nothing");
  assert.equal(await scenario(false), "ratified", "and a live one still blocks it");
});

test("revision cannot change an operation's KIND", async () => {
  const u = await universe();
  try {
    const { opId } = await drafted(u.root);
    // Naming the same kind is not a change and is accepted, so the refusal below is about
    // the kind MOVING rather than about the field being present at all.
    ok(await reviseOperation(u.root, { operationId: opId, kind: "add_requirement", statement: "All credit lines are in GBP.", ...AGENT }));
    assert.match(err(await reviseOperation(u.root, { operationId: opId, kind: "amend_statement", ...AGENT })),
      /remove_operation/, "a different kind is a different operation, checked against other fields");
  } finally { u.cleanup(); }
});

test("a removed operation stops applying, keeps its position, and stays readable", async () => {
  const u = await universe();
  try {
    const { specId, opId } = await drafted(u.root);
    const second = ok(await addOperation(u.root, {
      specId, kind: "add_requirement", rationale: "second thought", reversibility: "reversible",
      title: "Credit line rounding", section: "Credit/Limits",
      statement: "Credit lines round to the cent.", provenance: "credit policy §5", ...AGENT,
    }));
    assert.equal(second.operation.ord, 1);

    assert.match(err(await removeOperation(u.root, { operationId: second.id, reason: " ", ...AGENT })),
      /reason/, "the ratifier is reading a proposal that changed shape");
    ok(await removeOperation(u.root, { operationId: second.id, reason: "the rounding rule belongs in Settlement", ...AGENT }));
    assert.match(err(await removeOperation(u.root, { operationId: second.id, reason: "again", ...AGENT })), /already removed/);

    // Not in the operative set, and not counted.
    const live = await readOperations(u.root, { specId });
    assert.deepEqual(live.map((o) => o.id), [opId]);
    // But still readable, with the reason on it — a proposal that changed shape is worth
    // seeing, and it is served APART so it can never be read as still proposed.
    const served = ok(await getSpec(u.root, specId));
    assert.deepEqual(served.operations.map((o) => o.operation.id), [opId]);
    assert.deepEqual(served.removed.map((o) => o.id), [second.id]);
    assert.match(served.removed[0]!.removed!.reason, /Settlement/);

    // The tombstone keeps its `ord`, so the next operation cannot claim position 1 as
    // well. Two operations sharing an ord is a sort every clone breaks differently.
    const third = ok(await addOperation(u.root, {
      specId, kind: "add_requirement", rationale: "the real second rule", reversibility: "reversible",
      title: "Credit line review", section: "Credit/Limits",
      statement: "Credit lines are reviewed annually.", provenance: "credit policy §6", ...AGENT,
    }));
    assert.equal(third.operation.ord, 2, "a count would have handed back the removed operation's position");

    // And ratification applies exactly what is left.
    ok(await ratifyReviewed(u.root, specId));
    const rules = await listRequirements(u.root);
    assert.deepEqual(rules.map((r) => r.title).sort(), ["Credit line currency", "Credit line review"]);
  } finally { u.cleanup(); }
});

test("an operation another operation in the same draft targets cannot be pulled", async () => {
  const u = await universe();
  try {
    const { specId, opId } = await drafted(u.root);
    const crit = ok(await addOperation(u.root, {
      specId, kind: "add_criterion", rationale: "how it is discharged", reversibility: "reversible",
      targetOperationId: opId, criterion: "every credit line row carries a USD currency id",
      falsifier: "a row exists with a non-USD currency id", evidenceKind: "lint-test", ...AGENT,
    }));
    assert.match(err(await removeOperation(u.root, { operationId: opId, reason: "wrong rule", ...AGENT })),
      new RegExp(crit.id), "the criterion would be left with no rule");
    // Remove the dependent first and the same call goes through — so the refusal is about
    // the dependency, not about the operation.
    ok(await removeOperation(u.root, { operationId: crit.id, reason: "criterion first", ...AGENT }));
    ok(await removeOperation(u.root, { operationId: opId, reason: "wrong rule", ...AGENT }));
  } finally { u.cleanup(); }
});

test("an agent takes back its OWN draft, and nothing else", async () => {
  const u = await universe();
  try {
    const mine = await drafted(u.root, "Mine");
    const theirs = ok(await draftSpec(u.root, { title: "Somebody else's", ...MATE }));

    assert.match(err(await withdrawSpec(u.root, theirs.id, { reason: "I disagree", ...AGENT })),
      /mate@x\.com/, "withdrawing somebody else's proposal is disposing of it");
    assert.equal((await readSpec(u.root, theirs.id))!.status, "draft");

    // Its own, though, is authorship: nothing applied, so nothing is unbound.
    ok(await withdrawSpec(u.root, mine.specId, { reason: "an empty probe I should not have left", ...AGENT }));
    assert.equal((await readSpec(u.root, mine.specId))!.status, "withdrawn");
  } finally { u.cleanup(); }
});

test("an agent still cannot withdraw a RATIFIED spec — the ratchet is unchanged", async () => {
  const u = await universe();
  try {
    const { specId } = await drafted(u.root);
    ok(await ratifyReviewed(u.root, specId));
    const e = err(await withdrawSpec(u.root, specId, { reason: "second thoughts", ...AGENT }));
    assert.match(e, /principal's act/);
    assert.equal((await readSpec(u.root, specId))!.status, "ratified");
    // And the person may, which is what makes the refusal about the ACTOR rather than
    // about the spec being unwithdrawable.
    ok(await withdrawSpec(u.root, specId, { reason: "second thoughts" }));
    assert.equal((await readSpec(u.root, specId))!.status, "withdrawn");
  } finally { u.cleanup(); }
});

test("somebody else's pending gap refuses a revision, a removal and a withdrawal", async () => {
  const u = await universe();
  try {
    const { specId, opId } = await drafted(u.root);
    // Your OWN gap does not block you — you can release it, and it is your record to move.
    const mine = ok(await acknowledgeGap(u.root, {
      operationId: opId, rationale: "nothing implements it yet", priority: "medium",
      revalidateBy: "2027-01-01", ...AGENT,
    }));
    ok(await reviseOperation(u.root, { operationId: opId, statement: "All credit lines are in USD, rounded.", ...AGENT }));
    const { releaseAcknowledgement } = await import("./acknowledgements.js");
    ok(await releaseAcknowledgement(u.root, mine.id, "mine to move", { ...AGENT }));

    // Somebody else's is an approval artifact chained to THIS operation.
    const theirs = ok(await acknowledgeGap(u.root, {
      operationId: opId, rationale: "nothing implements it yet", priority: "medium",
      revalidateBy: "2027-01-01", ...MATE,
    }));
    for (const attempt of [
      await reviseOperation(u.root, { operationId: opId, statement: "All credit lines are in EUR.", ...AGENT }),
      await removeOperation(u.root, { operationId: opId, reason: "second thoughts", ...AGENT }),
      await withdrawSpec(u.root, specId, { reason: "second thoughts", ...AGENT }),
    ]) assert.match(err(attempt), new RegExp(theirs.id));

    // Nothing moved, and the gap is still there to be refused by a ratifier.
    assert.equal((await readOperations(u.root, { specId }))[0]!.statement, "All credit lines are in USD, rounded.");
    assert.equal((await readSpec(u.root, specId))!.status, "draft");
    assert.equal((await listAcknowledgements(u.root, {})).length, 2);
  } finally { u.cleanup(); }
});

test("somebody else's COMMENT refuses the same three, and your own does not", async () => {
  const u = await universe({ sidecar: true });
  try {
    const { specId, opId } = await drafted(u.root);
    const { commentOn } = await import("./ops.js");
    ok(await commentOn(u.root, { id: opId, body: "does this cover multi-currency lines?", ...AGENT }));
    // Your own reading of your own proposal is not somebody else's record.
    ok(await reviseOperation(u.root, { operationId: opId, statement: "All credit lines are in USD, one currency per line.", ...AGENT }));

    const theirs = ok(await as("mate@x.com", () => commentOn(u.root, { id: opId, body: "§4 says otherwise", ...AGENT })));
    assert.match(err(await reviseOperation(u.root, { operationId: opId, statement: "All credit lines are in EUR.", ...AGENT })),
      new RegExp(theirs.id));
    assert.match(err(await removeOperation(u.root, { operationId: opId, reason: "second thoughts", ...AGENT })),
      new RegExp(theirs.id));
    ok(await as("mate@x.com", () => commentOn(u.root, { id: specId, body: "and the title is wrong", ...AGENT })));
    assert.match(err(await withdrawSpec(u.root, specId, { reason: "second thoughts", ...AGENT })), /answer_shared_note/);
    assert.equal((await readSpec(u.root, specId))!.status, "draft");
  } finally { u.cleanup(); }
});

// --- the fold ----------------------------------------------------------------
//
// A remote clone never saw the MCP call. Everything above has to be refused here too, or
// the guard binds one machine.

const izzie: Actor = { principal: "izzie@x.com" };
const opus: Actor = { principal: "izzie@x.com", via: { kind: "agent", model: "claude-opus-5" } };
const mate: Actor = { principal: "mate@x.com", via: { kind: "agent", model: "other-model" } };
const U = "acme/api";
const SCOPE = standardScope(U);
const SPEC: Spec = { id: "sp_1", title: "Credit currency policy", status: "draft", author: opus, createdAt: "2026-08-01T00:00:00.000Z" };
const ADD: Operation = {
  id: "op_1", specId: "sp_1", kind: "add_requirement", ord: 0,
  title: "Credit line currency", section: "Credit/Limits",
  statement: "All credit lines are in USD.", provenance: "credit policy §4",
  rationale: "policy §4 was never written down", reversibility: "reversible",
};

async function log(t: string) {
  const root = mkdtempSync(join(tmpdir(), `codemap-revfold-${t}-`));
  await ensureSidecar(root, izzie);
  await publishSpecDrafted(root, SCOPE, opus, SPEC);
  await publishOperation(root, SCOPE, opus, ADD);
  return root;
}
const fold = async (root: string) => foldStandard(await readScope(root, SCOPE));

// Every `*Revised` fixture below carries a `revisions` entry, because every real writer
// does: `reviseSpec` and `reviseOperation` append one before publishing. The fold requires
// the rewrite and the entry to arrive together — a rewrite with no entry moves text a
// ratifier already signed with nothing recording that it moved — so a fixture without one
// is testing a shape nothing emits.

test("the fold applies a draft's corrections, and refuses them once it is ratified", async () => {
  const root = await log("ratified");
  try {
    await publishSpecRevised(root, SCOPE, opus, { ...SPEC, title: "Credit currency policy v2", narrative: "corrected", revisions: [{ at: "2026-08-02T00:00:00.000Z", by: opus, was: { title: SPEC.title } }] }, "2026-08-02T00:00:00.000Z");
    await publishOperationRevised(root, SCOPE, opus, {
      ...ADD, statement: "All credit lines are in USD or EUR.",
      revisions: [{ at: "2026-08-02T00:00:00.000Z", by: opus, was: { statement: ADD.statement }, reason: "EUR lines went live in July" }],
    });
    let s = await fold(root);
    assert.equal(s.specs[0]!.title, "Credit currency policy v2", "a draft's correction folds");
    assert.equal(s.operations[0]!.statement, "All credit lines are in USD or EUR.");
    // The reason reaches the clone. It is not derivable there — a teammate folding this
    // event never saw the call — so if the fold dropped it, only the author would ever know
    // why the text they are being asked to sign off moved.
    assert.equal(s.operations[0]!.revisions?.at(-1)?.reason, "EUR lines went live in July");

    await ratifyWithReview(root, SCOPE, izzie, "sp_1", "2026-08-03T00:00:00.000Z", {}, ["op_1"]);
    // The identical events, after adoption. Dropped — a ratified spec is the act that
    // produced a rule, and rewriting it would rewrite the standard's own provenance.
    await publishSpecRevised(root, SCOPE, opus, { ...SPEC, title: "quietly different", revisions: [{ at: "2026-08-02T00:00:00.000Z", by: opus, was: { title: SPEC.title } }] }, "2026-08-04T00:00:00.000Z");
    await publishOperationRevised(root, SCOPE, opus, { ...ADD, statement: "All credit lines are in GBP.", revisions: [{ at: "2026-08-02T00:00:00.000Z", by: opus, was: { statement: ADD.statement } }] });
    await publishOperationRemoved(root, SCOPE, opus, { ...ADD, removed: { at: "2026-08-04T00:00:00.000Z", by: opus, reason: "second thoughts" } });
    s = await fold(root);
    assert.equal(s.specs[0]!.title, "Credit currency policy v2");
    assert.equal(s.operations[0]!.statement, "All credit lines are in USD or EUR.");
    assert.equal(s.operations[0]!.removed, undefined);
    assert.equal(s.requirements[0]!.statement, "All credit lines are in USD or EUR.", "and the standard is untouched");
  } finally { discard(root); }
});

test("the fold refuses a kind change, a reasonless removal, and a removal something targets", async () => {
  const root = await log("shape");
  try {
    const CRIT: Operation = {
      id: "op_2", specId: "sp_1", kind: "add_criterion", ord: 1, targetOperationId: "op_1",
      criterion: "every row carries a USD currency id", falsifier: "a row carries another",
      evidenceKind: "lint-test", rationale: "how it is discharged",
      reversibility: "reversible",
    };
    await publishOperation(root, SCOPE, opus, CRIT);
    await publishOperationRevised(root, SCOPE, opus, { ...ADD, kind: "amend_statement", statement: "x", revisions: [{ at: "2026-08-02T00:00:00.000Z", by: opus, was: { statement: ADD.statement } }] });
    // The criterion still targets op_1, so this removal has TWO reasons to be refused.
    await publishOperationRemoved(root, SCOPE, opus, { ...ADD, removed: { at: "2026-08-02T00:00:00.000Z", by: opus, reason: "wrong rule" } });
    // And this one has exactly one — nothing targets the criterion, so only the blank
    // reason can refuse it. Kept apart because a shadowed guard is a guard nothing tests.
    await publishOperationRemoved(root, SCOPE, opus, { ...CRIT, removed: { at: "2026-08-02T00:00:00.000Z", by: opus, reason: "  " } });
    let s = await fold(root);
    assert.equal(s.operations.find((o) => o.id === "op_1")!.kind, "add_requirement", "a kind change is a different operation");
    assert.equal(s.operations.find((o) => o.id === "op_1")!.removed, undefined,
      "the criterion still targets it");
    assert.equal(s.operations.find((o) => o.id === "op_2")!.removed, undefined,
      "and a removal with a blank reason says nothing to the ratifier, so it does not land");

    // Drop the criterion with a real reason and the identical op_1 removal lands — so both
    // refusals were about what they said they were about.
    await publishOperationRemoved(root, SCOPE, opus, { ...CRIT, removed: { at: "2026-08-03T00:00:00.000Z", by: opus, reason: "criterion first" } });
    await publishOperationRemoved(root, SCOPE, opus, { ...ADD, removed: { at: "2026-08-03T00:00:00.000Z", by: opus, reason: "wrong rule" } });
    s = await fold(root);
    assert.match(s.operations.find((o) => o.id === "op_1")!.removed!.reason, /wrong rule/);
    assert.match(s.operations.find((o) => o.id === "op_2")!.removed!.reason, /criterion first/);
  } finally { discard(root); }
});

/**
 * The withdrawal count must see the same LIVE set the tool sees.
 *
 * `withdrawSpec` counts live operations only — `readOperations` drops a tombstone by
 * default — and the fold counted every row, so it saw an operation the tool never did.
 * A ratified spec whose only non-`add_requirement` operation had been REMOVED from the
 * draft was refusable at this end for ever, with the wrong diagnosis ("it amended, retired
 * or re-filed pre-existing state"). A spent spec cannot be re-withdrawn, so the rule could
 * never leave the standard on any clone.
 *
 * Four lines above the bug, `mineSoFar` already had `!o.removed`. This is the same filter
 * on the other branch.
 */
test("a removed operation does not block a withdrawal the tool would allow", async () => {
  const root = await log("withdraw-tombstone");
  try {
    // An `amend_statement` — the kind that makes a ratified spec unwithdrawable — pulled
    // out of the draft before it was ever adopted.
    await publishOperation(root, SCOPE, opus, {
      ...ADD, id: "op_gone", ord: 1, kind: "amend_statement",
      requirementId: "req_elsewhere", statement: "Something else entirely.",
      removed: { at: "2026-08-01T12:00:00.000Z", by: opus, reason: "wrong spec" },
    });
    await ratifyWithReview(root, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {}, ["op_1"]);
    assert.equal((await fold(root)).requirements.length, 1, "the live operation applied");

    await publishSpecWithdrawn(root, SCOPE, izzie, "sp_1", "2026-08-03T00:00:00.000Z", "adopted in error");
    const s = await fold(root);
    assert.equal(s.specs[0]!.status, "withdrawn", "a tombstone is not something the spec introduced");
    assert.equal(s.requirements.length, 0, "and the rule it created goes with it");
  } finally { discard(root); }

  // A LIVE amendment still blocks it, so the filter is about `removed` and not about the
  // guard having been weakened.
  const live = await log("withdraw-live");
  try {
    await publishOperation(live, SCOPE, opus, {
      ...ADD, id: "op_live", ord: 1, kind: "amend_statement",
      requirementId: requirementIdFor("op_1"), statement: "Amended in the same spec.",
    });
    await ratifyWithReview(live, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {}, ["op_1", "op_live"]);
    await publishSpecWithdrawn(live, SCOPE, izzie, "sp_1", "2026-08-03T00:00:00.000Z", "second thoughts");
    assert.equal((await fold(live)).specs[0]!.status, "ratified", "an amendment can only be REPEALED");
  } finally { discard(live); }
});

test("the fold lets an agent withdraw its own draft, and only that", async () => {
  const root = await log("withdraw");
  try {
    // Somebody else's agent: refused, exactly as the tool refuses it.
    await publishSpecWithdrawn(root, SCOPE, mate, "sp_1", "2026-08-02T00:00:00.000Z", "I disagree");
    assert.equal((await fold(root)).specs[0]!.status, "draft");

    // Its own principal's draft: allowed. Nothing applied, so nothing is unbound.
    await publishSpecWithdrawn(root, SCOPE, opus, "sp_1", "2026-08-03T00:00:00.000Z", "an empty probe");
    const s = await fold(root);
    assert.equal(s.specs[0]!.status, "withdrawn");
    assert.equal(s.specs[0]!.withdrawnBy!.via!.model, "claude-opus-5", "and it is recorded as the agent's act");
  } finally { discard(root); }
});

test("the fold refuses an agent's withdrawal of a RATIFIED spec, and one somebody else's gap sits on", async () => {
  const root = await log("gated");
  try {
    await publishAckGranted(root, SCOPE, mate, {
      id: "ack_1", basis: "gap", operationId: "op_1", state: "pending",
      rationale: "nothing implements it yet", priority: "medium", revalidateBy: "2027-01-01",
      grantedBy: mate, grantedAt: "2026-08-02T00:00:00.000Z",
    });
    // A pending gap somebody else granted: the agent's own draft, and still refused.
    await publishSpecWithdrawn(root, SCOPE, opus, "sp_1", "2026-08-03T00:00:00.000Z", "second thoughts");
    await publishOperationRevised(root, SCOPE, opus, { ...ADD, statement: "All credit lines are in EUR.", revisions: [{ at: "2026-08-02T00:00:00.000Z", by: opus, was: { statement: ADD.statement } }] });
    let s = await fold(root);
    assert.equal(s.specs[0]!.status, "draft", "somebody else's approval is chained to this proposal");
    assert.equal(s.operations[0]!.statement, "All credit lines are in USD.", "and it cannot be rewritten under them");

    // Released, and the same two events land — so both refusals were about the gap.
    const { publishAckReleased } = await import("./shared-standard.js");
    await publishAckReleased(root, SCOPE, mate, "ack_1", "2026-08-04T00:00:00.000Z", "withdrawn by its author");
    await publishOperationRevised(root, SCOPE, opus, { ...ADD, statement: "All credit lines are in EUR.", revisions: [{ at: "2026-08-02T00:00:00.000Z", by: opus, was: { statement: ADD.statement } }] });
    await publishSpecWithdrawn(root, SCOPE, opus, "sp_1", "2026-08-05T00:00:00.000Z", "second thoughts");
    s = await fold(root);
    assert.equal(s.operations[0]!.statement, "All credit lines are in EUR.");
    assert.equal(s.specs[0]!.status, "withdrawn");

    // And the ratified case stays exactly as it was: an agent may never unbind.
    const other = await log("gated-ratified");
    try {
      await ratifyWithReview(other, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {}, ["op_1"]);
      await publishSpecWithdrawn(other, SCOPE, opus, "sp_1", "2026-08-03T00:00:00.000Z", "second thoughts");
      assert.equal((await fold(other)).specs[0]!.status, "ratified");
      assert.equal((await fold(other)).requirements.length, 1);
    } finally { discard(other); }
  } finally { discard(root); }
});

test("a correction travels: a teammate's clone folds the corrected text, not the original", async () => {
  const u = await universe({ sidecar: true });
  try {
    const { specId, opId } = await drafted(u.root);
    ok(await reviseSpec(u.root, { specId, title: "Credit currency policy v2", ...AGENT }));
    ok(await reviseOperation(u.root, { operationId: opId, statement: "All credit lines are in USD or EUR.", ...AGENT }));
    const second = ok(await addOperation(u.root, {
      specId, kind: "add_requirement", rationale: "second thought", reversibility: "reversible",
      title: "Credit line rounding", section: "Credit/Limits",
      statement: "Credit lines round to the cent.", provenance: "credit policy §5", ...AGENT,
    }));
    ok(await removeOperation(u.root, { operationId: second.id, reason: "belongs in Settlement", ...AGENT }));

    const { lawScope } = await import("./shared-standard.js");
    const kinds = (await readScope(u.side!, lawScope())).map((e) => e.kind);
    assert.deepEqual(kinds, [
      "spec.drafted", "spec.operation", "spec.revised", "spec.operation.revised",
      "spec.operation", "spec.operation.removed",
    ], "each correction is an ACT, and acts enter the log");

    // Read back through the ROWS, which on this store the fold wrote.
    const served = ok(await getSpec(u.root, specId));
    assert.equal(served.spec.origin, "sync");
    assert.equal(served.spec.title, "Credit currency policy v2");
    assert.deepEqual(served.operations.map((o) => o.operation.statement), ["All credit lines are in USD or EUR."]);
    assert.deepEqual(served.removed.map((o) => o.id), [second.id]);
  } finally { u.cleanup(); }
});
