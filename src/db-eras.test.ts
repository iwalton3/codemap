import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { db } from "./db.js";
import { readTriage } from "./store.js";
import { SCHEMA_ERAS, buildEra, type SchemaEra } from "./schema-eras.js";
import { discard } from "./test-tmp.js";

/**
 * A store from every schema era this project has had, opened by the current build.
 *
 * `db-migrate.test.ts` covers ONE hop, by hand. This covers the ladder from the first
 * commit forward, against schemas transcribed from `db.ts`'s own history rather than
 * invented — which is the difference between testing the migration and testing a
 * migration-shaped thing.
 *
 * Three claims per era, and all three are needed:
 *
 *   1. it OPENS — `db()` runs the whole ladder without throwing;
 *   2. the ladder actually RAN — the columns that era lacked are there afterwards;
 *   3. the data SURVIVED — a "migration" that dropped and recreated a table passes
 *      (1) and (2) and is a total loss of the one thing in this database that cannot
 *      be regenerated.
 */

/** A store on disk holding exactly what a build of that era would have written. */
function storeOfEra(era: SchemaEra): string {
  const root = mkdtempSync(join(tmpdir(), `codemap-era-${era.era}-`));
  mkdirSync(join(root, ".codemap"), { recursive: true });
  const d = new DatabaseSync(join(root, ".codemap", "codemap.db"));
  try { buildEra(d, era); } finally { d.close(); }
  return root;
}

const columnsOf = (d: DatabaseSync, table: string): string[] =>
  (d.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((c) => c.name).sort();

const tablesOf = (d: DatabaseSync): string[] =>
  (d.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as unknown as { name: string }[])
    .map((t) => t.name);

/** Every column the current build's ladder must have added by the time it is done. */
const REQUIRED: Record<string, string[]> = {
  anchors: ["derivation"],
  node_versions: ["removed", "origin", "source_scope", "publication_state", "ord", "author"],
  snapshots: ["scheme", "hash_scheme"],
  // NOT `shared_scope`. Its `status`/`diagnostic` rungs were deliberately removed with
  // the protocol-1 freeze; the boundary that creates is asserted on its own below.
};

for (const era of SCHEMA_ERAS) {
  test(`a ${era.era} store (${era.commit}) still opens, and keeps what it held`, async () => {
    const root = storeOfEra(era);
    try {
      const d = db(root);

      // 2. The ladder ran, wherever a table exists to run it against. `genesis` has no
      // `node_versions` and no `shared_scope`, so those are not skipped for
      // convenience — they simply are not part of that era's claim.
      const tables = tablesOf(d);
      for (const [table, needed] of Object.entries(REQUIRED)) {
        if (!tables.includes(table)) continue;
        const cols = columnsOf(d, table);
        for (const col of needed) {
          assert.ok(cols.includes(col), `${era.era}: the ladder did not add ${table}.${col}`);
        }
      }

      // 3. The data. Every era seeds these, and every one is a row a person's work
      // depends on.
      const anchor = d.prepare("SELECT file, body_hash, derivation FROM anchors WHERE id = 'a_old'")
        .get() as { file: string; body_hash: string; derivation: number | null } | undefined;
      assert.ok(anchor, `${era.era}: the anchor is gone`);
      assert.equal(anchor!.file, "src/pay.ts");
      assert.equal(anchor!.body_hash, "h1:sha256:abc", "and its hash was not rewritten");
      assert.equal(anchor!.derivation, null,
        "an index made before provenance existed cannot say how it was derived, and must not be given a made-up answer");

      const node = d.prepare("SELECT title, body FROM nodes WHERE id = 'n_old'")
        .get() as { title: string; body: string } | undefined;
      assert.equal(node?.body, "the body", `${era.era}: the doc body is gone`);

      const edge = d.prepare("SELECT to_id FROM edges WHERE from_id = 'n_old'").get() as { to_id: string } | undefined;
      assert.equal(edge?.to_id, "n_other", `${era.era}: the edge is gone`);

      // Through the store seam rather than by raw SQL, because that is what every
      // caller does — and triage lives in `meta` as a blob, which a ladder cannot fix
      // if it ever gets it wrong.
      const triage = await readTriage(root);
      assert.equal(triage.triage.length, 1, `${era.era}: the triage mark is gone`);
      assert.equal(triage.triage[0]!.importance, "business-critical");
      assert.equal(triage.triage[0]!.target.id, "a_old");

      // On what the ERA SEEDED, not on the migrated table: `genesis` has no
      // `node_versions` to seed, and after the ladder it has the table but no `nv_old`
      // — its doc is back-filled under a fresh id, which the next test is about.
      if (era.seed.some((stmt) => stmt.includes("nv_old"))) {
        const v = d.prepare("SELECT node_id, body, citations, origin FROM node_versions WHERE version_id = 'nv_old'")
          .get() as { node_id: string; body: string; citations: string; origin: string | null } | undefined;
        assert.ok(v, `${era.era}: the doc VERSION is gone`);
        assert.equal(v!.body, "the body");
        assert.deepEqual(JSON.parse(v!.citations), [{ anchorId: "a_old", acceptedHashes: ["h1:sha256:abc"] }]);
        assert.equal(v!.origin, null,
          "a row that was already local is not retroactively made the fold's — origin is who wrote it, "
          + "and a ladder that defaulted it would hand every existing doc to a scope nobody published to");
      }
    } finally { discard(root); }
  });
}

test("a store from before node_versions gets its docs back-filled, not lost", async () => {
  // `genesis` is the only era where a doc exists ONLY as a `nodes` row. Opening it has
  // to produce a version, or every doc written before versioning silently stops being
  // a doc — the ladder is not the whole migration, and this is the part a column check
  // cannot see.
  const era = SCHEMA_ERAS.find((e) => e.era === "genesis")!;
  const root = storeOfEra(era);
  try {
    const d = db(root);
    const rows = d.prepare("SELECT node_id, title, body, citations FROM node_versions WHERE node_id = 'n_old'")
      .all() as unknown as { node_id: string; title: string; body: string; citations: string }[];
    assert.equal(rows.length, 1, "the unversioned doc became exactly one version");
    assert.equal(rows[0]!.body, "the body", "with its prose intact");
    // The citation is rebuilt from the node's own anchor list, which is the only place
    // it existed at that era.
    assert.deepEqual(
      JSON.parse(rows[0]!.citations).map((c: { anchorId: string }) => c.anchorId), ["a_old"],
      "and its anchors became citations",
    );
  } finally { discard(root); }
});

test("a store with data in tables this build no longer writes keeps it", async () => {
  // `shared_doc` / `shared_doc_version` / `shared_doc_citation` were replaced when a
  // teammate's doc became an ordinary `node_versions` row. Nothing writes them now, so
  // it would be easy to drop them — and a real store still holds a colleague's work in
  // them. Not reading a table is not a reason to destroy it.
  const era = SCHEMA_ERAS.find((e) => e.era === "parallel-doc-tables")!;
  const root = storeOfEra(era);
  try {
    const d = db(root);
    const row = d.prepare("SELECT body FROM shared_doc_version WHERE version_id = 'sv_1'")
      .get() as { body: string } | undefined;
    assert.ok(row, "the retired table is still there");
    assert.match(JSON.parse(row!.body).body, /a teammate wrote this/, "with its content untouched");
    assert.equal(
      (d.prepare("SELECT COUNT(*) c FROM shared_doc_citation").get() as { c: number }).c, 1,
      "and so is the citation edge beside it",
    );
  } finally { discard(root); }
});

test("a pre-freeze shared_scope is NOT migrated, and that is a decision", async () => {
  // `db.ts` removed the `shared_scope.status` / `.diagnostic` rungs on the grounds that
  // "the only stores that ever lacked them were dev stores on this branch". That claim
  // is TRUE and now measured twice: `370f261` is on no branch but this one (`git
  // merge-base --is-ancestor 370f261 main` fails), and none of the four live universes
  // under `/working/` has a `shared_scope` table at all — so `CREATE TABLE IF NOT
  // EXISTS` hands every real store the modern one.
  //
  // The consequence is worth pinning rather than leaving implicit, because it is the
  // exact shape of the defect `febbc09` shipped: a store that predates the columns
  // cannot be read AT ALL, not merely partially. Anyone still holding a mid-branch dev
  // store from before the freeze must delete it.
  //
  // INVERTED, like the walls in `oracle-handoff.test.ts`: if the rungs are ever
  // restored this fails, and the fix is to move `shared_scope` into REQUIRED above —
  // not to delete the test.
  const era = SCHEMA_ERAS.find((e) => e.era === "materialized")!;
  const root = storeOfEra(era);
  try {
    const d = db(root);
    assert.equal(
      columnsOf(d, "shared_scope").includes("status"), false,
      "THE RUNG IS BACK — good. Put `shared_scope: [\"status\", \"diagnostic\"]` into REQUIRED and delete this.",
    );
    // And it really is fatal, not cosmetic. Every ordinary shared read goes through
    // `readCached`, which selects the column.
    //
    // The log root must EXIST, and that is not incidental: `readCached` now returns early
    // when the configured sidecar is not there, rather than folding its absence into an
    // empty projection and wiping the rows. A nonexistent path short-circuits before the
    // query this is about ever runs, and the test passes for the wrong reason. `root` is
    // a real directory holding no scopes, which is what this needs.
    const { readCached } = await import("./materialize.js");
    await assert.rejects(
      () => readCached(root, root, "findings/acme-api/pr-1", "identity",
        () => new Map<string, unknown>(), { write() {}, read: () => new Map<string, unknown>() }),
      /no such column: status/,
      "a pre-freeze store fails the read outright",
    );
  } finally { discard(root); }
});

test("CONTROL: a store already at the current schema is not disturbed by any of this", async () => {
  // Without this the whole file passes on a ladder that recreated everything from
  // scratch on every open — which would satisfy every column check above and lose a
  // live store's docs on the first `codemap check` anybody ran.
  const root = mkdtempSync(join(tmpdir(), "codemap-era-current-"));
  try {
    mkdirSync(join(root, ".codemap"), { recursive: true });
    const first = db(root);
    first.exec(
      "INSERT INTO node_versions(version_id,node_id,type,title,summary,body,created_at,citations) "
      + "VALUES('nv_now','n_now','concept','Now','s','fresh prose','2026-08-24T00:00:00Z','[]')",
    );
    const before = tablesOf(first).join(",");

    // Open it AGAIN, as a different root. `db()` memoises per root, so re-calling it
    // here would hand back the same handle and run `migrate` zero more times — which
    // is precisely the thing being tested. A copy is a second first-open.
    const copy = mkdtempSync(join(tmpdir(), "codemap-era-copy-"));
    try {
      cpSync(join(root, ".codemap"), join(copy, ".codemap"), { recursive: true });
      const again = db(copy);
      assert.equal(tablesOf(again).join(","), before, "running the ladder over a current store changed no table");
      const row = again.prepare("SELECT body FROM node_versions WHERE version_id = 'nv_now'")
        .get() as { body: string } | undefined;
      assert.equal(row?.body, "fresh prose", "and the row written before it is still there");
    } finally { discard(copy); }
  } finally { discard(root); }
});

/**
 * The fixtures really are the shapes those commits produced.
 *
 * Skips when the history is unavailable (a shallow clone, a tarball), which is what
 * keeps `npm run unit` hermetic — the fixture itself never needs git, only this check
 * does. Comparing TABLES AND COLUMNS rather than text: the transcription strips
 * comments and the point is the shape, not the formatting.
 */
test("every era's SQL matches what its commit really produced", { skip: skipUnlessHistory() }, () => {
  for (const era of SCHEMA_ERAS) {
    const historic = schemaOf(migrateSqlAt(era.commit));
    const fixture = schemaOf(era.sql);
    assert.deepEqual(
      fixture, historic,
      `the ${era.era} fixture is not the schema ${era.commit} produced. Re-extract it rather than `
      + `editing it by hand — a fixture that drifts is a migration test against a store nobody ever had.`,
    );
  }
});

function skipUnlessHistory(): string | false {
  try {
    execFileSync("git", ["cat-file", "-e", `${SCHEMA_ERAS[0]!.commit}:src/db.ts`], { stdio: "ignore" });
    return false;
  } catch {
    return "no git history here — the fixtures stand on their own; only this cross-check needs it";
  }
}

/** Every statement `migrate()` executed at a commit: its template block plus its rungs. */
function migrateSqlAt(sha: string): string[] {
  const src = execFileSync("git", ["show", `${sha}:src/db.ts`], { encoding: "utf8" });
  const start = src.indexOf("function migrate(d: DatabaseSync): void {");
  assert.ok(start >= 0, `no migrate() at ${sha}`);
  const body = src.slice(start, src.indexOf("\n}", start));
  const parts: string[] = [];
  for (const m of body.matchAll(/d\.exec\(`([\s\S]*?)`\)/g)) parts.push(m[1]!);
  for (const m of body.matchAll(/d\.exec\("([^"]+)"\)/g)) parts.push(m[1]!);
  // The ALTER rungs written as a loop over a column list.
  for (const m of body.matchAll(/for \(const col of \[([^\]]+)\]\)[\s\S]*?ALTER TABLE (\w+) ADD COLUMN \$\{col\}/g)) {
    for (const c of m[1]!.split(",")) parts.push(`ALTER TABLE ${m[2]} ADD COLUMN ${c.trim().replace(/^["']|["']$/g, "")};`);
  }
  return parts;
}

/** Tables and their columns, after running whatever statements are given. */
function schemaOf(statements: string[]): Record<string, string[]> {
  const d = new DatabaseSync(":memory:");
  try {
    // A rung that has already been applied throws, exactly as it does in `migrate`,
    // and exactly as `migrate` does we carry on.
    for (const s of statements) { try { d.exec(s); } catch { /* already present */ } }
    const out: Record<string, string[]> = {};
    for (const t of tablesOf(d)) out[t] = columnsOf(d, t);
    return out;
  } finally { d.close(); }
}
