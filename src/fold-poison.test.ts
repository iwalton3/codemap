import { test } from "node:test";
import { testEvent } from "./test-events.js";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shardFor, causality, type LogEvent } from "./eventlog.js";
import { readFindings } from "./shared-findings.js";
import { publishDocVersion, readDocs } from "./shared-docs.js";
import { fixtureHash } from "./fixture-hash.js";
import { discard } from "./test-tmp.js";

const tmp = () => mkdtempSync(join(tmpdir(), "codemap-poison-"));
const izzie = { principal: "izzie@x.com" };
const SCOPE = "findings/acme/api/pr-264";
const PR = "acme/api/pr-264";

const good: LogEvent = testEvent({
  id: "0000000001-aa", kind: "finding.created", subject: "f_1", actor: izzie,
  data: { text: "a real finding", targetId: "a_1", targetKind: "anchor" },
});

/**
 * One malformed line from one client must not take a whole scope down.
 *
 * The fold's contract is that an event it cannot apply is SKIPPED, because events
 * arrive from other people's clients — older, buggier, or just wrong — and a
 * shared store that refuses to load is worse than one that ignores a record.
 *
 * `causality()` broke that without touching the fold: it keys its vector on
 * `actor.principal` for EVERY event before any fold branch sees any of them, so a
 * line with no actor threw instead of being skipped. It parses, it clears
 * `readShard`'s id/kind/subject check, and it stops the entire team reading the
 * pull request. Envelope validation moved to the door.
 */
test("an event with no actor is skipped, not fatal", async () => {
  const root = tmp();
  try {
    const file = join(root, shardFor(SCOPE, "w_test_clone"));
    mkdirSync(join(root, SCOPE), { recursive: true });
    writeFileSync(file, JSON.stringify(good) + "\n", "utf8");
    appendFileSync(file, JSON.stringify({ id: "0000000002-bb", kind: "finding.created", subject: "f_2" }) + "\n", "utf8");

    const out = await readFindings(root, PR);
    assert.deepEqual([...out.keys()], ["f_1"], "the good finding still reads");
  } finally { discard(root); }
});

test("and neither is one with a blank principal, or no id", async () => {
  const root = tmp();
  try {
    const file = join(root, shardFor(SCOPE, "w_test_clone"));
    mkdirSync(join(root, SCOPE), { recursive: true });
    writeFileSync(file, JSON.stringify(good) + "\n", "utf8");
    for (const bad of [
      { id: "0000000003-cc", kind: "finding.created", subject: "f_3", actor: { principal: "   " } },
      { id: "", kind: "finding.created", subject: "f_4", actor: izzie },
      { id: "0000000005-ee", kind: "finding.created", subject: "f_5", actor: null },
    ]) appendFileSync(file, JSON.stringify(bad) + "\n", "utf8");

    assert.deepEqual([...(await readFindings(root, PR)).keys()], ["f_1"]);
  } finally { discard(root); }
});

/** Called directly with a hand-built array, it must not crash either. */
test("causality tolerates an actorless event", () => {
  const evs = [good, { id: "0000000009-zz", kind: "noted", subject: "f_1" } as unknown as LogEvent];
  const c = causality(evs);
  assert.equal(c.saw(good.id, "0000000009-zz"), false);
  assert.deepEqual(c.heads(), [good.id], "the unusable event is not a head anyone must descend from");
});

/**
 * The same shape one layer up: a doc version whose `citations` is not an array.
 *
 * It parses, it has a `versionId` and a matching `nodeId`, and then it throws on
 * `.map()` — which is not one unreadable doc but EVERY shared doc in the universe,
 * permanently, for everyone who pulls. The `share_doc` MCP tool takes the version
 * as an opaque object, so this is reachable from an ordinary agent call.
 */
test("a doc version with malformed citations does not poison the universe", async () => {
  const side = tmp();
  try {
    const U = "acme/api";
    await publishDocVersion(side, U, izzie, {
      nodeId: "n_good", type: "concept", title: "a real doc", summary: "s", body: "b",
      citations: [{ anchorId: "a_1", acceptedHashes: [fixtureHash("abc", 2)] }],
    });
    await publishDocVersion(side, U, izzie, {
      nodeId: "n_bad", type: "concept", title: "t", summary: "s", body: "b",
      citations: "bad" as unknown as [],
    });

    const docs = await readDocs(side, U);
    assert.deepEqual([...docs.keys()], ["n_good"], "the healthy doc survives its neighbour");
    assert.equal(docs.get("n_good")!.versions[0]!.citations.length, 1);
  } finally { discard(side); }
});

test("and neither does a citation that is not an object", async () => {
  const side = tmp();
  try {
    const U = "acme/api";
    await publishDocVersion(side, U, izzie, {
      nodeId: "n_1", type: "concept", title: "t", summary: "s", body: "b",
      citations: [null, "a_1", { anchorId: "a_2", acceptedHashes: "nope" }] as unknown as [],
    });
    const v = (await readDocs(side, U)).get("n_1")!.versions[0]!;
    assert.deepEqual(v.citations.map((c) => c.anchorId), ["a_2"], "only the usable citation is kept");
    assert.deepEqual(v.citations[0]!.acceptedHashes, [], "and a non-array hash list reads as none");
  } finally { discard(side); }
});

/**
 * The same class, reached without a hostile writer or an odd type.
 *
 * `JSON.stringify` DROPS keys whose value is `undefined`, so a version carrying an
 * undefined `createdCommit` — required but NULLABLE, and easy to leave unset —
 * travels as a line with no such key. This build's `publishDocVersion` coerces them,
 * so the line has to come from somewhere else: a peer on a build that does not, or a
 * hand-written shard. That is precisely the population the FOLD exists to gate.
 *
 * The fold used to accept it and the projection's INSERT then threw a raw SQLite
 * bind error inside `readCached`'s transaction — not one bad doc but every shared
 * doc in the universe unreadable, permanently, because nothing about the failure
 * moves the scope's fingerprint.
 *
 * Found by the oracle's COMPLETENESS property while it was being written.
 */
const DOCS = "docs/acme/api";

const docLine = (id: string, node: string, version: Record<string, unknown>) => JSON.stringify(testEvent({
  id, kind: "doc.version", subject: node, actor: izzie, data: { version },
})) + "\n";

test("a doc version missing a nullable scalar does not poison the universe", async () => {
  const root = tmp();
  try {
    mkdirSync(join(root, DOCS), { recursive: true });
    const file = join(root, shardFor(DOCS, "w_test_clone"));
    writeFileSync(file, docLine("0000000001-aa", "n_good", {
      versionId: "nv_good", nodeId: "n_good", type: "concept", title: "a real doc",
      summary: "s", body: "b", citations: [], createdCommit: null, createdBranch: null, createdAt: "2026-01-01T00:00:00Z",
    }), "utf8");
    // No `createdCommit`, `createdBranch` or `createdAt` keys at all — what the wire
    // carries when they were undefined at the source.
    appendFileSync(file, docLine("0000000002-bb", "n_thin", {
      versionId: "nv_thin", nodeId: "n_thin", type: "concept", title: "t", summary: "s", body: "b", citations: [],
    }), "utf8");

    const docs = await readDocs(root, "acme/api");
    assert.deepEqual([...docs.keys()].sort(), ["n_good", "n_thin"], "both docs read");
    const thin = docs.get("n_thin")!.versions[0]!;
    // Absent is stored as absent. The point is that it BINDS, not that it is invented.
    assert.equal(thin.createdCommit, null);
    assert.equal(thin.createdBranch, null);
    assert.equal(thin.createdAt, "");
  } finally { discard(root); }
});

test("a doc version whose type is not a string never arrives at all", async () => {
  // CONTROL for the coercion above: the discriminator has no sensible default, and
  // inventing one files somebody's doc under a type they did not choose. It must be
  // dropped BEFORE the node entry is created, too — a node left existing with no
  // versions reads as "written and empty" rather than "never arrived".
  const root = tmp();
  try {
    mkdirSync(join(root, DOCS), { recursive: true });
    writeFileSync(join(root, shardFor(DOCS, "w_test_clone")), docLine("0000000001-aa", "n_1", {
      versionId: "nv_1", nodeId: "n_1", type: 7, title: "t", summary: "s", body: "b",
      citations: [], createdCommit: null, createdBranch: null, createdAt: "2026-01-01T00:00:00Z",
    }), "utf8");
    assert.equal((await readDocs(root, "acme/api")).size, 0, "no node, not an empty one");
  } finally { discard(root); }
});
