/**
 * The triage RULES, with nothing under them.
 *
 * Pure, and separated from `triage.ts` for one structural reason: `shared-triage.ts`
 * replays a teammate's events through the same ratchet a local write obeys, and
 * `triage.ts` reaches UP to `ops-shared.ts` to publish. Importing the rules from there
 * closed a cycle — `ops-shared -> shared-projections -> shared-triage -> triage ->
 * ops-shared` — and an ES-module cycle here fails with a blank page and an empty
 * console. Break it at the pure half; this is the pure half.
 *
 * `triage.ts` re-exports everything below, so nothing that already imported these has
 * to move.
 */

import { type Importance, type Complexity, type TriageSource, type Triage } from "./schema.js";

export const IMPORTANCE_RANK: Record<Importance, number> = { low: 0, important: 1, "business-critical": 2 };
export const COMPLEXITY_RANK: Record<Complexity, number> = { wiring: 0, rote: 1, standard: 2, deep: 3 };
// Untriaged complexity is treated as `standard` for severity — a code segment is
// assumed to need a real review until something proves it's just plumbing.
export const DEFAULT_COMPLEXITY: Complexity = "standard";

/** Legacy stores used "mechanical" for the low-stakes tier — map it to `low`. */
export function normImportance(i: string | undefined): Importance {
  return i === "mechanical" ? "low" : (i as Importance);
}

/**
 * The ratchet decision, pure so every path that writes a mark shares one rule.
 * Agents and the graph may only ever RAISE either axis; a human writes what they
 * set. Returns `{refused}` when the mark would add nothing or is not theirs to make.
 *
 * `humanDrifted` is the one exception: a human mark is authoritative UNLESS the
 * code it covers has moved since they set it, and then a higher derivation is a
 * legitimate re-escalation ("grew teeth") rather than an override. `deriveTriage`
 * is the only caller that can know this, which is why it is a parameter and not a
 * third hand-written copy of the ratchet — the copy it used to keep still had the
 * absent-complexity hole this function closed.
 */
export function ratchet(
  existing: Triage | undefined,
  input: { importance?: Importance; complexity?: Complexity; source: TriageSource },
  opts: { humanDrifted?: boolean } = {},
): { importance: Importance; complexity?: Complexity } | { refused: string } {
  const human = input.source === "human";
  const exImp = existing ? normImportance(existing.importance) : undefined;
  const wantImp = input.importance ? normImportance(input.importance) : undefined;
  // No signal means no claim. Defaulting a signal-free agent input to `important`
  // LOWERED attention: `untriaged` ranks BC-until-looked-at, while a fabricated
  // important+wiring mark scores `medium` and drops the bar from `signed` to
  // `viewed`. `pr.ts` guards this on its own path; the rule belongs here, where
  // `pr-ingest` and any direct `setTriageBatch` caller also reach it. A human
  // writing only a complexity is still an explicit act, so the default stays theirs.
  if (!human && wantImp === undefined && exImp === undefined) {
    return { refused: "no importance given and none on record — an agent that asserts no stakes does not get one invented for it" };
  }
  if (existing && !human) {
    const raisesImp = wantImp !== undefined && (exImp === undefined || IMPORTANCE_RANK[wantImp] > IMPORTANCE_RANK[exImp]);
    // An ABSENT complexity is not "lower than everything" — every consumer
    // (severity, barFor) reads it as DEFAULT_COMPLEXITY, so treating undefined as
    // raisable let an agent send `wiring` against a human's business-critical mark,
    // drop the bar from `signed` to `viewed`, and flip the mark back to
    // agent/`likely`. `derivePrTriage` sends a complexity for every changed symbol,
    // so the hole was mass-reachable.
    const exCx = existing.complexity ?? DEFAULT_COMPLEXITY;
    const raisesCx = input.complexity !== undefined && COMPLEXITY_RANK[input.complexity] > COMPLEXITY_RANK[exCx];
    if (!raisesImp && !raisesCx) {
      return { refused: existing.source === "human" ? "human-owned — agents may only ESCALATE it, never lower" : "ratchet: agents/graph may only raise stakes/complexity" };
    }
    if (existing.source === "human" && input.source === "graph" && !opts.humanDrifted) {
      return { refused: "graph derivation won't override a human mark — an agent with evidence can escalate via `triage`" };
    }
  }
  const importance: Importance = wantImp === undefined ? (exImp ?? "important")
    : human || exImp === undefined ? wantImp
      : IMPORTANCE_RANK[wantImp] > IMPORTANCE_RANK[exImp] ? wantImp : exImp;
  const complexity = human ? (input.complexity ?? existing?.complexity)
    : input.complexity === undefined ? existing?.complexity
      // Nothing to ratchet against on a first mark — the agent's proposal stands.
      // The DEFAULT_COMPLEXITY baseline only applies once a mark exists, because
      // that is when an absent complexity is already *read* as `standard`.
      : existing === undefined ? input.complexity
        : COMPLEXITY_RANK[input.complexity] > COMPLEXITY_RANK[existing.complexity ?? DEFAULT_COMPLEXITY] ? input.complexity : existing.complexity;
  return { importance, complexity };
}
