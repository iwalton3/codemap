/**
 * The one door for decisions on the read side (plan C1): the folded rounds and, for every
 * finding, held / not held / unknown. `decision_rounds`, `decision_round`, `review_queue`,
 * `findings` and `shared_findings` all ask it and nothing else, so no surface can answer "held"
 * differently from another. Its own module because `ops/annotations` cannot reach `ops-shared`
 * without closing a cycle through `ops/triage`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db.js";
import { readCached } from "../materialize.js";
import { decisionsProjection } from "../shared-projections.js";
import { resolveSidecar, sidecarIdentity } from "../sidecar-config.js";
import { isClosed, type FindingState } from "../shared-findings.js";
import { decisionScope, foldDecisions, heldFindings, supersededFindings, type Hold, type SharedDecisions } from "../shared-decisions.js";
import type { ScopeDiagnostic, ScopeStatus } from "../eventlog.js";

/** What a row carries: its holds, or `"unknown"`, and whether its decision may be superseded. */
export interface HoldMark {
  held?: Hold[] | "unknown";
  /** Verified words not yet bound may overturn the ruling that placed this (plan A3). A mark,
   *  never a reason to withhold (owner, S0.8(a)). */
  possiblySuperseded?: { decision: string; words: string[] }[];
}

export interface DecisionsView {
  s: SharedDecisions;
  status: ScopeStatus;
  /** Set when which findings are held cannot be known — never "none" from a log nobody could
   *  read (H7.14). */
  unknown?: string;
  /** The mark for finding `id` — the same for every row under that id (owner, P3.1 (3)). */
  mark(id: string): HoldMark;
  /** Open unless every row under the id says closed (owner, S0.8(e)). */
  isOpen(id: string): boolean;
}

const EMPTY: SharedDecisions = { rounds: [], decisions: [], questions: [] };

let builds = 0;
/** How many times the hold maps have been built in this process. For tests; no production caller. */
export const holdBuilds = (): number => builds;

/** This store has folded decisions from a sidecar before — at least one event (S0.8(b)): a
 *  zero-event read, like opening the page on a universe with none, is not evidence of any. */
function foldedBefore(root: string, universe?: string): boolean {
  try {
    const row = universe
      ? db(root).prepare("SELECT 1 AS y FROM shared_scope WHERE scope = ? AND events > 0").get(decisionScope(universe))
      : db(root).prepare("SELECT 1 AS y FROM shared_scope WHERE scope LIKE 'decisions/%' AND events > 0").get();
    return !!row;
  } catch { return false; }   // no table yet: nothing has ever been folded here
}

export async function decisionsView(root: string): Promise<DecisionsView> {
  // Built once per call: whether a finding is open, by id, across every review key it is under.
  const open = new Map<string, boolean>();
  try {
    for (const r of db(root).prepare("SELECT id, state FROM findings").all() as unknown as { id: string; state: string }[]) {
      open.set(r.id, (open.get(r.id) ?? false) || !isClosed(r.state as FindingState));
    }
  } catch { /* no findings table yet */ }
  const isOpen = (id: string) => open.get(id) ?? false;

  const view = (s: SharedDecisions, status: ScopeStatus, unknown?: string): DecisionsView => {
    // Built on the first mark read, once per view: a write reads the view for its rows only
    // (P2.2 (7)).
    let marks: { held?: Map<string, Hold[]>; flagged: ReturnType<typeof supersededFindings> } | undefined;
    const built = () => {
      if (!marks) { builds++; marks = { ...(unknown ? {} : { held: heldFindings(s, isOpen) }), flagged: supersededFindings(s) }; }
      return marks;
    };
    return {
      s, status, ...(unknown ? { unknown } : {}), isOpen,
      mark: (id) => {
        const { held, flagged } = built();
        const h = held ? held.get(id) : "unknown";
        const p = flagged.get(id);
        return { ...(h === "unknown" || h?.length ? { held: h } : {}), ...(p ? { possiblySuperseded: p } : {}) };
      },
    };
  };
  const complete: ScopeStatus = { status: "complete" };

  const cfg = resolveSidecar(root);
  const missing = (why: string): DecisionsView => {
    // Absent is not empty (the oracle's COMPLETENESS, and CLAUDE.md "An absent sidecar is not
    // an empty one"): having folded decisions here before, the holds are unknown; never
    // having, there are none. Not folded either way — folding nothing would write nothing.
    if (!foldedBefore(root, cfg?.universe)) return view(EMPTY, complete);
    const s = cfg ? stored(root, cfg.universe) : EMPTY;
    const diagnostic: ScopeDiagnostic = { reason: "sidecar-missing", detail: why, evidence: cfg ? [cfg.path] : [] };
    return view(s, { status: "blocked", diagnostic }, why);
  };
  if (!cfg) return missing("no sidecar is configured, and this store has read decisions from one before");
  if (!existsSync(join(cfg.path, ".git"))) return missing(`the sidecar at ${cfg.path} is missing, and this store has read decisions from it before`);
  if (!existsSync(join(cfg.path, decisionScope(cfg.universe)))) return missing(`the decisions log is missing from ${cfg.path}, and this store has read decisions from it before`);
  const { value, ...status } = await readCached(root, cfg.path, decisionScope(cfg.universe), sidecarIdentity(cfg), foldDecisions, decisionsProjection);
  return view(value, status, status.status === "blocked" ? status.diagnostic?.detail ?? "the decisions log cannot be read" : undefined);
}

/** The rows this store holds, read without folding. */
function stored(root: string, universe: string): SharedDecisions {
  try { return decisionsProjection.read(db(root), decisionScope(universe)); } catch { return EMPTY; }
}
