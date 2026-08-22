import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Anchor, DerivationTag } from "./schema.js";
import { writeAnchorStore, liveDerivationDrift } from "./store.js";
import { derivationTag } from "./grammars.js";
import { fixtureHash } from "./fixture-hash.js";

const tmp = () => mkdtempSync(join(tmpdir(), "codemap-drift-"));
const CURRENT = derivationTag("c_sharp");
const FOREIGN: DerivationTag = { ...CURRENT, grammarDigest: "g_from_another_build" };

const anchor = (id: string, derivation?: DerivationTag): Anchor => ({
  id, file: "src/pay.cs", symbolPath: ["Pay", id], kind: "function",
  bodyHash: fixtureHash(id), lastVerifiedCommit: null,
  ...(derivation ? { derivation } : {}),
});

/**
 * The detector exists because the repair is unavailable.
 *
 * A cached snapshot derived by another build is simply rebuilt. `@work` cannot be:
 * reindexing it is precisely what turns a grammar change into a store-wide false
 * staleness event, because every review witness and doc citation holds an
 * old-derivation hash and `comparableHashes` sees two `h2:` values and calls them
 * comparable. So this reports and stops.
 */
test("a live index built by another grammar is detected", async () => {
  const root = tmp();
  try {
    await writeAnchorStore(root, [anchor("a_1", FOREIGN), anchor("a_2", FOREIGN)]);
    const d = liveDerivationDrift(root);
    assert.equal(d.stale, true);
    assert.equal(d.tagged, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an index built by this build is not flagged", async () => {
  const root = tmp();
  try {
    await writeAnchorStore(root, [anchor("a_1", CURRENT), anchor("a_2", derivationTag("python"))]);
    assert.equal(liveDerivationDrift(root).stale, false, "several languages is not drift");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * Untagged rows do not fire it, which is the same answer `comparableDerivation`
 * and `readSnapshot` give. Every store that exists today is entirely untagged, and
 * warning all of them about a question their rows cannot answer would train people
 * to ignore the one case that means something.
 */
test("a pre-provenance index is silent, not suspicious", async () => {
  const root = tmp();
  try {
    await writeAnchorStore(root, [anchor("a_1"), anchor("a_2")]);
    const d = liveDerivationDrift(root);
    assert.equal(d.stale, false);
    assert.equal(d.untagged, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * The mixed state is the realistic one, and it must fire.
 *
 * After a grammar change an incremental update keeps existing rows' hashes and
 * indexes new symbols fresh, so `@work` ends up holding both. That is the shape a
 * person actually meets, and it is exactly when they most need telling before they
 * reach for a reindex.
 */
test("one stale row among current ones is enough", async () => {
  const root = tmp();
  try {
    await writeAnchorStore(root, [anchor("a_new", CURRENT), anchor("a_old", FOREIGN)]);
    assert.equal(liveDerivationDrift(root).stale, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
