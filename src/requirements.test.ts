/**
 * The standard, and the things it exists to make impossible.
 *
 * Nearly every assertion here is about a NEGATIVE — no edit path, no agent adoption, no
 * stale state, no leak into the node surface, no operation applied to a base its author
 * never saw — and a negative is exactly the shape that passes vacuously. So each test
 * proves the positive case works first, then proves the negative one is refused: if the
 * refusal were removed, the second half fails rather than the file silently asserting
 * nothing. Every guard below is mutation-checked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { indexBlob } from "./repo.js";
import { writeStore, loadNodes, readRequirement, readSpec, writeLocalOperation } from "./store.js";
import type { State } from "./schema.js";
import { discard } from "./test-tmp.js";
import {
  draftSpec, addOperation, ratifySpec, getSpec, pendingSpecs, withdrawSpec, relianceOn,
  listRequirements, getRequirement, requirementSections, reorganizeRequirement,
} from "./requirements.js";
import { ratifyReviewed, signOffEverything } from "./test-approve.js";
import { acknowledgeGap, listAcknowledgements } from "./acknowledgements.js";
import { declarePointer } from "./pointers.js";
import { recordAudit } from "./audits.js";
import { readOperations } from "./store.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const SRC = "export function creditLine(cents) { return cents; }\n";
const AGENT = { agent: true, model: "claude-opus-5" } as const;

async function universe() {
  const root = mkdtempSync(join(tmpdir(), "codemap-req-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "izzie@x.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "izzie"], { cwd: root });
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/credit.js"), SRC, "utf8");
  // COMMITTED, and that is load-bearing rather than tidy. An uncommitted fixture makes
  // every act `provisional`, and this file's reliance test was passing on exactly that:
  // `relianceOn` counted a provisional audit the FOLD can never see, so the assertion that
  // an audit blocks a withdrawal was really asserting a divergence between the two ends.
  // The same shape has now bitten this subsystem three times.
  spawnSync("git", ["add", "-A"], { cwd: root });
  spawnSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  const indexed = await indexBlob(SRC, "src/credit.js");
  await writeStore(root, indexed, state);
  return { root, anchors: indexed.map((a) => a.id) };
}

/** Re-index the same file with a CHANGED body, the way a real edit would. */
async function editCode(root: string, src: string) {
  writeFileSync(join(root, "src/credit.js"), src, "utf8");
  await writeStore(root, await indexBlob(src, "src/credit.js"), state);
}

/**
 * Assert success and narrow to the ok arm.
 *
 * `Exclude` rather than `T | {error}`: `ratifySpec`'s failure arm carries `checks` as well
 * as `error`, so the simpler signature left T inferred as the whole union and every field
 * access failed to compile — while the tests still PASSED, which is the shape worth not
 * repeating.
 */
const ok = <T>(r: T): Exclude<T, { error: string }> => {
  assert.ok(!(r && typeof r === "object" && "error" in (r as object)), `unexpected error: ${(r as any)?.error}`);
  return r as Exclude<T, { error: string }>;
};

/** The common case: one spec, one `add_requirement`, ratified. Returns the rule's id. */
async function adoptRule(root: string, over: Record<string, unknown> = {}, actor: object = {}) {
  const sp = ok(await draftSpec(root, { title: "Credit currency policy", ...actor } as any));
  ok(await addOperation(root, {
    specId: sp.id, kind: "add_requirement", rationale: "policy §4 was never written down",
    reversibility: "reversible", title: "Credit line currency", section: "Credit/Limits",
    statement: "All credit lines are in USD.", provenance: "credit policy §4",
    ...over, ...actor,
  } as any));
  ok(await ratifyReviewed(root, sp.id));
  const rules = await listRequirements(root);
  return { specId: sp.id, rule: rules[rules.length - 1]! };
}

test("an agent may draft and propose; only a principal adopts", async () => {
  const { root } = await universe();
  try {
    // The agent half must pass, or the refusal below proves nothing — a module that
    // rejected every write would also "refuse the agent".
    const sp = ok(await draftSpec(root, { title: "Credit currency policy", ...AGENT }));
    assert.ok(sp.spec.author.via, "an agent's authorship records the agent");
    ok(await addOperation(root, {
      specId: sp.id, kind: "add_requirement", rationale: "policy §4", reversibility: "reversible",
      title: "Credit line currency", section: "Credit/Limits",
      statement: "All credit lines are in USD.", provenance: "credit policy §4", ...AGENT,
    }));

    const denied = await ratifySpec(root, sp.id, AGENT);
    assert.ok("error" in denied, "an agent must not be able to ratify");
    assert.match((denied as any).error, /principal's act/);
    assert.equal((await readSpec(root, sp.id))!.status, "draft", "a refused ratify changes nothing");
    assert.equal((await listRequirements(root)).length, 0, "and writes no requirement");

    const done = ok(await ratifyReviewed(root, sp.id));
    assert.equal(done.spec.status, "ratified");
    assert.ok(done.spec.ratifiedBy && !done.spec.ratifiedBy.via, "ratification names a person, not an agent");
    assert.equal((await listRequirements(root)).length, 1, "the standard is the projection of the ratified spec");
  } finally { discard(root); }
});

test("a requirement enters the standard only through a ratified spec", async () => {
  const { root } = await universe();
  try {
    const sp = ok(await draftSpec(root, { title: "Credit currency policy" }));
    ok(await addOperation(root, {
      specId: sp.id, kind: "add_requirement", rationale: "policy §4", reversibility: "reversible",
      title: "Credit line currency", section: "Credit/Limits",
      statement: "All credit lines are in USD.", provenance: "credit policy §4",
    }));
    assert.equal((await listRequirements(root)).length, 0, "a draft spec writes nothing to the standard");

    ok(await ratifyReviewed(root, sp.id));
    const rules = await listRequirements(root);
    assert.equal(rules.length, 1);
    assert.equal(rules[0]!.introducedBy, sp.id, "the rule records the spec that introduced it");

    // Adding to a spec that has landed is refused: it would change a ratified argument.
    const late = await addOperation(root, {
      specId: sp.id, kind: "add_requirement", rationale: "one more", reversibility: "reversible",
      title: "Late rule", section: "Credit/Limits", statement: "Something else.", provenance: "policy",
    });
    assert.ok("error" in late);
  } finally { discard(root); }
});

test("an operation written against a moved base is refused, not applied", async () => {
  const { root } = await universe();
  try {
    const { rule } = await adoptRule(root);

    // Two specs drafted against the same text. This is the concurrency case: B is written
    // before A lands, and folding B afterwards would apply it to a base B never saw.
    const a = ok(await draftSpec(root, { title: "Spec A" }));
    ok(await addOperation(root, {
      specId: a.id, kind: "amend_statement", requirementId: rule.id, reversibility: "reversible",
      statement: "All credit lines are in USD, except settlement float.", rationale: "float exception",
    }));
    const b = ok(await draftSpec(root, { title: "Spec B" }));
    ok(await addOperation(root, {
      specId: b.id, kind: "amend_statement", requirementId: rule.id, reversibility: "reversible",
      statement: "All credit lines are in USD and EUR.", rationale: "new market",
    }));

    ok(await ratifyReviewed(root, a.id));
    assert.match((await readRequirement(root, rule.id))!.statement, /settlement float/);

    const stale = await ratifySpec(root, b.id);
    assert.ok("error" in stale, "B was drafted against text A has since replaced");
    assert.match((stale as any).error, /since moved|has changed/);
    assert.match((await readRequirement(root, rule.id))!.statement, /settlement float/, "the refused fold changed nothing");
    assert.equal((await readSpec(root, b.id))!.status, "draft");

    // And the review surface says so before anyone tries.
    const rendered = ok(await getSpec(root, b.id));
    assert.equal(rendered.adoptable, false);
    assert.equal(rendered.operations[0]!.contextMoved, true);
  } finally { discard(root); }
});

test("adoption is all or nothing", async () => {
  const { root } = await universe();
  try {
    const { rule } = await adoptRule(root);
    const sp = ok(await draftSpec(root, { title: "Mixed spec" }));
    // One operation that will still be valid...
    ok(await addOperation(root, {
      specId: sp.id, kind: "add_requirement", rationale: "new rule", reversibility: "reversible",
      title: "Float currency", section: "Settlement/Float",
      statement: "Settlement float is held in the tender currency.", provenance: "credit policy §9",
    }));
    // ...and one that will not.
    ok(await addOperation(root, {
      specId: sp.id, kind: "amend_statement", requirementId: rule.id, reversibility: "reversible",
      statement: "All credit lines are in USD and EUR.", rationale: "new market",
    }));

    const other = ok(await draftSpec(root, { title: "Lands first" }));
    ok(await addOperation(root, {
      specId: other.id, kind: "amend_statement", requirementId: rule.id, reversibility: "reversible",
      statement: "All credit lines are in USD, except settlement float.", rationale: "float exception",
    }));
    ok(await ratifyReviewed(root, other.id));

    const refused = await ratifySpec(root, sp.id);
    assert.ok("error" in refused);
    assert.equal(
      (await listRequirements(root)).length, 1,
      "the still-valid operation must NOT have landed — a half-applied spec is a standard nobody approved",
    );
  } finally { discard(root); }
});

test("drifted code makes a requirement recheck-due — never stale, and never untrusted", async () => {
  const { root, anchors } = await universe();
  try {
    // Staleness comes from a POINTER now: a requirement cites nothing, so the thing that
    // knows where the code is — and which universe it is in — is what carries the baseline.
    const { rule } = await adoptRule(root);
    ok(await declarePointer(root, {
      requirementId: rule.id, targetKind: "anchor", targetId: anchors[0]!,
      rationale: "the function that applies the rule",
    } as any));

    // Before the edit: settled. Asserting this is what makes the flip below evidence.
    assert.equal(ok(await getRequirement(root, rule.id)).requirement.recheckDue, false);

    await editCode(root, "export function creditLine(cents) { return cents * 2; }\n");

    const after = ok(await getRequirement(root, rule.id));
    assert.equal(after.requirement.recheckDue, true, "watched code moved");
    assert.equal(after.requirement.status, "ratified", "drift is evidence about the CODE, not a downgrade of the rule");
    assert.deepEqual(after.requirement.drifted, [anchors[0]!]);
    // The served shape must carry nothing a doc carries: acquiring one of these is how
    // "update it to match the code" becomes the obvious next move.
    for (const forbidden of ["trust", "state", "stale", "vouch"]) {
      assert.ok(!(forbidden in after.requirement), `a requirement must never be served with \`${forbidden}\``);
    }
  } finally { discard(root); }
});

test("a requirement cites nothing, and saying otherwise is refused rather than dropped", async () => {
  const { root, anchors } = await universe();
  try {
    // A requirement cites nothing, and passing citations is REFUSED rather than dropped:
    // an author who supplies them has a model of what a rule is, and silently ignoring
    // them would leave that model intact and the rule looking connected to code it is not.
    const { rule } = await adoptRule(root);
    assert.ok(!("cites" in rule), "a rule has no citation field at all");
    const cited = ok(await draftSpec(root, { title: "cites code" } as any));
    const refused = await addOperation(root, {
      specId: cited.id, kind: "add_requirement", rationale: "r", reversibility: "reversible",
      title: "T", section: "Credit/Cited", statement: "S.", provenance: "p", cites: [anchors[0]!],
    } as any);
    assert.match((refused as { error: string }).error, /a requirement cites nothing/);

    // The control: without the citations it is an ordinary, adoptable operation. Otherwise
    // the refusal above would pass against a branch that rejected everything.
    const sp = ok(await draftSpec(root, { title: "Real" }));
    ok(await addOperation(root, {
      specId: sp.id, kind: "add_requirement", rationale: "x", reversibility: "reversible",
      title: "Real", section: "Credit/Limits", statement: "Real rule.", provenance: "policy",
    }));
  } finally { discard(root); }
});

test("title, section, provenance, rationale and reversibility are all required", async () => {
  const { root } = await universe();
  try {
    const sp = ok(await draftSpec(root, { title: "Spec" }));
    const base = {
      specId: sp.id, kind: "add_requirement" as const, rationale: "because", reversibility: "reversible" as const,
      title: "Credit line currency", section: "Credit/Limits",
      statement: "All credit lines are in USD.", provenance: "credit policy §4",
    };
    for (const [field, over] of [
      ["title", { title: "  " }],
      ["section", { section: " / " }],
      ["provenance", { provenance: "  " }],
      ["rationale", { rationale: " " }],
      ["reversibility", { reversibility: "maybe" }],
    ] as const) {
      const bad = await addOperation(root, { ...base, ...over } as any);
      assert.ok("error" in bad, `${field} must be required`);
      assert.match((bad as any).error, new RegExp(field));
    }
    // The same call with all of them succeeds, so each refusal is about its field.
    ok(await addOperation(root, base));
  } finally { discard(root); }
});

test("sections normalize, and a case-variant of an existing one is refused", async () => {
  const { root } = await universe();
  try {
    const { rule } = await adoptRule(root, { section: "  Credit / Limits  " });
    assert.equal(rule.section, "Credit/Limits", "ragged input files under the normalized path");

    const sp = ok(await draftSpec(root, { title: "Clash" }));
    const clash = await addOperation(root, {
      specId: sp.id, kind: "add_requirement", rationale: "x", reversibility: "reversible",
      title: "Credit line ceiling", section: "credit/limits",
      statement: "No credit line exceeds 500k.", provenance: "credit policy §7",
    });
    assert.ok("error" in clash, "a case-variant of an existing section must be refused");
    assert.match((clash as any).error, /only by case/);

    // A genuinely different section is NOT refused — the guard must not be so eager that
    // it stops anyone opening a new one.
    ok(await addOperation(root, {
      specId: sp.id, kind: "add_requirement", rationale: "x", reversibility: "reversible",
      title: "Float currency", section: "Settlement/Float",
      statement: "Settlement float is held in the tender currency.", provenance: "credit policy §9",
    }));
    ok(await ratifyReviewed(root, sp.id));
    assert.deepEqual(
      (await requirementSections(root)).map((x) => x.section),
      ["Credit/Limits", "Settlement/Float"],
    );
  } finally { discard(root); }
});

test("retirement goes through a spec too, so retire-and-recreate is not a way around the gate", async () => {
  const { root } = await universe();
  try {
    const { rule } = await adoptRule(root);
    const sp = ok(await draftSpec(root, { title: "Retire it", ...AGENT }));
    ok(await addOperation(root, {
      specId: sp.id, kind: "retire_requirement", requirementId: rule.id,
      reversibility: "reversible", rationale: "superseded by the new credit model", ...AGENT,
    }));

    const denied = await ratifySpec(root, sp.id, AGENT);
    assert.ok("error" in denied);
    assert.equal((await readRequirement(root, rule.id))!.status, "ratified");

    ok(await ratifyReviewed(root, sp.id));
    assert.equal((await readRequirement(root, rule.id))!.status, "retired");

    // A retired rule is not an amendment target — otherwise "retire, then amend the
    // corpse" is the edit path by another name.
    const sp2 = ok(await draftSpec(root, { title: "Amend the corpse" }));
    const after = await addOperation(root, {
      specId: sp2.id, kind: "amend_statement", requirementId: rule.id,
      reversibility: "reversible", statement: "Anything goes.", rationale: "no",
    });
    assert.ok("error" in after);
  } finally { discard(root); }
});

test("re-filing is a principal's act and never touches the statement", async () => {
  const { root } = await universe();
  try {
    const { rule } = await adoptRule(root);

    // Retitling is how you make a rule READ differently without touching its statement,
    // so it is gated where the operation path is gated.
    const denied = await reorganizeRequirement(root, rule.id, { title: "Credit lines may be any currency" }, AGENT);
    assert.ok("error" in denied);
    assert.equal((await readRequirement(root, rule.id))!.title, "Credit line currency");

    ok(await reorganizeRequirement(root, rule.id, { title: "Credit line currency (USD)" }));
    const after = (await readRequirement(root, rule.id))!;
    assert.equal(after.title, "Credit line currency (USD)");
    assert.equal(after.statement, "All credit lines are in USD.", "re-filing never touches the rule");
  } finally { discard(root); }
});

test("irreversibility is declared before adoption and surfaces on the rule afterwards", async () => {
  const { root } = await universe();
  try {
    const { rule } = await adoptRule(root, { reversibility: "irreversible" });
    // It constrains the FUTURE, so it has to be visible on the requirement itself and not
    // only on the spec that introduced it — whoever opens the next amendment needs it.
    assert.equal(ok(await getRequirement(root, rule.id)).requirement.irreversible, true);

    const reversible = await adoptRule(root, {
      title: "Float currency", section: "Settlement/Float",
      statement: "Settlement float is held in the tender currency.", provenance: "credit policy §9",
    });
    assert.equal(ok(await getRequirement(root, reversible.rule.id)).requirement.irreversible, false);
  } finally { discard(root); }
});

test("requirements do not appear on the node surface", async () => {
  const { root, anchors } = await universe();
  try {
    await adoptRule(root);
    // The structural half of "a requirement has no stale state": it cannot acquire one,
    // because the code that computes one is never handed a requirement.
    const nodes = await loadNodes(root);
    assert.equal(nodes.length, 0, "a requirement is not a node");
    // And it IS readable through its own surface, so the emptiness above is separation
    // rather than the requirement having failed to store at all.
    assert.equal((await listRequirements(root)).length, 1);
  } finally { discard(root); }
});

test("the review surface carries what a principal needs to dispose of a spec", async () => {
  const { root } = await universe();
  try {
    const { rule } = await adoptRule(root);
    const sp = ok(await draftSpec(root, {
      title: "Float exception",
      narrative: "Background only. Non-operative — the operations below are what land.",
    }));
    ok(await addOperation(root, {
      specId: sp.id, kind: "amend_statement", requirementId: rule.id, reversibility: "irreversible",
      statement: "All credit lines are in USD, except settlement float.",
      rationale: "The exception surfaced during a conformance check.", evidence: "COD-29",
    }));

    const rendered = ok(await getSpec(root, sp.id));
    assert.equal(rendered.adoptable, true);
    const row = rendered.operations[0]!;
    assert.equal(row.before!.statement, "All credit lines are in USD.", "current text, for the diff");
    assert.equal(row.after, "All credit lines are in USD, except settlement float.", "proposed text, for the diff");
    assert.equal(row.operation.rationale, "The exception surfaced during a conformance check.", "rationale rides on the OPERATION");
    assert.equal(row.operation.evidence, "COD-29");

    const queue = await pendingSpecs(root);
    assert.equal(queue.length, 1);
    assert.equal(queue[0]!.operations, 1);
    assert.equal(queue[0]!.irreversible, true, "the queue shows irreversibility before it is adopted");

    ok(await ratifyReviewed(root, sp.id));
    assert.equal((await pendingSpecs(root)).length, 0, "an adopted spec leaves the queue");
  } finally { discard(root); }
});

test("an empty spec cannot be adopted", async () => {
  const { root } = await universe();
  try {
    const sp = ok(await draftSpec(root, { title: "Nothing here" }));
    const refused = await ratifySpec(root, sp.id);
    assert.ok("error" in refused);
    assert.match((refused as any).error, /no operations/);
  } finally { discard(root); }
});

test("a requirement's id is derived from its operation, so every clone agrees", async () => {
  const { root } = await universe();
  try {
    const sp = ok(await draftSpec(root, { title: "Credit currency policy" }));
    const op = ok(await addOperation(root, {
      specId: sp.id, kind: "add_requirement", rationale: "policy §4", reversibility: "reversible",
      title: "Credit line currency", section: "Credit/Limits",
      statement: "All credit lines are in USD.", provenance: "credit policy §4",
    }));
    ok(await ratifyReviewed(root, sp.id));
    const rule = (await listRequirements(root))[0]!;

    // The standard is a projection of the ratified specs, so replaying the same operation
    // on another machine has to produce the same name for the same rule. A random id
    // would never fail locally, where there is only ever one clone.
    const { createHash } = await import("node:crypto");
    assert.equal(rule.id, "r_" + createHash("sha256").update(op.id).digest("hex").slice(0, 12));
    assert.equal(rule.introducedBy, sp.id);
  } finally { discard(root); }
});

test("one spec cannot open two sections that differ only by case", async () => {
  const { root } = await universe();
  try {
    const sp = ok(await draftSpec(root, { title: "Two sections at once" }));
    const base = {
      specId: sp.id, kind: "add_requirement" as const, rationale: "x",
      reversibility: "reversible" as const, provenance: "policy",
    };
    ok(await addOperation(root, { ...base, title: "One", section: "Credit/Limits", statement: "A." }));

    // Comparing only against EXISTING rows let a spec introduce "Credit/Limits" and
    // "credit/limits" in one breath: neither had rows yet, so neither could see the
    // other, and both landed as complete-looking sections. Found by probing, not by a
    // review.
    const clash = await addOperation(root, { ...base, title: "Two", section: "credit/limits", statement: "B." });
    assert.ok("error" in clash);
    assert.match((clash as any).error, /this same spec already introduces/);

    // A genuinely different section in the same spec is still fine.
    ok(await addOperation(root, { ...base, title: "Three", section: "Settlement/Float", statement: "C." }));
    ok(await ratifyReviewed(root, sp.id));
    assert.deepEqual(
      (await requirementSections(root)).map((x) => x.section),
      ["Credit/Limits", "Settlement/Float"],
    );
  } finally { discard(root); }
});

test("a spec may not carry two operations against the same rule", async () => {
  // Both capture `context` from the stored row, so both hold the SAME pre-spec text: both
  // pass ratification's context check, both render with an identical `before` and
  // `adoptable: true`, and then they apply in `ord` order and the later one silently wins.
  // The principal is shown two contradictory rewrites, each claiming to apply to the
  // current statement, and approves an outcome the rendering never displayed.
  const { root } = await universe();
  try {
    const { rule } = await adoptRule(root);
    const sp = ok(await draftSpec(root, { title: "Currency amendment" }));
    const first = ok(await addOperation(root, {
      specId: sp.id, kind: "amend_statement", requirementId: rule.id,
      statement: "All credit lines are in USD or EUR.", rationale: "the business moved",
      reversibility: "reversible",
    }));
    const second = await addOperation(root, {
      specId: sp.id, kind: "amend_statement", requirementId: rule.id,
      statement: "All credit lines are in GBP.", rationale: "no, this",
      reversibility: "reversible",
    });
    assert.match((second as { error: string }).error ?? "", /already has an operation against/,
      "the second operation is written against a base the first one has already moved");

    // The refusal must be about the DUPLICATE and not about amendments in general: one
    // operation against the rule still ratifies, or this passes by forbidding the feature.
    const adopted = ok(await ratifyReviewed(root, sp.id));
    assert.ok(adopted.applied, "no sidecar, so this machine applied them and knows which");
    assert.equal(adopted.applied.length, 1);
    assert.equal(adopted.applied[0]!.id, first.id);
    const after = await getRequirement(root, rule.id);
    assert.equal(ok(after).requirement.statement, "All credit lines are in USD or EUR.");
  } finally { discard(root); }
});

test("and ratification refuses one even when authoring did not", async () => {
  // The guard above cannot be the only one: a spec assembled by an OLDER BUILD arrives
  // through the log already carrying both operations, and adoption is where it is caught.
  // Written straight to the store on purpose — going through `addOperation` cannot produce
  // this state any more, which is exactly why the second guard has to exist and why a test
  // that drove the ops would have pinned nothing.
  const { root } = await universe();
  try {
    const { rule } = await adoptRule(root);
    const sp = ok(await draftSpec(root, { title: "Two amendments" }));
    const base = {
      specId: sp.id, kind: "amend_statement" as const, requirementId: rule.id,
      rationale: "r", reversibility: "reversible" as const,
      context: { requirementId: rule.id, statement: rule.statement },
    };
    await writeLocalOperation(root, { ...base, id: "op_dup_a", ord: 0, statement: "USD or EUR." });
    await writeLocalOperation(root, { ...base, id: "op_dup_b", ord: 1, statement: "GBP." });

    const res = await ratifySpec(root, sp.id);
    assert.match((res as { error: string }).error ?? "", /carries two operations against/,
      "both hold the same base, so the per-operation context check passes them both");

    // All-or-nothing: the rule is untouched, not half-amended.
    assert.equal(ok(await getRequirement(root, rule.id)).requirement.statement,
      "All credit lines are in USD.");
  } finally { discard(root); }
});

/**
 * Section move / rename.
 *
 * A move is the one operation whose subject is a PATH rather than a rule, so it carries no
 * `context` and every check that keys on one skips it. Each test below proves the move
 * lands first, then proves the refusal — a suite that only asserted refusals would pass
 * with the whole operation kind deleted.
 */
test("a section move re-files the whole subtree, and nothing outside it", async () => {
  const { root } = await universe();
  try {
    await adoptRule(root, { title: "Daily cap", section: "Credit/Limits/Daily", statement: "Daily draw is capped." });
    await adoptRule(root, { title: "Currency", section: "Credit/Limits", statement: "All credit lines are in USD." });
    await adoptRule(root, { title: "Float", section: "Settlement/Float", statement: "Float settles T+1." });

    const sp = ok(await draftSpec(root, { title: "Credit policy is risk policy" } as any));
    ok(await addOperation(root, {
      specId: sp.id, kind: "move_section", rationale: "the standard files it under the wrong owner",
      reversibility: "reversible", fromSection: "Credit", toSection: "Risk",
    } as any));
    ok(await ratifyReviewed(root, sp.id));

    assert.deepEqual(
      (await requirementSections(root)).map((s) => s.section).sort(),
      ["Risk/Limits", "Risk/Limits/Daily", "Settlement/Float"],
      "descendants follow the subtree; a sibling section is untouched",
    );
  } finally { discard(root); }
});

test("a move onto a heading other rules occupy is refused; the same move to a free path is not", async () => {
  const { root } = await universe();
  try {
    await adoptRule(root, { title: "Currency", section: "Credit/Limits", statement: "All credit lines are in USD." });
    await adoptRule(root, { title: "Float", section: "Risk/Limits", statement: "Float settles T+1." });

    const sp = ok(await draftSpec(root, { title: "re-file credit" } as any));
    const merge = await addOperation(root, {
      specId: sp.id, kind: "move_section", rationale: "tidy", reversibility: "reversible",
      fromSection: "Credit", toSection: "Risk",
    } as any);
    assert.match((merge as { error: string }).error, /MERGES two sections/);

    // The positive half: the refusal is about the COLLISION, not about moves in general.
    ok(await addOperation(root, {
      specId: sp.id, kind: "move_section", rationale: "tidy", reversibility: "reversible",
      fromSection: "Credit", toSection: "Exposure",
    } as any));
  } finally { discard(root); }
});

test("repairing a case split is a legal move, though a plain section guard would refuse it", async () => {
  const { root } = await universe();
  try {
    await adoptRule(root, { title: "Currency", section: "credit", statement: "All credit lines are in USD." });
    await adoptRule(root, { title: "Float", section: "Risk", statement: "Float settles T+1." });

    // `checkSection` refuses a destination that case-matches an existing heading, and the
    // heading being moved is one of those. Excluding the moving subtree is what makes the
    // documented repair for a case split possible at all.
    const sp = ok(await draftSpec(root, { title: "fix the case split" } as any));
    ok(await addOperation(root, {
      specId: sp.id, kind: "move_section", rationale: "two spellings of one place",
      reversibility: "reversible", fromSection: "credit", toSection: "Credit",
    } as any));
    ok(await ratifyReviewed(root, sp.id));
    assert.ok((await requirementSections(root)).some((s) => s.section === "Credit"));

    // …and the guard still bites on a heading that STAYS put.
    const sp2 = ok(await draftSpec(root, { title: "collide with Risk" } as any));
    const clash = await addOperation(root, {
      specId: sp2.id, kind: "move_section", rationale: "tidy", reversibility: "reversible",
      fromSection: "Credit", toSection: "risk",
    } as any);
    assert.match((clash as { error: string }).error, /only by case/);
  } finally { discard(root); }
});

test("a move drafted against a section another spec has since emptied is refused at ratification", async () => {
  const { root } = await universe();
  try {
    await adoptRule(root, { title: "Currency", section: "Credit/Limits", statement: "All credit lines are in USD." });

    const mine = ok(await draftSpec(root, { title: "credit becomes risk" } as any));
    ok(await addOperation(root, {
      specId: mine.id, kind: "move_section", rationale: "ownership", reversibility: "reversible",
      fromSection: "Credit", toSection: "Risk",
    } as any));

    // Somebody else re-files it first. The draft above still validates against a section
    // that no longer exists, and a move with nothing to move applies cleanly and does
    // NOTHING — so without the ratification-time re-check the principal is told a
    // re-organization landed that never happened.
    const theirs = ok(await draftSpec(root, { title: "credit becomes exposure" } as any));
    ok(await addOperation(root, {
      specId: theirs.id, kind: "move_section", rationale: "ownership", reversibility: "reversible",
      fromSection: "Credit", toSection: "Exposure",
    } as any));
    ok(await ratifyReviewed(root, theirs.id));

    const late = await ratifySpec(root, mine.id);
    assert.match((late as { error: string }).error, /no section "Credit"/);
    assert.ok((await requirementSections(root)).some((s) => s.section === "Exposure/Limits"));
  } finally { discard(root); }
});

test("two moves whose subtrees overlap cannot ride in one spec", async () => {
  const { root } = await universe();
  try {
    await adoptRule(root, { title: "Currency", section: "Credit/Limits", statement: "All credit lines are in USD." });
    await adoptRule(root, { title: "Float", section: "Settlement/Float", statement: "Float settles T+1." });

    const sp = ok(await draftSpec(root, { title: "two moves" } as any));
    ok(await addOperation(root, {
      specId: sp.id, kind: "move_section", rationale: "ownership", reversibility: "reversible",
      fromSection: "Credit", toSection: "Risk",
    } as any));
    // A second move of a subtree INSIDE the first reads the first one's output, so the
    // before/after a principal approved is not what lands.
    const overlap = await addOperation(root, {
      specId: sp.id, kind: "move_section", rationale: "ownership", reversibility: "reversible",
      fromSection: "Credit/Limits", toSection: "Risk/Caps",
    } as any);
    assert.match((overlap as { error: string }).error, /overlaps it/);

    // A disjoint one is fine — the refusal is about overlap, not about a second move.
    ok(await addOperation(root, {
      specId: sp.id, kind: "move_section", rationale: "ownership", reversibility: "reversible",
      fromSection: "Settlement", toSection: "Treasury",
    } as any));
  } finally { discard(root); }
});

test("a spec renders which rules a move would actually take, read live", async () => {
  const { root } = await universe();
  try {
    await adoptRule(root, { title: "Currency", section: "Credit/Limits", statement: "All credit lines are in USD." });

    const sp = ok(await draftSpec(root, { title: "credit becomes risk" } as any));
    ok(await addOperation(root, {
      specId: sp.id, kind: "move_section", rationale: "ownership", reversibility: "reversible",
      fromSection: "Credit", toSection: "Risk",
    } as any));

    // Filed AFTER the operation was drafted. A principal who is shown only "Credit -> Risk"
    // cannot see how much is filed under it, which is the whole trade this surface makes.
    await adoptRule(root, { title: "Daily cap", section: "Credit/Limits/Daily", statement: "Daily draw is capped." });

    const rendered = ok(await getSpec(root, sp.id));
    const moves = rendered.operations[0]!.moves!;
    assert.deepEqual(
      moves.members.map((m) => `${m.from} -> ${m.to}`).sort(),
      ["Credit/Limits -> Risk/Limits", "Credit/Limits/Daily -> Risk/Limits/Daily"],
    );
    assert.equal(rendered.adoptable, true);
    assert.equal(moves.blocked, undefined);

    // And when the move's ground shifts, the surface must say so BEFORE the ratifier acts.
    // A move carries no `context`, so nothing else on this page could notice: the spec
    // would read adoptable right up to the ratification that refuses it.
    const other = ok(await draftSpec(root, { title: "somebody else got there first" } as any));
    ok(await addOperation(root, {
      specId: other.id, kind: "move_section", rationale: "ownership", reversibility: "reversible",
      fromSection: "Credit", toSection: "Exposure",
    } as any));
    ok(await ratifyReviewed(root, other.id));

    const after = ok(await getSpec(root, sp.id));
    assert.equal(after.adoptable, false);
    assert.equal(after.operations[0]!.contextMoved, true);
    assert.match(after.operations[0]!.moves!.blocked!, /no section "Credit"/);
  } finally { discard(root); }
});

/**
 * Spec withdrawal — the before-reliance half of backout.
 *
 * The refusals are the substance, so each test establishes that the withdrawal WORKS on the
 * same fixture first and then introduces the one thing that should stop it. A file that
 * only asserted refusals would pass with `withdrawSpec` returning an error unconditionally.
 */
test("a draft may always be withdrawn, and the gap attached to it is released with it", async () => {
  const { root } = await universe();
  try {
    const sp = ok(await draftSpec(root, { title: "a rule nothing satisfies yet" } as any));
    const op = ok(await addOperation(root, {
      specId: sp.id, kind: "add_requirement", rationale: "policy", reversibility: "reversible",
      title: "Settlement currency", section: "Settlement/Float",
      statement: "Float settles T+1.", provenance: "policy",
    } as any));
    // A pre-approved gap: pending, and it silences nothing until the spec is adopted.
    ok(await acknowledgeGap(root, {
      operationId: op.id, rationale: "no code exists to conform yet", priority: "medium",
      revalidateBy: "2027-01-01T00:00:00Z", ...AGENT,
    } as any));
    assert.equal((await listAcknowledgements(root)).filter((a) => a.state !== "released").length, 1);

    const done = ok(await withdrawSpec(root, sp.id, { reason: "drafted against the wrong cluster" }));
    assert.equal(done.spec.status, "withdrawn");
    assert.deepEqual(done.removed, [], "a draft applied nothing, so it removes nothing");
    // The approval outlives nothing: the rule it pre-approved will never exist.
    assert.equal((await listAcknowledgements(root)).filter((a) => a.state !== "released").length, 0);
    assert.equal((await pendingSpecs(root)).length, 0, "and it leaves the ratification queue");
  } finally { discard(root); }
});

test("a ratified spec nothing relies on is withdrawn; one something cites is not", async () => {
  const { root } = await universe();
  try {
    // The positive half, on its own fixture: an add-only spec with nothing downstream.
    const clean = await adoptRule(root, { title: "Float", section: "Settlement/Float", statement: "Float settles T+1." });
    const done = ok(await withdrawSpec(root, clean.specId, { reason: "the cluster was never adopted" }));
    assert.equal(done.spec.status, "withdrawn");
    assert.deepEqual(await listRequirements(root), [], "what it put into the standard is gone");
    assert.ok(ok(await readSpec(root, clean.specId)), "the spec itself stays — the act happened");

    // …and the same shape, with one audit against the rule.
    const cited = await adoptRule(root, { title: "Currency", section: "Credit/Limits", statement: "All credit lines are in USD." });
    // `indeterminate` needs no evidence, and reliance does not care about the verdict —
    // an audit against the rule is a reader who has already been told something about it.
    ok(await recordAudit(root, {
      requirementId: cited.rule.id, outcome: "indeterminate", finding: "could not reach the handler",
      ...AGENT,
    } as any));
    const refused = await withdrawSpec(root, cited.specId, { reason: "same reason" });
    assert.match((refused as { error: string }).error, /already rely on what it introduced/);
    assert.equal((await listRequirements(root)).length, 1, "and the rule is still there");
    assert.equal((await relianceOn(root, await readOperations(root, { specId: cited.specId })))[0]!.kind, "audit");
  } finally { discard(root); }
});

test("a spec that amended something is refused outright, however little relies on it", async () => {
  const { root } = await universe();
  try {
    const { rule } = await adoptRule(root);
    const sp = ok(await draftSpec(root, { title: "widen the currency rule" } as any));
    ok(await addOperation(root, {
      specId: sp.id, kind: "amend_statement", requirementId: rule.id,
      statement: "All credit lines are in USD or EUR.", rationale: "EU launch", reversibility: "reversible",
    } as any));
    ok(await ratifyReviewed(root, sp.id));

    // Nothing cites the rule at all — so this refusal is about the OPERATION KIND, which is
    // the whole point: undoing it would need the witnesses the amendment re-baselined away.
    assert.deepEqual(await relianceOn(root, await readOperations(root, { specId: sp.id })), []);
    const refused = await withdrawSpec(root, sp.id, { reason: "EU launch slipped" });
    assert.match((refused as { error: string }).error, /Repeal it instead/);
    assert.equal((await listRequirements(root))[0]!.statement, "All credit lines are in USD or EUR.");
  } finally { discard(root); }
});

test("an agent may not withdraw a spec", async () => {
  const { root } = await universe();
  try {
    const { specId } = await adoptRule(root, { title: "Float", section: "Settlement/Float", statement: "Float settles T+1." });
    const refused = await withdrawSpec(root, specId, { reason: "tidy", ...AGENT } as any);
    assert.ok("error" in refused);
    // The principal path must work on the same fixture, or the refusal above proves nothing.
    ok(await withdrawSpec(root, specId, { reason: "tidy" }));
  } finally { discard(root); }
});
