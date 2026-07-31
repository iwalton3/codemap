/**
 * Coverage & scope resolution — turns the binary "is it cited" into the real
 * per-anchor state, from citation + stored selector rules.
 *
 * Precedence, strongest first: deferred/owned (subtree scope) → cited (explicit
 * human citation) → trivial → covered → open. So a scope rule wins over
 * everything, an explicit citation beats a blanket trivial/covered rule, and an
 * anchor nobody has touched is `open` — the actual work queue.
 */

import { type Anchor, type AnchorSelector, type CoverageMark, type CoverageState, type CoverageRule } from "./schema.js";

function globToRegExp(glob: string): RegExp {
  const body = glob.split("*").map((s) => s.replace(/[.+^${}()|[\]\\?]/g, "\\$&")).join(".*");
  return new RegExp("^" + body + "$");
}

export function matchSelector(a: Anchor, sel: AnchorSelector): boolean {
  if (sel.file && a.file !== sel.file) return false;
  if (sel.pathPrefix && !a.file.startsWith(sel.pathPrefix)) return false;
  if (sel.kind && a.kind !== sel.kind) return false;
  if (sel.symbol) {
    const leaf = a.symbolPath[a.symbolPath.length - 1] ?? "";
    if (!globToRegExp(sel.symbol).test(leaf)) return false;
  }
  // An empty selector matches nothing (guard against accidental catch-all).
  return Boolean(sel.file || sel.pathPrefix || sel.kind || sel.symbol);
}

export function selectAnchors(anchors: Anchor[], sel: AnchorSelector): Anchor[] {
  return anchors.filter((a) => matchSelector(a, sel));
}

const MARK_RANK: Record<CoverageMark, number> = { deferred: 4, owned: 3, trivial: 2, covered: 1 };

export interface CoverageResult {
  state: Map<string, CoverageState>;
  breakdown: Record<CoverageState, number>;
}

export function emptyBreakdown(): Record<CoverageState, number> {
  return { open: 0, cited: 0, covered: 0, trivial: 0, deferred: 0, owned: 0 };
}

export function resolveCoverage(anchors: Anchor[], citedIds: Set<string>, rules: CoverageRule[]): CoverageResult {
  // Strongest matching rule mark per anchor.
  const ruleMark = new Map<string, CoverageMark>();
  for (const r of rules) {
    for (const a of anchors) {
      if (!matchSelector(a, r.select)) continue;
      const cur = ruleMark.get(a.id);
      if (!cur || MARK_RANK[r.as] > MARK_RANK[cur]) ruleMark.set(a.id, r.as);
    }
  }
  const state = new Map<string, CoverageState>();
  const breakdown = emptyBreakdown();
  for (const a of anchors) {
    const mark = ruleMark.get(a.id);
    let s: CoverageState;
    if (mark === "deferred" || mark === "owned") s = mark; // scope wins
    else if (citedIds.has(a.id)) s = "cited"; // explicit citation beats blanket rules
    else if (mark === "trivial") s = "trivial";
    else if (mark === "covered") s = "covered";
    else s = "open";
    state.set(a.id, s);
    breakdown[s]++;
  }
  return { state, breakdown };
}

/** Anchors that count toward the coverage ratio (in-scope, documentable). */
export const DENOMINATOR: CoverageState[] = ["open", "cited", "covered"];
/** Anchors that count as documented. */
export const DOCUMENTED: CoverageState[] = ["cited", "covered"];

export function docPct(b: Record<CoverageState, number>): number {
  const denom = DENOMINATOR.reduce((n, s) => n + b[s], 0);
  const done = DOCUMENTED.reduce((n, s) => n + b[s], 0);
  return denom ? Math.round((100 * done) / denom) : 0;
}

/**
 * The stricter number: anchors a doc actually CITES, over the same denominator.
 *
 * `docPct` counts a `cover` selector sweep the same as a citation, so a map can
 * read 100% documented while most of its code is only conceptually claimed by a
 * module doc. Both are honest answers to different questions — "is the queue
 * clean" vs "is this described" — so report them side by side and let neither
 * stand in for the other.
 */
export function citedPct(b: Record<CoverageState, number>): number {
  const denom = DENOMINATOR.reduce((n, s) => n + b[s], 0);
  return denom ? Math.round((100 * b.cited) / denom) : 0;
}
