/**
 * How each shared entity is stored in, and rebuilt from, the materialized tables.
 *
 * Separate from `materialize.ts` on purpose: that module owns the cache key, the
 * transaction and the re-fold, and knows nothing about what it is caching. This one
 * knows the entities and nothing about when they are folded. Keeping them apart is
 * what lets the fold be a parameter rather than an import — see the note there.
 *
 * The equivalence obligation lives here: `read(write(x))` must equal `x` for every
 * fold output, or the cache is a second, quieter implementation of the fold. It is
 * a cache, and "it's only a cache" is exactly the sentence that stops someone
 * testing it — so `materialize.test.ts` asserts the round trip against real folds.
 */

import type { DatabaseSync } from "node:sqlite";
import type { Projection } from "./materialize.js";
import { needsHumanAck, type SharedFinding } from "./shared-findings.js";

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
        // A row nothing can parse is the same as no row: the scope's fingerprint
        // will not match on the next read either, so the fold reruns and replaces it.
      }
    }
    return out;
  },
};
