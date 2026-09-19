/**
 * The store is copied before any migration that changes it, and copies older than two
 * days are pruned (owner, 2026-09-19). The snapshot compaction is the case that made it
 * necessary: an older build reads a compacted store's snapshots as EMPTY.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { db, closeDb, BACKUP_DIR, BACKUP_RETENTION_MS } from "./db.js";
import { discard } from "./test-tmp.js";

const SHA = "a".repeat(40);

function store(): { root: string; backups: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "codemap-backup-"));
  db(root);
  closeDb(root);
  return { root, backups: join(root, ".codemap", BACKUP_DIR), cleanup: () => { closeDb(root); discard(root); } };
}

const raw = (root: string, f: (d: DatabaseSync) => void) => {
  const d = new DatabaseSync(join(root, ".codemap", "codemap.db"));
  try { f(d); } finally { d.close(); }
};

/** A snapshot stored the pre-compaction way: one `anchors` row per anchor, under the commit. */
function legacySnapshot(root: string): void {
  raw(root, (d) => {
    d.prepare("INSERT INTO anchors(ref,id,file,symbol_path,kind,body_hash) VALUES(?,?,?,?,?,?)")
      .run(SHA, "a_1", "src/a.ts", '["alpha"]', "function", "sha256:x");
    d.prepare("INSERT INTO snapshots(ref) VALUES(?)").run(SHA);
  });
}

const listing = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

test("a new store and an up-to-date one are opened without a copy", () => {
  const s = store();
  try {
    db(s.root); closeDb(s.root);
    assert.deepEqual(listing(s.backups), []);
  } finally { s.cleanup(); }
});

test("a migration that changes the store copies it first, as it was", () => {
  const s = store();
  try {
    legacySnapshot(s.root);
    const d = db(s.root);
    assert.equal((d.prepare("SELECT COUNT(*) n FROM anchors WHERE ref = ?").get(SHA) as { n: number }).n, 0, "compacted");
    const copies = listing(s.backups);
    assert.equal(copies.length, 1, String(copies));
    assert.match(copies[0]!, /^codemap-\d{8}T\d{6}Z-\d+\.db$/);
    const b = new DatabaseSync(join(s.backups, copies[0]!), { readOnly: true });
    try {
      assert.equal((b.prepare("SELECT COUNT(*) n FROM anchors WHERE ref = ?").get(SHA) as { n: number }).n, 1,
        "the copy is the store BEFORE the migration");
    } finally { b.close(); }

    closeDb(s.root); db(s.root);
    assert.equal(listing(s.backups).length, 1, "the next open is a no-op and copies nothing");
  } finally { s.cleanup(); }
});

test("a schema change counts: an ALTER on an older table copies the store", () => {
  const s = store();
  try {
    // A store from before `snapshots.dirty`: the ALTER in `migrate` has to put it back.
    raw(s.root, (d) => d.exec("ALTER TABLE snapshots DROP COLUMN dirty"));
    db(s.root);
    assert.equal(listing(s.backups).length, 1);
  } finally { s.cleanup(); }
});

test("a blob no build can parse is left alone, and leaving it alone is not a migration", () => {
  const s = store();
  try {
    raw(s.root, (d) => d.prepare("INSERT INTO meta(k,v) VALUES('triage', '{not json')").run());
    const d = db(s.root);
    assert.equal((d.prepare("SELECT v FROM meta WHERE k = 'triage'").get() as { v: string }).v, "{not json");
    assert.deepEqual(listing(s.backups), []);
  } finally { s.cleanup(); }
});

test("no copy, no upgrade: a backup that cannot be written leaves the store as it was", () => {
  const s = store();
  try {
    legacySnapshot(s.root);
    writeFileSync(s.backups, "a file where the directory should be");
    assert.throws(() => db(s.root), /could not back up .* has not been upgraded/);
    raw(s.root, (d) => assert.equal(
      (d.prepare("SELECT COUNT(*) n FROM anchors WHERE ref = ?").get(SHA) as { n: number }).n, 1));
  } finally { s.cleanup(); }
});

test("copies older than the retention period are pruned on open, newer ones kept", () => {
  const s = store();
  try {
    mkdirSync(s.backups, { recursive: true });
    const age = (name: string, ms: number) => {
      writeFileSync(join(s.backups, name), "");
      const t = (Date.now() - ms) / 1000;
      utimesSync(join(s.backups, name), t, t);
    };
    age("codemap-20260101T000000Z-1.db", BACKUP_RETENTION_MS + 60_000);
    age("codemap-20260101T000000Z-2.db.tmp", BACKUP_RETENTION_MS + 60_000);
    age("codemap-20260102T000000Z-3.db", BACKUP_RETENTION_MS - 60_000);
    age("somebody-elses.db", BACKUP_RETENTION_MS * 10);
    db(s.root);
    assert.deepEqual(listing(s.backups).sort(), ["codemap-20260102T000000Z-3.db", "somebody-elses.db"]);
  } finally { s.cleanup(); }
});
