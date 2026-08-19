/**
 * Promoting a chapter into the map.
 *
 * A PR walkthrough is an executive summary of one change: useful while reviewing,
 * not worth keeping. Some of its chapters are not about the change at all though
 * — they describe how the system works, and those are documentation the map
 * should own. `durable` marks the candidates (a spec section describing the
 * system rather than this change); this turns one into a real node.
 *
 * Deliberately a human act. The walkthrough proposes; nothing is written until
 * someone says so, because a map full of auto-promoted chapters is worse than no
 * chapters at all.
 */

import { createHash } from "node:crypto";
import type { StoryChapter, StoryStep } from "./pr-story.js";
import { proseLines } from "./markdown.js";

/** Layer index → the name a reader recognises. Mirrors pr-story's `layerOf`. */
const LAYER_LABEL = ["Command", "Handler", "Event", "Aggregate", "Read model", "Scheduled job"];

export interface PromotionStep { title: string; summary: string; anchors: string[] }

export interface Promotion {
  id: string;
  type: "process" | "module";
  title: string;
  summary: string;
  body: string;
  anchors: string[];
  steps?: PromotionStep[];
  /** Why this shape was chosen, shown before the human confirms. */
  rationale: string;
  /**
   * Where the summary came from. `title` means nothing in the spec read as a
   * description of the system — these specs are written as instructions, so that
   * is common and not a failure. The surface should ask for one rather than let a
   * node into the map summarised by its own title.
   */
  summarySource: "spec" | "title";
  /**
   * The provenance line written into the body, and the token that lets a later
   * promotion recognise its own node. Absent for a derived chapter, which has no
   * spec section to cite — those own nothing and may never overwrite.
   */
  promotedFrom?: string;
}

const leaf = (s: StoryStep) => s.symbol.split(" › ").pop() ?? s.symbol;

const SLUG_MAX = 60;
const digest = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 6);

/**
 * Slugify, keeping the id readable. Truncation is where two long sibling headings
 * collapse onto one id, so a slug that had to be cut carries a digest of the whole
 * string instead of silently becoming its neighbour.
 */
function slugOf(s: string): string {
  const full = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (full.length <= SLUG_MAX) return full;
  return `${full.slice(0, SLUG_MAX - 7).replace(/-$/, "")}-${digest(full)}`;
}

/** The stem of the spec file, which is what qualifies a heading that repeats across specs. */
const specStem = (path: string | undefined) => path?.split("/").pop()?.replace(/\.[^.]*$/, "") ?? "";

/**
 * The body's provenance line — a citation for the human, and the token a later
 * promotion matches to recognise a node as its own. `document()` upserts, so
 * without an ownership test a chapter whose title slugs onto someone's
 * hand-written node would rewrite it; `prPromote` refuses unless it finds this.
 */
export function promotedFromLine(chapter: { specPath?: string; title: string; occurrence?: number }): string | undefined {
  if (!chapter.specPath) return undefined;
  const nth = (chapter.occurrence ?? 1) > 1 ? ` (${chapter.occurrence})` : "";
  return `_Promoted from \`${chapter.specPath}\` § ${cleanTitle(chapter.title)}${nth}._`;
}

/**
 * May a promotion write over the node already sitting at its id?
 *
 * Only when that node is this same spec section's earlier promotion — then the
 * write is the intended re-promote. Anything else is a different chapter or
 * somebody's hand-written node, and `document()` upserts: the write would replace
 * its title, body and citations with no way back. A derived chapter carries no
 * marker, so it owns nothing and can never overwrite.
 */
export function promotionOwns(node: { body: string } | undefined, promotedFrom: string | undefined): boolean {
  return !!node && !!promotedFrom && node.body.includes(promotedFrom);
}

/**
 * Shape a chapter for promotion.
 *
 * A chapter whose symbols span more than one layer of the command → handler →
 * event → aggregate → read-model spine *is* a process, and becomes a flow whose
 * steps are those layers — which is what the flow-walker exists to step through.
 * One that sits at a single layer is a module: a flow with one step is a worse
 * way to say the same thing.
 *
 * Steps are per LAYER, not per symbol. A chapter with twenty symbols would
 * otherwise become a twenty-step flow, which is the raw diff again with extra
 * ceremony rather than a process anyone can follow.
 */
export function planPromotion(chapter: StoryChapter, opts: { idPrefix?: string } = {}): Promotion {
  const steps = chapter.steps;
  const byLayer = new Map<number, StoryStep[]>();
  for (const s of steps) (byLayer.get(s.layer) ?? byLayer.set(s.layer, []).get(s.layer)!).push(s);
  const layers = [...byLayer.keys()].sort((a, b) => a - b);

  const anchors = steps.map((s) => s.anchorId);
  const title = cleanTitle(chapter.title);
  // `document()` upserts, so an id shared by two chapters means the second
  // rewrites the first node's title, body and citations. The title alone is not
  // distinct: headings repeat across the numbered specs this targets ("Validation
  // rules" under both 01-domain-model and 02-api), so the spec file qualifies it,
  // and the ordinal separates a heading that repeats *within* one file.
  const nth = chapter.occurrence > 1 ? ` ${chapter.occurrence}` : "";
  const base = slugOf([specStem(chapter.specPath), title + nth].filter(Boolean).join(" "))
    || `chapter-${slugOf(chapter.id) || digest(chapter.id)}`;
  const id = `${opts.idPrefix ?? ""}${base}`;
  // The spec section's own prose is the claim; the section it came from is the
  // citation that makes it checkable later — and the ownership token.
  const promotedFrom = promotedFromLine(chapter);
  const body = [chapter.prose, promotedFrom ? `\n\n${promotedFrom}` : ""].join("").trim();
  const summary = firstSentence(chapter.prose, title);
  const summarySource: "spec" | "title" = summary === title ? "title" : "spec";

  if (layers.length < 2) {
    return {
      id, type: "module", title, summary, summarySource, body, anchors, promotedFrom,
      rationale: `${steps.length} symbol(s) at a single layer (${LAYER_LABEL[layers[0] ?? 3] ?? "code"}) — a flow with one step says nothing a module does not.`,
    };
  }

  return {
    id, type: "process", title, summary, summarySource, body, anchors, promotedFrom,
    steps: layers.map((l) => {
      const group = byLayer.get(l)!;
      return {
        title: LAYER_LABEL[l] ?? `Layer ${l}`,
        summary: group.map(leaf).join(", ").slice(0, 240),
        anchors: group.map((s) => s.anchorId),
      };
    }),
    rationale: `${steps.length} symbol(s) across ${layers.length} layers (${layers.map((l) => LAYER_LABEL[l] ?? l).join(" → ")}) — a process, so it becomes a flow you can step through.`,
  };
}

/**
 * Spec prose is written to be *acted on*, so its opening lines are usually
 * instructions ("Add `public bool X`…") or front-matter ("**Status:** Draft").
 * Neither describes the system, and either makes a summary that reads like a
 * patch note. Skip those and take the first line that states something; if none
 * does, the title is a better summary than a misleading sentence.
 */
const DIRECTIVE = /^\s*(?:[-*]\s*)?(?:\*\*)?(add|change|set|remove|delete|rename|replace|update|introduce|extend|move|drop|status|depends|owner|prior art|see|note|todo|domain type|in|under|inside)\b/i;
/**
 * Prose, once `scanMarkdown` has already removed code fences, HTML comments and
 * headings. It used to drop fence DELIMITERS while keeping fence CONTENTS, so a
 * line of SQL could pass `looksLikeSummary` and become the promoted node's summary
 * — reported as `summarySource: "spec"`, which tells the surface a real description
 * was found and stops it asking the human for one.
 *
 * `DIRECTIVE` is NOT applied here any more: it is a sentence-level test, and
 * discarding the whole line meant a paragraph that opens with an instruction and
 * then states the behaviour lost the statement too.
 */
const isProse = (l: string) => l.trim() && !l.startsWith("|") && !l.startsWith(">");

/**
 * Sentence boundaries that survive abbreviations. A plain split after `.!?` cuts
 * "e.g.", "i.e.", "5 p.m." and an initial mid-sentence, and the fragment it leaves
 * passes every check — `looksLikeSummary` only guards where a candidate STARTS —
 * so "The gateway retries transient failures, e.g." was written into the map as a
 * node's description.
 */
// Case-SENSITIVE on the initial, and no bare trailing number: under `/i` the
// `[A-Z]` alternative matched any single letter and `\d+` matched any figure, so
// "Add the column X." absorbed the sentence after it — and the joined candidate then
// began with a directive and was discarded, taking a perfectly good summary with it.
const ABBREV_END = new RegExp(
  "(?:" + ["e\\.g", "i\\.e", "etc", "vs", "viz", "cf", "approx", "est", "fig", "al",
           "Mr", "Mrs", "Ms", "Dr", "Prof", "St", "Inc", "Ltd", "Co", "a\\.m", "p\\.m"].join("|") + ")\\.$",
  "i",
);
// Deliberately NOT joining on a trailing single capital ("…the column X."): an
// initial like "J. Smith" is rare, and the fragment it leaves is dropped by the
// length check anyway — whereas joining wrongly swallows the following sentence and
// loses a good summary entirely. The cheap error is the recoverable one.
function sentences(line: string): string[] {
  const out: string[] = [];
  for (const piece of line.split(/(?<=[.!?])\s+/)) {
    const prev = out[out.length - 1];
    if (prev !== undefined && ABBREV_END.test(prev)) out[out.length - 1] = `${prev} ${piece}`;
    else out.push(piece);
  }
  return out;
}

/** Marks of a fragment lifted out of an instruction rather than a statement about the system. */
const NOT_A_SUMMARY = [
  /\(L\d+/,                       // a line reference — belongs to a diff
  /:$/,                            // a lead-in to a code block
  /\.(cs|ts|tsx|py|js|md)\b/i,     // names a file
  // A path: two or more SLASHES, or one slash and a file extension. The bare
  // `\w+\/\w+` also matched "read/write", "and/or", "24/7" and "input/output", so a
  // perfectly good spec sentence was rejected and the node fell back to being
  // summarised by its own title — which the UI reads as "the spec had no
  // description" and asks the human to write one that already existed.
  /\w[\w.-]*\/[\w.-]*\/|\w[\w.-]*\/[\w.-]*\.\w{1,5}\b/,
];
const looksLikeSummary = (t: string) =>
  t.length >= 20
  // A candidate starting mid-clause is a fragment the sentence split produced, not
  // a statement — abbreviations and version numbers make that split imperfect.
  && /^[A-Z`"']/.test(t)
  && (t.match(/`/g) || []).length < 4
  && !NOT_A_SUMMARY.some((rx) => rx.test(t));

function firstSentence(text: string, fallback: string): string {
  // Sentences are cut WITHIN each line, so a line stays its own boundary — spec
  // prose is line-oriented, and "Add the column:" does not run on into whatever
  // follows it. `DIRECTIVE` then applies per SENTENCE rather than per line: it used
  // to discard the whole line, so a paragraph opening with an instruction and then
  // stating the behaviour lost the statement too.
  const candidates = proseLines(text).filter(isProse)
    .flatMap((l) => sentences(l.replace(/\s+/g, " ").trim()));
  // Take the first that actually reads like a description. Spec prose is written to
  // be acted on, so most leading sentences are instructions, file paths or
  // front-matter; a bad summary is worse than the title, which is at least honest.
  for (const cand of candidates.slice(0, 10)) {
    const t = cand.trim();
    if (DIRECTIVE.test(t)) continue;
    if (looksLikeSummary(t)) return t.length > 240 ? t.slice(0, 239) + "…" : t;
  }
  return fallback;
}

/** Line references belong to a diff, not to a name the map will carry for years. */
const cleanTitle = (t: string) => t.replace(/\s*\(L\d+[-–]\d+\)\s*/g, " ").replace(/\s+/g, " ").trim();
