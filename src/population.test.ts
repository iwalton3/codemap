/**
 * The population predicate: a hash-pinned lint, its delta, and the gating split.
 *
 * The claims here are almost all about REFUSALS, and a refusal test passes vacuously if
 * the positive case never worked. So each one lands the legitimate act first. The two that
 * are easiest to get vacuously right are flagged where they appear: the narrowing gate is
 * only meaningful if the same call SUCCEEDS for a principal and for a widening agent, and
 * the zero-member refusal is only meaningful if a one-member pin lands.
 *
 * Every guard below is mutation-checked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { indexBlob } from "./repo.js";
import { writeStore, readPopulations } from "./store.js";
import type { State, PopulationMember } from "./schema.js";
import { discard } from "./test-tmp.js";
import { draftSpec, addOperation, ratifySpec } from "./requirements.js";
import { ratifyReviewed } from "./test-approve.js";
import { acknowledgeGap, listAcknowledgements } from "./acknowledgements.js";
import {
  pinPopulation, declareNotExpressible, populationFor, brokenPins, populationDelta, counts,
} from "./population.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const RULE = "export function creditLine(cents) { return cents; }\n";
const LINT = "export function everyEndpointKeys() { return true; }\n";
const AGENT = { agent: true, model: "claude-opus-5" } as const;

const ok = <T>(r: T): Exclude<T, { error: string }> => {
  assert.ok(!(r && typeof r === "object" && "error" in (r as object)), `unexpected error: ${(r as any)?.error}`);
  return r as Exclude<T, { error: string }>;
};
const err = (r: unknown): string => {
  assert.ok(r && typeof r === "object" && "error" in (r as object), `expected a refusal, got ${JSON.stringify(r)}`);
  return (r as { error: string }).error;
};

async function universe() {
  const root = mkdtempSync(join(tmpdir(), "codemap-pop-"));
  for (const a of [["init", "-q", "-b", "main"], ["config", "user.email", "izzie@x.com"], ["config", "user.name", "izzie"]]) {
    spawnSync("git", a, { cwd: root });
  }
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, ".codemapignore"), "[tests]\ntests/\n", "utf8");
  writeFileSync(join(root, "src/credit.js"), RULE, "utf8");
  writeFileSync(join(root, "tests/endpoints.lint.js"), LINT, "utf8");
  const rule = await indexBlob(RULE, "src/credit.js");
  const lint = await indexBlob(LINT, "tests/endpoints.lint.js");
  await writeStore(root, [...rule, ...lint], state);
  // COMMITTED, and on the default branch. A pin is an observation of what is checked out,
  // so an uncommitted fixture makes every pin provisional and every gap-release test
  // vacuous — which is exactly how this fixture first behaved.
  spawnSync("git", ["add", "-A"], { cwd: root });
  spawnSync("git", ["commit", "-qm", "base"], { cwd: root });
  return { root, rule: rule.map((a) => a.id), lint: lint.map((a) => a.id) };
}

async function editLint(root: string, src: string) {
  writeFileSync(join(root, "tests/endpoints.lint.js"), src, "utf8");
  await writeStore(root, [
    ...await indexBlob(RULE, "src/credit.js"),
    ...await indexBlob(src, "tests/endpoints.lint.js"),
  ], state);
}

async function rule(root: string, opts: { gap?: boolean } = {}) {
  const sp = ok(await draftSpec(root, { title: "Endpoints" }));
  const add = ok(await addOperation(root, {
    specId: sp.id, kind: "add_requirement", rationale: "policy", reversibility: "reversible",
    title: "Every endpoint keys by tenant", section: "Access/Tenancy",
    statement: "Every endpoint keys its query by tenant.", provenance: "security policy",
  }));
  // A gap may only be minted while the spec is a DRAFT, against the operation.
  if (opts.gap) {
    ok(await acknowledgeGap(root, {
      operationId: add.id, rationale: "no endpoints exist yet", priority: "medium",
      revalidateBy: "2027-01-01", ...AGENT,
    }));
  }
  const rat = ok(await ratifyReviewed(root, sp.id));
  return rat.applied!.find((o) => o.kind === "add_requirement")!.requirementId!;
}

const M = (id: string, state: PopulationMember["state"]): PopulationMember => ({ id, state });

test("a pin enumerates members, and the counts are derived from them", async () => {
  const u = await universe();
  try {
    const rid = await rule(u.root);
    const pinned = ok(await pinPopulation(u.root, {
      requirementId: rid, lint: u.lint,
      members: [M("GET /orders", "conforms"), M("GET /invoices", "violates"), M("POST /webhook", "undecidable")],
    }));
    assert.deepEqual(pinned.population.counts, { members: 3, conforms: 1, violates: 1, undecidable: 1 });
    assert.equal(pinned.population.pinBroken, false);

    const p = ok(await populationFor(u.root, rid));
    assert.equal(p.state, "pinned");
    assert.equal(p.current!.counts.members, 3);
    // `undecidable` gets its OWN number. Folding it into conforms is `unknown` reading as
    // conformant one level down; folding it into violates is the false-positive shape.
    assert.equal(p.current!.counts.undecidable, 1);
  } finally { discard(u.root); }
});

test("a lint over zero members cannot be pinned — green reads as conformant", async () => {
  const u = await universe();
  try {
    const rid = await rule(u.root);
    assert.match(err(await pinPopulation(u.root, { requirementId: rid, lint: u.lint, members: [] })),
      /zero members/);
    // And the positive case works, so the refusal above is not the whole file passing
    // because nothing can ever be pinned.
    ok(await pinPopulation(u.root, { requirementId: rid, lint: u.lint, members: [M("GET /orders", "conforms")] }));
  } finally { discard(u.root); }
});

test("the pin hashes the LINT, so editing the detector breaks it", async () => {
  const u = await universe();
  try {
    const rid = await rule(u.root);
    ok(await pinPopulation(u.root, {
      requirementId: rid, lint: u.lint, members: [M("GET /orders", "conforms")],
    }));
    assert.equal(ok(await populationFor(u.root, rid)).current!.pinBroken, false);
    assert.deepEqual(await brokenPins(u.root), []);

    // *fired → was edited → now quiet*: the one pathology a scrub cannot reach, which is
    // the whole reason there is a hash here at all.
    await editLint(u.root, "export function everyEndpointKeys() { return false; }\n");
    assert.equal(ok(await populationFor(u.root, rid)).current!.pinBroken, true);
    assert.deepEqual((await brokenPins(u.root)).map((p) => p.requirementId), [rid]);

    // Retiring the rule empties the queue: a rule that does not bind makes an edit to the
    // lint that used to enumerate it nobody's work. Same call the two sibling queues make.
    const sp = ok(await draftSpec(u.root, { title: "retire it" }));
    ok(await addOperation(u.root, {
      specId: sp.id, kind: "retire_requirement", rationale: "superseded",
      reversibility: "reversible", requirementId: rid,
    }));
    ok(await ratifyReviewed(u.root, sp.id));
    assert.deepEqual(await brokenPins(u.root), []);
  } finally { discard(u.root); }
});

/**
 * The gating split, which is the whole defence against the third laundering door.
 *
 * Vacuous in three different ways if written carelessly, so all three arms are here: a
 * WIDENING re-pin by an agent must succeed, a NARROWING one by an agent must be refused,
 * and the same narrowing by a principal must succeed. Testing only the refusal would pass
 * against an implementation that refused every re-pin.
 */
test("widening is open, narrowing needs a principal, and the refusal reports the delta", async () => {
  const u = await universe();
  try {
    const rid = await rule(u.root);
    ok(await pinPopulation(u.root, {
      requirementId: rid, lint: u.lint,
      members: [M("GET /orders", "conforms"), M("GET /invoices", "violates"), M("GET /credits", "violates")],
      ...AGENT,
    }));

    // Widening: an agent may. Nothing is silenced by finding MORE that the rule covers.
    ok(await pinPopulation(u.root, {
      requirementId: rid, lint: u.lint,
      members: [M("GET /orders", "conforms"), M("GET /invoices", "violates"), M("GET /credits", "violates"), M("GET /refunds", "conforms")],
      ...AGENT,
    }));

    // Narrowing. It drops TWO members of which only ONE is violating, deliberately: a
    // delta that reported every drop as violating would be indistinguishable from this one
    // if both happened to be, and that is exactly how this assertion first passed while
    // asserting nothing. Dropping a conformer is ordinary refactoring; dropping the failing
    // one is the laundering move, and the number has to tell them apart.
    const narrower = [M("GET /orders", "conforms"), M("GET /credits", "violates")];
    const refused = err(await pinPopulation(u.root, { requirementId: rid, lint: u.lint, members: narrower, ...AGENT }));
    assert.match(refused, /NARROWS/);
    assert.match(refused, /drops 2 member\(s\), 1 of which/, "the delta is a NUMBER, not two diffed selectors");
    assert.match(refused, /GET \/invoices/, "and it names them, so the decision is reading rather than judgement");

    // The same call from a principal lands, and reports the delta rather than hiding it.
    const narrowed = ok(await pinPopulation(u.root, { requirementId: rid, lint: u.lint, members: narrower }));
    assert.equal(narrowed.delta!.dropped.length, 2);
    assert.equal(narrowed.delta!.droppedViolating, 1, "one violator and one conformer left the population");
    assert.equal(narrowed.population.counts.members, 2);

    // One active pin per rule, and the old ones kept — the chain a delta is read against.
    const all = await readPopulations(u.root, { requirementId: rid });
    assert.equal(all.filter((p) => p.state === "active").length, 1);
    assert.equal(all.length, 3);
    assert.equal(all.at(-1)!.supersedes, all.at(-2)!.id);
  } finally { discard(u.root); }
});

test("`not-expressible` is its own answer, and replacing a real population with it is narrowing", async () => {
  const u = await universe();
  try {
    const rid = await rule(u.root);
    assert.match(err(await declareNotExpressible(u.root, { requirementId: rid, reason: "  " })), /needs a reason/);

    ok(await declareNotExpressible(u.root, {
      requirementId: rid, reason: "the population spans Acme.API and Acme.React; two lints would drift", ...AGENT,
    }));
    const p = ok(await populationFor(u.root, rid));
    assert.equal(p.state, "not-expressible", "distinct from empty and from absent");
    assert.equal(p.current!.counts.members, 0);

    // Now pin a real one, then try to erase it by declaring inexpressibility.
    ok(await pinPopulation(u.root, { requirementId: rid, lint: u.lint, members: [M("GET /orders", "violates")], ...AGENT }));
    assert.match(err(await declareNotExpressible(u.root, { requirementId: rid, reason: "actually no", ...AGENT })),
      /narrowing at its limit/);
    ok(await declareNotExpressible(u.root, { requirementId: rid, reason: "principal says so" }));
  } finally { discard(u.root); }
});

test("absent is its own state and must not read as anything else", async () => {
  const u = await universe();
  try {
    const rid = await rule(u.root);
    const p = ok(await populationFor(u.root, rid));
    assert.equal(p.state, "absent");
    assert.equal(p.current, undefined, "no population, rather than an empty one");
    assert.deepEqual(p.history, []);
  } finally { discard(u.root); }
});

/**
 * A gap claims no code that should conform exists yet. A lint that just enumerated members
 * has found some, so the gap is falsified and has to go — releasing is the safe direction,
 * which is why it is automatic here exactly as it is after an audit.
 */
test("pinning a non-empty population releases a gap on that rule", async () => {
  const u = await universe();
  try {
    const rid = await rule(u.root, { gap: true });
    assert.equal((await listAcknowledgements(u.root, { requirementId: rid, state: "active" })).length, 1);

    const pinned = ok(await pinPopulation(u.root, {
      requirementId: rid, lint: u.lint, members: [M("GET /orders", "violates")],
    }));
    assert.equal(pinned.released.length, 1, "the gap said there was nothing; the lint found something");
    assert.deepEqual(await listAcknowledgements(u.root, { requirementId: rid, state: "active" }), []);
  } finally { discard(u.root); }
});

test("the delta separates dropping, adding and reclassifying", () => {
  const before = [M("a", "violates"), M("b", "conforms"), M("c", "undecidable")];
  const after = [M("b", "violates"), M("c", "undecidable"), M("d", "conforms")];
  const d = populationDelta(before, after);
  assert.deepEqual(d.dropped.map((m) => m.id), ["a"]);
  assert.deepEqual(d.added.map((m) => m.id), ["d"]);
  // A member that stays but flips verdict is the other way a lint gets narrowed, and it is
  // invisible in a count of members — so it is reported on its own axis.
  assert.deepEqual(d.reclassified, [{ id: "b", from: "conforms", to: "violates" }]);
  assert.equal(d.droppedViolating, 1);
  assert.equal(d.narrows, true);
  assert.equal(populationDelta(before, before).narrows, false);
  assert.deepEqual(counts(before), { members: 3, conforms: 1, violates: 1, undecidable: 1 });
});

test("a pin needs its lint, and the lint must be in the live index", async () => {
  const u = await universe();
  try {
    const rid = await rule(u.root);
    assert.match(err(await pinPopulation(u.root, { requirementId: rid, lint: [], members: [M("x", "conforms")] })),
      /needs the `lint` anchors/);
    assert.match(err(await pinPopulation(u.root, { requirementId: rid, lint: ["a_nope"], members: [M("x", "conforms")] })),
      /not in the live index/);
    assert.match(err(await pinPopulation(u.root, {
      requirementId: rid, lint: u.lint, members: [M("x", "conforms"), M("x", "violates")],
    })), /listed twice/);
    assert.match(err(await pinPopulation(u.root, {
      requirementId: rid, lint: u.lint, members: [{ id: "x", state: "maybe" } as never],
    })), /must be one of/);
    ok(await pinPopulation(u.root, { requirementId: rid, lint: u.lint, members: [M("x", "conforms")] }));
  } finally { discard(u.root); }
});

/**
 * A pin from a branch is that BRANCH's population, not the team's.
 *
 * A lint enumerates whatever is checked out, so the branch is not incidental to a member
 * list the way it is to a rule's text. Publishing one would release a gap on evidence that
 * may never merge — and a later honest pin from the default branch would then read as
 * NARROWING and need a principal to clear up after an abandoned branch.
 */
test("a pin taken off the default branch is provisional, and settles nothing", async () => {
  const u = await universe();
  try {
    const rid = await rule(u.root, { gap: true });
    spawnSync("git", ["checkout", "-qb", "feat"], { cwd: u.root });

    const pinned = ok(await pinPopulation(u.root, {
      requirementId: rid, lint: u.lint, members: [M("GET /orders", "violates")],
    }));
    assert.equal(pinned.population.provisional, true);
    assert.equal(pinned.population.branch, "feat");
    assert.deepEqual(pinned.released, [], "a gap is not released on evidence that may never merge");
    assert.equal((await listAcknowledgements(u.root, { requirementId: rid, state: "active" })).length, 1);

    // Back on the default branch the same pin is the codebase's, and it settles.
    spawnSync("git", ["checkout", "-q", "main"], { cwd: u.root });
    const real = ok(await pinPopulation(u.root, {
      requirementId: rid, lint: u.lint, members: [M("GET /orders", "violates")],
    }));
    assert.equal(real.population.provisional, undefined);
    assert.deepEqual(real.released.length, 1);
  } finally { discard(u.root); }
});

test("a dirty tree makes a pin provisional — its witnesses are of code in no commit", async () => {
  const u = await universe();
  try {
    const rid = await rule(u.root);
    // Clean: the ordinary case, and the control that stops the assertion below passing
    // against an implementation that calls everything provisional.
    assert.equal(ok(await pinPopulation(u.root, {
      requirementId: rid, lint: u.lint, members: [M("GET /orders", "conforms")],
    })).population.provisional, undefined);

    writeFileSync(join(u.root, "src/credit.js"), RULE + "// edited\n", "utf8");
    assert.equal(ok(await pinPopulation(u.root, {
      requirementId: rid, lint: u.lint, members: [M("GET /orders", "conforms"), M("GET /x", "conforms")],
    })).population.provisional, true, "witnessing from a dirty tree records a body that is in no commit");
  } finally { discard(u.root); }
});

test("a retired rule takes no population, by either basis", async () => {
  const u = await universe();
  try {
    const rid = await rule(u.root);
    const sp = ok(await draftSpec(u.root, { title: "retire" }));
    ok(await addOperation(u.root, {
      specId: sp.id, kind: "retire_requirement", rationale: "superseded",
      reversibility: "reversible", requirementId: rid,
    }));
    ok(await ratifyReviewed(u.root, sp.id));
    // Both doors, because the gates on this surface are deliberately symmetric and this
    // one was open on only one of them.
    assert.match(err(await pinPopulation(u.root, { requirementId: rid, lint: u.lint, members: [M("x", "conforms")] })), /retired/);
    assert.match(err(await declareNotExpressible(u.root, { requirementId: rid, reason: "spans repos" })), /retired/);
  } finally { discard(u.root); }
});
