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
import type { Complexity } from "./schema.js";

export interface SpecSection { specPath: string; heading: string; level: number; text: string; durable: boolean }

/**
 * Spec files that describe *this change* rather than the system. Promoting these
 * into the map would document a moment instead of a behaviour.
 */
const EPHEMERAL_SPEC = /(implementation-log|implementation-plan|open-items|changelog|migration-notes|_spec-authoring-playbook|README)/i;

/** Split spec markdown into `##`-level sections, each carrying the file's title as context. */
export function splitSpec(specPath: string, text: string): SpecSection[] {
  const durable = !EPHEMERAL_SPEC.test(specPath);
  const lines = text.split("\n");
  const out: SpecSection[] = [];
  let heading = specPath.split("/").pop() ?? specPath;
  let level = 1;
  let buf: string[] = [];
  let fenced = false;
  // The run before the first heading is a preamble and only counts when it has
  // text; once a heading has been seen, every section counts even if its body is
  // empty — a heading with nothing under it is exactly the "shipped without
  // code" case worth reporting.
  let started = false;
  const flush = () => {
    const body = buf.join("\n").trim();
    if (started || body) out.push({ specPath, heading, level, text: body, durable });
    buf = [];
  };
  for (const line of lines) {
    if (/^```/.test(line)) fenced = !fenced;       // a "#" inside a fence is code, not a heading
    const m = !fenced && /^(#{1,3})\s+(.*)$/.exec(line);
    if (m) { flush(); started = true; level = m[1]!.length; heading = m[2]!.trim(); continue; }
    buf.push(line);
  }
  flush();
  if (!out.length) out.push({ specPath, heading, level, text: "", durable });
  return out;
}

/**
 * Identifiers a spec section names. Backticked spans first (the author was
 * explicit), then bare PascalCase words, which in a C#/TS codebase are almost
 * always type or member names. Lowercase prose words are deliberately not
 * candidates — matching on them binds everything to everything.
 */
export function mentionedIdentifiers(text: string): Set<string> {
  const ids = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    for (const w of m[1]!.split(/[^A-Za-z0-9_]+/)) if (w.length > 2) ids.add(w);
  }
  for (const m of text.matchAll(/\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+)\b/g)) ids.add(m[1]!);
  return ids;
}

/** Where a symbol sits on the command → handler → event → aggregate → read-model spine. */
export function layerOf(file: string, symbol: string): number {
  const p = `${file} ${symbol}`;
  if (/\/Commands?\//i.test(file) || /Command\b/.test(symbol)) return 0;
  if (/\/Handlers?\//i.test(file) || /Handler\b/.test(symbol)) return 1;
  if (/Event\b/.test(symbol) || /\/Events?\//i.test(file)) return 2;
  if (/ModelAndProjections|Aggregate|\/Domain\//i.test(p)) return 3;
  if (/\/Quer(y|ies)\//i.test(file) || /Projection|ReadModel/.test(symbol)) return 4;
  if (/\/ScheduledJobs?\//i.test(file)) return 5;
  // front end: data access → hooks/components → routes
  if (/\/api\//.test(file)) return 0;
  if (/\/components?\//.test(file)) return 2;
  if (/\/routes?\//.test(file)) return 3;
  return 3;
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
  title: string;
  source: "spec" | "derived";
  specPath?: string;
  /** Describes the system (a promotion candidate) rather than just this change. */
  durable: boolean;
  prose: string;
  steps: StoryStep[];
}

export interface PrStory {
  chapters: StoryChapter[];
  /** Spec sections with no changed code behind them — shipped incomplete, or prose-only. */
  specWithoutCode: { specPath: string; heading: string }[];
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

const distinctive = (w: string) => w.length > 3 && !GENERIC.has(w);

/**
 * Headings keep their raw markdown, because the backticks are load-bearing for
 * identifier matching. Strip them only on the way out to a title.
 */
const display = (h: string) => h.replace(/`/g, "").trim();

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

/**
 * Bind steps to spec sections by identifier mention, then sweep the remainder into
 * derived chapters by directory. A step binds to at most one section — the one
 * naming the most of its identifiers — so a symbol appears once in the walkthrough.
 */
export function buildStory(sections: SpecSection[], steps: StoryStep[]): PrStory {
  const claimed = new Map<string, { idx: number; score: number }>();
  // Heading and body are scored separately: a section whose *heading* names a
  // symbol is almost always the chapter that symbol belongs in, while a passing
  // mention in the body is weak evidence.
  const secIds = sections.map((s) => ({ heading: mentionedIdentifiers(s.heading), body: mentionedIdentifiers(s.text) }));

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
        if (!distinctive(p)) continue;
        if (ids.heading.has(p)) score += p === leaf ? 6 : 3;
        else if (ids.body.has(p)) score += p === leaf ? 2 : 1;
      }
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
  const specWithoutCode: { specPath: string; heading: string }[] = [];
  sections.forEach((s, i) => {
    const steps = (byIdx.get(i) ?? []).sort(order);
    if (!steps.length) {
      // Only a section that actually names code can be "shipped without code";
      // prose, tables and headings legitimately have no symbols behind them, and
      // reporting them buries the sections that matter.
      const named = [...secIds[i]!.heading, ...secIds[i]!.body];
      if (named.some(distinctive)) specWithoutCode.push({ specPath: s.specPath, heading: display(s.heading) });
      return;
    }
    chapters.push({
      id: `spec-${slug(s.specPath)}-${slug(s.heading)}`,
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
      id: `derived-${slug(dir)}`, title: dir, source: "derived", durable: false,
      prose: "No spec section in this PR names these symbols.", steps: list.sort(order),
    });
  }

  return { chapters, specWithoutCode, undocumented: orphans.length };
}
