/**
 * The acknowledgement, and the one thing it must never become: a mute button.
 *
 * The guards here are asymmetric on purpose, so the tests are too. Granting hides a fact
 * and is gated; releasing reveals one and is not. A gap can only be raised before the
 * spec lands; debt only after, and only by a principal. Each test proves the permitted
 * path works before proving the refused one is refused — a module that rejected every
 * write would otherwise "pass" every negative assertion.
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
import { draftSpec, addOperation, ratifySpec, listRequirements, getSpec } from "./requirements.js";
import {
  acknowledgeGap, acknowledgeDebt, releaseAcknowledgement,
  listAcknowledgements, dueForRevalidation,
} from "./acknowledgements.js";
import { conformance, silenced } from "./audits.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const SRC = "export function creditLine(cents) { return cents; }\n";
const AGENT = { agent: true, model: "claude-opus-5" } as const;
const LATER = "2027-01-01";
const PASSED = "2020-01-01";

async function universe() {
  const root = mkdtempSync(join(tmpdir(), "codemap-ack-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "izzie@x.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "izzie"], { cwd: root });
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/credit.js"), SRC, "utf8");
  await writeStore(root, await indexBlob(SRC, "src/credit.js"), state);
  return root;
}

const ok = <T>(r: T): Exclude<T, { error: string }> => {
  assert.ok(!(r && typeof r === "object" && "error" in (r as object)), `unexpected error: ${(r as any)?.error}`);
  return r as Exclude<T, { error: string }>;
};

/** A draft spec with one `add_requirement`, not yet adopted. */
async function draftRule(root: string, over: Record<string, unknown> = {}) {
  const sp = ok(await draftSpec(root, { title: "Idempotency policy" }));
  const op = ok(await addOperation(root, {
    specId: sp.id, kind: "add_requirement", rationale: "the rule was never written down",
    reversibility: "reversible", title: "Settlement idempotency", section: "Settlement/Keys",
    statement: "Every settlement endpoint requires an idempotency key.",
    provenance: "our own past choice", ...over,
  } as any));
  return { specId: sp.id, operationId: op.id };
}

test("a gap is raised before the spec lands, and cannot be raised after", async () => {
  const root = await universe();
  try {
    const { specId, operationId } = await draftRule(root);
    // An auditor AGENT classifying ahead of adoption is the intended caller.
    const gap = ok(await acknowledgeGap(root, {
      operationId, rationale: "there are no settlement endpoints yet", priority: "medium",
      revalidateBy: LATER, workItem: "COD-31", ...AGENT,
    }));
    assert.equal(gap.acknowledgement.basis, "gap");
    assert.equal(gap.acknowledgement.requirementId, undefined, "the rule does not exist yet");

    ok(await ratifySpec(root, specId));
    const rule = (await listRequirements(root))[0]!;
    assert.equal(
      (await readAcknowledgement(root, gap.id))!.requirementId, rule.id,
      "adoption binds the gap to what the operation produced",
    );

    // The load-bearing refusal: no path to a gap after adoption. Declaring a ratified
    // rule not-yet-applicable is how an audit gets cleared without anything being decided.
    const late = ok(await draftSpec(root, { title: "Later" }));
    const lateOp = ok(await addOperation(root, {
      specId: late.id, kind: "amend_statement", requirementId: rule.id, reversibility: "reversible",
      statement: "Every settlement endpoint requires an idempotency key, except refunds.",
      rationale: "refunds are keyed differently",
    }));
    ok(await ratifySpec(root, late.id));
    const refused = await acknowledgeGap(root, {
      operationId: lateOp.id, rationale: "not built", priority: "low", revalidateBy: LATER,
    });
    assert.ok("error" in refused, "a gap may not be raised against a ratified spec");
  } finally { discard(root); }
});

test("debt is a principal's admission, and only against a live rule", async () => {
  const root = await universe();
  try {
    const { specId } = await draftRule(root);
    ok(await ratifySpec(root, specId));
    const rule = (await listRequirements(root))[0]!;

    const denied = await acknowledgeDebt(root, {
      requirementId: rule.id, rationale: "three endpoints do not key", priority: "high",
      revalidateBy: LATER, ...AGENT,
    });
    assert.ok("error" in denied, "an agent must not be able to accept non-conformance");
    assert.match((denied as any).error, /admission with an owner/);
    assert.equal((await listAcknowledgements(root)).length, 0, "a refused grant writes nothing");

    const granted = ok(await acknowledgeDebt(root, {
      requirementId: rule.id, rationale: "three endpoints do not key", priority: "high",
      revalidateBy: LATER,
    }));
    assert.equal(granted.acknowledgement.basis, "debt");
    assert.ok(!granted.acknowledgement.grantedBy.via, "a debt acknowledgement names a person");
  } finally { discard(root); }
});

test("rationale, priority and a revalidate-by date are all required", async () => {
  const root = await universe();
  try {
    const { operationId } = await draftRule(root);
    const base = { operationId, rationale: "not built yet", priority: "medium" as const, revalidateBy: LATER };
    for (const [field, over] of [
      ["rationale", { rationale: "  " }],
      ["priority", { priority: "urgent" }],
      ["revalidateBy", { revalidateBy: "soon" }],
    ] as const) {
      const bad = await acknowledgeGap(root, { ...base, ...over } as any);
      assert.ok("error" in bad, `${field} must be required`);
    }
    ok(await acknowledgeGap(root, base));
  } finally { discard(root); }
});

test("a work item is evidence, and never the release condition", async () => {
  const root = await universe();
  try {
    const { operationId } = await draftRule(root);
    // A linked ticket does not substitute for the date — omitting the date still fails.
    const noDate = await acknowledgeGap(root, {
      operationId, rationale: "tracked in Jira", priority: "medium", workItem: "COD-31",
    } as any);
    assert.ok("error" in noDate);
    assert.match((noDate as any).error, /revalidateBy/);

    const with_both = ok(await acknowledgeGap(root, {
      operationId, rationale: "tracked in Jira", priority: "medium",
      revalidateBy: LATER, workItem: "COD-31",
    }));
    assert.equal(with_both.acknowledgement.workItem, "COD-31");
  } finally { discard(root); }
});

test("revalidation is due by date, is derived rather than stored, and never auto-releases", async () => {
  const root = await universe();
  try {
    // RATIFIED, because a pre-approved gap is `pending` until then and a proposal nobody
    // has adopted cannot be overdue for revalidation — there is nothing being silenced yet.
    const { operationId, specId } = await draftRule(root);
    const a = ok(await acknowledgeGap(root, {
      operationId, rationale: "not built yet", priority: "high", revalidateBy: PASSED,
    }));
    assert.equal(a.acknowledgement.state, "pending", "it silences nothing until the spec is adopted");
    assert.deepEqual(await dueForRevalidation(root, { asOf: "2026-01-01" }), [],
      "and a proposal nobody has adopted cannot be overdue for revalidation");
    ok(await ratifySpec(root, specId));

    // Not due when asked about a moment before the date — so the flip below is evidence
    // rather than a value that was true all along.
    assert.equal((await listAcknowledgements(root, { asOf: "2019-01-01" }))[0]!.revalidateDue, false);
    assert.equal((await listAcknowledgements(root, { asOf: "2026-01-01" }))[0]!.revalidateDue, true);

    // Nothing about being due changes the stored record: it still silences, and it still
    // says active. Auto-release would un-silence a rule nobody has looked at.
    const stored = (await readAcknowledgement(root, a.id))!;
    assert.equal(stored.state, "active");
    assert.ok(!("revalidateDue" in stored), "due-ness is derived, never stored");

    const queue = await dueForRevalidation(root, { asOf: "2026-01-01" });
    assert.equal(queue.length, 1);
    assert.equal((await dueForRevalidation(root, { asOf: "2019-01-01" })).length, 0);
  } finally { discard(root); }
});

test("releasing is open to any actor, because gating what unsilences is backwards", async () => {
  const root = await universe();
  try {
    const { specId, operationId } = await draftRule(root);
    const a = ok(await acknowledgeGap(root, {
      operationId, rationale: "not built yet", priority: "medium", revalidateBy: LATER,
    }));
    ok(await ratifySpec(root, specId));

    const noReason = await releaseAcknowledgement(root, a.id, "  ", AGENT);
    assert.ok("error" in noReason, "a release still has to say why");

    // An AGENT may release: granting hides a fact, releasing reveals one, and the failure
    // mode of the second is noise.
    ok(await releaseAcknowledgement(root, a.id, "the endpoints now key on SettlementId", AGENT));
    assert.equal((await readAcknowledgement(root, a.id))!.state, "released");
    assert.equal((await listAcknowledgements(root, { state: "active" })).length, 0);
  } finally { discard(root); }
});

test("a standard with no audits reads entirely unknown, and never conformant", async () => {
  const root = await universe();
  try {
    const { specId } = await draftRule(root);
    ok(await ratifySpec(root, specId));

    const rows = await conformance(root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.conformance, "unknown", "nobody has checked, and that must not read as fine");
    assert.equal(
      rows.filter((r) => r.conformance === "conformant").length, 0,
      "conformant is unreachable without an audit record, which is correct rather than missing",
    );
  } finally { discard(root); }
});

test("an acknowledgement classifies the rule, and releasing it returns unknown — not conformant", async () => {
  const root = await universe();
  try {
    const { specId } = await draftRule(root);
    ok(await ratifySpec(root, specId));
    const rule = (await listRequirements(root))[0]!;
    assert.equal((await conformance(root))[0]!.conformance, "unknown");

    const debt = ok(await acknowledgeDebt(root, {
      requirementId: rule.id, rationale: "three endpoints do not key", priority: "high", revalidateBy: LATER,
    }));
    assert.equal((await conformance(root))[0]!.conformance, "debt");
    assert.equal((await silenced(root)).debt, 1);

    ok(await releaseAcknowledgement(root, debt.id, "endpoints were fixed"));
    assert.equal(
      (await conformance(root))[0]!.conformance, "unknown",
      "releasing a debt record says nobody is silencing this any more — NOT that the code now conforms",
    );
    assert.equal((await silenced(root)).unknown, 1);
  } finally { discard(root); }
});

test("silenced counts how much of the standard is muted, and by what", async () => {
  const root = await universe();
  try {
    const first = await draftRule(root);
    ok(await acknowledgeGap(root, {
      operationId: first.operationId, rationale: "no settlement endpoints yet",
      priority: "medium", revalidateBy: PASSED,
    }));
    ok(await ratifySpec(root, first.specId));

    const second = await draftRule(root, {
      title: "Credit line currency", section: "Credit/Limits",
      statement: "All credit lines are in USD.", provenance: "credit policy §4",
    });
    ok(await ratifySpec(root, second.specId));
    const currency = (await listRequirements(root)).find((r) => r.section === "Credit/Limits")!;
    ok(await acknowledgeDebt(root, {
      requirementId: currency.id, rationale: "one ledger path is EUR", priority: "high", revalidateBy: LATER,
    }));

    const s = await silenced(root, { asOf: "2026-01-01" });
    assert.deepEqual(
      { total: s.total, gap: s.gap, debt: s.debt, unknown: s.unknown, due: s.due },
      { total: 2, gap: 1, debt: 1, unknown: 0, due: 1 },
    );
  } finally { discard(root); }
});

test("a gap may not be raised against an operation on a rule already in force", async () => {
  const root = await universe();
  try {
    const { specId } = await draftRule(root);
    ok(await ratifySpec(root, specId));
    const rule = (await listRequirements(root))[0]!;

    // The second route to a post-ratification gap, and it survived the draft-only check:
    // draft a NEW spec amending the live rule, gap the amendment while that spec is still
    // a draft, and the binding at ratification attaches an agent's gap to a rule the team
    // has been living under. A gap claims there is no code that should conform yet, which
    // cannot be true of a rule already in force.
    const amend = ok(await draftSpec(root, { title: "Amend it" }));
    const op = ok(await addOperation(root, {
      specId: amend.id, kind: "amend_statement", requirementId: rule.id, reversibility: "reversible",
      statement: "Every settlement endpoint requires an idempotency key, except refunds.",
      rationale: "refunds are keyed differently",
    }));
    const refused = await acknowledgeGap(root, {
      operationId: op.id, rationale: "not built", priority: "low", revalidateBy: LATER, ...AGENT,
    });
    assert.ok("error" in refused);
    assert.match((refused as any).error, /already in force/);
    ok(await ratifySpec(root, amend.id));
    assert.equal((await listAcknowledgements(root)).length, 0, "and nothing bound to the live rule");
  } finally { discard(root); }
});

/**
 * A pre-approved gap is chained to the operation and merged ATOMICALLY with ratification.
 *
 * It is part of the argument a principal is being asked to adopt — *this rule is worth
 * binding even though nothing satisfies it yet* — so it silences nothing until that
 * argument is accepted, and then it does so in the same act that creates the rule. A spec
 * nobody ratifies must leave behind no silencer nobody approved.
 *
 * It was previously `active` from the moment it was granted, and inert only because it
 * carried no `requirementId` and `conformance()` joins on one. Inert by accident of a join
 * is not the same as not existing, and spec withdrawal will make the difference real.
 *
 * A gap accepted AFTER ratification is not this and cannot become it: the standard already
 * binds, so that is a waiver — `basis: "debt"`, post-hoc and principal-granted.
 */
test("a pre-approved gap is pending until ratification, and is visible to the ratifier meanwhile", async () => {
  const root = await universe();
  try {
    const { specId, operationId } = await draftRule(root);
    const a = ok(await acknowledgeGap(root, {
      operationId, rationale: "nothing implements this yet", priority: "low", revalidateBy: LATER,
    }));

    assert.equal(a.acknowledgement.state, "pending");
    assert.equal(a.acknowledgement.requirementId, undefined, "there is no rule to attach it to yet");
    // Silencing NOTHING: not in the active list, not in the revalidation queue.
    assert.deepEqual(await listAcknowledgements(root, { state: "active" }), []);
    // But VISIBLE where it has to be — the ratifier is the only person who can refuse it.
    assert.equal(ok(await getSpec(root, specId)).silenced, 1);

    ok(await ratifySpec(root, specId));
    const bound = (await readAcknowledgement(root, a.id))!;
    assert.equal(bound.state, "active", "adopted in the same act that created the rule");
    assert.ok(bound.requirementId, "and bound to it");
    assert.deepEqual((await listAcknowledgements(root, { state: "active" })).map((x) => x.id), [a.id]);
  } finally { discard(root); }
});

test("a gap on a spec nobody adopts never silences anything", async () => {
  const root = await universe();
  try {
    const { operationId } = await draftRule(root);
    ok(await acknowledgeGap(root, {
      operationId, rationale: "nothing implements this yet", priority: "low", revalidateBy: PASSED,
    }));
    // The spec is simply never ratified. Nothing here becomes a live acceptance, and the
    // revalidation queue — which is where an overdue silencer would surface — stays empty.
    assert.deepEqual(await listAcknowledgements(root, { state: "active" }), []);
    assert.deepEqual(await dueForRevalidation(root, { asOf: "2030-01-01" }), []);
    assert.deepEqual(await listRequirements(root), [], "and no rule came into force either");
  } finally { discard(root); }
});
