import { test } from "node:test";
import assert from "node:assert/strict";
import { team, who, edit, commit, branch, pushBranch, openPr, settle, type Team, type Member } from "./oracle.js";
import { Ledger, checkAlways, checkSettled, verified } from "./oracle-properties.js";
import { pr, prWalkthroughSet, prWalkthroughGet, setTriage, anchorMark } from "./ops.js";
import {
  shareFinding, sharedFindings, corroborateFinding, reportOnFinding,
  shareWalkthrough, sharedWalkthroughs,
} from "./ops-shared.js";
import { markReviewedBatch } from "./reviews.js";
import { triageStatus } from "./triage.js";

/**
 * WORKFLOW 1 — the hand-off arc, which is the product's whole point.
 *
 * A teammate's agents review and triage their OWN branch first, they fix what they
 * can, and what reaches the owner is a walkthrough plus the RESIDUAL findings — not
 * raw code needing artifacts the owner has to create himself. The owner reads at a
 * high level, corroborates or disputes, and signs off LOCALLY, because sign-off here
 * is his own ledger of review debt rather than a claim GitHub should carry.
 *
 * Every step runs the six properties. That is the point of driving the whole chain
 * rather than a unit of it: a defect that needs six operations to appear cannot
 * appear in three, and this is eleven.
 *
 * No `gh` anywhere. The origin has no GitHub slug, so resolution takes the git path
 * by the same rule production uses.
 *
 * WALLS. Three things deliberately do not travel today, and each is asserted
 * INVERTED — the test fails when the gap CLOSES. A wall recorded as a passing
 * assertion is a wall that rots into a lie the moment somebody fixes it.
 */

const OWNER = "izzie@acme.test";
const MATE = "ben@acme.test";

const PR = 11;
const BRANCH = "feature/payee-guard";

/** Ben's change: a real edit to a real symbol, so the index has something to say. */
const GUARDED =
  "export function transfer(amount: number, to: string) {\n"
  + "  if (amount <= 0) throw new Error(\"amount must be positive\");\n"
  + "  if (!to) throw new Error(\"payee required\");\n"
  + "  return { to, amount, at: \"now\" };\n"
  + "}\n\n"
  + "export function refund(amount: number, to: string) {\n"
  + "  return transfer(-amount, to);\n"
  + "}\n";

const LEDGER_FIXED =
  "export class Ledger {\n"
  + "  post(entry: { amount: number }) {\n"
  + "    if (!Number.isFinite(entry.amount)) throw new Error(\"amount must be finite\");\n"
  + "    return entry.amount;\n"
  + "  }\n"
  + "}\n";

test("the hand-off arc: a teammate reviews their own branch, the owner signs off", async () => {
  const t = await team([OWNER, MATE]);
  const ledger = new Ledger();
  /** Every step ends with the invariants, so a failure names the step that broke them. */
  const step = async (what: string, fn: () => Promise<void>) => {
    await fn();
    try { await checkAlways(t, ledger); }
    catch (e) { throw new Error(`after "${what}": ${(e as Error).message}`); }
  };
  const settled = async (what: string) => {
    await settle(t);
    try { await checkSettled(t, ledger); }
    catch (e) { throw new Error(`after settling "${what}": ${(e as Error).message}`); }
  };

  try {
    const ben = who(t, MATE), izzie = who(t, OWNER);
    let worklist: string[] = [];

    // 1 -------------------------------------------------------------------------
    await step("ben proposes a change", async () => {
      branch(ben, BRANCH, { create: true });
      edit(ben, { "src/pay.ts": GUARDED, "src/ledger.ts": LEDGER_FIXED });
      commit(ben, "guard the payee, and reject a non-finite amount");
      pushBranch(ben, BRANCH);
      openPr(ben, PR, { branch: BRANCH });
    });

    // 2 -------------------------------------------------------------------------
    await step("ben's agent reviews it", async () => {
      const t1 = await pr(ben.repo, String(PR)) as any;
      assert.equal(t1.error, undefined, `triage failed: ${t1.error}`);
      assert.equal(t1.pr.source, "git", "resolved with no gh in the loop");
      worklist = t1.worklist.map((w: any) => w.id);
      assert.ok(worklist.length >= 2, `expected changed symbols, got ${worklist.length}`);
      assert.ok(
        t1.worklist.some((w: any) => w.symbol.includes("transfer")),
        "the changed TypeScript symbol is on the worklist",
      );
    });

    let residual = "", fixed = "";
    await step("ben's agent files what it found", async () => {
      const a = await shareFinding(ben.repo, PR, {
        targetKind: "anchor", targetId: worklist[0]!, severity: "medium",
        text: "the payee guard rejects an empty string but not whitespace",
        comment: "`\" \"` is truthy, so a blank payee still gets through",
      }) as any;
      const b = await shareFinding(ben.repo, PR, {
        targetKind: "anchor", targetId: worklist[1]!, severity: "low",
        text: "the finite check should say which entry failed",
        comment: "the message names no id, so a batch failure is unattributable",
      }) as any;
      assert.equal(a.error, undefined, `share failed: ${a.error}`);
      assert.equal(b.error, undefined, `share failed: ${b.error}`);
      residual = a.id; fixed = b.id;
      assert.ok(residual && fixed, "both findings got ids");
    });

    // 3 -------------------------------------------------------------------------
    await step("ben triages the risky one", async () => {
      const r = await setTriage(ben.repo, {
        targetKind: "anchor", targetId: worklist[0]!,
        importance: "business-critical", complexity: "standard", source: "agent",
        reason: "money moves through here",
      }) as any;
      assert.equal(r.error, undefined, `triage failed: ${r.error}`);
    });

    // 4 -------------------------------------------------------------------------
    await step("ben fixes one of them himself", async () => {
      edit(ben, {
        "src/ledger.ts":
          "export class Ledger {\n"
          + "  post(entry: { id: string; amount: number }) {\n"
          + "    if (!Number.isFinite(entry.amount)) throw new Error(`amount must be finite: ${entry.id}`);\n"
          + "    return entry.amount;\n"
          + "  }\n"
          + "}\n",
      });
      commit(ben, "name the failing entry");
      pushBranch(ben, BRANCH);
      openPr(ben, PR, { branch: BRANCH });

      await verified(
        "reportOnFinding", reportOnFinding(ben.repo, PR, fixed, "fixed", "the message carries the entry id now", ["src/ledger.ts"]),
        async () => (await sharedFindings(ben.repo, PR) as any).findings
          .find((f: any) => f.id === fixed)?.outcome?.result === "fixed",
      );
    });

    // 5 -------------------------------------------------------------------------
    await step("ben writes the walkthrough", async () => {
      const t2 = await pr(ben.repo, String(PR)) as any;
      const ids: string[] = t2.worklist.map((w: any) => w.id);
      const w = await prWalkthroughSet(ben.repo, String(PR), [{
        title: "Payee and amount validation",
        summary: "both entry points now reject input they used to pass on",
        chapters: [{
          title: "The guards",
          blocks: [
            { kind: "prose", text: "transfer refuses a missing payee; the ledger refuses a non-finite amount." },
            ...ids.map((id) => ({ kind: "symbol" as const, anchorId: id })),
          ],
        }],
      }], { by: "ben's agent" }) as any;
      assert.equal(w.error, undefined, `walkthrough rejected: ${JSON.stringify(w)}`);

      const stored = await prWalkthroughGet(ben.repo, String(PR)) as any;
      assert.ok(stored.walkthrough, "it is stored locally");
      // A RECEIPT, not a return value: `ok` from a share that never reached the log
      // reads identically to one that did, and this project has shipped exactly that.
      await verified(
        "shareWalkthrough", shareWalkthrough(ben.repo, stored.walkthrough),
        async () => ((await sharedWalkthroughs(ben.repo, PR) as any).count ?? 0) > 0,
      );
    });

    // 6, 7 ----------------------------------------------------------------------
    await settled("ben hands off");

    await step("izzie receives a walkthrough and the residual findings", async () => {
      const t3 = await pr(izzie.repo, String(PR)) as any;
      assert.equal(t3.error, undefined, `izzie could not open the PR: ${t3.error}`);

      const w = await sharedWalkthroughs(izzie.repo, PR, t3.refs.head) as any;
      assert.equal(w.count, 1, "ben's walkthrough travelled");
      assert.equal(w.current?.by, MATE, "and it is attributed to him");
      assert.equal(w.current?.walkthrough.features.length, 1);

      const f = await sharedFindings(izzie.repo, PR) as any;
      assert.equal(f.findings.length, 2, "both findings travelled");
      const byId = new Map<string, any>(f.findings.map((x: any) => [x.id, x]));
      // THE RESIDUAL. What ben fixed is reported as fixed; what he did not is what
      // izzie actually has to read. That distinction is the hand-off.
      assert.equal(byId.get(fixed)?.outcome?.result, "fixed", "his own fix came with it");
      assert.equal(byId.get(fixed)?.outcome?.by, MATE, "reported by him, not by the tool");
      assert.equal(byId.get(residual)?.outcome, undefined, "the residual one is still open");
    });

    // 8 -------------------------------------------------------------------------
    await step("izzie corroborates one and disputes the other", async () => {
      const c = await corroborateFinding(izzie.repo, PR, residual, "confirm", "whitespace is the common case in imports") as any;
      const d = await corroborateFinding(izzie.repo, PR, fixed, "refute", "the id is in the batch context already") as any;
      assert.equal(c.error, undefined, `corroborate failed: ${c.error}`);
      assert.equal(d.error, undefined, `dispute failed: ${d.error}`);
    });

    // 9 -------------------------------------------------------------------------
    let signedAnchor = "";
    await step("izzie signs off, locally", async () => {
      const t4 = await pr(izzie.repo, String(PR)) as any;
      // `transfer` by name, deliberately: step 11 changes THAT symbol, and signing
      // whichever happened to rank first would let the staleness assertion pass for
      // the wrong reason — or fail for one.
      const item = t4.worklist.find((w: any) => w.symbol.includes("transfer"));
      assert.ok(item, `no transfer in the worklist: ${t4.worklist.map((w: any) => w.symbol).join(", ")}`);
      signedAnchor = item.id;
      const r = await markReviewedBatch(izzie.repo, [signedAnchor], {
        level: "code", actor: "human", attestation: "signed", ref: t4.refs.head,
      });
      assert.equal(r.marked, 1, "the sign-off landed");
      const mark = await anchorMark(izzie.repo, signedAnchor, { ref: t4.refs.head }) as any;
      assert.equal(mark.reviewed, true, "and it reads back as reviewed");
    });

    await settled("izzie responds");

    await step("both sides agree about the findings", async () => {
      const mine = await sharedFindings(izzie.repo, PR) as any;
      const theirs = await sharedFindings(ben.repo, PR) as any;
      const shape = (f: any) => f.findings
        .map((x: any) => `${x.id}:${(x.corroboration ?? []).map((c: any) => c.verdict).sort().join("+")}`)
        .sort().join("|");
      assert.equal(shape(mine), shape(theirs), "the disagreement itself converged");
      const residualNow = theirs.findings.find((x: any) => x.id === residual);
      assert.ok(
        (residualNow.corroboration ?? []).some((c: any) => c.verdict === "confirm"),
        "ben can see that izzie confirmed the one he left",
      );
    });

    // 10 — the walls -------------------------------------------------------------
    await step("WALL: triage does not travel", async () => {
      // Ben triaged `worklist[0]` as business-critical in step 3. Izzie cannot see it,
      // so "residual findings" reach him without the stakes that produced them.
      //
      // INVERTED ON PURPOSE. When triage starts syncing this fails, and the fix is to
      // assert the real thing here — not to delete the test. Owner's call, 2026-08-23:
      // triage IS to be shared; it is a build, not a decision.
      const his = await triageStatus(ben.repo, { kind: "anchor", id: worklist[0]! });
      const hers = await triageStatus(izzie.repo, { kind: "anchor", id: worklist[0]! });
      assert.equal(his.importance, "business-critical", "ben's own triage is where he left it");
      assert.notEqual(
        hers.importance, "business-critical",
        "TRIAGE NOW TRAVELS — good. Replace this wall with the real assertion.",
      );
    });

    await step("WALL: a process doc still cannot be published", async () => {
      // Edges never sync, so a `process`/`step` doc would arrive without its steps and
      // render as an empty flow. That is why the flow-walker — a headline reviewer
      // feature — is single-player. INVERTED: fails when edges start syncing.
      const { notPublishable } = await import("./ops-shared.js");
      assert.ok(
        notPublishable({ type: "process" }),
        "PROCESS DOCS NOW PUBLISH — edges must be syncing. Replace this wall.",
      );
    });

    await step("sign-off stays local, and that is deliberate", async () => {
      // NOT a wall — a decision. GitHub owns sign-off at the pull-request level, so
      // the local mark is izzie's own ledger of review debt: has this been reviewed,
      // how thoroughly, and which findings were accepted or deferred. Sharing it
      // would merge two different acts.
      const his = await anchorMark(ben.repo, signedAnchor) as any;
      assert.equal(his.reviewed, false, "izzie's sign-off is izzie's, and stays on his machine");
    });

    // 11 -------------------------------------------------------------------------
    await step("ben pushes again, and the sign-off stops claiming to cover it", async () => {
      edit(ben, {
        "src/pay.ts": GUARDED.replace(
          "if (!to) throw new Error(\"payee required\");",
          "if (!to?.trim()) throw new Error(\"payee required\");",
        ),
      });
      commit(ben, "reject a whitespace payee — izzie was right");
      pushBranch(ben, BRANCH);
      openPr(ben, PR, { branch: BRANCH });

      const t5 = await pr(izzie.repo, String(PR)) as any;
      const mark = await anchorMark(izzie.repo, signedAnchor, { ref: t5.refs.head }) as any;
      assert.equal(
        mark.reviewed, false,
        "a green check must go stale when the code it covered changes, or 'reviewed' silently lies",
      );

      const w = await sharedWalkthroughs(izzie.repo, PR, t5.refs.head) as any;
      assert.equal(w.current, undefined, "and the walkthrough is no longer about this head");
      assert.equal(w.stale.length, 1, "it is named as stale rather than hidden");
    });

    await settled("the branch moved");
  } finally { t.dispose(); }
});
