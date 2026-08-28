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
import * as shared from "./ops-shared.js";
import { markAgentSession, markObservedClient } from "./identity.js";
import * as multi from "./multi.js";
import { loadWorkspace, type Workspace, type Universe } from "./workspace.js";
import { METHODOLOGY } from "./guide.js";
import { analyzeMarten } from "./analyzers/marten.js";
import { enableAnalyzer } from "./analyzers/run.js";
import { markReviewed, markReviewedBatch, unmarkReviewed } from "./reviews.js";
import { withLock } from "./lock.js";
import { EVIDENCE_KINDS } from "./schema.js";

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
  "What triage CONCLUDED about the finding: \"open\" (filed, nobody has checked it — the default), \"confirmed\" (real as filed), \"partial\" (real in part; `comment` states the part that is real, in full), \"rerated\" (real, but the severity or impact differs from as-filed), \"refuted\" (not a defect — a false positive), \"accepted\" (real, deliberately not being fixed). Only confirmed/partial/rerated go to the submitter unasked; the rest stay on the map unless the human names them.\n\nThis axis is about the CLAIM, never about what was done. A finding somebody has since FIXED is still `confirmed` — set `remediation` for that. Revising a fixed finding to `refuted` marks a real defect a false positive, and \"which of my findings were wrong?\" then contains the ones that were most right.";


/**
 * The declared `enum`s, actually enforced.
 *
 * They were documentation: nothing validated `inputSchema`, so a value the schema
 * forbade reached the handler and whatever that handler did with it was the contract.
 * `annotate`'s enum dropped `"finding"` when findings moved to `report_defect` and the
 * path stayed fully open — the tool went on filing them for as long as anybody kept
 * passing the old value, which is how a closed create path keeps refilling a store.
 *
 * ENUMS ONLY, deliberately. `required` is not enforced here because the handlers already
 * refuse missing fields with errors that say what the field is FOR, and a generic
 * "missing required property" would be a worse message in every one of those cases. An
 * enum has no such handler-level equivalent: the values are the whole meaning.
 */
function violates(schema: unknown, args: Record<string, unknown>, path = ""): string | null {
  const props = (schema as { properties?: Record<string, unknown> })?.properties;
  if (!props) return null;
  // Undeclared properties, where the schema says there are none. `obj()` has always
  // emitted `additionalProperties: false` and nothing enforced it, so any field a HANDLER
  // happened to read was reachable whether or not the tool offered it. That is how
  // `{agent: false}` reached `resolveActor` and forged a principal, and how `promotedFrom`
  // reached `recordAudit` without passing `promote_audit`'s default-branch and
  // not-superseded gates. `required` is still deliberately unenforced, for the reason
  // below; this is the opposite direction and carries none of that cost — a parameter the
  // tool does not offer has no handler-level message to lose.
  if ((schema as { additionalProperties?: unknown }).additionalProperties === false) {
    const extra = Object.keys(args ?? {}).filter((k) => !(k in props));
    if (extra.length) {
      return `unknown parameter${extra.length > 1 ? "s" : ""} ${extra.map((x) => JSON.stringify(x)).join(", ")}`
        + `${path ? ` in ${path}` : ""} — this tool does not take ${extra.length > 1 ? "them" : "it"}`;
    }
  }
  for (const [k, spec] of Object.entries(props)) {
    const v = args?.[k];
    if (v === undefined || v === null) continue;
    const s = spec as { enum?: unknown[]; type?: string; properties?: unknown; items?: unknown };
    const where = path ? `${path}.${k}` : k;
    if (s.enum && !s.enum.includes(v)) {
      return `${where} must be one of ${s.enum.map((x) => JSON.stringify(x)).join(", ")} — got ${JSON.stringify(v)}`;
    }
    // One level in, because a discriminated `context` object is exactly where the
    // valuable enum lives (`report_defect`), and it is not a top-level property.
    if (s.type === "object" && s.properties && typeof v === "object" && !Array.isArray(v)) {
      const inner = violates(s, v as Record<string, unknown>, where);
      if (inner) return inner;
    }
  }
  return null;
}

/**
 * The surface is large on purpose, and the obvious tidy-up — collapsing sibling reads
 * behind one `kind` parameter — costs more than the tool count it saves.
 *
 * A tool is two things besides a handler: a DESCRIPTION, which is where per-call
 * steering lives ("read this before filing", `context`'s ANSWER-FIRST), and a NAME.
 * Which of the two actually reaches an agent depends on the client:
 *
 *  - A client that sends every tool eagerly puts the descriptions in context, so the
 *    steering lands before the agent picks. Merging six `shared_*` reads into one tool
 *    turns six pre-write nudges into one description, read once, by an agent that has
 *    already decided.
 *  - A client that DEFERS tools (Claude Code does) sends only names; the schema and
 *    description load on demand. The description then arrives AFTER the choice — too
 *    late to redirect anything — so the name is the whole steering surface, and
 *    `event_matrix` is findable where `view(kind:"matrix")` is not.
 *
 * Both readings point the same way. Never put a guard in a description: COD-24 is the
 * standing evidence that unenforced steering does not reach the consumer, and deferral
 * is a second, independent reason it may not even arrive. Guards are refusals in the
 * handler. Descriptions are for agents that already got here, and names are for the
 * ones still looking.
 */
const tools: Tool[] = [
  {
    name: "list_universes",
    description: "List the universes (repos) this server serves, which is primary, and per-universe counts. Use to see what projects and cross-links are available.",
    inputSchema: obj({}, [], false),
    handler: () => multi.listUniverses(ws),
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
    description: "The documentation work queue: only `open` anchors (in-scope, uncited, not marked covered/trivial/deferred/owned), ranked by likely value. Filter by path prefix or kind.\n\nWith a sidecar configured this reads the TEAM's docs too, so a symbol a colleague documented is not offered as a gap. Those come back under `documentedByTeam` with the node, its title and who wrote it: the action there is to READ theirs (`shared_docs`), not to write a second doc about the same code.",
    inputSchema: obj({
      pathPrefix: { type: "string" },
      kind: { type: "string" },
      limit: { type: "number" },
    }),
    handler: (a, c) => ops.findGaps(c.universe.path, a),
  },
  {
    name: "context",
    description: "ANSWER-FIRST: before exploring code, ask what codemap already knows about it. Given refs (files, dirs, `file#Symbol`, `file:line`, or anchor ids), returns a `verdict` (covered/partial/stale/gap), the covering docs with trust level, flows/open-bugs on that code, and the still-undocumented `gaps`. Read `trusted` docs instead of re-reading the code; explore only the gaps.\n\nWith a sidecar configured it also answers for the TEAM: `sharedDocs` is what colleagues have written about this code, and anything they cover is not reported as a gap. Those are not in your store — read them with `shared_docs` rather than relying on them unseen, and do not write a second doc about code somebody already documented.",
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
    description: "Cache a commit's anchors as an immutable snapshot (a fresh full index), so it can be diffed or read later WITHOUT checking it out. Defaults to the current commit — run it on a branch before switching away; `init` does it automatically.\n\nPass `ref` to index ANY commit straight from git objects, no checkout and no effect on the working tree. Already-cached shas are left alone.\n\nThat is how you READ a commit you are not on — its files, symbols and locations. It is not by itself an answer to \"where did this foreign id live\": the new index mints ids under THIS build's derivation, so it gives you that commit's symbols to judge against, not a pairing to the old id.",
    inputSchema: obj({
      ref: { type: "string", description: "A commit sha or anything `git rev-parse` accepts. Omit for the current commit." },
    }),
    mutates: true,
    handler: (a, c) => (a.ref ? ops.snapshotAt(c.universe.path, String(a.ref)) : ops.snapshot(c.universe.path)),
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
    description: "Diff two anchor snapshots for reviewing a branch/PR: added/removed/changed symbols plus the impact on the docs, flows, reviews, bugs and REQUIREMENTS that cite them.\n\n`impact.requirements` is the audit trigger: a rule of the standard whose cited code this change moves is worth re-auditing, and `auditMoved` says the last audit\u2019s witnesses moved too \u2014 so whatever verdict is on record was reached against source this change rewrites, and a `conformant` there is not evidence any more. `assertionsMoved` is the sharper signal: this change rewrote the CHECK that asserts the rule \u2014 the detector being modified rather than the code it guards \u2014 and a rule appears for that reason alone even when nothing it cites moved. What the rollup cannot reach is a rule that neither cites nor is asserted by anything, which is invisible to a set-op over anchors. `base` is a cached snapshot (branch/tag/sha — cache it first with `init`/`snapshot`). Omit `head` to diff against a fresh index of the CURRENT working tree (the usual PR-review path: you've checked out the branch under review); or pass a second cached ref for a pure historical set-op.",
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
    description: "Read a node: summary/body, anchors, edges (with cross-universe endpoints resolved), inbound cross-universe links, and annotations.\n\nIf you are reading this node to LEARN WHAT IT DOCUMENTS, pass `compact: true` — you get the prose, the anchors as {file, symbol, kind, lines}, the edges and the node's `trust`, without the per-anchor review/triage/annotation payload. That payload is most of the response on a well-annotated node (an annotation carries its full revision chain, superseded text included), and none of it answers what the node says. Omit `compact` only when you are actually working the review/triage queue; for one anchor's detail use `get_anchor`.",
    inputSchema: obj({
      id: { type: "string" },
      compact: { type: "boolean", description: "Documentation view: drop per-anchor review/viewed/severity/triage and all annotations." },
    }, ["id"]),
    handler: (a, c) => multi.getNodeEnriched(ws, c.universe.id, a.id, { compact: !!a.compact }),
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
    description: "One flow: its ordered steps, each with touched modules and the live source of its anchors, plus per-step review state. For stepping through a process and reviewing the code.\n\nPass `brief: true` when you are ORIENTING rather than walking it — you get the steps, what each touches and its review state, without every anchor's source inlined. A long flow otherwise returns twenty symbols' bodies in one response; fetch the one you stop at with `get_anchor`.",
    inputSchema: obj({
      id: { type: "string" },
      brief: { type: "boolean", description: "Omit each anchor's inlined source. The shape of the flow, not its code." },
    }, ["id"]),
    handler: (a, c) => ops.flow(c.universe.path, a.id, { brief: !!a.brief }),
  },
  {
    name: "review",
    description: "Mark (or unmark: unmark:true) a node or anchor as reviewed — the agent's first-pass 'I read this' mark. level 'logical' = the doc is accurate; 'code' = the source was read (mark ANCHORS at code level — a node's code review is DERIVED from its segments). Recorded as an AGENT review → `checked` trust (blue); only a human via the web UI grants `verified` (green sign-off). Staleness-aware: reverts to stale when the reviewed code changes.\n\nREVIEWING A PULL REQUEST: pass `ids` (a whole `pr_packet` page in one call) and `ref: <refs.head>`. Both matter — without `ref` the mark witnesses the working tree, which during a PR review is a third version that is neither the head you read nor the base. Pair with `report_defect` when you find something — `context:{kind:\"pull_request\"}` puts it on the PR under review — or `annotate` for a pointer or a durable remark about the code itself, to leave the human reviewer your findings and watch-outs on the exact lines.",
    inputSchema: obj({
      targetKind: { type: "string", enum: ["node", "anchor"] },
      targetId: { type: "string" },
      ids: { type: "array", items: { type: "string" }, description: "Mark MANY anchors at once — the form for a pull request, where a page of `pr_packet` is one call rather than forty. Anchors only (a node's code review is derived from its segments). Mutually exclusive with `targetKind`/`targetId`." },
      level: { type: "string", enum: ["logical", "code"] },
      ref: { type: "string", description: "Witness the code AT THIS COMMIT rather than in the working tree. On a pull request pass `pr_packet`'s `refs.head`: an anchor id carries no ref, so without this a sign-off made while reviewing a PR records whatever branch happens to be checked out — usually the base — and reads as a review of code nobody looked at." },
      unmark: { type: "boolean" },
      reviewer: { type: "string" },
    }, ["level"]),
    mutates: true,
    handler: async (a, c) => {
      const ids = Array.isArray(a.ids) ? (a.ids as string[]) : undefined;
      if (ids?.length) {
        // `unmark` has no batch behind it, and silently marking when the caller asked
        // to unmark is the worse failure of the two.
        if (a.unmark) return { error: "`unmark` takes one target — pass `targetKind`/`targetId`." };
        return markReviewedBatch(c.universe.path, ids, { level: a.level, reviewer: a.reviewer, actor: "agent", ref: a.ref });
      }
      if (!a.targetKind || !a.targetId) return { error: "review needs `ids` (anchors) or `targetKind` + `targetId`." };
      if (a.unmark) return unmarkReviewed(c.universe.path, { ...a, actor: "agent" });
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
      // No `|| "agent"` default: `actor` already carries agent-ness, and defaulting
      // the reviewer to the literal string dropped the identity `markReviewed` would
      // otherwise derive (`principal (model)`). The same act through `review` kept it,
      // so a sanity_check and a review of the same node disagreed about who did it.
      return markReviewed(c.universe.path, { targetKind: "node", targetId: a.id, level: "logical", reviewer: a.reviewer, actor: "agent" });
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
    name: "disconnect",
    description: "Remove wiring between two nodes — the other half of `connect`.\n\nUse it to say \"that step does not belong\" or \"this does not depend on that\". Without a removal a wiring disagreement can only be resolved by ADDING, which is accumulation rather than resolution.\n\nThe node's whole outgoing set is republished, so this is you stating what the wiring IS, not just what to subtract. Analyzer-generated edges are refused: they are regenerated from the code on every machine, so removing one here is undone by the next `check_stale`.",
    inputSchema: obj({
      from: { type: "string", description: "Source node id." },
      to: { type: "string", description: "Target node id." },
      type: { type: "string", description: "The edge type to remove." },
    }, ["from", "to", "type"]),
    mutates: true,
    handler: (a, c) => ops.disconnect(c.universe.path, { from: a.from, to: a.to, type: a.type }),
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
    description: "Confirm a doc is still accurate at the CURRENT code without editing or forking it: accepts the current anchor hashes, clearing a `stale` flag. Use when a change touched code the doc cites but the doc's claims still hold. (Editing a stale doc instead FORKS a new version — confirm is the 'no change needed' path.) Docs versioning: see how a node resolves per branch via get_node/node_versions.\n\nConfirming IS a corroborating read, so it also records an agent review — the same mark `sanity_check` makes, under the same no-self-vouching rule. The reply says whether it did: `reviewed: false` with a `reviewNote` when your own connection authored the doc, or when a person has signed it (see below).",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    mutates: true,
    handler: async (a, c) => {
      const r = await ops.confirm(c.universe.path, a.id) as Record<string, unknown>;
      if (r.error) return r;
      // Confirming is the strongest read the maintenance loop has — it compares the
      // doc against code that CHANGED — and it recorded nothing, so `trustOf` kept
      // reading `stale` off the review mark whose witness the same change invalidated.
      // A sweep that verified the whole map left the whole map looking unverified.
      const g = guardSelfCheck(c.universe.id, "node", a.id);
      if (g) return { ...r, reviewed: false, reviewNote: g.error };
      // The don't-overwrite-a-person guard that used to stand here is GONE, and
      // deliberately: review rows are keyed on the reviewer now (`rowIdentity`), so an
      // agent's read is its own row and cannot replace a sign-off. Both marks coexist
      // and `vouch` reports them separately — which is what the guard was approximating
      // while accountability and evidence shared one slot.
      const m = await markReviewed(c.universe.path, {
        targetKind: "node", targetId: a.id, level: "logical", actor: "agent",
      }) as { ok?: boolean };
      return { ...r, reviewed: !!m.ok };
    },
  },
  {
    name: "ack_hole",
    description: "Acknowledge a hole: the code a doc cited was removed ON THIS BRANCH and that's correct → tombstone the doc here (it disappears from this branch's map, but its content version still wins on branches where the code exists). Only valid when the doc is `dangling`. This is the branch-scoped 'delete' (vs delete_node which removes it everywhere).\n\nA doc reading `unverifiable` is REFUSED and queued instead. Its citations were minted by a build whose anchor derivation this one cannot reproduce, so nobody here can establish that the code is gone — and hiding a doc whose subject may be sitting right there is the direction with no recovery. The reply carries `queued`, the id of a question filed on the node with the ids, the commit they were written at and the derivation that minted them. Work that out and re-cite the doc; if the subject really is gone, say so and leave the retiring to a person.",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    mutates: true,
    handler: (a, c) => ops.ackHole(c.universe.path, a.id),
  },
  {
    name: "node_versions",
    description: "List all versions of a node with each version's per-branch status (fresh/stale/unverifiable/dangling/removed), created commit/branch, and cited anchors — for understanding a forked doc.",
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
    name: "list_bugs",
    description: "List bugs in a universe — this machine's and the team's, in one list. Open bugs whose anchored code changed since filing are flagged `possiblyFixed`; re-validate those rather than closing them, because a symbol that vanished may have been renamed or deleted without the defect being addressed. `queue: true` is the short list: what needs a PERSON here (promoted, corroborated, contested, asked about, or drifted).",
    inputSchema: obj({
      state: { type: "string", enum: ["issued", "created", "invalid", "refuted", "resolved", "withdrawn"] },
      open: { type: "boolean", description: "Only bugs that are not closed." },
      queue: { type: "boolean", description: "Only what is waiting on a person on this machine." },
    }),
    handler: (a, c) => ops.listBugs(c.universe.path, a),
  },
  {
    name: "bug",
    description: "One bug in full: prose, the discussion thread, second opinions, external tracking, and each cited anchor resolved to its live symbol with a `stale` flag. Read this before acting on a bug — `stale` is judged against the code in front of you, not against what was stored.",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    handler: (a, c) => ops.bugDetail(c.universe.path, a.id),
  },
  {
    name: "update_bug",
    description: "Update a bug: change state, add a comment, add anchors, refresh witness hashes, or revise its prose/severity. With a sidecar each of those is a separate act in the shared log, because they merge differently — citations are grow-only, prose can be contested, and the state is ratcheted. An agent may not move a bug somebody has stood behind; use `request_human` for that.",
    inputSchema: obj({
      id: { type: "string" },
      state: { type: "string", enum: ["issued", "created", "invalid", "refuted", "resolved", "withdrawn"] },
      reason: { type: "string", description: "Why, when closing one. Kept on the record." },
      note: { type: "string", description: "A comment on the bug — the team sees it." },
      addAnchors: { type: "array", items: { type: "string" } },
      refreshWitnesses: { type: "boolean", description: "Re-snapshot the cited code's hashes as the current witness, clearing `stale`. Say so in a note: it erases the evidence that the code moved." },
      title: { type: "string" },
      description: { type: "string" },
      severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
      category: { type: "string" },
    }, ["id"]),
    mutates: true,
    handler: (a, c) => ops.updateBug(c.universe.path, a),
  },
  {
    name: "track_bug",
    description: "Record that a bug is tracked outside codemap — a Jira ticket, a GitHub issue. It does NOT close the bug: being in a tracker is not being fixed, and the witness is still what decides that here. One reference per system, and the first one stands — if somebody already filed a ticket for this, that is the ticket.",
    inputSchema: obj({
      id: { type: "string" },
      system: { type: "string", description: "jira (default), github, or whatever the team uses." },
      key: { type: "string", description: "The ticket key, e.g. ACME-1234." },
      url: { type: "string", description: "A http(s) link to it." },
    }, ["id"]),
    mutates: true,
    handler: (a, c) => ops.trackBugExternally(c.universe.path, a.id, { system: a.system, key: a.key, url: a.url }),
  },
  {
    name: "promote_annotation",
    description: "Turn a `pointer`, `question` or `note` into a FINDING on a pull request — for when a watch-out you left turns out to be a real defect.\n\nThe only route. Filing a second record with `report_defect` and resolving the first loses the id, the history, the original author and the time it was raised, and leaves the team's copy pointing at an id nothing tracks any more.\n\nIt MOVES: the annotation becomes the finding and stops being an annotation. A pointer confirmed as a defect is not a separate thing from the finding — leaving both is the two-records-for-one-defect problem `codemap unify-findings` exists to drain. (`defer_finding` is different on purpose: a finding and the bug it defers to are two real obligations.)\n\n`pr` is REQUIRED and never inferred. An annotation carries no pull request of its own, and guessing one by intersecting its target with a worklist is wrong the moment two pull requests touch the same symbol.",
    inputSchema: obj({
      id: { type: "string", description: "An annotation id — from `get_anchor`, `questions` or `review_queue`." },
      pr: { type: "string", description: "Which pull request the finding belongs to. Say it; nothing infers it." },
    }, ["id", "pr"]),
    mutates: true,
    handler: (a, c) => ops.promoteAnnotation(c.universe.path, a.id, a.pr),
  },
  {
    name: "defer_finding",
    description: "Defer a pull-request finding into a bug, so it is not lost when the PR closes. The ONLY route from a finding to a bug — filing a second copy with `report_defect` loses the cross-link and the history.\n\nThe bug is witnessed at the ref the FINDING was witnessed at, so a finding about code the pull request INTRODUCES defers like any other — that code is in this store under the branch's snapshot, which `codemap pr <N>` wrote.\n\nThe finding SURVIVES and cross-links — the PR's history should still show it was raised there — and what transfers is the obligation: the finding stops asking for a decision because the bug is asking now. The bug's id is derived from the finding's, so two people accepting the same finding independently land on ONE bug rather than two.\n\nThe bug is filed against the anchors the finding names, witnessed here. A finding on a node takes that node's citations in THIS checkout, which is a judgement about what the defect covers — check it is the right code first.",
    inputSchema: obj({
      id: { type: "string", description: "A finding id, from `findings` or `shared_findings`. It carries its own pull request." },
      finding: { type: "string", description: "Deprecated alias for `id` — every sibling tool in this workflow spells it `id`." },
      title: { type: "string", description: "Defaults to the finding's first line." },
      severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
    }, []),
    mutates: true,
    handler: (a, c) => {
      const id = String(a.id ?? a.finding ?? "");
      if (!id) return Promise.resolve({ error: "defer_finding needs a finding `id`." });
      return ops.deferFinding(c.universe.path, id, { title: a.title, severity: a.severity });
    },
  },
  {
    name: "publish_bugs",
    description: "Send this machine's local bugs to the team. The BACKFILL path, not the ordinary one — with a sidecar configured `report_defect` already files into the shared log. What this is for is the backlog that predates the sidecar. `dryRun: true` counts without writing.",
    inputSchema: obj({
      dryRun: { type: "boolean" },
      ids: { type: "array", items: { type: "string" }, description: "Only these. Omit for every local bug." },
    }),
    mutates: true,
    handler: (a, c) => ops.publishBugs(c.universe.path, a),
  },
  {
    name: "annotate",
    description: "Attach review context to an anchor or node — durable on the map (not a throwaway PR comment), rendered inline for the human reviewer. `kind`:\n  • \"pointer\" — a review AID, not a defect: \"when reviewing this block, watch out for X / confirm Y.\" Points the human reviewer at what matters. `category` optional.\n  • \"question\" — an ask a human should answer (open-questions queue, see `questions`).\n  • \"note\" (default) — a durable remark.\n\nA DEFECT IS NOT AN ANNOTATION. `report_defect` files those, and it is REFUSED here rather than downgraded: a finding filed as an annotation is a local record with no pull request, so `shared_findings`, `defer_finding` and `inbound_replies` can none of them ever reach it — which is the split store `codemap unify-findings` exists to drain.\n\nPin to a specific line with `line` (for anchor targets) so it renders against that line. Typical agent review pass: read a segment → `review` it (level:code → `checked`) → `report_defect` what you found, `annotate` the pointers. `category` mirrors CI review buckets (Authorization, Logic, Tenant Safety, Performance, Domain Model, Validation, …)." + COMMENT_CONTRACT,
    inputSchema: obj({
      targetKind: { type: "string", enum: ["anchor", "node"] },
      targetId: { type: "string" },
      text: { type: "string", description: "The EVIDENCE, for the map and for whoever triages: what you checked, why the obvious alternative fails, what is still unverified. Not published." },
      comment: { type: "string", description: "The submitter-facing version, if this is going to a person — see the contract in this tool's description. Max 800 characters; longer is refused." },
      disposition: { type: "string", enum: ["open", "confirmed", "partial", "rerated", "refuted", "accepted"], description: DISPOSITION_DOC },
      publishPath: { type: "string", description: "Only when this is about code the pull request does not touch: the file IN THE DIFF nearest to the problem. Usually left to the human, who is better placed to judge \"nearest\" — an unset one is reported, never guessed." },
      publishLine: { type: "number", description: "Line within `publishPath`, if a specific one is meant." },
      kind: { type: "string", enum: ["note", "question", "pointer"], description: "\"pointer\" (a watch-out for the reviewer), \"question\" (an ask for a person), or \"note\" (default). A DEFECT is not an annotation — use `report_defect`, which puts it on a pull request or in the bug list rather than leaving it as a remark on a symbol." },
      severity: { type: "string", enum: ["low", "medium", "high", "critical"], description: "critical=security/auth/data-integrity, high=logic bug, medium=improvement, low=nitpick." },
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
      + "Chapter and feature ids are derived from titles, so re-walking a PR with the same structure keeps the reviewer's place. Chapters are witnessed against the head's bodies: when the submitter pushes, only the chapters whose code moved go stale, and only those need re-walking.\n\nPUBLISHED to the team's sidecar as part of writing it, when one is configured — writing a reading guide for a pull request the team reviews and keeping it to yourself is not a thing to have to remember. `shared` in the response says whether it happened, and it stages only: nothing reaches anybody until an explicit `sync`.",
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
          // DECLARED so that what `pr_walkthrough_get` returns can be handed straight
          // back. The read adds them and the write derives them, so a schema that
          // refused them broke the only natural editing loop there is — get, edit, put —
          // and every caller had to know to strip them first.
          id: { type: "string", description: "Ignored. Returned by `pr_walkthrough_get`; ids are derived from titles." },
          chapters: {
            type: "array",
            items: obj({
              title: { type: "string" },
              id: { type: "string", description: "Ignored — derived from the title." },
              witnesses: { type: "array", items: { type: "object" }, description: "Ignored — taken at write time from the pull request's head." },
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
    name: "pr_walkthrough_chapter",
    description:
      "Rewrite ONE chapter of a pull request's walkthrough, leaving the rest alone.\n\n"
      + "This is the verb for a re-walk after the submitter pushes. `pr_walkthrough_get` names the chapters whose code moved in `stale`; send those, one call each. Re-sending the whole document to change three chapters costs the read AND the write of everything you are not editing, and it scales the wrong way — the better documented the pull request, the more the smallest correction to it costs.\n\n"
      + "The document-level rules are unchanged and still checked, across the stored chapters with yours substituted in: every changed symbol still has to be covered, no symbol may be claimed by two chapters, and a chapter still needs a symbol in it. Moving a symbol from one chapter to another is therefore TWO calls — the one it leaves and the one it joins — and the first will be refused on its own, which is the invariant doing its job.\n\n"
      + "A chapter title that is not there is APPENDED to the named feature. `summary` re-states the feature's summary when the chapter's meaning changed it.\n\n"
      + "Somebody else's walkthrough is refused: editing one chapter of a teammate's reading would fork it under your name. Write your own with `pr_walkthrough`.",
    mutates: true,
    inputSchema: obj({
      pr: { type: "string", description: "PR number, url, or owner/repo#N." },
      feature: { type: "string", description: "The feature title this chapter belongs to, exactly as `pr_walkthrough_get` returns it." },
      title: { type: "string", description: "The chapter title. An unknown one is appended to the feature." },
      summary: { type: "string", description: "Optional: re-state the FEATURE's summary, if this chapter changed what it is about." },
      blocks: {
        type: "array",
        description: "The chapter's body — ordered, prose INTERLEAVED with symbols, exactly as `pr_walkthrough` describes it.",
        items: obj({
          kind: { type: "string", enum: ["prose", "symbol"] },
          text: { type: "string", description: "For `prose`." },
          anchorId: { type: "string", description: "For `symbol`." },
        }, ["kind"]),
      },
      dryRun: { type: "boolean", description: "Validate and report coverage without storing." },
    }, ["pr", "feature", "title", "blocks"]),
    handler: (a, c) => ops.prWalkthroughChapter(c.universe.path, String(a.pr ?? ""), {
      feature: String(a.feature ?? ""), title: String(a.title ?? ""),
      blocks: (a.blocks ?? []) as never, summary: a.summary as string | undefined,
    }, { by: "agent", dryRun: !!a.dryRun }),
  },
  {
    name: "pr_walkthrough_get",
    description: "The walkthrough for a pull request — yours, or a teammate's when they walked it and you did not. There is no separate tool for the team's: they are one set of readings, and which of them travelled is not a question you should have to ask.\n\n`stale` names the chapters whose code has moved since it was written (re-walk only those); `headMoved` means it was written against a different commit entirely. `sharedBy` is set when this is somebody else's reading, and `otherReadings` names the ones it is not showing. What this returns can be handed straight back to `pr_walkthrough` — the `id` and `witnesses` it adds are derived, and are ignored on the way in rather than refused.\n\nWHICH ONE you get: a reading written against THIS head wins over a stale one — a walkthrough about another commit is not a worse reading, it is about something else — and yours wins every tie. Pass `all` to get every reading with its body instead, newest and best-matching first, each with its own `stale` and `headMoved`.",
    inputSchema: obj({
      pr: { type: "string", description: "PR number, url, or owner/repo#N." },
      all: { type: "boolean", description: "Every reading of this pull request, with bodies — the fold keeps one per author. Use it to read a teammate's instead of the one chosen for you." },
    }, ["pr"]),
    handler: (a, c) => ops.prWalkthroughGet(c.universe.path, String(a.pr ?? ""), { all: !!a.all }),
  },
  {
    name: "pr_packet",
    description: "The pull request's changed symbols, ranked, WITH THEIR SOURCE AT THE PR's HEAD — and the base version of each, so you read the change rather than guessing it.\n\nThis is the tool for reviewing a PR. `get_anchor` returns the WORKING TREE's source, which during a review is a third version: not the PR's head and not the base. Quoting it as evidence for a finding is how a review cites code the pull request does not contain.\n\nPaged: `limit` (default 40) and `offset` walk the ranked worklist, so a large PR is read in passes rather than in one unusable response.",
    inputSchema: obj({
      pr: { type: "string", description: "PR number, url, or owner/repo#N." },
      limit: { type: "number", description: "Symbols per page (default 40)." },
      offset: { type: "number", description: "Where to start in the ranked worklist." },
      fetch: { type: "boolean", description: "Fetch the PR's refs first (default true). `false` requires them to be local already." },
    }, ["pr"]),
    // `prTriage` caches two commit snapshots, so this is a read that writes.
    mutates: true,
    handler: (a, c) => ops.prPacketFor(c.universe.path, String(a.pr ?? ""), {
      limit: a.limit as number | undefined,
      offset: a.offset as number | undefined,
      fetch: a.fetch !== false,
    }),
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
      tier: { type: "string", enum: ["unconfirmed", "confirmed", "doubted", "settled"], description: "How settled it is. PREFER this over `disposition` where they disagree — see `findings`." },
      remediation: { type: "string", enum: ["outstanding", "fixed-on-branch", "fixed-on-default", "deferred", "wont-fix"], description: "What HAPPENED about it — the other axis from `tier`." },
      pr: { type: "string", description: "Only items on this pull request." },
      publishState: { type: "string", enum: ["local", "approved", "withdrawn", "posted"], description: "Where it stands on its way to the pull request." },
    }, []),
    handler: (a, c) => ops.reviewQueue(c.universe.path, {
      includeAnswered: Boolean(a.includeAnswered), brief: a.brief !== false,
      limit: a.limit as number | undefined, offset: a.offset as number | undefined,
      pr: a.pr as string | undefined, tier: a.tier as string | undefined,
      remediation: a.remediation as string | undefined,
      disposition: a.disposition as string | undefined, publishState: a.publishState as string | undefined,
    }),
  },
  {
    name: "where_was",
    description:
      "What an anchor id NAMED, at a commit that named it. The one question about an unplaceable id that can be ANSWERED rather than guessed.\n\n"
      + "An anchor id is an opaque digest of file + symbol path + disambiguator, so it cannot be read backwards. But a commit can be indexed and the id looked for: what comes back is an anchor THIS build minted, from source at that commit, whose own id is the one you asked about. Nothing is trusted and nothing is inferred.\n\n"
      + "Four answers, and they are not the same:\n"
      + "  • `found` — that is where it was. The file, the symbol path and the line.\n"
      + "  • `absent` — this build indexed that commit and does not produce that id. Either the code was not there, or another build's derivation spelled the id.\n"
      + "  • `ambiguous` — this build mints that id for more than one symbol there, so it cannot say which. Refuses rather than picking.\n"
      + "  • `unaddressed` — there is no commit to ask about. `@work` is the live index, not a commit.\n\n"
      + "WHAT IT DOES NOT TELL YOU: where that symbol is NOW. A rename or a signature change gives it a different id by construction, so no digest can confirm the pairing — that step is a judgement, and if you cannot make it beyond doubt, say so instead of re-pointing the record.",
    inputSchema: obj({
      anchorId: { type: "string", description: "The id that will not resolve." },
      ref: { type: "string", description: "The commit that named it — a finding's `sourceRef`, a doc version's `createdCommit`." },
    }, ["anchorId", "ref"]),
    handler: (a, c) => ops.whereWas(c.universe.path, String(a.anchorId ?? ""), a.ref ? String(a.ref) : undefined),
  },
  {
    name: "orphans",
    description:
      "What is pointing at code the working tree no longer has — \"what did that refactor break?\"\n\n"
      + "An anchor id is derived from file + symbol path + signature, so it survives a line move or a body rewrite, but NOT a rename, a deletion, or a change to an overload's parameter list. Reindex replaces the live index wholesale, so an annotation whose target the new index does not produce used to be silently stranded.\n\n"
      + "Four buckets, and the difference is the point:\n"
      + "  • `offTree` — the symbol is in a cached commit snapshot, almost always a PR branch. Nothing is lost; the working tree is just on another branch. Re-run against that ref.\n"
      + "  • `retained` — gone from the tree and every snapshot, but its last known file/symbol/line/hash was kept because work pointed at it. Readable and re-anchorable.\n"
      + "  • `located` — no copy here, but the record's OWN commit still produces that id, so this build read that commit and can say what the symbol was. Only appears with `locate`.\n"
      + "  • `lost` — no copy here and nothing found. Each row carries `why`, because *nothing to ask*, *not asked*, *asked and absent* and *asked and ambiguous* are four different situations and only some are fixable.\n\n"
      + "`locate` is an ACT, not a default: it indexes the commit each stranded record names, which is seconds per commit. Without it the reply carries `locatable` — how many records could be asked about and how many commits that would open — and claims nothing it has not checked.\n\n"
      + "Items carrying `posted` are live on a pull request as review comments — a third party can see them, so the map disagreeing with GitHub about them is the worst case.",
    inputSchema: obj({
      locate: { type: "boolean", description: "Index each stranded record's own commit and say what its id named there. Seconds per distinct commit." },
      maxCommits: { type: "number", description: "How many distinct commits `locate` may open (default 25). Whatever it does not reach is reported as `notAsked`, never dropped." },
    }),
    handler: (a, c) => ops.orphanedWork(c.universe.path, { locate: !!a.locate, maxCommits: a.maxCommits as number | undefined }),
  },
  {
    name: "findings",
    description: "Every finding and question on the map — whoever raised them, whether or not anyone was asked to act, and whichever store they live in. Both halves: a finding filed with `report_defect` and a finding the team folded from the sidecar are one row here. `shared_findings` is the other view of the same pull request, from the sidecar's side, and carries the corroboration and thread this list only summarises.\n\n`review_queue` answers \"what have I been asked to do\" and only lists items with an assignment — so a finding raised by `annotate` and published to a pull request was invisible to every query afterwards. This one answers \"what is on this map, and where has it got to\".\n\nFilters: `pr` (one pull request — findings store theirs, so this is exact and not a guess from the diff), `tier` (how settled: `unconfirmed` is the untriaged pile), `disposition` (what triage concluded) and `publishState` (local / approved / withdrawn / posted). `tier` and `disposition` name the same axis in two vocabularies, and where they differ PREFER `tier`: `disposition` is flattened from state and corroboration and cannot tell `invalid` from unreviewed, so a finding closed as invalid reads `disposition:\"open\"` while its tier is `settled`. Ask \"what has nobody looked at\" with `tier:\"unconfirmed\"` — `disposition:\"open\"` puts closed-out findings in the pile. `tier` is also the word `shared_findings` uses, so it reads both lists.\n\n`posted` items carry `postedRef` with the review and comment they landed in. Brief by default, same as `review_queue`.",
    inputSchema: obj({
      pr: { type: "string", description: "Only findings on this pull request." },
      tier: { type: "string", enum: ["unconfirmed", "confirmed", "doubted", "settled"], description: "How settled it is — `unconfirmed` means nobody has weighed in yet. The vocabulary `shared_findings` uses." },
      remediation: { type: "string", enum: ["outstanding", "fixed-on-branch", "fixed-on-default", "deferred", "wont-fix"], description: "What HAPPENED about it — the other axis. `tier:\"confirmed\"` alone cannot tell an outstanding defect from one fixed last night." },
      disposition: { type: "string", enum: ["open", "confirmed", "partial", "rerated", "refuted", "accepted"] },
      publishState: { type: "string", enum: ["local", "approved", "withdrawn", "posted"] },
      includeResolved: { type: "boolean", description: "Also list findings a human has closed out (default false)." },
      includeAnswered: { type: "boolean", description: "Also return items an agent has already reported on." },
      ids: { type: "array", items: { type: "string" }, description: "Exactly these findings, by id — how you DEREFERENCE an id you were handed by `close_finding`, `revise_finding`, `comment`, `corroborate` or `shared_findings`. Applied before paging, and it implies `includeResolved`: you asked for this record, so its state is the answer, not a filter. Pair with `brief: false` to read one in full." },
      brief: { type: "boolean", description: "Default TRUE. `false` inlines each symbol's current source — large." },
      limit: { type: "number" },
      offset: { type: "number" },
    }, []),
    handler: (a, c) => ops.reviewQueue(c.universe.path, {
      assignedOnly: false,
      ids: a.ids as string[] | undefined,
      // Asking for a record by id and being told nothing exists, because a human
      // closed it, is the failure this whole affordance is for — so an id lookup
      // implies `includeResolved` rather than being filtered by it.
      includeResolved: Boolean(a.includeResolved) || !!(Array.isArray(a.ids) && a.ids.length),
      includeAnswered: Boolean(a.includeAnswered),
      brief: a.brief !== false,
      limit: a.limit as number | undefined, offset: a.offset as number | undefined,
      pr: a.pr as string | undefined, tier: a.tier as string | undefined,
      remediation: a.remediation as string | undefined,
      disposition: a.disposition as string | undefined, publishState: a.publishState as string | undefined,
    }),
  },
  {
    name: "close_finding",
    description: "Report back on a finding from `review_queue`. This records what you did; it does NOT resolve the finding — reporting and agreeing it is closed are different acts, and the human closes it after reading.\n\nIf you also pass `state` and the finding is confirmed or a person filed it, the close is recorded as a PENDING ask (`fixed pending`, `refuted pending`) with your reason on it, and lands in their queue — you do not need `request_human` for that. `result:\"fixed\"` with no `remediation` sets `fixed-on-branch` for you, because a report that says fixed must not leave the finding counted as open.\n\nThe answer is structured: `applied` lists what landed, `refused` says what did not and why, and `ok` is false if anything was refused. Do not read `note` for that.\n\n`result`:\n  • \"fixed\" — you changed the code. List every file you touched in `files`; more than one is refused, by design.\n  • \"answered\" — you investigated. Put the finding in `detail`: whether it is real, why, and what you checked.\n  • \"declined\" — you did not act. Say what it would take. Declining a fix that spans files, or that needs a judgement call you cannot make, is the RIGHT answer.\n\n`result` is what YOU DID; `disposition` is what turned out to be TRUE of the finding. They are different axes — a false positive is `answered` + `refuted`, because you did answer and the answer was \"not a defect\". Set `disposition` whenever you reached a conclusion: it is what decides whether this goes to the submitter, and prose saying \"recommend closing as invalid\" cannot be filtered on.\n\nThe same rule governs the other two conclusions an investigation reaches: a corrected `comment` and a re-rated `severity` go in the FIELDS, on the record, not into `detail`. A severity stated only in prose leaves the finding reading what it was filed as to everyone filtering by it.\n\nTakes any finding id — your own, another agent's, or the TEAM's from `shared_findings`; there is no second tool for the shared half and no `pr` to get wrong. On a team finding `disposition` becomes corroboration where it is a verdict (`confirmed`/`refuted`) and is reported back as not recorded otherwise. `comment`, `line` and `category` land at any point in a finding's life; only `severity` is refused, and only once somebody has confirmed it." + COMMENT_CONTRACT,
    inputSchema: obj({
      id: { type: "string", description: "A finding id, from `review_queue`, `findings` or `shared_findings`." },
      result: { type: "string", enum: ["fixed", "answered", "declined"] },
      detail: { type: "string", description: "What you did or found — the human reads this, so be concrete." },
      disposition: { type: "string", enum: ["open", "confirmed", "partial", "rerated", "refuted", "accepted"], description: DISPOSITION_DOC },
      comment: { type: "string", description: "Rewrite the submitter-facing version if your investigation changed it — as a standalone statement about the code, not as a diff against the filing, which the submitter has never seen. Max 800 characters. The previous wording is kept on the map." },
      line: { type: "number", description: "The line in the finding's own file that it actually points at. SET THIS — you have just read the code, and without it the comment is placed by geometry (the enclosing symbol's first changed line), which lands on a neighbouring member." },
      severity: { type: "string", enum: ["low", "medium", "high", "critical"], description: "Re-rate it, if the investigation changed the rating. Set the value you now believe — not the delta, and not a note about it in `detail`." },
      remediation: { type: "string", enum: ["outstanding", "fixed-on-branch", "fixed-on-default", "deferred", "wont-fix"], description: "What HAPPENED about it, as opposed to whether it is true — a separate axis from `disposition`. Set it when you have verified the code, and say where in `detail`. `fixed-on-branch` vs `fixed-on-default` is load-bearing: a fix on an unmerged branch means the mainline still carries the defect, so a linked bug must NOT be closed. Never reach for `refuted` to mean \"fixed\" — that marks a real defect a false positive and poisons the one question this data answers." },
      state: { type: "string", enum: ["created", "issued", "invalid", "refuted", "resolved", "withdrawn"], description: "Where the finding should END UP, if you have concluded that. Optional — reporting and closing are different acts, and most reports are not closes. On a finding nobody has confirmed and no person filed, it just happens; otherwise it is recorded as a PENDING ask carrying your `detail` as the reason, shows as `refuted pending` / `fixed pending` on the item, and lands in a person's queue." },
      files: { type: "array", items: { type: "string" }, description: "Files you actually changed (for `fixed`). One file maximum." },
      by: { type: "string" },
    }, ["id", "result", "detail"]),
    mutates: true,
    handler: (a, c) => ops.closeFinding(c.universe.path, a as never),
  },
  {
    name: "revise_finding",
    description:
      "Correct a finding — yours or somebody else's — without losing what it used to say.\n\n"
      + "Findings get filed before they are understood: a report goes in, investigation shows it was overstated or aimed at the wrong line, and the correction has to be visible AS a correction. Revisions APPEND; nothing is destroyed, and the previous wording stays readable ON THE MAP.\n\n"
      + "The submitter is not a party to that history: they receive the latest `comment` and nothing else. A revised comment therefore has to STAND ALONE — rewritten as if filed fresh, not written as a correction to the one before it.\n\n"
      + "Use it to sharpen a `comment`, to record what triage concluded (`disposition`), to re-rate a `severity` you now think is wrong, or to set `publishPath` for a finding about code the pull request does not touch.\n\n"
      + "Takes any finding id — your own, another agent's, or the TEAM's from `shared_findings`. The store the row lives in is not yours to work out, and it is not visible in the id.\n\n"
      + "TWO REFUSALS, both because the revision would otherwise be written and then ignored:\n"
      + "  • Already on the pull request — revising it here would diverge from the copy the submitter is acting on. Reply there instead.\n"
      + "  • `severity` on a CONFIRMED finding — the one field where \"somebody stood behind this number\" is the whole content, so re-rating it is theirs. Everything else about the finding you may rewrite at any point in its life, confirmed or not: what a finding SAYS is the text that gets published and acted on, and leaving a wrong one standing under a correction is worse for the reader than replacing it. Nothing is lost — the previous wording stays in `revisions`.\n\n"
      + "On a team finding `disposition` has nowhere true to live: `confirmed` and `refuted` are recorded as corroboration (with your `text` as the rationale), and the other four are reported back as not recorded rather than dropped quietly. `publishPath`/`publishLine` are local publishing fields with no shared equivalent."
      + COMMENT_CONTRACT,
    inputSchema: obj({
      id: { type: "string", description: "A finding id, from `findings` or `shared_findings`." },
      text: { type: "string", description: "The evidence — for the map, not published." },
      comment: { type: "string", description: "The submitter-facing version, rewritten to stand alone — it replaces the old one for the reader, who never sees what it replaced. Max 800 characters." },
      disposition: { type: "string", enum: ["open", "confirmed", "partial", "rerated", "refuted", "accepted"], description: DISPOSITION_DOC },
      severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
      line: { type: "number", description: "The line in the finding's OWN file that it points at — the normal way to say where it is." },
      publishPath: { type: "string", description: "For a finding about code this PR does not touch: the file IN THE DIFF nearest to the problem. An out-of-diff override, not the everyday field — use `line` for that." },
      publishLine: { type: "number", description: "Line within `publishPath`. Only meaningful alongside it." },
      remediation: { type: "string", enum: ["outstanding", "fixed-on-branch", "fixed-on-default", "deferred", "wont-fix"], description: "What HAPPENED about it, as opposed to whether it is true — a separate axis from `disposition`. Set it when you have verified the code, and say where in `detail`. `fixed-on-branch` vs `fixed-on-default` is load-bearing: a fix on an unmerged branch means the mainline still carries the defect, so a linked bug must NOT be closed. Never reach for `refuted` to mean \"fixed\" — that marks a real defect a false positive and poisons the one question this data answers." },
      ref: { type: "string", description: "Re-witness against this ref after re-reading the code — how a finding blocked as \"written against a different version\" is cleared. Not available on a TEAM finding — the fold has no re-witness event, and it says so rather than dropping it." },
      category: { type: "string", description: "Review bucket: Authorization, Logic, Tenant Safety, Performance, Domain Model, Validation, …" },
      allowPostEdit: { type: "boolean", description: "Revise even though it is already posted. The GitHub copy is NOT updated — reply there instead; this only stops the map from silently disagreeing with it. Lifts ONLY the already-posted refusal — there is no gate it lifts on `severity`, and nothing here edits the GitHub copy" },
      by: { type: "string" },
    }, ["id"]),
    mutates: true,
    handler: (a, c) => ops.reviseOn(c.universe.path, a as never),
  },
  {
    name: "questions",
    description: "List open questions a human left during review — the 'answer these to improve the docs' queue. Address each (edit the cited doc), then resolve_question.",
    inputSchema: obj({ includeResolved: { type: "boolean" } }),
    handler: (a, c) => ops.listQuestions(c.universe.path, a),
  },
  {
    name: "resolve_question",
    description: "Close out a review QUESTION (or re-open with resolved:false) once you've answered it by improving the documentation.\n\nQuestions only. Reporting on a finding and agreeing it is closed are different acts — use `close_finding` to say what you did and what you found; the human closes it after reading.\n\nDispatches on the record. Your own question closes here AND on the team's copy — except from an agent, which closes the local one and is told the shared copy is still open, because settling a question for everybody is a person's act. A teammate's question (`shared:true` in `questions`) has no local copy at all, so an agent is refused outright: `answer_shared_note` is the tool for that.",
    inputSchema: obj({ id: { type: "string" }, resolved: { type: "boolean" } }, ["id"]),
    mutates: true,
    handler: (a, c) => ops.resolveAnnotation(c.universe.path, a.id, a.resolved !== false, { actor: "agent" }),
  },

  // --- shared review (the sidecar). Absent a sidecar these say so and change nothing.
  {
    name: "sync",
    description: "Send and receive shared review state with the team's sidecar repo. Pull happens FIRST, always — the guard against publishing a finding somebody already published only works if it has seen what they published. Safe to run at any time; it never rewrites anyone's events.",
    inputSchema: obj({}),
    mutates: true,
    handler: (_a, c) => shared.sharedSync(c.universe.path),
  },
  {
    name: "pull",
    description: "Receive the team's shared review state WITHOUT sending yours. Use it to read what the team knows before deciding whether your own findings are ready to publish; use `sync` when you want both halves. Same fold and the same queueing as `sync` — only the push is missing.",
    inputSchema: obj({}),
    mutates: true,
    handler: (_a, c) => shared.sharedPull(c.universe.path),
  },
  {
    name: "shared_findings",
    description: "Findings on the sidecar for a pull request — everyone's, not just yours. Read this before filing: a finding somebody has already raised and refuted does not need raising again.\n\nTwo different questions, and they are NOT the same list:\n  • `tier` — how settled each finding is. `unconfirmed` is the untriaged pile: filed, and nobody has weighed in. That is what \"what still needs triage\" means, and it is what you want when somebody asks for the ones not confirmed yet. Also `confirmed` (somebody stood behind it), `doubted` (refuted, withdrawn, or carrying a refuting verdict) and `settled` (closed).\n  • `queue:true` — what is waiting on a PERSON: promoted, confirmed by somebody, contested, or with an outstanding request. An UNTRIAGED finding is waiting on nobody by that definition, so the queue deliberately does not contain it — triaging one is what PUTS it there.\n\n`tiers` on the answer counts all four whatever you filtered by, so the shape of the pull request is visible from any call.",
    inputSchema: obj({
      pr: { type: "string", description: "Pull request number." },
      tier: { type: "string", enum: ["unconfirmed", "confirmed", "doubted", "settled"], description: "Only findings at this tier. `unconfirmed` = nobody has weighed in yet." },
      remediation: { type: "string", enum: ["outstanding", "fixed-on-branch", "fixed-on-default", "deferred", "wont-fix"], description: "Only findings whose remediation is this — what HAPPENED about them, as opposed to whether they are true." },
      queue: { type: "boolean", description: "Only what needs a human decision. Excludes the untriaged — use `tier` for those." },
      rerated: { type: "boolean", description: "Only findings whose severity is not the one they were filed at — \"real, but not as bad (or worse) than it looked\". Derived from the revision trail, so it cannot disagree with it." },
      terse: { type: "boolean", description: "DEFAULT TRUE, and what you want for triage: `id`, `tier`, `state`, `severity`, `remediation`, any pending ask, and the first line of the comment. `false` returns everything — the investigation text, the thread, every verdict, outcome and ask — which on 25 findings is ~195k characters and spills to a file. Read one in full with `findings` + `ids: [\"f_…\"]`, `brief: false`." },
      limit: { type: "number", description: "How many to return. The answer says `shown`, `more` and `nextOffset` when it is a page rather than the whole list." },
      offset: { type: "number", description: "Where to start, for the next page." },
    }, ["pr"]),
    handler: (a, c) => shared.sharedFindings(c.universe.path, a.pr, {
      queue: !!a.queue, tier: a.tier as never, remediation: a.remediation as never, rerated: !!a.rerated,
      // TERSE BY DEFAULT for an agent. The web calls the same op and passes nothing,
      // so it keeps the full shape its expanded rows render from.
      terse: a.terse !== false,
      limit: typeof a.limit === "number" ? a.limit : undefined,
      offset: typeof a.offset === "number" ? a.offset : undefined,
    }),
  },
  {
    name: "report_defect",
    description: "Report a defect. ONE verb — you say what you were DOING, and that decides what the record becomes.\n\n"
      + "  • `context: {kind:\"pull_request\", pr:\"270\"}` — found while reviewing that pull request. Becomes a FINDING on it, resolved at or before merge, visible to the team and to their agents. Needs `targetKind`/`targetId` (the one symbol or node) and `comment`.\n"
      + "  • `context: {kind:\"drive_by\", rationale:\"noticed while changing X\"}` — spotted during unrelated work. Becomes a BUG, which outlives the branch. Needs `title` and `anchors`.\n\n"
      + "There is no storage parameter and there is no way to pick one. A pull-request finding belongs on the pull request, where the person who wrote the code will see it; whether it also reaches the sidecar depends on whether this machine has one, which is not your decision.\n\n"
      + "To defer a pull-request finding into a bug later, use `defer_finding` — that cross-links the two instead of filing a second, unattributed copy."
      + COMMENT_CONTRACT,
    inputSchema: obj({
      context: {
        type: "object",
        description: "What you were doing. `{kind:\"pull_request\", pr}` or `{kind:\"drive_by\", rationale}`.",
        properties: {
          kind: { type: "string", enum: ["pull_request", "drive_by"] },
          pr: { type: "string", description: "Pull request NUMBER, for `pull_request`." },
          rationale: { type: "string", description: "What you were doing when you noticed it, for `drive_by`." },
        },
        required: ["kind"],
      },
      text: { type: "string", description: "The evidence: what you checked, why the obvious alternative fails, what is still unverified. Not published." },
      comment: { type: "string", description: "REQUIRED on a pull-request finding — the submitter-facing version." },
      severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
      category: { type: "string", description: "Review bucket: Authorization, Logic, Tenant Safety, Performance, Domain Model, Validation, …" },
      targetKind: { type: "string", enum: ["anchor", "node"], description: "Pull-request findings: what the target is." },
      targetId: { type: "string", description: "Pull-request findings: the symbol or node it is about." },
      line: { type: "number", description: "1-based line the finding is about." },
      ref: { type: "string", description: "Resolve and witness the target at this commit too — a PR head, for a symbol that exists only on the branch." },
      title: { type: "string", description: "Drive-by bugs: the one line a triage list is read by." },
      anchors: { type: "array", items: { type: "string" }, description: "Drive-by bugs: the code it is anchored to (`file#Symbol`, `file:line`, or an id)." },
      model: { type: "string", description: "YOUR model id, e.g. \"claude-opus-5\". Recorded so the record says which model raised it. Never guess it." },
      harness: { type: "string", description: "The tool running you, e.g. \"claude-code\". Optional." },
    }, ["context", "text"]),
    mutates: true,
    handler: (a, c) => ops.reportDefect(c.universe.path, a as never),
  },
  {
    name: "comment",
    description: "Say something on a finding or a bug — the reviewers' thread. For a finding this lives here rather than on GitHub so that findings about ABSENT code, and about code the branch never touched, can be discussed in place.\n\nOne verb for both: pass the id and the record decides. There is no separate tool per entity type, and no `pr` to get wrong — a finding carries its own.",
    inputSchema: obj({
      id: { type: "string", description: "A finding or bug id, from `findings`, `shared_findings` or `list_bugs`." },
      body: { type: "string" },
      inReplyTo: { type: "string" },
      model: { type: "string", description: "YOUR model id. Never guess it." },
      harness: { type: "string" },
    }, ["id", "body"]),
    mutates: true,
    handler: (a, c) => ops.commentOn(c.universe.path, a as never),
  },
  {
    name: "corroborate",
    description: "Weigh in on somebody else's finding or bug: is it real? This is the point of several models reviewing — DISAGREEMENT is the signal, so refute plainly when you think it is wrong rather than deferring. Your verdict never replaces anyone else's, only your own earlier one. A rationale is required: a verdict without one is a vote, not a review.\n\nCorroborating something raised by the person you are running as does not count as independent — say so anyway, it is still worth recording, and passing `model` is what makes cross-model agreement measurable at all.",
    inputSchema: obj({
      id: { type: "string", description: "A finding or bug id." },
      verdict: { type: "string", enum: ["confirm", "partial", "refute", "unsure"], description: "`partial` — real, but not as filed: the defect is there and the stated impact or scope is not. Say the part that IS real, in full, in `rationale`; it is the commonest honest answer in triage and it counts as standing behind the finding." },
      anyway: { type: "boolean", description: "Record the verdict even though this checkout does not contain the commit the finding was witnessed at. Only when you have read the RIGHT code by another route — `git show <ref>:<file>`, or the pull request on GitHub. The refusal exists because a triage pass once refuted five findings for being \"not present\" while standing on a branch that predated them." },
      rationale: { type: "string", description: "What you actually checked." },
      model: { type: "string", description: "YOUR model id. Never guess it." },
      harness: { type: "string" },
    }, ["id", "verdict", "rationale"]),
    mutates: true,
    handler: (a, c) => ops.corroborateOn(c.universe.path, a as never),
  },
  {
    name: "request_human",
    description: "Ask a PERSON for something that is not a state change you have already concluded — chiefly `promote` (\"this is real, the team should know\"), or a close you want to flag WITHOUT having reached it yourself.\n\nYou usually do not need this to close something. `close_finding` records the ask for you: if the finding is confirmed, or a person filed it, your close is written as a pending `<state> pending` on the record with your reason attached, and it shows in their queue. That is the same act, in the verb you already reached for — two tools that looked more appropriate is exactly why this one went unused.\n\nAsks: `promote | invalidate | refute | resolve | withdraw`. `withdraw` retires the record with the claim intact — a duplicate.",
    inputSchema: obj({
      id: { type: "string", description: "A finding or bug id." },
      action: { type: "string", enum: ["promote", "invalidate", "refute", "resolve", "withdraw", "reopen"], description: "`withdraw` retires the record with the claim intact — a duplicate. The other four say something about whether it is true." },
      rationale: { type: "string", description: "Why. This is what the human reads to decide." },
    }, ["id", "action", "rationale"]),
    mutates: true,
    handler: (a, c) => ops.requestHuman(c.universe.path, a as never),
  },
  {
    name: "relocate_finding",
    description: "Say where a finding's target went, when its symbol is not in the checkout. FIRST check WHY it is missing: `shared_findings` reports `target.where` as `offTree` (the symbol is on another branch — nothing is wrong, do NOT relocate it), `retained` (gone from the tree, last known location recorded), or `lost`. Only the last two are yours to act on.\n\n`moved` needs the anchor id it moved TO — \"it moved\" is not actionable. `gone` says the code was genuinely removed. You may PROPOSE either, which queues it for a person; you may not apply one, because re-pointing a finding at the wrong symbol is worse than leaving it untriaged.",
    inputSchema: obj({
      id: { type: "string", description: "A finding id. It carries its own pull request." },
      kind: { type: "string", enum: ["moved", "gone"] },
      to: { type: "string", description: "For `moved`: the anchor id it is now." },
      rationale: { type: "string", description: "What you checked — the commit that renamed it, or where the code went." },
    }, ["id", "kind", "rationale"]),
    mutates: true,
    handler: (a, c) => ops.relocateOn(c.universe.path, String(a.id ?? ""), a.kind, String(a.rationale ?? ""), { to: a.to }),
  },
  {
    name: "shared_docs",
    description: "The TEAM's documentation, each doc resolved against the code you have checked out. One sidecar serves every branch: a doc is a set of immutable versions, each recording the anchors it cites with the body hashes it was confirmed against, and the version whose hashes match your checkout is the one you get — no branch tags, no git. Read `citations[].matches` to tell fresh from stale; a version being returned does NOT mean it describes your code.",
    inputSchema: obj({
      nodeId: { type: "string", description: "Only this node (default: all)." },
      terse: { type: "boolean", description: "Titles, summaries and status without the doc BODIES — and `citations`/`citationsMatching` as counts instead of the array. What you want to ask \"does the team already document this?\"; re-read the one you want with `nodeId`." },
      limit: { type: "number", description: "Cap the rows returned. `total` still counts the corpus and the reply says `truncated`." },
    }),
    handler: (a, c) => shared.sharedDocs(c.universe.path, { nodeId: a.nodeId, terse: !!a.terse, limit: a.limit as number | undefined }),
  },
  {
    name: "confirm_shared_doc",
    description: "Record that a shared doc is still true of the code YOU have checked out. This is what lets one version be valid on several branches at once: it adds your body hashes to the version's accepted set rather than writing a new version. Use it when you have read the doc against the code and it holds; write a new version instead when it does not.",
    inputSchema: obj({ nodeId: { type: "string" }, versionId: { type: "string", description: "Defaults to the version that resolves here." } }, ["nodeId"]),
    mutates: true,
    handler: (a, c) => shared.confirmSharedDoc(c.universe.path, a.nodeId, a.versionId),
  },
  {
    name: "shared_triage",
    description: "What the TEAM says a symbol is worth — everyone's stakes, with the receipt for each. Read it before you triage: somebody may already have decided this is business-critical, and the ordinary triage surfaces show you only the effective value, not who set it or why.\n\nEach field carries its own receipt, because a mark whose importance is a person's and whose complexity is an agent's has no single author. `escalatedByAgent` means an agent raised it above the human baseline, which is shown beside it — that is a proposal awaiting confirmation, not a decision. `contested` means two people disagree ACROSS the business-critical line and a person has to settle it; you may investigate and PROPOSE, and you may not settle it yourself.\n\nOmit both arguments for the whole universe.",
    inputSchema: obj({
      targetKind: { type: "string", enum: ["node", "anchor"], description: "Optional filter." },
      targetId: { type: "string", description: "Optional: one anchor or node id." },
    }, []),
    handler: (a, c) => shared.sharedTriage(c.universe.path, a.targetKind, a.targetId),
  },
  {
    name: "contested_triage",
    description: "Stakes two people disagree about across the business-critical line — the only triage disagreement worth interrupting somebody for, and the one a person must settle.\n\nEverything else the fold settles silently: two people who never saw each other disagreeing about `low` versus `important` is not worth anyone's attention, and the higher value holds meanwhile so nothing is under-reviewed. These are the exceptions.\n\nYour job here is to INVESTIGATE and propose — read the code, weigh both stated reasons, and report what you found through `close_finding` on the queued question (it arrives in `review_queue` as an `investigate` assignment). The person settles by triaging the symbol again having seen both sides; that mark supersedes both and the item closes itself.",
    inputSchema: obj({}, []),
    handler: (_a, c) => shared.contestedTriage(c.universe.path),
  },
  {
    name: "shared_notes",
    description: "What the TEAM knows about a symbol — everyone's notes, questions and pointers on it, not just this store's. Read it before investigating: somebody may already have worked out why the obvious answer here is wrong, and that knowledge cost them real reading time. Answers to a question are listed with it.",
    inputSchema: obj({ targetId: { type: "string", description: "The anchor or node id." } }, ["targetId"]),
    handler: (a, c) => shared.sharedNotes(c.universe.path, a.targetId),
  },
  {
    name: "answer_shared_note",
    description: "Answer somebody's open question about a symbol. You may ANSWER; you may not mark it settled — that is a person's act, same as closing a finding. Say what you found and let them close it.",
    inputSchema: obj({ targetId: { type: "string" }, id: { type: "string" }, body: { type: "string" } }, ["targetId", "id", "body"]),
    mutates: true,
    handler: (a, c) => shared.answerSharedNote(c.universe.path, a.targetId, a.id, a.body),
  },
  {
    name: "inbound_replies",
    description: "What the pull request's SUBMITTER said back about findings this team published. Read-only and one-directional: the reviewers' discussion lives on the sidecar (GitHub cannot host a conversation about code the branch never touched, or about an ABSENCE), but the person who has to fix it answers on the pull request and that answer exists nowhere else. Read it before acting on a finding — they may have already explained why it is not a defect.",
    inputSchema: obj({ pr: { type: "string" } }, ["pr"]),
    handler: (a, c) => shared.inboundReplies(c.universe.path, a.pr),
  },
  {
    name: "record_published",
    description: "Record WHERE a finding landed on the pull request, after you posted it there. `inbound_replies` reads nothing else — a finding with no record here is one whose replies nobody will ever be shown, however loudly the submitter answers. `key` is the review comment's numeric id (the `id` field of the GitHub API's comment object, not the node id), which is what ties the thread back to this finding.",
    inputSchema: obj({
      id: { type: "string", description: "A finding id. It carries its own pull request." },
      key: { type: "string", description: "The review comment's numeric id on GitHub." },
      url: { type: "string", description: "Its permalink, for people reading the finding." },
    }, ["id"]),
    mutates: true,
    handler: (a, c) => ops.recordPublishedOn(c.universe.path, String(a.id ?? ""), { key: a.key, url: a.url }),
  },
  {
    name: "share_doc",
    description: "Publish ONE doc version to the sidecar — the doc you just wrote, rather than the whole store. The CLI's `codemap publish-docs` is the bulk backfill for a store that predates its sidecar; this is the ordinary act. The version is immutable and records the commit and branch it was written on, so a later reader can tell whether it describes their checkout.",
    inputSchema: obj({ version: { type: "object", description: "The doc version: `nodeId`, `type`, `title`, `summary`, `body`, `citations`." } }, ["version"]),
    mutates: true,
    handler: (a, c) => shared.shareDoc(c.universe.path, a.version),
  },
  // --- the standard -----------------------------------------------------------
  //
  // The reads are named individually, per the note above this table — except the six
  // QUEUES, which are collapsed behind `standard_queue`. That is not the tidy-up the note
  // warns against: an agent finds the queues through `standard_status`, whose RESULT names
  // them, and a result always reaches the caller where a deferred description may not. The
  // steering is not carried by those six names, so collapsing them costs nothing.
  {
    name: "standard_status",
    description: "The state of the standard — the binding business rules — and every queue over it. START HERE for anything about requirements. Reports how much of the standard is `conformant` / `gap` / `debt` / `unknown`, plus `regressed` (met once, no longer known to be). `unknown` means nobody has checked, and is never the same as fine. `settledWithoutAdjudication` counts business questions that got answered by somebody changing code — read that queue if it is nonzero.",
    inputSchema: obj({}),
    handler: (_a, c) => ops.standardStatus(c.universe.path),
  },
  {
    name: "standard_queue",
    description: "Open one of the queues `standard_status` counts. `pending_specs` — proposals awaiting a principal, with how many operations each carries, whether any is irreversible, and how many arrive already `silenced` by a gap. `awaiting_adjudication` — discrepancies nobody has decided; this is deliberately NOT a fix queue. `actionable` — problems already decided, i.e. work that is owed. `settled_without_adjudication` — the andon signal. `promotable_audits` — branch findings whose evidence still holds on the default branch. `acknowledgements_due` — silencers past their revalidate-by date.",
    inputSchema: obj({
      queue: {
        type: "string",
        enum: ["pending_specs", "awaiting_adjudication", "actionable", "settled_without_adjudication", "promotable_audits", "acknowledgements_due"],
      },
    }, ["queue"]),
    handler: (a, c) => {
      const p = c.universe.path;
      switch (a.queue) {
        case "pending_specs": return ops.pendingSpecs(p);
        case "awaiting_adjudication": return ops.awaitingAdjudication(p);
        case "actionable": return ops.actionableProblems(p);
        case "settled_without_adjudication": return ops.settledWithoutAdjudication(p);
        case "promotable_audits": return ops.promotableAudits(p);
        case "acknowledgements_due": return ops.dueForRevalidation(p);
        // Unreachable while the enum above is enforced, and named rather than defaulted so
        // that ADDING a queue and forgetting the case is an error instead of silently
        // serving a different queue. That list-drifts-from-the-handlers shape has bitten
        // this file twice before; see the note on `mutates`.
        default: return Promise.resolve({ error: `unknown queue "${String(a.queue)}"` });
      }
    },
  },
  {
    name: "requirements",
    description: "The standard itself: the binding rules, filed taxonomically. A requirement is UPSTREAM of the code — the code exists to satisfy it — so it never goes `stale` when code drifts, and there is no edit path on it. Filter by `section` or `status`. To see where the sections are, call `requirement_sections`.",
    inputSchema: obj({
      section: { type: "string", description: "Filter to one section path, e.g. \"Credit/Limits\"." },
      status: { type: "string", enum: ["ratified", "retired"] },
    }),
    handler: (a, c) => ops.listRequirements(c.universe.path, a),
  },
  {
    name: "requirement",
    description: "One rule, with the whole history of operations that introduced and amended it, and `recheckDue` when the code it cites has moved since it was ratified.",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    handler: (a, c) => ops.getRequirement(c.universe.path, a),
  },
  {
    name: "requirement_sections",
    description: "The standard's taxonomy — the section index a reader opens before any individual rule, with a count per section. These are the STANDARD's sections, not the shape of whatever spec introduced a rule; they are different axes.",
    inputSchema: obj({}),
    handler: (_a, c) => ops.requirementSections(c.universe.path),
  },
  {
    name: "conformance",
    description: "Per-requirement classification: `conformant` (checked, and it holds) / `gap` (no code that should conform exists yet — roadmap, not a defect) / `debt` (conforming code should exist and does not) / `unknown` (nobody has checked). `conformant` is reachable only through an audit that touched code, so nothing about merging or time passing ever produces it.",
    inputSchema: obj({ asOf: { type: "string", description: "ISO timestamp — classify as of then rather than now." } }),
    handler: (a, c) => ops.conformance(c.universe.path, a),
  },
  {
    name: "spec",
    description: "A proposal against the standard, rendered per operation as what the rule says now and what it would say — plus `adoptable`, which is false when any operation's context has moved since it was written. Read `silencedBy` before adopting: a gap acknowledgement raised against an operation binds the moment the spec is ratified, so the rule arrives classified `gap` rather than `unknown`. Approving the rule is not approving that classification.",
    inputSchema: obj({ specId: { type: "string" } }, ["specId"]),
    handler: (a, c) => ops.getSpec(c.universe.path, a),
  },
  {
    name: "audits",
    description: "Every audit recorded against one requirement, OLDEST first — the LAST row is the current word on the rule, which is the one `conformance` reads. Each is marked `superseded` when the code it examined has moved. A superseded audit is not wrong — it was true of what it read — it just no longer speaks about what is there now.",
    inputSchema: obj({ requirementId: { type: "string" } }, ["requirementId"]),
    handler: (a, c) => ops.auditsFor(c.universe.path, a),
  },
  {
    name: "criteria",
    description: "The acceptance criteria on one rule: what discharges it, what would REFUTE it (`falsifier`), how it gets discharged (`evidenceKind`), and the check that asserts it (`assertedBy`).\n\nThree derived fields carry the warning COD-18 attaches to this relation. `assertionMoved` — the check's own code has changed since ratification, so the DETECTOR moved, which is a different and stronger signal than the rule's subject moving. `vacuity` — whether anybody has established the check CAN fail (`unchecked` by default, and it must never be read as `demonstrated`); it reverts to `unchecked` when the assertion moves, because whatever was established was established about code that is no longer there. `unasserted` — no check at all.\n\nWhy it matters: citing an assertion makes a claim STRONGER — it converts \"nobody edited the cited code\" into \"green as of the last build\". Over a check that cannot fail, that is manufactured confidence with a mechanism attached.",
    inputSchema: obj({ requirementId: { type: "string" } }, ["requirementId"]),
    handler: (a, c) => ops.criteriaSummary(c.universe.path, a),
  },
  {
    name: "weak_assertions",
    description: "The criteria nobody can currently lean on, in five buckets kept apart because the remedy differs. `unchecked` — has a check, nobody has tried to break it. `vacuous` — somebody tried and it cannot fail. `wrongLayer` — it fails, but somewhere that cannot observe the violation (a Validate-only test on a handler bug is green paint). `unasserted` — no check at all, which is a rule waiting for one rather than a defect. `moved` — the assertion's code changed, so every verdict about it is about code that is gone.",
    inputSchema: obj({}),
    handler: (_a, c) => ops.weakAssertions(c.universe.path),
  },
  {
    name: "acknowledgements",
    description: "The silencers: records saying the rule stands, we know it is not met, do not raise it. `basis` is `gap` (nothing that should conform exists yet) or `debt` (it should and does not). One record kind for both, so there is exactly one thing to count when asking how much of the standard is currently silenced.",
    inputSchema: obj({
      requirementId: { type: "string" },
      state: { type: "string", enum: ["active", "released"] },
      asOf: { type: "string" },
    }),
    handler: (a, c) => ops.listAcknowledgements(c.universe.path, a),
  },
  {
    name: "problems",
    description: "Discrepancies between the standard and the code. Each carries the audit that established it and, once decided, its disposition. Closure is DERIVED from the named move actually happening, so a problem that has been adjudicated is not thereby closed.",
    inputSchema: obj({ requirementId: { type: "string" } }),
    handler: (a, c) => ops.listProblems(c.universe.path, a),
  },
  {
    name: "draft_spec",
    description: "Open a proposal against the standard. A spec is the only way the standard ever changes — a ratified rule has no edit path — so this is where a disagreement between code and rule goes when the rule is what should move. Add operations with `add_operation`, then a principal ratifies. The narrative is a reading aid and is never the thing signed.",
    inputSchema: obj({
      title: { type: "string" },
      narrative: { type: "string", description: "Background and argument. Explicitly NON-OPERATIVE: nothing here changes the standard." },
      model: { type: "string", description: "YOUR model id, e.g. \"claude-opus-5\". Never guess it." },
      harness: { type: "string" },
    }, ["title"]),
    mutates: true,
    handler: (a, c) => ops.draftSpec(c.universe.path, a as never),
  },
  {
    name: "add_operation",
    description: "Add one operation to a draft spec: `add_requirement`, `amend_statement`, `retire_requirement`, or `add_criterion`. Operations are the operative content — the before/after a reviewer reads is rendered FROM them. Amending replaces one statement rather than reprinting a section, so nothing unnamed by an operation is ever touched. `rationale` and `reversibility` are per operation, not per spec, so there is no free-floating prose to drift from what lands.",
    inputSchema: obj({
      specId: { type: "string" },
      kind: { type: "string", enum: ["add_requirement", "amend_statement", "retire_requirement", "add_criterion"] },
      rationale: { type: "string", description: "What provoked this operation." },
      reversibility: { type: "string", enum: ["reversible", "irreversible", "unknown"], description: "Whether SATISFYING this can be undone. Declared before ratification because it changes the decision, and because it makes the rule harder to amend later." },
      requirementId: { type: "string", description: "The rule being amended or retired." },
      title: { type: "string", description: "New requirements: the name a queue row is read by." },
      section: { type: "string", description: "New requirements: where it files in the standard, e.g. \"Settlement/Float\"." },
      statement: { type: "string", description: "The rule itself." },
      provenance: { type: "string", description: "Where the rule comes from — a contract term, an IATA standard, a credit policy, a customer demand, our own past choice." },
      cites: { type: "array", items: { type: "string" }, description: "Code the rule is about. MAY be empty: an uncited requirement is one the code does not satisfy yet, which is a well-formed record." },
      evidence: { type: "string", description: "For an amendment: what shows the base state you wrote this against." },
      criterion: { type: "string", description: "`add_criterion`: what must be true, concretely and verifiably." },
      falsifier: { type: "string", description: "`add_criterion`, REQUIRED: the observation that would show the criterion is NOT met. The part authors skip and the part that does the work — if you cannot write what would refute it, it is prose rather than a criterion, and finding that out now is the whole point of writing it at drafting time." },
      evidenceKind: { type: "string", enum: [...EVIDENCE_KINDS], description: "`add_criterion`: how it gets discharged. A closed list. An invariant — anything phrased always/never/every, and \"writes zero rows\" counts — wants `lint-test`, because a green suite at merge does not prove nobody reintroduces the thing next quarter. `attestation` is the last resort and weak by construction: reaching for it for anything that can be rendered, captured or run is skipping the evidence rather than choosing a type." },
      assertedBy: { type: "array", items: { type: "string" }, description: "`add_criterion`: anchors of the CHECK — the test or lint that would fail if the rule stopped holding. Distinct from `cites`, which is the code the rule is ABOUT: `cites` going stale means the code moved, this going stale means the DETECTOR moved. MAY be empty — a criterion is written before the code exists." },
      targetOperationId: { type: "string", description: "`add_criterion` attaching to a rule THIS SAME SPEC creates: the `add_requirement` operation, since the rule has no id until ratification. Use instead of `requirementId`." },
      model: { type: "string", description: "YOUR model id. Never guess it." },
      harness: { type: "string" },
    }, ["specId", "kind", "rationale", "reversibility"]),
    mutates: true,
    handler: (a, c) => ops.addOperation(c.universe.path, a as never),
  },
  {
    name: "record_vacuity_check",
    description: "Record that you tried to make a criterion's assertion FAIL, and what happened. Open to any actor — verifying a check is exactly what an auditor agent is for, and the gate is what was DONE, not who did it.\n\n`demonstrated` needs a `method`: what you broke and what went red. It is the silencing direction — it makes the check trustworthy enough for an audit to lean on — so a demonstration recording nothing is the vacuous claim wearing the shape of evidence. `vacuous` and `wrong-layer` WEAKEN a criterion and need no method: their failure mode is noise, and gating what unsilences is the wrong asymmetry.\n\nThere is no way to record `unchecked`. That is the absence of a check, not a finding — and writing one would let an actor clear a real verdict by asserting ignorance. What does return a criterion to `unchecked` is the assertion moving, which supersedes every verdict about it.",
    inputSchema: obj({
      criterionId: { type: "string" },
      verdict: { type: "string", enum: ["demonstrated", "vacuous", "wrong-layer"] },
      method: { type: "string", description: "REQUIRED for `demonstrated`: the mutation you made and what the assertion did in response." },
      model: { type: "string", description: "YOUR model id. Never guess it." },
      harness: { type: "string" },
    }, ["criterionId", "verdict"]),
    mutates: true,
    handler: (a, c) => ops.recordVacuityCheck(c.universe.path, a as never),
  },
  {
    name: "ratify_spec",
    description: "Adopt a draft spec: apply every operation to the standard, all or nothing. Each operation is re-checked against the state it was written against, and the whole spec refuses if any of them has moved — a reviewer who approved a rendering built from the standard as of sign-off did not approve the result of applying it to a standard something else has since changed.",
    inputSchema: obj({
      specId: { type: "string" },
      model: { type: "string", description: "YOUR model id. Never guess it." },
      harness: { type: "string" },
    }, ["specId"]),
    mutates: true,
    handler: (a, c) => ops.ratifySpec(c.universe.path, a as never),
  },
  {
    name: "refile_requirement",
    description: "Change a rule's title or the section it files under, leaving the statement alone. This is filing, not amendment — amendment goes through a spec.",
    inputSchema: obj({
      id: { type: "string" },
      title: { type: "string" },
      section: { type: "string" },
      model: { type: "string", description: "YOUR model id. Never guess it." },
      harness: { type: "string" },
    }, ["id"]),
    mutates: true,
    handler: (a, c) => ops.reorganizeRequirement(c.universe.path, a as never),
  },
  {
    name: "record_audit",
    description: "Record that a rule was checked against the code. `evidence` is what you ACTUALLY read and ran — it is the audit's substance, not paperwork, because a positive audit closes a gap and silences the mechanism that would have caught the thing. Doc-only evidence is recorded but is weaker on purpose: auditing a document against a rule inherits the document's errors, and that failure is silent. Use `indeterminate` for \"I could not verify this\" — that is an unverified rule, not a violation.",
    inputSchema: obj({
      requirementId: { type: "string" },
      outcome: { type: "string", enum: ["conformant", "nonconformant", "indeterminate"] },
      finding: { type: "string", description: "What you concluded, in your own words." },
      evidence: {
        type: "object",
        description: "What you actually did.",
        properties: {
          read: { type: "array", items: { type: "string" }, description: "Anchors whose source you read." },
          ran: { type: "array", items: { type: "object" }, description: "Commands you executed: `{command, passed}`." },
          consulted: { type: "array", items: { type: "string" }, description: "Documentation you read. Weaker than the other two." },
        },
      },
      model: { type: "string", description: "YOUR model id. Never guess it." },
      harness: { type: "string" },
    }, ["requirementId", "outcome", "finding"]),
    mutates: true,
    handler: (a, c) => ops.recordAudit(c.universe.path, a as never),
  },
  {
    name: "promote_audit",
    description: "Put a provisional audit — one taken off the default branch — in front of the team. Decided on WITNESSES: whether the exact source it examined is still verbatim present. Never on commit ancestry, because a commit being in history does not mean the code is still that way. Re-records the finding as a fresh observation rather than rewriting the branch audit to claim it was something else.",
    inputSchema: obj({
      auditId: { type: "string" },
      model: { type: "string", description: "YOUR model id. Never guess it." },
      harness: { type: "string" },
    }, ["auditId"]),
    mutates: true,
    handler: (a, c) => ops.promoteProvisionalAudit(c.universe.path, a as never),
  },
  {
    name: "raise_problem",
    description: "File a discrepancy: the standard and the code disagree. Takes the AUDIT that established it rather than prose, so a problem cannot rest on a suspicion. Raising is what an auditor is for; it says nothing about which side should move.",
    inputSchema: obj({
      auditId: { type: "string", description: "The non-conformant audit this rests on." },
      summary: { type: "string", description: "The disagreement, stated plainly." },
      prior: { type: "string", description: "A pointer that raised this in the queue, if one did. Never a verdict." },
      model: { type: "string", description: "YOUR model id. Never guess it." },
      harness: { type: "string" },
    }, ["auditId", "summary"]),
    mutates: true,
    handler: (a, c) => ops.raiseProblem(c.universe.path, a as never),
  },
  {
    name: "adjudicate_problem",
    description: "Decide which side moves. `code-wrong` — the rule stands and the code violates it. `requirement-changed` — the business moved. `requirement-misstated` — the rule did not change, our statement of it was incomplete. `accepted` — non-conformant and we are living with it. Adjudication is NOT closure: naming the move does not make it, and the problem stays open until the named move actually happens.",
    inputSchema: obj({
      problemId: { type: "string" },
      disposition: { type: "string", enum: ["code-wrong", "requirement-changed", "requirement-misstated", "accepted"] },
      reason: { type: "string" },
      model: { type: "string", description: "YOUR model id. Never guess it." },
      harness: { type: "string" },
    }, ["problemId", "disposition", "reason"]),
    mutates: true,
    handler: (a, c) => ops.adjudicate(c.universe.path, a as never),
  },
  {
    name: "acknowledge_gap",
    description: "Record that a rule has no code that should conform to it yet — roadmap work, not a defect. Minted against an `add_requirement` operation on a spec that is still a draft, so holes are poked while the rule is a proposal. Saying \"no code should conform to this yet\" is only decidable against a population you can enumerate; without one it means \"I looked and did not find any\", which is a different claim.",
    inputSchema: obj({
      operationId: { type: "string", description: "The `add_requirement` operation this gaps." },
      rationale: { type: "string" },
      priority: { type: "string", enum: ["high", "medium", "low"] },
      revalidateBy: { type: "string", description: "ISO date this must be looked at again. A linked work item is evidence, never the release condition." },
      workItem: { type: "string", description: "A ticket, as evidence. It does not close this." },
      model: { type: "string", description: "YOUR model id. Never guess it." },
      harness: { type: "string" },
    }, ["operationId", "rationale", "priority", "revalidateBy"]),
    mutates: true,
    handler: (a, c) => ops.acknowledgeGap(c.universe.path, a as never),
  },
  {
    name: "acknowledge_debt",
    description: "Record that conforming code should exist, does not, and we are living with it — at the cost of a waiver. Post-hoc, unlike a gap. Carries a priority and a revalidate-by DATE, because a release condition living in a system nothing guarantees becomes unreachable and silences the audit permanently.",
    inputSchema: obj({
      requirementId: { type: "string" },
      rationale: { type: "string" },
      priority: { type: "string", enum: ["high", "medium", "low"] },
      revalidateBy: { type: "string", description: "ISO date this must be looked at again." },
      workItem: { type: "string", description: "A ticket, as evidence. It does not close this." },
      model: { type: "string", description: "YOUR model id. Never guess it." },
      harness: { type: "string" },
    }, ["requirementId", "rationale", "priority", "revalidateBy"]),
    mutates: true,
    handler: (a, c) => ops.acknowledgeDebt(c.universe.path, a as never),
  },
  {
    name: "release_acknowledgement",
    description: "Lift a silencer, so the rule is audited again. Open to any actor: gating what UNSILENCES would be backwards — granting is the act that needs authority.",
    inputSchema: obj({
      id: { type: "string" },
      reason: { type: "string" },
      model: { type: "string", description: "YOUR model id. Never guess it." },
      harness: { type: "string" },
    }, ["id", "reason"]),
    mutates: true,
    handler: (a, c) => ops.releaseAcknowledgement(c.universe.path, a as never),
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
      // Loud on connect, because the thing it warns against — a full reindex —
      // is a reasonable-looking next step that would flood the store with false
      // staleness, and nothing else would have told anyone.
      if (r?.derivationDrift) {
        process.stderr.write(`codemap-mcp: WARNING [${u.id}]: ${r.derivationDrift.note}\n`);
      }
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
      // Who is on the other end, as the transport saw it — the host sends this
      // before the model has any say, so it is the one piece of agent identity a
      // model cannot spell for itself. Everything else about `via` is self-report.
      markObservedClient(params?.clientInfo?.name);
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
      const bad = violates(tool.inputSchema, args);
      if (bad) {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${bad}` }], isError: true } });
        return;
      }
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
// Everything below this line is being driven by an agent, not a person — so the
// ratchet in the shared store applies. See `markAgentSession`.
markAgentSession();

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
