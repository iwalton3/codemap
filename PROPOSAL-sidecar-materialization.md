# Proposal: materialize the sidecar fold into SQLite, behind `store.ts`

Status: **draft for review.** Written in response to the `store.ts`-seam finding in
`COLLABORATION-STATIC-REVIEW.md`, and to two goals stated more narrowly than that
finding did: **consistency** and **performance**.

Reviewed against `worktree-shared-review-hashscheme` at `54da307`.

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
           + ANCHOR_SCHEME             -- the rows are keyed BY anchor id; see below
           + resolved sidecar identity -- so pointing at another sidecar cannot reuse rows
           + universe qualification
```

The file half is a change **signal**, not a content address: it does not identify
the input set, it detects that the input set moved. Everything else in this
document assumes only the latter, but the distinction should not be blurred.

`ANCHOR_SCHEME` is in the key because the materialized rows store anchor ids
(`shared_doc_citation.anchor_id`, `shared_finding.target_id`). A scheme bump
rewrites the anchor table with different ids while every shard stays
byte-identical — unchanged files, no re-fold, and every citation edge now joins to
nothing. `snapshots` already carries a `scheme` column for exactly this, and one
written under another value reads as NOT CACHED.

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

0. **Split the pure folds out first.** A storage-free module holding the folds,
   the shared model types, and version evaluation; `store.ts` above it owning
   SQLite only. Without this, `store.ts` importing the folds closes a cycle against
   `shared-docs.ts`'s existing import of `winningVersionAt` — and this repo's
   import cycles fail with no diagnostic at all.
1. **Tables, key, re-fold-on-miss, behind `store.ts`.** No caller changes.
   The fold stays the authority; the view is pure cache, so a bug here is slow, not
   wrong. Ship with an equivalence test: fold N random event sets directly and
   assert the view matches, including after inserting a late event.
2. **Point `ops-shared` reads at the store functions.** `ops-shared` becomes thin,
   which is what it should have been.
3. **Lift the citation edges and do the anchor join in SQL.** Delete `liveHashes`
   and the `Set`-of-everything in `classifyCitations`. This is the performance win.
4. **Single doc verdict from `evalVersion`;** delete the three re-derivations.
5. **Expose shared docs/notes through the ordinary read ops.** The consistency win.
6. *(Separate decision)* Unify `Bug`/`SharedFinding` and `Annotation`/`SharedNote`,
   per the original proposal's Decision 5. Not required by 1–5 and much riskier —
   the shapes genuinely differ (corroboration, contest residue, agent ratchet vs
   severity/witness/status). Deferring it is not deferring the benefit.

Steps 0–1 pay for themselves; steps 3 and 4 are the ones the stated goals ask for.

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
- **It does not fix the same-principal-two-machines hole** in `causality()` —
  `readScope` dedupes because one person can append from two machines, those writes
  are not causally related, and `ownLast` fabricates an edge between them. That
  needs a per-writer generation id in the event format and is orthogonal to where
  the fold is stored.
- **It does not add a lock.** The fingerprint makes the *cache* correct across
  processes; it does not serialize two processes doing git operations on one
  sidecar clone. That is a separate fix.

## 9. Open questions for review

1. ~~Convention or physical enforcement for cache-not-accumulator?~~ **Closed by
   §10: physical.** One transactional `replaceScope(scope, fingerprint, rows)`, no
   per-row API, scope ownership on every table so replacement cannot orphan
   citation edges.
2. Is the file fingerprint the right change signal, or should the sidecar get a
   real lock first and use a git sha? The fingerprint works without the lock, which
   is why I chose it, but it is the weaker guarantee. §3 now argues the determinism
   of the fold makes the missing lock tolerable *for the cache*; that argument does
   not extend to the git operations themselves.
3. ~~Should `needs_ack` and `contested` be stored columns at all?~~ **Closed by
   §10: yes**, and for the reason that resolves the `Disposition` worry — under
   physical enforcement nothing but a whole-scope replacement can write them, so
   they are projection output rather than state a writer may update.
4. ~~Does anything need the shared fold without a universe DB?~~ **Closed by §10:
   no.** The scenario tests keep their coverage through the pure folds or an
   in-memory materializer (`node:sqlite` takes `:memory:`); a DB-free production
   path would preserve the second read implementation this exists to remove.
5. Step 6 (entity unification) — worth doing at all, or is the materialized view
   the right permanent bridge between two genuinely different entities?
6. **Does `HASH_SCHEME` belong in the cache key alongside `ANCHOR_SCHEME`?** My
   reading is no: ids survive a hash-scheme bump, and `comparableHashes` already
   draws the boundary at read time. But it is the same class of mistake as leaving
   `ANCHOR_SCHEME` out, and I would rather be told than assume.
7. Authority and merge semantics for local plus shared rows (§10). The largest
   remaining unknown, and a prerequisite for step 5 rather than part of it —
   including what a *conflict* between a local and a shared version looks like to a
   reader. Findings have `contested` for this; docs have nothing equivalent.

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
