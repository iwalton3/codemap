import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { db } from "./db.js";
import { discard } from "./test-tmp.js";

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
  } finally { discard(root); }
});

/**
 * The scrub policy is the only record in the standard whose id is a CONSTANT, so
 * "replaces only what it owns" cannot be expressed by scope alone.
 *
 * A store that set a policy locally and then joined a team holds `pol_standard` with a null
 * `source_scope`. The scoped DELETE does not touch it and a plain INSERT then raises a
 * UNIQUE violation inside `readCached`'s transaction — the fold throws, nothing moves the
 * fingerprint, and it never self-heals. Worse than a crash here: `standardScopeWarning`
 * catches it and reports `stale`, so the machine stops syncing the standard silently.
 */
test("the fold adopts a locally-set scrub policy instead of colliding with it", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-pol-"));
  try {
    mkdirSync(join(root, ".codemap"), { recursive: true });
    const { writeLocalScrubPolicy, readScrubPolicy } = await import("./store.js");
    const { standardProjection } = await import("./shared-projections.js");
    const { emptyStandard } = await import("./shared-standard.js");
    const izzie = { principal: "izzie@x.com" };

    await writeLocalScrubPolicy(root, { coverageDays: 30, minObservations: 3, setBy: izzie, setAt: "2026-08-01T00:00:00.000Z" });
    assert.equal((await readScrubPolicy(root))!.coverageDays, 30);

    standardProjection.write(db(root), "standard/acme/api", {
      ...emptyStandard(),
      scrubPolicy: { coverageDays: 7, minObservations: 5, setBy: izzie, setAt: "2026-08-02T00:00:00.000Z" },
    });
    // Adopted, not duplicated and not crashed. The team's decision is the one that stands.
    const rows = db(root).prepare("SELECT id, source_scope FROM scrub_policy").all() as unknown as { source_scope: string | null }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.source_scope, "standard/acme/api");
    assert.equal((await readScrubPolicy(root))!.coverageDays, 7);
  } finally { discard(root); }
});

/**
 * Changing what the standard fold PROJECTS requires bumping `MATERIALIZER_VERSION`.
 *
 * The fingerprint is over the sidecar's shards, which do not move when the fold's mind
 * changes — so a store that has already folded a scope keeps serving its cached rows under
 * the old number for ever. That is stated at 6 -> 7 and again at 12 -> 13, and it was still
 * missed when six tables were added to this scope at once: nothing failed, because nothing
 * checked. Here is the check.
 *
 * It cannot know whether a fold's LOGIC changed — only a reader can — but the table set is
 * the coarse signal that catches the case that has actually happened twice.
 */
test("the standard projection's table set is pinned to a materializer version", async () => {
  const { MATERIALIZER_VERSION } = await import("./materialize.js");
  const src = readFileSync("src/shared-projections.ts", "utf8");
  const block = src.slice(src.indexOf("export const standardProjection"));
  const tables = [...new Set([...block.matchAll(/INSERT (?:OR REPLACE )?INTO (\w+)\(/g)].map((m) => m[1]!))].sort();

  // Bump BOTH when the standard fold starts projecting something new. If you are reading
  // this because the assertion failed: the table list changing means clones with cached
  // rows will not re-fold unless the version moves.
  assert.deepEqual(tables, [
    "acknowledgements", "audits", "criteria", "operations", "pointers", "populations",
    "problems", "proposal_witnesses", "requirements", "scrub_policy", "specs", "vacuity_checks",
  ], "the standard projection's tables changed — bump MATERIALIZER_VERSION with them");
  // 16: the standard folds from TWO scopes now (law + evidence), so a store that cached
  // the single-scope fold holds rows describing a different input set — and only the
  // shards move a fingerprint. The table set did NOT change, which is exactly why the
  // version has to be recorded here as well: this test's coarse signal would not have
  // caught it.
  // 17: a draft spec has a correction path — three new law events fold, and the
  // withdrawal gate admits an agent's own draft. Table set unchanged again, same reason.
  // 18: `proposal_witnesses` — this time the table set DID change, which is the case this
  // assertion was written for, and the fold refuses an unwitnessed ratification with it.
  assert.equal(MATERIALIZER_VERSION, 18, "and record the new number here");
});

/**
 * No backticks inside the DDL, which is a template literal they would close.
 *
 * This has bitten three times — twice before it was written down in
 * `codemap-requirement-kernel`'s defect shapes, and once after. The failure is loud (a
 * syntax error) but the cost is a debugging round every time, and the habit that causes it
 * is the ordinary one of quoting an identifier in a comment. A lint costs nothing.
 */
test("the schema DDL contains no backticks", () => {
  const src = readFileSync("src/db.ts", "utf8");
  // The literal itself, from `d.exec(\`` to its closing backtick — not a text window, which
  // would sweep in the ordinary prose comments around it and fail on every one of them.
  const open = src.indexOf("d.exec(`");
  const close = src.indexOf("\n  `);", open);
  assert.ok(open > 0 && close > open, "the DDL literal moved — this lint is looking in the wrong place");
  const ddl = src.slice(open + "d.exec(`".length, close);
  assert.ok(ddl.includes("CREATE TABLE"), "found something that is not the DDL");
  const offenders = ddl.split("\n")
    .map((line, i) => ({ line, n: i }))
    .filter((x) => x.line.includes("`"));
  assert.deepEqual(offenders.map((x) => x.line.trim()), [],
    "a backtick inside db.ts's DDL closes the template literal — quote identifiers with \"double quotes\" instead");
});
