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

1. **The recovery arc** — `docs/anchor-id-provenance.md` § "Recovery: placing an id
   nobody can place". **Designed properly and step 1 is built; the rest is
   deliberately not.** Three review rounds killed two of my central claims, and the
   section records both as false rather than quietly dropping them.

   **What is true.** An anchor id is a digest of `file + symbolPath + disambiguator`.
   A record's own commit (`sourceRef`, `createdCommit`) is an address, and indexing
   that commit FRESH answers what the id named — an anchor this build minted itself,
   whose own id is the one asked about. `whereWas` is that, with four answers
   (`found` / `absent` / `ambiguous` / `unaddressed`), and `ackHole` runs it so the
   queue item carries the address.

   **What is false, and was in an earlier draft of this doc.** (a) That a published
   locator is verifiable by arithmetic: `anchorId` joins its fields with NUL and
   nothing else, so `["N","C","M"]` encodes identically to `["N","C"] + "M"` — a
   crafted triple verifies against an id it never named. The repair is to verify the
   READER's own anchor, never the publisher's split, which also collapses the
   mechanism to "is this id in my own index of that commit". (b) That the grammar
   contributes only the disambiguator: §1 says otherwise and §1 is right.

   **Measured, because the numbers decided the scope.** 3.4% of ids in the real
   event-sourced target carry a disambiguator at all (347 of 10,111); 0 colliding
   ids in 18,761 anchors across five repositories; and the alphabets of a symbol name
   and a disambiguator are disjoint, which is what makes reader-side verification
   sound and is now a test.

   **Left, and why.** Step 2 — what is that symbol NOW — is a judgement no digest can
   confirm, and `migrateOverloads` already does its strongest form for the case it can
   prove. A remap protocol for the minority this build cannot mint is designed in the
   doc and NOT built. **The denominator to measure before building more is the queue
   itself**: how many records reaching it carry a commit, how many step 1 places, how
   many stay foreign.

   **One latent bug found on the way.** Two `partial` declarations of one class in one
   file give their members the same id, and `INSERT OR REPLACE` drops one silently.
   Zero instances in five repos (real partials live in different files, and the file
   is the first digest field), so `reindex` REPORTS it rather than refusing, and the
   derivation fix — carry a container's disambiguator into its children's path —
   waits for the next `ANCHOR_SCHEME` bump rather than forcing one.

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
   - **`find_gaps` reads them now.** A symbol a teammate documented comes out of the
     work queue and back under `documentedByTeam` with the node, its title and who
     wrote it — the action there is to read theirs, not write a second. It asks
     `sharedDocCandidates` first (one query over the scope's distinct citations,
     intersected in memory) because asking `sharedDocsCiting` about every
     undocumented anchor would bind one parameter per anchor.
   - **Still to expose**: `outline`, `context`, `search`.
   - **The outbox model** (§7, "prerequisite for step 5") has its two named
     prerequisites done (`657232a`, `7e459af`): publication preserves the source
     version id and the original `createdAt`. The overlay itself is not built.
   - **3a** — generation sharding and the sidecar-root lock — untouched.
   - `shared_scope.folded_at` and `events` are still written and never read. The
     review that would delete them stands; §5 landing does not save them.

4. ~~**There is no orphans page.**~~ **DONE.** `/u/:u/orphans/` reads `/api/orphans`,
   which had been served since the sweep was built and consumed by nothing — the
   `stranded` count on the PR findings panel pointed at a CLI command from inside a
   browser. Four buckets, a kind filter, and `locate` as a button rather than part
   of the load, because it indexes a commit per stranded record's address.

5. ~~**`orphanedWork`'s `lost` bucket**~~ **DONE.** It meant "no record anywhere",
   which it never did: raw id membership in two local tables, presented as a claim
   about the CODE. Records carry their own address (an annotation's `sourceRef`, a
   bug's `createdCommit`, a review's `reviewedCommit`), so `locate` runs `whereWere`
   grouped BY COMMIT and a record whose own commit still names its id moves to a new
   `located` bucket with the file, symbol and line. What stays `lost` carries `why`
   — *no address to ask*, *not asked*, *absent*, *ambiguous* are four situations and
   only some are fixable. Capped at 25 commits with the remainder reported, never
   dropped.

   **What is left of this item:** other surfaces that still classify by raw id
   membership. `prOffStoryFindings` does so deliberately and says why (its question
   is placement on a diff, not existence). `retireSharedDoc` classifies raw ids and
   would need the same treatment if the shared path is ever queued.

6. ~~**`src/ops.ts` is ~3400 lines**~~ **DONE.** It is a 59-line barrel; the
   operations live in twelve modules under `src/ops/`, split along the seams the
   file already had (its own section banners, plus the call graph). No call site
   moved — `mcp.ts`, `serve.ts`, `cli.ts`, every test and `web/app.js`'s `ApiMap`
   import `ops.js` exactly as before, and the 85 runtime exports are identical.

   **Nothing under `src/ops/` may import the barrel.** The barrel imports all of
   them, so a module reaching back closes a cycle — and an ES-module cycle here
   fails with a blank page and an empty console. Shared helpers go DOWN into
   `src/ops/shared.ts`; `resolveRefs` alone is used by five surfaces and is why a
   naive split cycles immediately.

   **`src/import-cycles.test.ts` was silently not guarding this.** It walked
   `src/*.ts` non-recursively and matched only same-directory `"./x.js"`, so it saw
   **0** modules under `src/ops/` and **no** dependencies for the barrel — it would
   have stayed green while guarding nothing. It recurses and resolves relative paths
   now, and a planted `shared → docs` back-edge fails it by name.

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
