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
  /**
   * How `id` and `bodyHash` were derived. Absent on rows indexed before this
   * existed, which reads as `legacy_live_derivation` — the reader's own index
   * cannot say, which is a different problem from a stored receipt that cannot.
   */
  derivation?: DerivationTag;
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

// ---------------------------------------------------------------------------
// Identity — who did this, at two levels
// ---------------------------------------------------------------------------

/**
 * WHO caused an action (always a person) and WHAT performed it (them, or an agent
 * acting for them). See `identity.ts` for how one is resolved.
 *
 * Structured rather than a string because the string was load-bearing and wrong:
 * `annotate` decides a finding's default disposition with
 * `author.startsWith("agent")`, so a person called "agentina" filed proposals and
 * an agent labelled anything else filed confirmed findings. `via` answers that
 * question by construction.
 *
 * Added ALONGSIDE the legacy `author`/`reviewer`/`by` strings rather than
 * replacing them. Records written before this cannot be attributed — nobody knows
 * who "me" was — and inventing a principal for them would be worse than admitting
 * it, so an absent `actor` means "legacy, unattributed" and stays that way.
 */
export interface Actor {
  /** A person. An agent never appears here — it appears in `via`, acting for one. */
  principal: string;
  /** GitHub login, when a caller knows it — for correlating with pull-request comments. */
  github?: string;
  /**
   * Present when an agent performed the action on the principal's behalf.
   * `model` is free text: the model list churns faster than any enum would ship,
   * and cross-checking findings across models is the reason to record it at all.
   */
  via?: { kind: "agent"; model?: string; harness?: string };
}

/**
 * How anchor ids are derived, as a number. BUMP IT whenever that changes.
 *
 * Ids are the identity of a piece of code, and a cached snapshot is a set of them.
 * Comparing a snapshot minted under one derivation against one minted under another
 * makes every affected symbol read as removed-and-added — 107 phantom "changes" on
 * one real pull request, across nine files that git says are byte-identical, which
 * put the review-queue coverage number permanently out of reach.
 *
 * The previous guard sniffed for NUMERIC disambiguators, so it caught the
 * ordinal→signature change and silently missed the next one (adding parameter
 * modifiers, which made an extension method's `(AcmeUser)` become `(thisAcmeUser)`).
 * A version cannot miss the next one.
 *
 *   1  ordinal disambiguators for overloads
 *   2  signature disambiguators, parameter TYPES only
 *   3  …plus parameter modifiers (`this`, `ref`, `out`, `in`, `params`)
 */
export const ANCHOR_SCHEME = 3;

/**
 * How a body hash is DERIVED, as a number. BUMP IT whenever normalization changes.
 *
 * The sibling of ANCHOR_SCHEME, and needed for the same reason one level down: an
 * id says WHICH code a mark is about, a hash says WHAT that code was. Change what
 * the tokens are and every stored witness — on reviews, bugs, triage and findings
 * alike — silently reads as drift, because a hash minted under one derivation and
 * one minted under another are unequal for a reason that has nothing to do with
 * anyone editing the code.
 *
 * Unlike ANCHOR_SCHEME this is carried IN the hash string (`h<N>:sha256:…`), not
 * beside it. A snapshot can be rejected wholesale, but a witness frozen on a
 * review years ago has to be individually self-describing — after a re-index the
 * live hashes are new-scheme while those witnesses are not, and only the value
 * itself can say so.
 *
 *   1  bare `sha256:…` — every hash minted before this constant existed
 *   2  `#region`/`#endregion` subtrees dropped; CR stripped inside multi-line tokens
 */
export const HASH_SCHEME = 2;

/**
 * How a durable code-derived value was produced — see PROPOSAL-provenance.md.
 *
 * Carried BY THE VALUE, never by the container holding it: a ref, a file or an
 * event is a bag of things derived at different moments, and three earlier
 * designs failed by attaching provenance to one.
 */
export interface DerivationTag {
  anchorScheme: number;
  hashScheme: number;
  /** SHA-256 over every shipped tree-sitter runtime artifact — loader AND wasm engine. */
  parserIntegrity: string;
  /** SHA-256 of the vendored grammar blob that produced this. */
  grammarDigest: string;
}

/**
 * Whether an inequality between two values derived this way means the CODE differs.
 *
 * A grammar re-vendor changes the token stream and therefore the body hash without
 * touching `HASH_SCHEME` — so the numeric schemes agree, the hashes differ, and
 * every symbol in the repository reads as changed. That is the phantom-diff failure
 * the scheme numbers were introduced to prevent, arriving through a door they do
 * not cover.
 *
 * An absent tag on either side falls back to comparing, which is today's behaviour.
 * It has to: every stored value predates tags, and answering "unverifiable" for all
 * of them would replace a rare false positive with a universal false negative. As
 * untagged snapshots are rebuilt the tagged path takes over.
 */
export function comparableHashDerivation(a?: DerivationTag, b?: DerivationTag): boolean {
  if (!a || !b) return true;
  // THREE fields, not four. `anchorScheme` governs whether two IDS name the same
  // symbol; it says nothing about whether two hashes of that symbol's body can be
  // compared, which is decided by the rules that produced the token stream.
  //
  // Including it was wrong in the direction that matters. A symbol whose id
  // derivation did not change across a scheme bump — anything without a
  // disambiguator — keeps its id, so a pair can differ on `anchorScheme` alone
  // while its hashes are perfectly comparable. Real drift then reported as
  // "cannot be decided", which a reviewer skips rather than reads.
  //
  // Ids are gated elsewhere and at the right granularity: `readSnapshot` refuses a
  // cache from another derivation, and `liveDerivationDrift` warns about `@work`.
  return a.hashScheme === b.hashScheme
    && a.parserIntegrity === b.parserIntegrity && a.grammarDigest === b.grammarDigest;
}

/**
 * Whether an inequality between two ANCHOR IDS derived this way means they name
 * different symbols.
 *
 * The other three-field projection of the same tag, and the sibling above is why it
 * needs a name of its own rather than a shared `comparableDerivation`: the two
 * questions exclude DIFFERENT fields, so a call site that picks by name rather than
 * by question gets a confident wrong answer.
 *
 *   hash comparability  = everything but `anchorScheme`
 *   id   comparability  = everything but `hashScheme`
 *
 * `hashScheme` is out because an id contains no body hash — `anchorId` sees only
 * file, symbol path and disambiguator. `grammarDigest` and `parserIntegrity` are IN
 * because two of those three inputs are read off the parse: two C# grammars mint
 * different ids for `M(ref string)` under one ANCHOR_SCHEME, which is the failure
 * this exists for. See docs/anchor-id-provenance.md §1-§2.
 */
export function comparableAnchorDerivation(a?: DerivationTag, b?: DerivationTag): boolean {
  if (!a || !b) return true;   // untagged falls back to comparing, as everywhere else here
  return a.anchorScheme === b.anchorScheme
    && a.parserIntegrity === b.parserIntegrity && a.grammarDigest === b.grammarDigest;
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
  | "unverifiable" // a cited anchor exists, but every accepted hash predates a HASH_SCHEME bump
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
   * The sidecar scope this version was folded from, when the fold owns this row.
   *
   * Absent means this user wrote it. The ownership rule turns on exactly this: a row
   * with an origin is written ONLY by the fold, and every local mutation is either an
   * origin-less operation or an event append. NOT the same fact as `generatedBy`,
   * which says a machine wrote the prose.
   */
  origin?: string;
  /** Who wrote it, when the fold owns this row. The principal, not the whole actor. */
  author?: string;
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
  /**
   * The sidecar scope this node's WINNING version came from, if a teammate wrote it.
   *
   * A field on the value on purpose: a caller that ignores it shows the doc, which is
   * the safe default. Whether that scope may be BELIEVED is a separate question with
   * one answer per scope — `docsVerdict` — rather than a copy per node that can drift.
   */
  origin?: string;
  /** Who wrote the winning version, when it is a teammate's. */
  author?: string;
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
//
// LEGACY, as of the `bugs` table. The live entity is `SharedBug` in
// `shared-bugs.ts`: one shape whether it came from this machine or a teammate's
// log, on the lifecycle findings already use. What is below is the shape of the
// `meta["bugs"]` blob that `migrateBugsBlob` reads once and drops, and it is kept
// only so that migration has a type. Nothing else should import it.
//
// `BugSeverity` and `BugWitness` are NOT legacy — both are still the vocabulary
// everywhere, and both are re-exported from the shared entity.

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

/**
 * What triage concluded about a finding.
 *
 *   open       filed, not yet investigated (the default)
 *   confirmed  real, as filed
 *   partial    real in part; `comment` states which part
 *   rerated    real, but the severity or impact differs from as-filed
 *   refuted    not a defect — a false positive
 *   accepted   real, deliberately not being fixed (a product or architecture call)
 */
export type Disposition = "open" | "confirmed" | "partial" | "rerated" | "refuted" | "accepted";

export const DISPOSITIONS: readonly Disposition[] = ["open", "confirmed", "partial", "rerated", "refuted", "accepted"];

/**
 * What goes to the submitter without being asked for by name.
 *
 * `open` is excluded because nobody has checked it yet; `refuted` and `accepted`
 * because they are conclusions about the finding rather than asks of the author.
 * All three stay individually publishable — a refutation the human already raised
 * on the PR is worth one line closing it out, which saves the submitter defending
 * a non-issue.
 */
export const PUBLISHABLE: readonly Disposition[] = ["confirmed", "partial", "rerated"];

/**
 * The `comment` cap. Over-length is REJECTED, never truncated: a comment cut off
 * mid-sentence loses the ask, which is the one part the submitter needs.
 */
export const COMMENT_MAX = 800;

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
  /**
   * The submitter-facing half of a finding: what is broken, where, and what to do.
   *
   * Separate from `text` because the two have different audiences and want
   * different documents. `text` is evidence for the map and for whoever triages —
   * what was checked, why the obvious alternative fails, what is still unverified.
   * `comment` is for the person who has to fix it, who does not want the
   * investigation. Writing one document for both means the PR-facing version gets
   * hand-rewritten outside the tool every time.
   *
   * It is also the ONLY thing that reaches them — not `text`, not `disposition`, not
   * the revisions — so it has to read as a standalone statement about the code. Copy
   * phrased against the filing ("confirmed", "wider than reported") describes a
   * baseline the submitter has never seen.
   *
   * Capped at COMMENT_MAX. The cap is the mechanism, not decoration: it makes
   * "verdict + evidence pointer + ask" the only shape that fits.
   */
  comment?: string;
  /**
   * What triage concluded. An enum rather than prose because the batch builder has
   * to filter on it — a refuted finding published to the submitter reads as
   * "actually this is not a bug", which is exactly the noise batching exists to
   * prevent. See PUBLISHABLE for what goes out by default.
   */
  disposition?: Disposition;
  /**
   * Where to publish a finding about code this pull request does not touch.
   *
   * GitHub only accepts a review comment on a file in the diff, and plenty of real
   * findings are about code the branch never edited (a fail-open predicate it now
   * makes reachable) or about an ABSENCE, which has no line anywhere. The human
   * picks the nearest file in the diff; nothing is guessed, because a comment on
   * the wrong file costs the submitter more than one that did not go out.
   */
  publishPath?: string;
  publishLine?: number;
  /** Publish under `[Claude]` or not. Defaults to whether an agent wrote `comment`. */
  publishAttribution?: "agent" | "human";
  /**
   * The human decided not to send this one. Distinct from clearing `escalated`,
   * which only exists on an agent's finding — a human's own finding is publishable
   * by having been written, so declining to send it needs its own record.
   */
  withdrawn?: {
    at: string; by: string;
    /**
     * Why it is not going out. Optional, but the reason is the whole value of the
     * record: "withdrawn" alone is indistinguishable from "forgotten", and the
     * common case — a duplicate of something already on the pull request — is only
     * legible if it names what superseded it.
     */
    reason?: string;
  };
  /** Where this landed on GitHub. Set by the publish; what makes editing it possible. */
  postedRef?: {
    pr: number;
    reviewId?: number;
    commentId?: number;
    url?: string;
    at: string;
    path?: string;
    line?: number;
    placement: "inline" | "file" | "body";
  };
  /**
   * Prior states, appended on every revision, never destroyed.
   *
   * Findings are filed before they are understood: a report goes in, investigation
   * says it was overstated or aimed at the wrong line, and the correction has to be
   * visible AS a correction. Write-once meant those corrections survived only in a
   * chat transcript.
   */
  revisions?: {
    at: string;
    by: string;
    /** The values as they stood BEFORE this revision — only the fields it changed. */
    was: Partial<Pick<Annotation, "text" | "comment" | "disposition" | "severity" | "publishPath" | "publishLine" | "witness" | "sourceRef" | "line">>;
  }[];
  /**
   * The code this was written against, witnessed the way bugs and reviews are.
   *
   * A finding is a claim ABOUT a body of code, and an anchor id is deliberately
   * ref-free — `EmailTemplateService` at that path is the same anchor on every
   * branch, which is what lets a review mark survive a rebase. The cost is that a
   * finding written while reading one branch lands on an anchor another branch's
   * review will read. Recording the hash makes that detectable: publishing a
   * finding whose witnessed body is not the body at the PR head is refused.
   *
   * Witnessed at `sourceRef`, so a finding raised on a symbol that exists only on a
   * branch is witnessed against the branch, not the working tree.
   */
  witness?: BugWitness;
  /**
   * Which ref the anchor was resolved and witnessed at — a commit sha, or `@work`
   * for the live index. Distinct from `createdCommit`, which is only ever the
   * working tree's HEAD and so says nothing about what was actually read.
   */
  sourceRef?: string;
  /** Who wrote it — an agent label or a person. Display only; see `actor`. */
  author: string;
  /**
   * Who wrote it, structured. Absent on records written before identity existed,
   * which are unattributable and must stay that way rather than be back-filled
   * with a guess. Every rule that asks "was this an agent?" or "is this the same
   * person?" reads THIS, never `author`.
   */
  actor?: Actor;
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
   * The human elected to send an AGENT's finding to the pull request.
   *
   * An agent's finding is a proposal. Publishing it posts under your account and
   * notifies the author, so vouching for it has to be a deliberate act rather than
   * a side effect of having looked at the symbol. A finding you wrote yourself
   * carries no flag — writing it WAS the act.
   */
  escalated?: { at: string; by: string };
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
/**
 * `tests` is NOT a `CoverageMark`, and that asymmetry is the point: every other state
 * can be reached by a `cover` rule, which lives in the gitignored store and binds one
 * machine. This one comes only from the `[tests]` bin in the committed `.codemapignore`,
 * because "tests are not documentation subjects" is a repo-wide fact and a local rule
 * cannot express one.
 */
export type CoverageState = "open" | "cited" | "covered" | "trivial" | "deferred" | "owned" | "tests";

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
  /** Display only — historically the literal "me". See `by`. */
  reviewer: string;
  /**
   * Who made the mark, structured. Absent on marks made before identity existed.
   * A sign-off is a statement about who read the code, so a shared queue that
   * cannot name them is not showing a sign-off at all.
   */
  by?: Actor;
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
  /**
   * This mark was not made about this symbol directly: it was made about the
   * anchor named here, whose body physically CONTAINS this one (a class and its
   * methods, a method and its local functions). The container's review pane shows
   * the whole span, so signing it reads the contained code too — but the two are
   * still separate marks, each witnessing its own hash, so a later edit to one
   * method stales that method alone.
   *
   * Only cover rows carry it. That is what makes withdrawing a container's
   * sign-off precise: it clears the rows it wrote and leaves untouched any mark
   * the reviewer made on a member directly.
   */
  coveredBy?: string;
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
/**
 * `unverifiable`: the stored hashes and the live one were minted under different
 * HASH_SCHEMEs, so their inequality says the hashing rules changed, not that the
 * code did. It must never be reported as `none` — that is read as staleness, and
 * a scheme bump would then flag every mark in the store rather than the handful
 * whose body actually moved.
 */
export type AcceptanceVia = "direct" | "replayed" | "reverted" | "unverifiable" | "none";

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
  /**
   * Per-FIELD provenance, when the mark came from a store that keeps it.
   *
   * The singular `source`/`likely`/`reason`/`witnesses` above are aliases of the
   * IMPORTANCE receipt — documented as such, because a record whose importance is a
   * human's and whose complexity is an agent's has no single truthful value for any of
   * them. Anything asking a question ABOUT A FIELD reads here. Optional: a legacy blob
   * has no per-field receipts to offer.
   */
  axes?: Partial<Record<"importance" | "complexity" | "tripwire", {
    source: TriageSource; likely: boolean; witnesses: BugWitness[]; at: string;
  }>>;
  /**
   * Fields where THIS clone's unpublished mark and the team's answer disagree.
   *
   * The value in the record is the PESSIMISTIC one — higher stakes, deeper complexity,
   * armed tripwire — because the cost is asymmetric: reviewing something too carefully
   * costs minutes, and reviewing it too lightly costs the thing this project exists to
   * prevent. That is the same rule the fold uses for concurrent divergence, so there is
   * one asymmetry in the system rather than two.
   *
   * Present means somebody should look: the safe reading is being shown, and it is not
   * what either side actually asserted. Publishing yours, or adopting theirs, ends it.
   */
  divergence?: { field: "importance" | "complexity" | "tripwire"; yours: string; theirs: string }[];
}

export interface TriageStore {
  schemaVersion: number;
  triage: Triage[];
}

// ---------------------------------------------------------------------------
// Requirements — the OTHER kind of claim (COD-29). A doc explains code and is
// therefore downstream of it; a requirement is upstream, and the code exists to
// satisfy it. That inversion is the whole reason this is a separate record kind
// and not a `LogicalNodeType`: every member of that union is code-shaped, so a
// business rule stored as a node inherits explanation semantics — it goes
// `stale` when code drifts, and the standing instruction for stale is
// `update_node`, i.e. rewrite the rule to match the drifted code. That launders
// a defect into documentation at the highest-authority place in the system.
//
// `LogicalNodeType` ends `| (string & {})` and is therefore OPEN: adding
// "requirement" to it type-checks and inherits all of the above silently.
// `requirements.test.ts` fails if a requirement ever reaches the node path.
// ---------------------------------------------------------------------------

/**
 * A requirement's lifecycle. There is deliberately **no `stale`**, and no trust.
 *
 * The load-bearing property of this type is what it omits. Cited code moving is
 * evidence about the CODE, not about the rule, so it produces a recheck-due signal
 * (derived at read time from `witnesses`, never stored) and never a status a reader
 * could clear by editing the statement.
 */
export type RequirementStatus = "ratified" | "retired";

/**
 * A **spec** — the unit of proposal, and the only way anything enters the standard.
 *
 * There is deliberately no second, cheaper path for a one-line change: a single amendment
 * is a spec with one operation. Two paths to amend means the cheap one is the real policy,
 * which is what happened to ITIL's "standard change" everywhere it was tried.
 *
 * The spec is NARRATIVE — it argues in its own order. The standard is a taxonomy. They are
 * different axes over the same content, which is why a spec's shape never becomes the
 * standard's shape; each operation says where its content files.
 */
export type SpecStatus = "draft" | "ratified" | "withdrawn" | "repealed";

export interface Spec {
  id: string;
  title: string;
  /**
   * Background and argument. **Non-operative**, and marked so on every surface.
   *
   * Both legislative drafting and ITIL change records pair plain language with an
   * operative change, and both document the same failure: the halves drift, the reviewer
   * reads the prose, the operative half is what lands. The structural defence is that
   * every operation carries its OWN rationale, so nothing here is load-bearing.
   */
  narrative?: string;
  status: SpecStatus;
  author: Actor;
  createdAt: string;
  ratifiedBy?: Actor;
  ratifiedAt?: string;
  /**
   * Adopted against a base that had already moved, so the fold applied NOTHING from it.
   *
   * Set by the fold, never written by a caller: it is a function of the log and every
   * clone derives the same answer. The spec stays `ratified` because that act really
   * happened — what did not happen is the application, and saying so is the honest record.
   */
  conflicted?: boolean;
  origin?: string;
}

export type OperationKind = "add_requirement" | "amend_statement" | "retire_requirement" | "add_criterion";

/**
 * How a criterion is discharged. A CLOSED list, adopted from the Acme.API spec playbook's
 * §13.2 rather than re-derived — it is production wording with a why-it-holds column, and
 * we would have arrived somewhere worse.
 *
 * `attestation` is the one that has to be watched. It is *"last resort only"*, weak by
 * construction, and the playbook's rule is the useful half: **an author who reaches for
 * attestation for something renderable has skipped the evidence, not chosen a type.**
 * Nothing here can decide whether a thing was renderable, so that stays a reader's job —
 * which is why `attestation` is named rather than quietly allowed as a default.
 */
export const EVIDENCE_KINDS = [
  "automated-test",         // behaviour: a named test, re-runnable by anyone
  "lint-test",              // an invariant — fails when the thing is REINTRODUCED
  "characterization-test",  // a refactor that must not change behaviour
  "screenshot",             // a UI surface; a human looks at it
  "persona-walk",           // reachability/visibility — reached VIA the entry point
  "recorded-run",           // jobs, migrations, reports: the artifact is the proof
  "attestation",            // last resort — see above
] as const;

/** Derived from the list, so the vocabulary cannot drift from what validation accepts. */
export type EvidenceKind = typeof EVIDENCE_KINDS[number];

/**
 * Whether anyone has established that a criterion's assertion CAN FAIL.
 *
 * COD-18 is explicit that `asserted_by` must not ship without this, and the reason is that
 * the citation makes a claim STRONGER: it converts *nobody edited the cited code* into
 * *green as of the last build*. Over a check that cannot fail, that is manufactured
 * confidence with a mechanism attached. The measured base rate is not reassuring — two of
 * three tests examined in one session were vacuous when written, and four of the oracle's
 * six invariants were.
 *
 * `unchecked` is the default and **must never render as `demonstrated`**, the same rule
 * `Conformance.unknown` carries for the same reason one level up.
 *
 * `wrong-layer` is the fourth state and neither COD-18 nor `audits.ts` names it: the check
 * is non-vacuous, it exercises a real falsifier, and it runs somewhere that cannot observe
 * the violation — the playbook's *"a Validate-only test on a handler bug is green paint"*
 * (§14.4). Folding it into `demonstrated` is the failure it describes; folding it into
 * `vacuous` misreports a check that does work, just not this work.
 */
export type Vacuity = "unchecked" | "demonstrated" | "vacuous" | "wrong-layer";

/**
 * Whether satisfying this operation can be undone — declared BEFORE ratification.
 *
 * ITIL writes the backout plan before approval because it changes the decision. This
 * makes nothing reversible; it makes irreversibility visible in time to matter, and it
 * constrains the future as much as it records the past: a requirement whose implementation
 * was irreversible is harder to amend later, which the next proposer has to see.
 */
export type Reversibility = "reversible" | "irreversible" | "unknown";

/**
 * The state an operation was written against.
 *
 * An instruction with no context applies cleanly to the wrong thing when the base has
 * moved — which is why `patch` carries context lines and refuses a hunk that does not
 * match. The fold verifies this and refuses; a reviewer who approved a rendering built
 * from the standard as of sign-off did not approve applying it to a standard that has
 * since changed.
 */
export interface OperationContext {
  requirementId: string;
  statement: string;
}

export interface Operation {
  id: string;
  specId: string;
  kind: OperationKind;
  /** Target. Absent for `add_requirement`, which creates one. */
  requirementId?: string;
  /** Payload for `add_requirement`, and the new statement for `amend_statement`. */
  title?: string;
  section?: string;
  statement?: string;
  provenance?: string;
  cites?: string[];
  /** Payload for `add_criterion`. See `AcceptanceCriterion` for what each one is. */
  criterion?: string;
  falsifier?: string;
  evidenceKind?: EvidenceKind;
  assertedBy?: string[];
  /**
   * For an `add_criterion` attaching to a rule THIS SPEC creates: the `add_requirement`
   * operation, because the rule has no id until the spec is ratified. The same shape
   * `Acknowledgement.operationId` uses, for the same reason.
   */
  targetOperationId?: string;
  /** Operative pairing — the rationale rides on the operation, never on the document. */
  rationale: string;
  /** What provoked it: a problem id, a finding id, a commit, a conversation. */
  evidence?: string;
  context?: OperationContext;
  reversibility: Reversibility;
  /** Application order within the spec. */
  ord: number;
  origin?: string;
}

export interface Requirement {
  id: string;
  /**
   * A short name for the rule — what a queue row, an index and a cross-reference show.
   *
   * Required, because most readers read the title and not the statement, which is why a
   * title that has drifted from its statement is the "confidently wrong prose suppresses
   * scrutiny" failure (COD-18) sitting on the most authoritative record in the system.
   */
  title: string;
  /**
   * Where the rule files in the STANDARD, as a `/`-delimited path — "Credit/Limits",
   * "Settlement/Float".
   *
   * Required for the same reason `provenance` is: optional organization is no
   * organization, and the alternative is what the merged spec clusters already are — a
   * few hundred well-formed claims in a flat heap. This is the standard's taxonomy, not
   * the shape of the spec that introduced the rule; those are different axes and each
   * operation says where its content files.
   */
  section: string;
  /** The rule itself. Only a ratified operation may change this — there is no edit path. */
  statement: string;
  /**
   * Where the rule comes from: a contract term, an IATA standard, a credit policy, one
   * customer's demand, or our own past choice. Free text on purpose — the vocabulary is
   * the business's and an enum would be wrong within a quarter.
   */
  provenance: string;
  status: RequirementStatus;
  /**
   * Anchors the rule is about. **MAY be empty**, and that is not a floating claim:
   * "no floating claims" governs the downstream direction, where a doc must point at
   * what it explains. An uncited requirement is one the code does not yet satisfy —
   * the missing gate, the absent default arm — which is a well-formed record.
   */
  cites: string[];
  /** Hashes of `cites` at ratification. A later mismatch is recheck-due, never stale. */
  witnesses: BugWitness[];
  author: Actor;
  createdAt: string;
  /** The spec that introduced it, and the ones that amended it. Its whole history. */
  introducedBy: string;
  amendedBy?: string[];
  ratifiedBy?: Actor;
  ratifiedAt?: string;
  retiredBy?: Actor;
  retiredAt?: string;
  /** Set by the sidecar fold only; a local row has none. Same marker as `node_versions`. */
  origin?: string;
}

/**
 * An **acknowledgement** — the rule stands, we know it is not met, do not raise it.
 *
 * ONE record for both shapes rather than two, because they differ only on whether
 * conforming code exists and share an identical lifecycle. The specific reason, beyond
 * the general one-canonical-table rule: an acknowledgement is a **silencer**, and there
 * must be exactly one thing to count when asking how much of the standard is currently
 * silenced.
 *
 * `basis` routes the reporting — *how much have we not built* stays a different question
 * from *how much do we owe* — without splitting the mechanism.
 *
 * There is deliberately **no magnitude field**. A gap's size is its population, which is
 * counted rather than estimated; an estimate here would be a self-report by the party
 * whose judgement is in doubt, which is COD-17's refuted `coverage.method` in different
 * clothes. It arrives when the population predicate does.
 */
export type AcknowledgementBasis = "gap" | "debt";

export type AcknowledgementState = "active" | "released";

/** Orders the revalidation queue among records falling due together. */
export type AcknowledgementPriority = "high" | "medium" | "low";

export interface Acknowledgement {
  id: string;
  basis: AcknowledgementBasis;
  /**
   * For a `gap`: the operation it was raised against, while the spec was still a draft.
   *
   * This is what makes the mint-time asymmetry structural rather than advisory — a gap
   * cannot be minted against a ratified requirement because the path takes an operation
   * in a draft spec. Filing one in response to a raised problem would be the laundering
   * pattern arriving through a third door: not *amend the rule to match the code*, but
   * *declare the rule not yet applicable*.
   */
  operationId?: string;
  /** The rule. Bound at ratification for a gap; required up front for debt. */
  requirementId?: string;
  rationale: string;
  priority: AcknowledgementPriority;
  /**
   * ISO date. **The release condition**, and the only one.
   *
   * Never an external work item: `track_bug` already settled that shape — being tracked
   * elsewhere is not being fixed — and a condition living in a system nothing guarantees
   * becomes unreachable when a ticket is closed as won't-do, moved, renamed or deleted.
   * The acknowledgement would then silence the audit permanently, and silently.
   */
  revalidateBy: string;
  /** A ticket, a commit, a conversation. EVIDENCE, never the release condition. */
  workItem?: string;
  state: AcknowledgementState;
  grantedBy: Actor;
  grantedAt: string;
  releasedBy?: Actor;
  releasedAt?: string;
  releasedReason?: string;
  origin?: string;
}

/**
 * An **audit** — somebody checked a rule against the code, and this is what they did.
 *
 * Produced whether or not anything was found. A positive audit is a first-class record
 * rather than the absence of a problem, because it is the only thing that can do two jobs
 * nothing else does: **close a gap** (a gap has no code to witness, so it cannot drift and
 * would otherwise outlive its truth in silence) and **make a regression detectable** (once
 * a rule has been met, a later failure is a problem rather than a gap that was always
 * there).
 */
export type AuditOutcome = "conformant" | "nonconformant" | "indeterminate";

/**
 * What the auditor ACTUALLY did — the non-vacuity requirement, as a recorded fact.
 *
 * A positive audit has an effect: it closes a gap and silences the mechanism that would
 * have caught the thing. So *"I checked and it conforms"* from an actor that did not
 * really check is worse than a vacuous test — it manufactures confidence AND disables the
 * detector. Two of three tests examined in one session were vacuous when written, and four
 * of six of the oracle's own invariants were; assume the same rate here.
 *
 * The fix cannot be prompt wording. *"Check thoroughly"* is steering, and steering is not
 * merely ignorable — a tool description may never be sent at all (see the note above the
 * tool table in `mcp.ts`). So it is recorded and enforced: an audit that says nothing about
 * what it read or ran cannot claim an outcome.
 */
export interface AuditEvidence {
  /** Anchors whose source was actually read. */
  read?: string[];
  /** Commands actually executed, and whether they passed. */
  ran?: { command: string; passed: boolean }[];
  /**
   * Documentation consulted.
   *
   * Recorded but **weaker on purpose**: auditing a doc against a requirement inherits the
   * doc's errors, and the failure is silent — a stale or missing doc yields a pass, not a
   * flag. Doc-only evidence therefore does not move a rule to `conformant`.
   */
  consulted?: string[];
}

export interface Audit {
  id: string;
  requirementId: string;
  outcome: AuditOutcome;
  evidence: AuditEvidence;
  /** Hashes of what was read. A later mismatch means this audit is about older code. */
  witnesses: BugWitness[];
  /** What the auditor concluded, in their own words. */
  finding: string;
  auditor: Actor;
  at: string;
  commit?: string | null;
  branch?: string | null;
  /**
   * Taken somewhere other than the default branch, so it is about somebody's work in
   * progress rather than about the codebase.
   *
   * A provisional audit is real work and stays local: it never enters the shared log,
   * because broadcasting "the code violates rule X" from a feature branch announces a
   * non-conformance that may not exist on the default branch and may never. What makes
   * the same finding live is a fresh audit after the merge — and that is honest, because
   * the merged code is different code.
   */
  provisional?: boolean;
  /**
   * The provisional audit this re-records as an observation of the codebase.
   *
   * Present on the promotion, not on the original: the original was taken on a branch and
   * rewriting it would falsify its own record. It also stops a finding being promoted
   * twice, which is otherwise invisible — the original stays non-superseded for ever.
   */
  promotedFrom?: string;
  origin?: string;
}

/**
 * A **problem** — two authorities disagree, and neither is presumed right.
 *
 * A finding says *the code is wrong*. A doc says *the code does X*. A problem says only
 * that a ratified rule and the code do not agree, and it is **un-adjudicated by
 * construction**: there is no verdict field an agent can set, and no input that accepts
 * one. If the auditor filed this as a finding, the filing act would already have decided
 * the question in the direction the agent is least entitled to decide — an agent can
 * establish non-conformance, it cannot establish which side should move.
 *
 * Note what is NOT here: a `state`. Open, adjudicated and closed are DERIVED, because a
 * stored state is a field, and a field is something a writer can satisfy. There is no
 * `closeProblem` verb anywhere for the same reason — you cannot close a problem, you can
 * only do the thing that closes it.
 */
export type ProblemDisposition =
  /** The rule stands and the code violates it. Closed by a conformant audit. */
  | "code-wrong"
  /** The business moved. Closed by a ratified spec amending the rule. */
  | "requirement-changed"
  /** The rule did not change; our statement of it was incomplete. Closed the same way. */
  | "requirement-misstated"
  /** Non-conformant and we are living with it. Closed by a granted debt acknowledgement. */
  | "accepted";

export interface Problem {
  id: string;
  requirementId: string;
  /**
   * The audit that established non-conformance. **Positive evidence only** — a problem
   * cannot be raised from an `indeterminate` audit, because "I could not verify this" is
   * an unverified requirement rather than a violation. Without that gate this becomes the
   * 138-false-positives problem again.
   */
  auditId: string;
  summary: string;
  /**
   * What the auditor thinks should happen. **Context, never a resolution** — it is
   * recorded precisely so it does not have to be smuggled in as one.
   */
  prior?: string;
  raisedBy: Actor;
  raisedAt: string;
  /** Raised from a provisional audit — local to this branch, never broadcast. */
  provisional?: boolean;
  /** Set only by `adjudicate`, and only by a principal. */
  disposition?: ProblemDisposition;
  adjudicatedBy?: Actor;
  adjudicatedAt?: string;
  adjudicationReason?: string;
  origin?: string;
}

/**
 * A requirement's id, DERIVED from the operation that creates it.
 *
 * Lives here, in the leaf, because BOTH the local apply and the sidecar fold have to
 * compute it and neither may import the other. Not random, and the reason is the fold
 * rather than tidiness: the standard is a projection of the ratified specs, so every
 * clone replays the same operations and must arrive at the same ids. A random id would
 * give each machine its own name for the same rule — and would never fail locally, where
 * there is only ever one clone.
 */
export function requirementIdFor(operationId: string): string {
  return "r_" + createHash("sha256").update(operationId).digest("hex").slice(0, 12);
}

export interface RequirementStore {
  schemaVersion: number;
  requirements: Requirement[];
}

/**
 * An acceptance criterion: **what** discharges a rule and **how** it would be refuted.
 *
 * The second citation relation lives here. `Requirement.cites` is the code a rule is
 * ABOUT — its staleness is *that code moved*. `assertedBy` is the check that WOULD FAIL if
 * the rule stopped holding — its staleness is *the build is red*. Snapshot versus live,
 * and codemap can only observe the first half: it never runs anything, so what it watches
 * is the assertion's own hash. That is deliberate and it is the pin the scrub was missing —
 * *fired → was edited → now quiet* is the detector being modified by the change it exists
 * to detect, and nothing else catches it.
 *
 * Separate from `Requirement` because it is a separate record in the design: a pointer is
 * WHERE TO LOOK, a criterion is WHAT and HOW to verify, and one criterion can be watched
 * from several pointers. Created only by a ratified `add_criterion` operation — declaring
 * what discharges a rule can NARROW it in practice, which is the silencing direction, and
 * the standing asymmetry gates what silences.
 */
export interface AcceptanceCriterion {
  id: string;
  requirementId: string;
  /** What must be true — concrete and verifiable, in the playbook's §7 sense. */
  criterion: string;
  /**
   * The observation that would show the criterion is **not** met.
   *
   * Required, and it is the highest-value thing adopted from the playbook (§13.1): *"if
   * you cannot write what observation would show the criterion is not met, it is prose,
   * not a criterion."* It is the PRE-COMMITMENT form of non-vacuity — written at drafting,
   * before the code exists, so it cannot be fitted to whatever the check turned out to do.
   * Every non-vacuity guard in `audits.ts` fires at AUDIT time, when the author already
   * knows what passed; this is the only one that cannot.
   */
  falsifier: string;
  evidenceKind: EvidenceKind;
  /**
   * The check itself, as anchors. **MAY be empty**: a criterion is written before the code
   * exists, so an unasserted criterion is a rule waiting for its check, not a malformed
   * record — the same shape as an uncited requirement being *unsatisfied* rather than
   * floating.
   */
  assertedBy: string[];
  /** Hashes of `assertedBy` at ratification. A later mismatch means the DETECTOR moved. */
  witnesses: BugWitness[];
  author: Actor;
  createdAt: string;
  /** The operation that introduced it — its whole provenance. */
  introducedBy: string;
  specId: string;
  origin?: string;
}

/**
 * A criterion's id, DERIVED from the operation that creates it — for the reason
 * `requirementIdFor` is derived: every clone replays the same operations and must arrive
 * at the same ids, and a random id never fails locally where there is only one clone.
 */
export function criterionIdFor(operationId: string): string {
  return "ac_" + createHash("sha256").update(operationId).digest("hex").slice(0, 12);
}

/**
 * WHERE an auditor should look to decide whether a rule still holds.
 *
 * Distinct from the acceptance criterion beside it, and conflating them is easy because
 * both sit at the same seam: the criterion states WHAT would discharge the rule and HOW it
 * would be refuted; the pointer is the ADDRESS. One criterion can be watched from several
 * pointers, and one pointer can serve several rules.
 *
 * **A pointer never changes the conformance state — it changes queue position.** That is
 * the whole discipline: `conformant` stays reachable only through a code-backed audit, in
 * both directions, because even a failing test proves the *invariant* broke and whether
 * the *requirement* broke depends on whether the check faithfully encodes it. Letting
 * green pointers read as conformance is the vacuity trap one level up — a cheap signal
 * certifying — and it is the trade `recordAudit`'s evidence refusal already forbids.
 *
 * What it buys is the thing the queue needs at seeding scale, where nearly everything is
 * `unknown`: **`unknown` stops being uniform.** A rule audited last week with three quiet
 * pointers and a rule never audited with none are both honestly unknown, and they belong
 * in very different places in the queue.
 *
 * Because it cannot silence anything, declaring one is open to any actor — unlike an
 * acceptance criterion, which can NARROW what discharges a rule and therefore goes through
 * a ratification. The defence against a rule quietly having nothing watching it is not a
 * gate but visibility: **a requirement with no pointer can never rise**, so "unwatched" is
 * the requirement-side twin of `unknown` and must not read as settled.
 */
export interface Pointer {
  id: string;
  requirementId: string;
  /**
   * The observable. **Aim as HIGH up the abstraction ladder as it reaches** — a lint
   * covers a population and survives any single site changing, a doc-of-a-pattern covers
   * everything the pattern governs and survives refactors within it, and one anchor covers
   * one symbol and survives almost nothing, because a rename mints a new id.
   *
   * So an anchor is the LAST RESORT rather than the default, which cuts against the
   * instinct: the map's own primitive is a citation to an anchor, and reaching for one here
   * produces a pointer that goes quiet exactly when the code it governs is edited.
   *
   * Only two kinds, because the third rung is not a separate kind — a check is an anchor in
   * a `[tests]` path, and `ServedPointer.rank` derives that rather than asking a writer to
   * declare it. That is also why tests are indexed at all (`docs/population-predicate.md`).
   */
  target: { kind: "node" | "anchor"; id: string };
  /** Why this address is the one to watch — the reasoning a later reader has to judge. */
  rationale: string;
  /**
   * Hashes of what it watches, at declaration: the anchor itself, or a doc's citations.
   *
   * A mismatch is the pointer FIRING. One mechanism for both kinds, deliberately — the
   * `code changes → doc stales → pointer` path is not special-cased, because a doc going
   * stale IS its cited anchors moving, observed from the other side.
   */
  witnesses: BugWitness[];
  state: "active" | "retired";
  declaredBy: Actor;
  declaredAt: string;
  /** Re-baselined by `restatePointer` — somebody looked, so this is the new quiet. */
  restatedBy?: Actor;
  restatedAt?: string;
  retiredBy?: Actor;
  retiredAt?: string;
  retiredReason?: string;
  origin?: string;
}

/**
 * Somebody tried to make a criterion's assertion fail, and reports what happened.
 *
 * A RECORD rather than a field on the criterion, and that is the load-bearing choice.
 * COD-18 asks for a "vacuity field"; a stored field is something a writer can satisfy, and
 * worse, **a derived value with nothing to invalidate it is permanent** — a `demonstrated`
 * flag would survive a rewrite of the very lint it certifies, which is the exact pathology
 * `assertedBy` exists to catch, reintroduced one level up. So this is witnessed like an
 * audit, and it goes `superseded` when the assertion it examined moves.
 *
 * Open to any actor, gated on EVIDENCE, in both directions:
 *
 *  - `demonstrated` is the SILENCING direction — it says the check is trustworthy, which
 *    is what lets an audit lean on it — so it must say what was broken and what went red.
 *  - `vacuous` / `wrong-layer` weaken a criterion, which is the safe direction, and the
 *    same rule that lets anyone RELEASE an acknowledgement applies: its failure mode is
 *    noise, and gating it would be gating what unsilences.
 */
export interface VacuityCheck {
  id: string;
  criterionId: string;
  verdict: Exclude<Vacuity, "unchecked">;
  /**
   * What was done: the mutation made, and what the assertion did in response.
   *
   * The evidence, and required for `demonstrated` — *"I checked and it can fail"* from an
   * actor that did not really check manufactures exactly the confidence the record exists
   * to supply, which is `recordAudit`'s argument arriving one layer down.
   */
  method: string;
  /** Hashes of the criterion's `assertedBy` AS EXAMINED. A mismatch supersedes this. */
  witnesses: BugWitness[];
  checkedBy: Actor;
  at: string;
  origin?: string;
}
