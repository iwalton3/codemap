# Closing the gap: the sidecar as designed vs as implemented

Written 2026-08-23, after the five-step sequence finished and the whole arc was
exercised end to end against a clone of a real 148MB universe (`Acme.Settlement`,
275 docs, 1,222 anchors).

**The mechanism is complete. It has never been used by two people.** Everything below
is about that distance, not about missing machinery.

## What the live exercise proved

Worth recording, because it is the only evidence in this repo that is not a test:

| | result |
|---|---|
| open a real pre-existing store | **failed** — fixed in `720b6d9`, see "What contact found" |
| publish 275 local docs | 53 published, 200 analyzer-generated skipped, 22 flows skipped |
| first sync between two clones | 53 events received, one scope folded |
| the adoption rule on colliding ids | 275 rows before, 275 after, 53 adopted, 0 duplicated |
| a shared writer id | sync failed closed, named the shard and the writer, said what to run |
| `codemap sidecar heal` | unioned 55 events keeping both sides, rotated, acknowledged |
| both clones after the heal | `complete`, same winner, **both forked writes still present** |

The 200/22/53 split is the first real measurement of something the design argued from
first principles: analyzer output really is the bulk, so not syncing it is not a
rounding error.

## What contact found that 698 tests did not

One defect, and it is the reason this document exists.

**The build could not open any pre-existing store.** `migrate` created an index on
`source_scope` inside the `CREATE TABLE` block, which runs before the `ALTER` ladder
that adds the column. A fresh database has the column in its `CREATE TABLE`, so the
entire suite passed while `db()` threw `no such column` on every store that already
existed. Every test starting from empty is precisely the blind spot.

The lesson generalises and is the first item in the plan below: **this codebase has no
test that exercises an OLD store.** It now has one, and that is not enough — the
suite's fixtures are all born at the current schema.

## The gap, in five parts

### 1. No store in this repo is ever old

`db-migrate.test.ts` covers one hop. Nothing covers a store written by a build from
three schema changes ago, a store with data in tables the current build no longer
writes, or a `main`-era store with the legacy JSON import path.

**Close it by:** a fixtures directory of small, committed, pre-built stores — one per
schema era — that a test opens and asserts still reads. They are a few KB each. The
test is "it opens, its rows are intact, and the ladder ran"; the control is that a
current-schema store is untouched by it.

### 2. Nothing has ever synced under contention

Every sync in every test is sequential. The lock, the retry loop, the fetch outside
the lock and the merge inside it have never had two processes racing them for real.
The scenario harness serialises by construction.

**Close it by:** a test that runs two `sync` calls concurrently against one sidecar
(same clone, two processes — `child_process`, not two awaits), asserting that both
complete, no event is lost, and the lock was not stolen. This is the highest-value
missing test, because the lock's whole purpose is a case nothing exercises.

### 3. Three entity kinds are shared; two are not

Findings, docs, notes and walkthroughs sync. **Bugs and triage do not**, though the
original design put them in the sidecar. **Edges never sync**, so `process`/`step`
docs are refused — which means the flow-walker, a headline reviewer feature, is
single-player.

**Close it by:** deciding, not building. Bugs and triage are a genuine entity-kind
gap with no design behind them yet. Flows need an edge-sync design whose cost was
judged too high for zero demonstrated demand — and demand is now testable, because
somebody using this will hit "why can't I share this flow" within a day.

### 4. Two design questions are open and one mechanism is unbuilt

- **Whether findings become canonical rows** like docs did. Two reviews split. Docs
  are done, so this is now decidable on evidence rather than argument.
- **The tombstone rule** for a doc nobody can place. Five sub-questions written up in
  `docs/anchor-id-provenance.md`; until it lands, such a doc is queued rather than
  clearable, which is the deliberate holding position.
- **No writer-id rotation exists outside `heal`.** If a fork is somebody ELSE's clone,
  heal acknowledges and names the writer, and that person still has to run heal
  themselves. That is correct but untested across two real people.

### 5. The web UI has never shown any of this to a person

`serve.ts` routes the shared ops and `src/e2e/shared-ui.e2e.ts` exercises some of it
headlessly, but nobody has looked at a blocked scope, a contested finding, or a
teammate's doc in a browser and said whether it reads right. The north star is a
reviewer's cognitive load, and that is not measurable from a test.

## The plan, in order

**Order is by risk of silent wrongness, not by size.**

1. **Old-store fixtures** (§1). Small, mechanical, and it closes the class that just
   bit. Do this first because every later item risks another schema change.
2. **Concurrent sync test** (§2). The lock is the least-exercised safety mechanism in
   the system and the one whose failure is quietest.
3. **Use it for real, on one repo, for a week.** Two clones, two people, ordinary
   review. Nothing in items 4-6 should be built before this, because it is what turns
   "the flow-walker is single-player" from a judgement into a complaint or a shrug.
4. **Decide bugs/triage** (§3). Either design them into the sidecar or write down that
   they stay local and why — the architecture doc currently records the gap without a
   position.
5. **Decide findings-as-canonical-rows** (§4), with docs as the worked example.
6. **Flows, if and only if somebody asks** (§3). The refusal message already tells
   them the state of things; a complaint is the signal.

**Not on this list, deliberately:** more adversarial review rounds of the existing
code. The last four rounds each found real defects, and the fifth found the class that
only a real store could show. The marginal value has moved from reading the code to
running it.
