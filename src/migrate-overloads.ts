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
 * That would orphan those references instead, so this maps them across. The OLD
 * anchor rows are the record of the old scheme: each carries its file, symbolPath
 * and ordinal, so pairing them with a freshly indexed file BY POSITION recovers
 * old id -> new id without needing the old code back.
 *
 * Deliberately conservative: a group whose member count changed between the stored
 * index and the working tree is SKIPPED rather than guessed at, because position is
 * only a reliable pairing when nothing was added or removed. Those references
 * dangle — which is what would have happened anyway, and dangling is visible.
 */

import type { Anchor, Review, Triage, Annotation } from "./schema.js";

const groupKey = (a: { file: string; symbolPath: string[] }) => `${a.file} ${a.symbolPath.join(" ")}`;

/** Old rows were disambiguated by ordinal; new ones by signature. */
const isOrdinal = (d: string | undefined) => d !== undefined && /^\d+$/.test(d);

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
    if (!olds.some((a) => isOrdinal(a.disambiguator))) continue;   // already migrated
    const news = now.get(k);
    if (!news || news.length !== olds.length) continue;            // shape moved — do not guess
    // The ordinals ARE the old source order, and the fresh list is in source order,
    // which is what those ordinals counted.
    const inOrder = [...olds].sort((a, b) => Number(a.disambiguator) - Number(b.disambiguator));
    inOrder.forEach((o, i) => { if (o.id !== news[i]!.id) out.set(o.id, news[i]!.id); });
  }
  return out;
}

export interface RemapCounts { anchors: number; reviews: number; triage: number; annotations: number; citations: number }

/** Rewrite every stored reference through `map`, in place. Returns how many it touched. */
export function applyRemap(
  map: Map<string, string>,
  stores: {
    reviews: Review[];
    triage: Triage[];
    annotations: Annotation[];
    /** Node versions' citation lists, mutated in place. */
    citations: { anchorId: string; acceptedHashes?: string[] }[][];
  },
): RemapCounts {
  const to = (id: string) => map.get(id) ?? id;
  const counts: RemapCounts = { anchors: map.size, reviews: 0, triage: 0, annotations: 0, citations: 0 };

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
  for (const cites of stores.citations) {
    for (const c of cites) if (map.has(c.anchorId)) { c.anchorId = to(c.anchorId); counts.citations++; }
  }
  return counts;
}
