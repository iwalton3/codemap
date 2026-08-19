import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Anchor, Review, Triage, Annotation, State } from "./schema.js";
import { remapOverloadIds, applyRemap } from "./migrate-overloads.js";
import { indexBlob } from "./repo.js";
import { writeStore, readReviews, writeReviews, readAnchorStore } from "./store.js";
import { markReviewed } from "./reviews.js";
import { reindex } from "./ops.js";

const anchor = (over: Partial<Anchor> & { id: string; disambiguator?: string }): Anchor => ({
  file: "Agg.cs", symbolPath: ["D", "Agg", "Apply"], kind: "function",
  bodyHash: "sha256:x", lastVerifiedCommit: null, ...over,
});

test("old ordinal ids are paired with the new signature ids by position", () => {
  const stored = [
    anchor({ id: "old0", disambiguator: "0" }),
    anchor({ id: "old1", disambiguator: "1" }),
    anchor({ id: "old2", disambiguator: "2" }),
  ];
  const fresh = [
    anchor({ id: "new_a", disambiguator: "(OrderCreated)" }),
    anchor({ id: "new_b", disambiguator: "(TicketCreated)" }),
    anchor({ id: "new_c", disambiguator: "(OrderClosed)" }),
  ];
  const map = remapOverloadIds(stored, fresh);
  assert.deepEqual([...map], [["old0", "new_a"], ["old1", "new_b"], ["old2", "new_c"]]);

  // the ordinals are the old ORDER, however the rows happen to be listed
  const shuffled = [stored[2]!, stored[0]!, stored[1]!];
  assert.deepEqual([...remapOverloadIds(shuffled, fresh)], [...map]);
});

test("a group whose shape moved is skipped rather than guessed at", () => {
  // Position only pairs reliably when nothing was added or removed. Guessing here
  // would attach somebody's sign-off to a method they never read.
  const stored = [anchor({ id: "old0", disambiguator: "0" }), anchor({ id: "old1", disambiguator: "1" })];
  const fresh = [anchor({ id: "new_a", disambiguator: "(OrderCreated)" })];
  assert.equal(remapOverloadIds(stored, fresh).size, 0);

  // and a store already on the new scheme is left alone
  const already = [anchor({ id: "new_a", disambiguator: "(OrderCreated)" })];
  assert.equal(remapOverloadIds(already, already).size, 0);
});

test("every kind of stored reference is carried across", () => {
  const map = new Map([["old0", "new_a"]]);
  const reviews: Review[] = [{
    id: "r1", target: { kind: "anchor", id: "old0" }, level: "code", reviewer: "me",
    at: "2026-08-19T00:00:00Z", reviewedCommit: null,
    witnesses: [{ anchorId: "old0", bodyHash: "sha256:a" }],
    accepted: [{ anchorId: "old0", entries: [] }],
  } as Review];
  const triage: Triage[] = [{
    target: { kind: "anchor", id: "old0" }, importance: "important", likely: false,
    source: "human", at: "2026-08-19T00:00:00Z",
    witnesses: [{ anchorId: "old0", bodyHash: "sha256:a" }],
  } as Triage];
  const annotations: Annotation[] = [{
    id: "n1", target: { kind: "anchor", id: "old0" }, text: "x", author: "me", createdCommit: null,
  } as Annotation];
  const citations = [[{ anchorId: "old0", acceptedHashes: [] }, { anchorId: "untouched" }]];

  const counts = applyRemap(map, { reviews, triage, annotations, citations });
  assert.deepEqual(counts, { anchors: 1, reviews: 1, triage: 1, annotations: 1, citations: 1 });
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

    // a cached commit snapshot written under the old scheme
    const { writeSnapshot, listSnapshots } = await import("./store.js");
    await writeSnapshot(root, "oldsha", "main", legacy, "2026-08-19T00:00:00Z");
    assert.equal((await listSnapshots(root)).length, 1);

    const r = await reindex(root) as any;
    assert.ok(r.remapped, "the re-index reports what it carried across");
    assert.equal(r.remapped.reviews, 1);
    assert.equal(r.remapped.droppedSnapshots, 1,
      "an old-scheme snapshot cannot be diffed against a new-scheme one, so it is discarded and rebuilt");
    assert.equal((await listSnapshots(root)).some((s) => s.ref === "oldsha"), false);

    const store = await readAnchorStore(root);
    const ticket = store.anchors.find((a) => a.disambiguator === "(TicketCreated)")!;
    assert.ok(ticket, "the new scheme is in the store");
    const rev = (await readReviews(root)).reviews[0]!;
    assert.equal(rev.target.id, ticket.id, "the sign-off followed the method, not the ordinal");
    assert.equal(rev.witnesses[0]!.anchorId, ticket.id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
