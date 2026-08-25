/**
 * How each shared entity is stored in, and rebuilt from, the materialized tables.
 *
 * Separate from `materialize.ts` on purpose: that module owns the cache key, the
 * transaction and the re-fold, and knows nothing about what it is caching. This one
 * knows the entities and nothing about when they are folded. Keeping them apart is
 * what lets the fold be a parameter rather than an import — see the note there.
 *
 * The equivalence obligation lives here: `read(write(x))` must equal `x` UP TO JSON
 * for every fold output, or the cache is a second, quieter implementation of the
 * fold. "Up to JSON" is exact, not a hedge — a property whose value is `undefined`
 * comes back absent rather than present-and-undefined, which no caller here depends
 * on. What JSON cannot carry AT ALL needs a column: a `Map`, or an order a caller
 * reads. It is a cache, and "it's only a cache" is exactly the sentence that stops
 * someone testing it — so `materialize.test.ts` asserts the round trip against real
 * folds.
 */

import type { DatabaseSync } from "node:sqlite";
import { db } from "./db.js";
import { CorruptProjection, type Projection } from "./materialize.js";
import type { LogEvent } from "./eventlog.js";
import { foldWalkthroughs, type SharedWalkthrough } from "./shared-walkthrough.js";
import { needsHumanAck, foldFindings, prOfScope, type SharedFinding } from "./shared-findings.js";
import { foldDocs, type SharedDoc, type UnmatchedAcceptance } from "./shared-docs.js";
import { foldNotes, type SharedNote } from "./shared-notes.js";
import { foldTriage, triageSubject, isTombstone, ABSENT_FIELD, type TriageEntry, type Axis, type TriageField } from "./shared-triage.js";
import { foldGraph, type SharedWiring } from "./shared-graph.js";
import { foldBugs, needsHumanAck as bugNeedsAck, type SharedBug } from "./shared-bugs.js";
import type { Actor, NodeVersion } from "./schema.js";

/**
 * Findings, into the ONE canonical `findings` table.
 *
 * A teammate's finding is a row there with an `origin`, not a row in a parallel
 * `shared_finding` — the rule that removed the `shared_doc_*` tables, and the reason a
 * finding now shows up in the review queue, the PR story, the anchor view and the
 * GitHub publish path with no bridge code at any of them. Before this there were two
 * stores holding the same entity and neither was a superset: 96 local findings against
 * 26 shared ones on one universe, with no surface showing more than 96 of the 122.
 *
 * **`pr` comes from the SCOPE**, which is the only place it has ever been reliable —
 * see `prOfScope`.
 *
 * **Replaces only what it owns.** `DELETE ... WHERE source_scope = ?`, never by id or
 * by pr: a bare delete would silently take local rows the fold may not own, and the
 * next fold would not put them back.
 *
 * **The adoption rule.** Publishing a local finding preserves its id — a republication
 * of history, not a new finding — so on any store that filed then published, the fold
 * meets an id already in the table. `ix_findings_identity` is UNIQUE on `(pr, id)`, so
 * the constraint violation would happen INSIDE `readCached`'s transaction: the fold
 * throws, every finding read on that store fails, and nothing about the failure moves
 * the fingerprint, so it never self-heals. The row is the same row, so the fold ADOPTS
 * it.
 *
 * **Unconditionally, unlike `bugsProjection` and `docsProjection`**, which adopt only
 * when the local content still matches and otherwise `continue`. That `continue` is a
 * hole: the shared row is then never stored, the fingerprint is committed anyway, the
 * first (missing) read returns the fold and every later one answers from rows without
 * it — measured here, `folds so far: 1` and the finding gone from every subsequent hit.
 * A scope that silently answers incomplete for ever is worse than the loss the narrow
 * predicate was protecting against.
 *
 * And here that loss cannot be the feared one. Adoption fires only when an EVENT with
 * this id exists, so the row it takes is by definition a finding that has been
 * published. The non-regenerable case the bugs comment is about — filed locally, never
 * published — never reaches this branch at all. What an unconditional adopt can lose is
 * an unpublished edit made between publishing and the first fold, and for that the log
 * is authoritative by the architecture's first rule.
 */
export const findingsProjection: Projection<Map<string, SharedFinding>> = {
  write(d: DatabaseSync, scope: string, value: Map<string, SharedFinding>): void {
    const pr = prOfScope(scope);
    d.prepare("DELETE FROM findings WHERE source_scope = ?").run(scope);
    const ins = d.prepare(
      "INSERT INTO findings(id,pr,target_kind,target_id,state,severity,category,line,"
      + "author,created_at,needs_ack,contested,origin,source_scope,ord,body) "
      + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    const adopt = d.prepare(
      "UPDATE findings SET pr=?,target_kind=?,target_id=?,state=?,severity=?,category=?,line=?,"
      + "author=?,created_at=?,needs_ack=?,contested=?,origin=?,source_scope=?,ord=?,body=? "
      + "WHERE pr=? AND id=? AND source_scope IS NULL",
    );
    // Keyed on (pr, id) and LOCAL rows only. An id looked up across every scope was the
    // first version's bug: another pull request's row for the same id made this skip, so
    // the fold's second finding was never stored.
    const candidate = d.prepare("SELECT 1 FROM findings WHERE pr = ? AND id = ? AND source_scope IS NULL");
    let ord = 0;
    for (const f of value.values()) {
      const i = ord++;
      // `origin` and `pr` are STORE facts, not fold output — they must not ride in the
      // JSON, or the round trip returns a value the fold never produced.
      const body = JSON.stringify({ ...f, origin: undefined, pr: undefined });
      const cols = [
        pr, f.target.kind, f.target.id, f.state,
        f.severity ?? null, f.category ?? null, f.line ?? null,
        f.author.principal, f.createdAt,
        needsHumanAck(f) ? 1 : 0, f.contested?.length ? 1 : 0,
        "sync", scope, i, body,
      ];
      if (!candidate.get(pr, f.id)) { ins.run(f.id, ...cols as any); continue; }
      // `changes` is the invariant, not decoration: the UPDATE and the SELECT that
      // chose it run in one transaction that already holds the write lock, so zero
      // rows here means the predicate and the index have drifted apart — which would
      // otherwise present as the scope quietly missing one finding.
      const r = adopt.run(...cols as any, pr, f.id);
      if (Number(r.changes) !== 1) {
        throw new CorruptProjection(`findings ${scope}/${f.id}: adoption matched no local row`);
      }
    }
  },

  read(d: DatabaseSync, scope: string): Map<string, SharedFinding> {
    const out = new Map<string, SharedFinding>();
    // `ord`, the fold's own order — the fold walks events in causal order and the ack
    // queue is presented in it. Returns the PURE fold output: `origin` and `pr` are
    // added by the store-level readers, so `read(write(x))` still equals `x`.
    for (const r of d.prepare("SELECT id, body FROM findings WHERE source_scope = ? ORDER BY ord").all(scope) as unknown as
      { id: string; body: string }[]) {
      try {
        out.set(r.id, JSON.parse(r.body) as SharedFinding);
      } catch {
        throw new CorruptProjection(`findings ${scope}/${r.id} is unreadable`);
      }
    }
    return out;
  },
};

/**
 * Bugs, into the ONE canonical `bugs` table.
 *
 * A teammate's bug is a row there with an `origin`, not a row in a parallel
 * `shared_bug` — the rule that removed the `shared_doc_*` tables, and the reason a bug
 * shows up in `list_bugs`, the outline rollups and the anchor view with no bridge code
 * at any of them.
 *
 * **Replaces only what it owns.** `DELETE ... WHERE source_scope = ?`, never by id: a
 * bare delete would take local rows the fold may not own, silently, and the next fold
 * would not put them back.
 *
 * **The adoption rule**, and it is the same crash `docsProjection` documents. Publishing
 * a local bug preserves its id — it is a republication of history, not a new bug — so on
 * any store that filed a bug and then published it the fold inserts an id that already
 * exists, `bugs` keys on `id` alone, and the constraint violation happens INSIDE
 * `readCached`'s transaction: the fold throws, every bug read on that store fails, and
 * nothing about the failure moves the fingerprint, so it never self-heals.
 *
 * The row is the same row, so the fold ADOPTS it. The predicate is narrow for the reason
 * docs' is: a local row EDITED between publishing and the first fold holds content the
 * event does not, and overwriting it is unrecoverable loss of the one thing in this
 * database that is not regenerable. Same id, still local, same title and text — anything
 * else is not the same bug and the event is left in the log rather than forced onto it.
 */
export const bugsProjection: Projection<Map<string, SharedBug>> = {
  write(d: DatabaseSync, scope: string, value: Map<string, SharedBug>): void {
    d.prepare("DELETE FROM bugs WHERE source_scope = ?").run(scope);
    const ins = d.prepare(
      "INSERT INTO bugs(id,title,state,severity,author,created_at,needs_ack,contested,tracked,"
      + "origin,source_scope,ord,body) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    const adopt = d.prepare(
      "UPDATE bugs SET title=?,state=?,severity=?,author=?,created_at=?,needs_ack=?,contested=?,"
      + "tracked=?,origin=?,source_scope=?,ord=?,body=? WHERE id=?",
    );
    const candidate = d.prepare("SELECT title, body, source_scope FROM bugs WHERE id = ?");
    let ord = 0;
    for (const b of value.values()) {
      const i = ord++;
      // `origin` is a store fact, not a fold output — it must not ride in the JSON, or
      // the round trip returns a value the fold never produced.
      const body = JSON.stringify({ ...b, origin: undefined });
      const cols = [
        b.title, b.state, b.severity, b.author.principal, b.createdAt,
        bugNeedsAck(b) ? 1 : 0, b.contested?.length ? 1 : 0, b.tracking.length ? 1 : 0,
        "sync", scope, i, body,
      ];
      const row = candidate.get(b.id) as { title: string; body: string; source_scope: string | null } | undefined;
      if (!row) { ins.run(b.id, ...cols as any); continue; }
      if (row.source_scope) continue; // owned by another scope; not ours to take
      let local: SharedBug | null = null;
      try { local = JSON.parse(row.body) as SharedBug; } catch { /* unreadable: not adoptable */ }
      if (!local || local.title !== b.title || local.text !== b.text) continue;
      adopt.run(...cols as any, b.id);
    }
  },

  read(d: DatabaseSync, scope: string): Map<string, SharedBug> {
    const out = new Map<string, SharedBug>();
    // `ord`, the fold's own order — see the column's note in `db.ts`.
    for (const r of d.prepare("SELECT id, body FROM bugs WHERE source_scope = ? ORDER BY ord").all(scope) as unknown as
      { id: string; body: string }[]) {
      try {
        out.set(r.id, JSON.parse(r.body) as SharedBug);
      } catch {
        throw new CorruptProjection(`bugs ${scope}/${r.id} is unreadable`);
      }
    }
    return out;
  },
};

/**
 * Shared docs, keyed by scope (`docs/<universe>` — universe-qualified already).
 *
 * Two fields do NOT survive a JSON round trip and therefore get columns:
 * `versions` is ORDERED (oldest first) and row order is not a property of a table,
 * and `authors` is a `Map`, which `JSON.stringify` renders as `{}` — silently, and
 * a doc that forgot who wrote each version would look perfectly well formed. The
 * equivalence test is what catches that class, which is why it compares serialized
 * forms rather than spot-checking fields.
 */
export const docsProjection: Projection<Map<string, SharedDoc>> = {
  /**
   * Canonical rows: a teammate's doc is a `node_versions` row with an `origin`, not a
   * row in a parallel table. Two tables holding one type, resolved by the same
   * function and judged by the same verdict, is what forced a hand-written bridge
   * onto every surface.
   *
   * **Replaces only what it owns.** `DELETE ... WHERE source_scope = ?` — never by
   * `node_id`, which would take the user's own versions of a node they and a teammate
   * both documented.
   *
   * **The adoption rule**, and without it this is a deterministic crash on the one
   * store that matters. `publishLocalDocs` preserves the original `versionId` — it is
   * a republication of history, not a new act — and the fold preserves ids from
   * events. So on any store that authored a doc and then published it, the fold
   * inserts a version id that already exists locally, `node_versions` keys on
   * `version_id` alone, and the constraint violation happens INSIDE `readCached`'s
   * transaction. The fold throws, every docs read on that store fails, and nothing
   * about the failure moves the fingerprint, so it never self-heals.
   *
   * The row is the same row. So the fold ADOPTS it: stamps the provenance onto the
   * existing local row rather than colliding with it. That is the truth of the
   * situation — the local copy and the published copy are one version, which is
   * exactly why the id was preserved.
   */
  write(d: DatabaseSync, scope: string, value: Map<string, SharedDoc>): void {
    d.prepare("DELETE FROM node_versions WHERE source_scope = ?").run(scope);
    d.prepare("DELETE FROM shared_doc_unmatched WHERE scope = ?").run(scope);

    const ins = d.prepare(
      "INSERT INTO node_versions(version_id,node_id,type,title,summary,body,generated_by,created_commit,"
      + "created_branch,created_at,citations,removed,origin,source_scope,ord,author) "
      + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    // Adoption: the local row IS this version. Stamped, not duplicated.
    const adopt = d.prepare(
      "UPDATE node_versions SET type=?,title=?,summary=?,body=?,created_commit=?,created_branch=?,"
      + "created_at=?,citations=?,removed=?,origin=?,source_scope=?,ord=?,author=? WHERE version_id=?",
    );
    // The adoption PREDICATE, and it has to be exact. Matching on `version_id` alone
    // adopts three things it must not:
    //
    //   - a local row that has been EDITED since it was published. The event carries
    //     the older content, and overwriting is unrecoverable data loss — local rows
    //     are the one non-regenerable thing in this database.
    //   - a row under a DIFFERENT node id, which would leave the old `node_id` and
    //     replace its content, putting one doc's prose under another's name.
    //   - a row already owned by ANOTHER scope, which reassigns `source_scope` while
    //     the losing scope's fingerprint still reads as a cache hit — two scopes then
    //     steal the row from each other on every fold.
    //
    // So: local, same node, same immutable payload. Anything else is not the same
    // version and must not be treated as one.
    const candidate = d.prepare("SELECT node_id, body, title, summary, origin FROM node_versions WHERE version_id = ?");
    const insUnmatched = d.prepare("INSERT INTO shared_doc_unmatched(scope,node_id,body) VALUES(?,?,?)");

    for (const doc of value.values()) {
      if (doc.unmatched?.length) insUnmatched.run(scope, doc.nodeId, JSON.stringify(doc.unmatched));
      doc.versions.forEach((v, i) => {
        const a = doc.authors.get(v.versionId);
        const author = a ? JSON.stringify(a) : null;
        const cites = JSON.stringify(v.citations ?? []);
        const row = candidate.get(v.versionId) as
          { node_id: string; body: string | null; title: string | null; summary: string | null; origin: string | null } | undefined;
        const adoptable = row && !row.origin && row.node_id === doc.nodeId
          && (row.body ?? "") === (v.body ?? "") && (row.title ?? "") === (v.title ?? "")
          && (row.summary ?? "") === (v.summary ?? "");
        if (row && !adoptable) {
          // A collision that is NOT the same version. Skipping loses the event rather
          // than the local row, and losing the regenerable thing is the right way
          // round: the log still holds it, and the next fold after the local row
          // changes will place it.
          return;
        }
        if (adoptable) {
          adopt.run(v.type, v.title, v.summary, v.body, v.createdCommit, v.createdBranch,
            v.createdAt, cites, v.removed ? 1 : 0, "sync", scope, i, author, v.versionId);
        } else {
          ins.run(v.versionId, doc.nodeId, v.type, v.title, v.summary, v.body, v.generatedBy ?? null,
            v.createdCommit, v.createdBranch, v.createdAt, cites, v.removed ? 1 : 0,
            "sync", scope, i, author);
        }
      });
    }
  },

  read(d: DatabaseSync, scope: string): Map<string, SharedDoc> {
    return readDocRows(d, scope);
  },
};


/** Unfiltered, this is the projection's `read`; filtered, it is what makes
 *  `docsCiting` worth having — only the matched nodes' JSON is parsed. */
function readDocRows(d: DatabaseSync, scope: string, nodeIds?: string[]): Map<string, SharedDoc> {
  const out = new Map<string, SharedDoc>();
  if (nodeIds && !nodeIds.length) return out;
  const only = nodeIds ? ` AND node_id IN (${nodeIds.map(() => "?").join(",")})` : "";
  const args = nodeIds ? [scope, ...nodeIds] : [scope];
  // `ord` is the fold's own order and is why it is a column: `versions` is oldest
  // first and row order is not a property of a table.
  // `rowid, ord`, NOT `node_id, ord`. `foldDocs` returns a Map in first-event order,
  // and the projection's contract is `read(write(x)) === x` — alphabetising the outer
  // order means a cache MISS and a cache HIT return different serialized values for
  // the same scope. Rows are inserted in fold order, so rowid is that order.
  for (const r of d.prepare(
    `SELECT * FROM node_versions WHERE source_scope = ?${only} ORDER BY rowid, ord`,
  ).all(...args) as unknown as (VersionRow & { author: string | null })[]) {
    let doc = out.get(r.node_id);
    if (!doc) { doc = { nodeId: r.node_id, versions: [], authors: new Map<string, Actor>() }; out.set(r.node_id, doc); }
    try {
      doc.versions.push(versionFromRow(r));
      if (r.author) doc.authors.set(r.version_id, JSON.parse(r.author) as Actor);
    } catch {
      throw new CorruptProjection(`node_versions ${scope}/${r.version_id} is unreadable`);
    }
  }
  for (const r of d.prepare(`SELECT node_id, body FROM shared_doc_unmatched WHERE scope = ?`).all(scope) as unknown as
    { node_id: string; body: string }[]) {
    const doc = out.get(r.node_id);
    if (!doc || (nodeIds && !nodeIds.includes(r.node_id))) continue;
    try { doc.unmatched = JSON.parse(r.body) as UnmatchedAcceptance[]; }
    catch { throw new CorruptProjection(`shared_doc_unmatched ${scope}/${r.node_id} is unreadable`); }
  }
  return out;
}

/** A `node_versions` row as the `NodeVersion` the fold put in. */
interface VersionRow {
  version_id: string; node_id: string; type: string; title: string; summary: string; body: string;
  generated_by: string | null; created_commit: string | null; created_branch: string | null;
  created_at: string; citations: string; removed: number | null; origin: string | null;
}

function versionFromRow(r: VersionRow): NodeVersion {
  return {
    versionId: r.version_id, nodeId: r.node_id, type: r.type as NodeVersion["type"],
    title: r.title ?? "", summary: r.summary ?? "", body: r.body ?? "",
    citations: JSON.parse(r.citations ?? "[]"),
    ...(r.generated_by ? { generatedBy: r.generated_by } : {}),
    ...(r.removed ? { removed: true as const } : {}),
    // NOT `origin`. The projection's contract is `read(write(x)) === x`, and origin is
    // a fact about the ROW rather than part of the version the fold produced. The
    // store's own `rowToVersion` does carry it, because store-level resolution is
    // asking a different question: whose row is this.
    createdCommit: r.created_commit, createdBranch: r.created_branch, createdAt: r.created_at,
  };
}

/** Just those nodes, built the same way the whole-scope read builds them. */
export function docsByNode(root: string, scope: string, nodeIds: string[]): Map<string, SharedDoc> {
  return readDocRows(db(root), scope, [...new Set(nodeIds)]);
}


/** Shared notes, keyed by scope (`notes/<universe>/<bucket>`). */
export const notesProjection: Projection<Map<string, SharedNote>> = {
  write(d: DatabaseSync, scope: string, value: Map<string, SharedNote>): void {
    d.prepare("DELETE FROM shared_note WHERE scope = ?").run(scope);
    const ins = d.prepare("INSERT INTO shared_note(scope,id,target_id,kind,author,created_at,resolved,body) VALUES(?,?,?,?,?,?,?,?)");
    for (const n of value.values()) {
      ins.run(scope, n.id, n.target.id, n.kind ?? null, n.author.principal, n.createdAt, n.resolved ? 1 : 0, JSON.stringify(n));
    }
  },

  read(d: DatabaseSync, scope: string): Map<string, SharedNote> {
    const out = new Map<string, SharedNote>();
    for (const r of d.prepare("SELECT id, body FROM shared_note WHERE scope = ? ORDER BY rowid").all(scope) as unknown as
      { id: string; body: string }[]) {
      try { out.set(r.id, JSON.parse(r.body) as SharedNote); }
      catch { throw new CorruptProjection(`shared_note ${scope}/${r.id} is unreadable`); }
    }
    return out;
  },
};

/**
 * Shared walkthroughs, keyed by scope (`walkthrough/<universe>/pr-<n>`).
 *
 * The last scope kind that folded on every read. `readWalkthroughs` went straight to
 * `readScope`, so opening a pull request parsed every shard in its walkthrough scope
 * — which is the one thing "the log is pull/push, never read on an ordinary query" is
 * about. It is a cache like the others now, filled by sync and by write-through.
 *
 * One row per author, because that is what the fold produces: a later publication by
 * the same person REPLACES their earlier one, and two people's walkthroughs of one
 * pull request are two answers rather than a conflict.
 */
export const walkthroughsProjection: Projection<SharedWalkthrough[]> = {
  write(d: DatabaseSync, scope: string, value: SharedWalkthrough[]): void {
    d.prepare("DELETE FROM shared_walkthrough WHERE scope = ?").run(scope);
    const ins = d.prepare("INSERT INTO shared_walkthrough(scope,author,event_id,body) VALUES(?,?,?,?)");
    for (const w of value) ins.run(scope, w.actor.principal, w.eventId, JSON.stringify(w));
  },

  read(d: DatabaseSync, scope: string): SharedWalkthrough[] {
    const out: SharedWalkthrough[] = [];
    // `rowid`, so the fold's own order survives the round trip — `foldWalkthroughs`
    // returns a Map's values in first-seen order and the projection's contract is
    // `read(write(x)) === x`.
    for (const r of d.prepare("SELECT body, event_id FROM shared_walkthrough WHERE scope = ? ORDER BY rowid")
      .all(scope) as unknown as { body: string; event_id: string }[]) {
      try { out.push(JSON.parse(r.body) as SharedWalkthrough); }
      catch { throw new CorruptProjection(`shared_walkthrough ${scope}/${r.event_id} is unreadable`); }
    }
    return out;
  },
};

/**
 * Shared triage, into the ONE canonical `triage` table.
 *
 * A teammate's stakes are an ordinary row carrying an `origin`, not a row in a parallel
 * table — the rule that removed `shared_doc_*`. So every surface that already reads
 * triage reads a teammate's without knowing it exists, and nothing needs a bridge.
 *
 * **Replaces only what it owns.** `DELETE ... WHERE source_scope = ?`, never by target:
 * a bare delete would take the local rows, which are the one thing here the log cannot
 * put back.
 *
 * One row per (target, FIELD), because that is what the fold produces and what the
 * table is keyed on. The columns hold the EFFECTIVE receipt — what ranking and severity
 * use — and `detail` holds that field's whole `Axis`, which is what makes the round trip
 * exact rather than approximately right.
 */
export const triageProjection: Projection<Map<string, TriageEntry>> = {
  write(d: DatabaseSync, scope: string, value: Map<string, TriageEntry>): void {
    d.prepare("DELETE FROM triage WHERE source_scope = ?").run(scope);
    const ins = d.prepare(
      "INSERT INTO triage(target_kind,target_id,field,value,source,likely,generated_by,reason,at,"
      + "actor,asserted_commit,witnesses,origin,source_scope,detail) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    const put = (t: { target: { kind: string; id: string } }, field: string, axis: Axis<any> | undefined): void => {
      if (!axis) return;
      const r = axis.effective;
      ins.run(
        t.target.kind, t.target.id, field,
        // `tripwire` is stored as "1"/"0", the same encoding `triageToRows` uses for a
        // local row — one column, one reading, whoever wrote the row.
        field === "tripwire" ? (r.value ? "1" : "0") : String(r.value),
        r.source, r.likely ? 1 : 0, null, r.reason ?? null, r.at,
        JSON.stringify(r.actor), r.assertedCommit ?? null, JSON.stringify(r.witnesses ?? []),
        "sync", scope, JSON.stringify(axis),
      );
    };
    for (const t of value.values()) {
      if (isTombstone(t)) {
        // An absence a person ASSERTED. Written as a row because the alternative — no
        // row — is indistinguishable from a target the log never mentioned, and that
        // is precisely how a cleared mark used to be resurrected by a local one.
        ins.run(
          t.target.kind, t.target.id, ABSENT_FIELD, "", "human", 0, null, null, t.cleared.at,
          JSON.stringify(t.cleared.actor), null, "[]", "sync", scope,
          JSON.stringify({ cleared: t.cleared }),
        );
        continue;
      }
      put(t, "importance", t.importance);
      put(t, "complexity", t.complexity);
      put(t, "tripwire", t.tripwire);
    }
  },

  read(d: DatabaseSync, scope: string): Map<string, TriageEntry> {
    const out = new Map<string, TriageEntry>();
    // `rowid`, so the fold's own Map order survives the round trip — `foldTriage`
    // returns targets in first-event order and the contract is `read(write(x)) === x`.
    for (const r of d.prepare(
      "SELECT target_kind, target_id, field, detail FROM triage WHERE source_scope = ? ORDER BY rowid",
    ).all(scope) as unknown as { target_kind: string; target_id: string; field: string; detail: string | null }[]) {
      const kind = r.target_kind as "node" | "anchor";
      const key = triageSubject(kind, r.target_id);
      try {
        const detail = JSON.parse(r.detail ?? "null");
        if (!detail) throw new Error("no detail");
        if (r.field === ABSENT_FIELD) { out.set(key, { target: { kind, id: r.target_id }, cleared: detail.cleared }); continue; }
        let t = out.get(key);
        if (!t) {
          // `importance` is written first for every target, so the partial object is
          // only ever missing it between this line and the assignment below.
          t = { target: { kind, id: r.target_id } } as TriageEntry;
          out.set(key, t);
        }
        (t as any)[r.field] = detail as Axis<any>;
      } catch {
        throw new CorruptProjection(`triage ${scope}/${key}/${r.field} is unreadable`);
      }
    }
    return out;
  },
};

/**
 * A teammate's wiring, into the ONE canonical `edges` table.
 *
 * Same rule that removed the `shared_doc_*` tables: a teammate's edge is an ordinary
 * edge carrying an `origin`, so every surface that reads the graph reads theirs without
 * knowing it exists. Before this, `edges` had no provenance columns at all — an edge
 * could not be fold-owned, so a teammate's doc arrived with its citations and none of
 * its wiring, and the event matrix reported their aggregate as an orphan.
 *
 * **Replaces only what it owns.** `DELETE ... WHERE source_scope = ?`, never by node:
 * a bare delete would take this clone's own edges, which are the one thing here the log
 * cannot put back.
 *
 * The DIVERGENCE is not stored. It is derived from the same events on every clone, so a
 * column for it would be a second copy of something the fold already answers — and the
 * queue that consumes it is local by the same rule that keeps the contested-triage item
 * local.
 */
export const graphProjection: Projection<Map<string, SharedWiring>> = {
  write(d: DatabaseSync, scope: string, value: Map<string, SharedWiring>): void {
    d.prepare("DELETE FROM edges WHERE source_scope = ?").run(scope);
    d.prepare("DELETE FROM shared_wiring WHERE scope = ?").run(scope);
    const ins = d.prepare(
      "INSERT INTO edges(from_id,to_id,type,ord,generated_by,origin,source_scope) VALUES(?,?,?,?,?,?,?)",
    );
    const receipt = d.prepare("INSERT INTO shared_wiring(scope,node_id,body) VALUES(?,?,?)");
    for (const w of value.values()) {
      for (const e of w.winner.edges) {
        ins.run(w.nodeId, e.to, e.type, e.order ?? null, null, "sync", scope);
      }
      receipt.run(scope, w.nodeId, JSON.stringify(w));
    }
  },

  read(d: DatabaseSync, scope: string): Map<string, SharedWiring> {
    // From the RECEIPT table, not by reassembling edge rows: the fold's answer carries
    // who published it, at what commit, and whether the ordering mattered, and none of
    // that survives a trip through `edges`. `rowid` order, so the fold's own Map order
    // survives the round trip — the contract is `read(write(x)) === x`.
    const out = new Map<string, SharedWiring>();
    for (const r of d.prepare("SELECT node_id, body FROM shared_wiring WHERE scope = ? ORDER BY rowid")
      .all(scope) as unknown as { node_id: string; body: string }[]) {
      try { out.set(r.node_id, JSON.parse(r.body) as SharedWiring); }
      catch { throw new CorruptProjection(`shared_wiring ${scope}/${r.node_id} is unreadable`); }
    }
    return out;
  },
};

/**
 * The fold and projection a scope is cached by, or null if its kind has none yet.
 *
 * Prefix-matched on the scope path, which is the same string `findingScope` /
 * `docScope` / `noteScope` / `walkthroughScope` build. All four kinds are here now,
 * which is what makes "the log is not read during normal operation" true rather
 * than aspirational — a scope missing from this map folds on every read.
 *
 * Lives with the projections rather than with the ops: it is the mapping itself,
 * and `ops-shared.ts` is an API surface whose every export must be reachable from a
 * front-end (`src/ops-reach.test.ts`). This is not an op.
 */
export function projectionFor(scope: string): { fold: (e: LogEvent[]) => any; proj: Projection<any> } | null {
  if (scope.startsWith("findings/")) return { fold: foldFindings, proj: findingsProjection };
  if (scope.startsWith("bugs/")) return { fold: foldBugs, proj: bugsProjection };
  if (scope.startsWith("docs/")) return { fold: foldDocs, proj: docsProjection };
  if (scope.startsWith("notes/")) return { fold: foldNotes, proj: notesProjection };
  if (scope.startsWith("walkthrough/")) return { fold: foldWalkthroughs, proj: walkthroughsProjection };
  if (scope.startsWith("triage/")) return { fold: foldTriage, proj: triageProjection };
  if (scope.startsWith("graph/")) return { fold: foldGraph, proj: graphProjection };
  return null;
}
