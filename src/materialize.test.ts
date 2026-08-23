import { test } from "node:test";
import { testEvent } from "./test-events.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor } from "./schema.js";
import { readScope, type LogEvent } from "./eventlog.js";
import { createFinding, foldFindings, findingScope, comment } from "./shared-findings.js";
import { createHash } from "node:crypto";
import { readCached as readCachedChecked, scopeFingerprint, MATERIALIZER_VERSION, type Projection } from "./materialize.js";

/**
 * The value half of a cached read.
 *
 * `readCached` returns the scope's STATUS with its value, deliberately, so no
 * surface can answer from a blocked scope without having seen that it is one. Most
 * tests here are about the caching itself; the status has its own, at the bottom.
 */
const readCached = async <T>(
  root: string, logRoot: string, scope: string, identity: string,
  fold: (events: LogEvent[]) => T, proj: Projection<T>,
): Promise<T> => (await readCachedChecked(root, logRoot, scope, identity, fold, proj)).value;
import { findingsProjection, docsProjection } from "./shared-projections.js";

/**
 * A materialized fold is a cache, and "it's only a cache" is exactly the sentence
 * that stops someone testing it properly. A materializer bug does not lose data —
 * it returns WRONG shared state, from rows that look perfectly well formed.
 *
 * What protects it is this equivalence — fold directly, fold through the cache,
 * assert they agree — plus transactional replacement. Not its disposability.
 * See PROPOSAL-sidecar-materialization.md §7 step 1.
 */

const izzie: Actor = { principal: "izzie@x.com" };
const dana: Actor = { principal: "dana@x.com" };
const tmp = (t: string) => mkdtempSync(join(tmpdir(), `codemap-mz-${t}-`));
const PR = 264;
const ID = "/tmp/sidecar-under-test";

const fixture = async () => {
  const logRoot = tmp("log"), root = tmp("repo");
  const a = await createFinding(logRoot, PR, izzie, {
    targetKind: "anchor", targetId: "a_1", text: "the retry is not idempotent", comment: "please look",
  } as never);
  await createFinding(logRoot, PR, dana, {
    targetKind: "node", targetId: "n_pay", text: "this flow drops the tender", comment: "and here",
  } as never);
  await comment(logRoot, PR, dana, a, "agreed, and it double-charges");
  return { logRoot, root, cleanup: () => [logRoot, root].forEach((r) => rmSync(r, { recursive: true, force: true })) };
};

/**
 * Equivalence is asserted THROUGH JSON, because the projection stores JSON — so
 * the honest claim is "the projection preserves everything JSON preserves", and
 * comparing the serialized forms catches both content and ordering. A fold that
 * started returning something JSON cannot carry (a Map, a Date) would fail here,
 * which is the case worth catching.
 */
const same = (a: Map<string, unknown>, b: Map<string, unknown>, why: string) =>
  assert.equal(JSON.stringify([...a]), JSON.stringify([...b]), why);

test("the cached fold equals the direct fold", async () => {
  const f = await fixture();
  try {
    const scope = findingScope(PR);
    const direct = foldFindings(await readScope(f.logRoot, scope));
    const cached = await readCached(f.root, f.logRoot, scope, ID, foldFindings, findingsProjection);
    same(cached, direct, "a miss must fold and return the same answer");

    // And again, this time served from rows rather than events.
    let folds = 0;
    const counted = await readCached(f.root, f.logRoot, scope, ID, (e) => { folds++; return foldFindings(e); }, findingsProjection);
    assert.equal(folds, 0, "an unchanged scope must not re-fold");
    same(counted, direct, "and the rows must rebuild the same value");
  } finally { f.cleanup(); }
});

test("an appended event invalidates the scope", async () => {
  const f = await fixture();
  try {
    const scope = findingScope(PR);
    await readCached(f.root, f.logRoot, scope, ID, foldFindings, findingsProjection);

    await createFinding(f.logRoot, PR, izzie, {
      targetKind: "anchor", targetId: "a_2", text: "and this one too", comment: "third",
    } as never);

    let folds = 0;
    const after = await readCached(f.root, f.logRoot, scope, ID, (e) => { folds++; return foldFindings(e); }, findingsProjection);
    assert.equal(folds, 1, "the fingerprint must notice a new event");
    same(after, foldFindings(await readScope(f.logRoot, scope)), "and the answer must match a direct fold");
    assert.equal(after.size, 3);
  } finally { f.cleanup(); }
});

/**
 * The identity half of the key. Pointing a universe at a different sidecar must not
 * reuse rows folded from the first one — the scope NAME is the same, and nothing
 * else in the key would notice.
 */
test("a different sidecar identity cannot reuse the rows", async () => {
  const f = await fixture();
  try {
    const scope = findingScope(PR);
    await readCached(f.root, f.logRoot, scope, ID, foldFindings, findingsProjection);
    let folds = 0;
    await readCached(f.root, f.logRoot, scope, "/tmp/some-other-sidecar", (e) => { folds++; return foldFindings(e); }, findingsProjection);
    assert.equal(folds, 1, "same scope, different sidecar — the rows are not about this one");
  } finally { f.cleanup(); }
});

/**
 * Fingerprint, fold, fingerprint again. A scope that moves WHILE it is folded must
 * not be stored: the rows describe an input set that no longer exists, and writing
 * them under the new fingerprint would claim they describe the new one.
 */
test("a scope that moves during the fold is not cached under the new key", async () => {
  const f = await fixture();
  try {
    const scope = findingScope(PR);
    const dir = join(f.logRoot, scope);
    const { readdirSync } = await import("node:fs");
    const shard = readdirSync(dir).find((n) => n.endsWith(".ndjson"))!;

    let folds = 0;
    const value = await readCached(f.root, f.logRoot, scope, ID, (e) => {
      folds++;
      // Append DURING the fold, exactly once — the race the re-fingerprint closes.
      if (folds === 1) appendFileSync(join(dir, shard), JSON.stringify({ id: "zzz", kind: "noise", subject: "x", actor: izzie, at: "t" }) + "\n");
      return foldFindings(e);
    }, findingsProjection);
    assert.ok(folds >= 2, "the move must be detected and the fold retried");
    same(value, foldFindings(await readScope(f.logRoot, scope)), "and the answer is the one for the settled input");
  } finally { f.cleanup(); }
});

test("an empty scope fingerprints without throwing", async () => {
  const f = await fixture();
  try {
    const fp = await scopeFingerprint(f.logRoot, "findings/does-not-exist", ID);
    assert.match(fp, /^[0-9a-f]{64}$/, "a scope with no shards is a legitimate answer, not an error");
    const empty = await readCached(f.root, f.logRoot, "findings/does-not-exist", ID, foldFindings, findingsProjection);
    assert.equal(empty.size, 0);
  } finally { f.cleanup(); }
});

/**
 * Docs are the projection with something JSON cannot carry.
 *
 * `SharedDoc.authors` is a Map — `JSON.stringify` renders it `{}` — and `versions`
 * is ordered, which a table is not. Both get columns. This is the test that would
 * have caught storing them naively, and it is the reason the equivalence assertion
 * compares serialized forms rather than spot-checking fields.
 */
test("a doc's authors Map and version order survive the round trip", async () => {
  const logRoot = tmp("dlog"), root = tmp("drepo");
  try {
    const { publishDocVersion, readDocs, foldDocs, docScope } = await import("./shared-docs.js");
    const U = "acme/api";
    const v = (title: string) => ({
      nodeId: "n_pay", type: "process" as const, title, summary: "s", body: "b",
      citations: [{ anchorId: "a_1", acceptedHashes: [] }],
      createdCommit: null, createdBranch: null,
    });
    // No id passed, so each is minted — two versions cannot share one.
    const id1 = await publishDocVersion(logRoot, U, izzie, v("first") as never);
    const id2 = await publishDocVersion(logRoot, U, dana, v("second") as never);

    const scope = docScope(U);
    const direct = foldDocs(await readScope(logRoot, scope));
    const cached = await readCached(root, logRoot, scope, ID, foldDocs, docsProjection);

    const doc = cached.get("n_pay")!;
    assert.deepEqual(doc.versions.map((x) => x.title), ["first", "second"], "order is not a table property — it needs a column");
    assert.equal(doc.authors.get(id1)?.principal, izzie.principal, "and a Map does not survive JSON.stringify");
    assert.equal(doc.authors.get(id2)?.principal, dana.principal);
    assert.equal(doc.authors.size, direct.get("n_pay")!.authors.size);

    // Served from rows this time, and still the same.
    let folds = 0;
    const again = await readCached(root, logRoot, scope, ID, (e) => { folds++; return foldDocs(e); }, docsProjection);
    assert.equal(folds, 0);
    assert.deepEqual(again.get("n_pay")!.authors, doc.authors);
    assert.equal(JSON.stringify(again.get("n_pay")!.versions), JSON.stringify(direct.get("n_pay")!.versions));
  } finally { [logRoot, root].forEach((r) => rmSync(r, { recursive: true, force: true })); }
});

test("the citation edge table is populated for the step-3b join", async () => {
  const logRoot = tmp("clog"), root = tmp("crepo");
  try {
    const { publishDocVersion, foldDocs, docScope } = await import("./shared-docs.js");
    const { db } = await import("./db.js");
    const U = "acme/api";
    const vid = await publishDocVersion(logRoot, U, izzie, {
      nodeId: "n_pay", type: "process", title: "t", summary: "s", body: "b",
      citations: [{ anchorId: "a_1", acceptedHashes: [] }, { anchorId: "a_2", acceptedHashes: [] }],
      createdCommit: null, createdBranch: null,
    } as never);
    await readCached(root, logRoot, docScope(U), ID, foldDocs, docsProjection);
    const rows = db(root).prepare("SELECT anchor_id FROM shared_doc_citation WHERE version_id = ? ORDER BY anchor_id").all(vid) as unknown as { anchor_id: string }[];
    assert.deepEqual(rows.map((r) => r.anchor_id), ["a_1", "a_2"],
      "lifted out of the JSON so an anchor lookup can be an index seek");
  } finally { [logRoot, root].forEach((r) => rmSync(r, { recursive: true, force: true })); }
});

/**
 * A row the projection cannot read must NOT be silently skipped.
 *
 * The fingerprint is over the sidecar's shards, so nothing about a damaged DB row
 * moves it: a `read` that drops what it cannot parse serves an incomplete answer on
 * every subsequent hit, forever, while looking like a cache hit. The comment used to
 * claim the fold would rerun and replace it. It would not.
 */
test("a corrupt projection row invalidates the scope instead of vanishing", async () => {
  const f = await fixture();
  try {
    const { db } = await import("./db.js");
    const scope = findingScope(PR);
    const first = await readCached(f.root, f.logRoot, scope, ID, foldFindings, findingsProjection);
    assert.equal(first.size, 2);

    // Damage a row without touching the log.
    db(f.root).prepare("UPDATE shared_finding SET body = ? WHERE scope = ?").run("{not json", scope);

    let folds = 0;
    const after = await readCached(f.root, f.logRoot, scope, ID, (e) => { folds++; return foldFindings(e); }, findingsProjection);
    assert.equal(folds, 1, "unreadable rows are a miss, not an empty answer");
    same(after, foldFindings(await readScope(f.logRoot, scope)), "and the re-fold restores the whole scope");
  } finally { f.cleanup(); }
});

/** The third projection. Notes had no round-trip test; §7 asks for one per entity. */
test("notes round-trip through the projection", async () => {
  const logRoot = tmp("nlog"), root = tmp("nrepo");
  try {
    const { createNote, foldNotes, noteScope, bucketFor } = await import("./shared-notes.js");
    const { notesProjection } = await import("./shared-projections.js");
    const U = "acme/api";
    const target = "a_1";
    await createNote(logRoot, U, izzie, { targetKind: "anchor", targetId: target, text: "costly to work out", kind: "note" } as never);
    await createNote(logRoot, U, dana, { targetKind: "anchor", targetId: target, text: "and a question", kind: "question" } as never);

    const scope = noteScope(U, bucketFor(target));
    const direct = foldNotes(await readScope(logRoot, scope));
    const cached = await readCached(root, logRoot, scope, ID, foldNotes, notesProjection);
    same(cached, direct, "a miss folds and returns the same answer");

    let folds = 0;
    const hit = await readCached(root, logRoot, scope, ID, (e) => { folds++; return foldNotes(e); }, notesProjection);
    assert.equal(folds, 0);
    same(hit, direct, "and the rows rebuild it");
  } finally { [logRoot, root].forEach((r) => rmSync(r, { recursive: true, force: true })); }
});

/**
 * §7's other named case: a late parent arrives and REORDERS a scope that was
 * already folded. The projection has to match a fold of the settled input, not the
 * order the events happened to be written in.
 */
test("a late parent that reorders the scope is re-folded, not patched", async () => {
  const f = await fixture();
  try {
    const scope = findingScope(PR);
    const before = await readCached(f.root, f.logRoot, scope, ID, foldFindings, findingsProjection);
    const order = (m: Map<string, unknown>) => [...m.keys()].join(",");

    // A comment on the first finding, written to a shard as if it had arrived late.
    const a = [...before.keys()][0]!;
    await comment(f.logRoot, PR, izzie, a, "arriving after the others");

    const after = await readCached(f.root, f.logRoot, scope, ID, foldFindings, findingsProjection);
    const direct = foldFindings(await readScope(f.logRoot, scope));
    same(after, direct, "the cache must agree with a fold of the settled input");
    assert.equal(order(after), order(direct), "including the order the fold produces");
  } finally { f.cleanup(); }
});

// --- the scope's status rides with its value ------------------------------------

/**
 * §7 of PROPOSAL-provenance.md is a FAIL-CLOSED rule, and the way a fail-closed
 * rule fails in practice is a surface that never asked. So the status comes back
 * from `readCached` with the value, and — the part that needs testing — it survives
 * a cache HIT, where nothing re-reads the log to work it out again.
 */

/** Fork the writer's chain in place: a second event of theirs opening at GENESIS. */
const forkShard = (logRoot: string, scope: string) => {
  const dir = join(logRoot, scope);
  const name = readdirSync(dir).find((n) => n.endsWith(".ndjson"))!;
  const writer = name.replace(/\.ndjson$/, "");
  // Through `testEvent`, so the line is a WELL-FORMED protocol-1 event that happens
  // to fork. A hand-written literal missing the mandatory envelope is dropped at the
  // door instead, and the test then proves nothing — it passed for a while by
  // detecting no fork in a scope that had none.
  appendFileSync(join(dir, name), JSON.stringify(testEvent({
    id: "9999999999-ffffffffff", kind: "finding.commented", subject: "f_x",
    actor: izzie, at: "2026-08-23T00:00:00Z", writer, writerPrev: "GENESIS",
    data: { body: "from the copied clone" },
  })) + "\n");
};

test("a fork blocks the scope, and the value still comes back", async () => {
  const f = await fixture();
  try {
    const scope = findingScope(PR);
    forkShard(f.logRoot, scope);
    const read = await readCachedChecked(f.root, f.logRoot, scope, ID, foldFindings, findingsProjection);
    assert.equal(read.status, "blocked");
    assert.equal(read.diagnostic?.reason, "fork");
    assert.ok(read.value.size > 0, "non-authoritative, not hidden");
  } finally { f.cleanup(); }
});

test("the verdict survives a cache hit — the rows do not re-fold to find it again", async () => {
  const f = await fixture();
  try {
    const scope = findingScope(PR);
    forkShard(f.logRoot, scope);
    await readCachedChecked(f.root, f.logRoot, scope, ID, foldFindings, findingsProjection);
    let folds = 0;
    const hit = await readCachedChecked(f.root, f.logRoot, scope, ID,
      (e) => { folds++; return foldFindings(e); }, findingsProjection);
    assert.equal(folds, 0, "served from rows");
    assert.equal(hit.status, "blocked", "and the verdict came with them");
    assert.equal(hit.diagnostic?.reason, "fork");
  } finally { f.cleanup(); }
});

test("a healthy scope is complete, and says nothing else", async () => {
  // The control. A status that were always `blocked` would pass both tests above.
  const f = await fixture();
  try {
    const read = await readCachedChecked(f.root, f.logRoot, findingScope(PR), ID, foldFindings, findingsProjection);
    assert.deepEqual({ status: read.status, diagnostic: read.diagnostic }, { status: "complete", diagnostic: undefined });
  } finally { f.cleanup(); }
});

test("a scope that repairs itself stops being blocked", async () => {
  // The fingerprint moves when a shard does, so a stored `blocked` is not sticky:
  // it describes THOSE shards. Rewriting the shard without the second GENESIS is
  // what a rotation-and-repair leaves behind.
  const f = await fixture();
  try {
    const scope = findingScope(PR);
    const dir = join(f.logRoot, scope);
    const name = readdirSync(dir).find((n) => n.endsWith(".ndjson"))!;
    const before = readFileSync(join(dir, name), "utf8");
    forkShard(f.logRoot, scope);
    assert.equal((await readCachedChecked(f.root, f.logRoot, scope, ID, foldFindings, findingsProjection)).status, "blocked");
    writeFileSync(join(dir, name), before);
    assert.equal((await readCachedChecked(f.root, f.logRoot, scope, ID, foldFindings, findingsProjection)).status, "complete");
  } finally { f.cleanup(); }
});

// --- the fold's output, pinned ---------------------------------------------------

/**
 * A golden vector for the FOLD, guarding `MATERIALIZER_VERSION`.
 *
 * The cache key is the shards plus that number, so a fold that starts producing
 * something different while the number stands still serves stale rows to everyone
 * who has already folded that scope — indefinitely, because only the shards move
 * the fingerprint and they have not. Nothing about a code change touches the key.
 *
 * So this pins what the fold produces from a fixed log, and a failure here is a
 * QUESTION, not a defect: either the fold broke, or it legitimately changed and
 * `MATERIALIZER_VERSION` has to be bumped in the same commit. That is exactly the
 * shape `normalize.test.ts`'s golden vector gives `HASH_SCHEME`, and for the same
 * reason — a manual version number that can be forgotten is silent and total.
 *
 * The log deliberately exercises the two rules that a fold change is most likely
 * to touch: one person's two clones disagreeing (a contest, keyed on the writer)
 * and one person's two models disagreeing (two corroborations, keyed on the model).
 */
const GOLDEN_LOG: LogEvent[] = (() => {
  const dana: Actor = { principal: "dana@x.com" };
  const human: Actor = { principal: "izzie@x.com" };
  const opus: Actor = { principal: "izzie@x.com", via: { kind: "agent", model: "claude-opus-5" } };
  const sonnet: Actor = { principal: "izzie@x.com", via: { kind: "agent", model: "claude-sonnet-5" } };
  const e = (n: number, kind: string, actor: Actor, writer: string,
             data?: Record<string, unknown>, after?: string[]): LogEvent => testEvent({
    id: `000000000${n}-x`, kind, subject: "f_gold", actor,
    at: `2026-01-0${n}T00:00:00.000Z`, writer,
    ...(after ? { after } : {}), ...(data ? { data } : {}),
  });
  return [
    e(1, "finding.created", dana, "w_dana",
      { targetKind: "anchor", targetId: "a_1", text: "the retry is not idempotent", comment: "look", severity: "medium" }),
    e(2, "finding.corroborated", opus, "w_laptop", { verdict: "confirm", rationale: "reproduced" }, ["0000000001-x"]),
    e(3, "finding.corroborated", sonnet, "w_laptop", { verdict: "refute", rationale: "guarded upstream" }, ["0000000002-x"]),
    e(4, "finding.revised", human, "w_laptop", { now: { severity: "critical" }, was: { severity: "medium" } }, ["0000000003-x"]),
    // Not descended from 4: the desktop never saw it.
    e(5, "finding.revised", human, "w_desktop", { now: { severity: "low" }, was: { severity: "medium" } }, ["0000000001-x"]),
    e(6, "finding.commented", dana, "w_dana", { body: "which is it" }, ["0000000004-x", "0000000005-x"]),
  ];
})();

test("the fold's output is pinned — change it and bump MATERIALIZER_VERSION", () => {
  const folded = [...foldFindings(GOLDEN_LOG)];
  assert.equal(
    createHash("sha256").update(JSON.stringify(folded)).digest("hex").slice(0, 32),
    "f63820fba9d809da8d285f86eb81e0dc",
    "the fold produces something different from what MATERIALIZER_VERSION "
    + `${MATERIALIZER_VERSION} was set for — bump it, or fix the fold`,
  );
});

test("…and the vector actually contains the two rules it claims to", () => {
  // A golden hash that covered nothing interesting would pass forever. These are
  // the assertions the digest is standing in for.
  const f = foldFindings(GOLDEN_LOG).get("f_gold")!;
  assert.equal(f.corroboration.length, 2, "two models, two opinions");
  const c = (f.contested ?? []).find((c) => c.field === "severity");
  assert.ok(c, "two clones, one contest");
  assert.deepEqual([c.held.writer, c.incoming.writer], ["w_laptop", "w_desktop"]);
});
