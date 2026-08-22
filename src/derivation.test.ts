import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Anchor, DerivationTag } from "./schema.js";
import { writeAnchorStore, anchorsUnderRef, retainOrphans, readOrphans } from "./store.js";
import { derivationTag } from "./grammars.js";
import { fixtureHash } from "./fixture-hash.js";

const tmp = () => mkdtempSync(join(tmpdir(), "codemap-deriv-"));

const OLD: DerivationTag = { anchorScheme: 2, hashScheme: 1, parserIntegrity: "p_old", grammarDigest: "g_old" };
const NEW: DerivationTag = { anchorScheme: 3, hashScheme: 2, parserIntegrity: "p_new", grammarDigest: "g_new" };

const anchor = (id: string, derivation?: DerivationTag): Anchor => ({
  id, file: "src/pay.cs", symbolPath: ["Pay", id], kind: "function",
  bodyHash: fixtureHash(id), lastVerifiedCommit: null,
  ...(derivation ? { derivation } : {}),
});

/**
 * The reason provenance is on the ROW and not on the ref.
 *
 * `sync.ts` refreshes an existing anchor's location but deliberately preserves its
 * `bodyHash` as the baseline, so after an upgrade `@work` legitimately holds rows
 * derived two different ways. A per-ref stamp has no correct value to take: the
 * new one relabels the old rows, the old one relabels the new.
 */
test("one ref holds rows derived two different ways, and each keeps its own", async () => {
  const root = tmp();
  try {
    await writeAnchorStore(root, [anchor("a_before", OLD)]);

    // The upgrade: read what is there, add what is new, write the union back —
    // exactly the shape of `applyIndexUpdate`.
    const existing = anchorsUnderRef(root, "@work");
    assert.deepEqual(existing[0]!.derivation, OLD, "the tag survived one round-trip");
    await writeAnchorStore(root, [...existing, anchor("a_after", NEW)]);

    const byId = new Map(anchorsUnderRef(root, "@work").map((a) => [a.id, a]));
    assert.deepEqual(byId.get("a_before")!.derivation, OLD, "the old row was relabelled");
    assert.deepEqual(byId.get("a_after")!.derivation, NEW, "the new row lost its tag");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * The failure this design is guarding against, stated as a test.
 *
 * `replaceAnchors` deletes the ref and re-inserts every row from `Anchor[]`, so a
 * `derivation` COLUMN that the `Anchor` object did not carry would be silently
 * dropped by the first incremental update. Provenance has to ride on the object,
 * and this is what proves it does.
 */
test("provenance survives the delete-and-reinsert round trip, repeatedly", async () => {
  const root = tmp();
  try {
    let anchors = [anchor("a_1", OLD), anchor("a_2", NEW)];
    for (let i = 0; i < 3; i++) {
      await writeAnchorStore(root, anchors);
      anchors = anchorsUnderRef(root, "@work");
    }
    const byId = new Map(anchors.map((a) => [a.id, a]));
    assert.deepEqual(byId.get("a_1")!.derivation, OLD);
    assert.deepEqual(byId.get("a_2")!.derivation, NEW);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * An orphan keeps what it was EVICTED under.
 *
 * `retainOrphans` is `INSERT OR IGNORE` because the first eviction holds the last
 * state the anchor was really seen in. Re-deriving it later would be a claim
 * nobody can check — the code it described is not in the tree any more.
 */
test("an orphan keeps the derivation it was evicted under", async () => {
  const root = tmp();
  try {
    await writeAnchorStore(root, []);
    retainOrphans(root, [anchor("a_gone", OLD)]);
    // A later pass under a new derivation must not overwrite it.
    retainOrphans(root, [anchor("a_gone", NEW)]);
    assert.deepEqual(readOrphans(root).get("a_gone")!.derivation, OLD, "re-derived an orphan");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * A row from before this existed says so, rather than borrowing today's answer.
 *
 * That is `legacy_live_derivation`: this machine cannot say how its own index was
 * made. Stamping it with the current tag would be the relabeling defect performed
 * deliberately, and it is the state every existing store starts in.
 */
test("an untagged row reads as untagged, not as the current derivation", async () => {
  const root = tmp();
  try {
    await writeAnchorStore(root, [anchor("a_legacy")]);
    assert.equal(anchorsUnderRef(root, "@work")[0]!.derivation, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** Interned, because there are five tags at most against any number of anchors. */
test("identical tags are stored once", async () => {
  const root = tmp();
  try {
    await writeAnchorStore(root, Array.from({ length: 50 }, (_, i) => anchor(`a_${i}`, OLD)));
    const d = new DatabaseSync(join(root, ".codemap", "codemap.db"));
    const { n } = d.prepare("SELECT count(*) AS n FROM derivations").get() as { n: number };
    d.close();
    assert.equal(n, 1, "50 anchors, one distinct tag, one row");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * The real tag, not a fixture — the values that make it an identity rather than a
 * label. A version string would authenticate nothing: two runtimes can share one
 * and tokenize differently.
 */
test("the live tag identifies the runtime and the exact grammar blob", () => {
  const cs = derivationTag("c_sharp"), tsx = derivationTag("tsx"), ts = derivationTag("typescript");
  assert.match(cs.parserIntegrity, /^[0-9a-f]{64}$/, "a digest, not a version");
  assert.match(cs.grammarDigest, /^[0-9a-f]{64}$/);
  assert.equal(cs.parserIntegrity, tsx.parserIntegrity, "one runtime ran all of them");
  assert.notEqual(tsx.grammarDigest, ts.grammarDigest, "tsx and typescript are different blobs");
});
