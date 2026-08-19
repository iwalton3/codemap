/**
 * One-time remap of overloaded-callable anchor ids.
 *
 * An overload's disambiguator used to be its ORDINAL position in its scope, so
 * `Apply(OrderCreated)` and `Apply(OrderClosed)` were "0" and "1" and nothing about
 * the id said which method it was. Deleting or reordering one renumbered the rest,
 * and every stored reference — reviews, triage, annotations, node citations —
 * silently retargeted with it. It is a signature now (`(OrderCreated)`), which
 * changes the id of every overloaded callable exactly once.
 *
 * That would orphan those references instead, so this maps them across, pairing old
 * rows to new ones BY BODY HASH — the same identity `resolveAcceptance` reasons
 * about, which does not depend on the id and so survives both a reordering of the
 * file and the change of scheme itself.
 *
 * Deliberately conservative. A group is SKIPPED — leaving its references to dangle,
 * visibly, which is what would have happened anyway — whenever it cannot be paired
 * beyond doubt: the member count changed, two overloads share a body, or any body
 * differs between the stored index and the working tree. Guessing here would attach
 * somebody's sign-off to a method they never read.
 */

import type { Anchor, Review, Triage, Annotation, Bug } from "./schema.js";

const groupKey = (a: { file: string; symbolPath: string[] }) => `${a.file} ${a.symbolPath.join(" ")}`;

/**
 * old id -> new id, for every overloaded callable whose group is unambiguously
 * pairable. `fresh` must be an index of the same working tree the `stored` rows
 * were built from — `reindex` calls this with the anchors it just produced.
 */
export function remapOverloadIds(stored: Anchor[], fresh: Anchor[]): Map<string, string> {
  const byGroup = (list: Anchor[]) => {
    const m = new Map<string, Anchor[]>();
    for (const a of list) {
      if (a.disambiguator === undefined || a.disambiguator === "") continue;
      const k = groupKey(a);
      (m.get(k) ?? m.set(k, []).get(k)!).push(a);
    }
    return m;
  };
  const old = byGroup(stored), now = byGroup(fresh);
  const out = new Map<string, string>();
  for (const [k, olds] of old) {
    const news = now.get(k);
    if (!news || news.length !== olds.length) continue;            // shape moved — do not guess
    if (olds.every((o) => news.some((n) => n.id === o.id))) continue;   // already migrated

    // Pair by BODY HASH, not by position. Position looked right because the old
    // disambiguator WAS a position, but it only holds if nothing moved: reorder the
    // methods in a file — or check out a branch that orders them differently, which
    // auto-reindexes — and the counts still match while every pairing is off by a
    // rotation. That attaches somebody's sign-off to a method they never read, which
    // is the one outcome this whole migration exists to avoid.
    //
    // The body hash is the same identity `resolveAcceptance` reasons about and does
    // not depend on the id, so it survives both the reorder and the scheme change.
    const uniq = (list: Anchor[]) => new Set(list.map((a) => a.bodyHash)).size === list.length;
    if (!uniq(olds) || !uniq(news)) continue;                      // identical bodies cannot be told apart
    const byHash = new Map(news.map((n) => [n.bodyHash, n]));
    if (!olds.every((o) => byHash.has(o.bodyHash))) continue;      // a body changed — cannot pair safely
    for (const o of olds) {
      const n = byHash.get(o.bodyHash)!;
      if (o.id !== n.id) out.set(o.id, n.id);
    }
  }
  return out;
}

export interface RemapCounts { anchors: number; reviews: number; triage: number; annotations: number; citations: number; bugs: number }

/** Rewrite every stored reference through `map`, in place. Returns how many it touched. */
export function applyRemap(
  map: Map<string, string>,
  stores: {
    reviews: Review[];
    triage: Triage[];
    annotations: Annotation[];
    /**
     * Bugs are witness-hashed against anchor ids exactly as reviews are — the
     * `possiblyFixed` signal reads them — and were the one store this forgot.
     */
    bugs: Bug[];
    /** Node versions' citation lists, mutated in place. */
    citations: { anchorId: string; acceptedHashes?: string[] }[][];
  },
): RemapCounts {
  const to = (id: string) => map.get(id) ?? id;
  const counts: RemapCounts = { anchors: map.size, reviews: 0, triage: 0, annotations: 0, citations: 0, bugs: 0 };

  const retargetWitnesses = (ws: { anchorId: string }[] | undefined) => {
    let n = 0;
    for (const w of ws ?? []) if (map.has(w.anchorId)) { w.anchorId = to(w.anchorId); n++; }
    return n;
  };

  for (const r of stores.reviews) {
    let touched = r.target.kind === "anchor" && map.has(r.target.id);
    if (touched) r.target = { ...r.target, id: to(r.target.id) };
    if (retargetWitnesses(r.witnesses)) touched = true;
    for (const acc of r.accepted ?? []) if (map.has(acc.anchorId)) { acc.anchorId = to(acc.anchorId); touched = true; }
    if (touched) counts.reviews++;
  }
  for (const t of stores.triage) {
    let touched = t.target.kind === "anchor" && map.has(t.target.id);
    if (touched) t.target = { ...t.target, id: to(t.target.id) };
    if (retargetWitnesses(t.witnesses)) touched = true;
    if (touched) counts.triage++;
  }
  for (const a of stores.annotations) {
    if (a.target.kind === "anchor" && map.has(a.target.id)) {
      a.target = { ...a.target, id: to(a.target.id) };
      counts.annotations++;
    }
  }
  for (const b of stores.bugs) {
    let touched = false;
    const anchors = (b.anchors ?? []).map((id) => { if (map.has(id)) { touched = true; return to(id); } return id; });
    if (touched) b.anchors = anchors;
    if (retargetWitnesses(b.witnesses)) touched = true;
    if (touched) counts.bugs++;
  }
  for (const cites of stores.citations) {
    for (const c of cites) if (map.has(c.anchorId)) { c.anchorId = to(c.anchorId); counts.citations++; }
  }
  return counts;
}
