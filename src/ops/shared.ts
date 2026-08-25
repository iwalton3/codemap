import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { type Anchor, type LogicalNode } from "../schema.js";
import { indexFile } from "../repo.js";
import { readAnchorStore, loadNodes, readCoverage, readSnapshot, findAnchorsOutsideWork, readOrphans, derivationLookup, readWalkthroughsFor } from "../store.js";
import type { PrWalkthrough } from "../walkthrough.js";
import { requireActor } from "../identity.js";
import { resolveSidecar, scopeFor, sidecarIdentity } from "../sidecar-config.js";
import { ensureMaterialized } from "../materialize.js";
import { foldWalkthroughs, walkthroughScope } from "../shared-walkthrough.js";
import { walkthroughsProjection } from "../shared-projections.js";
import { resolveCoverage, type CoverageResult } from "../coverage.js";
import { resolveAnchorRefs } from "../refs.js";
import { grammarForPath, currentDerivations } from "../grammars.js";
import { anchorIndex, legacyIndex, derivationsOf, type AnchorIndex } from "../anchor-resolve.js";

const HL_LANG: Record<string, string> = { c_sharp: "csharp", python: "python", javascript: "javascript", typescript: "typescript", tsx: "typescript" };
export const langFor = (file: string) => HL_LANG[grammarForPath(file) ?? ""] ?? "plaintext";

export function genId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

/** Re-index the given files and return current anchors by id (source of truth for "now"). */
/**
 * The hash index behind a `liveAnchors` map.
 *
 * `currentDerivations()`, not the tags on the anchors in the map: those were minted
 * in process by THIS build, so this build's tags are what an id must have been
 * minted under to appear here — and reading them off the map instead would call a
 * genuinely deleted file's symbols undecidable, because an empty map has no tags to
 * read. See docs/anchor-id-provenance.md §6.
 */
export function liveIndex(root: string, live: Map<string, Anchor>): AnchorIndex {
  return anchorIndex(
    new Map([...live].map(([id, a]) => [id, a.bodyHash])),
    currentDerivations(),
    derivationLookup(root),
  );
}

export async function liveAnchors(root: string, files: Iterable<string>): Promise<Map<string, Anchor>> {
  const map = new Map<string, Anchor>();
  for (const f of new Set(files)) {
    try {
      for (const a of await indexFile(join(root, f), f)) map.set(a.id, a);
    } catch {
      /* unreadable / unparseable — treat as no anchors */
    }
  }
  return map;
}

export function anchorBrief(a: Anchor) {
  return {
    id: a.id,
    file: a.file,
    symbol: a.symbolPath.join(" › "),
    kind: a.kind,
    lines: a.loc ? `${a.loc.startLine}-${a.loc.endLine}` : undefined,
  };
}

type ReviewLite = { state: string; actor?: "human" | "agent" };
export type Trust = "verified" | "checked" | "unverified" | "stale" | "generated";

/**
 * The trust ladder a codemap-aware agent should key on, from freshness (does the
 * cited code still match) × who confirmed the claim. Three tiers:
 *   verified   — fresh AND a HUMAN reviewed it → rely on it.
 *   checked    — fresh AND an AGENT read the code and confirmed the claims hold
 *                (a corroborating read, not a human blessing) → solid; spot-check
 *                if critical.
 *   unverified — fresh but nobody has confirmed it (just authored) → a hypothesis;
 *                use, but verify against live code before depending on it.
 *   stale      — code drifted or was removed → re-derive, then confirm/refork.
 *   generated  — analyzer-emitted graph; structural, not a prose claim.
 * (fresh ≠ correct: freshness only proves the code hasn't changed, not that the
 * doc read it right — hence the review dimension.)
 */
export function trustOf(status: string | undefined, review?: { logical: ReviewLite; code: ReviewLite }): Trust {
  if (status === "generated") return "generated";
  if (status === "stale" || status === "dangling" || status === "removed") return "stale";
  // `unverifiable` is deliberately NOT here: it is not a claim that anything drifted.
  if (!review) return "unverified";
  const { logical: L, code: C } = review;
  if (L.state === "stale" || C.state === "stale") return "stale";
  const humanOK = (L.state === "reviewed" && L.actor === "human") || (C.state === "reviewed" && C.actor === "human");
  if (humanOK) return "verified";
  if (L.state === "reviewed" || C.state === "reviewed") return "checked"; // agent-confirmed
  return "unverified";
}

/** Effective coverage state per anchor, from citation + stored rules. */
/**
 * Nodes, with the shared docs folded in first.
 *
 * `docsVerdict` is what materializes the docs scope, so a surface that calls
 * `loadNodes` straight reads whatever the last fold happened to leave — which on a
 * fresh store or after somebody else's sync means no teammate docs at all. Every
 * ops-layer read of nodes goes through here for that reason.
 *
 * DISPLAY semantics: nothing is excluded. A caller that must not be decided for by a
 * blocked scope wants `coverageFor`, which does the deciding split.
 */
export async function loadNodesShared(root: string): Promise<LogicalNode[]> {
  await import("../docs-lookup.js").then((m) => m.docsVerdict(root)).catch(() => null);
  return loadNodes(root);
}

/**
 * Coverage, with the show/decide split made in ONE place.
 *
 * `nodes` is everything, for DISPLAY. `result` is computed from the deciding subset
 * only — a blocked scope's rows are shown and do not get to say there is no work
 * here. Doing the filtering at the call site cannot work: coverage state is computed
 * here, so a blocked citation has already made its anchor `cited` by the time a
 * caller sees it, and no later filter can turn that back into a gap.
 *
 * It also FOLDS. `docsVerdict` is what materializes the docs scope, so a surface that
 * never asked simply did not see a teammate's docs at all — which is most of them.
 * Doing it here means every coverage consumer gets the team's half without each one
 * remembering to.
 */
export async function coverageFor(root: string): Promise<{
  store: Awaited<ReturnType<typeof readAnchorStore>>;
  nodes: LogicalNode[];
  deciding: LogicalNode[];
  result: CoverageResult;
  verdict: { status: string; scope?: string; excludeFromDecisions: ReadonlySet<string> } | null;
}> {
  const verdict = await import("../docs-lookup.js").then((m) => m.docsVerdict(root)).catch(() => null);
  const [store, nodes, cov] = await Promise.all([readAnchorStore(root), loadNodes(root), readCoverage(root)]);
  const blocked = verdict?.excludeFromDecisions;
  const deciding = blocked?.size ? nodes.filter((n) => !n.origin || !blocked.has(n.origin)) : nodes;
  const cited = new Set(deciding.flatMap((n) => n.anchors));
  return { store, nodes, deciding, result: resolveCoverage(store.anchors, cited, cov.rules), verdict };
}

/** Anchor→hash map for a cached commit — the hash source when documenting a branch. */
export async function snapshotHashes(root: string, ref: string): Promise<AnchorIndex> {
  const snap = await readSnapshot(root, ref);
  // No cached snapshot: nothing is on record about which build would have minted
  // these ids, so every absence falls back to today's answer rather than to
  // "cannot tell" — the same legacy rule the rest of this design uses.
  if (!snap) return legacyIndex(new Map());
  // The SNAPSHOT's own rows: a cached commit was minted by whatever build cached it,
  // and that is the index an id had to come from to appear here.
  return anchorIndex(
    new Map(snap.map((a) => [a.id, a.bodyHash])),
    derivationsOf(snap),
    derivationLookup(root),
  );
}

/**
 * Resolve human-friendly anchor refs (file#Symbol, file#Symbol(*), file:line, or
 * raw id) → ids, keeping the failures alongside what resolved.
 *
 * Write ops PARTIALLY ACCEPT: a doc is saved with the anchors that resolved and
 * the rejects come back as `rejectedAnchors`, because the alternative — the whole
 * call discarded over one ambiguous overload — cost the caller a re-send of the
 * entire body. The "no floating claims" invariant is unchanged: a node still can
 * not exist with zero anchors, so a call where NOTHING resolves is still an error.
 */
export async function resolveRefs(
  root: string, refs: string[], scopeRef?: string,
  opts: { includeOrphans?: boolean } = {},
): Promise<{ ids: string[]; errors: string[] }> {
  const store = await readAnchorStore(root);
  let anchors = store.anchors;
  if (opts.includeOrphans) {
    // Code the working tree does not have, that somebody's work still points at.
    // Resolvable so a filed finding can still be read and revised — one that cannot
    // even be addressed is indistinguishable from one that was deleted.
    //
    // Two sources, and both are needed. `@orphan` is code gone from everywhere; a
    // commit SNAPSHOT holds code that exists on a branch, which during a PR review
    // is most of what is worth annotating — the files the branch ADDS are not in the
    // working tree at all, so requiring the caller to name the ref made the common
    // case the one that failed.
    const byId = new Map(anchors.map((a) => [a.id, a]));
    const missing = refs.filter((r) => /^a_[0-9a-f]+$/.test(r) && !byId.has(r));
    if (missing.length) {
      for (const [id, hit] of findAnchorsOutsideWork(root, missing)) if (!byId.has(id)) byId.set(id, hit.anchor);
      for (const [id, a] of readOrphans(root, missing)) if (!byId.has(id)) byId.set(id, a);
      anchors = [...byId.values()];
    }
  }
  if (scopeRef) {
    // A symbol that exists only on a PR's head is not a floating claim — it is in
    // this store, under that commit's ref. Union those anchors in so a finding can
    // be raised on code that has not merged yet. The invariant holds: the citation
    // still has to resolve against anchors the store actually holds, and an id that
    // is in neither @work nor `scopeRef` is still rejected.
    const snap = await readSnapshot(root, scopeRef);
    if (snap) {
      const byId = new Map(anchors.map((a) => [a.id, a]));
      for (const a of snap) if (!byId.has(a.id)) byId.set(a.id, a);
      anchors = [...byId.values()];
    }
  }
  return resolveAnchorRefs(anchors, refs);
}

/** `rejectedAnchors: […]` for a result, or nothing when every ref resolved. */
export const rejected = (errors: string[]) => (errors.length ? { rejectedAnchors: errors } : {});


// ---------------------------------------------------------------------------
// Walkthroughs: yours and the team's, as one answer
// ---------------------------------------------------------------------------

export interface WalkthroughPick {
  walkthrough: PrWalkthrough;
  /**
   * The teammate whose reading this is, by principal — absent when it is your own.
   *
   * NOT `by`: a walkthrough already carries one, the free-text author `pr_walkthrough`
   * was called with ("ben's agent"). Two meanings on one field is how a surface ends up
   * reporting your own walkthrough as somebody else's.
   */
  sharedBy?: string;
  /** The readings this is NOT showing. Named, because the fold keeps one per author. */
  others: { by: string; head: string; mine: boolean }[];
}

/**
 * The walkthrough to show for a pull request, out of everyone's.
 *
 * One table read. A page renders ONE structure, so something has to choose between the
 * readings a pull request has — and the choice being nowhere was the defect: a
 * teammate's walkthrough folded into the reader's own store and every surface that
 * renders one looked in the other place. Now they are rows in `walkthroughs` and this is
 * only the choosing.
 *
 * The order, and the head rule is FIRST on purpose:
 *
 *   1. a reading written against this head — yours before a teammate's
 *   2. failing that, yours, stale and flagged as it always was
 *   3. failing that, the newest teammate's
 *
 * Head first because a walkthrough about another commit is not a worse reading, it is
 * about something else — the rule `currentWalkthrough` already enforces — so a
 * teammate's fresh one beats your stale one. Yours wins every tie, so nothing you wrote
 * is ever displaced by somebody else's at equal standing.
 *
 * Never picks silently: whatever is not shown comes back in `others`.
 */
export async function walkthroughFor(
  root: string, pr: number | string, head: string,
): Promise<WalkthroughPick | null> {
  // Ensure, then QUERY the canonical table — the shape `sharedFindings` uses, and the
  // reason it is two steps rather than one: `ensureMaterialized` is `readCached` without
  // deserializing a value nobody wants, because the rows themselves are the answer now.
  // It is a fingerprint check on a cache hit, not a fold; the log stays pull/push.
  const cfg = resolveSidecar(root);
  if (cfg) {
    await ensureMaterialized(root, cfg.path, walkthroughScope(scopeFor(cfg, "pr", String(pr))),
      sidecarIdentity(cfg), foldWalkthroughs, walkthroughsProjection).catch(() => null);
  }
  const rows = await readWalkthroughsFor(root, pr);
  if (!rows.length) return null;

  // MINE is by principal, never by `origin`. Publishing your own walkthrough makes the
  // fold adopt your row, so an origin marks "came via the log" and would report your own
  // reading back to you as a stranger's. An unattributed row (`author === ""`, migrated
  // from the legacy blob) has no principal to match, and is yours by the only other
  // thing that can say so: nothing published it.
  const actor = requireActor(root);
  const me = "error" in actor ? null : actor.principal;
  const isMine = (r: typeof rows[number]) => (r.author ? r.author === me : !r.origin);

  const rank = (r: typeof rows[number]) =>
    (r.walkthrough.head === head ? 0 : 2) + (isMine(r) ? 0 : 1);
  // Newest FIRST among equals — the winner is `sorted[0]` — so a re-walk supersedes
  // rather than losing the tiebreak to the reading it was written to replace.
  const sorted = [...rows].sort((a, b) => rank(a) - rank(b) || b.at.localeCompare(a.at));
  const [best, ...rest] = sorted;
  return {
    walkthrough: best!.walkthrough,
    ...(isMine(best!) ? {} : { sharedBy: best!.author }),
    others: rest.map((r) => ({ by: r.author || "(unattributed)", head: r.walkthrough.head, mine: isMine(r) })),
  };
}
