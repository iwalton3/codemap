import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Anchor, Review, Triage, Annotation, State } from "./schema.js";
import { remapOverloadIds, applyRemap } from "./migrate-overloads.js";
import { testBug } from "./test-events.js";
import { indexBlob } from "./repo.js";
import { writeStore, readReviews, writeReviews, readAnchorStore } from "./store.js";
import { markReviewed } from "./reviews.js";
import { reindex } from "./ops.js";
import { fixtureHash } from "./fixture-hash.js";
import { discard } from "./test-tmp.js";

const anchor = (over: Partial<Anchor> & { id: string; disambiguator?: string }): Anchor => ({
  file: "Agg.cs", symbolPath: ["D", "Agg", "Apply"], kind: "function",
  bodyHash: fixtureHash("x"), lastVerifiedCommit: null, ...over,
});

test("old ids are paired to new ones by body hash, so a reorder cannot mis-assign", () => {
  // Position looked right because the old disambiguator WAS a position — but that
  // only holds if nothing moved. Reorder the methods in a file (or check out a
  // branch that orders them differently, which auto-reindexes) and the counts still
  // match while every pairing is off by a rotation, attaching somebody's sign-off to
  // a method they never read.
  const stored = [
    anchor({ id: "old0", disambiguator: "0", bodyHash: fixtureHash("A") }),
    anchor({ id: "old1", disambiguator: "1", bodyHash: fixtureHash("B") }),
    anchor({ id: "old2", disambiguator: "2", bodyHash: fixtureHash("C") }),
  ];
  // the same three methods, reordered in the file, under the new scheme
  const fresh = [
    anchor({ id: "new_c", disambiguator: "(OrderClosed)", bodyHash: fixtureHash("C") }),
    anchor({ id: "new_a", disambiguator: "(OrderCreated)", bodyHash: fixtureHash("A") }),
    anchor({ id: "new_b", disambiguator: "(TicketCreated)", bodyHash: fixtureHash("B") }),
  ];
  assert.deepEqual([...remapOverloadIds(stored, fresh)].sort(),
    [["old0", "new_a"], ["old1", "new_b"], ["old2", "new_c"]].sort(),
    "each old id follows its own body, whatever order the file is in");
});

test("a group that cannot be paired beyond doubt is left alone", () => {
  // Skipping leaves those references dangling — which is what would have happened
  // anyway, and dangling is visible. Guessing is what is not recoverable.
  const two = (aHash: string, bHash: string, ids: [string, string], dis: [string, string]) => [
    anchor({ id: ids[0], disambiguator: dis[0], bodyHash: aHash }),
    anchor({ id: ids[1], disambiguator: dis[1], bodyHash: bHash }),
  ];
  const stored = two(fixtureHash("A"), fixtureHash("B"), ["old0", "old1"], ["0", "1"]);

  // a body changed since the index — we cannot tell which method it was
  assert.equal(remapOverloadIds(stored, two(fixtureHash("A"), fixtureHash("CHANGED"), ["n0", "n1"], ["(x)", "(y)"])).size, 0);
  // two overloads sharing a body cannot be told apart by it
  assert.equal(remapOverloadIds(two(fixtureHash("S"), fixtureHash("S"), ["old0", "old1"], ["0", "1"]),
    two(fixtureHash("S"), fixtureHash("S"), ["n0", "n1"], ["(x)", "(y)"])).size, 0);
  // the shape moved
  assert.equal(remapOverloadIds(stored, [anchor({ id: "n0", disambiguator: "(x)", bodyHash: fixtureHash("A") })]).size, 0);
  // and a store already on the new scheme is a no-op
  const already = two(fixtureHash("A"), fixtureHash("B"), ["n0", "n1"], ["(x)", "(y)"]);
  assert.equal(remapOverloadIds(already, already).size, 0);
});


test("every kind of stored reference is carried across", () => {
  const map = new Map([["old0", "new_a"]]);
  const reviews: Review[] = [{
    id: "r1", target: { kind: "anchor", id: "old0" }, level: "code", reviewer: "me",
    at: "2026-08-19T00:00:00Z", reviewedCommit: null,
    witnesses: [{ anchorId: "old0", bodyHash: fixtureHash("a") }],
    accepted: [{ anchorId: "old0", entries: [] }],
  } as Review];
  const triage: Triage[] = [{
    target: { kind: "anchor", id: "old0" }, importance: "important", likely: false,
    source: "human", at: "2026-08-19T00:00:00Z",
    witnesses: [{ anchorId: "old0", bodyHash: fixtureHash("a") }],
  } as Triage];
  const annotations: Annotation[] = [{
    id: "n1", target: { kind: "anchor", id: "old0" }, text: "x", author: "me", createdCommit: null,
  } as Annotation];
  const citations = [[{ anchorId: "old0", acceptedHashes: [] }, { anchorId: "untouched" }]];
  // Bugs are witness-hashed against anchor ids exactly as reviews are, and were the
  // one store the first version of this migration forgot.
  const bugs = [testBug({
    id: "b1", title: "t", severity: "high",
    cites: [{ anchorId: "old0", bodyHash: fixtureHash("a") }, { anchorId: "untouched", bodyHash: fixtureHash("b") }],
  })];

  const counts = applyRemap(map, { reviews, triage, annotations, bugs, citations });
  assert.deepEqual(counts, { anchors: 1, reviews: 1, triage: 1, annotations: 1, citations: 1, bugs: 1 });
  // One list now: a citation carries its own witness, so the id and the hash cannot
  // drift apart under the remap the way two parallel lists could.
  assert.deepEqual(bugs[0]!.anchors.map((a) => a.anchorId), ["new_a", "untouched"]);
  assert.equal(reviews[0]!.target.id, "new_a");
  assert.equal(reviews[0]!.witnesses[0]!.anchorId, "new_a");
  assert.equal(reviews[0]!.accepted![0]!.anchorId, "new_a");
  assert.equal(triage[0]!.target.id, "new_a");
  assert.equal(triage[0]!.witnesses[0]!.anchorId, "new_a");
  assert.equal(annotations[0]!.target.id, "new_a");
  assert.equal(citations[0]![0]!.anchorId, "new_a");
  assert.equal(citations[0]![1]!.anchorId, "untouched");
});

test("a sign-off on an overload survives the re-index that changes its id", async () => {
  // The whole point: 1,350 stored references on the live universes pointed at
  // ordinal-derived ids. Re-indexing mints signature-derived ones, and without this
  // every one of them would dangle.
  const root = mkdtempSync(join(tmpdir(), "codemap-migrate-"));
  try {
    mkdirSync(join(root, "src"));
    const src = `namespace D { public class Agg {
      public void Apply(OrderCreated e) { X(1); }
      public void Apply(TicketCreated e) { Y(2); }
    } }`;
    writeFileSync(join(root, "src/Agg.cs"), src);

    // stand in for a store written under the OLD scheme
    const fresh = await indexBlob(src, "src/Agg.cs");
    const applies = fresh.filter((a) => a.symbolPath.at(-1) === "Apply");
    assert.equal(applies.length, 2);
    const legacy = fresh.map((a) => {
      const i = applies.indexOf(a);
      return i < 0 ? a : { ...a, id: `legacy_${i}`, disambiguator: String(i) };
    });
    await writeStore(root, legacy, { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State);
    await markReviewed(root, { targetKind: "anchor", targetId: "legacy_1", level: "code", actor: "human", attestation: "signed" });

    // A cached commit snapshot from before the derivation changed. Snapshots written
    // by the current code are stamped with the scheme in force, so simulating an old
    // one means clearing that stamp — which is exactly the state every snapshot
    // written before the column existed is already in.
    const { writeSnapshot, readSnapshot, listSnapshots } = await import("./store.js");
    await writeSnapshot(root, "oldsha", "main", legacy, "2026-08-19T00:00:00Z");
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(join(root, ".codemap/codemap.db"));
    raw.prepare("UPDATE snapshots SET scheme = NULL WHERE ref = ?").run("oldsha");
    raw.close();

    assert.equal(await readSnapshot(root, "oldsha"), null,
      "a snapshot from another derivation reads as NOT CACHED — comparing it would report every affected symbol as removed-and-added");
    assert.equal((await listSnapshots(root)).length, 1, "…while still being on record, so it can be rebuilt rather than lost");

    const r = await reindex(root) as any;
    assert.ok(r.remapped, "the re-index reports what it carried across");
    assert.equal(r.remapped.reviews, 1);
    assert.equal(r.remapped.droppedSnapshots, 1, "and says how many snapshots are due a rebuild");

    const store = await readAnchorStore(root);
    const ticket = store.anchors.find((a) => a.disambiguator === "(TicketCreated)")!;
    assert.ok(ticket, "the new scheme is in the store");
    const rev = (await readReviews(root)).reviews[0]!;
    assert.equal(rev.target.id, ticket.id, "the sign-off followed the method, not the ordinal");
    assert.equal(rev.witnesses[0]!.anchorId, ticket.id);
  } finally { discard(root); }
});

test("a snapshot from another derivation never reports phantom changes", async () => {
  // On one real pull request this was 107 symbols across NINE files that git says are
  // byte-identical, every one carrying an overloaded name. The base snapshot predated
  // a change to how a signature is rendered (`(AcmeUser)` became `(thisAcmeUser)` once
  // parameter modifiers were included), so every overload read as removed-and-added —
  // and the review queue's coverage could never reach "everything accounted for",
  // which is the one thing that number is for.
  const root = mkdtempSync(join(tmpdir(), "codemap-scheme-"));
  try {
    mkdirSync(join(root, "src"));
    const src = `namespace D { public static class E {
      public static bool Is(this User u) { return true; }
      public static bool Is(this User u, Guid g) { return false; }
    } }`;
    writeFileSync(join(root, "src/E.cs"), src);
    const current = await indexBlob(src, "src/E.cs");

    // the same file, indexed under a derivation that rendered signatures differently
    const older = current.map((a) => a.disambiguator
      ? { ...a, id: `old_${a.disambiguator}`, disambiguator: a.disambiguator.replace("this", "") }
      : a);
    assert.notDeepEqual(older.map((a) => a.id), current.map((a) => a.id), "the fixture has to actually differ");

    const { writeSnapshot, readSnapshot } = await import("./store.js");
    await writeStore(root, current, { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State);
    await writeSnapshot(root, "basesha", "main", older, "2026-08-19T00:00:00Z");
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(join(root, ".codemap/codemap.db"));
    raw.prepare("UPDATE snapshots SET scheme = NULL WHERE ref = ?").run("basesha");
    raw.close();

    // The point: it refuses to be read as a comparable set, so `diff` says it is not
    // cached instead of inventing two added and two removed symbols.
    assert.equal(await readSnapshot(root, "basesha"), null);
    const { computeDiff } = await import("./diff.js");
    const d = await computeDiff(root, "basesha") as any;
    assert.ok(d.error, "a wrong answer has no handler; 'not cached' has one");
    assert.match(d.error, /codemap (init|snapshot)/, "and it says how to fix it");
  } finally { discard(root); }
});
