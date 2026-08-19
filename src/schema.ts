/**
 * The `.codemap/` format — single source of truth for the on-disk model.
 *
 * Two layers:
 *   1. Anchors (physical grounding): a hashed handle to a specific code symbol.
 *      Anchors are NOT graph nodes; they are the leaves that logical nodes cite.
 *   2. Logical nodes + edges (the map): modules / processes / steps that describe
 *      the code, each citing the anchors it depends on. A logical claim with no
 *      anchor does not exist — that invariant is what makes staleness detectable.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// On-disk layout
// ---------------------------------------------------------------------------

export const CODEMAP_DIR = ".codemap";
export const DB_FILE = "codemap.db"; // the SQLite store (see src/db.ts)
// Legacy JSON layout — retained only so `src/db.ts` can import a pre-SQLite
// `.codemap/` on first open. The live store is now the DB, not these files.
export const ANCHORS_FILE = "anchors.json"; // AnchorStore
export const GRAPH_FILE = "graph.json"; // { edges: Edge[] }
export const STATE_FILE = "state.json"; // State
export const NODES_DIR = "nodes"; // one <id>.md per LogicalNode
export const BUGS_FILE = "bugs.json"; // { bugs: Bug[] }
export const ANNOTATIONS_FILE = "annotations.json"; // { annotations: Annotation[] }
export const COVERAGE_FILE = "coverage.json"; // { rules: CoverageRule[] }
export const ANALYZERS_FILE = "analyzers.json"; // { enabled: string[], lastEmit: Record<string,string> }
export const REVIEWS_FILE = "reviews.json"; // { reviews: Review[] }

export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Anchors — the physical grounding layer
// ---------------------------------------------------------------------------

export type AnchorKind =
  | "namespace"
  | "module"
  | "class"
  | "interface"
  | "struct"
  | "enum"
  | "record"
  | "method"
  | "constructor"
  | "function"
  | "property"
  | "variable";

export interface Anchor {
  /** Deterministic id derived from (file, symbolPath, disambiguator). */
  id: string;
  /** Repo-relative POSIX path. */
  file: string;
  /**
   * Ordered container chain ending in the symbol itself, e.g.
   * ["FakeBank.Api.Wits", "WitsValidator", "Validate"]. Stored as an array so
   * we never have to pick a separator that collides with a language's syntax.
   */
  symbolPath: string[];
  kind: AnchorKind;
  /**
   * Distinguishes overloads / merged declarations that share a symbolPath
   * (C#/TS overloads, C# `partial`, TS declaration merging). A normalized
   * signature or an ordinal — absent when the symbolPath is already unique.
   */
  disambiguator?: string;
  /** "sha256:..." over the normalized, comment-stripped token stream. */
  bodyHash: string;
  /** Commit at which bodyHash was last confirmed to match reality. */
  lastVerifiedCommit: string | null;
  /**
   * Advisory source location, refreshed on every index. NOT part of the id or
   * hash — line numbers drift constantly. For jump-to-code in the UI/agent;
   * always re-resolve live for exactness. NOTE: `startByte`/`endByte` are a
   * historical misnomer — they are UTF-16 code-unit indices into the parsed
   * source string (what web-tree-sitter returns, matching node.text), NOT UTF-8
   * byte offsets. Slice the decoded STRING with them, never a raw Buffer.
   */
  loc?: { startByte: number; endByte: number; startLine: number; endLine: number };
}

export interface AnchorStore {
  schemaVersion: number;
  anchors: Anchor[];
}

/** Stable anchor id — same inputs always yield the same id across re-indexes. */
export function anchorId(
  file: string,
  symbolPath: string[],
  disambiguator?: string,
): string {
  const h = createHash("sha256");
  h.update(file);
  h.update("\0");
  h.update(symbolPath.join("\0"));
  if (disambiguator !== undefined) {
    h.update("\0");
    h.update(disambiguator);
  }
  return "a_" + h.digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Logical nodes + edges — the map layer
// ---------------------------------------------------------------------------

/**
 * Node type. The core kinds are module/process/step; the vocabulary is open so
 * analyzers can add their own (e.g. the Marten analyzer's `event_family`) without
 * the core knowing about them. The `(string & {})` keeps literal autocomplete.
 */
export type LogicalNodeType = "module" | "process" | "step" | "event_family" | "aggregate" | "projection" | "command" | "handler" | "state" | "transition" | (string & {});

/**
 * A doc is a *set of versions* (see docs/doc-versioning.md). Each version records
 * the anchors it cites WITH the hashes it was written against ("accepted hashes",
 * a set so one version can be valid on several branches). Resolution picks the
 * version whose accepted hashes match the current branch's live anchors — so each
 * branch resolves to its own version, by hash-match, without branch tags.
 */
export interface NodeCitation {
  anchorId: string;
  /** bodyHashes this version is known-valid against (one per branch confirmed). */
  acceptedHashes: string[];
}

export type NodeStatus =
  | "fresh" // every cited anchor exists and its live hash is accepted here
  | "stale" // a cited anchor exists but its live hash isn't accepted (code drifted)
  | "dangling" // a cited anchor is absent from @work (code removed/renamed) — a hole
  | "removed" // a tombstone wins here — the doc's subject was intentionally removed
  | "generated"; // analyzer-emitted; not versioned (regenerated per branch)

export interface NodeVersion {
  versionId: string;
  nodeId: string;
  type: LogicalNodeType;
  title: string;
  summary: string;
  body: string;
  citations: NodeCitation[];
  /** Analyzer that generated this node (e.g. "marten"); absent = human-authored. */
  generatedBy?: string;
  /**
   * A tombstone — the doc's subject was intentionally removed. A tombstone is
   * "fresh" on a branch where its cited anchors are ABSENT (the removal holds),
   * and loses to a live content version on branches where they still exist. So
   * "removed on feat, live on develop" resolves by presence-match, no git needed.
   */
  removed?: boolean;
  /** Commit this version was written against — load-bearing for git-aware tiebreak. */
  createdCommit: string | null;
  createdBranch: string | null;
  createdAt: string;
}

/**
 * The RESOLVED view of a node on the current branch: the winning version's content
 * plus derived status. Kept shape-compatible with the old single-version node
 * (`anchors` = the winning version's cited anchor ids) so consumers don't change.
 */
export interface LogicalNode {
  id: string;
  type: LogicalNodeType;
  title: string;
  summary: string;
  /** Anchor ids this node's (winning version's) claims depend on. */
  anchors: string[];
  /** Free-form markdown body. */
  body: string;
  /** Analyzer that generated this node (e.g. "marten"); absent = human-authored. */
  generatedBy?: string;
  // --- resolution metadata (absent on legacy reads) ---
  versionId?: string;
  status?: NodeStatus;
  /** Cited anchors whose live hash isn't accepted by the winning version. */
  staleAnchors?: string[];
  /** Cited anchors absent from @work (holes). */
  danglingAnchors?: string[];
  /** How many versions this node has (>1 = forked). */
  versionCount?: number;
}

export type EdgeType =
  | "part_of" // module -> module (containment / hierarchy)
  | "depends_on" // module -> module (structural dependency)
  | "step_of" // step -> process (ordered via `order`)
  | "touches" // step -> module (the keystone: unifies process & structure)
  | "calls_api" // cross-universe: consumer node -> producer endpoint (qualified `to`, e.g. "api::handler")
  // Analyzer-supplied vocabulary (Marten): the type set is open so plugins add
  // relationships without the core knowing them.
  | "folds" // event_family -> aggregate (Apply/Create)
  | "projects" // event_family -> projection (Transform)
  | "emits" // handler -> event_family
  | "handles" // handler -> command
  // State-machine vocabulary (see docs/state-map.md): states + transitions are
  // NODES (a transition is a claim and must cite anchors); these edges wire them.
  | "state_of" // state -> aggregate
  | "transition_of" // transition -> aggregate (tether; survives even with no static target)
  | "transitions_to" // transition -> state (target; generated when static, authored for dynamic)
  | "on_event" // transition -> event_family
  | "initial_state" // aggregate -> state (Create-assigned / property default)
  | "from_state" // state -> transition (source; AUTHORED during enrichment, never generated)
  | (string & {});

export interface Edge {
  from: string; // LogicalNode.id
  to: string; // LogicalNode.id
  type: EdgeType;
  /** Sequence position, for ordered edges like `step_of`. */
  order?: number;
  /** Analyzer that generated this edge (e.g. "marten"); absent = human-authored. */
  generatedBy?: string;
}

export interface Graph {
  edges: Edge[];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface State {
  schemaVersion: number;
  /** Commit the index was last brought in sync with; null if never / no git. */
  lastVerifiedCommit: string | null;
  /**
   * Branch the live index was last baselined on. When the checked-out branch
   * differs from this, `check` re-inits the anchor index to the new branch's
   * HEAD (a branch switch means "I'm looking at different code now"). Absent on
   * indexes built before this field existed — recorded on first `check`.
   */
  branch?: string | null;
  /** grammar name -> vendored grammar version, for reproducibility. */
  grammarVersions: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

export type StalenessStatus =
  | "ok" // anchor re-resolved and hash matches
  | "candidate_stale" // anchor re-resolved but hash changed — needs review
  | "lost"; // symbolPath no longer resolves — moved/renamed/deleted

export interface AnchorCheck {
  anchorId: string;
  status: StalenessStatus;
  /** New hash when candidate_stale (so a review can see what it became). */
  newHash?: string;
}

export interface StalenessReport {
  checks: AnchorCheck[];
  /** LogicalNode ids flagged because ≥1 cited anchor is stale or lost. */
  flaggedNodes: string[];
}

// ---------------------------------------------------------------------------
// Bugs — findings anchored to code, re-validatable when that code changes
// ---------------------------------------------------------------------------

export type BugStatus = "open" | "fixed" | "wontfix" | "invalid";
export type BugSeverity = "low" | "medium" | "high" | "critical";

/** Snapshot of an anchor's hash when the bug was filed / last reviewed. */
export interface BugWitness {
  anchorId: string;
  bodyHash: string;
}

export interface Bug {
  id: string;
  title: string;
  status: BugStatus;
  severity: BugSeverity;
  /** Prose: what's wrong, repro, expected vs actual. */
  description: string;
  /** Anchors where the breakage lives — the "exact areas". */
  anchors: string[];
  /**
   * Hashes of `anchors` at filing/last-review time. When a witness no longer
   * matches the live hash, the underlying code changed — the bug is "possibly
   * fixed" and should be re-validated. Same mechanism as doc staleness.
   */
  witnesses: BugWitness[];
  createdCommit: string | null;
  /** Free-form log of status changes / resolution notes. */
  history: string[];
}

export interface BugStore {
  schemaVersion: number;
  bugs: Bug[];
}

// ---------------------------------------------------------------------------
// Annotations — notes on anchors or nodes, for agents and human readers
// ---------------------------------------------------------------------------

export interface Annotation {
  id: string;
  target: { kind: "anchor" | "node"; id: string };
  text: string;
  /**
   * The review-annotation vocabulary (mirrors CI code-review workflows):
   *   - `note` (default) — a durable remark.
   *   - `question` — an ask a human/agent should answer; open-questions queue.
   *   - `finding` — a raised issue/requirement needing attention (a potential bug,
   *     a missing check). Carries `severity`/`category`. Stays open until `resolved`.
   *   - `pointer` — a review AID, not a defect: "when reviewing this block, watch
   *     out for X / confirm Y." Guides the human reviewer to the thing that matters.
   */
  kind?: "note" | "question" | "finding" | "pointer";
  /** For findings/pointers: how much attention it deserves (reuses the bug/triage scale). */
  severity?: BugSeverity;
  /** Freeform review category — "Authorization", "Logic", "Tenant Safety", … (from the CI vocabulary). */
  category?: string;
  resolved?: boolean;
  /**
   * Optional 1-based line pin (for an anchor target): a finding/pointer raised on a
   * specific line during code review, so it renders against the exact line and you
   * can sign a segment off with the action item recorded.
   */
  line?: number;
  /** Who wrote it — an agent label or a person. */
  author: string;
  createdCommit: string | null;
  /**
   * Handed to an agent to act on. The reviewer's half of the loop: raising a
   * finding records it, assigning it asks for something to be done.
   *
   * `investigate` — go find out whether this is real and report back.
   * `fix` — make the change. Deliberately scoped to ONE file: a fix that spans
   *   files is a piece of work to hand a proper agent, not something to slip into
   *   someone's branch from a review tool. An agent that finds it needs more must
   *   decline and say why, which is a useful answer rather than a failure.
   */
  assignment?: { to: "agent"; kind: "investigate" | "fix"; at: string; by: string; note?: string };
  /**
   * What the agent did. Kept separate from `resolved` because closing the loop and
   * agreeing it is closed are different acts: the agent reports, the human resolves.
   */
  outcome?: {
    at: string;
    by: string;
    result: "fixed" | "answered" | "declined";
    detail: string;
    /** Files actually touched — the receipt for the single-file rule. */
    files?: string[];
  };
}

export interface AnnotationStore {
  schemaVersion: number;
  annotations: Annotation[];
}

// ---------------------------------------------------------------------------
// Coverage & scope — "documented" is a state, not just "is it cited"
// ---------------------------------------------------------------------------

/**
 * Effective per-anchor state (derived, never stored per-anchor):
 *   open     — nobody has claimed it; the real work queue
 *   cited    — a node explicitly cites it (load-bearing)
 *   covered  — claimed by a node's rule but not load-bearing (counts as done)
 *   trivial  — never worth documenting (getters, enum members); out of denominator
 *   deferred — a subtree intentionally not documented here; out of denominator
 *   owned    — documented in another universe (shared kernel); out of denominator
 */
export type CoverageState = "open" | "cited" | "covered" | "trivial" | "deferred" | "owned";

/** What a rule can assign (cited is derived from citation, never a rule). */
export type CoverageMark = "covered" | "trivial" | "deferred" | "owned";

/** Selects a set of anchors by human-friendly criteria (all present fields AND). */
export interface AnchorSelector {
  pathPrefix?: string; // file starts with
  file?: string; // exact repo-relative file
  kind?: string; // anchor kind
  symbol?: string; // glob on the leaf symbol name, e.g. "Apply*"
}

/**
 * A stored, re-applied rule. Rules match live anchors, so members added later
 * inherit the state instead of re-polluting the queue — the reason coverage is
 * rules, not per-anchor flags (which `init` would regenerate away).
 */
export interface CoverageRule {
  id: string;
  as: CoverageMark;
  node?: string; // for `covered`: the node that conceptually covers these
  owner?: string; // for `owned`: the universe that owns the real doc
  select: AnchorSelector;
}

export interface CoverageStore {
  schemaVersion: number;
  rules: CoverageRule[];
}

/**
 * Which framework analyzers are "covering" this universe. Once enabled, a `check`
 * re-runs the analyzer's emission when code changed — so the generated graph stays
 * current without a manual refresh. `lastEmit` records the commit each analyzer was
 * last emitted at (to skip re-running when nothing moved).
 */
export interface AnalyzerConfig {
  schemaVersion: number;
  enabled: string[];
  lastEmit: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Reviews — a human marking parts as reviewed, staleness-aware (same witness
// mechanism as bugs: a review goes `stale` when the code it covered changes).
// ---------------------------------------------------------------------------

export type ReviewLevel = "logical" | "code"; // read the doc vs read the source
export type ReviewState = "unreviewed" | "reviewed" | "stale";

export interface Review {
  id: string;
  target: { kind: "node" | "anchor"; id: string };
  level: ReviewLevel;
  reviewer: string;
  /**
   * Who vouched. "human" = a person reviewed it (top trust: `verified`). "agent"
   * = an agent read the code and confirmed the claims hold (`checked` — a corroborating
   * read, not a human blessing). Absent = legacy human review. See `trustOf`.
   */
  actor?: "human" | "agent";
  /**
   * Sub-splits the *human* act into two independent, separately witness-hashed marks:
   *   "viewed" = exposure — "I've laid eyes on this, intuition didn't fire" (does NOT
   *              vouch; it's the pass that elicits questions).
   *   "signed" = ownership — the liability-bearing sign-off (this is `verified`).
   * A human can be `signed` on an old hash yet not have re-`viewed` the new one, so the
   * two are separate rows. Absent on an agent review = `checked`; absent on a legacy
   * human review = `signed` (see `effectiveAttestation`).
   */
  attestation?: "viewed" | "signed";
  at: string; // ISO timestamp
  reviewedCommit: string | null;
  /** Hashes of the covered anchors at review time; a mismatch later = `stale`. */
  witnesses: BugWitness[];
  /**
   * Every body this mark has ever approved, per anchor, with where it happened.
   *
   * `witnesses` holds one hash per anchor and is overwritten on each re-mark, so
   * signing the same symbol on a second branch destroyed the first sign-off — a
   * stacked PR chain, where the same symbols recur with different hashes, loses
   * approvals as you walk down it. An acceptance is really a statement about
   * (anchor, body): it should hold wherever that body appears.
   *
   * Provenance is per entry because *how* the code got here matters. Arriving at
   * an older approved body by switching refs is navigation; a new commit on this
   * ref's own ancestry moving back to one is a revert, and only the second is
   * worth interrupting someone for. See `resolveAcceptance`.
   */
  accepted?: AcceptedCitation[];
}

export interface AcceptedEntry {
  bodyHash: string;
  /** Commit the acceptance was made against — the ancestry probe for revert detection. */
  commit: string | null;
  branch: string | null;
  at: string;
}

export interface AcceptedCitation {
  anchorId: string;
  /** Oldest first. Capped; see ACCEPTED_CAP. */
  entries: AcceptedEntry[];
}

/**
 * How a live body relates to what this mark has approved.
 *   direct   — the newest acceptance on this ref's own ancestry; the ordinary case.
 *   replayed — approved, but on a lineage this ref does not descend from.
 *   reverted — approved earlier on THIS ancestry, then superseded there by a
 *              different body, and the code has since moved back to it.
 *   none     — never approved.
 */
export type AcceptanceVia = "direct" | "replayed" | "reverted" | "none";

/** Keep the accepted set from growing without bound on a much-revised symbol. */
export const ACCEPTED_CAP = 24;

export interface ReviewStore {
  schemaVersion: number;
  reviews: Review[];
}

// ---------------------------------------------------------------------------
// Triage — the stakes of an anchor/node (blast radius if wrong), which sets how
// much review it demands. Combined with the review attestation (viewed/signed),
// it yields a severity (see docs/triage.md). Absent = untriaged (escalates until
// looked at). Agents/graph may only *raise* stakes (`likely`); a human owns lowering.
// ---------------------------------------------------------------------------

// Stakes — blast radius if wrong. NOT how hard it is to verify (that's `Complexity`).
// Legacy stores may carry "mechanical" here (the old low-stakes tier) → normalized to
// "low" on read; see triage.ts normImportance.
export type Importance = "business-critical" | "important" | "low";
// Complexity — how much careful thought it takes to verify the code is correct,
// independent of stakes. `deep` subtle logic · `standard` real but tractable ·
// `rote` a mechanical/checklist verification (e.g. authz: right permission + AuthCheck
// on the right entity) · `wiring` pure plumbing (DTO map, projection fold).
export type Complexity = "deep" | "standard" | "rote" | "wiring";
export type TriageSource = "graph" | "agent" | "human";

export interface Triage {
  target: { kind: "node" | "anchor"; id: string };
  importance: Importance; // stakes (blast radius)
  /** Verification difficulty (review depth), orthogonal to stakes. Absent = untriaged complexity. */
  complexity?: Complexity;
  /** Agent/graph proposal, not yet confirmed by a human. A human mark is never `likely`. */
  likely: boolean;
  /** Alert-on-change, independent of the review bar (see docs/triage.md). */
  tripwire?: boolean;
  source: TriageSource;
  /** Provenance when graph/agent-derived (re-emit safe), mirrors node `generatedBy`. */
  generatedBy?: string;
  reason?: string;
  at: string; // ISO timestamp
  /** Anchor hashes at triage time — a mismatch later triggers re-triage (Phase 4). */
  witnesses: BugWitness[];
}

export interface TriageStore {
  schemaVersion: number;
  triage: Triage[];
}
