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
  write(d: DatabaseSync, scope: string, value: Map<string, SharedDoc>): void {
    for (const t of ["shared_doc", "shared_doc_version", "shared_doc_citation"]) {
      d.prepare(`DELETE FROM ${t} WHERE scope = ?`).run(scope);
    }
    const insDoc = d.prepare("INSERT INTO shared_doc(scope,node_id,unmatched) VALUES(?,?,?)");
    const insVer = d.prepare("INSERT INTO shared_doc_version(scope,node_id,version_id,ord,author,body) VALUES(?,?,?,?,?,?)");
    const insCite = d.prepare("INSERT OR IGNORE INTO shared_doc_citation(scope,version_id,anchor_id) VALUES(?,?,?)");
    for (const doc of value.values()) {
      insDoc.run(scope, doc.nodeId, doc.unmatched?.length ? JSON.stringify(doc.unmatched) : null);
      doc.versions.forEach((v, i) => {
        const a = doc.authors.get(v.versionId);
        insVer.run(scope, doc.nodeId, v.versionId, i, a ? JSON.stringify(a) : null, JSON.stringify(v));
        for (const c of v.citations ?? []) insCite.run(scope, v.versionId, c.anchorId);
      });
    }
  },

  read(d: DatabaseSync, scope: string): Map<string, SharedDoc> {
    const out = new Map<string, SharedDoc>();
    for (const r of d.prepare("SELECT node_id, unmatched FROM shared_doc WHERE scope = ? ORDER BY rowid").all(scope) as unknown as
      { node_id: string; unmatched: string | null }[]) {
      const doc: SharedDoc = { nodeId: r.node_id, versions: [], authors: new Map<string, Actor>() };
      if (r.unmatched) doc.unmatched = JSON.parse(r.unmatched) as UnmatchedAcceptance[];
      out.set(r.node_id, doc);
    }
    for (const r of d.prepare("SELECT node_id, version_id, author, body FROM shared_doc_version WHERE scope = ? ORDER BY node_id, ord").all(scope) as unknown as
      { node_id: string; version_id: string; author: string | null; body: string }[]) {
      const doc = out.get(r.node_id);
      if (!doc) continue;
      try {
        doc.versions.push(JSON.parse(r.body) as NodeVersion);
        if (r.author) doc.authors.set(r.version_id, JSON.parse(r.author) as Actor);
      } catch {
        throw new CorruptProjection(`shared_doc_version ${scope}/${r.version_id} is unreadable`);
      }
    }
    return out;
  },
};

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
