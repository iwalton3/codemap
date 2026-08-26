import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Anchor, State } from "./schema.js";
import { writeStore, writeSnapshot, readReviews } from "./store.js";
import { markReviewed, reviewStatesFor, liveHashes } from "./reviews.js";
import { fixtureHash } from "./fixture-hash.js";
import { discard } from "./test-tmp.js";

const anchor = (bodyHash: string): Anchor => ({
  id: "a_pay", file: "src/pay.cs", symbolPath: ["Pay", "Handle"], kind: "function", bodyHash, lastVerifiedCommit: null,
});
const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const target = { kind: "anchor" as const, id: "a_pay" };

/**
 * The witness is the whole point of a sign-off: it records *which* code was
 * vouched for. Reviewing a pull request reads code that is not in the working
 * tree, so without a ref the mark would witness the branch you happen to be on.
 */
test("a PR sign-off witnesses the code that was read, not the working tree's copy", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-prrev-"));
  try {
    await writeStore(root, [anchor(fixtureHash("OLD"))], state);            // working tree = base branch
    await writeSnapshot(root, "headsha", "feature", [anchor(fixtureHash("NEW"))], "2026-08-18T00:00:00Z");

    await markReviewed(root, { targetKind: "anchor", targetId: "a_pay", level: "code", actor: "human", attestation: "signed", ref: "headsha" });

    const w = (await readReviews(root)).reviews[0]!.witnesses;
    assert.deepEqual(w, [{ anchorId: "a_pay", bodyHash: fixtureHash("NEW") }], "must witness the PR head, not the working tree");
  } finally { discard(root); }
});

test("that mark reads fresh on the PR and stale on the base — and lands when the change does", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-prrev-"));
  try {
    await writeStore(root, [anchor(fixtureHash("OLD"))], state);
    await writeSnapshot(root, "basesha", "develop", [anchor(fixtureHash("OLD"))], "2026-08-18T00:00:00Z");
    await writeSnapshot(root, "headsha", "feature", [anchor(fixtureHash("NEW"))], "2026-08-18T00:00:00Z");
    await markReviewed(root, { targetKind: "anchor", targetId: "a_pay", level: "code", actor: "human", attestation: "signed", ref: "headsha" });

    const at = async (ref: string) => (await reviewStatesFor(root, [target], { ref })).get("anchor:a_pay")!.code.state;
    assert.equal(await at("headsha"), "reviewed", "fresh against the code it covered");
    assert.equal(await at("basesha"), "stale", "the base branch still holds code this vouch never saw");

    // Once the change lands, the base carries the hash the mark vouched for, so the
    // pre-merge sign-off activates on its own rather than needing to be redone.
    await writeSnapshot(root, "mergedsha", "develop", [anchor(fixtureHash("NEW"))], "2026-08-18T01:00:00Z");
    assert.equal(await at("mergedsha"), "reviewed", "a pre-merge sign-off activates when the code lands");
  } finally { discard(root); }
});

test("a symbol that exists only on the branch is witnessed, not recorded as absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-prrev-"));
  try {
    await writeStore(root, [], state);                                 // not on the base branch at all
    await writeSnapshot(root, "headsha", "feature", [anchor(fixtureHash("NEW"))], "2026-08-18T00:00:00Z");

    const withRef = await liveHashes(root, ["a_pay"], "headsha");
    assert.equal(withRef.get("a_pay"), fixtureHash("NEW"));

    await markReviewed(root, { targetKind: "anchor", targetId: "a_pay", level: "code", actor: "human", attestation: "signed", ref: "headsha" });
    assert.equal((await readReviews(root)).reviews[0]!.witnesses[0]!.bodyHash, fixtureHash("NEW"), "an added symbol must not witness sha256:absent");
  } finally { discard(root); }
});
