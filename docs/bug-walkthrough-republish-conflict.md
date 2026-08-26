# `pr_walkthrough` cannot re-walk a PR that has already been published

> **Kind: archive** — superseded or finished. Do NOT plan from it; read it only for history.
> resolved; the fix that shipped is deliberately not the one proposed here.


> **RESOLVED** in `cd7a711`, 2026-08-25. Kept because the diagnosis is the reason the
> fix looks the way it does — and because the fix is NOT the one suggested below.
>
> The suggested upsert (demote the row back to local) would have left the superseded
> event in the log, so the next fold adopts the local row with the OLD body and the
> re-walk is silently reverted on the next sync — worse than the crash. A fold-owned row
> may only change by an event, so a re-walk of a PUBLISHED reading IS a publication;
> `pr_walkthrough` skips the local write and republishes, and a publish that does not
> land is reported as a failed re-walk rather than as `ok`.
>
> The report did not reach a second crash of the same shape from the other side:
> `attributeLocalWalkthrough` renaming the migrated `''` row onto an existing published
> one. That is the doubled state the report measures on 269 and 271, and it now collapses.


**Found:** 2026-08-25, re-walking Acme.API PR #270 after the submitter pushed two commits.
**Store:** `/working/Acme.API/.codemap/codemap.db` · **codemap HEAD:** `384f32c`
**Severity:** blocking — the second walkthrough of any published PR fails, and the tool
surfaces a raw SQLite error rather than anything a caller can act on.

---

## Symptom

```
pr_walkthrough(pr: 270, features: [...])
→ Error: UNIQUE constraint failed: walkthroughs.pr, walkthroughs.author
```

`dryRun: true` passes cleanly on the identical payload (88/88 changed symbols covered,
8 features / 20 chapters), so this is not a validation failure — it is the write. The
transaction rolls back, so `pr_walkthrough_get` keeps returning the OLD walkthrough with
no indication that anything failed. An agent that does not check the read-back would
reasonably report success.

## Root cause

`writeLocalWalkthrough` — `src/store.ts:1790`

```js
d.prepare("DELETE FROM walkthroughs WHERE pr = ? AND source_scope IS NULL").run(String(pr));
d.prepare("INSERT INTO walkthroughs(pr,author,body) VALUES(?,?,?)").run(
  String(pr), actor?.principal ?? "", ...);
```

The DELETE is deliberately scoped to locally-owned rows — the doc comment above it is
explicit that "rows the FOLD owns are never touched: they may only change by an event."
The INSERT then writes under `actor.principal`, unconditionally.

But `walkthroughsProjection.write` (`src/shared-projections.ts:413-440`) adopts your own
published walkthrough into a row keyed on *your* principal. Its own doc comment predicts
this collision from the other side:

> Publishing your own walkthrough is a republication of the reading you already have, so
> the fold produces a row for YOUR principal that the local row is already holding
> `(pr, author)` for. Insert would violate the unique index inside the fold's transaction;
> adopting turns the local row into the folded one instead.

The fold handles the conflict by adopting. **The local writer has no matching path.** Once
a fold-owned row exists under `(pr, yourPrincipal)`, `writeLocalWalkthrough` can neither
delete it (wrong `source_scope`) nor insert beside it (unique index), so it can only fail.

## Why this is deterministic, not a one-off

The observed row state for this store, before and after:

```
BEFORE (PR 270 blocked)          AFTER (published, PR 270)
rowid pr  author        origin   rowid pr  author        origin
    4 270 ''            NULL         9 270 izzie@...     sync
    6 270 izzie@...     sync
```

Publishing leaves PR 270 with a single **fold-owned** row under the principal. That is
precisely the state that makes `writeLocalWalkthrough` fail. So the next re-walk of PR 270
is predicted to hit this same error — worth confirming with one throwaway re-walk, but the
code path admits no other outcome.

The general shape: **walk → publish → re-walk** breaks on the third step. Re-walking is not
an edge case; it is the normal response to the submitter pushing a commit, which is exactly
when a walkthrough most needs updating.

## Current blast radius in this store

```
rowid pr  author              origin
    1 227 ''                  NULL     <- one row, fine for now
    2 264 ''                  NULL     <- one row, fine for now
    3 269 ''                  NULL   } already doubled —
    7 269 izzie@iwalton.com   sync   } next re-walk of 269 will fail
    5 271 ''                  NULL   } already doubled —
    8 271 izzie@iwalton.com   sync   } next re-walk of 271 will fail
    9 270 izzie@iwalton.com   sync     <- fold-owned; next re-walk predicted to fail
```

269 and 271 acquired their second row during a sync that ran mid-session, so this is
actively spreading rather than historical. 227 and 264 are single-row today and will enter
the same state as soon as a sync adopts them.

## Suggested fix

Give the local writer the upsert the fold already has. The cleanest form matches the tool's
stated semantics — "re-walking replaces your reading, it does not accumulate one per attempt":

```js
d.prepare(
  "INSERT INTO walkthroughs(pr,author,body) VALUES(?,?,?) "
  + "ON CONFLICT(pr,author) DO UPDATE SET "
  + "body=excluded.body, event_id=NULL, origin=NULL, source_scope=NULL, ord=NULL"
).run(...)
```

Demoting the row back to locally-owned is coherent: a fresh local reading supersedes the
published one and will re-publish on the next sync. If reverting `source_scope` is
unacceptable — i.e. the fold must stay the only thing that can retire an event — then the
alternative is to keep the row fold-owned and update `body` in place, which preserves the
invariant at the cost of a row whose body no longer matches its event.

Either way the raw SQLite error should not reach the caller. A conflict here has a real
meaning ("your published reading is in the way") and deserves a message that says so.

## What was done to unblock (for the record)

Diagnosed to the duplicate row, then **Izzie** ran the deletion — an agent attempt was
blocked by the sandbox classifier, and the call was theirs to make regardless:

```sql
DELETE FROM walkthroughs WHERE pr='270' AND author='izzie@iwalton.com' AND origin='sync';
```

The deleted row's body was byte-comparable to the surviving unattributed row (both the old
`a183de64` walkthrough), so nothing was lost. The sidecar was not touched — only the local
adopted copy. A backup of the pre-change DB is at
`/tmp/claude-1000/-working-Acme-API/a171478d-fbfb-4f59-9059-5c89ef9b5f63/scratchpad/codemap.db`
(session-scoped; copy it somewhere durable if it is still wanted).

The re-walk then published successfully against head `a7120b2c`.

**This workaround does not generalise.** It requires direct SQL against a live store, and it
has to be repeated before every re-walk of every published PR.
