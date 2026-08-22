# Proposal: immutable provenance

Status: **draft, restructured.** Nine review rounds are folded in; §10 records what
each changed, and §8 lists what is still open.

Reviewed against `worktree-shared-review-hashscheme` at `039fdce`.

This is the ninth revision and the first that is *smaller* than the one before it.
Round 9 asked whether the design had outgrown its value; it had, and two whole
subsystems came out. What follows is the design after that cut — not the design
plus a note about it. §9 says what was removed, for anyone who needs to know why
it is not here.

## 1. The rule

> **Every durable code-derived value carries how it was derived.**

An anchor id and a body hash are produced by applying a set of rules to source
text. Whether two of them can be compared is a question about those rules — not
about the event, file or table that happens to carry the value, and a value
outlives all three. So the derivation travels *with the value*, inline, and nothing
else is consulted to interpret it.

Three earlier drafts attached provenance to a container instead — an event's
envelope, a manifest, an anchor ref — and each failed the same way, because a
container is a bag of things derived at different moments.

## 2. What is broken today

Four separately-filed problems, all of them this one.

**The manifest is mutable and relabels history.** `ensureSidecar` overwrites one
"current" manifest per principal on every run. After an upgrade it claims the new
schemes while that principal's immutable historical events sit in the same shard
under the old derivation, so a teammate folds old anchor ids as current and
silently mis-targets them. (Static review, P1.)

**A publisher's rules are not its values' rules.** `publishLocalDocs` re-emits each
historical doc version with its original citations and their `acceptedHashes` —
minted under whatever scheme was current when somebody confirmed them, sometimes
years earlier. Stamping that event with today's rules asserts they were derived
today. The manifest defect one level down, reachable through an ordinary migration
rather than only an upgrade.

**Grammar and runtime identity are nowhere.** Body hashes encode `HASH_SCHEME` but
not which grammar tokenized the code, nor which tree-sitter runtime ran it. Two
builds can tokenize unchanged source differently under the same `h2:` prefix, so a
reader reports real-looking drift. Grammar mismatch is currently advisory only.
(Static review, P1.)

**One principal is not one writer.** `readScope` dedupes by id because
`merge=union` can produce a line twice, and its comment names the case exactly:
*"one person appending from two machines."* Those writes are not causally related,
but `causality()` keys its vector on principal and treats a principal's previous
event as a causal parent — so fold order fabricates an edge that never existed.
Recorded in `eventlog.ts` as a known limitation.

## 3. The derivation tag

```ts
interface DerivationTag {
  anchorScheme: number;
  hashScheme: number;
  /** The locked integrity of `web-tree-sitter` — an authenticated identity. */
  parserIntegrity: string;
  /** SHA-256 of the exact vendored grammar blob that ran. */
  grammarDigest: string;
}
```

Four values, carried **inline** on everything derived. No registry, no
content-addressed profile object, no reference to resolve.

Indirection through a published profile saved bytes and cost: an object that must
be published before the values referencing it, a registry that must be
materialized, an ordering constraint between them, and two reader states —
`missing_profile` and `dangling_profile` — that existed *only* to describe a
registry not yet complete. Inlining deletes all of it, for perhaps 100–200 bytes
per receipt. A store may normalise identical tags internally after validating them,
so long as the durable record stays self-contained.

**`grammarDigest`, not a language name.** An earlier draft carried a `language`
selector and looked the digest up in a profile's map. With no profile there is no
map, and the digest was the identity anyway — `typescript` and `tsx` are distinct
because their blobs differ, which is a fact about the blobs, not the names. Five
`sha256sum`s over `grammars/*.wasm`, computed at startup or baked in at build.

**`parserIntegrity`, not a version label.** Two runtimes with different bytes can
claim the same version string and tokenize differently, so a label authenticates
nothing. `package-lock.json` already carries an integrity value for
`web-tree-sitter`; that is the identity.

**Only hash derivation bumps `HASH_SCHEME`** — not the receipt's encoding, not the
event schema. An earlier draft said both, in two different sections. Wrapping a
hash differently has not changed the hash, and treating it as though it had would
relabel every hash in the store as a different derivation.

## 4. Writers

A **writer** is a clone-local random `writerId`, minted on first use and never
derived from the principal, the hostname, or anything reconstructible.

```ts
interface EventEnvelope {
  sidecarProtocol: number;   // governs THIS envelope
  eventSchema: number;       // governs `data` only
  writerId: string;
  writerPrev: string;        // previous event of this (scope, writerId), or "GENESIS"
  subject: string;
  // actor, at, after, data...
}
```

Writer identity is **independent of derivation**. An earlier draft made a
"generation" out of `(clone seed, profile id)`, so re-vendoring the Python grammar
rotated the shard of somebody writing only C#. Once every value carries its own
tag, a writer has no reason to know anything about derivation.

### Shard and key the vector by writer

- Shard `(scope, writerId)` rather than by principal.
- Key the vector clock's sequence and `ownLast` by `writerId`.
- Keep `Actor.principal` for attribution and independence, unchanged.

One person on two machines then writes two files, so nothing union-merges anyone's
shard and prefix-closure becomes true rather than assumed.

### `writerPrev`, and the genesis rule

The chain key is `(scope, writerId)` — not global. A global predecessor could not
be validated from `readScope`, which reads one scope at a time, and materialization
is per scope for the same reason.

- Exactly **one** event in a chain may name `GENESIS`.
- Every later event names an event in that same chain.
- **Two distinct events naming the same predecessor are a fork** — including two
  naming `GENESIS`.

That last clause is the one an implementation will drop and must not: two clones
copied *before* either had written anything both open with `GENESIS`, and without
the rule they evade the detector entirely.

### The lock, and what it is for

The sidecar-root lock is a **correctness** requirement, not git hygiene, and it must
be held across **selecting the writer, reading the causal heads and `writerPrev`,
and appending** — not merely around the final write. The race is between reading
what came before and committing to it, so two processes that both read the same
predecessor have already forked whichever order their writes land in.

```
lock          PREVENTS local forks (two processes, one clone)
writerPrev    DETECTS distributed forks (two clones, one copied id)
scope status  STOPS a detected fork answering authoritatively
```

A fork is **not** an ordinary contest. A contest is per-field residue on one entity;
a fork invalidates the vector's single-writer compression for a whole writer across
every entity it touched, and the two sides may not overlap at all. Containment is
scope-level; any contest is a symptom.

### Writer identity must reach the entity folds

Sharding and the vector clock are not the only places one person is treated as one
writer. Verified in the current code:

- `contest.ts` suppresses a contest when `held.by.principal === e.actor.principal`.
- `shared-findings.ts` keys corroboration by principal, so one person's second model
  replaces the first — disagreement included.
- `shared-walkthrough.ts` keeps one walkthrough per principal.

Each needs the *writer* for concurrency and the *principal* for attribution and
independence. Fixing causality without these leaves the collapse where users see it.

### Losing the id

`writerId` lives under the sidecar's real git directory, located with
`git rev-parse --git-path`, created atomically with restrictive permissions. Losing
it — a wiped directory, a restored backup — correctly starts a new writer, which is
cheap; old events stay attributable through their principals.

Copying one into two live clones is the one failure a user can cause by ordinary
means (a machine image, a synced home directory). Document it as clone-local,
provide an explicit rotation command, rotate automatically when absent, and rely on
`writerPrev` for what slips through.

## 5. Receipts

```ts
interface AnchorReceipt { id: AnchorId;  derivation: DerivationTag }
interface HashReceipt   { value: string; derivation: DerivationTag }
```

**Explicit at serialization time.** No "same as the enclosing event" default in
durable data — that default is exactly what lets a later copy relabel a value,
which is the §2 defect.

### Comparability

- Two hashes are comparable when their tags agree on `hashScheme`,
  `parserIntegrity` and `grammarDigest`. The scheme prefix inside the hash string
  stays as a self-description and a migration path, but the tag is the authority;
  where they disagree that is a corrupt record, not a choice between answers.
- Do not attempt an anchor join when the tags disagree on `anchorScheme`. Report the
  mismatch — **never `lost`**, which claims the code is gone.
- **Evaluation order is contract**, not implementation detail:

  ```
  validate derivation → establish comparability → resolve anchor → classify absence/drift
  ```

  A join that goes straight from citation to anchor row cannot tell a missing symbol
  from an unreadable derivation, and defaults to `lost`. `ABSENT_HASH` is
  universally comparable only *after* anchor compatibility is established; before
  that, "there is no code here" is not a statement anyone is entitled to make.

### The value states

| state | what happened | recovery |
|---|---|---|
| `legacy_no_receipt` | a stored receipt predates receipts existing | re-witness |
| `legacy_live_derivation` | the reader's own `@work`/snapshot rows carry no tag | **reindex** — the gap is on this machine |
| `incompatible_anchor_scheme` | ids derived differently | re-witness; **never** relocate |
| `incompatible_hash_scheme` | hashes derived differently | re-witness |
| `parser_mismatch` | a different tree-sitter runtime produced it | re-witness |
| `grammar_mismatch` | a different grammar blob produced it | re-witness |
| `corrupt_receipt` | malformed, or disagreeing with its own hash string | a person looks |

Seven. `missing_profile` and `dangling_profile` went with the registry that created
them; `parser_mismatch` is new, because the runtime is now identified rather than
assumed.

The two legacy states look alike and their repairs differ — one needs the record
re-witnessed, the other needs the reader to reindex their own code — so a reader
must carry **which operand** was untagged, not merely that something was. One label
mapping to two actions is the failure typed states exist to fix.

Every recovery except `corrupt_receipt` is re-witness or reindex. None is evidence
the code moved — a receipt carries no locator — so offering relocation for a
derivation mismatch invites the false re-targeting `witness`/`sourceRef` prevent.

## 6. The live operand, and the seam

A receipt is compared against `@work` anchor rows, and those rows carry no
derivation today. They may themselves have been produced by an older grammar or
runtime, so comparing against them recreates the relabeling defect on the reader's
side.

```sql
ALTER TABLE anchors ADD COLUMN derivation TEXT;   -- the tag, as JSON; NULL = legacy
```

One column, because the tag is one self-contained value. An earlier draft used two
independent nullable columns and needed a `CHECK` to stop half a receipt existing;
one column cannot be half-present.

**Per row, never per ref.** A ref is a bag of rows derived at different moments, and
two places in the current code make that concrete: `sync.ts` refreshes an existing
anchor's location while deliberately *preserving its `bodyHash`* as the baseline, so
`@work` legitimately holds rows from two derivations after an upgrade; and
`@orphan` is `INSERT OR IGNORE` by design, its own comment explaining that the first
eviction holds the last state the anchor was really seen in. Stamping either ref
relabels half its rows.

**The cost is the seam, not the column.** `Anchor` is the currency between the
indexer, `sync.ts`, the store and orphan retention, and it has no derivation field.
`rowToAnchor` builds an `Anchor` from a fixed column list, `replaceAnchors` does
`DELETE FROM anchors WHERE ref = ?` and re-inserts every row from `Anchor[]`, and
the incremental updater round-trips *all* anchors through that path. A column alone
would be **erased on the first incremental update**. So this requires
`Anchor.derivation?: DerivationTag` threaded through the seam — indexer, sync,
store, `retainOrphans`, and every construction site — or write paths that update in
place. The first is honest; the second fights the existing design.

### Migration

Existing rows **cannot** be truthfully backfilled: a tag needs `parserIntegrity` and
a grammar digest, and what a store has is `State.grammarVersions` (friendly strings)
and two integers on snapshots.

- **Never stamp existing rows.** That is the §2 defect performed deliberately.
- **Reindex `@work`** — a genuine full reindex, gated on a store migration marker.
  **Not `check`**: it calls `applyIndexUpdate`, whose contract explicitly never
  rehashes an existing anchor. An earlier draft claimed connect already did this,
  which would have left every row NULL forever while reporting success.
- **Rebuild snapshots**, which nothing currently drives either.
  `staleSchemeSnapshots` and `readSnapshot` compare only the two numeric schemes, so
  a pre-migration snapshot with current schemes and NULL derivation reads as usable
  indefinitely. It needs its own marker, or `readSnapshot` rejecting untagged refs.
  **Do not bump a derivation scheme to force it** — that is the borrowed signal §7
  rejects, and it would rebuild caches in universes with no sidecar.
- **Leave orphans legacy forever.** Their source may not exist any more, so their
  derivation is genuinely unknown and must read that way.

A NULL derivation on an anchor is `legacy_live_derivation`, not `legacy_no_receipt`.

## 7. Reading a scope: fail closed

For v1 a scope is readable or it is not. No partial answer set, no per-entity
incompleteness, no per-line discard accounting.

| situation | status | render |
|---|---|---|
| unsupported `sidecarProtocol` | `blocked` | nothing, plus what to upgrade |
| unsupported `eventSchema` | `blocked` | nothing, plus what to upgrade |
| torn line, malformed envelope | `blocked` | nothing, plus the diagnostic |
| detected writer fork | `blocked` | optionally the rows, explicitly non-authoritative |
| duplicate id, identical content | — | normal; `merge=union` produces these |
| duplicate id, differing content | `blocked` | a person looks |
| ratchet or domain rejection | — | **understood no-op**; the scope stays complete |
| value derivation mismatch | — | render the entity, mark that value |

Two rows earn their place.

**A ratchet rejection is an authoritative fold result, not a failure.** The fold
already ignores forbidden transitions on purpose. Counting one as a reason a scope
is unreadable would let any client wedge a scope by emitting an event the rules
correctly refuse — a denial of service built out of a safety mechanism.

**Identical duplicates are normal.** `readScope` dedupes by id precisely because
`merge=union` legitimately produces a line twice. Only *differing* content under one
id is a problem, and that one is real.

So `shared_scope` carries a status and one diagnostic, not a taxonomy:

```sql
CREATE TABLE IF NOT EXISTS shared_scope (
  scope TEXT PRIMARY KEY,
  protocol INTEGER NOT NULL,
  key TEXT NOT NULL,               -- the cache key: materialization proposal §3
  folded_at TEXT NOT NULL,
  status TEXT NOT NULL,            -- 'complete' | 'blocked'
  diagnostic TEXT                  -- JSON: why, and what to do about it
);
```

**What this gives up** is availability: one bad event hides a scope until it is
repaired or the reader upgrades. The trade is smaller than it looks, because the
partial design already refused state-dependent writes on an impaired scope — and
this never silently lies, which is the guarantee the whole design is for. Salvage
can come back if evidence shows hiding a usable scope is worse than the machinery it
costs; it should not be built on speculation, which is what the three-level model
was.

## 8. Open

- ~~The seam change.~~ **Done.** `Anchor.derivation` is threaded through the
  indexer, store and orphan retention; `sync.ts` needed no change, because
  preserving an existing anchor's provenance falls out of preserving the object.
  Anchors turned out to be constructed in exactly ONE place (`indexer.ts`), so
  stamping is one line. Tags are interned locally in a `derivations` table — one
  to five rows against any number of anchors — which §3 permits because the local
  store is not the durable record.
- **Nothing READS the tag yet.** It is recorded and preserved; comparability (§5)
  still ignores it, so `parser_mismatch` and `grammar_mismatch` cannot yet be
  reported. That is the next slice and it is where the behaviour changes.
- **Before this is called feature-complete**, a Claude Fable 5 subagent should
  review the design and the surrounding changes. Nine rounds with one external reviewer
  is one perspective repeated, and the failures this design exists to prevent are
  exactly the ones a single vantage point does not see.
- **Publication must preserve receipts unchanged**, alongside the source version id
  and `createdAt`. `publishDocVersion` mints a fresh `nv_` id and stamps
  `createdAt: new Date()`, so exact deduplication is impossible today rather than
  merely unimplemented.
- **Where the pull refusal is removed.** `sidecar.ts`'s `fatal` manifest check must
  be deleted in the same change that lands receipts — not before, not after.
  Neither document owns that edit.
- **How to show a value unverifiable for provenance reasons** rather than because
  code moved. Both are "cannot be decided", and conflating them repeats the mistake
  `unverifiable` was introduced to fix.

## 9. What was cut, and why it is not here

Round 9 asked whether the design had outgrown its value. It had, as one coupled
design bundling four things:

```
1. derivation compatibility   tags, receipts, live-operand provenance   KEPT
2. multi-writer causality     writerId, sharding, lock, writerPrev      KEPT
3. projection completeness    protocol boundary, diagnostics            KEPT, trimmed
4. partial-scope salvage      three levels, subject, quarantine index   CUT
```

**Removed: content-addressed profiles and generation records.** A published,
immutable `CompatibilityProfile` behind a `ProfileId`, plus a `GenerationRecord`
binding a writer to one. It bought byte deduplication and cost a registry, a
publication ordering constraint, a "who owns the local registry" question with no
answer, and the two reader states that existed only to describe an incomplete
registry. Inlining the tag deleted all five at once.

**Removed: the three-level status model.** Scope / entity / value, with
`shared_quarantine.subject` deriving entity incompleteness and a partial index to
read it. Built to salvage a scope where one event could not be applied. It is an
availability optimization rather than a correctness one, and it generated most of
the state explosion — including a discard-accounting problem that needed a second
table, which failing closed dissolves entirely.

**Not negotiable**, per the same round: per-value derivation provenance, exact
grammar and runtime identity, provenance on the live operand, the
validate→compare→resolve→classify order, the protocol boundary, clone-local writer
identity, the sidecar lock, and `writerPrev`. Cutting the last three accepts
fabricated causality and silent last-write errors.

## 10. What each round changed

Recorded because the design's shape came from being wrong in public four times,
and the corrections are more instructive than the result.

1. **Insertion-only ordering was false.** A late-arriving *parent* reorders events
   already folded; my property test could not generate that shape because it drew
   parents only from events already present. Replaced with the counterexample plus
   a determinism property that includes forward references.
2. **`ANCHOR_SCHEME` in the materializer cache key was unnecessary**, not merely
   insufficient. Re-folding reproduces the same ids, so nothing changes. One
   criterion covers both scheme numbers: a scheme belongs in the key iff the
   projection stores something *derived* from the anchors table.
3. **An event's profile is not its values' provenance.** The correction that
   produced this document: a backfill republishes values minted years earlier, so
   the envelope cannot speak for them.
4. **Receipts should not copy what the profile authenticates**, and digest
   strictness should not have been deferred. Both were me choosing the locally
   comfortable answer — extra fields "just in case", and readable fixtures over a
   correct parser — where the better one cost nothing once looked at properly.

5. **Round 5** (three-angle pass) — the envelope is not a protocol boundary; a
   copied seed needs *detection* (`writerPrev`), not documentation; the live index
   has provenance too, and comparing against rows that carry none recreates the
   defect on the reader's side; `unverifiable` is seven states, not one; and the
   documents had begun to contradict each other, which is its own hazard.

6. **Round 6** — `ANCHOR_SCHEME` must not be borrowed as a compatibility signal:
   its invariant reaches `staleSchemeSnapshots`, so the lie would rebuild the
   branch-diff cache in universes that have never had a sidecar. And the question
   dissolved once someone checked whether there were any deployed clients — there
   are none, the feature is entirely unmerged, so version checking ships as part
   of the first format rather than being retrofitted into one. My "a detected fork
   is just a contest" framing was also wrong: a fork invalidates a generation's
   single-writer compression across every entity it touched, so containment is
   scope-level and a contest is a symptom of it.

7. **Round 7** — the first round conducted machine-to-machine rather than through a
   human courier, and it caught me making the same mistake §1 exists to prevent.
   Provenance was proposed per REF, when a ref is a bag of rows derived at
   different moments: `sync.ts` preserves an existing anchor's hash while indexing
   new ones fresh, and `@orphan` is `INSERT OR IGNORE` by design. Per-row was
   always the answer, and §1 already said so. Two open questions dissolved with the
   wrong design rather than being answered, and `blocked` turned out to be two
   situations wearing one name.

8. **Round 8** — the first follow-up on a live thread, and it found the revision
   worse than the thing it replaced in one respect: per-row provenance is right as
   a data model and **physically impossible on the current seam**, because `Anchor`
   carries no provenance and `replaceAnchors` reconstructs every row from it. Two
   columns would be erased by the first incremental update. Also caught me leaving
   the withdrawn design in force above the archive boundary — the exact hazard I
   had filed against this document two rounds earlier and then committed myself.

9. **Round 9** — asked whether the design had outgrown its value, which is the one
   question its author cannot answer. It had, as one coupled design: see §9. The
   two cuts both dissolve states rather than hiding them — inlining the derivation
   tag deletes `missing_profile` and `dangling_profile` outright, because those
   exist only to describe a registry that would no longer exist. It also caught a
   coupling I had introduced without noticing: generation = (seed, profile) meant
   re-vendoring the Python grammar rotated the shard of somebody writing only C#.
