/**
 * Workflow 9 — a defect outlives the pull request that found it.
 *
 * `shared-bugs.test.ts` pins every fold rule against hand-built events and
 * `bugs-store.test.ts` pins the table against one machine. Neither can reach the thing
 * bugs were made shared FOR, which needs two real clones writing through the real ops
 * and syncing through the real transport:
 *
 * - **A finding accepted into a bug survives the branch it was found on.** The finding
 *   stays on the pull request for its history; the bug carries the obligation, and the
 *   other person has it.
 * - **The drift verdict is each machine's own.** One person re-witnesses a bug after
 *   the code moves; the other, whose checkout still has the old code, must NOT inherit
 *   that answer — `possiblyFixed` is a join, not a claim, and shipping it would be a
 *   copy nobody can refresh.
 * - **A conversation, not a status field.** Two people comment, one links a ticket, and
 *   both see all of it.
 *
 * The six properties run after every step, plus `bugOwnership`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { team, who, whileApart, settle, edit, commit, type Team } from "./oracle.js";
import { Ledger, checkAlways, checkSettled } from "./oracle-properties.js";
import * as ops from "./ops.js";
import { shareFinding, sharedFindings, sharedSync } from "./ops-shared.js";

const OWNER = "izzie@acme.test";
const MATE = "ben@acme.test";

const bugById = async (repo: string, id: string) => {
  const b = await ops.bugDetail(repo, id) as any;
  assert.equal(b.error, undefined, `${repo} cannot read bug ${id}: ${b.error}`);
  return b;
};

test("a finding becomes a bug, travels, and each machine judges its own code", async () => {
  const t: Team = await team([OWNER, MATE]);
  const ledger = new Ledger();
  const step = async (what: string, fn: () => Promise<void>) => {
    await fn();
    try { await checkAlways(t, ledger); }
    catch (e) { throw new Error(`after "${what}": ${(e as Error).message}`); }
  };

  try {
    const izzie = who(t, OWNER), ben = who(t, MATE);
    let bugId = "";

    // 1 — a finding on a pull request, and the act that stops it dying with the branch.
    await step("izzie files a finding and accepts it into a bug", async () => {
      const f = await shareFinding(izzie.repo, 264, {
        targetKind: "anchor", targetId: "src/pay.ts#transfer",
        text: "transfer() accepts a negative amount and moves money the wrong way",
        comment: "reject amounts <= 0", severity: "high", category: "Validation",
      }) as any;
      assert.equal(f.error, undefined, `the finding did not file: ${f.error}`);

      const accepted = await ops.acceptFinding(izzie.repo, 264, f.id) as any;
      assert.equal(accepted.error, undefined, `accept failed: ${accepted.error}`);
      bugId = accepted.id;

      const view = await sharedFindings(izzie.repo, 264) as any;
      assert.equal(view.findings[0]!.bug, bugId, "the finding cross-links to its successor");
      assert.equal(view.waitingOnYou, 0, "and stops asking — the bug is asking now");
      await sharedSync(izzie.repo);
    });

    await settle(t);
    await checkSettled(t, ledger);

    // 2 — THE POINT. Ben never saw the pull request; he has the defect anyway.
    await step("ben has the bug, with the evidence and where it came from", async () => {
      const b = await bugById(ben.repo, bugId);
      assert.equal(b.title, "transfer() accepts a negative amount and moves money the wrong way");
      assert.equal(b.severity, "high");
      assert.equal(b.shared, true);
      assert.deepEqual(b.from, { pr: "264", finding: b.from?.finding });
      assert.ok(b.anchors.length > 0 && b.anchors.every((a: any) => a.present),
        "and it cites code ben can open, resolved in HIS index");
      assert.equal((await ops.listBugs(ben.repo) as any).bugs.length, 1);
    });

    // 3 — a conversation, both directions, and a ticket link.
    await step("both of them work the bug, and each sees the other's half", async () => {
      await whileApart(t,
        OWNER, async (m) => {
          await ops.commentBug(m.repo, bugId, "the guard is missing in transfer, not in post");
        },
        MATE, async (m) => {
          await ops.commentBug(m.repo, bugId, "reproduced against staging with -100");
          await ops.corroborateBugOp(m.repo, bugId, "confirm", "reproduced with a negative amount");
          await ops.trackBugExternally(m.repo, bugId, { key: "ACME-31", url: "https://jira.acme.test/ACME-31" });
        });
    });

    await settle(t);
    await checkSettled(t, ledger);

    await step("…and after the sync both halves are on both machines", async () => {
      for (const m of [izzie, ben]) {
        const b = await bugById(m.repo, bugId);
        assert.deepEqual(
          b.thread.map((c: any) => c.body).sort(),
          ["reproduced against staging with -100", "the guard is missing in transfer, not in post"],
          `${m.actor.principal} is missing half the conversation`,
        );
        assert.deepEqual(b.tracking, [{ system: "jira", key: "ACME-31", url: "https://jira.acme.test/ACME-31" }]);
        assert.equal(b.tracked, true);
        assert.equal(b.state, "created", "being in a tracker is not being fixed");
        assert.equal(b.corroboration.length, 1);
      }
      // The ratchet, across machines: ben confirmed it, so izzie's AGENT may not close it.
      // The op resolves its own actor and takes no override, so the model is set around
      // the call — and restored in `finally`, because the suite runs in ONE process and
      // a left-set global makes later files fail as "an agent may not".
      const saved = process.env.CODEMAP_AGENT_MODEL;
      process.env.CODEMAP_AGENT_MODEL = "claude-opus-5";
      try {
        const r = await ops.updateBug(izzie.repo, { id: bugId, state: "resolved" }) as any;
        assert.match(r.error ?? "", /needs a person/,
          "an agent closing what a colleague stood behind is the whole reason for the gate");
      } finally {
        if (saved === undefined) delete process.env.CODEMAP_AGENT_MODEL;
        else process.env.CODEMAP_AGENT_MODEL = saved;
      }
      assert.equal((await bugById(izzie.repo, bugId)).state, "created", "…and nothing moved");
    });

    // 4 — THE VERDICT IS LOCAL. Izzie fixes the code; ben has not pulled it.
    await step("izzie's checkout moves under the bug and ben's does not", async () => {
      edit(izzie, {
        "src/pay.ts": "export function transfer(c: number) {\n  if (c <= 0) throw new Error('no');\n  return c;\n}\n",
      });
      commit(izzie, "guard transfer");
      await ops.reindex(izzie.repo);

      const hers = await bugById(izzie.repo, bugId);
      assert.equal(hers.possiblyFixed, true, "the code she cited moved — re-validate, do not close");
      assert.equal(hers.state, "created", "and drift is never a state change");

      const his = await bugById(ben.repo, bugId);
      assert.equal(his.possiblyFixed, false,
        "ben's checkout still has the old code, so the verdict about HIS tree is unchanged — "
        + "a shipped `possiblyFixed` would be a copy he could never refresh");
    });

    await settle(t);
    await checkSettled(t, ledger);

    await step("…and syncing does not give ben her verdict", async () => {
      assert.equal((await bugById(ben.repo, bugId)).possiblyFixed, false,
        "the witness travels; the judgement about it does not");
      assert.equal((await bugById(izzie.repo, bugId)).possiblyFixed, true, "…and hers survived the sync");
    });

    // 5 — a person closes it, and that DOES travel.
    await step("izzie resolves it and ben sees it closed", async () => {
      const r = await ops.updateBug(izzie.repo, { id: bugId, state: "resolved", reason: "guarded in transfer" }) as any;
      assert.equal(r.error, undefined, `close failed: ${r.error}`);
      await sharedSync(izzie.repo);
    });

    await settle(t);
    await checkSettled(t, ledger);

    await step("the whole team's list agrees", async () => {
      for (const m of [izzie, ben]) {
        const b = await bugById(m.repo, bugId);
        assert.equal(b.state, "resolved", `${m.actor.principal} still has it open`);
        assert.equal(b.possiblyFixed, false, "a closed bug is not in the re-validate queue");
        assert.equal((await ops.listBugs(m.repo, { open: true }) as any).bugs.length, 0);
        assert.equal((await ops.listBugs(m.repo) as any).counts.resolved, 1);
      }
    });
  } finally { t.dispose(); }
});

/**
 * The duplicate the derived id exists to prevent.
 *
 * Two people reviewing the same pull request, offline from each other, both decide the
 * same finding is worth keeping. A minted id would give the team one defect twice —
 * with the conversation split across them, which is worse than either half alone.
 */
test("two people accepting one finding, apart, land on ONE bug", async () => {
  const t: Team = await team([OWNER, MATE]);
  const ledger = new Ledger();
  try {
    const izzie = who(t, OWNER), ben = who(t, MATE);

    const f = await shareFinding(izzie.repo, 264, {
      targetKind: "anchor", targetId: "src/pay.ts#transfer",
      text: "negatives are not rejected", comment: "guard it", severity: "high",
    }) as any;
    assert.equal(f.error, undefined);
    await settle(t);

    const ids: string[] = [];
    await whileApart(t,
      OWNER, async (m) => { ids.push(((await ops.acceptFinding(m.repo, 264, f.id)) as any).id); },
      MATE, async (m) => { ids.push(((await ops.acceptFinding(m.repo, 264, f.id)) as any).id); });
    assert.equal(ids[0], ids[1], "the id is derived from the finding, so neither had to see the other");

    await settle(t);
    await checkSettled(t, ledger);

    for (const m of [izzie, ben]) {
      const list = await ops.listBugs(m.repo) as any;
      assert.equal(list.bugs.length, 1, `${m.actor.principal} has the defect ${list.bugs.length} time(s)`);
      assert.equal(list.bugs[0]!.id, ids[0]);
    }
  } finally { t.dispose(); }
});
