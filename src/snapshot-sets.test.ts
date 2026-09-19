/**
 * Commit snapshots stored once per file content (docs/plan-review-before-pr.md, A4).
 *
 * Measured before this: ~8 MB per commit on a 1,840-file repo, never evicted, and every
 * commit an agent reads at adds one. Consecutive commits share almost every file, so the
 * store now keeps one copy of each file's anchors and a snapshot is the list of them.
 * What matters is that nothing READS differently, so every test here compares against a
 * fresh `indexCommit` of the same commit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { db, closeDb } from "./db.js";
import { indexCommit } from "./repo.js";
import { readSnapshot, buildSnapshot } from "./snapshots.js";
import { readCachedSnapshot, dropSnapshot, blobReuser, writeSnapshot } from "./store.js";
import type { Anchor } from "./schema.js";
import { discard } from "./test-tmp.js";

const FILES = 6;
const src = (i: number, v = 0) => `export function f${i}(x: number) {\n  return x + ${i} + ${v};\n}\n`;

function repo() {
  const root = mkdtempSync(join(tmpdir(), "codemap-sets-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".codemap"), { recursive: true });
  const git = (...a: string[]) => spawnSync("git", ["-c", "user.email=t@x.com", "-c", "user.name=t", ...a], { cwd: root, encoding: "utf8" }).stdout.trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, ".gitignore"), ".codemap/\n");
  for (let i = 0; i < FILES; i++) writeFileSync(join(root, `src/f${i}.ts`), src(i));
  git("add", "-A"); git("commit", "-q", "-m", "one");
  const c1 = git("rev-parse", "HEAD");
  writeFileSync(join(root, "src/f0.ts"), src(0, 1));   // one file changes
  git("add", "-A"); git("commit", "-q", "-m", "two");
  const c2 = git("rev-parse", "HEAD");
  return { root, c1, c2, cleanup: () => discard(root) };
}

// Through JSON: the indexer leaves `disambiguator: undefined` as an own key, which strict
// deep-equality counts, and storage (old layout or new) never kept.
const byId = (xs: Anchor[]) => JSON.parse(JSON.stringify([...xs].sort((a, b) => a.id.localeCompare(b.id))));
const count = (root: string, table: string) => (db(root).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test("a snapshot reads back exactly what a fresh index of the commit produces", async () => {
  const r = repo();
  try {
    for (const sha of [r.c1, r.c2]) {
      assert.deepEqual(byId((await readSnapshot(r.root, sha))!), byId((await indexCommit(r.root, sha))!));
    }
  } finally { r.cleanup(); }
});

test("two commits that share files store the shared files once", async () => {
  const r = repo();
  try {
    await readSnapshot(r.root, r.c1);
    const one = count(r.root, "anchor_sets");
    await readSnapshot(r.root, r.c2);
    const two = count(r.root, "anchor_sets");
    assert.equal(one, FILES, "one anchor per file");
    assert.equal(two, FILES + 1, "the second commit adds only the file it changed");
  } finally { r.cleanup(); }
});

test("a commit near one already cached parses only what changed", async () => {
  const r = repo();
  try {
    await readSnapshot(r.root, r.c1);
    const reuse = blobReuser(r.root);
    let hits = 0;
    const counting = (p: string, o: string) => { const x = reuse(p, o); if (x) hits++; return x; };
    const again = await indexCommit(r.root, r.c2, { reuse: counting });
    assert.equal(hits, FILES - 1, "every unchanged file came from the cache");
    assert.deepEqual(byId(again!), byId((await indexCommit(r.root, r.c2))!), "and the answer is the same");
  } finally { r.cleanup(); }
});

test("a cached set from another indexer build is not reused", async () => {
  const r = repo();
  try {
    await readSnapshot(r.root, r.c1);
    db(r.root).prepare("UPDATE blob_index SET deriv = 'an-older-build'").run();
    const reuse = blobReuser(r.root);
    let hits = 0;
    await indexCommit(r.root, r.c1, { reuse: (p, o) => { const x = reuse(p, o); if (x) hits++; return x; } });
    assert.equal(hits, 0);
  } finally { r.cleanup(); }
});

test("dropping a snapshot frees only what no other snapshot uses", async () => {
  const r = repo();
  try {
    await readSnapshot(r.root, r.c1);
    await readSnapshot(r.root, r.c2);
    dropSnapshot(r.root, r.c1);
    assert.equal(count(r.root, "anchor_sets"), FILES, "c1's old f0 is gone, the shared five stay");
    assert.deepEqual(byId((await readCachedSnapshot(r.root, r.c2))!), byId((await indexCommit(r.root, r.c2))!));
    assert.equal(
      (db(r.root).prepare("SELECT COUNT(*) AS n FROM blob_index WHERE fkey NOT IN (SELECT fkey FROM anchor_sets) AND fkey <> ''").get() as { n: number }).n,
      0, "no cache entry names a set that is gone — it would read as 'no anchors'",
    );
  } finally { r.cleanup(); }
});

test("a store with snapshots in the old layout is converted on open, and reads the same", async () => {
  const r = repo();
  try {
    const anchors = (await indexCommit(r.root, r.c1))!;
    // The old layout: one `anchors` row per anchor, under the commit's sha.
    const d = db(r.root);
    const ins = d.prepare("INSERT INTO anchors(ref,id,file,symbol_path,kind,disambiguator,body_hash,last_commit,start_byte,end_byte,start_line,end_line) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const a of anchors) {
      ins.run(r.c1, a.id, a.file, JSON.stringify(a.symbolPath), a.kind, a.disambiguator ?? null, a.bodyHash, null,
        a.loc?.startByte ?? null, a.loc?.endByte ?? null, a.loc?.startLine ?? null, a.loc?.endLine ?? null);
    }
    await writeSnapshot(r.root, "unrelated", null, [], new Date().toISOString());   // a snapshots row to keep company
    d.prepare("INSERT OR REPLACE INTO snapshots(ref,branch,at,count,scheme,hash_scheme,dirty) SELECT ?,branch,at,?,scheme,hash_scheme,0 FROM snapshots WHERE ref = 'unrelated'").run(r.c1, anchors.length);
    closeDb(r.root);

    const after = db(r.root);
    assert.equal((after.prepare("SELECT COUNT(*) AS n FROM anchors WHERE ref = ?").get(r.c1) as { n: number }).n, 0,
      "the per-commit rows are gone");
    const read = (await readCachedSnapshot(r.root, r.c1))!;
    // The fixture wrote no derivation column, as the oldest rows have none.
    const strip = (xs: Anchor[]) => byId(xs).map((a: Anchor) => ({ ...a, derivation: undefined }));
    assert.deepEqual(JSON.parse(JSON.stringify(strip(read))), JSON.parse(JSON.stringify(strip(anchors))));
  } finally { r.cleanup(); }
});

test("a rebuilt snapshot reuses the sets its previous build left", async () => {
  const r = repo();
  try {
    await readSnapshot(r.root, r.c1);
    const before = count(r.root, "anchor_sets");
    await buildSnapshot(r.root, r.c1);
    assert.equal(count(r.root, "anchor_sets"), before, "nothing duplicated by a rebuild");
  } finally { r.cleanup(); }
});

test("a snapshot's blob index is written in the snapshot's own transaction", async () => {
  // Triage run 2026-09-19-branch-review-round, J15: one autocommit per indexed file
  // (~1,840 WAL commits on Acme.API) on the path every `at:` read and PR open takes.
  const r = repo();
  const d = db(r.root);
  const prepare = d.prepare.bind(d);
  const outside: string[] = [];
  d.prepare = ((sql: string) => {
    const st = prepare(sql);
    if (!/blob_index|INTO snapshots/.test(sql)) return st;
    const run = st.run.bind(st);
    st.run = ((...a: unknown[]) => { if (!d.isTransaction) outside.push(sql.slice(0, 40)); return run(...(a as [])); }) as typeof st.run;
    return st;
  }) as typeof d.prepare;
  try {
    assert.ok(await buildSnapshot(r.root, r.c1));
    assert.deepEqual(outside, [], "every blob_index and snapshots write inside one transaction");
  } finally { d.prepare = prepare; r.cleanup(); }
});
