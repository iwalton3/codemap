import { test } from "node:test";
import assert from "node:assert/strict";
import { legacyIndex } from "./anchor-resolve.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor, NodeVersion } from "./schema.js";
import { sortEvents, type LogEvent } from "./eventlog.js";
import { publishDocVersion, acceptDocHash, readDocs, resolveDoc, foldDocs, docScope } from "./shared-docs.js";
import { comparableHashes } from "./normalize.js";
import { fixtureHash } from "./fixture-hash.js";

const izzie: Actor = { principal: "izzie@x.com" };
const dana: Actor = { principal: "dana@x.com" };
const tmp = () => mkdtempSync(join(tmpdir(), "codemap-sd-"));
const U = "acme/api";

const DOC = {
  nodeId: "n_payments",
  type: "process",
  title: "Payments seam",
  summary: "how a payment reaches the ledger",
  body: "The handler folds…",
  citations: [{ anchorId: "a_1", acceptedHashes: [fixtureHash("develop", 2)] }],
};

// --- versions accumulate ---------------------------------------------------------

test("a doc is a set of versions, and a change adds one rather than editing", async () => {
  const root = tmp();
  try {
    const v1 = await publishDocVersion(root, U, izzie, DOC);
    const v2 = await publishDocVersion(root, U, izzie, { ...DOC, body: "rewritten" });
    const doc = (await readDocs(root, U)).get("n_payments")!;
    assert.equal(doc.versions.length, 2);
    assert.notEqual(v1, v2);
    assert.equal(doc.versions[0]!.body, "The handler folds…", "the first version is untouched");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("each version records who wrote it", async () => {
  const root = tmp();
  try {
    const v1 = await publishDocVersion(root, U, izzie, DOC);
    const v2 = await publishDocVersion(root, U, dana, { ...DOC, body: "dana's take" });
    const doc = (await readDocs(root, U)).get("n_payments")!;
    assert.equal(doc.authors.get(v1)?.principal, "izzie@x.com");
    assert.equal(doc.authors.get(v2)?.principal, "dana@x.com");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- the point of the whole design: one log, every branch -------------------------

test("resolution picks the version matching the code in front of you", async () => {
  // The reason `node_versions` had to stay when docs moved to a sidecar: the
  // sidecar's timeline is not the code repo's, so a checkout cannot be the version.
  const root = tmp();
  try {
    await publishDocVersion(root, U, izzie, DOC);
    await publishDocVersion(root, U, dana, {
      ...DOC, body: "on the feature branch the fold is async",
      citations: [{ anchorId: "a_1", acceptedHashes: [fixtureHash("feature", 2)] }],
    });
    const doc = (await readDocs(root, U)).get("n_payments")!;

    const onDevelop = resolveDoc(doc, legacyIndex(new Map([["a_1", fixtureHash("develop", 2)]])));
    const onFeature = resolveDoc(doc, legacyIndex(new Map([["a_1", fixtureHash("feature", 2)]])));
    assert.match(onDevelop!.body, /handler folds/);
    assert.match(onFeature!.body, /fold is async/, "same log, two branches, no branch tags");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("confirming a version against a second body makes it valid on both branches", async () => {
  const root = tmp();
  try {
    const versionId = await publishDocVersion(root, U, izzie, DOC);
    await acceptDocHash(root, U, dana, "n_payments", versionId, "a_1", fixtureHash("feature", 2));
    const doc = (await readDocs(root, U)).get("n_payments")!;
    assert.ok(resolveDoc(doc, legacyIndex(new Map([["a_1", fixtureHash("develop", 2)]]))));
    assert.ok(resolveDoc(doc, legacyIndex(new Map([["a_1", fixtureHash("feature", 2)]]))), "one version, two branches");
    assert.equal(doc.versions[0]!.citations[0]!.acceptedHashes.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("accepted hashes are a grow-only set — two people confirming both stick", async () => {
  const root = tmp();
  try {
    const versionId = await publishDocVersion(root, U, izzie, DOC);
    await acceptDocHash(root, U, izzie, "n_payments", versionId, "a_1", fixtureHash("x", 2));
    await acceptDocHash(root, U, dana, "n_payments", versionId, "a_1", fixtureHash("y", 2));
    await acceptDocHash(root, U, dana, "n_payments", versionId, "a_1", fixtureHash("x", 2));
    const c = (await readDocs(root, U)).get("n_payments")!.versions[0]!.citations[0]!;
    assert.deepEqual([...c.acceptedHashes].sort(),
      [fixtureHash("develop", 2), fixtureHash("x", 2), fixtureHash("y", 2)].sort(),
      "deduped, none lost");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a hash for an anchor the version does not cite is ignored", async () => {
  // Otherwise a doc reads `fresh` because of code it never claimed anything about.
  const root = tmp();
  try {
    const versionId = await publishDocVersion(root, U, izzie, DOC);
    await acceptDocHash(root, U, izzie, "n_payments", versionId, "a_UNRELATED", fixtureHash("z", 2));
    const v = (await readDocs(root, U)).get("n_payments")!.versions[0]!;
    assert.equal(v.citations.length, 1);
    assert.equal(v.citations[0]!.acceptedHashes.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a doc still resolves on a checkout no version was written against", async () => {
  // `winningVersionAt` picks the LEAST-BAD version rather than refusing, so the
  // existence of a winner says nothing about freshness — the citation's accepted
  // hashes do. Pinned because it would be easy to read a returned version as "this
  // describes your code".
  const root = tmp();
  try {
    await publishDocVersion(root, U, izzie, DOC);
    const doc = (await readDocs(root, U)).get("n_payments")!;
    const v = resolveDoc(doc, legacyIndex(new Map([["a_1", fixtureHash("drifted", 2)]])));
    assert.ok(v, "a version is still returned");
    assert.equal(v!.citations[0]!.acceptedHashes.includes(fixtureHash("drifted", 2)), false, "…and it is NOT fresh here");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- fold contract ----------------------------------------------------------------

const vEvent = (id: string, actor: Actor, v: Partial<NodeVersion> & { versionId: string }, after?: string): LogEvent => ({
  id, kind: "doc.version", subject: "n_1", actor, at: "t", ...(after ? { after } : {}),
  data: { version: { nodeId: "n_1", type: "module", title: "t", summary: "s", body: "b", citations: [], createdCommit: null, createdBranch: null, createdAt: "t", ...v } as never },
});

test("the fold is order-independent", () => {
  const a = vEvent("0000000001-a", izzie, { versionId: "nv_1", body: "one" });
  const b = vEvent("0000000002-b", dana, { versionId: "nv_2", body: "two" }, a.id);
  const shapes = [[a, b], [b, a]].map((s) => foldDocs(sortEvents(s)).get("n_1")!.versions.map((v) => v.body).join("|"));
  assert.equal(new Set(shapes).size, 1);
  assert.equal(shapes[0], "one|two");
});

test("a version id is written once — a replay cannot duplicate it", () => {
  const a = vEvent("0000000001-a", izzie, { versionId: "nv_1", body: "one" });
  const dup = vEvent("0000000002-b", izzie, { versionId: "nv_1", body: "sneaky rewrite" });
  const doc = foldDocs([a, dup]).get("n_1")!;
  assert.equal(doc.versions.length, 1);
  assert.equal(doc.versions[0]!.body, "one", "immutable means immutable");
});

test("a malformed version, or one claiming another node, is skipped", () => {
  const bad = { id: "0000000001-a", kind: "doc.version", subject: "n_1", actor: izzie, at: "t", data: {} } as LogEvent;
  const wrongNode = vEvent("0000000002-b", izzie, { versionId: "nv_9", nodeId: "n_OTHER" } as never);
  assert.equal(foldDocs([bad, wrongNode]).size, 0);
});

test("scopes are per universe", () => {
  assert.notEqual(docScope("acme/api"), docScope("acme/settlement"));
});

test("a citation confirmed under an older HASH_SCHEME is unverifiable, not drifted", () => {
  // The migration case, found on a real repo: reindexing re-hashes everything, so
  // every doc in the store read `stale` without anyone touching the code — 985 of
  // 985. "The code changed" and "these hashes predate a scheme bump" call for
  // completely different actions, so they must not render the same.
  const accepted: string = fixtureHash("old");  // scheme 1, as written before the bump
  const live: string = fixtureHash("new", 2);   // scheme 2, as the reindex minted it
  assert.equal(accepted === live, false, "a plain compare calls this drift");
  assert.equal(comparableHashes(accepted, live), false, "…but they are not comparable at all");

  // Whereas a genuine edit under one scheme IS comparable, and IS drift.
  assert.equal(comparableHashes(fixtureHash("a", 2), fixtureHash("b", 2)), true);
});

/**
 * An acceptance that matches no citation is RETAINED, not dropped.
 *
 * This is the design's one record-against-record join: `doc.accepted` carries an
 * anchor id and finds the citation to attach it to by exact equality. Anchor ids are
 * derived from the parse, so a teammate on another build confirms `a_theirs` against
 * a version citing `a_mine` — the same symbol, spelled two ways, which nothing here
 * can know. Merging would be a guess; dropping meant their acceptance never
 * happened, with no trace. The fold recomputes from the log on every read, so
 * keeping it costs nothing durable and a later reader that CAN pair them recovers it.
 *
 * See docs/anchor-id-provenance.md §3 and §6.
 */
test("an acceptance that matches no citation is kept, not silently dropped", () => {
  const version = {
    versionId: "v1", nodeId: "n1", type: "process", title: "t", summary: "s", body: "b",
    citations: [{ anchorId: "a_mine", acceptedHashes: [] }],
    createdCommit: null, createdBranch: null, createdAt: "2026-01-01T00:00:00Z",
  } as unknown as NodeVersion;
  const ev: LogEvent[] = [
    { id: "1", kind: "doc.version", subject: "n1", actor: izzie, at: "t1", data: { version: version as never } },
    { id: "2", kind: "doc.accepted", subject: "n1", actor: dana, at: "t2",
      data: { versionId: "v1", anchorId: "a_theirs", bodyHash: fixtureHash("body", 2) } },
  ] as LogEvent[];

  const doc = foldDocs(ev).get("n1")!;
  assert.deepEqual(doc.versions[0]!.citations[0]!.acceptedHashes, [],
    "it must NOT be merged — the two ids are not known to name one symbol");
  assert.equal(doc.unmatched?.length, 1, "and it must not vanish either");
  assert.equal(doc.unmatched![0]!.anchorId, "a_theirs");
  assert.equal(doc.unmatched![0]!.why, "no-citation");
});

test("an acceptance for a version this fold never saw is kept too", () => {
  const version = {
    versionId: "v1", nodeId: "n1", type: "process", title: "t", summary: "s", body: "b",
    citations: [{ anchorId: "a_mine", acceptedHashes: [] }],
    createdCommit: null, createdBranch: null, createdAt: "2026-01-01T00:00:00Z",
  } as unknown as NodeVersion;
  const ev: LogEvent[] = [
    { id: "1", kind: "doc.version", subject: "n1", actor: izzie, at: "t1", data: { version: version as never } },
    { id: "2", kind: "doc.accepted", subject: "n1", actor: dana, at: "t2",
      data: { versionId: "v_unknown", anchorId: "a_mine", bodyHash: fixtureHash("body", 2) } },
  ] as LogEvent[];
  assert.equal(foldDocs(ev).get("n1")!.unmatched?.[0]!.why, "no-version");
});
