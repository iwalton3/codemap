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
  migrateTriageBlob(d);
  migrateBugsBlob(d);
  migrateWalkthroughBlob(d);
  cache.set(root, d);
  return d;
}

/**
 * One-time: `meta["triage"]` becomes rows in the `triage` table.
 *
 * The blob was one JSON document holding every mark. It has to become a table before a
 * teammate's stakes can be an ordinary row with an `origin` — the one-canonical-table
 * rule that removed the parallel `shared_doc_*` tables. See `docs/shared-triage.md`.
 *
 * Every migrated mark is LOCAL (`source_scope IS NULL`), and stays local until somebody
 * publishes it deliberately. That is not fastidiousness: a legacy `Triage` carries a
 * `source` but no `Actor`, so publishing automatically would attribute every historical
 * judgment to whoever happened to upgrade first.
 *
 * Idempotent by construction — the key is dropped in the same transaction that writes
 * the rows, so a second open has nothing to import. If rows already exist the blob is
 * stale (something has written since) and is dropped without being read: the table has
 * already won, and re-importing would resurrect marks a later write removed.
 */
function migrateTriageBlob(d: DatabaseSync): void {
  const row = d.prepare("SELECT v FROM meta WHERE k = 'triage'").get() as { v: string } | undefined;
  if (!row) return;
  const existing = (d.prepare("SELECT COUNT(*) c FROM triage").get() as { c: number }).c;

  d.exec("BEGIN");
  try {
    if (!existing) {
      let parsed: { triage?: unknown[] } | undefined;
      // A blob this build cannot parse is not a reason to refuse to open the store. It
      // is left in `meta` rather than dropped, so nothing is destroyed and a later build
      // can still look at it.
      try { parsed = JSON.parse(row.v) as { triage?: unknown[] }; } catch { d.exec("ROLLBACK"); return; }
      const ins = d.prepare(
        "INSERT OR IGNORE INTO triage(target_kind,target_id,field,value,source,likely,generated_by,"
        + "reason,at,witnesses) VALUES(?,?,?,?,?,?,?,?,?,?)",
      );
      for (const t of (parsed?.triage ?? []) as Record<string, any>[]) {
        const kind = t?.target?.kind, id = t?.target?.id;
        // `importance` is what makes a mark a mark; every other field is a refinement of
        // one. A row without it is not a triage record and there is nothing to carry.
        if (!kind || !id || !t.importance) continue;
        const receipt = [
          t.source ?? "human", t.likely ? 1 : 0, t.generatedBy ?? null,
          t.reason ?? null, t.at ?? new Date(0).toISOString(), JSON.stringify(t.witnesses ?? []),
        ];
        ins.run(kind, id, "importance", String(t.importance), ...receipt);
        if (t.complexity) ins.run(kind, id, "complexity", String(t.complexity), ...receipt);
        // Only when SET. `undefined` means nobody has said, which is not the same as
        // disarmed — and a tripwire invented as `false` is an alarm silently turned off.
        if (t.tripwire !== undefined && t.tripwire !== null) {
          ins.run(kind, id, "tripwire", t.tripwire ? "1" : "0", ...receipt);
        }
      }
    }
    d.prepare("DELETE FROM meta WHERE k = 'triage'").run();
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

/**
 * One-time: `meta["pr_walkthrough"]` becomes rows in the `walkthroughs` table.
 *
 * Same shape and the same reasons as the two above. The blob was `{[pr]: walkthrough}`,
 * one per pull request, which is precisely a `(pr, author)` row set with the author left
 * out — and leaving it out is what made a teammate's walkthrough unrepresentable, so the
 * whole surface read the blob and could not see one.
 *
 * A migrated row is LOCAL (`source_scope IS NULL`) and **unattributed** (`author = ''`),
 * the sentinel `migrateBugsBlob` already uses for a legacy record with no `Actor`. A
 * `PrWalkthrough` carries a free-text `by` ("agent", "ben's agent") and that is not a
 * principal — attributing every historical reading to whoever happens to upgrade first
 * is the failure `migrateTriageBlob` refuses for the same reason. It stays unattributed
 * until it is re-walked or published, and publishing is the act that knows who.
 *
 * The SHARED half needs no migration: those rows are a projection of the log, and
 * `MATERIALIZER_VERSION` 8 -> 9 invalidates every cached walkthrough scope so the next
 * read re-folds into the new table. That is what the version is for.
 *
 * Idempotent by construction, exactly as the two above are — the key is dropped in the
 * same transaction that writes the rows.
 */
function migrateWalkthroughBlob(d: DatabaseSync): void {
  const row = d.prepare("SELECT v FROM meta WHERE k = 'pr_walkthrough'").get() as { v: string } | undefined;
  if (!row) return;
  const existing = (d.prepare("SELECT COUNT(*) c FROM walkthroughs").get() as { c: number }).c;

  d.exec("BEGIN");
  try {
    if (!existing) {
      let parsed: { walkthroughs?: Record<string, unknown> } | undefined;
      // Left in `meta` rather than dropped when it will not parse: nothing is
      // destroyed, and a later build can still look at it.
      try { parsed = JSON.parse(row.v) as { walkthroughs?: Record<string, unknown> }; }
      catch { d.exec("ROLLBACK"); return; }
      const ins = d.prepare("INSERT OR IGNORE INTO walkthroughs(pr,author,body) VALUES(?,?,?)");
      for (const [pr, w] of Object.entries(parsed?.walkthroughs ?? {})) {
        const walk = w as { head?: unknown; at?: unknown } | null;
        // `head` is what makes a walkthrough a claim about a commit rather than a
        // document; the fold already drops an event without one, and a row without one
        // would be shown as being about whatever the reader is looking at.
        if (!walk || typeof walk.head !== "string") continue;
        // The `SharedWalkthrough` envelope, so a local row and a folded one are one
        // shape and one read path. `eventId` is empty: nothing published this.
        const body = JSON.stringify({
          walkthrough: walk, actor: { principal: "" }, eventId: "",
          at: typeof walk.at === "string" ? walk.at : new Date(0).toISOString(),
        });
        ins.run(String(pr), "", body);
      }
    }
    d.prepare("DELETE FROM meta WHERE k = 'pr_walkthrough'").run();
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Run the walkthrough blob migration on an ALREADY-OPEN store. **For tests.**
 *
 * `db()` caches a connection per root and the migrations run once, at open, so a test
 * that writes a legacy blob into a live store cannot get it re-read without a new
 * process. Nothing in production calls this: the migration it drives is the one at open.
 */
export function migrateWalkthroughBlobForTest(root: string): void {
  migrateWalkthroughBlob(db(root));
}

/**
 * One-time: `meta["bugs"]` becomes rows in the `bugs` table.
 *
 * Same shape and the same reasons as `migrateTriageBlob` above — a blob cannot carry an
 * `origin`, so a teammate's bug could not be an ordinary row until it was a table.
 *
 * The status vocabulary changes here, and that is the interesting part. A shared bug
 * runs on the lifecycle findings already use, so the four legacy statuses map onto it:
 *
 *   open    -> created    somebody stands behind it
 *   fixed   -> resolved
 *   wontfix -> withdrawn  with the old name kept as the closing reason, because
 *                         "withdrawn" alone loses the deliberateness of a wontfix
 *   invalid -> invalid
 *
 * Every migrated bug is LOCAL (`source_scope IS NULL`) and stays local until somebody
 * publishes it. A legacy `Bug` has no `Actor` — only a `history` of strings — so
 * publishing on upgrade would attribute the whole backlog to whoever upgraded first.
 * `author` is recorded as the empty principal for the same reason: unknown is a fact,
 * and inventing one is the false provenance the witness fields exist to prevent.
 *
 * Idempotent by construction: the key is dropped in the transaction that writes the
 * rows. If rows already exist the blob is stale and is dropped unread — the table has
 * won, and re-importing would resurrect bugs a later write removed.
 */
function migrateBugsBlob(d: DatabaseSync): void {
  const row = d.prepare("SELECT v FROM meta WHERE k = 'bugs'").get() as { v: string } | undefined;
  if (!row) return;
  const existing = (d.prepare("SELECT COUNT(*) c FROM bugs").get() as { c: number }).c;

  const STATE: Record<string, string> = { open: "created", fixed: "resolved", wontfix: "withdrawn", invalid: "invalid" };

  d.exec("BEGIN");
  try {
    if (!existing) {
      let parsed: { bugs?: unknown[] } | undefined;
      // A blob this build cannot parse is left in `meta` rather than dropped: nothing
      // is destroyed, and a later build can still look at it.
      try { parsed = JSON.parse(row.v) as { bugs?: unknown[] }; } catch { d.exec("ROLLBACK"); return; }
      const ins = d.prepare(
        "INSERT OR IGNORE INTO bugs(id,title,state,severity,author,created_at,needs_ack,contested,tracked,body) "
        + "VALUES(?,?,?,?,?,?,0,0,0,?)",
      );
      for (const b of (parsed?.bugs ?? []) as Record<string, any>[]) {
        if (!b?.id || !b?.title) continue;
        const state = STATE[b.status as string] ?? "created";
        const at = new Date(0).toISOString();
        const witness = new Map<string, string>();
        for (const w of (b.witnesses ?? []) as { anchorId?: string; bodyHash?: string }[]) {
          if (w?.anchorId && w?.bodyHash) witness.set(w.anchorId, w.bodyHash);
        }
        const author = { principal: "" };
        const bug = {
          id: b.id,
          title: String(b.title),
          text: String(b.description ?? ""),
          severity: b.severity ?? "medium",
          // A legacy anchor with no witness gets `sha256:absent` — the same value the
          // filer writes for a symbol its index cannot see. It reads as "nobody
          // recorded what this looked like", which is true, and it keeps every citation
          // in the shape `witnessDrift` takes rather than dropping the evidence.
          anchors: ((b.anchors ?? []) as string[]).map((id) => ({
            anchorId: id, bodyHash: witness.get(id) ?? "sha256:absent", by: author, at,
          })),
          createdCommit: b.createdCommit ?? undefined,
          author,
          createdAt: at,
          state,
          corroboration: [],
          // The old free-text history, as the thread it always was. It is the only
          // record of what happened to these bugs, and dropping it on upgrade would
          // lose the one thing the blob held that the columns do not.
          thread: ((b.history ?? []) as string[]).map((body, i) => ({
            id: `${b.id}_h${i}`, actor: author, at, body: String(body),
          })),
          tracking: [],
          ...(b.status === "wontfix" ? { closed: { at, by: author, reason: "wontfix" } } : {}),
          revisions: [],
        };
        ins.run(bug.id, bug.title, state, String(bug.severity), "", at, JSON.stringify(bug));
      }
    }
    d.prepare("DELETE FROM meta WHERE k = 'bugs'").run();
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
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
      citations TEXT, removed INTEGER DEFAULT 0,
      -- WHERE THIS ROW CAME FROM, and it is three facts rather than one: a locally
      -- authored version that has since been published needs all three.
      --   origin            NULL = this user wrote it; non-NULL = the fold owns it.
      --   source_scope      which sidecar scope the fold read it from.
      --   publication_state whether a local row has been published, and how.
      -- The ownership rule (docs/sidecar-architecture.md) is stated on origin: a row
      -- with one is written ONLY by the fold. Do NOT overload generated_by for this
      -- — analyzer-generated and sync-origin are different facts about a row.
      origin TEXT, source_scope TEXT, publication_state TEXT,
      -- The fold's position for this version, and its author. Both are fold outputs
      -- that a table does not otherwise preserve. author is a column rather than part
      -- of the JSON because SharedDoc.authors is a Map, which JSON cannot carry — the
      -- same reason it is a column in shared_doc_version today.
      ord INTEGER, author TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_nv_node ON node_versions(node_id);
    -- Edges. origin/source_scope exactly as node_versions: NULL origin = this user
    -- wrote it, and a row with one is written ONLY by the fold. Without them an edge
    -- could not be fold-owned at all, which is why a teammate's doc used to arrive with
    -- its citations and none of its wiring — and the event matrix then called their
    -- aggregate an orphan.
    CREATE TABLE IF NOT EXISTS edges (
      rowid INTEGER PRIMARY KEY, from_id TEXT, to_id TEXT, type TEXT, ord INTEGER, generated_by TEXT,
      origin TEXT, source_scope TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_edges_from ON edges(from_id);
    -- The fold's own answer per node: who published the winning wiring, at what commit,
    -- and whether wall-clock and canonical order disagreed about it. The edge rows
    -- above are the canonical materialization every reader uses; this is the receipt
    -- they cannot carry, as shared_doc_unmatched holds what a node_versions row cannot.
    -- Without it the projection could not round-trip and CONVERGENCE would fail.
    CREATE TABLE IF NOT EXISTS shared_wiring (
      scope TEXT NOT NULL, node_id TEXT NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY (scope, node_id)
    );
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
    -- Acceptances that could not be joined to any version or citation. Per NODE, not
    -- per version, and a different entity kind from a doc — "an acceptance that could
    -- not land" — so its own table is the one-canonical-table rule applied rather than
    -- violated. Entirely fold-owned; no local writer exists.
    CREATE TABLE IF NOT EXISTS shared_doc_unmatched (
      scope TEXT NOT NULL, node_id TEXT NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY (scope, node_id)
    );
    -- Walkthroughs. ONE canonical table, on the rule that removed shared_doc_* and
    -- then shared_finding, and this one had already cost what the rule predicts: a
    -- teammate's walkthrough travelled, folded into the old parallel
    -- shared_walkthrough, and every surface that renders a walkthrough read a local
    -- meta blob instead — so the pull-request page offered "ask an agent to map out
    -- PR N" over a walkthrough sitting in the reader's own database.
    --
    -- (pr, author) is the identity, and it is the one shape both halves already had:
    -- the blob held one walkthrough per pull request (this store's), and the fold holds
    -- one per author, because two people mapping a pull request is two readings and not
    -- a conflict to arbitrate. A local row is this store's own reading with a NULL
    -- source_scope; publishing it is the fold ADOPTING that row, exactly as a bug's
    -- publication does, so the author's own copy never appears twice.
    --
    -- No at or head column, and that decision predates this table: both are already in
    -- body, neither is queried — walkthroughFor ranks a handful of rows in memory —
    -- and at NOT NULL was a domain mismatch with the envelope, which does not require
    -- at. One accepted event without it poisoned materialization of a whole scope. A
    -- column that stores nothing anybody asks for can only be wrong.
    CREATE TABLE IF NOT EXISTS walkthroughs (
      pr TEXT NOT NULL,
      author TEXT NOT NULL,
      event_id TEXT,
      origin TEXT, source_scope TEXT,
      -- The fold's own iteration order; a column rather than rowid for the reason
      -- bugs.ord gives — adoption UPDATEs a row already there, so rowid order is
      -- publication order rather than fold order and read(write(x)) === x fails on
      -- exactly the stores that published.
      ord INTEGER,
      body TEXT NOT NULL
    );
    -- The finding's rule, one layer simpler: one store holds one universe, so a pr maps
    -- to exactly one walkthrough scope, and (pr, author) is both the fold's key and the
    -- constraint that refuses a local row and a folded row for the same reading.
    CREATE UNIQUE INDEX IF NOT EXISTS ix_walkthroughs_identity ON walkthroughs(pr, author);
    CREATE INDEX IF NOT EXISTS ix_walkthroughs_scope ON walkthroughs(source_scope);
    -- Gone: the parallel shared_walkthrough. Its rows are a projection of the log, so
    -- MATERIALIZER_VERSION 8 -> 9 re-folds every walkthrough scope into walkthroughs on
    -- the next read and nothing has to be copied across. Dropped rather than left empty:
    -- a table nothing writes is a table somebody reads by mistake.
    DROP TABLE IF EXISTS shared_walkthrough;
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
    -- Bugs. ONE canonical table, not a bugs plus a shared_bug: a teammate's bug is a row
    -- here with an origin, by the rule that removed the parallel shared_doc_* tables. A
    -- bug filed with no sidecar configured is the same row with a NULL origin, and
    -- publishing it is the fold ADOPTING it (see bugsProjection).
    --
    -- No scope in the primary key, unlike shared_finding: a bug id is minted once and
    -- one universe has one bugs scope, so (scope, id) would let the same bug exist
    -- twice -- which is precisely what adoption is for. The columns are what a query
    -- filters on; body is the whole SharedBug, the shape shared_finding uses.
    CREATE TABLE IF NOT EXISTS bugs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL, state TEXT NOT NULL, severity TEXT NOT NULL,
      author TEXT NOT NULL, created_at TEXT NOT NULL,
      -- Derived by the FOLD and recomputed whole, never incremented, so the queue is a
      -- WHERE rather than a scan over deserialized objects. tracked is the same kind
      -- of fact: whether anybody has put this in a tracker outside codemap.
      needs_ack INTEGER NOT NULL DEFAULT 0, contested INTEGER NOT NULL DEFAULT 0,
      tracked INTEGER NOT NULL DEFAULT 0,
      origin TEXT, source_scope TEXT,
      -- The FOLD's own iteration order, and it is a column rather than a reliance on
      -- rowid because adoption UPDATEs a row already there: an adopted bug keeps the
      -- rowid it had as a local row, so rowid order is publication order, not fold
      -- order, and read(write(x)) === x fails on exactly the stores that published.
      ord INTEGER,
      body TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_bugs_scope ON bugs(source_scope);

    -- Findings. ONE canonical table, on the same rule as bugs and for a sharper
    -- reason: there were two stores holding the same entity and neither was a
    -- superset. On one real universe, 96 local findings against 26 shared ones, with
    -- no surface showing more than 96 of the 122. See docs/plan-findings-unification.md.
    --
    -- pr is a COLUMN, and that is the whole point. A local annotation had no pr at
    -- all, so which pull request a finding belonged to was inferred by intersecting
    -- its target with that PR's changed-symbol worklist -- which silently drops every
    -- finding about code the PR does not touch, the exact class a reviewer most needs.
    -- Stored here, the association cannot be got wrong and cannot be lost. Worklist
    -- intersection goes back to being what it always should have been: a rendering
    -- decision about which chapter a finding belongs in.
    --
    -- Keyed like triage, NOT like bugs. One universe has one bugs scope, so an id
    -- alone identifies a bug; findings have one scope PER PULL REQUEST, and a log can
    -- carry the same id in two of them -- a fork, a replayed shard, or somebody
    -- hand-writing one. An id-only primary key silently drops the second, and the
    -- oracle's hostile-history property caught exactly that: the fold said two
    -- findings, the table held one, and every read of that scope then answered from
    -- something the log does not say.
    --
    -- So: partial unique indexes, the pattern triage already uses here. SQLite does
    -- not conflict NULLs, so a plain UNIQUE(source_scope, id) would admit unlimited
    -- duplicate LOCAL rows.
    CREATE TABLE IF NOT EXISTS findings (
      id TEXT NOT NULL,
      pr TEXT NOT NULL,
      target_kind TEXT NOT NULL, target_id TEXT NOT NULL,
      state TEXT NOT NULL, severity TEXT, category TEXT, line INTEGER,
      author TEXT NOT NULL, created_at TEXT NOT NULL,
      -- Derived by the FOLD and recomputed whole, never incremented, so the ack queue
      -- is a WHERE rather than a scan over deserialized objects.
      needs_ack INTEGER NOT NULL DEFAULT 0, contested INTEGER NOT NULL DEFAULT 0,
      origin TEXT, source_scope TEXT,
      -- The fold's own iteration order; a column rather than rowid for the reason
      -- bugs.ord gives -- adoption UPDATEs a row already there.
      ord INTEGER,
      body TEXT NOT NULL
    );
    -- (pr, id), which is the finding's actual identity. It admits one id in two
    -- different pull requests -- the case an id-only key dropped, caught by the
    -- oracle's hostile-history property -- while REFUSING a local row and a folded
    -- row for the same PR finding to sit side by side. Two partial indexes keyed on
    -- source_scope allowed exactly that, and a local row the fold then declined to
    -- adopt left the scope answering incomplete for ever.
    --
    -- One store holds one universe, so a pr maps to exactly one scope: (pr, id) and
    -- (source_scope, id) are the same constraint over shared rows, and (pr, id) covers
    -- the local ones too.
    CREATE UNIQUE INDEX IF NOT EXISTS ix_findings_identity ON findings(pr, id);
    CREATE INDEX IF NOT EXISTS ix_findings_target ON findings(target_id);
    CREATE INDEX IF NOT EXISTS ix_findings_queue ON findings(pr, needs_ack);
    CREATE INDEX IF NOT EXISTS ix_findings_scope ON findings(source_scope);
    -- ord and author are columns rather than part of the JSON because neither
    -- survives a round trip through it: versions are ORDERED (oldest first) and a
    -- Map key order is not a document property, and SharedDoc.authors is a Map,
    -- which JSON.stringify turns into {}.
    -- The citation edge, lifted out of the JSON. READ, by the section-5 reverse

    -- Triage, one row per (target, field). ONE canonical table, so a teammate's stakes
    -- are an ordinary row with an origin rather than a parallel table needing a bridge
    -- onto every surface — the rule that removed the shared_doc_* tables.
    -- See docs/shared-triage.md.
    --
    -- Per FIELD, not per target, because each asserted field carries its own receipt:
    -- a record whose importance is a human's and whose complexity is an agent's has no
    -- single truthful source, reason or witnesses. Collapsing them to one row is
    -- the compound-value bug the design exists to avoid.
    CREATE TABLE IF NOT EXISTS triage (
      target_kind TEXT NOT NULL,          -- 'node' | 'anchor'
      target_id TEXT NOT NULL,
      field TEXT NOT NULL,                -- 'importance' | 'complexity' | 'tripwire'
      value TEXT NOT NULL,
      -- The receipt for THIS field.
      source TEXT NOT NULL,               -- TriageSource
      likely INTEGER NOT NULL DEFAULT 0,
      generated_by TEXT,
      reason TEXT,
      at TEXT NOT NULL,
      -- Who asserted it, as JSON Actor. NULL on a local row: it is this store's user,
      -- and legacy marks carry a source but no actor at all.
      actor TEXT,
      -- The commit the assertion was made at. A body hash decides whether a claim
      -- applies here; only a locator can retrieve or explain the writer's version.
      asserted_commit TEXT,
      witnesses TEXT NOT NULL DEFAULT '[]',
      -- Provenance, exactly as node_versions: NULL origin = this user wrote it.
      origin TEXT, source_scope TEXT,
      -- The fold's whole answer for THIS field, as a JSON Axis: the human baseline,
      -- the agent escalation over it, the concurrent receipts it won against. The
      -- columns above carry the EFFECTIVE receipt so every ordinary reader works
      -- unchanged; this is what makes the projection's read/write round trip exact,
      -- and it is NULL on a local row, which has no baseline but itself.
      detail TEXT
    );
    -- PARTIAL indexes, and they are not interchangeable with one composite UNIQUE.
    -- SQLite does not conflict NULLs, so UNIQUE(target_kind,target_id,field,source_scope)
    -- admits unlimited duplicate LOCAL rows — measured, it inserts two happily.
    CREATE UNIQUE INDEX IF NOT EXISTS ix_triage_local ON triage(target_kind, target_id, field)
      WHERE source_scope IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ix_triage_shared ON triage(source_scope, target_kind, target_id, field)
      WHERE source_scope IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ix_triage_target ON triage(target_id);

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
  // node_versions provenance (docs unification). Additive, and additive is
  // load-bearing here: local rows are the ONE thing in this database that is not
  // regenerable — human docs live there and nowhere else — so "delete it and re-init"
  // is never a revert path for this table.
  for (const col of ["origin TEXT", "source_scope TEXT", "publication_state TEXT", "ord INTEGER", "author TEXT"]) {
    try { d.exec(`ALTER TABLE node_versions ADD COLUMN ${col}`); } catch { /* already present */ }
  }
  // AFTER the ladder, never in the CREATE block above. On a fresh database the
  // `CREATE TABLE` already has `source_scope`, so an index on it there works and the
  // whole suite passes. On an EXISTING one the table is a no-op, the column does not
  // arrive until the ALTER below, and indexing it throws `no such column` — which
  // fails `migrate`, which fails `db()`, which means the build cannot open any store
  // that predates the column. Found by opening a real store; no test could catch it
  // because every test starts from an empty database.
  // A per-fold `DELETE WHERE source_scope = ?` is a table scan without it.
  try { d.exec("CREATE INDEX IF NOT EXISTS ix_nv_scope ON node_versions(source_scope)"); } catch { /* fine */ }
  // triage.detail — added with the fold, for stores created between the table landing
  // and it. Same ladder rule as everything above: the CREATE block has it on a fresh
  // database, and an existing one needs the ALTER or `no such column` fails `migrate`.
  try { d.exec("ALTER TABLE triage ADD COLUMN detail TEXT"); } catch { /* already present */ }
  // edges provenance (graph sync). Additive, and on the ladder rather than in the
  // CREATE block above for the reason that block already records: an existing store's
  // table is a no-op, so the column only arrives here, and an index on it in CREATE
  // would fail `migrate` on every store that predates it.
  for (const col of ["origin TEXT", "source_scope TEXT"]) {
    try { d.exec(`ALTER TABLE edges ADD COLUMN ${col}`); } catch { /* already present */ }
  }
  try { d.exec("CREATE INDEX IF NOT EXISTS ix_edges_scope ON edges(source_scope)"); } catch { /* fine */ }
  // A per-fold `DELETE WHERE source_scope = ?` is a table scan without it.
  try { d.exec("CREATE INDEX IF NOT EXISTS ix_triage_scope ON triage(source_scope)"); } catch { /* fine */ }
  // The `shared_scope.status` / `.diagnostic` rungs are GONE with the protocol-1
  // freeze: both columns are in the CREATE above, and the only stores that ever
  // lacked them were dev stores on this branch. The four rungs that remain are core
  // tables with real stores behind them and are NOT part of the freeze.
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
