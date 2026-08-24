/**
 * Triage — the stakes of an anchor/node (blast radius if wrong), and the severity
 * that results from crossing stakes with the review attestation (viewed/signed).
 * See docs/triage.md. The ratchet: agents/graph may only *raise* stakes (as `likely`
 * proposals); only a human lowers a tier or confirms (drops `likely`).
 */

import { randomBytes } from "node:crypto";
import { type Importance, type Complexity, type TriageSource, type Triage, type BugSeverity } from "./schema.js";
import { readTriage, readLocalTriage, replaceLocalTriage, replaceLocalGraphTriage, upsertLocalTriage, loadNodes, readGraph, readAnchorStore } from "./store.js";
import { reviewStatesFor, witnessesFor, liveHashes, witnessDrift, realDrift, deriveCodeReview, type Target, type ReviewPair, type AnchorChange } from "./reviews.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { indexFile } from "./repo.js";
import { headCommit } from "./git.js";
import { resolveSidecar } from "./sidecar-config.js";
// The pure rules live one layer down so the shared fold can replay through the SAME
// ratchet without importing this module — see `triage-rules.ts`. Re-exported, because
// every existing caller imports them from here.
import { IMPORTANCE_RANK, COMPLEXITY_RANK, DEFAULT_COMPLEXITY, normImportance, ratchet } from "./triage-rules.js";
export { IMPORTANCE_RANK, COMPLEXITY_RANK, DEFAULT_COMPLEXITY, normImportance, ratchet } from "./triage-rules.js";
// The publish half. A LEAF on purpose — it holds the fold and the projection and never
// the op surface, because reaching `ops-shared.ts` from here closes an import cycle by
// four different routes. See the note at the top of `triage-publish.ts`.
import { mirrorTriage, mirrorTriageBatch, mirrorTriageClear } from "./triage-publish.js";

/** `complete` = meets the tier's bar; `untriaged` = no stakes assigned yet (escalates). */
export type Severity = BugSeverity | "complete" | "untriaged";

const SEV_ORDER: BugSeverity[] = ["low", "medium", "high", "critical"];
// docs/triage.md — severity = stakes × complexity × review-gap. Two lookup tables
// (unread / read-but-unsigned) are the authority; a floor keeps stakes visible.
const UNREAD: Record<Importance, Record<Complexity, BugSeverity>> = {
  "business-critical": { deep: "critical", standard: "high", rote: "medium", wiring: "low" },
  important: { deep: "high", standard: "medium", rote: "low", wiring: "low" },
  low: { deep: "medium", standard: "low", rote: "low", wiring: "low" },
};
const READ_UNSIGNED: Record<Importance, Record<Complexity, BugSeverity>> = {
  "business-critical": { deep: "high", standard: "medium", rote: "low", wiring: "low" },
  important: { deep: "medium", standard: "low", rote: "low", wiring: "low" },
  low: { deep: "low", standard: "low", rote: "low", wiring: "low" },
};

/**
 * Severity from stakes × complexity × review-gap (docs/triage.md). `read` = a live
 * `viewed` OR `signed` mark (signing implies reading); `signed` = a live sign-off.
 * Complexity sets the bar — `wiring` clears on a glance (viewed), everything else needs
 * a sign-off — and weights how much review depth the gap represents. Floor: while any
 * gap remains, business-critical/important never rank below `medium` (a stake you've
 * left unreviewed always deserves attention, even if it's quick to clear).
 */
export function triageSeverity(
  importance: Importance,
  complexity: Complexity,
  live: { read: boolean; signed: boolean },
): BugSeverity | "complete" {
  if (live.signed) return "complete";
  if (barFor(complexity) === "viewed" && live.read) return "complete"; // wiring: a glance is enough
  let sev = (live.read ? READ_UNSIGNED : UNREAD)[importance][complexity];
  if ((importance === "business-critical" || importance === "important") && SEV_ORDER.indexOf(sev) < SEV_ORDER.indexOf("medium")) {
    sev = "medium";
  }
  return sev;
}

/** The attestation a target must reach to be review-complete — driven by complexity. */
export function barFor(complexity: Complexity): "viewed" | "signed" {
  return complexity === "wiring" ? "viewed" : "signed";
}

/** Verification-difficulty from code shape — a cheap cyclomatic-ish proxy (decision
 * points). Marked `likely`; a human confirms/adjusts. `deep` subtle · `wiring` plumbing. */
export function complexityOf(code: string): Complexity {
  if (!code) return DEFAULT_COMPLEXITY;
  const decisions =
    (code.match(/\b(if|for|foreach|while|case|catch|switch)\b/gi) || []).length +
    (code.match(/&&|\|\||\?\?/g) || []).length;
  if (decisions === 0) return "wiring";
  if (decisions <= 2) return "rote";
  if (decisions <= 6) return "standard";
  return "deep";
}

const sameTarget = (t: Triage, k: "node" | "anchor", id: string) => t.target.kind === k && t.target.id === id;

/**
 * Set (or raise) the stakes of a target, enforcing the ratchet. A human source has
 * full control (raise, lower, confirm); an agent/graph source may only raise an
 * existing tier and always writes a `likely` proposal. `ok:false` = ratchet refusal.
 */
export interface TriageInput {
  targetKind: "node" | "anchor";
  targetId: string;
  importance?: Importance; // omit to set complexity alone (keeps existing stakes)
  complexity?: Complexity;
  source: TriageSource;
  reason?: string;
  tripwire?: boolean;
  generatedBy?: string;
  /** Witness the mark against this commit instead of the working tree (a PR head). */
  ref?: string;
}

/**
 * One message for the one failure a caller has to act on, with the cause kept.
 *
 * The raw cause alone is what this returned first, and it reads as an unrelated
 * filesystem error (`EEXIST: file already exists, mkdir ...`) with nothing tying it to
 * the sidecar or saying the mark was not stored.
 */
const appendFailed = (cause?: string): string =>
  "the mark could not be appended to the sidecar log, so NOTHING was written — "
  + `fix the sidecar and set it again${cause ? ` (${cause})` : ""}`;

export async function setTriage(
  root: string,
  input: TriageInput,
  // `importance` is absent only on a refusal with nothing on record — there is no
  // mark to report, and inventing one here is the very thing being refused.
): Promise<{ ok: boolean; importance?: Importance; complexity?: Complexity; likely?: boolean; reason?: string }> {
  const ts = await readTriage(root);
  const existing = ts.triage.find((t) => sameTarget(t, input.targetKind, input.targetId));
  const human = input.source === "human";
  const decision = ratchet(existing, input);
  if (decision && "refused" in decision) {
    // `existing` may be absent: a signal-free agent input is refused with nothing on
    // record, and reporting the refusal must not depend on there being a prior mark.
    return existing
      ? { ok: false, importance: normImportance(existing.importance), complexity: existing.complexity, reason: decision.refused }
      : { ok: false, reason: decision.refused };
  }
  const { importance, complexity } = decision!;
  const target: Target = { kind: input.targetKind, id: input.targetId };
  const rec: Triage = {
    target,
    importance,
    complexity,
    likely: !human, // a human sets a confirmed tier; agents/graph propose
    tripwire: input.tripwire ?? existing?.tripwire,
    source: input.source,
    generatedBy: input.generatedBy ?? (human ? undefined : existing?.generatedBy),
    reason: input.reason ?? existing?.reason,
    at: new Date().toISOString(),
    witnesses: await witnessesFor(root, target, input.ref),
  };
  // Where the mark GOES. The ratchet decided against the MERGED value above — that is
  // what makes "agents may only raise" mean anything once a teammate's mark exists —
  // and the destination follows from whether this universe has a sidecar.
  //
  // With one, the mark is an EVENT: the log is authoritative for shared state, and a
  // local row alongside it would be a second copy that no supersession can ever reach
  // (see `readTriage`). Without one — or if publishing fails — it is a local row,
  // exactly as it has always been. A mark must never be lost because a shared repo is
  // missing, so the fallback is the old path and not an error.
  //
  // `graph` never travels: it is regenerated per machine by `deriveTriage`.
  const shared = input.source === "graph" ? { shared: false as const } : await mirror(root, rec, input);
  // NO LOCAL FALLBACK when a sidecar is configured, and this is the rule rather than an
  // omission. A row written here is published LATER, and `emitEvents` captures the
  // causal heads at APPEND time — so the event would claim this act had seen everything
  // pulled between the failure and the publish. That is the "reconstructed events
  // falsely claim to have seen everything just pulled" defect `sidecar-architecture.md`
  // bans, arriving by a slower route. Causal position is only true at the moment of the
  // write; an uncaptured one is not a fact anyone holds, it is gone.
  //
  // The sidecar is a LOCAL clone — nothing touches the network until `sync` — so a
  // failed append is a real local failure (a bad path, a disk, an unresolvable actor),
  // not a blip to paper over. Failing loudly is the honest answer and the caller can
  // retry. Without a sidecar the local row is still the whole story, exactly as before.
  if (shared.configured && !shared.shared) {
    return { ok: false, reason: appendFailed(shared.error) };
  }
  if (!shared.shared) await upsertLocalTriage(root, rec);
  return {
    ok: true, importance: rec.importance, complexity: rec.complexity, likely: rec.likely,
    ...(shared.shared ? { shared: true } : {}),
  };
}

/**
 * Publish a mark, when there is a sidecar to publish it to.
 *
 * A throw here must not fail a write that is about to succeed locally: the caller falls
 * back to a local row, which is what codemap did for its whole life before the sidecar.
 */
async function mirror(root: string, rec: Triage, input: TriageInput): Promise<{ shared: boolean; configured?: boolean; error?: string }> {
  try {
    return await mirrorTriage(root, {
      targetKind: rec.target.kind, targetId: rec.target.id,
      importance: rec.importance, complexity: rec.complexity,
      // Only when the caller SET it. An omitted field means "did not touch", and an
      // invented `false` is an alarm silently turned off.
      ...(input.tripwire !== undefined ? { tripwire: input.tripwire } : {}),
      source: rec.source === "human" ? "human" : "agent",
      reason: rec.reason,
      assertedCommit: input.ref ?? headCommit(root) ?? undefined,
      witnesses: rec.witnesses,
    });
  } catch (e: any) {
    // A throw with a sidecar configured is a FAILED APPEND, and the caller must not
    // paper over it — `mirrorTriage` only reaches the log once it has resolved one.
    return { shared: false, configured: !!resolveSidecar(root), error: e?.message ?? String(e) };
  }
}

/**
 * Remove a target's triage (back to untriaged). Human-only in practice — it lowers.
 *
 * LOCAL rows only. Filtering the merged list and rewriting it would do two wrong things
 * at once: it would not remove a teammate's mark (the next merged read returns it), and
 * it would copy every OTHER teammate's mark into this clone's partition on the way past.
 * Clearing a shared mark is an append — `triage.cleared` — and is not built yet.
 */
export async function clearTriage(root: string, input: { targetKind: "node" | "anchor"; targetId: string }) {
  const ts = await readLocalTriage(root);
  const kept = ts.triage.filter((t) => !sameTarget(t, input.targetKind, input.targetId));
  const removed = ts.triage.length - kept.length;
  if (removed) await replaceLocalTriage(root, kept);
  // And the shared half, which cannot be a deletion: the log is append-only and NO LOSS
  // forbids removing an event once observed, so a clear is an appended `triage.cleared`
  // carrying an explicit `present: false`. Encoded as an absent importance it would be
  // indistinguishable from an event that simply did not mention the field.
  const shared = await mirrorTriageClear(root, input)
    .catch(() => ({ shared: false }) as { shared: boolean; error?: string });
  return {
    ok: true, removed,
    ...(shared.shared ? { shared: true } : {}),
    ...(shared.error ? { note: shared.error } : {}),
  };
}

export interface TriageInfo {
  importance: Importance | null; // null = untriaged (stakes)
  complexity?: Complexity; // verification difficulty (review depth)
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
 *
 * A node's *code* attestation is **derived from the anchors it cites** (`deriveCodeReview`)
 * — there is no `node`+`code` review row to find, because signing a node vouches for the
 * doc, never for code you never opened. Reading the raw row here would pin every node at
 * `signed:false` forever, so the whole map could never leave 0% review-complete.
 */
export async function reviewTriageFor(root: string, targets: Target[], opts: { ref?: string } = {}): Promise<Map<string, ReviewTriage>> {
  // Node targets need their cited anchors' code reviews too — batch them into the same
  // passes (reviewStatesFor re-indexes each file once, so widening the list is cheap).
  const nodeTargets = targets.filter((t) => t.kind === "node");
  const [nodes, present] = nodeTargets.length
    ? await Promise.all([loadNodes(root), readAnchorStore(root).then((s) => new Set(s.anchors.map((a) => a.id)))])
    : [[], new Set<string>()];
  // Missing anchors are excluded from the denominator — a lost anchor is a `dangling`
  // status, not an un-completable review (matches `getNode`).
  const citedBy = new Map(nodeTargets.map((t) => [t.id, (nodes.find((n) => n.id === t.id)?.anchors ?? []).filter((a) => present.has(a))]));
  const seen = new Set(targets.map((t) => `${t.kind}:${t.id}`));
  const extra: Target[] = [];
  for (const ids of citedBy.values()) {
    for (const id of ids) if (!seen.has(`anchor:${id}`)) { seen.add(`anchor:${id}`); extra.push({ kind: "anchor", id }); }
  }
  const all = extra.length ? [...targets, ...extra] : targets;
  const [ts, vouch, viewed] = await Promise.all([
    readTriage(root),
    reviewStatesFor(root, all, { ref: opts.ref }),
    reviewStatesFor(root, all, { viewed: true, ref: opts.ref }),
  ]);
  const byTarget = new Map(ts.triage.map((t) => [`${t.target.kind}:${t.target.id}`, t]));
  const out = new Map<string, ReviewTriage>();
  for (const t of targets) {
    const k = `${t.kind}:${t.id}`;
    let vp = vouch.get(k) ?? emptyPair();
    let vw = viewed.get(k) ?? emptyPair();
    if (t.kind === "node") {
      const cited = citedBy.get(t.id) ?? [];
      const codeOf = (m: Map<string, ReviewPair>, id: string) => m.get(`anchor:${id}`)?.code ?? { state: "unreviewed" as const };
      const sign = deriveCodeReview(cited.map((id) => codeOf(vouch, id)));
      // Exposure per segment is "signed OR viewed" — signing implies reading, so a node
      // half-signed / half-viewed still reads as fully looked at.
      const look = deriveCodeReview(cited.map((id) => {
        const s = codeOf(vouch, id);
        return s.state === "reviewed" ? s : codeOf(viewed, id);
      }));
      vp = { logical: vp.logical, code: { state: sign.state, actor: sign.actor ?? undefined } };
      vw = { logical: vw.logical, code: look.state === "unreviewed" ? vw.code : { state: look.state, actor: look.actor ?? undefined } };
    }
    const tri = byTarget.get(k);
    const signed = isLive(vp); // a live sign-off/checked at code level
    const read = signed || isLive(vw); // signing implies reading
    let triage: TriageInfo;
    if (!tri) {
      // Untriaged escalates *while a gap remains* — but a live sign-off clears the bar
      // (DEFAULT_COMPLEXITY `standard` → `signed`) whatever the stakes turn out to be,
      // so reviewed-but-unclassified code isn't stuck outstanding forever.
      triage = signed
        ? { importance: null, likely: false, severity: "complete", bar: null }
        : { importance: null, likely: false, severity: "untriaged", bar: null };
    } else {
      const importance = normImportance(tri.importance);
      const complexity = tri.complexity ?? DEFAULT_COMPLEXITY;
      const sev = triageSeverity(importance, complexity, { read, signed });
      triage = {
        importance,
        complexity: tri.complexity,
        likely: tri.likely,
        source: tri.source,
        reason: tri.reason,
        tripwire: tri.tripwire,
        severity: sev,
        bar: sev === "complete" ? null : barFor(complexity),
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
/** Name-shaped money signal — also used to rank PR anchors in universes with no graph yet. */
export const MONEY_RX = /\b(amount|currenc|balance|payment|payout|settle|settlement|debit|credit|fee|fees|transfer|price|total|money|refund|charge|invoice|ledger|remit|disburse|wallet|deposit|withdraw)\w*/i;

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
  if (type === "projection") return { importance: "low", reason: "projection (read model)" };
  return null;
}

/**
 * Derive `likely` stakes AND complexity across the graph. Stakes: money-name →
 * business-critical; structural spine → important; projection → low; proximity;
 * anchors inherit the max stakes of citing nodes. Complexity: read off each anchor's
 * live source (cyclomatic-ish, `complexityOf`) — a node takes its meatiest anchor's.
 * Raise-only ratchet per axis; never overrides a human mark (unless its code drifted).
 */
export async function deriveTriage(root: string): Promise<{ derived: number; byImportance: Record<string, number>; escalated: number }> {
  const [nodes, graph, store, ts] = await Promise.all([loadNodes(root), readGraph(root), readAnchorStore(root), readTriage(root)]);
  const nsById = new Map(store.anchors.map((a) => [a.id, a.symbolPath[0]]));
  const symById = new Map(store.anchors.map((a) => [a.id, a.symbolPath.join(".")]));
  const nodeAnchors = new Map(nodes.map((n) => [n.id, n.anchors]));
  const emitters = new Set<string>();
  for (const e of graph.edges) if (e.type === "emits") emitters.add(e.from);

  // Per-anchor complexity from live source (cyclomatic-ish). Read+index each file once.
  const anchorCx = new Map<string, Complexity>();
  const files = [...new Set(store.anchors.map((a) => a.file))];
  // Sequential on purpose. web-tree-sitter hands out one parser per grammar, and
  // parsing concurrently on it aborts the WASM instance — a `Promise.all` over
  // every file died with a flood of `Aborted()` on a 1200-file repo, taking the
  // whole derive with it. `indexRepo`/`indexCommit` walk sequentially for the
  // same reason; the cost is a couple of seconds, not a timeout.
  for (const f of files) {
    try {
      const src = await readFile(join(root, f), "utf8");
      for (const a of await indexFile(join(root, f), f)) {
        if (a.loc) anchorCx.set(a.id, complexityOf(src.slice(a.loc.startByte, a.loc.endByte)));
      }
    } catch { /* file gone */ }
  }
  const nodeCx = (anchors: string[]): Complexity | undefined => {
    let best: Complexity | undefined;
    for (const aid of anchors) { const c = anchorCx.get(aid); if (c && (best === undefined || COMPLEXITY_RANK[c] > COMPLEXITY_RANK[best])) best = c; }
    return best;
  };

  // Live hashes for every anchor → witness the derived marks (re-triage-on-change) and
  // detect which existing HUMAN marks cover code that has since drifted.
  const live = await liveHashes(root, store.anchors.map((a) => a.id));
  const witnessesOf = (kind: "node" | "anchor", id: string) =>
    (kind === "anchor" ? [id] : nodeAnchors.get(id) ?? []).map((aid) => ({ anchorId: aid, bodyHash: live.get(aid) ?? "sha256:absent" }));
  const humanDrifted = new Set<string>();
  // `realDrift`: a witness minted under an older HASH_SCHEME is not evidence a human's
  // mark went stale, and treating it as such would re-escalate every human mark in the
  // store the first time normalization changes.
  for (const t of ts.triage) if (t.source === "human" && realDrift(witnessDrift(t.witnesses, live)).length) humanDrifted.add(key(t.target.kind, t.target.id));

  // Start from the marks we keep (human + agent proposals); graph marks are regenerated.
  const result = new Map<string, Triage>();
  for (const t of ts.triage) if (t.source !== "graph") result.set(key(t.target.kind, t.target.id), t);

  const at = new Date().toISOString();
  let escalated = 0;
  // Raise-only on BOTH axes, via the SHARED `ratchet` — this used to be a third
  // hand-written copy, and it still carried the absent-complexity hole that the
  // shared one had already closed: against a human's business-critical mark with no
  // complexity recorded, a derived `wiring` counted as a raise and dropped the bar
  // from `signed` to `viewed` with no human involved.
  const graphMark = (kind: "node" | "anchor", id: string, importance: Importance, complexity: Complexity | undefined, reason: string) => {
    const k = key(kind, id);
    const ex = result.get(k);
    const overHuman = ex?.source === "human";
    const d = ratchet(ex, { importance, complexity, source: "graph" }, { humanDrifted: overHuman && humanDrifted.has(k) });
    if ("refused" in d) return;
    // A human mark is authoritative UNLESS its code drifted since they set it —
    // then a higher derivation re-enters the confirm queue rather than silently
    // overriding their judgement.
    let note = reason;
    if (overHuman) { note = `${reason} (code changed since you triaged — re-confirm)`; escalated++; }
    result.set(k, { target: { kind, id }, importance: d.importance, complexity: d.complexity, likely: true, source: "graph", reason: note, at, witnesses: witnessesOf(kind, id) });
  };

  const nodeMoney = (n: { title: string; summary?: string; anchors: string[] }) =>
    MONEY_RX.test(`${n.title} ${n.summary ?? ""} ${n.anchors.map((a) => symById.get(a) ?? "").join(" ")}`);

  // Pass 1: per-node money + structural signals. Complexity = the node's meatiest anchor.
  for (const n of nodes) {
    if (nodeMoney(n)) graphMark("node", n.id, "business-critical", nodeCx(n.anchors), "handles money/value");
    else {
      const s = structuralImportance(n.type, emitters.has(n.id));
      if (s) graphMark("node", n.id, s.importance, nodeCx(n.anchors), s.reason);
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
    if (imp && normImportance(imp) !== "low") { const ns = nodeNs(n); if (ns) hotNs.add(ns); }
  }
  for (const n of nodes) {
    if (result.has(key("node", n.id))) continue; // already has a stake
    const ns = nodeNs(n);
    if (ns && hotNs.has(ns)) graphMark("node", n.id, "important", nodeCx(n.anchors), "in a high-stakes module");
  }

  // Pass 3: anchors inherit the max stakes among their citing nodes; complexity is their own.
  const citingImp = new Map<string, Importance>();
  for (const n of nodes) {
    const imp = result.get(key("node", n.id))?.importance;
    if (!imp) continue;
    const ni = normImportance(imp);
    for (const aid of n.anchors) {
      const cur = citingImp.get(aid);
      if (!cur || IMPORTANCE_RANK[ni] > IMPORTANCE_RANK[cur]) citingImp.set(aid, ni);
    }
  }
  for (const [aid, imp] of citingImp) graphMark("anchor", aid, imp, anchorCx.get(aid), "inherited from a citing node");

  const triage = [...result.values()];
  // GRAPH rows only. `result` was seeded from the MERGED view so the ratchet could judge
  // against a teammate's stakes, and writing it whole would copy their mark into this
  // clone's partition — where the next fold produces it again alongside. `graphMark` is
  // the only thing that mutates `result`, and it only ever writes `source: "graph"`, so
  // everything else in here is already in the table untouched.
  await replaceLocalGraphTriage(root, triage);
  const byImportance = triage.reduce<Record<string, number>>((m, t) => ((m[normImportance(t.importance)] = (m[normImportance(t.importance)] ?? 0) + 1), m), {});
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
    // The re-triage worklist and the tripwire both mean "this code moved", so an
    // unverifiable witness must not appear here — it means "this hash is old", which
    // a re-index fixes and nobody needs waking up for.
    const drift = realDrift(witnessDrift(t.witnesses, live));
    if (drift.length) out.push({ target: t.target, importance: normImportance(t.importance), source: t.source, tripwire: !!t.tripwire, reason: t.reason, drift });
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

export interface BatchTriageItem { anchorId: string; importance?: Importance; complexity?: Complexity; reason?: string }

/**
 * Apply many anchor triage marks in one read/write of the store.
 *
 * `setTriage` re-reads and rewrites the whole triage blob per call, which is fine
 * for a button click and quadratic for a pull request — #227 changes 531 symbols.
 * The ratchet is the shared `ratchet()`, so batching cannot drift from the
 * single-set path.
 *
 * `ref` witnesses against that commit, so a mark on a symbol the branch adds
 * records the body it was actually derived from rather than `sha256:absent`.
 */
export async function setTriageBatch(
  root: string,
  items: BatchTriageItem[],
  opts: { source: TriageSource; ref?: string },
): Promise<{ applied: number; refused: number; shared?: boolean; error?: string }> {
  if (!items.length) return { applied: 0, refused: 0 };
  const ts = await readTriage(root);
  const byId = new Map(ts.triage.filter((t) => t.target.kind === "anchor").map((t) => [t.target.id, t]));
  const hashes = await liveHashes(root, items.map((i) => i.anchorId), opts.ref);
  const at = new Date().toISOString();
  /** Only what this batch actually WROTE — see the note at the write below. */
  const touched = new Set<string>();

  let applied = 0, refused = 0;
  for (const item of items) {
    const existing = byId.get(item.anchorId);
    const d = ratchet(existing, { importance: item.importance, complexity: item.complexity, source: opts.source });
    if ("refused" in d) { refused++; continue; }
    byId.set(item.anchorId, {
      target: { kind: "anchor", id: item.anchorId },
      importance: d.importance,
      complexity: d.complexity,
      likely: opts.source !== "human",
      tripwire: existing?.tripwire,
      source: opts.source,
      // A human write CLEARS analyzer provenance, matching `setTriage`: carrying it
      // forward left a human-owned mark tagged as analyzer-generated, and a re-emit
      // is contracted to rewrite only generated content.
      generatedBy: opts.source === "human" ? undefined : existing?.generatedBy,
      reason: item.reason ?? existing?.reason,
      at,
      witnesses: [{ anchorId: item.anchorId, bodyHash: hashes.get(item.anchorId) ?? "sha256:absent" }],
    });
    touched.add(item.anchorId);
    applied++;
  }
  // Published in ONE append and folded ONCE — `emitEvent` re-reads the scope per call,
  // which is quadratic on a pull request that marks 531 symbols. `graph` never travels,
  // so it keeps the local path it has always had.
  const marks = [...touched].map((id) => byId.get(id)!);
  const shared = opts.source === "graph" ? { shared: false as const, configured: false } : await mirrorTriageBatch(root, marks.map((t) => ({
    targetKind: t.target.kind, targetId: t.target.id,
    importance: t.importance, complexity: t.complexity,
    source: (t.source === "human" ? "human" : "agent") as TriageSource,
    reason: t.reason, assertedCommit: opts.ref, witnesses: t.witnesses,
  }))).catch((e: any) => ({ shared: false, configured: !!resolveSidecar(root), error: e?.message ?? String(e) }));
  // Same rule as `setTriage`: a failed append with a sidecar configured writes NOTHING.
  // A batch is where it matters most — hundreds of rows published later would each
  // claim a causal position captured long after the act.
  if (shared.configured && !shared.shared) {
    return { applied: 0, refused: items.length, error: appendFailed((shared as { error?: string }).error) };
  }
  // What this batch WROTE, one target at a time — never the whole list. `byId` was built
  // from the merged view so the ratchet could judge against a teammate's stakes; writing
  // it back wholesale would copy every one of their marks into this clone's partition,
  // and would rewrite untouched local marks under a fresh timestamp for no reason.
  if (!shared.shared) for (const t of marks) await upsertLocalTriage(root, t);
  return { applied, refused, ...(shared.shared ? { shared: true } : {}) };
}
