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

// Tools that write to a universe's .codemap/ — held under the write lock so a
// concurrent CLI run or second agent can't clobber a read-modify-write.
const MUTATING = new Set(["document", "connect", "update_node", "cover", "report_bug", "update_bug", "annotate", "link", "check_stale", "analyze", "review", "snapshot", "reindex"]);

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
    name: "status",
    description: "Overview of one universe: anchor/doc/edge/bug counts and how many anchors are undocumented.",
    inputSchema: obj({}),
    handler: (_a, c) => ops.status(c.universe.path),
  },
  {
    name: "outline",
    description: "Drill down the structural tree (derived from anchor paths) one level at a time, with anchor counts, documentation coverage %, and node/bug rollups per child. Omit prefix for the repo root; pass a dir prefix to expand it, or a file path to list its symbols. The way to understand a large codebase top-down.",
    inputSchema: obj({ prefix: { type: "string", description: "Directory or file prefix to expand (default: repo root)." } }),
    handler: (a, c) => ops.outline(c.universe.path, a.prefix ?? ""),
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
    handler: (a, c) => ops.cover(c.universe.path, a),
  },
  {
    name: "check_stale",
    description: "Staleness pass for a universe: which anchors changed/vanished since baseline and which docs they flag. Also auto re-inits the anchor index if the checked-out branch changed since it was baselined (a branch switch = different code) — the result then includes `rebaselined`.",
    inputSchema: obj({}),
    handler: (_a, c) => ops.checkStale(c.universe.path),
  },
  {
    name: "reindex",
    description: "Force a full re-baseline: re-index the whole repo at the CURRENT HEAD and replace the live anchor index, advancing the baseline commit/branch. Use when the index is pinned to an old commit and newly-added files/symbols aren't resolving (e.g. a subsystem added after the last init). NON-DESTRUCTIVE to the map — nodes, edges, reviews, coverage, bugs, and annotations are untouched; only anchors + baseline move (and the commit is cached as a diff snapshot). `check_stale` does this automatically on a branch change; call `reindex` to refresh same-branch drift on demand.",
    inputSchema: obj({}),
    handler: (_a, c) => ops.reindex(c.universe.path),
  },
  {
    name: "snapshot",
    description: "Cache the current commit's anchors as an immutable snapshot (a fresh full index), so this branch can be diffed later WITHOUT checking it out again. Run it on a branch before switching away. `init` snapshots automatically; use this to (re)cache the current commit on demand.",
    inputSchema: obj({}),
    handler: (_a, c) => ops.snapshot(c.universe.path),
  },
  {
    name: "snapshots",
    description: "List the cached commit snapshots available to diff (ref sha, branch, when captured, anchor count).",
    inputSchema: obj({}),
    handler: (_a, c) => ops.snapshots(c.universe.path),
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
    handler: async (a, c) => {
      const r = await analyzeMarten(c.universe.path, { verbose: Boolean(a.verbose) });
      if (!a.emit) return r;
      const e = await enableAnalyzer(c.universe.path, a.analyzer);
      return e.error ? { ...r, emitError: e.error } : { ...r, enabled: true, emitted: e.emitted };
    },
  },
  {
    name: "search",
    description: "Search anchors and nodes for a substring. Set allUniverses:true to search every universe (useful to find a link target in another project).",
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
    description: "Read an anchor with its CURRENT source code (live), citing nodes, related bugs, annotations, and review state. Use before documenting or filing a bug.",
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
    name: "flow",
    description: "One flow: its ordered steps, each with touched modules and the live source of its anchors, plus per-step review state. For stepping through a process and reviewing the code.",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
    handler: (a, c) => ops.flow(c.universe.path, a.id),
  },
  {
    name: "review",
    description: "Mark (or unmark: unmark:true) a node or anchor as reviewed. level 'logical' = the doc is accurate; 'code' = the source was read. Staleness-aware: a review goes stale when the reviewed code changes.",
    inputSchema: obj({
      targetKind: { type: "string", enum: ["node", "anchor"] },
      targetId: { type: "string" },
      level: { type: "string", enum: ["logical", "code"] },
      unmark: { type: "boolean" },
      reviewer: { type: "string" },
    }, ["targetKind", "targetId", "level"]),
    handler: (a, c) => (a.unmark ? unmarkReviewed(c.universe.path, a) : markReviewed(c.universe.path, a)),
  },
  {
    name: "document",
    description: "Create/update a logical node (module|process|step) in a universe. Must cite ≥1 anchor — floating claims are rejected. Set `id` to control the slug you'll [[link]] to.",
    inputSchema: obj({
      id: { type: "string" },
      type: { type: "string", enum: ["module", "process", "step"] },
      title: { type: "string" },
      summary: { type: "string" },
      anchors: { type: "array", items: { type: "string" }, description: "Anchors by `file#Symbol`, `file:line`, or raw id — resolved server-side." },
      body: { type: "string" },
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
    handler: (a, c) => ops.document(c.universe.path, a),
  },
  {
    name: "connect",
    description: "Add one edge or many (same-universe: part_of/depends_on/step_of/touches). Pass from/to/type for one, or edges:[…] for a batch. For cross-universe API boundaries use `link`.",
    inputSchema: obj({
      from: { type: "string" },
      to: { type: "string" },
      type: { type: "string", enum: ["part_of", "depends_on", "step_of", "touches"] },
      order: { type: "number" },
      edges: {
        type: "array",
        items: {
          type: "object",
          properties: {
            from: { type: "string" },
            to: { type: "string" },
            type: { type: "string", enum: ["part_of", "depends_on", "step_of", "touches"] },
            order: { type: "number" },
          },
          required: ["from", "to", "type"],
          additionalProperties: false,
        },
      },
    }),
    handler: (a, c) => ops.connect(c.universe.path, a),
  },
  {
    name: "update_node",
    description: "Patch a node in place without resending its whole body: change title/summary/body and/or add/remove anchors (by file#Symbol or id). A node must keep ≥1 anchor.",
    inputSchema: obj({
      id: { type: "string" },
      setTitle: { type: "string" },
      setSummary: { type: "string" },
      setBody: { type: "string" },
      addAnchors: { type: "array", items: { type: "string" } },
      removeAnchors: { type: "array", items: { type: "string" } },
    }, ["id"]),
    handler: (a, c) => ops.updateNode(c.universe.path, a),
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
    handler: (a, c) => multi.link(ws, { fromUniverse: c.universe.id, from: a.from, toUniverse: a.toUniverse, to: a.to, type: a.type, order: a.order }),
  },
  {
    name: "report_bug",
    description: "File a bug anchored to exact code in a universe. Captures a witness hash so it auto-flags possiblyFixed when that code changes.",
    inputSchema: obj({
      title: { type: "string" },
      description: { type: "string" },
      anchors: { type: "array", items: { type: "string" }, description: "Anchors by `file#Symbol`, `file:line`, or raw id." },
      severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
    }, ["title", "description", "anchors"]),
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
    handler: (a, c) => ops.updateBug(c.universe.path, a),
  },
  {
    name: "annotate",
    description: "Attach a note to an anchor or node in a universe, visible to agents and human readers.",
    inputSchema: obj({
      targetKind: { type: "string", enum: ["anchor", "node"] },
      targetId: { type: "string" },
      text: { type: "string" },
      author: { type: "string" },
    }, ["targetKind", "targetId", "text"]),
    handler: (a, c) => ops.annotate(c.universe.path, a),
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
        const out = MUTATING.has(tool.name) ? await withLock(universe.path, run) : await run();
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
