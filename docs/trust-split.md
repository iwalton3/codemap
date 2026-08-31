# Splitting `trust`

> **Kind: decision record** — why the code looks the way it does. Finished; kept for the
> argument, not as a to-do.

**Status: BUILT.** Steps 1–3 shipped (`a5f091a`, `e95899d`, `d5020cc`), plus
`Mark.profiles`. Step 4 (removing `trust`) is deliberately not done — `trustOf`
computes something real, 25 call sites read it, and it is unchanged. Written
2026-08-27 out of the COD-17 / COD-18 discussion.

## The problem in one line

`trust` is a single word carrying **four independent claims**, and a reader takes it
as answering all of them.

```
trustOf(status, review) -> "verified" | "checked" | "unverified" | "stale" | "generated"
```

The four, pulled apart:

| claim | question | checkable? | who can make it |
| --- | --- | --- | --- |
| **freshness** | has the cited code moved since it was witnessed? | yes, mechanically | nobody — it is derived |
| **accountability** | who is answerable for this? | **no** | a person, only |
| **evidence** | what examination exists, and how independent? | yes | anyone; quality varies |
| **completeness** | is the cited set *the subject*? | only via a predicate | nobody, by assertion |

`trustOf` computes freshness × (accountability ⊔ evidence) over the **cited** anchors
and says nothing about completeness — while returning one word that reads as a verdict
on all four.

## Why this is not cosmetic

**1. `stale` is a freshness answer occupying a trust slot.** `trustOf` short-circuits:
`status === "stale" → "stale"`, before it looks at any mark. So a doc that a human
signed and an agent re-checked is indistinguishable from one nobody ever read, the
moment the code moves. Two different situations, one word.

**2. The ladder contradicts COD-18.** `verified` (human) ranks above `checked` (agent)
— but COD-18's thesis is that the human prior is no longer maintainable, and a
broken-prior sign-off is *worse* than none, because it carries more authority and stops
the next reader. Both statements are true at once and cannot be said with one scalar:
the sign-off is valid **accountability** and worthless **evidence**.

**3. It forces destructive writes.** `sameMark` (`src/reviews.ts`) keys review rows on
target + level, **not on actor**, so there is one row per level and an agent mark
replaces a human's sign-off. `confirm` now refuses to record on a signed doc purely to
avoid this (see `confirm-review.test.ts`) — a guard that exists only because two claims
share one slot.

**4. Completeness has nowhere to go.** COD-17 wants to say "this list is the whole set".
Rendering that in the same position as an evidence claim guarantees it is read as one.

## Evidence the axes come apart

Measured this session, in both directions:

- one person, two vendors → **not** independent (same principal), **is**
  error-independent (different harness). This is the practice actually in use.
- two people, one harness → independent, **not** error-independent.

`isIndependent` / `isErrorIndependent` already model this split for corroborations.
The same split has not reached reviews.

## The shape — as SHIPPED, not as first proposed

Four fields beside `trust`, emitted from all 7 `trustOf` call sites (`vouchOf`,
`src/ops/shared.ts`):

```ts
type Mark = { at?: string; level: "logical" | "code"; current: boolean };

{
  fresh: boolean,              // node not stale AND no mark's witness moved
  accountable: Mark | null,    // a person signed. Never derived.
  evidence: Mark | null,       // an agent read the code and the claims held
  coverage: "derived" | "unknown",
}
```

Two changes from the first draft, both because the field would have been vacuous:

- **`evidence.reads` was dropped.** Reads are a heat signature, not evidence: more
  reads means more references means the cited code is MORE likely to be churning, so
  a count points the wrong way. What matters is distinct ERROR PROFILES — and that
  cannot vary until step 3, because one row exists per level, so the number would be
  pinned at 1. `errorIndependent` waits for the same reason.
- **`current` was added to each mark**, and it is the part the first implementation
  got wrong. A mark whose body moved has `state: "stale"`, not `"reviewed"` — so
  "a mark exists" and "a mark is current" are different questions, and reading only
  `reviewed` returned `accountable: null` on every real stale doc. See the note under
  Migration.

Rules that make it honest:

- **`accountable` is never inferred.** No agent act produces it, ever.
- **`coverage` is never asserted.** It is `"derived"` iff COD-17's `derivedFrom`
  re-derives the cited set clean, `"unknown"` otherwise. No author-set enum — a
  self-report of exhaustiveness by the party whose exhaustiveness is in doubt is the
  failure COD-17 describes, not a fix for it.
- **`fresh: false` does not erase the others.** A signed doc whose code moved is
  `{fresh: false, accountable: {...}}` — which is the true statement, and the one the
  current `"stale"` throws away.

## Migration

**Additive first, exactly as `errorIndependent` was done.** Keep `trust` computing
what it computes today; add the four fields beside it. Nothing stored changes meaning,
the web keeps rendering `trust`, and `src/api-map.test.ts` stays green.

Then, in order:

1. ~~Emit the four fields from the 7 `trustOf` call sites.~~ **Done.**
2. ~~Teach the web to render vouching separately from freshness.~~ **Done** — and it
   turned out `statusChip` was ALREADY the freshness chip, sitting immediately beside
   the trust chip. So the old `trustChip` collapsing to `stale` duplicated its
   neighbour *and* destroyed the vouch. The chip now renders who vouched; a vouch on
   a body that has moved is muted and struck through rather than hidden.
3. Make `sameMark` actor-aware so accountability and evidence rows coexist. Designed
   below. **The change that lets `confirm` drop its guard**, and the only one that
   touches stored review rows.
4. Only then consider removing `trust`.

**A warning from step 1, worth carrying into step 3.** The first implementation was
wrong and its unit test hid it: the test hand-built `{state: "reviewed"}` alongside a
stale node status, a pairing the system never produces, so it passed while the feature
did nothing on every real stale doc. Only rendering a real universe caught it. Step 3
multiplies the states a review can be in, so a test built from hand-written rows is
even less likely to be testing something reachable — **drive it through the real ops.**

## Step 3, as built — actor-keyed review rows

The hinge, and it delivered all three: `evidence` counts distinct error profiles,
`confirm` dropped its don't-overwrite-a-person guard, and a human sign-off and an
agent check now coexist instead of one silently replacing the other.

### THE DESIGN WAS WRONG ON THE KEY, and this is the part to read

This section said *"the key already exists: `reviewerKey`. Do not invent a second
one."* That was insufficient, and following it left the hazard open in the common
case. `reviewerKey` is `principal \0 model`, **nothing sets `CODEMAP_AGENT_MODEL`**,
so a person and their agent shared a key and the agent went on overwriting the
sign-off.

What caught it: the full suite passed 1075/1075 **including**
`confirm-review.test.ts`'s characterization test, which asserts that an agent mark
replaces a human's and was written to FAIL at this point. It passing was the signal
— a green suite as evidence that the change had not landed.

Reviews key on `principal + model + ACTOR KIND + observed HARNESS`:

- **actor kind**, because accountability and evidence are the two claims this split
  separated and must never share a row, whatever is recorded about the model.
- **harness**, because it is transport-observed (`markObservedClient`) and
  unforgeable, and is the field that actually varies for a cross-vendor check.
  `model` is self-reported and only ever ADDS separation.

`reviewerKey` itself is untouched — corroborations depend on its semantics, and
changing it there would change their dedup.

### What is actually stored, and what that rules out

Reviews are **local-only**: a JSON blob under the `reviews` meta key
(`readReviews` / `writeReviews`), not in the sidecar log, not folded, not projected.
So this needs **no event kind, no `MATERIALIZER_VERSION` bump, no cross-clone story,
and no DDL.** That is most of the risk gone before the design starts, and it is worth
confirming again before anyone writes code, because it is the assumption everything
below rests on.

### The change

`sameMark` used to key on `target.kind + target.id + level + isViewedRow`. Reviewer
identity is now part of that key (`rowIdentity`), so there is one row per *reviewer*
per level.

The reasoning that justifies keying on the reviewer at all is `reviewerKey`'s own
comment — *"A reviewer running two models produces two verdicts, and they are two
opinions rather than one revised one: collapsing them makes the second silently
overwrite the first, disagreement included."* That is correct and is why reviews now
key this way; it is just not the whole key (see above).

Legacy rows carry no `by` and key on the `reviewer` display string, which every row
has, so they stay one-per-level — which is what they already are.

### The compat surface: 25 call sites read the collapsed shape

`reviewStatesFor` / `reviewTriageFor` / `anchorReviewMap` are consumed at ~25 sites
across `diff.ts`, `ops/graph.ts`, `ops/read.ts`, `ops/triage.ts`, `pr.ts`, `pr-bulk.ts`
and `triage.ts`. **Keep `ReviewInfo` / `ReviewPair` as the collapsed view** and add
`marks: Mark[]` beside it. `deriveCodeReview` then needs no change at all — it folds
`ReviewInfo` across anchors and never sees the list.

### The collapse rule, and the property that makes it safe

One `ReviewInfo` from N rows: pick the strongest, ordered **human before agent**, and
**current before stale** within each. `state` is that row's state.

The safety property, and it is worth stating because it is what makes this a
non-migration: **no stored review changes meaning.** Every existing store has at most
one row per (target, level, viewed), so the collapse is the identity on all of them —
`trust` reads exactly as it reads today. Multi-row states cannot exist until this
ships, so nothing is retroactively reinterpreted.

Note the collapse rule does change what `trust` WOULD say in a case that cannot occur
yet: a stale human sign-off beside a current agent check reads `checked` rather than
`stale`. That is the right answer — somebody has confirmed the body in front of you —
but it is a new behaviour, not a preserved one, and it should be tested as such.

### The hazard it creates — CLOSED in the same commit, in both write paths

`unmarkReviewed` filters out **every** row matching (target, level, attestation-class),
regardless of who made it. Today that is harmless because there is only one row, so
"drop the mark at this level" and "drop MY mark" are the same operation.

**The moment rows multiply, that function becomes a way for an agent to delete a
person's sign-off** — through the ordinary `review(unmark: true)` tool, with no guard
and no record. It now drops only the caller's own mark.

`markReviewedBatch` had the same defect and considerably louder: one
`review(ids: [...])` call spans a whole `pr_packet` page, so an unnarrowed replace
would wipe a reviewer's marks across an entire pull request in a single call. Also
narrowed.

This is the same shape as the `confirm` guard: two claims sharing one slot, where the
code that was correct for one becomes destructive for two.

### `accepted` carry-forward

`markReviewed` carries forward `acceptedOf(prior)` from the single same-mark row, so an
earlier acceptance is not dropped when the row is replaced. Per-reviewer, each reviewer
carries their own set, which is the honest reading — an acceptance is a statement by
somebody. Anywhere the question is "has ANYONE accepted this body", take the union at
read time rather than merging on write.

### `Mark.profiles`, shipped with it

`errorProfile(actor)` is the profile as a KEY rather than a pairwise predicate, so
"how many distinct profiles vouched" is a set size rather than an O(n²) scan, and
`isErrorIndependent` is **derived from it** rather than duplicating the rule — the
two cannot drift.

- a person is their own profile, keyed on the principal
- an agent is keyed on harness + model, NOT the principal: two people running one
  harness make the same mistakes, which is the point
- a person and an agent are never the same profile
- conservative when unknown: two agents with neither harness nor model recorded key
  the same, because nothing establishes that they differ

`profiles: 1` is reported rather than omitted, so a reader can tell one profile from
"this build does not compute it". It is **absent on derived rollups** — a node's code
review is folded from its anchors by `deriveCodeReview`, which has no rows to count.

`confirm` dropped its guard. Its characterization test now asserts the opposite of
what it did, which is what it was written to prompt.

## Open decisions

1. **Does `viewed` belong on the accountability axis or the evidence axis?** It is a
   human act that explicitly does *not* vouch ("laid eyes on this, intuition didn't
   fire"). It reads like weak evidence rather than accountability — but it is the pass
   COD-18 says is now nearly worthless without a prior, so it may deserve neither.
2. **Does `evidence.reads` count reads by the same error profile?** Two reads from one
   harness are not two reads in any useful sense. Suggest counting distinct profiles,
   not acts — otherwise the number rewards rerunning the same agent.
3. **What is `coverage` for a node with no `derivedFrom`?** `"unknown"` is honest but
   will be ~100% of nodes at first. That is the correct starting reading and should not
   be softened; the queue it creates is the COD-18 work-list.
4. **Does `generated` survive?** It is an origin, not a trust level — arguably it
   belongs with `status`, and its presence in this enum is a fifth thing sharing the
   slot.

## What this does NOT fix

Completeness still needs the predicate COD-17 asks for; this only gives it an honest
place to be reported. And nothing here improves the *quality* of an agent's read — it
only stops that read being confused with a person's sign-off.
