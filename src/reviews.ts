/**
 * Human review state — marking nodes/anchors as logically or code reviewed, with
 * the same witness mechanism as bugs: a review captures the covered code's hashes,
 * and goes `stale` when that code later changes (so a green check never lies).
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { type Review, type ReviewLevel, type ReviewState } from "./schema.js";
import { readReviews, writeReviews, readAnchorStore, loadNodes } from "./store.js";
import { indexFile } from "./repo.js";
import { headCommit } from "./git.js";

export interface ReviewInfo {
  state: ReviewState;
  by?: string;
  at?: string;
}
export interface ReviewPair {
  logical: ReviewInfo;
  code: ReviewInfo;
}

export type Target = { kind: "node" | "anchor"; id: string };
const key = (t: Target) => `${t.kind}:${t.id}`;

async function coveredAnchorIds(root: string, target: Target, nodeAnchors?: Map<string, string[]>): Promise<string[]> {
  if (target.kind === "anchor") return [target.id];
  if (nodeAnchors) return nodeAnchors.get(target.id) ?? [];
  const nodes = await loadNodes(root);
  return nodes.find((n) => n.id === target.id)?.anchors ?? [];
}

/** Current live hashes for a set of anchor ids (re-indexes their files once). */
async function liveHashes(root: string, anchorIds: Iterable<string>): Promise<Map<string, string>> {
  const store = await readAnchorStore(root);
  const byId = new Map(store.anchors.map((a) => [a.id, a]));
  const files = new Set<string>();
  for (const id of anchorIds) {
    const f = byId.get(id)?.file;
    if (f) files.add(f);
  }
  const live = new Map<string, string>();
  for (const f of files) {
    try {
      for (const a of await indexFile(join(root, f), f)) live.set(a.id, a.bodyHash);
    } catch {
      /* file gone */
    }
  }
  return live;
}

export async function markReviewed(
  root: string,
  input: { targetKind: "node" | "anchor"; targetId: string; level: ReviewLevel; reviewer?: string },
) {
  const target: Target = { kind: input.targetKind, id: input.targetId };
  const anchorIds = await coveredAnchorIds(root, target);
  const live = await liveHashes(root, anchorIds);
  const witnesses = anchorIds.map((id) => ({ anchorId: id, bodyHash: live.get(id) ?? "sha256:absent" }));
  const rs = await readReviews(root);
  rs.reviews = rs.reviews.filter((r) => !(r.target.kind === target.kind && r.target.id === target.id && r.level === input.level));
  rs.reviews.push({
    id: "rev_" + randomBytes(6).toString("hex"),
    target,
    level: input.level,
    reviewer: input.reviewer || "me",
    at: new Date().toISOString(),
    reviewedCommit: headCommit(root),
    witnesses,
  });
  await writeReviews(root, rs.reviews);
  return { ok: true, level: input.level, anchors: anchorIds.length };
}

export async function unmarkReviewed(root: string, input: { targetKind: "node" | "anchor"; targetId: string; level: ReviewLevel }) {
  const rs = await readReviews(root);
  const before = rs.reviews.length;
  rs.reviews = rs.reviews.filter((r) => !(r.target.kind === input.targetKind && r.target.id === input.targetId && r.level === input.level));
  await writeReviews(root, rs.reviews);
  return { ok: true, removed: before - rs.reviews.length };
}

/** Review state for many targets at once — batches the live re-index over all covered files. */
export async function reviewStatesFor(root: string, targets: Target[]): Promise<Map<string, ReviewPair>> {
  const rs = await readReviews(root);
  const nodes = await loadNodes(root);
  const nodeAnchors = new Map(nodes.map((n) => [n.id, n.anchors]));
  const all = new Set<string>();
  const covers = new Map<string, string[]>();
  for (const t of targets) {
    const ids = await coveredAnchorIds(root, t, nodeAnchors);
    covers.set(key(t), ids);
    ids.forEach((id) => all.add(id));
  }
  const live = await liveHashes(root, all);
  const out = new Map<string, ReviewPair>();
  const forLevel = (t: Target, level: ReviewLevel): ReviewInfo => {
    const r = rs.reviews.find((x) => x.target.kind === t.kind && x.target.id === t.id && x.level === level);
    if (!r) return { state: "unreviewed" };
    const stale = r.witnesses.some((w) => live.get(w.anchorId) !== w.bodyHash);
    return { state: stale ? "stale" : "reviewed", by: r.reviewer, at: r.at };
  };
  for (const t of targets) out.set(key(t), { logical: forLevel(t, "logical"), code: forLevel(t, "code") });
  return out;
}

export async function reviewStatus(root: string, target: Target): Promise<ReviewPair> {
  return (await reviewStatesFor(root, [target])).get(key(target))!;
}

/**
 * Per-anchor review state for the whole store. Staleness is judged against LIVE
 * hashes, but only the files that actually contain reviewed anchors are
 * re-indexed (reviews are few) — so it's both correct and cheap enough for the
 * outline heatmap. A node review propagates to the anchors it cites. Precedence:
 * reviewed > stale > unreviewed.
 */
export async function anchorReviewMap(
  root: string,
  anchors: { id: string }[],
  nodes: { id: string; anchors: string[] }[],
  reviews: Review[],
): Promise<Map<string, { code: ReviewState; logical: ReviewState }>> {
  const nodeAnchors = new Map(nodes.map((n) => [n.id, n.anchors]));
  const reviewedAnchorIds = new Set<string>();
  for (const r of reviews) {
    if (r.target.kind === "anchor") reviewedAnchorIds.add(r.target.id);
    else for (const aid of nodeAnchors.get(r.target.id) ?? []) reviewedAnchorIds.add(aid);
  }
  const live = await liveHashes(root, reviewedAnchorIds);
  const isStale = (r: Review) => r.witnesses.some((w) => live.get(w.anchorId) !== w.bodyHash);
  const code = new Map<string, ReviewState>();
  const logical = new Map<string, ReviewState>();
  const bump = (m: Map<string, ReviewState>, id: string, state: ReviewState) => {
    const c = m.get(id);
    if (c === "reviewed") return;
    if (state === "reviewed" || !c) m.set(id, state);
  };
  for (const r of reviews) {
    const state: ReviewState = isStale(r) ? "stale" : "reviewed";
    const m = r.level === "code" ? code : logical;
    if (r.target.kind === "anchor") bump(m, r.target.id, state);
    else for (const aid of nodeAnchors.get(r.target.id) ?? []) bump(m, aid, state);
  }
  const out = new Map<string, { code: ReviewState; logical: ReviewState }>();
  for (const a of anchors) out.set(a.id, { code: code.get(a.id) ?? "unreviewed", logical: logical.get(a.id) ?? "unreviewed" });
  return out;
}
