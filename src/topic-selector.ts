/**
 * A review topic's selector, and what it resolves to at a commit.
 *
 * The selector is the DENOMINATOR of a topic walkthrough (docs/PROPOSAL-review-topics.md
 * §3.1): it is resolved from saved data, not chosen by the agent as it writes, so
 * `unaccounted for` keeps meaning something. Pure — the caller supplies the anchors of
 * the head (and base) commit, the node citations, and the lane rule.
 */
import type { Anchor } from "./schema.js";
import { sameBody } from "./normalize.js";
import { compileIgnore } from "./ignore.js";
import { containedAnchorIds } from "./reviews.js";

export type { TopicSelector, ResolvedTopic } from "./shared-topics.js";
import type { TopicSelector, ResolvedTopic } from "./shared-topics.js";

export interface ResolveInput {
  head: Anchor[];
  /** The base commit's anchors; required when `selector.base` is set. */
  base?: Anchor[];
  /** Each node's cited anchor ids. A node absent here is unresolved. */
  nodeAnchors?: ReadonlyMap<string, readonly string[]>;
  /** The lane a file falls in when it is NOT the review queue; null for the queue. */
  outsideLane: (file: string) => string | null;
}

const byFile = (anchors: Anchor[]) => {
  const m = new Map<string, Anchor[]>();
  for (const a of anchors) (m.get(a.file) ?? m.set(a.file, []).get(a.file)!).push(a);
  return m;
};

/** Changed between the two sides: added, removed, or a different body. The `prContainment` rule. */
export function touchedBetween(base: Anchor[], head: Anchor[]): Set<string> {
  const b = new Map(base.map((a) => [a.id, a.bodyHash]));
  const h = new Map(head.map((a) => [a.id, a.bodyHash]));
  const out = new Set<string>();
  for (const id of new Set([...b.keys(), ...h.keys()])) {
    const x = b.get(id), y = h.get(id);
    if (x === undefined || y === undefined ? x !== y : !sameBody(x, y)) out.add(id);
  }
  return out;
}

export function resolveSelector(sel: TopicSelector, input: ResolveInput): ResolvedTopic {
  if (sel.base && !input.base) throw new Error("a range selector needs the base commit's anchors");
  // A range reads both sides: a symbol the range DELETES is only in the base, and is
  // part of what the range did (F19).
  const sides = sel.base ? [input.head, input.base!] : [input.head];
  const files = sides.map(byFile);
  const known = new Map<string, Anchor>();
  for (const side of sides) for (const a of side) if (!known.has(a.id)) known.set(a.id, a);

  const picked = new Set<string>();
  const unresolved: ResolvedTopic["unresolved"] = [];

  if (sel.paths?.length) {
    const ig = compileIgnore(sel.paths.join("\n"));
    for (const a of known.values()) if (ig.ignores(a.file, false)) picked.add(a.id);
  }

  const takeSymbol = (id: string, via?: string) => {
    const a = known.get(id);
    if (!a) { unresolved.push({ kind: "symbol", id, ...(via ? { via } : {}) }); return; }
    picked.add(id);
    // Per side: spans from two commits are not comparable (`containedAnchorIds`).
    for (const f of files) for (const c of containedAnchorIds(f.get(a.file) ?? [], id)) picked.add(c);
  };
  for (const id of sel.symbols ?? []) takeSymbol(id);
  for (const n of sel.nodes ?? []) {
    const cited = input.nodeAnchors?.get(n);
    if (!cited) { unresolved.push({ kind: "node", id: n }); continue; }
    for (const id of cited) takeSymbol(id, n);
  }

  const touched = sel.base ? touchedBetween(input.base!, input.head) : null;
  const ids: string[] = [];
  const outside: ResolvedTopic["outside"] = [];
  for (const id of picked) {
    if (touched && !touched.has(id)) continue;
    const lane = input.outsideLane(known.get(id)!.file);
    if (lane) outside.push({ id, lane }); else ids.push(id);
  }
  ids.sort(); outside.sort((a, b) => a.id.localeCompare(b.id));
  return { ids, outside, unresolved };
}

/**
 * What each of `ids` contains, within `within` — for coverage (a cited container covers
 * its members, topics only; owner Round 2.1). Both sides, as `prContainment` does.
 */
export function containmentFor(
  ids: Iterable<string>, sides: Anchor[][], within: ReadonlySet<string>,
): Map<string, string[]> {
  const files = sides.map(byFile);
  const fileOf = new Map<string, string>();
  for (const side of sides) for (const a of side) if (!fileOf.has(a.id)) fileOf.set(a.id, a.file);
  const out = new Map<string, string[]>();
  for (const id of ids) {
    const file = fileOf.get(id);
    if (!file) continue;
    const inside = new Set<string>();
    for (const f of files) for (const c of containedAnchorIds(f.get(file) ?? [], id)) if (within.has(c)) inside.add(c);
    if (inside.size) out.set(id, [...inside]);
  }
  return out;
}

export type SelectorDelta = {
  [K in "paths" | "symbols" | "nodes"]?: { added: string[]; removed: string[] };
} & { base?: { from: string | null; to: string | null } };

/**
 * How a topic's selector moved since a snapshot copied it, form by form — so an old
 * walkthrough can say WHAT changed (owner Round 2.4), not only that something did.
 * Empty object when nothing did.
 */
export function selectorChanged(was: TopicSelector, now: TopicSelector): SelectorDelta {
  const out: SelectorDelta = {};
  for (const k of ["paths", "symbols", "nodes"] as const) {
    const a = new Set(was[k] ?? []), b = new Set(now[k] ?? []);
    const added = [...b].filter((x) => !a.has(x)), removed = [...a].filter((x) => !b.has(x));
    if (added.length || removed.length) out[k] = { added, removed };
  }
  if ((was.base ?? null) !== (now.base ?? null)) out.base = { from: was.base ?? null, to: now.base ?? null };
  return out;
}

/** Ids the selector matches now that the snapshot never saw. */
export function newlyMatched(snapshot: Iterable<string>, current: Iterable<string>): string[] {
  const seen = new Set(snapshot);
  return [...current].filter((id) => !seen.has(id));
}
