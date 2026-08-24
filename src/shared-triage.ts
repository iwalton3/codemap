/**
 * Triage on the event log — how stakes travel between people.
 *
 * `docs/shared-triage.md` is normative and this file implements it. The three
 * decisions worth knowing before reading, because each killed an obvious design:
 *
 * 1. **There is no lattice, so there is no max-fold.** Agent writes are not
 *    commutative: an absent complexity is read as `DEFAULT_COMPLEXITY` once a mark
 *    exists but an explicit `wiring` stands on a FIRST mark, so
 *    `{important} → {business-critical, wiring}` and its reverse disagree. Eligible
 *    agent claims are REPLAYED in canonical order through `ratchet`, which is the
 *    same rule a local write obeys. DETERMINISM needs every clone to agree after
 *    sorting, not a commutative reducer, and `sortEvents` is a total order.
 *
 * 2. **Supersession is per FIELD.** A record whose importance is a human's and whose
 *    complexity is an agent's has no single truthful source, reason or witness list —
 *    collapsing them to one receipt is the compound-value bug the design exists to
 *    avoid. An assertion reaches only the fields it carries.
 *
 * 3. **Concurrent divergence takes the higher value, silently — except across the
 *    business-critical line.** Ranking something too high costs somebody a few
 *    minutes; ranking it too low costs the thing this project exists to prevent. Only
 *    a disagreement that crosses `business-critical` is worth interrupting a person
 *    for, and that one becomes a review-queue item rather than a sticky label.
 *
 * The fold is the authority. Every rule here is enforced when FOLDING, not only when
 * writing: events arrive from other people's clients, which may be older, buggy or
 * wrong, so a write-time check protects the honest writer and nobody else.
 */

import type { Actor, BugWitness, Complexity, Importance, TriageSource, Triage } from "./schema.js";
import { isAgentActor } from "./identity.js";
import { emitEvent, emitEvents, type LogEvent, type Causality, causality } from "./eventlog.js";
import { IMPORTANCE_RANK, COMPLEXITY_RANK, ratchet, type RatchetState } from "./triage-rules.js";

/** One universe's stakes. Not per-PR: a symbol's blast radius outlives any branch. */
export const triageScope = (universe: string): string => `triage/${universe}`;

/**
 * The pseudo-field a tombstone occupies in the canonical table.
 *
 * `@`-prefixed like `@work` and `@orphan`: it is not an axis anyone triages, and the
 * prefix keeps it from ever colliding with one. `triageFromRows` looks for `importance`
 * and so ignores it, which is what stops a tombstone rendering as a phantom mark.
 */
export const ABSENT_FIELD = "@absent";

/** The grouping key, so the fold never parses a scope path or a kind out of a string. */
export const triageSubject = (kind: "node" | "anchor", id: string): string => `${kind}:${id}`;

/** What one writer said about one field, and everything needed to judge it here. */
export interface AxisReceipt<V> {
  value: V;
  actor: Actor;
  /** `human` or `agent`. `graph` is refused at the fold — see `foldTriage`. */
  source: TriageSource;
  likely: boolean;
  reason?: string;
  at: string;
  /**
   * The commit the assertion was made at. A body hash decides whether a claim applies
   * HERE; only a locator can retrieve or explain the writer's version of the code.
   */
  assertedCommit?: string;
  witnesses: BugWitness[];
  eventId: string;
}

/**
 * One field's resolved state, which is three things and not one.
 *
 * `effective` is what ranking and severity use. `baseline` is the active human
 * assertion, kept visible or "confirm" has nothing concrete to mean. `escalation` is
 * set when an agent supplied the effective value over a human baseline.
 */
export interface Axis<V> {
  effective: AxisReceipt<V>;
  baseline?: AxisReceipt<V>;
  escalation?: AxisReceipt<V>;
  /**
   * Concurrent divergent assertions this one won over. Retained regardless of the
   * outcome — per-field provenance is required anyway, and the queue item for a
   * contested field has to be able to name both sides.
   */
  concurrent?: AxisReceipt<V>[];
  /** Only ever set on `importance`, and only across the business-critical line. */
  contested?: boolean;
}

/**
 * A target a person deliberately cleared — an absence somebody ASSERTED.
 *
 * Distinct from a target the fold simply has no answer for, and the distinction is the
 * whole of the F2 repair. Both used to fold to nothing, so the table could not tell
 * "the team cleared this" from "the team never mentioned it", and a local mark
 * reappeared the moment shared history cleared one.
 *
 * It also has to stay distinct from a target whose only events were REFUSED by policy
 * — a complexity-only agent claim, say. That target is genuinely uncovered, and
 * counting it as covered would let a forbidden agent claim suppress a human's local
 * mark, which is the same lowering the ratchet exists to refuse.
 */
export interface TriageTombstone {
  target: { kind: "node" | "anchor"; id: string };
  cleared: { actor: Actor; at: string; eventId: string };
}

/** What a fold answers with for one target: a mark, or an asserted absence. */
export type TriageEntry = SharedTriage | TriageTombstone;
export const isTombstone = (e: TriageEntry): e is TriageTombstone => "cleared" in e;

export interface SharedTriage {
  target: { kind: "node" | "anchor"; id: string };
  /** Always present: a record with no importance is not a mark. See `foldTarget`. */
  importance: Axis<Importance>;
  complexity?: Axis<Complexity>;
  tripwire?: Axis<boolean>;
}

/** The fields an assertion can carry. `tripwire` is a field, not a flag on the record. */
const FIELDS = ["importance", "complexity", "tripwire"] as const;
export type TriageField = (typeof FIELDS)[number];

const TRUE_RANK = { false: 0, true: 1 } as const;
const rankOf = (field: TriageField, v: unknown): number =>
  field === "importance" ? IMPORTANCE_RANK[v as Importance] ?? -1
    : field === "complexity" ? COMPLEXITY_RANK[v as Complexity] ?? -1
      : TRUE_RANK[String(v) as "true" | "false"] ?? -1;

const VALID: Record<TriageField, (v: unknown) => boolean> = {
  importance: (v) => v === "business-critical" || v === "important" || v === "low",
  complexity: (v) => v === "deep" || v === "standard" || v === "rote" || v === "wiring",
  tripwire: (v) => typeof v === "boolean",
};

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface TriageAssertion {
  targetKind: "node" | "anchor";
  targetId: string;
  importance?: Importance;
  complexity?: Complexity;
  tripwire?: boolean;
  source: TriageSource;
  reason?: string;
  assertedCommit?: string;
  witnesses?: BugWitness[];
}

/**
 * Publish one assertion.
 *
 * The event carries the fields the writer actually asserts. A LOCAL write is still one
 * act producing one record — `ratchet` inherits the existing complexity and `setTriage`
 * stamps it — and the fold treats that record as a set of field assertions sharing one
 * receipt, which is where per-field provenance comes from without a second merge rule.
 */
export async function assertTriage(
  logRoot: string, scope: string, actor: Actor, a: TriageAssertion,
): Promise<LogEvent> {
  return emitEvent(logRoot, scope, actor, "triage.asserted", triageSubject(a.targetKind, a.targetId), assertionData(a));
}

/** The payload half of an assertion, shared by the single and batch writers. */
function assertionData(a: TriageAssertion): Record<string, unknown> {
  if (a.source === "graph") {
    // Refused here AND at the fold. Graph output is regenerated per machine by
    // `deriveTriage` and `docs/sidecar-architecture.md` keeps deterministic analyzer
    // output in local SQLite; a write-time check alone would not stop another build.
    throw new Error("graph-derived triage does not travel — it is regenerated locally");
  }
  return {
    targetKind: a.targetKind, targetId: a.targetId,
    ...(a.importance !== undefined ? { importance: a.importance } : {}),
    ...(a.complexity !== undefined ? { complexity: a.complexity } : {}),
    ...(a.tripwire !== undefined ? { tripwire: a.tripwire } : {}),
    source: a.source,
    ...(a.reason ? { reason: a.reason } : {}),
    ...(a.assertedCommit ? { assertedCommit: a.assertedCommit } : {}),
    witnesses: a.witnesses ?? [],
  };
}

/**
 * Many assertions, one append.
 *
 * The batch path exists because `derivePrTriage` marks every changed symbol — 531 on
 * one real pull request — and `emitEvent` re-reads the scope per call.
 */
export async function assertTriageBatch(
  logRoot: string, scope: string, actor: Actor, items: TriageAssertion[],
): Promise<LogEvent[]> {
  return emitEvents(logRoot, scope, actor, items.map((a) => ({
    kind: "triage.asserted", subject: triageSubject(a.targetKind, a.targetId), data: assertionData(a),
  })));
}

/**
 * Publish "this target has NO stakes".
 *
 * `present: false` is EXPLICIT and must never be encoded as `importance: undefined`:
 * `applyRevision` reads an absent field as "this event did not touch it", so a clear
 * written that way is indistinguishable from silence. The log is append-only and NO
 * LOSS forbids removing an event once observed, so a clear is an append like any other
 * — the superseded mark stays in history and simply stops appearing in the projection.
 */
export async function clearSharedTriage(
  logRoot: string, scope: string, actor: Actor,
  t: { targetKind: "node" | "anchor"; targetId: string; reason?: string },
): Promise<LogEvent> {
  return emitEvent(logRoot, scope, actor, "triage.cleared", triageSubject(t.targetKind, t.targetId), {
    targetKind: t.targetKind, targetId: t.targetId, present: false,
    ...(t.reason ? { reason: t.reason } : {}),
  });
}

// ---------------------------------------------------------------------------
// Folding
// ---------------------------------------------------------------------------

/** An assertion or a clear, with the envelope questions already answered. */
interface Entry {
  e: LogEvent;
  /** A clear asserts the ABSENCE of the whole mark, so it reaches every field. */
  clear: boolean;
  /**
   * Whether this counts as an agent claim.
   *
   * `isAgentActor` OR a declared `agent` source, deliberately: an ambiguous case is
   * treated as the WEAKER claim, because an agent may only raise, may not clear and
   * may not arm a tripwire. Failing toward "agent" cannot hand anyone authority they
   * did not have.
   */
  agent: boolean;
  source: TriageSource;
  data: Record<string, unknown>;
}

const str = (d: Record<string, unknown>, k: string): string | undefined =>
  typeof d[k] === "string" ? (d[k] as string) : undefined;

function entryOf(e: LogEvent): Entry | null {
  const d = (e.data ?? {}) as Record<string, unknown>;
  const kind = str(d, "targetKind");
  if (kind !== "node" && kind !== "anchor") return null;
  if (!str(d, "targetId")) return null;
  if (e.subject !== triageSubject(kind, str(d, "targetId")!)) return null; // envelope and payload must agree
  const clear = e.kind === "triage.cleared";
  if (clear && d.present !== false) return null; // a clear that does not say so is not one
  const declared = str(d, "source");
  // `graph` never travels. Refused at the fold as well as at the publish surface,
  // because remote events come from builds this one did not write.
  if (!clear && declared === "graph") return null;
  if (!clear && declared !== "agent" && declared !== "human") return null;
  const agent = isAgentActor(e.actor) || declared === "agent";
  return { e, clear, agent, source: agent ? "agent" : "human", data: d };
}

/**
 * Every target's resolved stakes.
 *
 * Targets whose surviving state has no importance are DROPPED rather than emitted
 * empty: no importance is not a mark — nothing else can stand in for it, which is
 * exactly what `ratchet` refuses to invent — and `triageFromRows` already drops such a
 * group, so emitting one would make the projection's round trip disagree with itself.
 */
export function foldTriage(events: LogEvent[]): Map<string, TriageEntry> {
  const causal = causality(events);
  const byTarget = new Map<string, Entry[]>();
  for (const e of events) {
    if (e.kind !== "triage.asserted" && e.kind !== "triage.cleared") continue;
    const entry = entryOf(e);
    if (!entry) continue;
    const acc = byTarget.get(e.subject);
    if (acc) acc.push(entry); else byTarget.set(e.subject, [entry]);
  }
  const out = new Map<string, TriageEntry>();
  for (const [key, entries] of byTarget) {
    const t = foldTarget(entries, causal);
    if (t) out.set(key, t);
  }
  return out;
}

const receiptOf = <V>(en: Entry, value: V): AxisReceipt<V> => ({
  value,
  actor: en.e.actor,
  source: en.source,
  // An agent proposes; a human sets a confirmed tier. Derived from the actor rather
  // than trusted from the payload, for the same reason `agent` is.
  likely: en.agent,
  ...(str(en.data, "reason") ? { reason: str(en.data, "reason")! } : {}),
  at: en.e.at,
  ...(str(en.data, "assertedCommit") ? { assertedCommit: str(en.data, "assertedCommit")! } : {}),
  witnesses: Array.isArray(en.data.witnesses) ? (en.data.witnesses as BugWitness[]) : [],
  eventId: en.e.id,
});

/**
 * The human answer for one field: what survives supersession, and what won.
 *
 * `null` means the humans on record say this field is absent — every assertion of it
 * has been superseded by a clear. That is different from "no human has ever spoken",
 * which is `undefined`, because an agent claim may escalate from nothing but must not
 * escalate from a decision to clear.
 */
function humanBaseline<V>(
  entries: Entry[], field: TriageField, causal: Causality,
): { chosen?: AxisReceipt<V>; concurrent: AxisReceipt<V>[]; cleared: boolean } | undefined {
  // A clear reaches every field; an assertion reaches only the fields it carries.
  const relevant = entries.filter((en) => !en.agent
    && (en.clear || (en.data[field] !== undefined && VALID[field](en.data[field]))));
  if (!relevant.length) return undefined;

  // Supersession: Y supersedes X when Y's writer had already folded X. That is the
  // normal way anything gets lowered — a decision, not a merge — and it is why most
  // of what looks like conflict needs no machinery at all.
  const survivors = relevant.filter((x) => !relevant.some((y) => y !== x && causal.saw(y.e.id, x.e.id)));

  const asserts = survivors.filter((s) => !s.clear);
  // PRESENCE WINS over a concurrent clear: a mark nobody wanted costs a glance, a mark
  // silently removed costs the review it was asking for. The clear stays in history and
  // a human who has seen both can clear again.
  if (!asserts.length) return { concurrent: [], cleared: true };

  const receipts = asserts.map((a) => receiptOf<V>(a, a.data[field] as V));
  // Concurrent divergence: the higher value wins, silently. Ties break on event id so
  // two clones with the same events always choose the same receipt.
  const chosen = receipts.reduce((best, r) => {
    const d = rankOf(field, r.value) - rankOf(field, best.value);
    return d > 0 || (d === 0 && r.eventId < best.eventId) ? r : best;
  });
  return { chosen, concurrent: receipts.filter((r) => r !== chosen), cleared: false };
}

/**
 * Has a human ANSWERED this agent event's claim to `field`?
 *
 * Per FIELD, and that is the whole correction. Judged per event, a human who saw an
 * agent's `{business-critical, deep}` and answered only the complexity suppressed the
 * entire event — and the business-critical importance nobody had disputed vanished with
 * it, folding the target to absent. An assertion supersedes causally-seen claims only
 * for the fields it carries; a clear carries all of them.
 */
const answered = (humans: Entry[], en: Entry, field: TriageField, causal: Causality): boolean =>
  humans.some((h) => causal.saw(h.e.id, en.e.id)
    && (h.clear || (h.data[field] !== undefined && VALID[field](h.data[field]))));

function foldTarget(entries: Entry[], causal: Causality): TriageEntry | null {
  const first = entries[0]!;
  const target = {
    kind: str(first.data, "targetKind") as "node" | "anchor",
    id: str(first.data, "targetId")!,
  };

  const impBase = humanBaseline<Importance>(entries, "importance", causal);
  const cxBase = humanBaseline<Complexity>(entries, "complexity", causal);
  const twBase = humanBaseline<boolean>(entries, "tripwire", causal);

  const humans = entries.filter((en) => !en.agent);
  const agents = entries.filter((en) => en.agent && !en.clear);

  // The state the replay ratchets against. Carries a human complexity even when no
  // human importance exists — see `RatchetState`.
  let running: RatchetState | undefined = impBase?.chosen || cxBase?.chosen
    ? {
      ...(impBase?.chosen ? { importance: impBase.chosen.value } : {}),
      ...(cxBase?.chosen ? { complexity: cxBase.chosen.value } : {}),
      source: "human" as const,
    }
    : undefined;

  let impFrom: AxisReceipt<Importance> | undefined;
  let cxFrom: AxisReceipt<Complexity> | undefined;
  /** Every live agent claim per field — needed for contests, not just the raising one. */
  const agentSaid: { importance: AxisReceipt<Importance>[]; complexity: AxisReceipt<Complexity>[] } =
    { importance: [], complexity: [] };

  for (const en of agents) {
    // A field a human has answered is masked OUT of this event before the ratchet sees
    // it. The rest of the event still stands.
    const imp = !answered(humans, en, "importance", causal) && VALID.importance(en.data.importance)
      ? (en.data.importance as Importance) : undefined;
    const cx = !answered(humans, en, "complexity", causal) && VALID.complexity(en.data.complexity)
      ? (en.data.complexity as Complexity) : undefined;
    if (imp === undefined && cx === undefined) continue;
    if (imp !== undefined) agentSaid.importance.push(receiptOf(en, imp));
    if (cx !== undefined) agentSaid.complexity.push(receiptOf(en, cx));

    const decided = ratchet(running, { importance: imp, complexity: cx, source: "agent" });
    if ("refused" in decided) continue;
    // Visible only if it actually RAISES: concurrency alone does not make a lower or
    // no-op claim an escalation.
    if (imp !== undefined && decided.importance !== running?.importance) impFrom = receiptOf(en, decided.importance);
    if (cx !== undefined && decided.complexity !== running?.complexity && decided.complexity !== undefined) {
      cxFrom = receiptOf(en, decided.complexity);
    }
    running = {
      importance: decided.importance,
      ...(decided.complexity ? { complexity: decided.complexity } : {}),
      source: "agent",
    };
  }

  const importance = axisOf<Importance>(impBase, impFrom);
  if (!importance) {
    // Absence ASSERTED by a person is a fact the team stated and it gets a tombstone.
    // Absence for any other reason — no importance ever, or every claim refused — is
    // the log having nothing admissible to say, and must NOT read as coverage.
    const won = impBase?.cleared ? clearWinner(entries, causal) : undefined;
    return won
      ? { target, cleared: { actor: won.e.actor, at: won.e.at, eventId: won.e.id } }
      : null;
  }
  if (contested(importance, agentSaid.importance, causal)) importance.contested = true;

  const complexity = axisOf<Complexity>(cxBase, cxFrom);
  // Humans only. An agent's tripwire value is ignored outright rather than ratcheted:
  // `false` suppresses a notification, and an alarm silently disarmed is the failure.
  const tripwire = axisOf<boolean>(twBase, undefined);

  return {
    target, importance,
    ...(complexity ? { complexity } : {}),
    ...(tripwire ? { tripwire } : {}),
  };
}

/**
 * Does this field hold a disagreement across the business-critical line?
 *
 * Two distinct ACTIVE receipts whose values straddle the line, where neither saw the
 * other. Three clauses, each of which was wrong at some point:
 *
 * **No writer or principal test.** `docs/sidecar-architecture.md` deletes `sameWriter`
 * from contest detection outright — under the segment vector `saw()` subsumes every
 * legitimate case it covered, and its only residual effect was suppressing intra-fork
 * disagreements, which is exactly the disagreement worth seeing. An earlier draft of
 * this function tested writer inequality and would have hidden a fork's own conflict.
 *
 * **ACTIVE, not "ever said".** A receipt that saw both sides and spoke is a settlement,
 * so it prunes what it saw. Without this a settled contest contests forever, because
 * the historical pair is still on the record.
 *
 * **Only a person settles.** The design said an agent may settle an agent/agent
 * disagreement, and the build found that half UNREACHABLE: settling is asserting a
 * value having seen both sides, `ratchet` refuses an agent's no-op restatement, and a
 * contest exists only across the business-critical line — so there is never a higher
 * value left for an agent to assert. Rather than carve a special case into `ratchet`
 * (consolidated from three copies precisely to stop them drifting), the agent's role
 * is a PROPOSAL on the queue item — it investigates and reports an outcome, and the
 * person settles by re-triaging. See `docs/shared-triage.md`.
 */
function contested(
  axis: Axis<Importance>, agentClaims: AxisReceipt<Importance>[], causal: Causality,
): boolean {
  const humanSide = [...(axis.baseline ? [axis.baseline] : []), ...(axis.concurrent ?? [])];
  const all = [...humanSide, ...agentClaims];
  const isAgent = (r: AxisReceipt<Importance>) => r.source === "agent";
  const active = all.filter((x) => !all.some((y) => y !== x
    && causal.saw(y.eventId, x.eventId)
    && !isAgent(y)));
  return active.some((a) => a.value === "business-critical")
    && active.some((b) => b.value !== "business-critical")
    // Straddling is not enough on its own: the two sides must be genuinely concurrent,
    // or a person lowering something they had just read reads as a conflict with
    // themselves.
    && active.some((a) => active.some((b) => a !== b
      && a.value === "business-critical" && b.value !== "business-critical"
      && !causal.saw(a.eventId, b.eventId) && !causal.saw(b.eventId, a.eventId)));
}

/** Baseline plus escalation as the three-part axis consumers read. */
function axisOf<V>(
  base: { chosen?: AxisReceipt<V>; concurrent: AxisReceipt<V>[]; cleared: boolean } | undefined,
  escalation: AxisReceipt<V> | undefined,
): Axis<V> | undefined {
  if (escalation) {
    return {
      effective: escalation, escalation,
      ...(base?.chosen ? { baseline: base.chosen } : {}),
      ...(base?.concurrent.length ? { concurrent: base.concurrent } : {}),
    };
  }
  if (!base?.chosen) return undefined;
  return {
    effective: base.chosen, baseline: base.chosen,
    ...(base.concurrent.length ? { concurrent: base.concurrent } : {}),
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * A folded record as the `Triage` every existing consumer already reads.
 *
 * The compatibility surface, and it is documented rather than left ambiguous:
 * `Triage` has singular `source`, `likely`, `reason` and `witnesses`, which a record
 * whose importance is human and whose complexity is an agent's cannot truthfully have.
 * So the top-level ones are aliases of the IMPORTANCE field's receipt — the field the
 * others refine — `likely` is true when ANY effective field is agent-supplied, and
 * anything needing real provenance reads the axes.
 */
export function triageOf(t: SharedTriage): Triage {
  const imp = t.importance.effective;
  const likely = imp.likely || !!t.complexity?.effective.likely;
  return {
    target: t.target,
    importance: imp.value,
    ...(t.complexity ? { complexity: t.complexity.effective.value } : {}),
    likely,
    ...(t.tripwire ? { tripwire: t.tripwire.effective.value } : {}),
    source: imp.source,
    ...(imp.reason ? { reason: imp.reason } : {}),
    at: imp.at,
    witnesses: imp.witnesses,
  };
}

/**
 * The clear that actually won — the receipt a tombstone is written from.
 *
 * Only something that could REINSTATE the mark supersedes a clear: another clear, or a
 * human assertion carrying an importance. Judged against every later human entry, a
 * complexity-only assertion killed the clear here while `humanBaseline` — which filters
 * on the field — still read the target as cleared, so the fold returned NEITHER a mark
 * nor a tombstone and a legacy local row filled the hole a deliberate clear had made.
 *
 * `setTriage` does not currently produce a complexity-only human assertion, but this
 * fold's whole contract is that it is the authority over events from clients it did not
 * write, and `TriageAssertion` permits the shape.
 */
function clearWinner(entries: Entry[], causal: Causality): Entry | undefined {
  const reinstates = (en: Entry) => !en.agent
    && (en.clear || (en.data.importance !== undefined && VALID.importance(en.data.importance)));
  const clears = entries.filter((en) => en.clear && !en.agent);
  const live = clears.filter((x) => !entries.some((y) => y !== x && reinstates(y) && causal.saw(y.e.id, x.e.id)));
  // Lowest id among the survivors, so every clone writes the same tombstone.
  return [...live].sort((a, b) => (a.e.id < b.e.id ? -1 : 1))[0];
}

/** Every field of every target where two people crossed the business-critical line. */
export function contestedTargets(folded: Map<string, TriageEntry>): SharedTriage[] {
  return [...folded.values()].filter((t): t is SharedTriage => !isTombstone(t) && !!t.importance.contested);
}
