/**
 * Review topics on the sidecar: the topic definitions, and the walkthroughs walked from them.
 * See docs/review-topics.md.
 *
 * Two families, two prefixes:
 *
 *   topics/<universe>                      topic.defined | topic.revised | topic.retired
 *   topic-walkthrough/<universe>/t-<hex>   topic.walkthrough.published
 *
 * Walkthroughs are NOT under `walkthrough/`: that family's door and fold are registered by
 * prefix and would claim a topic snapshot, then refuse it for lacking a pull request number.
 *
 * A topic's slug is its key for ever — findings and walkthroughs cite it — so retiring is a
 * tombstone and a slug is never reused (the `withdraw_spec` lesson,
 * docs/requirements-architecture.md). Anyone may revise or retire (owner, Round 2.4).
 */
import { createHash } from "node:crypto";
import { readScope, registerDoor, registerKinds, registerReferences, tipReader, type LogEvent, type ScopeReader } from "./eventlog.js";
import { collector, foldJudged, registerReport, type Refusal, type RefusalClass } from "./validation.js";
import { emitEvent } from "./write.js";
import { canonical } from "./canonical.js";
import { walkthroughShaped } from "./shared-walkthrough.js";
import { validateWalkthrough } from "./walkthrough.js";
import type { Actor, BugWitness } from "./schema.js";
import type { WalkFeature } from "./walkthrough.js";

/** A topic's selector and what it resolves to; the resolver is `topic-selector.ts`, above this. */
export interface TopicSelector {
  /** Gitignore-style globs: every anchor in a matching file. */
  paths?: string[];
  /** Anchor ids: each, and every anchor it contains (byte span, as `prContainment`). */
  symbols?: string[];
  /** Doc or flow node ids: the anchors each cites, as if listed in `symbols`. */
  nodes?: string[];
  /** Intersect with what changed between this commit and the head — the merged-range form. */
  base?: string;
}

export interface ResolvedTopic {
  /** The review queue: what a walkthrough must account for. */
  ids: string[];
  /** In the selector, outside the queue lane — counted apart, as `WalkCoverage.outsideQueue`. */
  outside: { id: string; lane: string }[];
  /**
   * Entries that name nothing at the head (nor, for a range, at the base). Reported, never
   * dropped: a renamed symbol silently leaving a topic is the floating claim this exists
   * to prevent. `via` is the node whose citation it was.
   */
  unresolved: { kind: "path" | "symbol" | "node"; id: string; via?: string }[];
}

export const TOPIC_SLUG = /^[a-z0-9-]{1,64}$/;

export const topicsScope = (universe: string): string => `topics/${universe}`;

/** The hex every per-topic scope is keyed by — a hash, as a branch scope is (`review-target.ts`). */
export const topicHex = (universe: string, slug: string): string =>
  createHash("sha256").update(`${universe}\0topic\0${slug}`).digest("hex").slice(0, 40);

export const topicWalkthroughScope = (universe: string, slug: string): string =>
  `topic-walkthrough/${universe}/t-${topicHex(universe, slug)}`;

export interface Topic {
  slug: string;
  title: string;
  selector: TopicSelector;
  status: "active" | "retired";
  definedBy: Actor;
  definedAt: string;
  revisions: { at: string; by: Actor; eventId: string; was: { title?: string; selector?: TopicSelector } }[];
  retired?: { at: string; by: Actor };
}

type Data = Record<string, unknown>;
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && !!x.trim());

/** Why a selector is malformed, or null. At least one of paths, symbols or nodes, each of strings. */
export function selectorProblem(s: unknown): string | null {
  if (!s || typeof s !== "object" || Array.isArray(s)) return "a selector is an object";
  const o = s as Data;
  for (const k of Object.keys(o)) if (!["paths", "symbols", "nodes", "base"].includes(k)) return `a selector has no field "${k}"`;
  for (const k of ["paths", "symbols", "nodes"]) if (o[k] !== undefined && !isStrings(o[k])) return `selector.${k} is a list of non-empty strings`;
  if (o.base !== undefined && (typeof o.base !== "string" || !o.base.trim())) return "selector.base is a commit";
  if (![o.paths, o.symbols, o.nodes].some((x) => Array.isArray(x) && x.length)) return "a selector names at least one path, symbol or node";
  return null;
}

/** Every topic ever defined in a universe, retired ones included, in definition order. */
export function foldTopicsReport(events: LogEvent[]): { value: Topic[]; refused: Refusal[] } {
  const { refused, refuse } = collector();
  return { value: foldTopicsWith(events, refuse), refused };
}

function foldTopicsWith(events: LogEvent[], refuse: (e: LogEvent, cls: RefusalClass, why: string) => void): Topic[] {
  const out = new Map<string, Topic>();
  // The same defining bytes again are one act seen twice; different ones claim a taken key.
  const created = new Map<string, string>();
  for (const e of events) {
    if (!e.kind.startsWith("topic.") || e.kind.startsWith("topic.walkthrough.")) continue;
    const d = e.data as Data | undefined;
    const slug = e.subject;
    if (!TOPIC_SLUG.test(slug)) { refuse(e, "shape", `"${slug}" is not a topic slug — lowercase letters, digits and dashes, at most 64`); continue; }

    if (e.kind === "topic.defined") {
      if (out.has(slug)) {
        // Identical bytes are a retry only while the topic stands: after a retire, the same
        // define is a fresh act that would otherwise read as success and change nothing.
        if (out.get(slug)!.status === "retired") refuse(e, "state", `topic ${slug} was retired, and a retired topic's slug is never reused`);
        else if (created.get(slug) !== canonical(d ?? null)) refuse(e, "state", `topic ${slug} already exists`);
        continue;
      }
      const title = typeof d?.title === "string" ? d.title.trim() : "";
      if (!title) { refuse(e, "shape", "a topic needs a title"); continue; }
      const bad = selectorProblem(d?.selector);
      if (bad) { refuse(e, "shape", bad); continue; }
      created.set(slug, canonical(d ?? null));
      out.set(slug, {
        slug, title, selector: d!.selector as TopicSelector, status: "active",
        definedBy: e.actor, definedAt: e.at, revisions: [],
      });
      continue;
    }

    const t = out.get(slug);
    if (!t) { refuse(e, "reference", `no topic ${slug}`); continue; }
    if (t.status === "retired") { refuse(e, "state", `topic ${slug} is retired`); continue; }

    if (e.kind === "topic.revised") {
      const now = (d?.now ?? {}) as { title?: unknown; selector?: unknown };
      const was = (d?.was ?? {}) as { title?: unknown; selector?: unknown };
      if (now.title === undefined && now.selector === undefined) { refuse(e, "shape", "a revision changes the title or the selector"); continue; }
      if (now.title !== undefined && (typeof now.title !== "string" || !now.title.trim())) { refuse(e, "shape", "a topic needs a title"); continue; }
      if (now.selector !== undefined) {
        const bad = selectorProblem(now.selector);
        if (bad) { refuse(e, "shape", bad); continue; }
      }
      // A compare-and-swap, as `staleRevision`, but by CONTENT: a selector is an object, and
      // two equal ones read from two places are never `===`. `was` is REQUIRED per changed
      // field: topics have no legacy writer, so a missing one is a write that skipped the check.
      const unread = (["title", "selector"] as const).filter((k) => now[k] !== undefined && !(k in was));
      if (unread.length) { refuse(e, "shape", `a revision says what it read of ${unread.join(" and ")}`); continue; }
      const moved = (["title", "selector"] as const).filter((k) => now[k] !== undefined
        && canonical(t[k]) !== canonical(was[k]) && canonical(t[k]) !== canonical(now[k]));
      if (moved.length) { refuse(e, "state", `${moved.join(", ")} changed since you read it`); continue; }
      t.revisions.push({
        at: e.at, by: e.actor, eventId: e.id,
        was: { ...(now.title !== undefined ? { title: t.title } : {}), ...(now.selector !== undefined ? { selector: t.selector } : {}) },
      });
      if (typeof now.title === "string") t.title = now.title.trim();
      if (now.selector !== undefined) t.selector = now.selector as TopicSelector;
      continue;
    }

    if (e.kind === "topic.retired") {
      t.status = "retired";
      t.retired = { at: e.at, by: e.actor };
      continue;
    }
  }
  return [...out.values()];
}

registerReport((scope) => scope.startsWith("topics/"), foldTopicsReport);
registerDoor((scope) => scope.startsWith("topics/"), () => (events) => foldTopicsReport(events));
const TOPIC_KINDS = registerKinds((scope) => scope.startsWith("topics/"), ["topic.defined", "topic.revised", "topic.retired"]);

/** The fold for a READ: a refused linear event is damage or newer; see `validation.ts`. */
export function foldTopics(events: LogEvent[]): Topic[] {
  return foldJudged(events, foldTopicsReport, TOPIC_KINDS).value;
}

export const defineTopic = (logRoot: string, universe: string, actor: Actor, slug: string, title: string, selector: TopicSelector) =>
  emitEvent(logRoot, topicsScope(universe), actor, "topic.defined", slug, { title, selector: selector as unknown as Data });

/** `was` is the topic as its author read it: a replay onto a topic a teammate has since revised refuses. */
export const reviseTopic = (
  logRoot: string, universe: string, actor: Actor, current: Topic, now: { title?: string; selector?: TopicSelector },
) => emitEvent(logRoot, topicsScope(universe), actor, "topic.revised", current.slug, {
  now: now as Data,
  was: { ...(now.title !== undefined ? { title: current.title } : {}), ...(now.selector !== undefined ? { selector: current.selector } : {}) },
});

export const retireTopic = (logRoot: string, universe: string, actor: Actor, slug: string) =>
  emitEvent(logRoot, topicsScope(universe), actor, "topic.retired", slug, {});

// ---------------------------------------------------------------------------
// Topic walkthroughs
// ---------------------------------------------------------------------------

/** One snapshot: the selector resolved at a commit, walked. Immutable once published. */
export interface TopicWalkthrough {
  topic: string;
  head: string;
  base?: string;
  /** The selector as resolved — a COPY, so revising the topic never rewrites what this was about. */
  selector: TopicSelector;
  resolved: ResolvedTopic;
  by: string;
  at: string;
  features: WalkFeature[];
  /**
   * What each cited container covers in the set, witnessed at the head. A class's own hash is
   * its shell without member bodies, so without these a chapter citing only the class never
   * reads "moved" when a member changes (R15).
   */
  covers: { container: string; members: BugWitness[] }[];
}

export interface SharedTopicWalkthrough {
  /** The publishing event's id: the walkthrough's identity, and what sign-offs hang off. */
  id: string;
  walkthrough: TopicWalkthrough;
  actor: Actor;
  at: string;
}

const shapeProblem = (w: TopicWalkthrough | undefined): string | null => {
  if (!w || typeof w !== "object") return "a topic walkthrough is an object";
  if (typeof w.topic !== "string" || !TOPIC_SLUG.test(w.topic)) return "a topic walkthrough names its topic";
  if (typeof w.head !== "string" || !w.head) return "a topic walkthrough names its head";
  if (w.base !== undefined && typeof w.base !== "string") return "a topic walkthrough's base is a commit";
  const sel = selectorProblem(w.selector);
  if (sel) return `the selector it copied: ${sel}`;
  if (!w.resolved || !Array.isArray(w.resolved.ids) || !Array.isArray(w.resolved.outside) || !Array.isArray(w.resolved.unresolved)) {
    return "a topic walkthrough carries the set it resolved";
  }
  if (!walkthroughShaped(w as never)) return "a walkthrough's chapters need an id and witnesses — this is not a built walkthrough";
  return accountingProblem(w);
};

/**
 * What `topicWalkthroughSet` checks, checked again here so a walk that skipped the op is
 * refused by the same rule (the guard-in-one-end shape). The PR walkthrough door is NOT
 * tightened alike: it has events on real logs, which a new refusal would turn into damage.
 */
function accountingProblem(w: TopicWalkthrough): string | null {
  if (!w.features.length) return "a topic walkthrough walks nothing: it needs at least one feature";
  const inSet = new Set([...w.resolved.ids, ...w.resolved.outside.map((o) => o?.id)]);
  const v = validateWalkthrough(w.features, inSet);
  if (v.notInPr.length) return `cites what its resolved set does not hold: ${v.notInPr.join(", ")}`;
  if (v.claimedTwice.length) return `walks ${v.claimedTwice.map((c) => c.anchorId).join(", ")} in more than one chapter`;
  if (v.emptyChapters.length) return `chapters that walk no symbol: ${v.emptyChapters.join(", ")}`;
  const cited = new Set<string>();
  for (const c of w.features.flatMap((f) => f.chapters)) {
    const cites = c.blocks.filter((b) => b.kind === "symbol").map((b) => (b as { anchorId: string }).anchorId);
    const seen = new Set(c.witnesses.map((x) => x?.anchorId));
    const bare = cites.filter((id) => !seen.has(id));
    if (bare.length) return `chapter ${c.id} cites without a witness: ${bare.join(", ")}`;
    for (const id of cites) cited.add(id);
  }
  if (!Array.isArray(w.covers)) return "a topic walkthrough carries what its cited containers cover";
  for (const c of w.covers) {
    if (!c || !cited.has(c.container)) return `a cover names ${c?.container}, which no chapter cites`;
    if (!Array.isArray(c.members) || !c.members.every((m) => inSet.has(m?.anchorId) && typeof m.bodyHash === "string")) {
      return `what ${c.container} covers is witnessed members of the resolved set`;
    }
  }
  return null;
}

/** Every snapshot of a topic, oldest first. Nothing replaces anything: each is its own record. */
export function foldTopicWalkthroughsReport(events: LogEvent[]): { value: SharedTopicWalkthrough[]; refused: Refusal[] } {
  const { refused, refuse } = collector();
  const out: SharedTopicWalkthrough[] = [];
  for (const e of events) {
    if (e.kind !== "topic.walkthrough.published") continue;
    const w = (e.data as Data | undefined)?.walkthrough as TopicWalkthrough | undefined;
    const bad = shapeProblem(w);
    if (bad) { refuse(e, "shape", bad); continue; }
    out.push({ id: e.id, walkthrough: w!, actor: e.actor, at: e.at });
  }
  return { value: out, refused };
}

const WALK_SCOPE = /^topic-walkthrough\/(.+)\/t-([0-9a-f]+)$/;

/**
 * A snapshot names its topic, which lives in `topics/<universe>`: it must be defined there and
 * not retired, as the log stood before the event — and filed in that topic's own scope.
 */
async function walkReferences(scope: string, e: LogEvent, _own: LogEvent[], read: ScopeReader): Promise<Refusal[]> {
  if (e.kind !== "topic.walkthrough.published") return [];
  const slug = ((e.data as Data | undefined)?.walkthrough as { topic?: unknown } | undefined)?.topic;
  const m = WALK_SCOPE.exec(scope);
  const refuse = (why: string): Refusal[] => [{ id: e.id, kind: e.kind, cls: "reference", why }];
  // Reads and lists find a topic's walks by its hash scope; one filed anywhere else is never read.
  if (!m) return refuse(`${scope} is not a topic walkthrough scope (topic-walkthrough/<universe>/t-<hex>)`);
  if (typeof slug !== "string") return [];
  const [, universe, hex] = m;
  if (topicHex(universe!, slug) !== hex) return refuse(`a walkthrough of topic ${slug} belongs in ${topicWalkthroughScope(universe!, slug)}, not ${scope}`);
  const topic = foldTopicsReport(await read.read(topicsScope(universe!))).value.find((t) => t.slug === slug);
  if (!topic) return refuse(`no topic ${slug} has been defined`);
  if (topic.status === "retired") return refuse(`topic ${slug} is retired`);
  return [];
}

registerReport((scope) => scope.startsWith("topic-walkthrough/"), foldTopicWalkthroughsReport);
registerDoor((scope) => scope.startsWith("topic-walkthrough/"), (logRoot, scope) => async (events, minted) => ({
  refused: [...foldTopicWalkthroughsReport(events).refused, ...await walkReferences(scope, minted, events, tipReader(logRoot))],
}));
registerReferences((scope) => scope.startsWith("topic-walkthrough/"), walkReferences);
const TOPIC_WALK_KINDS = registerKinds((scope) => scope.startsWith("topic-walkthrough/"), ["topic.walkthrough.published"]);

export function foldTopicWalkthroughs(events: LogEvent[]): SharedTopicWalkthrough[] {
  return foldJudged(events, foldTopicWalkthroughsReport, TOPIC_WALK_KINDS).value;
}

export const publishTopicWalkthrough = (logRoot: string, universe: string, actor: Actor, w: TopicWalkthrough) =>
  emitEvent(logRoot, topicWalkthroughScope(universe, w.topic), actor, "topic.walkthrough.published", w.topic,
    { walkthrough: w as unknown as Data });

/** For tests and wholesale reads. Ordinary reads go through the projection (`ops/topics.ts`). */
export const readTopicsLog = async (logRoot: string, universe: string) => foldTopics(await readScope(logRoot, topicsScope(universe)));
