/**
 * Pull requests as first-class review targets.
 *
 * A PR is a *logical* change with a base that nobody has checked out. Two things
 * make it reviewable here: `indexCommit` can snapshot the merge-base and head
 * without touching the working tree, and lanes + triage rank what comes out, so
 * a 27k-line diff becomes an ordered worklist instead of a wall.
 *
 * GitHub access is the `gh` CLI (already required by this project) over
 * `child_process` — no API client dependency.
 */

import { spawnSync } from "node:child_process";
import type { Anchor } from "./schema.js";
import { computeDiff, lineDiff, stripCR, type DiffResult, type DiffLine } from "./diff.js";
import { indexBlob, indexCommit } from "./repo.js";
import { readSnapshot, writeSnapshot, readAnnotations, readAnchorStore } from "./store.js";
import { loadLanes, LANE_POLICY, type Lane } from "./lanes.js";
import { complexityOf, MONEY_RX, reviewTriageFor, setTriageBatch } from "./triage.js";
import { readTriage } from "./store.js";
import type { Importance } from "./schema.js";
import type { Complexity } from "./schema.js";
import { revParse, mergeBase, hasObject, fetchRef, numstat, readBlobs, isGitRepo, originSlug, prBaseCommit } from "./git.js";
import { splitSpec, buildStory, layerOf, spineRole, type PrStory, type StoryStep, type StoryChapter } from "./pr-story.js";
import { planPromotion, type Promotion } from "./pr-promote.js";

export interface PrRef { owner: string; repo: string; number: number }

/** Accepts a PR URL, `owner/repo#123`, or a bare `123` (with a default repo). */
export function parsePrRef(input: string, fallback?: { owner: string; repo: string }): PrRef | null {
  const url = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(input);
  if (url) return { owner: url[1]!, repo: url[2]!, number: Number(url[3]) };
  const short = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(input.trim());
  if (short) return { owner: short[1]!, repo: short[2]!, number: Number(short[3]) };
  const bare = /^#?(\d+)$/.exec(input.trim());
  if (bare && fallback) return { ...fallback, number: Number(bare[1]) };
  return null;
}

function gh(args: string[], cwd?: string): { ok: boolean; out: string; err: string } {
  const r = spawnSync("gh", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  return { ok: r.status === 0, out: r.stdout ?? "", err: (r.stderr ?? "").trim() };
}

export function ghAvailable(): boolean {
  return spawnSync("gh", ["--version"], { encoding: "utf8" }).status === 0;
}

export interface PrMeta {
  number: number; url: string; title: string; author: string;
  baseRef: string; headRef: string; baseSha: string; headSha: string;
  draft: boolean; state: string; createdAt: string; updatedAt: string;
  additions: number; deletions: number; changedFiles: number; commits: number;
}

const PR_FIELDS = "number,url,title,author,baseRefName,headRefName,baseRefOid,headRefOid,isDraft,state,createdAt,updatedAt,additions,deletions,changedFiles,commits";
/**
 * Same minus `commits`. That field is a GraphQL *connection*, and asking for it
 * across a page of PRs multiplies out past GitHub's 500k-node ceiling — a repo
 * with a long history fails the whole query with a limit error rather than
 * returning fewer rows. The list never displays commit counts anyway.
 */
const PR_LIST_FIELDS = "number,url,title,author,baseRefName,headRefName,baseRefOid,headRefOid,isDraft,state,createdAt,updatedAt,additions,deletions,changedFiles";

export function fetchPrMeta(ref: PrRef): PrMeta | { error: string } {
  const r = gh(["pr", "view", String(ref.number), "--repo", `${ref.owner}/${ref.repo}`, "--json", PR_FIELDS]);
  if (!r.ok) return { error: `gh pr view failed: ${r.err || "unknown error"}` };
  try {
    const j = JSON.parse(r.out);
    return {
      number: j.number, url: j.url, title: j.title, author: j.author?.login ?? "?",
      baseRef: j.baseRefName, headRef: j.headRefName, baseSha: j.baseRefOid, headSha: j.headRefOid,
      draft: !!j.isDraft, state: j.state, createdAt: j.createdAt, updatedAt: j.updatedAt,
      additions: j.additions, deletions: j.deletions, changedFiles: j.changedFiles,
      commits: Array.isArray(j.commits) ? j.commits.length : 0,
    };
  } catch (e) { return { error: `could not parse gh output: ${(e as Error).message}` }; }
}

/** Open PRs for a repo, newest first — the "what's on my plate" list. */
export function listOpenPrs(repoSlug: string): { prs: PrMeta[] } | { error: string } {
  const r = gh(["pr", "list", "--repo", repoSlug, "--state", "open", "--limit", "50", "--json", PR_LIST_FIELDS]);
  if (!r.ok) return { error: `gh pr list failed: ${r.err || "unknown error"}` };
  try {
    const prs = JSON.parse(r.out).map((j: any) => ({
      number: j.number, url: j.url, title: j.title, author: j.author?.login ?? "?",
      baseRef: j.baseRefName, headRef: j.headRefName, baseSha: j.baseRefOid, headSha: j.headRefOid,
      draft: !!j.isDraft, state: j.state, createdAt: j.createdAt, updatedAt: j.updatedAt,
      additions: j.additions ?? 0, deletions: j.deletions ?? 0, changedFiles: j.changedFiles ?? 0,
      commits: 0, // not queried for lists — see PR_LIST_FIELDS
    }));
    return { prs };
  } catch (e) { return { error: `could not parse gh output: ${(e as Error).message}` }; }
}

/** Make sure both sides of the PR exist locally, fetching only what's missing. */
export function ensurePrObjects(root: string, meta: PrMeta, remote = "origin"): { ok: boolean; fetched: string[]; error?: string } {
  const fetched: string[] = [];
  if (!hasObject(root, meta.headSha)) {
    const r = fetchRef(root, remote, `pull/${meta.number}/head`);
    if (!r.ok) return { ok: false, fetched, error: `fetch pull/${meta.number}/head failed: ${r.err}` };
    fetched.push(`pull/${meta.number}/head`);
  }
  // The base *branch*, not just its recorded tip — the merge-base is computed against it.
  const r = fetchRef(root, remote, `${meta.baseRef}:refs/remotes/${remote}/${meta.baseRef}`);
  if (r.ok) fetched.push(meta.baseRef);
  if (!hasObject(root, meta.headSha)) return { ok: false, fetched, error: "PR head still missing after fetch" };
  return { ok: true, fetched };
}

export interface LaneTally { lane: Lane; files: number; lines: number; review: string; why: string }
export interface PrFile { path: string; lane: Lane; adds: number; dels: number }

export interface WorkItem {
  id: string; file: string; symbol: string; kind: string;
  change: "added" | "changed" | "removed";
  lane: Lane;
  complexity: Complexity;
  /** Name-shaped money signal — a hint for the triage pass, never a verdict. */
  moneyHint: boolean;
  /**
   * First source line of the symbol. Overloads share a symbolPath and are told
   * apart only by an *ordinal* disambiguator, which is hashed into the anchor id
   * and so can never be made descriptive — an event-sourced aggregate's dozen
   * `Apply` methods are otherwise indistinguishable in a worklist.
   */
  signature: string;
  severity: string;
  reviewed: boolean;
  viewed: boolean;
  review?: unknown;
  viewedMark?: unknown;
  rank: number;
}

export interface PrTriageResult {
  pr: PrMeta & { owner: string; repo: string };
  refs: { base: string; head: string; mergeBase: string; baseAheadOfMergeBase: number | null };
  lanes: LaneTally[];
  files: PrFile[];
  worklist: WorkItem[];
  diff: DiffResult;
  totals: { changedLines: number; queueLines: number; anchors: number };
}

const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, untriaged: 2.5, complete: 9 };
const CX_RANK: Record<Complexity, number> = { deep: 0, standard: 1, rote: 2, wiring: 3 };

export async function prTriage(
  root: string,
  input: string,
  opts: { fetch?: boolean; fallbackRepo?: { owner: string; repo: string } } = {},
): Promise<PrTriageResult | { error: string }> {
  if (!isGitRepo(root)) return { error: "not a git repository" };
  if (!ghAvailable()) return { error: "the `gh` CLI is required for PR triage (not on PATH)" };

  const ref = parsePrRef(input, opts.fallbackRepo ?? originSlug(root) ?? undefined);
  if (!ref) return { error: `could not read a PR reference from "${input}"` };
  const meta = fetchPrMeta(ref);
  if ("error" in meta) return meta;

  if (opts.fetch !== false) {
    const f = ensurePrObjects(root, meta);
    if (!f.ok) return { error: f.error ?? "could not fetch PR refs" };
  }
  if (!hasObject(root, meta.headSha)) return { error: `PR head ${meta.headSha.slice(0, 12)} is not in this repo — is ${ref.owner}/${ref.repo} the right universe?` };

  // The PR's true base: the merge-base of head and the base branch, NOT the branch
  // tip. For a long-lived branch these differ by hundreds of commits, and using
  // the tip reports every one of them as part of the PR.
  //
  // The base side must be GitHub's recorded `baseRefOid`, not the branch's current
  // tip. Once a PR is MERGED its head is an ancestor of that tip, so the merge-base
  // collapses to the head itself and the diff comes out empty — every merged PR
  // would read as changing nothing. Checked against open, closed and merged PRs:
  // the recorded base sha reproduces GitHub's own file count in all three.
  const baseTip = revParse(root, `origin/${meta.baseRef}`) ?? meta.baseSha;
  const mb = prBaseCommit(root, { recordedBase: meta.baseSha, baseRef: meta.baseRef, headSha: meta.headSha });
  if (!mb) return { error: `no merge-base between ${meta.baseRef} and the PR head` };
  const drift = countCommits(root, mb, baseTip);

  for (const [sha, label] of [[mb, `merge-base(${meta.baseRef})`], [meta.headSha, meta.headRef]] as const) {
    const s = await ensureSnapshot(root, sha, label);
    if (s.error) return { error: `snapshot ${sha.slice(0, 12)}: ${s.error}` };
  }

  const diff = await computeDiff(root, mb, meta.headSha);
  if ("error" in diff) return { error: diff.error };

  const lanes = await loadLanes(root);
  const stats = numstat(root, mb, meta.headSha) ?? [];
  const files: PrFile[] = stats.map((f) => ({ path: f.path, lane: lanes.classify(f.path), adds: f.adds, dels: f.dels }));

  const tally = new Map<Lane, LaneTally>();
  for (const f of files) {
    const t = tally.get(f.lane) ?? { lane: f.lane, files: 0, lines: 0, review: LANE_POLICY[f.lane].review, why: LANE_POLICY[f.lane].why };
    t.files++; t.lines += f.adds + f.dels;
    tally.set(f.lane, t);
  }

  const worklist = await buildWorklist(root, meta.headSha, diff, lanes.classify);
  const changedLines = files.reduce((n, f) => n + f.adds + f.dels, 0);
  const queueLines = files.filter((f) => LANE_POLICY[f.lane].review === "queue").reduce((n, f) => n + f.adds + f.dels, 0);

  return {
    pr: { ...meta, owner: ref.owner, repo: ref.repo },
    refs: { base: baseTip, head: meta.headSha, mergeBase: mb, baseAheadOfMergeBase: drift },
    lanes: [...tally.values()].sort((a, b) => b.lines - a.lines),
    files,
    worklist,
    diff,
    totals: { changedLines, queueLines, anchors: worklist.length },
  };
}

/** Cache a commit's anchors if not already cached. Snapshots are immutable, so a hit is final. */
async function ensureSnapshot(root: string, sha: string, label: string): Promise<{ error?: string }> {
  if (await readSnapshot(root, sha)) return {};
  const anchors = await indexCommit(root, sha);
  if (!anchors) return { error: "could not read that commit's tree" };
  await writeSnapshot(root, sha, label, anchors, new Date().toISOString());
  return {};
}

/**
 * Commits in `from..to`, or null when git could not answer (missing object, an
 * unfetched remote-tracking ref). Not 0: every surface suppresses the drift notice
 * at 0, so folding the failure in there rendered "the base branch has not moved"
 * precisely when the base was least known.
 */
function countCommits(root: string, from: string, to: string): number | null {
  const r = spawnSync("git", ["rev-list", "--count", `${from}..${to}`], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) return null;
  const n = Number((r.stdout ?? "").trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Rank the changed symbols. Complexity comes from the head source itself, so the
 * ordering is useful even in a universe with no documented nodes yet (the React
 * map is empty today); stakes and review state layer on wherever the map has them.
 */
async function buildWorklist(
  root: string, headSha: string, diff: DiffResult, classify: (p: string) => Lane,
): Promise<WorkItem[]> {
  const entries = [
    ...diff.changed.map((b) => ({ b, change: "changed" as const })),
    ...diff.added.map((b) => ({ b, change: "added" as const })),
    ...diff.removed.map((b) => ({ b, change: "removed" as const })),
  ];
  if (!entries.length) return [];

  // Source for complexity: read each touched file's head blob once, re-index it,
  // and slice each anchor's own body out of it.
  const headAnchors = new Map<string, Anchor>();
  const wanted = [...new Set(entries.filter((e) => e.change !== "removed").map((e) => e.b.file))];
  const blobs = readBlobs(root, headSha, wanted);
  const bodies = new Map<string, string>();
  for (const [path, src] of blobs) {
    for (const a of await indexBlob(src, path)) {
      headAnchors.set(a.id, a);
      if (a.loc) bodies.set(a.id, src.slice(a.loc.startByte, a.loc.endByte));
    }
  }

  let rt: Awaited<ReturnType<typeof reviewTriageFor>> = new Map();
  try {
    rt = await reviewTriageFor(root, entries.map((e) => ({ kind: "anchor" as const, id: e.b.id })), { ref: headSha });
  } catch { /* no live index — fall back to untriaged/unreviewed */ }

  const items: WorkItem[] = entries.map(({ b, change }) => {
    const e = rt.get(`anchor:${b.id}`);
    const body = bodies.get(b.id) ?? "";
    const complexity = complexityOf(body);
    const lane = classify(b.file);
    const sig = body.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*")) ?? "";
    return {
      id: b.id, file: b.file, symbol: b.symbol, kind: b.kind, change, lane, complexity,
      signature: sig.length > 120 ? sig.slice(0, 119) + "…" : sig,
      moneyHint: MONEY_RX.test(`${b.file} ${b.symbol}`),
      severity: e?.triage.severity ?? "untriaged",
      reviewed: e?.review.code.state === "reviewed",
      viewed: e?.viewed.code.state === "reviewed",
      // The full marks, not just booleans: a replayed or revert-sitting approval
      // must look different on the walkthrough than one signed here.
      review: e?.review.code,
      viewedMark: e?.viewed.code,
      rank: 0,
    };
  });

  const laneRank = (l: Lane) => (LANE_POLICY[l].review === "queue" ? 0 : LANE_POLICY[l].review === "glance" ? 1 : 2);
  items.sort((x, y) =>
    Number(x.reviewed) - Number(y.reviewed) ||
    laneRank(x.lane) - laneRank(y.lane) ||
    (SEV_RANK[x.severity] ?? 5) - (SEV_RANK[y.severity] ?? 5) ||
    Number(y.moneyHint) - Number(x.moneyHint) ||
    (CX_RANK[x.complexity] ?? 1) - (CX_RANK[y.complexity] ?? 1) ||
    x.file.localeCompare(y.file));
  items.forEach((it, i) => { it.rank = i + 1; });
  return items;
}

export interface PacketItem {
  rank: number; id: string; file: string; symbol: string; signature: string;
  /** Absolute line span at the PR head — without it an agent cannot pin a finding to a real file line. */
  startLine?: number; endLine?: number;
  change: "added" | "changed" | "removed";
  lane: Lane; complexity: Complexity; severity: string; moneyHint: boolean;
  /** Source at the PR head. Absent for a removed symbol. */
  head?: string;
  /** Source at the merge-base — present only for a changed symbol, so the agent can compare. */
  base?: string;
}

export interface PrPacket {
  pr: { number: number; title: string; url: string; author: string; headRef: string; baseRef: string };
  refs: { mergeBase: string; head: string };
  /** Spec/doc files the PR itself changed — the author's own account of the change. */
  specs: { path: string; text: string }[];
  counts: { total: number; included: number };
  items: PacketItem[];
}

/**
 * Everything an agent needs to review a PR's symbols without touching the repo:
 * the ranked items with their before/after source, plus the specs the PR ships.
 *
 * Specs come first on purpose — these PRs carry thousands of lines of numbered
 * spec describing the intended behaviour, and a reviewer (human or agent) that
 * reads the code without it is guessing at intent.
 */
export async function prPacket(
  root: string, input: string,
  opts: { limit?: number; offset?: number; lanes?: Lane[]; fetch?: boolean } = {},
): Promise<PrPacket | { error: string }> {
  const t = await prTriage(root, input, { fetch: opts.fetch });
  if ("error" in t) return t;

  const want = new Set<Lane>(opts.lanes ?? ["code"]);
  const selected = t.worklist.filter((w) => want.has(w.lane));
  const offset = opts.offset ?? 0;
  const slice = selected.slice(offset, offset + (opts.limit ?? 40));

  const headByFile = readBlobs(root, t.refs.head, [...new Set(slice.filter((w) => w.change !== "removed").map((w) => w.file))]);
  const baseByFile = readBlobs(root, t.refs.mergeBase, [...new Set(slice.filter((w) => w.change !== "added").map((w) => w.file))]);
  const cut = async (src: string | undefined, path: string, id: string) => {
    if (!src) return undefined;
    const a = (await indexBlob(src, path)).find((x) => x.id === id);
    return a?.loc ? src.slice(a.loc.startByte, a.loc.endByte) : undefined;
  };
  const span = await anchorSpans(root, t.refs.head, slice.filter((w) => w.change !== "removed"));

  const items: PacketItem[] = [];
  for (const w of slice) {
    const loc = span.get(w.id);
    items.push({
      rank: w.rank, id: w.id, file: w.file, symbol: w.symbol, signature: w.signature,
      startLine: loc?.startLine, endLine: loc?.endLine,
      change: w.change, lane: w.lane, complexity: w.complexity, severity: w.severity, moneyHint: w.moneyHint,
      head: w.change === "removed" ? undefined : await cut(headByFile.get(w.file), w.file, w.id),
      base: w.change === "added" ? undefined : await cut(baseByFile.get(w.file), w.file, w.id),
    });
  }

  const specPaths = t.files.filter((f) => f.lane === "spec").map((f) => f.path);
  const specBlobs = readBlobs(root, t.refs.head, specPaths);
  const specs = specPaths.map((p) => ({ path: p, text: specBlobs.get(p) ?? "" })).filter((s) => s.text);

  return {
    pr: { number: t.pr.number, title: t.pr.title, url: t.pr.url, author: t.pr.author, headRef: t.pr.headRef, baseRef: t.pr.baseRef },
    refs: { mergeBase: t.refs.mergeBase, head: t.refs.head },
    specs,
    counts: { total: selected.length, included: slice.length },
    items,
  };
}

/**
 * The PR's story: spec-derived chapters bound to the symbols that implement
 * them, ordered along the command → handler → event → aggregate → read-model
 * spine, with everything the spec fails to account for swept in behind.
 */
export async function prStory(
  root: string, input: string, opts: { fetch?: boolean } = {},
): Promise<(PrStory & {
  pr: PrPacket["pr"];
  refs: { mergeBase: string; head: string; baseAheadOfMergeBase: number | null };
  lanes: LaneTally[];
  totals: { steps: number; chapters: number; changedLines: number; queueLines: number };
}) | { error: string }> {
  const t = await prTriage(root, input, { fetch: opts.fetch });
  if ("error" in t) return t;

  const specPaths = t.files.filter((f) => f.lane === "spec").map((f) => f.path);
  const blobs = readBlobs(root, t.refs.head, specPaths);
  const sections = specPaths.flatMap((p) => splitSpec(p, blobs.get(p) ?? ""));

  const anns = (await readAnnotations(root)).annotations.filter((a) => a.target.kind === "anchor" && !a.resolved);
  const byAnchor = new Map<string, unknown[]>();
  for (const a of anns) (byAnchor.get(a.target.id) ?? byAnchor.set(a.target.id, []).get(a.target.id)!).push(a);

  const steps: StoryStep[] = t.worklist
    .filter((w) => w.lane === "code")
    .map((w) => ({
      anchorId: w.id, file: w.file, symbol: w.symbol, signature: w.signature,
      change: w.change, complexity: w.complexity, severity: w.severity, lane: w.lane,
      layer: layerOf(w.file, w.symbol),
      reviewed: w.reviewed, viewed: w.viewed,
      review: w.review, viewedMark: w.viewedMark,
      annotations: byAnchor.get(w.id) ?? [],
    }));

  // Symbol names this universe knows about at all — live plus the PR head — so a
  // spec section can be told apart from one describing another repo's code.
  const known = new Set<string>();
  for (const a of (await readAnchorStore(root).catch(() => ({ anchors: [] as Anchor[] }))).anchors) known.add(a.symbolPath[a.symbolPath.length - 1]!);
  for (const a of (await readSnapshot(root, t.refs.head)) ?? []) known.add(a.symbolPath[a.symbolPath.length - 1]!);

  const story = buildStory(sections, steps, { known });
  return {
    ...story,
    pr: { number: t.pr.number, title: t.pr.title, url: t.pr.url, author: t.pr.author, headRef: t.pr.headRef, baseRef: t.pr.baseRef },
    refs: { mergeBase: t.refs.mergeBase, head: t.refs.head, baseAheadOfMergeBase: t.refs.baseAheadOfMergeBase },
    // Carried so a walkthrough with nothing in it can say *why* — a PR that is all
    // tests or all generated code has an empty queue by design, and an unexplained
    // empty page reads as a broken one.
    lanes: t.lanes,
    totals: { steps: steps.length, chapters: story.chapters.length, changedLines: t.totals.changedLines, queueLines: t.totals.queueLines },
  };
}

export interface PrAnchorCode {
  id: string; file: string; lang: string;
  /** Head source plus its real starting line, so findings can be pinned to file lines. */
  head: string | null; startLine: number;
  /**
   * Base source and its own starting line. For a symbol the PR REMOVES this is the
   * only body there is — the walkthrough shows it, because deleted code is what a
   * review must least skip.
   */
  base: string | null; baseStartLine: number;
  /** Unified diff of base→head. What a reviewer of a *changed* symbol actually wants. */
  lines: DiffLine[];
  /**
   * The two sides disagree about line endings. Reported rather than silently
   * normalised: a CRLF↔LF flip makes every line look rewritten, and a reviewer
   * who is not told will either read a wall of false changes or, worse, trust a
   * diff that quietly hid it.
   */
  lineEndingsChanged: boolean;
  annotations: unknown[];
}

/**
 * One anchor's source at the PR head (and at the merge-base, when it existed
 * there). `/api/anchor` reads the working tree, which is on some other branch
 * entirely — a walkthrough has to read the code as the PR actually leaves it.
 */
export async function prAnchorCode(root: string, input: string, id: string): Promise<PrAnchorCode | { error: string }> {
  const t = await prTriage(root, input, { fetch: false });
  if ("error" in t) return t;
  const item = t.worklist.find((w) => w.id === id);
  if (!item) return { error: `anchor ${id} is not part of PR #${t.pr.number}` };

  const at = async (sha: string) => {
    const src = readBlobs(root, sha, [item.file]).get(item.file);
    if (!src) return { code: null as string | null, startLine: 1 };
    const a = (await indexBlob(src, item.file)).find((x) => x.id === id);
    return a?.loc ? { code: src.slice(a.loc.startByte, a.loc.endByte), startLine: a.loc.startLine } : { code: null, startLine: 1 };
  };
  const head = item.change === "removed" ? { code: null as string | null, startLine: 1 } : await at(t.refs.head);
  const base = item.change === "added" ? { code: null as string | null, startLine: 1 } : await at(t.refs.mergeBase);
  const anns = (await readAnnotations(root)).annotations.filter((a) => a.target.kind === "anchor" && a.target.id === id);

  const hasCR = (x: string | null) => x != null && x.includes("\r");
  const lineEndingsChanged = base.code != null && head.code != null && hasCR(base.code) !== hasCR(head.code);
  const b = stripCR(base.code), h = stripCR(head.code);
  const lines: DiffLine[] =
    b != null && h != null ? lineDiff(b, h)
      : h != null ? h.split("\n").map((text) => ({ tag: "+" as const, text }))
        : b != null ? b.split("\n").map((text) => ({ tag: "-" as const, text }))
          : [];

  return {
    id, file: item.file, lang: langOf(item.file),
    head: h, startLine: head.startLine, base: b, baseStartLine: base.startLine, lines, lineEndingsChanged, annotations: anns,
  };
}

/** Line spans for a set of anchors at one commit — one blob read + parse per file. */
export async function anchorSpans(
  root: string, sha: string, items: { id: string; file: string }[],
): Promise<Map<string, { startLine: number; endLine: number }>> {
  const out = new Map<string, { startLine: number; endLine: number }>();
  const wanted = new Map<string, Set<string>>();
  for (const it of items) (wanted.get(it.file) ?? wanted.set(it.file, new Set()).get(it.file)!).add(it.id);
  const blobs = readBlobs(root, sha, [...wanted.keys()]);
  for (const [file, ids] of wanted) {
    const src = blobs.get(file);
    if (!src) continue;
    for (const a of await indexBlob(src, file)) {
      if (ids.has(a.id) && a.loc) out.set(a.id, { startLine: a.loc.startLine, endLine: a.loc.endLine });
    }
  }
  return out;
}

const LANG: Record<string, string> = { cs: "csharp", py: "python", js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", tsx: "typescript", jsx: "javascript" };
const langOf = (file: string) => LANG[file.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext";


/** What promoting a chapter would write — inspect before it lands in the map. */
export async function prPromotionPlan(
  root: string, input: string, chapterId: string,
): Promise<{ promotion: Promotion; chapter: { id: string; title: string; durable: boolean; source: string }; ref: string } | { error: string }> {
  const story = await prStory(root, input, { fetch: false });
  if ("error" in story) return story;
  const chapter = story.chapters.find((c) => c.id === chapterId);
  if (!chapter) return { error: `no chapter "${chapterId}" in PR #${story.pr.number}` };
  if (!chapter.steps.length) return { error: `chapter "${chapter.title}" has no symbols to cite — a node with no anchors is a floating claim` };
  return {
    promotion: planPromotion(chapter),
    chapter: { id: chapter.id, title: chapter.title, durable: chapter.durable, source: chapter.source },
    ref: story.refs.head,
  };
}

/**
 * Derive stakes and complexity for the symbols a pull request touches.
 *
 * The graph-wide `deriveTriage` cannot reach these: it reads the @work index, and
 * a symbol the branch *adds* is not there — so every added symbol stayed
 * `untriaged`, which is why a big feature PR ranked as an undifferentiated wall.
 * #227 is 521 added symbols against 16 changed ones.
 *
 * Signals, weakest claim first — the graph knows nothing about brand-new code, so
 * these are shape-based and all land as `likely` proposals a human confirms:
 *   - money in the file or symbol name → business-critical (the existing MONEY_RX);
 *   - position on the command → handler → event → aggregate spine → important,
 *     a read model → low (mirrors `structuralImportance`, read off the path
 *     because a new symbol has no node type yet);
 *   - proximity: a file that already holds business-critical or important marks
 *     is presumed to keep producing them (docs/triage.md), so an otherwise
 *     unclassified symbol there inherits `important`.
 * Complexity comes from the head source, which needs no graph at all.
 */
export async function derivePrTriage(
  root: string, input: string, opts: { fetch?: boolean } = {},
): Promise<{ applied: number; refused: number; considered: number; byImportance: Record<string, number> } | { error: string }> {
  const t = await prTriage(root, input, { fetch: opts.fetch });
  if ("error" in t) return t;

  const existing = await readTriage(root);
  // Files that already carry a real stake — the proximity signal.
  const anchorFile = new Map(t.worklist.map((w) => [w.id, w.file]));
  const hotFiles = new Set<string>();
  for (const tr of existing.triage) {
    if (tr.target.kind !== "anchor") continue;
    // legacy stores wrote "mechanical" for the low tier; it is normalised on read
    if (tr.importance === "business-critical" || tr.importance === "important") {
      const f = anchorFile.get(tr.target.id);
      if (f) hotFiles.add(f);
    }
  }

  const LAYER_STAKE: (Importance | undefined)[] = ["important", "important", "important", "important", "low", "important"];
  const items = t.worklist
    .filter((w) => w.lane === "code" && w.change !== "removed")
    .map((w) => {
      const money = MONEY_RX.test(`${w.file} ${w.symbol} ${w.signature}`);
      const role = spineRole(w.file, w.symbol);
      const structural = role === null ? undefined : LAYER_STAKE[role];
      const importance: Importance | undefined =
        money ? "business-critical"
          : structural ?? (hotFiles.has(w.file) ? "important" : undefined);
      const reason = money ? "name suggests money/value"
        : structural ? "on the command → read-model spine"
          : hotFiles.has(w.file) ? "file already holds high-stakes code" : "";
      return { anchorId: w.id, importance, complexity: w.complexity, reason };
    })
    // No signal means no claim. Asserting a stake here would turn "we do not know"
    // into "important", and untriaged already escalates — while the worklist reads
    // complexity off the live source anyway, so the ranking loses nothing.
    .filter((i) => i.importance !== undefined);

  const r = await setTriageBatch(root, items, { source: "agent", ref: t.refs.head });
  const byImportance: Record<string, number> = {};
  for (const i of items) if (i.importance) byImportance[i.importance] = (byImportance[i.importance] ?? 0) + 1;
  return { ...r, considered: items.length, byImportance };
}
