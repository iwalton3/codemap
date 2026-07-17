/**
 * Human review state — marking nodes/anchors as logically or code reviewed, with
 * the same witness mechanism as bugs: a review captures the covered code's hashes,
 * and goes `stale` when that code later changes (so a green check never lies).
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { type Review, type ReviewLevel, type ReviewState, type BugWitness } from "./schema.js";
import { readReviews, writeReviews, readAnchorStore, loadNodes } from "./store.js";
import { indexFile } from "./repo.js";
import { headCommit } from "./git.js";

/** The human review acts: exposure (`viewed`) vs liability-bearing sign-off (`signed`). */
export type Attestation = "viewed" | "signed";

/**
 * What a review row effectively attests, resolving the two legacy defaults:
 * an agent review with no `attestation` reads as `checked`; a legacy human review
 * (actor human, no attestation) reads as `signed` — it predates the viewed/signed split.
 */
export function effectiveAttestation(r: Review): Attestation | "checked" {
  if (r.attestation) return r.attestation;
  return (r.actor ?? "agent") === "human" ? "signed" : "checked";
}

/** A `viewed` row records exposure only; every other row is a vouch (`signed`/`checked`). */
const isViewedRow = (r: Review) => r.attestation === "viewed";

export interface ReviewInfo {
  state: ReviewState;
  by?: string;
  /** "human" (verified) or "agent" (checked); absent legacy reviews are treated as human. */
  actor?: "human" | "agent";
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
export async function liveHashes(root: string, anchorIds: Iterable<string>): Promise<Map<string, string>> {
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

/** Witnesses (anchor id + current live hash) covering a target — the staleness snapshot. */
export async function witnessesFor(root: string, target: Target): Promise<BugWitness[]> {
  const anchorIds = await coveredAnchorIds(root, target);
  const live = await liveHashes(root, anchorIds);
  return anchorIds.map((id) => ({ anchorId: id, bodyHash: live.get(id) ?? "sha256:absent" }));
}

export async function markReviewed(
  root: string,
  input: { targetKind: "node" | "anchor"; targetId: string; level: ReviewLevel; reviewer?: string; actor?: "human" | "agent"; attestation?: Attestation },
) {
  const target: Target = { kind: input.targetKind, id: input.targetId };
  const anchorIds = await coveredAnchorIds(root, target);
  const live = await liveHashes(root, anchorIds);
  const witnesses = anchorIds.map((id) => ({ anchorId: id, bodyHash: live.get(id) ?? "sha256:absent" }));
  // Default to "agent": only an explicit human action (the web UI) grants a human
  // review. A human act with no attestation is a `signed` sign-off (the old `verified`).
  const actor = input.actor ?? "agent";
  const attestation: Attestation | undefined = input.attestation ?? (actor === "human" ? "signed" : undefined);
  const viewed = attestation === "viewed";
  const rs = await readReviews(root);
  // `viewed` and vouches (`signed`/`checked`) are independent marks: a new vouch
  // replaces the prior vouch at this level (human `signed` supersedes agent `checked`,
  // as before), while a new `viewed` replaces only the prior `viewed` — never a sign-off.
  rs.reviews = rs.reviews.filter(
    (r) => !(r.target.kind === target.kind && r.target.id === target.id && r.level === input.level && isViewedRow(r) === viewed),
  );
  rs.reviews.push({
    id: "rev_" + randomBytes(6).toString("hex"),
    target,
    level: input.level,
    reviewer: input.reviewer || "me",
    actor,
    attestation,
    at: new Date().toISOString(),
    reviewedCommit: headCommit(root),
    witnesses,
  });
  await writeReviews(root, rs.reviews);
  return { ok: true, level: input.level, attestation: attestation ?? "checked", anchors: anchorIds.length };
}

export async function unmarkReviewed(
  root: string,
  input: { targetKind: "node" | "anchor"; targetId: string; level: ReviewLevel; attestation?: Attestation },
) {
  const rs = await readReviews(root);
  const before = rs.reviews.length;
  // No attestation → clear the whole level (both marks). `viewed` → drop only the
  // exposure row; `signed` → drop only the vouch, leaving any `viewed` intact.
  const dropViewed = input.attestation === undefined || input.attestation === "viewed";
  const dropVouch = input.attestation === undefined || input.attestation === "signed";
  rs.reviews = rs.reviews.filter(
    (r) =>
      !(
        r.target.kind === input.targetKind &&
        r.target.id === input.targetId &&
        r.level === input.level &&
        (isViewedRow(r) ? dropViewed : dropVouch)
      ),
  );
  await writeReviews(root, rs.reviews);
  return { ok: true, removed: before - rs.reviews.length };
}

/**
 * Review state for many targets at once — batches the live re-index over all covered
 * files. By default reflects the *vouch* (`signed`/`checked`); pass `{ viewed: true }`
 * to read the `viewed` exposure marks instead (same shape, so callers render either).
 */
export async function reviewStatesFor(
  root: string,
  targets: Target[],
  opts?: { viewed?: boolean },
): Promise<Map<string, ReviewPair>> {
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
  const wantViewed = opts?.viewed ?? false;
  const forLevel = (t: Target, level: ReviewLevel): ReviewInfo => {
    // Default: only vouches (`signed`/`checked`) set the reviewed state — a `viewed`
    // row is exposure, not a blessing. With `{viewed:true}` we read exactly those rows.
    const r = rs.reviews.find((x) => x.target.kind === t.kind && x.target.id === t.id && x.level === level && isViewedRow(x) === wantViewed);
    if (!r) return { state: "unreviewed" };
    const stale = r.witnesses.some((w) => live.get(w.anchorId) !== w.bodyHash);
    return { state: stale ? "stale" : "reviewed", by: r.reviewer, actor: r.actor ?? "agent", at: r.at };
  };
  for (const t of targets) out.set(key(t), { logical: forLevel(t, "logical"), code: forLevel(t, "code") });
  return out;
}

export async function reviewStatus(root: string, target: Target, opts?: { viewed?: boolean }): Promise<ReviewPair> {
  return (await reviewStatesFor(root, [target], opts)).get(key(target))!;
}

export interface DerivedCodeReview {
  state: ReviewState;
  actor: "human" | "agent" | null;
  signed: number;
  total: number;
  stale: number;
}

/**
 * A node's code-review state is *derived* from the code reviews of the anchors it
 * cites — never a single "I signed the node" click that would silently vouch for
 * code you never opened. Every referenced segment must be signed (at live hashes)
 * before the node reads code-reviewed; any stale segment poisons it to `stale`;
 * anything short is `unreviewed` (with `signed/total` so the UI can show progress).
 * `actor` is `human` when a person signed at least one segment (so trust can reach
 * `verified`), else `agent` — matching the human/agent split used elsewhere.
 */
export function deriveCodeReview(anchorCode: ReviewInfo[]): DerivedCodeReview {
  const total = anchorCode.length;
  const signed = anchorCode.filter((a) => a.state === "reviewed").length;
  const stale = anchorCode.filter((a) => a.state === "stale").length;
  const state: ReviewState = total === 0 ? "unreviewed" : stale > 0 ? "stale" : signed === total ? "reviewed" : "unreviewed";
  const actor: "human" | "agent" | null =
    state === "reviewed" ? (anchorCode.some((a) => a.state === "reviewed" && a.actor === "human") ? "human" : "agent") : null;
  return { state, actor, signed, total, stale };
}

export interface AnchorChange { anchorId: string; was: string; now: string }

/** Which of a mark's frozen witnesses no longer match the current live hashes. */
export function witnessDrift(witnesses: BugWitness[], live: Map<string, string>): AnchorChange[] {
  const out: AnchorChange[] = [];
  for (const w of witnesses) {
    const now = live.get(w.anchorId) ?? "sha256:absent";
    if (now !== w.bodyHash) out.push({ anchorId: w.anchorId, was: w.bodyHash, now });
  }
  return out;
}

/**
 * Targeted diff — which anchors covered by `target` have moved since the human last
 * `viewed` / `signed` it. Powers "what changed since I last looked?" so a re-review of
 * a big change reads only the delta under the last mark, never the whole flow again.
 * `found:false` = no such mark yet (never viewed / never signed).
 */
export async function changedSince(
  root: string,
  target: Target,
  opts: { level: ReviewLevel; attestation: Attestation },
): Promise<{ found: boolean; at?: string; reviewedCommit?: string | null; changed: AnchorChange[] }> {
  const rs = await readReviews(root);
  const r = rs.reviews.find(
    (x) =>
      x.target.kind === target.kind &&
      x.target.id === target.id &&
      x.level === opts.level &&
      effectiveAttestation(x) === opts.attestation,
  );
  if (!r) return { found: false, changed: [] };
  const live = await liveHashes(root, r.witnesses.map((w) => w.anchorId));
  return { found: true, at: r.at, reviewedCommit: r.reviewedCommit, changed: witnessDrift(r.witnesses, live) };
}

/**
 * Per-anchor review state for the whole store. Staleness is judged against LIVE
 * hashes, but only the files that actually contain reviewed anchors are
 * re-indexed (reviews are few) — so it's both correct and cheap enough for the
 * outline heatmap. A node review propagates to the anchors it cites. Precedence:
 * reviewed > stale > unreviewed.
 */
export interface AnchorReview { code: ReviewState; logical: ReviewState; codeActor: "human" | "agent" | null; logicalActor: "human" | "agent" | null }

export async function anchorReviewMap(
  root: string,
  anchors: { id: string }[],
  nodes: { id: string; anchors: string[] }[],
  reviews: Review[],
): Promise<Map<string, AnchorReview>> {
  const nodeAnchors = new Map(nodes.map((n) => [n.id, n.anchors]));
  const reviewedAnchorIds = new Set<string>();
  for (const r of reviews) {
    if (r.target.kind === "anchor") reviewedAnchorIds.add(r.target.id);
    else for (const aid of nodeAnchors.get(r.target.id) ?? []) reviewedAnchorIds.add(aid);
  }
  const live = await liveHashes(root, reviewedAnchorIds);
  const isStale = (r: Review) => r.witnesses.some((w) => live.get(w.anchorId) !== w.bodyHash);
  type Cell = { state: ReviewState; actor: "human" | "agent" };
  const rank: Record<ReviewState, number> = { reviewed: 2, stale: 1, unreviewed: 0 };
  const code = new Map<string, Cell>();
  const logical = new Map<string, Cell>();
  // Higher-precedence state wins (reviewed > stale); among reviewed, a human review
  // beats an agent one (verified > checked), so the anchor reads at the best trust.
  const bump = (m: Map<string, Cell>, id: string, state: ReviewState, actor: "human" | "agent") => {
    const c = m.get(id);
    if (!c) { m.set(id, { state, actor }); return; }
    if (rank[state] > rank[c.state]) { c.state = state; c.actor = actor; }
    else if (state === c.state && state === "reviewed" && actor === "human") c.actor = "human";
  };
  for (const r of reviews) {
    const state: ReviewState = isStale(r) ? "stale" : "reviewed";
    const actor = r.actor ?? "agent"; // migration: legacy reviews read as agent-checked
    const m = r.level === "code" ? code : logical;
    if (r.target.kind === "anchor") bump(m, r.target.id, state, actor);
    else for (const aid of nodeAnchors.get(r.target.id) ?? []) bump(m, aid, state, actor);
  }
  const out = new Map<string, AnchorReview>();
  for (const a of anchors) {
    const c = code.get(a.id), l = logical.get(a.id);
    out.set(a.id, {
      code: c?.state ?? "unreviewed", logical: l?.state ?? "unreviewed",
      codeActor: c?.state === "reviewed" ? c.actor : null, logicalActor: l?.state === "reviewed" ? l.actor : null,
    });
  }
  return out;
}
