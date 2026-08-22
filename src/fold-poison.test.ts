import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shardFor, causality, type LogEvent } from "./eventlog.js";
import { readFindings } from "./shared-findings.js";
import { publishDocVersion, readDocs } from "./shared-docs.js";

const tmp = () => mkdtempSync(join(tmpdir(), "codemap-poison-"));
const izzie = { principal: "izzie@x.com" };
const SCOPE = "findings/acme/api/pr-264";
const PR = "acme/api/pr-264";

const good: LogEvent = {
  id: "0000000001-aa", kind: "finding.created", subject: "f_1", actor: izzie, at: "2026-08-21T00:00:00Z",
  data: { text: "a real finding", targetId: "a_1", targetKind: "anchor" },
};

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
    const file = join(root, shardFor(SCOPE, izzie));
    mkdirSync(join(root, SCOPE), { recursive: true });
    writeFileSync(file, JSON.stringify(good) + "\n", "utf8");
    appendFileSync(file, JSON.stringify({ id: "0000000002-bb", kind: "finding.created", subject: "f_2" }) + "\n", "utf8");

    const out = await readFindings(root, PR);
    assert.deepEqual([...out.keys()], ["f_1"], "the good finding still reads");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("and neither is one with a blank principal, or no id", async () => {
  const root = tmp();
  try {
    const file = join(root, shardFor(SCOPE, izzie));
    mkdirSync(join(root, SCOPE), { recursive: true });
    writeFileSync(file, JSON.stringify(good) + "\n", "utf8");
    for (const bad of [
      { id: "0000000003-cc", kind: "finding.created", subject: "f_3", actor: { principal: "   " } },
      { id: "", kind: "finding.created", subject: "f_4", actor: izzie },
      { id: "0000000005-ee", kind: "finding.created", subject: "f_5", actor: null },
    ]) appendFileSync(file, JSON.stringify(bad) + "\n", "utf8");

    assert.deepEqual([...(await readFindings(root, PR)).keys()], ["f_1"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
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
      citations: [{ anchorId: "a_1", acceptedHashes: ["h2:sha256:abc"] }],
    });
    await publishDocVersion(side, U, izzie, {
      nodeId: "n_bad", type: "concept", title: "t", summary: "s", body: "b",
      citations: "bad" as unknown as [],
    });

    const docs = await readDocs(side, U);
    assert.deepEqual([...docs.keys()], ["n_good"], "the healthy doc survives its neighbour");
    assert.equal(docs.get("n_good")!.versions[0]!.citations.length, 1);
  } finally { rmSync(side, { recursive: true, force: true }); }
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
  } finally { rmSync(side, { recursive: true, force: true }); }
});
