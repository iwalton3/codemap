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
  | "property";

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
   * always re-resolve live for exactness.
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
export type LogicalNodeType = "module" | "process" | "step" | "event_family" | "aggregate" | "projection" | "command" | "handler" | (string & {});

/**
 * The parsed form of a `nodes/<id>.md` file: YAML frontmatter fields plus the
 * markdown body. `anchors` is the load-bearing field — it is what a staleness
 * pass follows to decide which nodes a code change invalidates.
 */
export interface LogicalNode {
  id: string;
  type: LogicalNodeType;
  title: string;
  summary: string;
  /** Anchor ids this node's claims depend on. Empty = a floating claim. */
  anchors: string[];
  /** Free-form markdown body (everything after the frontmatter). */
  body: string;
  /** Analyzer that generated this node (e.g. "marten"); absent = human-authored. */
  generatedBy?: string;
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
  /** Who wrote it — an agent label or a person. */
  author: string;
  createdCommit: string | null;
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
  at: string; // ISO timestamp
  reviewedCommit: string | null;
  /** Hashes of the covered anchors at review time; a mismatch later = `stale`. */
  witnesses: BugWitness[];
}

export interface ReviewStore {
  schemaVersion: number;
  reviews: Review[];
}
