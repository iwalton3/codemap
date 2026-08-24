# Handoff — `worktree-shared-review-hashscheme`

Green (779 unit + 74 e2e; `tsc -p .` and `tsc -p web` clean; the vdx template lint is clean).
**Uncommitted** — everything below is in the working tree. Last updated 2026-08-24, at
the end of the session that finished workflows 3–6 and the old-store fixtures.

## What the 2026-08-24 session did

**Workflows 3–6 are DONE**, each driving the whole chain with the six properties checked
at every step, and each **mutation-checked** — the fix reverted, the test must fail.

- **3, the cloned machine** (`oracle-cloned-machine.test.ts`). One writer id on two of
  one person's machines. The half a unit test cannot reach is a THIRD person: while the
  fork is unpushed it is invisible to him (a sync that fails closed pushes nothing), and
  once it lands he is not blocked either, because **the acknowledgment is an EVENT and
  travels with the evidence it covers**. One person looking at a fork clears it for every
  reader. The control is a SECOND fork, which blocks again.
  *Measured while mutation-checking:* it takes removing BOTH of `acknowledged`'s gates —
  the evidence digest AND the causal check — to make an acknowledgment a mute. They are
  independently sufficient, so neither is redundant.
- **4, hostile history** (`oracle-hostile-history.test.ts`). A pushed `git rm`, an event
  from a newer protocol, a `writerPrev` cycle, and a malformed line. Every mechanism
  already had a unit test, so what this adds is **blast radius**: each shape is refused
  in ONE scope and nowhere else, and with two scopes blocked the team still publishes,
  reads and opens new scopes. A junk line must NOT block, or one corrupt byte from
  anybody is a denial of service built out of a safety check.
- **5, schema movement** (`oracle-schema-movement.test.ts`). A `HASH_SCHEME` bump
  simulated by moving the STORE back to its pre-bump form, which is what an old build's
  store really holds. A local doc, a teammate's doc and a sign-off all degrade to
  "cannot tell" rather than to drift, and the LOG is untouched — a scheme is a fact about
  a build. Plus the `ANCHOR_SCHEME` half: a snapshot from another derivation reads as NOT
  CACHED.
- **6, upgrade skew** (`oracle-upgrade-skew.test.ts`). `ANCHOR_SCHEME` differing is FATAL
  in both directions (the push is gated too — being behind is not safer than being
  ahead); `HASH_SCHEME` and a grammar version are ADVISORY. Nothing is lost while a clone
  is gated out.

**Old-store fixtures are DONE** (`schema-eras.ts` + `db-eras.test.ts`). Five eras, and
the SQL is **extracted from `db.ts`'s own history**, not written by hand — a test
re-extracts it with `git show <commit>:src/db.ts` and fails if a fixture drifts from the
shape that commit really produced (it skips when history is unavailable, so the unit
suite stays hermetic).

**And they immediately found a boundary.** A store from `3624f49` cannot be read at all
— `no such column: status` — because the `shared_scope.status`/`diagnostic` rungs were
deliberately removed at the protocol-1 freeze. **That decision is correct and is now
measured twice:** `3624f49` is on no branch but this one, and none of the four live
universes under `/working/` has a `shared_scope` table at all, so `CREATE TABLE IF NOT
EXISTS` hands every real store the modern one. Pinned as an INVERTED test: restore the
rungs and it fails, telling you to move `shared_scope` into `REQUIRED`.

**Two defects fixed in the web UI**, both found by workflow 5 and both the same class —
a green check that cannot say why it is green:

1. `AcceptanceVia` has had `unverifiable` since the scheme work, and it appeared in
   NONE of `web/app.js`'s lookup tables. After a `HASH_SCHEME` bump every sign-off in
   the store rendered as an ordinary ✓.
2. `revBtn` called `revCls(st, actor)` and `revMark(st, actor)` with two arguments, so
   on that surface `reverted` and `replayed` were invisible too.

`src/review-via-render.test.ts` guards the correspondence statically, the way
`api-map.test.ts` does: every member of the union that needs a label has a tooltip, a
glyph in both renderers, and every call site is passed the `via`.

**The seed is polyglot now.** `SEED` gained C#, which is the only way to reach the anchor
shapes this project exists for — overloads (and so a DISAMBIGUATOR), namespaces in the
symbol path, and partial types across two files. `oracle.test.ts` asserts all three land
in the index, because a seed that quietly stopped indexing `.cs` would read as coverage.

**`concurrently` is `whileApart`.** It was exported and called by nothing, and it claimed
a simultaneity it never delivered: it produces CAUSAL concurrency, which is the only kind
the log defines. `oracle-apart.test.ts` now uses it and asserts, from the causal vector
itself, that neither write saw the other — with the counter-control that a write after a
settle DOES. Real simultaneity is `oracle-race.test.ts` and nothing else.

The harness also gained `rewriteHistory`, `appendRaw`, `shardsIn` (hostile history) and
`publishManifestAs` (upgrade skew), and `cloneMachine` now says so when the source clone
has never written rather than throwing ENOENT.

### The e2e half was RED, and both causes were stale fixtures

`npm run e2e` failed 8 of 81 before this session touched it, and neither cause was a
product defect:

- **`shared-ui.e2e.ts` published nothing.** Its fixture documented with
  `type: "process"`, which the publish surface and the fold both refuse — the trap this
  handoff already lists, in a fixture that was missed. Both shared-docs tests sat waiting
  30s for a row that could never render. Retyped to `concept`; the suite went from 73s to
  14s.
- **`pr-import.e2e.ts` had lost its prerequisite.** `~/Desktop/jellyfin` no longer holds
  any `refs/pull/*` and its remote is named `alt`, so the fixture PR is unreachable. That
  is a missing prerequisite, and CLAUDE.md's rule is that those SKIP rather than fail —
  `skipReason()` checked the fixture COMMITS and `gh auth`, neither of which implies the
  pull ref now that resolution is git-only. It checks the ref and says how to restore it.

**`npm run e2e` is green (74 pass, 1 suite skipped).** To bring those six back:

```sh
git -C ~/Desktop/jellyfin fetch <remote> '+refs/pull/17463/head:refs/pull/17463/head'
```

### A live defect, filed not fixed: two agents can raise a contest neither may settle

`contest.ts` gates SETTLEMENT on the actor (`src/contest.ts:88`) and not CREATION:
`applyRevision` records every incoming owner (`:75`) and detects divergence without
testing either actor (`:103`). Two agent writes of different values, neither having seen
the other, produce a contest — and `isAgentActor` then refuses to let either clear it.
**Measured** against `dist/contest.js`; the repro is in `docs/shared-triage.md`.

It is live for findings and notes today. Deliberately NOT fixed here: both depend on the
current semantics (`src/shared-findings.ts:237`, `src/shared-notes.ts:127`), and a global
actor rule has consequences unrelated to triage. Shared triage works around it by feeding
only human events into its `ContestState`.

### Shared triage: designed, not built

`docs/shared-triage.md` is normative and reviewed. The headline, because it killed the
obvious design: **`ratchet()` is not a join-semilattice, and not only because humans
lower — two AGENT writes already reorder** (the counterexample is in the document and
was run against `dist/triage.js`). It does not matter, because DETERMINISM here is
satisfied by a sequential fold over `sortEvents`, not by commutativity.

Settled: per-axis receipts; `source: "graph"` does NOT travel; triage moves out of
`meta["triage"]` into one canonical table. A second review round then found the rules did
not define a UNIQUE fold — two implementers could produce deterministic, incompatible
projections — so the document now specifies **per-FIELD supersession**, which agent
claims stay active when concurrent with a human, what happens while two humans disagree
(maximum for ranking, labelled contested, never a scalar chosen by event id), and
`tripwire` as a third receipt-bearing field that stays ARMED while contested.

**Five write paths are whole-list rewrites, not three** — `clearTriage` is the one that
matters most, because filtering the local list does not remove a fold-owned target at
all and the next merged read returns it. The seam grows to five functions; the table
needs PARTIAL unique indexes, because SQLite does not conflict NULLs and a plain
`UNIQUE(target_kind, target_id, source_scope)` admits duplicate local rows (measured).

**Two things the build must decide that no earlier draft mentioned.** What happens with
no sidecar configured — the answer is "write locally and publish later, exactly as docs
do". And what happens to the legacy `meta["triage"]` blob: it stays LOCAL until somebody
publishes it explicitly, because a legacy `Triage` carries `source` but **no `Actor`**,
so automatic publication would attribute every historical judgment to whoever upgraded
first.

**The merge rule was decided by asking what a conflict is WORTH**, which is what triage
is for in the first place. Neither "contest everything" (correct and exhausting) nor
"last-in-wins" (silent — among concurrent events "last" means "larger event id", so a
`low` from somebody who never saw the `business-critical` quietly lowers it). Three rules
instead: causally-seen supersedes, concurrent divergence takes the higher value silently,
and only a disagreement ACROSS the `business-critical` line reaches the review queue.
Applied consistently it also settles presence and `tripwire`, and it leaves LOCAL
semantics unchanged — a write is one act producing one record, and the fold reads that
record as fields sharing one receipt.

**THE STORAGE IS BUILT AND GREEN.** Triage is one canonical `triage` table, one row per
(target, FIELD), with `origin`/`source_scope` exactly as `node_versions`. `meta["triage"]`
migrates on open, idempotently, and every migrated mark stays LOCAL. All five write paths
go through the local seam and are table-driven-tested against a store that already holds
a teammate's row; the ratchet still judges against the merged view. Mutation-checked in
both commits.

**What is left of the build:** the event kinds and the fold (`shared-triage.ts`), the
projection and its `projectionFor` entry, the ops (`shareTriage` / `sharedTriage` and
write-through), the review-queue escalation for a business-critical crossing, the oracle
wiring (OWNERSHIP and COMPLETENESS know only about docs), and the WALL in
`oracle-handoff.test.ts`.

**One measured trap for whoever writes the fold:** SQLite does not conflict NULLs, so the
table uses PARTIAL unique indexes. A plain `UNIQUE(target_kind, target_id, field,
source_scope)` admits unlimited duplicate local rows.

## The commands changed

`npm test` now runs EVERYTHING — unit then e2e — because a suite that is not in the
default keyword is a suite that stops being run. `npm run unit` is the fast loop
(~85s) and `npm run e2e` is the browser/real-repo half.

## What the oracle is, after one session

**Built and green.** `src/oracle.ts` is the harness: a member is a whole universe —
a clone of a shared code repo, a `.codemap` store, and a sidecar clone — over two
bare origins. `src/oracle-properties.ts` is six invariants checked after every step.
`src/oracle-handoff.test.ts` drives the owner's actual arc across eleven steps;
`src/oracle-race.test.ts` puts two real PROCESSES on one sidecar.

**PR review no longer needs `gh`.** `prContext` resolves from git alone when the
origin has no GitHub slug — a property of the remote, not a flag. Forks included
(`refs/pull/N/head` is a server-side ref), merged PRs included (the base is recovered
from the merge commit's first parent). That is what makes the oracle hermetic.

**Three real defects fell out of building it**, which is the argument for the whole
approach:

1. The harness's own `settle()` called the transport instead of the `sharedSync` op,
   so every clone held an unmaterialized log — a state no real machine is in. The
   COMPLETENESS property caught it.
2. A doc version missing a nullable scalar **poisoned the whole universe**.
   `JSON.stringify` drops `undefined` keys, so a peer on a build without the coercion
   sends a line with no `createdCommit`; the fold accepted it and the projection's
   INSERT threw inside `readCached`'s transaction — every shared doc unreadable,
   permanently, because nothing about the failure moves the fingerprint. Fixed at the
   fold, which is the only gate that binds writers this build did not write.
3. Git-only resolution assumed the remote's default base, so a PR onto `release` was
   diffed against `main` — a wrong diff, not merely approximate metadata. It takes an
   explicit base now and flags a guessed one (`PrMeta.baseInferred`).

### The properties were VACUOUS, and that is the lesson

A review round found four of the six passing on a broken system. All are fixed, and
each fix has a test that fails without it — but the shapes are worth knowing, because
they are what a property-based oracle fails as:

- **`ownership` passed after `DELETE FROM node_versions WHERE source_scope IS NOT
  NULL`** — the largest violation available. It iterated the ROWS, so absence was
  invisible; it selected on `origin IS NOT NULL`, so clearing provenance hid the write
  that did it; and it compared four fields, so `citations`, `removed`, `ord` and
  `author` were free.
- **`converged` never read the projections.** It re-folded the log on both clones, so
  a row corrupted in place — still valid JSON, still under a current fingerprint —
  passed while `sharedFindings` served the corruption.
- **`determinism` was vacuous for exactly two events**: every seeded shuffle of a
  two-element list is the identity, and two concurrent events are the *smallest*
  interesting ordering case. It always tries a reversal now.
- **`NO SILENT OK` did not exist at all.** It was in the list, and the list was the
  documentation. It is a receipt at the call site now (`verified`), because only the
  caller knows what a given `ok` promised.

The general rule, which cost the most to learn twice: **check that a passing property
COULD have failed.** Every one of these was green.

### Branch-canonical keying is REFUTED — read `docs/review-target-identity.md`

The plan was to make the branch name the scope key. A transient network error alone
changes it, splitting one review's findings across two scopes; a real branch named
`pr-17` collides with the fork fallback; and there is no lifecycle generation, so two
sequential PRs from one branch name share a review. All measured. The document has the
table, the design to build instead (durable minted id, typed aliases, base+head on the
target), and the one migration rule: **never infer historical branch names from shas.**

Nothing about the built git-only resolution depends on it.

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

**Not shared:** bugs (no design), edges (so `process` and `step` docs are refused, which
makes the flow-walker single-player), witness marks — and **triage, which now has a
design and no build**: `docs/shared-triage.md`.

## Why the current suite could not see it

Written when 699 tests passed. **All three are now closed**, and the section is kept
because the shapes are what a suite fails as, not because the gaps remain.

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

**CLOSED, all three.** (1) `schema-eras.ts` + `db-eras.test.ts`, five eras extracted from
`db.ts`'s own history. (2) `oracle-race.test.ts`, two real processes gated on each other
so they overlap by construction. (3) the six workflows below, each driving the whole
chain with the invariants checked after every step.

**Two blind spots the last session named are also closed.** The seed was TypeScript and
Python only, so no C# overloads, namespaces or partial types — it has all three now, with
a control test. And `concurrently()` claimed a simultaneity it never delivered; it is
`whileApart` and its causal concurrency is now asserted from the causal vector itself.

**What is left uncovered, honestly:** the web UI is still exercised only headlessly
(`docs/sidecar-gap.md` §5), and nobody has looked at a blocked scope or a contested
finding in a browser and said whether it reads right. Two defects this session found in
`web/app.js` were both invisible to every test that existed, and the guard written for
them is static — it checks that a `via` is RENDERED, not that the rendering is legible.

## The workflows to model

**ALL SIX ARE DONE.** 1 is `oracle-handoff.test.ts`; 2 is `oracle-race.test.ts` (two
real processes) plus `oracle-apart.test.ts` (the causal half); 3-6 are
`oracle-cloned-machine`, `oracle-hostile-history`, `oracle-schema-movement` and
`oracle-upgrade-skew`. Every one is mutation-checked. What each ADDS over the unit tests
that already covered its mechanism is written at the top of its own file, and it is
always the same kind of thing: what the failure does to somebody who was not involved.

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
npm run unit     # ~70s, and it no longer stalls. The loop
npm test         # unit AND e2e
```

**The suite is usable again.** It was unusable for three sessions — the
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
