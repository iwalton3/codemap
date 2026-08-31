/**
 * The audit, and the non-vacuity rule it exists to enforce.
 *
 * A positive audit has an EFFECT — it closes a gap and silences the mechanism that would
 * have caught the thing — so the tests here care as much about what is refused as about
 * what is recorded. Each proves the permitted path works before proving the refused one is
 * refused, and every guard is mutation-checked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { indexBlob } from "./repo.js";
import { writeStore, readAcknowledgement } from "./store.js";
import type { State } from "./schema.js";
import { discard } from "./test-tmp.js";
import { draftSpec, addOperation, ratifySpec, listRequirements, getSpec, pendingSpecs } from "./requirements.js";
import { ratifyReviewed } from "./test-approve.js";
import { acknowledgeGap, acknowledgeDebt } from "./acknowledgements.js";
import { recordAudit, auditsFor, conformance, silenced } from "./audits.js";
import { auditClaimStands } from "./schema.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const SRC = "export function creditLine(cents) { return cents; }\n";
const LATER = "2027-01-01";

async function universe() {
  const root = mkdtempSync(join(tmpdir(), "codemap-audit-"));
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

/** One ratified rule, plus the id of the operation that produced it. */
async function adoptRule(root: string) {
  const sp = ok(await draftSpec(root, { title: "Credit currency policy" }));
  const op = ok(await addOperation(root, {
    specId: sp.id, kind: "add_requirement", rationale: "policy §4 was never written down",
    reversibility: "reversible", title: "Credit line currency", section: "Credit/Limits",
    statement: "All credit lines are in USD.", provenance: "credit policy §4",
  }));
  return { specId: sp.id, operationId: op.id };
}

test("a conformant audit must have touched the code — consulting a doc certifies nothing", async () => {
  const { root, anchors } = await universe();
  try {
    const { specId } = await adoptRule(root);
    ok(await ratifyReviewed(root, specId));
    const rule = (await listRequirements(root))[0]!;

    const docOnly = await recordAudit(root, {
      requirementId: rule.id, outcome: "conformant", finding: "the module doc says USD only",
      evidence: { consulted: ["n_credit"] },
    });
    assert.ok("error" in docOnly, "doc-only evidence must not certify");
    assert.match((docOnly as any).error, /READ or a command it RAN/);

    const nothing = await recordAudit(root, {
      requirementId: rule.id, outcome: "conformant", finding: "looks fine",
    });
    assert.ok("error" in nothing, "an audit that records nothing cannot claim conformance");
    assert.equal((await auditsFor(root, rule.id)).length, 0, "a refused audit writes nothing");

    // The same claim WITH code read is accepted, so the refusals are about evidence.
    ok(await recordAudit(root, {
      requirementId: rule.id, outcome: "conformant", finding: "creditLine returns cents unchanged",
      evidence: { read: anchors, ran: [{ command: "npm test", passed: true }] },
    }));
    assert.equal((await conformance(root))[0]!.conformance, "conformant");
  } finally { discard(root); }
});

/**
 * `conformant` over code that is not there, and nothing could ever supersede it.
 *
 * The gate asked the `@work` TABLE while the witnesses came from a live RE-PARSE. A
 * renamed symbol keeps its `@work` row, so the audit was admitted with every witness
 * `sha256:absent` — and absent never drifts, so no later edit could ever make the claim
 * stale. A permanent pass, standing on a symbol that no longer exists.
 */
test("evidence.read is resolved against the live tree, not against a `@work` row that outlived it", async () => {
  const { root, anchors } = await universe();
  try {
    const { specId } = await adoptRule(root);
    ok(await ratifyReviewed(root, specId));
    const rule = (await listRequirements(root))[0]!;

    // POSITIVE FIRST, and it must witness a REAL hash — an absent one here would make the
    // refusal below unfalsifiable.
    const good = ok(await recordAudit(root, {
      requirementId: rule.id, outcome: "conformant", finding: "creditLine returns cents unchanged",
      evidence: { read: anchors },
    }));
    assert.deepEqual(good.audit.witnesses.filter((w) => w.bodyHash === "sha256:absent"), [],
      "a conformant audit must freeze a hash something can later contradict");

    // The rename, with NO reindex: `@work` keeps the old id, the file no longer mints it.
    writeFileSync(join(root, "src/credit.js"), "export function creditCeiling(cents) { return cents; }\n", "utf8");
    spawnSync("git", ["commit", "-qam", "rename"], { cwd: root });

    const stale = await recordAudit(root, {
      requirementId: rule.id, outcome: "conformant", finding: "still fine",
      evidence: { read: anchors },
    });
    assert.ok("error" in stale, "an audit whose every witness would be absent is not an audit");
    assert.match((stale as any).error, /unknown anchor/);
    assert.equal((await auditsFor(root, rule.id)).length, 1, "and the refusal wrote nothing");
  } finally { discard(root); }
});

test("a nonconformant audit needs evidence too — absence of evidence must never file", async () => {
  const { root, anchors } = await universe();
  try {
    const { specId } = await adoptRule(root);
    ok(await ratifyReviewed(root, specId));
    const rule = (await listRequirements(root))[0]!;

    const cannotVerify = await recordAudit(root, {
      requirementId: rule.id, outcome: "nonconformant", finding: "I could not verify this",
    });
    assert.ok("error" in cannotVerify);
    assert.match((cannotVerify as any).error, /indeterminate/);

    // `indeterminate` is the quiet bucket and is the ONE outcome that may carry nothing.
    ok(await recordAudit(root, {
      requirementId: rule.id, outcome: "indeterminate", finding: "no ledger path was reachable from the map",
    }));
    ok(await recordAudit(root, {
      requirementId: rule.id, outcome: "nonconformant", finding: "creditLine doubles the amount",
      evidence: { read: anchors },
    }));
  } finally { discard(root); }
});

/**
 * A detector that went RED is the strongest evidence of non-conformance there is.
 *
 * `hasEvidence` reused `touchedCode`, which requires `ran.some(r => r.passed)`. That is
 * right for the CONFORMANT direction — a green detector is what certifies — and exactly
 * inverted for this one. An auditor who ran the lint, watched it FAIL and recorded
 * `{ command, passed: false }` was told their demonstrated violation was "I could not
 * verify this" and to file it `indeterminate`: the quiet bucket, for the loudest evidence.
 *
 * The `{ passed: true }` case below is what keeps `passed` from being ignored altogether —
 * a command NAME is still required, because a bare verdict records nothing that was run.
 */
test("a RED detector files a nonconformant audit; a nameless one still does not", async () => {
  const { root } = await universe();
  try {
    const { specId } = await adoptRule(root);
    ok(await ratifyReviewed(root, specId));
    const rule = (await listRequirements(root))[0]!;

    ok(await recordAudit(root, {
      requirementId: rule.id, outcome: "nonconformant", finding: "the cap lint fails on the credit path",
      evidence: { ran: [{ command: "npm run lint:credit-cap", passed: false }] },
    }));

    // Still refused, and by the guard one layer earlier: a `ran` entry with no command
    // records nothing that was run, whatever its verdict says. So the arm above accepts a
    // FAILING check, not any `ran` entry at all.
    const nameless = await recordAudit(root, {
      requirementId: rule.id, outcome: "nonconformant", finding: "trust me",
      evidence: { ran: [{ command: "   ", passed: false }] },
    });
    assert.ok("error" in nameless, "a nameless command is not evidence");
    assert.match((nameless as any).error, /needs the `command` you actually ran/);

    // And absence of evidence is still not evidence — the case that must keep working.
    const nothing = await recordAudit(root, {
      requirementId: rule.id, outcome: "nonconformant", finding: "I could not verify this",
    });
    assert.ok("error" in nothing);
    assert.match((nothing as any).error, /indeterminate/);
  } finally { discard(root); }
});

/**
 * The FOLD's copy of the evidence rule, which diverged from the tool's the day the tool's
 * was fixed.
 *
 * `hasEvidence` was changed so a RED detector files a nonconformant audit;
 * `auditClaimStands` — the end every clone applies — still demanded `r.passed`. The tool
 * answered `{ok: true}`, the fold dropped the event, and on a sidecar store `disposition`
 * skips the local write too, so the audit existed on NO machine. `sharing-boundary.test.ts`
 * pins the pair as text; this pins the BEHAVIOUR, because a grep passes on a line that is
 * still present and no longer used.
 *
 * The conformant row is what keeps the fix honest: a failed check is evidence of a
 * violation and must never certify one.
 */
test("the fold's evidence rule admits a red detector, and still refuses it as certification", () => {
  const audit = (outcome: string, evidence: unknown) => ({
    id: "au_1", requirementId: "req_1", outcome, finding: "the cap lint fails on the credit path",
    evidence, witnesses: [], auditor: { principal: "izzie@x.com" }, at: "2026-08-01T00:00:00.000Z",
    trigger: "ad-hoc",
  }) as never;
  const RED = { ran: [{ command: "npm run lint:credit-cap", passed: false }] };

  assert.equal(auditClaimStands(audit("nonconformant", RED)), true, "a red detector IS the violation");
  assert.equal(auditClaimStands(audit("conformant", RED)), false, "and certifies nothing");
  assert.equal(auditClaimStands(audit("nonconformant", { ran: [{ command: "   ", passed: false }] })), false,
    "a nameless command records nothing that ran");
  assert.equal(auditClaimStands(audit("nonconformant", {})), false, "and absence of evidence never files");
});

test("a positive audit closes a gap, which nothing else can", async () => {
  const { root, anchors } = await universe();
  try {
    const { specId, operationId } = await adoptRule(root);
    const gap = ok(await acknowledgeGap(root, {
      operationId, rationale: "no credit path exists yet", priority: "medium", revalidateBy: LATER,
    }));
    ok(await ratifyReviewed(root, specId));
    const rule = (await listRequirements(root))[0]!;
    assert.equal((await conformance(root))[0]!.conformance, "gap");

    const audited = ok(await recordAudit(root, {
      requirementId: rule.id, outcome: "conformant", finding: "the credit path now exists and is USD only",
      evidence: { read: anchors },
    }));
    assert.deepEqual(audited.released, [gap.id], "the audit released the gap");
    assert.equal((await readAcknowledgement(root, gap.id))!.state, "released");
    assert.equal((await conformance(root))[0]!.conformance, "conformant");
  } finally { discard(root); }
});

test("a nonconformant audit falsifies a gap, so a stale gap cannot hide code that exists", async () => {
  const { root, anchors } = await universe();
  try {
    const { specId, operationId } = await adoptRule(root);
    const gap = ok(await acknowledgeGap(root, {
      operationId, rationale: "no credit path exists yet", priority: "medium", revalidateBy: LATER,
    }));
    ok(await ratifyReviewed(root, specId));
    const rule = (await listRequirements(root))[0]!;

    // A gap claims there is no code that should conform. Finding some that does not
    // conform falsifies the claim, so the silencer goes.
    const audited = ok(await recordAudit(root, {
      requirementId: rule.id, outcome: "nonconformant", finding: "creditLine exists and does not enforce USD",
      evidence: { read: anchors },
    }));
    assert.deepEqual(audited.released, [gap.id]);
    assert.equal(
      (await conformance(root))[0]!.conformance, "unknown",
      "no longer a gap, and a nonconformant audit is not a state anyone accepted",
    );
  } finally { discard(root); }
});

test("debt survives a nonconformant audit, because that is exactly what debt says", async () => {
  const { root, anchors } = await universe();
  try {
    const { specId } = await adoptRule(root);
    ok(await ratifyReviewed(root, specId));
    const rule = (await listRequirements(root))[0]!;
    const debt = ok(await acknowledgeDebt(root, {
      requirementId: rule.id, rationale: "one ledger path is EUR and stays that way for now",
      priority: "high", revalidateBy: LATER,
    }));

    const audited = ok(await recordAudit(root, {
      requirementId: rule.id, outcome: "nonconformant", finding: "creditLine does not enforce USD",
      evidence: { read: anchors },
    }));
    assert.deepEqual(audited.released, [], "debt and non-conformance are consistent by construction");
    assert.equal((await readAcknowledgement(root, debt.id))!.state, "active");
    assert.equal(
      (await conformance(root))[0]!.conformance, "debt",
      "the acknowledgement decides how a known violation reads — that is what it is for",
    );
  } finally { discard(root); }
});

test("a superseded audit returns the rule to unknown, and the regression is still visible", async () => {
  const { root, anchors } = await universe();
  try {
    const { specId } = await adoptRule(root);
    ok(await ratifyReviewed(root, specId));
    const rule = (await listRequirements(root))[0]!;
    ok(await recordAudit(root, {
      requirementId: rule.id, outcome: "conformant", finding: "USD only, verified",
      evidence: { read: anchors },
    }));
    assert.equal((await conformance(root))[0]!.conformance, "conformant");
    assert.equal((await silenced(root)).regressed, 0);

    await editCode(root, "export function creditLine(cents) { return cents * 2; }\n");

    const row = (await conformance(root))[0]!;
    assert.equal(row.conformance, "unknown", "nobody has checked the code that is actually there now");
    assert.equal(row.lastAudit!.superseded, true);
    assert.equal(
      row.wasConformant, true,
      "that it was met once is kept on the record — which is what makes this a regression rather than a gap that was always there",
    );
    assert.equal((await silenced(root)).regressed, 1);
  } finally { discard(root); }
});

test("silenced separates checked from merely unexamined", async () => {
  const { root, anchors } = await universe();
  try {
    const first = await adoptRule(root);
    ok(await ratifyReviewed(root, first.specId));
    const a = (await listRequirements(root))[0]!;
    ok(await recordAudit(root, {
      requirementId: a.id, outcome: "conformant", finding: "verified", evidence: { read: anchors },
    }));

    const sp = ok(await draftSpec(root, { title: "Idempotency" }));
    ok(await addOperation(root, {
      specId: sp.id, kind: "add_requirement", rationale: "never written down", reversibility: "reversible",
      title: "Settlement idempotency", section: "Settlement/Keys",
      statement: "Every settlement endpoint requires an idempotency key.", provenance: "our own past choice",
    }));
    ok(await ratifyReviewed(root, sp.id));

    const s = await silenced(root);
    assert.deepEqual(
      { total: s.total, conformant: s.conformant, unknown: s.unknown, gap: s.gap, debt: s.debt },
      { total: 2, conformant: 1, unknown: 1, gap: 0, debt: 0 },
      "one rule is checked and one is merely unexamined, and they must not read the same",
    );
  } finally { discard(root); }
});

test("a failed command is evidence of non-conformance, never of conformance", async () => {
  const { root, anchors } = await universe();
  try {
    // Two guards fire on this path and they must not be confused, which is how this test
    // passed vacuously the first time it was written: `touchedCode` is about the `passed`
    // flag, and the baseline check is about having anything that could later invalidate
    // the claim. Each assertion below names the message it expects.
    const sp = ok(await draftSpec(root, { title: "Cited rule" }));
    ok(await addOperation(root, {
      specId: sp.id, kind: "add_requirement", rationale: "x", reversibility: "reversible",
      title: "Credit line currency", section: "Credit/Limits",
      statement: "All credit lines are in USD.", provenance: "credit policy §4",
    }));
    ok(await ratifyReviewed(root, sp.id));
    const rule = (await listRequirements(root))[0]!;

    const failed = await recordAudit(root, {
      requirementId: rule.id, outcome: "conformant", finding: "the suite ran",
      evidence: { ran: [{ command: "false", passed: false }] },
    });
    assert.match((failed as { error: string }).error, /must record code it READ or a command it RAN/,
      "any nonempty `ran` used to count as touching code");

    // A PASSING command alone gets PAST that guard and is stopped by the next one — and
    // this is a real change: it used to be allowed, because the rule's own citations were
    // merged in and silently supplied the baseline. A requirement cites nothing now, so
    // there is nothing to inherit and the auditor has to say what they read. Nothing else
    // could ever supersede a green command, which is the definition the guard applies.
    const noBaseline = await recordAudit(root, {
      requirementId: rule.id, outcome: "conformant", finding: "the suite is green",
      evidence: { ran: [{ command: "npm test", passed: true }] },
    });
    assert.match((noBaseline as { error: string }).error, /needs something that could later invalidate it/);

    ok(await recordAudit(root, {
      requirementId: rule.id, outcome: "conformant", finding: "the suite is green",
      evidence: { read: anchors, ran: [{ command: "npm test", passed: true }] },
    }));
  } finally { discard(root); }
});

test("an audit of a dirty tree is provisional, whatever branch it is on", async () => {
  const { root, anchors } = await universe();
  try {
    const { specId } = await adoptRule(root);
    ok(await ratifyReviewed(root, specId));
    const rule = (await listRequirements(root))[0]!;

    const clean = ok(await recordAudit(root, {
      requirementId: rule.id, outcome: "conformant", finding: "verified", evidence: { read: anchors },
    }));
    assert.equal(clean.audit.provisional, undefined, "committed work on the default branch is about the codebase");

    // Uncommitted. The witnesses come off the filesystem while `commit` records an
    // unchanged HEAD, so sharing this attributes work in progress to a commit that does
    // not contain it — the dirty-snapshot confusion codemap has shipped once already.
    writeFileSync(join(root, "src/credit.js"), "export function creditLine(c) { return c * 3; }\n", "utf8");
    const dirty = ok(await recordAudit(root, {
      requirementId: rule.id, outcome: "indeterminate", finding: "mid-edit",
    }));
    assert.equal(dirty.audit.provisional, true);
  } finally { discard(root); }
});

test("a rule whose cited symbol was RENAMED can still be audited", async () => {
  // `recordAudit` validated the merged list of `evidence.read` AND the requirement's own
  // `cites`, so once a citation left `@work` every audit of that rule was refused — in all
  // three outcomes, `indeterminate` included, which the module documents as "the quiet
  // bucket, and the only outcome that may carry nothing". The rule was pinned at `unknown`
  // for good and the error named ids the caller had never supplied.
  //
  // A rename is the ordinary way this happens: the anchor id is derived from the symbol
  // path, so renaming a function changes it. CLAUDE.md flags the same churn for overload
  // signatures — `Apply(SomeEvent)` in an event-sourced codebase, i.e. exactly the code
  // people file findings about.
  const { root, anchors } = await universe();
  try {
    // A requirement CITES NOTHING now, so the original defect is structurally impossible:
    // there are no citations on a rule to leave the tree and refuse its audits. What the
    // test still has to hold is the half that outlived it — the caller's own evidence.
    const sp = ok(await draftSpec(root, { title: "Cited policy" }));
    ok(await addOperation(root, {
      specId: sp.id, kind: "add_requirement", rationale: "r", reversibility: "reversible",
      title: "Credit line currency", section: "Credit/Cited",
      statement: "All credit lines are in USD.", provenance: "policy",
    }));
    ok(await ratifyReviewed(root, sp.id));
    const rule = (await listRequirements(root, { section: "Credit/Cited" }))[0]!;

    // The symbol is renamed, so the id below no longer exists in the tree.
    await editCode(root, "export function creditLimit(cents) { return cents; }\n");

    const quiet = ok(await recordAudit(root, {
      requirementId: rule.id, outcome: "indeterminate", finding: "could not reach the setter",
    }));
    assert.ok(quiet.id, "an unverifiable rule is `indeterminate`, not an unauditable one");
    assert.deepEqual(quiet.audit.witnesses, [],
      "an audit witnesses what the AUDITOR read and nothing else — it used to inherit the "
      + "rule's citations, so it claimed to have read code the auditor never opened");

    // And the caller's OWN evidence is still checked — the refusal moved, it did not go.
    const bogus = await recordAudit(root, {
      requirementId: rule.id, outcome: "indeterminate", finding: "f",
      evidence: { read: ["a_not_a_real_anchor"] },
    });
    assert.match((bogus as { error: string }).error, /unknown anchor\(s\) in evidence\.read/,
      "an id the caller passed must still have to exist");
  } finally { discard(root); }
});

test("a spec shows the ratifier the silencers already attached to it", async () => {
  // A gap may only be minted while the spec is a DRAFT, and ratification binds it to the
  // rule the operation creates — so the rule arrives classified `gap` instead of `unknown`,
  // on an agent's assertion that no code which should conform exists yet, which nothing can
  // check until the population predicate exists. The ratifier is the only person who can
  // refuse that, and neither `getSpec` nor `pendingSpecs` showed it: they could approve the
  // rule without ever seeing the classification riding along with it.
  const { root } = await universe();
  try {
    const { specId, operationId } = await adoptRule(root);

    // Could this pass vacuously? Before the gap exists both readings are 0.
    assert.equal(ok(await getSpec(root, specId)).silenced, 0);
    assert.equal((await pendingSpecs(root))[0]!.silenced, 0);

    ok(await acknowledgeGap(root, {
      operationId, rationale: "nothing implements this yet", priority: "low",
      revalidateBy: LATER,
    }));

    const rendered = ok(await getSpec(root, specId));
    assert.equal(rendered.silenced, 1);
    assert.equal(rendered.operations[0]!.silencedBy.length, 1);
    assert.equal(rendered.operations[0]!.silencedBy[0]!.basis, "gap");
    assert.equal((await pendingSpecs(root))[0]!.silenced, 1,
      "visible in the QUEUE too, or it is only found by whoever already opened the spec");

    // And it does not block adoption: a pre-attached gap is something to see and decide
    // about, not a defect in the proposal.
    assert.equal(rendered.adoptable, true);
    ok(await ratifyReviewed(root, specId));
  } finally { discard(root); }
});
