import { test } from "node:test";
import assert from "node:assert/strict";
import { team, who, syncOne, settle, publishManifestAs, type Member } from "./oracle.js";
import { Ledger, checkAlways, checkSettled } from "./oracle-properties.js";
import { shareFinding, sharedFindings, sharedStatus, publishLocalDocs, sharedDocs } from "./ops-shared.js";
import { document } from "./ops.js";
import { ANCHOR_SCHEME, HASH_SCHEME } from "./schema.js";
import { GRAMMAR_VERSIONS } from "./grammar-versions.js";

/**
 * WORKFLOW 6 — two people, two builds.
 *
 * The manifest is the only thing on the sidecar that describes a BUILD rather than a
 * fact, and it exists for one reason: an anchor id derived under a different
 * `ANCHOR_SCHEME` names a different symbol, so a teammate's findings would land on code
 * that is not the code they meant. Merging that is worse than refusing it, because
 * every mis-targeted finding still looks like a finding.
 *
 * The asymmetry is the whole design and is asserted in both directions:
 *
 *   - **`ANCHOR_SCHEME` differing is FATAL.** Ids mean different things, so nothing may
 *     cross. It gates the pull AND the push — being the one who is behind is no safer
 *     than being the one who is ahead.
 *   - **`HASH_SCHEME` differing is ADVISORY.** Ids still agree, so the events are
 *     meaningful; only the witnesses cannot be compared, which reads as `unverifiable`
 *     and is what `oracle-schema-movement.test.ts` is about. Refusing here would stop a
 *     team working over a difference that costs them nothing but a re-witness.
 *   - **A grammar version differing is ADVISORY** for the same reason: bodies hash
 *     differently, ids do not move.
 *
 * And the recovery: nothing is lost while a clone is gated out. The events wait, and
 * the moment the builds agree they all arrive.
 */

const ANA = "ana@acme.test";
const BEN = "ben@acme.test";
/** On a newer codemap and never syncing in these tests — so their manifest stays put. */
const CAROL = "carol@acme.test";

const current = { anchorScheme: ANCHOR_SCHEME, hashScheme: HASH_SCHEME, grammars: { ...GRAMMAR_VERSIONS } };

const peerWarning = async (m: Member) => await sharedStatus(m.repo) as
  { warning?: string; blocked?: string; peers: { principal: string }[] };

test("a peer on a newer ANCHOR_SCHEME stops the sync, in both directions", async () => {
  const t = await team([ANA, BEN]);
  const ledger = new Ledger();
  try {
    const ana = who(t, ANA), ben = who(t, BEN);

    await document(ana.repo, {
      id: "n_transfer", type: "concept", title: "Transfer", summary: "moves money",
      anchors: ["src/pay.ts#transfer"],
    });
    await publishLocalDocs(ana.repo);
    await shareFinding(ben.repo, 6, { targetKind: "anchor", targetId: "a_1", text: "before the skew" });
    await settle(t);
    await checkSettled(t, ledger);

    // CONTROL — the team works, and `peers` says nothing. Every refusal below is only
    // meaningful against a baseline that was not already refusing.
    const before = await peerWarning(ana);
    assert.equal(before.blocked, undefined, "nothing is blocked to begin with");
    assert.equal(before.warning, undefined, "and nothing is even advisory");

    // Carol upgrades. Ben publishes her manifest because a clone rewrites its own on
    // every sync and so cannot misrepresent its own build.
    publishManifestAs(ben, CAROL, { ...current, anchorScheme: ANCHOR_SCHEME + 1 });

    await test("the pull is refused, and says why in terms of what would go wrong", async () => {
      const r = await syncOne(ana) as { error?: string };
      assert.ok(r.error, "a sync into a log written under another id derivation is refused");
      assert.match(r.error!, new RegExp(String(ANCHOR_SCHEME + 1)), "it names their scheme");
      assert.match(r.error!, new RegExp(`codemap is ${ANCHOR_SCHEME}`), "and this one");
      assert.match(r.error!, /point at symbols that do not exist here/, "and what merging would actually do");
    });

    await test("and the push is refused too — being behind is not safer than being ahead", async () => {
      // The direction people get wrong. A clone that is BEHIND still writes events, and
      // those events carry ids the upgraded reader cannot place. Gating only the pull
      // would let the stale machine keep poisoning the log it refuses to read.
      await shareFinding(ana.repo, 6, { targetKind: "anchor", targetId: "a_2", text: "written while gated" });
      const r = await syncOne(ana) as { error?: string };
      assert.ok(r.error, "the write is held rather than pushed");
    });

    await test("nothing is lost while a clone is gated out", async () => {
      // The refusal has to be a HOLD, not a drop. The finding written during the skew
      // is still readable locally, and `NO LOSS` is watching the log itself.
      const mine = await sharedFindings(ana.repo, 6) as any;
      assert.ok(
        mine.findings.some((f: any) => f.text === "written while gated"),
        "the write made during the skew is still here",
      );
      await checkAlways(t, ledger);
    });

    await test("and when the builds agree again, everything arrives", async () => {
      // Carol's machine is downgraded — or, as it really happens, everyone else
      // upgrades. Either way the manifests agree and the gate opens.
      publishManifestAs(ben, CAROL, current);
      await settle(t);
      await checkSettled(t, ledger);

      for (const m of t.all) {
        const f = await sharedFindings(m.repo, 6) as any;
        assert.deepEqual(
          f.findings.map((x: any) => x.text).sort(), ["before the skew", "written while gated"],
          `${m.machine} is missing a write that was held during the skew`,
        );
      }
      const after = await peerWarning(ana);
      assert.equal(after.blocked, undefined, "and nothing is blocked any more");
    });
  } finally { t.dispose(); }
});

test("my own machine being ahead is fatal; my own machine being behind is the upgrade path", async () => {
  // The two directions of one's OWN manifest, which is not automatically "me": one
  // person on two machines writes one manifest file from both.
  const t = await team([ANA, BEN]);
  try {
    const ana = who(t, ANA), ben = who(t, BEN);

    // AHEAD — another of ana's machines has upgraded and pushed. Anything this machine
    // writes now would land in a log that has moved past it.
    publishManifestAs(ben, ANA, { ...current, anchorScheme: ANCHOR_SCHEME + 1 });
    const blocked = await syncOne(ana) as { error?: string };
    assert.ok(blocked.error, "this machine is the stale one and is stopped");
    assert.match(blocked.error!, /your own manifest/i);
    assert.match(blocked.error!, /Upgrade this machine before syncing/);

    // BEHIND — the ordinary upgrade. The remote copy is this person's own older claim
    // and writing over it is exactly what an upgrade does, so it must NOT be fatal.
    // Without this control the rule above reads as "any difference in my own manifest
    // is fatal", which would make upgrading impossible.
    publishManifestAs(ben, ANA, { ...current, anchorScheme: Math.max(1, ANCHOR_SCHEME - 1) });
    const ok = await syncOne(ana) as { error?: string };
    assert.equal(ok.error, undefined, `an upgrade writing over its own older claim is the normal path: ${ok.error}`);
  } finally { t.dispose(); }
});

test("a differing HASH_SCHEME is advisory, not fatal — the team keeps working", async () => {
  // The asymmetry that makes the fatal rule bearable. Ids still agree, so the events
  // mean what they say; only the witnesses cannot be compared. Refusing here would stop
  // a team over something a re-witness fixes.
  const t = await team([ANA, BEN]);
  const ledger = new Ledger();
  try {
    const ana = who(t, ANA), ben = who(t, BEN);
    publishManifestAs(ben, CAROL, { ...current, hashScheme: HASH_SCHEME + 1 });

    const r = await syncOne(ana) as { error?: string };
    assert.equal(r.error, undefined, `a hash-scheme difference must not stop a sync: ${r.error}`);

    const status = await peerWarning(ana);
    assert.equal(status.blocked, undefined, "it is not fatal");
    assert.ok(status.warning, "but it is not silent either");
    assert.match(status.warning!, /HASH_SCHEME/);
    assert.match(status.warning!, /unverifiable until re-witnessed/, "and it says what the consequence is");

    // And real work still crosses.
    await document(ana.repo, {
      id: "n_transfer", type: "concept", title: "Transfer", summary: "moves money",
      anchors: ["src/pay.ts#transfer"],
    });
    await publishLocalDocs(ana.repo);
    await shareFinding(ben.repo, 8, { targetKind: "anchor", targetId: "a_1", text: "across a hash-scheme gap" });
    await settle(t);
    await checkSettled(t, ledger);

    for (const m of t.all) {
      assert.deepEqual(
        (await sharedDocs(m.repo) as any).docs.map((d: any) => d.nodeId), ["n_transfer"],
        `${m.machine} did not receive the doc`,
      );
      assert.deepEqual(
        (await sharedFindings(m.repo, 8) as any).findings.map((f: any) => f.text), ["across a hash-scheme gap"],
        `${m.machine} did not receive the finding`,
      );
    }
  } finally { t.dispose(); }
});

test("a differing grammar version is advisory, and names the grammar", async () => {
  // The case `HASH_SCHEME` cannot see: two builds agree on the hashing RULES and still
  // produce different bodies, because the parser underneath moved. Ids do not move, so
  // it is advisory for the same reason — but it has to be SAID, or a witness that never
  // matches looks like drift nobody caused.
  const t = await team([ANA, BEN]);
  try {
    const ana = who(t, ANA), ben = who(t, BEN);
    const [name, version] = Object.entries(GRAMMAR_VERSIONS)[0]!;
    publishManifestAs(ben, CAROL, { ...current, grammars: { ...GRAMMAR_VERSIONS, [name]: version + "-next" } });

    const r = await syncOne(ana) as { error?: string };
    assert.equal(r.error, undefined, `a grammar difference must not stop a sync: ${r.error}`);

    const status = await peerWarning(ana);
    assert.equal(status.blocked, undefined);
    assert.ok(status.warning, "it is reported");
    assert.match(status.warning!, new RegExp(`grammar ${name}`), "and it names which grammar");
    assert.match(status.warning!, /bodies hash differently/);

    // CONTROL — the SAME grammar versions say nothing at all, so this is not "any peer
    // warns".
    publishManifestAs(ben, CAROL, current);
    await syncOne(ana);
    assert.equal((await peerWarning(ana)).warning, undefined, "an agreeing peer is silent");
  } finally { t.dispose(); }
});
