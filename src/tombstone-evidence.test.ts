import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reindex, document as documentNode, ackHole } from "./ops.js";
import { readAnchorStore, loadNodeVersions } from "./store.js";
import { derivationMark } from "./normalize.js";

/**
 * A tombstone's citations keep their accepted hashes.
 *
 * They are NOT an acceptance — `evalVersion`'s removed branch never reads them, and
 * a tombstone's badness comes from which cited anchors are still PRESENT. They are
 * the derivation evidence behind the removal CLAIM: "this was removed" is an
 * inference from absence, and absence only means removal if this index could have
 * resolved the id in the first place.
 *
 * Emptied, a tombstone arrives with nothing to judge that by, so it reads as holding
 * against any index — including one whose build mints different ids for the same
 * code, where the code is still right there. See docs/anchor-id-provenance.md §6.
 */

const write = (root: string, body: string) => writeFileSync(join(root, "src/pay.ts"), body);

async function repo() {
  const root = mkdtempSync(join(tmpdir(), "codemap-tomb-"));
  mkdirSync(join(root, "src"));
  write(root, "export function transfer(cents: number) {\n  return cents;\n}\n");
  await reindex(root);
  return root;
}

test("acking a hole keeps the hashes the removal claim rests on", async () => {
  const root = await repo();
  try {
    const anchorId = (await readAnchorStore(root)).anchors[0]!.id;
    const d = await documentNode(root, {
      type: "process", title: "The transfer seam", summary: "s", body: "b", anchors: [anchorId],
    }) as { id?: string; error?: string };
    assert.ok(d.id, JSON.stringify(d));

    const before = (await loadNodeVersions(root, d.id))[0]!;
    assert.ok(before.citations[0]!.acceptedHashes.length > 0, "control: a live citation captures a hash");

    // The code goes away, and the doc becomes a hole.
    write(root, "export const nothing = 1;\n");
    await reindex(root);
    const r = await ackHole(root, d.id) as { ok?: true; error?: string };
    assert.ok(r.ok, JSON.stringify(r));

    const tomb = (await loadNodeVersions(root, d.id)).find((v) => v.removed);
    assert.ok(tomb, "acking a hole writes a tombstone version");
    assert.deepEqual(tomb.citations.map((c) => c.anchorId), [anchorId]);
    assert.deepEqual(tomb.citations[0]!.acceptedHashes, before.citations[0]!.acceptedHashes,
      "the tombstone carries the prior version's hashes — its only evidence that this index could resolve the id");
    assert.ok(derivationMark(tomb.citations[0]!.acceptedHashes[0]!),
      "and they are annotated, which is what makes them evidence rather than decoration");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
