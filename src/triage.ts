/**
 * Triage — the stakes of an anchor/node (blast radius if wrong), and the severity
 * that results from crossing stakes with the review attestation (viewed/signed).
 * See docs/triage.md. The ratchet: agents/graph may only *raise* stakes (as `likely`
 * proposals); only a human lowers a tier or confirms (drops `likely`).
 */

import { randomBytes } from "node:crypto";
import { type Importance, type TriageSource, type Triage, type BugSeverity } from "./schema.js";
import { readTriage, writeTriage } from "./store.js";
import { reviewStatesFor, witnessesFor, type Target, type ReviewPair } from "./reviews.js";

export const IMPORTANCE_RANK: Record<Importance, number> = { mechanical: 0, important: 1, "business-critical": 2 };

/** `complete` = meets the tier's bar; `untriaged` = no stakes assigned yet (escalates). */
export type Severity = BugSeverity | "complete" | "untriaged";

/**
 * The severity matrix (docs/triage.md). `read` = a live `viewed` OR `signed` mark
 * (signing implies having read); `signed` = a live sign-off. Stale marks are absent.
 *   - Mechanical needs only a read; sign-off is never required.
 *   - Important / Business Critical need a sign-off; unread outranks read-but-unsigned.
 */
export function triageSeverity(importance: Importance, live: { read: boolean; signed: boolean }): BugSeverity | "complete" {
  if (importance === "mechanical") return live.read ? "complete" : "low";
  if (live.signed) return "complete";
  const bc = importance === "business-critical";
  if (live.read) return bc ? "high" : "medium"; // read but unsigned
  return bc ? "critical" : "high"; // unread — the blind spot
}

/** The attestation a target must reach to be review-complete at its tier. */
export function barFor(importance: Importance): "viewed" | "signed" {
  return importance === "mechanical" ? "viewed" : "signed";
}

const sameTarget = (t: Triage, k: "node" | "anchor", id: string) => t.target.kind === k && t.target.id === id;

/**
 * Set (or raise) the stakes of a target, enforcing the ratchet. A human source has
 * full control (raise, lower, confirm); an agent/graph source may only raise an
 * existing tier and always writes a `likely` proposal. `ok:false` = ratchet refusal.
 */
export async function setTriage(
  root: string,
  input: {
    targetKind: "node" | "anchor";
    targetId: string;
    importance: Importance;
    source: TriageSource;
    reason?: string;
    tripwire?: boolean;
    generatedBy?: string;
  },
): Promise<{ ok: boolean; importance: Importance; likely?: boolean; reason?: string }> {
  const ts = await readTriage(root);
  const existing = ts.triage.find((t) => sameTarget(t, input.targetKind, input.targetId));
  const human = input.source === "human";
  if (existing && !human && IMPORTANCE_RANK[input.importance] <= IMPORTANCE_RANK[existing.importance]) {
    // Ratchet: a non-human source can only *raise* stakes, never lower or equal-downgrade.
    return { ok: false, importance: existing.importance, reason: "ratchet: agents/graph may only raise stakes; a human must lower" };
  }
  const target: Target = { kind: input.targetKind, id: input.targetId };
  const rec: Triage = {
    target,
    importance: input.importance,
    likely: !human, // a human sets a confirmed tier; agents/graph propose
    tripwire: input.tripwire ?? existing?.tripwire,
    source: input.source,
    generatedBy: input.generatedBy ?? (human ? undefined : existing?.generatedBy),
    reason: input.reason ?? existing?.reason,
    at: new Date().toISOString(),
    witnesses: await witnessesFor(root, target),
  };
  ts.triage = ts.triage.filter((t) => !sameTarget(t, input.targetKind, input.targetId)).concat(rec);
  await writeTriage(root, ts.triage);
  return { ok: true, importance: rec.importance, likely: rec.likely };
}

/** Remove a target's triage (back to untriaged). Human-only in practice — it lowers. */
export async function clearTriage(root: string, input: { targetKind: "node" | "anchor"; targetId: string }) {
  const ts = await readTriage(root);
  const before = ts.triage.length;
  ts.triage = ts.triage.filter((t) => !sameTarget(t, input.targetKind, input.targetId));
  await writeTriage(root, ts.triage);
  return { ok: true, removed: before - ts.triage.length };
}

export interface TriageInfo {
  importance: Importance | null; // null = untriaged
  likely: boolean;
  source?: TriageSource;
  reason?: string;
  tripwire?: boolean;
  severity: Severity;
  /** Attestation still needed to reach `complete` (null once complete/untriaged). */
  bar: "viewed" | "signed" | null;
}

const isLive = (p?: ReviewPair) => Boolean(p && p.code.state === "reviewed");

/** The vouch, the viewed marks, and triage/severity for a target — all from one batch. */
export interface ReviewTriage {
  review: ReviewPair; // vouch (signed/checked)
  viewed: ReviewPair; // exposure marks
  triage: TriageInfo;
}

const emptyPair = (): ReviewPair => ({ logical: { state: "unreviewed" }, code: { state: "unreviewed" } });

/**
 * Review state (vouch + viewed) *and* triage severity for many targets, in a single
 * set of passes. The one enrichment primitive every review surface uses, so they all
 * speak the same language (attestation + stakes).
 */
export async function reviewTriageFor(root: string, targets: Target[]): Promise<Map<string, ReviewTriage>> {
  const [ts, vouch, viewed] = await Promise.all([
    readTriage(root),
    reviewStatesFor(root, targets),
    reviewStatesFor(root, targets, { viewed: true }),
  ]);
  const byTarget = new Map(ts.triage.map((t) => [`${t.target.kind}:${t.target.id}`, t]));
  const out = new Map<string, ReviewTriage>();
  for (const t of targets) {
    const k = `${t.kind}:${t.id}`;
    const vp = vouch.get(k) ?? emptyPair();
    const vw = viewed.get(k) ?? emptyPair();
    const tri = byTarget.get(k);
    const signed = isLive(vp); // a live sign-off/checked at code level
    const read = signed || isLive(vw); // signing implies reading
    let triage: TriageInfo;
    if (!tri) {
      triage = { importance: null, likely: false, severity: "untriaged", bar: null };
    } else {
      const sev = triageSeverity(tri.importance, { read, signed });
      triage = {
        importance: tri.importance,
        likely: tri.likely,
        source: tri.source,
        reason: tri.reason,
        tripwire: tri.tripwire,
        severity: sev,
        bar: sev === "complete" ? null : barFor(tri.importance),
      };
    }
    out.set(k, { review: vp, viewed: vw, triage });
  }
  return out;
}

/** Triage + severity for many targets (derives from `reviewTriageFor`). */
export async function triageFor(root: string, targets: Target[]): Promise<Map<string, TriageInfo>> {
  const m = await reviewTriageFor(root, targets);
  return new Map([...m].map(([k, v]) => [k, v.triage]));
}

export async function triageStatus(root: string, target: Target): Promise<TriageInfo> {
  return (await triageFor(root, [target])).get(`${target.kind}:${target.id}`)!;
}
