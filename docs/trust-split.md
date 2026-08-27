# Splitting `trust`

**Status: proposal. Nothing here is built.** Written 2026-08-27, out of the COD-17 /
COD-18 discussion. It supersedes nothing; `trustOf` is correct for what it measures.

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

## Proposed shape

Four fields, replacing one. Names are provisional.

```ts
{
  fresh: boolean,                  // the cited code still matches what was witnessed
  accountable: { by: Actor, at: string } | null,   // a person signed. Never derived.
  evidence: {
    reads: number,                 // corroborating reads on the CITED set
    errorIndependent: boolean,     // at least two distinct error profiles
    lastAt: string,
  } | null,
  coverage: "derived" | "unknown", // ONLY "derived" when a recorded derivation re-runs clean
}
```

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

1. Emit the four fields from the 7 `trustOf` call sites (`ops/graph.ts` ×4,
   `ops/read.ts` ×3).
2. Teach the web `trustChip` to render freshness and vouching as separate chips.
   Today one chip flips to `stale` and hides who signed.
3. Make `sameMark` actor-aware so accountability and evidence rows coexist. **This is
   the change that lets `confirm` drop its guard**, and it is the only one that touches
   stored review rows.
4. Only then consider removing `trust`.

Steps 1–2 are safe. Step 3 is a stored-shape change and wants its own review.

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
