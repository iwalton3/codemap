import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { db } from "./db.js";

/**
 * A store written by an older codemap, at the schema before the provenance columns.
 *
 * The whole point is that `node_versions` exists WITHOUT them: `CREATE TABLE IF NOT
 * EXISTS` is then a no-op, so anything in the create block that assumes a new column
 * runs against the old table.
 */
function legacyStore(): string {
  const root = mkdtempSync(join(tmpdir(), "codemap-legacy-"));
  mkdirSync(join(root, ".codemap"), { recursive: true });
  const d = new DatabaseSync(join(root, ".codemap", "codemap.db"));
  d.exec(`
    CREATE TABLE node_versions (
      version_id TEXT PRIMARY KEY, node_id TEXT NOT NULL,
      type TEXT, title TEXT, summary TEXT, body TEXT, generated_by TEXT,
      created_commit TEXT, created_branch TEXT, created_at TEXT,
      citations TEXT, removed INTEGER DEFAULT 0
    );
    INSERT INTO node_versions(version_id,node_id,type,title,summary,body,created_at,citations)
      VALUES('nv_old','n_old','concept','Old','s','b','2026-01-01T00:00:00Z','[]');
  `);
  d.close();
  return root;
}

test("a store from before the provenance columns still opens", () => {
  // Found by opening a real one, not by a test: an index on `source_scope` sat in the
  // CREATE block, which runs BEFORE the ALTER ladder that adds the column. Fresh
  // databases were fine — their CREATE TABLE has it — so the entire suite passed while
  // no existing store could be opened at all. Every test starting from empty is
  // exactly the blind spot.
  const root = legacyStore();
  try {
    const d = db(root);
    const cols = (d.prepare("PRAGMA table_info(node_versions)").all() as unknown as { name: string }[])
      .map((c) => c.name);
    for (const col of ["origin", "source_scope", "publication_state", "ord", "author"]) {
      assert.ok(cols.includes(col), `the ladder added ${col}`);
    }
    // CONTROL — the row that was already there is still there, with its content. A
    // "migration" that dropped and recreated the table would pass the check above.
    const row = d.prepare("SELECT node_id, body, origin FROM node_versions WHERE version_id = 'nv_old'")
      .get() as { node_id: string; body: string; origin: string | null };
    assert.equal(row.node_id, "n_old");
    assert.equal(row.body, "b");
    assert.equal(row.origin, null, "and an existing local row is not retroactively fold-owned");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
