/**
 * Review topics: walkthroughs of any selector-defined set of code (docs/PROPOSAL-review-topics.md).
 *
 * Definitions and walkthroughs travel (`shared-topics.ts`); sign-off history is LOCAL
 * (`walk_signoffs`), and the per-anchor review mark is re-projected from it.
 */
import type { Anchor } from "../schema.js";
import { resolveSidecar, sidecarIdentity, type SidecarConfig } from "../sidecar-config.js";
import { readCached } from "../materialize.js";
import { topicsProjection, topicWalkthroughsProjection } from "../shared-projections.js";
import {
  foldTopics, foldTopicWalkthroughs, topicsScope, topicWalkthroughScope, defineTopic, reviseTopic, retireTopic,
  publishTopicWalkthrough, selectorProblem, TOPIC_SLUG,
  type Topic, type TopicWalkthrough, type SharedTopicWalkthrough,
} from "../shared-topics.js";
import { resolveSelector, containmentFor, touchedBetween, selectorChanged, newlyMatched, type TopicSelector, type ResolvedTopic } from "../topic-selector.js";
import { validateWalkthrough, buildWalkthrough, walkCoverage, movedSince, type WalkInput } from "../walkthrough.js";
import { readSnapshot } from "../snapshots.js";
import { headCommit, revParse, trunkRef, readBlobs } from "../git.js";
import { loadLanes, LANE_POLICY } from "../lanes.js";
import { loadIgnore } from "../ignore.js";
import { resolveActor } from "../identity.js";
import { appendWalkSignoffs, readWalkSignoffs, readFindings, type WalkSignoff } from "../store.js";
import { topicKey } from "../review-target.js";
import { markReviewedBatch, unmarkReviewed, type Attestation } from "../reviews.js";
import { ABSENT_HASH } from "../normalize.js";
import { snapshotHashes, loadNodesShared, langFor } from "./shared.js";
import { anchorMark } from "./triage.js";
import { deliveryNote } from "../delivery.js";

type Err = { error: string };
const NO_SIDECAR = "topics live on the sidecar, and this universe has none configured. Point one at a shared repo "
  + "with CODEMAP_SIDECAR=/path/to/sidecar or .codemap/sidecar — it may be a local repository with no remote.";

const sidecar = (root: string): SidecarConfig | Err => resolveSidecar(root) ?? { error: NO_SIDECAR };

async function topicsOf(root: string, cfg: SidecarConfig): Promise<Topic[]> {
  return (await readCached(root, cfg.path, topicsScope(cfg.universe), sidecarIdentity(cfg), foldTopics, topicsProjection)).value;
}

async function walksOf(root: string, cfg: SidecarConfig, slug: string): Promise<SharedTopicWalkthrough[]> {
  return (await readCached(root, cfg.path, topicWalkthroughScope(cfg.universe, slug), sidecarIdentity(cfg),
    foldTopicWalkthroughs, topicWalkthroughsProjection)).value;
}

async function topicOr(root: string, slug: string): Promise<{ cfg: SidecarConfig; topic: Topic } | Err> {
  const cfg = sidecar(root);
  if ("error" in cfg) return cfg;
  const topic = (await topicsOf(root, cfg)).find((t) => t.slug === slug);
  return topic ? { cfg, topic } : { error: `no topic "${slug}" — \`topic list\` shows the topics there are` };
}

/** Bind, make sure the sidecar exists, run one write, and turn a door refusal into an error. */
async function write<T>(root: string, act: (cfg: SidecarConfig, actor: import("../schema.js").Actor) => Promise<T>): Promise<T | Err> {
  const { bindShared } = await import("../ops-shared.js");
  const { ensureSidecar } = await import("../sidecar.js");
  const b = bindShared(root);
  if ("error" in b) return b;
  const ready = await ensureSidecar(b.cfg.path, b.actor);
  if ("error" in ready) return ready;
  try { return await act(b.cfg, b.actor); } catch (e) { return { error: String((e as Error)?.message ?? e) }; }
}

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

export async function topicList(root: string, opts: { all?: boolean } = {}) {
  const cfg = sidecar(root);
  if ("error" in cfg) return cfg;
  const all = await topicsOf(root, cfg);
  const shown = opts.all ? all : all.filter((t) => t.status === "active");
  const counts = await Promise.all(shown.map(async (t) => {
    const walks = await walksOf(root, cfg, t.slug);
    return { walks: walks.length, latest: walks.at(-1) ? { id: walks.at(-1)!.id, head: walks.at(-1)!.walkthrough.head, at: walks.at(-1)!.at } : null };
  }));
  return {
    topics: shown.map((t, i) => ({ ...t, ...counts[i]! })),
    ...(opts.all ? {} : { retired: all.length - shown.length }),
  };
}

const checkSlug = (slug: string): Err | null =>
  TOPIC_SLUG.test(slug) ? null : { error: `"${slug}" is not a topic slug — lowercase letters, digits and dashes, at most 64` };

export async function topicDefine(root: string, input: { slug: string; title: string; selector: TopicSelector }) {
  const bad = checkSlug(input.slug) ?? (selectorProblem(input.selector) ? { error: selectorProblem(input.selector)! } : null);
  if (bad) return bad;
  if (!input.title?.trim()) return { error: "a topic needs a title" };
  const r = await write(root, (cfg, actor) => defineTopic(cfg.path, cfg.universe, actor, input.slug, input.title.trim(), input.selector));
  if ("error" in r) return r;
  return { ok: true, topic: input.slug, note: deliveryNote(root) };
}

export async function topicRevise(root: string, slug: string, now: { title?: string; selector?: TopicSelector }) {
  if (now.title === undefined && now.selector === undefined) return { error: "nothing to revise: pass a title, a selector, or both" };
  if (now.selector !== undefined && selectorProblem(now.selector)) return { error: selectorProblem(now.selector)! };
  const t = await topicOr(root, slug);
  if ("error" in t) return t;
  if (t.topic.status === "retired") return { error: `topic ${slug} is retired` };
  const r = await write(root, (cfg, actor) => reviseTopic(cfg.path, cfg.universe, actor, t.topic, now));
  if ("error" in r) return r;
  return { ok: true, topic: slug, note: deliveryNote(root) };
}

export async function topicRetire(root: string, slug: string) {
  const t = await topicOr(root, slug);
  if ("error" in t) return t;
  if (t.topic.status === "retired") return { error: `topic ${slug} is already retired` };
  const r = await write(root, (cfg, actor) => retireTopic(cfg.path, cfg.universe, actor, slug));
  if ("error" in r) return r;
  return { ok: true, topic: slug, retired: true, note: deliveryNote(root) };
}

// ---------------------------------------------------------------------------
// Resolving a selector at a commit
// ---------------------------------------------------------------------------

interface Resolution {
  head: string;
  /** What the set was intersected with: the re-walk's delta base, or the selector's own range. */
  base?: string;
  resolved: ResolvedTopic;
  sides: Anchor[][];
}

/** The commit a topic is walked at by default: main's tip, else whatever is checked out. */
const defaultHead = (root: string): string | null => trunkRef(root)?.sha ?? headCommit(root);

async function resolveAt(root: string, sel: TopicSelector, head: string, delta?: string): Promise<Resolution | Err> {
  const headAnchors = await readSnapshot(root, head);
  if (!headAnchors) return { error: `cannot read commit ${head.slice(0, 12)} here` };
  const rangeBase = sel.base ? revParse(root, sel.base) : null;
  if (sel.base && !rangeBase) return { error: `the selector's base "${sel.base}" is not a commit this clone has` };
  const deltaBase = delta ? revParse(root, delta) : null;
  if (delta && !deltaBase) return { error: `"${delta}" is not a commit this clone has` };
  const base = deltaBase ?? rangeBase;
  const baseAnchors = base ? await readSnapshot(root, base) : null;
  if (base && !baseAnchors) return { error: `cannot read commit ${base.slice(0, 12)} here` };

  const [lanes, ignore] = await Promise.all([loadLanes(root), loadIgnore(root)]);
  const outsideLane = (f: string) => {
    if (ignore.isTest(f, false)) return "test";
    const lane = lanes.classify(f);
    return LANE_POLICY[lane].review === "queue" ? null : lane;
  };
  const nodeAnchors = sel.nodes?.length ? new Map((await loadNodesShared(root)).map((n) => [n.id, n.anchors])) : undefined;
  let resolved = resolveSelector({ ...sel, ...(base ? { base } : {}) },
    { head: headAnchors, ...(baseAnchors ? { base: baseAnchors } : {}), nodeAnchors, outsideLane });
  // A re-walk of a RANGE topic: the delta base narrows, and the selector's own range still bounds.
  if (deltaBase && rangeBase && deltaBase !== rangeBase) {
    const rangeAnchors = await readSnapshot(root, rangeBase);
    if (!rangeAnchors) return { error: `cannot read commit ${rangeBase.slice(0, 12)} here` };
    const inRange = touchedBetween(rangeAnchors, headAnchors);
    resolved = { ...resolved, ids: resolved.ids.filter((id) => inRange.has(id)), outside: resolved.outside.filter((o) => inRange.has(o.id)) };
  }
  return { head, ...(base ? { base } : {}), resolved, sides: baseAnchors ? [headAnchors, baseAnchors] : [headAnchors] };
}

/**
 * The head of the latest walkthrough of this topic in which THIS MACHINE'S PERSON signed
 * anything (owner, F6). By principal, never "the caller": an agent writes a walkthrough
 * and never signs one, so "the latest I wrote" would always be the agent's.
 */
function lastSignedWalk(root: string, walks: SharedTopicWalkthrough[]): SharedTopicWalkthrough | null {
  const me = resolveActor(root)?.principal;
  if (!me || !walks.length) return null;
  const signed = new Set(readWalkSignoffs(root, { walkIds: walks.map((w) => w.id), principal: me }).map((r) => r.walkId));
  for (let i = walks.length - 1; i >= 0; i--) if (signed.has(walks[i]!.id)) return walks[i]!;
  return null;
}

async function planWalk(root: string, slug: string, opts: { head?: string; base?: string; whole?: boolean }) {
  const t = await topicOr(root, slug);
  if ("error" in t) return t;
  if (t.topic.status === "retired") return { error: `topic ${slug} is retired` };
  const head = opts.head ? revParse(root, opts.head) : defaultHead(root);
  if (!head) return { error: opts.head ? `"${opts.head}" is not a commit this clone has` : "no commit to walk: this is not a git repository" };
  const walks = await walksOf(root, t.cfg, slug);
  const since = opts.base || opts.whole ? null : lastSignedWalk(root, walks);
  const delta = opts.base ?? (since && since.walkthrough.head !== head ? since.walkthrough.head : undefined);
  const r = await resolveAt(root, t.topic.selector, head, delta);
  if ("error" in r) return r;
  return { ...t, ...r, walks, ...(since && !opts.base ? { since: { walk: since.id, head: since.walkthrough.head } } : {}) };
}

/** The resolved set with its source, for the agent writing the walkthrough — as `pr_packet`. */
export async function topicPacket(root: string, slug: string, opts: { head?: string; base?: string; whole?: boolean; limit?: number; offset?: number } = {}) {
  const p = await planWalk(root, slug, opts);
  if ("error" in p) return p;
  const byId = new Map<string, Anchor>();
  for (const side of [...p.sides].reverse()) for (const a of side) byId.set(a.id, a);
  const headIds = new Set(p.sides[0]!.map((a) => a.id));
  const offset = opts.offset ?? 0;
  const slice = p.resolved.ids.slice(offset, offset + (opts.limit ?? 40));
  const fileAt = (sha: string, ids: string[]) => readBlobs(root, sha, [...new Set(ids.map((id) => byId.get(id)!.file))]);
  const headBlobs = fileAt(p.head, slice.filter((id) => headIds.has(id)));
  const baseBlobs = p.base ? fileAt(p.base, slice.filter((id) => !headIds.has(id))) : new Map<string, string>();
  const cut = (src: string | undefined, a: Anchor | undefined) => (src && a?.loc ? src.slice(a.loc.startByte, a.loc.endByte) : undefined);
  const headById = new Map(p.sides[0]!.map((a) => [a.id, a]));
  const baseById = new Map((p.sides[1] ?? []).map((a) => [a.id, a]));
  return {
    topic: { slug: p.topic.slug, title: p.topic.title, selector: p.topic.selector },
    head: p.head, ...(p.base ? { base: p.base } : {}), ...(p.since ? { since: p.since } : {}),
    counts: { total: p.resolved.ids.length, included: slice.length, outside: p.resolved.outside.length },
    outside: p.resolved.outside.slice(0, 50),
    unresolved: p.resolved.unresolved,
    items: slice.map((id) => {
      const a = byId.get(id)!;
      const deleted = !headIds.has(id);
      return {
        id, file: a.file, symbol: a.symbolPath.join(" › "), kind: a.kind,
        ...(a.loc && !deleted ? { startLine: a.loc.startLine, endLine: a.loc.endLine } : {}),
        ...(deleted
          ? { change: "removed" as const, head: undefined, base: cut(baseBlobs.get(a.file), baseById.get(id)) }
          : { head: cut(headBlobs.get(a.file), headById.get(id)) }),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Walkthroughs
// ---------------------------------------------------------------------------

export async function topicWalkthroughSet(
  root: string, slug: string, features: WalkInput[],
  opts: { head?: string; base?: string; whole?: boolean; by?: string; dryRun?: boolean } = {},
) {
  const p = await planWalk(root, slug, opts);
  if ("error" in p) return p;
  const queue = new Set(p.resolved.ids);
  const inSet = new Set([...p.resolved.ids, ...p.resolved.outside.map((o) => o.id)]);
  const input = features.map((f) => ({
    title: f.title, summary: f.summary, ...(f.unstated ? { unstated: true } : {}),
    chapters: (f.chapters ?? []).map((c) => ({ title: c.title, blocks: c.blocks })),
  }));
  const v = validateWalkthrough(input, inSet);
  if (!v.ok) {
    return { error: "the walkthrough does not describe this topic's set", notInSet: v.notInPr, claimedTwice: v.claimedTwice, emptyChapters: v.emptyChapters };
  }
  const cited = new Set(input.flatMap((f) => f.chapters.flatMap((c) => c.blocks.filter((b) => b.kind === "symbol").map((b) => (b as { anchorId: string }).anchorId))));
  const coverage = walkCoverage(input, queue, p.resolved.outside, containmentFor(cited, p.sides, queue));
  // Witnessed at the walk's head, never trunk's tip: signing is pinned to this commit (§3.3).
  const live = await snapshotHashes(root, p.head);
  const built = buildWalkthrough({ pr: 0, head: p.head, by: opts.by || "agent", at: new Date().toISOString(), features: input }, (id) => live.get(id));
  const w: TopicWalkthrough = {
    topic: slug, head: p.head, ...(p.base ? { base: p.base } : {}),
    selector: p.topic.selector, resolved: p.resolved, by: built.by, at: built.at, features: built.features,
  };
  const summary = {
    topic: slug, head: p.head, ...(p.base ? { base: p.base } : {}), ...(p.since ? { since: p.since } : {}),
    features: built.features.length, chapters: built.features.reduce((n, f) => n + f.chapters.length, 0),
    coverage, ...(p.resolved.unresolved.length ? { unresolved: p.resolved.unresolved } : {}),
  };
  if (opts.dryRun) return { ok: true, walk: undefined, ...summary, dryRun: true };
  const e = await write(root, (cfg, actor) => publishTopicWalkthrough(cfg.path, cfg.universe, actor, w));
  if ("error" in e) return e;
  return { ok: true, walk: e.id, ...summary, dryRun: false, note: deliveryNote(root) };
}

/** The sign-off state THIS walkthrough holds for this person — never another walk's (owner, Round 3). */
function walkState(root: string, walkId: string) {
  const me = resolveActor(root)?.principal;
  const rows = me ? readWalkSignoffs(root, { walkId, principal: me }) : [];
  const latest = new Map<string, WalkSignoff>();
  for (const r of rows) latest.set(`${r.targetKind}\0${r.targetId}\0${r.attestation}`, r);
  const out: Record<string, { signed?: boolean; viewed?: boolean; coveredBy?: string; at?: string }> = {};
  const chapters: Record<string, { signed?: boolean; viewed?: boolean }> = {};
  for (const r of latest.values()) {
    const slot = r.targetKind === "chapter" ? (chapters[r.targetId] ??= {}) : (out[r.targetId] ??= {});
    slot[r.attestation] = r.act === "signed";
    if (r.targetKind === "symbol" && r.act === "signed" && r.attestation === "signed") {
      (slot as { coveredBy?: string }).coveredBy = r.coveredBy;
      (slot as { at?: string }).at = r.at;
    }
  }
  return { symbols: out, chapters };
}

export async function topicWalkthroughGet(root: string, slug: string, walkId?: string) {
  const t = await topicOr(root, slug);
  if ("error" in t) return t;
  const walks = await walksOf(root, t.cfg, slug);
  if (!walks.length) return { topic: t.topic, walkthrough: null, walkthroughs: [] };
  const i = walkId ? walks.findIndex((w) => w.id === walkId) : walks.length - 1;
  if (i < 0) return { error: `no walkthrough ${walkId} of topic ${slug}` };
  const pick = walks[i]!;
  const w = pick.walkthrough;

  const trunk = trunkRef(root);
  const moved = trunk ? movedSince(w, await snapshotHashes(root, trunk.sha)) : { chapters: [], symbols: [] };
  // Against every walk up to this one: a delta walk only ever saw the delta, and "never
  // seen" means no walk of the topic so far accounted for it.
  const seen = walks.slice(0, i + 1).flatMap((x) => [...x.walkthrough.resolved.ids, ...x.walkthrough.resolved.outside.map((o) => o.id)]);
  let fresh: string[] | null = null;
  if (trunk && t.topic.status === "active") {
    const now = await resolveAt(root, t.topic.selector, trunk.sha);
    if (!("error" in now)) fresh = newlyMatched(seen, now.resolved.ids);
  }
  return {
    topic: t.topic,
    walk: pick.id,
    author: pick.actor.principal,
    walkthrough: w,
    walkthroughs: walks.map((x) => ({ id: x.id, head: x.walkthrough.head, base: x.walkthrough.base, by: x.walkthrough.by, author: x.actor.principal, at: x.at })),
    trunk: trunk ? { name: trunk.name, sha: trunk.sha } : null,
    /** Chapters and symbols whose code main's tip has changed since this walk witnessed it. */
    moved,
    selectorChanged: selectorChanged(w.selector, t.topic.selector),
    newlyMatched: fresh,
    signoffs: walkState(root, pick.id),
    /** The TOPIC's findings, not this walk's: walk 2 opens with walk 1's, each still open or not. */
    findings: (await readFindings(root, { pr: topicKey(slug) })).findings.map((f) => ({
      id: f.id, target: f.target, comment: f.comment ?? f.text, state: f.state, severity: f.severity,
      author: f.author.principal, createdAt: f.createdAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// Signing — web only, as PR sign-off is
// ---------------------------------------------------------------------------

/**
 * Re-derive this person's per-anchor mark for one symbol from `walk_signoffs`.
 *
 * The standing sign-off is the LATEST WALK whose latest act on the symbol is `signed`, written
 * at that walk's head (and base). So withdrawing in May leaves March's sign-off standing on the
 * map, and signing an older walk after a newer one does not displace the newer one. Known
 * limit: the mark is one row per reviewer, shared with PR sign-off, so a topic withdrawal can
 * clear a mark a PR walkthrough wrote for the same symbol.
 */
async function reprojectMark(root: string, anchorId: string, attestation: Attestation, principal: string, reviewer?: string) {
  const rows = readWalkSignoffs(root, { targetId: anchorId, principal })
    .filter((r) => r.targetKind === "symbol" && r.attestation === attestation);
  const byWalk = new Map<string, WalkSignoff>();
  for (const r of rows) byWalk.set(r.walkId, r);
  // Walk ids are event ids, which sort by time (`mintId`).
  const standing = [...byWalk.values()].filter((r) => r.act === "signed").sort((a, b) => (a.walkId < b.walkId ? 1 : -1))[0];
  if (!standing) {
    await unmarkReviewed(root, { targetKind: "anchor", targetId: anchorId, level: "code", attestation, actor: "human" });
    return { unwitnessed: false };
  }
  const r = await markReviewedBatch(root, [anchorId], {
    level: "code", actor: "human", attestation, reviewer, ref: standing.commit, base: standing.base,
    ...(standing.coveredBy ? { coveredBy: standing.coveredBy } : {}),
  });
  return { unwitnessed: !!r.unwitnessed?.includes(anchorId) };
}

async function signIn(
  root: string, slug: string, walkId: string,
  targets: { ids: string[]; chapter?: string },
  opts: { attestation: Attestation; unmark?: boolean; reviewer?: string },
) {
  const t = await topicOr(root, slug);
  if ("error" in t) return t;
  const walk = (await walksOf(root, t.cfg, slug)).find((w) => w.id === walkId);
  if (!walk) return { error: `no walkthrough ${walkId} of topic ${slug}` };
  const me = resolveActor(root);
  if (!me) return { error: "no identity: a sign-off records who made it. Set `git config user.email`." };
  const w = walk.walkthrough;
  // The cover is bounded by the resolved set: one click must not become a claim over code
  // the reviewer was never shown as part of this review (proposal §3.3).
  const inSet = new Set([...w.resolved.ids, ...w.resolved.outside.map((o) => o.id)]);
  const stray = targets.ids.filter((id) => !inSet.has(id));
  if (stray.length) return { error: `not in this walkthrough's set: ${stray.join(", ")}` };

  const [head, base] = await Promise.all([readSnapshot(root, w.head), w.base ? readSnapshot(root, w.base) : null]);
  if (!head) return { error: `cannot read commit ${w.head.slice(0, 12)} here` };
  const sides = base ? [head, base] : [head];
  const hashAt = new Map(head.map((a) => [a.id, a.bodyHash]));
  const contained = containmentFor(targets.ids, sides, inSet);
  const at = new Date().toISOString();
  const act = opts.unmark ? "withdrawn" as const : "signed" as const;
  const row = (targetKind: "symbol" | "chapter", targetId: string, coveredBy?: string): WalkSignoff => ({
    walkId, topic: slug, targetKind, targetId, attestation: opts.attestation, act,
    ...(targetKind === "symbol" ? { bodyHash: hashAt.get(targetId) ?? ABSENT_HASH } : {}),
    commit: w.head, ...(w.base ? { base: w.base } : {}), actor: me, at, ...(coveredBy ? { coveredBy } : {}),
  });
  const direct = new Set(targets.ids);
  const rows: WalkSignoff[] = [
    ...(targets.chapter ? [row("chapter", targets.chapter)] : []),
    ...targets.ids.map((id) => row("symbol", id)),
    ...[...contained].flatMap(([c, ms]) => ms.filter((m) => !direct.has(m)).map((m) => row("symbol", m, c))),
  ];
  appendWalkSignoffs(root, rows);

  const affected = [...new Set(rows.filter((r) => r.targetKind === "symbol").map((r) => r.targetId))];
  const unwitnessed: string[] = [];
  for (const id of affected) if ((await reprojectMark(root, id, opts.attestation, me.principal, opts.reviewer)).unwitnessed) unwitnessed.push(id);
  const marks: Record<string, unknown> = {};
  for (const id of affected) marks[id] = await anchorMark(root, id, { ref: w.head, base: w.base });
  return { ok: true, walk: walkId, anchors: targets.ids.length, covered: affected.length - targets.ids.length, marks, signoffs: walkState(root, walkId), ...(unwitnessed.length ? { unwitnessed } : {}) };
}

export async function topicStepMark(
  root: string, slug: string, walkId: string, anchorId: string,
  opts: { attestation: Attestation; unmark?: boolean; reviewer?: string },
) {
  return signIn(root, slug, walkId, { ids: [anchorId] }, opts);
}

export async function topicChapterMark(
  root: string, slug: string, walkId: string, chapterId: string,
  opts: { attestation: Attestation; unmark?: boolean; reviewer?: string },
) {
  const t = await topicOr(root, slug);
  if ("error" in t) return t;
  const walk = (await walksOf(root, t.cfg, slug)).find((w) => w.id === walkId);
  if (!walk) return { error: `no walkthrough ${walkId} of topic ${slug}` };
  const chapter = walk.walkthrough.features.flatMap((f) => f.chapters).find((c) => c.id === chapterId);
  if (!chapter) return { error: `no chapter "${chapterId}" in that walkthrough` };
  const ids = chapter.blocks.filter((b) => b.kind === "symbol").map((b) => (b as { anchorId: string }).anchorId);
  if (!ids.length) return { error: "that chapter walks no symbols" };
  return signIn(root, slug, walkId, { ids, chapter: chapterId }, opts);
}

/**
 * Where a finding filed against a topic is witnessed: the named walk's head (and base, for a
 * symbol the walk's range deletes), else the topic's latest walk, else main's tip. Refused for
 * an undefined or retired topic — the door refuses it too, but this says so before witnessing.
 */
export async function topicFindingContext(root: string, slug: string, walkId?: string): Promise<{ head: string; base?: string } | Err> {
  const t = await topicOr(root, slug);
  if ("error" in t) return t;
  if (t.topic.status === "retired") return { error: `topic ${slug} is retired, so it takes no new findings` };
  const walks = await walksOf(root, t.cfg, slug);
  const w = walkId ? walks.find((x) => x.id === walkId) : walks.at(-1);
  if (walkId && !w) return { error: `no walkthrough ${walkId} of topic ${slug}` };
  if (w) return { head: w.walkthrough.head, ...(w.walkthrough.base ? { base: w.walkthrough.base } : {}) };
  const head = defaultHead(root);
  return head ? { head } : { error: "no commit to witness the finding at: this is not a git repository" };
}

/** One symbol's source as a walkthrough walked it: at the walk's head, or at its base for a deletion. */
export async function topicCode(root: string, slug: string, walkId: string, id: string) {
  const t = await topicOr(root, slug);
  if ("error" in t) return t;
  const walk = (await walksOf(root, t.cfg, slug)).find((w) => w.id === walkId);
  if (!walk) return { error: `no walkthrough ${walkId} of topic ${slug}` };
  const w = walk.walkthrough;
  for (const [sha, deleted] of [[w.head, false], [w.base, true]] as const) {
    if (!sha) continue;
    const a = (await readSnapshot(root, sha))?.find((x) => x.id === id);
    if (!a) continue;
    const src = readBlobs(root, sha, [a.file]).get(a.file);
    return {
      id, file: a.file, symbol: a.symbolPath.join(" › "), kind: a.kind, at: sha, deleted, lang: langFor(a.file),
      startLine: a.loc?.startLine ?? 1,
      code: src && a.loc ? src.slice(a.loc.startByte, a.loc.endByte) : null,
    };
  }
  return { error: `${id} is in neither ${w.head.slice(0, 12)} nor its base` };
}
