/**
 * The story of a change — chapters, in the order they make sense.
 *
 * A ranked worklist answers "what deserves attention first". It does not answer
 * "what did this change actually do", which is the question a 27k-line diff
 * hides and the reason review degrades into rubber-stamping. This builds that
 * narrative.
 *
 * The key move is that we do not invent it. These PRs ship numbered spec
 * markdown (`01-domain-model.md`, `02-api-and-notifications.md`, …) — the author
 * already wrote the story. Binding those sections to the symbols the PR changed
 * is exactly codemap's core competency, and it yields two review signals for
 * free: a spec section with no code behind it, and changed code under no section.
 *
 * Chapters are an executive summary of *this change* and are ephemeral by
 * default. A chapter whose spec section describes the *system* rather than the
 * change (a domain model, an API contract, a security rule) is marked
 * `durable` — a candidate to promote into a real node/flow. Promotion stays a
 * human act; this only proposes.
 */

import type { Lane } from "./lanes.js";
import { scanMarkdown } from "./markdown.js";
import type { Complexity } from "./schema.js";

export interface SpecSection { specPath: string; heading: string; level: number; text: string; durable: boolean }

/**
 * Spec files that describe *this change* rather than the system. Promoting these
 * into the map would document a moment instead of a behaviour.
 */
const EPHEMERAL_SPEC = /(implementation-log|implementation-plan|open-items|changelog|migration-notes|_spec-authoring-playbook|README)/i;

/**
 * A heading that describes *this change* rather than the system, even inside a
 * file that otherwise documents the system. `01-domain-model.md` is a durable
 * document, but its "3.1 Changed: `OrderShipmentCreated` (L903-968)" section
 * is a diff instruction — promoting that mints a node named after a patch, which
 * is the junk the durable/ephemeral split exists to prevent.
 */
const CHANGE_VERB = "changed|new|not added|added|removed|deprecated|renamed|extend(?:ed|s)?|migrat\\w*|revert(?:ed)?";
const CHANGE_HEADING = new RegExp(
  // Leading, after an optional section number — "3.1 Changed: `Foo`", "3.5 Not
  // added". The verb has to be QUALIFYING something (a colon, a dash, a backticked
  // name) or be the whole heading: a bare `\b` also caught "Extended attributes"
  // and "New order flow", so an ordinary system-describing heading was excluded
  // from promotion even in a durable spec.
  `^\\s*(?:[\\d.]+\\s*)?(?:${CHANGE_VERB})\\b(?:\\s*[:—–]|\\s+-\\s|\\s+\`|\\s*$)`
  // or trailing after a real dash, which is how these specs qualify a heading:
  // "4.4 Apply(OrderDeliveryCreated) — extend (D7)". A bare hyphen matched inside
  // hyphenated words too ("auto-removed"), so it must be an em/en dash or spaced.
  + `|(?:[—–]|\\s-)\\s*(?:${CHANGE_VERB})\\b`
  // or carrying a line range, which only a diff has
  + `|\\(L\\d+[-–]\\d+\\)|\\bTODO\\b`,
  "i",
);

export const isDurableHeading = (heading: string) => !CHANGE_HEADING.test(heading);

/**
 * Split spec markdown into sections, each carrying the file's title as context.
 *
 * The document is scanned once (`scanMarkdown`) rather than matched line by line:
 * headings inside fenced blocks, inside HTML comments, or written as setext
 * underlines all used to be got wrong, each of them silently. See markdown.ts.
 */
export function splitSpec(specPath: string, text: string): SpecSection[] {
  const durable = !EPHEMERAL_SPEC.test(specPath);
  const out: SpecSection[] = [];
  let heading = specPath.split("/").pop() ?? specPath;
  let level = 1;
  let buf: string[] = [];
  // The run before the first heading is a preamble and only counts when it has
  // text; once a heading has been seen, every section counts even if its body is
  // empty — a heading with nothing under it is exactly the "shipped without
  // code" case worth reporting.
  let started = false;
  const flush = () => {
    const body = buf.join("\n").trim();
    if (started || body) out.push({ specPath, heading, level, text: body, durable: durable && isDurableHeading(heading) });
    buf = [];
  };
  for (const l of scanMarkdown(text)) {
    // Only `#`..`###` cut a section; deeper ones are detail inside one.
    if (l.kind === "heading" && l.level <= 3) {
      flush(); started = true; level = l.level; heading = l.text;
      continue;
    }
    // A commented-out section is text the author DELETED. Keeping its body would
    // report its identifiers as spec shipped without code.
    if (l.kind === "comment") continue;
    buf.push(l.kind === "heading" ? `${"#".repeat(l.level)} ${l.text}` : l.text);
  }
  flush();
  if (!out.length) out.push({ specPath, heading, level, text: "", durable: durable && isDurableHeading(heading) });
  return out;
}

/**
 * Identifiers a spec section names. Backticked spans first (the author was
 * explicit), then bare PascalCase words, which in a C#/TS codebase are almost
 * always type or member names. Lowercase prose words are deliberately not
 * candidates — matching on them binds everything to everything.
 */
export function mentionedIdentifiers(text: string, known?: Set<string>): Set<string> {
  const ids = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    for (const w of m[1]!.split(/[^A-Za-z0-9_]+/)) if (w.length > 2) ids.add(w);
  }
  // Two humps, OR a leading run of capitals: the `\b[A-Z][a-z0-9]+` form could not
  // match anything starting with two capitals, so `IOrderService`, `APIKeyStore`
  // and every `I`-prefixed interface produced NOTHING — not even a tail — and the
  // section naming one bound no symbols and vanished from the walkthrough.
  for (const m of text.matchAll(/\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+|[A-Z]{2,}[a-z0-9]+(?:[A-Z][a-z0-9]*)*)\b/g)) ids.add(m[1]!);
  // A single-hump word is only an identifier if something in this pull request
  // actually goes by that name. Admitting them unconditionally would make "The",
  // "This" and "When" identifiers and bind everything to everything, which is why
  // they were excluded outright; checking against what the PR touches is the
  // precision that was missing, and it is what lets an unbackticked `Ledger` bind.
  if (known?.size) {
    for (const m of text.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)) if (known.has(m[1]!)) ids.add(m[1]!);
  }
  return ids;
}

/**
 * Where a symbol sits on the spine, or null when nothing in its path or name says.
 *
 * The distinction matters to anything drawing a conclusion from it: `layerOf`
 * defaults an unrecognised symbol to the middle of the spine so the walkthrough
 * can still order it, but *deriving stakes* from that default would assert
 * "important" about every unclassifiable file in the PR.
 */
/**
 * Position on the command → handler → event → aggregate → read-model spine, or
 * null. STAKES are derived from this one only.
 *
 * `spineRole` also places front-end paths, which is right for ORDERING a React PR
 * but wrong for stakes: those positions are indices into the same table, so every
 * `/components/` and `/routes/` file asserted "important", which pins severity at
 * >= medium and leaves the whole ranking carrying no information. The docstring
 * there promises a null rather than "a stake about every unclassifiable file" —
 * this is the half that keeps that promise.
 */
export function backendSpineRole(file: string, symbol: string): number | null {
  const p = `${file} ${symbol}`;
  if (/\/Commands?\//i.test(file) || /Command\b/.test(symbol)) return 0;
  if (/\/Handlers?\//i.test(file) || /Handler\b/.test(symbol)) return 1;
  if (/Event\b/.test(symbol) || /\/Events?\//i.test(file)) return 2;
  if (/ModelAndProjections|Aggregate|\/Domain\//i.test(p)) return 3;
  if (/\/Quer(y|ies)\//i.test(file) || /Projection|ReadModel/.test(symbol)) return 4;
  if (/\/ScheduledJobs?\//i.test(file)) return 5;
  return null;
}

export function spineRole(file: string, symbol: string): number | null {
  const backend = backendSpineRole(file, symbol);
  if (backend !== null) return backend;
  // front end: data access → hooks/components → routes. ORDERING only — see
  // `backendSpineRole` for why these must not reach the stake table.
  if (/\/api\//.test(file)) return 0;
  if (/\/components?\//.test(file)) return 2;
  if (/\/routes?\//.test(file)) return 3;
  return null;
}

/** The spine position for ordering — unknowns sort mid-spine rather than first. */
export function layerOf(file: string, symbol: string): number {
  return spineRole(file, symbol) ?? 3;
}

export interface StoryStep {
  anchorId: string; file: string; symbol: string; signature: string;
  change: "added" | "changed" | "removed"; complexity: Complexity; severity: string;
  lane: Lane; layer: number;
  /** Live review state and the first-pass agent's findings, so a chapter renders in one call. */
  reviewed?: boolean; viewed?: boolean;
  /** The marks themselves, carrying `via` — a borrowed approval must not render as a plain tick. */
  review?: unknown; viewedMark?: unknown;
  annotations?: unknown[];
}

export interface StoryChapter {
  id: string;
  /**
   * Which chapter of this name this is, 1-based. A spec that repeats a heading
   * produces two chapters that are otherwise identical; the ordinal is what keeps
   * their ids — and the node ids they promote to — apart.
   */
  occurrence: number;
  title: string;
  source: "spec" | "derived";
  specPath?: string;
  /** Describes the system (a promotion candidate) rather than just this change. */
  durable: boolean;
  prose: string;
  steps: StoryStep[];
}

/**
 * Why a spec section has no code behind it in this PR. Without the distinction the
 * list is unusable: a backend PR ships the whole spec cluster, so its UI sections
 * are "missing" only in the sense that they live in the front-end repo.
 *   covered   — its symbols ARE in this PR, but another section claimed them; a
 *               step binds to one chapter only, so the loser looks empty.
 *   unchanged — the symbols it names exist here; this PR just did not touch them.
 *   absent    — nothing by that name exists in this universe, so it is another
 *               repo's concern (or genuinely unbuilt).
 */
export type SpecGapReason = "covered" | "unchanged" | "absent";

export interface PrStory {
  chapters: StoryChapter[];
  /** Spec sections naming code this PR does not contain, and why. */
  specWithoutCode: { specPath: string; heading: string; reason: SpecGapReason; names: string[] }[];
  /** Changed symbols no spec section accounts for — where scrutiny belongs. */
  undocumented: number;
}

/**
 * Member names so common that matching on them binds everything to everything —
 * a section naming `OrderShipmentCreated` would otherwise claim every
 * `Create` in the PR. A symbol still binds through its *type* or file name,
 * which is what actually identifies it.
 */
const GENERIC = new Set([
  "Create", "Update", "Delete", "Remove", "Add", "Handle", "HandleAsync", "Load", "LoadAsync",
  "Validate", "Apply", "Get", "Set", "Build", "Run", "Execute", "Send", "Map", "Parse",
  "Result", "Request", "Response", "Handler", "Endpoint", "Command", "Query", "Event",
  "Model", "Dto", "Item", "Value", "Name", "Status", "Type", "State", "Data", "Info", "Async",
]);

/**
 * Worth binding on. `known` is what the pull request actually touches, which is
 * what makes a SHORT name safe: `Fee`, `Tax`, `Vat` and `Sku` are real domain types
 * and could never bind under a blanket length cut-off, while a bare three-letter
 * word from prose still cannot get in.
 */
const distinctive = (w: string, known?: Set<string>) =>
  !GENERIC.has(w) && (w.length > 3 || (w.length >= 3 && !!known?.has(w)));

/**
 * Headings keep their raw markdown, because the backticks are load-bearing for
 * identifier matching. Strip them only on the way out to a title.
 */
const display = (h: string) => h.replace(/`/g, "").trim();

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

/**
 * Chapter ids must be distinct: they key `each()` in the walkthrough (vdx drops a
 * duplicate and never reconciles it), they key the open/promoted maps, and they
 * are what a promotion's node id is derived from. A spec that repeats a heading —
 * "### Notes" under two features — otherwise yields two chapters with one id.
 */
function distinctId(base: string, taken: Set<string>): { id: string; occurrence: number } {
  let occurrence = 1, id = base;
  while (taken.has(id)) id = `${base}-${++occurrence}`;
  taken.add(id);
  return { id, occurrence };
}

/**
 * Bind steps to spec sections by identifier mention, then sweep the remainder into
 * derived chapters by directory. A step binds to at most one section — the one
 * naming the most of its identifiers — so a symbol appears once in the walkthrough.
 */
export function buildStory(sections: SpecSection[], steps: StoryStep[], opts: { known?: Set<string> } = {}): PrStory {
  const claimed = new Map<string, { idx: number; score: number }>();

  // Every identifier this PR actually touched, however it is spelled — leaf name,
  // any path segment, or a type named in a signature (which is how an aggregate's
  // Apply overloads are told apart). Computed FIRST because it is what makes a
  // single-hump or three-letter word in the spec safe to read as an identifier.
  const changedNames = new Set<string>();
  for (const st of steps) {
    for (const part of st.symbol.split(" › ")) changedNames.add(part);
    for (const id of mentionedIdentifiers(st.signature)) changedNames.add(id);
  }
  const vocabulary = new Set([...changedNames, ...(opts.known ?? [])]);

  // Heading and body are scored separately: a section whose *heading* names a
  // symbol is almost always the chapter that symbol belongs in, while a passing
  // mention in the body is weak evidence.
  const secIds = sections.map((s) => ({
    heading: mentionedIdentifiers(s.heading, vocabulary),
    body: mentionedIdentifiers(s.text, vocabulary),
  }));

  for (const step of steps) {
    const leaf = step.symbol.split(" › ").pop() ?? step.symbol;
    const parts = new Set([leaf, ...step.symbol.split(" › "), (step.file.split("/").pop() ?? "").replace(/\.[a-z]+$/i, "")]);
    // The signature carries what the symbolPath cannot: an aggregate's `Apply`
    // overloads are distinguished only by their event parameter, and that event
    // name is exactly what the spec section is titled after.
    for (const id of mentionedIdentifiers(step.signature)) parts.add(id);

    let best = -1, bestScore = 0;
    secIds.forEach((ids, i) => {
      let score = 0;
      for (const p of parts) {
        if (!distinctive(p, vocabulary)) continue;
        if (ids.heading.has(p)) score += p === leaf ? 6 : 3;
        else if (ids.body.has(p)) score += p === leaf ? 2 : 1;
      }
      // A GENERIC leaf (`Apply`, `Handle`) never binds on its own — that is what
      // `distinctive` is for. But when a section heading names it AND something
      // distinctive the step also carries, that section is the more specific home:
      // `## \`Apply(OrderShipmentCreated)\` on the aggregate` and `## \`OrderShipmentCreated\``
      // otherwise scored identically, and the tie went to whichever came FIRST in
      // the file, so the aggregate's prose ended up with no steps and was demoted
      // to a gap row — never shown beside the overload it exists to explain.
      if (score > 0 && GENERIC.has(leaf) && ids.heading.has(leaf)) score += 1;
      if (score > bestScore) { bestScore = score; best = i; }
    });
    if (best >= 0) claimed.set(step.anchorId, { idx: best, score: bestScore });
  }

  const byIdx = new Map<number, StoryStep[]>();
  const orphans: StoryStep[] = [];
  for (const step of steps) {
    const c = claimed.get(step.anchorId);
    if (!c) { orphans.push(step); continue; }
    (byIdx.get(c.idx) ?? byIdx.set(c.idx, []).get(c.idx)!).push(step);
  }

  const order = (a: StoryStep, b: StoryStep) => a.layer - b.layer || a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol);

  const chapters: StoryChapter[] = [];
  const chapterIds = new Set<string>();
  const specWithoutCode: { specPath: string; heading: string; reason: SpecGapReason; names: string[] }[] = [];
  sections.forEach((s, i) => {
    const steps = (byIdx.get(i) ?? []).sort(order);
    if (!steps.length) {
      // Only a section that actually names code can be "shipped without code";
      // prose, tables and headings legitimately have no symbols behind them, and
      // reporting them buries the sections that matter. A tracker or readme is
      // never a claim about code at all.
      if (EPHEMERAL_SPEC.test(s.specPath)) return;
      const named = [...new Set([...secIds[i]!.heading, ...secIds[i]!.body])].filter((w) => distinctive(w, vocabulary));
      if (!named.length) return;
      // Claimed by a sibling section? Then it is documented in this PR after all,
      // and reporting it as a gap is an artefact of one-section-per-step binding.
      const covered = named.filter((n) => changedNames.has(n));
      const here = opts.known ? named.filter((n) => opts.known!.has(n)) : [];
      const reason: SpecGapReason = covered.length ? "covered" : here.length ? "unchanged" : "absent";
      specWithoutCode.push({
        specPath: s.specPath,
        heading: display(s.heading),
        reason,
        names: (covered.length ? covered : here.length ? here : named).slice(0, 6),
      });
      return;
    }
    chapters.push({
      ...distinctId(`spec-${slug(s.specPath)}-${slug(s.heading)}`, chapterIds),
      title: display(s.heading), source: "spec", specPath: s.specPath, durable: s.durable,
      prose: s.text, steps,
    });
  });

  // Everything the spec does not account for, grouped by directory so the sweep
  // still reads as chapters rather than a flat remainder pile.
  const byDir = new Map<string, StoryStep[]>();
  for (const o of orphans) {
    const dir = o.file.split("/").slice(0, -1).join("/") || "(root)";
    (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(o);
  }
  for (const [dir, list] of [...byDir.entries()].sort((a, b) => b[1].length - a[1].length)) {
    chapters.push({
      ...distinctId(`derived-${slug(dir)}`, chapterIds), title: dir, source: "derived", durable: false,
      prose: "No spec section in this PR names these symbols.", steps: list.sort(order),
    });
  }

  return { chapters, specWithoutCode, undocumented: orphans.length };
}
