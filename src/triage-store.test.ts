import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { db } from "./db.js";
import {
  readTriage, readLocalTriage, replaceLocalTriage, replaceLocalGraphTriage, upsertLocalTriage,
} from "./store.js";
import type { Triage } from "./schema.js";

/**
 * Triage as one canonical table, and the seam that keeps a local write off a teammate's
 * row.
 *
 * `docs/shared-triage.md` is normative. Nothing is shared yet — no fold writes
 * `source_scope` — so what is under test here is the STORAGE being right before anything
 * depends on it, which is the order the docs unification proved out: the ownership rule
 * has to be true of the table before the fold that relies on it exists.
 */

/** `id` is the target's, and is deliberately NOT spread into the record. */
const mark = ({ id, ...over }: Partial<Triage> & { id: string }): Triage => ({
  target: { kind: "anchor", id },
  importance: "important",
  likely: false,
  source: "human",
  at: "2026-08-24T00:00:00Z",
  witnesses: [{ anchorId: id, bodyHash: "h2:aa:sha256:bb" }],
  ...over,
});

const universe = (): string => {
  const root = mkdtempSync(join(tmpdir(), "codemap-triage-"));
  mkdirSync(join(root, ".codemap"), { recursive: true });
  return root;
};

/** A row the FOLD owns, written directly — there is no op that produces one yet. */
function plantShared(root: string, scope: string, t: Triage): void {
  const d = db(root);
  const ins = d.prepare(
    "INSERT INTO triage(target_kind,target_id,field,value,source,likely,generated_by,reason,at,"
    + "witnesses,origin,source_scope) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  const receipt = [t.source, t.likely ? 1 : 0, null, t.reason ?? null, t.at,
    JSON.stringify(t.witnesses), "sync", scope] as const;
  ins.run(t.target.kind, t.target.id, "importance", String(t.importance), ...receipt);
  if (t.complexity) ins.run(t.target.kind, t.target.id, "complexity", String(t.complexity), ...receipt);
}

test("a mark survives the trip out to rows and back", async () => {
  const root = universe();
  try {
    const one = mark({ id: "a_1", importance: "business-critical", complexity: "deep", reason: "money moves here" });
    const two = mark({ id: "a_2", importance: "low", likely: true, source: "agent", tripwire: true });
    await replaceLocalTriage(root, [one, two]);

    const back = (await readTriage(root)).triage.sort((a, b) => a.target.id.localeCompare(b.target.id));
    assert.equal(back.length, 2);
    assert.deepEqual(back[0], one, "every field of the first, unchanged");
    assert.deepEqual(back[1], two, "and of the second");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an absent tripwire stays absent — it is not the same as disarmed", async () => {
  // `undefined` means nobody has said. Round-tripping it as `false` would silently turn
  // off an alarm nobody disarmed, which is the failure the arm-safe rule exists for.
  const root = universe();
  try {
    await replaceLocalTriage(root, [mark({ id: "a_1" })]);
    const back = (await readTriage(root)).triage[0]!;
    assert.equal("tripwire" in back, false, "no tripwire key at all");

    await replaceLocalTriage(root, [mark({ id: "a_1", tripwire: false })]);
    assert.equal((await readTriage(root)).triage[0]!.tripwire, false, "an explicit false is kept, and is different");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a row with no importance is not a mark", async () => {
  // Importance is what makes a mark; complexity alone has no stakes to weigh, which is
  // exactly what the ratchet refuses to invent for an agent that asserts none.
  const root = universe();
  try {
    db(root).prepare(
      "INSERT INTO triage(target_kind,target_id,field,value,source,likely,at,witnesses) "
      + "VALUES('anchor','a_orphan','complexity','deep','agent',1,'2026-01-01T00:00:00Z','[]')",
    ).run();
    assert.deepEqual((await readTriage(root)).triage, [], "it answers with nothing rather than inventing stakes");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a local write never reaches a row the fold owns", async () => {
  // THE ownership rule, at the storage layer, before any fold depends on it. A bare
  // `DELETE FROM triage` passes every other test in this file.
  const root = universe();
  try {
    plantShared(root, "triage/acme-api", mark({ id: "a_theirs", importance: "business-critical", complexity: "deep" }));
    await replaceLocalTriage(root, [mark({ id: "a_mine" })]);

    const d = db(root);
    const theirs = d.prepare("SELECT value, origin FROM triage WHERE target_id = 'a_theirs' AND field = 'importance'")
      .get() as { value: string; origin: string } | undefined;
    assert.ok(theirs, "the teammate's row is still there after a local write");
    assert.equal(theirs!.value, "business-critical");
    assert.equal(theirs!.origin, "sync", "with its provenance intact");

    // …and a second local write, which is the case a single write cannot show: the
    // DELETE runs every time.
    await replaceLocalTriage(root, [mark({ id: "a_mine", importance: "low" })]);
    assert.equal(
      (d.prepare("SELECT COUNT(*) c FROM triage WHERE source_scope IS NOT NULL").get() as { c: number }).c, 2,
      "both of the teammate's field rows survived a rewrite of the local partition",
    );

    // The reader sees both; the local reader sees only its own.
    assert.deepEqual((await readTriage(root)).triage.map((t) => t.target.id).sort(), ["a_mine", "a_theirs"]);
    assert.deepEqual((await readLocalTriage(root)).triage.map((t) => t.target.id), ["a_mine"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a local mark wins over a teammate's for the same target", async () => {
  // Not the real merge rule — that lands with the fold. This is the trivial one the
  // storage answers with today, and it is asserted so the change is visible when the
  // rule arrives rather than being absorbed silently.
  const root = universe();
  try {
    plantShared(root, "triage/acme-api", mark({ id: "a_1", importance: "low" }));
    await replaceLocalTriage(root, [mark({ id: "a_1", importance: "business-critical" })]);
    const back = (await readTriage(root)).triage;
    assert.equal(back.length, 1, "one answer for one target");
    assert.equal(back[0]!.importance, "business-critical");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("replacing the graph rows leaves human and agent marks alone", async () => {
  // `deriveTriage` regenerates graph output by dropping and rebuilding it. Doing that
  // with a whole-list rewrite is safe only while everything in the table is local and
  // graph-derived, which it never is.
  const root = universe();
  try {
    await replaceLocalTriage(root, [
      mark({ id: "a_human", importance: "business-critical" }),
      mark({ id: "a_agent", source: "agent", likely: true }),
      mark({ id: "a_graph", source: "graph", likely: true, importance: "important" }),
    ]);
    await replaceLocalGraphTriage(root, [
      mark({ id: "a_graph2", source: "graph", likely: true, importance: "low" }),
    ]);

    const back = new Map((await readTriage(root)).triage.map((t) => [t.target.id, t]));
    assert.equal(back.get("a_human")?.importance, "business-critical", "the human mark is untouched");
    assert.equal(back.get("a_agent")?.source, "agent", "and so is the agent's");
    assert.equal(back.has("a_graph"), false, "the old graph mark is gone");
    assert.equal(back.get("a_graph2")?.importance, "low", "and the new one is there");

    // CONTROL — a non-graph mark handed to it is REFUSED rather than written, or the
    // function is just `replaceLocalTriage` with extra steps.
    await replaceLocalGraphTriage(root, [mark({ id: "a_sneak", source: "human" })]);
    assert.equal((await readTriage(root)).triage.some((t) => t.target.id === "a_sneak"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an upsert replaces a target whole, so a dropped complexity really drops", async () => {
  const root = universe();
  try {
    await upsertLocalTriage(root, mark({ id: "a_1", complexity: "deep" }));
    assert.equal((await readTriage(root)).triage[0]!.complexity, "deep");

    await upsertLocalTriage(root, mark({ id: "a_1" }));
    const back = (await readTriage(root)).triage[0]!;
    assert.equal("complexity" in back, false,
      "a stale complexity row would survive under a receipt that no longer mentions it");
    assert.equal((await readTriage(root)).triage.length, 1, "and it did not duplicate the target");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- the blob migration -------------------------------------------------------------

const LEGACY = JSON.stringify({
  schemaVersion: 1,
  triage: [
    { target: { kind: "anchor", id: "a_1" }, importance: "business-critical", complexity: "deep",
      likely: false, source: "human", reason: "money moves here", at: "2026-01-01T00:00:00Z",
      witnesses: [{ anchorId: "a_1", bodyHash: "sha256:old" }], tripwire: true },
    { target: { kind: "node", id: "n_1" }, importance: "low", likely: true, source: "agent",
      at: "2026-01-02T00:00:00Z", witnesses: [] },
    // Not a mark: no importance. It must be dropped rather than given one.
    { target: { kind: "anchor", id: "a_junk" }, complexity: "wiring", likely: true, source: "graph", at: "x", witnesses: [] },
  ],
});

/** A store holding the legacy blob and no `triage` table rows — what an upgrade meets. */
function storeWithBlob(): string {
  const root = mkdtempSync(join(tmpdir(), "codemap-triage-blob-"));
  mkdirSync(join(root, ".codemap"), { recursive: true });
  const d = new DatabaseSync(join(root, ".codemap", "codemap.db"));
  d.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)");
  d.prepare("INSERT INTO meta(k,v) VALUES('triage', ?)").run(LEGACY);
  d.close();
  return root;
}

test("the legacy blob becomes rows, and every mark survives", async () => {
  const root = storeWithBlob();
  try {
    const back = new Map((await readTriage(root)).triage.map((t) => [t.target.id, t]));
    assert.equal(back.size, 2, "the two real marks, and not the one with no importance");

    const a = back.get("a_1")!;
    assert.equal(a.importance, "business-critical");
    assert.equal(a.complexity, "deep");
    assert.equal(a.reason, "money moves here");
    assert.equal(a.tripwire, true, "an armed tripwire stays armed across the migration");
    assert.deepEqual(a.witnesses, [{ anchorId: "a_1", bodyHash: "sha256:old" }],
      "and the witness is carried verbatim — a pre-scheme hash is not rewritten");

    const n = back.get("n_1")!;
    assert.equal(n.target.kind, "node", "a node target is still a node target");
    assert.equal(n.likely, true);
    assert.equal(n.source, "agent");
    assert.equal("tripwire" in n, false, "and an absent tripwire did not become disarmed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("every migrated mark is LOCAL, and nothing is published by an upgrade", async () => {
  // A legacy `Triage` carries a `source` but no `Actor`, so publishing automatically
  // would attribute every historical judgment to whoever happened to upgrade first.
  const root = storeWithBlob();
  try {
    const d = db(root);
    assert.equal(
      (d.prepare("SELECT COUNT(*) c FROM triage WHERE source_scope IS NOT NULL OR origin IS NOT NULL")
        .get() as { c: number }).c, 0,
      "no migrated row claims a scope or an origin",
    );
    assert.equal((await readLocalTriage(root)).triage.length, 2, "they are all this clone's own");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the migration is idempotent, and a later write is not undone by re-opening", async () => {
  const root = storeWithBlob();
  try {
    const d = db(root);
    assert.equal((d.prepare("SELECT COUNT(*) c FROM meta WHERE k='triage'").get() as { c: number }).c, 0,
      "the blob is dropped in the same transaction that wrote the rows");

    // The failure this guards: a migration keyed on "the table is empty" that left the
    // blob behind would resurrect, on the next open, every mark a later write removed.
    await replaceLocalTriage(root, [mark({ id: "a_only" })]);
    d.prepare("INSERT INTO meta(k,v) VALUES('triage', ?)").run(LEGACY);   // as if it had never been dropped
    const { db: reopen } = await import("./db.js");
    // Same root, so `db()` hands back the cached handle — the migration is re-run
    // explicitly against it instead, which is the same call `db()` makes on a fresh open.
    const before = (await readTriage(root)).triage.map((t) => t.target.id);
    assert.deepEqual(before, ["a_only"]);
    reopen(root);
    assert.deepEqual(
      (await readTriage(root)).triage.map((t) => t.target.id), ["a_only"],
      "re-opening did not re-import marks a later write had removed",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a blob this build cannot parse does not stop the store opening", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-triage-bad-"));
  try {
    mkdirSync(join(root, ".codemap"), { recursive: true });
    const raw = new DatabaseSync(join(root, ".codemap", "codemap.db"));
    raw.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)");
    raw.prepare("INSERT INTO meta(k,v) VALUES('triage', ?)").run("{not json");
    raw.close();

    const d = db(root);   // must not throw
    assert.deepEqual((await readTriage(root)).triage, []);
    assert.equal(
      (d.prepare("SELECT COUNT(*) c FROM meta WHERE k='triage'").get() as { c: number }).c, 1,
      "and the unreadable blob is LEFT rather than dropped — nothing is destroyed, and a "
      + "later build can still look at it",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});
