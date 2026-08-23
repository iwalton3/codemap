import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor } from "./schema.js";
import { readScope } from "./eventlog.js";
import { createFinding, foldFindings, findingScope, comment } from "./shared-findings.js";
import { readCached, scopeFingerprint } from "./materialize.js";
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
    const v = (id: string, title: string) => ({
      nodeId: "n_pay", versionId: id, type: "process" as const, title, summary: "s", body: "b",
      citations: [{ anchorId: "a_1", acceptedHashes: [] }],
      createdCommit: null, createdBranch: null, createdAt: "2026-01-01T00:00:00Z",
    });
    // publishDocVersion MINTS the id; the caller does not choose it.
    const id1 = await publishDocVersion(logRoot, U, izzie, v("ignored", "first") as never);
    const id2 = await publishDocVersion(logRoot, U, dana, v("ignored", "second") as never);

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
