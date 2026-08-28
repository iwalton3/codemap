# Plan: unify shared docs into `node_versions`

> **Kind: decision record** — why the code looks like this. Done — kept for the argument, not as a to-do.
> done 2026-08-23.

**Status: DONE** (2026-08-23; `1322e6c`, `87586db`, `0e097b2`, `ce1e027`, `1771aff`,
`e70e5fa`). Kept because the arguments are still the reasons the code looks like this,
and because three of its steps changed under review — see "What the build changed"
at the end.

Originally: **reviewed twice, NOT started.** Written 2026-08-23, revised the same day
after a design pass closed five defects the first version only claimed to close, and
an adversarial round found five more. `docs/sidecar-architecture.md` is the
architecture this implements and wins wherever the two differ.

## Why

A teammate's doc and a local doc are both `NodeVersion`, both resolved by
`selectWinner`, both judged by `evalVersion` — and they live in two tables read by two
paths. The cost is a hand-written bridge per surface, and four surfaces (`outline`,
`search`, `get_node`, notes) that still cannot see team docs at all. Unifying retires
the bridges instead of adding a fifth.

## The prerequisite that is not in this plan

**Materialize-at-sync must land first.** Today `readCached` folds on a miss on the
read path and sync materializes nothing. Once the bridges are gone, a pulled
teammate version reaches SQLite *only* if sync put it there — so without it the
choice is between a version that is invisible indefinitely and a `loadNodes` that
folds on an ordinary query. The second breaks both "the log is not read during
normal operation" and "the hot path is SQLite". It is step 2 of the sequence in
`docs/session-log-2026-08.md`; this plan is blocked on it, and that dependency was missing from
both earlier drafts.

## Two decisions taken before any step

**Analyzer-generated docs never sync.** The architecture doc always said so; the line
that published them (`publishLocalDocs` passing `generatedBy` through) was a mistake,
not a policy. Beyond the doc's own argument, two things settle it: a published
generated doc has **no refresh path**, because `publishLocalDocs` skips nodes the
sidecar already has, so the team's copy freezes on publish day while every local copy
keeps tracking code; and generated versions carry `acceptedHashes: []` and short
circuit to badness 0, so a synced one can never be judged stale — which breaks the
staleness invariant for exactly the bulk of the content.

**`process` and `step` docs are not publishable, for now.** Flows are assembled
entirely from `step_of` edges and `document()` materialises a process's steps as
separate nodes plus edges; a `doc.version` event carries only the version and its
citations, and no event kind carries edges. So a synced process doc renders as an
empty flow under a teammate's name — which is worse for a reviewer than absence,
because it looks like the team mapped the flow and found nothing. Edge sync is a full
entity design (edges have no id, so it needs an identity rule, a G3-compatible
removal story, an ordering-merge rule for `ord` contests, and fold ownership in the
`edges` table) for a surface with no demonstrated demand. Narrow now; design it when
somebody asks why they cannot share a flow.

**Both are enforced per VERSION, at three points** — `badDocVersion`,
`publishLocalDocs`, and `foldDocs`. Per version, not per node: `type` is a version
field and a node's history can mix them, so a node-granular skip either drops a
legitimate older `concept` version or lets the backfill loop publish a historical
`process` version that `foldDocs` then silently rejects — an event durably in the log,
permanently invisible, nobody told. Fold-time refusal is the load-bearing one: there
is no server and no central validation, so the fold is the only gate that binds every
writer.

## The steps

1. **Narrow the publishable surface.** The two decisions above. Bump
   `MATERIALIZER_VERSION`. Nothing is deleted and nothing is deployed, so there is no
   quarantine question.

2. **Provenance, ownership, ordering, and the act gates.** `origin` / `source_scope` /
   `publication_state`, **plus `ord` and `author`** — `author` is missing from the
   earlier draft and is mandatory, because `SharedDoc.authors` is a `Map` that JSON
   cannot carry, which is why it is a column today; without a home it becomes
   `undefined` for every doc, silently and well-formed. Indexes on
   `origin`/`source_scope`. The adoption rule for backfilled ids, so the fold takes
   ownership of a byte-identical local row rather than colliding with it. Every local
   mutation routed through one helper appending `AND origin IS NULL`, or a trigger
   that raises unless a fold is active.

   Canonical read order, everywhere versions load:
   `ORDER BY (origin IS NULL), ord, rowid` — fold rows first in the log's order, then
   local rows in insertion order. On a local-only store `(origin IS NULL)` is
   constant and `ord` is NULL, so it degenerates to `rowid` and reproduces today's de
   facto order; note that today's SQL guarantees no order at all, so this turns an
   empirical behaviour into a contract.

   **(f) — `ackHole` gets two mechanisms**, because the hole has two halves. The
   ownership guard cannot close it on its own: `ackHole` does not mutate a fold-owned
   row, it INSERTs a new local tombstone that is `origin IS NULL` by construction, and
   a tombstone citing absent anchors scores badness 0 while a teammate's content
   version whose code is absent here scores ≥ 1 — so it wins, and `loadNodes` filters
   the node out entirely. An agent thereby achieves locally what both shared gates
   exist to prevent. So: `ackHole` refuses when the node has any fold-owned content
   version (gate the version **pool**, not the winner — gating the winner still lets
   the tombstone land while a local version happens to win, and it then suppresses the
   fold version on other branches); and the union layer drops local tombstones from any
   pool containing a fold-owned content version, which covers the ordering race the
   gate cannot. A fold-owned tombstone — a published retirement — is untouched by both.

   **The filter must reach `docDiff`.** It calls `winningVersionAt` directly on
   `loadNodeVersions` output, outside every store call site, so an old local tombstone
   otherwise still wins a diff side and renders `(removed)` against a teammate's doc.
   It cannot go inside `loadNodeVersions` — the version-history UI must still show the
   tombstone — so `docDiff` needs an explicit filtered resolution path.

   **(b) — the analyzer re-emit.** `writeNode`'s generated branch computes `existing`
   from the local partition only, restoring the `existing.length === 1` idempotence
   check that a teammate's row otherwise makes permanently false, which would churn a
   fresh `version_id` on every `check`.

   **One deliberate behaviour change, declared rather than smuggled in:**
   `selectWinner` gains a human-beats-generated tiebreak at equal badness. This is
   **not** inert — a generated version and a fresh human version are both badness 0
   today, so recency decides between them, and a generated row's `created_at`
   refreshes on every re-emit, meaning a machine synopsis silently outranks a
   teammate's prose after any code change. It changes resolution on local-only stores
   too, where a human version can already fork onto a generated node. It needs its
   own test; the "generated-only node still resolves generated" control cannot catch
   it. A *stale* human doc still loses on badness, which is the right reading.

3. **Retarget the projection and carry the verdict — one step, not two.** The
   projection writes `node_versions` and `shared_doc_unmatched`, replacing only rows
   it owns; `loadNodes` unions and carries `origin: { scope, status }` on the value,
   degrading sidecar I/O failure to `blocked` rather than throwing; gap suppression
   lives in one exported function beside it.

   **These cannot be separate steps.** The moment the projection writes
   `node_versions`, `loadNodes` reads those rows automatically — and until the verdict
   lands, `coverageFor` treats blocked-scope citations as authoritative and `findGaps`
   removes them from `open` before its blocked-scope protection runs. A split
   therefore ships a window that violates the normative "blocked rows show but
   suppress nothing" rule. Each surface drops its bridge *call* in the same commit it
   becomes union-aware, or teammate docs render twice.

   **(i) — team versions participate in diff, and the diff surfaces are extended
   here.** `DocSide` gains `by` and `origin`; `DocDiff` and `impact.nodes` carry the
   verdict, so a blocked scope's docs appear marked rather than hidden. A PR that
   drifts code a *teammate's* doc describes is exactly the context a raw diff hides —
   excluding team versions would make the diff blind to the docs most likely to be
   staled unknowingly, and would need a sixth bridge.

   **`computeDiff` needs more than inclusion, and the earlier draft was wrong about
   this.** It does not resolve documentation per side at all: it calls `loadNodes(root)`
   once, against the *current* `@work` index, regardless of the base and head asked
   for. So a fold-owned retirement that wins on whatever branch happens to be checked
   out erases the node — and `computeDiff` takes explicit cached refs and is used for
   pull requests independently of the checkout, so the current working tree silently
   decides what a PR's impact reports. Resolving impact against the requested refs is
   part of this step, not a follow-up.

4. **Write-through**, covering `updateNode` and `confirmNode`, not just `document()`.
   A confirm on a fold-owned row is `confirmSharedDoc`, not an in-place UPDATE.

5. **Delete the bridges and drop `shared_doc*`.** `sharedDocsCiting`,
   `sharedDocCandidates`, `sharedCoverage`, `sharedKnowsNode`, `context`'s parallel
   field and verdict rank, `get_anchor`'s second lookup, `annotate`'s guard.
   **`sharedDocs` is reimplemented** over canonical rows plus `shared_doc_unmatched`
   and `author` — three front-ends render it and it carries per-citation
   classification `loadNodes` should not produce. Then drop the tables.

### Two things cut from the earlier draft, because there are no users

**No transitional dual-write** of `shared_doc*` alongside the retarget, and **no
one-release grace period** before dropping them. Both existed to protect a rollback
for people who do not exist: nothing is deployed and no sidecar has ever been created.
The dual-write also came with its own defect — stopping it at the final step is not
revertible, because later folds would refresh the canonical rows and the scope
fingerprint while leaving `shared_doc*` stale, so reverting to the bridges would find
a current fingerprint, decline to re-fold, and serve a stale cache as authoritative.
Cutting it removes that problem rather than solving it.

## Revertibility, honestly

Each step is revertible on its own terms, with one thing that is not and must be
respected: **local `node_versions` rows are the only thing in the store that is not
regenerable.** Human docs live there and nowhere else, so "delete the DB and re-init"
is never a revert path. Every schema change above is therefore additive — reverting
the code that reads a column leaves a dead column in a fully functional store — and
every fold-owned row is re-derivable from the log by definition. Step 1's guards
revert through the `MATERIALIZER_VERSION` mismatch, which forces a re-fold in either
direction.

## Defects this plan must close

The ten from the first review, plus what closes each. (a) backfill self-collision —
step 2's adoption rule. (b) analyzer re-emit — step 2, narrowed further by the no-sync
decision. (c) `confirmNode` writing a fold-owned row — step 4. (d) `writeNode`'s
fresh-edit UPDATE — step 4. (e) `deleteNode`/`removeNode` — step 2's guard. (f)
`ackHole` — step 2, both mechanisms plus the `docDiff` path. (g)
`remapNodeCitations` — step 2's guard. (h) `ord`, `author`, `unmatched`, ordering —
step 2 and step 3. (i) diff meaning — step 3, decided. (j) process docs without edges
— step 1, narrowed away.

Existing `shared_doc*` rows are the one non-issue: they are a cache, and the version
bump re-folds them.

## Corrections to earlier claims in this repo

- **`Cached<T>` is not a compile-time guarantee.** It was described that way,
  including to the owner. Every caller destructures `const { value, ...status }` and
  may drop the status; it is a convention with good ergonomics.
- **The 0.5s budget is not threatened.** `loadNodes` already pays the two dominant
  costs — the `@work` hash scan and a JSON parse per row. Unification adds one scope
  fingerprint per call and an occasional whole-scope fold (61ms at 20,000 events). The
  call to measure is `document()`, which calls `loadNodes` twice.
- **Migration is from `main`, which has no sidecar**, so none of the ten defects is a
  data-repair problem. (a) still bites, but as a rule to get right rather than a store
  to fix.

## Left open

Whether a *stale* human doc should outrank a fresh generated synopsis. This plan keeps
badness-first; flipping it is one line in the same tiebreak and wants UI evidence.

The pre-existing local behaviour that an analyzer re-emit deletes a human fork sharing
its node id. Scoped to local rows by step 2, otherwise unchanged, and flagged here so
it is not later mistaken for a regression.

## What the build changed

Five things the implementation settled differently from the plan above, each found by
attacking the code rather than by writing it:

1. **Adoption needs an exact predicate**, not a `version_id` match. Matching on the id
   alone adopts a row edited since publication (unrecoverable: local rows are the only
   non-regenerable thing in the store), a row under another node id, and a row owned by
   another scope — which then makes two scopes steal it from each other on every fold.
   Local, same node, same payload; anything else is not the same version.
2. **The show/decide split has to live inside `coverageFor`.** Coverage STATE is
   computed there, so a blocked scope's citation has already made its anchor `cited`
   before any caller could filter it, and no downstream filtering turns that back into
   a gap. `nodes` for display, `result` from the deciding subset, one place.
3. **`coverageFor` and every ops-layer node read must FOLD.** `docsVerdict` is what
   materializes the docs scope; a surface that never called it simply did not see
   teammate docs. That was most of them.
4. **The projection must preserve the fold's OUTER order.** `ORDER BY node_id`
   alphabetises a Map that `foldDocs` returns in first-event order, so a cache miss and
   a cache hit returned different values for one scope. The pre-existing equivalence
   test could not catch it — it used a single node.
5. **`MATERIALIZER_VERSION` had to move twice**, once for the narrowing and once for
   the projection reshape. A cache written under the old number points at tables the
   new reader does not read, so the fingerprint matches and the fold never happens.

And one product decision made rather than inherited: `context` no longer ranks a
teammate's doc below every local one. That rank existed because the doc was NOT in this
store, so "go and read it" was the only honest instruction. It is a `node_versions` row
now, so how much to trust it is the same question as for any other doc — confirmed with
the owner. Whose it is is carried by `sharedDocs`.
