# Proposal: immutable provenance

Status: **draft — design settled, implementation begun.** Ten review rounds are
folded in; §10 records what each changed, and §8 lists what is still open.

Reviewed against `worktree-shared-review-hashscheme` at `568bd07`.

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

**Two of the three inputs are covered automatically; the third is discipline.** A
body hash is decided by the grammar, the runtime, and *our own* tokenization —
`indexer.ts`'s walk and `normalize.ts`'s canonicalization. The first two are opaque
third-party artifacts where any change might matter and nobody can tell, so they
are digested. The third cannot be: digesting our own source would invalidate every
hash in every store on every release, and only a person can say which edits to it
actually move a token stream. It is `hashScheme`, bumped by hand.

That asymmetry is right and it is also the weak link, because a manual bump can be
forgotten — and a forgotten one is silent and total. Demonstrated rather than
assumed: changing one separator in `canonicalize` moves every hash while
`parserIntegrity` stands still, so `comparableDerivation` calls the pair comparable
and the whole store reads as drift. `normalize.test.ts` now pins the canonical
output with a golden vector, which turns "did you mean to bump `HASH_SCHEME`?" into
a question somebody is forced to answer rather than one they might not think to ask.

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

**Built.** `emitEvent` stamps it, `detectForks` reads it, `eventlog.test.ts` covers
the GENESIS clause and its control.

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

Two rules the implementation had to add, neither of which is in the sketch above:

- **An absent `writerPrev` is not an implicit `GENESIS`.** Every event written
  before the chain existed lacks one, and reading those as genesis makes each of
  them a fork on the writer's second event — every log in the wild, at once.
  They are **not judged**.
- **A chain claim needs a `writer`, not the principal fallback.** `causality`
  falls back to `actor.principal` so an old event still folds; a fork is a claim
  about a CLONE, and the same fallback here would file two machines' independent
  chains under one person and call their genesis events a fork.

The predecessor an event names comes from **its own shard's last line**, not from
fold order. A shard is single-writer and append-only, so its last line IS the
chain head by construction — where fold order is a total order over the whole
scope, and trusting it to agree with append order for one writer is the very thing
a fork breaks.

**What could make the detector fire on an honest team**, since a false positive
blocks a whole scope and is the failure that matters here. It needs one clone to
append twice from the same shard state, and the shard only grows: the lock
serializes two processes, sync is one branch with fetch-and-merge and never
rewinds, and `merge=union` can only stitch somebody else into my shard if they
hold my writer id — the case being detected. The route that remains is a **restored
backup of the sidecar clone**, which rewinds the shard while the writer id, living
in the same git directory, is restored with it. That is the same class §4 already
names under *Losing the id*, and the same remedy applies: rotate. `contested.test.ts`
pins the negative — a real team, a real remote, two rounds of concurrent writes and
merges in both directions, and every clone still reads `complete`.

### The lock, and what it is for

The sidecar-root lock is a **correctness** requirement, not git hygiene, and it must
be held across **selecting the writer, reading the causal heads and `writerPrev`,
and appending** — not merely around the final write. The race is between reading
what came before and committing to it, so two processes that both read the same
predecessor have already forked whichever order their writes land in.

```
lock          PREVENTS local forks (two processes, one clone)      — built
writerPrev    DETECTS distributed forks (two clones, one copied id) — built
scope status  STOPS a detected fork answering authoritatively       — built
```

Scope status is §7's fail-closed rule, and it landed as §7 describes it: one
`status` and one `diagnostic` on `shared_scope`, stored beside the fingerprint so
a cache HIT answers the verdict without re-reading the log. `readCached` returns
it WITH the value — a signature that lets a caller take the rows and forget to
ask is how a fail-closed rule fails in practice. The surfaces that present team
state carry it (`sharedFindings`, `sharedDocs`, `sharedNotes`, and `context` via
`sharedCoverage`), and the web pages render it as a banner above the rows.

`sharedCoverage` is the one that needed a second route. It takes the QUERY path —
`ensureMaterialized`, then SQL — so no envelope comes back to carry a verdict, and
it is also where a silent one does the most damage: coverage DROPS gaps, so a
blocked scope quietly talks an agent out of documenting code. `scopeVerdict` reads
the stored row and **re-fingerprints**, answering `null` rather than a verdict that
no longer describes the shards on disk.

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

**Resolved, and they did not all resolve the same way.** The three look like one
question and are three.

- **`contest.ts` keys on the WRITER.** Its check meant "revising your own write",
  and for a single clone it is subsumed by `saw` below it — a writer's own history
  is always in its own causal vector. So the line's only live effect was ever the
  two-machine case, where it suppressed a genuine disagreement and the fold picked
  last-writer-wins in silence. `Contested` now carries the clone on each side as
  well as the person: attribution still wants the human, but a disagreement whose
  two sides show the same name is one nobody acts on.
- **Corroboration keys on `(principal, model)`, not the writer.** A verdict is an
  OPINION, and whose opinion it is includes which model formed it — two models
  disagreeing is the signal, and the principal key overwrote it. But a person
  re-reviewing from their desktop has *changed their mind*, which is a replacement,
  not a second voice; keying on the clone would leave two entries for one opinion.
  `reviewerKey` in `identity.ts`.
- **Walkthroughs stay per principal.** A walkthrough is a whole authored document,
  not a concurrency-sensitive scalar. One per person is the intended product rule,
  and two clones publishing is last-writer-wins on a document a person can simply
  republish — not the silent loss of somebody's disagreement that the other two
  were.

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

> **SUPERSEDED — do not build either of these.** `HashReceipt` was replaced by the
> fingerprint inside the hash string (`docs/decision-receipts-vs-prefix.md`, landed).
> `AnchorReceipt` was then CANCELLED by `docs/anchor-id-provenance.md`: the evidence
> an id needs is already on the body hash minted beside it, so ids stay bare and the
> work is join-side. That document is authoritative for everything below about
> anchor ids, including the comparability rule in this section. The rest of §5 — the
> state table, the evaluation order — still stands and is implemented.

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
- ~~Do not attempt an anchor join when the tags disagree on `anchorScheme`.~~
  **Superseded**: id comparability is three fields — everything but `hashScheme` —
  because `symbolPath` and the disambiguator are read off the parse, so a grammar
  moves ids without `anchorScheme` moving. And the gate is consulted only AFTER id
  equality fails, exactly as the hash side consults it only after two digests
  differ. `docs/anchor-id-provenance.md` §2.
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
| `incompatible_derivation` | the two tags disagree; `detail` says on what | re-witness; **never** relocate |
| `corrupt_receipt` | malformed, or disagreeing with its own hash string | a person looks |

Four, not seven. An earlier draft split the third row into
`incompatible_anchor_scheme`, `incompatible_hash_scheme`, `parser_mismatch` and
`grammar_mismatch` — four labels whose recovery column read "re-witness" four
times. A state whose only distinction is a better error message is a `detail`
field, and separating them buys a taxonomy to maintain rather than a decision to
make. Same move round 9 made twice, applied to a table I wrote after it.

The two legacy states DO stay separate, because their repairs genuinely differ:
one needs the record re-witnessed, the other needs the reader to reindex their own
code. A reader must therefore carry **which operand** was untagged, not merely that
something was. One label mapping to two actions is the failure typed states exist
to fix — and it is the test for whether a split earns itself.

Where a recovery is a person's action at all it is re-witness or reindex. None is
evidence the code moved — a receipt carries no locator — so offering relocation for
a derivation mismatch invites the false re-targeting `witness`/`sourceRef` prevent.

### One deliberate exception to the evaluation order

Equal hashes settle a pair as unchanged **before** comparability is consulted,
which reads as inverting the order above. It is intentional: two derivations that
produced the same digest for a symbol produced the same token stream for it, so
they agree *there* whatever they do elsewhere. Marking those unverifiable would
flood a grammar bump with every symbol it did not actually affect.

Written down because it looks like a bug. Somebody implementing receipts will
otherwise "fix" `diff.ts` to match the stated order and cause exactly that flood.

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
- ~~Nothing reads the tag.~~ **The snapshot gate does, and repairs.** A cached
  snapshot derived by another build now reads as NOT CACHED, so `ensureSnapshot`
  regenerates it — the repair this codebase already performs for a scheme bump,
  extended to the question the scheme numbers cannot ask. Reporting the mismatch
  downstream instead, which an earlier slice did, leaves a repairable cache in
  place and floods the diff.

  A snapshot is minted atomically by one build, so it HAS a truthful derivation.
  That is the correction to §1's rule as first written: provenance belongs at the
  granularity of the MINTING EVENT — per row where rows are minted separately
  (`@work`, `@orphan`), per ref where the ref is minted at once. "Never a
  container" was over-generalized from three containers that genuinely were bags
  of mixed moments.

  `unverifiable` survives as a narrow residue: `@work` against a snapshot. An
  incremental update preserves an existing anchor's hash, so a live index
  legitimately holds pre-upgrade rows and cannot be rehashed without destroying
  the baseline it exists to be. Those pairs are genuinely undecidable, stay out of
  `impacted`, and are surfaced in the CLI and the web.
- ~~**The other comparison sites still ignore it, and that is the LARGER exposure.**~~
  **Closed**, and it was the largest thing left. Doc citations (`doc-version.ts`),
  review witnesses (`witnessDrift`/`realDrift`), acceptance and bug witnesses all
  ask `comparableHashes` before calling a difference drift — the annotation in the
  hash string is what made that answerable without a schema change.

  A sweep of every remaining bare `sameBody` found two more the section never
  named, and they are the same defect one level out: `pr-push.ts` gated PUBLICATION
  on it, so an incomparable witness read as "the submitter pushed" and the finding
  was withheld from the pull request silently — it is `evidence-unverifiable` now,
  still withheld but counted and explained, because "nobody can tell" is not
  clearance to send a confident review. And `staleChapters` re-implemented
  `witnessDrift` without the check: `resolveAnchor` classifies an ABSENT id, so a
  FOUND one hands its hash back unexamined.

  Three sites were checked and are SAFE, so nobody re-audits them: `pr.ts` and
  `diff.ts` compare two snapshots, and `readSnapshot` returns null for a snapshot
  from another derivation, so both sides are always current; `pr-bulk.ts` indexes
  both sides in one process. `stale.ts` compares stored anchors against a fresh
  re-index and is the `check` path — the reindex IS the repair there, not a
  comparison to protect.

  What has NOT changed is why `@work` cannot simply be reindexed when its
  derivation changes: doing so is what triggers the flood. So the diff's
  `unverifiable` residue is not a quirk, it is a symptom of the same gap.

- **A cheaper fix than receipts may exist** — now written up as a decision to take,
  in `docs/decision-receipts-vs-prefix.md`. The short version is that the two are
  not alternatives: a fingerprint in the hash string covers HASHES (witnesses,
  accepted hashes, acceptance) locally and in the sidecar with no schema change,
  while receipts remain irreducible for anchor IDS, which no prefix can describe.
  Taking both in their own lanes deletes `HashReceipt` from §5 and leaves
  `AnchorReceipt`. Original note kept below for the reasoning.

- **A cheaper fix than receipts may exist**, raised by the Fable review and worth
  a round of its own. Put the derivation fingerprint IN the hash string —
  `h2:<fp>:<digest>` over (hashScheme, parserIntegrity, grammarDigest). Every site
  above already funnels through `comparableHashes`, and `hashSchemeOf` already
  parses that prefix, so they would become derivation-aware with no receipts, no
  sidecar dependency, and no per-site change. Local-only universes — which will
  never have a sidecar — get grammar-aware staleness under this framing and never
  get it under receipts.

  The cost is real and bounded: about ten sites compare hash STRINGS with `===` or
  `.includes`, so a format change needs them all moved to one comparison helper
  first. Which is arguably worth doing regardless — raw equality on a hash string
  is what makes any format change hazardous.

- ~~Proportionality: build a detector, not a mechanism.~~ **Done**
  (`liveDerivationDrift`). `check` reports when `@work` holds tags this build does
  not produce, and the MCP connect path writes it to stderr, because the thing it
  warns against — a full reindex — is a reasonable-looking next step that nothing
  else would have flagged. It reports and stops: reindexing is what would flood the
  store, so acting automatically would BE the failure.

  Sized for something that has never happened. `git log --follow -- grammars/`
  shows the blobs committed exactly once, in the initial commit. One query, on
  demand, one sentence when it fires, and silence for untagged stores — which is
  every store that exists today, and warning all of them about a question their
  rows cannot answer would train people to ignore the case that means something.
- **Untagged is comparable, on purpose.** A tag on only one side falls back to
  today's behaviour. It has to: every stored value predates tags, and answering
  `unverifiable` for all of them would trade a rare false positive for a universal
  false negative. Snapshots rebuilt after this ships carry tags, so the tagged path
  takes over as caches turn over.
- **Before this is called feature-complete**, a Claude Fable 5 subagent should
  review the design and the surrounding changes. Nine rounds with one external reviewer
  is one perspective repeated, and the failures this design exists to prevent are
  exactly the ones a single vantage point does not see.
- **Publication must preserve receipts unchanged**, alongside the source version id
  and `createdAt`. `publishDocVersion` mints a fresh `nv_` id and stamps
  `createdAt: new Date()`, so exact deduplication is impossible today rather than
  merely unimplemented.
- **There is deliberately no forced reindex.** §6 once implied a migration marker
  would drive one. It will not: reindexing `@work` is what converts a grammar
  change into store-wide false staleness, so the response is
  `liveDerivationDrift` warning and a person deciding. Snapshots are the opposite
  case and do rebuild automatically, because they can be.

- **A corrupt interned tag reads as untagged**, not as suspicious —
  `derivationsById` skips a row it cannot parse, so the anchor arrives with no
  derivation and falls into the legacy fallback. The two gates above catch the
  consequential cases (`readSnapshot` rebuilds, `liveDerivationDrift` warns, both
  because an unresolvable id is not a current tag), so what remains is a diff
  pair reading as comparable when nobody can say. Recorded rather than fixed: the
  fix is a third meaning for the derivation column, and this repository's own
  local DB corrupting is not the threat the design is for.

- ~~**Where the pull refusal is removed.**~~ **Cancelled** by
  `docs/anchor-id-provenance.md`: there is no `AnchorReceipt` to land, and
  `sidecar.ts`'s `fatal` manifest check becomes load-bearing rather than obsolete —
  `anchorScheme` is the one id-gating field the derivation mark on a body hash does
  not carry, so the refusal is what covers it. Keep it.
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

10. **Round 10** (Claude Fable, a second external model rather than a tenth round
    with the first) — found the thing nine rounds of one reviewer had not: the
    rule from §1 was over-generalized. "Never attach provenance to a container"
    came from three containers that were genuinely bags of mixed moments, and was
    applied to a snapshot, which is minted atomically by one build and therefore
    has a truthful derivation. That mattered because only ref-level identity can
    qualify ABSENCE — a grammar that changes symbol recognition floods
    added/removed, and an absent value carries no tag. It also caught
    `parserIntegrity` hashing the CommonJS loader rather than the wasm that does
    the lexing, and the web silently dropping a count the CLI printed. The cut it
    proposed — four states whose recovery column all read "re-witness" — is
    applied above.
