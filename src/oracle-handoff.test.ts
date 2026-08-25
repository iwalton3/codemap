import { test } from "node:test";
import assert from "node:assert/strict";
import { team, who, edit, commit, branch, pushBranch, openPr, settle, type Team, type Member } from "./oracle.js";
import { Ledger, checkAlways, checkSettled, verified } from "./oracle-properties.js";
import { pr, prWalkthroughSet, prWalkthroughGet, prStoryFor, setTriage, anchorMark, document } from "./ops.js";
import {
  shareFinding, sharedFindings, corroborateFinding, reportOnFinding,
  shareWalkthrough, sharedWalkthroughs, sharedTriage, contestedTriage, publishLocalTriage,
} from "./ops-shared.js";
import { markReviewedBatch } from "./reviews.js";
import { triageStatus, deriveTriage, clearTriage } from "./triage.js";
import { readLocalTriage } from "./store.js";

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

    // 5b ------------------------------------------------------------------------
    await step("the submitter pushes, and ben RE-walks — the ordinary next step", async () => {
      // walk -> publish -> re-walk is the whole lifecycle, and the third step used to
      // fail: publishing makes the row the fold's, and the local writer could neither
      // delete it (wrong source_scope) nor insert beside it (unique index), so it
      // surfaced a raw SQLite constraint error while the read-back kept answering with
      // the old reading. Re-walking is not an edge case — it is what a pushed commit
      // asks for, which is exactly when a walkthrough most needs replacing.
      edit(ben, { "src/pay.ts": GUARDED.replace("payee required", "payee required (checked)") });
      commit(ben, "tighten the payee message");
      pushBranch(ben, BRANCH);
      openPr(ben, PR, { branch: BRANCH });

      const t = await pr(ben.repo, String(PR)) as any;
      const ids: string[] = t.worklist.map((w: any) => w.id);
      const again = await prWalkthroughSet(ben.repo, String(PR), [{
        title: "Payee and amount validation",
        summary: "re-walked after the push",
        chapters: [{
          title: "The guards",
          blocks: [
            { kind: "prose", text: "the message changed; the guard did not." },
            ...ids.map((id) => ({ kind: "symbol" as const, anchorId: id })),
          ],
        }],
      }], { by: "ben's agent" }) as any;
      assert.equal(again.error, undefined, `re-walk rejected: ${JSON.stringify(again)}`);
      assert.equal(again.republished, true, "the reading was already published, so re-walking it published again");

      const stored = await prWalkthroughGet(ben.repo, String(PR)) as any;
      assert.equal(stored.walkthrough.features[0].summary, "re-walked after the push",
        "and the read-back is the NEW reading — the old failure rolled back silently");
      assert.equal(stored.sharedBy, undefined, "still his own");

      // ONE CHAPTER, not the whole document. The model has always been per-chapter —
      // ids from titles, witnesses per chapter, `stale` naming them one at a time — and
      // only the write verb was per-document, so changing eight of twenty-six meant
      // resending all twenty-six reconstructed byte-for-byte.
      const { prWalkthroughChapter } = await import("./ops.js");
      const one = await prWalkthroughChapter(ben.repo, String(PR), {
        feature: "Payee and amount validation", title: "The guards",
        blocks: [
          { kind: "prose", text: "sharpened after the push, without resending the rest" },
          ...ids.map((id) => ({ kind: "symbol" as const, anchorId: id })),
        ],
      }, { by: "ben's agent" }) as any;
      assert.equal(one.error, undefined, `chapter write refused: ${JSON.stringify(one)}`);
      assert.equal(one.added, false, "it replaced the chapter rather than appending a second");

      const after = await prWalkthroughGet(ben.repo, String(PR)) as any;
      const ch = after.walkthrough.features[0].chapters[0];
      assert.match(ch.blocks[0].text, /without resending the rest/);
      assert.equal(after.walkthrough.features[0].chapters.length, 1);
      // The document rules still hold across the substitution — coverage is checked over
      // the stored chapters with this one swapped in, not over this one alone.
      assert.deepEqual(after.stale, [], "and the chapter is re-witnessed at this head");

      // What the READ returns is what the WRITE takes. The natural loop is get, edit,
      // put, and it failed on the `id`/`witnesses` the read adds and the write refused.
      const roundTrip = await prWalkthroughSet(ben.repo, String(PR), after.walkthrough.features, { by: "ben's agent" }) as any;
      assert.equal(roundTrip.error, undefined, `round trip refused: ${JSON.stringify(roundTrip)}`);
    });

    // 6, 7 ----------------------------------------------------------------------
    await settled("ben hands off");

    await step("izzie receives a walkthrough and the residual findings", async () => {
      const t3 = await pr(izzie.repo, String(PR)) as any;
      assert.equal(t3.error, undefined, `izzie could not open the PR: ${t3.error}`);

      const w = await sharedWalkthroughs(izzie.repo, PR, t3.refs.head) as any;
      assert.equal(w.count, 1, "ben's walkthrough travelled — ONE reading, re-walked, not two");
      assert.equal(w.current?.by, MATE, "and it is attributed to him");
      assert.equal(w.current?.walkthrough.features.length, 1);

      // ...and it is on the surfaces she actually opens. `sharedWalkthroughs` above is
      // the dedicated view; these two are the pull-request page and the walkthrough
      // tool, and they read the local blob only until the bridge in `walkthroughFor`.
      // The gap was invisible from here for exactly that reason — the transport was
      // asserted and the surface was not.
      const hers = await prWalkthroughGet(izzie.repo, String(PR)) as any;
      assert.ok(hers.walkthrough, "ben's walkthrough is what `pr_walkthrough_get` answers with");
      assert.equal(hers.sharedBy, MATE, "and it is attributed to him, not presented as her own");
      assert.equal(hers.headMoved, false);

      const story = await prStoryFor(izzie.repo, String(PR)) as any;
      assert.ok(story.walkthrough, "the pull-request page renders it rather than `no agent has walked this one`");
      assert.equal(story.walkthrough.sharedBy, MATE);
      // `by` is the free-text author `pr_walkthrough` was called with, and it is NOT
      // the attribution — one field meaning both is how a surface reports your own
      // walkthrough as somebody else's.
      assert.equal(story.walkthrough.by, "ben's agent");
      assert.equal(story.walkthrough.features[0].summary, "re-walked after the push",
        "and it is the re-walk she gets, not the reading the push invalidated");

      const his = await prStoryFor(ben.repo, String(PR)) as any;
      assert.equal(his.walkthrough.sharedBy, undefined, "his own reading is not labelled as somebody else's");

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
    await step("triage travels: izzie inherits the stakes ben's agent set", async () => {
      // This was a WALL until the fold landed. It was the gap that mattered most: the
      // hand-off transferred findings without the stakes used to rank them, so izzie
      // got a residual finding with no idea it sat on a business-critical path.
      const his = await triageStatus(ben.repo, { kind: "anchor", id: worklist[0]! });
      const hers = await triageStatus(izzie.repo, { kind: "anchor", id: worklist[0]! });
      assert.equal(his.importance, "business-critical", "ben's own triage is where he left it");
      assert.equal(hers.importance, "business-critical", "and it reached izzie");
      assert.equal(hers.complexity, "standard", "with the other axis, which decides the review BAR");
      assert.equal(hers.likely, true, "still an agent's proposal on her side — travelling is not confirming");

      // THE RECEIPTS, which are the half a bare value cannot carry. Izzie has to be
      // able to see it was ben's agent that said so, and why.
      const shared = await sharedTriage(izzie.repo, "anchor", worklist[0]!) as any;
      assert.equal(shared.error, undefined, `shared triage failed: ${shared.error}`);
      assert.equal(shared.count, 1);
      assert.equal(shared.marks[0].importance.by, MATE, "attributed to ben, not to whoever pulled");
      assert.equal(shared.marks[0].importance.reason, "money moves through here");
      assert.equal(shared.marks[0].importance.contested, undefined, "nobody has disagreed");
    });

    await step("and izzie can lower it, because she has now SEEN it", async () => {
      // The rule that makes the whole merge tractable: causally-seen supersedes. It is
      // a decision, not a conflict, and it does not go anywhere near the review queue.
      const r = await setTriage(izzie.repo, {
        targetKind: "anchor", targetId: worklist[0]!,
        importance: "important", source: "human", reason: "guarded now",
      }) as any;
      assert.equal(r.error, undefined, `izzie could not re-triage: ${r.error}`);
      assert.equal(r.shared, true, "her mark went to the log, not to a local row the team cannot see");

      const hers = await triageStatus(izzie.repo, { kind: "anchor", id: worklist[0]! });
      assert.equal(hers.importance, "important");
      assert.equal(hers.likely, false, "a human set it, so it is no longer a proposal");
      const contested = await contestedTriage(izzie.repo) as any;
      assert.equal(contested.count, 0, "a decision made having seen the other side is not a contest");
    });

    await step("graph-derived stakes stay local, beside the shared ones", async () => {
      // The coexistence case, and the one that makes OWNERSHIP mean something here:
      // until now every mark izzie made went to the log, so the local partition was
      // empty and no local write could reach a fold-owned row even if it tried.
      // `deriveTriage` is the path that fills it — graph output is regenerated per
      // machine and never travels, which is exactly why it is written locally.
      const before = (await sharedTriage(izzie.repo, "anchor", worklist[0]!) as any).count;
      // A doc first, because the derive works off NODES — with none, it marks nothing
      // and this step would pass over an empty local partition, proving nothing.
      const doc = await document(izzie.repo, {
        id: "n_payments", type: "concept", title: "Payments",
        summary: "moves money between accounts", anchors: ["src/pay.ts#transfer"],
      }) as any;
      assert.equal(doc.error, undefined, `document failed: ${doc.error}`);
      const r = await deriveTriage(izzie.repo) as any;
      assert.equal(r.error, undefined, `derive failed: ${r.error}`);
      assert.ok(r.derived > 0, "the derive marked something — otherwise the assertions below are over nothing");
      const localRows = (await readLocalTriage(izzie.repo)).triage;
      assert.ok(localRows.length > 0, "the derive produced local rows — otherwise this step proves nothing");
      assert.ok(localRows.every((t) => t.source === "graph"), "and only graph ones: the rest are events now");
      assert.equal(
        (await sharedTriage(izzie.repo, "anchor", worklist[0]!) as any).count, before,
        "a whole-list local rewrite did not disturb the fold's partition",
      );
    });

    await step("clearing a local mark leaves the fold's partition alone", async () => {
      // `clearTriage` filters a list and writes it back — done against the MERGED view
      // it would delete a teammate's row and clone every other one into the local
      // partition, in one call.
      //
      // What this step CAN see, said plainly because the difference decides where the
      // real guard lives: a clear appends an event, so the fingerprint moves and the
      // next read re-folds — a local write that flattened the shared rows would be
      // repaired before anything here looked. The permanent case is a local rewrite
      // with no event behind it, where the cache is a HIT and nothing ever re-folds;
      // that is `triage-store.test.ts`, which plants a fold-owned row and calls the
      // local writers directly. Both mutations of the seam fail it.
      const before = (await sharedTriage(izzie.repo) as any).count;
      assert.ok(before > 0, "there are fold-owned rows to disturb");
      const r = await clearTriage(izzie.repo, { targetKind: "node", targetId: "n_payments" }) as any;
      assert.equal(r.removed, 1, "her own derived mark went");
      assert.equal((await sharedTriage(izzie.repo) as any).count, before, "and the team's marks did not");
    });

    await step("publishing local marks skips the graph ones, and says so", async () => {
      // What the owner runs to get an existing store's marks onto a new sidecar. The
      // graph rows must NOT go: they are regenerated on every machine, and a silent
      // narrowing reads from the other side exactly like a mark that did travel.
      const dry = await publishLocalTriage(izzie.repo, { dryRun: true }) as any;
      assert.equal(dry.error, undefined, `publish failed: ${dry.error}`);
      assert.equal(dry.wouldPublish, 0, "everything she asserted is already an event");
      assert.ok(dry.skippedGraph > 0, "and the graph rows are counted rather than quietly dropped");
    });

    await step("a flow travels now — the last wall is gone", async () => {
      // INVERTED until edges synced. A `process` doc used to be refused outright,
      // because its steps are `step_of` edges and edges never travelled, so the shared
      // copy rendered as an empty flow on every teammate's machine — which is why the
      // flow-walker, a headline reviewer feature, was single-player.
      //
      // A flow is a node with forced cardinality, so syncing the graph was the whole
      // fix. See `shared-graph.ts`.
      const { notPublishable } = await import("./ops-shared.js");
      assert.equal(notPublishable({ type: "process" }), null, "a flow is publishable");
      assert.equal(notPublishable({ type: "step" }), null, "and so are its steps");
      assert.ok(
        notPublishable({ type: "concept", generatedBy: "marten" }),
        "but analyzer output still is not — every clone regenerates it, so a copy is one nobody can refresh",
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
