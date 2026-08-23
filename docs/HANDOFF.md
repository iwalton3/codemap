# Handoff — `worktree-shared-review-hashscheme`

Written at `bec6d1e`; updated at `0499657` after another session and two review
rounds, and again after the session that finished §4. Everything below is
committed and green (639 tests, `tsc -p .` and `tsc -p web` both clean). Read
this, then the two documents it points at; do not read the whole branch history.

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

3. **Materialization.** Step 5 is largely landed; 3a is half done and its remainder
   is the biggest single thing left on this branch.

   - **5 — landed for the reads that matter.** `shared_doc_citation` is READ
     (`docsCiting`, the reverse lookup); `get_anchor` carries `sharedDocs`;
     `find_gaps` no longer offers a symbol a teammate documented; `context` — the
     call an agent makes first — reports the team's docs, drops them from `gaps` and
     has a verdict ranked below every local one. `sharedCoverage` is the single
     entry point those use. Left: `outline`, `search`, `get_node`, notes — browse
     polish, not the north star.
   - **The outbox model**'s two named prerequisites are done: publication preserves
     the source version id and the original `createdAt`. The overlay itself is not
     built.
   - **3a — HALF DONE. Read `PROPOSAL-provenance.md` §4, not the archived §13.**

     Built: `withSidecarLock` (lock file OUTSIDE the sidecar — `git add -A` would
     otherwise push it to the team), around `sync` AND around `emitEvent`'s whole
     read-heads-then-append sequence. `LogEvent.writer`, a clone-local random id in
     the sidecar's git dir; shards and the causal vector key on it. That closes a
     VERIFIED wrong answer — see the commit and `eventlog.test.ts`: one person's
     laptop agent lending their stale desktop knowledge it never had, which
     suppressed a real contest between two other people.

     **Now built — all four.** §4 is updated to say so; read it rather than this.

     - **`writerPrev` and the GENESIS rule.** `emitEvent` stamps it, `detectForks`
       reads it. Two rules the sketch did not have, both nearly got wrong: an absent
       `writerPrev` is NOT an implicit GENESIS (every pre-chain log would fork on
       its writer's second event), and a chain claim needs a `writer`, not
       `causality`'s principal fallback (which files two machines' chains under one
       person). The predecessor comes from the writer's own SHARD's last line, not
       from fold order — a shard is single-writer and append-only, so its last line
       is the chain head by construction, where fold order has to be trusted to
       agree with append order and that is what a fork breaks.
     - **Scope status.** §7's fail-closed rule: `status` + one `diagnostic` on
       `shared_scope`, stored beside the fingerprint so a cache HIT answers it.
       `readCached` returns it WITH the value and `ensureMaterialized` returns it
       with `fresh`, deliberately — a signature that lets a caller take the rows
       and forget to ask is how a fail-closed rule fails, and that is exactly how
       it first failed here.
     - **Writer identity in the folds — and the three resolved differently.**
       `contest.ts` keys on the WRITER (its principal test was subsumed by `saw` for
       one clone, so its only live effect was suppressing a real two-machine
       disagreement). Corroboration keys on `(principal, model)`, NOT the writer: a
       verdict is an opinion and which model formed it is part of whose it is, but a
       person re-reviewing from their desktop has changed their mind. Walkthroughs
       stay per principal. Izzie's calls, recorded in §4.
     - **`sidecarProtocol` / `eventSchema`** on the envelope, with §7's rule that a
       HIGHER number blocks the scope and a lower or absent one reads fine.

     **What this cost that was not on the list.** The fold's OUTPUT changed shape,
     and nothing about a code change touches the materializer's cache key — so
     every store that had already folded a scope would have served the old answer
     forever. `MATERIALIZER_VERSION` is 3, and a golden vector over a fixed log now
     fails when the fold moves, which is the guard `normalize.test.ts` gives
     `HASH_SCHEME`. **If you change a fold, that test is the question, not a
     defect.**
   - **3b** — the anchor-table scans are gone but `shared_doc_citation`'s §5 join is
     the one that landed, not the doc-freshness one. `shared_scope.folded_at` and
     `events` are still written and never read; `status` and `diagnostic` are read.

   **What is left of 3a, and it is small.** There is no rotation command for a
   writer id yet (§4 asks for one), so the repair for a detected fork is manual:
   delete `<sidecar git dir>/codemap-writer` on one clone. And nothing REFUSES a
   write to a blocked scope; the choice was deliberate — a fork is in history and
   cannot be un-forked, so refusing writes would wedge the scope permanently
   rather than contain it.

   **Two codex rounds, and the second was worth more than the first.** Round one
   refuted a comment in `contest.ts` that claimed more than it could: the writer
   test is subsumed by `saw` between two TAGGED events, and not between a tagged
   one and a pre-writer one. Round two found the real hole and named the cut in
   the same breath — `ensureMaterialized` returned a bare boolean, so the two
   surfaces on the QUERY path dropped the verdict, and `scopeVerdict` was a second
   route bolted on to recover it for one caller with an "unknown" state §7 does
   not permit. One route now carries it. **Ask it what to cut.**

   **The rule that came out of round two and is easy to get wrong:** a blocked
   scope must stop DECIDING, not merely stop claiming. Suppressing a gap is an
   authoritative act and the harm is invisible — it is what is missing from the
   list. So `findGaps` and `context` keep the gap and show the team's doc beside
   it; `getAnchor`, which suppresses nothing, reports the verdict and its docs
   unchanged.

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
