/**
 * Audit pointers: a prior on where to look, never a verdict.
 *
 * The claims worth defending here are mostly NEGATIVE — a pointer never reaches
 * conformance, an unwatched rule never rises, a pointer at a dead address fires never —
 * and a negative is the shape that passes vacuously. So each test proves the positive case
 * first and the negative second, and every guard below is mutation-checked.
 *
 * The subtlest one is the ladder: `rank` is DERIVED from whether the anchor's file is in
 * the `[tests]` bin, so a fixture whose test file is not actually declared as one would
 * quietly make every pointer a `symbol` and the ladder assertion vacuous. The fixture
 * writes a real `.codemapignore` and the tests assert both rungs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { indexBlob } from "./repo.js";
import { writeStore, writeNode, readPointers } from "./store.js";
import type { LogicalNode, State } from "./schema.js";
import { discard } from "./test-tmp.js";
import { draftSpec, addOperation, ratifySpec, getSpec } from "./requirements.js";
import { declarePointer, restatePointer, retirePointer, pointersFor, auditQueue } from "./pointers.js";
import { universeKey } from "./sidecar-config.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const RULE = "export function creditLine(cents) { return cents; }\n";
const LINT = "export function assertCapped() { return true; }\n";

const ok = <T>(r: T): Exclude<T, { error: string }> => {
  assert.ok(!(r && typeof r === "object" && "error" in (r as object)), `unexpected error: ${(r as any)?.error}`);
  return r as Exclude<T, { error: string }>;
};
const err = (r: unknown): string => {
  assert.ok(r && typeof r === "object" && "error" in (r as object), `expected a refusal, got ${JSON.stringify(r)}`);
  return (r as { error: string }).error;
};

/**
 * A universe with the rule's code, a LINT in a declared `[tests]` path, and a doc.
 *
 * The `.codemapignore` `[tests]` header is what makes the `check` rung reachable at all —
 * that bin is the reason tests are indexed, and without it this fixture would prove only
 * that everything ranks `symbol`.
 */
async function universe() {
  const root = mkdtempSync(join(tmpdir(), "codemap-ptr-"));
  for (const a of [["init", "-q", "-b", "main"], ["config", "user.email", "izzie@x.com"], ["config", "user.name", "izzie"]]) {
    spawnSync("git", a, { cwd: root });
  }
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, ".codemapignore"), "[tests]\ntests/\n", "utf8");
  writeFileSync(join(root, "src/credit.js"), RULE, "utf8");
  writeFileSync(join(root, "tests/credit.lint.js"), LINT, "utf8");
  const rule = await indexBlob(RULE, "src/credit.js");
  const lint = await indexBlob(LINT, "tests/credit.lint.js");
  await writeStore(root, [...rule, ...lint], state);

  const doc: LogicalNode = {
    id: "n_credit", type: "concept", title: "How credit limits work",
    summary: "The pattern every limit check follows.", anchors: rule.map((a) => a.id), body: "",
  };
  await writeNode(root, doc);
  return { root, rule: rule.map((a) => a.id), lint: lint.map((a) => a.id), doc: doc.id };
}

async function editFile(root: string, rel: string, src: string, others: [string, string][]) {
  writeFileSync(join(root, rel), src, "utf8");
  const all = [];
  for (const [p, body] of [[rel, src] as [string, string], ...others]) all.push(...await indexBlob(body, p));
  await writeStore(root, all, state);
}

/** A ratified rule to hang pointers off. */
async function rule(root: string, cites: string[] = []) {
  const sp = ok(await draftSpec(root, { title: "Credit limits" }));
  ok(await addOperation(root, {
    specId: sp.id, kind: "add_requirement", rationale: "policy", reversibility: "reversible",
    title: "Credit line is capped", section: "Credit/Limits",
    statement: "A credit line never exceeds the approved limit.", provenance: "credit policy",
  }));
  const rat = ok(await ratifySpec(root, sp.id));
  return rat.applied!.find((o) => o.kind === "add_requirement")!.requirementId!;
}

test("the ladder is derived: a lint ranks above a doc, and an anchor is the last resort", async () => {
  const u = await universe();
  try {
    const rid = await rule(u.root);
    const check = ok(await declarePointer(u.root, {
      requirementId: rid, targetKind: "anchor", targetId: u.lint[0]!, rationale: "the lint enforcing the cap",
    }));
    const pattern = ok(await declarePointer(u.root, {
      requirementId: rid, targetKind: "node", targetId: u.doc, rationale: "the doc describing the pattern",
    }));
    const symbol = ok(await declarePointer(u.root, {
      requirementId: rid, targetKind: "anchor", targetId: u.rule[0]!, rationale: "the one function",
    }));

    // `check` is not a third target KIND — it is an anchor in a `[tests]` path, derived.
    assert.equal(check.pointer.rank, "check");
    assert.equal(pattern.pointer.rank, "pattern");
    assert.equal(symbol.pointer.rank, "symbol");
    assert.equal(symbol.pointer.lastResort, true);
    assert.equal(check.pointer.lastResort, false, "a lint is not the last resort, though it is an anchor too");

    // Accepted and FLAGGED, never refused — and the advice names the doc that already
    // covers it, because that is the better pointer and the caller is one call from it.
    assert.match(symbol.advice ?? "", /LAST RESORT/);
    assert.match(symbol.advice ?? "", /n_credit/);
    assert.equal(check.advice, undefined, "no lecture where the rung was already high");
  } finally { discard(u.root); }
});

test("a doc pointer fires when the code UNDER the doc moves — the free differential path", async () => {
  const u = await universe();
  try {
    const rid = await rule(u.root);
    ok(await declarePointer(u.root, {
      requirementId: rid, targetKind: "node", targetId: u.doc, rationale: "the doc describing the pattern",
    }));
    assert.equal((await pointersFor(u.root, rid))[0]!.moved, false, "quiet at the baseline");

    // Nothing touches the doc. The code it compresses changes, which is what makes a doc
    // stale — and that existing downstream detector is now an upstream trigger.
    await editFile(u.root, "src/credit.js", "export function creditLine(cents) { return cents * 2; }\n",
      [["tests/credit.lint.js", LINT]]);

    const fired = (await pointersFor(u.root, rid))[0]!;
    assert.equal(fired.moved, true, "the doc's cited code moved, so the rule is suspect");
    assert.deepEqual(fired.drifted, u.rule);
    assert.equal(fired.docStatus, "stale", "and the doc's own status is reported as context");
  } finally { discard(u.root); }
});

test("a fired pointer changes the QUEUE and never the conformance state", async () => {
  const u = await universe();
  try {
    const { conformance } = await import("./audits.js");
    const rid = await rule(u.root, u.rule);
    ok(await declarePointer(u.root, {
      requirementId: rid, targetKind: "node", targetId: u.doc, rationale: "the doc",
    }));
    await editFile(u.root, "src/credit.js", "export function creditLine(cents) { return cents * 2; }\n",
      [["tests/credit.lint.js", LINT]]);

    const q = await auditQueue(u.root);
    assert.deepEqual(q.firing.map((f) => f.requirementId), [rid], "it rose in the queue");

    // And the state is untouched. Letting a green — or a red — pointer speak for
    // conformance is the vacuity trap one level up: even a failing check proves the
    // INVARIANT broke, not that the RULE did.
    const rows = await conformance(u.root);
    assert.equal(rows.find((c) => c.requirement.id === rid)!.conformance, "unknown");
  } finally { discard(u.root); }
});

test("an unwatched rule is reported in its own right — silence must not read as calm", async () => {
  const u = await universe();
  try {
    const watched = await rule(u.root);
    ok(await declarePointer(u.root, {
      requirementId: watched, targetKind: "node", targetId: u.doc, rationale: "the doc",
    }));
    // A second rule, citing nothing and watched by nothing: the shape no set-op over
    // anchors can ever reach, which is why the absence is a reported bucket.
    const sp = ok(await draftSpec(u.root, { title: "Second" }));
    ok(await addOperation(u.root, {
      specId: sp.id, kind: "add_requirement", rationale: "r", reversibility: "reversible",
      title: "Float settles daily", section: "Settlement/Float",
      statement: "Float must be settled daily.", provenance: "treasury",
    }));
    const rat = ok(await ratifySpec(u.root, sp.id));
    const orphan = rat.applied!.find((o) => o.kind === "add_requirement")!.requirementId!;

    const q = await auditQueue(u.root);
    assert.deepEqual(q.unwatched.map((r) => r.requirementId), [orphan]);
    assert.ok(!q.unwatched.some((r) => r.requirementId === watched), "a watched rule is not in the silence bucket");
  } finally { discard(u.root); }
});

test("restating is the new quiet; retiring keeps the record", async () => {
  const u = await universe();
  try {
    const rid = await rule(u.root);
    const p = ok(await declarePointer(u.root, {
      requirementId: rid, targetKind: "node", targetId: u.doc, rationale: "the doc",
    }));
    await editFile(u.root, "src/credit.js", "export function creditLine(cents) { return cents * 2; }\n",
      [["tests/credit.lint.js", LINT]]);
    assert.equal((await pointersFor(u.root, rid))[0]!.moved, true);

    ok(await restatePointer(u.root, { id: p.id }));
    assert.equal((await pointersFor(u.root, rid))[0]!.moved, false, "somebody looked — this is the new baseline");

    assert.match(err(await retirePointer(u.root, { id: p.id, reason: "" })), /needs a reason/);
    ok(await retirePointer(u.root, { id: p.id, reason: "the doc was folded into another" }));

    // RETIRED, not deleted: the firing history is the evidence a scrub reads.
    const rows = await readPointers(u.root, { requirementId: rid });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.state, "retired");
    assert.equal(rows[0]!.retiredReason, "the doc was folded into another");
    assert.deepEqual((await auditQueue(u.root)).unwatched.map((r) => r.requirementId), [rid],
      "and the rule is unwatched again, which is the thing that must stay visible");
  } finally { discard(u.root); }
});

test("an address that does not resolve is refused — a pointer that fires never reads as coverage", async () => {
  const u = await universe();
  try {
    const rid = await rule(u.root);
    assert.match(err(await declarePointer(u.root, {
      requirementId: rid, targetKind: "anchor", targetId: "a_nope", rationale: "r",
    })), /not in the live index/);
    assert.match(err(await declarePointer(u.root, {
      requirementId: rid, targetKind: "node", targetId: "n_nope", rationale: "r",
    })), /no doc/);
    assert.match(err(await declarePointer(u.root, {
      requirementId: rid, targetKind: "node", targetId: u.doc, rationale: "  ",
    })), /rationale/);
    ok(await declarePointer(u.root, {
      requirementId: rid, targetKind: "node", targetId: u.doc, rationale: "the doc",
    }));
  } finally { discard(u.root); }
});

/**
 * The DOWNWARD half: a ratifier is the one person who cannot otherwise see how much is
 * pointed at the rule they are about to move.
 */
test("a spec shows what is watching the rule each operation changes", async () => {
  const u = await universe();
  try {
    const rid = await rule(u.root);
    const p = ok(await declarePointer(u.root, {
      requirementId: rid, targetKind: "node", targetId: u.doc, rationale: "the doc",
    }));
    const sp = ok(await draftSpec(u.root, { title: "Amend it" }));
    ok(await addOperation(u.root, {
      specId: sp.id, kind: "amend_statement", rationale: "policy moved", reversibility: "reversible",
      requirementId: rid, statement: "A credit line never exceeds the approved limit, ever.",
    }));
    const rendered = ok(await getSpec(u.root, sp.id));
    assert.deepEqual(rendered.operations[0]!.watchedBy.map((x) => x.id), [p.id]);
  } finally { discard(u.root); }
});

/**
 * The rollup closes the residue the other two signals cannot reach.
 *
 * A requirement that cites nothing and asserts nothing is a well-formed record — the rule
 * the code does not yet satisfy — and no set-op over anchors can find it, so the
 * highest-value record in the store was also the quietest. A pointer gives it something to
 * fire on, and the fixture is built that way deliberately: the rule below cites NOTHING.
 */
test("a diff raises a rule that cites nothing, through the doc watching it", async () => {
  const u = await universe();
  try {
    const rid = await rule(u.root, []);   // cites nothing, asserts nothing
    const p = ok(await declarePointer(u.root, {
      requirementId: rid, targetKind: "node", targetId: u.doc, rationale: "the doc describing the pattern",
    }));
    const { readAnchorStore, writeSnapshot } = await import("./store.js");
    const { computeDiff } = await import("./diff.js");

    await writeSnapshot(u.root, "base_sha", "main", (await readAnchorStore(u.root)).anchors, "2026-08-01T00:00:00Z");
    await editFile(u.root, "src/credit.js", "export function creditLine(cents) { return cents * 2; }\n",
      [["tests/credit.lint.js", LINT]]);
    await writeSnapshot(u.root, "head_sha", "feature", (await readAnchorStore(u.root)).anchors, "2026-08-01T01:00:00Z");

    const r = await computeDiff(u.root, "base_sha", "head_sha");
    assert.ok(!("error" in r), "expected a diff result");
    if ("error" in r) return;

    const row = r.impact.requirements.find((x) => x.id === rid);
    assert.ok(row, "a rule is reachable through what watches it — the only way, now that a rule cites nothing");
    assert.deepEqual(row.anchors, row.pointersFired.flatMap((f) => f.anchors),
      "and the anchors reported are the POINTER's, which is the record that knows which universe they are in");
    assert.deepEqual(row.assertionsMoved, []);
    assert.equal(row.pointersFired.length, 1);
    assert.equal(row.pointersFired[0]!.id, p.id);
    assert.equal(row.pointersFired[0]!.rank, "pattern");
    // The backtrace is the point: the auditor opens the DOC, not the symbol. Aiming high
    // is worth nothing if the reader is still handed the compression's contents.
    assert.equal(row.pointersFired[0]!.via, "How credit limits work");
    assert.deepEqual(row.pointersFired[0]!.anchors, u.rule);
  } finally { discard(u.root); }
});

test("a retired pointer does not fire a diff", async () => {
  const u = await universe();
  try {
    const rid = await rule(u.root, []);
    const p = ok(await declarePointer(u.root, {
      requirementId: rid, targetKind: "node", targetId: u.doc, rationale: "the doc",
    }));
    ok(await retirePointer(u.root, { id: p.id, reason: "superseded" }));

    const { readAnchorStore, writeSnapshot } = await import("./store.js");
    const { computeDiff } = await import("./diff.js");
    await writeSnapshot(u.root, "base_sha", "main", (await readAnchorStore(u.root)).anchors, "2026-08-01T00:00:00Z");
    await editFile(u.root, "src/credit.js", "export function creditLine(cents) { return cents * 2; }\n",
      [["tests/credit.lint.js", LINT]]);
    await writeSnapshot(u.root, "head_sha", "feature", (await readAnchorStore(u.root)).anchors, "2026-08-01T01:00:00Z");

    const r = await computeDiff(u.root, "base_sha", "head_sha");
    assert.ok(!("error" in r), "expected a diff result");
    if ("error" in r) return;
    assert.equal(r.impact.requirements.find((x) => x.id === rid), undefined,
      "retired means stopped watching, not kept for the record and still firing");
  } finally { discard(u.root); }
});

test("a pointer records which universe's code it watches", async () => {
  // The reason the standard can be workspace-scoped at all: ONE rule points into
  // several universes, and neither pointer is the other's duplicate. Without the key a
  // rule's watchers collapse into one undifferentiated list, and nothing downstream can
  // say which repo was actually looked at.
  const u = await universe();
  try {
    const rid = await rule(u.root);
    const p = ok(await declarePointer(u.root, {
      requirementId: rid, targetKind: "anchor", targetId: u.rule[0]!,
      rationale: "the one function that applies the cap",
    }));
    assert.equal(p.pointer.universe, universeKey(u.root));
    assert.ok(p.pointer.universe, "a real key, not an empty string");
    // And it survives the round trip, which is what a reader actually sees.
    assert.equal((await readPointers(u.root, { requirementId: rid }))[0]!.universe, universeKey(u.root));
  } finally { discard(u.root); }
});
