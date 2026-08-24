/**
 * The six properties that must hold after ANY sequence of real operations.
 *
 * This is the oracle proper. Hand-written cases assert what one scenario happens to
 * produce; these assert what can never be true, and they are checked after every
 * step of every scenario — so a defect that only appears on the sixth operation of a
 * chain has something watching when it does.
 *
 * Where they come from: `docs/HANDOFF.md` § "Make them oracles, not assertions".
 *
 *   1. CONVERGENCE   — after everyone syncs twice, their projections are identical.
 *   2. NO LOSS       — no clone ever loses an event it once held.
 *   3. NO SILENT OK  — an op that returned `ok` is verifiable by an independent read.
 *                     Taken as a receipt at the call site (`verified`), because only
 *                     the caller knows what a given `ok` promised.
 *   4. DETERMINISM   — arrival order does not change what the log folds to.
 *   5. OWNERSHIP     — no local write ever reaches a row the fold owns.
 *   6. COMPLETENESS  — after a sync, an ordinary query never folds the log.
 *
 * Every one of them is mutation-checked in `oracle-properties.test.ts`: the fix is
 * reverted and the property must fail. A property that cannot fail is decoration.
 */

import assert from "node:assert/strict";
import { readScope, scopesOnDisk, sortEvents, type LogEvent } from "./eventlog.js";
import { projectionFor } from "./shared-projections.js";
import { foldCount } from "./materialize.js";
import { docScope, foldDocs } from "./shared-docs.js";
import { triageScope, foldTriage, isTombstone, ABSENT_FIELD } from "./shared-triage.js";
import { bugScope, foldBugs } from "./shared-bugs.js";
import { listBugs } from "./ops/bugs.js";
import { sharedDocs, sharedFindings, sharedNotes, sharedWalkthroughs, sharedTriage } from "./ops-shared.js";
import { universeKey } from "./sidecar-config.js";
import { db } from "./db.js";
import type { Member, Team } from "./oracle.js";

// --- comparing folded values -------------------------------------------------------

/**
 * A stable string for any folded value.
 *
 * `JSON.stringify` is not enough on its own: the folds return `Map`s, which
 * stringify as `{}` — so two clones holding completely different docs would compare
 * equal and every convergence check would pass vacuously. Keys are sorted because
 * two clones can build an equal map in different insertion orders.
 */
export function stable(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (v instanceof Map) return { "@map": [...v.entries()].map(([k, x]) => [k, norm(x)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) };
    if (v instanceof Set) return { "@set": [...v].map(norm).map((x) => JSON.stringify(x)).sort() };
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) out[k] = norm((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

/** Every scope on a clone's disk, folded. */
async function foldedScopes(m: Member): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const scope of await scopesOnDisk(m.sidecar)) {
    const which = projectionFor(scope);
    if (!which) continue;
    out.set(scope, stable(which.fold(await readScope(m.sidecar, scope))));
  }
  return out;
}

const eventIds = async (m: Member): Promise<Map<string, Set<string>>> => {
  const out = new Map<string, Set<string>>();
  for (const scope of await scopesOnDisk(m.sidecar)) {
    out.set(scope, new Set((await readScope(m.sidecar, scope)).map((e) => e.id)));
  }
  return out;
};

// --- 2. no loss ---------------------------------------------------------------------

/**
 * What every clone has ever held, so a disappearance is detectable.
 *
 * Loss is invisible to a single read: a clone missing an event looks exactly like a
 * clone that never received one. Only the history distinguishes them, so the oracle
 * carries it.
 */
export class Ledger {
  private held = new Map<string, Map<string, Set<string>>>();

  async observe(t: Team): Promise<void> {
    for (const m of t.all) {
      const now = await eventIds(m);
      const before = this.held.get(m.machine);
      if (before) {
        for (const [scope, ids] of before) {
          const current = now.get(scope) ?? new Set<string>();
          const lost = [...ids].filter((id) => !current.has(id));
          assert.deepEqual(
            lost, [],
            `NO LOSS violated: ${m.machine} no longer holds ${lost.length} event(s) in ${scope} `
            + `it held earlier (${lost.slice(0, 3).join(", ")}). An event in a log is history; nothing may remove it.`,
          );
        }
      }
      // Union rather than replace: a scope legitimately absent from this read must
      // still be checked against next time.
      const merged = before ?? new Map<string, Set<string>>();
      for (const [scope, ids] of now) {
        const acc = merged.get(scope) ?? new Set<string>();
        for (const id of ids) acc.add(id);
        merged.set(scope, acc);
      }
      this.held.set(m.machine, merged);
    }
  }

  /**
   * Every event id anyone has ever held.
   *
   * Wired into `everyoneHasEverything`. It sat here unused for a while advertising a
   * check that did not exist — dead oracle machinery is worse than none, because it
   * reads as coverage.
   */
  union(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const perScope of this.held.values()) {
      for (const [scope, ids] of perScope) {
        const acc = out.get(scope) ?? new Set<string>();
        for (const id of ids) acc.add(id);
        out.set(scope, acc);
      }
    }
    return out;
  }
}

// --- 3. no silent success -------------------------------------------------------------

/**
 * An op that returned `ok` did the thing, checked by an INDEPENDENT read.
 *
 * This one cannot be a post-state sweep like the others: only the caller knows what a
 * given `ok` promised, so nothing generic can infer it. It is a receipt taken at the
 * call site instead — and it was listed among the six for a while without existing at
 * all, which is worse than not claiming it, because the list was the documentation.
 *
 * The failure it guards is specific and this project has shipped it: `sync` returned
 * `pushed: true` while the finding never left the machine, because the commit had
 * failed and pushing a tip the remote already had exits 0.
 */
export async function verified<T>(
  what: string,
  op: Promise<T>,
  readBack: (result: T) => Promise<unknown>,
): Promise<T> {
  const result = await op;
  const err = (result as { error?: unknown })?.error;
  assert.equal(err, undefined, `${what} failed: ${String(err)}`);
  const seen = await readBack(result);
  assert.ok(
    seen !== undefined && seen !== null && seen !== false,
    `NO SILENT OK violated: ${what} returned success, and reading it back independently found nothing.`,
  );
  return result;
}

// --- 4. fold determinism -------------------------------------------------------------

/** Deterministic shuffle, so a failure reproduces from the seed alone. */
export function shuffled<T>(items: T[], seed: number): T[] {
  let s = seed >>> 0;
  const rand = () => {
    // mulberry32 — small, seeded, and good enough to permute a few dozen events.
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * The order events ARRIVE in must not change what they mean.
 *
 * Shards are read in filename order and merged, so the order a clone sees depends on
 * who wrote which file and when it pulled. `sortEvents` is what makes that
 * irrelevant — this asserts it actually does, which is a claim about a total order
 * and not a tautology: a comparator that ties on two concurrent events would fold
 * differently depending on which arrived first.
 */
export async function determinism(m: Member, seed: number): Promise<void> {
  for (const scope of await scopesOnDisk(m.sidecar)) {
    const which = projectionFor(scope);
    if (!which) continue;
    const events = await readScope(m.sidecar, scope);
    if (events.length < 2) continue;
    const canonical = stable(which.fold(events));
    // REVERSE first, and it is not decoration: for exactly two events every seeded
    // shuffle is the identity (`shuffled(["a","b"], 1..3)` is `["a","b"]` each time),
    // and two concurrent events are the SMALLEST interesting ordering case. Seeds
    // alone made this property vacuous exactly where it mattered most.
    const orders: [string, LogEvent[]][] = [["reversed", events.slice().reverse()]];
    for (const round of [seed, seed + 1, seed + 2]) orders.push([`seed ${round}`, shuffled(events, round)]);
    for (const [how, order] of orders) {
      assert.equal(
        stable(which.fold(sortEvents(order))), canonical,
        `DETERMINISM violated in ${scope} (${how}): the same ${events.length} events fold to `
        + `two different values depending on the order they arrived in.`,
      );
    }
  }
}

// --- 5. ownership --------------------------------------------------------------------

/** One fold-owned version, exactly as `docsProjection` writes it. */
const versionRepr = (v: {
  nodeId: string; type: unknown; title: unknown; summary: unknown; body: unknown;
  generatedBy?: unknown; createdCommit: unknown; createdBranch: unknown; createdAt: unknown;
  citations: unknown; removed?: unknown; ord: number; author: unknown;
}): string => stable({
  nodeId: v.nodeId, type: v.type, title: v.title ?? "", summary: v.summary ?? "", body: v.body ?? "",
  generatedBy: v.generatedBy ?? null, createdCommit: v.createdCommit ?? null,
  createdBranch: v.createdBranch ?? null, createdAt: v.createdAt ?? "",
  citations: v.citations ?? [], removed: v.removed ? 1 : 0, ord: v.ord, author: v.author ?? null,
});

interface OwnedRow {
  version_id: string; node_id: string; type: string; title: string; summary: string; body: string;
  generated_by: string | null; created_commit: string | null; created_branch: string | null;
  created_at: string; citations: string; removed: number; origin: string | null;
  source_scope: string | null; ord: number; author: string | null;
}

/**
 * Rows the fold owns are the fold's alone — in BOTH directions, and whole.
 *
 * A teammate's doc is an ordinary `node_versions` row carrying an `origin`, which is
 * what removed the parallel tables, and this rule is the price of that design. A
 * local write that reached one of those rows would overwrite somebody else's work
 * with no event recording it, and the next fold would put it back — so the damage
 * appears and disappears depending on when you look.
 *
 * An earlier version of this check compared four fields of the rows that happened to
 * be PRESENT, and so passed after `DELETE FROM node_versions WHERE source_scope IS
 * NOT NULL` — the largest possible violation. Three things follow, and all three are
 * load-bearing:
 *
 *   - iterate the FOLD as well as the rows, or deletion is invisible;
 *   - select by `source_scope`, not by `origin IS NOT NULL`, or clearing the
 *     provenance takes a row out of scope and hides the write that did it;
 *   - compare the whole stored representation, or a mutation to `citations`,
 *     `removed`, `ord` or `author` passes.
 */
/**
 * The same rule, on the `bugs` table.
 *
 * A separate function rather than a branch inside `ownership`, because the failure it
 * catches is different in one way that matters: a bug's whole content is ONE JSON
 * column, so a local mutation is a single `UPDATE` that a shape check over columns
 * would not see. Compare the stored body against what the log folds to, and nothing
 * that edits a fold-owned bug can pass.
 */
export async function bugOwnership(m: Member): Promise<void> {
  const universe = universeKey(m.repo);
  const scope = bugScope(universe);
  const folded = foldBugs(await readScope(m.sidecar, scope));
  const d = db(m.repo);

  const rows = d.prepare("SELECT id, body FROM bugs WHERE source_scope = ?").all(scope) as unknown as
    { id: string; body: string }[];
  const expected = new Map([...folded.values()].map((b) => [b.id, stable(b)]));

  for (const r of rows) {
    const want = expected.get(r.id);
    assert.ok(
      want !== undefined,
      `OWNERSHIP violated: ${m.actor.principal} holds bug ${r.id} under ${scope}, and the log does not `
      + `say it exists. A fold-owned row is written only by the fold.`,
    );
    assert.equal(
      stable(JSON.parse(r.body)), want,
      `OWNERSHIP violated: ${m.actor.principal}'s stored bug ${r.id} is not what the log folds to. `
      + `Nothing about a local mutation moves the scope fingerprint, so the cache would keep serving `
      + `this indefinitely.`,
    );
  }
  // Iterate the FOLD too, or a DELETE is invisible — the lesson `ownership` records.
  for (const id of expected.keys()) {
    assert.ok(
      rows.some((r) => r.id === id),
      `OWNERSHIP violated: ${m.actor.principal} is missing fold-owned bug ${id}. Rows the fold owns `
      + `are replaced whole; one that is gone was taken by something else.`,
    );
  }
}

export async function ownership(m: Member): Promise<void> {
  const universe = universeKey(m.repo);
  const scope = docScope(universe);
  const folded = foldDocs(await readScope(m.sidecar, scope));
  const d = db(m.repo);

  const cols = "version_id, node_id, type, title, summary, body, generated_by, created_commit, "
    + "created_branch, created_at, citations, removed, origin, source_scope, ord, author";
  const rows = d.prepare(`SELECT ${cols} FROM node_versions WHERE source_scope = ?`).all(scope) as unknown as OwnedRow[];
  const local = new Map((d.prepare(`SELECT ${cols} FROM node_versions WHERE source_scope IS NULL`).all() as unknown as OwnedRow[])
    .map((r) => [r.version_id, r]));

  const actual = new Map(rows.map((r) => [r.version_id, versionRepr({
    nodeId: r.node_id, type: r.type, title: r.title, summary: r.summary, body: r.body,
    generatedBy: r.generated_by, createdCommit: r.created_commit, createdBranch: r.created_branch,
    createdAt: r.created_at, citations: JSON.parse(r.citations || "[]"), removed: r.removed,
    ord: r.ord, author: r.author ? JSON.parse(r.author) : null,
  })]));

  const expected = new Map<string, string>();
  for (const doc of folded.values()) {
    doc.versions.forEach((v, i) => {
      const repr = versionRepr({
        nodeId: doc.nodeId, type: v.type, title: v.title, summary: v.summary, body: v.body,
        generatedBy: v.generatedBy, createdCommit: v.createdCommit, createdBranch: v.createdBranch,
        createdAt: v.createdAt, citations: v.citations ?? [], removed: v.removed,
        ord: i, author: doc.authors.get(v.versionId) ?? null,
      });
      const clash = local.get(v.versionId);
      if (clash) {
        // The projection SKIPS a version whose id collides with a local row it cannot
        // adopt — losing the regenerable thing rather than the user's own edit. That
        // is correct, so it is not a violation. But an IDENTICAL local row would have
        // been adopted, so finding one means somebody cleared the provenance off a
        // fold-owned row, and that is exactly the write this rule forbids.
        const sameContent = clash.node_id === doc.nodeId && (clash.body ?? "") === (v.body ?? "")
          && (clash.title ?? "") === (v.title ?? "") && (clash.summary ?? "") === (v.summary ?? "");
        assert.ok(
          !sameContent,
          `OWNERSHIP violated: ${m.actor.principal}'s row ${v.versionId} is byte-identical to the `
          + `shared version but carries no origin. The fold would have adopted it, so its provenance `
          + `was cleared by a local write.`,
        );
        return;
      }
      expected.set(v.versionId, repr);
    });
  }

  const missing = [...expected.keys()].filter((id) => !actual.has(id));
  assert.deepEqual(
    missing, [],
    `OWNERSHIP violated: ${m.actor.principal} is missing ${missing.length} row(s) the log produces `
    + `(${missing.slice(0, 3).join(", ")}). A local write deleted rows only the fold may own.`,
  );
  const extra = [...actual.keys()].filter((id) => !expected.has(id));
  assert.deepEqual(
    extra, [],
    `OWNERSHIP violated: ${m.actor.principal} holds ${extra.length} fold-owned row(s) no event in `
    + `${scope} produces (${extra.slice(0, 3).join(", ")}).`,
  );
  for (const [id, want] of expected) {
    assert.equal(
      actual.get(id), want,
      `OWNERSHIP violated: ${m.actor.principal}'s row ${id} differs from what the log folds to. `
      + `A local write reached a row the fold owns; the next fold will silently undo it.`,
    );
  }

  for (const r of rows) {
    assert.ok(r.origin, `OWNERSHIP violated: row ${r.version_id} is owned by ${scope} but carries no origin`);
  }

  await triageOwnership(m, universe);
}

/**
 * The same rule for the TRIAGE table, which is the second canonical table and so the
 * second place a local write can reach a row only the fold may own.
 *
 * Its own function rather than a second copy of the docs walk: the identity is
 * (target, field) and not a version id, and the five whole-list write paths in
 * `triage.ts` are exactly the shape this exists to catch — `clearTriage` filtering the
 * MERGED list and writing it back would delete a teammate's row and clone every other
 * one into the local partition, in a single call.
 */
async function triageOwnership(m: Member, universe: string): Promise<void> {
  const scope = triageScope(universe);
  const folded = foldTriage(await readScope(m.sidecar, scope));
  const d = db(m.repo);

  const key = (kind: string, id: string, field: string) => `${kind}/${id}/${field}`;
  const rows = d.prepare(
    "SELECT target_kind, target_id, field, value, source, likely, reason, at, actor, origin, detail "
    + "FROM triage WHERE source_scope = ?",
  ).all(scope) as unknown as {
    target_kind: string; target_id: string; field: string; value: string; source: string;
    likely: number; reason: string | null; at: string; actor: string | null;
    origin: string | null; detail: string | null;
  }[];

  const actual = new Map(rows.map((r) => [key(r.target_kind, r.target_id, r.field), stable({
    value: r.value, source: r.source, likely: !!r.likely, reason: r.reason, at: r.at,
    actor: r.actor ? JSON.parse(r.actor) : null, detail: r.detail ? JSON.parse(r.detail) : null,
  })]));

  const expected = new Map<string, string>();
  for (const t of folded.values()) {
    if (isTombstone(t)) {
      // An asserted absence is a row too — that is the point of it. Same shape as the
      // axes so the ownership comparison stays one loop.
      expected.set(key(t.target.kind, t.target.id, ABSENT_FIELD), stable({
        value: "", source: "human", likely: false, reason: null, at: t.cleared.at,
        actor: t.cleared.actor, detail: { cleared: t.cleared },
      }));
      continue;
    }
    for (const field of ["importance", "complexity", "tripwire"] as const) {
      const axis = t[field];
      if (!axis) continue;
      const e = axis.effective;
      expected.set(key(t.target.kind, t.target.id, field), stable({
        value: field === "tripwire" ? (e.value ? "1" : "0") : String(e.value),
        source: e.source, likely: e.likely, reason: e.reason ?? null, at: e.at,
        actor: e.actor, detail: axis,
      }));
    }
  }

  const missing = [...expected.keys()].filter((k) => !actual.has(k));
  assert.deepEqual(
    missing, [],
    `OWNERSHIP violated: ${m.actor.principal} is missing ${missing.length} triage row(s) the log `
    + `produces (${missing.slice(0, 3).join(" · ")}). A local write deleted rows only the fold may own.`,
  );
  const extra = [...actual.keys()].filter((k) => !expected.has(k));
  assert.deepEqual(
    extra, [],
    `OWNERSHIP violated: ${m.actor.principal} holds ${extra.length} fold-owned triage row(s) no event `
    + `in ${scope} produces (${extra.slice(0, 3).join(" · ")}).`,
  );
  for (const [k, want] of expected) {
    assert.equal(
      actual.get(k), want,
      `OWNERSHIP violated: ${m.actor.principal}'s triage row ${k} differs from what the log folds to. `
      + `A local write reached a row the fold owns; the next fold will silently undo it.`,
    );
  }
  for (const r of rows) {
    assert.ok(
      r.origin,
      `OWNERSHIP violated: triage row ${key(r.target_kind, r.target_id, r.field)} is owned by ${scope} `
      + `but carries no origin — cleared provenance is how a fold-owned row becomes an untraceable local one`,
    );
  }
}

/**
 * After a settle, every machine holds every event anyone has ever held.
 *
 * Distinct from convergence, which compares what clones FOLD: a scope kind that never
 * syncs would leave two clones agreeing about the scopes they both have while one of
 * them silently lacks a whole scope.
 */
export async function everyoneHasEverything(t: Team, ledger: Ledger): Promise<void> {
  const union = ledger.union();
  for (const m of t.all) {
    const mine = await eventIds(m);
    for (const [scope, ids] of union) {
      const held = mine.get(scope) ?? new Set<string>();
      const absent = [...ids].filter((id) => !held.has(id));
      assert.deepEqual(
        absent, [],
        `NO LOSS violated after a settle: ${m.machine} is missing ${absent.length} event(s) in ${scope} `
        + `that another machine holds (${absent.slice(0, 3).join(", ")}).`,
      );
    }
  }
}

// --- 1 + 6. convergence, and reading without folding ----------------------------------

/**
 * Every clone folded to the same thing.
 *
 * Only meaningful once everyone has synced — before that, divergence is just news
 * that has not travelled yet.
 */
export async function converged(t: Team): Promise<void> {
  // The projections FIRST. Comparing clone against clone only proves they fold the
  // same log; it says nothing about the SQLite rows every ordinary read is answered
  // from. A row corrupted in place — still valid JSON, still under a current
  // fingerprint — passed both this and completeness while `sharedFindings` served the
  // corruption, because neither ever looked at what a read returns.
  for (const m of t.all) {
    for (const scope of await scopesOnDisk(m.sidecar)) {
      const which = projectionFor(scope);
      if (!which) continue;
      const fromLog = stable(which.fold(await readScope(m.sidecar, scope)));
      let fromRows: string;
      try { fromRows = stable(which.proj.read(db(m.repo), scope)); }
      catch (e) { throw new Error(`PROJECTION violated in ${scope} for ${m.actor.principal}: rows unreadable — ${(e as Error).message}`); }
      assert.equal(
        fromRows, fromLog,
        `PROJECTION violated in ${scope} for ${m.actor.principal}: the stored rows are not what the log `
        + `folds to, so every ordinary read of this scope answers from something the log does not say.`,
      );
    }
  }

  const shapes = new Map<string, Map<string, string>>();
  for (const m of t.all) shapes.set(m.machine, await foldedScopes(m));

  const scopes = new Set<string>();
  for (const s of shapes.values()) for (const k of s.keys()) scopes.add(k);

  for (const scope of scopes) {
    const seen = [...shapes.entries()].map(([principal, s]) => [principal, s.get(scope) ?? "(absent)"] as const);
    const first = seen[0]!;
    const bad = seen.find(([, shape]) => shape !== first[1]);
    if (bad) {
      throw new Error(
        `CONVERGENCE violated in ${scope} — every reader must fold to the same state.\n`
        + `  ${first[0]}: ${first[1].slice(0, 400)}\n`
        + `  ${bad[0]}: ${bad[1].slice(0, 400)}`,
      );
    }
  }
}

/**
 * An ordinary read does not fold the log.
 *
 * The architecture's load-bearing claim: the log is pull/push, and SQLite is its
 * projection. A read that folds is not a performance problem, it is the projection
 * being wrong — and it is invisible from the outside, because a fold returns exactly
 * what a cache hit would.
 *
 * Only valid straight after a sync, which is what materializes every moved scope.
 */
export async function readsDoNotFold(t: Team): Promise<void> {
  for (const m of t.all) {
    const universe = universeKey(m.repo);
    const scopes = await scopesOnDisk(m.sidecar);
    const before = foldCount();
    // Only scopes that EXIST. A scope nobody has ever written has no shard directory,
    // so materialization — which iterates what is on disk — correctly never visits
    // it, and the first read folds its zero events and caches that. Counting it as a
    // violation would report every store that has not used a feature yet.
    if (scopes.includes(docScope(universe))) await sharedDocs(m.repo);
    // And triage, which is FIVE surfaces now. It is the one whose ordinary read is not
    // a shared op at all: `readTriage` answers from rows, so the way this regresses is
    // a fold that never materializes — the shared read would then be the only thing
    // folding, and it would fold on every call.
    if (scopes.includes(triageScope(universe))) await sharedTriage(m.repo);
    // And bugs, whose ordinary read is `listBugs` — a LOCAL op that happens to fold a
    // shared scope. That shape is the one at risk: nothing about it looks shared, so a
    // missing materialization would leave the read path folding on every call while
    // every shared surface still looked correct.
    if (scopes.includes(bugScope(universe))) await listBugs(m.repo);
    // All FOUR public read surfaces. Checking two of them left notes and walkthroughs
    // free to fold on every read with the property still green — and a scope kind
    // missing from materialization is exactly the defect this is watching for.
    for (const scope of scopes) {
      const findings = `findings/${universe}/pr-`;
      const walk = `walkthrough/${universe}/pr-`;
      if (scope.startsWith(findings)) await sharedFindings(m.repo, scope.slice(findings.length));
      else if (scope.startsWith(walk)) await sharedWalkthroughs(m.repo, scope.slice(walk.length));
      else if (scope.startsWith(`notes/${universe}/`)) {
        // A note scope is a hash BUCKET, so it cannot be turned back into a target id.
        // Take one from the events it holds, which is what a reader would have.
        const target = (await readScope(m.sidecar, scope))
          .map((e) => (e.data as { targetId?: unknown } | undefined)?.targetId)
          .find((id): id is string => typeof id === "string");
        if (target) await sharedNotes(m.repo, target);
      }
    }
    const after = foldCount();
    assert.equal(
      after, before,
      `COMPLETENESS violated: ${m.actor.principal} folded the log ${after - before} time(s) answering an `
      + `ordinary read after a sync. Materialization is meant to have already done it.`,
    );
  }
}

// --- the whole oracle ------------------------------------------------------------------

/**
 * Everything that must hold at ANY moment — mid-scenario, before anyone has synced.
 *
 * Convergence and completeness are deliberately not here: both are claims about a
 * settled team, and asserting them mid-flight would fail on ordinary, correct
 * behaviour.
 */
export async function checkAlways(t: Team, ledger: Ledger, seed = 1): Promise<void> {
  await ledger.observe(t);
  for (const m of t.all) {
    await determinism(m, seed);
    await ownership(m);
    await bugOwnership(m);
  }
}

/** Everything that must hold once everyone has synced. */
export async function checkSettled(t: Team, ledger: Ledger, seed = 1): Promise<void> {
  await checkAlways(t, ledger, seed);
  await everyoneHasEverything(t, ledger);
  await converged(t);
  await readsDoNotFold(t);
}
