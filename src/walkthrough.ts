/**
 * The PR walkthrough: an agent's reading guide to a change, in two levels.
 *
 * A 22k-line pull request is not reviewable as a flat list of symbols, and it is
 * not reviewable as the spec document's table of contents either — a spec has
 * goals, constants and "common pitfalls" sections that are not features, and it can
 * simply be wrong about what the change contains. So the structure comes from an
 * agent reading the CODE, and the spec is evidence rather than scaffolding.
 *
 *   Feature   a coherent capability the change delivers
 *     Chapter a unit worth describing, and worth signing off in one go
 *       Block prose, or a symbol — INTERLEAVED
 *
 * The interleaving is the point. A chapter is not a paragraph with ten code boxes
 * bolted underneath; the prose sits between the symbols and says what to look at
 * next and why, which is what makes it a walkthrough.
 *
 * See docs/pr-walkthrough-design.md. This module is the model and its invariants,
 * deliberately pure — no git, no network — so the rules can be tested directly.
 */

import type { BugWitness } from "./schema.js";
import { sameBody, comparableHashes, ABSENT_HASH } from "./normalize.js";
import { resolveAnchor, type AnchorIndex } from "./anchor-resolve.js";

export type WalkBlock =
  | { kind: "prose"; text: string }
  | { kind: "symbol"; anchorId: string };

export interface WalkChapter {
  id: string;
  title: string;
  blocks: WalkBlock[];
  /**
   * Body hashes of the symbols this chapter cites, as they were when it was
   * written. A walkthrough is a CLAIM about code: when the submitter pushes, the
   * chapters whose symbols moved go stale and only those need re-walking.
   */
  witnesses: BugWitness[];
}

export interface WalkFeature {
  id: string;
  title: string;
  /** What this feature is aiming to do — the thing that guides reading. */
  summary: string;
  /**
   * The agent judged this outside the change's stated purpose — a drive-by. Kept as
   * data rather than prose because it is the answer to "what is in here that
   * nobody told me about", which is a question about the PR, not about the code.
   */
  unstated?: boolean;
  chapters: WalkChapter[];
}

export interface PrWalkthrough {
  pr: number;
  /** The commit this was written against; a walkthrough is only about one head. */
  head: string;
  at: string;
  by: string;
  features: WalkFeature[];
}

/** What the agent submits — ids and witnesses are assigned on ingest. */
export interface WalkInput {
  title: string;
  summary: string;
  unstated?: boolean;
  chapters: { title: string; blocks: WalkBlock[] }[];
}

export interface WalkValidation {
  /** Cited anchors that are not changed by this pull request. */
  notInPr: string[];
  /** Anchors cited by more than one chapter, with the chapters that claim them. */
  claimedTwice: { anchorId: string; chapters: string[] }[];
  /** Chapters with no symbol in them at all. */
  emptyChapters: string[];
  ok: boolean;
}

/** Anchors a walkthrough cites, in order, with the chapter that cites each. */
export function citedAnchors(features: { chapters: { title: string; blocks: WalkBlock[] }[] }[]): { anchorId: string; chapter: string }[] {
  const out: { anchorId: string; chapter: string }[] = [];
  for (const f of features) {
    for (const c of f.chapters) {
      for (const b of c.blocks) if (b.kind === "symbol") out.push({ anchorId: b.anchorId, chapter: c.title });
    }
  }
  return out;
}

/**
 * The invariants, checked before anything is stored.
 *
 * A walkthrough is only worth reviewing FROM if it accounts for the change
 * honestly, so: it may not cite code the pull request does not touch, and no symbol
 * may appear in two chapters — a reviewer must never read one twice, or have to
 * work out which chapter's sign-off counted for it.
 */
export function validateWalkthrough(features: WalkInput[], inPr: ReadonlySet<string>): WalkValidation {
  const cited = citedAnchors(features);
  const notInPr = [...new Set(cited.filter((c) => !inPr.has(c.anchorId)).map((c) => c.anchorId))];

  const byAnchor = new Map<string, Set<string>>();
  for (const c of cited) (byAnchor.get(c.anchorId) ?? byAnchor.set(c.anchorId, new Set()).get(c.anchorId)!).add(c.chapter);
  const claimedTwice = [...byAnchor.entries()]
    .filter(([, chapters]) => chapters.size > 1)
    .map(([anchorId, chapters]) => ({ anchorId, chapters: [...chapters] }));

  const emptyChapters = features.flatMap((f) => f.chapters)
    .filter((c) => !c.blocks.some((b) => b.kind === "symbol"))
    .map((c) => c.title);

  return { notInPr, claimedTwice, emptyChapters, ok: !notInPr.length && !claimedTwice.length && !emptyChapters.length };
}

export interface WalkCoverage {
  /** Changed symbols in the review queue that no chapter walks. */
  uncovered: string[];
  covered: number;
  total: number;
  /**
   * Changed symbols outside the review queue (generated, vendored, test data).
   * Counted apart because those are EXPECTED to go unwalked — folding them in would
   * make the number meaningless.
   */
  outsideQueue: number;
}

/**
 * What the walkthrough leaves unaccounted for.
 *
 * This is not a tidiness metric. Anything not covered here is what the reviewer
 * ends up reading on GitHub instead — unviewed, out of context, without a guide —
 * so an uncovered symbol is work escaping the tool.
 */
export function walkCoverage(
  features: { chapters: { title: string; blocks: WalkBlock[] }[] }[],
  queue: ReadonlySet<string>,
  outsideQueue: number,
): WalkCoverage {
  const cited = new Set(citedAnchors(features).map((c) => c.anchorId));
  const uncovered = [...queue].filter((id) => !cited.has(id));
  return { uncovered, covered: queue.size - uncovered.length, total: queue.size, outsideQueue };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

/**
 * Assign stable ids and witness each chapter against the hashes it was written
 * from. Ids are derived from titles and de-duplicated, so re-walking a PR whose
 * structure is unchanged keeps the same ids — and therefore the same open/closed
 * and sign-off state in the UI.
 */
export function buildWalkthrough(
  input: { pr: number; head: string; by: string; at: string; features: WalkInput[] },
  hashOf: (anchorId: string) => string | undefined,
): PrWalkthrough {
  const taken = new Set<string>();
  const uniq = (base: string, fallback: string) => {
    let id = slug(base) || fallback, n = 2;
    while (taken.has(id)) id = `${slug(base) || fallback}-${n++}`;
    taken.add(id);
    return id;
  };
  return {
    pr: input.pr, head: input.head, by: input.by, at: input.at,
    features: input.features.map((f, fi) => ({
      id: uniq(f.title, `feature-${fi + 1}`),
      title: f.title,
      summary: f.summary,
      ...(f.unstated ? { unstated: true } : {}),
      chapters: f.chapters.map((c, ci) => ({
        id: uniq(c.title, `chapter-${fi + 1}-${ci + 1}`),
        title: c.title,
        blocks: c.blocks,
        witnesses: c.blocks.filter((b): b is { kind: "symbol"; anchorId: string } => b.kind === "symbol")
          .map((b) => ({ anchorId: b.anchorId, bodyHash: hashOf(b.anchorId) ?? "sha256:absent" })),
      })),
    })),
  };
}

/** Chapters whose cited code has moved since the walkthrough was written. */
export function staleChapters(w: PrWalkthrough, live: AnchorIndex): string[] {
  return w.features.flatMap((f) => f.chapters)
    .filter((c) => c.witnesses.some((wit) => {
      const r = resolveAnchor(wit.anchorId, [wit.bodyHash], live);
      // An id this index could not have minted says nothing about whether the
      // chapter's code moved, and a chapter flagged stale for that reason is work
      // nobody can do. `headMoved` already covers "the whole thing is suspect".
      if (r.at === "incomparable") return false;
      // The same rule one level down, and `resolveAnchor` does not reach it: it
      // classifies an ABSENT id, so a FOUND one hands back a hash unexamined. Two
      // hashes from different derivations differ because the tokenizer changed, not
      // because the chapter did — which after a grammar re-vendor is every chapter
      // at once. This is what `witnessDrift` does for reviews and bugs.
      const now = r.at === "found" ? r.hash : ABSENT_HASH;
      if (!comparableHashes(now, wit.bodyHash)) return false;
      return !sameBody(now, wit.bodyHash);
    }))
    .map((c) => c.id);
}
