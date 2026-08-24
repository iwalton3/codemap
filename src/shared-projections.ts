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
import { needsHumanAck, type SharedFinding } from "./shared-findings.js";
import type { SharedDoc, UnmatchedAcceptance } from "./shared-docs.js";
import type { SharedNote } from "./shared-notes.js";
import type { Actor, NodeVersion } from "./schema.js";

/**
 * Findings, keyed by scope.
 *
 * `body` holds the whole `SharedFinding` as JSON — the same shape `node_versions`
 * already uses for citations. The real columns are only what a query filters or
 * joins on, and every one of them is copied from the fold's own output rather than
 * derived from the anchors table, which is the condition the cache key rests on.
 */
export const findingsProjection: Projection<Map<string, SharedFinding>> = {
  write(d: DatabaseSync, scope: string, value: Map<string, SharedFinding>): void {
    // Replace, not merge. A fold is a whole-scope answer, and merging would let a
    // row survive the event that retracted it.
    d.prepare("DELETE FROM shared_finding WHERE scope = ?").run(scope);
    const ins = d.prepare(
      "INSERT INTO shared_finding(scope,id,target_kind,target_id,state,severity,category,line,"
      + "author,created_at,needs_ack,contested,body) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (const f of value.values()) {
      ins.run(
        scope, f.id, f.target.kind, f.target.id, f.state,
        f.severity ?? null, f.category ?? null, f.line ?? null,
        f.author.principal, f.createdAt,
        needsHumanAck(f) ? 1 : 0, f.contested?.length ? 1 : 0,
        JSON.stringify(f),
      );
    }
  },

  read(d: DatabaseSync, scope: string): Map<string, SharedFinding> {
    const out = new Map<string, SharedFinding>();
    // Insertion order, so a re-read matches the fold's own iteration order. The
    // fold walks events in causal order and the ack queue is presented in it.
    for (const r of d.prepare("SELECT id, body FROM shared_finding WHERE scope = ? ORDER BY rowid").all(scope) as unknown as
      { id: string; body: string }[]) {
      try {
        out.set(r.id, JSON.parse(r.body) as SharedFinding);
      } catch {
        throw new CorruptProjection(`shared_finding ${scope}/${r.id} is unreadable`);
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
    const exists = d.prepare("SELECT version_id FROM node_versions WHERE version_id = ?");
    const insUnmatched = d.prepare("INSERT INTO shared_doc_unmatched(scope,node_id,body) VALUES(?,?,?)");

    for (const doc of value.values()) {
      if (doc.unmatched?.length) insUnmatched.run(scope, doc.nodeId, JSON.stringify(doc.unmatched));
      doc.versions.forEach((v, i) => {
        const a = doc.authors.get(v.versionId);
        const author = a ? JSON.stringify(a) : null;
        const cites = JSON.stringify(v.citations ?? []);
        if (exists.get(v.versionId)) {
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

/**
 * Every anchor any shared doc version cites in this scope.
 *
 * One query with one parameter, deliberately: `docsCiting` takes the ids it is
 * asking about, which is right for a handful and wrong for a caller holding the
 * whole index — a repo with thousands of undocumented anchors would bind thousands
 * of parameters to ask a question whose answer is a few hundred rows. Intersect
 * against this instead, then ask `docsCiting` about what survives.
 */
export function sharedCitedAnchors(root: string, scope: string): Set<string> {
  const out = new Set<string>();
  for (const r of db(root).prepare("SELECT citations FROM node_versions WHERE source_scope = ?").all(scope) as unknown as
    { citations: string }[]) {
    try { for (const c of JSON.parse(r.citations ?? "[]") as { anchorId: string }[]) out.add(c.anchorId); }
    catch { /* one unreadable row must not blind the whole answer */ }
  }
  return out;
}

/** Unfiltered, this is the projection's `read`; filtered, it is what makes
 *  `docsCiting` worth having — only the matched nodes' JSON is parsed. */
function readDocRows(d: DatabaseSync, scope: string, nodeIds?: string[]): Map<string, SharedDoc> {
  const out = new Map<string, SharedDoc>();
  if (nodeIds && !nodeIds.length) return out;
  const only = nodeIds ? ` AND node_id IN (${nodeIds.map(() => "?").join(",")})` : "";
  const args = nodeIds ? [scope, ...nodeIds] : [scope];
  // `ord` is the fold's own order and is why it is a column: `versions` is oldest
  // first and row order is not a property of a table.
  for (const r of d.prepare(
    `SELECT * FROM node_versions WHERE source_scope = ?${only} ORDER BY node_id, ord`,
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

/**
 * Which shared docs cite these anchors — the read `shared_doc_citation` exists for.
 *
 * The catalogue read wants every doc anyway, so its citation ids are already in the
 * JSON it deserializes. This is the other direction — "does anybody's doc describe
 * THIS symbol" — and answering it by deserializing the universe is the cost
 * materialization exists to remove.
 *
 * Node ids only, so nothing is parsed to find out. `ensureMaterialized` first:
 * these are projection rows, and a stale one answers confidently from the wrong
 * input set.
 */
export function docsCiting(root: string, scope: string, anchorIds: string[]): string[] {
  const ids = [...new Set(anchorIds)];
  if (!ids.length) return [];
  // Over canonical rows now. The citation table is gone with the duality it served,
  // and `citations` is JSON here exactly as it is for a local doc — so this scans the
  // scope's rows rather than joining an index. That is the same shape the local
  // coverage path already has, at the same scale (one universe's docs), and it is
  // what removes the second table this function existed to bridge.
  const want = new Set(ids);
  const out = new Set<string>();
  for (const r of db(root).prepare("SELECT node_id, citations FROM node_versions WHERE source_scope = ?")
    .all(scope) as unknown as { node_id: string; citations: string }[]) {
    try {
      for (const c of JSON.parse(r.citations ?? "[]") as { anchorId: string }[]) {
        if (want.has(c.anchorId)) { out.add(r.node_id); break; }
      }
    } catch { /* one unreadable row must not blind the whole answer */ }
  }
  return [...out];
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
