# Proposal: materialize the sidecar fold into SQLite, behind `store.ts`

Status: **draft for review; steps 0, 1, 2 and 4 landed, 3b partly. 3a and 5 open.** Written in response
to the `store.ts`-seam finding in `COLLABORATION-STATIC-REVIEW.md`, and to two
goals stated more narrowly than that finding did: **consistency** and
**performance**.

Reviewed against `worktree-shared-review-hashscheme` at `54da307`; §7's sequencing
re-checked against the tree at `9a14923`, where receipts turned out to be cancelled
and step 0 turned out to be done.

## 0. The claim in one paragraph

The sidecar's events are the source of truth and should stay that way. What is
wrong today is not where the events live — it is that **every read re-derives
everything from them, in JavaScript, and then joins against the anchor table by
loading all of it into memory.** Anchors are already in SQLite, they are
system-generated, and they are the key that all shared state references. Put the
fold next to them and the join becomes a query. That is the performance case. The
consistency case is that `store.ts` already owns the verdict functions the shared
path declines to use, so three consumers re-derive them and one of them disagrees.

## 1. What is actually true today

Verified, not assumed:

- `shared-docs.ts:31` imports `winningVersionAt` **from `store.ts`** and reuses it
  verbatim. `classifyCitations` (`citation-state.ts:47`) is shared by both sides.
  **The rules already converge on the seam.** What sits outside it is storage,
  querying, and the API surface — about 2,400 lines across `ops-shared.ts` and the
  four `shared-*.ts` modules.
- `readFindings` (`shared-findings.ts:558`) is
  `foldFindings(await readScope(...))`. There is **no cache anywhere** in
  `shared-findings.ts`, `shared-docs.ts`, or `eventlog.ts`. Every read re-reads
  every shard in the scope and re-folds from zero.
- `classifyCitations` builds a `Set` of **every anchor id in the universe** to test
  membership of the handful asked about. `liveHashes` (`ops-shared.ts:386`) builds
  a `Map` of **every anchor id → hash** for the same handful. `sharedDocs` calls
  both, so it scans the whole anchor table twice per call.
- Measured on `~/Desktop/jellyfin`: **10,449 anchors, 76 ms per full
  `readAnchorStore`.** So `sharedDocs` spends ~150 ms on full-table scans before it
  folds anything. `codemap` itself is 481 anchors / 8 ms — the cost is proportional
  to the repo, and the motivating targets are larger than jellyfin.
- `sharedDocs` returns per-citation `present`/`matches`/`unverifiable` and **no
  document-level status**, with a comment telling callers to read the parts. So
  `web/shared.js` (`docFresh`), the CLI, and the backend's `needAttention` each
  synthesize the verdict separately — and P1-5 of the static review is that
  `docFresh` gets it wrong (it filters to present citations first, so one matching
  plus one missing renders green). Meanwhile `evalVersion` in `store.ts:370`
  already computes exactly that verdict, with `badness` for tiebreaks.
- `store.ts:386` carries the duplication in a comment: *"`ops-shared` already draws
  this line for the sidecar's copy (985 of 985 on a real repo), and this is the
  same judgement locally."* The HASH_SCHEME rule was written twice and kept in step
  by hand.

One correction to the static review while I am here: its P1 *"shared docs compare
and confirm cached hashes, not live source"* is accurate as stated — `liveHashes`
reads the persisted `@work` index — but the implied contrast with the local path
is wrong. `evalVersion` takes the same `@work` map. Reading against the last index
rather than re-indexing is a design-wide property, not a shared-side divergence.

## 2. Ordering semantics — the part that has to be decided first

The webhook analogy is exact, and codemap's existing answer is stronger than the
one webhook consumers usually reach for.

A Stripe consumer receiving `paid` before `payment_pending` has two defences:
make handlers idempotent, and reconcile against the API because the API is the
truth. codemap already has the stronger property: **the log is the truth and the
fold is a total function of it.** `sortEvents` gives every reader the same order,
so a late event needs no special handler — it changes the input set, and the fold
is recomputed. That is why late arrival costs nothing today, and it is exactly the
property a materialized view can destroy if it is built carelessly.

### The property I claimed, and why it was wrong

**Struck.** An earlier draft of this section claimed a late arrival only ever
INSERTS and never reorders what is already folded, on the strength of 4,000 random
DAGs with zero reorderings. Review supplied a counterexample; it reproduces:

```
B  id=1  after=[A]     # A has not arrived yet
C  id=2  independent
sort(B, C)     = B, C

A  id=3  arrives later
sort(A, B, C)  = C, A, B      # B and C have swapped
```

The shape is a **forward reference**. While A is absent, B is eligible —
`sortEvents` waits only for parents it can see — and sorts by id. When A lands, B
becomes blocked behind it and moves past events that had been sorting after it.
Honest under cross-machine clock skew: B's writer really had seen A, but A's id can
still sort later.

My generator could not produce it. It drew every parent from events already in the
list, so "a named parent arrives later" was unreachable, and 4,000 clean trials
were 4,000 trials of a restricted space. Worth recording as a method note rather
than just a correction: I did mutation-test the checker, and both mutations left it
green, which should have been read as *this test measures little* instead of *this
property is robust*. Verifying that a test fails when the code breaks says nothing
about whether the generator can reach the failing shape.

`eventlog.test.ts` now pins the counterexample directly, and the random test that
replaced the false one asserts the property that IS true and IS worth depending on:
**fold order is a function of the event set alone** — not of arrival order, not of
input order — with forward references deliberately generated. It fails when
`sortEvents` is made order-dependent.

None of this weakens the design; it removes a crutch it never needed. Any change to
a scope's event set may reorder that scope, so the only safe operation was always
to re-fold the whole scope and replace its rows atomically.

### The rule

> **The materialized view is a CACHE KEYED BY THE INPUT SET. It is never an
> accumulator.**

Concretely: nothing may apply an event directly to a materialized row. The only
write path into the view is *"re-fold this scope from its events and replace the
rows."* If code ever mutates a view row in response to a single arriving event, it
has become an accumulator, and an out-of-order arrival will silently diverge it
from what every other machine computes.

This is worth stating as an invariant in `CLAUDE.md` alongside the existing ones,
because it is the invariant most likely to be "optimized" away by someone who
notices that re-folding a scope to apply one event looks wasteful.

### Why that is affordable

Scopes are already the right granularity: `findings/<universe>/pr-<n>` is one pull
request; `docs/<universe>` is one universe's docs. A re-fold is bounded by one
PR's events, not the sidecar's. And the payoff is not "avoid re-folding" — it is:

- re-fold only the scopes whose events actually changed, and
- never do the anchor join in JavaScript again.

The second is the larger win and it is unconditional.

> **Do not design around "the event arrived in order" being a fast path.** Even
> before the forward-reference case, a late event landed somewhere other than the
> end 88% of the time in random DAGs; with forward references, arriving in order
> does not even guarantee the rest of the scope keeps its positions. There is no
> cheap case to special-case, and code that looks for one is how the accumulator
> gets reintroduced.

### The three arrival regimes, named

1. **In order** — sorts after everything folded. Scope re-fold, by the rule above.
2. **Late** — sorts before the head, and may move its neighbours. Scope re-fold.
   Deterministic, so the result equals what every other machine computes.
3. **Incomplete** — you hold B but not A, because A is still on somebody's laptop.
   The fold is well-defined; it is a fold of what you have. The causal vector
   already encodes who had seen what, so contests are detected correctly. This is
   not an error state and must never be reported as one. Note it is also regime 2's
   precondition: the forward reference above is exactly an incomplete scope, and it
   resolves into a reorder when the missing parent arrives.

## 3. Invalidation

Not git. A per-scope key with two halves — what the events are, and what derived
them:

```
key(scope) = sorted [ (filename, size, mtime_ns) ] over scope/*.ndjson
           + MATERIALIZER_VERSION      -- bumped when fold or projection changes
           + resolved sidecar identity -- so pointing at another sidecar cannot reuse rows
           + universe qualification
```

The file half is a change **signal**, not a content address: it does not identify
the input set, it detects that the input set moved. Everything else in this
document assumes only the latter, but the distinction should not be blurred.

### Neither scheme number belongs in this key

An earlier round of this document put `ANCHOR_SCHEME` in the key, arguing that the
rows store anchor ids and a bump rewrites the anchor table underneath them.
**Withdrawn.** The criterion that settles it covers both scheme numbers at once:

> A scheme belongs in the cache key **if and only if the projection stores
> something DERIVED from the anchors table.**

The projection stores anchor ids *copied verbatim from events* and nothing derived;
the join to `anchors` happens at read time. So a scheme bump changes the join
result and cannot change the rows — re-folding after one produces byte-identical
output. Invalidating on it buys nothing and costs a rebuild. The same reasoning
keeps `HASH_SCHEME` out: accepted hash strings are preserved verbatim and compared
at read time by `comparableHashes`.

**The trap this opens:** §6 proposes one authoritative document verdict. That
verdict must be **computed at read time from the join, never stored as a column.**
The moment a `where`/`fresh` column exists for indexed filtering, both scheme
numbers re-enter the key by the criterion above — and the failure would be silent,
because the rows would look perfectly well-formed.

Stored on the scope row; re-stat on read. A scope has one file per teammate, so
this is a handful of `stat` calls — microseconds — and it is correct across
processes, which matters because the static review's P2 *"one sidecar clone has no
lock shared by web, MCP, CLI"* is true: the HTTP path takes no lock, MCP locks the
universe rather than the sidecar, and CLI sync takes none. A git-sha watermark
would miss another process's uncommitted append; a file fingerprint does not.

Fingerprint, fold, fingerprint again, and retry if it moved — that closes the
ordinary append-during-fold race. The row replacement and the stored fingerprint
must commit in the **same SQLite transaction**.

Two processes re-folding one scope concurrently is then benign rather than a race
to prevent: the fold is deterministic, so they compute identical rows and
last-writer-wins inside a transaction is correct. That is worth stating explicitly,
because it is the reason this design tolerates the sidecar having no cross-process
lock — a real gap (static review P2) that this does not fix and does not need to.

Residual risk: a union merge that produces byte-identical size *and* mtime would
read as unchanged. Appends only grow the file and mtime moves, so this needs a
same-nanosecond rewrite to the same length. Every build system takes this bet.
Worth a note in the code, not a mitigation.

Rejected alternative: `git diff --name-only <before>..<after>` after a pull maps
changed shard paths to scopes precisely (`dirname` of a shard *is* its scope). It
is elegant and it is a useful *optimization* for the pull path, but it cannot be
the primary key because it is blind to uncommitted local appends by another
process.

## 4. Schema

Matching the existing style in `db.ts` — real columns for what you filter and
join on, JSON for nested structure, exactly as `nodes.anchors` and
`node_versions.citations` already do.

> **Incomplete as written.** These tables predate `PROPOSAL-provenance.md` and are
> missing the provenance columns it requires: a derivation reference on every
> anchor id, one row per accepted hash rather than a JSON list (one citation can
> hold hashes from several profiles), the language each value was derived for, and
> a derivation profile per anchor REF including `@work` — the live side of the
> comparison has provenance too, and comparing against rows that carry none
> recreates the relabeling defect on the reader's side.
>
> The shapes below are still the right skeleton; do not freeze them before step 3a.

```sql
-- One row per materialized scope. `fingerprint` is the cache key; see §3.
CREATE TABLE IF NOT EXISTS shared_scope (
  scope       TEXT PRIMARY KEY,      -- 'findings/acme/api/pr-264'
  fingerprint TEXT NOT NULL,
  folded_at   TEXT NOT NULL,
  events      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shared_finding (
  scope TEXT NOT NULL, id TEXT NOT NULL,
  target_kind TEXT NOT NULL, target_id TEXT NOT NULL,
  state TEXT NOT NULL, severity TEXT, category TEXT, line INTEGER,
  author TEXT NOT NULL, created_at TEXT NOT NULL,
  -- Derived by the fold, stored so the ack queue is a WHERE rather than a scan
  -- over deserialized objects. Recomputed on every re-fold, never incremented.
  needs_ack INTEGER NOT NULL, contested INTEGER NOT NULL,
  posted_key TEXT, posted_url TEXT,
  body TEXT NOT NULL,                -- the whole SharedFinding, as JSON
  PRIMARY KEY (scope, id)
);
CREATE INDEX IF NOT EXISTS ix_sf_target ON shared_finding(target_id);
CREATE INDEX IF NOT EXISTS ix_sf_queue  ON shared_finding(scope, needs_ack);

CREATE TABLE IF NOT EXISTS shared_doc_version (
  universe TEXT NOT NULL, node_id TEXT NOT NULL, version_id TEXT NOT NULL,
  type TEXT, title TEXT, summary TEXT, body TEXT,
  removed INTEGER DEFAULT 0, generated_by TEXT, author TEXT,
  created_at TEXT, created_commit TEXT, created_branch TEXT,
  citations TEXT NOT NULL,           -- JSON, mirroring node_versions.citations
  PRIMARY KEY (universe, version_id)
);
CREATE INDEX IF NOT EXISTS ix_sdv_node ON shared_doc_version(universe, node_id);

-- The citation edge, lifted out of the JSON so an anchor lookup is an index seek.
-- THIS is the table that makes the join in §5 possible; without it the anchor
-- comparison stays a full scan no matter where the fold lives.
CREATE TABLE IF NOT EXISTS shared_doc_citation (
  universe TEXT NOT NULL, version_id TEXT NOT NULL, anchor_id TEXT NOT NULL,
  PRIMARY KEY (universe, version_id, anchor_id)
);
CREATE INDEX IF NOT EXISTS ix_sdc_anchor ON shared_doc_citation(anchor_id);

CREATE TABLE IF NOT EXISTS shared_note (
  scope TEXT NOT NULL, id TEXT NOT NULL, target_id TEXT NOT NULL,
  kind TEXT, author TEXT, created_at TEXT, resolved INTEGER DEFAULT 0,
  body TEXT NOT NULL,
  PRIMARY KEY (scope, id)
);
CREATE INDEX IF NOT EXISTS ix_sn_target ON shared_note(target_id);
```

The DB stays per-universe at `.codemap/codemap.db`, gitignored and rebuildable —
which is the correct shape for a materialized view and adds no durability risk,
because the sidecar git repo remains authoritative. A sidecar serves several
universes; each universe materializes only the scopes it reads.

Walkthroughs are deliberately omitted from this pass — they are read whole, by
PR, and gain nothing from a join. Add them only if a query appears that needs one.

## 5. What the reads become

The whole point, in one query — the shared-docs read that currently costs two
full anchor scans plus a re-fold:

```sql
SELECT v.node_id, v.version_id, c.anchor_id, a.body_hash
FROM shared_doc_citation c
JOIN shared_doc_version v USING (universe, version_id)
LEFT JOIN anchors a ON a.id = c.anchor_id AND a.ref = '@work'
WHERE c.universe = ?
```

`LEFT JOIN` because a missing anchor is the signal, not an error — a `NULL`
`body_hash` is `classifyCitations`'s `present: false`, and the `offTree` /
`retained` / `lost` refinement stays exactly where it is.

> **This join is the pre-provenance version.** It goes straight from citation to
> anchor row, so a miss is indistinguishable from an incompatible derivation and
> classifies as `lost` — claiming code is gone when the truth is that nobody can
> compare it. The order must be: **validate derivation → establish comparability →
> resolve anchor → classify absence or drift.** `ABSENT_HASH` is universally
> comparable only *after* anchor derivation compatibility is established, not
> before.

These hashes are the LAST INDEXED ones, not the current files. That is unchanged
by moving the join into SQL, and it is what `@work` has always meant on both sides
of the seam — but the new store API must not make it harder to see. In particular
a *confirmation* writes a durable claim, so it should re-index the cited files or
refuse when it cannot establish that `@work` describes the source. Separable from
materialization; tracked, not folded in.

Ack queue: `WHERE scope = ? AND needs_ack = 1`, indexed, instead of folding a PR
and filtering objects.

Findings on a symbol — a query that is impractical today and is the one an agent
most wants: `SELECT ... FROM shared_finding WHERE target_id = ?`, across every PR.

## 6. Consistency: one verdict

`evalVersion` (`store.ts:370`) becomes the single source of the document-level
status for both local and shared docs, and `sharedDocs` returns it alongside the
per-citation parts. `web/shared.js`'s `docFresh`, the CLI's equivalent, and
`needAttention` all delete their local re-derivations and read the field.

That is not a nice-to-have: it is what makes P1-5 impossible rather than fixed.
Three call sites synthesizing one verdict is a standing invitation for the fourth
to get it wrong.

The same move exposes shared knowledge to the ordinary surfaces. Once shared docs
and notes are rows next to the anchors, `outline`, `get_node`, `context`, `search`
and `find_gaps` can read them with a join instead of being blind to anything a
teammate synced. `find_gaps` reporting a gap a colleague documented last week is
the product's north star running backwards.

## 7. Sequencing

Each step is shippable and independently revertible.

**Order corrected twice.** An earlier draft finalized the schema before receipts
existed, which would have meant a second migration and would have kept the
`lost`-instead-of-`unverifiable` P1 alive on purpose in the interim.

**Then receipts were cancelled** (`docs/anchor-id-provenance.md`, landed): anchor
ids stay bare and their derivation evidence is the fingerprint on the body hash
minted beside them, which a materialized row already carries as a column. So the
dependency that pushed steps 4–5 behind the provenance work is gone. **Nothing in
0–5 is now blocked on provenance**; what changed instead is what steps 3a and 3b
have to do, below.

0. ~~**Split the pure folds out first.**~~ **DONE** — `doc-version.ts` holds the
   folds, the shared model types and version evaluation; `store.ts` sits above it
   owning SQLite. The cycle it exists to prevent is real and was load-bearing all
   through the provenance work. Without it, `store.ts` importing the folds closes a
   cycle against `shared-docs.ts`'s existing import of `winningVersionAt` — and this
   repo's import cycles fail with no diagnostic at all.
1. ~~**Tables, key, re-fold-on-miss, behind `store.ts`.**~~ **DONE** (`materialize.ts` +
   `shared-projections.ts`). No caller changes.
   *(Basic cache mechanics only — the table SHAPES wait for step 3a.)*
   The fold stays the authority and the view is rebuildable — which is *not* the
   same as correctness-irrelevant. A materializer bug returns wrong state, and
   "it's only a cache" is exactly the sentence that would stop someone testing it
   properly. What protects it is the equivalence test and transactional
   replacement, not its disposability: fold N random event sets directly and assert
   the projection matches, including after a late parent arrives and reorders the
   scope.
2. ~~**Point `ops-shared` reads at the store functions.**~~ **DONE** — it no longer
   imports `readDocs`, `readFindings` or `notesForTarget`. The trap was
   `SharedDoc.authors`: a `Map`, which `JSON.stringify` renders `{}` silently, so
   it and the version ORDER get columns.
3a. **Generation-based sharding and the sidecar-root lock.** ~~Profiles,
   generations, receipts.~~ **No receipt columns.** There are no receipts, and a
   materialized row does not need one: it already carries the body hash, and the
   derivation fingerprint rides inside that string. What the first schema does need
   is that the hash column is **stored whole** — never split into a bare digest for
   indexing convenience, which would throw away the annotation the join's fallback
   reads.
3b. **PARTLY DONE — the scans are gone; the join is not.** Both full scans are
   indexed lookups now (`workIndexFor`, `workHas`): 9.8ms x2 -> 0.93ms on a real
   4,983-anchor store, and the cost scales with the citations asked about rather
   than the repo. But that is an `IN` over ids parsed out of the citation JSON, NOT
   the §5 join through `shared_doc_citation`. That table is populated and indexed
   and **no production read consumes it** — so either §5's query lands, or the
   table should be deleted rather than left looking like an implemented join.
   The ref's derivations stay a separate DISTINCT — see the note in `workIndexFor`
   for why taking them from the matched rows is a bug, not an optimisation.

   **This looks like it contradicts the provenance conclusion, and does not — but
   only in one order.** That design's whole argument for leaving ids bare is that
   `WHERE anchor_id = ?` cannot call a comparison helper. It does not need to:
   `docs/anchor-id-provenance.md` §2 settles that the derivation gate is consulted
   *only after id equality fails*. So SQL does the equality join, which is the
   correct fast path on its own, and the **misses** — a small set, and the only rows
   whose absence has to be classified — go through `resolveAnchor` in JS afterwards.

   Write it the other way round, gating before joining, and you get a query that
   cannot express the predicate and a reimplementation of it in SQL that will drift
   from the one in `anchor-resolve.ts`. The seam is: **join by equality in the
   database, classify absence in the resolver.**
4. ~~**Single doc verdict from `evalVersion`;**~~ **DONE** — deleted the three re-derivations
   (`web/shared.js`'s `docFresh`, `ops-shared.ts`'s `needAttention`, the CLI).
   **Stronger now than when this was written.** Those three were merely duplicated
   then; they are now *behind*. `evalVersion` distinguishes an id this build could
   not have minted from a symbol that is gone, and none of the three does — so
   `ops-shared` labels an incomparable citation `lost` while `evalVersion` calls the
   same doc `unverifiable`. That is a live disagreement about one doc, not a
   latent one, and this step is its fix.
5. **Expose shared docs/notes through the ordinary read ops.** The consistency win.
   **STARTED.** `shared_doc_citation` is read (`docsCiting` — the reverse lookup,
   "does anybody's doc describe THIS symbol"), `docsByNode` parses only the matched
   nodes, and `ensureMaterialized` converges the rows without deserializing them.
   `get_anchor` carries `sharedDocs`; `find_gaps` no longer offers a symbol a
   teammate documented. Left: `outline`, `context`, `search`, and notes.
6. *(Separate decision)* Unify the **machinery** behind `Bug`/`SharedFinding` and
   `Annotation`/`SharedNote` — Actor and compatibility provenance, witnesses and
   freshness, threads and corroboration, external refs, the event envelope, one
   acknowledgement surface — while leaving the entities distinct. Their ratchets
   and shapes genuinely differ and merging them would flatten that. Not required by
   0–5; deferring it is not deferring the benefit.

Steps 0–1 pay for themselves; steps 3 and 4 are the ones the stated goals ask for.

### Authority: the outbox model (prerequisite for step 5, not part of it)

With a sidecar configured, **its local event log is authoritative for shared
entities from the moment of the write** — before any git sync. SQLite's shared
tables are projections of it and nothing else. Without a sidecar, today's local
behaviour is authoritative and none of this applies.

Local-only rows written before publication become an explicitly marked **pending
overlay**, not a second authority. Ordinary reads union the projection with
pending rows; a pending row disappears the moment its event materializes; a failed
publication stays visible as pending *with a warning* rather than vanishing or
silently masquerading as shared.

That makes exact deduplication the load-bearing requirement, and it is broken
today: `publishDocVersion` (`shared-docs.ts:149`) mints `"nv_" + mintId()`
unconditionally, discarding the caller's version id. So the same content has one id
locally and a different one on the sidecar, and nothing can tell the copies apart.

It also stamps `createdAt: new Date().toISOString()`, which `publishLocalDocs`
never overrides — so backfilling a node's history rewrites every version's
authorship time to the moment of migration. `selectWinner` (`store.ts:402`)
tiebreaks equal-badness versions on `createdAt`, so after a backfill that tiebreak
ranks by *publication* order rather than authorship. It happens to agree while the
backfill iterates in order, which is exactly the kind of accident that survives
until someone republishes.

**Publication must preserve the source version id and the original `createdAt`.**
Both are one-line changes and both are prerequisites for the overlay to work.

For concurrent docs: two independently written versions coexist. If both are
equally fresh against the same code and their content differs, that is
**contested**, and should surface as such rather than resolving to the newest
timestamp. Findings already have `contested` for precisely this; docs have no
equivalent, and inventing a silent winner is the failure the finding model was
built to avoid.

**Completeness.** Sync materializes every changed scope for the universe, rather
than each query materializing what it needs. It is bounded by what the pull brought,
and it makes completeness a property of the store instead of a contract every query
must remember — a cross-PR query like `WHERE target_id = ?` would otherwise return
only the warmed scopes and look total. The store must also distinguish
"materialized and empty" from "never materialized" and say which, rather than
answering zero rows to both.

**What this does not close.** Steps 0–5 cover materialization, one doc verdict, and
ordinary read visibility for findings, docs and notes. They do not close the whole
authoritative-store finding: shared doc EDGES have no events or table, Bugs and
triage stay local, `finding.assigned` still has no writer, and walkthroughs and
inbound replies stay outside the ordinary PR read. Staging those deliberately is
fine; claiming materialization as their completion is not.

## 8. What this deliberately does not do

- **It does not move the source of truth.** Events stay in the sidecar git repo.
  The DB can be deleted at any time and rebuilt from them.
- **It does not make the fold incremental.** See §2. Anyone who "fixes" that has
  reintroduced the accumulator.
- **It does not by itself fix the same-principal-two-machines hole** in
  `causality()`, nor add a lock. Both are now steps 3a/3b of the plan above rather
  than out of scope, because `PROPOSAL-provenance.md` made them prerequisites of
  the final schema — but neither is delivered by materialization, and steps 0–1 do
  not wait for them.

## 9. Open questions for review

1. ~~Convention or physical enforcement for cache-not-accumulator?~~ **Closed by
   §10: physical.** One transactional `replaceScope(scope, fingerprint, rows)`, no
   per-row API, scope ownership on every table so replacement cannot orphan
   citation edges.
2. ~~Fingerprint or lock?~~ **Closed: both, for different jobs.** The fingerprint
   sees uncommitted and externally appended events, which a git sha cannot; the
   lock protects one clone's mutable index, merge state and commits, which the
   fingerprint cannot. Neither substitutes for the other, and the
   fingerprint–fold–refingerprint loop stays the cache protocol.
3. ~~Should `needs_ack` and `contested` be stored columns at all?~~ **Closed by
   §10: yes**, and for the reason that resolves the `Disposition` worry — under
   physical enforcement nothing but a whole-scope replacement can write them, so
   they are projection output rather than state a writer may update.
4. ~~Does anything need the shared fold without a universe DB?~~ **Closed by §10:
   no.** The scenario tests keep their coverage through the pure folds or an
   in-memory materializer (`node:sqlite` takes `:memory:`); a DB-free production
   path would preserve the second read implementation this exists to remove.
5. ~~Entity unification — worth doing at all?~~ **Closed: unify the machinery,
   keep the entities.** `Bug`/`SharedFinding` and `Annotation`/`SharedNote` have
   genuinely different ratchets and shapes, and merging them would flatten that.
   What should be shared is the plumbing: Actor and immutable compatibility
   provenance, witnesses and freshness evaluation, threads and corroboration,
   external references, the event envelope and materialization, and one combined
   acknowledgement surface. That is the original proposal's direction, correctly
   read — step 6 is rewritten accordingly.
6. ~~Does `HASH_SCHEME` belong in the cache key?~~ **Closed: no — and neither does
   `ANCHOR_SCHEME`.** See §3; one criterion covers both, and my answer last round
   was wrong in the other direction.
7. ~~Authority and merge semantics for local plus shared rows.~~ **Closed: the
   outbox model in §7.** What replaces it as the largest open item is below.
8. ~~Immutable producer provenance, plus derivation receipts.~~ **Moved to
   `PROPOSAL-provenance.md`, and then RESOLVED there and in
   `docs/anchor-id-provenance.md`: receipts are cancelled.** Ids stay bare; the
   evidence is the fingerprint on the hash beside them. No step here is blocked on
   it any more — see §7, where 3a lost its receipt columns and 3b gained the
   equality-join-then-classify rule.
9. ~~`comparableHashes` fails OPEN on an unparseable hash.~~ **Fixed in `6d4c40d`.**
   `hashSchemeOf` returns `number | null` and requires the whole form; an
   unparseable value is comparable to nothing, including another unparseable one.

---

# Review history (ARCHIVE — not normative)

**Everything below is a transcript of four review rounds, kept for its reasoning
and preserved verbatim. It contains SUPERSEDED designs.** In particular §13's
receipt shape carries `anchorScheme` / `hashScheme` / `grammar` fields that were
later replaced by a `DerivationRef` pointing at a content-addressed profile, and
several recommendations were revised by the round that followed them.

Where the archive and §§0–9 disagree, §§0–9 win. Where §§0–9 and the provenance
documents disagree about provenance, those win — and for anchor ids specifically
that is `docs/anchor-id-provenance.md`, which supersedes `PROPOSAL-provenance.md`
§5 and cancels both receipt shapes. **Every mention of a receipt below this line is
superseded**, including §13's shape and the `DerivationRef`/profile revision of it.
Do not implement from anything below this line.

## 10. Open questions/revisions

Review agrees with the materialized-cache direction: events remain authoritative,
the DB is disposable, and a changed scope is re-folded and replaced wholesale.
The following points need revising or deciding before implementation.

### A late event can reorder events already folded

The stronger claim in §2 — that a late arrival only inserts and never reorders
existing events — is false when the late event is a missing causal parent. For
example:

```text
B  id=1  after=A     # A is not present yet
C  id=2  independent

sort(B, C) = B, C

A  id=3  arrives later
sort(A, B, C) = C, A, B
```

B and C reversed relative order. This is an honest shape under cross-machine
clock skew: B's writer had seen A, but A's id can still sort after B's. The
property test added with this proposal does not generate this case; its new event
is independent or a child of an event already present, never a missing parent
already named by an existing event.

This does **not** weaken the proposed materialization rule. It strengthens its
rationale: any change to the input set may reorder the scope, so the only safe
operation is still to re-fold the complete scope and atomically replace its rows.
The insertion-only claim and test should be replaced with an equivalence test:
after arbitrary additions, including a newly supplied missing parent, the
materialized rows must equal a fresh direct fold of the complete set.

### Define when a materialized view is complete

“Each universe materializes only the scopes it reads” is sufficient for a known
PR or a known note target, but not for the proposal's cross-PR query
`shared_finding WHERE target_id = ?`. It would return only warmed PR scopes and
silently omit the rest. Ordinary `search`, `outline`, and `find_gaps` have the
same completeness problem if their shared doc/note scopes have not previously
been visited.

The implementation needs an explicit policy:

- sync/startup enumerates and materializes every changed scope belonging to the
  universe; or
- a query materializes every scope required by its completeness contract before
  answering.

Known-target notes can derive one bucket. Universe docs have one known scope.
Cross-PR findings require enumerating that universe's PR scope directories.

### Define authority and merge semantics for local plus shared rows

Materialization makes shared rows queryable; it does not by itself decide how
they combine with existing local state. Before step 5, specify:

- whether local `node_versions` and `shared_doc_version` participate in one
  version selection set;
- how a locally published version is recognized after the sidecar remints its
  version id, so it is not presented twice;
- whether ordinary `document()` and annotation writes automatically emit or
  mirror sidecar events;
- what a local unsynced version means after a shared version arrives; and
- which path is authoritative for writes versus merely a local pending overlay.

Without this, ordinary reads can see two stores but still have no single semantic
answer.

### The cache key needs more than scope file metadata

The fingerprint must also include:

- a `MATERIALIZER_VERSION`, bumped whenever fold or projection semantics change;
- the resolved sidecar identity, so switching sidecar repositories cannot reuse
  rows from the previous one; and
- the universe qualification used for the scope.

Otherwise unchanged shard metadata after a code upgrade can keep rows produced
by an older fold indefinitely. Filename/size/mtime is a pragmatic invalidation
signal, but it is not literally the input set; the document should describe that
tradeoff without claiming content-addressed equivalence.

Fingerprint before folding, fold, fingerprint again, and retry if it changed.
That closes the ordinary append-during-fold race. The row replacement and the
stored fingerprint must commit in the same SQLite transaction.

### Enforce one replacement path physically

The answer to open question 1 should be yes: expose one transactional
`replaceScope(scope, fingerprint, rows)` operation and no per-event/per-row
mutation API. Delete the scope's prior projection, insert the complete new fold,
and update `shared_scope` atomically. Every materialized table should carry scope
ownership, preferably with foreign keys/cascade semantics, so replacement cannot
leave stale versions or citation edges behind.

Storing `needs_ack` and `contested` as indexed columns is acceptable under this
rule. They are disposable projection columns recomputed by the fold, not state
that any writer may update independently.

### Avoid introducing a dependency cycle around `store.ts`

Today `shared-docs.ts` imports `winningVersionAt` from `store.ts`. If `store.ts`
imports the shared folds to materialize them, the new seam becomes a cycle. Move
pure event folds, shared model types, and document evaluation into a lower,
storage-free module. `store.ts` should own SQLite persistence and queries; the
pure folds should remain usable by property/scenario tests without creating a
second production read implementation.

A DB-free production path is not required merely because unit tests use bare
sidecar directories. Pure fold tests or an in-memory SQLite materializer preserve
that coverage without preserving two authorities.

### `@work` still means last indexed, not current filesystem source

The correction in §1 is valid: cached `@work` hashes are a design-wide behavior,
not a divergence unique to shared docs. Moving the join into SQL does not change
that behavior. The proposal should therefore avoid calling the joined hashes
“live” without qualification.

In particular, a confirmation operation makes a durable claim. It should
re-index the cited files first, or refuse when it cannot establish that `@work`
describes the current source. This is separable from materialization, but the new
store API should not accidentally make the cached-hash meaning harder to see.

### Scope of the P1 closure

Steps 1–5 resolve materialization, shared-doc verdict consistency, and ordinary
read visibility for the entities they cover. They do not yet close the whole
authoritative-store finding from the static review:

- shared doc edges have no sidecar events or materialized table;
- Bugs and triage remain local;
- `finding.assigned` still has no writer;
- shared walkthroughs and inbound replies remain outside the ordinary PR read;
  and
- the normal shared write path remains to be defined above.

Those may be staged deliberately. The implementation should claim the narrower
closure explicitly and keep the remaining work tracked, rather than treating
materialized rows alone as completion of the original P1.

---

## 11. Response to review (§10)

Every point in §10 is accepted. Six are folded into the sections above; the rest
are recorded here with what changes and what is still open. One addition the
review did not raise is at the end, and it is the one I would most like a second
opinion on.

### Accepted and already applied

**The reorder counterexample.** Verified, and §2 is rewritten around it. The false
property test is deleted; `eventlog.test.ts` now pins the counterexample directly
and asserts the true property — fold order is a function of the event set alone —
with forward references deliberately generated. Confirmed it fails when
`sortEvents` is made order-dependent. (It does *not* catch the single-greedy-sweep
regression; the older hand-built `sorting is deterministic` test does. Complementary,
so both stay.)

**The `@work` naming.** §5's join comment stops calling the joined hashes "live".
The separate point — that a *confirmation* makes a durable claim and should
re-index the cited files or refuse — is right and is now the one place where the
cached-hash meaning has real consequences. Tracked as its own item rather than
folded in, because it changes behaviour and is separable from materialization.

**`replaceScope` enforced physically.** Open question 1 is closed: one transactional
`replaceScope(scope, fingerprint, rows)`, no per-row API, scope ownership on every
materialized table so replacement cannot orphan citation edges. Which also closes
open question 3 — `needs_ack` and `contested` are fine as indexed columns precisely
*because* nothing but a whole-scope replacement can write them. They are projection
output, not state.

**The cache key.** §3 was under-specified and slightly dishonest. Adding
`MATERIALIZER_VERSION`, the resolved sidecar identity, and the universe
qualification; and dropping the implication that a filename/size/mtime fingerprint
is the input set. It is a change *signal*, not a content address, and the document
should say so plainly.

The fingerprint–fold–refingerprint–retry loop is right and I had missed the
append-during-fold race entirely. Worth noting what falls out of pairing it with a
deterministic fold: if two processes re-fold the same scope concurrently, they
compute the same rows, so last-writer-wins inside one transaction is benign rather
than a race to be prevented. That is a reason the design tolerates having no
sidecar lock, and it should be stated rather than left as luck.

**Scope of the P1 closure.** Agreed, and steps 1–5 should say so. The remaining
items — shared doc edges, Bugs and triage, `finding.assigned`'s missing writer,
walkthroughs and inbound replies outside the ordinary PR read — stay tracked as
open, not folded into "materialization done".

### Accepted, and they change the plan

**Completeness policy.** A real gap: "each universe materializes the scopes it
reads" cannot answer `shared_finding WHERE target_id = ?` across PRs, and would
silently return only the warmed scopes. Silently is the problem — a partial answer
that looks total is worse here than a slow one.

Of the two options offered I lean to the first: **sync materializes every changed
scope for the universe**, enumerating the scope directories. It is bounded by what
the pull actually brought, it is one `readdir` plus the scopes that moved, and it
makes completeness a property of the store rather than a contract each query must
remember to honour. Per-query materialization puts the obligation in the place
most likely to forget it, and the failure mode is invisible.

Neither option covers a scope nobody has ever synced. So the store also needs to
know the difference between "materialized and empty" and "never materialized", and
say so, rather than returning zero rows.

**The dependency cycle.** The sharpest catch, and verified: `shared-docs.ts:31`
imports `winningVersionAt` from `store.ts` today, so `store.ts` importing the folds
closes a loop. This repo has already been bitten by import cycles in a way that
produces no diagnostic at all — see the blank-page failures in the web UI — so it
is worth avoiding structurally rather than watching for.

So: a lower, storage-free module holding the pure folds, the shared model types,
and version evaluation, with `store.ts` above it owning SQLite only. That also
answers open question 4 better than I did. A DB-free *production* path is not
needed to keep the scenario tests honest — they can exercise the pure folds, or an
in-memory SQLite materializer (`node:sqlite` takes `:memory:`) — and keeping one
would preserve exactly the second read implementation this proposal exists to
remove.

**Authority and merge semantics for local plus shared rows.** Accepted as stated,
and it is the largest remaining unknown. Making rows queryable does not decide what
they mean together, and step 5 waved at this. All five sub-questions need answering
before step 5 is designed, not during it. I would add a sixth: what a *conflict*
between a local version and a shared one looks like to a reader — the sidecar has
`contested` for exactly this on findings, and docs have nothing equivalent.

### One addition: the anchor schemes belong in the cache key

`MATERIALIZER_VERSION` covers fold and projection changes. It does not cover the
thing the materialized rows are keyed *against*.

`shared_doc_citation.anchor_id` and `shared_finding.target_id` are anchor ids, and
`CLAUDE.md` already carries the invariant that changing how an id is derived bumps
`ANCHOR_SCHEME`. After such a bump, the anchor table is rewritten with different
ids while every shard is byte-identical — so the fingerprint is unchanged, the
scope is not re-folded, and every materialized citation edge now joins to nothing.
The symptom is an entire universe's shared docs reading as `lost` for a reason
having nothing to do with the code, which is the same false-staleness class the
scheme numbers were introduced to prevent.

`HASH_SCHEME` has the milder version of this: ids survive, but `body_hash`
comparisons cross a derivation boundary, which is already handled by
`comparableHashes` at read time and so probably needs nothing in the key.

The precedent is right there — `snapshots` already carries a `scheme` column, and
a snapshot written under another value reads as NOT CACHED. The materialized scopes
should do the same with `ANCHOR_SCHEME`. Worth a second opinion on whether
`HASH_SCHEME` genuinely stays out.

---

## 12. Response to review, round 2

Accepted in full, and one of the corrections lands on something I contributed last
round rather than on the original draft.

### The `ANCHOR_SCHEME` correction goes further than stated

The point made — that including `ANCHOR_SCHEME` in the cache key is *necessary but
not sufficient*, because historical events still carry old-scheme ids and
re-folding reproduces them — is right, and following it through says the key does
not need it **at all**.

Re-folding after a scheme bump produces byte-identical rows: the projection stores
ids copied verbatim from events, and the join to `anchors` happens at read time. So
invalidating on the scheme buys nothing and costs a rebuild — which is exactly the
argument made for keeping `HASH_SCHEME` out. One criterion covers both, and §3 now
carries it: *a scheme belongs in the key iff the projection stores something
derived from the anchors table.* Today nothing is.

I have withdrawn my own addition rather than leaving it standing with a caveat, and
recorded the trap it exposes: §6's single doc verdict must be computed at read time.
Store it as a column and both scheme numbers re-enter the key, silently, because the
rows would still look well-formed.

What the scheme problem actually needs is what was said: **immutable per-event or
per-writer-generation compatibility provenance**, so a reader on scheme 2 can tell
that an event's target id was minted under scheme 1 and report it `unverifiable`
rather than `lost`. That is the same shape as the `HASH_SCHEME` → `unverifiable`
work already landed for review marks and doc status, and it is the same defect the
static review filed as P1 *"compatibility metadata is mutable and relabels
historical events"* — the manifest is per-principal and overwritten in place, so a
writer's upgrade silently relabels their own history. One fix, two findings. It is
now open question 8, and the largest remaining item after authority.

### Verified while writing up the outbox model

Two things that strengthen the dedup requirement, both checked rather than assumed:

- `publishDocVersion` (`shared-docs.ts:149`) mints `"nv_" + mintId()`
  unconditionally and discards the caller's version id. The same content therefore
  has one id locally and another on the sidecar, so exact deduplication is not
  merely unimplemented — it is currently impossible.
- It also stamps `createdAt: new Date()`, which `publishLocalDocs` never overrides.
  Backfilling a node rewrites every historical version's authorship time to the
  migration moment, and `selectWinner` (`store.ts:402`) tiebreaks equal-badness
  versions on `createdAt` — so that tiebreak silently becomes publication order.
  It agrees with authorship order only because the backfill happens to iterate in
  order, which is the kind of accident that survives until the first republish.

Both are one-line fixes and both are prerequisites for the overlay, so they are
named in §7 rather than left to be discovered during step 5.

### On "a bug here is slow, not wrong"

Fair, and worth more than a wording fix. That sentence would have discouraged
exactly the testing the design depends on — a confident claim of harmlessness
raises the reader's prior that the thing below it is safe, which is how a wrong
comment ends up protecting the bug it sits on. §7 now says the view is rebuildable,
that rebuildable is not correctness-irrelevant, and that what protects it is the
equivalence test and transactional replacement.

### Remaining

With 2, 5, 6 and 7 closed, the open list is: immutable compatibility provenance (8,
now the prerequisite), grammar identity's absence from hash comparability, and the
implementation of the outbox semantics themselves. The first two are both really
"the event envelope does not record enough about how it was derived", which suggests
they should be designed together rather than separately.

---

## 13. Response to review, round 3

The core correction is accepted and it reframes the whole item: **an event's
profile describes its producer, not the derivation of every value it carries.**

Verified against the code. `publishLocalDocs` (`ops-shared.ts`) iterates
`loadNodeVersions` and re-emits each historical version, `citations` and their
`acceptedHashes` included. Those hashes were minted under whatever scheme was
current when somebody confirmed them, sometimes years earlier. Stamp that event
with today's profile and it asserts they were derived today — which is the mutable
manifest defect exactly, one level further down, and now reachable through an
ordinary migration rather than only through an upgrade.

So: producer provenance on the envelope, derivation receipts on the values, and
copied values keep their original receipts. Unknown legacy provenance stays
explicitly unknown.

### The two receipts are not symmetric

Worth knowing before implementing, because it changes what each has to carry.

**Hashes already self-describe their scheme.** `hashTokens` stamps
`h<scheme>:sha256:…` (`normalize.ts:49`) and `hashSchemeOf` reads it back, which is
the entire reason `comparableHashes` works across a bump without any side table.

**Anchor ids do not.** `anchorId` is `"a_" + sha256(file \0 symbolPath \0
disambiguator).slice(0,16)` (`schema.ts:177`) — no marker, no way to tell a
scheme-1 id from a scheme-2 one by looking at it. `AnchorReceipt.anchorScheme` is
therefore load-bearing in a way `HashReceipt.hashScheme` looks redundant.

**But keep `hashScheme` on the receipt anyway**, for a reason that argues against my
own first instinct here: scheme 1 is encoded as the ABSENCE of a prefix
(`schemePrefix` returns `""` for 1), so in-band encoding cannot distinguish "scheme
1" from "not a hash at all". That is a fail-open, and it is live:

```
hashSchemeOf("garbage")                      -> 1
comparableHashes("garbage", "h2:sha256:aa")  -> false   (safe: unverifiable)
comparableHashes("garbage", "sha256:aa")     -> true    (compared, mismatched, STALE)
```

A malformed value produces a confident `stale` against any scheme-1 hash. An
explicit receipt field cannot be spoofed by absence, which is exactly the
fail-closed property asked for. Filed as open question 9; the immediate two-line
version is to make an unparseable hash answer `unverifiable` rather than scheme 1.

Both receipts need `grammar` regardless, since neither the id nor the hash string
encodes it.

### Grammar identity as an exact digest is cheap here

The blobs are vendored and committed on purpose, so the digest is already sitting
in the repo:

```
tree-sitter-c_sharp.wasm       6f69e1cae44e1c32
tree-sitter-javascript.wasm    5fb488d0cabb4775
tree-sitter-python.wasm        16108b50df4ee9a3
tree-sitter-tsx.wasm           79e5da75ea62855a
tree-sitter-typescript.wasm    778025db5a8be0e7
```

Five sha256 prefixes computed at startup, or baked in at build and checked. No new
dependency, no registry, no version-label negotiation — and `grammars/PROVENANCE.md`
already records where each came from, so half the mapping exists.

### One field, not two: fold the profile into the writer generation

`writerGeneration` must stay distinct from the profile *as a concept* — two
machines on identical schemes still need separate writer identities for causality.
Agreed. But they need not be two fields on the wire.

Define a generation as **(machine identity, compatibility profile)**, so an upgrade
that changes any derivation-affecting value starts a new generation by definition.
Then the event carries one short id, the generation record carries machine identity
and profile, and the profile is content-addressed and immutable as proposed. Two
machines on the same profile still get distinct generations, which was the point.

Generation churn stays low because the profile holds only derivation-affecting
parts — schemes and grammar digests — not the release version. Re-vendoring a
grammar is rare; shipping a release is not.

### Then shard by generation, not by principal

This is the part I would most like challenged, because it makes an existing hole
disappear rather than patching it.

`readScope` dedupes by id today, and its comment says exactly why: *"`merge=union`
can legitimately produce the same line twice: it is the case sharding does not
cover, one person appending from two machines."* That same case is the hole in the
causality vector — `ownLast` fabricates a causal edge between two genuinely
concurrent writes by one person, which is recorded in `eventlog.ts` as a known
limitation.

Shard by generation and one person on two machines writes two files. No union merge
of anyone's shard, so no dedup case; prefix-closure per writer becomes true rather
than assumed; and the vector's premise is sound instead of nearly-sound. Attribution
and independence keep using `principal`, unchanged.

Cost is shard count: generations × scopes rather than principals × scopes. Bounded
by machines and by rare profile changes, so it stays far from the file-count problem
the bundling design exists to avoid — but it is the honest tradeoff and it should be
stated when this is written up.

### Receipt columns do not re-open the cache key

Materialized rows carrying receipt/profile columns is right, and it is worth
confirming it does not undo §3: those columns are copied verbatim from events, like
the anchor ids beside them, so nothing in the projection becomes anchors-derived.
The criterion holds and both scheme numbers stay out of the key. The receipts are
in fact what lets read-time SQL refuse an incompatible join *without* invalidation.

### Migration

Agreed that append-only history means old incompatible events are there forever, so
gating must degrade rather than block. Two precedents already exist and should be
reused rather than reinvented: anchors that leave the tree are retained under
`@orphan` and reported by `codemap orphans`, and the finding model already has
relocation events that re-point a citation as a person's act. A current-profile
re-witness or relocation is the migration path; the incompatible original stays
readable and explicitly unverifiable.

### Where this leaves the document

The remaining design is now larger than the proposal that surfaced it, and it
resolves at least five separately-filed problems — mutable manifests, grammar
comparability, same-principal writer separation, legacy attribution, and cross-scheme
read behaviour. It should become its own document rather than open question 8 of
this one. This proposal's steps 0–5 do not depend on it; step 6 and the outbox
model's *semantic* deduplication do.
