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

### The measured property

I property-tested `sortEvents` over 4,000 random event DAGs (4 principals, 12
events, 0–2 `after` parents each, random ids), inserting one late event into each:

```
trials=4000   reorderings=0   late-event-landed-before-the-end=3515
```

**A late arrival never reorders events already folded. It only inserts.** That is
the guarantee the design rests on, and it is now pinned in `eventlog.test.ts`
rather than left as a claim here.

Worth knowing how strong it is: it is *entailed* by the existing determinism
guarantee, not independent of it — it follows from "repeatedly take the lowest
eligible id" over an immutable parent relation. I tried to falsify it twice
(reversing the id tiebreak; the single greedy sweep `sortEvents`' own comment warns
against) and both mutations broke `sorting is deterministic regardless of input
order` while leaving the new test green. So the design is resting on something
structural, which is the good news, and the new test is a named citation rather
than the real guard, which is the honest caveat.

The second number matters more for design than the first: the late event landed
somewhere other than the end **88% of the time**. Real traffic is better behaved
than random ids — a writer's own events are monotonic — but any teammate working
concurrently produces exactly this shape. So:

> **Do not design around "append to the end" being the fast path.** It is not the
> common case, and a design that treats mid-sequence insertion as the exception
> degrades to re-folding almost every time.

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

### The three arrival regimes, named

1. **In order** — the event sorts after everything folded. Still a scope re-fold,
   by the rule above. Cheap.
2. **Late (insertion)** — sorts before the head. Scope re-fold. Deterministic, so
   the result equals what every other machine computes from the same set.
3. **Incomplete** — you hold B but not A, because A is still on somebody's laptop.
   The fold is still well-defined; it is a fold of what you have. The causal vector
   already encodes who had seen what, so contests are detected correctly. This is
   not an error state and must never be reported as one.

## 3. Invalidation

Not git. A per-scope fingerprint of its shard files:

```
fingerprint(scope) = sorted [ (filename, size, mtime_ns) ] over scope/*.ndjson
```

Stored on the scope row; re-stat on read. A scope has one file per teammate, so
this is a handful of `stat` calls — microseconds — and it is correct across
processes, which matters because the static review's P2 *"one sidecar clone has no
lock shared by web, MCP, CLI"* is true: the HTTP path takes no lock, MCP locks the
universe rather than the sidecar, and CLI sync takes none. A git-sha watermark
would miss another process's uncommitted append; a file fingerprint does not.

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

1. **Tables, fingerprint, re-fold-on-miss, behind `store.ts`.** No caller changes.
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

Step 1 alone pays for itself; steps 3 and 4 are the ones the stated goals ask for.

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

1. Is the cache-not-accumulator rule strong enough as a convention, or should the
   view tables be physically prevented from partial update (e.g. every write goes
   through one `replaceScope(scope, rows)` function, as `replaceAnchors` already
   does for anchors)? I lean to the latter.
2. Is the file fingerprint the right key, or should the sidecar get a real
   lock first and use a git sha? The fingerprint works without the lock, which is
   why I chose it, but it is the weaker guarantee.
3. Should `needs_ack` and `contested` be stored columns at all? They are derived,
   and storing derived state is how the `Disposition` enum went wrong. The argument
   for is that they are recomputed wholesale on every re-fold and never mutated —
   the same status `evalVersion` gives docs. The argument against is precedent.
4. Does anything need the shared fold *without* a universe DB? `readFindings` today
   works against a bare sidecar path with no `.codemap` anywhere — the scenario
   tests rely on it. Keeping a DB-free path means keeping two implementations,
   which is the thing this proposal exists to reduce.
5. Step 6 (entity unification) — worth doing at all, or is the materialized view
   the right permanent bridge between two genuinely different entities?
