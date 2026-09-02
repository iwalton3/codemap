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

**A bug backlogs too**, and this once refused — on the argument that a bug is already the
tracked record, so a second deferral queue over the queue people read would be quieter than
the queue itself. What answers that is the constraint below: a backlogged BUG is never
silenced. See *The bug backlog*.

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

**A squashed or rebased merge falls back to GitHub, because ancestry cannot see
one.** Both rewrite the commit, so the head a finding was witnessed at is never an
ancestor of the trunk however completely its code landed — left there, a team that
squashes has every such finding reading "still in review" for ever and an empty
debt filter.

The order is the design, and `landingOf` is a pure function of it so it can be
tested without a GitHub repo:

1. **Ancestry when it can speak.** Local, free, never wrong when it says yes, and
   right about the stacked case where a PR's status field is not — a PR merged
   into another feature branch has not reached the trunk.
2. **`null` stays `unknown`.** No `sourceRef`, `@work`, or a commit this clone
   does not have. Guessing puts real debt in the wrong pile silently.
3. **Only a NEGATIVE consults GitHub**, because that is the one ambiguous answer.
   A merged pull request's code is on the trunk however it got there.
4. **A failed lookup keeps ancestry's answer.** No `gh`, no auth, no network, a
   timeout: the verdict is what it was before this existed. "I could not ask" is
   never a verdict.

The lookup is `gh pr list --state merged` for the bulk of it and a single
`gh pr view` for anything outside that window — and **the window being capped is
load-bearing**: `Acme.React` returned exactly 200, the limit, so absence there means
"older than the 200 most recent merges" and not "not merged". Measured: PR #1 is
outside the window and answers `true` through the single lookup, where treating
absence as authoritative would have called it open. Both answers are cached, a
`yes` for ever (merged is monotonic) and a `no` on the list's TTL — without the
second, every open pull request costs a round trip on every page load, since an
open PR never appears in the merged list at all.

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

## The bug backlog — the same third exit, one record kind over

A bug nobody will reach this quarter has the same two bad options a finding had: stay in
the open queue and dilute it, or close as won't-fix, which asserts a decision nobody made.
The first is what actually happens, and it is how a bug queue stops being read.

`SharedBug.backlogged` is the same record — `until` required and fold-enforced, witnesses
snapshotted at grant time, principal-granted at both ends, no MCP tool
(`ops-reach.test.ts`). Three things differ, and each is forced by what a bug IS.

**It is never deleted and never silenced from search.** That is the one hard constraint.
A finding can afford `sleeping` to be quiet because it is a claim about one pull request;
a bug is a standing defect record, and a defect you cannot find is worse than one nobody
has prioritised. So a backlogged bug leaves the WORKING lists and nothing else: it stays in
`search`, in the backlog list, and on the detail page, and every surface that shows it
carries a visible `backlogged until <date>` so it never reads as an ordinary open bug that
everybody is ignoring.

**Its own list, not a bucket.** Findings got six buckets on one page because they had one
undifferentiated pile. Bugs already have a queue people read, so this is a sibling filter
(`bugs?state=backlog`) — and the point is that the main queue means "what we are doing"
again. The queue counts beside it exclude the sleeping ones for the same reason `sleeping`
is out of `attention`: counting a live deferral as work makes deferring honestly look
identical to ignoring the thing. `backlogged` and `sleeping` are reported next to them, so
nothing is uncounted.

**The release condition fires without anybody visiting the list.** `due` and `woken` are
back in the working queue on the next read — a deadline that needed somebody to open a
separate page would be a note rather than a mechanism. They are derived, so no fold can
disagree with them.

**The witnesses bind to the bug's own live citations, and the FOLD checks it.** A witness
on unrelated code would answer drift about code the bug is not about: edits to the actual
defect would never wake it and edits elsewhere would. The finding fold could not hold that
line for a node target — a node's citations are store state — but a bug's are fold state,
so here it does.

It cost `MATERIALIZER_VERSION` 19 → 20, for the reason 18 → 19 gives verbatim: a teammate
folds a backlogged bug into nothing on the old build, upgrades, and their unmoved shards
serve cached rows that keep it in the working queue for ever. `db-migrate.test.ts` pins
the bugs fold's vocabulary the way it pins the findings fold's.

## Findings in search

`search` reached anchors, nodes and bugs. A finding was the one canonical record kind it
did not, so the only ways to find one were to already know its pull request or to page a
list — a defect somebody reported eight months ago was unfindable by what it says.

The backlog is what made that urgent rather than untidy. A finding used to be scoped to a
live pull request and read in that context; it can now be live on the trunk for months,
which is exactly the kind of thing somebody rediscovers from scratch. Search is how you
find out it was already known.

Four things it gets right, each of which is a defect when absent:

- **It leads with `comment`, and matches `text` as well.** The names are inverted from what
  they suggest: `comment` is the description of the defect and `text` is the running triage
  narrative. A hit that led with `text` answers "what is the defect" with the audit trail
  of what people did about it. The backlog page shipped that once and had to swap it.
- **Closed findings match, and sort last.** "Was this ever reported?" is the question
  search is for, and a refuted finding is often the best possible answer — somebody
  already looked, and their reasoning is in the record. The hit carries `state` and any
  `backlogged` deadline, because a refuted one, a live one and a sleeping one are three
  different answers to the same query.
- **It materializes first.** The canonical table is a projection; a read straight off it
  would not see a teammate's finding until some unrelated list happened to fold the scope,
  which is precisely the finding somebody is most likely to search for. `search` and
  `findingBacklog` share `materializeFindingScopes` for this.
- **Findings sit beside the code results, never in front.** Search is primarily how an
  agent locates a symbol; findings are context.

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
- `bug-backlogged.test.ts` — the BUGS fold, on hand-built events, every guard
  mutation-checked. Same reason as the first entry, and it is the only thing that can see
  a guard binding one end.
- `bug-backlog-flow.test.ts` — which lists a deferred bug leaves, which it must not, and
  that the witnesses are taken at grant time rather than read off the record.
- `findings-search.test.ts` — including that a teammate's finding is found straight from
  the log with no list read first.

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
