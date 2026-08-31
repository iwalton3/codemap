# codemap

> **Kind: current reference** — describes how codemap works today. Trust it; fix it if it is wrong.
> the project front door: what codemap is, the CLI, the MCP tools, and the agent setup.

A codebase-agnostic **semantic map** that anchors documented claims to hashed
code, so a claim going out of date becomes *visible* instead of silent.

Everything rests on one primitive: an **anchor** — a symbol, identified by a
deterministic id derived from its path rather than its body, carrying a
normalized hash of that body. A doc, a bug, a review, a requirement's detector
and a pinned lint all cite anchors, so all of them can be told when the code
underneath them moved. A green check that would otherwise quietly lie instead
goes `stale`.

## What it is for

The north star is making review of a **large change** meaningful rather than a
rubber stamp. Event sourcing is the worst case: one behavior is scattered across
`command → handler → event → aggregate → projection`, so a file diff hides what
actually changed about the system. codemap's job is to supply the context a raw
diff cannot and a way to work through it deliberately —

- **branch diff** that rolls each changed symbol up to the flows, docs, reviews
  and rules it affects, not a list of hunks;
- **flow-walker**, **node catalog**, **event matrix** and **pipeline graph** for
  the wiring a diff can't show;
- **witness-hashed review marks**, so "reviewed" expires when the code does;
- a **standard** of requirements with detectors attached, so a rule can be
  audited on evidence instead of recollection.

Two views over one graph — a **structure map** (modules, responsibilities,
dependencies) and a **process map** (named flows stepped through the code that
runs them) — unified by a `touches` edge, so a code change flags every process
running through it and vice versa. Maps C#/.NET, Python and JS/TS.

Consumed by **both** a human (web app) and **AI agents** (MCP), from the same
`.codemap/` store. Three front-ends, one store, no privileged one.

## Getting started (one repo)

Requires **Node ≥ 23.4** (the store uses `node:sqlite`). One runtime dependency
(`web-tree-sitter`); the grammars are vendored, so there is nothing else to fetch.

```sh
git clone <this repo> ~/codemap && cd ~/codemap
npm install && npm run build
```

**1. Index the repo you want to map.** This builds the anchor index — every
symbol, hashed — and caches the current commit so you can diff against it later.

```sh
node ~/codemap/dist/cli.js init /path/to/your-repo
```

The map lives in `/path/to/your-repo/.codemap/codemap.db`, which is gitignored
for you: it never shows up in a branch or PR diff, and a checkout never drags a
stale map in.

**2. Give an agent the map.** One server, one repo — every per-universe tool
just defaults to it, so nothing needs a `universe` argument:

```sh
claude mcp add codemap -- node ~/codemap/dist/mcp.js /path/to/your-repo
```

Skipped step 1? The agent will be told the universe isn't initialized and can
run the `init` tool itself — it doesn't need you at a terminal.

**3. Read it yourself.** The web UI serves the same store the agent writes to,
so documentation appears live:

```sh
node ~/codemap/dist/serve.js /path/to/your-repo   # http://localhost:4310 (pass a port to change)
```

**Then, as the code moves:**

```sh
node ~/codemap/dist/cli.js check    /path/to/your-repo   # what drifted, and which docs it flags
node ~/codemap/dist/cli.js snapshot /path/to/your-repo   # cache this branch before switching away
node ~/codemap/dist/cli.js diff main --repo /path/to/your-repo
```

`check` is also an MCP tool (`check_stale`) and the diff has a web view at
`/#/u/<universe>/diff/`.

### Several repos at once

A **workspace** is a set of universes served together. Each keeps its own
`.codemap/`; per-universe tools take an optional `universe` (default = primary).
Cross-universe links (`calls_api`) are stored in the *consumer's* graph with a
qualified target (`api::handler`); a hub universe's inbound links are derived by
scanning.

```jsonc
// codemap.workspace.json — paths resolve relative to this file
{ "universes": [
  { "id": "api",        "path": "Acme.API",        "primary": true },
  { "id": "settlement", "path": "Acme.Settlement" }
] }
```

```sh
node dist/cli.js init /working/Acme.API && node dist/cli.js init /working/Acme.Settlement
claude mcp add codemap -- node ~/codemap/dist/mcp.js /working/codemap.workspace.json
node dist/serve.js /working/codemap.workspace.json
```

### `.codemapignore` has two bins

Gitignore-style, in the repo root, with **`excluded`** (the default) and
**`[tests]`**. An excluded path is not indexed at all — vendored and generated
code belongs here. A `[tests]` path **is** indexed — citable, hashable,
pinnable — but is never a documentation subject: it gets `CoverageState =
"tests"`, so `find_gaps` never offers it and no coverage percentage moves when a
repo starts indexing its tests.

The asymmetry is the point. Code is a liability and describing it reduces that,
which is what `find_gaps` ranks; a test is already a claim in executable form. An
uncovered piece of code is a gap and an uncovered test is not. Tests are indexed
at all so that a requirement can pin a lint by hash — see
`docs/population-predicate.md`.

## Reading the map

| Surface | Web | MCP |
| --- | --- | --- |
| File outline, drilled domain → file → symbol, with coverage bars and a two-track review heatmap | `/#/u/:u/tree/` | `outline` |
| Node catalog — every logical node with type, domain, edge degree, provenance, review state; filter and mark reviewed inline | `/#/u/:u/nodes/` | `nodes` |
| Flows and the flow-walker — a process's ordered steps with the live, highlighted source of each | `/#/u/:u/flows/`, `/flow/:id/` | `flows`, `flow` |
| Graph explorer — force-directed, grown by clicking a node to expand its neighbors; pan/zoom, hover-to-trace, type filters | `/#/u/:u/graph/:id/` | `subgraph` |
| Event wiring matrix — events as rows, the aggregates and projections they feed as columns; an orphan event is a blank row | `/#/u/:u/matrix/` | `event_matrix` |
| Layered pipeline — `command → handler → event → aggregate → projection`, one column per role, barycenter-ordered | `/#/u/:u/pipeline/` | `pipeline_graph` |
| State map — per-aggregate state machines: analyzer-extracted transition skeletons plus the source states and guards you author onto them, laid out in BFS layers. `unenriched` is the work queue | `/#/u/:u/statemap/` | `state_map` |
| Search, one symbol, one node | `/search/`, `/anchor/:id/`, `/node/:id/` | `search`, `get_anchor`, `get_node` |

**Coverage is a state, not a binary** (`src/coverage.ts`): per-anchor `open` /
`cited` / `covered` / `trivial` / `deferred` / `owned` / `tests`, derived from
citation plus stored selector rules. The `cover` op marks anchors by selector
(path prefix, file, kind, symbol glob) and re-applies it, so new members inherit
the state. Reporting the honest breakdown instead of a raw ratio turned one real
repo's misleading "4% documented / 1170 open" into "52% / 351 open".

**No floating claims.** A logical node must cite anchors, and write ops validate
that those anchors exist. That invariant is what makes staleness detectable at
all. Referenced anchors that leave the tree are retained under `@orphan`;
`codemap orphans` reports them.

## Reviewing a change

**Branch diff** (`diff.ts`, `codemap diff <base> [head]`, MCP `diff`, web
`/#/u/:u/diff/`) is a logical set-op over two cached anchor snapshots — added and
removed by **id**, changed by **hash** — with the impact rolled up to the nodes,
flows, reviews and rules that cite the affected anchors. "This PR changes
`transfer`, deletes `refund`, and would stale the Money-transfer flow and its
review."

`base` is a cached snapshot; omit `head` to diff against a fresh index of the
current working tree (the PR-review path), or pass a second cached ref for a pure
historical set-op with no re-indexing. Base code for the drill-down comes from
`git show <sha>:file` — no checkout, no contamination. The web view pairs the
before/after code diff with the docs it may stale, and the base/head selection
lives in the URL, so a diff view is shareable.

**Pull requests.** `codemap pr <url|owner/repo#N|#N>` resolves a PR against the
real base (including a merged one), `pr-packet` produces an agent work packet,
`pr-ingest` takes findings back as JSONL, and `pr-push` publishes them to GitHub.
Web: `/#/u/:u/prs/` and `/#/u/:u/pr/:pr/`.

**Walkthroughs** (`docs/pr-walkthrough-design.md`) — an agent writes a PR as
features and chapters, each chapter interleaving prose with the symbols it
claims, so a reviewer reads the change in an order somebody chose. Chapters are
witnessed, so only the ones whose code moved go stale, and no symbol may be
claimed twice.

**Stakes triage** (`docs/triage.md`) — grades each anchor by what an error there
would touch, combines that with the review gap, and sorts the worklist by *most
dangerous thing least looked at*, so the golden window of attention lands there
first.

**Review marks are witness-hashed.** Mark a flow, step, node or anchor `viewed`
(exposure) or `signed` (liability-bearing); the mark captures the covered code's
hashes and goes `stale` when they change. Judged against **live** hashes, never
the frozen stored ones. Normalized hashing (comment-stripped, length-prefixed
tokens) keeps cosmetic edits from flipping anything.

## The standard — requirements, detectors, audits

The other kind of claim. **A doc explains code and is downstream of it; a
requirement is upstream, and the code exists to satisfy it.** That inversion is
why a requirement is its own record kind and not a node type: a business rule
stored as a node would go `stale` when code drifts, and the standing instruction
for stale is "update the node" — i.e. rewrite the rule to match the drift.

`docs/requirements-architecture.md` and `docs/cross-universe-standard.md` are
**normative**; both are short. The shape in brief:

- **The standard is the authority.** A **spec** is a set of **operations** on it
  (add a requirement, amend a statement, retire one, move a section) — never a
  stored diff or free-floating prose. A folded spec is repealed as authority and
  retained as history.
- **Immutability attaches at ratification, not at drafting.** A draft binds
  nothing, so it has a correction path (`revise_spec`, `revise_operation`,
  `remove_operation`, author withdrawal) — all open to any actor, all refused the
  moment the spec leaves `draft`.
- **A ratifier signs what they read.** `ratify_spec` refuses unless that
  principal has signed off every operation *and* the framing, at the text they
  say now — a content hash, so revise-and-revise-back invalidates nothing and the
  refusal can name the field that moved. Sign-off is principal-only.
- **A requirement cites nothing.** Code linkage is a **pointer**, which names
  exactly one universe and carries its own baseline: an anchor, a doc, or a
  lint. A pointer is *a prior on where to look, never a verdict* — when what it
  watches moves, the rule rises in the audit queue, and that is all it does.
  Detectors can be **proposed with a draft spec** and bind at ratification, so
  the ratifier can see the check.
- **`conformant` is only reachable through a code-backed audit.** An audit
  records what was read and what was run; the refusals are the substance (a
  doc-only check certifies nothing; "I could not verify this" is
  `indeterminate`, not a violation).
- **Every mechanism that silences an audit is one acknowledgement record**, whose
  mint-time rules differ by basis: a `gap` may only be minted before
  ratification, `debt` is post-hoc and principal-granted.
- **Law is workspace-scoped, evidence is per-universe.** One business, several
  repos: a rule governing the API and the React app is stated once, while audits,
  pointers, populations and problems stay with the code they observe.

Both front ends carry it — `/#/u/:u/standard/` is the hub, with rules,
conformance, the audit queue, a branch view and a spec/ratification page — and
`src/standard-reach.test.ts` fails if an op is reachable from neither surface, or
if a route no page fetches. *"MCP has it"* is not an accepted exemption:
ratification is the one act an agent structurally cannot perform.

## Shared review — setting up a sidecar (a team)

Everything above is one person's map. A **sidecar** is a second git repo carrying
the *shared* half — findings, docs, notes, triage, the standard — as an
append-only event log that every teammate pulls and pushes. No server, no auth,
no new protocol: the log is authoritative and each clone's SQLite store is a
projection of it. `docs/sidecar-architecture.md` is normative.

One sidecar serves **many universes**. Scopes are prefixed with a universe key
taken from the repo's `owner/repo` origin — `acme/acme.api/pr-264` — so two repos
that share a submodule, and therefore share anchor ids, cannot collide.

**1. Make a repo for it.** Empty is fine. A remote is optional: a sidecar with no
remote is a perfectly good local one — sync commits, push is a no-op, and adding
`origin` later just starts working.

```sh
git clone git@github.com:your-org/codemap-sidecar.git /working/codemap-sidecar
```

**2. Point your universes at it.** Three ways, in precedence order:

| How | Where it fits |
| --- | --- |
| `CODEMAP_SIDECAR=/path/to/sidecar` | a one-off, or trying it out |
| `.codemap/sidecar` — a file holding the path, or a directory that *is* the sidecar | one repo, permanently |
| `"sidecar": "codemap-sidecar"` in `codemap.workspace.json`, relative to the manifest | **a team** — one entry serves every universe in the workspace |

**3. Have an identity**, because every event records who did it — `git config
user.email you@example.com`, or `CODEMAP_PRINCIPAL`. Reading needs none of it.

**4. First sync.** Run it once per universe:

```sh
node dist/cli.js sync --repo /working/Acme.API
# sidecar /working/codemap-sidecar  (acme/acme.api)
#   received 0 event(s), sent yours
```

That `git init`s the sidecar if it isn't one yet (it is always its own repo, even
at `.codemap/sidecar` inside your code repo), writes the shard merge policy
`.gitattributes`, registers a per-person manifest recording your anchor/hash
schemes, then commits and pushes.

### The initial sync — putting an existing map on the sidecar

A store that predates the sidecar holds docs, notes and triage marks nobody else
can see. **It is append-only** — publishing is not something you undo — so
dry-run first and read the counts.

```sh
node dist/cli.js publish-docs   --repo /working/Acme.API --dry-run
node dist/cli.js publish-notes  --repo /working/Acme.API --dry-run
node dist/cli.js publish-triage --repo /working/Acme.API --dry-run
```

Then publish for real and **`sync` to send** — publishing appends locally and
tells you so; the transport is a separate step.

```sh
node dist/cli.js publish-docs   --repo /working/Acme.API
node dist/cli.js publish-notes  --repo /working/Acme.API
node dist/cli.js publish-triage --repo /working/Acme.API
node dist/cli.js sync           --repo /working/Acme.API
```

Analyzer-generated content is skipped on purpose: it is derived, every clone
mints its own copy deterministically, and a derived event has no honest author.
On one real repo that was 622 human triage marks published against 2,221
generated ones skipped, and 756 of 998 documented nodes skipped as analyzer
output.

**Joining a sidecar somebody else set up** is the same minus the publishing:
clone it, point at it, `sync`. The fold materializes their state into your store,
resolved against *your* checkout.

### Day to day

```sh
node dist/cli.js sync           --repo <repo>   # send and receive; also queues arriving disagreements
node dist/cli.js peers          --repo <repo>   # who else is on this sidecar, and scheme drift
node dist/cli.js shared 264     --repo <repo>   # the team's findings on a PR
node dist/cli.js replies 264    --repo <repo>   # what the submitter said back
node dist/cli.js shared-docs    --repo <repo>   # their docs, resolved against your checkout
node dist/cli.js shared-triage  --repo <repo>   # their stakes, with receipts
node dist/cli.js contested      --repo <repo>   # stakes two people disagree about
node dist/cli.js notes <anchor|node> --repo <repo>   # what the team knows about one symbol
node dist/cli.js sidecar heal   --repo <repo>   # repair a forked sidecar (a person, not an agent)
```

The web UI has a hub at `/#/u/<universe>/shared/` with a sync button. The log is
**pull/push only** — an ordinary read never touches the network.

One trap worth knowing: **`--repo` works on every one of these; the bare
positional does not.** `shared`, `replies`, `notes` and `shared-triage` take
their target first, so `codemap shared-triage /working/Acme.API` reads the path
as a *symbol*, falls back to the current directory, and reports no sidecar
configured.

## Setting up an agent

The MCP server (`src/mcp.ts`) is hand-rolled newline-delimited JSON-RPC 2.0 over
stdio — no SDK — and exposes **124 tools** over the `ops` layer: the map
(`outline`, `search`, `get_node`, `get_anchor`, `find_gaps`, `document`,
`connect`, `annotate`), staleness and git (`check_stale`, `reindex`, `snapshot`,
`diff`, `where_was`), findings and review (`report_defect`, `findings`, `triage`,
`review`, `pr_packet`, `pr_walkthrough`), the sidecar (`sync`,
`shared_findings`, `shared_docs`, `shared_triage`, `shared_notes`), and the
standard (`draft_spec`, `add_operation`, `sign_off_operation`, `ratify_spec`,
`declare_pointer`, `record_audit`, `raise_problem`, `standard_queue`,
`scrub_plan`, …).

### The `codemap-audit` skill

Ships in this repo at **`.claude/skills/codemap-audit/SKILL.md`**, with a
byte-identical copy at `.agents/skills/codemap-audit/SKILL.md` for harnesses that
read the vendor-neutral location.

It exists because of an asymmetry that is easy to miss: the requirements
subsystem **records what a caller reports — nothing runs a lint and nothing runs
a scrub.** The agent is the thing that runs. The skill is what tells it which job
it is doing (`scrub`, `differential`, `baseline`, `ad-hoc` select on different
things), what evidence each one owes, and which acts it may not perform —
ratifying, withdrawing, granting debt and adjudicating a problem are a person's.

**Install it for one repo** you audit, so it is checked in for the team:

```sh
mkdir -p /path/to/your-repo/.claude/skills
cp -r ~/codemap/.claude/skills/codemap-audit /path/to/your-repo/.claude/skills/
```

**Or for every project** on your machine:

```sh
mkdir -p ~/.claude/skills
cp -r ~/codemap/.claude/skills/codemap-audit ~/.claude/skills/
```

Either way it is picked up at the start of the next session. It is selected by
its description — when the hub says something is overdue, when a branch is about
to land, before a release — and can be asked for by name. **It needs the codemap
MCP server attached to that repo**, because every step it takes is a tool call;
without the server it has nothing to run.

### The `codemap-explore` agent

A subagent for the other half of the loop: exploration that uses the map as a
**prior to test** rather than an answer to repeat, and writes back what it
learned — correcting docs that turned out wrong, documenting what was missing.
It is one file rather than a directory:

```sh
mkdir -p /path/to/your-repo/.claude/agents      # or ~/.claude/agents
cp ~/codemap/.claude/agents/codemap-explore.md /path/to/your-repo/.claude/agents/
```

Its frontmatter pins it to the codemap MCP tools plus `Read`/`Grep`/`Glob`/`Bash`,
so it has the same prerequisite: the server has to be attached.

## Analyzers (opt-in)

Framework analyzers live in `src/analyzers/`. `codemap analyze marten <repo>
--emit` (MCP `analyze`) runs its own tree-sitter C# pass over a
Marten/Wolverine codebase and extracts folds (`Apply`/`Create(Event)`),
projections (`Transform(IEvent<T>)`), emissions (`new EventT` into
`Events.Append`/`StartStream`), commands (`I…Command` records) and handlers
(`Handle`/`Consume`/`[Wolverine*]` endpoints).

Checks: `command-no-handler`, `appended-orphan` (an event nothing folds,
projects or consumes), and read-model-gap detail. With `--emit` it writes
`event_family` / `aggregate` / `projection` / command / handler nodes and
`folds` / `projects` / `handles` / `emits` edges, making the whole
`command ←handles← handler →emits→ event →folds→ aggregate →projects→ projection`
chain navigable. Emitting also **registers** the analyzer, after which `check`
re-emits whenever the code moved.

Everything analyzer-written carries `generatedBy`, so a re-emit clears and
rewrites only generated content and leaves human docs untouched.

Two caveats worth stating plainly. **"Opt-in" is a runtime property, not a
dependency one** — nothing framework-specific *runs* unless enabled, but Marten
is in the core's static import graph. And **analyzer findings must be
adversarially verified before they are presented**: the first Marten pass on a
real repo produced 138 false positives, and it took about five rounds to get to 4
genuine ones.

## Dependency budget (enforced)

Supply-chain rot is the primary risk this project is designed against. The
runtime footprint is deliberately tiny and **grammars are vendored as inert
`.wasm` blobs**, not fetched or compiled — there is no build toolchain to break
years later.

| Need | Source |
| --- | --- |
| Parsing | `web-tree-sitter` (1 pkg) + 5 **vendored** `.wasm` grammars (four languages; TS ships `typescript` and `tsx`) |
| Hashing | `node:crypto` (stdlib) |
| Git | `node:child_process` → `git` (stdlib) |
| Storage | `node:sqlite` (stdlib; unflagged from Node 23.4) |
| HTTP | `node:http` (stdlib) |
| FS / paths | `node:fs`, `node:path` (stdlib) |
| CLI args | `node:util` `parseArgs` (stdlib) |
| Tests | `node:test` (stdlib) |
| TypeScript | dev-only, compiled away |

The MCP server is hand-rolled rather than using the official SDK. The web UI
vendors vdx-web, marked and highlight.js under `web/vendor/`, committed on
purpose. **Runtime footprint target: one package and the vendored blobs.**
Adding a runtime dependency is a discussed decision, not a reflex.

## Storage & git-awareness

One SQLite DB per universe at `.codemap/codemap.db` (`src/db.ts`), gitignored —
out of git so it never pollutes a branch or PR diff. `src/store.ts` is the
abstraction seam and kept the same async API across the JSON→SQLite move, so
nothing above it changed; on first open of a legacy JSON `.codemap/` the DB
**auto-imports** it, guarded so it never double-imports.

Anchors live under `ref = @work` (the live index). `init` and `snapshot` cache
the current commit's anchors under `ref = <sha>`, immutable — so a commit maps to
a cached index and other-branch data is never lost. `check` incrementally adds
newly-appeared anchors and refreshes moved locations without a full re-init, and
conservatively never re-hashes an existing anchor or removes a vanished one
(those are the `candidate_stale` and `lost` signals). A branch switch
auto-reindexes, because different code is checked out.

**Write safety:** SQLite WAL gives concurrent readers and serialized writers
across processes; a cross-process file lock (`src/lock.ts`) wraps mutating CLI
commands and MCP tools as a redundant outer layer, and a stale lock from a dead
owner is stolen, so a crash never wedges the map.

**Anchor ids are deterministic** — `a_ + sha256(file \0 symbolPath \0
disambiguator)` — stable across branches, line moves and body rewrites. What
*does* change an id: a file rename, a symbol rename, and a change to an
overload's signature (its disambiguator is its parameter-type list). Change how
an id is derived and you must bump `ANCHOR_SCHEME`, because a diff is a set
operation between two snapshots and pairing two derivations reports every symbol
as removed-and-added.

## Development

```sh
npm test         # EVERYTHING — unit then e2e. The default keyword runs the whole suite
npm run unit     # dist/**/*.test.js — hermetic, the fast loop
npm run e2e      # needs a browser and a real repo; skips what is unavailable
npm run build    # emit dist/
npm run typecheck   # tsc && tsc -p web (both targets; `unit` runs it too)
```

`npm test` runs both on purpose: a suite that is not in the default command is a
suite that stops being run. `npm run unit` must stay hermetic — anything needing
an external prerequisite goes in `src/e2e/` and *skips* when it is absent. The
web app is plain `.js` the browser loads directly, typechecked in place
(`web/tsconfig.json` is `allowJs` + `checkJs` + `noEmit`), so there is no second
build target to drift.

`CLAUDE.md` carries the contributor detail — the layering and its seams, the
vdx gotchas, why the suite runs in one process, and the invariants not to break.

## Not built yet

- Fuzzy re-anchoring recovery (today a lost anchor is flagged `lost`, and
  `where_was` answers the one question that *can* be answered about an
  unplaceable id: index a commit, look for the id, and report what this build
  minted there — `found` with the file and symbol path, or `absent`, and it says
  which)
- Marten: auto-generated coverage rules for `Apply`/`Transform` overloads
- Convenience flow-authoring on top of `document` / `connect`
- Optional API-boundary auto-detection (route ↔ fetch matching)

## Where the rest of the documentation is

`docs/README.md` indexes every document with a `Kind:` line saying whether it is
current reference, current design, an active plan, or an archive — because a
superseded document reads exactly like reference material if nothing says
otherwise. The normative ones: `docs/sidecar-architecture.md` for shared state,
`docs/requirements-architecture.md` and `docs/cross-universe-standard.md` for the
standard.
