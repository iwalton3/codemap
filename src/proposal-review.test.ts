/**
 * The reviewer's witness: ratifying something that changed since you read it is refused.
 *
 * Every other check in `ratifySpec` asks whether the WORLD moved under the proposal. These
 * are about the one that asks whether the proposal moved under the REVIEWER — which nothing
 * asked before, and which `revise_operation` (open to any actor, correctly) makes reachable.
 *
 * The shape every test here follows: prove the loop WORKS, then break exactly one thing and
 * prove adoption refuses. A file that only proved the refusals would pass with sign-off
 * deleted, since nothing would ever be witnessed; one that only proved the loop would pass
 * with the gate deleted. Both halves, every time.
 *
 * Both ends where a guard has two: `ratifySpec` and `foldStandard`. A signature check that
 * binds only the machine that ran it is not a signature check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { indexBlob } from "./repo.js";
import { writeStore, readSpec, readOperations, readProposalWitnesses } from "./store.js";
import type { Actor, Operation, Spec, State } from "./schema.js";
import { framingContent, operationContent, witnessHash, contentDiff } from "./schema.js";
import { discard } from "./test-tmp.js";
import { ensureSidecar } from "./sidecar.js";
import { readScope } from "./eventlog.js";
import {
  draftSpec, addOperation, ratifySpec, reviseSpec, reviseOperation, removeOperation,
  reviewProposal, signOffOperation, signOffFraming, signOffSection, getSpec, listRequirements,
} from "./requirements.js";
import { signOffEverything, ratifyReviewed, ratifyWithReview } from "./test-approve.js";
import {
  foldStandard, standardScope, publishSpecDrafted, publishOperation, publishSpecRatified,
  publishSpecReviewed,
} from "./shared-standard.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const SRC = "export function creditLine(cents) { return cents; }\n";
const AGENT = { agent: true, model: "claude-opus-5" } as const;

const ok = <T>(r: T): Exclude<T, { error: string }> => {
  assert.ok(!(r && typeof r === "object" && "error" in (r as object)), `unexpected error: ${(r as any)?.error}`);
  return r as Exclude<T, { error: string }>;
};
const err = (r: unknown): string => {
  assert.ok(r && typeof r === "object" && "error" in (r as object), `expected a refusal, got ${JSON.stringify(r)}`);
  return (r as { error: string }).error;
};
const git = (root: string, ...a: string[]) => spawnSync("git", a, { cwd: root, encoding: "utf8" });

async function universe(opts: { sidecar?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "codemap-rev-w-"));
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
    side = mkdtempSync(join(tmpdir(), "codemap-rev-w-side-"));
    writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
  }
  await writeStore(root, await indexBlob(SRC, "src/credit.js"), state);
  return { root, side, cleanup: () => { discard(root); if (side) discard(side); } };
}

/** A draft with two `add_requirement` operations, proposed by an agent. */
async function drafted(root: string) {
  const sp = ok(await draftSpec(root, { title: "Credit currency policy", narrative: "on branch feat/typo", ...AGENT }));
  const a = ok(await addOperation(root, {
    specId: sp.id, kind: "add_requirement", rationale: "policy §4 was never written down",
    reversibility: "reversible", title: "Credit line currency", section: "Credit/Limits",
    statement: "All credit lines are in USD.", provenance: "credit policy §4", ...AGENT,
  }));
  const b = ok(await addOperation(root, {
    specId: sp.id, kind: "add_requirement", rationale: "rounding was never written down",
    reversibility: "reversible", title: "Credit line rounding", section: "Settlement/Sweep",
    statement: "Credit lines round to the cent.", provenance: "treasury practice", ...AGENT,
  }));
  return { specId: sp.id, a: a.id, b: b.id };
}

// --- the loop, and the gate --------------------------------------------------

test("an unread proposal cannot be adopted, and the same one can once it is signed", async () => {
  const u = await universe();
  try {
    const { specId } = await drafted(u.root);
    const refused = await ratifySpec(u.root, specId);
    assert.match(err(refused), /never signed off/);
    assert.equal((await listRequirements(u.root)).length, 0, "and nothing landed");

    // The refusal is STRUCTURED, not just prose: the caller can route to what it has not
    // approved rather than parse a sentence.
    const gap = (refused as { review?: any }).review;
    assert.equal(gap.reviewer, "izzie@x.com");
    assert.equal(gap.total, 2);
    assert.equal(gap.unwitnessed.length, 2);
    assert.equal(gap.framing.state, "unwitnessed");
    assert.ok(gap.unwitnessed.every((x: any) => x.id && x.kind && x.title), "each names what it is");

    ok(await signOffEverything(u.root, specId));
    ok(await ratifySpec(u.root, specId));
    assert.equal((await listRequirements(u.root)).length, 2);
  } finally { u.cleanup(); }
});

test("signing off the operations is not signing off the FRAMING", async () => {
  const u = await universe();
  try {
    const { specId } = await drafted(u.root);
    for (const op of await readOperations(u.root, { specId })) {
      ok(await signOffOperation(u.root, { operationId: op.id }));
    }
    // Every operation read, and still refused: the narrative is what each of them is read
    // UNDER, and this one names the wrong branch.
    assert.match(err(await ratifySpec(u.root, specId)), /title and narrative are unread/);
    ok(await signOffFraming(u.root, { specId }));
    ok(await ratifySpec(u.root, specId));
  } finally { u.cleanup(); }
});

test("correcting the narrative invalidates the reading of the whole proposal", async () => {
  const u = await universe();
  try {
    const { specId } = await drafted(u.root);
    ok(await signOffEverything(u.root, specId));
    // The real case: the narrative named the wrong git branch, and the framing a reviewer
    // decided under was wrong.
    ok(await reviseSpec(u.root, { specId, narrative: "on branch feat/credit", ...AGENT }));

    const refused = await ratifySpec(u.root, specId);
    const gap = (refused as { review?: any }).review;
    assert.equal(gap.framing.state, "moved");
    assert.deepEqual(gap.framing.changed.map((c: any) => c.field), ["narrative"]);
    assert.match(gap.framing.changed[0].was, /feat\/typo/);
    assert.match(gap.framing.changed[0].now, /feat\/credit/);
    assert.equal(gap.moved.length, 0, "no OPERATION moved — the frame did");

    ok(await signOffFraming(u.root, { specId }));
    ok(await ratifySpec(u.root, specId));
  } finally { u.cleanup(); }
});

test("an operation revised after sign-off is refused, and the refusal says what moved", async () => {
  const u = await universe();
  try {
    const { specId, a } = await drafted(u.root);
    ok(await signOffEverything(u.root, specId));
    ok(await reviseOperation(u.root, { operationId: a, statement: "All credit lines are in EUR.", ...AGENT }));

    const refused = await ratifySpec(u.root, specId);
    const gap = (refused as { review?: any }).review;
    assert.equal(gap.unwitnessed.length, 0, "it was read — it moved afterwards, which is a different thing");
    assert.deepEqual(gap.moved.map((m: any) => m.id), [a]);
    assert.deepEqual(gap.moved[0].changed, [{ field: "statement", was: "All credit lines are in USD.", now: "All credit lines are in EUR." }]);
    assert.ok(gap.moved[0].readAt, "and when you read it");

    ok(await signOffOperation(u.root, { operationId: a }));
    ok(await ratifySpec(u.root, specId));
    assert.equal((await listRequirements(u.root)).find((r) => r.title === "Credit line currency")!.statement,
      "All credit lines are in EUR.");
  } finally { u.cleanup(); }
});

test("the RATIONALE is signed too — the whole rendering, not the operative half", async () => {
  const u = await universe();
  try {
    const { specId, a } = await drafted(u.root);
    ok(await signOffEverything(u.root, specId));
    // A statement nobody touched, and a reason to adopt it that is now entirely different.
    // Splitting "operative" from "explanatory" would let the half that persuades change
    // under a signature that covered only the half that applies.
    ok(await reviseOperation(u.root, { operationId: a, rationale: "the regulator now demands it", ...AGENT }));
    const gap = (await ratifySpec(u.root, specId) as { review?: any }).review;
    assert.deepEqual(gap.moved.map((m: any) => m.changed[0].field), ["rationale"]);
  } finally { u.cleanup(); }
});

test("revising back to identical text does NOT invalidate a reading", async () => {
  const u = await universe();
  try {
    const { specId, a } = await drafted(u.root);
    ok(await signOffEverything(u.root, specId));
    ok(await reviseOperation(u.root, { operationId: a, statement: "All credit lines are in EUR.", ...AGENT }));
    assert.match(err(await ratifySpec(u.root, specId)), /changed since/);
    // ...and back. A content hash says nothing you read has changed; a version counter or a
    // timestamp would say it had, and would make every reviewer re-read a correction of a
    // correction that ended where it started.
    ok(await reviseOperation(u.root, { operationId: a, statement: "All credit lines are in USD.", ...AGENT }));
    ok(await ratifySpec(u.root, specId));
  } finally { u.cleanup(); }
});

test("removing an operation after sign-off leaves the rest signed", async () => {
  const u = await universe();
  try {
    const { specId, b } = await drafted(u.root);
    ok(await signOffEverything(u.root, specId));
    ok(await removeOperation(u.root, { operationId: b, reason: "rounding belongs in its own spec", ...AGENT }));
    // The proposal shrank to text this reviewer HAS read, so it is adoptable. A witness of
    // an operation nobody is adopting is not a gap in anybody's reading.
    ok(await ratifySpec(u.root, specId));
    assert.deepEqual((await listRequirements(u.root)).map((r) => r.title), ["Credit line currency"]);
  } finally { u.cleanup(); }
});

test("adding an operation after sign-off is NOT covered by it", async () => {
  const u = await universe();
  try {
    const { specId } = await drafted(u.root);
    ok(await signOffEverything(u.root, specId));
    const late = ok(await addOperation(u.root, {
      specId, kind: "add_requirement", rationale: "slipped in afterwards",
      reversibility: "irreversible", title: "Credit line freeze", section: "Credit/Limits",
      statement: "A credit line may be frozen without notice.", provenance: "ours", ...AGENT,
    }));
    const gap = (await ratifySpec(u.root, specId) as { review?: any }).review;
    assert.deepEqual(gap.unwitnessed.map((x: any) => x.id), [late.id]);
  } finally { u.cleanup(); }
});

// --- who may sign ------------------------------------------------------------

test("an agent may not sign off — that would void the gate in one step", async () => {
  const u = await universe();
  try {
    const { specId, a } = await drafted(u.root);
    for (const attempt of [
      await signOffFraming(u.root, { specId, ...AGENT }),
      await signOffOperation(u.root, { operationId: a, ...AGENT }),
      await signOffSection(u.root, { specId, axis: "spec", count: 2, ...AGENT }),
    ]) assert.match(err(attempt), /principal's act/);
    assert.equal((await readProposalWitnesses(u.root, { specId })).length, 0);

    // The person may, so the refusal is about WHO rather than a malformed call.
    ok(await signOffFraming(u.root, { specId }));
    assert.equal((await readProposalWitnesses(u.root, { specId })).length, 1);
  } finally { u.cleanup(); }
});

test("one person's reading is not another's", async () => {
  const u = await universe();
  try {
    const { specId } = await drafted(u.root);
    ok(await signOffEverything(u.root, specId, { principal: "mate@x.com" }));
    // Everything is signed — by somebody else. Adoption is the act that produces
    // accountability, so it is the ratifier's own reading that is asked for.
    assert.match(err(await ratifySpec(u.root, specId)), /never signed off/);
    const served = ok(await getSpec(u.root, specId));
    assert.deepEqual(served.reviewers, [{ principal: "mate@x.com", signed: 3 }],
      "and who HAS read it is visible, which is the next question a ratifier asks");
    ok(await signOffEverything(u.root, specId));
    ok(await ratifySpec(u.root, specId));
  } finally { u.cleanup(); }
});

// --- bulk sign-off -----------------------------------------------------------

test("a bulk sign-off must say how many it is signing", async () => {
  const u = await universe();
  try {
    const { specId } = await drafted(u.root);
    // The whole proposal: two operations, and saying "one" is refused rather than accepted
    // and applied to whatever it found. A caller told it would sign two has learned
    // something the moment it mattered.
    assert.match(err(await signOffSection(u.root, { specId, axis: "spec", count: 1 })), /sign off 2 operation/);
    assert.equal((await readProposalWitnesses(u.root, { specId })).length, 0, "and nothing was signed");

    const done = ok(await signOffSection(u.root, { specId, axis: "spec", count: 2 }));
    assert.equal(done.signed, 2);
    // Recorded AS a bulk act: twelve witnesses that each claim an operation was read
    // individually are a different claim from twelve written by one call.
    const written = await readProposalWitnesses(u.root, { specId });
    assert.equal(written.length, 2);
    assert.ok(written.every((w) => w.bulk?.count === 2 && w.bulk.axis === "spec"));
    // The framing is not an operation and is not swept up by a bulk sign-off.
    assert.match(err(await ratifySpec(u.root, specId)), /title and narrative are unread/);
  } finally { u.cleanup(); }
});

test("the standard axis signs one heading, and only its members", async () => {
  const u = await universe();
  try {
    const { specId, a, b } = await drafted(u.root);
    assert.match(err(await signOffSection(u.root, { specId, axis: "standard", count: 1 })), /needs a `section`/);
    assert.match(err(await signOffSection(u.root, { specId, axis: "standard", section: "Nowhere", count: 1 })), /no operation/);

    const done = ok(await signOffSection(u.root, { specId, axis: "standard", section: "Credit/Limits", count: 1 }));
    assert.deepEqual(done.witnesses.map((w) => w.operationId), [a]);
    // The other heading is untouched, which is the point of grouping by it at all.
    const gap = (await ratifySpec(u.root, specId) as { review?: any }).review;
    assert.deepEqual(gap.unwitnessed.map((x: any) => x.id), [b]);
  } finally { u.cleanup(); }
});

test("the spec axis has ONE group, and says so rather than inventing a heading", async () => {
  const u = await universe();
  try {
    const { specId } = await drafted(u.root);
    assert.match(
      err(await signOffSection(u.root, { specId, axis: "spec", section: "Background", count: 2 })),
      /one group/,
      "a spec's internal hierarchy is narrative and nothing stores it",
    );
    // Matched on the VOCABULARY, not on the word "axis": falling through to the standard
    // branch produces "`axis: \"standard\"` needs a `section`", which contains it — so the
    // loose assertion passed with the enum check deleted.
    assert.match(
      err(await signOffSection(u.root, { specId, axis: "sideways" as any, count: 2 })),
      /must be one of standard \| spec/,
    );
  } finally { u.cleanup(); }
});

// --- the loop's first step ---------------------------------------------------

test("review_proposal shows what moved since you last looked", async () => {
  const u = await universe();
  try {
    const { specId, a } = await drafted(u.root);
    const fresh = ok(await reviewProposal(u.root, specId));
    assert.equal(fresh.complete, false);
    assert.equal(fresh.review.unwitnessed.length, 2);

    ok(await signOffEverything(u.root, specId));
    assert.equal(ok(await reviewProposal(u.root, specId)).complete, true);

    ok(await reviseOperation(u.root, { operationId: a, statement: "All credit lines are in EUR.", ...AGENT }));
    const after = ok(await reviewProposal(u.root, specId));
    assert.equal(after.complete, false);
    assert.deepEqual(after.review.moved[0]!.changed.map((c) => c.field), ["statement"]);
  } finally { u.cleanup(); }
});

/**
 * Two clones of ONE universe on ONE log — they must share a directory BASENAME, or
 * `universeKey` takes its fallback and they publish to different universes and never see
 * each other, which would make this pass while testing nothing.
 */
async function twoClones() {
  const side = mkdtempSync(join(tmpdir(), "codemap-rev-w-side2-"));
  const roots: string[] = [];
  for (const parent of [mkdtempSync(join(tmpdir(), "codemap-rw-a-")), mkdtempSync(join(tmpdir(), "codemap-rw-b-"))]) {
    const root = join(parent, "acme-api");
    mkdirSync(join(root, ".codemap"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "izzie@x.com");
    git(root, "config", "user.name", "izzie");
    writeFileSync(join(root, "src/credit.js"), SRC, "utf8");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");
    writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
    await writeStore(root, await indexBlob(SRC, "src/credit.js"), state);
    roots.push(root);
  }
  return { a: roots[0]!, b: roots[1]!, side };
}

test("a sign-off refuses when the pull moves the very thing being signed", async () => {
  const { a, b, side } = await twoClones();
  try {
    const { specId, a: opId } = await drafted(a);
    const { materializeStandard } = await import("./standard-publish.js");
    const { resolveSidecar } = await import("./sidecar-config.js");
    assert.equal(await materializeStandard(b, resolveSidecar(b)!), true);

    // B revises the operation. A has not folded it, so A's rows still say what A last saw —
    // which is the state a reviewer is looking at when they reach for sign-off.
    ok(await reviseOperation(b, { operationId: opId, statement: "All credit lines are in EUR.", ...AGENT }));
    assert.equal((await readOperations(a, { specId })).find((o) => o.id === opId)!.statement,
      "All credit lines are in USD.", "A is still reading the old text");

    // A signs off. The sign-off PULLS first, so B's revision arrives mid-call — and
    // recording the witness now would say A had read text that landed during the call.
    const refused = await signOffOperation(a, { operationId: opId });
    assert.match(err(refused), /changed while you were signing it off/);
    assert.match(err(refused), /statement/, "and says which field, so the answer is to read it");
    assert.equal((await readProposalWitnesses(a, { specId, operationId: opId })).length, 0,
      "nothing was witnessed — a witness of unread text is the thing this exists to prevent");

    // Read it, then sign it: the same call goes through, so the refusal was about the
    // change arriving rather than about sign-off being broken on a shared store.
    ok(await reviewProposal(a, specId));
    ok(await signOffOperation(a, { operationId: opId }));
    assert.equal((await readProposalWitnesses(a, { specId, operationId: opId }))[0]!.content.statement,
      "All credit lines are in EUR.");
  } finally { discard(a); discard(b); discard(side); }
});

// --- the fold ----------------------------------------------------------------

const izzie: Actor = { principal: "izzie@x.com" };
const opus: Actor = { principal: "izzie@x.com", via: { kind: "agent", model: "claude-opus-5" } };
const mate: Actor = { principal: "mate@x.com" };
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
  const root = mkdtempSync(join(tmpdir(), `codemap-rev-w-fold-${t}-`));
  await ensureSidecar(root, izzie);
  await publishSpecDrafted(root, SCOPE, opus, SPEC);
  await publishOperation(root, SCOPE, opus, ADD);
  return root;
}
const fold = async (root: string) => foldStandard(await readScope(root, SCOPE));

test("THE FOLD REFUSES A RATIFICATION ITS RATIFIER NEVER SIGNED", async () => {
  const root = await log("unread");
  try {
    await publishSpecRatified(root, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {}, ["op_1"]);
    let s = await fold(root);
    assert.equal(s.requirements.length, 0, "no clone applies an adoption nobody witnessed");
    assert.equal(s.specs[0]!.conflicted, true, "and the ratification really happened, so the record says so");

    // The same event in a FRESH log, once the readings that should have preceded it are
    // there — so the refusal above was about the witness and not about anything else. A
    // second ratification into the same log proves nothing: a spec that has been ratified
    // once is spent, conflicted or not, and the fold skips it.
    const clean = await log("unread-ok");
    try {
      await ratifyWithReview(clean, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {}, ["op_1"]);
      assert.equal((await fold(clean)).requirements.length, 1);
    } finally { discard(clean); }
  } finally { discard(root); }
});

test("the fold refuses one signed by somebody ELSE, and one signed at a text that has since moved", async () => {
  const root = await log("stale");
  try {
    // mate reads it; izzie ratifies it. A reading is not transferable.
    await publishSpecReviewed(root, SCOPE, mate, {
      id: "rw_1", specId: "sp_1", reviewer: mate, at: "2026-08-02T00:00:00.000Z", content: framingContent(SPEC),
    });
    await publishSpecReviewed(root, SCOPE, mate, {
      id: "rw_2", specId: "sp_1", operationId: "op_1", reviewer: mate, at: "2026-08-02T00:00:00.000Z", content: operationContent(ADD),
    });
    await publishSpecRatified(root, SCOPE, izzie, "sp_1", "2026-08-03T00:00:00.000Z", {}, ["op_1"]);
    assert.equal((await fold(root)).requirements.length, 0, "mate's reading is not izzie's");

    // izzie reads it, and the text moves under her before she adopts it. A fresh log,
    // because the spec above is spent — a second ratification into it would be skipped for
    // a reason that has nothing to do with what this asserts.
    const moved = await log("stale-moved");
    try {
      await publishSpecReviewed(moved, SCOPE, izzie, {
        id: "rw_3", specId: "sp_1", reviewer: izzie, at: "2026-08-04T00:00:00.000Z", content: framingContent(SPEC),
      });
      await publishSpecReviewed(moved, SCOPE, izzie, {
        id: "rw_4", specId: "sp_1", operationId: "op_1", reviewer: izzie, at: "2026-08-04T00:00:00.000Z",
        content: operationContent({ ...ADD, statement: "All credit lines are in EUR." }),
      });
      await publishSpecRatified(moved, SCOPE, izzie, "sp_1", "2026-08-05T00:00:00.000Z", {}, ["op_1"]);
      assert.equal((await fold(moved)).requirements.length, 0, "she signed a version this is not");
    } finally { discard(moved); }

    // And at the text it actually says, it binds — so both refusals were about the witness.
    const good = await log("stale-ok");
    try {
      await ratifyWithReview(good, SCOPE, izzie, "sp_1", "2026-08-06T00:00:00.000Z", {}, ["op_1"]);
      assert.equal((await fold(good)).requirements.length, 1);
    } finally { discard(good); }
  } finally { discard(root); }
});

test("the fold drops an AGENT's sign-off, so an agent cannot clear the gate for its principal", async () => {
  const root = await log("agentsign");
  try {
    // Same principal, and an agent — which is exactly the shortest path: sign as the agent,
    // ratify as the person, having read nothing.
    for (const w of [
      { id: "rw_a", content: framingContent(SPEC) },
      { id: "rw_b", operationId: "op_1", content: operationContent(ADD) },
    ]) {
      await publishSpecReviewed(root, SCOPE, opus, { specId: "sp_1", reviewer: opus, at: "2026-08-02T00:00:00.000Z", ...w } as any);
    }
    await publishSpecRatified(root, SCOPE, izzie, "sp_1", "2026-08-03T00:00:00.000Z", {}, ["op_1"]);
    assert.equal((await fold(root)).requirements.length, 0);
    assert.equal((await fold(root)).witnesses.length, 0, "the agent's sign-off is not a row anywhere");

    // The person's own reading of the identical text does bind — in a fresh log, since the
    // spec above is spent.
    const clean = await log("agentsign-ok");
    try {
      await ratifyWithReview(clean, SCOPE, izzie, "sp_1", "2026-08-04T00:00:00.000Z", {}, ["op_1"]);
      assert.equal((await fold(clean)).requirements.length, 1);
    } finally { discard(clean); }
  } finally { discard(root); }
});

test("the fold takes the reviewer from the EVENT, never from the row's own claim", async () => {
  const root = await log("forged");
  try {
    // A row that names its own reviewer is a row one clone can use to write another
    // person's approval — and the approval is the whole of the gate. The event's actor is
    // the only thing a receiving clone has any reason to believe.
    await publishSpecReviewed(root, SCOPE, mate, {
      id: "rw_f1", specId: "sp_1", reviewer: izzie, at: "2026-08-02T00:00:00.000Z", content: framingContent(SPEC),
    });
    await publishSpecReviewed(root, SCOPE, mate, {
      id: "rw_f2", specId: "sp_1", operationId: "op_1", reviewer: izzie, at: "2026-08-02T00:00:00.000Z", content: operationContent(ADD),
    });
    const folded = await fold(root);
    assert.deepEqual(folded.witnesses.map((w) => w.reviewer.principal), ["mate@x.com", "mate@x.com"],
      "the payload said izzie; the log says who actually wrote it");

    await publishSpecRatified(root, SCOPE, izzie, "sp_1", "2026-08-03T00:00:00.000Z", {}, ["op_1"]);
    assert.equal((await fold(root)).requirements.length, 0, "so it buys izzie nothing");
  } finally { discard(root); }
});

test("the fold refuses a sign-off of a spec that is no longer a draft", async () => {
  const root = await log("ratifiedsign");
  try {
    await ratifyWithReview(root, SCOPE, izzie, "sp_1", "2026-08-02T00:00:00.000Z", {}, ["op_1"]);
    assert.equal((await fold(root)).witnesses.length, 2, "the readings that permitted it are on the record");
    await publishSpecReviewed(root, SCOPE, mate, {
      id: "rw_late", specId: "sp_1", operationId: "op_1", reviewer: mate,
      at: "2026-08-03T00:00:00.000Z", content: operationContent(ADD),
    });
    assert.equal((await fold(root)).witnesses.length, 2,
      "a reading of something that can no longer change claims nothing, and would let a witness arrive after the adoption it is supposed to have preceded");
  } finally { discard(root); }
});

// --- the sanctioned alternative to partial ratification ----------------------

test("striking an operation and moving it to another proposal works end to end", async () => {
  const u = await universe();
  try {
    // Izzie's call: no partial ratification. The answer to "I want 1 of these 2" is to
    // strike what you do not want and re-propose it, which `remove_operation` makes
    // possible — so it has to actually work, start to finish, on one store.
    const { specId, a, b } = await drafted(u.root);
    const other = ok(await draftSpec(u.root, { title: "Rounding, on its own", ...AGENT }));

    // The removal reason NAMES the destination. Nothing enforces that and nothing should —
    // a `move_operation` verb would be a second authoring path, and the reason field is
    // already the author's account of why the proposal changed shape. What it buys is that
    // a ratifier reading the tombstone can find where the work went.
    ok(await removeOperation(u.root, { operationId: b, reason: `moved to ${other.id} — rounding is a settlement rule`, ...AGENT }));
    ok(await addOperation(u.root, {
      specId: other.id, kind: "add_requirement", rationale: "rounding was never written down",
      reversibility: "reversible", title: "Credit line rounding", section: "Settlement/Sweep",
      statement: "Credit lines round to the cent.", provenance: "treasury practice", ...AGENT,
    }));

    ok(await ratifyReviewed(u.root, specId));
    ok(await ratifyReviewed(u.root, other.id));
    assert.deepEqual((await listRequirements(u.root)).map((r) => r.title).sort(),
      ["Credit line currency", "Credit line rounding"]);

    // The struck operation is still readable on the spec it left, with the pointer to
    // where it went — which is what makes this a move rather than a loss.
    const served = ok(await getSpec(u.root, specId));
    assert.deepEqual(served.operations.map((o) => o.operation.id), [a]);
    assert.match(served.removed[0]!.removed!.reason, new RegExp(other.id));
  } finally { u.cleanup(); }
});

// --- the digest --------------------------------------------------------------

test("the content hash cannot be fooled by a field boundary", () => {
  // `{a: "x", b: "y"}` and `{a: "xb", b: "y"}` are different readings, and a naive join
  // makes them the same string. A silent collision here is a silent hole in the guard.
  // The naive form is `join(key + value)`, and these two are the collision it produces:
  // "a" + "1b2" is the same string as "a" + "1" then "b" + "2".
  assert.notEqual(witnessHash({ a: "1b2" }), witnessHash({ a: "1", b: "2" }));
  assert.notEqual(witnessHash({ a: "x" }), witnessHash({ b: "x" }));
  assert.equal(witnessHash({ a: "x", b: "y" }), witnessHash({ b: "y", a: "x" }), "key order is not content");
  assert.deepEqual(contentDiff({ a: "1", b: "2" }, { a: "1", b: "3", c: "4" }), [
    { field: "b", was: "2", now: "3" }, { field: "c", now: "4" },
  ]);
});
