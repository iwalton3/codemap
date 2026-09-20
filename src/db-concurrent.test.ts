/**
 * Two processes opening one store at the same moment (owner, Ruling 8: transactional per
 * ref + wait).
 *
 * The store upgrades itself on open, and that path had two defects with one trigger:
 *
 * - LOUD. `upgrade` ran the migrations inside a `SAVEPOINT`, which is a DEFERRED
 *   transaction: the first read takes a read snapshot and the first write tries to upgrade
 *   it, which fails with `SQLITE_BUSY_SNAPSHOT` if anyone wrote in between — an error
 *   `busy_timeout` does NOT wait out. `db()` is on every MCP call, every web request and
 *   every CLI verb, so the loser got `database is locked` simply for opening the store.
 *
 * - SILENT, and worse. `compactLegacySnapshots` read a ref's rows in autocommit and
 *   `putSnapshotSets` opens by DELETING that ref's sets, so a process reading a ref the
 *   other had already converted wrote the empty result over a complete snapshot. Nothing
 *   said so: the `snapshots` row survived with its original count.
 *
 * WHAT IS AND IS NOT PINNED HERE, because the difference matters more than usual.
 *
 * Pinned: the lock is taken up front, and two real processes both open a legacy store
 * with every snapshot intact. Both fail if `tx` goes back to a deferred transaction.
 *
 * NOT pinned: the empty-rows guard inside the compaction. The race is not a usable check
 * for the silent arm — 14 staggers in one sitting reproduced it zero times, historically
 * about one run in six — and now that the lock is taken first the interleaving cannot
 * happen within a process at all, so removing that guard leaves this file green. It stays
 * because the REFS LIST is still read in autocommit: another process converting a ref
 * between the list and our read leaves zero rows, and writing that empty result is the
 * wipe. It is defence in depth against a window no test here can open.
 *
 * The silent arm's HARM is closed separately and unconditionally, by `snapshotRefusal`
 * refusing to serve a snapshot that records anchors and holds none — that one has a
 * deterministic check, in `snapshot-refusal.test.ts`, and it holds whatever caused the
 * disagreement.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { db, tx, closeDb } from "./db.js";
import { discard } from "./test-tmp.js";

// A file:// URL, not a path: `import("C:\\\\...")` is ERR_UNSUPPORTED_ESM_URL_SCHEME on
// Windows. And derived from this module rather than `process.cwd()`, which is only the repo
// root by convention. Same shape as `oracle-race.test.ts`, which spawns a helper the same way.
const HERE = dirname(fileURLToPath(import.meta.url));

const root = () => {
  const r = mkdtempSync(join(tmpdir(), "codemap-conc-"));
  mkdirSync(join(r, ".codemap"), { recursive: true });
  return r;
};

test("a top-level transaction takes the WRITE lock before it reads", async () => {
  const r = root();
  try {
    const d = db(r);
    // A second connection that will not wait, so "locked out" is observable in
    // milliseconds rather than after the five-second busy timeout.
    const other = new DatabaseSync(join(r, ".codemap", "codemap.db"));
    other.exec("PRAGMA busy_timeout=0");
    try {
      let checked = false;
      tx(d, () => {
        // NOTHING has been written in this transaction yet. Under the old deferred form
        // the lock was still free here, so another process could write — and this one's
        // first write would then fail with BUSY_SNAPSHOT, which cannot be waited out.
        assert.throws(
          () => other.exec("BEGIN IMMEDIATE; INSERT OR REPLACE INTO meta(k,v) VALUES('probe','x'); COMMIT"),
          /locked|busy/i,
          "the writer's lock was not held before its first write",
        );
        checked = true;
        d.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('mine','y')").run();
      });
      assert.ok(checked);
      // And it is released afterwards, or the next caller inherits the lock.
      other.exec("BEGIN IMMEDIATE; INSERT OR REPLACE INTO meta(k,v) VALUES('after','z'); COMMIT");
    } finally { other.close(); }
  } finally { closeDb(r); discard(r); }
});

test("and it still nests, because half the writes in the tree are already inside one", async () => {
  const r = root();
  try {
    const d = db(r);
    tx(d, () => {
      tx(d, () => { d.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('inner','1')").run(); });
      // An inner rollback must not take the outer transaction with it.
      tx(d, () => { d.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('undone','2')").run(); return false; });
      d.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('outer','3')").run();
    });
    const got = (k: string) => (d.prepare("SELECT v FROM meta WHERE k = ?").get(k) as { v?: string } | undefined)?.v;
    assert.equal(got("inner"), "1");
    assert.equal(got("undone"), undefined, "the inner rollback stands");
    assert.equal(got("outer"), "3", "and the outer transaction committed");
  } finally { closeDb(r); discard(r); }
});

/**
 * A store in the OLD shape — one `anchors` row per anchor per commit — so that opening it
 * runs the compaction, which is the migration both defects lived in.
 */
function legacyStore(refs: number, perRef: number): string {
  const r = root();
  const d = db(r);
  closeDb(r);
  const raw = new DatabaseSync(join(r, ".codemap", "codemap.db"));
  raw.exec("BEGIN");
  const snap = raw.prepare("INSERT INTO snapshots(ref,branch,at,count,scheme,hash_scheme,dirty) VALUES(?,?,?,?,?,?,0)");
  const anc = raw.prepare("INSERT INTO anchors(ref,id,file,symbol_path,kind,body_hash) VALUES(?,?,?,?,?,?)");
  const { ANCHOR_SCHEME, HASH_SCHEME } = { ANCHOR_SCHEME: 1, HASH_SCHEME: 2 };
  for (let i = 0; i < refs; i++) {
    const ref = String(i).padStart(40, "0");
    snap.run(ref, "main", new Date().toISOString(), perRef, ANCHOR_SCHEME, HASH_SCHEME);
    for (let j = 0; j < perRef; j++) {
      anc.run(ref, `a_${i}_${j}`, `src/f${j % 20}.ts`, JSON.stringify([`s${j}`]), "function", `h2:0:sha256:${i}_${j}`);
    }
  }
  raw.exec("COMMIT");
  raw.close();
  return r;
}

test("two processes opening one store both succeed, and no snapshot is lost", async () => {
  const r = legacyStore(12, 150);
  try {
    const open = join(r, "open.mjs");
    writeFileSync(open, `
      const { db, closeAll } = await import(${JSON.stringify(pathToFileURL(join(HERE, "db.js")).href)});
      const t = Number(process.argv[3] ?? 0);
      const until = Date.now() + t; while (Date.now() < until) { /* stagger without a timer */ }
      try { db(process.argv[2]); console.log("ok"); closeAll(); }
      catch (e) { console.log("THREW " + e.message); process.exit(1); }
    `, "utf8");

    // `spawn`, not `spawnSync`: a synchronous spawn inside a promise executor still runs
    // to completion before the next one starts, so the two would never overlap and this
    // would test nothing while looking exactly like a concurrency test.
    const run = (ms: number) => new Promise<{ status: number | null; stdout: string }>((res) => {
      const p = spawn(process.execPath, ["--no-warnings", open, r, String(ms)], { encoding: "utf8" } as never);
      let stdout = "";
      p.stdout!.on("data", (c: Buffer) => { stdout += c.toString(); });
      p.on("close", (status) => res({ status, stdout }));
    });
    const [a, b] = await Promise.all([run(0), run(2)]);
    for (const [name, p] of [["A", a], ["B", b]] as const) {
      assert.equal(p.status, 0, `${name}: ${p.stdout}`);
      assert.match(p.stdout, /ok/, `${name} did not open the store`);
    }

    // Every snapshot still holds its anchors. The wipe left the `snapshots` row intact
    // with its original count, so counting rows is the only way to see it.
    const raw = new DatabaseSync(join(r, ".codemap", "codemap.db"));
    try {
      const rows = raw.prepare("SELECT ref, count FROM snapshots").all() as { ref: string; count: number }[];
      assert.equal(rows.length, 12);
      for (const s of rows) {
        const n = (raw.prepare("SELECT COUNT(*) c FROM snapshot_anchor_rows WHERE ref = ?").get(s.ref) as { c: number }).c;
        assert.equal(n, s.count, `snapshot ${s.ref.slice(0, 8)} records ${s.count} anchors and holds ${n}`);
      }
    } finally { raw.close(); }
  } finally { closeDb(r); discard(r); }
});
