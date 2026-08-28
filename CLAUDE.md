# CLAUDE.md — codemap

A codebase-agnostic **semantic map**: it anchors documented claims to hashed code
(tree-sitter, per-symbol normalized hashes) so documentation / bug / review
staleness becomes *visible* instead of silent. Maps C#/.NET, Python, JS/TS.
Consumed by both a human (web UI) and AI agents (MCP server), from one store.

## Why this exists — meaningful review of large, event-sourced changes

The north star: make code review of big changes **meaningful** instead of
rubber-stamping a 20k-line diff with "nothing jumps out" because the context
wasn't there. Event sourcing is a worst case — a single behavior is scattered
across `command → handler → event → aggregate → projection`, so a raw file diff
hides *what actually changed about the system*. codemap's job is to give the
reviewer that context and a way to work through it deliberately:

- **Branch diff** (`/diff`) — not a file diff: it rolls each changed symbol up to
  the **flows, docs, and reviews** it affects, and lets you review a change
  (anchor) and read the doc it may have staled, side by side with the code.
- **Flow-walker** — step through a process and review the live source of each step.
- **Node catalog / event matrix / pipeline graph** — see the wiring a diff can't:
  which events an aggregate folds, which handler emits what, what's orphaned.
- **Review marks are witness-hashed** — a green check goes `stale` when the code it
  covered changes, so "reviewed" never silently lies.

When adding features, bias toward **reducing the reviewer's cognitive load and
surfacing the context a raw diff hides** — that is the product, not incidental.

## Golden rule: dependency frugality

Supply-chain rot is the primary risk this project is designed against. The
runtime footprint is deliberately tiny:

- **`web-tree-sitter`** + four **vendored** `.wasm` grammar blobs (`grammars/`).
- Everything else is Node stdlib: `node:crypto`, `node:sqlite`, `node:http`,
  `node:child_process` (→ `git`), `node:test`, `node:util`.
- The MCP server is **hand-rolled** (newline-delimited JSON-RPC 2.0 over stdio),
  not the official SDK. The web UI vendors vdx-web, marked, and highlight.js
  (`web/vendor/`). Grammars/vendor blobs are committed on purpose — no fetch, no
  build toolchain to rot.

**Do not add a runtime dependency without discussing it first.** A few hundred
lines we own beats another thing that can become a worm/rugpull vector.

## Build & test

```sh
npm test         # EVERYTHING — unit then e2e. The default keyword runs the whole suite
npm run unit     # dist/**/*.test.js — hermetic, ~60s. The fast loop
npm run e2e      # dist/e2e/**/*.e2e.js — needs a browser and a real repo; ~100s
npm run build    # emit dist/
node dist/serve.js <repo|workspace.json> [port]   # web UI (default :4310)
```

`npm test` runs both on purpose: a suite that is not in the default command is a
suite that stops being run. `npm run unit` is the loop you iterate in.

**`npm run unit` must stay hermetic and fast.** Anything needing an external
prerequisite goes in `src/e2e/` and *skips* when the prerequisite is absent —
puppeteer for the UI suite, a `jellyfin/jellyfin` clone for the PR suite (see
Guinea-pig repos). The golden rule applies to the test tree too: no runtime deps,
and no test that fails because a browser or a repo is missing.

### The oracle: workflow tests as an oracle, not as assertions

`src/oracle.ts` makes a team where each member is a WHOLE universe (code clone +
`.codemap` store + sidecar clone); `src/oracle-properties.ts` holds six invariants
checked after every step of a scenario. Use it for anything multi-person.

- **Drive the OPS, never the plumbing under them.** `settle()` calling `sidecar.ts`'s
  `sync` instead of the `sharedSync` op left every clone holding an unmaterialized
  log — a state no real machine is in, and every read folded.
- **Check that a passing property COULD have failed.** Four of the six were vacuous
  at first: `ownership` passed after deleting every fold-owned row, `converged` never
  read the projections it claims to be about, `determinism` was the identity for
  exactly two events, and `NO SILENT OK` was not implemented at all.
- **All clones share the directory basename `acme-api` on purpose.** A local origin
  is never a GitHub URL, so `universeKey` takes its fallback; differently-named
  clones would silently publish to different universes.

### The suite runs in ONE process, and that is deliberate

`--test-isolation=none`. The runner's default is a child process per file, and
that child intermittently never exits — parked in Node's own
`NodePlatform::DrainTasks` after every test in it has passed, wedging the run for
as long as you let it. One process cannot hit it. See `docs/session-log-2026-08.md` § "The
stall" for the stack and the four hypotheses that died.

Two rules follow, and neither is optional now that nothing separates the files:

- **Leave no process-global state set.** A test that flips a module-level latch
  must restore it in `finally` — `markAgentSession()` had no way back, and one
  file marking the session made eight later tests fail as "an agent may not".
  That is what `clearAgentSession()` is for, and it has no production caller.
- **`--test-concurrency=1` is load-bearing, not leftover.** A few tests set
  `CODEMAP_AGENT_MODEL` around a call because the op resolves its own actor and
  takes no override. Serialized files make that safe; concurrent ones would let
  it leak into whatever else is running.

To debug one file, `node --no-warnings dist/x.test.js` runs it in process and is
the fastest loop. `node --test dist/x.test.js` also works and is what wedges —
if it parks at 0% CPU, that is the bug above, not your change.

Requires **Node ≥ 23.4** — the store uses `node:sqlite` (`DatabaseSync`)
unflagged, which lands there (emits an ExperimentalWarning; harmless).

## Architecture (the layering — respect the seams)

```
schema.ts            the data model (single source of truth for the store)
  ↑
indexer/repo/normalize/grammars   tree-sitter → deterministic anchors + hashes
  ↑
db.ts + store.ts     SQLite persistence (store.ts is the abstraction SEAM)
  ↑
ops.ts               plain async API — all real logic; protocol-free
  ↑
mcp.ts   serve.ts+web/   two co-equal front-ends over ops (+ multi.ts for workspaces)
src/analyzers/*      OPT-IN framework plugins (Marten) — see the caveat below
```

- **`store.ts` is the seam.** Everything above it calls store functions; keep
  their signatures stable so storage changes stay contained (that's how the
  JSON→SQLite migration touched nothing above it).
- **`ops.ts` holds the logic.** MCP tools and the HTTP API are thin wrappers —
  add behavior in ops, expose it in both.

## Core invariants (don't break these)

- **No floating claims.** A logical node must cite anchors; write ops validate
  that the anchors exist. That invariant is what makes staleness detectable.
- **Deterministic anchor id** = `a_ + sha256(file \0 symbolPath \0 disambiguator)`
  — stable across branches/line-moves, and across a body rewrite: the hash of the
  CODE is not in it. What does change an id: a file rename, a symbol rename, and —
  since an overload's disambiguator is its parameter-type list — a change to an
  overload's signature. In an event-sourced codebase that last one is
  `Apply(SomeEvent)`, i.e. exactly the code people file findings about, so it is
  worth knowing before diagnosing "my findings disappeared". Referenced anchors that
  leave the tree are retained under `@orphan`; `codemap orphans` reports them.
- **Change how an id is derived → bump `ANCHOR_SCHEME`.** A cached snapshot is a set
  of ids, and a diff is a set operation between two of them, so pairing snapshots
  from different derivations reports every affected symbol as removed-and-added.
  Snapshots store the scheme they were written under and one from another value reads
  as NOT CACHED, which callers already handle. This replaced a guard that sniffed
  disambiguator SHAPE and therefore only ever caught the one change it was written
  for — the next one shipped 107 phantom "changed" symbols on a real PR.
- **Witness-hash staleness.** Bugs and reviews snapshot the covered code's
  normalized hashes; a later mismatch = `possiblyFixed` / `stale`. Judge review
  staleness against **live** hashes, never the frozen stored ones.
- **Normalized hashing** (comment-stripped, length-prefixed tokens) so cosmetic
  edits don't flip a hash.
- **`generatedBy` provenance.** Analyzer-emitted nodes/edges carry it; a re-emit
  clears+rewrites only generated content and leaves human docs untouched.

## Storage & git-awareness

- One **SQLite DB per universe at `.codemap/codemap.db`**, gitignored (the DB
  auto-writes `.codemap/.gitignore`). Out of git so it never pollutes a branch/PR
  diff and a checkout never drags a stale map in. On first open of a legacy JSON
  `.codemap/`, it **auto-imports** it (guarded so it never double-imports).
- Anchors live under `ref = @work` (live index). `init` and the `snapshot` op
  cache the current commit's anchors under `ref = <sha>` (immutable) — a commit
  maps to a cached index, other-branch data is never lost.
- **Diff** (`diff.ts`, `codemap diff <base> [head]`, MCP `diff`, web
  `/#/u/:u/diff/`) is a logical set-op over two snapshots (added/removed by id,
  changed by hash) with impact rolled up to nodes/flows/reviews. Base code for the
  drill-down comes from `git show <sha>:file` — no checkout, no contamination.

## Web UI — vdx gotchas (these have bitten repeatedly)

- The vdx router is **HASH mode** (no `<base href>`). Deep links are `/#/u/...`,
  **not** `/u/...` — a path-form deep link falls back to home→outline. Test with
  the `#` URL.
- In `html` slots use **`each(list, fn, keyFn)`**, never bare `.map()` (it throws
  a guard).
- Boolean attributes (`selected`, `checked`, `disabled`) bind as
  `attr="${bool}"`, **not** `${cond ? 'attr' : ''}` string-injection.
- Dynamic SVG children and the `:path*` wildcard had upstream vdx bugs; both are
  **fixed and re-vendored** — don't reintroduce the old workarounds (`?p=` query
  param, innerHTML-after-nextRender). SVG builds straight from templates via
  `each()`.
- `index.html` asset paths are **absolute** (`/app.js`, `/vendor/*`) for
  deep-link robustness.

### The web app is typechecked in place

It is three modules: `core.js` (fetch, nav, page frame — imports NEITHER of the
others), `app.js` (the pages and the route table) and `shared.js`. `core.js` exists
to break a real `app.js` <-> `shared.js` cycle, whose failure mode here is a blank
page that logs nothing; `src/import-cycles.test.ts` walks `web/` and fails if it
returns.

It stays plain `.js` that the browser loads directly — `web/tsconfig.json` is
`allowJs` + `checkJs` + `noEmit`, so there is no second build target and no
generated file to drift. Both test targets run it (`tsc -p web`, well under a second).

- **Type a page and you must do it twice.** `@extends {Component<Props, State>}`
  types `this.props` only; `this.state` is typed by a `@type` on the constructor
  assignment, which shadows the inherited `state: S`. Do one and you get a page
  that looks typed and is half `any`.
- **API shapes come from the ops functions themselves.** `app.js` carries an
  `ApiMap` typedef — every GET route to `Awaited<ReturnType<Ops['fn']>>` — and
  `api()` is generic over it, so all call sites are typed with no per-page
  annotation. `serve.ts` returns those values verbatim, so a field ops stopped
  returning fails the typecheck at the page that reads it instead of rendering
  nothing (a bug this project has already shipped). The map is derived and can
  drift: `src/api-map.test.ts` fails when it does.
- **A page that can fail must pass `taskError(this.load)` to `pageShell`.**
  `createTask` never rejects — it parks the failure on `task.error` — so a page
  that ignores it shows its spinner forever. That was all eighteen of them once.
- `noImplicitAny` and `strictNullChecks` are **off**: measured on 3.5k lines of
  untyped JS they produced 1293 of 1345 errors and no defects. The tree is ~5k lines
  now, so treat that as the reason they were turned off, not as a current count. Turn them on per-file later
  if it earns its keep; leaving them on now just trains people to ignore output.
- **Reactivity is READ-TRACKING, and lifecycle hooks are not a substitute.** A
  store field consulted only inside a side effect is never a dependency, so the
  component never re-renders when it changes. `afterRender` is **one-shot** — it
  fires after the first render and never again, so using it to react to anything
  gives you a component that works exactly once, before the data it needs exists.
  For chrome that must follow the router (no props, so no `propsChanged`), use
  `watch(() => store.field, fn)`. Cost a debugging round on `codemap-checkout`.
- The framework's own **template lint** covers the string-form bindings TS reads
  as opaque text (Lit sigils, raw `.map()` in a slot, `ref=` typos) — the one class
  of front-end defect `tsc -p web` cannot see. It runs in the **e2e suite**
  (`src/e2e/vdx-lint.e2e.ts`) and *skips* when the tool is absent; point
  `CODEMAP_VDX_TOOLS` at a vdx-web checkout's `tools/`. It used to be a manual
  step at re-vendoring time, which meant the only check TypeScript could not
  stand in for was also the only one with no schedule.

## The sidecar — read `docs/sidecar-architecture.md` before touching shared state

It is short and it is normative; the two proposal documents predate it and lose
where they disagree. The three things it settles, so a reader knows whether they
need it: the **log is authoritative** for shared state and SQLite is its
projection; the log is **pull/push, never read on an ordinary MCP or web read**;
and there is **one canonical table per entity kind**, so a teammate's doc is a
`node_versions` row with an origin marker rather than a parallel table needing a
bridge onto every surface.

One sentence carries most of it, and the codebase has re-derived it five times:
**acts enter the log at the moment they happen; everything derivable is a local
projection.** A derived event has no honest actor and no honest causal position, and a
deterministic fold means every clone mints its own copy; a claim that never entered the
log cannot be retrofitted with a position, because `after` is captured at append time.

It defers the mechanisms to two documents: `docs/plan-docs-unification.md` and
`docs/fork-repair.md`. The second is worth knowing exists before touching
`eventlog.ts` or `contest.ts` — the causal vector's per-writer ordinal is a **prefix
claim** that a fork falsifies, and the fix derives the vector from the `writerPrev`
chain instead of fold order. A design that looked like a soundness argument was wrong
here for two reviews; both documents open with the counterexample rather than quietly
dropping it.

## Requirements — read `docs/requirements-architecture.md` before touching them

Also short, also normative, and it outranks COD-29 and the *Requirement Kernel* draft
where they disagree. A **requirement** is the other kind of claim: a doc explains code and
is downstream of it, a requirement is upstream and the code exists to satisfy it. That
inversion is why it is a separate record kind and not a `LogicalNodeType` — every member
of that union is code-shaped, so a business rule stored as a node goes `stale` when code
drifts, and the standing instruction for stale is `update_node`, i.e. rewrite the rule to
match the drifted code.

Three things worth knowing before deciding whether you need the document: the **standard
is the authority** and a folded spec is repealed as authority (retained as history); a
spec is a set of **operations** carrying their own context, never a stored diff or
free-floating prose; and every mechanism that silences an audit is **one acknowledgement
record** whose mint-time rules differ by basis — a `gap` may only be minted before
ratification, `debt` is post-hoc and principal-granted. That last one is the whole defence
against "declare the rule not yet applicable" becoming the cheap way to clear a finding.

`LogicalNodeType` ends `| (string & {})` and is therefore OPEN: adding `"requirement"` to
it type-checks and silently inherits all of the above. `src/requirements.test.ts` fails if
a requirement ever reaches the node path.

## Analyzers (opt-in only)

- Framework analyzers (currently Marten/Wolverine) live in `src/analyzers/`.
  `analyze marten --emit` registers the analyzer; `check` then auto-refreshes the
  generated graph when code changes.
- **"Opt-in" is a runtime property, not a dependency one, and this used to say
  otherwise.** Nothing framework-specific RUNS unless it is enabled — but Marten is in
  the core's static import graph: `ops/indexing.ts` imports `refreshAnalyzers`, which
  imports `marten-emit.ts`, on the ordinary staleness path. It costs no runtime
  dependency, so it has not been worth inverting; it is worth not claiming otherwise.
- **Always adversarially verify analyzer findings before presenting them.** The
  first Marten pass had 138 false positives; it took ~5 rounds to get to 4 genuine.

## Operational constraints

- **The private C# universes under `/working/` are LIVE and edited by another
  agent — do not write to them.** Validate on isolated scratch copies. The
  primary one is the real motivating target; work out of it (it's the hub where
  system knowledge lives).
- Use the **`gh` CLI** for GitHub, not raw URL fetches.
- **Don't `pkill -f serve.js`** — it self-kills the shell (exit 144). Kill scratch
  servers by pid. Never kill the user's `/working/codemap.workspace.json` server.
- Puppeteer for headless UI checks lives at
  `/working/vdx-web/tests/e2e/node_modules` (createRequire from there;
  `executablePath: /usr/bin/chromium`). Manage the serve child in-process; avoid
  lingering background jobs.

## Guinea-pig repos

`cl-pprint` (primary; py+js, git), `FakeBankSimulator` (C# hard cases),
`mrepo-web` (scale, gitless), plus two private enterprise C# repos under
`/working/` — the real targets (referred to as `Acme.API` / `Acme.Settlement` in
examples throughout this repo).

`~/Desktop/jellyfin` (override with `CODEMAP_E2E_GIT_REPO`) backs the PR e2e
suite: a public C# repo with a genuine history, which is the only way to reach
merged-PR base resolution, working-tree independence, and symbols a branch
DELETES. Tests always run on a `--local` clone — never the named repo, which is
somebody's working tree. Fixture shas live in `src/e2e/real-repo.ts`; a merged
PR's `baseRefOid`/`headRefOid` are immutable, so they do not rot.
