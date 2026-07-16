/**
 * Triage — the stakes of an anchor/node (blast radius if wrong), and the severity
 * that results from crossing stakes with the review attestation (viewed/signed).
 * See docs/triage.md. The ratchet: agents/graph may only *raise* stakes (as `likely`
 * proposals); only a human lowers a tier or confirms (drops `likely`).
 */

import { randomBytes } from "node:crypto";
import { type Importance, type TriageSource, type Triage, type BugSeverity } from "./schema.js";
import { readTriage, writeTriage, loadNodes, readGraph, readAnchorStore } from "./store.js";
import { reviewStatesFor, witnessesFor, liveHashes, witnessDrift, type Target, type ReviewPair, type AnchorChange } from "./reviews.js";

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
  if (existing && !human) {
    const raises = IMPORTANCE_RANK[input.importance] > IMPORTANCE_RANK[existing.importance];
    // Lowering is human-only — a demotion hides risk, so no automated source may do it.
    if (!raises) {
      return {
        ok: false,
        importance: existing.importance,
        reason: existing.source === "human" ? "human-owned — agents may only ESCALATE it, never lower" : "ratchet: agents/graph may only raise stakes",
      };
    }
    // Escalation only ever ADDS scrutiny, so it's allowed — an agent that finds a mis-flag
    // or code that grew teeth SHOULD propose higher (as a `likely` mark you re-confirm).
    // Exception: the *blind graph batch* respects a human mark (no new evidence, so it
    // won't nag); a code-change-driven re-escalation is the witnessed Phase-4 path.
    if (existing.source === "human" && input.source === "graph") {
      return { ok: false, importance: existing.importance, reason: "graph derivation won't override a human mark — an agent with evidence can escalate via `triage`" };
    }
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

// Attention rank for "what's the worst thing outstanding." Untriaged escalates to
// BC-until-looked-at, so it sits just under confirmed-critical; complete is 0.
const SEV_RANK: Record<Severity, number> = { complete: 0, low: 1, medium: 2, high: 3, untriaged: 4, critical: 5 };

export interface Coverage {
  total: number;
  complete: number; // severity === "complete" — meets its tier's bar
  outstanding: number; // total − complete — the review still owed
  completePct: number; // 0–100, 100 when total === 0
  bySeverity: Record<string, number>; // full distribution incl. complete + untriaged
  worst: Severity | null; // worst non-complete severity present (drives the headline)
}

/** Roll a set of triage infos into a coverage summary — the "am I done here?" number. */
export function rollupCoverage(infos: Iterable<TriageInfo>): Coverage {
  const bySeverity: Record<string, number> = {};
  let total = 0, complete = 0, worst: Severity | null = null;
  for (const t of infos) {
    total++;
    const sev = t.severity;
    bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
    if (sev === "complete") complete++;
    else if (!worst || SEV_RANK[sev] > SEV_RANK[worst]) worst = sev;
  }
  return { total, complete, outstanding: total - complete, completePct: total === 0 ? 100 : Math.round((complete / total) * 100), bySeverity, worst };
}

/** Coverage over a set of targets (their live severity), rolled up. */
export async function coverageFor(root: string, targets: Target[]): Promise<Coverage> {
  const m = await triageFor(root, targets);
  return rollupCoverage(m.values());
}

// ---------------------------------------------------------------------------
// Graph-derived stakes (Phase 2). The pipeline/event graph is a blast-radius
// oracle: what a node emits/is tells you its stakes far more reliably than an
// LLM guess. Everything derived is a `likely` proposal (source `graph`) a human
// confirms or overrides; the pass is regenerable (clears prior graph marks,
// leaves human/agent marks) — the same discipline as analyzer-generated nodes.
// ---------------------------------------------------------------------------

// Money/value signal — a strong business-critical cue that's codebase-agnostic. Word
// boundaries so "feel" ≠ "fee". Recorded as the reason, so it's auditable/confirmable.
const MONEY_RX = /\b(amount|currenc|balance|payment|payout|settle|settlement|debit|credit|fee|fees|transfer|price|total|money|refund|charge|invoice|ledger|remit|disburse|wallet|deposit|withdraw)\w*/i;

const key = (kind: "node" | "anchor", id: string) => `${kind}:${id}`;

/**
 * Structural stakes for one node from the graph alone (no name heuristics):
 * emitting a domain event or being a command/handler/aggregate/event is the
 * business-logic spine (`important`); a projection is a read-model (`mechanical`).
 */
function structuralImportance(type: string, emitsEvent: boolean): { importance: Importance; reason: string } | null {
  if (emitsEvent) return { importance: "important", reason: "emits a domain event" };
  if (type === "command" || type === "handler" || type === "aggregate" || type === "event_family")
    return { importance: "important", reason: `${type} — domain core` };
  if (type === "projection") return { importance: "mechanical", reason: "projection (read model)" };
  return null;
}

/**
 * Derive `likely` stakes across the graph. Money-name → business-critical; structural
 * spine → important; projection → mechanical; then proximity (an untriaged node sharing
 * a top-namespace with a derived important/BC node inherits `important`); then anchors
 * inherit the max stakes of their citing nodes. Never overrides a human mark, only
 * raises over an existing agent mark.
 */
export async function deriveTriage(root: string): Promise<{ derived: number; byImportance: Record<string, number>; escalated: number }> {
  const [nodes, graph, store, ts] = await Promise.all([loadNodes(root), readGraph(root), readAnchorStore(root), readTriage(root)]);
  const nsById = new Map(store.anchors.map((a) => [a.id, a.symbolPath[0]]));
  const symById = new Map(store.anchors.map((a) => [a.id, a.symbolPath.join(".")]));
  const nodeAnchors = new Map(nodes.map((n) => [n.id, n.anchors]));
  const emitters = new Set<string>();
  for (const e of graph.edges) if (e.type === "emits") emitters.add(e.from);

  // Live hashes for every anchor → witness the derived marks (re-triage-on-change) and
  // detect which existing HUMAN marks cover code that has since drifted.
  const live = await liveHashes(root, store.anchors.map((a) => a.id));
  const witnessesOf = (kind: "node" | "anchor", id: string) =>
    (kind === "anchor" ? [id] : nodeAnchors.get(id) ?? []).map((aid) => ({ anchorId: aid, bodyHash: live.get(aid) ?? "sha256:absent" }));
  const humanDrifted = new Set<string>();
  for (const t of ts.triage) if (t.source === "human" && witnessDrift(t.witnesses, live).length) humanDrifted.add(key(t.target.kind, t.target.id));

  // Start from the marks we keep (human + agent proposals); graph marks are regenerated.
  const result = new Map<string, Triage>();
  for (const t of ts.triage) if (t.source !== "graph") result.set(key(t.target.kind, t.target.id), t);

  const at = new Date().toISOString();
  let escalated = 0;
  const graphMark = (kind: "node" | "anchor", id: string, importance: Importance, reason: string) => {
    const k = key(kind, id);
    const ex = result.get(k);
    let note = reason;
    if (ex) {
      if (IMPORTANCE_RANK[importance] <= IMPORTANCE_RANK[ex.importance]) return; // ratchet: raise-only
      if (ex.source === "human") {
        // A human mark is authoritative UNLESS its code drifted since they set it —
        // then a higher derivation is a legitimate re-escalation ("grew teeth"): it
        // re-enters the confirm queue rather than silently overriding their judgement.
        if (!humanDrifted.has(k)) return;
        note = `${reason} (code changed since you triaged — re-confirm)`;
        escalated++;
      }
    }
    result.set(k, { target: { kind, id }, importance, likely: true, source: "graph", reason: note, at, witnesses: witnessesOf(kind, id) });
  };

  const nodeMoney = (n: { title: string; summary?: string; anchors: string[] }) =>
    MONEY_RX.test(`${n.title} ${n.summary ?? ""} ${n.anchors.map((a) => symById.get(a) ?? "").join(" ")}`);

  // Pass 1: per-node money + structural signals.
  for (const n of nodes) {
    if (nodeMoney(n)) graphMark("node", n.id, "business-critical", "handles money/value");
    else {
      const s = structuralImportance(n.type, emitters.has(n.id));
      if (s) graphMark("node", n.id, s.importance, s.reason);
    }
  }

  // Pass 2: proximity — a node's dominant top-namespace; if that namespace holds any
  // derived important/BC node, untriaged nodes there inherit `important` (guilty by
  // neighborhood until read). Never raises above what pass 1 set.
  const nodeNs = (n: { anchors: string[] }): string | undefined => {
    const tally = new Map<string, number>();
    for (const a of n.anchors) { const ns = nsById.get(a); if (ns) tally.set(ns, (tally.get(ns) ?? 0) + 1); }
    return [...tally.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
  };
  const hotNs = new Set<string>();
  for (const n of nodes) {
    const imp = result.get(key("node", n.id))?.importance;
    if (imp && imp !== "mechanical") { const ns = nodeNs(n); if (ns) hotNs.add(ns); }
  }
  for (const n of nodes) {
    if (result.has(key("node", n.id))) continue; // already has a stake
    const ns = nodeNs(n);
    if (ns && hotNs.has(ns)) graphMark("node", n.id, "important", "in a high-stakes module");
  }

  // Pass 3: anchors inherit the max stakes among their citing nodes.
  const citingImp = new Map<string, Importance>();
  for (const n of nodes) {
    const imp = result.get(key("node", n.id))?.importance;
    if (!imp) continue;
    for (const aid of n.anchors) {
      const cur = citingImp.get(aid);
      if (!cur || IMPORTANCE_RANK[imp] > IMPORTANCE_RANK[cur]) citingImp.set(aid, imp);
    }
  }
  for (const [aid, imp] of citingImp) graphMark("anchor", aid, imp, "inherited from a citing node");

  const triage = [...result.values()];
  await writeTriage(root, triage);
  const byImportance = triage.reduce<Record<string, number>>((m, t) => ((m[t.importance] = (m[t.importance] ?? 0) + 1), m), {});
  const derived = triage.filter((t) => t.source === "graph").length;
  return { derived, byImportance, escalated };
}

// ---------------------------------------------------------------------------
// Tripwire + re-triage-on-change (Phase 4). Every triage mark witnesses the code
// it covered; when that code drifts the mark is a re-triage candidate, and if the
// mark is a tripwire it has *fired* — "tell me the instant this moves."
// ---------------------------------------------------------------------------

export interface TriageDrift {
  target: { kind: "node" | "anchor"; id: string };
  importance: Importance;
  source: TriageSource;
  tripwire: boolean;
  reason?: string;
  drift: AnchorChange[]; // which covered anchors moved since the mark was set
}

/** Triage marks whose witnessed code has drifted — candidates for re-triage. */
export async function triageDrift(root: string): Promise<TriageDrift[]> {
  const ts = await readTriage(root);
  const ids = new Set<string>();
  for (const t of ts.triage) for (const w of t.witnesses) ids.add(w.anchorId);
  const live = await liveHashes(root, ids);
  const out: TriageDrift[] = [];
  for (const t of ts.triage) {
    const drift = witnessDrift(t.witnesses, live);
    if (drift.length) out.push({ target: t.target, importance: t.importance, source: t.source, tripwire: !!t.tripwire, reason: t.reason, drift });
  }
  return out;
}

/**
 * Tripwires: marks armed with `tripwire`. `fired` = its code has moved since arming
 * ("tell me it changed"); `armed` = the full watch list. The alert surface behind
 * "page me the instant this business-critical code moves, even after I've signed it."
 */
export async function tripwires(root: string): Promise<{ fired: TriageDrift[]; armedCount: number }> {
  const ts = await readTriage(root);
  const armedCount = ts.triage.filter((t) => t.tripwire).length;
  const drift = await triageDrift(root);
  return { fired: drift.filter((d) => d.tripwire), armedCount };
}
