# Proposal: backlog-with-deadline for BUGS

**Status:** untracked proposal, not started. Written to be picked up by another
agent after `dashboard-attention` merges. Read `docs/finding-backlog.md` first —
this is the same mechanism one record kind over, and most of the argument is
already made there.

## The ask

Bugs need the same third exit findings just got: **real, not now, and it comes
back.** A bug that nobody will get to this quarter currently has two options —
stay in the open queue and dilute it, or be closed as won't-fix, which asserts a
decision nobody made. The first is what actually happens, and it is how a bug
queue stops being read.

**One hard constraint, stated by Izzie and not negotiable:** a backlogged bug is
**never deleted and never silenced from global search**. It goes to a separate
queue, not out of existence. The finding backlog can afford `sleeping` to be
quiet because a finding is a claim about one pull request; a bug is a standing
defect record, and a defect you cannot find is worse than one you have not
prioritised.

## What to reuse

Almost all of it. The finding side is built and tested; this is the same shape:

- **The record.** `SharedFinding.backlogged` — `{ until, witness?, reason, by, at,
  ref? }`. Copy it onto the bug record. `until` REQUIRED, and enforced in the
  fold, for the reason `acknowledgements` gives: a linked ticket that is closed,
  moved or deleted leaves the record asleep permanently and silently.
- **The witness snapshotted at backlog time**, not read off the record. This is
  the subtle one and the finding side got it wrong first: a deadline keyed on the
  original witness fires the instant it is set, because backlogging follows an
  investigation and the code has usually moved since. Snapshot NOW, and drift
  against that means somebody is editing the code the decision was about.
- **Principal-granted, both ends.** The tool refuses an agent and the fold drops
  an agent's event. `ops-reach.test.ts` must forbid an MCP tool for it, the way
  it does for `backlogOn` / `releaseBacklogOn`.
- **`landedIn`** in `ops-shared.ts` — the ancestry cache keyed on the trunk's
  resolved SHA. Already written, already measured (211ms → 21ms).

## What is genuinely different

1. **Never silenced from search.** Whatever `sleeping` does on the finding
   backlog, the bug equivalent must still appear in `search`, in `bugs`, and in
   whatever the global search becomes (see the sibling proposal). It is filtered
   OUT of the working queue and filtered IN everywhere else. Suggest a visible
   `backlogged until <date>` marker on every surface that lists it, so it never
   looks like an ordinary open bug that nobody is doing.
2. **Its own queue, not a bucket.** Findings got six buckets on one page because
   they had one pile. Bugs already have a queue people read; this should be a
   sibling view (`/u/:u/bugs/backlog/` or a filter that is clearly a different
   list), so the main queue means "what we are doing" again.
3. **A bug has no `pr`.** The finding verbs dispatch on the record via
   `whichRecord`; `carryOn`'s bug branch currently REFUSES, with the message that
   a bug is already the tracked record. That refusal has to become the bug path
   instead — see `ops.ts` `backlogOn`, which is where the branch already exists
   and says so.

## Cost of getting it wrong

The failure mode is a bug that sleeps for ever, and it is the same one the
finding side measured: seven deferrals on record, every one with an empty `ref`,
no date, and the escape hatch written in prose. If the deadline is optional this
becomes a graveyard with extra steps.

## Definition of done

- `MATERIALIZER_VERSION` bumped, with an entry in `materialize.ts`'s comment
  block saying why — the bug fold learning a new event is the same hazard as the
  findings fold learning one. `db-migrate.test.ts` pins the BUGS fold's event
  vocabulary the way it now pins the findings fold's.
- The fold guards mutation-checked by RUNNING the fold on hand-built events.
  Every guard-in-one-end defect this project has produced was found that way and
  none was found by reading.
- A test that a backlogged bug is still reachable from search. That is the whole
  constraint, and it is the one an implementation will drift from.
