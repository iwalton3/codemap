/**
 * The standard with a sidecar configured: what leaves this machine, and what does not.
 *
 * The local tests in `requirements.test.ts` and friends never configure one, so they
 * exercise only the local path. These are the ones that would catch a record that stops
 * travelling, or one that starts travelling when it should not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { indexBlob } from "./repo.js";
import { writeStore, readRequirements, readSpecs, readAudits, readProblems } from "./store.js";
import type { State } from "./schema.js";
import { discard } from "./test-tmp.js";
import { resolveSidecar } from "./sidecar-config.js";
import { materializeStandard } from "./standard-publish.js";
import { readScope } from "./eventlog.js";
import { standardScope, lawScope } from "./shared-standard.js";
import { draftSpec, addOperation, ratifySpec, listRequirements, withdrawSpec } from "./requirements.js";
import { ratifyReviewed, signOffEverything } from "./test-approve.js";
import { readSpec } from "./store.js";
import { recordAudit, promotableAudits, promoteProvisionalAudit } from "./audits.js";
import { raiseProblem, listProblems } from "./problems.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const SRC = "export function creditLine(cents) { return cents * 2; }\n";

const git = (root: string, ...a: string[]) => spawnSync("git", a, { cwd: root, encoding: "utf8" });

/** A store on `main` with a sidecar beside it, so writes have somewhere to go. */
async function shared() {
  const root = mkdtempSync(join(tmpdir(), "codemap-share-"));
  const side = mkdtempSync(join(tmpdir(), "codemap-side-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "izzie@x.com");
  git(root, "config", "user.name", "izzie");
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/credit.js"), SRC, "utf8");
  writeFileSync(join(root, "src/x.txt"), "x", "utf8");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
  const indexed = await indexBlob(SRC, "src/credit.js");
  await writeStore(root, indexed, state);
  return { root, side, anchors: indexed.map((a) => a.id) };
}

const ok = <T>(r: T): Exclude<T, { error: string }> => {
  assert.ok(!(r && typeof r === "object" && "error" in (r as object)), `unexpected error: ${(r as any)?.error}`);
  return r as Exclude<T, { error: string }>;
};

/** The EVIDENCE half — audits, pointers, problems, debt. */
const events = async (root: string, side: string) =>
  readScope(side, standardScope(resolveSidecar(root)!.universe));

/** The LAW half — specs, operations, criteria, gaps. One scope for the whole workspace. */
const lawEvents = async (side: string) => readScope(side, lawScope());

test("a spec travels, and the standard a teammate reads is folded from the log", async () => {
  const { root, side, anchors } = await shared();
  try {
    assert.ok(resolveSidecar(root), "the fixture must actually have a sidecar or this is vacuous");
    const sp = ok(await draftSpec(root, { title: "Credit currency policy" }));
    ok(await addOperation(root, {
      specId: sp.id, kind: "add_requirement", rationale: "policy §4 was never written down",
      reversibility: "reversible", title: "Credit line currency", section: "Credit/Limits",
      statement: "All credit lines are in USD.", provenance: "credit policy §4",
    }));
    ok(await ratifyReviewed(root, sp.id));

    // Law, not evidence: a spec governs the workspace, so it does not live in one
    // universe's scope. The evidence half stays empty here — nothing was audited.
    // The reviewer's sign-offs are acts and enter the log with the rest: one for the
    // framing, one per operation, then the adoption they are what permits.
    assert.deepEqual((await lawEvents(side)).map((e) => e.kind), [
      "spec.drafted", "spec.operation", "spec.reviewed", "spec.reviewed", "spec.ratified",
    ]);
    assert.deepEqual(await events(root, side), [], "a spec is not an observation of this universe's code");

    // The rows exist because the FOLD wrote them, not because a local write did: they
    // carry the sync origin, which a local row never has.
    const rules = (await readRequirements(root)).requirements;
    assert.equal(rules.length, 1);
    assert.equal(rules[0]!.origin, "sync");
    assert.equal((await readSpecs(root))[0]!.origin, "sync");
    assert.equal(rules[0]!.statement, "All credit lines are in USD.");
    // No baseline on the rule itself: a requirement is upstream of code, and what watches
    // the code is a pointer, which carries its own witnesses and names its own universe.
    assert.ok(!("witnesses" in rules[0]!), "a folded rule carries no witnesses");
  } finally { discard(root); discard(side); }
});

test("an audit and its problem travel from the default branch", async () => {
  const { root, side, anchors } = await shared();
  try {
    const sp = ok(await draftSpec(root, { title: "Credit currency policy" }));
    ok(await addOperation(root, {
      specId: sp.id, kind: "add_requirement", rationale: "x", reversibility: "reversible",
      title: "Credit line currency", section: "Credit/Limits",
      statement: "All credit lines are in USD.", provenance: "credit policy §4",
    }));
    ok(await ratifyReviewed(root, sp.id));
    const rule = (await listRequirements(root))[0]!;

    const audit = ok(await recordAudit(root, {
      requirementId: rule.id, outcome: "nonconformant",
      finding: "creditLine doubles the amount", evidence: { read: anchors },
    }));
    assert.equal(audit.audit.provisional, undefined, "main is the default branch here");
    assert.equal(audit.audit.branch, "main");
    ok(await raiseProblem(root, { auditId: audit.id, summary: "creditLine does not enforce USD" }));

    const kinds = (await events(root, side)).map((e) => e.kind);
    assert.ok(kinds.includes("audit.recorded"), "an audit of the codebase is the team's");
    assert.ok(kinds.includes("problem.raised"));
    assert.equal((await readAudits(root))[0]!.origin, "sync");
    assert.equal((await readProblems(root))[0]!.origin, "sync");
  } finally { discard(root); discard(side); }
});

test("a PROVISIONAL audit stays put, however the sidecar is configured", async () => {
  const { root, side, anchors } = await shared();
  try {
    const sp = ok(await draftSpec(root, { title: "Credit currency policy" }));
    ok(await addOperation(root, {
      specId: sp.id, kind: "add_requirement", rationale: "x", reversibility: "reversible",
      title: "Credit line currency", section: "Credit/Limits",
      statement: "All credit lines are in USD.", provenance: "credit policy §4",
    }));
    ok(await ratifyReviewed(root, sp.id));
    const rule = (await listRequirements(root))[0]!;
    const before = (await events(root, side)).length;

    // Somebody's work in progress. Auditing it is real work; broadcasting it announces a
    // non-conformance on code that may be fixed or abandoned before it ever merges.
    git(root, "checkout", "-q", "-b", "feature/credit");
    const audit = ok(await recordAudit(root, {
      requirementId: rule.id, outcome: "nonconformant",
      finding: "creditLine doubles the amount on this branch", evidence: { read: anchors },
    }));
    assert.equal(audit.audit.provisional, true);
    assert.equal(audit.audit.branch, "feature/credit");

    const problem = ok(await raiseProblem(root, { auditId: audit.id, summary: "branch-local non-conformance" }));
    assert.equal(problem.problem.provisional, true, "a problem is exactly as shareable as its evidence");

    assert.equal((await events(root, side)).length, before, "nothing left this machine");
    // And it is fully usable here — provisional does not mean second-class, only local.
    assert.equal((await listProblems(root)).length, 1);
    assert.equal((await readAudits(root))[0]!.origin, undefined, "a local row, not a folded one");
  } finally { discard(root); discard(side); }
});

/**
 * The model an agent is told never to guess, on the one surface a principal reads.
 *
 * `commentOn` forwarded `{model, harness}` to the FINDING branch and not to the proposal
 * branch, so an agent's objection to an amendment recorded no model and degraded to the
 * bare string "agent" — on the spec page, where the reader is deciding whether to adopt
 * the thing. `thread()`'s own docstring calls collapsing an agent's remark into a person's
 * "the misattribution this codebase has already shipped once".
 */
test("an agent's comment on a proposal records WHICH agent", async () => {
  const { root, side } = await shared();
  try {
    const sp = ok(await draftSpec(root, { title: "Credit currency policy" }));
    const { commentOn } = await import("./ops.js");
    ok(await commentOn(root, {
      id: sp.id, body: "is T+1 calendar or business days?",
      agent: true, model: "claude-opus-5", harness: "claude-code",
    } as any));

    const { sharedNotes } = await import("./ops-shared.js");
    const r = await sharedNotes(root, sp.id) as { notes: { by: string; model?: string }[] };
    assert.equal(r.notes.length, 1);
    assert.equal(r.notes[0]!.model, "claude-opus-5",
      "\"agent\" alone does not tell a ratifier whose objection this is");
  } finally { discard(root); discard(side); }
});

test("a failed append writes nothing at all", async () => {
  const { root, side } = await shared();
  try {
    // A sidecar that cannot work: the path is a FILE, so every append throws. A local row
    // here would fabricate causality no clone can ever see.
    writeFileSync(join(root, ".codemap", "sidecar"), join(root, "src/x.txt"), "utf8");
    const refused = await draftSpec(root, { title: "Goes nowhere" });
    assert.ok("error" in refused);
    assert.match((refused as any).error, /sidecar/i);
    assert.equal((await readSpecs(root)).length, 0, "and no local row was written");
  } finally { discard(root); discard(side); }
});

/** A ratified rule the code violates, in a store that shares. */
async function ruleAndCode() {
  const f = await shared();
  const sp = ok(await draftSpec(f.root, { title: "Credit currency policy" }));
  ok(await addOperation(f.root, {
    specId: sp.id, kind: "add_requirement", rationale: "x", reversibility: "reversible",
    title: "Credit line currency", section: "Credit/Limits",
    statement: "All credit lines are in USD.", provenance: "credit policy §4",
  }));
  ok(await ratifyReviewed(f.root, sp.id));
  return { ...f, rule: (await listRequirements(f.root))[0]! };
}

test("a provisional finding whose code survived the merge is promotable, on evidence not on ancestry", async () => {
  const { root, side, anchors, rule } = await ruleAndCode();
  try {
    git(root, "checkout", "-q", "-b", "feature/credit");
    const found = ok(await recordAudit(root, {
      requirementId: rule.id, outcome: "nonconformant",
      finding: "creditLine doubles the amount", evidence: { read: anchors },
    }));
    assert.equal(await promotableAudits(root).then((a) => a.length), 0, "not while still on the branch");

    // Merged without a fix: back on the default branch, the audited source is verbatim
    // present, so the finding is evidence rather than inference.
    git(root, "checkout", "-q", "main");
    const promotable = await promotableAudits(root);
    assert.equal(promotable.length, 1);
    assert.equal(promotable[0]!.id, found.id);

    const before = (await events(root, side)).length;
    const promoted = ok(await promoteProvisionalAudit(root, found.id));
    assert.equal(promoted.audit.provisional, undefined);
    assert.match(promoted.audit.finding, /promoted from provisional audit/);
    assert.ok((await events(root, side)).length > before, "the promotion is what reaches the team");
    assert.equal(promoted.audit.promotedFrom, found.id, "the promotion names what it re-records");
    assert.equal(
      await promotableAudits(root).then((a) => a.length), 0,
      "and it is not promotable twice — the original stays non-superseded for ever, so nothing else would stop it",
    );
  } finally { discard(root); discard(side); }
});

test("a provisional finding that was FIXED before merging makes no noise at all", async () => {
  const { root, side, anchors, rule } = await ruleAndCode();
  try {
    git(root, "checkout", "-q", "-b", "feature/credit");
    const found = ok(await recordAudit(root, {
      requirementId: rule.id, outcome: "nonconformant",
      finding: "creditLine doubles the amount", evidence: { read: anchors },
    }));

    // The branch author fixes it. The audited code is now different code.
    writeFileSync(join(root, "src/credit.js"), "export function creditLine(cents) { return cents; }\n", "utf8");
    git(root, "commit", "-qam", "fix on the branch");
    git(root, "checkout", "-q", "main");
    git(root, "merge", "-q", "--no-edit", "feature/credit");
    await writeStore(root, await indexBlob("export function creditLine(cents) { return cents; }\n", "src/credit.js"), state);

    assert.equal(
      await promotableAudits(root).then((a) => a.length), 0,
      "a superseded finding says nothing about what is here now, so it never reaches the team",
    );
    const refused = await promoteProvisionalAudit(root, found.id);
    assert.ok("error" in refused, "and it cannot be promoted by hand either");
    assert.match((refused as any).error, /survives its own fix/);
  } finally { discard(root); discard(side); }
});

/**
 * Two clones of ONE universe on ONE log.
 *
 * They must share a directory BASENAME: a local origin is never a GitHub URL, so
 * `universeKey` takes its fallback, and differently-named clones publish to different
 * universes and never see each other — the fixture would pass while testing nothing.
 */
async function twoClones() {
  const side = mkdtempSync(join(tmpdir(), "codemap-side2-"));
  const roots: string[] = [];
  for (const parent of [mkdtempSync(join(tmpdir(), "codemap-a-")), mkdtempSync(join(tmpdir(), "codemap-b-"))]) {
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

test("a shared ratification reports what the FOLD did, not what it was asked to do", async () => {
  // `ratifySpec` used to push every operation onto `applied` and return `ok: true` the
  // moment the append succeeded, without ever consulting the fold — which is the only
  // thing that applies anything on this path, and which can refuse. A ratification the
  // fold threw away was indistinguishable from one it adopted.
  const { a, b, side } = await twoClones();
  try {
    assert.equal(resolveSidecar(a)!.universe, resolveSidecar(b)!.universe,
      "the clones must be ONE universe or they never see each other");

    // A rule both clones can see.
    const base = ok(await draftSpec(a, { title: "Currency policy" }));
    ok(await addOperation(a, {
      specId: base.id, kind: "add_requirement", rationale: "policy §4", reversibility: "reversible",
      title: "Credit line currency", section: "Credit/Limits",
      statement: "All credit lines are in USD.", provenance: "policy",
    }));
    const adopted = ok(await ratifyReviewed(a, base.id));
    assert.ok(adopted.applied, "folded here, so this clone can say what landed");
    // Read back from the FOLD, so the operation carries the rule it created — the shared
    // path used to return the unbound original and this was `undefined`.
    assert.ok(adopted.applied[0]!.requirementId, "the returned operation names what it created");
    // B syncs. An ordinary read never folds the log — it is pull/push — so without this
    // B simply has no standard, and the race below could not be set up at all.
    assert.equal(await materializeStandard(b, resolveSidecar(b)!), true);
    const rule = (await listRequirements(b))[0]!;
    assert.equal(rule.statement, "All credit lines are in USD.");

    // B drafts an amendment against the text as it stands...
    const mine = ok(await draftSpec(b, { title: "B's amendment" }));
    ok(await addOperation(b, {
      specId: mine.id, kind: "amend_statement", requirementId: rule.id,
      statement: "All credit lines are in GBP.", rationale: "b", reversibility: "reversible",
    }));
    // B signs off its own proposal BEFORE A's lands, which is the story this test tells:
    // B reviewed what it drafted, and the race happened underneath it. Signing off after
    // A had landed would pull A's ratification in and refuse for a different reason.
    ok(await signOffEverything(b, mine.id));

    // ...and A ratifies a different one first. The log is pull/push and never read on an
    // ordinary read, so B's local check cannot see this.
    const theirs = ok(await draftSpec(a, { title: "A's amendment" }));
    ok(await addOperation(a, {
      specId: theirs.id, kind: "amend_statement", requirementId: rule.id,
      statement: "All credit lines are in USD or EUR.", rationale: "a", reversibility: "reversible",
    }));
    ok(await ratifyReviewed(a, theirs.id));

    const race = await ratifySpec(b, mine.id);
    assert.ok("error" in race, `B's ratification applied nothing and must not report ok — got ${JSON.stringify(race)}`);
    assert.match(race.error, /applied NOTHING/);
    assert.match(race.error, /Do not retry/, "the spec is spent, and the natural response to an error is a retry");

    // The record agrees with what was reported: spent, and conflicted.
    const spent = await readSpec(b, mine.id);
    assert.equal(spent!.status, "ratified");
    assert.equal(spent!.conflicted, true);
    // And the standard is A's text, on both clones.
    assert.equal((await listRequirements(a))[0]!.statement, "All credit lines are in USD or EUR.");
    assert.equal((await listRequirements(b))[0]!.statement, "All credit lines are in USD or EUR.");
  } finally { discard(a); discard(b); discard(side); }
});

/** Adopt one rule into `section`, through the shared path. */
async function adoptInto(root: string, section: string, title: string, statement: string) {
  const sp = ok(await draftSpec(root, { title: `open ${section}` }));
  ok(await addOperation(root, {
    specId: sp.id, kind: "add_requirement", rationale: "seed", reversibility: "reversible",
    title, section, statement, provenance: "policy",
  }));
  ok(await ratifyReviewed(root, sp.id));
}

test("a section move is applied by the FOLD, subtree and all", async () => {
  const { root, side } = await shared();
  try {
    await adoptInto(root, "Credit/Limits", "Currency", "All credit lines are in USD.");
    await adoptInto(root, "Credit/Limits/Daily", "Daily cap", "Daily draw is capped.");
    await adoptInto(root, "Settlement/Float", "Float", "Float settles T+1.");

    const sp = ok(await draftSpec(root, { title: "credit is risk" }));
    ok(await addOperation(root, {
      specId: sp.id, kind: "move_section", rationale: "ownership", reversibility: "reversible",
      fromSection: "Credit", toSection: "Risk",
    }));
    ok(await ratifyReviewed(root, sp.id));

    const rules = (await readRequirements(root)).requirements;
    assert.deepEqual(
      rules.map((r) => r.section).sort(),
      ["Risk/Limits", "Risk/Limits/Daily", "Settlement/Float"],
    );
    // The fold is the writer on this path, so these rows carry the sync origin. Without
    // that the assertion above would also pass on a purely local apply.
    assert.ok(rules.every((r) => r.origin === "sync"), "the FOLD moved them, not a local write");
    assert.ok((await lawEvents(side)).some((e) => e.kind === "spec.ratified"));
  } finally { discard(root); discard(side); }
});

test("the fold refuses a move whose source another clone has already emptied", async () => {
  // The tool's re-check is TOCTOU across clones: the log is pull/push and never read on an
  // ordinary read, so both principals validate against a section that still exists locally
  // and both append. A move with nothing to move applies cleanly and does NOTHING, so
  // without the fold's own check the loser is told a re-organization landed that did not.
  const { a, b, side } = await twoClones();
  try {
    await adoptInto(a, "Credit/Limits", "Currency", "All credit lines are in USD.");
    assert.equal(await materializeStandard(b, resolveSidecar(b)!), true);
    assert.equal((await listRequirements(b))[0]!.section, "Credit/Limits");

    // B drafts against the section as it stands...
    const mine = ok(await draftSpec(b, { title: "credit becomes exposure" }));
    ok(await addOperation(b, {
      specId: mine.id, kind: "move_section", rationale: "ownership", reversibility: "reversible",
      fromSection: "Credit", toSection: "Exposure",
    }));
    // B signs off its own proposal BEFORE A's lands, which is the story this test tells:
    // B reviewed what it drafted, and the race happened underneath it. Signing off after
    // A had landed would pull A's ratification in and refuse for a different reason.
    ok(await signOffEverything(b, mine.id));

    // ...and A moves it somewhere else first.
    const theirs = ok(await draftSpec(a, { title: "credit becomes risk" }));
    ok(await addOperation(a, {
      specId: theirs.id, kind: "move_section", rationale: "ownership", reversibility: "reversible",
      fromSection: "Credit", toSection: "Risk",
    }));
    ok(await ratifyReviewed(a, theirs.id));

    const race = await ratifySpec(b, mine.id);
    assert.ok("error" in race, "the fold applied nothing, so this is not an ok ratification");
    assert.match(race.error, /applied NOTHING/);
    assert.equal((await listRequirements(b))[0]!.section, "Risk/Limits", "A's move stands; B's did not double-apply");
  } finally { discard(a); discard(b); discard(side); }
});

test("a withdrawal is applied by the FOLD, and RETIRES what it introduced", async () => {
  const { root, side } = await shared();
  try {
    const sp = ok(await draftSpec(root, { title: "float policy" }));
    const op = ok(await addOperation(root, {
      specId: sp.id, kind: "add_requirement", rationale: "policy", reversibility: "reversible",
      title: "Float", section: "Settlement/Float", statement: "Float settles T+1.", provenance: "policy",
    }));
    ok(await addOperation(root, {
      specId: sp.id, kind: "add_criterion", targetOperationId: op.id, rationale: "policy",
      reversibility: "reversible", criterion: "Settlement runs on T+1.",
      falsifier: "A settlement dated T+2 is accepted.", evidenceKind: "automated-test",
    }));
    ok(await ratifyReviewed(root, sp.id));
    assert.equal((await readRequirements(root)).requirements.length, 1);

    ok(await withdrawSpec(root, sp.id, { reason: "the cluster was never adopted" }));
    // TOMBSTONED by the fold, not dropped. Deleting the row orphaned every citation, which
    // is what forced withdrawal to prove a distributed negative; retiring proves nothing
    // and every clone reaches it from law alone.
    const rules = (await readRequirements(root)).requirements;
    assert.equal(rules.length, 1, "the row survives — a tombstone, not a hole");
    assert.equal(rules[0]!.status, "retired", "and it no longer binds");
    assert.equal((await readSpecs(root))[0]!.status, "withdrawn", "the spec itself survives, as the act it was");
    assert.ok((await lawEvents(side)).some((e) => e.kind === "spec.withdrawn"));
  } finally { discard(root); discard(side); }
});

/**
 * A citation on another clone no longer decides anything, because withdrawal no longer
 * destroys what the citation points at.
 *
 * This drove `relianceEverywhere` — the cross-scope scan that read every universe's
 * evidence to prove nothing anywhere relied on the rule. That machinery is gone with the
 * deletion it protected. Both acts land, and B's audit resolves against a retired rule.
 */
test("a citation on another clone survives the withdrawal, on both clones", async () => {
  const { a, b, side } = await twoClones();
  try {
    await adoptInto(a, "Settlement/Float", "Float", "Float settles T+1.");
    assert.equal(await materializeStandard(b, resolveSidecar(b)!), true);
    const rule = (await listRequirements(b))[0]!;
    ok(await recordAudit(b, {
      requirementId: rule.id, outcome: "indeterminate", finding: "could not reach the handler",
    }));

    const spec = (await readSpecs(a))[0]!;
    ok(await withdrawSpec(a, spec.id, { reason: "never adopted" }));

    for (const [who, root] of [["A", a], ["B", b]] as const) {
      if (root === b) assert.equal(await materializeStandard(b, resolveSidecar(b)!), true);
      const rules = (await readRequirements(root)).requirements;
      assert.equal(rules.length, 1, `${who}: the row survives`);
      assert.equal(rules[0]!.status, "retired", `${who}: and it is out of force`);
      assert.equal((await readSpecs(root)).find((x) => x.id === spec.id)!.status, "withdrawn", `${who}: the act happened`);
    }
    assert.equal((await readAudits(b)).length, 1, "and B's audit still resolves against a rule that is there");
  } finally { discard(a); discard(b); discard(side); }
});
