# Handoff — `worktree-shared-review-hashscheme`

Everything is committed and green (699 tests; `tsc -p .` and `tsc -p web` clean).
Last updated 2026-08-23, at the end of the session that finished the sidecar sequence
and exercised it against a real universe for the first time.

## START HERE

**The sidecar is mechanically complete and has never been used by two people.**
Steps 1-5 of the old sequence are done; `docs/sidecar-gap.md` is the gap analysis, and
this file is the brief.

### Your job: build the oracle, not the feature

The owner's words: *"high fidelity e2e and integration tests consisting of the patterns
involved in a real workflow - the goal being to prove out the system and provide an
oracle, so I'm not doing a week of break/fix while trying to use the tool."*

So: **the tests replace the week of real use, they do not follow it.**
`docs/sidecar-gap.md` ranks "use it for real for a week" third; that ranking is
SUPERSEDED by this brief. Every break/fix cycle you move out of the owner's hands and
into a test is the whole value of the next session.

Judge your work by one question: *if this system were subtly broken in a way a real
two-person review would surface on day three, would a test have caught it?* Today the
honest answer is mostly no, and the next section says why.

## What exists, so you do not rebuild it

Four entity kinds sync - **docs, findings, notes, walkthroughs** - each with a fold, a
projection, and materialization at sync and on write-through. Transport is honest: a
failed commit fails the sync, a push is verified to have landed, a deleted shard is
restored rather than propagated. Conflict machinery is real: segment-derived causal
vectors, contests, fork detection, `codemap sidecar heal` with a person-gated and
causally-gated acknowledgment. A teammate's doc is an ordinary `node_versions` row with
an `origin`; the bridges are gone.

Normative design: `docs/sidecar-architecture.md`. Mechanisms: `docs/fork-repair.md` and
`docs/plan-docs-unification.md` - both carry a "what the build changed" section, so
read those rather than diffing the design against the code.

**Not shared, deliberately:** bugs and triage (no design yet), edges (so `process` and
`step` docs are refused, which makes the flow-walker single-player), witness marks.

## Why the current suite cannot see it

699 tests pass and they share three structural blind spots. These are why a real store
broke the build on first contact.

1. **Every fixture is born at the current schema.** A build that could not open ANY
   pre-existing store passed the entire suite (`720b6d9`): an index on `source_scope`
   sat in the CREATE block, which runs before the ALTER ladder that adds the column.
   `db-migrate.test.ts` now covers one hop; nothing covers a store from three schema
   changes ago.
2. **Every sync is sequential.** The lock, the retry loop, the unlocked fetch and the
   locked merge have never had two processes racing them. `src/scenario.ts` serialises
   by construction, so the least-exercised safety mechanism in the system is also the
   one whose failure is quietest.
3. **Every scenario is a handful of operations.** Real review is a long chain - index,
   document, publish, sync, review a PR, file findings, disagree, edit a colleague's
   doc, change code, re-index, confirm, sync again. A defect that needs six steps to
   appear cannot appear.

## The workflows to model

The patterns a real two-person review actually produces. Each should drive the WHOLE
chain, not a unit of it.

1. **Two people, one repo, a week of review.** A indexes and documents, publishes,
   syncs. B pulls, sees A's docs, reviews a PR, files findings, syncs. A pulls, sees
   them, corroborates one and disputes another. B edits one of A's docs. Someone
   changes the code; docs go stale; the diff shows the impact; someone confirms.
   Assert convergence at every sync point.
2. **Offline and concurrent.** Both write while apart, then both sync - including two
   syncs racing in two PROCESSES against one sidecar.
3. **The cloned machine.** One writer id on two clones, both write, sync fails closed,
   `heal` repairs, both converge, and **both writes still exist**.
4. **Hostile history.** A `git rm`'d shard; an event added and deleted between pulls; a
   `writerPrev` cycle; an event from a newer protocol.
5. **Schema movement.** An old store opened by a new build; `ANCHOR_SCHEME` and
   `HASH_SCHEME` bumps against a store with published docs and witnessed reviews.
6. **Upgrade skew.** One clone on a newer codemap than the other - the manifest gates,
   in both directions.

### Make them oracles, not assertions

The value is in properties that must hold after ANY sequence, checked at every step:

- **Convergence.** After every clone syncs twice, their projections are identical.
- **No loss.** Every event ever appended is present in every clone's log afterwards.
- **No silent success.** Every op returning `ok` is independently verifiable by a read.
- **Fold determinism.** The same events in any order fold to the same value.
- **Ownership.** No local write ever reaches a row with `origin IS NOT NULL`.
- **Completeness.** After a sync, no ordinary query folds the log.

A harness that drives a seeded, random sequence of real operations across two or three
clones and checks those six after each step is worth more than any number of
hand-written cases. Seeded, so a failure reproduces.

## Test-authoring traps, all of which cost me time

Do not rediscover these.

- **A test that passes with the fix reverted is not a test.** Mutation-check every one.
  I wrote three versions of the `computeDiff` impact test that all passed against the
  bug they were written for.
- **Every test needs a control.** "Absence is now unverifiable" passes just as well if
  absence were suppressed entirely.
- **`init` re-caches the CURRENT commit.** You cannot make the working tree disagree
  with a cached head ref without committing the change - otherwise `init` overwrites
  that ref's snapshot from the tree you just emptied.
- **`universeKey` memoises per root.** Add the git remote BEFORE the first `init`, or
  the universe key is the directory basename and the scope you publish under is not the
  scope the fold looks for.
- **Two clones have different writer ids and so write different shards.** You cannot
  test same-shard concurrency without copying `.git/codemap-writer` between them.
- **`type: "process"` fixtures silently do not publish.** The publish surface and the
  fold both refuse `process`/`step`/`generatedBy`. 25 fixtures used `process` as a
  generic doc type; the ones that publish had to be retyped.
- **`publishLocalDocs` skips already-shared NODES**, not versions.
- **`materialize.test.ts` has a LOCAL `readCached` wrapper** returning the value, not
  `Cached<T>`.
- **Write test files with the `Write` tool or python, not a bash heredoc.** Backticks
  and NUL bytes in test content break the shell before they reach the file.
- **A fixture that never commits has no HEAD**, and half the diff surface needs one.

## What the live exercise proved

The only evidence in this repo that is not a test. Against a clone of `Acme.Settlement`
(148MB, 275 docs, 1,222 anchors); the table is in `docs/sidecar-gap.md`.

Publish: 53 shareable, **200 analyzer-generated skipped, 22 flows skipped** - the first
real measurement of "analyzer output is the bulk". Adoption on colliding version ids:
275 rows before, 275 after, 53 adopted, 0 duplicated. A shared writer id failed the
sync closed; `heal` unioned 55 events keeping both sides, rotated and acknowledged;
both clones converged with both forked writes intact.

**Clone before you touch `/working/`.** Those universes are live and edited by another
agent. I opened one directly and it threw inside `migrate` - no damage, verified (every
statement before the failure was `IF NOT EXISTS` on objects that already existed) - but
`cp -r` to scratch and work there.

## What to run

```sh
npm test         # ~60s, and it no longer stalls
```

**`npm test` is the command again.** It was unusable for three sessions — the
same suite took 28 minutes because the runner's per-file child intermittently
never exits. It runs in ONE process now (`--test-isolation=none`), which cannot
hit that. The stall is diagnosed below, and `CLAUDE.md` § "The suite runs in ONE
process" has the two rules that come with sharing a process.

To debug a single file, `node --no-warnings dist/x.test.js`.

### The stall: it is Node's own exit path

Reproducible now, and answered — it had been open across three sessions.

```sh
# ~50% on this machine. All seven tests PASS, then the child never exits.
for i in $(seq 1 12); do timeout 25 node --no-warnings --test dist/pr-ingest.test.js; done
```

`eu-stack` on a parked child, every time:

```
uv_cond_wait
node::NodePlatform::DrainTasks(v8::Isolate*)
node::SpinEventLoopInternal(node::Environment*)
node::NodeMainInstance::Run()
```

That is Node (v23.11.1) waiting for its platform's background tasks to drain
*after* the event loop has finished — a shutdown hang in the runtime, reached
only through the test runner's per-file CHILD. Three hypotheses died on the way,
and each is worth not re-testing:

- **Not our code, and not the tests.** `node --test <file>` hung 6 of 12;
  `node <file>` — the same tests, in process, no runner child — hung **0 of 12**.
- **Not SQLite at exit.** Already refuted by an earlier session; the stack
  confirms it.
- **Not `io_uring`** (the child's fd table has rings, so it is the obvious
  suspect): `UV_USE_IO_URING=0` hung 10 of 20 against 11 of 20 with it on.
- **Not "a rebuild under the running suite"**, which this session recorded as a
  habit on one run's evidence and then refuted on the next. Left here as the
  correction, because a wrong note in a handoff is worse than no note.

**Two fixes that look like fixes and are not**, both measured, both discarded:

- **Splitting `pr-ingest.test.js`.** Works — 0/12 for each half. But so does
  appending a test that does nothing at all (`await setTimeout(0)`), and so does
  removing ANY ONE of the seven. Seven hangs, six does not, eight does not. It is
  a threshold that any perturbation clears, so a split would read as a fix and
  stop working the next time somebody touched the file.
- **Chasing the mechanism further.** Not SQLite (a probe opening a dozen stores
  on deleted dirs: 0/12), not `io_uring`, not `--v8-pool-size=0`, and not any
  single test. No other file comes near it — `contested`, `ops-shared`,
  `indexer`, `diff` are all 0/8 as children, and several are far heavier.

**What actually fixed it:** `--test-isolation=none`. No child, so the bug is
unreachable, and 639 tests run in 60 seconds. The eight tests that failed under
it had ONE cause — `markAgentSession()` was a latch with no way back, so the file
proving the MCP surface is an agent made every later file's writes an agent's.
`clearAgentSession()` exists for that and has no production caller.

The old per-file mode still works and is still what wedges, so if you run
`node --test dist/<file>.test.js` and it parks at 0% CPU: kill the child by pid,
the parent moves straight on, and only that file's results are lost (it reports
as one failed FILE with no failing test inside).

## What is open

**The implementation sequence is finished** (steps 1-5). Two design threads remain,
and both are deliberately parked rather than half-built — read them before deciding
they are quick.

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
   doc and NOT built.

   **The denominator has now been MEASURED.** The tables are in the doc under
   "Measured (2026-08-23)". 2,641 stranded records across the two live C# universes;
   every one carries an address, every address resolved and indexed, zero ambiguous.

   **What decides placement is the SCHEME, not the address.** Split by whether the
   record was written before or after `ANCHOR_SCHEME` went to 3: records written
   after place at 100% (49 of 49 on `Acme.React`), records written before place at
   5–10%. That is blocker 1 of item 2, measured — a pre-bump id resolves `absent`
   when the honest answer is `incomparable`, because `derivationFingerprint`
   excludes `anchorScheme`. The doc guessed it might matter; it is the dominant
   cause by an order of magnitude.

   **So step 2 stays unbuilt, for a better reason than "not enough pain."** A remap
   protocol re-points an id at a symbol that is still there. These records are not
   code that moved — they are ids this build cannot mint, and what they need is
   honest classification, which is blocker 1. The bulk importer's wrong address is
   a real second defect and a data repair, but it is the smaller one.

   **The repair is validated on a copy and is Izzie's to run on the live stores**
   (`/working/` is edited by another agent — never write there). `codemap`'s
   `prPullViewedAll(root, { force: true })` on a clone of `Acme.API`: 269 PRs, 151
   with ticks, 5,375 marks, 0 errors, 202 seconds. Distinct addresses across the
   bulk marks went **1 → 107**, and step 1's placement of them **0.4% → 46.8%**.
   Not 100% because the measured population is by definition the marks missing
   from the existing `@work` index; the delta is the result, not the level.

   Reproducing it needs two things or the numbers are nonsense: the clone must
   have its **submodules checked out** (`indexCommit` reaches a gitlink through the
   working tree, and a missing one collapses the index to null), and it must carry
   the **untracked `.codemapignore`** (kept in `.git/info/exclude`; without it the
   same commit indexed 9,828 anchors instead of 4,412).

   **One wrong turn, kept because the method is the lesson.** An earlier pass
   concluded the residue was genuine absence, from a test that looked for each
   record's witnessed body under another id and found none in 67. That test could
   not have found one — the stored witnesses are `HASH_SCHEME` 1 and this build
   mints scheme-2 digests, so it compared two tokenizers. **Check that a negative
   result COULD have been positive before believing it.**

   Two things the measurement found on the way. `locate` on a `--no-checkout` clone
   answers `unaddressed` for everything — `indexCommit` reaches a submodule through
   the working tree, and a missing one correctly collapses the index to null; measure
   on a checkout. And `whereWere` returns a bare `absent` without asking whether this
   build could have minted that id — the classification `resolveAnchor` exists to
   make. It changed no number here, and the code still does not apply the rule.

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

   **Blocker 2 is decided (2026-08-23): per-citation.** Each incomparable citation
   is judged against the derivation its own marks name, so a C# tag can never
   authorize a Python citation; a citation with no marks has no language to test
   and counts against the tombstone. Blocker 1 is now MEASURED as the dominant
   cause of unplaceable ids — see item 1 — and the call there was data repair
   first, re-measure, before any code change to the fingerprint. The other three
   are still open.

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

3. ~~**Materialization.**~~ **DONE**, and then some: every scope kind has a
   projection, sync materializes them, and shared writes are write-through. No
   ordinary query folds the log any more. `docs/plan-docs-unification.md` and
   `docs/fork-repair.md` record what the build settled differently from the designs.

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
