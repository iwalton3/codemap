# The finding backlog — what happens to a finding nobody actioned

Normative for `backlog`, `rewitness` and `findingBacklog`. Read it before changing
any of them.

## The problem, measured

A pull-request finding has two exits: somebody fixes it, or somebody promotes it
to a bug. A finding that is real, is not severe enough to hold the merge, and is
not worth a bug record has **no third exit** — so it stays open on a pull request
that merges, and nothing looks at it again. It is not marked won't-fix, not
closed, and never raised. The code rots under it until somebody rediscovers the
defect from scratch.

Measured 2026-09-01 across two live universes, read-only, judged against each
trunk (`origin/develop`, `origin/main`):

- **227** findings filed on 13 merged pull requests; **97 (43%)** still open.
- Of those 97: **46 (47%)** with the witnessed code **unchanged** — the claim is
  still exactly true of the trunk. **24 (25%)** moved. **18 (19%)** have no
  witness at all, so nothing can judge them.
- Of the 46 live ones, **41 have no disposition of any kind**. Nobody said
  anything about them, ever.

The workaround people reached for is in the records. Every one of the seven
deferrals anybody *had* made has an empty `ref`, no date, and its escape hatch
written in prose — including one reading *"deferred to bug_7a5b29e71285 so it
survives the PR closing"*. That is the bug queue being used as a holding pen.

## The backlog

`SharedFinding.backlogged` is the third exit: **real, not now, and it comes back.**

On the review surfaces the three dispositions read **Escalate** (surface it to the team),
**File Bug** (it is a defect somebody will fix) and **Backlog** (defer it, with a deadline).

```ts
backlogged?: {
  until: string;            // ISO date. REQUIRED. The release condition.
  witness?: BugWitness;     // the code when it was BACKLOGGED
  reason: string;           // REQUIRED
  by: Actor; at: string;
  ref?: ExternalRef;        // a Jira issue — evidence, NEVER the condition
}
```

Four rules, and each exists because leaving it out produced a specific failure:

**`until` is required, and the fold enforces it.** Same rule and same wording as
`acknowledgements`: a linked issue may be evidence but never the release
condition, because a ticket closed as won't-do, moved or deleted leaves the
record asleep permanently and silently. Every deferral on record was in exactly
that state.

**The witness is snapshotted at GRANT time, not read off the finding.**
`SharedFinding.witness` is from filing time, and backlogging normally follows an
investigation — so a condition keyed on the filing witness fires the moment it is
set, on code that moved days ago. Drift against its own witness means
somebody is editing the exact code the decision was about. That is the early
wake, and it is the half only codemap can offer.

**Principal-granted, like `debt`.** With a backlog this size, deferral is the
cheapest way to empty a queue. The tool refuses an agent AND the fold drops an
agent's `finding.backlogged`, because a teammate's clone applies the log without
ever seeing the tool. Bringing one back is gated identically — an agent that
could do it to every finding is the same move from the other side. `ops-reach.test.ts` forbids an
MCP tool for either.

**A bug is refused rather than backlogged.** A bug is already the tracked record; a
second deferral queue over the queue people read is the thing this avoids.

## Re-witnessing, and why an agent may

`rewitness` attaches a witness to a finding filed without one. It is the only act
here an agent may perform on its own, deliberately: a witness-less finding cannot
be judged against code by anything — not re-checked when a branch lands, not
shown as live or fixed, never able to leave `unjudgeable`. That was 19% of the
measured backlog, and left to people it is never repaired.

It is **evidence, not a disposition**, which is why the gate is off. Two rules:

- It refuses to replace an existing witness. Re-baselining one silently moves
  every drift answer that depends on it.
- It records `witnessAttached`, because a retro witness testifies from that
  moment on and **not** about the code when the finding was filed.

## Re-evaluate — handing it back for a fresh look

`finding.assigned` had been folded since the record existed, and
`findingAsQueueEntry` had been mapping an assignment into `review_queue` just as
long — with no emitter, no op and no tool, so nothing could ever put one there.
The whole verb was missing at one end.

It answers *"I think this was fixed, but somebody should check"*, which had no way
to be said: the alternatives were closing the finding (asserting something nobody
verified) or leaving it, which is how the backlog filled up. The ask names what a
fresh look means — is it still true, re-witness it if it has none, report — so it
is not merely "look again".

**Ungated, and that is the line the surfaces are drawn on.** Re-evaluate, File Bug
and Backlog all ask or defer; none of them ends anything, so they sit on the row.
Resolve and refute assert something about the code, and a list is exactly the
shape that invites clearing a queue without reading it — so those two live only
inside the opened finding.

**A fresh ask CLEARS the standing `outcome`, and the fold is where that happens.**
`reviewQueue` keeps an item only while `includeAnswered || !outcome`, so without
it a finding somebody had already reported on was handed back and appeared in no
queue at all — silently, and for exactly the case the button exists for. The local
path cleared it and the fold did not, so the two stores disagreed; the fold is the
authority and now does. `outcomes` is untouched: it is append-only history, and a
re-ask does not unsay what earlier rounds found.

## `landed` — when a finding changes kind

A pull request merging to the default branch is the moment a finding stops being
review and becomes debt. That is decided **by ancestry, not by a pull request's
status field**:

```
landed   sourceRef is an ancestor of the trunk
open     it is not
unknown  sourceRef is absent or "@work"
```

Local, no network, and *more* correct than asking GitHub — it gets stacked pull
requests right, where the status field does not. `Acme.API` #280 reads `MERGED`
while its code went to `feat/deferred-charge-pricing`, so its findings are still
ordinary review. `unknown` is recorded rather than guessed; it was a third of the
measured findings, and guessing either way puts real debt in the wrong pile
silently.

**Known limitation: a squashed or rebased merge reads `open` for ever.** Both
rewrite the commit, so the head a finding was witnessed at is never an ancestor of
the trunk however completely its code landed. On a team that squashes,
`byLanding.landed` is permanently 0 and the debt filter is permanently empty.

Shipped with it, deliberately. `open` costs a finding nothing — it stays in every
bucket, in `attention`, and on the page; what is lost is the debt/review SPLIT,
which is a lens over the queue rather than the queue itself. Ancestry is also the
half that is never wrong when it says `landed`, and it gets the stacked case right
where a pull request's status field does not.

Fixing it needs one of: patch-identity (`git cherry` recognises a rebased commit;
a squash of N commits into one defeats it), or the merge commit from the pull
request's metadata — a network read this deliberately avoids. Raised by both
reviews of the branch that built this; recorded rather than quietly dropped.

**Nothing runs at merge, and nothing should.** `landed` is derived on every read,
so there is no state to keep in sync and no event whose absence could strand a
record — which is the same reason the sidecar architecture gives for deriving
rather than storing.

**But it must be cached.** `isAncestor` is NOT memoised inside `git.ts` (a
comment once claimed it was), so this cost one `git merge-base` per finding —
211ms for 91 calls on `Acme.API`, against 21ms for the 11 distinct commits behind
them, and growing with the finding count rather than the history. `landedIn`
memoises on the trunk's **resolved SHA**, which is what makes a process-lifetime
cache sound rather than merely fast: ancestry between two fixed commits is
immutable, so there is nothing to invalidate, and a fetch that advances the trunk
produces a different key instead of a stale answer. Keying on `origin/main` would
have been the bug.

## The six buckets

`findingBacklog` is a **projection**, not a record — everything in it is derived,
so no fold can disagree with it. Ordered by what somebody should do:

| bucket | means | next move |
|---|---|---|
| `due` | backlogged, deadline passed | you said you would come back |
| `woken` | backlogged, its code moved | somebody is editing that code now |
| `live` | not backlogged, code unchanged | still true, and undisposed — the debt |
| `moved` | not backlogged, code changed | re-read; a moved body is not a fix |
| `unjudgeable` | no comparable witness | `rewitness_finding` repairs it |
| `sleeping` | backlogged, still asleep | nothing — a decision somebody made |

**`sleeping` is excluded from `attention`.** Counting a live deferral as debt
makes deferring honestly look identical to ignoring the thing, which would train
people out of the one honest exit.

**`needsAck` is not a bucket.** It is a property of findings the buckets already
count, so summing it beside them makes one record two items — a mistake the
dashboard shipped once and `dashboard-attention.test.ts` now fails on.

## What must not happen

**Nothing here promotes anything to a bug.** `defer_finding` remains the right
verb for a finding that IS a defect somebody intends to fix — that is the
ordinary case and it should stay easy. What breaks a bug queue is *mass*
conversion, sweeping a pull request's leftovers into it until the queue stops
meaning "defects we said we would fix" and starts meaning "things reported on a
PR six months ago". `deferFinding` therefore **warns on the run rather than the
act** (the `cover` precedent): past five conversions on one pull request it says
so and names the backlog as the alternative. It never refuses.

## Upgrade skew — why this needed `MATERIALIZER_VERSION` 18 → 19

The question a mixed-version team makes urgent: can a teammate a day behind be
harmed by a backlogged finding that arrives before they upgrade?

**Their log cannot be corrupted.** The log is append-only and the new events are
just records in it. `foldFindings` has no `default:` case, so an old build drops
`finding.backlogged` silently and keeps folding everything after it — verified by
feeding the fold an event kind no build has. They simply do not see the deferral, which
is the correct degradation. Nothing rewrites a fold-owned row either:
`writeLocalFinding` refuses one outright.

**The danger is the other direction, and it is real.** The scope fingerprint is
`MATERIALIZER_VERSION` + identity + scope + each shard's name, size and mtime. It
does not know what the fold knows. So: the teammate pulls a backlogged finding on the old
build, folds it into nothing, and upgrades. Their shards have not moved since that
fold, the fingerprint is unchanged, and the new build reads the CACHED rows —
showing the finding as undisposed for ever while the log has said otherwise the
whole time. The finding reads as debt on one machine and as a decision on another,
which is precisely the disagreement the log exists to prevent.

Confirmed rather than assumed: re-reading a scope whose shards have not moved runs
no fold (`foldCount` unchanged), and bumping the version moves the fingerprint
(`d12b587d…` → `bf544b78…`) and forces the refold.

So the bump is required, and it is a **refold, not a migration**: no column moved,
because `backlogged` lives inside the `findings.body` JSON. Only derived rows are
discarded and rebuilt from events that were always there. Nobody's log is touched.

`db-migrate.test.ts` pins the findings fold's event VOCABULARY to the version —
the sibling of the standard test's table-set pin, and vocabulary rather than tables
because no column changed here, so the coarse signal would not have caught it.

## What it costs, measured

`findingBacklog` re-indexes every file a live witness names — one tree-sitter parse
per file — because the six buckets are drift answers and drift needs today's
hashes. On `Acme.API` (125 open findings, 55 distinct witnessed files, ~900 KB)
that is **343ms**, and the dashboard reads it, so the landing page pays it.

Kept rather than optimised, for three reasons: the file set is computed AFTER the
closed and bug-linked findings are dropped, so it already indexes only what it
needs; the dashboard has always re-indexed bug-cited files for the same reason, so
this is the accepted shape and not a new one; and a cache here would need an
invalidation story against a working tree that changes constantly. If it becomes a
problem the answer is probably to let the dashboard ask for counts without the
rows, not to cache parses.

The ancestry half is separately cached — see `landedIn`, 211ms → 21ms.

## Tests that hold this up

- `finding-backlogged.test.ts` — the fold, on hand-built events. Every guard
  mutation-checked. This is the only thing that can see a guard binding one end.
- `finding-backlog-flow.test.ts` — the verbs, on real stores, both the local table
  and the sidecar log, under an agent actor and a principal.
- `finding-backlog.test.ts` — the six buckets, `landed`, and the bulk-conversion
  warning.
- `dashboard-attention.test.ts` — that the dashboard's number and the backlog's
  are one number, and that the branch card offers a fork point or nothing.

## Read-path invariant

**`findingBacklog` MUST materialize before it reads.** The canonical table is a
projection; reading it raw is how a `MATERIALIZER_VERSION` bump gets bypassed. An
upgraded store whose shards have not moved would serve rows its OLD build folded —
with no `backlogged` on them — for ever, which is the exact skew the bump exists to
prevent. `sharedFindings` has always called `ensureMaterialized`; this read did not,
so the bump was necessary and NOT sufficient. Both reviews of this branch found it.

A fabricated hash will not produce drift, and should not: a witness from another
derivation is not evidence the code moved, so it reads `undecidable`. Build a
differing hash by changing the digest of a real one.
