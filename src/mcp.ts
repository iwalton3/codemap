/**
 * codemap MCP server — zero dependencies, workspace-aware.
 *
 * MCP's stdio transport is newline-delimited JSON-RPC 2.0: one JSON message per
 * line each way. stdout is the protocol channel — logging goes to stderr.
 *
 * Launch with either a single repo (single-universe) or a workspace manifest:
 *   node dist/mcp.js /working/Acme.API
 *   node dist/mcp.js /working/codemap.workspace.json
 *
 * Per-universe tools take an optional `universe` (defaults to the primary), so
 * one server serves several projects concurrently and links them at boundaries.
 */

import * as ops from "./ops.js";
import * as multi from "./multi.js";
import { loadWorkspace, type Workspace, type Universe } from "./workspace.js";
import { METHODOLOGY } from "./guide.js";
import { analyzeMarten } from "./analyzers/marten.js";
import { enableAnalyzer } from "./analyzers/run.js";
import { markReviewed, unmarkReviewed } from "./reviews.js";
import { withLock } from "./lock.js";

/**
 * Tools that write to a universe's `.codemap/` are held under the write lock, so a
 * concurrent CLI run or a second agent cannot clobber a read-modify-write.
 *
 * Declared as `mutates: true` on the tool ITSELF rather than in a separate list of
 * names. That list drifted from the handlers twice: `close_finding` ran unlocked,
 * and so did `triage` and `triage_derive` — the latter rewriting the whole triage
 * store on every call. A flag beside the handler cannot fall out of step with it.
 */

// Anti-self-vouching guard: node ids this MCP CONNECTION authored/edited this
// session. An agent can't `sanity_check` (or agent-review) a doc its own
// connection wrote — the `checked` tier only means it, only means a *different*
// session corroborated. A later connection starts fresh, so it may check.
const authoredHere = new Set<string>();
const trackAuthored = (r: any) => { if (r && r.ok && r.id) authoredHere.add(r.id); return r; };
const guardSelfCheck = (u: string, targetKind: string, targetId: string) =>
  targetKind === "node" && authoredHere.has(targetId)
    ? { error: `this connection authored "${targetId}" — a different session must sanity-check it (no self-vouching)` }
    : null;

const PROTOCOL_VERSION = "2024-11-05";

const target = process.argv[2] ?? process.env.CODEMAP_ROOT ?? process.cwd();
let ws: Workspace;
try {
  ws = await loadWorkspace(target);
} catch (e: any) {
  process.stderr.write(
    `codemap-mcp: failed to load workspace "${target}": ${e?.message ?? e}\n` +
      `  Expected a repo directory or a valid codemap.workspace.json manifest.\n`,
  );
  process.exit(1);
}

interface Ctx {
  ws: Workspace;
  universe: Universe;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Writes to `.codemap/` — run under the cross-process write lock. */
  mutates?: boolean;
  handler: (args: any, ctx: Ctx) => Promise<unknown>;
}

// Build an object schema; `perUniverse` appends the optional universe selector.
const obj = (
  properties: Record<string, unknown>,
  required: string[] = [],
  perUniverse = true,
): Record<string, unknown> => ({
  type: "object",
  properties: perUniverse
    ? { ...properties, universe: { type: "string", description: "Universe id (default: primary)." } }
    : properties,
  required,
  additionalProperties: false,
});

/**
 * §5 of docs/findings-publishing-spec.md, verbatim in every tool that writes a
 * `comment`. It is the part that determines whether the feature works: a bare
 * "write a short version" reliably yields an ABSTRACT of the finding, which is a
 * different document from a comment to the person who has to fix it. The worked
 * example is what makes the difference, so it travels with the rule.
 */
const COMMENT_CONTRACT =
  "\n\n`comment` — READ BY THE PR SUBMITTER, who wants to know what is broken and what to do about it. They do not want the investigation. IT IS THE WHOLE MESSAGE THEY GET: they never see the finding as filed, your `text`, the `disposition`, or any earlier revision. So a comment opening \"confirmed\", \"as filed\", \"wider than reported\", \"partly right\" or \"still open\" is written against a baseline the reader does not have. At most 800 characters (over-length is REFUSED, not trimmed). Three parts, in order:\n"
  + "  1. WHAT IS BROKEN — one sentence, stated as a defect, not as a suspicion.\n"
  + "  2. WHERE / THE EVIDENCE — file:line plus the smallest quote that proves it.\n"
  + "  3. THE ASK — the change, or the decision needed.\n"
  + "ORDER BY DISPOSITION — stating every verdict in ABSOLUTE terms, as a fact about the code. A `partial` or `rerated` one leads with THE DEFECT THAT REMAINS, written in full as if filed fresh; name the cleared half only if the submitter would otherwise go hunting for it, and state it as a fact (\"the read side is safe — every consumer treats undefined as not-accepted\"), never as a retraction. A real `partial` that opened \"X cannot express this, so the ad-hoc filter is correct\" read as a refutation on a skim and was dropped by a reviewer filtering refutations out. `refuted` is the one disposition with a shared baseline — it goes out only where the human already raised the concern ON the pull request — so it leads with the withdrawal, said as what the code does correctly.\n"
  + "ENFORCED, like the length cap: an opening that grades the finding (\"Confirmed…\", \"Partial —\", \"Real, but…\", \"Still open:\") is REFUSED, as is a withdrawal lead (\"Withdrawing this…\") on any disposition but `refuted`. The check reads the first few words only, so a defect sentence that happens to start on one of those words (\"Partial writes are not rolled back — …\") passes.\n"
  + "Omit: how you found it, what you ruled out, what you checked and cleared, why it was filed, tool names, and any narration of your own process. Those go in `text`, which is not published.\n"
  + "GOOD: \"The by-id branch has no tenant predicate — `CreateTicket.cs:1006` queries `Aircraft` on `x.Id == request.AircraftId.Value` while the registration branch below scopes to `x.OperatorId == operatorId`. Add the same `.Where`. Currently an existence oracle over the aircraft table (`:512` blocks the actual attach, so this is not an IDOR).\"\n"
  + "BAD: the same finding written for the map — opening \"PARTLY CONFIRMED — the missing predicate is real; the stated IMPACT is overstated\", then three paragraphs of what was traced and a severity re-rating discussion. All correct, all valuable in `text`, all noise to the person who has to fix it.\n"
  + "ALSO BAD: \"Confirmed and wider than filed: five fields, not three.\" — short, on-topic, and still unreadable: \"wider than filed\" and \"not three\" cite a filing the reader has never seen. Say what the five fields are and what is wrong with them.";

const DISPOSITION_DOC =
  "What triage CONCLUDED about the finding: \"open\" (filed, nobody has checked it — the default), \"confirmed\" (real as filed), \"partial\" (real in part; `comment` states the part that is real, in full), \"rerated\" (real, but the severity or impact differs from as-filed), \"refuted\" (not a defect — a false positive), \"accepted\" (real, deliberately not being fixed). Only confirmed/partial/rerated go to the submitter unasked; the rest stay on the map unless the human names them.";


const tools: Tool[] = [
  {
    name: "list_universes",
    description: "List the universes (repos) this server serves, which is primary, and per-universe counts. Use to see what projects and cross-links are available.",
    inputSchema: obj({}, [], false),
    handler: () => multi.listUniverses(ws),
  },
  {
    name: "guide",
    description: "The documentation methodology: how to orient, document at the right granularity, connect, and file bugs. Re-read this any time you're unsure how to proceed.",
    inputSchema: obj({}, [], false),
    handler: async () => ({ methodology: METHODOLOGY }),
  },
  {
    name: "init",
    description: "Build the anchor index for a universe that isn't mapped yet — run this FIRST if any tool answers \"codemap not initialized\", instead of falling back to reading the codebase by hand. `list_universes` shows `initialized: false` for a universe that needs it. Safe to re-run on an initialized universe: it is the same full re-baseline as `reindex` and leaves docs, edges, reviews, coverage, bugs and annotations untouched. Note it only builds the ANCHOR index — the map's documentation starts empty, so follow with `outline` / `find_gaps`.",
    inputSchema: obj({}),
    mutates: true,
    handler: (_a, c) => ops.init(c.universe.path),
  },
  {
    name: "status",
    description: "Overview of one universe: anchor/doc/edge/bug counts and how many anchors are undocumented.",
    inputSchema: obj({}),
    handler: (_a, c) => ops.status(c.universe.path),
  },
  {
    name: "outline",
    description: "Drill down the structural tree (derived from anchor paths) one level at a time, with anchor counts, documentation coverage %, and node/bug rollups per child. Omit prefix for the repo root; pass a dir prefix to expand it, or a file path to list its symbols. The way to understand a large codebase top-down. Per-directory coverage reports `docPct` (cited OR swept in by a `cover` selector) and `citedPct` (actually cited by a doc) separately — read the gap between them as \"claimed\" vs \"described\". For a big file pass `compact: true` to get just {id, symbol, kind, lines} per symbol instead of the full per-anchor coverage/review payload — that is the cheap symbol listing, no need to grep the file.",
    inputSchema: obj({
      prefix: { type: "string", description: "Directory or file prefix to expand (default: repo root)." },
      compact: { type: "boolean", description: "File listings only: return {id, symbol, kind, lines} per symbol and nothing else." },
    }),
    handler: (a, c) => ops.outline(c.universe.path, a.prefix ?? "", { compact: !!a.compact }),
  },
  {
    name: "find_gaps",
    description: "The documentation work queue: only `open` anchors (in-scope, uncited, not marked covered/trivial/deferred/owned), ranked by likely value. Filter by path prefix or kind.",
    inputSchema: obj({
      pathPrefix: { type: "string" },
      kind: { type: "string" },
      limit: { type: "number" },
    }),
    handler: (a, c) => ops.findGaps(c.universe.path, a),
  },
  {
    name: "context",
    description: "ANSWER-FIRST: before exploring code, ask what codemap already knows about it. Given refs (files, dirs, `file#Symbol`, `file:line`, or anchor ids), returns a `verdict` (covered/partial/stale/gap), the covering docs with trust level, flows/open-bugs on that code, and the still-undocumented `gaps`. Read `trusted` docs instead of re-reading the code; explore only the gaps.",
    inputSchema: obj({ refs: { type: "array", items: { type: "string" }, description: "Files, dirs, file#Symbol, file:line, or anchor ids — the code you're about to work in." } }, ["refs"]),
    handler: (a, c) => ops.context(c.universe.path, a.refs),
  },
  {
    name: "lint_summaries",
    description: "Zero-cost drift check (no code read): nodes whose SUMMARY makes an absolute claim (only/all/always/never/…) while the BODY carries a qualifier (except/unless/…) — a summary/body self-contradiction, the most common doc drift. Review candidates: verify each (usually just re-read the body) and `update_node` to bound the summary, or dismiss. Bounded by construction: it compares a doc against ITSELF, so it cannot see a claim that contradicts the CODE — use `sanity_check` (read the cited code, confirm or correct) for that.",
    inputSchema: obj({}),
    handler: (a, c) => ops.lintSummaries(c.universe.path),
  },
  {
    name: "cover",
    description: "Mark selected anchors so they stop polluting `find_gaps`. `as`: covered (claimed by a node, not load-bearing) | trivial (never document — getters, Apply overloads) | deferred (a subtree not documented here) | owned (documented in another universe — pass `owner`). The selector is stored and re-applied, so anchors added later inherit the state. Select by pathPrefix / file / kind / symbol-glob (e.g. \"Apply*\").",
    inputSchema: obj({
      as: { type: "string", enum: ["covered", "trivial", "deferred", "owned"] },
      node: { type: "string", description: "For `covered`: the node that conceptually covers these." },
      owner: { type: "string", description: "For `owned`: the universe id that owns the real doc." },
      select: {
        type: "object",
        properties: {
          pathPrefix: { type: "string" },
          file: { type: "string" },
          kind: { type: "string" },
          symbol: { type: "string", description: "Glob on the leaf symbol name, e.g. \"Apply*\"." },
        },
        additionalProperties: false,
      },
    }, ["as", "select"]),
    mutates: true,
    handler: (a, c) => ops.cover(c.universe.path, a),
  },
  {
    name: "check_stale",
    description: "Staleness pass for a universe: which anchors changed/vanished since baseline and which docs they flag. Also auto re-inits the anchor index if the checked-out branch changed since it was baselined (a branch switch = different code) — the result then includes `rebaselined`.",
    inputSchema: obj({}),
    mutates: true,
    handler: (_a, c) => ops.checkStale(c.universe.path),
  },
  {
    name: "reindex",
    description: "Force a full re-baseline: re-index the whole repo at the CURRENT HEAD and replace the live anchor index, advancing the baseline commit/branch. Use when the index is pinned to an old commit and newly-added files/symbols aren't resolving (e.g. a subsystem added after the last init). NON-DESTRUCTIVE to the map — nodes, edges, reviews, coverage, bugs, and annotations are untouched; only anchors + baseline move (and the commit is cached as a diff snapshot). `check_stale` does this automatically on a branch change; call `reindex` to refresh same-branch drift on demand.",
    inputSchema: obj({}),
    mutates: true,
    handler: (_a, c) => ops.reindex(c.universe.path),
  },
  {
    name: "snapshot",
    description: "Cache the current commit's anchors as an immutable snapshot (a fresh full index), so this branch can be diffed later WITHOUT checking it out again. Run it on a branch before switching away. `init` snapshots automatically; use this to (re)cache the current commit on demand.",
    inputSchema: obj({}),
    mutates: true,
    handler: (_a, c) => ops.snapshot(c.universe.path),
  },
  {
    name: "snapshots",
    description: "List the cached commit snapshots available to diff (ref sha, branch, when captured, anchor count).",
    inputSchema: obj({}),
    handler: (_a, c) => ops.snapshots(c.universe.path),
  },
  {
    name: "diff_doc",
    description: "Diff a doc's PROSE across a branch diff: resolves which version of node `id` wins on `base` vs `head` and, if they differ (a fork), line-diffs their title/summary/body. Shows how the DOCUMENTATION changed between branches — grounds a code diff in the human-readable intent. Omit head to compare base against the working tree.",
    inputSchema: obj({ base: { type: "string" }, head: { type: "string" }, id: { type: "string" } }, ["base", "id"]),
    handler: (a, c) => ops.docDiff(c.universe.path, a.base, a.head, a.id),
  },
  {
    name: "diff",
    description: "Diff two anchor snapshots for reviewing a branch/PR: added/removed/changed symbols plus the impact on the docs, flows, and reviews that cite them. `base` is a cached snapshot (branch/tag/sha — cache it first with `init`/`snapshot`). Omit `head` to diff against a fresh index of the CURRENT working tree (the usual PR-review path: you've checked out the branch under review); or pass a second cached ref for a pure historical set-op.",
    inputSchema: obj({ base: { type: "string" }, head: { type: "string" } }, ["base"]),
    handler: (a, c) => ops.diff(c.universe.path, a.base, a.head),
  },
  {
    name: "analyze",
    description: "Run an opt-in framework analyzer. analyzer: 'marten' — for Marten/Wolverine event-sourced C#. Returns consistency-check findings (commands with no handler/endpoint; events appended but never folded/projected/consumed). verbose:true adds read-model-gap review findings. emit:true writes the event graph as nodes+edges (event_family/command/handler/aggregate/projection + folds/projects/handles/emits, tagged generatedBy:marten) AND registers the analyzer so `check_stale` auto-refreshes it when code changes — no manual re-emit.",
    inputSchema: obj({
      analyzer: { type: "string", enum: ["marten"] },
      verbose: { type: "boolean" },
      emit: { type: "boolean" },
    }, ["analyzer"]),
    mutates: true,
    handler: async (a, c) => {
      const r = await analyzeMarten(c.universe.path, { verbose: Boolean(a.verbose) });
      if (!a.emit) return r;
      const e = await enableAnalyzer(c.universe.path, a.analyzer);
      return e.error ? { ...r, emitError: e.error } : { ...r, enabled: true, emitted: e.emitted };
    },
  },
  {
    name: "search",
    description: "Search anchors and nodes for a substring. Node hits carry a trust level (trusted / unverified / stale) from freshness × review — prefer a `trusted` doc over re-reading code. Set allUniverses:true to search every universe.",
    inputSchema: obj({ query: { type: "string" }, limit: { type: "number" }, allUniverses: { type: "boolean" } }, ["query"]),
    handler: (a, c) => (a.allUniverses ? multi.searchAll(ws, a.query, a.limit) : ops.search(c.universe.path, a.query, a.limit)),
  },
  {
    name: "get_node",
    description: "Read a node: summary/body, anchors, edges (with cross-universe endpoints resolved), inbound cross-universe links, and annotations.",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    handler: (a, c) => multi.getNodeEnriched(ws, c.universe.id, a.id),
  },
  {
    name: "get_anchor",
    description: "Read an anchor with its source code, citing nodes, related bugs, annotations, and review state. Use before documenting or filing a bug.\n\nThe source is the WORKING TREE's, and the response says so (`sourceRef: \"@work\"`, `sourceCommit`). During a pull-request review that is a THIRD version — not the PR's head, and not whatever branch you were last reading. An anchor id carries no ref (the same path+symbol is one anchor on every branch), so if you are reviewing a PR, get its bodies from `pr_packet`, and check `sourceCommit` before quoting this one as evidence.",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    handler: (a, c) => ops.getAnchor(c.universe.path, a.id),
  },
  {
    name: "flows",
    description: "All flows (process nodes) with step counts and review progress — the review bird's-eye view.",
    inputSchema: obj({}),
    handler: (_a, c) => ops.flows(c.universe.path),
  },
  {
    name: "nodes",
    description: "The node catalog: every logical node with type, domain, edge degree (in/out), provenance (generatedBy), and review state, plus byType/byDomain rollups. The node-first index for browsing/auditing the whole graph (complements flows and the file outline).",
    inputSchema: obj({}),
    handler: (_a, c) => ops.nodeCatalog(c.universe.path),
  },
  {
    name: "event_matrix",
    description: "Event wiring matrix for an event-sourced graph: events as rows, the aggregates/projections they feed as columns (cells = folds/projects), plus per-event emitter count and review state. Surfaces ORPHAN events (folded/projected by nothing) as blank rows — the audit view for checking every event is wired into an aggregate + read model.",
    inputSchema: obj({}),
    handler: (_a, c) => ops.eventMatrix(c.universe.path),
  },
  {
    name: "pipeline_graph",
    description: "Layered event-pipeline graph: the chain command → handler → event → aggregate → projection, one column per role, nodes ordered within columns (barycenter) to reduce edge crossings. The whole-application graph view. Optional `domain` narrows the left columns to one subsystem. Returns nodes with {layer,row} coordinates + edges.",
    inputSchema: obj({ domain: { type: "string" } }),
    handler: (a, c) => ops.pipelineGraph(c.universe.path, { domain: a.domain }),
  },
  {
    name: "state_map",
    description: "Per-aggregate state machines: states (status-enum members) and transition nodes, with BFS layers from the initial states for layout. A transition skeleton `mtr-<agg>-<event>` is analyzer-generated; its SOURCE STATES and GUARDS are enrichment you author — a versioned node whose id is EXACTLY the skeleton id minus the leading 'm' (`mtr-hold-approved` → `tr-hold-approved`; copy it, don't re-derive the slug) via `document` (type 'transition', citing the Apply/guard anchors) plus `connect` edges: `from_state` (state → transition) for each source, and `transitions_to` (transition → state) when you derive a dynamic transition's target. `unenriched` per machine is the work queue: transitions with no enrichment or whose enrichment went stale when code drifted. Machines can also be FULLY AUTHORED for lifecycles the static pass can't see (handler-mutated documents, collection-item children like card holds): `document` state/transition nodes (types 'state'/'transition', citing the enum + the mutating code) and `connect` the same edge vocabulary — `state_of`/`transition_of` tether them to any node standing for the machine's owner, and the machine appears here like a generated one. Optional `aggregate` filters to one machine (id or title).",
    inputSchema: obj({ aggregate: { type: "string" } }),
    handler: (a, c) => ops.stateMap(c.universe.path, { aggregate: a.aggregate }),
  },
  {
    name: "subgraph",
    description: "Induced subgraph for incremental graph exploration: pass `ids` (the current node set) and optionally `expand` (one node id) to pull in that node's neighbors. Returns the nodes (each with full-graph degree and how many neighbors are still hidden) plus every edge among them. Grow the view one node at a time.",
    inputSchema: obj({ ids: { type: "array", items: { type: "string" } }, expand: { type: "string" } }, ["ids"]),
    handler: (a, c) => ops.subgraph(c.universe.path, a.ids ?? [], a.expand),
  },
  {
    name: "flow",
    description: "One flow: its ordered steps, each with touched modules and the live source of its anchors, plus per-step review state. For stepping through a process and reviewing the code.",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    handler: (a, c) => ops.flow(c.universe.path, a.id),
  },
  {
    name: "review",
    description: "Mark (or unmark: unmark:true) a node or anchor as reviewed — the agent's first-pass 'I read this' mark. level 'logical' = the doc is accurate; 'code' = the source was read (mark ANCHORS at code level — a node's code review is DERIVED from its segments). Recorded as an AGENT review → `checked` trust (blue); only a human via the web UI grants `verified` (green sign-off). Staleness-aware: reverts to stale when the reviewed code changes. Pair with `annotate` (kind:finding/pointer) to leave the human reviewer your findings and watch-outs on the exact lines.",
    inputSchema: obj({
      targetKind: { type: "string", enum: ["node", "anchor"] },
      targetId: { type: "string" },
      level: { type: "string", enum: ["logical", "code"] },
      unmark: { type: "boolean" },
      reviewer: { type: "string" },
    }, ["targetKind", "targetId", "level"]),
    mutates: true,
    handler: async (a, c) => {
      if (a.unmark) return unmarkReviewed(c.universe.path, a);
      const g = guardSelfCheck(c.universe.id, a.targetKind, a.targetId);
      if (g) return g;
      return markReviewed(c.universe.path, { ...a, actor: "agent" });
    },
  },
  {
    name: "triage",
    description: "Propose the STAKES and/or COMPLEXITY of a node/anchor — two orthogonal axes (docs/triage.md). STAKES = blast radius if wrong: 'business-critical' (moves money / gates a business process / authz boundary), 'important' (real business logic, recoverable), 'low' (no business consequence). COMPLEXITY = how much thought it takes to VERIFY the code, independent of stakes: 'deep' (subtle logic), 'standard' (real but tractable), 'rote' (a mechanical/checklist verify, e.g. authz: right permission + AuthCheck on the right entity), 'wiring' (pure plumbing — a DTO map, a projection fold). Set either or both — but a target with NO stakes on record needs an `importance`: a complexity alone would have one invented for it, and `untriaged` (which escalates) outranks a fabricated `important`. Recorded as an AGENT proposal (`likely`) a human confirms. RATCHET (per axis): you may only RAISE, never lower — escalation is always allowed (code grew teeth / a wiring path grew a branch) and re-enters the human's confirm queue. severity = stakes × complexity × review-gap. Stakes from the graph (emits an event, touches money, gates a command); complexity from code shape (branching/arithmetic vs a straight-line copy).",
    inputSchema: obj({
      targetKind: { type: "string", enum: ["node", "anchor"] },
      targetId: { type: "string" },
      importance: { type: "string", enum: ["business-critical", "important", "low"] },
      complexity: { type: "string", enum: ["deep", "standard", "rote", "wiring"] },
      reason: { type: "string" },
    }, ["targetKind", "targetId"]),
    mutates: true,
    handler: async (a, c) => ops.setTriage(c.universe.path, { targetKind: a.targetKind, targetId: a.targetId, importance: a.importance, complexity: a.complexity, source: "agent", reason: a.reason }),
  },
  {
    name: "triage_derive",
    description: "Graph-derive `likely` stakes AND complexity across the whole map in one pass (the honest first cut). Stakes: money/value names → business-critical; emitting a domain event or being a command/handler/aggregate/event → important; projection → low; proximity elevates untriaged neighbors of high-stakes modules; anchors inherit their citing nodes' max stakes. Complexity: read off each anchor's source shape (branching density) → deep/standard/rote/wiring, a node taking its meatiest anchor. Regenerable — clears prior graph marks, never touches human or agent marks. Run this FIRST, then use `triage` to raise the anchors the graph couldn't judge, and leave the rest for a human to confirm.",
    inputSchema: obj({}, []),
    mutates: true,
    handler: async (_a, c) => ops.deriveTriage(c.universe.path),
  },
  {
    name: "triage_drift",
    description: "Stakes marks whose witnessed code has DRIFTED since triage — the re-triage worklist. A `mechanical` anchor that changed may have grown teeth (now sums money / emits an event); re-run `triage_derive` (auto-escalates drifted human marks) or `triage` it higher. `tripwire:true` entries have FIRED — business-critical code someone asked to be alerted on has moved.",
    inputSchema: obj({}, []),
    handler: async (_a, c) => ops.triageDriftList(c.universe.path),
  },
  {
    name: "sanity_check",
    description: "Record that YOU (an agent) read the current code and a doc's claims hold — promotes it from `unverified` to `checked` trust. Witnessed, so it reverts to `stale` when the code changes. GUARDED: the connection that authored the doc can't check it — a different session must corroborate (no self-vouching). Use after verifying a doc during exploration.",
    inputSchema: obj({ id: { type: "string" }, reviewer: { type: "string" } }, ["id"]),
    mutates: true,
    handler: async (a, c) => {
      const g = guardSelfCheck(c.universe.id, "node", a.id);
      if (g) return g;
      return markReviewed(c.universe.path, { targetKind: "node", targetId: a.id, level: "logical", reviewer: a.reviewer || "agent", actor: "agent" });
    },
  },
  {
    name: "document",
    description: "Create/update a logical node (module|process|step|transition|state) in a universe. Must cite ≥1 anchor — floating claims are rejected. Anchors resolve PARTIALLY: refs that resolve are saved and the rest come back as `rejectedAnchors` (only a call where nothing resolves fails), so one ambiguous overload no longer costs you the whole body — fix the rejects with `update_node addAnchors`. Set `id` to control the slug you'll [[link]] to. For state-machine enrichment use type 'transition' with id `tr-<agg>-<event>` (see `state_map`).",
    inputSchema: obj({
      id: { type: "string" },
      type: { type: "string", enum: ["module", "process", "step", "transition", "state"] },
      title: { type: "string" },
      summary: { type: "string" },
      anchors: { type: "array", items: { type: "string" }, description: "Anchors by `file#Symbol`, `file:line`, or raw id — resolved server-side. `file#Symbol(*)` cites EVERY overload of Symbol in that file; an ambiguous `file#Symbol` comes back with each candidate id AND line range, so you can pick without another lookup." },
      body: { type: "string" },
      ref: { type: "string", description: "Document code as a BRANCH leaves it: anchors resolve against that commit's snapshot as well as the live index, and the version's accepted hashes are captured there. Pass a PR head when documenting a change that has not merged — without it a doc written during a PR review cites symbols the working tree has never seen and matches nothing." },
      steps: {
        type: "array",
        description: "For a process: inline ordered steps. Each is materialized as a step node with a step_of edge (order = position) and touches edges — no separate document/connect calls.",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            summary: { type: "string" },
            anchors: { type: "array", items: { type: "string" } },
            touches: { type: "array", items: { type: "string" }, description: "Module node ids this step runs through." },
            body: { type: "string" },
          },
          required: ["title", "summary", "anchors"],
          additionalProperties: false,
        },
      },
    }, ["type", "title", "summary", "anchors"]),
    mutates: true,
    handler: async (a, c) => trackAuthored(await ops.document(c.universe.path, a)),
  },
  {
    name: "connect",
    description: "Add one edge or many (same-universe: part_of/depends_on/step_of/touches, plus state-map enrichment: from_state = state→transition source, transitions_to = transition→state target for dynamic transitions, initial_state = aggregate→state when the static pass couldn't detect the initial). Pass from/to/type for one, or edges:[…] for a batch. For cross-universe API boundaries use `link`.",
    inputSchema: obj({
      from: { type: "string" },
      to: { type: "string" },
      type: { type: "string", enum: ["part_of", "depends_on", "step_of", "touches", "from_state", "transitions_to", "initial_state", "state_of", "transition_of", "on_event"] },
      order: { type: "number" },
      edges: {
        type: "array",
        items: {
          type: "object",
          properties: {
            from: { type: "string" },
            to: { type: "string" },
            type: { type: "string", enum: ["part_of", "depends_on", "step_of", "touches", "from_state", "transitions_to", "initial_state", "state_of", "transition_of", "on_event"] },
            order: { type: "number" },
          },
          required: ["from", "to", "type"],
          additionalProperties: false,
        },
      },
    }),
    mutates: true,
    handler: (a, c) => ops.connect(c.universe.path, a),
  },
  {
    name: "delete_node",
    description: "Delete a logical node outright and any edges touching it (ALL branches). For removing code on ONE branch while keeping the doc live on another, use `ack_hole` instead. To drop a single vanished anchor ref while keeping the node, use update_node with removeAnchors: [\"a_<id>\"].",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    mutates: true,
    handler: (a, c) => ops.removeNode(c.universe.path, a.id),
  },
  {
    name: "confirm",
    description: "Confirm a doc is still accurate at the CURRENT code without editing or forking it: accepts the current anchor hashes, clearing a `stale` flag. Use when a change touched code the doc cites but the doc's claims still hold. (Editing a stale doc instead FORKS a new version — confirm is the 'no change needed' path.) Docs versioning: see how a node resolves per branch via get_node/node_versions.",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    mutates: true,
    handler: (a, c) => ops.confirm(c.universe.path, a.id),
  },
  {
    name: "ack_hole",
    description: "Acknowledge a hole: the code a doc cited was removed ON THIS BRANCH and that's correct → tombstone the doc here (it disappears from this branch's map, but its content version still wins on branches where the code exists). Only valid when the doc is `dangling`. This is the branch-scoped 'delete' (vs delete_node which removes it everywhere).",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    mutates: true,
    handler: (a, c) => ops.ackHole(c.universe.path, a.id),
  },
  {
    name: "node_versions",
    description: "List all versions of a node with each version's per-branch status (fresh/stale/dangling/removed), created commit/branch, and cited anchors — for understanding a forked doc.",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    handler: (a, c) => ops.nodeVersions(c.universe.path, a.id),
  },
  {
    name: "update_node",
    description: "Patch a node in place without resending its whole body: change title/summary/body and/or add/remove anchors (by `file#Symbol`, `file#Symbol(*)` for every overload, or id). A node must keep ≥1 anchor. Added anchors resolve partially — whatever resolves is added and the rest come back as `rejectedAnchors`.",
    inputSchema: obj({
      id: { type: "string" },
      setTitle: { type: "string" },
      setSummary: { type: "string" },
      setBody: { type: "string" },
      addAnchors: { type: "array", items: { type: "string" } },
      removeAnchors: { type: "array", items: { type: "string" } },
    }, ["id"]),
    mutates: true,
    handler: async (a, c) => trackAuthored(await ops.updateNode(c.universe.path, a)),
  },
  {
    name: "links",
    description: "Report every dangling [[link]] in a universe's node bodies (targets that don't resolve to a node id) — so cross-linked docs don't silently rot.",
    inputSchema: obj({}),
    handler: (_a, c) => ops.linksReport(c.universe.path),
  },
  {
    name: "link",
    description: "Link a node across universes at an API boundary: connects a consumer node (in `universe`, default primary) to a producer node in `toUniverse`. Stored in the consumer's graph as a qualified edge (default type calls_api).",
    inputSchema: obj({
      from: { type: "string", description: "Consumer node id (in `universe`)." },
      toUniverse: { type: "string", description: "Producer universe id." },
      to: { type: "string", description: "Producer node id." },
      type: { type: "string", enum: ["calls_api", "depends_on"] },
      order: { type: "number" },
    }, ["from", "toUniverse", "to"]),
    mutates: true,
    handler: (a, c) => multi.link(ws, { fromUniverse: c.universe.id, from: a.from, toUniverse: a.toUniverse, to: a.to, type: a.type, order: a.order }),
  },
  {
    name: "report_bug",
    description: "File a bug anchored to exact code in a universe. Captures a witness hash so it auto-flags possiblyFixed when that code changes.",
    inputSchema: obj({
      title: { type: "string" },
      description: { type: "string" },
      anchors: { type: "array", items: { type: "string" }, description: "Anchors by `file#Symbol`, `file:line`, or raw id (`file#Symbol(*)` = every overload). Partially resolved: unresolvable refs come back as `rejectedAnchors`." },
      severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
    }, ["title", "description", "anchors"]),
    mutates: true,
    handler: (a, c) => ops.reportBug(c.universe.path, a),
  },
  {
    name: "list_bugs",
    description: "List bugs in a universe. Open bugs whose anchored code changed since filing are flagged possiblyFixed — re-validate those.",
    inputSchema: obj({ status: { type: "string", enum: ["open", "fixed", "wontfix", "invalid"] } }),
    handler: (a, c) => ops.listBugs(c.universe.path, a),
  },
  {
    name: "update_bug",
    description: "Update a bug: change status, append a note, add anchors, and/or refresh witness hashes (automatic when marking fixed).",
    inputSchema: obj({
      id: { type: "string" },
      status: { type: "string", enum: ["open", "fixed", "wontfix", "invalid"] },
      note: { type: "string" },
      addAnchors: { type: "array", items: { type: "string" } },
      refreshWitnesses: { type: "boolean" },
    }, ["id"]),
    mutates: true,
    handler: (a, c) => ops.updateBug(c.universe.path, a),
  },
  {
    name: "annotate",
    description: "Attach review context to an anchor or node — durable on the map (not a throwaway PR comment), rendered inline for the human reviewer. This is how an agent hands off a code-review pass. `kind`:\n  • \"finding\" — a raised issue/requirement needing attention (a potential bug, a missing check). Set `severity` + `category`; stays open until a human resolves it.\n  • \"pointer\" — a review AID, not a defect: \"when reviewing this block, watch out for X / confirm Y.\" Points the human reviewer at what matters. `category` optional.\n  • \"question\" — an ask a human should answer (open-questions queue, see `questions`).\n  • \"note\" (default) — a durable remark.\nPin to a specific line with `line` (for anchor targets) so it renders against that line. Typical agent review pass: read a segment → `review` it (level:code → `checked`) → `annotate` any findings/pointers on the exact lines. `category` mirrors CI review buckets (Authorization, Logic, Tenant Safety, Performance, Domain Model, Validation, …)." + COMMENT_CONTRACT,
    inputSchema: obj({
      targetKind: { type: "string", enum: ["anchor", "node"] },
      targetId: { type: "string" },
      text: { type: "string", description: "The EVIDENCE, for the map and for whoever triages: what you checked, why the obvious alternative fails, what is still unverified. Not published." },
      comment: { type: "string", description: "REQUIRED on a finding. The submitter-facing version — see the contract in this tool's description. Max 800 characters; longer is refused." },
      disposition: { type: "string", enum: ["open", "confirmed", "partial", "rerated", "refuted", "accepted"], description: DISPOSITION_DOC },
      publishPath: { type: "string", description: "Only when this is about code the pull request does not touch: the file IN THE DIFF nearest to the problem. Usually left to the human, who is better placed to judge \"nearest\" — an unset one is reported, never guessed." },
      publishLine: { type: "number", description: "Line within `publishPath`, if a specific one is meant." },
      kind: { type: "string", enum: ["note", "question", "finding", "pointer"], description: "\"finding\" (issue), \"pointer\" (watch-out for the reviewer), \"question\", or \"note\" (default)." },
      severity: { type: "string", enum: ["low", "medium", "high", "critical"], description: "For findings: critical=security/auth/data-integrity, high=logic bug, medium=improvement, low=nitpick." },
      category: { type: "string", description: "Review bucket, e.g. Authorization, Logic, Tenant Safety, Performance, Domain Model, Validation, Separation of Concerns." },
      line: { type: "number", description: "1-based line to pin to (anchor targets) — the exact line the finding/pointer is about." },
      ref: { type: "string", description: "Resolve the target against this commit snapshot as well as the live index — a PR head, for a symbol that exists only on the branch. Rarely needed: an anchor id found in any cached snapshot resolves without it." },
      author: { type: "string" },
      model: { type: "string", description: "YOUR model id, e.g. \"claude-opus-5\". Recorded so a finding says which model raised it — that is what makes cross-model corroboration measurable. Never guess it: pass it only if you were told what you are, and omit it otherwise." },
      harness: { type: "string", description: "The tool running you, e.g. \"claude-code\". Optional." },
    }, ["targetKind", "targetId", "text"]),
    mutates: true,
    handler: (a, c) => ops.annotate(c.universe.path, a),
  },
  {
    name: "pr_walkthrough",
    description:
      "Write the reading guide for a pull request: the document a human reviews FROM.\n\n"
      + "A 22k-line PR is unreviewable as a flat list. Break it into FEATURES (a coherent capability the change delivers) and, inside each, CHAPTERS (a unit someone can hold in their head and then sign off in one go — roughly 5-20 symbols).\n\n"
      + "A chapter body is an ORDERED list of blocks that INTERLEAVE prose and symbols:\n"
      + "  [{\"kind\":\"prose\",\"text\":\"The aggregate owns every transition. Read the guard first:\"},\n"
      + "   {\"kind\":\"symbol\",\"anchorId\":\"a_1f..\"},\n"
      + "   {\"kind\":\"prose\",\"text\":\"...which is the only place Pending is enforced. Confirmation is then a straight fold:\"},\n"
      + "   {\"kind\":\"symbol\",\"anchorId\":\"a_9c..\"}]\n"
      + "Prose goes BETWEEN symbols and says what to look at next and why. A paragraph followed by ten symbols is not a walkthrough — it is a wall of text with code boxes attached, which is what the reviewer already has.\n\n"
      + "DESCRIBE WHAT THE CODE DOES. The spec is evidence, not scaffolding: specs lie, and code drifts. Use `pr_packet` for the ranked symbols, their source and the spec text, then say what is actually there.\n\n"
      + "ACCOUNT FOR EVERYTHING. Every changed symbol in the review queue belongs in exactly one chapter. Anything you leave out is what the human ends up reading on GitHub with no context — so if a cluster does not fit the change's stated purpose, it is still a feature: name it for what it is and set `unstated: true`. A drive-by that is called out is useful; one that is silently omitted is the thing this exists to prevent.\n\n"
      + "REJECTED if a chapter cites a symbol this PR does not touch, if two chapters claim the same symbol, or if a chapter has no symbol in it. Re-run with `dryRun: true` to check coverage before writing.\n\n"
      + "Chapter and feature ids are derived from titles, so re-walking a PR with the same structure keeps the reviewer's place. Chapters are witnessed against the head's bodies: when the submitter pushes, only the chapters whose code moved go stale, and only those need re-walking.",
    mutates: true,
    inputSchema: obj({
      pr: { type: "string", description: "PR number, url, or owner/repo#N." },
      dryRun: { type: "boolean", description: "Validate and report coverage without storing." },
      features: {
        type: "array",
        description: "Ordered for reading — put the feature the rest builds on first.",
        items: obj({
          title: { type: "string", description: "What this capability IS, in the reviewer's words." },
          summary: { type: "string", description: "What it is aiming to do. One to three sentences that guide reading — not a description of every symbol in it." },
          unstated: { type: "boolean", description: "This is not part of the change's stated purpose — a drive-by. Say so here rather than in prose." },
          chapters: {
            type: "array",
            items: obj({
              title: { type: "string" },
              blocks: {
                type: "array",
                description: "Interleaved. Each item is {kind:'prose',text} or {kind:'symbol',anchorId}.",
                items: { type: "object" },
              },
            }, ["title", "blocks"], false),
          },
        }, ["title", "summary", "chapters"], false),
      },
    }, ["pr", "features"]),
    handler: (a, c) => ops.prWalkthroughSet(c.universe.path, String(a.pr ?? ""), a.features ?? [], { by: "agent", dryRun: !!a.dryRun }),
  },
  {
    name: "pr_walkthrough_get",
    description: "The stored walkthrough for a pull request, with `stale` naming the chapters whose code has moved since it was written (re-walk only those) and `headMoved` when it was written against a different commit entirely.",
    inputSchema: obj({ pr: { type: "string", description: "PR number, url, or owner/repo#N." } }, ["pr"]),
    handler: (a, c) => ops.prWalkthroughGet(c.universe.path, String(a.pr ?? "")),
  },
  {
    name: "review_queue",
    description: "What the human has asked you to act on: findings they raised during review and handed to an agent, newest-severity-first, each with the symbol it sits on and that symbol's CURRENT source — so you can act without hunting for it.\n\n`assignment.kind` says what was asked:\n  • \"investigate\" — work out whether it is real and report back what you found.\n  • \"fix\" — make the change. ONE file only. A fix that needs to span files is work for an agent the human dispatches, not a review-tool edit: report `declined` with what it would take, which is a useful answer, not a failure.\n\nReport back with `close_finding`. You do NOT resolve the finding — the human does, after reading what you did.\n\nBRIEF by default: no source is inlined, because the full form is unreadably large on a real queue. Read one symbol with `get_anchor`, or pass `brief:false` when you actually need every body at once.",
    inputSchema: obj({
      includeAnswered: { type: "boolean", description: "Also return items you have already reported on (default false — those are waiting on the human, not on you)." },
      brief: { type: "boolean", description: "Default TRUE. `false` inlines each symbol's current source — large; page it with limit/offset." },
      limit: { type: "number" },
      offset: { type: "number" },
      disposition: { type: "string", enum: ["open", "confirmed", "partial", "rerated", "refuted", "accepted"], description: "Only items triage concluded this about — `open` is the untouched work." },
      publishState: { type: "string", enum: ["local", "approved", "withdrawn", "posted"], description: "Where it stands on its way to the pull request." },
    }, []),
    handler: (a, c) => ops.reviewQueue(c.universe.path, {
      includeAnswered: Boolean(a.includeAnswered), brief: a.brief !== false,
      limit: a.limit as number | undefined, offset: a.offset as number | undefined,
      disposition: a.disposition as string | undefined, publishState: a.publishState as string | undefined,
    }),
  },
  {
    name: "orphans",
    description:
      "What is pointing at code the working tree no longer has — \"what did that refactor break?\"\n\n"
      + "An anchor id is derived from file + symbol path + signature, so it survives a line move or a body rewrite, but NOT a rename, a deletion, or a change to an overload's parameter list. Reindex replaces the live index wholesale, so an annotation whose target the new index does not produce used to be silently stranded.\n\n"
      + "Three buckets, and the difference is the point:\n"
      + "  • `offTree` — the symbol is in a cached commit snapshot, almost always a PR branch. Nothing is lost; the working tree is just on another branch. Re-run against that ref.\n"
      + "  • `retained` — gone from the tree and every snapshot, but its last known file/symbol/line/hash was kept because work pointed at it. Readable and re-anchorable.\n"
      + "  • `lost` — no record anywhere. Filed before retention existed. Irrecoverable; the finding's own `comment` and `text` are all that survive.\n\n"
      + "Items carrying `posted` are live on a pull request as review comments — a third party can see them, so the map disagreeing with GitHub about them is the worst case.",
    inputSchema: obj({}),
    handler: (_a, c) => ops.orphanedWork(c.universe.path),
  },
  {
    name: "findings",
    description: "Every finding and question on the map, whoever raised them and whether or not anyone was asked to act.\n\n`review_queue` answers \"what have I been asked to do\" and only lists items with an assignment — so a finding raised by `annotate` and published to a pull request was invisible to every query afterwards. This one answers \"what is on this map, and where has it got to\": filter by `disposition` (what triage concluded) and `publishState` (local / approved / withdrawn / posted), and `posted` items carry `postedRef` with the review and comment they landed in.\n\nBrief by default, same as `review_queue`.",
    inputSchema: obj({
      disposition: { type: "string", enum: ["open", "confirmed", "partial", "rerated", "refuted", "accepted"] },
      publishState: { type: "string", enum: ["local", "approved", "withdrawn", "posted"] },
      includeResolved: { type: "boolean", description: "Also list findings a human has closed out (default false)." },
      brief: { type: "boolean", description: "Default TRUE. `false` inlines each symbol's current source — large." },
      limit: { type: "number" },
      offset: { type: "number" },
    }, []),
    handler: (a, c) => ops.reviewQueue(c.universe.path, {
      assignedOnly: false,
      includeResolved: Boolean(a.includeResolved), brief: a.brief !== false,
      limit: a.limit as number | undefined, offset: a.offset as number | undefined,
      disposition: a.disposition as string | undefined, publishState: a.publishState as string | undefined,
    }),
  },
  {
    name: "close_finding",
    description: "Report back on a finding from `review_queue`. This records what you did; it does NOT resolve the finding — reporting and agreeing it is closed are different acts, and the human closes it after reading.\n\n`result`:\n  • \"fixed\" — you changed the code. List every file you touched in `files`; more than one is refused, by design.\n  • \"answered\" — you investigated. Put the finding in `detail`: whether it is real, why, and what you checked.\n  • \"declined\" — you did not act. Say what it would take. Declining a fix that spans files, or that needs a judgement call you cannot make, is the RIGHT answer.\n\n`result` is what YOU DID; `disposition` is what turned out to be TRUE of the finding. They are different axes — a false positive is `answered` + `refuted`, because you did answer and the answer was \"not a defect\". Set `disposition` whenever you reached a conclusion: it is what decides whether this goes to the submitter, and prose saying \"recommend closing as invalid\" cannot be filtered on." + COMMENT_CONTRACT,
    inputSchema: obj({
      id: { type: "string", description: "The annotation id from `review_queue`." },
      result: { type: "string", enum: ["fixed", "answered", "declined"] },
      detail: { type: "string", description: "What you did or found — the human reads this, so be concrete." },
      disposition: { type: "string", enum: ["open", "confirmed", "partial", "rerated", "refuted", "accepted"], description: DISPOSITION_DOC },
      comment: { type: "string", description: "Rewrite the submitter-facing version if your investigation changed it — as a standalone statement about the code, not as a diff against the filing, which the submitter has never seen. Max 800 characters. The previous wording is kept on the map." },
      line: { type: "number", description: "The line in the finding's own file that it actually points at. SET THIS — you have just read the code, and without it the comment is placed by geometry (the enclosing symbol's first changed line), which lands on a neighbouring member." },
      files: { type: "array", items: { type: "string" }, description: "Files you actually changed (for `fixed`). One file maximum." },
      by: { type: "string" },
    }, ["id", "result", "detail"]),
    mutates: true,
    handler: (a, c) => ops.closeAssignment(c.universe.path, a as never),
  },
  {
    name: "revise_finding",
    description:
      "Correct a finding — yours or somebody else's — without losing what it used to say.\n\n"
      + "Findings get filed before they are understood: a report goes in, investigation shows it was overstated or aimed at the wrong line, and the correction has to be visible AS a correction. Revisions APPEND; nothing is destroyed, and the previous wording stays readable ON THE MAP.\n\n"
      + "The submitter is not a party to that history: they receive the latest `comment` and nothing else. A revised comment therefore has to STAND ALONE — rewritten as if filed fresh, not written as a correction to the one before it.\n\n"
      + "Use it to sharpen a `comment`, to record what triage concluded (`disposition`), to re-rate a `severity` you now think is wrong, or to set `publishPath` for a finding about code the pull request does not touch.\n\n"
      + "Refused once the finding is on the pull request: revising it here would diverge from the copy the submitter is acting on."
      + COMMENT_CONTRACT,
    inputSchema: obj({
      id: { type: "string", description: "The annotation id." },
      text: { type: "string", description: "The evidence — for the map, not published." },
      comment: { type: "string", description: "The submitter-facing version, rewritten to stand alone — it replaces the old one for the reader, who never sees what it replaced. Max 800 characters." },
      disposition: { type: "string", enum: ["open", "confirmed", "partial", "rerated", "refuted", "accepted"], description: DISPOSITION_DOC },
      severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
      line: { type: "number", description: "The line in the finding's OWN file that it points at — the normal way to say where it is." },
      publishPath: { type: "string", description: "For a finding about code this PR does not touch: the file IN THE DIFF nearest to the problem. An out-of-diff override, not the everyday field — use `line` for that." },
      publishLine: { type: "number", description: "Line within `publishPath`. Only meaningful alongside it." },
      ref: { type: "string", description: "Re-witness against this ref after re-reading the code — how a finding blocked as \"written against a different version\" is cleared." },
      allowPostEdit: { type: "boolean", description: "Revise even though it is already posted. The GitHub copy is NOT updated — reply there instead; this only stops the map from silently disagreeing with it." },
      by: { type: "string" },
    }, ["id"]),
    mutates: true,
    handler: (a, c) => ops.reviseAnnotation(c.universe.path, a as never),
  },
  {
    name: "questions",
    description: "List open questions a human left during review — the 'answer these to improve the docs' queue. Address each (edit the cited doc), then resolve_question.",
    inputSchema: obj({ includeResolved: { type: "boolean" } }),
    handler: (a, c) => ops.listQuestions(c.universe.path, a),
  },
  {
    name: "resolve_question",
    description: "Close out a review QUESTION (or re-open with resolved:false) once you've answered it by improving the documentation.\n\nQuestions only. Reporting on a finding and agreeing it is closed are different acts — use `close_finding` to say what you did and what you found; the human closes it after reading.",
    inputSchema: obj({ id: { type: "string" }, resolved: { type: "boolean" } }, ["id"]),
    mutates: true,
    handler: (a, c) => ops.resolveAnnotation(c.universe.path, a.id, a.resolved !== false, { actor: "agent" }),
  },
];

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

/**
 * On connect, bring every universe's index up to date in the background:
 * `check_stale` picks up drift and (via the branch-change guard) re-baselines
 * if the checkout moved to a different branch. Fire-and-forget so the handshake
 * stays fast; each runs under the universe's write lock, so a subsequent tool
 * call just waits on the lock and then sees the fresh index. Runs once.
 */
let connectRefreshed = false;
async function refreshOnConnect(): Promise<void> {
  if (connectRefreshed) return;
  connectRefreshed = true;
  for (const u of ws.universes) {
    try {
      const r: any = await withLock(u.path, () => ops.checkStale(u.path));
      const reb = r?.rebaselined ? ` rebaselined ${r.rebaselined.from}→${r.rebaselined.to} (${r.rebaselined.anchors} anchors)` : "";
      const add = r?.indexUpdate ? ` +${r.indexUpdate.added} anchors` : "";
      process.stderr.write(`codemap-mcp: check_stale on connect [${u.id}]: ok=${r?.ok ?? "?"}${reb}${add}\n`);
    } catch (e: any) {
      process.stderr.write(`codemap-mcp: check_stale on connect [${u.id}] skipped: ${e?.message ?? e}\n`);
    }
  }
}

async function handle(msg: any): Promise<void> {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "codemap", version: "0.2.0" },
          instructions: METHODOLOGY,
        },
      });
      void refreshOnConnect(); // background: freshen indexes / re-baseline on branch change
      return;
    case "ping":
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    case "tools/list":
      send({ jsonrpc: "2.0", id, result: { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
      return;
    case "tools/call": {
      const tool = tools.find((t) => t.name === params?.name);
      if (!tool) {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${params?.name}` } });
        return;
      }
      const args = params.arguments ?? {};
      const universe = args.universe ? ws.byId.get(args.universe) : ws.primary;
      if (!universe) {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: unknown universe "${args.universe}"` }], isError: true } });
        return;
      }
      try {
        const run = () => tool.handler(args, { ws, universe });
        const out = tool.mutates ? await withLock(universe.path, run) : await run();
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] } });
      } catch (e: any) {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Error: " + (e?.message ?? String(e)) }], isError: true } });
      }
      return;
    }
    default:
      if (isRequest) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let m: unknown;
    try {
      m = JSON.parse(line);
    } catch {
      process.stderr.write("codemap-mcp: bad JSON line\n");
      continue;
    }
    handle(m).catch((e) => process.stderr.write(`codemap-mcp: handler error: ${e}\n`));
  }
});
process.stdin.on("end", () => process.exit(0));
process.stderr.write(`codemap-mcp: serving ${ws.universes.length} universe(s): ${ws.universes.map((u) => u.id + (u.primary ? "*" : "")).join(", ")}\n`);
