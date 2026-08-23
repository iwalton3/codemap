# Handoff — `worktree-shared-review-hashscheme`

Written at `bec6d1e`; updated at `0499657` after another session and two review
rounds. Everything below is committed and green (573 tests, `tsc -p .` and
`tsc -p web` both clean). Read this, then the two documents it points at; do not
read the whole branch history.

## What to run

```sh
npx tsc && npx tsc -p web
node --no-warnings --test --test-concurrency=1 "dist/**/*.test.js"
```

**Use that rather than `npm test`.** `npm test` runs the same three commands and
stalls intermittently under the agent harness. Two separate bisects blamed code for
it and both were wrong. **A run that blocks with near-zero CPU is a wait, not work
— check what else is running before suspecting the diff.**

The stall was caught in the act once and is worth writing down, because it rules
things out:

- It lands on `dist/pr-ingest.test.js`, and that file's seven tests have all PASSED
  when it happens. The child process simply never exits; its event loop is idle in
  `epoll_wait` and every libuv worker is parked.
- It is not SQLite at exit. `db()` caches connections and never closes them, so a
  test process ends holding a dozen WAL databases on deleted files — a plausible
  culprit, and refuted: 40 of them open and delete in 0.24s with a clean exit.
- It is load-dependent and does not reproduce on demand. Three stale runs from
  earlier sessions were still alive and wedged at the same file; killing them and
  running two full suites concurrently, with and without `--test-concurrency=1`,
  came out green all four times.

- **It is the channel between parent and child, not either end's work.** Caught
  twice, from both sides: once with the child alive and idle in `epoll_wait` after
  passing every test, once with the child already EXITED and the parent idle in
  `epoll_wait` still holding its three stdio sockets. Killing the wedged process
  unblocks the run — the parent moves straight to the next file and finishes
  normally; only the killed file's results are lost (it reports as one failed
  FILE, with no failing test inside it).

So: nothing in this tree, and nothing you can bisect. Kill leftovers by pid first
(`ps -eo pid,pcpu,etime,args | grep test-concurrency`), and if a run parks on one
file at 0% CPU, kill that child and re-run the file on its own.

## The two arcs that landed

### 1. Anchor-id provenance — `docs/anchor-id-provenance.md`

The finding: **anchor ids are derived from the tree-sitter parse**, so two builds
mint different ids for the same symbol. §1 has a runnable proof (two C# grammars,
one `ANCHOR_SCHEME`, different ids for `M(ref string)`).

`AnchorReceipt` was designed over three review rounds and then **cancelled**: the
derivation evidence an id needs is already on the body hash minted beside it. Ids
stay bare. The work was join-side, and it is done: `resolveAnchor`
(`src/anchor-resolve.ts`) answers found / absent / **incomparable**, and every site
that used to write `live.get(id) ?? ABSENT_HASH` consumes it.

Two rules that are easy to get backwards, both learned by getting them wrong:

- **The operand is the index being searched, not the running build.** `liveHashes`
  with no ref re-parses in process, so the operand is this build; `@work`,
  snapshots and `hashesAt` are stored rows, so it is the rows' own derivations.
- **An index with no tags rules nothing out.** An empty ref, or one whose matched
  rows happened to be empty, must fall back — otherwise every absence reads
  `incomparable` exactly when it is most likely a real deletion.

### 2. Sidecar materialization — `PROPOSAL-sidecar-materialization.md`

Steps 0, 1, 2, 3b and 4 landed; §7 marks them. `materialize.ts` owns the cache key
and the transaction and knows nothing about what it caches (the fold is a
**parameter**, to avoid the storage/fold import cycle); `shared-projections.ts`
knows the entities and nothing about when they fold.

Receipts being cancelled means **nothing in 0–5 is blocked on provenance any more**.
§7 was rewritten to say so, and to record the one thing that reads as a
contradiction and is not: 3b's "do the anchor join in SQL" versus provenance's
"`WHERE anchor_id = ?` cannot call a helper". Both hold, in one order —
**equality join in the database, classify the misses in the resolver.**

## What is open, roughly in the order I would take it

1. **The recovery arc** — `docs/anchor-id-provenance.md` § "Recovery". Design-first
   and the reason the rest exists. Derive a candidate from the **commit graph** (a
   finding carries `sourceRef`, so an unresolvable id is a question with an
   address: index their commit and read the locator off your own snapshot), then
   publish it as a **remap event** — an append-only log cannot be migrated but can
   be interpreted, and an appended interpretation is auditable and retractable.

   **Its first task is done: the bug is located and fixed** (`e9e66f2`, and §
   "Recovery" in the provenance doc records the mechanism). It was not the sidecar
   — shared findings are per-PR scoped, which is where the last search stopped.
   **Local annotations have no PR scope at all**, and the PR findings panel was
   rebuilding one in the browser with a disjunct that had no `pr` term in it, over a
   universe-wide `/api/queue`. Every orphan on the map was listed on every pull
   request alike. `offStoryReason` is the rule now, server-side.

   That narrows the surface. It does not place the ids, which is still this arc.

2. **The un-clearable doc — decided, half built.** Izzie chose the synthesis:
   refuse the removal (B), queue it for triage instead of leaving it stuck, and
   record the judgment so a retire-after-triage is attributable (A). The design and
   what is left are in `docs/anchor-id-provenance.md` § "Clearing a doc nobody can
   place".

   **Built:** `ackHole` files a `question` on the node, assigned `investigate`,
   carrying the ids, the commit they were written at, the derivation that minted
   them and their last-known file. It lands in the existing `review_queue`, and it
   is mirrored to the sidecar deliberately — "this build cannot place these ids" is
   a fact about ONE build, and a teammate whose build minted them can answer it
   outright. Entered by the ACT, never by the state: a `HASH_SCHEME` bump made 985
   of 985 docs unverifiable at once. One evolving investigation per doc — a later
   attempt revises the open item, an answered-and-still-accurate one is left alone.
   Identity is a digest of the EVIDENCE, written into the item as one line, not the
   rendered text: comparing prose would make a copy edit look like new evidence,
   revise an answered item and re-assign it, and re-assigning clears the outcome.

   **And it fixed a live bug on the way.** `evalVersion` ranks dangling over
   unverifiable, so a version with one absent citation and one incomparable one read
   `dangling` — and `ackHole` built its tombstone from `e.dangling` alone, dropping
   the citation nobody could place. It retired the whole doc on the comparable
   subset. The guard is on the evidence now, never on the status. `shareDoc` also
   refuses `removed: true`, which was a way round `retireSharedDoc`'s person-only
   rule; such a tombstone had to cite live anchors so it lost to any content
   version — until that code was deleted, at which point it began winning.

   **Honest about its reach.** Re-citing is available today only when a locator
   survived; without one, `createdCommit` plus an opaque `a_<digest>` needs the
   commit indexed and read, which is what the recovery arc does and it is not built.
   `snapshot` now takes a `ref` (any commit, straight from git objects) so the first
   step at least exists.

   **Not built, and deliberately:** the tombstone rule. A review round found five
   things that have to be settled first — the `anchorScheme` under-rejection routes
   the commonest case to `absent` and never reaches the rule; `judgedBy` is a SET
   and the aggregation rule is unstated (any/any authorizes an unrelated language,
   all/all resurrects on a missing one); "the reader is in exactly D's position" is
   too strong; the no-tag fallback ties rather than favouring the content version,
   and `anyUntagged` must not defeat a positive match; and a shared-only doc has no
   path to the queue at all. All five are written up. **Until it lands the doc is
   queued, not clearable — and that is the point of the queue.**

   Landing it should also carry the investigation, not only the build:
   `removalJudgment { indexDerivations, triageId, rationale }`. `retireSharedDoc`
   already demands a rationale and then drops it from the durable event.

3. **Materialization.** Step 5 has started and 3b's question is answered.

   - **5 — landed in part** (`e3d77d6`). `shared_doc_citation` is READ now:
     `docsCiting` is the reverse lookup ("does anybody's doc describe THIS symbol"),
     `docsByNode` parses only the matched nodes, `ensureMaterialized` is
     `readCached` without the read. `getAnchor` gains `sharedDocs`. So the table
     stays — it earned its place, and 3b's "either the query lands or delete it" is
     settled in favour of landing it.
   - **Still to expose**: `outline`, `context`, `search`, `find_gaps`. `find_gaps`
     is the one that matters most — reporting a gap a colleague documented last week
     is the north star running backwards.
   - **The outbox model** (§7, "prerequisite for step 5") has its two named
     prerequisites done (`657232a`, `7e459af`): publication preserves the source
     version id and the original `createdAt`. The overlay itself is not built.
   - **3a** — generation sharding and the sidecar-root lock — untouched.
   - `shared_scope.folded_at` and `events` are still written and never read. The
     review that would delete them stands; §5 landing does not save them.

4. **There is no orphans page.** `/api/orphans` is served and no page consumes it.
   The PR panel now reports a `stranded` COUNT pointing at `codemap orphans`, which
   is honest and is not a workflow. This is the smallest real gap on the list.

5. **Two surfaces still bypass the resolution**: `orphanedWork`'s `lost` bucket, and
   anything else that classifies by raw id membership. Note that
   `prOffStoryFindings` deliberately uses raw membership and says why: its question
   is whether an id can be PLACED on a diff, not whether the code exists.

6. **`src/ops.ts` is ~3400 lines** and wants splitting. A prose audit measured the
   tree: ratio climbing 0.15 → 0.28, but 66% of prose is skippable boundary
   comments and only 4.3% is in over-budget blocks. `ops.ts` is the one file where
   length is a real problem, and prose trimming cannot fix it — it is code.

## Working notes that cost something to learn

- **`safe-pkill`** (`~/.claude/bin/safe-pkill`) exists now. `pkill -f` matches the
  killing shell's own command line, and the bracket trick only stops the pattern
  matching *its own literal text* — not the same string appearing elsewhere on a
  compound line. That is how I killed a shell mid-command this session.
- **Mutation-check every fix.** Several tests in this branch pass whether or not
  the code they cover works, because the interesting input (an index built by
  another grammar) cannot be produced by this build. Revert the fix; if the test
  still passes, it is not testing anything.
- **Every new test needs a control.** "Absence is now unverifiable" would pass just
  as well if absence were suppressed entirely.
- **The tags are interned.** `derivationsOf` dedupes by object identity before
  hashing, because hashing per row put a SHA-256 on a hot helper.
- **Codex wedges silently on a permission request.** A review round ran for 6.5
  hours before anyone noticed: it had asked for write permission, and that prompt
  reaches neither auto mode nor Remote Control. It reads exactly like thoroughness.
  Pass `sandbox: read-only`, expect any write attempt to hang rather than fail, and
  if a round passes ~15 minutes, stop it and re-ask instead of waiting.
- **Ask codex what to cut, not just what is wrong.** The rounds this session were
  worth more for that than for the bugs: it cut `DocCitationHit` to a list of node
  ids, deleted seven comment blocks that were narrating rather than warning, and
  caught a count whose LABEL was wrong (`unattributed` included findings posted to
  other pull requests and findings already resolved). Frame it so "nothing, it is
  all load-bearing" is an equally acceptable answer.
