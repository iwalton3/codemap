/**
 * Branch/commit diff — a *logical* operation over two anchor snapshots (no
 * checkout, no blob reading): compare the anchor sets by id (added / removed
 * symbols) and by bodyHash (changed bodies), then roll the impact up to the
 * logical nodes, flows, and reviews that cite the affected anchors.
 *
 * Two modes:
 *   diff(base)        base = cached snapshot,  head = a fresh index of the
 *                     current working tree (the PR-review path: you've checked
 *                     out the branch, so "head" is just what's on disk now).
 *   diff(base, head)  both sides are cached commit snapshots — a pure set-op,
 *                     nothing re-indexed and nothing checked out.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { comparableHashDerivation, type Anchor, type Review } from "./schema.js";
import { indexRepo, indexFile, indexBlob } from "./repo.js";
import { readSnapshot, readAnchorStore, loadNodes, loadNodeVersions, winningVersionAt, readGraph, readReviews, readBugs } from "./store.js";
import { reviewStatesFor } from "./reviews.js";
import { reviewTriageFor, coverageFor, type Coverage } from "./triage.js";
import { revParse, headCommit, currentBranch, showFile } from "./git.js";
import { grammarForPath } from "./grammars.js";
import { sameBody } from "./normalize.js";

const HL_LANG: Record<string, string> = { c_sharp: "csharp", python: "python", javascript: "javascript", typescript: "typescript", tsx: "typescript" };
const langFor = (file: string) => HL_LANG[grammarForPath(file) ?? ""] ?? "plaintext";

interface Brief { id: string; file: string; symbol: string; kind: string }
const brief = (a: Anchor): Brief => ({ id: a.id, file: a.file, symbol: a.symbolPath.join(" › "), kind: a.kind });

export interface DiffSide { ref: string; sha: string | null; label: string; anchors: number }
export interface DiffResult {
  base: DiffSide;
  head: DiffSide;
  added: Brief[];
  removed: Brief[];
  changed: Brief[];
  /**
   * Paired symbols whose hashes differ but were derived differently — a grammar or
   * runtime change, not a code change. Nobody can say whether these moved, so they
   * are reported apart from `changed` rather than inflating it.
   */
  unverifiable: Brief[];
  impact: {
    nodes: { id: string; title: string; type: string; summary: string; anchors: string[]; status: string; versionCount: number; review: { logical: string; code: string }; reviewBy: { logical: string | null; code: string | null }; reviewVia: { logical?: string; code?: string }; viewed: { logical: string; code: string }; severity: string }[];
    flows: { id: string; title: string; steps: { id: string; title: string; anchors: string[] }[] }[];
    reviews: { id: string; target: { kind: string; id: string }; level: string; anchors: string[] }[];
    bugs: { id: string; title: string; status: string; severity: string; anchors: string[]; removed: boolean; possiblyFixed: boolean }[];
  };
  /** Review-complete rollup over the changed+added anchors — "am I done reviewing this?" */
  coverage: Coverage;
}

/** Resolve a ref to (sha, cached anchors). Accepts a branch/tag/sha; null anchors when uncached. */
async function resolveSnapshot(root: string, ref: string): Promise<{ sha: string; anchors: Anchor[] | null }> {
  const sha = revParse(root, ref) ?? ref; // fall back to treating ref as a raw sha
  return { sha, anchors: await readSnapshot(root, sha) };
}

export async function computeDiff(root: string, baseRef: string, headRef?: string): Promise<DiffResult | { error: string }> {
  const base = await resolveSnapshot(root, baseRef);
  if (!base.anchors) {
    return { error: `no cached snapshot for base "${baseRef}" (${base.sha.slice(0, 12)}). Check out that commit and run \`codemap init\` (or \`codemap snapshot\`) to cache it.` };
  }

  let headAnchors: Anchor[];
  let headSide: DiffSide;
  if (headRef) {
    const h = await resolveSnapshot(root, headRef);
    if (!h.anchors) return { error: `no cached snapshot for head "${headRef}" (${h.sha.slice(0, 12)}). Cache it with \`codemap snapshot\` while it's checked out.` };
    headAnchors = h.anchors;
    headSide = { ref: headRef, sha: h.sha, label: headRef, anchors: h.anchors.length };
  } else {
    // Fresh index of the current working tree — accurate to what's checked out.
    headAnchors = await indexRepo(root);
    const sha = headCommit(root);
    const br = currentBranch(root);
    headSide = { ref: "WORK", sha, label: `working tree${br ? ` (${br})` : ""}`, anchors: headAnchors.length };
  }

  const baseById = new Map(base.anchors.map((a) => [a.id, a]));
  const headById = new Map(headAnchors.map((a) => [a.id, a]));

  const added: Brief[] = [];
  const removed: Brief[] = [];
  const changed: Brief[] = [];
  const unverifiable: Brief[] = [];
  for (const [id, a] of headById) if (!baseById.has(id)) added.push(brief(a));
  for (const [id, a] of baseById) if (!headById.has(id)) removed.push(brief(a));
  for (const [id, a] of headById) {
    const b = baseById.get(id);
    // Equal hashes end it, BEFORE comparability is consulted. That looks like it
    // inverts the validate-then-compare order the design states, and it is a
    // deliberate exception with a reason: two derivations that produced the same
    // digest for this symbol produced the same token stream for it, so they agree
    // here whatever they do elsewhere. Marking those unverifiable would flood a
    // grammar bump with every symbol it did not actually affect — which is the
    // failure this whole path exists to avoid, arrived at from the other side.
    if (!b || sameBody(b.bodyHash, a.bodyHash)) continue;
    // The hashes differ. Whether that is DRIFT depends on whether the two sides
    // were derived the same way — a re-vendored grammar tokenizes unchanged code
    // differently, and calling that "changed" reports the whole repository as
    // rewritten. Kept out of `impacted` below: not evidence anything went stale.
    (comparableHashDerivation(b.derivation, a.derivation) ? changed : unverifiable).push(brief(a));
  }

  // Impact = the anchors whose existing documentation/reviews may no longer hold:
  // bodies that changed, plus symbols that vanished. (Added symbols are new work,
  // surfaced separately as `added`, not as invalidation.)
  const impacted = new Set<string>([...changed, ...removed].map((b) => b.id));

  const nodes = await loadNodes(root);
  const graph = await readGraph(root);
  const reviews = (await readReviews(root)).reviews;

  const nodeImpact = nodes
    .map((n) => ({ n, hit: n.anchors.filter((id) => impacted.has(id)) }))
    .filter((x) => x.hit.length > 0);

  // Review + viewed + severity, best-effort — never let it break the diff (e.g. no @work index).
  let nodeRt: Awaited<ReturnType<typeof reviewTriageFor>> = new Map();
  try {
    nodeRt = await reviewTriageFor(root, nodeImpact.map(({ n }) => ({ kind: "node" as const, id: n.id })));
  } catch { /* leave unreviewed */ }
  const impactedNodes = nodeImpact.map(({ n, hit }) => {
    const e = nodeRt.get(`node:${n.id}`);
    const rp = e?.review;
    return { id: n.id, title: n.title, type: n.type, summary: n.summary, anchors: hit, status: n.status ?? "fresh", versionCount: n.versionCount ?? 1, review: { logical: rp?.logical.state ?? "unreviewed", code: rp?.code.state ?? "unreviewed" }, reviewBy: { logical: rp?.logical.actor ?? null, code: rp?.code.actor ?? null }, reviewVia: { logical: rp?.logical.via, code: rp?.code.via }, viewed: { logical: e?.viewed.logical.state ?? "unreviewed", code: e?.viewed.code.state ?? "unreviewed" }, severity: e?.triage.severity ?? "untriaged" };
  });

  // Flows: process nodes whose steps (via step_of) or self touch impacted anchors.
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const stepsOf = new Map<string, string[]>(); // process id -> step node ids (ordered by edge order)
  for (const e of graph.edges) {
    if (e.type === "step_of") {
      const arr = stepsOf.get(e.to) ?? [];
      arr.push(e.from);
      stepsOf.set(e.to, arr);
    }
  }
  const flows: DiffResult["impact"]["flows"] = [];
  for (const p of nodes.filter((n) => n.type === "process")) {
    const stepHits: { id: string; title: string; anchors: string[] }[] = [];
    const own = p.anchors.filter((id) => impacted.has(id));
    if (own.length) stepHits.push({ id: p.id, title: `${p.title} (flow node)`, anchors: own });
    for (const sid of stepsOf.get(p.id) ?? []) {
      const s = nodeById.get(sid);
      if (!s) continue;
      const hit = s.anchors.filter((id) => impacted.has(id));
      if (hit.length) stepHits.push({ id: s.id, title: s.title, anchors: hit });
    }
    if (stepHits.length) flows.push({ id: p.id, title: p.title, steps: stepHits });
  }

  // Reviews that would go stale: their covered anchors intersect the impacted set.
  const coveredBy = (r: Review): string[] =>
    r.target.kind === "anchor" ? [r.target.id] : nodeById.get(r.target.id)?.anchors ?? [];
  const reviewImpact = reviews
    .map((r) => ({ r, hit: coveredBy(r).filter((id) => impacted.has(id)) }))
    .filter((x) => x.hit.length > 0)
    .map(({ r, hit }) => ({ id: r.id, target: r.target, level: r.level, anchors: hit }));

  // Bugs whose cited code moved in this diff: an open bug on changed code may be
  // *fixed* by the change (verify), and any bug on removed code lost its anchor.
  // This is the "does this change touch known-broken code" context a raw diff hides.
  const removedIds = new Set(removed.map((b) => b.id));
  const bugImpact = (await readBugs(root)).bugs
    .map((bug) => ({ bug, hit: bug.anchors.filter((id) => impacted.has(id)) }))
    .filter((x) => x.hit.length > 0)
    .map(({ bug, hit }) => ({
      id: bug.id, title: bug.title, status: bug.status, severity: bug.severity, anchors: hit,
      removed: hit.some((id) => removedIds.has(id)),
      possiblyFixed: bug.status === "open",
    }));

  // Review-complete over the anchors this diff changed or added (removed ones need no
  // review). The number that answers "am I actually done reviewing this change?" —
  // stakes-relative, so it never demands a golden-window sign-off on plumbing.
  let coverage: Coverage = { total: 0, complete: 0, outstanding: 0, completePct: 100, bySeverity: {}, worst: null };
  try {
    coverage = await coverageFor(root, [...added, ...changed].map((b) => ({ kind: "anchor" as const, id: b.id })));
  } catch { /* best-effort — never break the diff */ }

  return {
    base: { ref: baseRef, sha: base.sha, label: baseRef, anchors: base.anchors.length },
    head: headSide,
    added,
    removed,
    changed,
    unverifiable,
    impact: { nodes: impactedNodes, flows, reviews: reviewImpact, bugs: bugImpact },
    coverage,
  };
}

// --- per-anchor code drill-down (before/after with a line diff) --------------

export type DiffLine = { tag: " " | "+" | "-"; text: string };

/** LCS line diff — cheap and exact for function-body-sized code. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.split("\n"), B = b.split("\n");
  const n = A.length, m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ tag: " ", text: A[i]! }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { out.push({ tag: "-", text: A[i]! }); i++; }
    else { out.push({ tag: "+", text: B[j]! }); j++; }
  }
  while (i < n) out.push({ tag: "-", text: A[i++]! });
  while (j < m) out.push({ tag: "+", text: B[j++]! });
  return out;
}

/**
 * The source of an anchor at a cached commit. We `git show` the blob and
 * RE-PARSE it to locate the symbol — the snapshot's stored `loc` came from the
 * working tree at snapshot time (possibly dirty, or different line endings) and
 * won't align with the committed blob. loc offsets index the parsed STRING
 * (UTF-16 code units, per web-tree-sitter — matching node.text), so slice the
 * decoded blob, not the raw buffer (which multi-byte chars would misalign).
 */
async function codeAtSnapshot(root: string, sha: string, id: string, file: string): Promise<string | null> {
  const buf = showFile(root, sha, file);
  if (!buf) return null;
  try {
    const src = buf.toString("utf8");
    const a = (await indexBlob(src, file)).find((x) => x.id === id);
    return a?.loc ? src.slice(a.loc.startByte, a.loc.endByte) : null;
  } catch {
    return null;
  }
}

/** The head source of an anchor: from the working tree (live) or a cached commit. */
async function codeAtHead(root: string, headRef: string | undefined, id: string, file: string): Promise<string | null> {
  if (headRef) {
    const sha = revParse(root, headRef) ?? headRef;
    return codeAtSnapshot(root, sha, id, file);
  }
  // working tree: read the file live and re-resolve the anchor's exact slice.
  try {
    const src = await readFile(join(root, file), "utf8"); // loc index the parsed string, not raw bytes
    const a = (await indexFile(join(root, file), file)).find((x) => x.id === id);
    return a?.loc ? src.slice(a.loc.startByte, a.loc.endByte) : null;
  } catch {
    return null;
  }
}

/** Strip CR so CRLF-vs-LF differences don't turn a real diff into full replacement. */
export const stripCR = (s: string | null): string | null => (s == null ? null : s.replace(/\r/g, ""));

export interface AnchorCodeDiff {
  id: string;
  file: string;
  lang: string;
  hasBase: boolean;
  hasHead: boolean;
  lines: DiffLine[];
}

/** Anchor-hash map for a ref: a cached snapshot's hashes, or @work for the working tree. */
async function hashesAt(root: string, ref: string | undefined): Promise<Map<string, string> | null> {
  if (!ref) return new Map((await readAnchorStore(root).catch(() => ({ anchors: [] as Anchor[] }))).anchors.map((a) => [a.id, a.bodyHash]));
  const anchors = await readSnapshot(root, revParse(root, ref) ?? ref);
  return anchors ? new Map(anchors.map((a) => [a.id, a.bodyHash])) : null;
}

export interface DocSide {
  versionId: string; branch: string | null; commit: string | null;
  title: string; summary: string; body: string; removed: boolean;
}
export interface DocDiff {
  forked: boolean;
  base?: DocSide;
  head?: DocSide;
  lines?: DiffLine[];
  /** The single winning version when it's identical on both branches (forked=false). */
  doc?: DocSide;
  note?: string;
  error?: string;
}

/**
 * Diff a doc's PROSE across a branch diff: resolve which version wins on the base
 * snapshot vs the head, and if they differ, line-diff their text (title/summary/
 * body). Lets a reviewer read *how the documentation changed* alongside the code.
 */
export async function docDiff(root: string, baseRef: string, headRef: string | undefined, nodeId: string): Promise<DocDiff> {
  const versions = await loadNodeVersions(root, nodeId);
  if (!versions.length) return { forked: false, error: `no node "${nodeId}"` };
  const baseHashes = await hashesAt(root, baseRef);
  if (!baseHashes) return { forked: false, error: `no cached snapshot for base "${baseRef}"` };
  const headHashes = await hashesAt(root, headRef);
  if (!headHashes) return { forked: false, error: `no cached snapshot for head "${headRef}"` };
  const bv = winningVersionAt(versions, baseHashes);
  const hv = winningVersionAt(versions, headHashes);
  if (!bv || !hv) return { forked: false, note: "not resolvable on both sides" };
  const text = (v: typeof bv) => (v.removed ? "(removed)" : `# ${v.title}\n\n${v.summary}\n\n${v.body}`.replace(/\r/g, ""));
  const side = (v: typeof bv): DocSide => ({ versionId: v.versionId, branch: v.createdBranch, commit: v.createdCommit, title: v.title, summary: v.summary, body: v.body, removed: !!v.removed });
  // Same version on both branches: the doc's prose is unchanged, so ship the
  // single winning version for the UI to render inline (no diff to show).
  if (bv.versionId === hv.versionId) return { forked: false, note: "same version on both branches", doc: side(bv) };
  return { forked: true, base: side(bv), head: side(hv), lines: lineDiff(text(bv), text(hv)) };
}

/**
 * Before/after code for one anchor between two refs. `file` comes from the diff
 * result (an anchor id maps to exactly one file, so one param covers both sides).
 * Omit `head` to compare against the working tree.
 */
export async function anchorCodeDiff(root: string, baseRef: string, headRef: string | undefined, id: string, file: string): Promise<AnchorCodeDiff> {
  const baseSha = revParse(root, baseRef) ?? baseRef;
  const baseCode = stripCR(await codeAtSnapshot(root, baseSha, id, file));
  const headCode = stripCR(await codeAtHead(root, headRef, id, file));
  let lines: DiffLine[];
  if (baseCode == null && headCode != null) lines = headCode.split("\n").map((text) => ({ tag: "+" as const, text }));
  else if (headCode == null && baseCode != null) lines = baseCode.split("\n").map((text) => ({ tag: "-" as const, text }));
  else if (baseCode != null && headCode != null) lines = lineDiff(baseCode, headCode);
  else lines = [];
  return { id, file, lang: langFor(file), hasBase: baseCode != null, hasHead: headCode != null, lines };
}
