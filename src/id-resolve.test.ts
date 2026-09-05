/**
 * Resolving an id the way `git` resolves a commit — and refusing where it must.
 *
 * Everyone runs the web UI locally, so a link carries a port that is only true for
 * whoever copied it; the id is the handle that survives leaving the machine. That only
 * works if the half a person actually copies resolves, which it did not: the suffix of
 * `f_00mt93q2i0-cc017f2546` looks like a checksum, so the prefix is what gets pasted,
 * and it failed as `no finding "f_00mt93q2i0"` — which says the record does not exist.
 *
 * Every case here is one the resolver must get wrong in a specific, silent way if the
 * rule it encodes is dropped. The one that matters most is EXACT BEATS PREFIX: without
 * it, holding a complete id becomes the ambiguous case the moment a longer id shares its
 * front, which is the opposite of what a full id is for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexBlob } from "./repo.js";
import { writeStore, writeLocalFinding, resolveRecordId, idsStartingWith } from "./store.js";
import type { State, Actor } from "./schema.js";
import type { SharedFinding } from "./shared-findings.js";
import { discard } from "./test-tmp.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const SRC = "export function creditLine(cents) {\n  return cents * 2;\n}\n";
const PERSON: Actor = { principal: "izzie@x.com" };

async function universe() {
  const root = mkdtempSync(join(tmpdir(), "codemap-idres-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/credit.js"), SRC, "utf8");
  const anchors = await indexBlob(SRC, "src/credit.js");
  await writeStore(root, anchors, state);
  return { root, anchorId: anchors[0]!.id };
}

const finding = (id: string, over: Partial<SharedFinding> = {}): SharedFinding => ({
  id, target: { kind: "anchor", id: "a_x" }, text: "", comment: "a defect",
  author: PERSON, createdAt: "2026-08-01T00:00:00Z",
  state: "created", corroboration: [], thread: [], revisions: [], ...over,
} as SharedFinding);

test("the prefix a person actually copies resolves to the finding", async () => {
  const { root } = await universe();
  try {
    await writeLocalFinding(root, finding("f_00mt93q2i0-cc017f2546"), "264");
    const r = resolveRecordId(root, "f_00mt93q2i0");
    assert.deepEqual(r, { match: { kind: "finding", id: "f_00mt93q2i0-cc017f2546", pr: "264" } });
  } finally { discard(root); }
});

/**
 * The case that makes a full id worth holding. `f_00mt93q2i0` is BOTH a complete id and
 * the front of a longer one here; prefix-first would call that ambiguous and refuse to
 * resolve the very thing the caller has in hand.
 */
test("an exact id beats a longer one that starts with it", async () => {
  const { root } = await universe();
  try {
    await writeLocalFinding(root, finding("f_00mt93q2i0"), "264");
    await writeLocalFinding(root, finding("f_00mt93q2i0-cc017f2546"), "264");
    assert.deepEqual(resolveRecordId(root, "f_00mt93q2i0"),
      { match: { kind: "finding", id: "f_00mt93q2i0", pr: "264" } });
    // And the shared front is still ambiguous for anyone who did not type the whole thing.
    const short = resolveRecordId(root, "f_00mt93");
    assert.ok(short && "ambiguous" in short && short.ambiguous.length === 2);
  } finally { discard(root); }
});

test("two records behind one prefix are refused, not picked", async () => {
  const { root } = await universe();
  try {
    await writeLocalFinding(root, finding("f_00mt93q2i0-aaaaaaaaaa"), "264");
    await writeLocalFinding(root, finding("f_00mt93q2i0-bbbbbbbbbb"), "264");
    const r = resolveRecordId(root, "f_00mt93q2i0");
    assert.ok(r && "ambiguous" in r, "a prefix matching two findings must not resolve to one");
    assert.deepEqual(r.ambiguous.map((h) => h.id).sort(),
      ["f_00mt93q2i0-aaaaaaaaaa", "f_00mt93q2i0-bbbbbbbbbb"]);
  } finally { discard(root); }
});

/**
 * `(pr, id)` is a finding's identity — `ix_findings_identity` is unique on the pair
 * precisely because a log can carry one id in two pull requests. An id-only resolver
 * that returned the first row would hand one reviewer's finding to another.
 */
test("one id on two pull requests is ambiguous, and says which", async () => {
  const { root } = await universe();
  try {
    await writeLocalFinding(root, finding("f_00mt93q2i0-cc017f2546"), "264");
    await writeLocalFinding(root, finding("f_00mt93q2i0-cc017f2546"), "271");
    const r = resolveRecordId(root, "f_00mt93q2i0-cc017f2546");
    assert.ok(r && "ambiguous" in r);
    assert.deepEqual(r.ambiguous.map((h) => h.pr).sort(), ["264", "271"]);
  } finally { discard(root); }
});

/**
 * The old `prefix.length < 6` guard measured the whole string, which means it measured a
 * different thing per kind: `bug_` and `finding_` eat four and eight characters that `f_`
 * does not. So it admitted `bug_00` — two characters of body — and held `f_00mt`, with
 * four, to the same bar as `bug_00mt93`, which has six. Counting the body is what makes
 * the threshold mean one thing across every id shape in the store.
 */
test("the minimum length counts the id BODY, not the kind tag", async () => {
  const { root } = await universe();
  try {
    await writeLocalFinding(root, finding("f_00mt93q2i0-cc017f2546"), "264");
    assert.ok(resolveRecordId(root, "f_00mt93"), "six characters of body is a prefix worth trying");
    assert.equal(resolveRecordId(root, "f_00mt9"), null, "five is not");
    // Same body length, longer string: the old guard would have judged these differently.
    await writeLocalFinding(root, finding("bug_00mt93q2i0"), "264");
    assert.equal(resolveRecordId(root, "bug_00"), null, "two characters of body is not a prefix");
  } finally { discard(root); }
});

/**
 * `_` is LIKE's single-character wildcard and every id in this store contains one, so an
 * unescaped pattern turns the kind tag into a match-all.
 */
test("the underscore in an id is a literal, not a wildcard", async () => {
  const { root } = await universe();
  try {
    await writeLocalFinding(root, finding("f_00mt93q2i0"), "264");
    assert.equal(resolveRecordId(root, "fx00mt93q2i0"), null,
      "`_` must not match `x` — that is LIKE's wildcard leaking into an id lookup");
  } finally { discard(root); }
});

/** Anchors are keyed `(ref, id)`, so an unrestricted scan reports one id once per snapshot. */
test("an anchor resolves once, not once per cached snapshot", async () => {
  const { root, anchorId } = await universe();
  try {
    assert.deepEqual(resolveRecordId(root, anchorId), { match: { kind: "anchor", id: anchorId } });
    assert.deepEqual(resolveRecordId(root, anchorId.slice(0, 12)),
      { match: { kind: "anchor", id: anchorId } });
  } finally { discard(root); }
});

/**
 * The trap that made this silent for every document in the store.
 *
 * There are two node tables. `nodes` is a legacy shape the versioned-docs migration
 * DRAINS, so on any store written since it is empty; live docs are rows in
 * `node_versions` keyed by `node_id`. A resolver pointed at the first matched no
 * document at all while every doc page kept rendering perfectly — nothing failed, ids
 * just never resolved. Caught by executing it against a doc the real writer produced,
 * which is the only way it could have been caught.
 */
test("a document resolves — from the table docs are actually in", async () => {
  const { root, anchorId } = await universe();
  try {
    const { document: documentNode } = await import("./ops.js");
    await documentNode(root, {
      type: "concept", title: "Transfer rules", summary: "how a transfer lands",
      body: "transfer() is the only entry point.", anchors: [anchorId],
    });
    assert.deepEqual(resolveRecordId(root, "transfer-rules"),
      { match: { kind: "node", id: "transfer-rules" } });
  } finally { discard(root); }
});

test("nothing matching resolves to nothing", async () => {
  const { root } = await universe();
  try {
    assert.equal(resolveRecordId(root, "f_nothinghere"), null);
    assert.equal(resolveRecordId(root, ""), null);
  } finally { discard(root); }
});

/** The refusal paths print ids; they must keep getting ids, whichever way it resolved. */
test("`did you mean` still answers with ids for both outcomes", async () => {
  const { root } = await universe();
  try {
    await writeLocalFinding(root, finding("f_00mt93q2i0-aaaaaaaaaa"), "264");
    assert.deepEqual(idsStartingWith(root, "f_00mt93q2i0"), ["f_00mt93q2i0-aaaaaaaaaa"]);
    await writeLocalFinding(root, finding("f_00mt93q2i0-bbbbbbbbbb"), "264");
    assert.deepEqual(idsStartingWith(root, "f_00mt93q2i0").sort(),
      ["f_00mt93q2i0-aaaaaaaaaa", "f_00mt93q2i0-bbbbbbbbbb"]);
  } finally { discard(root); }
});
