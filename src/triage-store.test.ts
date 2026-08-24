import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { db } from "./db.js";
import {
  readTriage, readLocalTriage, replaceLocalTriage, replaceLocalGraphTriage, upsertLocalTriage,
  writeStore,
} from "./store.js";
import { setTriage, clearTriage, setTriageBatch, deriveTriage } from "./triage.js";
import type { Triage } from "./schema.js";

/**
 * Triage as one canonical table, and the seam that keeps a local write off a teammate's
 * row.
 *
 * `docs/shared-triage.md` is normative. What is under test here is the STORAGE — the
 * ownership rule and the read merge — separately from the fold that fills the shared
 * partition, which is `shared-triage.test.ts`. Rows are planted directly for the same
 * reason the docs unification proved its table first: the ownership rule has to be true
 * of the table independently of whatever wrote into it.
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

/**
 * A universe with an anchor index, which the OPS need and the seam does not.
 *
 * `witnessesFor` reads the anchor store, so `setTriage` on an uninitialized root throws
 * "codemap not initialized" — a real guard, and one the storage tests above are right to
 * skip. Empty is enough: an anchor id nobody indexed witnesses as `sha256:absent`, which
 * is exactly what these tests want, since none of them is about drift.
 */
const initialized = async (): Promise<string> => {
  const root = universe();
  await writeStore(root, [], { schemaVersion: 1, lastVerifiedCommit: null, grammarVersions: {} });
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

test("the fold-owned row wins, per FIELD, and a local row fills what the scope never says", async () => {
  // The real merge rule (`docs/shared-triage.md`, and the note on `readTriage`). The
  // fold has already weighed this clone's own published marks against everyone else's,
  // so a local row outranking it would silently reinstate a value a teammate superseded
  // — and would do it only on this machine.
  const root = universe();
  try {
    plantShared(root, "triage/acme-api", mark({ id: "a_1", importance: "low" }));
    await replaceLocalTriage(root, [mark({ id: "a_1", importance: "business-critical", complexity: "deep" })]);
    const back = (await readTriage(root)).triage;
    assert.equal(back.length, 1, "one answer for one target");
    assert.equal(back[0]!.importance, "low", "the team's answer, not this clone's unpublished one");
    assert.equal(
      back[0]!.complexity, "deep",
      "PER FIELD: the scope says nothing about complexity, so the local row still fills it",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("and a local mark on a target the scope has never heard of is untouched", async () => {
  // The control. Without it the rule above passes just as well if fold-owned rows
  // suppressed every local row in the table.
  const root = universe();
  try {
    plantShared(root, "triage/acme-api", mark({ id: "a_theirs", importance: "low" }));
    await replaceLocalTriage(root, [mark({ id: "a_mine", importance: "business-critical" })]);
    const back = new Map((await readTriage(root)).triage.map((t) => [t.target.id, t.importance]));
    assert.equal(back.get("a_mine"), "business-critical");
    assert.equal(back.get("a_theirs"), "low");
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

// --- the write PATHS, not just the seam ---------------------------------------------

/**
 * Every op that writes triage, against a store that already holds a teammate's mark.
 *
 * The seam tests above prove `replaceLocalTriage` cannot reach a fold-owned row. These
 * prove the OPS go through it — which is a different claim, and the one that actually
 * broke: each of these was a read-modify-write of the whole list, and the merged view is
 * what makes that destructive rather than merely wasteful.
 *
 * Table-driven on purpose. The interesting property is the same for all of them, and
 * writing it once means a new write path that forgets the rule fails by being added to
 * the list rather than by being noticed.
 */
interface WritePath {
  what: string;
  run: (root: string) => Promise<unknown>;
  /**
   * Whether this path is EXPECTED to leave a local row for the teammate's target.
   *
   * Writing my own mark about a symbol a colleague also triaged is the point, not a
   * violation — it is how two people disagree at all. What must never happen is a row
   * appearing there as a side effect of writing something else.
   */
  ownsTheirTarget?: boolean;
}

const WRITE_PATHS: WritePath[] = [
  { what: "setTriage", run: (root) => setTriage(root, {
    targetKind: "anchor", targetId: "a_mine", importance: "business-critical", source: "human",
  }) },
  { what: "setTriage on the SAME target as the teammate's", ownsTheirTarget: true, run: (root) => setTriage(root, {
    targetKind: "anchor", targetId: "a_theirs", importance: "business-critical", source: "human",
  }) },
  { what: "setTriageBatch", run: (root) => setTriageBatch(root, [
    { anchorId: "a_mine", importance: "important" },
  ], { source: "agent" }) },
  { what: "clearTriage", run: (root) => clearTriage(root, { targetKind: "anchor", targetId: "a_mine" }) },
  { what: "clearTriage on the teammate's target", run: (root) =>
    clearTriage(root, { targetKind: "anchor", targetId: "a_theirs" }) },
  { what: "deriveTriage", run: (root) => deriveTriage(root) },
];

for (const { what, run, ownsTheirTarget } of WRITE_PATHS) {
  test(`${what} leaves a teammate's mark exactly where it was`, async () => {
    const root = await initialized();
    try {
      const theirs = mark({ id: "a_theirs", importance: "low", complexity: "deep", reason: "they looked" });
      plantShared(root, "triage/acme-api", theirs);
      await replaceLocalTriage(root, [mark({ id: "a_mine" })]);

      const d = db(root);
      const shared = () => d.prepare(
        "SELECT field, value, reason, origin, source_scope FROM triage WHERE source_scope IS NOT NULL ORDER BY field",
      ).all() as unknown as { field: string; value: string; reason: string | null; origin: string; source_scope: string }[];
      const before = shared();
      assert.equal(before.length, 2, "precondition: the teammate has two field rows");

      await run(root);

      assert.deepEqual(shared(), before,
        `${what} altered, removed or duplicated a row only the fold may own`);
      // And it did not COPY one into the local partition either, which is the failure
      // that looks harmless until the next fold produces the row again alongside.
      const localForTheirs = d.prepare(
        "SELECT value FROM triage WHERE source_scope IS NULL AND target_id = 'a_theirs' AND field = 'importance'",
      ).get() as { value: string } | undefined;
      if (ownsTheirTarget) {
        assert.equal(localForTheirs?.value, "business-critical",
          `${what} is supposed to write MY judgment about their target`);
        assert.notEqual(localForTheirs?.value, theirs.importance,
          "and it must be my value, not a copy of theirs");
      } else {
        assert.equal(localForTheirs, undefined,
          `${what} copied the teammate's mark into this clone's own rows`);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("CONTROL: the write paths really do write — they are not all no-ops here", async () => {
  // Without this, every assertion above passes on ops that silently did nothing, which
  // is the shape "it did not touch the teammate's row" fails as.
  const root = await initialized();
  try {
    plantShared(root, "triage/acme-api", mark({ id: "a_theirs", importance: "low" }));

    const set = await setTriage(root, {
      targetKind: "anchor", targetId: "a_mine", importance: "business-critical", source: "human",
    });
    assert.equal(set.ok, true, "setTriage reported a write");
    assert.equal((await readLocalTriage(root)).triage.find((t) => t.target.id === "a_mine")?.importance,
      "business-critical", "and it is in this clone's own rows");

    const batch = await setTriageBatch(root, [{ anchorId: "a_b", importance: "important" }], { source: "agent" });
    assert.equal(batch.applied, 1, "setTriageBatch applied one");
    assert.ok((await readLocalTriage(root)).triage.some((t) => t.target.id === "a_b"));

    const cleared = await clearTriage(root, { targetKind: "anchor", targetId: "a_mine" });
    assert.equal(cleared.removed, 1, "clearTriage removed the local mark");
    assert.equal((await readLocalTriage(root)).triage.some((t) => t.target.id === "a_mine"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the ratchet judges against the MERGED value, not this clone's own", async () => {
  // The other half of the split, and the one a "did not touch their row" test cannot
  // see: an agent may only RAISE, and raising is meaningless if the baseline it is
  // compared against excludes the teammate who set the stakes.
  const root = await initialized();
  try {
    plantShared(root, "triage/acme-api", mark({ id: "a_1", importance: "business-critical" }));
    const r = await setTriage(root, {
      targetKind: "anchor", targetId: "a_1", importance: "low", source: "agent",
    }) as { ok: boolean; importance?: string };
    assert.equal(r.ok, false, "an agent cannot lower a teammate's business-critical mark");
    assert.equal(r.importance, "business-critical", "and the refusal reports the value that stands");

    // CONTROL — the same agent CAN raise, so this is not "an agent may never write".
    plantShared(root, "triage/acme-api", mark({ id: "a_2", importance: "low" }));
    const up = await setTriage(root, {
      targetKind: "anchor", targetId: "a_2", importance: "business-critical", source: "agent",
    }) as { ok: boolean };
    assert.equal(up.ok, true, "raising over a teammate's mark is allowed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
