/**
 * Reading the map AT a commit — `at: <branch | sha>` on the read tools.
 *
 * One view in place of the live index: the commit's snapshot (built on first read, from
 * git objects, so no checkout and nothing written to `@work`), the docs as they resolve
 * against it, and its `.codemapignore`. An agent in a worktree reads its own branch through
 * the main checkout's universe without disturbing it or anyone else's reads.
 *
 * Uncommitted edits are never silently missing. When `at` names a branch that some
 * worktree has checked out, that worktree's uncommitted indexable files are listed on the
 * answer; with `dirty` they are indexed from that worktree's disk and laid over the commit
 * instead. Review marks are judged at the commit either way: review does not cover
 * uncommitted changes. See docs/plan-review-before-pr.md, "Uncommitted edits".
 */
import { join } from "node:path";
import type { Anchor, LogicalNode } from "../schema.js";
import { indexFile } from "../repo.js";
import { revParse, showFile, worktreeForBranch, uncommittedPaths, defaultBranch, mergeBase } from "../git.js";
import { reviewStatesFor } from "../reviews.js";
import { computeDiff } from "../diff.js";
import { readSnapshot } from "../snapshots.js";
import { snapshotRefusal, loadNodesAt, derivationLookup } from "../store.js";
import { anchorIndex, derivationsOf, type AnchorIndex } from "../anchor-resolve.js";
import { isIndexablePath } from "../fs-scan.js";
import { compileIgnore, loadIgnore, type Ignore } from "../ignore.js";

export interface AtView {
  /** What the caller asked for, as they spelled it. */
  ref: string;
  sha: string;
  anchors: Anchor[];
  index: AnchorIndex;
  nodes: LogicalNode[];
  ignore: Ignore;
  /** The worktree that has `ref` checked out, when `ref` is a branch one does. */
  worktree: string | null;
  /** Indexable files that worktree has not committed. */
  uncommitted: string[];
  /** True when `uncommitted` is laid over the commit in this view rather than left out. */
  overlaid: boolean;
}

export async function viewAt(root: string, at: string, opts: { dirty?: boolean } = {}): Promise<AtView | { error: string }> {
  const sha = revParse(root, at);
  if (!sha) return { error: `cannot resolve "${at}" to a commit in this repository` };
  const committedAnchors = await readSnapshot(root, sha);
  if (!committedAnchors) return { error: snapshotRefusal(root, sha)?.message ?? `cannot index ${sha.slice(0, 12)}` };
  // The commit's own rules, as `indexCommit` uses to build the snapshot.
  const committed = showFile(root, sha, ".codemapignore")?.toString("utf8");
  const ignore = committed !== undefined ? compileIgnore(committed) : await loadIgnore(root);

  const worktree = revParse(root, `refs/heads/${at}`) === sha ? worktreeForBranch(root, at) : null;
  const uncommitted = worktree ? uncommittedPaths(worktree).filter((p) => isIndexablePath(p, ignore)) : [];

  // The overlay is recomputed per read and never cached: it belongs to a worktree, not to
  // the commit it is laid over, and only the uncommitted files are indexed.
  let anchors = committedAnchors;
  const overlaid = !!(opts.dirty && worktree && uncommitted.length);
  if (overlaid) {
    const dirtyFiles = new Set(uncommitted);
    const fresh: Anchor[] = [];
    for (const p of uncommitted) {
      try { fresh.push(...await indexFile(join(worktree!, p), p)); } catch { /* deleted in the worktree */ }
    }
    anchors = [...committedAnchors.filter((a) => !dirtyFiles.has(a.file)), ...fresh];
  }
  // Folds the team's docs first, as every ops-layer node read does (`loadNodesShared`).
  await import("../docs-lookup.js").then((m) => m.docsVerdict(root)).catch(() => null);
  const index = anchorIndex(new Map(anchors.map((a) => [a.id, a.bodyHash])), derivationsOf(anchors), derivationLookup(root));
  const nodes = await loadNodesAt(root, index);
  return { ref: at, sha, anchors, index, nodes, ignore, worktree, uncommitted, overlaid };
}

/** The header every `at` answer carries: which commit it read, and what it left out. */
export function atHeader(v: AtView) {
  return {
    at: {
      ref: v.ref, sha: v.sha,
      ...(v.uncommitted.length ? {
        uncommitted: v.uncommitted,
        uncommittedNote: v.overlaid
          ? `This answer includes ${v.uncommitted.length} file(s) with uncommitted changes, read from ${v.worktree}. `
            + `Review state is still the commit's: review does not cover uncommitted changes.`
          : `${v.uncommitted.length} file(s) have uncommitted changes in ${v.worktree}. `
            + `This answer is the commit's and does not include them; pass \`dirty: true\` to include them.`,
        ...(v.overlaid ? { overlaid: true } : {}),
      } : {}),
    },
  };
}

/**
 * `check_stale at:` — what a branch changed against its base, and whether the map still
 * holds for it. Read-only: it never rebaselines, reindexes or refreshes analyzers.
 *
 * The three answers the spec playbook asks for at the head: the symbols the change
 * touched; the docs citing them that are not fresh at the head (§14.8's gate is zero of
 * them); and which touched symbols carry a review mark that still holds there, one the
 * change moved, or none (a review round's scope).
 */
export async function staleAt(root: string, at: string, base?: string) {
  const view = await viewAt(root, at);
  if ("error" in view) return view;
  let baseSha: string | null;
  let baseLabel: string;
  if (base) {
    baseSha = revParse(root, base);
    baseLabel = base;
  } else {
    const trunk = defaultBranch(root);
    const tip = revParse(root, `origin/${trunk}`) ?? revParse(root, trunk);
    baseSha = tip ? mergeBase(root, view.sha, tip) : null;
    baseLabel = `merge-base with ${trunk}`;
  }
  if (!baseSha) return { ...atHeader(view), error: `no base for ${at}: pass \`base\` (the branch it will merge into)` };

  const d = await computeDiff(root, baseSha, view.sha);
  if ("error" in d) return { ...atHeader(view), error: d.error };
  const touched = [...d.added, ...d.changed];
  const marks = await reviewStatesFor(root, touched.map((b) => ({ kind: "anchor" as const, id: b.id })), { ref: view.sha });
  const byState = (s: string) => touched.filter((b) => marks.get(`anchor:${b.id}`)?.code.state === s).map((b) => b.id);
  const notFresh = d.impact.nodes.filter((n) => n.status !== "fresh");

  return {
    ...atHeader(view),
    base: { ref: baseLabel, sha: baseSha },
    touched: { added: d.added, changed: d.changed, removed: d.removed },
    staleDocs: notFresh.map((n) => ({ id: n.id, title: n.title, status: n.status, anchors: n.anchors })),
    freshDocs: d.impact.nodes.length - notFresh.length,
    reviews: { reviewed: byState("reviewed"), stale: byState("stale"), unreviewed: byState("unreviewed") },
    gate: { staleDocs: notFresh.length, pass: notFresh.length === 0 },
  };
}
