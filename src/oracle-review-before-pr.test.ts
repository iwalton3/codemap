/**
 * Workflow — a branch reviewed before its pull request exists, and the findings arriving
 * on the pull request once it is opened.
 *
 * `review-before-pr.test.ts` pins this on one machine. What only two real clones can show:
 * the branch's findings travel through the sidecar to a teammate who has never seen the
 * branch, and they appear under the pull request on THEIR machine once anybody linked it.
 * The oracle runs without `gh`, so the link is made by hand (`link_review`), which is the
 * path a machine without `gh` takes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { team, who, settle, edit, commit, branch, pushBranch, openPr, type Team } from "./oracle.js";
import { Ledger, checkAlways, checkSettled } from "./oracle-properties.js";
import { reportDefect } from "./ops/defect.js";
import { linkReviewOp, sharedFindings, sharedSync } from "./ops-shared.js";
import { readFindings } from "./store.js";
import { branchKey } from "./review-target.js";

const OWNER = "izzie@acme.test";
const MATE = "ben@acme.test";

test("findings filed on a branch reach a teammate, and appear under the pull request once linked", async () => {
  const t: Team = await team([OWNER, MATE]);
  const ledger = new Ledger();
  const step = async (what: string, fn: () => Promise<void>) => {
    await fn();
    try { await checkAlways(t, ledger); }
    catch (e) { throw new Error(`after "${what}": ${(e as Error).message}`); }
  };

  try {
    const izzie = who(t, OWNER), ben = who(t, MATE);
    let id = "";

    await step("izzie reviews her branch before opening a pull request", async () => {
      branch(izzie, "feature/limits", { create: true });
      edit(izzie, { "src/limits.ts": "export function cap(amount: number) {\n  return Math.min(amount, 100);\n}\n" });
      commit(izzie, "cap transfers");
      pushBranch(izzie, "feature/limits");
      branch(izzie, "main");   // she is back on main; the branch is only a ref here now

      const r = await reportDefect(izzie.repo, {
        context: { kind: "branch", branch: "feature/limits" },
        targetKind: "anchor", targetId: "src/limits.ts#cap",
        text: "a negative amount passes the cap", comment: "reject amounts < 0 before capping",
        severity: "high",
      }) as Record<string, unknown>;
      assert.equal(r.error, undefined, String(r.error));
      id = String(r.id);
      await sharedSync(izzie.repo);
    });

    await settle(t);
    await checkSettled(t, ledger);

    await step("ben has the branch's finding without ever having the branch", async () => {
      const [f] = (await readFindings(ben.repo, { pr: branchKey("feature/limits") })).findings;
      assert.equal(f?.id, id);
      assert.ok(f?.origin, "folded from the sidecar, not filed here");
      assert.equal((await readFindings(ben.repo, { pr: 41 })).findings.length, 0, "no pull request yet");
    });

    await step("izzie opens the pull request and links it — no gh here", async () => {
      openPr(izzie, 41, { branch: "feature/limits" });
      const l = await linkReviewOp(izzie.repo, "41", "feature/limits") as Record<string, unknown>;
      assert.equal(l.error, undefined, String(l.error));
      await sharedSync(izzie.repo);
    });

    await settle(t);
    await checkSettled(t, ledger);

    await step("on ben's machine the pull request now carries the branch's finding", async () => {
      const [f] = (await readFindings(ben.repo, { pr: 41 })).findings;
      assert.equal(f?.id, id, "under the pull request");
      assert.equal(f?.pr, branchKey("feature/limits"), "still living in the branch's scope");
      const s = await sharedFindings(ben.repo, 41) as { findings: { id: string }[] };
      assert.deepEqual(s.findings.map((x) => x.id), [id], "and in shared_findings");
    });
  } finally { t.dispose(); }
});
