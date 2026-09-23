# Picking up the decision-rounds work

> **Kind: handoff.** Written 2026-09-23 at the end of a session that built the first slice of
> plan `2026-09-22-decision-rounds`, took it through two review rounds, and stopped in a
> diagnosis. Nothing here is ratified, except where the owner's words are quoted.

## Read this first if you read nothing else

**Do not fix anything, and do not push `main`.** The owner chose **"Rule first"**. The ten commits
`747f7fd..c745e30` stay untouched until a ruling on what a decision *is* decides whether they are
kept, rewritten or reverted.

**The next job is to write cases, not code.** Write out what a ruling, carrying it out, and a
finding's state each are, as concrete cases the owner can mark right or wrong. Only then decide the
fate of the ten commits.

**Why:** two review rounds in a row landed in the previous round's fixes, and the diagnosis names
the reason. It is not carelessness at the sites; the concept they sit on was never stated. More
guards at more sites is the failure mode, and the report's kill conditions say so.

## Where everything is

| what | where | committed? |
|---|---|---|
| The plan, revision 7, with rulings R1–R25 | `.git/plan/2026-09-22-decision-rounds/plan.md` (revision 6 beside it) | no, under `.git/` |
| The plan's owner rulings, sealed | `.git/plan/2026-09-22-decision-rounds/owner.md` | no |
| Worked cases and C-list marks; later rulings through R19 | `docs/decision-rounds-worked-cases.md` | yes |
| Round 1 (review of I8a): sort, arbitration, owner's rulings R20–R25 | `.git/triage/2026-09-23-i8a-decision-fold/` | no |
| Round 2 (review of the fixes): sort, lens readings, deposition, owner | `.git/triage/2026-09-23-i8a-fix-round/` | no |
| **The diagnosis report**, forwardable, with the owner's answers in §11 | `docs/postmortems/2026-09-23-i8a-fix-round.md` | not yet: untracked |
| Checkpoint before the diagnosis | tag `diagnose/20260923-042851-2026-09-23-i8a-fix-round` → `c745e30` | local tag |
| Raw findings of each review, word for word | `.git/plan/2026-09-22-decision-rounds/review-i8a.md`, `review-fixes.md` | no |

**The records under `.git/` do not travel.** The second review judged the fixes without the
rulings they implement, because those rulings lived only there. That is report §6.1.

## The state of the branch

`main` is local, well ahead of `origin/main`, and nothing is pushed. In order:

- **Before the decision-round code (keep; the unit suite passes, but I2 was never separately reviewed):**
  - `749fb2e` (I2): `at:` on `close_finding` and `record_audit`.
  - `341b4fb` and later docs commits: the worked cases and the owner's rulings.
  - `21cb228`: the owner's "last good point".
- **The decision-round code, on hold:**
  - `747f7fd` (I8a): the `decisions/` fold, three tables, `MATERIALIZER_VERSION` 26 → 27, and the
    stamp in two existing folds.
  - Nine fix commits, `3ad2c22..c745e30`.
  - It changes two folds that run today: the findings close path and the standard's operation
    sign-off.
  - Nothing reads or writes the new record yet. No op emits a decision event or a stamp.
- **Skills repo** (`/working/skills`, `a9b68a8`): I1, "what landed keeps each fix's check",
  landed. A sweep reviewer checked it for conflicting wording; nothing more reviewed it.

## What the owner ruled in the diagnosis (report §11, verbatim)

- **Is a close its own act?**
  > Agent closed is the expected primary means, it's possible a finding could be pre-staged to close
  > immediately on a ruling if it answers a specific multiple choice option, but I expect that to be
  > less common.
- **Names.**
  > Arbitrator is part of /triage-review and resolves conflicts between the two sorting models. The
  > name for a model that verifies verdicts or fixes should be a verifier, an arbitrator would only
  > get pulled in on disagreement, my verbiage was sloppy.

  So the code's free-text mapper, called "arbitration" throughout `shared-decisions.ts`, needs a
  different name. The closer is the **verifier**.
- **How an effect names a finding.**
  > Codemap ids. The round instrumentation would integrate with codemap for fix verification and
  > durable documentation of findings, so it would be a stronger store than .git/triage

  This reverses the worked cases' C11, "by number only". C11 must be revisited in the same case
  work.
- **What a decision is**, from phase 1b (`.git/triage/2026-09-23-i8a-fix-round/owner.md`):
  > A decision is a recorded ruling from a team member which is durable recorded and allows agents
  > to implement design changes to later close findings. Some findings can be directly closer by a
  > verdict that was pre-validated without having to go to an arbitrator agent.
  >
  > For already closed: the finding is closed, no need to close again. The decision is still
  > answered and recorded as normal.
  >
  > For a decision that doesn't directly close a finding, it is a verdict arbitrator agents can act
  > on to close findings or authorize fix work without requiring questions at time of fix.

  Read "arbitrator agents" here as "verifier", per the correction above.

## The next session's job: the cases

Start from the report's §5 domain model and mark it against the answers above. Its four sentences:
1. **The ruling stands** as given, whatever happens to the finding. The owner's answers support
   this.
2. **There is a "ruled on, not yet carried out" condition**, which someone wants to see. It is
   implied by "agent closed is the expected primary means" but **not yet confirmed**, including
   whether the finding is held back during it.
3. **A round's F14 and codemap's F14.** The owner ruled "codemap ids", so this sentence is now
   moot; the case work rewrites effects to name codemap ids.
4. **Two jobs.** The free-text mapper and the closer are different. Settled: the closer is the
   verifier.

The cases must at least cover:

- **What a decision's state IS**, as a function of its posted question and every answer,
  free-text reading and replacement that applies to it. It should be several small facts rather
  than one `state` label carrying four questions:
  - has the person ruled?
  - has it been carried out?
  - is a free-text reading pending, or disagreeing?
  - has it been replaced?
  - is something waiting on the person?

  The "set on one path, never reset on another" defects all came from the single label.
- **Which record answers "is this finding settled?"**, and what the "ruled, not yet closed"
  period looks like on a page and to an agent.
- **The pre-staged close**, the owner's less common case: which options may close on the spot, and
  who checks that it was pre-validated.
- **A settle that says nothing about what it closes as.** Open question 5a: refuse it, or default
  it to refuted. "Accepted" is deferred to a finding-state overhaul, which is its own item and is
  planned with I9.
- **Two people.** One person answers, and an agent running for a different person carries it
  out. From round 2's lens reader B, not carried in the report: a stamped sign-off is credited to
  the agent's principal.

**Then decide keep, rewrite or revert.** The report's §3 costs:
- Revert is free of teammate cost, since nothing was pushed, and a revert re-folds locally.
- The parts judged probably sound are binding an answer to the exact question text, and the
  shape checks.

## Still open, beyond the cases

- **Report §10, questions 1–5:** the sorters' carried disagreements on round 2's items. They only
  matter if the fixes are kept.
- **5b: should the I8a rulings (R20–R25) be committed somewhere citable?** The code's comments
  cite `docs/decision-rounds-worked-cases.md`, which lacks them. The report's process finding 3
  proposes a gate: before a commit quotes the owner, the quote is in a committed doc at the path
  the code cites.
- **Round 2's items, which stand only if the code is kept:**
  - the "awaits you" flag goes stale;
  - a settle with no `as`;
  - leave-closed covers agents only;
  - the witness-hash throw;
  - the multi-select park;
  - the one-item-list `ref` throw, found by both lens readers.

  All are in `.git/triage/2026-09-23-i8a-fix-round/sort.md`.

## The rest of the plan, after the rulings

Plan `2026-09-22-decision-rounds`, revision 7. **I8's order will change with the case work.** In
plan order:
- **I8e — the transcript module.** It reads an `AskUserQuestion` call and a typed message from
  the local transcript. The rules measured this session:
  - answers come from `toolUseResult`, never from the result's text;
  - the person's words are `origin.kind: "human"` on a `user` entry or on a `queued_command`
    attachment, never a bare `queue-operation`, which goal messages share
    (`auto-continuation`);
  - `multiSelect: false` is dropped from the recorded questions, so compare with it defaulting to
    false;
  - the message span is found by the list's start and end excerpts.
- **I8b — the ops.** `postRound`, `logQuestion` (the default relay path, R13), `relayAnswer`
  (the whole typed message by entry id, R16), the free-text reading, and a page-only `answer`.
  - Note the report's process finding 2: the record was built before anything that reads or
    writes it. The case work should decide whether I8b comes first next time.
- **I8c — the surfaces.** MCP tools. `codemap answer` is **dropped** (R18).
- **I8d — the page.**
- **I10 — the skills rule.** Call `log_question` after every question put to the owner, when
  codemap is present. "Present" means the database, plus the MCP tools, plus a sidecar that
  resolves (R24).
- **Decision records require a sidecar.** The default local sidecar is
  `docs/plan-retire-local-findings.md`'s work, and it has a comment-push trap to clear first. The
  decision tools must never create a sidecar themselves.
- **Next plan:** I9, the verifier and the sort on each finding, with the finding-state overhaul.

## What not to do again (report §8)

- **Don't commit a state-bearing fold before its states are put to the owner as cases.** A
  458-line fold with seven states was built in about an hour.
- **Don't build the record before anything that reads or writes it.** No review had an oracle.
- **Don't quote a ruling in code that lives only under `.git/`.**
- **When a sort carries two or more design items whose reason is "no rule says", recommend
  Diagnose.** In round 1 I recommended "Don't diagnose" over exactly that.
- **One guard per site, one failing check per fix, verifies the site and not the population.**
  That policy produced the next round.
- **Codex wedged three times, identically**, a minute into each round, right after running shell
  commands. It points at the plugin or its runtime. Don't retry without the owner; a foreground
  `--wait` run or the `task` entry point are untested alternatives.
