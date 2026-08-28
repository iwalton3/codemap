import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { type Anchor, type LogicalNode } from "../schema.js";
import { indexFile } from "../repo.js";
import { readAnchorStore, loadNodes, readCoverage, readSnapshot, findAnchorsOutsideWork, readOrphans, derivationLookup, readWalkthroughsFor, type StoredWalkthrough } from "../store.js";
import type { PrWalkthrough } from "../walkthrough.js";
import { requireActor } from "../identity.js";
import { loadIgnore } from "../ignore.js";
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

/**
 * The claims `trust` collapses into one word, said separately.
 *
 * `trustOf` above computes freshness × (accountability ⊔ evidence) over the CITED
 * anchors and returns a single tier, which a reader takes as a verdict on four
 * independent things. The sharpest consequence is that `stale` short-circuits: a doc
 * a person signed and an agent re-checked becomes indistinguishable from one nobody
 * ever read, the moment the code moves. That is a freshness answer erasing two
 * unrelated facts. See `docs/trust-split.md`.
 *
 * Additive: `trustOf` is unchanged and still emitted beside this, so nothing stored
 * changes meaning and no reader breaks.
 *
 * What is deliberately NOT here:
 *
 *   - `viewed` — "I looked at this and want to come back to it". A personal
 *     work-tracking bookmark, not a claim about the doc, so it stays its own field
 *     and is not an input to either axis.
 *   - a count of corroborating READS, which is what `profiles` is deliberately not.
 *     Reads are a heat signature: more reads means more references means the cited
 *     code is MORE likely to be churning, so counting acts would point the wrong way.
 *     `Mark.profiles` counts distinct ERROR PROFILES instead (see `errorProfile`),
 *     which is the quantity that says whether two looks could have failed
 *     differently. It was withheld until review rows were keyed on the reviewer,
 *     because before that exactly one mark existed per level and the number was
 *     structurally pinned at 1 — the vacuous shape `independent` demonstrated.
 *   - `coverage` beyond `"unknown"`. It is only ever `"derived"` when a recorded
 *     derivation re-runs clean (COD-17); an author-set value is a self-report of
 *     exhaustiveness by the party whose exhaustiveness is in doubt.
 */
export type Mark = {
  at?: string;
  level: "logical" | "code";
  /**
   * Distinct ERROR PROFILES that have vouched at this level, not a count of reads.
   * `>= 2` is the interesting reading: two looks that could have failed differently.
   * See `errorProfile`. Absent when the level was never marked.
   */
  profiles?: number;
  /**
   * The witnessed body still matches. FALSE does not mean the mark is gone — it
   * means the act happened and the code has since moved, which is the whole point:
   * "a person signed this, about a body that has changed" is two facts, and the
   * single `trust` word could only carry the second.
   */
  current: boolean;
};

export type Vouch = {
  /** Nothing has drifted: the node is not stale AND no mark's witness moved. */
  fresh: boolean;
  /** A person signed it. Never inferred, and no agent act produces it. */
  accountable: Mark | null;
  /** An agent read the code and the claims held. */
  evidence: Mark | null;
  /** Whether the cited set is known to BE the subject. See COD-17. */
  coverage: "derived" | "unknown";
};

type OneMark = { actor: "human" | "agent"; state: string; at?: string };
type ReviewFull = {
  state: string; actor?: "human" | "agent"; at?: string; profiles?: number;
  /** Every vouch at this level. See `ReviewInfo.marks`. */
  marks?: OneMark[];
};

/** A mark EXISTS in both states: `reviewed` is current, `stale` is one whose body moved. */
const isMark = (state: string) => state === "reviewed" || state === "stale";

/**
 * Every vouch across both levels, as (level, mark) pairs.
 *
 * Reads `marks` and falls back to the collapsed row for a caller that does not supply
 * it (`deriveCodeReview`'s rollup has no rows behind it). Reading ONLY the collapsed
 * row was the defect: the collapse keeps one mark per level, so a person's sign-off
 * beside an agent's check reported `evidence: null` — hiding exactly the coexistence
 * that keying rows on the reviewer exists to allow.
 */
const allMarks = (review?: { logical: ReviewFull; code: ReviewFull }) => {
  const out: { level: "logical" | "code"; m: OneMark; profiles?: number }[] = [];
  for (const level of ["logical", "code"] as const) {
    const r = review?.[level];
    if (!r) continue;
    // `?? "agent"`, matching every other default in `reviews.ts`: a row that cannot
    // show a person stood behind it must not be read as accountability.
    const rows = r.marks ?? (isMark(r.state) ? [{ actor: r.actor ?? "agent", state: r.state, at: r.at }] : []);
    for (const m of rows) if (isMark(m.state)) out.push({ level, m, profiles: r.profiles });
  }
  return out;
};

export function vouchOf(
  status: string | undefined,
  review?: { logical: ReviewFull; code: ReviewFull },
): Vouch {
  const statusFresh = !(status === "stale" || status === "dangling" || status === "removed");
  const marks = allMarks(review);
  // ANY mark whose witness moved makes this not fresh — not just the one the collapse
  // chose. A current human sign-off beside a stale agent check used to read `fresh`.
  const markStale = marks.some((x) => x.m.state === "stale");
  const pick = (want: "human" | "agent"): Mark | null => {
    // Current before stale, so a reviewer who re-confirmed is not reported as stale
    // because of an older mark of the same kind at the other level.
    const hits = marks.filter((x) => x.m.actor === want);
    const best = hits.find((x) => x.m.state === "reviewed") ?? hits[0];
    return best
      ? { at: best.m.at, level: best.level, current: best.m.state === "reviewed", profiles: best.profiles }
      : null;
  };
  return {
    fresh: statusFresh && !markStale,
    accountable: pick("human"),
    evidence: pick("agent"),
    coverage: "unknown",
  };
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
  // `.codemapignore` as well as the stored rules: the `[tests]` bin is a repo-wide,
  // COMMITTED declaration and a `cover` rule is one machine's uncommitted state, so this
  // is the only half that reaches a teammate's fresh clone.
  const [store, nodes, cov, ignore] = await Promise.all([
    readAnchorStore(root), loadNodes(root), readCoverage(root), loadIgnore(root),
  ]);
  const blocked = verdict?.excludeFromDecisions;
  const deciding = blocked?.size ? nodes.filter((n) => !n.origin || !blocked.has(n.origin)) : nodes;
  const cited = new Set(deciding.flatMap((n) => n.anchors));
  const result = resolveCoverage(store.anchors, cited, cov.rules, (f) => ignore.isTest(f, false));
  return { store, nodes, deciding, result, verdict };
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
  /**
   * Every reading, chosen first, with bodies — what a caller asking to see a
   * teammate's INSTEAD of the chosen one needs. `others` is the summary of the same
   * list; this is the list. Already in memory from the one table read, so carrying it
   * costs nothing and saves the caller a second one that could disagree.
   */
  all: (StoredWalkthrough & { mine: boolean })[];
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
    all: sorted.map((r) => ({ ...r, mine: isMine(r) })),
  };
}
