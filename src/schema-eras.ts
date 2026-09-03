/**
 * The store as it really was, one entry per schema era.
 *
 * Every fixture in this repository is born at the CURRENT schema, and that blind spot
 * has already shipped a build that could not open ANY pre-existing store (`c383a45`):
 * an index on `source_scope` sat in the `CREATE TABLE` block, which runs before the
 * ALTER ladder that adds the column. A fresh database has the column in its CREATE, so
 * the whole suite passed while `db()` threw `no such column` on every store anyone
 * actually had.
 *
 * **The SQL is transcribed from `src/db.ts`'s own history, not written by hand.** Each
 * era's statements were extracted verbatim from `git show <commit>:src/db.ts` and
 * stripped of comments; `db-eras.test.ts` re-extracts them and fails if a transcription
 * no longer matches the shape that commit really produced. A hand-invented "old schema"
 * tests the ladder against a store that never existed, which is how a migration test
 * passes while the migration is broken for everybody.
 *
 * Generated once and committed on purpose — `npm run unit` stays hermetic, and the
 * check against git is the part that skips when history is unavailable.
 */

import type { DatabaseSync } from "node:sqlite";

export interface SchemaEra {
  /** Short name, used in test output. */
  era: string;
  /** The commit whose `migrate()` produced this shape. */
  commit: string;
  /** That commit's subject line, so a reader can place it without leaving the file. */
  subject: string;
  /** What is interesting about this era — why a store from it is worth opening. */
  why: string;
  /** The statements `migrate()` executed at that commit, comments stripped. */
  sql: string[];
  /** Rows a real store of that era would hold, in the tables that existed then. */
  seed: string[];
}

export const SCHEMA_ERAS: SchemaEra[] = [
  {
    era: "genesis",
    commit: "c0d8b99",
    subject: "Initial commit: codemap semantic-map engine + MCP + web UI",
    why:
      "No `node_versions` at all — docs were unversioned rows in `nodes`. The oldest store anyone can have, and the one the `nodes` → `node_versions` back-fill has to run against.",
    sql: [
      "    CREATE TABLE IF NOT EXISTS anchors (\n      ref TEXT NOT NULL, id TEXT NOT NULL, file TEXT NOT NULL, symbol_path TEXT NOT NULL,\n      kind TEXT NOT NULL, disambiguator TEXT, body_hash TEXT NOT NULL, last_commit TEXT,\n      start_byte INTEGER, end_byte INTEGER, start_line INTEGER, end_line INTEGER,\n      PRIMARY KEY (ref, id)\n    );\n    CREATE INDEX IF NOT EXISTS ix_anchors_reffile ON anchors(ref, file);\n    CREATE TABLE IF NOT EXISTS nodes (\n      id TEXT PRIMARY KEY, type TEXT, title TEXT, summary TEXT, body TEXT,\n      anchors TEXT, generated_by TEXT\n    );\n    CREATE TABLE IF NOT EXISTS edges (\n      rowid INTEGER PRIMARY KEY, from_id TEXT, to_id TEXT, type TEXT, ord INTEGER, generated_by TEXT\n    );\n    CREATE INDEX IF NOT EXISTS ix_edges_from ON edges(from_id);\n    CREATE INDEX IF NOT EXISTS ix_edges_to ON edges(to_id);\n    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);\n    CREATE TABLE IF NOT EXISTS snapshots (ref TEXT PRIMARY KEY, branch TEXT, at TEXT, count INTEGER);",
    ],
    seed: [
      "INSERT INTO anchors(ref,id,file,symbol_path,kind,body_hash,start_byte,end_byte,start_line,end_line)\n     VALUES('@work','a_old','src/pay.ts','[\"transfer\"]','function','h1:sha256:abc',0,40,1,3);",
      "INSERT INTO nodes(id,type,title,summary,body,anchors) VALUES('n_old','concept','Transfer','moves money','the body','[\"a_old\"]');",
      "INSERT INTO edges(from_id,to_id,type,ord) VALUES('n_old','n_other','relates',0);",
      "INSERT INTO meta(k,v) VALUES('triage','{\"schemaVersion\":1,\"triage\":[{\"target\":{\"kind\":\"anchor\",\"id\":\"a_old\"},\"importance\":\"business-critical\",\"likely\":false,\"source\":\"human\",\"at\":\"2026-01-01T00:00:00Z\",\"witnesses\":[]}]}');",
      "INSERT INTO snapshots(ref,branch,at,count) VALUES('deadbeef','main','2026-01-01T00:00:00Z',1);",
    ],
  },
  {
    era: "versioned-docs",
    commit: "14708d3",
    subject: "Doc versioning Phase 1: versioned nodes + hash-match resolution",
    why:
      "`node_versions` exists but has none of `removed`, `origin`, `source_scope`, `publication_state`, `ord`, `author`. Five ALTER rungs have to land on a table that `CREATE TABLE IF NOT EXISTS` will not touch.",
    sql: [
      "    CREATE TABLE IF NOT EXISTS anchors (\n      ref TEXT NOT NULL, id TEXT NOT NULL, file TEXT NOT NULL, symbol_path TEXT NOT NULL,\n      kind TEXT NOT NULL, disambiguator TEXT, body_hash TEXT NOT NULL, last_commit TEXT,\n      start_byte INTEGER, end_byte INTEGER, start_line INTEGER, end_line INTEGER,\n      PRIMARY KEY (ref, id)\n    );\n    CREATE INDEX IF NOT EXISTS ix_anchors_reffile ON anchors(ref, file);\n    CREATE TABLE IF NOT EXISTS nodes (\n      id TEXT PRIMARY KEY, type TEXT, title TEXT, summary TEXT, body TEXT,\n      anchors TEXT, generated_by TEXT\n    );\n    CREATE TABLE IF NOT EXISTS node_versions (\n      version_id TEXT PRIMARY KEY, node_id TEXT NOT NULL,\n      type TEXT, title TEXT, summary TEXT, body TEXT, generated_by TEXT,\n      created_commit TEXT, created_branch TEXT, created_at TEXT,\n      citations TEXT\n    );\n    CREATE INDEX IF NOT EXISTS ix_nv_node ON node_versions(node_id);\n    CREATE TABLE IF NOT EXISTS edges (\n      rowid INTEGER PRIMARY KEY, from_id TEXT, to_id TEXT, type TEXT, ord INTEGER, generated_by TEXT\n    );\n    CREATE INDEX IF NOT EXISTS ix_edges_from ON edges(from_id);\n    CREATE INDEX IF NOT EXISTS ix_edges_to ON edges(to_id);\n    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);\n    CREATE TABLE IF NOT EXISTS snapshots (ref TEXT PRIMARY KEY, branch TEXT, at TEXT, count INTEGER);",
    ],
    seed: [
      "INSERT INTO anchors(ref,id,file,symbol_path,kind,body_hash,start_byte,end_byte,start_line,end_line)\n     VALUES('@work','a_old','src/pay.ts','[\"transfer\"]','function','h1:sha256:abc',0,40,1,3);",
      "INSERT INTO nodes(id,type,title,summary,body,anchors) VALUES('n_old','concept','Transfer','moves money','the body','[\"a_old\"]');",
      "INSERT INTO edges(from_id,to_id,type,ord) VALUES('n_old','n_other','relates',0);",
      "INSERT INTO meta(k,v) VALUES('triage','{\"schemaVersion\":1,\"triage\":[{\"target\":{\"kind\":\"anchor\",\"id\":\"a_old\"},\"importance\":\"business-critical\",\"likely\":false,\"source\":\"human\",\"at\":\"2026-01-01T00:00:00Z\",\"witnesses\":[]}]}');",
      "INSERT INTO snapshots(ref,branch,at,count) VALUES('deadbeef','main','2026-01-01T00:00:00Z',1);",
      "INSERT INTO node_versions(version_id,node_id,type,title,summary,body,created_at,citations)\n     VALUES('nv_old','n_old','concept','Transfer','moves money','the body','2026-01-01T00:00:00Z','[{\"anchorId\":\"a_old\",\"acceptedHashes\":[\"h1:sha256:abc\"]}]');",
    ],
  },
  {
    era: "derivation-schemes",
    commit: "ac371ec",
    subject: "fix(diff): a snapshot from another anchor-id derivation is not comparable",
    why:
      "`snapshots` has `scheme` but not `hash_scheme`, and `anchors` has no `derivation`. A store whose index cannot say how it was derived.",
    sql: [
      "    CREATE TABLE IF NOT EXISTS anchors (\n      ref TEXT NOT NULL, id TEXT NOT NULL, file TEXT NOT NULL, symbol_path TEXT NOT NULL,\n      kind TEXT NOT NULL, disambiguator TEXT, body_hash TEXT NOT NULL, last_commit TEXT,\n      start_byte INTEGER, end_byte INTEGER, start_line INTEGER, end_line INTEGER,\n      PRIMARY KEY (ref, id)\n    );\n    CREATE INDEX IF NOT EXISTS ix_anchors_reffile ON anchors(ref, file);\n    CREATE TABLE IF NOT EXISTS nodes (\n      id TEXT PRIMARY KEY, type TEXT, title TEXT, summary TEXT, body TEXT,\n      anchors TEXT, generated_by TEXT\n    );\n    CREATE TABLE IF NOT EXISTS node_versions (\n      version_id TEXT PRIMARY KEY, node_id TEXT NOT NULL,\n      type TEXT, title TEXT, summary TEXT, body TEXT, generated_by TEXT,\n      created_commit TEXT, created_branch TEXT, created_at TEXT,\n      citations TEXT, removed INTEGER DEFAULT 0\n    );\n    CREATE INDEX IF NOT EXISTS ix_nv_node ON node_versions(node_id);\n    CREATE TABLE IF NOT EXISTS edges (\n      rowid INTEGER PRIMARY KEY, from_id TEXT, to_id TEXT, type TEXT, ord INTEGER, generated_by TEXT\n    );\n    CREATE INDEX IF NOT EXISTS ix_edges_from ON edges(from_id);\n    CREATE INDEX IF NOT EXISTS ix_edges_to ON edges(to_id);\n    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);\n    CREATE TABLE IF NOT EXISTS snapshots (ref TEXT PRIMARY KEY, branch TEXT, at TEXT, count INTEGER);",
      "ALTER TABLE node_versions ADD COLUMN removed INTEGER DEFAULT 0",
      "ALTER TABLE snapshots ADD COLUMN scheme INTEGER",
    ],
    seed: [
      "INSERT INTO anchors(ref,id,file,symbol_path,kind,body_hash,start_byte,end_byte,start_line,end_line)\n     VALUES('@work','a_old','src/pay.ts','[\"transfer\"]','function','h1:sha256:abc',0,40,1,3);",
      "INSERT INTO nodes(id,type,title,summary,body,anchors) VALUES('n_old','concept','Transfer','moves money','the body','[\"a_old\"]');",
      "INSERT INTO edges(from_id,to_id,type,ord) VALUES('n_old','n_other','relates',0);",
      "INSERT INTO meta(k,v) VALUES('triage','{\"schemaVersion\":1,\"triage\":[{\"target\":{\"kind\":\"anchor\",\"id\":\"a_old\"},\"importance\":\"business-critical\",\"likely\":false,\"source\":\"human\",\"at\":\"2026-01-01T00:00:00Z\",\"witnesses\":[]}]}');",
      "INSERT INTO snapshots(ref,branch,at,count) VALUES('deadbeef','main','2026-01-01T00:00:00Z',1);",
      "INSERT INTO node_versions(version_id,node_id,type,title,summary,body,created_at,citations)\n     VALUES('nv_old','n_old','concept','Transfer','moves money','the body','2026-01-01T00:00:00Z','[{\"anchorId\":\"a_old\",\"acceptedHashes\":[\"h1:sha256:abc\"]}]');",
    ],
  },
  {
    era: "materialized",
    commit: "cfa4fff",
    subject: "feat(materialize): step 1 — the sidecar fold, cached in SQLite",
    why:
      "The first shared tables — `derivations`, `shared_scope`, `shared_finding`. `shared_scope` predates its `status` and `diagnostic` columns.",
    sql: [
      "    CREATE TABLE IF NOT EXISTS anchors (\n      ref TEXT NOT NULL, id TEXT NOT NULL, file TEXT NOT NULL, symbol_path TEXT NOT NULL,\n      kind TEXT NOT NULL, disambiguator TEXT, body_hash TEXT NOT NULL, last_commit TEXT,\n      start_byte INTEGER, end_byte INTEGER, start_line INTEGER, end_line INTEGER,\n      PRIMARY KEY (ref, id)\n    );\n    CREATE INDEX IF NOT EXISTS ix_anchors_reffile ON anchors(ref, file);\n    CREATE TABLE IF NOT EXISTS derivations (\n      id INTEGER PRIMARY KEY, tag TEXT NOT NULL UNIQUE\n    );\n    CREATE TABLE IF NOT EXISTS nodes (\n      id TEXT PRIMARY KEY, type TEXT, title TEXT, summary TEXT, body TEXT,\n      anchors TEXT, generated_by TEXT\n    );\n    CREATE TABLE IF NOT EXISTS node_versions (\n      version_id TEXT PRIMARY KEY, node_id TEXT NOT NULL,\n      type TEXT, title TEXT, summary TEXT, body TEXT, generated_by TEXT,\n      created_commit TEXT, created_branch TEXT, created_at TEXT,\n      citations TEXT, removed INTEGER DEFAULT 0\n    );\n    CREATE INDEX IF NOT EXISTS ix_nv_node ON node_versions(node_id);\n    CREATE TABLE IF NOT EXISTS edges (\n      rowid INTEGER PRIMARY KEY, from_id TEXT, to_id TEXT, type TEXT, ord INTEGER, generated_by TEXT\n    );\n    CREATE INDEX IF NOT EXISTS ix_edges_from ON edges(from_id);\n    CREATE INDEX IF NOT EXISTS ix_edges_to ON edges(to_id);\n    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);\n    CREATE TABLE IF NOT EXISTS snapshots (ref TEXT PRIMARY KEY, branch TEXT, at TEXT, count INTEGER);\n    CREATE TABLE IF NOT EXISTS shared_scope (\n      scope TEXT PRIMARY KEY,\n      fingerprint TEXT NOT NULL,\n      folded_at TEXT NOT NULL,\n      events INTEGER NOT NULL\n    );\n    CREATE TABLE IF NOT EXISTS shared_finding (\n      scope TEXT NOT NULL, id TEXT NOT NULL,\n      target_kind TEXT NOT NULL, target_id TEXT NOT NULL,\n      state TEXT NOT NULL, severity TEXT, category TEXT, line INTEGER,\n      author TEXT NOT NULL, created_at TEXT NOT NULL,\n      needs_ack INTEGER NOT NULL, contested INTEGER NOT NULL,\n      body TEXT NOT NULL,\n      PRIMARY KEY (scope, id)\n    );\n    CREATE INDEX IF NOT EXISTS ix_sf_target ON shared_finding(target_id);\n    CREATE INDEX IF NOT EXISTS ix_sf_queue  ON shared_finding(scope, needs_ack);",
      "ALTER TABLE anchors ADD COLUMN derivation INTEGER",
      "ALTER TABLE node_versions ADD COLUMN removed INTEGER DEFAULT 0",
      "ALTER TABLE snapshots ADD COLUMN scheme INTEGER",
      "ALTER TABLE snapshots ADD COLUMN hash_scheme INTEGER",
    ],
    seed: [
      "INSERT INTO anchors(ref,id,file,symbol_path,kind,body_hash,start_byte,end_byte,start_line,end_line)\n     VALUES('@work','a_old','src/pay.ts','[\"transfer\"]','function','h1:sha256:abc',0,40,1,3);",
      "INSERT INTO nodes(id,type,title,summary,body,anchors) VALUES('n_old','concept','Transfer','moves money','the body','[\"a_old\"]');",
      "INSERT INTO edges(from_id,to_id,type,ord) VALUES('n_old','n_other','relates',0);",
      "INSERT INTO meta(k,v) VALUES('triage','{\"schemaVersion\":1,\"triage\":[{\"target\":{\"kind\":\"anchor\",\"id\":\"a_old\"},\"importance\":\"business-critical\",\"likely\":false,\"source\":\"human\",\"at\":\"2026-01-01T00:00:00Z\",\"witnesses\":[]}]}');",
      "INSERT INTO snapshots(ref,branch,at,count) VALUES('deadbeef','main','2026-01-01T00:00:00Z',1);",
      "INSERT INTO node_versions(version_id,node_id,type,title,summary,body,created_at,citations)\n     VALUES('nv_old','n_old','concept','Transfer','moves money','the body','2026-01-01T00:00:00Z','[{\"anchorId\":\"a_old\",\"acceptedHashes\":[\"h1:sha256:abc\"]}]');",
      "INSERT INTO derivations(id,tag) VALUES(1,'{\"anchorScheme\":2,\"hashScheme\":1}');",
      "INSERT INTO shared_scope(scope,fingerprint,folded_at,events) VALUES('findings/acme-api/pr-1','fp1','2026-01-01T00:00:00Z',1);",
      "INSERT INTO shared_finding(scope,id,target_kind,target_id,state,author,created_at,needs_ack,contested,body)\n     VALUES('findings/acme-api/pr-1','f_old','anchor','a_old','created','ana@acme.test','2026-01-01T00:00:00Z',0,0,'{\"id\":\"f_old\"}');",
    ],
  },
  {
    era: "parallel-doc-tables",
    commit: "229ea14",
    subject: "feat(eventlog): a chain per (scope, clone), and a scope that says when it cannot be trusted",
    why:
      "Holds data in three tables THIS BUILD NO LONGER WRITES: `shared_doc`, `shared_doc_version`, `shared_doc_citation`, from before a teammate's doc became a `node_versions` row. Opening such a store must neither fail nor quietly destroy them.",
    sql: [
      "    CREATE TABLE IF NOT EXISTS anchors (\n      ref TEXT NOT NULL, id TEXT NOT NULL, file TEXT NOT NULL, symbol_path TEXT NOT NULL,\n      kind TEXT NOT NULL, disambiguator TEXT, body_hash TEXT NOT NULL, last_commit TEXT,\n      start_byte INTEGER, end_byte INTEGER, start_line INTEGER, end_line INTEGER,\n      PRIMARY KEY (ref, id)\n    );\n    CREATE INDEX IF NOT EXISTS ix_anchors_reffile ON anchors(ref, file);\n    CREATE TABLE IF NOT EXISTS derivations (\n      id INTEGER PRIMARY KEY, tag TEXT NOT NULL UNIQUE\n    );\n    CREATE TABLE IF NOT EXISTS nodes (\n      id TEXT PRIMARY KEY, type TEXT, title TEXT, summary TEXT, body TEXT,\n      anchors TEXT, generated_by TEXT\n    );\n    CREATE TABLE IF NOT EXISTS node_versions (\n      version_id TEXT PRIMARY KEY, node_id TEXT NOT NULL,\n      type TEXT, title TEXT, summary TEXT, body TEXT, generated_by TEXT,\n      created_commit TEXT, created_branch TEXT, created_at TEXT,\n      citations TEXT, removed INTEGER DEFAULT 0\n    );\n    CREATE INDEX IF NOT EXISTS ix_nv_node ON node_versions(node_id);\n    CREATE TABLE IF NOT EXISTS edges (\n      rowid INTEGER PRIMARY KEY, from_id TEXT, to_id TEXT, type TEXT, ord INTEGER, generated_by TEXT\n    );\n    CREATE INDEX IF NOT EXISTS ix_edges_from ON edges(from_id);\n    CREATE INDEX IF NOT EXISTS ix_edges_to ON edges(to_id);\n    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);\n    CREATE TABLE IF NOT EXISTS snapshots (ref TEXT PRIMARY KEY, branch TEXT, at TEXT, count INTEGER);\n    CREATE TABLE IF NOT EXISTS shared_scope (\n      scope TEXT PRIMARY KEY,\n      fingerprint TEXT NOT NULL,\n      folded_at TEXT NOT NULL,\n      events INTEGER NOT NULL,\n      status TEXT NOT NULL DEFAULT 'complete',\n      diagnostic TEXT\n    );\n    CREATE TABLE IF NOT EXISTS shared_finding (\n      scope TEXT NOT NULL, id TEXT NOT NULL,\n      target_kind TEXT NOT NULL, target_id TEXT NOT NULL,\n      state TEXT NOT NULL, severity TEXT, category TEXT, line INTEGER,\n      author TEXT NOT NULL, created_at TEXT NOT NULL,\n      needs_ack INTEGER NOT NULL, contested INTEGER NOT NULL,\n      body TEXT NOT NULL,\n      PRIMARY KEY (scope, id)\n    );\n    CREATE INDEX IF NOT EXISTS ix_sf_target ON shared_finding(target_id);\n    CREATE INDEX IF NOT EXISTS ix_sf_queue  ON shared_finding(scope, needs_ack);\n    CREATE TABLE IF NOT EXISTS shared_doc (\n      scope TEXT NOT NULL, node_id TEXT NOT NULL,\n      unmatched TEXT,\n      PRIMARY KEY (scope, node_id)\n    );\n    CREATE TABLE IF NOT EXISTS shared_doc_version (\n      scope TEXT NOT NULL, node_id TEXT NOT NULL, version_id TEXT NOT NULL,\n      ord INTEGER NOT NULL, author TEXT,\n      body TEXT NOT NULL,\n      PRIMARY KEY (scope, version_id)\n    );\n    CREATE INDEX IF NOT EXISTS ix_sdv_node ON shared_doc_version(scope, node_id);\n    CREATE TABLE IF NOT EXISTS shared_doc_citation (\n      scope TEXT NOT NULL, version_id TEXT NOT NULL, anchor_id TEXT NOT NULL,\n      PRIMARY KEY (scope, version_id, anchor_id)\n    );\n    CREATE INDEX IF NOT EXISTS ix_sdc_anchor ON shared_doc_citation(anchor_id);\n    CREATE TABLE IF NOT EXISTS shared_note (\n      scope TEXT NOT NULL, id TEXT NOT NULL, target_id TEXT NOT NULL,\n      kind TEXT, author TEXT, created_at TEXT, resolved INTEGER DEFAULT 0,\n      body TEXT NOT NULL,\n      PRIMARY KEY (scope, id)\n    );\n    CREATE INDEX IF NOT EXISTS ix_sn_target ON shared_note(target_id);",
      "ALTER TABLE anchors ADD COLUMN derivation INTEGER",
      "ALTER TABLE node_versions ADD COLUMN removed INTEGER DEFAULT 0",
      "ALTER TABLE snapshots ADD COLUMN scheme INTEGER",
      "ALTER TABLE snapshots ADD COLUMN hash_scheme INTEGER",
      "ALTER TABLE shared_scope ADD COLUMN status TEXT NOT NULL DEFAULT 'complete'",
      "ALTER TABLE shared_scope ADD COLUMN diagnostic TEXT",
    ],
    seed: [
      "INSERT INTO anchors(ref,id,file,symbol_path,kind,body_hash,start_byte,end_byte,start_line,end_line)\n     VALUES('@work','a_old','src/pay.ts','[\"transfer\"]','function','h1:sha256:abc',0,40,1,3);",
      "INSERT INTO nodes(id,type,title,summary,body,anchors) VALUES('n_old','concept','Transfer','moves money','the body','[\"a_old\"]');",
      "INSERT INTO edges(from_id,to_id,type,ord) VALUES('n_old','n_other','relates',0);",
      "INSERT INTO meta(k,v) VALUES('triage','{\"schemaVersion\":1,\"triage\":[{\"target\":{\"kind\":\"anchor\",\"id\":\"a_old\"},\"importance\":\"business-critical\",\"likely\":false,\"source\":\"human\",\"at\":\"2026-01-01T00:00:00Z\",\"witnesses\":[]}]}');",
      "INSERT INTO snapshots(ref,branch,at,count) VALUES('deadbeef','main','2026-01-01T00:00:00Z',1);",
      "INSERT INTO node_versions(version_id,node_id,type,title,summary,body,created_at,citations)\n     VALUES('nv_old','n_old','concept','Transfer','moves money','the body','2026-01-01T00:00:00Z','[{\"anchorId\":\"a_old\",\"acceptedHashes\":[\"h1:sha256:abc\"]}]');",
      "INSERT INTO derivations(id,tag) VALUES(1,'{\"anchorScheme\":2,\"hashScheme\":1}');",
      "INSERT INTO shared_scope(scope,fingerprint,folded_at,events) VALUES('findings/acme-api/pr-1','fp1','2026-01-01T00:00:00Z',1);",
      "INSERT INTO shared_finding(scope,id,target_kind,target_id,state,author,created_at,needs_ack,contested,body)\n     VALUES('findings/acme-api/pr-1','f_old','anchor','a_old','created','ana@acme.test','2026-01-01T00:00:00Z',0,0,'{\"id\":\"f_old\"}');",
      "INSERT INTO shared_doc(scope,node_id) VALUES('docs/acme-api','n_shared');",
      "INSERT INTO shared_doc_version(scope,node_id,version_id,ord,author,body) VALUES('docs/acme-api','n_shared','sv_1',0,'ben@acme.test','{\"versionId\":\"sv_1\",\"nodeId\":\"n_shared\",\"body\":\"a teammate wrote this\"}');",
      "INSERT INTO shared_doc_citation(scope,version_id,anchor_id) VALUES('docs/acme-api','sv_1','a_old');",
    ],
  },
];

/**
 * Build one era's store into an open database.
 *
 * Deliberately NOT via `db()`: the whole point is a database this build did not create,
 * so it is written with the historic statements and then handed to `db()` to open.
 */
export function buildEra(d: DatabaseSync, era: SchemaEra): void {
  // The schema statements are tolerant, exactly as `migrate` is: an era's ALTER rungs
  // sit alongside a CREATE that already has those columns, and the real code has always
  // swallowed the duplicate. Faithful, not lax.
  for (const stmt of era.sql) { try { d.exec(stmt); } catch { /* already present */ } }
  // The SEED is not tolerant. A row that fails to insert is a fixture that silently
  // tests less than it claims, which is the failure this whole file exists to prevent.
  for (const stmt of era.seed) d.exec(stmt);
}
