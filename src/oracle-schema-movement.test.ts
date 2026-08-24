import { test } from "node:test";
import assert from "node:assert/strict";
import { team, who, edit, commit, settle, type Member } from "./oracle.js";
import { Ledger, checkAlways, checkSettled, verified } from "./oracle-properties.js";
import { document, anchorMark } from "./ops.js";
import { publishLocalDocs, sharedDocs, shareFinding, sharedFindings } from "./ops-shared.js";
import { markReviewedBatch } from "./reviews.js";
import { loadNodes, readAnchorStore } from "./store.js";
import { db } from "./db.js";
import { ANCHOR_SCHEME } from "./schema.js";

/**
 * WORKFLOW 5 — the ground moves under a store that already has work on it.
 *
 * A scheme bump is the only change in this system with a 100% blast radius. Every hash
 * carries `HASH_SCHEME`, so re-hashing moves ALL of them; every id is derived under
 * `ANCHOR_SCHEME`, so a bump repoints ALL of them. The rule, from `CLAUDE.md`, is that
 * a mismatch across schemes means the RULES changed and not the code, so it must read
 * as **cannot tell** and never as drift — this project has already measured the
 * alternative at 985 docs of 985 reading `stale` after a bump nobody's code was in.
 *
 * `scheme-boundary.test.ts` pins that rule on the pure functions and on one local doc.
 * What only a team can show is the half those cannot reach:
 *
 *   - a bump is a fact about ONE MACHINE'S BUILD, so the shared log must be untouched
 *     by it and the team must still converge;
 *   - a TEAMMATE'S doc, which arrives as a claim plus the hashes it was accepted at,
 *     must be judged by the same rule as a local one — a separate path, and one that
 *     has drifted from `evalVersion` before;
 *   - a review mark and a finding are witnessed the same way and must degrade the same
 *     way, or "reviewed" starts lying in a different place than "fresh" does.
 *
 * Both bumps are simulated by moving the STORE back to the pre-bump form rather than by
 * touching a constant: that is what a real store from an older build actually holds, and
 * a test that edited `ANCHOR_SCHEME` would be measuring a build nobody runs.
 */

const ANA = "ana@acme.test";
const BEN = "ben@acme.test";

/**
 * Every stored hash back to its pre-`HASH_SCHEME` form — an unprefixed digest.
 *
 * Exactly what a store written before scheme 2 holds. The code is byte-identical
 * afterwards; only the stamp saying how it was hashed has moved, which is the whole
 * point: anything that reads this as the code having changed is the 985-of-985 bug.
 */
function downgradeHashes(m: Member): number {
  const d = db(m.repo);
  const strip = (h: string) => h.replace(/^h\d+:[0-9a-f]*:/, "").replace(/^h\d+:/, "");
  let moved = 0;

  // `source_scope IS NULL` — this clone's OWN rows only, and the restriction is not
  // tidiness. A fold-owned row's citations come from the log, so rewriting one is a
  // local write reaching a row only the fold may own; the next fold silently undoes it
  // and the damage appears and disappears depending on when you look. The OWNERSHIP
  // property caught exactly that when this function was written without the clause.
  // The realistic story is the restriction anyway: an old build's re-hash moves what
  // that build wrote, never what a teammate published.
  for (const row of d.prepare("SELECT version_id, citations FROM node_versions WHERE source_scope IS NULL")
    .all() as unknown as { version_id: string; citations: string }[]) {
    const cites = (JSON.parse(row.citations || "[]") as { acceptedHashes: string[] }[])
      .map((c) => ({ ...c, acceptedHashes: (c.acceptedHashes ?? []).map(strip) }));
    d.prepare("UPDATE node_versions SET citations = ? WHERE version_id = ?")
      .run(JSON.stringify(cites), row.version_id);
    moved += cites.reduce((n, c) => n + c.acceptedHashes.length, 0);
  }
  return moved;
}

/**
 * The same downgrade for review marks, which live in `meta` rather than in a table.
 *
 * BOTH places, and this is the trap: a review record carries the covered hash twice —
 * once in `witnesses`, which is what drift is judged against, and once in
 * `accepted[].entries[]`, which is what `resolveAcceptance` reads to decide whether the
 * mark is still live. Downgrading only `witnesses` changes nothing a reader can see, and
 * an earlier draft of this test asserted a degradation that had never happened.
 */
async function downgradeWitnesses(m: Member): Promise<number> {
  const { readReviews, writeReviews } = await import("./store.js");
  const strip = (h: string) => h.replace(/^h\d+:[0-9a-f]*:/, "").replace(/^h\d+:/, "");
  const store = await readReviews(m.repo);
  let moved = 0;
  const down = (holder: { bodyHash: string }) => {
    const before = holder.bodyHash;
    holder.bodyHash = strip(before);
    if (holder.bodyHash !== before) moved++;
  };
  for (const r of store.reviews) {
    for (const w of (r as { witnesses?: { bodyHash: string }[] }).witnesses ?? []) down(w);
    for (const a of (r as { accepted?: { entries: { bodyHash: string }[] }[] }).accepted ?? []) {
      for (const e of a.entries ?? []) down(e);
    }
  }
  await writeReviews(m.repo, store.reviews);
  return moved;
}

test("a HASH_SCHEME bump reads as 'cannot tell' across the whole team, not as drift", async () => {
  const t = await team([ANA, BEN]);
  const ledger = new Ledger();
  const step = async (what: string, fn: () => Promise<void>) => {
    await fn();
    try { await checkAlways(t, ledger); }
    catch (e) { throw new Error(`after "${what}": ${(e as Error).message}`); }
  };

  try {
    const ana = who(t, ANA), ben = who(t, BEN);
    let signed = "";

    // 1 — real work of both witnessed kinds, on the current build.
    await step("ana documents; ben signs off and files a finding", async () => {
      const d = await document(ana.repo, {
        id: "n_transfer", type: "concept", title: "Transfer",
        summary: "moves money", anchors: ["src/pay.ts#transfer"],
      }) as { error?: string };
      assert.equal(d.error, undefined, `document failed: ${d.error}`);

      signed = (await readAnchorStore(ben.repo)).anchors
        .find((a) => a.symbolPath.join(".") === "transfer")!.id;
      const r = await markReviewedBatch(ben.repo, [signed], { level: "code", actor: "human", attestation: "signed" });
      assert.equal(r.marked, 1, "the sign-off landed");

      await shareFinding(ben.repo, 5, { targetKind: "anchor", targetId: signed, text: "check the negative case" });
    });

    await settle(t);
    await checkSettled(t, ledger);

    // The CONTROL, and every later assertion rests on it: before the bump both read as
    // verified. Without it, "nothing is stale afterwards" passes on a store in which
    // nothing was ever fresh.
    await step("before the bump, both verify", async () => {
      const mine = (await loadNodes(ana.repo)).find((n) => n.id === "n_transfer");
      assert.equal(mine?.status, "fresh", "ana's own doc is fresh");
      const mark = await anchorMark(ben.repo, signed) as any;
      assert.equal(mark.reviewed, true, "and ben's sign-off is live");
    });

    // 2 — the bump. Nothing about the CODE changes; only the stamp saying how it was
    //     hashed, which is exactly what a store written by an older build holds.
    await step("both stores become what an older build would have written", async () => {
      const docs = downgradeHashes(ana);
      const marks = await downgradeWitnesses(ben);
      assert.ok(docs > 0, "citations were downgraded");
      assert.ok(marks > 0, "and so were review witnesses — otherwise the next step proves nothing");
    });

    await step("a local doc is unverifiable, and specifically not stale", async () => {
      const mine = (await loadNodes(ana.repo)).find((n) => n.id === "n_transfer");
      assert.equal(mine?.status, "unverifiable", "the rules for hashing moved; the code did not");
      assert.notEqual(mine?.status, "stale", "THE 985-OF-985 FAILURE — every doc in the store turning red");
    });

    await step("a sign-off stays LIVE, and records that it could not be verified", async () => {
      // Both halves are deliberate, and the second is what makes the first honest.
      //
      // It stays live because the alternative is the 985-of-985 failure moved into the
      // review surface: the prefix is on every hash, so a bump would turn every mark in
      // every store red at once, for a change nobody's code was in. And it must not read
      // `stale` either — that would send somebody looking for a drift nobody caused.
      //
      // What carries the caveat is `via`, which goes from `direct` to `unverifiable`.
      const mark = await anchorMark(ben.repo, signed) as any;
      assert.equal(mark.reviewed, true, "a scheme bump does not retract everyone's sign-offs");
      assert.equal(mark.review.state, "reviewed");
      assert.equal(mark.review.via, "unverifiable",
        "and the mark says it could not be checked, rather than passing for a direct tick");
      assert.notEqual(mark.review.via, "direct", "which is what it said before the bump");
    });

    // 3 — the teammate's copy. Ana PUBLISHES from the old-build store, so the log
    //     carries her scheme-1 hashes verbatim and ben judges them against his own
    //     scheme-2 index. That is the real shape of the question, and it reaches a
    //     different code path from `evalVersion` — one that has drifted from it before,
    //     with three re-derivations of this verdict disagreeing about `lost` versus
    //     `unverifiable`.
    await step("ana publishes what her old build wrote", async () => {
      await verified(
        "publish", publishLocalDocs(ana.repo),
        async () => ((await sharedDocs(ana.repo) as any).docs ?? []).length === 1,
      );
    });

    await settle(t);
    await checkSettled(t, ledger);

    await step("ben cannot verify it either, and says so in those words", async () => {
      const row = (await sharedDocs(ben.repo) as any).docs.find((r: any) => r.nodeId === "n_transfer");
      assert.ok(row?.resolved, "the doc travelled");
      assert.equal(row.resolved.status, "unverifiable");
      const cite = row.resolved.citations[0];
      assert.equal(cite.unverifiable, true, "the citation cannot be compared, rather than failing to match");
      assert.equal(cite.matches, false);
      assert.equal(cite.present, true, "the symbol is right there — this is not an absence");
      assert.equal(cite.where, "here", "and it is not reported as somebody else's branch either");
    });

    // 4 — the team-level claim, and the reason this is a workflow rather than a unit.
    await step("the LOG is untouched: a scheme is a fact about a build, not about the team", async () => {
      for (const m of t.all) {
        const f = await sharedFindings(m.repo, 5) as any;
        assert.deepEqual(f.findings.map((x: any) => x.text), ["check the negative case"],
          `${m.machine} lost a shared finding to a local re-hash`);
        const docs = (await sharedDocs(m.repo) as any).docs;
        assert.deepEqual(docs.map((r: any) => r.nodeId), ["n_transfer"], `${m.machine} lost a shared doc`);
      }
    });

    await step("and re-witnessing puts it back", async () => {
      // The recovery, which makes `unverifiable` a holding state rather than a dead end
      // — and the CONTROL for the whole file: if the downgrade had broken something
      // instead of moving a stamp, this could not succeed.
      const r = await markReviewedBatch(ben.repo, [signed], { level: "code", actor: "human", attestation: "signed" });
      assert.equal(r.marked, 1);
      const mark = await anchorMark(ben.repo, signed) as any;
      assert.equal(mark.reviewed, true, "re-witnessed against this build, it is live again");
    });
  } finally { t.dispose(); }
});

test("CONTROL: real drift is still drift — the scheme rule must not launder it into silence", async () => {
  // Mutation-checking found this missing, and the shape is worth recording: with
  // `comparableHashes` forced to FALSE the whole test above still passed, because it
  // only ever asserts that things read `unverifiable`. A build where nothing is ever
  // comparable satisfies every one of those assertions and reports no staleness at all
  // — the mirror image of the 985-of-985 bug, and the quieter one.
  //
  // So: same team, same doc, no scheme trickery. Just move the code.
  const t = await team([ANA, BEN]);
  try {
    const ana = who(t, ANA), ben = who(t, BEN);
    await document(ana.repo, {
      id: "n_transfer", type: "concept", title: "Transfer",
      summary: "moves money", anchors: ["src/pay.ts#transfer"],
    });
    const signed = (await readAnchorStore(ana.repo)).anchors
      .find((a) => a.symbolPath.join(".") === "transfer")!.id;
    await markReviewedBatch(ana.repo, [signed], { level: "code", actor: "human", attestation: "signed" });
    assert.equal((await loadNodes(ana.repo)).find((n) => n.id === "n_transfer")?.status, "fresh");
    assert.equal((await anchorMark(ana.repo, signed) as any).review.via, "direct");

    await verified(
      "publish", publishLocalDocs(ana.repo),
      async () => ((await sharedDocs(ana.repo) as any).docs ?? []).length === 1,
    );
    await settle(t);

    // A real edit to the documented symbol, under the SAME hash scheme on both sides.
    edit(ana, {
      "src/pay.ts":
        "export function transfer(amount: number, to: string) {\n"
        + "  if (amount <= 0) throw new Error(\"amount must be positive\");\n"
        + "  if (!to) throw new Error(\"payee required\");\n"
        + "  return { to, amount, at: \"now\" };\n"
        + "}\n\n"
        + "export function refund(amount: number, to: string) {\n"
        + "  return transfer(-amount, to);\n"
        + "}\n",
    });
    commit(ana, "guard the payee");
    // Reindex, because staleness is judged against the LIVE index and nothing else
    // updates it — an edit plus a commit leaves `@work` describing the old bodies, and
    // every hash still matches. A test that skipped this would read `fresh` and look
    // like the scheme rule working when nothing had been compared at all.
    const { init } = await import("./ops.js");
    await init(ana.repo);

    const mine = (await loadNodes(ana.repo)).find((n) => n.id === "n_transfer");
    assert.equal(mine?.status, "stale", "the code really moved, and the doc must say so");
    assert.notEqual(mine?.status, "unverifiable", "calling real drift 'cannot tell' is the quiet failure");

    const mark = await anchorMark(ana.repo, signed) as any;
    assert.equal(mark.reviewed, false, "and the sign-off goes stale, because it genuinely no longer covers this");

    // And the teammate's view of it agrees — a separate path, and the one a reviewer
    // reads when the change was somebody else's.
    const row = (await sharedDocs(ana.repo) as any).docs.find((r: any) => r.nodeId === "n_transfer");
    const cite = row.resolved.citations[0];
    assert.equal(cite.unverifiable, false, "this comparison CAN be made");
    assert.equal(cite.matches, false, "and it fails, which is what drift is");
  } finally { t.dispose(); }
});

test("a snapshot from another ANCHOR_SCHEME reads as NOT CACHED, never as a diff", async () => {
  // The other bump, and the more dangerous one. A snapshot is a SET OF IDS and a diff
  // is a set operation between two of them, so pairing snapshots from two derivations
  // reports every symbol in the repository as removed-and-added. That is not an
  // approximate answer, it is a 100%-wrong one, and it shipped once — 107 phantom
  // "changed" symbols on a real pull request — because the guard sniffed disambiguator
  // SHAPE and so only caught the one change it was written for.
  const t = await team([ANA]);
  try {
    const ana = who(t, ANA);
    const { snapshot } = await import("./ops.js");
    const { readSnapshot } = await import("./store.js");

    edit(ana, { "src/pay.ts": "export function transfer(amount: number) {\n  return amount;\n}\n" });
    const head = commit(ana, "simplify transfer");
    const snap = await snapshot(ana.repo) as any;
    assert.equal(snap.error, undefined, `snapshot failed: ${snap.error}`);

    // CONTROL — under this build's own scheme the snapshot is a cache HIT with real
    // content in it. Without this the assertion below passes on a snapshot that was
    // never usable.
    const cached = await readSnapshot(ana.repo, head);
    assert.ok(cached, "the snapshot this build wrote is readable");
    assert.ok(cached!.length > 0, "and it holds anchors");

    // Now say it was written under a different derivation, which is precisely what the
    // `scheme` column records and the only thing that changes.
    db(ana.repo).prepare("UPDATE snapshots SET scheme = ? WHERE ref = ?").run(ANCHOR_SCHEME + 1, head);
    const foreign = await readSnapshot(ana.repo, head);
    assert.equal(
      foreign, null,
      "a snapshot from another id derivation must read as NOT CACHED — callers already handle that, "
      + "and the alternative is a diff that reports every symbol as removed and re-added",
    );
  } finally { t.dispose(); }
});
