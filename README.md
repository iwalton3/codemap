# codemap

A codebase-agnostic **semantic map** that anchors documented claims to hashed
code, so documentation staleness becomes *visible* instead of silent.

Two views over one graph:

- **Structure map** — modules, their responsibilities, and what depends on what.
- **Process map** — named flows (checkout, sync, …) stepped through the code
  that executes them.

They are unified by a single `touches` edge (step → module), so a code change
can flag every process that runs through it, and vice versa.

Consumed by **both** a human (web app, later) and **AI agents** (a token-cheap
map file read instead of a fresh codebase exploration each session), from the
same `.codemap/` data.

## Status

Building **v1: the anchor + staleness engine** (the code-index phase). Process
maps, the web frontend, and the AI-documentation loop come in later phases.

Done:

- [x] Project scaffold + dependency budget
- [x] Data model (`src/schema.ts`) — the `.codemap/` format
- [x] Normalizer / hasher (`src/normalize.ts`) — the false-staleness guard

- [x] Vendored tree-sitter grammars (C#, Python, JS, TS) + loader (`src/grammars.ts`)
- [x] Indexer — callables + type shells, per language (`src/indexer.ts`)
- [x] Anchor store + `init` (`src/store.ts`, `src/cli.ts`)
- [x] Staleness checker, `git diff`-driven + `check` (`src/stale.ts`)
- [x] Change → logical-node routing (flagged docs)

**v1 engine complete** — validated end-to-end on real code (Python, C#, JS):
a body edit flags `candidate_stale`, a rename flags `lost`, a signature change
ripples to the type shell, a changed call site flags the caller, and the logical
node citing any of them is surfaced — with zero false positives on unchanged code.

**AI-documentation loop (MCP) complete** — a zero-dependency MCP server
(`src/mcp.ts`, newline-delimited JSON-RPC 2.0 over stdio) exposes tools over an
`ops` layer (`src/ops.ts`): `list_universes`, `status`, `outline` (top-down
drill with coverage rollups), `find_gaps`, `check_stale`, `search`, `get_node`,
`get_anchor` (live code), `document`, `connect`, `link` (cross-universe),
`report_bug`, `list_bugs`, `update_bug`, `annotate`. Bugs anchor to code and
store a witness hash, so they auto-flag `possiblyFixed` when that code changes —
the same mechanism as doc staleness, and it correctly ignores comment/whitespace
edits.

### Connecting to Claude Code

Single repo:

```sh
node /home/izzie/Desktop/codemap/dist/cli.js init /path/to/repo
claude mcp add codemap -- node /home/izzie/Desktop/codemap/dist/mcp.js /path/to/repo
```

Multiple repos (a "workspace" of universes, linked at API boundaries). Each
universe keeps its own `.codemap/`; the MCP server serves them together and
per-universe tools take an optional `universe` (default = primary). Cross-universe
links (`calls_api`) are stored in the *consumer's* graph with a qualified target
(`api::handler`); a hub universe's inbound links are derived by scanning.

```jsonc
// codemap.workspace.json (paths resolve relative to this file)
{ "universes": [
  { "id": "api",        "path": "Acme.API",        "primary": true },
  { "id": "settlement", "path": "Acme.Settlement" }
] }
```

```sh
node dist/cli.js init /working/Acme.API && node dist/cli.js init /working/Acme.Settlement
claude mcp add codemap -- node /home/izzie/Desktop/codemap/dist/mcp.js /working/codemap.workspace.json
```

**Multi-universe workspaces complete** — one MCP server serves several repos
(`src/workspace.ts`, `src/multi.ts`); `list_universes` + `link` join them across
API boundaries with qualified `universe::id` refs, and `get_node` resolves
outbound cross-links and shows inbound ones on a hub universe. `.codemapignore`
(`src/ignore.ts`, gitignore-style) excludes vendored/generated code per repo.

**Web UI (first sketch) working** — `codemap serve <workspace>` (`src/serve.ts`,
zero-dep `node:http`) serves a JSON API mirroring ops/multi plus a vendored
vdx-web SPA (`web/`). The outline browser drills domains → files → symbols → live
code with coverage-% bars and a universe switcher; reads the same `.codemap/`
data the MCP server writes, so agent documentation shows up live. Verified
rendering headless (puppeteer). Run: \`node dist/serve.js /working/codemap.workspace.json\`
then open http://localhost:4310.

Web UI now uses the **vdx router** (`web/vendor/vdx/router.js`) with page
components (`outline-page`, `anchor-page`, `node-page`, `search-page`) and a
**markdown-rendered node detail view** (marked, `web/vendor/marked.min.js`, via
the `md-content` component). Node summaries/bodies/annotations render as markdown.
Note: the router mis-binds a multi-segment `:path*` wildcard when it follows a
named param, so the tree prefix rides in a `?p=` query param instead.

**Coverage is a state, not a binary** (`src/coverage.ts`) — per-anchor `open` /
`cited` / `covered` / `trivial` / `deferred` / `owned`, derived from citation +
stored selector rules (`.codemap/coverage.json`). The `cover` op marks anchors
by selector (pathPrefix/file/kind/symbol-glob), stored & re-applied so new members
inherit state. `find_gaps`/`outline`/`status` report the honest breakdown — on
Acme.Settlement this turned a misleading "4% documented / 1170 open" into "52% /
351 open". Write ops accept anchors by `file#Symbol` / `file:line` (`src/refs.ts`),
resolved server-side with candidate lists on ambiguity.

Agent-throughput items shipped: **P1.2** inline `steps[]` on a process (one
`document` call materializes step nodes + `step_of` + `touches`), **P1.3** bulk
`connect(edges:[…])` + `update_node` patch (change fields / add-remove anchors
without resending the body), **P1.4** `[[link]]` validation on write + a `links`
danglers report. MCP now exposes 19 tools.

**Opt-in Marten/Wolverine analyzer (consistency checks)** — `codemap analyze
marten <repo>` and an MCP `analyze` tool (`src/analyzers/marten.ts`). NOT part of
core; its own tree-sitter C# pass extracts folds (`Apply`/`Create(Event)`),
projections (`Transform(IEvent<T>)`), emissions (`new EventT` into
`Events.Append/StartStream`), commands (`I…Command` records), and handlers
(`Handle`/`Consume`/`[Wolverine*]` endpoints). Checks: `command-no-handler`,
`appended-orphan` (event nothing folds/projects/consumes), and verbose
read-model-gap info. On Acme.API it found **4 genuine unwired commands** (verified:
Subscription line-items defined but with no handler, unlike Plan's) with 1
disclosed FP (GET query-bound command); settlement is clean.

**Marten event-graph emission** (`src/analyzers/marten-emit.ts`, `analyze marten
--emit` / MCP `analyze emit:true`) — writes `event_family`/`aggregate`/`projection`
nodes + `folds`/`projects` edges, mapping the model's locations to anchors. Node/
edge types are now open (`(string & {})`) so analyzers extend the vocabulary
without core changes. All tagged `generatedBy: "marten"`: a re-run clears+rewrites
generated content while human-authored nodes/annotations survive (verified). On
settlement: 50 event nodes + 2 aggregates + 1 projection + 100 edges; the browser
shows each event as one wiring unit (record + Apply + Transform anchors, folds/
projects chips).

The event graph now includes **command + handler nodes** with `handles` (handler→
command) and `emits` (handler→event) edges — the full `command ←handles← handler
→emits→ event →folds→ aggregate →projects→ projection` chain is navigable. Emission
indexes current code (not the stored snapshot) so it reflects reality.

**Analyzer coverage / auto-refresh** (`src/analyzers/run.js`, `.codemap/analyzers.json`)
— `analyze marten --emit` (or MCP `analyze emit:true`) also *registers* the analyzer;
thereafter `check` / `check_stale` re-emit the graph whenever code changed (commit
advanced or staleness detected). Enable once; no manual re-emit. Verified: adding a
new command then `check` auto-created its node.

**Incremental index update on `check`** (`src/sync.ts`) — `check`/`check_stale` now
add newly-appeared anchors and refresh moved locations in the store, so new code
resolves without a full re-init. Conservative: never re-hashes an existing anchor
(preserves the candidate_stale signal) or removes a vanished one (preserves `lost`).

**Re-baseline: `reindex` + branch-aware `check`** (`ops.reindex`, MCP `reindex`) — a
full re-index at the current HEAD that replaces the live anchor set and advances the
baseline commit/branch. Non-destructive: nodes, edges, reviews, coverage, bugs, and
annotations are untouched — only anchors + baseline move (`init` shares this path).
`State` records the branch it was baselined on, and `check_stale` (CLI `check` too)
**auto-reindexes when the checked-out branch changed** — a branch switch means
different code, so the index follows it. The MCP server also runs `check_stale`
across every universe **on connect** (background, under the lock), so an agent starts
against a fresh, correctly-branched index without having to remember to sync.

**Graph viewer** (web `graph-page`, `/api/neighborhood`) — a clickable SVG ego-graph
of a node's immediate neighborhood, color-coded by type with direction+type edge
labels; click a neighbor to re-center. Reached via the ◆ graph link on a node.
Built as data-driven SVG straight from the template with `each()`. (Routing uses the
`:path*` wildcard again, and the graph builds SVG from templates — the two vdx bugs
this hit were fixed upstream and re-vendored; see BUG-REPORT-from-codemap.RESPONSE.md.)

**SQLite storage — out of git, no merge conflicts** (`src/db.ts`) — the store is a
per-universe **`node:sqlite`** DB at `.codemap/codemap.db` (stdlib, zero new deps),
gitignored so it never pollutes a branch/PR diff and a branch switch never drags a
stale map into your working tree. `src/store.ts` keeps the exact same async API, so
the whole app is unchanged above the storage seam. On first open of a pre-SQLite
JSON `.codemap/`, the DB **auto-imports it** (anchors, human + generated nodes,
edges, state, reviews, coverage) so no existing map is lost — guarded so it never
re-imports; the old JSON files are left in place as a backup. This is Phase 1 of
git-awareness; Phase 2 (below) caches anchor snapshots per commit for branch-diff.

**Branch/PR diff — a logical set-op over anchor snapshots** (`src/diff.ts`) — the
git-awareness payoff. `init` (and the `snapshot` op/CLI/MCP tool) cache the current
commit's anchors as an immutable, sha-keyed snapshot in the DB — a commit maps to a
cached index, and old-branch data is never lost. `codemap diff <base> [head]` (MCP
`diff`, `ops.diff`) then compares two snapshots by anchor **id** (added / removed
symbols) and **bodyHash** (changed bodies), and rolls the impact up to the **nodes,
flows, and reviews** that cite the affected anchors — "this PR changes `transfer`,
deletes `refund`, and would stale the Money-transfer flow + its review." `base` is a
cached snapshot; omit `head` to diff against a fresh index of the **current working
tree** (the PR-review path — you've checked out the branch under review, so nothing
else is checked out or contaminated), or pass a second cached ref for a pure
historical set-op with no re-indexing. Because the store is out of git, reviewing
another branch never leaks its map into yours.

**Diff viewer (web)** — a review-focused diff surface at `/#/u/:u/diff/` (`diff-page`,
`/api/diff` + `/api/diff/code`, `/api/snapshots`). A base/head picker (base = any
cached snapshot; head = working tree or another snapshot) drives three panes:
**flows changed** (each impacted flow with its affected steps), **structural changes**
(added/removed/changed symbols grouped by file, `+`/`−`/`~` colour-coded), and a
**drill-down** — click a symbol to see its before/after **code diff** (LCS line diff,
syntax-highlighted, `git show` for the base side so no checkout is needed) alongside
the **docs it may stale** (the citing nodes, linked). The base/head selection lives in
the URL query, so a diff view is shareable.

**Write safety** — the CLI, the MCP server, and multiple agents can all write a
universe's store. SQLite's WAL mode gives concurrent readers + serialized writers
(cross-process) out of the box, so writers can't clobber each other. A
cross-process file lock (`src/lock.ts`, `.codemap/.lock`) is kept as a redundant
outer layer around mutating MCP tools and CLI commands; stale/dead-owner locks are
stolen (pid + timestamp), so a crash never wedges the map.

**Code-review UI** — a review-focused surface over the same map:
- **Flows overview** (`/u/:u/flows`, `flows` op/MCP tool) — every flow (process node)
  with step counts and per-flow / per-step review progress.
- **Flow-walker** (`/u/:u/flow/:id`, `flow` op) — a flow's ordered steps, each with
  its summary, touched modules, and the **syntax-highlighted live source** (vendored
  highlight.js) of the responsible anchors.
- **Human review, staleness-aware** (`src/reviews.ts`, `.codemap/reviews.json`, `review`
  op/MCP tool + POST `/api/review`): mark a flow/step/anchor `logical` (doc is accurate)
  or `code` (source read). Captures witness hashes like bugs — a review goes **stale**
  when the reviewed code changes, so a green check never lies. Review state shows in
  get_node/get_anchor too. The UI's first write path — goes through the write lock.

**Node catalog** (`/#/u/:u/nodes/`, `node-catalog-page`, `/api/nodes`, MCP `nodes`,
`ops.nodeCatalog`) — the node-first surface that complements flows and the file
outline: every logical node with its type, domain (derived from its anchors'
namespace), edge degree (in/out), provenance (`generatedBy`), and review state.
Filter by type / domain / source (human vs analyzer) / review state, group by type
or domain, and **mark any node reviewed inline** (logical/code, same witness-hashed
review as the flow-walker). Built to browse and review a large graph systematically —
e.g. settlement's 220 nodes (66 commands, 66 handlers, 50 event families, …).

**Event wiring matrix** (`/#/u/:u/matrix/`, `matrix-page`, `/api/matrix`, MCP
`event_matrix`, `ops.eventMatrix`) — the audit view for an event-sourced graph:
events as rows, the aggregates/projections they feed as columns (green = folds into
an aggregate, blue = projects to a read-model), plus per-event emitter count and
inline review. A high-degree sink (a projection that consumes every event) becomes
one dense column instead of a 50-spoke wheel, and an **orphan** event (folded /
projected by nothing) is a red-highlighted blank row. On settlement: 50 events × 2
aggregates + 1 projection, 0 orphans.

**Layered event-pipeline graph** (`/#/u/:u/pipeline/`, `pipeline-page`,
`/api/pipeline`, MCP `pipeline_graph`, `ops.pipelineGraph`) — the whole-application
graph view: the chain `command → handler → event → aggregate → projection` laid out
left-to-right, one column per role, nodes ordered within columns by barycenter (a
couple of Sugiyama sweeps) to cut edge crossings. Pan/zoom, a domain filter to focus
one subsystem, and **hover a node to trace its wiring** (dims everything except the
node and its neighbors). This is where the radial ego-graph's crowding is answered —
settlement's 185 nodes / 221 edges read as five aligned columns instead of a hairball.

**Review heatmap on the outline** — each dir/file row carries a two-track review
bar (top: logical, bottom: code; green reviewed / amber stale) rolled up over its
in-scope anchors, and each file symbol shows logical/code review dots. Staleness is
judged against LIVE hashes but only the files that contain reviewed anchors are
re-indexed (reviews are few), so it's correct and cheap on the browse path.

Later phases:

- [ ] Marten: auto-generate coverage rules for Apply/Transform overloads
- [ ] Graph viewer: better layout for high-degree hubs; bug list view; distinguish the coverage bar hue from the review heat
- [ ] Fuzzy re-anchoring recovery (v1 only flags \`lost\`)
- [ ] Process maps: convenience flow-authoring on top of document/connect
- [ ] Optional API-boundary auto-detection (route ↔ fetch matching)

## Dependency budget (enforced)

Supply-chain rot is the primary risk this project is designed against. The
runtime dependency footprint is deliberately tiny and **grammars are vendored as
inert `.wasm` blobs**, not fetched or compiled — there is no build toolchain to
break years later.

| Need | Source |
| --- | --- |
| Parsing | `web-tree-sitter` (1 pkg) + 4 **vendored** `.wasm` grammars |
| Hashing | `node:crypto` (stdlib) |
| Git diff | `node:child_process` → `git` (stdlib) |
| Storage | `node:sqlite` (stdlib, experimental in Node 23) |
| FS / paths | `node:fs`, `node:path` (stdlib) |
| CLI args | `node:util` `parseArgs` (stdlib) |
| Tests | `node:test` (stdlib) |
| TypeScript | dev-only, compiled away |

Runtime footprint target: **one package + four vendored files.** Adding any new
runtime dependency is a discussed decision, not a reflex.

## Development

```sh
npm test        # tsc build + node --test
npm run build   # emit dist/
```

Guinea-pig repos for validation: `cl-pprint` (primary; py+js, git),
`FakeBankSimulator` (C# hard cases), `mrepo-web` (scale, gitless).
