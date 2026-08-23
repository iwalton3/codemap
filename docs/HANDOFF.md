# Handoff — `worktree-shared-review-hashscheme`

Written at `bec6d1e`, updated after a review round. Everything below is committed
and green (560 tests,
`tsc -p .` and `tsc -p web` both clean). Read this, then the two documents it
points at; do not read the whole branch history.

## What to run

```sh
npx tsc && npx tsc -p web
node --no-warnings --test --test-concurrency=1 "dist/**/*.test.js"
```

**Use that rather than `npm test`.** `npm test` runs the same three commands and
stalls intermittently under the agent harness — it did repeatedly in this session
while the direct form ran green in ~32s. Two separate bisects blamed code for it
and both were wrong; controlled A/Bs in a clean `git worktree` came out green on
both sides every time. **A run that blocks with near-zero CPU is a wait, not work
— check what else is running before suspecting the diff.**

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

1. **The recovery arc** — `docs/anchor-id-provenance.md` § "Recovery". Design-first
   and the reason the rest exists. Derive a candidate from the **commit graph** (a
   finding carries `sourceRef`, so an unresolvable id is a question with an
   address: index their commit and read the locator off your own snapshot), then
   publish it as a **remap event** — an append-only log cannot be migrated but can
   be interpreted, and an appended interpretation is auditable and retractable.

   Its first task is **not** design: **locate the bug**. Izzie reports that on
   `master`, unplaceable findings surface in the UI and agents get stuck re-citing
   them against unrelated PRs. I could not find the mechanism on this branch —
   findings are per-PR scoped, `context` reads local bugs, there is no cross-PR
   per-anchor view. Note that §5 of the materialization proposal names the query
   that would produce exactly this (`WHERE target_id = ?` across every PR, called
   "impractical today"), and step 1 built `shared_finding` **with `ix_sf_target`**,
   which makes it practical. Check there first.

2. **The un-clearable doc.** A doc whose citations read `incomparable` cannot be
   cleared: `confirmNode` has no live hash to add, and `ackHole` refuses because
   the status is not `dangling`. And `ackHole` could not help if it ran — the
   tombstone it writes inherits the prior version's old-derivation hashes, so §6's
   inversion counts them against it and the content version wins. **The tombstone
   judges its own author foreign.** The evidence it needs is the derivation of the
   build that made the removal judgment, and a `NodeVersion` has nowhere to put it.
   A schema addition, not a patch. This is a regression from this branch's work;
   `main` always answered `dangling` here.

3. **Materialization 3a and 5** — generation sharding and the sidecar-root lock;
   then expose shared docs/notes through the ordinary read ops.

   **3b is only half done, and the spec now says so.** The anchor-table scans are
   gone (indexed lookups over the cited ids), but that is an `IN` over ids parsed
   out of the citation JSON — NOT the §5 join through `shared_doc_citation`. That
   table is populated, indexed, and read by nothing. Either §5's query lands or the
   table should be deleted; leaving it is a write-only structure that reads as an
   implemented join. A review round caught me overstating this.

   The same review would delete `shared_scope.folded_at` and `events` (written,
   never read) and the finding/note filter columns until the SQL surfaces that use
   them exist. I left them, because §5 is the next step and re-adding is churn —
   but if §5 slips, they should go.

4. **Two surfaces still bypass the resolution**: `orphanedWork`'s `lost` bucket,
   and — smaller now — anything else that classifies by raw id membership.

5. **`src/ops.ts` is 3324 lines** and wants splitting. A prose audit measured the
   tree: ratio climbing 0.15 → 0.28, but 66% of prose is skippable boundary
   comments and only 4.3% is in over-budget blocks. `ops.ts` is the one file where
   length is a real problem, and prose trimming cannot fix it — it is code.

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
