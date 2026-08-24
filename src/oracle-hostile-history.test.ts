import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  team, who, syncOne, settle, rewriteHistory, appendRaw, shardsIn, type Team, type Member,
} from "./oracle.js";
import { Ledger, checkAlways, checkSettled, verified } from "./oracle-properties.js";
import { shareFinding, sharedFindings, sharedHeal, publishLocalDocs, sharedDocs } from "./ops-shared.js";
import { document } from "./ops.js";
import { scopesOnDisk, readScope, readScopeChecked, SIDECAR_PROTOCOL, EVENT_SCHEMA } from "./eventlog.js";

/**
 * WORKFLOW 4 — a hostile history, landing on a team that is working.
 *
 * The sidecar is an ordinary git repository on somebody's disk. Every guarantee the
 * log makes therefore has to survive a person with `git` — a `git rm` that looked like
 * tidying, a badly resolved merge, a hand-edited line, or a teammate on a build from
 * the future. None of those can be produced by the ops, so nothing above the harness's
 * `rewriteHistory` / `appendRaw` can reach them.
 *
 * Each individual refusal already has a unit test (`eventlog.test.ts` for the
 * diagnostics, `sidecar.test.ts` for the restore). What only a whole-universe run can
 * answer is the question those cannot ask: **what is the blast radius?** A refusal
 * that is correct and total is a universe somebody cannot use, and every one of these
 * shapes arrives in ONE scope while the rest of the team's work is in others.
 *
 * So the claim under test throughout is two-sided, and both halves are asserted every
 * time: the bad scope is refused, AND nothing else is.
 */

const ANA = "ana@acme.test";
const BEN = "ben@acme.test";

/** Every scope on a clone with its verdict — the blast radius, in one value. */
async function radius(m: Member): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const scope of await scopesOnDisk(m.sidecar)) {
    const c = await readScopeChecked(m.sidecar, scope);
    out[scope] = c.status === "complete" ? "complete" : `blocked:${c.diagnostic?.reason ?? "?"}`;
  }
  return out;
}

const scopeFor = async (m: Member, endsWith: string): Promise<string> => {
  const s = (await scopesOnDisk(m.sidecar)).find((x) => x.endsWith(endsWith));
  assert.ok(s, `${m.machine} has no scope ending ${endsWith}`);
  return s!;
};

/** A well-formed protocol-1 envelope with whatever the caller wants broken. */
const envelope = (over: Record<string, unknown>) => ({
  kind: "finding.created", subject: "f_hostile",
  actor: { principal: "mallory@acme.test" }, at: "2026-08-24T00:00:00Z",
  writer: "w_hostile", writerPrev: "GENESIS", after: [],
  sidecarProtocol: SIDECAR_PROTOCOL, eventSchema: EVENT_SCHEMA,
  data: { targetKind: "anchor", targetId: "a_x", text: "hand-written" },
  ...over,
});

test("hostile history: each shape is refused in its own scope, and nowhere else", async () => {
  const t = await team([ANA, BEN]);
  const ledger = new Ledger();
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
    const ana = who(t, ANA), ben = who(t, BEN);

    // 0 — a working team across FOUR scopes, so "blast radius" has room to be measured.
    await step("the team has real work in four scopes", async () => {
      await verified(
        "publish a doc",
        document(ana.repo, {
          id: "n_transfer", type: "concept", title: "Transfer",
          summary: "moves money", anchors: ["src/pay.ts#transfer"],
        }).then(() => publishLocalDocs(ana.repo)),
        async () => ((await sharedDocs(ana.repo) as any).docs ?? []).length === 1,
      );
      for (const pr of [21, 22, 23]) {
        await shareFinding(ben.repo, pr, {
          targetKind: "anchor", targetId: `a_${pr}`, text: `honest finding on ${pr}`,
        });
      }
    });
    await settled("the baseline");

    await step("and everything is readable", async () => {
      assert.deepEqual(await radius(ana), await radius(ben), "both clones agree about what is healthy");
      for (const [scope, verdict] of Object.entries(await radius(ana))) {
        assert.equal(verdict, "complete", `${scope} starts clean`);
      }
    });

    // 1 — a `git rm`, pushed with raw git. The one rewrite append-only cannot survive
    //     on its own, and the repair is on the RECEIVING side: the deleter's own sync
    //     has nothing to notice, because from its point of view the deletion is simply
    //     the state of its tree. Somebody pulling it is the only one who can see that
    //     history went backwards.
    //
    //     NOTE the `raw` step: between the `git rm` and somebody pulling it, NO LOSS is
    //     genuinely violated on ana's clone — she really has stopped holding an event
    //     she held. That is not a bug in the property, it is the damage, and the whole
    //     point of the restore is to end it. Checking the invariants mid-damage would
    //     assert that a repair mechanism is never needed.
    let deleted = "";
    const raw = async (what: string, fn: () => Promise<void>) => {
      try { await fn(); } catch (e) { throw new Error(`during "${what}": ${(e as Error).message}`); }
    };
    await raw("somebody tidies up a shard with git rm, and pushes it", async () => {
      const scope = await scopeFor(ana, "pr-23");
      const [shard] = shardsIn(ana, scope);
      assert.ok(shard, "there is a shard to delete");
      deleted = shard!;

      rewriteHistory(ana, "tidy up an old shard", (_paths, sidecar) => {
        const rm = spawnSync("git", ["rm", "-q", "--", shard!], { cwd: sidecar, encoding: "utf8" });
        assert.equal(rm.status, 0, `git rm failed: ${rm.stderr}`);
      });
      const push = spawnSync("git", ["push", "-q", "origin", "HEAD:main"], { cwd: ana.sidecar, encoding: "utf8" });
      assert.equal(push.status, 0, `push failed: ${push.stderr}`);
      assert.deepEqual(shardsIn(ana, scope), [], "the deletion really is on its way to the team");
    });

    await raw("and the teammate who pulls it puts it back", async () => {
      // Still `raw`: ben has repaired it, but ana is the one who deleted it and she
      // does not hold it again until she pulls his restore. The invariants come back
      // at the `settled` below, which is where they are meant to be judged.
      const scope = await scopeFor(ben, "pr-23");
      const r = await syncOne(ben) as any;
      assert.equal(r.error, undefined, `the pull still succeeds — refusing would wedge it forever: ${r.error}`);
      assert.equal(r.restored?.length, 1, "and it reports what it put back");
      assert.equal(r.restored[0].path, deleted);
      assert.deepEqual(shardsIn(ben, scope), [deleted], "the shard is on disk again");
    });

    await settled("the deletion");

    await step("the deletion did not travel", async () => {
      // RESTORED, NOT PROPAGATED. A merge that took the deletion cleanly is the silent
      // failure here: every clone converges, every property passes, and the finding is
      // simply gone from the team. NO LOSS in `checkSettled` is watching too, but this
      // says it at the surface a person reads.
      for (const m of t.all) {
        const f = await sharedFindings(m.repo, 23) as any;
        assert.deepEqual(f.findings.map((x: any) => x.text), ["honest finding on 23"],
          `${m.machine} lost the finding to somebody else's git rm`);
      }
    });

    // 2 — an event from a build that does not exist yet.
    await step("a teammate on a newer codemap writes into pr-21", async () => {
      const scope = await scopeFor(ana, "pr-21");
      appendRaw(ana, join(scope, "w_future.ndjson"), envelope({
        id: "9999999999-future", writer: "w_future",
        sidecarProtocol: SIDECAR_PROTOCOL + 1, eventSchema: EVENT_SCHEMA + 1,
      }));
      rewriteHistory(ana, "an event from a newer protocol", () => {});

      const r = await syncOne(ana) as any;
      // The sync SUCCEEDS and reports it. A scope this build cannot fully read is not
      // a reason to refuse to sync — the events still have to reach everybody, and the
      // moment of a sync is the moment a person is watching.
      assert.equal(r.error, undefined, `the sync itself is not refused: ${r.error}`);
      assert.deepEqual(r.materialized.blocked.map((b: any) => b.scope), [scope]);
      assert.match(r.materialized.blocked[0].reason, /Upgrade to read this scope/);
    });

    await settled("the future event");

    await step("pr-21 is blocked for everyone, and only pr-21", async () => {
      const scope = await scopeFor(ana, "pr-21");
      for (const m of t.all) {
        const seen = await radius(m);
        assert.equal(seen[scope], "blocked:protocol", `${m.machine} must refuse a scope it cannot fully read`);
        for (const [other, verdict] of Object.entries(seen)) {
          if (other !== scope) assert.equal(verdict, "complete", `${m.machine}: ${other} is collateral damage`);
        }
      }
    });

    await step("a blocked scope answers, and says it is not authoritative", async () => {
      // It serves everything it can PARSE — the future event included, because a
      // protocol-1 reader can read a protocol-2 envelope's fields, it just cannot know
      // which ones it is missing. What it must never do is serve that silently, and
      // the diagnostic riding along is what makes it honest: `web/shared.js` renders it
      // as a "not authoritative" banner on all three shared pages.
      //
      // Both halves are asserted because both can rot independently. Serving nothing
      // would turn one bad line into a data-loss event; serving the content without the
      // diagnostic would be a partial answer presented as a whole one.
      const f = await sharedFindings(ana.repo, 21) as any;
      assert.deepEqual(
        f.findings.map((x: any) => x.text).sort(), ["hand-written", "honest finding on 21"],
        "the readable events are all served, this build's and the newer one's alike",
      );
      assert.equal(f.scope.status, "blocked");
      assert.equal(f.scope.diagnostic.reason, "protocol");
      assert.deepEqual(f.scope.diagnostic.evidence, ["9999999999-future"], "and it names the line");
    });

    await step("and no person may acknowledge their way out of it", async () => {
      // Every other blocking shape clears when a person says they have looked. This one
      // cannot: clearing it would be agreeing to read data this build cannot interpret,
      // and the only exit is an upgrade.
      const scope = await scopeFor(ana, "pr-21");
      const r = await sharedHeal(ana.repo) as any;
      assert.equal(r.error, undefined, `heal itself did not fail: ${r.error}`);
      assert.deepEqual(r.acknowledged, [], "nothing was acknowledged");
      assert.deepEqual(r.blocked.map((b: any) => b.scope), [scope], "it is reported as still blocked");
      assert.equal((await radius(ana))[scope], "blocked:protocol", "and it still is");
    });

    // 3 — a chain that loops. No append can produce it; a hand-edit can.
    await step("a hand-edited shard gives pr-22 a writerPrev cycle", async () => {
      const scope = await scopeFor(ana, "pr-22");
      const shard = join(scope, "w_cycle.ndjson");
      appendRaw(ana, shard, envelope({ id: "8888888881-c1", writer: "w_cycle", writerPrev: "8888888882-c2" }));
      appendRaw(ana, shard, envelope({ id: "8888888882-c2", writer: "w_cycle", writerPrev: "8888888881-c1" }));
      rewriteHistory(ana, "a writerPrev cycle", () => {});
    });

    await settled("the cycle");

    await step("the cycle blocks pr-22, and the events stay readable", async () => {
      const cycled = await scopeFor(ana, "pr-22");
      const future = await scopeFor(ana, "pr-21");
      for (const m of t.all) {
        const seen = await radius(m);
        assert.equal(seen[cycled], "blocked:chain-cycle");
        assert.equal(seen[future], "blocked:protocol", "the earlier one is still what it was");
        for (const [other, verdict] of Object.entries(seen)) {
          if (other !== cycled && other !== future) {
            assert.equal(verdict, "complete", `${m.machine}: ${other} is collateral damage`);
          }
        }
      }

      // "The events are readable; their causal position is not" — the diagnostic's own
      // words, and a claim worth holding it to. A log that refuses to load is worse
      // than one that cannot order itself.
      const events = await readScope(ana.sidecar, cycled);
      const ids = events.map((e) => e.id);
      assert.ok(ids.includes("8888888881-c1") && ids.includes("8888888882-c2"), "both cyclic events are still there");
      const f = await sharedFindings(ana.repo, 22) as any;
      assert.ok(f.findings.some((x: any) => x.text === "honest finding on 22"), "and the honest one is still served");
    });

    // 4 — the shape that must NOT block: a line this build cannot even parse as an
    //     event. Anything else and one corrupt byte from anybody wedges a scope for
    //     the whole team, which is a denial of service built out of a safety check.
    await step("a malformed line is dropped, and does not wedge the scope", async () => {
      const scope = await scopeFor(ana, "pr-23");
      const before = (await readScope(ana.sidecar, scope)).length;
      appendRaw(ana, join(scope, "w_junk.ndjson"), envelope({
        id: "7777777777-junk", writer: "w_junk", sidecarProtocol: undefined, eventSchema: undefined,
      }) as any);
      // …and something that is not JSON at all, which is what a half-written append or
      // a botched merge actually leaves behind.
      appendRaw(ana, join(scope, "w_junk.ndjson"), {} as any);
      rewriteHistory(ana, "a malformed line and a meaningless one", (_p, sidecar) => {
        const path = join(sidecar, scope, "w_junk.ndjson");
        spawnSync("sh", ["-c", `printf '{"id":"nope"\\n' >> ${JSON.stringify(path)}`]);
      });

      const r = await syncOne(ana) as any;
      assert.equal(r.error, undefined, `a junk line must not fail a sync: ${r.error}`);
      assert.equal((await radius(ana))[scope], "complete", "nor block the scope");
      assert.equal((await readScope(ana.sidecar, scope)).length, before,
        "the unreadable lines are skipped rather than folded — an envelope missing its "
        + "protocol numbers is not an event, and neither is a truncated line");
    });

    await settled("the junk");

    // 5 — the point of all of it.
    await step("with two scopes blocked the team still works", async () => {
      await verified(
        "a new doc, after all that",
        document(ben.repo, {
          id: "n_ledger", type: "concept", title: "Ledger",
          summary: "records what moved", anchors: ["src/ledger.ts#Ledger"],
        }).then(() => publishLocalDocs(ben.repo)),
        async () => ((await sharedDocs(ben.repo) as any).docs ?? []).some((d: any) => d.nodeId === "n_ledger"),
      );
      // A brand-new scope, opened after the damage, is unaffected by any of it.
      await shareFinding(ana.repo, 24, { targetKind: "anchor", targetId: "a_24", text: "life goes on" });
    });

    await settled("carrying on");

    await step("and the new work reached everybody", async () => {
      for (const m of t.all) {
        const docs = (await sharedDocs(m.repo) as any).docs.map((d: any) => d.nodeId).sort();
        assert.deepEqual(docs, ["n_ledger", "n_transfer"], `${m.machine} is missing a doc`);
        const f = await sharedFindings(m.repo, 24) as any;
        assert.deepEqual(f.findings.map((x: any) => x.text), ["life goes on"]);
        assert.equal(f.scope, undefined, "a scope opened after the damage carries none of it");
      }
    });
  } finally { t.dispose(); }
});
