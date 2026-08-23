# Causal vectors under a fork, and repairing one

**Status: designed and prototyped, NOT built.** `docs/sidecar-architecture.md` is
the architecture; this is the mechanism behind its "Conflict repair" section and
wins on detail wherever that document is only summarising.

A **fork** is two clones holding one writer id — a machine image, a synced home
directory — so one `(scope, writer)` chain is not sequential. Everything here is
downstream of that one situation.

## What was wrong, since a wrong fix shipped in this repo's own design

The first design said: for a forked writer, drop the `ownLast` causal edge, which
makes `saw()` a lower bound, which can only *raise* contests. **That was false**,
and it matters because it looked exactly like a soundness argument.

`causality()` (`src/eventlog.ts:617`) gives each event a 1-based ordinal among its
writer's events *in fold order* and stores per-writer high-water marks; `saw()` is
`seen[from][writer(target)] >= seq(target)` (`src/eventlog.ts:662`). That is a
**prefix claim** — holding ordinal n of W asserts holding 1..n of W — and the prefix
claim *is* the single-writer compression a fork invalidates. `ownLast`
(`src/eventlog.ts:646`) is one edge; the false claim in the counterexample lives in
a **third party's** vector and is produced by the ordinal arithmetic, which dropping
the edge never touches.

```
F1  writer W, writerPrev GENESIS, subject S      # fork branch A
F2  writer W, writerPrev GENESIS, subject T      # fork branch B
X   writer X, after [F2],        subject S      # disagrees with F1, never saw it

today            saw(X, F1) = true   heads = [X]        # fabricated sight; F1 unreachable forever
ownLast dropped  saw(X, F1) = true   heads = [X]        # identical — a non-fix
```

`contest.ts:132` then suppresses a real disagreement between two different people,
and `heads()` (`src/eventlog.ts:664-671`) drops F1 so no future `after` can ever
name it. Both are the opposite of the claimed direction.

## The fix: chain-derived segment vectors

`writerPrev` already records each event's *actual* predecessor, written under the
sidecar lock from the writer's own shard's last line (`src/eventlog.ts:283-287`) —
append-only and single-writer, so it is the true chain head by construction. A
writer's events therefore form a tree: linear when honest, branching at a fork.
Derive the vector from that tree instead of from fold order.

- **Segment** — a maximal linear run of the `writerPrev` tree. A new segment opens
  when the predecessor is `GENESIS`, absent from the scope, owned by another writer,
  or already has a chain child (the fork point).
- **Ordinal** — position within the segment. Chain position, not fold position.
- **Own-edge** — `absorb(e.writerPrev)`, replacing `absorb(ownLast.get(mine))`. The
  writer's recorded claim, never a fold-order fabrication.
- **Key** — `(writer, firstEventIdOfSegment)` held in **nested maps**, never a
  concatenated string. See "Two ways to get this exactly wrong" below; this is not
  a style preference.

The prefix claim is then true by construction: within a segment each event names its
predecessor, so ordinal n really does imply 1..n. Cross-segment knowledge flows only
along recorded edges. `saw()` and `heads()` keep their shapes.

### Verified against a prototype

```
today     saw(X,F1) = true   heads = [X]
segments  saw(X,F1) = false  heads = [F1, X]                       # fixed, branch kept
control linear      saw(c,a)=true  saw(x,a)=true  heads=[x]        # own history still own
control 2-machine   saw(E,H)=false                                 # pinned behaviour preserved
fork mid-chain      saw(b1,a)=saw(b2,a)=true  saw(b1,b2)=false  heads=[b1,b2]
bench               29.8ms -> 32.9ms per 20,000 events
```

The mid-chain case is the one that decides the design. The pre-fork prefix is
genuinely known to both branches and must stay credited to both; the branches must
lend each other nothing. Per-branch designs usually break one or the other.

### Two ways to get this exactly wrong

Both were found by attacking the prototype, and both reproduce the original bug.

**A concatenated segment key is not injective.** With `writer + "\0" + firstEventId`,
writer `w` + id `root\0tail` collides with writer `w\0root` + id `tail`: a third
event that saw only the second reports `saw = true` against the first and drops it
from `heads()`. Use nested maps and the question does not arise. This is the third
instance of NUL-joined non-injectivity in this repository — anchor ids
(`docs/anchor-id-provenance.md`) and the acknowledgment digest below are the others.
**Treat a NUL-joined digest as a defect on sight**; length-prefix it, or do not join.

**A `writerPrev` cycle zeroes the scope.** `A.writerPrev = B`, `B.writerPrev = A`
makes every event cover every other, and `heads()` returns `[]` — so the next
`emitEvent` captures no parents at all and the whole scope's causality is silently
gone. `wellFormed` (`src/eventlog.ts:310-314`) rejects neither cycles nor the writer
and id grammars, and `detectForks` does not look for them. Draining the cycle in
`sortEvents` is not enough: cycle detection belongs in segment construction, and a
cycle is **blocking evidence**, never a shrug. Fail closed, as everything else here
does.

### Why the alternatives lose

- **One vector key per forked-writer event** (no compression for forked writers) is
  sound and gives identical answers, but a branch of length k costs O(k) per
  absorbing event. Forks grow precisely while nobody has healed them. Segments are
  the same thing compressed where compression is valid — a singleton segment *is* a
  per-event key.
- **Full reachability** (per-event closure or bitsets) is O(n²) space — ~50MB at
  20,000 events — for answers segments already give exactly, and it loses the
  one-number-per-key summary that keeps `saw()` and `heads()` cheap.
- **Leaving the scope blocked forever** is rejected by the premise: a scope that can
  never answer again is a dead scope, not a fail-closed one.

### What comes with it

- **`sortEvents` must treat `writerPrev` as an ordering edge** alongside `after`
  (today only `after`, via `parentsOf`, `src/eventlog.ts:540-541`). Not for
  soundness — an unfolded parent merely under-credits, which errs loud — but so
  that "chain parent folds before chain child" is a property rather than a
  coincidence. It already drains cycles, so a dishonest `writerPrev` cannot wedge it.
- **`MATERIALIZER_VERSION` 3 → 4.** The fold's output changes (contested sets, heads,
  scope status), so rows folded under 3 answer a question this build no longer asks.
- **Hard dependency: the protocol-1 freeze.** The own-edge is now `writerPrev`, so it
  must be mandatory. Land the freeze in the same change. A malformed event that slips
  past is its own segment root — under-credit, never fabricate.

## Delete `sameWriter`

`src/contest.ts:131` short-circuits on `sameWriter` **before** the `saw()` test on
:132, and two fork branches share a writer id by definition — so an intra-fork
disagreement is never contested no matter what the vector says. Its justifying
comment (`src/contest.ts:124-130`) asserts "a writer's own history is always in its
own causal vector", which is the exact premise a fork breaks.

Under the segment vector, `saw(held.id)` covers every legitimate case, so the helper
(`src/contest.ts:68-71`) and its call site are **deleted**, not made fork-aware. No
fork state is plumbed into the fold — the vector already encodes the tree.

- Same writer, same segment (revising your own write) — `saw` is true via `writerPrev`
  absorption. No contest, as today.
- Same writer, different branches — `saw` is false, so the contest is raised. The bug.
- One person, two writers — `sameWriter` was already false; unchanged.
- Pre-writer events — the only leg where it was load-bearing, and it dies with the
  freeze.

Settling gets *more* coherent: `after` now names both branch heads, so the first
post-fork write by a person with a full pull can settle an intra-fork contest, and an
agent still cannot (`src/contest.ts:108`).

One accepted rough edge: a chain gap from a torn or glued shard line can make a
writer's revision of their own pre-gap write raise a self-contest. The direction of
error is raising, and it needs an already-damaged shard. If it proves noisy the
remedy is a diagnostic on the gap, not a resurrected `sameWriter`.

## Cut `merge=union`

Change `src/sidecar.ts:198` to write `*.ndjson -merge`.

The justification for union is obsolete on this branch's own terms, and the code says
so: shards are per-**writer** (`src/eventlog.ts:159-175`), and the comment at
:163-165 states outright that "Nothing then union-merges anyone's shard." Two clones
write one shard file **only** when they share a writer id — which is the fork. So
union's one remaining merge case launders a fork's evidence into a clean-looking
merge, to be discovered later as a team-wide blocked scope instead of at sync time on
the guilty clone. Union does not *manufacture* the fork (the shared writer id does);
it hides it. It also *adds* a line-damage mode — `src/eventlog.ts:321` already lists
"a merge=union that stitched two sides" among the causes of a glued line.

**`-merge` semantics, verified empirically rather than from the manual:** a
both-sides-changed shard conflicts with **no conflict markers written into the file**
(so a conflicted shard can never poison `readShard`), ours left in the working tree,
and both sides recoverable from `git show :2:<path>` and `:3:<path>` — *while the
conflict is live*. A one-side-changed shard never invokes a driver and merges clean,
so ordinary team flow with disjoint per-writer files is untouched.

Keep `readScope`'s dedupe-by-id (`src/eventlog.ts:353-360`) and `readShard`'s
torn-line tolerance (`src/eventlog.ts:318-327`) regardless — the first guards the
hand-merge that `heal` performs, and the second covers a process killed mid-append,
which no merge driver affects.

`pull()`'s merge-failure arm (`src/sidecar.ts:262-267`) must stop assuming the cause
is a manifest: inspect `git diff --name-only --diff-filter=U`, and when the conflicts
are shards, return the diagnosis — *"shard `<scope>/<writer>.ndjson` diverged: writer
id `<w>` exists in two clones (machine image, synced home directory). Run
`codemap sidecar heal` on this clone."*

**Failure properties.** The aborted merge deletes nothing: local commits stay local,
remote history stays remote, both sides fully readable where they were written. The
blast radius is exactly the two clones sharing the id; everyone else fast-forwards.
The push-retry loop (`src/sidecar.ts:299-311`) does not spin — its follow-up pull
returns the conflict error and sync fails with the diagnosis.

**What cutting does NOT delete:** the vector fix and fork detection stay. Git is not
the only ingress — a synced home directory merges shards outside git entirely, with
no driver ever running, and a healed shard deliberately contains the fork.

## `codemap sidecar heal`

One person-run command; refused for agent actors, same enforcement as
`retireSharedDoc`. Every step is append-only.

1. **Re-run the merge and resolve the shards by line union.** All lines from both
   sides; byte-identical duplicates dropped; differing-content same-id lines **both
   kept** — they are the duplicate-id evidence and G3 forbids picking by deletion.
   *`pull()` has already aborted the merge, so stages 2/3 are gone by the time heal
   runs* — heal must re-run the merge itself (or read the two blobs from `HEAD` and
   the fetched `origin/<branch>`). Specifying heal to "consume the conflict" is a
   sequencing bug; it consumes a conflict it creates.
2. **Rotate the local writer id** when this clone holds the forked writer — mint a
   fresh id into `.git/codemap-writer` and invalidate the in-process cache
   (`src/eventlog.ts:233, 247-262`; expose `rotateWriter(logRoot)` rather than having
   tests poke the map). Future events chain cleanly and the fork stops growing.
3. **Acknowledge** the evidence, then sync.

**It must not take `withSidecarLock` around the whole thing.** `emitEvent`
(`src/eventlog.ts:275`) and `sync` (`src/sidecar.ts:321`) each take that lock, and it
is documented **non-reentrant** — wrapping `sync` in it deadlocks for the full
timeout (`src/lock.ts:144`). Heal needs lock-held internal variants, or must release
before calling those entry points.

**No standalone acknowledge surface** — no web button, no MCP tool. Acknowledging
without rotating leaves the fork growing, so the command that acknowledges is the
command that rotates. The one exception is a teammate looking at someone else's fork,
where heal degrades to acknowledge-only and names whose clone must rotate. Writer ids
are opaque by design, so the message can only say "whichever clone holds writer
`w_…`" and the team finds it by asking.

### The `scope.acknowledged` event

`kind: "scope.acknowledged"`, subject the scope, ordinary envelope so it syncs like
any write. `data.acknowledges` is a list of `{ reason, digest }`, one per piece of
blocking evidence.

**The digest must be an injective encoding** — canonical JSON arrays or
length-prefixed fields. The NUL-join above is the third instance of this bug class in
this repo, and it bites here identically: `{writer:"w", prev:"a", ids:["b","c","d"]}`
and `{writer:"w", prev:"a\0b", ids:["c","d"]}` serialise to the same bytes under a
NUL join, so one acknowledgment silences evidence it never named. Duplicate-id
evidence digests the id plus the sorted hashes of each distinct byte-form of the
line, which is what makes a *third* differing claim re-block.

**The acknowledgment must causally cover the evidence.** Identity-by-digest alone
lets a digest be planted before its evidence exists, lying dormant until matching
evidence appears — pre-acknowledging a fork nobody has seen. Require that the ack
event `saw()` every evidence event, which the fixed vector can now answer. This is
the one place the vector fix pays for something other than contests.

**Person-gating is cooperative, not enforced.** `resolveActor` classifies the CLI as
a person unless the environment marks it agent-driven (`src/identity.ts:68`), so an
agent with shell access can invoke the command and present as a person. Say so in the
document rather than implying a boundary the design cannot hold — there is no server
and no auth, by choice.

`scopeStatus` (`src/eventlog.ts:482-527`) computes blocking evidence as today,
subtracts digests acknowledged by a person whose ack covers them, and blocks on the
remainder. Everything current acknowledged ⇒ `status: "complete"` plus
`acknowledged: ScopeDiagnostic[]` so the history stays visible. A later fork or a new
differing duplicate produces a digest no ack covers, so it blocks again — that
property is what makes acknowledging safe. An unsupported `sidecarProtocol` is never
acknowledgeable: acknowledging it would be reading data you cannot interpret.

Do **not** persist a prose copy of the evidence on the event. `scopeStatus` must
recompute the live diagnostic to decide whether a digest still matches, and
`acknowledged` already exposes that; a second stored copy only drifts.

## Tests, each with a control

A test that would pass if the mechanism did nothing is not a test — this branch has
shipped several. `npm test` is one process at `--test-concurrency=1`, so
`markAgentSession` must be undone with `clearAgentSession` in `finally`. Copying a
clone directory to a new path misses the `writers` cache and re-reads the copied
`.git/codemap-writer`, which is how a test fabricates a shared writer id.

| test | asserts | control |
|---|---|---|
| **T-A1** counterexample | `saw(X,F1)` false, `heads()` contains F1 | same events with F2 chained: `saw` true, `heads` just X — catches a "drop all own-history" non-fix |
| **T-A2** no cross-branch sight | mid-chain fork, `saw(b2,b1)` false | `saw(b1,a)` and `saw(b2,a)` both true — the shared prefix must survive |
| **T-A3** key injectivity | writer `w`/id `root\0tail` vs writer `w\0root`/id `tail` do not alias | ordinary ids still resolve |
| **T-A4** cycle | a `writerPrev` cycle blocks the scope | an acyclic scope is unaffected and `heads()` is non-empty |
| **T-B1** intra-fork contest | raised, both sides carrying the same writer | linear own-chain revision raises none — this is what proves `saw` subsumes the deleted `sameWriter` |
| **T-B2** settling across a fork | person naming both heads clears it; agent does not | — |
| **T-G1** head capture | `emitEvent` after a fork names both branch heads | linear scope names one — pins that `heads()` did not start returning everything |
| **T-M1** shared writer id | B's sync fails naming the shard, B's events still readable, remote tip unmoved | same scenario without the copied writer file: both sync, a third pull sees both — catches `-merge` breaking ordinary merges |
| **T-M2** heal | merged shard has every event from both sides; next emit carries a new writer id; scope `complete` with the diagnostic retained | as an agent: refused, scope stays blocked. A *new* forked pair after heal re-blocks — this is what proves acknowledgment is evidence-keyed and not a scope mute |
| **T-ACK1** digest discipline | matching ack completes; one altered id still blocks | an ack that does not causally cover its evidence does not complete |

Asserting `MATERIALIZER_VERSION` moved is worthless — control-free by construction.
Instead fold a forked scope through `readCached` and assert the stored status
round-trips `acknowledged`, with an unrecognised status string still reading
`blocked`.

## Open

- **Heal's remote-fork UX** can only name the opaque writer id, never the machine.
  Accepted; writer-id anonymity is deliberate.
- **`isAgentActor` inside `scopeStatus`** adds an `eventlog → identity` import.
  Check `src/import-cycles.test.ts`; inject the predicate if it cycles.
- **Byzantine writers remain out of scope.** A writer that lies in `after` or
  `writerPrev` over-credits itself. The protocol has always trusted causal claims;
  this design does not change that, and does not claim to.
