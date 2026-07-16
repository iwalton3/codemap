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

export const WORK_REF = "@work";

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
  cache.set(root, d);
  return d;
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
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY, type TEXT, title TEXT, summary TEXT, body TEXT,
      anchors TEXT, generated_by TEXT
    );
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
  `);
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
