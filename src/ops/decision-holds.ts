/**
 * The one door for decisions on the read side (plan C1): the folded rounds and, for every
 * finding, held / not held / unknown. `decision_rounds`, `decision_round`, `review_queue`,
 * `findings` and `shared_findings` all ask it and nothing else, so no surface can answer "held"
 * differently from another. Its own module because `ops/annotations` cannot reach `ops-shared`
 * without closing a cycle through `ops/triage`.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db.js";
import { decisionScopeHasEvents, decisionFindingStates, decisionBugStates, readStoreMeta, writeStoreMeta } from "../store.js";
import { canonicalIssueKey, type CanonicalIssueReference } from "../decision-issues.js";
import { readCachedMerged, sidecarUnusable } from "../materialize.js";
import { decisionsProjection } from "../shared-projections.js";
import { resolveSidecar, sidecarIdentity, universeKey } from "../sidecar-config.js";
import { isClosed, type FindingState } from "../shared-findings.js";
import { comparisonHoldApplies, decisionScope, decisionScopes, foldDecisions, heldFindings, heldIssues, supersededFindings, type Hold, type SharedDecisions } from "../shared-decisions.js";
import { LINEAR_SHARD, overlayActive, type ScopeDiagnostic, type ScopeStatus } from "../eventlog.js";

/** What a row carries: its holds, or `"unknown"`, and whether its decision may be superseded. */
export interface HoldMark {
  held?: Hold[] | "unknown";
  /** Verified words not yet bound may overturn the ruling that placed this (plan A3). A mark,
   *  never a reason to withhold (owner, S0.8(a)). */
  possiblySuperseded?: { decision: string; words: string[] }[];
}

export interface WorkEligibility {
  allowed: boolean;
  /** Every active restriction remains visible, even when another has been released. */
  restrictions: Hold[] | "unknown";
  reason?: string;
}

/** A later human assignment can release an ordinary hold for work. A semantic comparison
 * needs its own judgment or resolution; neither assignment nor an interactive caller does it. */
export function workEligibility(mark: HoldMark, assigned?: { at: string; by: { principal: string; via?: { kind: "agent" } } }, kind: "finding" | "bug" = "finding"): WorkEligibility {
  const held = mark.held;
  if (held === "unknown") return { allowed: false, restrictions: "unknown", reason: `the decisions log cannot establish whether this ${kind} is eligible for work` };
  if (!held?.length) return { allowed: true, restrictions: [] };
  const hard = held.filter((h) => h.why !== "undecided" && h.why !== "ruled");
  if (hard.length) return { allowed: false, restrictions: held, reason: `${kind} work awaits comparison: ${hard.map((h) => h.answers?.join(" / ") ?? h.decision).join(", ")}` };
  const began = Math.max(...held.map((h) => Date.parse(h.since)));
  const humanAssignment = !!assigned && !assigned.by.via && Number.isFinite(Date.parse(assigned.at)) && Date.parse(assigned.at) > began;
  if (humanAssignment) return { allowed: true, restrictions: held };
  return { allowed: false, restrictions: held, reason: `a decision holds this ${kind} from work: ${held.map((h) => `${h.decision} (${h.why})`).join(", ")}` };
}

export interface DecisionsView {
  s: SharedDecisions;
  status: ScopeStatus;
  /** Set when which findings are held cannot be known — never "none" from a log nobody could
   *  read (H7.14). */
  unknown?: string;
  /** The mark for finding `id` — the same for every row under that id (owner, P3.1 (3)). */
  mark(id: string): HoldMark;
  work(id: string, assigned?: { at: string; by: { principal: string; via?: { kind: "agent" } } }): WorkEligibility;
  issueMark(ref: CanonicalIssueReference): HoldMark;
  issueWork(ref: CanonicalIssueReference, assigned?: { at: string; by: { principal: string; via?: { kind: "agent" } } }): WorkEligibility;
  /** Open unless every row under the id says closed (owner, S0.8(e)). */
  isOpen(id: string): boolean;
}

const EMPTY: SharedDecisions = { rounds: [], decisions: [], questions: [], comparisons: [] };

let builds = 0;
/** How many times the hold maps have been built in this process. For tests; no production caller. */
export const holdBuilds = (): number => builds;

/** This store has folded decisions from a sidecar before — at least one event (S0.8(b)): a
 *  zero-event read, like opening the page on a universe with none, is not evidence of any. */
function foldedBefore(root: string, universe?: string): boolean {
  return decisionScopeHasEvents(root, universe ? decisionScope(universe) : undefined);
}

export async function decisionsView(root: string): Promise<DecisionsView> {
  // Built once per call: whether a finding is open, by id, across every review key it is under.
  const universe = resolveSidecar(root)?.universe ?? universeKey(root);
  const open = new Map<string, boolean>();
  const openIssues = new Map<string, boolean>();
  try {
    for (const r of decisionFindingStates(root)) {
      open.set(r.id, (open.get(r.id) ?? false) || !isClosed(r.state as FindingState));
      if (r.source_scope?.startsWith(`findings/${universe}/`)) {
        const key = canonicalIssueKey({ kind: "finding", universe, scope: r.source_scope, review: r.pr, id: r.id });
        openIssues.set(key, !isClosed(r.state as FindingState));
      }
    }
  } catch { /* no findings table yet */ }
  try {
    for (const r of decisionBugStates(root)) {
      if (r.source_scope === `bugs/${universe}`) {
        const key = canonicalIssueKey({ kind: "bug", universe, scope: r.source_scope, id: r.id });
        openIssues.set(key, !isClosed(r.state as FindingState));
      }
    }
  } catch { /* no bugs table yet */ }
  const isOpen = (id: string) => open.get(id) ?? false;
  const isOpenIssue = (key: string) => openIssues.get(key) ?? false;

  const view = (s: SharedDecisions, status: ScopeStatus, unknown?: string): DecisionsView => {
    // Built on the first mark read, once per view: a write reads the view for its rows only
    // (P2.2 (7)).
    let marks: { held?: Map<string, Hold[]>; issues?: Map<string, Hold[]>; flagged: ReturnType<typeof supersededFindings> } | undefined;
    const built = () => {
      if (!marks) { builds++; marks = { ...(unknown ? {} : { held: heldFindings(s, universe, isOpen), issues: heldIssues(s, isOpenIssue) }), flagged: supersededFindings(s, universe) }; }
      return marks;
    };
    const mark = (id: string): HoldMark => {
      const { held, flagged } = built();
      const h = held ? held.get(id) : "unknown";
      const p = flagged.get(id);
      return { ...(h === "unknown" || h?.length ? { held: h } : {}), ...(p ? { possiblySuperseded: p } : {}) };
    };
    const issueMark = (ref: CanonicalIssueReference): HoldMark => {
      const { issues } = built();
      const typed = issues ? issues.get(canonicalIssueKey(ref)) ?? [] : "unknown";
      if (ref.kind === "bug") return typed === "unknown" || typed.length ? { held: typed } : {};
      const legacy = mark(ref.id);
      if (typed === "unknown" || legacy.held === "unknown") return { ...legacy, held: "unknown" };
      const exactLegacy = (legacy.held ?? []).filter((hold) => comparisonHoldApplies(s, hold, ref));
      const combined = [...exactLegacy, ...typed];
      return { ...legacy, ...(combined.length ? { held: combined } : {}) };
    };
    return {
      s, status, ...(unknown ? { unknown } : {}), isOpen,
      mark,
      work: (id, assigned) => workEligibility(mark(id), assigned),
      issueMark,
      issueWork: (ref, assigned) => workEligibility(issueMark(ref), assigned, ref.kind),
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
  const { value, status } = await cachedDecisions(root, cfg);
  return view(value, status, status.status === "blocked" ? status.diagnostic?.detail ?? "the decisions log cannot be read" : undefined);
}

/**
 * The workspace's decisions, through the cache: every decisions scope folded together and stored
 * under this universe's legacy key, so `source_scope` and every reader of the rows are unchanged.
 * Never folded one scope alone (`projectionFor` does not offer it): an act in `law/decisions` on a
 * legacy decision would be refused by a fold that cannot see the decision.
 */
export async function cachedDecisions(root: string, cfg: { path: string; universe: string })
  : Promise<{ value: SharedDecisions; status: ScopeStatus; folded: boolean; fresh: boolean }> {
  // Absent is not empty, over the set the fold reads: the fold is total, so folding without a
  // scope it read before would write its rows away. Both callers come through here.
  // Asked only on the way to declining: `wrongSidecar` may spawn git, which a read must not pay.
  const gone = decisionsAbsence(root, cfg);
  if (gone) return { value: stored(root, cfg.universe), status: { status: "blocked", diagnostic: sidecarUnusable(root, cfg.path) ?? gone }, folded: false, fresh: false };
  const scopes = await decisionScopes(cfg.path);
  // None on disk, none staged and none read before: not folded, so no zero-event row is
  // written (S0.8(b)).
  if (!scopes.some((s) => existsSync(join(cfg.path, s)) || overlayActive(cfg.path, s))) return { value: EMPTY, status: { status: "complete" }, folded: false, fresh: true };
  const { value, folded, fresh, ...status } = await readCachedMerged(root, cfg.path, scopes, decisionScope(cfg.universe),
    sidecarIdentity(cfg), (events) => foldDecisions(events), decisionsProjection,
    (read) => writeStoreMeta(root, DECISIONS_READ, read));
  return { value, status, folded, fresh };
}

/** The decisions scopes this store's stored fold read events from (`cachedDecisions`). */
const DECISIONS_READ = "decisions-scopes-read";

/** Adopting a sidecar replaces the rows, so nothing read from the old one is expected in it.
 *  An empty record, not none: none falls back to the pre-record seed below. */
export const forgetDecisionScopesRead = (root: string): void => writeStoreMeta(root, DECISIONS_READ, []);

/**
 * A `sidecar-missing` diagnostic when a decisions scope this store has folded events from is
 * gone, or null. Every reader of decisions authority asks it before reading the merged log —
 * `cachedDecisions` and each op that calls `readDecisionLog` — because the scope list comes from
 * the disk, so a vanished scope otherwise reads `complete` over the rest.
 */
export function decisionsAbsence(root: string, cfg: { path: string; universe: string }): ScopeDiagnostic | null {
  let read = readStoreMeta<string[]>(root, DECISIONS_READ);
  if (!read) {
    // No record: last folded by a build before it, which folded only this universe's own scope.
    // Persisted at once, because an overlay fold writes that same `shared_scope` row: seeding
    // later would read a dropped staged act as "folded before", and decline for good.
    read = foldedBefore(root, cfg.universe) ? [decisionScope(cfg.universe)] : [];
    writeStoreMeta(root, DECISIONS_READ, read);
  }
  // The shard, not the directory, and its bytes: deleting the file leaves the directory, and
  // emptying it leaves the file; either folds as empty. A recorded scope had an event.
  const gone = read.find((s) => !(statSync(join(cfg.path, s, LINEAR_SHARD), { throwIfNoEntry: false })?.size));
  if (!gone) return null;
  return { reason: "sidecar-missing", detail: `${gone} is missing from ${cfg.path}, and this store has read decisions from it before`, evidence: [cfg.path] };
}

/** The rows this store holds, read without folding. */
function stored(root: string, universe: string): SharedDecisions {
  try { return decisionsProjection.read(db(root), decisionScope(universe)); } catch { return EMPTY; }
}
