# Plan: retire the local-finding code path

**Status: not started. Deliberately parked** until the finding lifecycle stops moving —
this is a big mechanical change and it should land on a stable target, not chase one.
Written 2026-08-25, while the evidence for it was in hand.

## Why

There are two implementations of one thing. Every finding op has a fold-owned branch and
a local branch, and the local one is not a thinner version of the other — it is a second
implementation that drifts. Measured this session, all of it found by review rather than
by anything failing:

- `closeLocalFinding` appended a verdict without dedupe; `reviseLocalFinding` deduped by
  PRINCIPAL, which clobbers the same person's other model's verdict — the exact thing
  `reviewerKey` exists to prevent; only `corroborateLocalFinding` matched the fold. Two of
  the three hardcoded `independent: false`, so a genuinely independent confirmation read
  as self-agreement on the field the queue is ranked by.
- The `applied`/`refused` envelope, the honest `ok`, the `fixed → fixed-on-branch`
  inference and the severity gate all existed ONLY on the fold-owned branch, while the
  tool descriptions promised them unconditionally.
- `closeAssignment` accepted `remediation` and dropped it silently — an annotation has no
  such field.

All four are now fixed. That is the argument: they were fixed one at a time, by three
separate reviews, and the next one will be found the same way. **"Local" is not an edge
case** — it is every finding before `unify-findings`, and everything on a machine with no
sidecar.

The stronger argument is the one the surfaces made. Findings reached the pull-request page
only through a collapsed panel, while local ANNOTATIONS rendered inline at their line — so
raising a finding from the diff put nothing where it was typed. The good surface was
attached to the store being retired. (Fixed since; but that is the shape of the problem.)

## The claim: a store with no sidecar loses nothing

Three facts, each verified in the code rather than assumed:

1. **The event log is plain files.** `eventlog.ts` contains no git call at all. Shards are
   NDJSON under a directory; git is the TRANSPORT, not the store.
2. **A sidecar with no remote is already supported, deliberately.** `sidecar.ts`:
   *"`false` means there is no remote, which is not an error: a sidecar with no remote is
   a perfectly good local one and the whole design works offline."*
3. **`resolveSidecar` already accepts a bare directory** as the zero-configuration form:
   *"a directory named `sidecar`, which IS the sidecar — the zero-configuration case, for
   one person trying it out."*

So "no sidecar" becomes "a sidecar nobody else pulls from": `.codemap/sidecar/`,
`git init`, no remote. One write path (`emit` → fold → projection), one read path, every
finding carrying a `source_scope` and an `origin`.

**The migration verb already exists.** `unify-findings` replays local rows into a log
preserving ids and history, and refuses anything whose replay would forge attribution. It
was built to publish to a TEAM; pointed at a local log it is the retirement.

## What deletion this earns

- `writeLocalFinding`, `localFindingWrite`, and every `*LocalFinding` op.
- Every `!f.origin` branch, including the split-store gate in `sharedFindings` and the
  `unmigrated` reporting around it.
- `migrateLocalFindings`' destination distinction (it still has a job: annotations → the
  log).
- The duplicated predicates this session had to introduce to keep the two halves honest:
  `mayRerate`, `recordVerdict`, the second `applied`/`refused` envelope.
- The `whichRecord` dispatch collapses to "finding or bug", not "which store".

## The two obstacles, and neither is large

- **The writer id lives in the sidecar's GIT DIRECTORY**, and `eventlog.ts` says a root
  with no resolvable git dir "gets an id for the life of the process only". A local log
  must therefore be `git init`-ed, not merely a directory — otherwise every process is a
  new writer, which is precisely the fork `writerPrev` exists to detect.
- **`ensureSidecar` refuses a sidecar that resolves to the ENCLOSING repository** (it
  checks, having once pointed every git call at the user's own repo). `.codemap/` is
  gitignored, so `git init` inside it yields a genuinely separate repo — but that is a
  claim to verify with `git rev-parse --git-dir` from inside the candidate, not to assume.

## Order, when it is picked up

1. Verify the two obstacles above on a scratch universe: `git init` under `.codemap/`,
   confirm `ensureSidecar` accepts it and the writer id persists across processes.
2. Teach `resolveSidecar` a default: no env var, no pointer, no manifest → `.codemap/sidecar`,
   created on first write. This is the whole behavioural change; everything else is deletion.
3. Run `unify-findings` on a store with local rows and the new default, and confirm the
   rows are adopted rather than duplicated (`materialize.test.ts` already covers adoption).
4. Delete the local ops, one verb at a time, leaning on the tests that already assert both
   branches behave identically — `finding-triage-surface.test.ts` was written for exactly
   that comparison and is the safety net for this change.
5. Only then simplify `whichRecord` and the `!f.origin` readers.

## What this does NOT propose

Retiring **annotations**. Notes, questions and pointers are a different entity — symbol-
scoped knowledge that outlives a branch — and `docs/sidecar-architecture.md` settles that
they keep their own table. The audit in `docs/finding-event-shape-audit.md` measured what
that store actually holds and found it healthy once the pre-canonical findings were
excluded from it. This plan is about the FINDING lifecycle only.
