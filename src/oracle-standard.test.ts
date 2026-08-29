/**
 * Workflow 10 — the standard as shared law.
 *
 * `shared-standard.test.ts` pins every fold rule against hand-built events, and
 * `standard-sharing.test.ts` drives two hand-built clones through one sidecar. Neither
 * runs the ORACLE's invariants, and that is the gap this file closes — a gap that is
 * bigger than it looks:
 *
 * **Four of the six properties are generic over scopes** (`projectionFor` has known
 * `standard/` since it was added) **and not one of them had ever seen a standard event**,
 * because no scenario produced any. Convergence, projection-vs-rows, determinism under
 * shuffled arrival, and no-loss have therefore never once run over specs, requirements,
 * acknowledgements, audits or problems. Writing the scenario is what switches them on.
 *
 * What needs two real machines, and cannot be reached with one:
 *
 * - **Two principals adopt against the same rule without seeing each other.** The log is
 *   pull/push, so both local context checks pass and both append. The fold picks one and
 *   marks the other `conflicted` — and every clone must pick the SAME one, or the standard
 *   is not law, it is a per-machine opinion.
 * - **A gap minted on one clone binds on another.** The gap names an operation; the rule
 *   does not exist yet. Whoever folds the ratification has to bind it, or a silencer
 *   arrives attached to nothing and quietly silences a rule nobody can find it by.
 * - **Branch work reaches the reviewer, and not the standard.** A provisional audit
 *   travels as a commit-discovered document; the problem raised from it does not, and no
 *   clone ends up with a row either could be counted in.
 * - **An adjudication travels with the problem it decides**, and lands on a clone that
 *   never saw the code.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { team, who, whileApart, settle, branch, appendRaw, rewriteHistory, type Team, type Member } from "./oracle.js";
import { Ledger, checkAlways, checkSettled } from "./oracle-properties.js";
import { SIDECAR_PROTOCOL, EVENT_SCHEMA, readScope } from "./eventlog.js";
import { standardScope } from "./shared-standard.js";
import { universeKey } from "./sidecar-config.js";
import { readAcknowledgements, readAudits } from "./store.js";
import { readAnchorStore, readSpecs, readOperations } from "./store.js";
import {
  draftSpec, addOperation, ratifySpec, listRequirements, getSpec, pendingSpecs,
} from "./requirements.js";
import { acknowledgeGap, listAcknowledgements } from "./acknowledgements.js";
import { recordAudit, conformance, provisionalAudits, promotableAudits } from "./audits.js";
import { raiseProblem, adjudicate, listProblems, awaitingAdjudication } from "./problems.js";

const OWNER = "izzie@acme.test";
const MATE = "ben@acme.test";

const ok = <T>(r: T): Exclude<T, { error: string }> => {
  assert.ok(!(r && typeof r === "object" && "error" in (r as object)),
    `unexpected error: ${(r as { error?: string })?.error}`);
  return r as Exclude<T, { error: string }>;
};

/** The anchor id for a symbol, so operations cite real code rather than a made-up id. */
async function anchorFor(m: Member, file: string, symbol: string): Promise<string> {
  const store = await readAnchorStore(m.repo);
  const a = store.anchors.find((x) => x.file === file && x.symbolPath.includes(symbol));
  assert.ok(a, `${m.repo} has no anchor for ${file}#${symbol}`);
  return a.id;
}

/**
 * Draft one spec carrying SEVERAL operations, and hand back their ids.
 *
 * Several on purpose. A spec with one operation cannot distinguish a fold that respects
 * `ord` from one that applies whatever arrived first, so a scenario built on single-
 * operation specs leaves `determinism` with nothing to bite on over this scope — it runs,
 * and every ordering it tries is the same ordering. A real spec amends several rules at
 * once anyway.
 */
async function adopt(
  m: Member, title: string,
  rules: { title: string; section: string; statement: string }[],
) {
  const sp = ok(await draftSpec(m.repo, { title }));
  const operationIds: string[] = [];
  for (const r of rules) {
    const op = ok(await addOperation(m.repo, {
      specId: sp.id, kind: "add_requirement", rationale: "the contract says so",
      reversibility: "reversible", title: r.title, section: r.section,
      statement: r.statement, provenance: "MSA §4",
    }));
    operationIds.push(op.id);
  }
  return { specId: sp.id, operationIds };
}

test("the standard is one law across machines, and a race for it has one winner", async () => {
  const t: Team = await team([OWNER, MATE]);
  const ledger = new Ledger();
  const step = async (what: string, fn: () => Promise<void>) => {
    await fn();
    try { await checkAlways(t, ledger); }
    catch (e) { throw new Error(`after "${what}": ${(e as Error).message}`); }
  };

  try {
    const izzie = who(t, OWNER), ben = who(t, MATE);
    const transfer = await anchorFor(izzie, "src/pay.ts", "transfer");
    let ruleId = "";

    // 1 — a rule, and a gap raised against the operation BEFORE it is law. The gap names
    //     an operation because the rule does not exist yet; binding is the fold's job.
    await step("izzie proposes a rule and an auditor gaps it", async () => {
      const { specId, operationIds } = await adopt(izzie, "Refund and settlement policy", [
        {
          title: "Refunds never move money the wrong way", section: "Payments/Refunds",
          statement: "A refund must never call transfer with a negative amount.",
        },
        {
          title: "Settlement batches balance", section: "Settlement/Batches",
          statement: "A settlement batch must sum to zero across debits and credits.",
        },
      ]);
      ok(await acknowledgeGap(izzie.repo, {
        operationId: operationIds[0]!, rationale: "no refund path exists yet", priority: "medium",
        revalidateBy: "2027-01-01", agent: true, model: "claude-opus-5",
      }));
      // The ratifier can SEE the silencer riding along — the whole point of rendering it.
      const rendered = ok(await getSpec(izzie.repo, specId));
      assert.equal(rendered.silenced, 1);
      ok(await ratifySpec(izzie.repo, specId));
    });

    await step("everyone settles", async () => {
      await settle(t);
      const mine = await listRequirements(izzie.repo);
      const theirs = await listRequirements(ben.repo);
      assert.equal(mine.length, 2, "one spec, two rules — a spec amends several things at once");
      assert.deepEqual(theirs.map((r) => r.id), mine.map((r) => r.id),
        "a rule is the team's or it is not law");
      ruleId = mine.find((r) => r.section === "Payments/Refunds")!.id;
      assert.equal(theirs[0]!.origin, "sync", "ben's row came from the fold, not a local write");

      // The gap bound to what the operation produced, on the clone that never granted it.
      const bound = await listAcknowledgements(ben.repo, { requirementId: ruleId });
      assert.equal(bound.length, 1, "a silencer that binds to nothing silences a rule nobody can find");
      assert.equal(bound[0]!.basis, "gap");
      // And it is doing its job on ben's machine: gap, not unknown, not conformant.
      const cls = await conformance(ben.repo);
      assert.equal(cls.find((c) => c.requirement.id === ruleId)!.conformance, "gap");
    });

    // 2 — THE RACE. Both draft an amendment against the same text, neither having seen the
    //     other; both local checks pass because the log is never read on an ordinary read.
    await step("two principals amend the same rule while apart", async () => {
      await whileApart(
        t,
        OWNER, async (m) => {
          const sp = ok(await draftSpec(m.repo, { title: "Izzie's amendment" }));
          ok(await addOperation(m.repo, {
            specId: sp.id, kind: "amend_statement", requirementId: ruleId,
            statement: "A refund must never call transfer with a negative amount, and must be logged.",
            rationale: "audit asked for the log line", reversibility: "reversible",
          }));
          return ratifySpec(m.repo, sp.id);
        },
        MATE, async (m) => {
          const sp = ok(await draftSpec(m.repo, { title: "Ben's amendment" }));
          ok(await addOperation(m.repo, {
            specId: sp.id, kind: "amend_statement", requirementId: ruleId,
            statement: "A refund must be expressed as a positive amount on a credit entry.",
            rationale: "the ledger team's shape", reversibility: "reversible",
          }));
          return ratifySpec(m.repo, sp.id);
        },
      );
    });

    await step("the race resolves the same way on both machines", async () => {
      const mine = (await listRequirements(izzie.repo)).find((r) => r.id === ruleId)!;
      const theirs = (await listRequirements(ben.repo)).find((r) => r.id === ruleId)!;
      assert.equal(mine.statement, theirs.statement,
        "two clones disagreeing about what the rule SAYS is the failure this whole subsystem exists to prevent");

      // Both drafts were ratified, so neither is still pending on either machine.
      for (const m of [izzie, ben]) assert.equal((await pendingSpecs(m.repo)).length, 0);

      // And the loser is `conflicted` on BOTH clones, not just where it was written.
      const verdicts = await Promise.all([izzie, ben].map(async (m) => {
        const all = await readSpecs(m.repo, {});
        return ["Izzie's amendment", "Ben's amendment"].map((title) => {
          const sp = all.find((x) => x.title === title)!;
          return `${title}:${sp.conflicted ? "conflicted" : "applied"}`;
        }).join("|");
      }));
      assert.equal(verdicts[0], verdicts[1],
        "the clones must agree WHICH ratification lost, or the standard is a per-machine opinion");
      assert.match(verdicts[0]!, /conflicted/, "one of the two must have lost, or there was no race");
    });

    // 3 — branch work reaches the reviewer without reaching the standard.
    await step("ben's branch finding is visible to izzie, and changes nothing she conforms to", async () => {
      branch(ben, "fix/refunds", { create: true });
      const before = await conformance(izzie.repo);
      const local = ok(await recordAudit(ben.repo, {
        requirementId: ruleId, outcome: "nonconformant", finding: "refund() still negates",
        evidence: { read: [transfer] }, agent: true, model: "claude-opus-5",
      }));
      assert.equal(local.audit.provisional, true, "off the default branch, so it is not the codebase");
      assert.equal(local.notShared, undefined, "and it went to the team as a document");
      ok(await raiseProblem(ben.repo, {
        auditId: local.id, summary: "refund negates the amount", agent: true, model: "claude-opus-5",
      }));
      await settle(t);

      // The finding travels; the problem raised from it does not. A problem is a claim
      // that the team owes something, and nothing is owed until the branch lands.
      const seen = await provisionalAudits(izzie.repo, { commit: local.audit.commit! });
      assert.deepEqual(seen.map((a) => a.id), [local.id],
        "the reviewer of a branch must be able to see that it fails a rule");
      assert.equal((await listProblems(izzie.repo)).length, 0,
        "a problem is exactly as shareable as the evidence under it");

      // And it reached no row: izzie's conformance is byte-for-byte what it was. This is
      // structural rather than filtered — a document is never folded, so there is nothing
      // for `conformance` to have counted.
      assert.deepEqual(
        (await conformance(izzie.repo)).map((c) => `${c.requirement.id}:${c.conformance}`),
        before.map((c) => `${c.requirement.id}:${c.conformance}`),
        "a branch observation must not move the team's standard",
      );
      assert.deepEqual((await readAudits(izzie.repo)).map((a) => a.id), [],
        "and no clone has a row for it at all");

      // Ben's branch changed nothing, so the code izzie has IS the code he audited — which
      // is what makes it promotable to her, on witnesses rather than on ancestry.
      const promotable = await promotableAudits(izzie.repo);
      assert.deepEqual(promotable.map((a) => a.id), [local.id],
        "promotion used to be available only to the author, on the machine that took it");
      branch(ben, "main");
    });

    await step("the same finding from the default branch is the team's", async () => {
      const real = ok(await recordAudit(ben.repo, {
        requirementId: ruleId, outcome: "nonconformant", finding: "refund() negates the amount",
        evidence: { read: [transfer] }, agent: true, model: "claude-opus-5",
      }));
      ok(await raiseProblem(ben.repo, {
        auditId: real.id, summary: "refund negates the amount", agent: true, model: "claude-opus-5",
      }));
      await settle(t);
      const queue = await awaitingAdjudication(izzie.repo);
      assert.equal(queue.length, 1, "izzie has to decide, and can only do that if she has it");
    });

    // 4 — the decision travels, and it is a principal's.
    await step("izzie adjudicates and ben sees which side moves", async () => {
      const p = (await awaitingAdjudication(izzie.repo))[0]!;
      const refused = await adjudicate(izzie.repo, p.id, "code-wrong", "the rule stands",
        { agent: true, model: "claude-opus-5" });
      assert.match((refused as { error: string }).error, /is a principal's act/,
        "an agent may establish the disagreement and may not decide it");

      ok(await adjudicate(izzie.repo, p.id, "code-wrong", "the rule stands"));
      await settle(t);

      // BY ID. Ben holds two problems — the provisional one never left his machine, which
      // is correct — so indexing blindly reads the local one and asserts nothing about
      // what travelled.
      const theirs = (await listProblems(ben.repo)).find((x) => x.id === p.id);
      assert.ok(theirs, "the adjudicated problem must be on ben's machine at all");
      assert.equal(theirs.disposition, "code-wrong");
      assert.equal(theirs.state, "adjudicated", "named, and not yet done");
      assert.equal((await listProblems(ben.repo)).length, 2,
        "and his branch-local problem is still his, untouched by any of this");
    });

    await checkSettled(t, ledger);
  } finally {
    t.dispose();
  }
});

test("co-authoring one spec collides, and the collision is refused rather than resolved", async () => {
  // `ord` is `existing.length` — each clone's own count — so two people adding to one
  // draft spec while apart both get `ord: 0`. That is harmless while the operations touch
  // DIFFERENT rules, and it is the exact state `ratifySpec`'s duplicate-target guard was
  // written for when they touch the same one.
  //
  // That guard was added for "a spec assembled by an older build", and could not be
  // reached through `addOperation` on one machine — the authoring guard prevents the
  // state. Two machines reach it by ordinary concurrent authoring, which is a much
  // stronger reason for it to exist than the one it was written under.
  const t: Team = await team([OWNER, MATE]);
  const ledger = new Ledger();
  try {
    const izzie = who(t, OWNER), ben = who(t, MATE);

    // A rule for them to disagree about.
    const first = await adopt(izzie, "Payments policy", [{
      title: "Refunds are positive", section: "Payments/Refunds",
      statement: "A refund must be expressed as a positive amount.",
    }]);
    ok(await ratifySpec(izzie.repo, first.specId));
    await settle(t);
    const ruleId = (await listRequirements(ben.repo))[0]!.id;

    // Both add an amendment for THE SAME rule to one shared draft, neither seeing the
    // other. Both local duplicate checks pass, because neither has the other's operation.
    const sp = ok(await draftSpec(izzie.repo, { title: "Co-authored amendment" }));
    await settle(t);
    await whileApart(
      t,
      OWNER, (m) => addOperation(m.repo, {
        specId: sp.id, kind: "amend_statement", requirementId: ruleId,
        statement: "A refund must be a positive amount on a credit entry.",
        rationale: "izzie", reversibility: "reversible",
      }),
      MATE, (m) => addOperation(m.repo, {
        specId: sp.id, kind: "amend_statement", requirementId: ruleId,
        statement: "A refund must be a positive amount and must be logged.",
        rationale: "ben", reversibility: "reversible",
      }),
    );

    for (const m of [izzie, ben]) {
      const ops = await readOperations(m.repo, { specId: sp.id });
      assert.equal(ops.length, 2, "both operations reached both clones");
      assert.deepEqual(ops.map((o) => o.ord), [0, 0],
        "`ord` is each clone's own count, so concurrent authors collide on it");
    }

    // Adoption refuses, on both machines, rather than picking one and applying it.
    for (const m of [izzie, ben]) {
      const res = await ratifySpec(m.repo, sp.id);
      assert.match((res as { error: string }).error ?? "", /carries two operations against/,
        `${m.actor.principal} adopted a spec whose two operations were written against the same base`);
    }

    // Nothing moved, and both clones still agree about the rule.
    await settle(t);
    const statements = await Promise.all([izzie, ben].map(async (m) =>
      (await listRequirements(m.repo)).find((r) => r.id === ruleId)!.statement));
    assert.equal(statements[0], "A refund must be expressed as a positive amount.");
    assert.equal(statements[0], statements[1]);

    await checkSettled(t, ledger);
  } finally {
    t.dispose();
  }
});

/**
 * A well-formed envelope from a writer whose TOOL never checked — an older build, a
 * script, somebody with `git` and a text editor. This is the only way to reach the fold's
 * own refusals: every one of them exists because a remote clone sees a ROW and never saw
 * the call, and the ops refuse to append these shapes, so nothing else in the suite can
 * produce them at team scale.
 */
const forged = (over: Record<string, unknown>) => ({
  actor: { principal: "mallory@acme.test", via: { kind: "agent", model: "claude-opus-5" } },
  at: "2026-08-24T00:00:00Z",
  writer: "w_forged", writerPrev: "GENESIS", after: [],
  sidecarProtocol: SIDECAR_PROTOCOL, eventSchema: EVENT_SCHEMA,
  ...over,
});

test("every fold refusal binds a writer whose tool never checked, on every clone", async () => {
  // `sharing-boundary.test.ts` proves the two ends EXIST by reading source. This proves
  // they WORK, against a real log, on a machine that did not write the events — which is
  // the only situation any of them is for. Five forgeries, one per registered guard.
  const t: Team = await team([OWNER, MATE]);
  const ledger = new Ledger();
  try {
    const izzie = who(t, OWNER), ben = who(t, MATE);
    const transfer = await anchorFor(izzie, "src/pay.ts", "transfer");

    // Real state for the forgeries to aim at: one ratified rule, one spec left in DRAFT,
    // and one problem awaiting a decision.
    const adopted = await adopt(izzie, "Payments policy", [{
      title: "Refunds are positive", section: "Payments/Refunds",
      statement: "A refund must be expressed as a positive amount.",
    }]);
    ok(await ratifySpec(izzie.repo, adopted.specId));
    const pending = await adopt(izzie, "A proposal nobody has adopted", [{
      title: "Batches balance", section: "Settlement/Batches",
      statement: "A settlement batch must sum to zero.",
    }]);
    await settle(t);
    const ruleId = (await listRequirements(ben.repo))[0]!.id;
    const audit = ok(await recordAudit(ben.repo, {
      requirementId: ruleId, outcome: "nonconformant", finding: "refund() negates",
      evidence: { read: [transfer] }, agent: true, model: "claude-opus-5",
    }));
    const problem = ok(await raiseProblem(ben.repo, {
      auditId: audit.id, summary: "refund negates", agent: true, model: "claude-opus-5",
    }));
    await settle(t);

    const scope = standardScope(universeKey(ben.repo));
    const shard = `${scope}/w_forged.ndjson`;
    let prev = "GENESIS";
    const append = (id: string, body: Record<string, unknown>) => {
      appendRaw(ben, shard, forged({ id, writerPrev: prev, ...body }));
      prev = id;
    };

    // 1 — an AGENT adopting a spec. The act the whole subsystem reserves.
    append("9000000001-ratify", {
      kind: "spec.ratified", subject: pending.specId,
      data: { at: "2026-08-24T00:00:00Z", witnesses: {}, operations: pending.operationIds },
    });
    // 2 — an agent granting DEBT, which is an admission with an owner.
    append("9000000002-debt", {
      kind: "ack.granted", subject: "ack_forged_debt",
      data: { ack: {
        id: "ack_forged_debt", basis: "debt", requirementId: ruleId, rationale: "living with it",
        priority: "high", revalidateBy: "2027-01-01", state: "active",
        grantedBy: { principal: "mallory@acme.test" }, grantedAt: "2026-08-24T00:00:00Z",
      } },
    });
    // 3 — a GAP aimed at a rule that is already law, naming no operation at all.
    append("9000000003-gap", {
      kind: "ack.granted", subject: "ack_forged_gap",
      data: { ack: {
        id: "ack_forged_gap", basis: "gap", requirementId: ruleId, rationale: "not applicable yet",
        priority: "low", revalidateBy: "2027-01-01", state: "active",
        grantedBy: { principal: "mallory@acme.test" }, grantedAt: "2026-08-24T00:00:00Z",
      } },
    });
    // 4 — `conformant` on a command that FAILED.
    append("9000000004-audit", {
      kind: "audit.recorded", subject: ruleId,
      data: { audit: {
        id: "au_forged", requirementId: ruleId, outcome: "conformant",
        evidence: { ran: [{ command: "false", passed: false }] }, witnesses: [],
        finding: "passes", auditor: { principal: "mallory@acme.test" }, at: "2026-08-24T00:00:00Z",
      } },
    });
    // 5 — an agent deciding which side moves.
    append("9000000005-adjudicate", {
      kind: "problem.adjudicated", subject: problem.id,
      data: { disposition: "requirement-changed", reason: "the business moved", at: "2026-08-24T00:00:00Z" },
    });
    rewriteHistory(ben, "a writer whose tool never checked", () => {});
    await settle(t);

    // COULD ANY OF THIS FAIL? Only if the forgeries actually arrived. Every assertion
    // below is a negative — "this did not happen" — and a shard that never propagated
    // satisfies all of them while testing nothing at all.
    const forgedIds = ["9000000001-ratify", "9000000002-debt", "9000000003-gap",
      "9000000004-audit", "9000000005-adjudicate"];
    for (const m of [izzie, ben]) {
      const ids = new Set((await readScope(m.sidecar, scope)).map((e) => e.id));
      for (const id of forgedIds) {
        assert.ok(ids.has(id), `${m.actor.principal} never received ${id} — the refusals below prove nothing`);
      }
    }

    // Every clone, including the one the shard was written on. A guard that binds only
    // the reader is not a guard: the events are here, and they must fold to nothing.
    for (const m of [izzie, ben]) {
      const where = m.actor.principal;
      const specs = await readSpecs(m.repo, {});
      assert.equal(specs.find((x) => x.id === pending.specId)!.status, "draft",
        `${where}: an agent adopted a spec through the log`);

      const acks = await readAcknowledgements(m.repo, {});
      assert.equal(acks.find((a) => a.id === "ack_forged_debt"), undefined,
        `${where}: an agent granted debt through the log`);
      assert.equal(acks.find((a) => a.id === "ack_forged_gap"), undefined,
        `${where}: a gap was minted against a rule that is already law`);

      assert.equal((await readAudits(m.repo)).find((a) => a.id === "au_forged"), undefined,
        `${where}: a command that FAILED certified a rule`);

      const p = (await listProblems(m.repo)).find((x) => x.id === problem.id)!;
      assert.equal(p.disposition, undefined, `${where}: an agent decided which side moves`);
      assert.equal(p.state, "open");

      // And the standard is exactly what the legitimate acts left behind.
      const rules = await listRequirements(m.repo);
      assert.equal(rules.length, 1, `${where}: the forged ratification added a rule`);
      assert.equal((await conformance(m.repo))[0]!.conformance, "unknown",
        `${where}: the forged audit or the forged gap moved the conformance state`);
    }

    await checkSettled(t, ledger);
  } finally {
    t.dispose();
  }
});
