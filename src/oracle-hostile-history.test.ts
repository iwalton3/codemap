import { LockedOut } from "./lockout.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
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

    // (A `git rm` pushed with raw git was shape 1 here. It is tampering with the git repository,
    // which the owner ruled out of scope, and a linear pull takes the tip as it is — there is no
    // erasure restore to test. docs/PROPOSAL-online-only-sync.md.)

    /** A step the invariants are not judged after — damage in progress, or a clone locked by it. */
    const raw = async (what: string, fn: () => Promise<void>) => {
      try { await fn(); } catch (e) { throw new Error(`during "${what}": ${(e as Error).message}`); }
    };

    /** What a build without codemap's gates does: commit whatever is on disk and push it with git. */
    const pushRaw = (m: typeof ana, message: string, mutate: (paths: string[], sidecar: string) => void = () => {}) => {
      rewriteHistory(m, message, mutate);
      const push = spawnSync("git", ["push", "-q", "origin", "HEAD:main"], { cwd: m.sidecar, encoding: "utf8" });
      assert.equal(push.status, 0, `push failed: ${push.stderr}`);
    };

    // 2 — an event from a build that does not exist yet.
    await step("a teammate on a newer codemap writes into pr-21", async () => {
      const scope = await scopeFor(ana, "pr-21");
      appendRaw(ana, join(scope, "w_future.ndjson"), envelope({
        id: "9999999999-future", writer: "w_future",
        sidecarProtocol: SIDECAR_PROTOCOL + 1, eventSchema: EVENT_SCHEMA + 1,
      }));
      pushRaw(ana, "an event from a newer protocol");

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
      pushRaw(ana, "a writerPrev cycle");
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

    // 4 — an event this build cannot INTERPRET is dropped and must not block. That is
    //     what keeps a version skew from wedging a scope for the whole team, which
    //     would be a denial of service built out of a safety check.
    await step("a malformed event is dropped, and does not wedge the scope", async () => {
      const scope = await scopeFor(ana, "pr-23");
      const before = (await readScope(ana.sidecar, scope)).length;
      appendRaw(ana, join(scope, "w_junk.ndjson"), envelope({
        id: "7777777777-junk", writer: "w_junk", sidecarProtocol: undefined, eventSchema: undefined,
      }) as any);
      appendRaw(ana, join(scope, "w_junk.ndjson"), {} as any);
      pushRaw(ana, "a malformed line and a meaningless one");

      const r = await syncOne(ana) as any;
      assert.equal(r.error, undefined, `a junk line must not fail a sync: ${r.error}`);
      assert.equal((await radius(ana))[scope], "complete", "nor block the scope");
      assert.equal((await readScope(ana.sidecar, scope)).length, before,
        "the unreadable lines are skipped rather than folded — an envelope missing its "
        + "protocol numbers is not an event, and neither is a meaningless object");
    });

    // 4b — a line that is not JSON at all is a DIFFERENT thing, and the distinction is
    //      the one this file used to get wrong. The two above PARSE: they are records
    //      this build declines to interpret, and dropping them loses nothing that was
    //      not already unreadable everywhere. Bytes that are not JSON are events that
    //      have been DESTROYED, and skipping those quietly is how a wholly-corrupt shard
    //      read as an empty scope with `status: "complete"` — the team's findings gone,
    //      and every surface agreeing the queue was clear.
    await step("a line that is not JSON blocks its own scope, and only its own", async () => {
      const scope = await scopeFor(ana, "pr-23");
      const before = (await readScope(ana.sidecar, scope)).length;
      rewriteHistory(ana, "a truncated line", (_p, sidecar) => {
        const path = join(sidecar, scope, "w_junk.ndjson");
        spawnSync("sh", ["-c", `printf '{"id":"nope"\\n' >> ${JSON.stringify(path)}`]);
      });

      const seen = await radius(ana);
      assert.equal(seen[scope], "blocked:corrupt-shard");
      const future = await scopeFor(ana, "pr-21"), cycled = await scopeFor(ana, "pr-22");
      for (const [other, verdict] of Object.entries(seen)) {
        if (other !== scope && other !== future && other !== cycled) {
          assert.equal(verdict, "complete", `${other} is collateral damage`);
        }
      }
      // Still readable, like every other blocked scope: what `blocked` forbids is
      // presenting it as settled.
      assert.equal((await readScope(ana.sidecar, scope)).length, before);
    });

    // 4c — and it STOPS rather than spreading. This is the half a per-scope verdict
    //      cannot deliver: a blocked scope is a diagnosis on the clone that already has
    //      the bytes, and the point of the transport gate is that one more clone never
    //      gets them.
    // `raw`, not `step`: both clones are LOCKED at the end of it, and every read the invariants
    // make refuses — which is the lockout working, not an invariant failing.
    await raw("a damaged sidecar stops the pull instead of being merged into one more clone", async () => {
      // Ana's clone holds the bytes, so it is LOCKED (plan 1.2: damage anywhere this machine
      // can see), and a locked sync publishes nothing. Only plain git gets them out — a
      // person, or a build with no such gate — which is what the pull gate is for.
      const pushed = await syncOne(ana) as { error?: string };
      assert.match(pushed.error ?? "", /codemap is locked/, "a clone holding damage does not publish it");
      assert.equal(spawnSync("git", ["push", "-q", "origin", "HEAD:main"], { cwd: ana.sidecar }).status, 0);

      const blocked = await syncOne(ben) as { error?: string };
      assert.match(blocked.error ?? "", /refusing to take the remote tip/, "ben's pull refuses the damaged bytes");
      assert.match(blocked.error ?? "", /w_junk\.ndjson:/, "and names the line, so it can be repaired where it was written");

      // The promise the refusal makes, and the reason it is worth the collateral: ben's
      // clone never took the bytes, so the scope is healthy on his machine and his own
      // work is untouched.
      assert.equal((await radius(ben))[await scopeFor(ben, "pr-23")], "complete");
      // And the pull it refused locks ben too: damage this machine can see (owner, batch 8).
      await assert.rejects(sharedFindings(ben.repo, 23), LockedOut);
    });

    await step("and the repair, made where the shard was written, lets the team continue", async () => {
      const scope = await scopeFor(ana, "pr-23");
      // A repair is a commit pushed with git (docs/log-repair.md): a sync moves the tree to the
      // remote tip, which still holds the damage, and refuses a hand edit rather than discard it.
      pushRaw(ana, "delete the damaged line", (_p, sidecar) => {
        const path = join(sidecar, scope, "w_junk.ndjson");
        const kept = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() && l !== '{"id":"nope"');
        writeFileSync(path, kept.join("\n") + "\n");
      });
      assert.equal((await radius(ana))[scope], "complete",
        "a shard is append-only, so deleting the line is the whole repair");
      // A locked sync re-checks here and on the fetched tip, and clears once neither is damaged:
      // ana's publishes the repair, then ben's takes it — no re-clone (docs/log-repair.md).
      for (const m of [ana, ben]) {
        const r = await syncOne(m) as { error?: string };
        assert.equal(r.error, undefined, `${m.machine}: ${r.error}`);
      }

    });

    await settled("the repair");

    // 5 — newer data on the remote blocks every push until an upgrade re-folds it; reads carry
    //     on (owner, batch 1: "in the mean time all pushes get blocked. Reads would still be
    //     allowed"). pr-21 still holds an event from a newer protocol.
    await step("with a newer event on the remote, a write is refused and says why; reads carry on", async () => {
      const w = await shareFinding(ana.repo, 24, { targetKind: "anchor", targetId: "a_24", text: "life goes on" })
        .catch((e: unknown) => ({ error: String((e as Error)?.message ?? e) })) as { error?: string };
      assert.match(w.error ?? "", /newer than it[\s\S]*upgraded/, "the write is refused until an upgrade");
      for (const m of t.all) {
        const docs = (await sharedDocs(m.repo) as any).docs.map((d: any) => d.nodeId);
        assert.deepEqual(docs, ["n_transfer"], `${m.machine} still reads the team's docs`);
        const f = await sharedFindings(m.repo, 22) as any;
        assert.ok(f.findings.some((x: any) => x.text === "honest finding on 22"), "and its findings");
      }
    });
  } finally { t.dispose(); }
});
