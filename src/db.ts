/**
 * SQLite backing store (node:sqlite, zero-dep). One DB per universe at
 * `<root>/.codemap/codemap.db`, gitignored so it never pollutes a branch/PR diff.
 *
 * Anchors are keyed by `ref` — `@work` is the live/working index (what the app
 * reads today); committed shas will be cached here for branch-diff (Phase 2), so
 * a commit maps to an immutable anchor snapshot and stale data is never lost.
 *
 * On first open, any pre-existing JSON `.codemap/` is imported so no map is lost.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const WORK_REF = "@work";
/**
 * Where an anchor goes when the tree no longer has it but somebody's work still
 * points at it.
 *
 * Reserved like `@work`, and deliberately NOT a snapshot: a snapshot is a cache of
 * a commit and can be rebuilt or dropped, whereas this is the last surviving record
 * of what a finding was about. Nothing a human wrote should be able to disappear
 * because a machine re-read the tree.
 */
export const ORPHAN_REF = "@orphan";

const cache = new Map<string, DatabaseSync>();

export function db(root: string): DatabaseSync {
  let d = cache.get(root);
  if (d) return d;
  const dir = join(root, ".codemap");
  mkdirSync(dir, { recursive: true });
  // Ensure the whole .codemap/ is git-ignored (DB must not be tracked).
  const gi = join(dir, ".gitignore");
  if (!existsSync(gi)) writeFileSync(gi, "# codemap store — never commit; regenerate with `codemap init`\n*\n");
  d = new DatabaseSync(join(dir, "codemap.db"));
  d.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  migrate(d);
  importLegacy(root, d);
  migrateNodesToVersions(d);
  cache.set(root, d);
  return d;
}

/**
 * One-time: fold the legacy single-version `nodes` table into `node_versions`
 * (v1 each), seeding each citation's accepted hash from the current @work anchor
 * hash. The old `nodes` table is kept as a backup but is no longer authoritative.
 */
function migrateNodesToVersions(d: DatabaseSync): void {
  const nvCount = (d.prepare("SELECT COUNT(*) c FROM node_versions").get() as any).c;
  const nCount = (d.prepare("SELECT COUNT(*) c FROM nodes").get() as any).c;
  if (nvCount || !nCount) return;
  const work = new Map<string, string>();
  for (const r of d.prepare("SELECT id, body_hash FROM anchors WHERE ref = '@work'").all() as any[]) work.set(r.id, r.body_hash);
  const ins = d.prepare("INSERT INTO node_versions(version_id,node_id,type,title,summary,body,generated_by,created_commit,created_branch,created_at,citations) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  const at = new Date().toISOString();
  d.exec("BEGIN");
  try {
    for (const n of d.prepare("SELECT * FROM nodes").all() as any[]) {
      const anchors: string[] = JSON.parse(n.anchors ?? "[]");
      const citations = anchors.map((id) => ({ anchorId: id, acceptedHashes: work.has(id) ? [work.get(id)!] : [] }));
      ins.run("nv_" + randomBytes(6).toString("hex"), n.id, n.type, n.title, n.summary, n.body, n.generated_by, null, null, at, JSON.stringify(citations));
    }
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

function migrate(d: DatabaseSync): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS anchors (
      ref TEXT NOT NULL, id TEXT NOT NULL, file TEXT NOT NULL, symbol_path TEXT NOT NULL,
      kind TEXT NOT NULL, disambiguator TEXT, body_hash TEXT NOT NULL, last_commit TEXT,
      start_byte INTEGER, end_byte INTEGER, start_line INTEGER, end_line INTEGER,
      PRIMARY KEY (ref, id)
    );
    CREATE INDEX IF NOT EXISTS ix_anchors_reffile ON anchors(ref, file);
    -- Derivation tags, interned. There are as many distinct tags as there are
    -- grammars in use (one to five), against up to hundreds of thousands of
    -- anchors, so storing the JSON per row would add tens of megabytes to say
    -- the same five things. The DURABLE record — a sidecar event — stays
    -- self-contained; this is the local store normalising its own copy, which
    -- PROPOSAL-provenance.md §3 permits precisely because it is not durable.
    CREATE TABLE IF NOT EXISTS derivations (
      id INTEGER PRIMARY KEY, tag TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY, type TEXT, title TEXT, summary TEXT, body TEXT,
      anchors TEXT, generated_by TEXT
    );
    -- Versioned docs (see docs/doc-versioning.md): a node id has 1+ versions, each
    -- capturing the anchor hashes it was written against (citations JSON).
    CREATE TABLE IF NOT EXISTS node_versions (
      version_id TEXT PRIMARY KEY, node_id TEXT NOT NULL,
      type TEXT, title TEXT, summary TEXT, body TEXT, generated_by TEXT,
      created_commit TEXT, created_branch TEXT, created_at TEXT,
      citations TEXT, removed INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS ix_nv_node ON node_versions(node_id);
    CREATE TABLE IF NOT EXISTS edges (
      rowid INTEGER PRIMARY KEY, from_id TEXT, to_id TEXT, type TEXT, ord INTEGER, generated_by TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_edges_from ON edges(from_id);
    CREATE INDEX IF NOT EXISTS ix_edges_to ON edges(to_id);
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    -- One row per cached commit snapshot (the anchors themselves live in the
    -- anchors table under ref = the commit sha). This is the branch-diff cache:
    -- a commit maps to an immutable anchor set, and old-branch data is never lost.
    CREATE TABLE IF NOT EXISTS snapshots (ref TEXT PRIMARY KEY, branch TEXT, at TEXT, count INTEGER);

    -- Materialized sidecar folds. The sidecar's event log stays authoritative;
    -- these are a cache of the projection, rebuildable and gitignored with the rest
    -- of the DB. See PROPOSAL-sidecar-materialization.md §3-§4.
    --
    -- NO column here may hold anything DERIVED from the anchors table. The cache
    -- key deliberately excludes ANCHOR_SCHEME and HASH_SCHEME on the grounds that
    -- the projection copies ids and hashes VERBATIM from events and joins to
    -- the anchors table at read time, so a scheme bump changes the join result and
    -- cannot change these rows. Store a derived verdict as a column and both schemes
    -- silently belong in the key again, with well-formed-looking rows that are
    -- wrong. That is the trap; this comment is the guard.
    CREATE TABLE IF NOT EXISTS shared_scope (
      scope TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      folded_at TEXT NOT NULL,
      events INTEGER NOT NULL,
      -- Whether the fold may be presented as the truth: 'complete' | 'blocked',
      -- with one diagnostic as JSON. Stored beside the fingerprint on purpose —
      -- the fingerprint is what says the verdict still describes these shards, so
      -- a cache hit answers the status without re-reading the log.
      -- See PROPOSAL-provenance.md section 7, and scopeStatus() in eventlog.ts.
      status TEXT NOT NULL DEFAULT 'complete',
      diagnostic TEXT
    );
    CREATE TABLE IF NOT EXISTS shared_finding (
      scope TEXT NOT NULL, id TEXT NOT NULL,
      target_kind TEXT NOT NULL, target_id TEXT NOT NULL,
      state TEXT NOT NULL, severity TEXT, category TEXT, line INTEGER,
      author TEXT NOT NULL, created_at TEXT NOT NULL,
      -- Derived by the FOLD, not by a join: recomputed whole on every re-fold and
      -- never incremented, so the ack queue is a WHERE rather than a scan over
      -- deserialized objects.
      needs_ack INTEGER NOT NULL, contested INTEGER NOT NULL,
      body TEXT NOT NULL,
      PRIMARY KEY (scope, id)
    );
    CREATE INDEX IF NOT EXISTS ix_sf_target ON shared_finding(target_id);
    CREATE INDEX IF NOT EXISTS ix_sf_queue  ON shared_finding(scope, needs_ack);

    CREATE TABLE IF NOT EXISTS shared_doc (
      scope TEXT NOT NULL, node_id TEXT NOT NULL,
      unmatched TEXT,                  -- JSON UnmatchedAcceptance[]; null when empty
      PRIMARY KEY (scope, node_id)
    );
    -- ord and author are columns rather than part of the JSON because neither
    -- survives a round trip through it: versions are ORDERED (oldest first) and a
    -- Map key order is not a document property, and SharedDoc.authors is a Map,
    -- which JSON.stringify turns into {}.
    CREATE TABLE IF NOT EXISTS shared_doc_version (
      scope TEXT NOT NULL, node_id TEXT NOT NULL, version_id TEXT NOT NULL,
      ord INTEGER NOT NULL, author TEXT,
      body TEXT NOT NULL,              -- the whole NodeVersion, as JSON
      PRIMARY KEY (scope, version_id)
    );
    CREATE INDEX IF NOT EXISTS ix_sdv_node ON shared_doc_version(scope, node_id);
    -- The citation edge, lifted out of the JSON. WRITTEN AND NOT YET READ: the
    -- anchor-table scans were removed by an indexed lookup over the cited ids
    -- (workIndexFor), not by a join through this table. It exists for the query in
    -- PROPOSAL-sidecar-materialization.md §5, which is not built. If that query
    -- does not land, delete this table rather than leaving a write-only structure
    -- that reads as an implemented join.
    CREATE TABLE IF NOT EXISTS shared_doc_citation (
      scope TEXT NOT NULL, version_id TEXT NOT NULL, anchor_id TEXT NOT NULL,
      PRIMARY KEY (scope, version_id, anchor_id)
    );
    CREATE INDEX IF NOT EXISTS ix_sdc_anchor ON shared_doc_citation(anchor_id);

    CREATE TABLE IF NOT EXISTS shared_note (
      scope TEXT NOT NULL, id TEXT NOT NULL, target_id TEXT NOT NULL,
      kind TEXT, author TEXT, created_at TEXT, resolved INTEGER DEFAULT 0,
      body TEXT NOT NULL,
      PRIMARY KEY (scope, id)
    );
    CREATE INDEX IF NOT EXISTS ix_sn_target ON shared_note(target_id);
  `);
  // anchors.derivation — NULL on rows indexed before provenance existed, which is
  // `legacy_live_derivation`: this machine cannot say how its own index was made.
  try { d.exec("ALTER TABLE anchors ADD COLUMN derivation INTEGER"); } catch { /* already present */ }
  // node_versions.removed (Phase 2) — add to tables created before it existed.
  try { d.exec("ALTER TABLE node_versions ADD COLUMN removed INTEGER DEFAULT 0"); } catch { /* already present */ }
  // Which anchor-id derivation a snapshot was written under. NULL means "before this
  // column existed", which is indistinguishable from "some older scheme" — so it is
  // treated as stale and the snapshot is rebuilt on next use.
  try { d.exec("ALTER TABLE snapshots ADD COLUMN scheme INTEGER"); } catch { /* already present */ }
  // And which body-hash derivation. Same NULL rule, for the same reason: the ids say
  // which symbols pair up across two snapshots, the hashes say which pairs changed,
  // so a mismatch on either makes the whole diff meaningless.
  try { d.exec("ALTER TABLE snapshots ADD COLUMN hash_scheme INTEGER"); } catch { /* already present */ }
  // shared_scope.status — rows folded before §7's fail-closed rule existed. The
  // default is 'complete', which is what they were assumed to be; the next fold of
  // that scope replaces it with a judgement.
  try { d.exec("ALTER TABLE shared_scope ADD COLUMN status TEXT NOT NULL DEFAULT 'complete'"); } catch { /* already present */ }
  try { d.exec("ALTER TABLE shared_scope ADD COLUMN diagnostic TEXT"); } catch { /* already present */ }
}

// --- one-time migration of a legacy JSON .codemap/ into the DB ---------------

function tinyFrontmatter(text: string): { fields: Record<string, string | string[]>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return { fields: {}, body: text };
  const fields: Record<string, string | string[]> = {};
  for (const line of m[1]!.split("\n")) {
    const mm = /^(\w+):\s*(.*)$/.exec(line);
    if (!mm) continue;
    const val = mm[2]!.trim();
    fields[mm[1]!] = val.startsWith("[") && val.endsWith("]")
      ? val.slice(1, -1).split(",").map((x) => x.trim()).filter(Boolean)
      : val;
  }
  return { fields, body: m[2]! };
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function importLegacy(root: string, d: DatabaseSync): void {
  const already = (d.prepare("SELECT COUNT(*) c FROM anchors").get() as any).c;
  const dir = join(root, ".codemap");
  const anchorsJson = readJson(join(dir, "anchors.json"));
  if (already || !anchorsJson) return; // fresh DB or nothing to import

  const insA = d.prepare("INSERT OR REPLACE INTO anchors(ref,id,file,symbol_path,kind,disambiguator,body_hash,last_commit,start_byte,end_byte,start_line,end_line) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
  for (const a of anchorsJson.anchors ?? []) {
    insA.run(WORK_REF, a.id, a.file, JSON.stringify(a.symbolPath), a.kind, a.disambiguator ?? null, a.bodyHash, a.lastVerifiedCommit ?? null,
      a.loc?.startByte ?? null, a.loc?.endByte ?? null, a.loc?.startLine ?? null, a.loc?.endLine ?? null);
  }

  const insN = d.prepare("INSERT OR REPLACE INTO nodes(id,type,title,summary,body,anchors,generated_by) VALUES(?,?,?,?,?,?,?)");
  try {
    for (const name of readdirSync(join(dir, "nodes"))) {
      if (!name.endsWith(".md")) continue;
      const { fields, body } = tinyFrontmatter(readFileSync(join(dir, "nodes", name), "utf8"));
      const id = (fields.id as string) ?? name.replace(/\.md$/, "");
      insN.run(id, (fields.type as string) ?? "module", (fields.title as string) ?? "", (fields.summary as string) ?? "",
        body, JSON.stringify(Array.isArray(fields.anchors) ? fields.anchors : []), (fields.generatedBy as string) ?? null);
    }
  } catch { /* no nodes dir */ }

  const graph = readJson(join(dir, "graph.json"));
  if (graph?.edges) {
    const insE = d.prepare("INSERT INTO edges(from_id,to_id,type,ord,generated_by) VALUES(?,?,?,?,?)");
    for (const e of graph.edges) insE.run(e.from, e.to, e.type, e.order ?? null, e.generatedBy ?? null);
  }

  const setMeta = d.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)");
  for (const [file, key] of [["state.json", "state"], ["bugs.json", "bugs"], ["annotations.json", "annotations"], ["coverage.json", "coverage"], ["analyzers.json", "analyzers"], ["reviews.json", "reviews"]] as const) {
    const j = readJson(join(dir, file));
    if (j) setMeta.run(key, JSON.stringify(j));
  }
}
