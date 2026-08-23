# Plan: unify shared docs into `node_versions`

**Status: reviewed, NOT started.** Written 2026-08-23, put through a dual review
(Fable 5 and codex) before any code. Both reviews rejected the first sequencing;
this is the plan after them. `docs/sidecar-architecture.md` is the architecture
this implements and wins wherever the two differ.

## Why

A teammate's doc and a local doc are both `NodeVersion`, both resolved by
`selectWinner`, both judged by `evalVersion` — and they live in two tables read by
two paths. The cost is a hand-written bridge per surface, and four surfaces
(`outline`, `search`, `get_node`, notes) that still cannot see team docs at all.
Unifying retires the bridges instead of adding a fifth.

## What the review changed

**The first sequencing would have shipped a deterministic crash.**
`publishLocalDocs` preserves the original `versionId` (deliberately — it is a
republication of history, not a new act), and the fold preserves ids from events.
So on any store that authored docs and then published them — the real hub — the
fold inserts a version id that already exists locally, `node_versions` keys on
`version_id` alone, and the constraint violation happens **inside `readCached`'s
transaction**. The fold throws, every docs read on that store fails, and nothing
about the failure moves the fingerprint, so it never self-heals.

**"Projection change alone" is not a shippable step.** The moment the projection
writes `node_versions`, five existing local writers have write access to
fold-owned rows. The guards are a read-path prerequisite, not write-through work.

## The revised order

Each step is revertible while the `shared_doc*` tables remain (they are a cache;
the log is the authority).

1. **Provenance and ownership, together.** Add `origin` / `source_scope` /
   `publication_state` — three facts, not one; a locally authored version that has
   been published needs all three. Add the adoption rule for backfilled ids: the
   fold takes ownership of a byte-identical local row rather than colliding with
   it. Add indexes on `origin`/`source_scope` — a per-fold `DELETE WHERE origin = ?`
   is otherwise a table scan. Route every local mutation through one helper that
   appends `AND origin IS NULL`, or a trigger that raises unless a fold is active.
2. **Retarget the docs projection** to `node_versions`, replacing only rows it
   owns. Bump `MATERIALIZER_VERSION`; the golden vector in `materialize.test.ts`
   will fail until it is, which is the intended prompt.
3. **`loadNodes` unions and carries the verdict** as `origin: { scope, status }` on
   the value, degrading sidecar I/O failure to `blocked` rather than throwing.
   Gap suppression — the one dangerous derived decision — lives in one exported
   function beside it, with a test pinning "blocked ⇒ docs listed AND gaps not
   suppressed".
4. **Write-through**, covering `updateNode` and `confirmNode`, not just
   `document()`. A confirm on a fold-owned row is `confirmSharedDoc`, not an
   in-place UPDATE.
5. **Delete the bridges**: `sharedDocsCiting`, `sharedDocCandidates`,
   `sharedCoverage`, `sharedKnowsNode`, `context`'s parallel field and verdict
   rank, `get_anchor`'s second lookup, `annotate`'s guard. **`sharedDocs` is
   reimplemented over canonical rows, not deleted** — three front-ends render it
   and it carries per-citation classification `loadNodes` should not produce.
6. **Leave `shared_doc*` inert for one release**, then drop.

## Defects found by review, each of which must be closed by a step above

| # | Defect |
|---|---|
| a | Backfill self-collision — deterministic, permanent, on the real hub store |
| b | Analyzer re-emit `deleteNode`s teammate rows; fingerprint unmoved, so the cache serves the hole forever; `existing.length === 1` idempotence goes permanently false |
| c | `confirmNode` writes a fold-owned row — reverted next fold, never an event |
| d | `writeNode`'s fresh-edit UPDATE mutates a teammate's winning version; its stale path forks a local sibling the log never hears about |
| e | `deleteNode`/`removeNode` vanish-then-resurrect a team doc |
| f | `ackHole` lets an AGENT tombstone a team doc locally, bypassing `retireSharedDoc`'s person-only gate and `shareDoc`'s refusal of `removed: true` |
| g | `remapNodeCitations` rewrites fold-owned citations with this build's anchor mapping |
| h | `ord` and per-node `unmatched` have no home; `versionsOf`/`loadNodes` read with **no ORDER BY**, so version order is rowid order that local writes interleave |
| i | `docDiff` and `computeDiff` change meaning — a teammate's version can win one side. A product decision nobody has made |
| j | Team `process` docs arrive without `step_of` edges (edges never sync), so flows render empty |

Existing `shared_doc*` rows are the one non-issue: they are a cache, and the
version bump re-folds them into the new shape.

## Migration is from `main`, which has no sidecar

`main` carries no event log and no `shared_*` tables, and this branch has never
been used for real. So none of the ten defects above is a data-repair problem —
they are all forward-design constraints. Defect (a) in particular still bites, but
as a rule to get right rather than a store to fix: the first time a `main`-era
store publishes its local docs and folds them back, the preserved version id
collides with the local row unless the adoption rule in step 1 exists.

## Corrections to earlier claims in this repo

- **`Cached<T>` is not a compile-time guarantee.** It was described that way,
  including to the owner. Every caller destructures `const { value, ...status }`
  and may drop the status; it is a convention with good ergonomics. The
  suppression decision is moreover already derived in two places
  (`sharedCoverage` and `findGaps`), so one site is an improvement over today, not
  a regression from it.
- **The 0.5s budget is not threatened.** `loadNodes` already pays the two dominant
  costs — the `@work` hash scan and a JSON parse per row. Unification adds one
  scope fingerprint per call and an occasional whole-scope fold (61ms at 20,000
  events). The call to measure is `document()`, which calls `loadNodes` twice.

## Still undecided, and blocking nothing in step 1

Whether analyzer-generated docs should sync at all — they do today, and the
architecture doc says they should not. A migration needs to know whether to
ignore, quarantine or accept them.
