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
 * 3. **Between people, the later mark supersedes.** The log is linear, so there is no
 *    concurrent divergence to rank: a person's mark replaces the one before it in push
 *    order, field by field. Agents are the exception — the ratchet, judged against the
 *    log before the claim, so a stale agent claim is refused at replay.
 *
 * The fold is the authority. Every rule here is enforced when FOLDING, not only when
 * writing: events arrive from other people's clients, which may be older, buggy or
 * wrong, so a write-time check protects the honest writer and nobody else.
 */

import type { Actor, BugWitness, Complexity, Importance, TriageSource, Triage } from "./schema.js";
import { isAgentActor } from "./identity.js";
import { type DoorFold, type LogEvent, registerDoor } from "./eventlog.js";
import { collector, foldJudged, registerReport, type RefusalClass, type Refusal } from "./validation.js";
import { emitEvent, emitEvents } from "./write.js";
import { ratchet, type RatchetState } from "./triage-rules.js";

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
 * the fold reads an absent field as "this event did not touch it", so a clear
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

type Refuse = (e: LogEvent, cls: RefusalClass, why: string) => void;

function entryOf(e: LogEvent, refuse: Refuse): Entry | null {
  const d = (e.data ?? {}) as Record<string, unknown>;
  const kind = str(d, "targetKind");
  if ((kind !== "node" && kind !== "anchor") || !str(d, "targetId")) { refuse(e, "shape", "a triage event needs a node or anchor target"); return null; }
  if (e.subject !== triageSubject(kind, str(d, "targetId")!)) { refuse(e, "shape", "a triage event names its target in the envelope and the payload alike"); return null; }
  const clear = e.kind === "triage.cleared";
  if (clear && d.present !== false) { refuse(e, "shape", "a clear says `present: false`"); return null; }
  const declared = str(d, "source");
  // `graph` never travels. Refused at the fold as well as at the publish surface,
  // because remote events come from builds this one did not write.
  if (!clear && declared === "graph") { refuse(e, "state", "graph-derived triage does not travel — it is regenerated locally"); return null; }
  if (!clear && declared !== "agent" && declared !== "human") { refuse(e, "shape", `unknown triage source ${String(declared)}`); return null; }
  const agent = isAgentActor(e.actor) || declared === "agent";
  // Both ends: `mirrorTriageClear` refuses it too. An agent may only raise.
  if (clear && agent) { refuse(e, "state", "clearing stakes is a person's call — an agent may only raise"); return null; }
  if (!clear) {
    const bad = FIELDS.filter((f) => d[f] !== undefined && !VALID[f](d[f]));
    if (bad.length) refuse(e, "shape", `unknown ${bad.map((f) => `${f} ${JSON.stringify(d[f])}`).join(", ")}`);
    else if (!FIELDS.some((f) => d[f] !== undefined)) refuse(e, "shape", "an assertion carries at least one of importance, complexity or tripwire");
  }
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
export function foldTriageReport(events: LogEvent[]): { value: Map<string, TriageEntry>; refused: Refusal[] } {
  const { refused, refuse } = collector();
  const byTarget = new Map<string, Entry[]>();
  for (const e of events) {
    if (e.kind !== "triage.asserted" && e.kind !== "triage.cleared") continue;
    const entry = entryOf(e, refuse);
    if (!entry) continue;
    const acc = byTarget.get(e.subject);
    if (acc) acc.push(entry); else byTarget.set(e.subject, [entry]);
  }
  const out = new Map<string, TriageEntry>();
  for (const [key, entries] of byTarget) {
    const t = foldTarget(entries);
    if (t) out.set(key, t);
    // An agent claim the ratchet refuses, judged against what came BEFORE it. The fold
    // above ratchets against the final human baseline, so its refusals are retroactive: a
    // later human mark would turn an earlier, valid agent claim into "damage" on every reader.
    entries.forEach((en, i) => {
      if (!en.agent || en.clear) return;
      foldTarget(entries.slice(0, i + 1), (x, why) => { if (x === en) refuse(en.e, "state", why); });
    });
  }
  return { value: out, refused };
}

// Triage names no shared item: a node target is not a foreign key (owner, Q2 — an unpublished
// node is not missing, and triage ABOUT an analyzer node is not publishing one).
registerReport((scope) => scope.startsWith("triage/"), foldTriageReport);

/**
 * The report's verdict on `minted` alone, folding only its target: `derivePrTriage` batches
 * hundreds of marks, and each is folded at the door.
 */
export const triageDoor: DoorFold = (events, minted) => {
  const { refused, refuse } = collector();
  if (minted.kind !== "triage.asserted" && minted.kind !== "triage.cleared") return { refused };
  const en = entryOf(minted, refuse);
  if (!en || !en.agent || en.clear) return { refused };
  const entries = events.filter((e) => e.subject === minted.subject && e !== minted
    && (e.kind === "triage.asserted" || e.kind === "triage.cleared"))
    .map((e) => entryOf(e, () => {})).filter((x): x is Entry => !!x);
  foldTarget([...entries, en], (x, why) => { if (x === en) refuse(minted, "state", why); });
  return { refused };
};
registerDoor((scope) => scope.startsWith("triage/"), () => triageDoor);

/** The fold for a READ: a refused linear event is damage or newer; see `validation.ts`. */
export function foldTriage(events: LogEvent[]): Map<string, TriageEntry> {
  return foldJudged(events, foldTriageReport).value;
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
 * The human answer for one field: the latest human entry that speaks to it, in log order.
 *
 * `cleared` means the humans on record say this field is absent — the latest such entry is
 * a clear. That is different from "no human has ever spoken" (`undefined`), because an
 * agent claim may escalate from nothing but must not escalate from a decision to clear.
 */
function humanBaseline<V>(entries: Entry[], field: TriageField): { chosen?: AxisReceipt<V>; cleared: boolean } | undefined {
  // A clear reaches every field; an assertion reaches only the fields it carries.
  const last = entries.filter((en) => !en.agent && speaksTo(en, field)).at(-1);
  if (!last) return undefined;
  return last.clear ? { cleared: true } : { chosen: receiptOf<V>(last, last.data[field] as V), cleared: false };
}

const speaksTo = (en: Entry, field: TriageField): boolean =>
  en.clear || (en.data[field] !== undefined && VALID[field](en.data[field]));

function foldTarget(entries: Entry[], onRefused?: (en: Entry, why: string) => void): TriageEntry | null {
  const first = entries[0]!;
  const target = {
    kind: str(first.data, "targetKind") as "node" | "anchor",
    id: str(first.data, "targetId")!,
  };

  const impBase = humanBaseline<Importance>(entries, "importance");
  const cxBase = humanBaseline<Complexity>(entries, "complexity");
  const twBase = humanBaseline<boolean>(entries, "tripwire");

  // Has a person ANSWERED this agent claim's `field` — spoken to it later in the log? Per
  // field: a person who answered only the complexity leaves the agent's importance standing.
  const answered = (i: number, field: TriageField): boolean =>
    entries.some((h, j) => j > i && !h.agent && speaksTo(h, field));

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

  for (const [i, en] of entries.entries()) {
    if (!en.agent || en.clear) continue;
    // A field a human has answered is masked OUT of this event before the ratchet sees
    // it. The rest of the event still stands.
    const imp = !answered(i, "importance") && VALID.importance(en.data.importance)
      ? (en.data.importance as Importance) : undefined;
    const cx = !answered(i, "complexity") && VALID.complexity(en.data.complexity)
      ? (en.data.complexity as Complexity) : undefined;
    if (imp === undefined && cx === undefined) continue;

    const decided = ratchet(running, { importance: imp, complexity: cx, source: "agent" });
    if ("refused" in decided) { onRefused?.(en, decided.refused); continue; }
    // Visible only if it actually RAISES.
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
    const won = impBase?.cleared ? clearWinner(entries) : undefined;
    return won
      ? { target, cleared: { actor: won.e.actor, at: won.e.at, eventId: won.e.id } }
      : null;
  }

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

/** Baseline plus escalation as the three-part axis consumers read. */
function axisOf<V>(
  base: { chosen?: AxisReceipt<V>; cleared: boolean } | undefined,
  escalation: AxisReceipt<V> | undefined,
): Axis<V> | undefined {
  if (escalation) return { effective: escalation, escalation, ...(base?.chosen ? { baseline: base.chosen } : {}) };
  if (!base?.chosen) return undefined;
  return { effective: base.chosen, baseline: base.chosen };
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
 * The clear that won — the receipt a tombstone is written from: the last human entry that
 * could reinstate or clear the mark, when it is a clear. A complexity-only assertion does not
 * reinstate a cleared mark, the same way `humanBaseline` filters on the field.
 */
function clearWinner(entries: Entry[]): Entry | undefined {
  const last = entries.filter((en) => !en.agent && speaksTo(en, "importance")).at(-1);
  return last?.clear ? last : undefined;
}
