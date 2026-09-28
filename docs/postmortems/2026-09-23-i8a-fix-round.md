# Postmortem — the decision-round fold and its two fix rounds (2026-09-23)

Window `21cb2284840f..c745e306c453` (10 commits, all on local `main`, none pushed). Checkpoint
`diagnose/20260923-042851-2026-09-23-i8a-fix-round` → `c745e30`. Diagnosis only: nothing was
changed except this file.

---

## 1. Executive summary

**What was being built.** The record of a person's rulings ("decision rounds"): the person answers
a few questions, and agents use those answers to close or unblock the review findings the
questions cover.

**What happened.** The first piece was built in one evening: the store and the logic that works
out, from the history of posts, answers and readings, what state each question is in and which
findings it settles. Before it was committed, three internal passes had already found seven
problems and fixed six of them. The seventh was left alone by a ruling. A review then found ten more. The owner ruled on six points, and nine fixes landed
within five minutes of each other. A second review found ten again, and every real one (eight of
them) was in those fixes or on a path they did not reach. Nothing yet uses this record: no command
writes to it, and no page or agent reads it.

**What it cost.** About two and a half hours from the gate opening to the stop. That was one
build, with three passes inside it, and then two review-and-fix rounds. The work never left this
machine, so nobody else is affected.

**What kind of failure it was.**
- *What made the repairs wrong:* one word is doing two jobs. "Settled" means both *the person has
  ruled on this finding* and *the finding has actually been closed*. The design wrote these as
  one moment. The build keeps them in two separate records, joined by a note that an agent is
  meant to attach and that nothing attaches yet. Most of each round's findings sit where the two
  records meet, or in a single "state" label that bundles four separate questions together. Each
  fix corrected one side.
- *What was available to settle it:* the person who could answer "what does settled mean
  between your answer and the close?" was available. They were asked only about individual
  behaviours until this diagnosis. No reader of the record exists yet, so nothing else could
  answer it. Their rulings from the last round were written only in scratch files that the
  reviewers could not see.
- *The conditions:* the pace (a large piece of state logic built in about an hour, fixes batched)
  and a build order that made the record before anything that reads or writes it.

**What is being asked for, and of whom.** A decision, from the owner: stop fixing, and answer
three short questions about what a ruling and a close are (§3, §10) before anyone touches the
code again. Whether to keep or revert the code depends on those answers.

---

## 2. What doesn't add up

Two blind readers ran the six lenses. Three entries were found by both, one is a disagreement
between them, and one was reached by only one reader. Each entry's shape is `NOTICED`. None of them
is a work item.

**1. The design says a settling answer closes its findings "the moment it is recorded". The build
records the answer as having settled them and stops holding them back, but the findings stay open
until an agent separately closes them, and nothing does that yet.** *Both readers*
(vocabulary drift and second authority).
- So "settled" is true in the record of rulings and false in the record of findings, and the time
  in between has no name anywhere: zero tokens for it in code, docs or tests (reader A).
- For findings codemap does not hold, the ruling record is the only place they are settled at
  all. The worked cases say that covers 34 of the 42 findings in one real round.
- Evidence, `CONFIRMED`: proposal §4 (`docs/PROPOSAL-decision-rounds.md:78-86`, written before
  the window). Against it, `src/shared-decisions.ts:251` and `:430`. A verified settle with no
  outcome folds as `answered`, lists the finding as applied, and holds nothing back (my run,
  Appendix B probe 1).
- It goes away if the owner says that "ruled, and free for an agent to close" is what settled
  means, and that nobody needs to see which findings are in between.

**2. "Arbitrator" names three different jobs.** *Both readers* (vocabulary drift).
- The proposal: two sorters and an arbitrator decide what kind of problem a finding is, before
  any fix.
- The code: a second agent reads the person's free-text words and maps them onto the options.
- The owner's answer today: "a verdict arbitrator agents can act on to close findings or
  authorize fix work". That is the job the proposal calls the *verifier*, and the code has no
  word for it.
- Evidence: proposal table at `:28-33`, `src/shared-decisions.ts:325-368`, `owner.md`.
- I dropped reader B's further claim that the owner's condition "closed by an agent other than
  the one that passed the answer on" had been implemented on the wrong role. The plan defers that
  condition to the verifier plan explicitly (plan R1, R7.3, and "Decided instead of asked"), so
  the condition was deferred, not misplaced.
- It goes away if the owner says which job the word means.

**3. The rule that one bad record must never stop the whole team reading has been enforced one
field at a time.** *Both readers* (population).
- It was found short at a null effect (Codex, in the build), at option `items` (P7) and at the
  witness content (Q5). Now both readers found a question label stored as a one-item list, which
  passes the check and then stops the read.
- Evidence, `CONFIRMED`: `d.ref.toUpperCase is not a function` (Appendix B probe 3). The check is
  at `src/shared-decisions.ts:135`, and the throw happens in `parseReply` at `:163`.
- It goes away if the owner rules that these records are only ever written by codemap's own
  commands, so shape-hardening is a single pass and not a per-field chase.

**4. The fix for "a made-up note closed a finding" now requires the note to name the finding and
the outcome, and both are written by the same agent in the same act.** *A disagreement.* Reader A
flagged it (discriminator decay). Reader B read the same checks and cleared them.
- A's reading: a note citing a ruling that never existed still closes the finding. The test
  that shows the note being accepted cites round `R1`, decision `d1`, answer `e9`, and none of
  them is posted in that test (`src/decision-stamps.test.ts:33-36, 48-55`).
- B's reading: each check has an independent failing case, so none of them can only pass.
- Both facts hold; I checked both.
- What is left is a question of meaning, which is not mine to settle. The owner said *"I am not
  worried about forged sidecar entries"*, and the protection now rests entirely on a writer that
  does not exist yet. So either the check guards only against that future writer contradicting
  itself (and that is enough), or the fix answered a threat the owner had already accepted.
- Who settles it: the owner.

**5. "F14" in a round is the round's fourteenth item. "F14" to the close is a codemap finding. Two
review rounds on different pull requests that each have an F14 hold each other's back.** *One
reader (A)* (cardinality). B did not look here.
- Evidence, `CONFIRMED`: two rounds, PR 1 and PR 2, give `F14 → [da, db]` (Appendix B probe 2).
- The worked cases' C11 says effects name findings "by number only". The proposal says "Validated
  at post: each finding exists and belongs to the round's findings" (`:161`). The close compares
  against codemap's own finding id.
- It goes away if effects are ruled to be scoped to their round, or to name codemap ids only.

Not carried, because of the five-entry ceiling:
- Reader B's relayed-park asymmetry: a clear reply vanishes, while vague words meaning the same
  thing are kept and flagged. I reproduced it and use it as evidence in §5.
- Reader B's two-person sign-off credit (§9).

Every lens found something for at least one reader. Discriminator decay found nothing for reader
B. Neither reader invented a category.

---

## 3. Decision requested

The path has forked: the default is another fix round.

| option | cost | forfeits |
|---|---|---|
| **A — Rule first** *(recommended)* | Leave all ten commits untouched and unpushed. The owner answers §10 questions 6–8 (a few minutes). Then a fresh session writes out what a ruling and a close are, as cases the owner can mark. Only after that is keep, rewrite or revert decided. | For now, the eight open review items stay open. No user can reach them, because nothing reads or writes the record. Local `main` carries unreviewed changes to two folds that do run today (the findings close and the standard's sign-off). |
| **B — Revert to the gate** | Revert `747f7fd..c745e30` (all ten), keeping both test files and the six worked-case lines aside as the case list, and rebuild after the rulings. Re-deriving the fold's logic, about 460 lines, is roughly one build. | The parts that are probably sound: binding answers to the exact question text, and the shape checks. It also commits to a revert before anyone knows what survives. |
| **C — Fix the eight** | Plan the sort's eight items as usual. One more round. | Nothing now. The expected result, measured twice: the next review lands in these fixes. |

**Recommendation: A.** Whether to revert or keep depends on what the record is for, and nobody has
said that yet. Its downside is that the two live-fold changes sit unreviewed on local `main`
meanwhile. Do not push `main` until this is decided.

**If nothing is decided,** the session's own stated next step happens: "add `delete d.awaitsYou` to
`apply` and to supersession — the same kind of patch as the one that caused it". That is option C
by default.

---

## 4. Timeline

The build's internal passes come only from the deposition's memory, because git blames every line
to one commit. The rounds after it have records (`.git/triage/2026-09-23-i8a-decision-fold/`).

| round | told by | changed | what the next round found |
|---|---|---|---|
| 0 — build (`747f7fd`, 22:37) | Plan I8a, drafted in an earlier session and ruled by the owner. The worked cases were its gate; the gate closed at `21cb228`, 21:38. | 458-line fold, four event kinds, seven states, and bypasses in the findings and standard folds. The read-back found 3, Codex round 1 found 3, and Codex round 2 found 1 before it wedged; all were fixed inside the same commit. | Round 1: 6 of its real findings were in those in-commit fixes (the prior sort's own count). |
| 1 — review of the build | `/code-review high` (9) plus a read-back (1). The route recommended **"Don't diagnose"** and the owner agreed. In discussion the owner ruled on six points (R20–R25), which were recorded only under `.git/`. | Nine commits, 23:46 to 23:51: P1, P3, P4, P2, P7, P8, P6, "accepted" removed, P9+P10. | Round 2: all 8 real findings. Q1 was in P2's flag; Q2 and Q3 in `1ded24f`; Q4, Q5 and Q10 in `c745e30`; Q7 is P1 not reaching multi-select. |
| 2 — review of the fixes | `/code-review high` (10). Codex wedged for the third time. | Nothing. The route recommended **Diagnose**, and the owner agreed. | This report. |

**Where the criteria came from.**
- **Round 0** worked from rulings on behaviours (the C-list).
- **Round 1** added six rulings mid-loop. None reverses an earlier one. Each answers one sequence
  of events. The window changed the worked cases once, adding six lines inside `747f7fd`.
- **The state vocabulary** (`answered`, `partly-applied`, `awaiting-arbitration` and the rest),
  the meaning of "applied", and the missing outcome on a settle were all decided at the keyboard.
  The deposition says so ("Decided myself").

---

## 5. Diagnosis

**The domain model this report assumes.** Mark any of these wrong:
1. *You answer D2 in session: "settle F14 as refuted". Your answer is the ruling, and it stays on
   record as you gave it whatever then happens to F14, including a reviewer closing F14 as
   resolved first.* This matches your answer in phase 1b.
2. *Between your answer and an agent actually closing F14, F14 is in a third condition: ruled on,
   not yet carried out. It is neither "open, waiting for you" nor "closed". You (or the page)
   would want to see which findings are in it.*
3. *A round's "F14" and codemap's F14 are the same finding only when something says so. Two review
   rounds on different pull requests can each have an F14, and they are different findings.*
4. *The agent that maps your free-text words onto the options and the agent that later closes
   findings on your ruling are two different jobs.*

**Mechanism: concept conflation.** Two names each carry more than one question.

- **"Settled" / "applied" / "answered" carry the ruling and its execution.** Proposal §4 makes them
  one moment. The build splits them:
  - the ruling goes into the decision record (`applied`, `answered`, and `blockedBy` releasing the
    finding);
  - execution goes into the finding record, reached only through a note (the "stamp") that an
    agent attaches to a separate close.

  This round's cluster sits on that seam: Q2, Q3, Q4, Q5 and Q10, plus F5, found invalid only
  because of a residual the owner accepted. So does the previous round's P9/P10. That is five of
  this round's eight real items. The deposition names the same four words as two-meaning terms,
  independently of both readers.
- **The decision's single `state` carries four questions.** Has the person ruled? Has it been
  carried out? Is an arbitration pending or disagreeing? Is the question replaced?
  - Three more side-flags carry a fifth: something awaits the person.
  - Every event path must reset the others' flags. The "set on one path, not reset on the others"
    shape (P2 → Q1, and last round's stuck arbitration) is what that produces.
  - After P2, `open` alone means three things (reader B).
  - Reader B's asymmetry is the same thing seen from outside, `CONFIRMED` by Appendix B probe 4:
    - a clear relayed "D3 A" (park) leaves no trace;
    - vague words meaning the same park are kept and flagged for the person.
- **Beside it, and separate: plain population underreach.** The "never throw on garbage" chain
  (§2 entry 3) is one rule at four sites. It wants one pass, not a concept.

**The distribution of the sort is evidence for this, not a count of it.** Of the six correctness
items, three are group 1 (Q1, a pattern at 2 or 4 sites; Q3, 1 site; Q5, 1 site). The other three
are design defects or assumptions (Q2, Q4, and Q7, which is group 2 or 3). Hygiene and suggestions
make up the rest: Q8 at 7 sites, Q6, Q9 at 4 sites, and Q10. Half the real items are "no rule
says", and they sit exactly where the two meanings meet.

**The smallest scenario where two defensible repairs disagree.**
- D2 settles F14 (codemap holds it) and F28 (it does not).
- Your verified answer picks D2's settle. Before any agent closes F14, a reviewer closes it as
  resolved.
- Repair X ("the decision record is the ruling") keeps D2 `answered`, applied to F14 as refuted.
  Your phase-1b answer endorses exactly this.
- Repair Y ("the decision record lists what was carried out") must not list F14 among the findings
  D2 closed. C12 requires that a round list every finding its answer closed. The plan's
  "closed by a superseded answer" listing reads the same way.

**A value both repairs could read.** I looked for one. For F14 there is one: the finding's own
"closed by decision" note. For F28 there is nothing, and there the ruling record is the only
authority. The scenario therefore holds for findings codemap does not hold and is resolvable for
those it does, provided someone rules which record answers "was it carried out?". That ruling is
§10 question 6.

**Price, conditional on the answer.**
- If the distinction holds, the remedy is larger than guards. Someone has to author what a ruling,
  a carrying-out and a finding's state each are, and which record answers for each. After that,
  the fold's state handling is probably rewritten rather than patched.
- If the owner rules that the answer itself closes its settled findings (proposal §4), the change
  crosses two folds. That is a rearchitecture, and the frame is what wants handing over,
  to an uninvolved, stronger reader.

**Evidence access, per rule.**
- **What a decision's states mean:** unavailable in the repository, because no reader or writer
  exists (`CONFIRMED`, §6).
  - Each review supplied an imagined one ("the page would ask the person…").
  - Available and unconsulted: the owner, who was first asked a state-level question in this
    diagnosis's phase 1b.
- **Whether a settle's close is its own act:** available and consulted only through a premise.
  - Ruling (5) asked "recorded as an agent acting for you, or rewritten as you?". It never asked
    whether a separate close event should exist at all.
  - Proposal §4 (committed) says the opposite of what was built, and nobody reconciled the two.
- **How an effect names a finding:** available (C11; proposal `:161`) and unconsulted at the
  close.
- **Round 1's rulings:** available to the session, unavailable to both reviewers. They exist only
  under `.git/`, while the code says they are in a committed document (§6).
- **Garbage tolerance:** consulted, with the rule in the code. Plain underreach.

**Kill conditions.** If this diagnosis is right, the recovery must not turn out to need any of
these:
1. **Guards only.** Only per-site guards (clear the flag on the other paths, refuse an outcome-less
   settle, guard the hash) with nobody ruling which record answers "is this finding settled?", and
   the next review then finding nothing in those areas.
2. **A wrong premise.** The owner marking sentence 2 of the domain model wrong, and no page, skill
   or command ever needing to tell "ruled on" apart from "carried out".
3. **The labels unchanged.** The decision's state vocabulary and the meaning of `answered` surviving
   unchanged, with resets added and nothing else, and the loop still converging.

---

## 6. Believed versus actual

Addressed to the session that does the recovery.

1. **Where the rulings are.**
   - *Believed:* the rulings are "word for word in `docs/decision-rounds-worked-cases.md`". That
     is what the headers of `src/shared-decisions.ts:5-7` and `src/decision-stamps.test.ts:3-4`
     say, and `schema.ts:2306-2311` cites "option B".
   - *Record:* R20–R25 are in no committed file. "leave it closed", "awaits you", "just drop it"
     and `R2[0-5]` each count 0 in that document and in the proposal. They exist only in
     `.git/triage/2026-09-23-i8a-decision-fold/owner.md` and `.git/plan/…/plan.md`.
   - *Why it matters:* the second review judged the fixes without the rulings they implement, and
     a fresh session or a clone starts without them. `CONFIRMED`: Appendix B, commands 3 and 4.
2. **Who reads and writes the record.**
   - *Believed:* "`blockedBy` is what the page and the skills will use"; `applied` records
     "intentions" until the commands exist.
   - *Record:* nothing outside the fold and its tests reads the decisions record, and nothing
     writes a decision event or a stamp. The only writers of the two stamp-carrying events emit no
     stamp (`shared-findings.ts:1190`, `shared-standard.ts:145`).
   - *Why it matters:* no consumer defines what any field means, so no review had an oracle.
     Holding or reverting costs no user anything. `CONFIRMED`: command 5.
3. **What the tests cover.**
   - *Believed:* the tests cover the settle.
   - *Record:* no test joins a decision's effect to a finding's close.
     - The decision tests name findings `F10`, `F30` and so on, and assert only the decision
       record.
     - The stamp tests use `f_1` and a stamp citing nothing posted.
     - Fixtures `d2` and `d4` (`src/shared-decisions.test.ts:19-24`) are outcome-less settles
       asserted as `answered`, so the suite encodes the unsettled meaning as correct.
     - Fixture `d1` was changed from `accepted` to `refuted` in `1ded24f`, and that fixture is the
       prime suspect.
   - *Why it matters:* the seam where most findings land has never been exercised end to end, and
     every "failed first" check sits on one side of it. `CONFIRMED`: command 6.
4. **What ruling (5) covered.**
   - *Believed:* the fixes applied the owner's rulings.
   - *Record:* ruling (5) (`.git/plan/2026-09-22-decision-rounds/owner.md:150`) chose "recorded as
     an agent acting for you, with the stamp, not rewritten as you". The premise that a settle's
     close is a *second, agent-written event* was the session's. Proposal §4 says the findings
     close "the moment it is recorded".
   - *Why it matters:* the seam that produced P9, P10 and Q2–Q5 rests on a premise nobody ruled.
     `CONFIRMED` by reading.
5. **Whether the work left the machine.**
   - *Believed:* "27 has not left this machine".
   - *Record:* true. No remote branch contains `747f7fd`, and `origin/main` is `161d754`
     (2026-09-20). The fold version is part of each cached scope's fingerprint
     (`src/materialize.ts:327`), so a revert re-folds locally.
   - *Why it matters:* reverting any of the ten is free of teammate cost. `CONFIRMED`: command 7.
     That old builds tolerate the three extra empty tables is `ARGUED`.

---

## 7. Recovery envelope

*For whoever picks this up next.*

**What is preserved.**
- `src/shared-decisions.test.ts` and `src/decision-stamps.test.ts`, as a catalogue of the
  sequences already argued over. They are coverage, not a verdict: fixtures `d1`, `d2` and `d4`
  encode meanings nobody ruled.
- The six worked-case lines added in `747f7fd`.
- The rulings in `.git/triage/2026-09-23-i8a-decision-fold/owner.md` and `.git/plan/…/owner.md`,
  copied into a committed document verbatim, before anything cites them.

**What may be reverted.** Keep, rewrite or revert is decided after §10 questions 6–8, not before.
The candidates, if the answers move the model:
- the fold's state handling in `747f7fd` and fixes `3ad2c22`, `3c61208`, `bdd1051`, `7ffddde`,
  `1ded24f`;
- the stamp bypasses in two live folds, from `747f7fd` and `c745e30`. These are the only part
  that runs on real data today.

**Checkpoint.** `git log -1 diagnose/20260923-042851-2026-09-23-i8a-fix-round`
(→ `c745e30`). Things not to do first:
- do not apply the session's queued flag-reset fix;
- do not plan the sort's eight items;
- do not push `main`.

**The decision frontier.** These must be settled before a plan can exist:
- whether a settle's close is its own act or a consequence of the answer;
- which record answers "is this finding settled?", for findings codemap holds and for those it
  does not;
- what "arbitrator" names;
- how an effect names a finding.

Until then, two things get no helper name, site count or shape: the decision's state model, and the
seam between the two records. Both are fogged. Do not pre-slice them into "derive the state as a
function" or "add a pending-close state".

**Premises the plan author must check first.** I have not measured these; they are the plan
author's first task.
- *"The findings fold cannot see the decisions record"* (R20; `schema.ts:2306`).
  - Source: the session.
  - Cheapest falsifier: the standard is already folded from two scopes
    (`src/shared-projections.ts:796`). Read `docs/sidecar-architecture.md` for whether a
    cross-scope read is forbidden or merely costly. CLAUDE.md's spec-withdrawal history says the
    last one was costly.
- *"The commands will write the close at the moment of the answer"*.
  - Source: the plan's "decided instead of asked", marked *(mine)*.
  - Falsifier: ask the owner, and read how the page's direct answers would write a close as the
    person (Q4).
- *"Effects name codemap finding ids"*.
  - Falsifier: `docs/decision-rounds-worked-cases.md:49-63`, where 34 of 42 are by number.

**Gates the implementation owes.**
- **Two kinds of instrument per rule, before the first patch.** Derive every rule's population
  with two kinds of instrument: a static search of every state assignment and flag, and the fold
  run over the three worked cases' real sequences as hand-built events. Reconcile the two, do not
  merely make them equal.
- **A named reader first.** No fold field is reviewed for meaning until its reader is named.
- **An oracle per rule.** Every rule names its oracle.
- **A failing check per rule.** Every rule ships a check observed failing at the parent, including
  one that runs a decision's effect through to a finding's state.

**What counts as an oracle here.**
- *Counts:* the owner's verbatim rulings; the worked cases (three real past rounds); the proposal,
  where no ruling supersedes it.
- *Does not count:* the fold's tests and fixtures, the stamp's agreement with itself, and a
  reviewer's imagined page.

**One next observation.** The owner's one-sentence answer to §10 question 6.

**Who authors the plan.** A session that wrote neither this report nor the fold.
- Its job is to author the missing level: what exists (ruling, carrying-out, finding state), which
  of it is stored, and the single authority for each.
- Give it the owner's exchanges verbatim, questions included, and the measured facts marked as
  measured. Label the prior sorts as hearsay, and give it permission to change anything.
- It returns cases the owner can mark wrong, not a design to ratify.

---

## 8. Process findings

1. **The rate is a finding.** The gate closed at 21:38, and a 458-line fold with seven states and
   two live-fold bypasses was committed at 22:37. Nine fixes landed between 23:46 and 23:51.
   - This predicts the pattern without causing it.
   - *Gate:* before a state-bearing fold is committed, its state vocabulary is put to the owner as
     cases.
2. **The record was built before anything that reads or writes it** (order I8a → I8e → I8b →
   I8c → I8d). Reviews therefore had an unbounded space of inputs and no consumer to judge
   against.
   - *Gate:* before the first review of a projection, every field names its reader. A field with
     no reader is out of scope for "is this state right?".
3. **The rulings lived where reviewers cannot look.**
   - *Gate:* before a commit whose code or message quotes the owner, the quote is in a committed
     document at the path the code cites.
4. **The round-1 route recommended "Don't diagnose"** while its own sort carried a requirement the
   plan never wrote down (P9, "no rule for the end state" in P2 and P10).
   - *Gate:* when a sort carries two or more group-2 items whose reason is "no rule says", the
     route's recommendation is Diagnose.
5. **One guard, one arm, one failing check per fix.** Each fix was the smallest change at its
   site, with a check that failed at that site. The check verifies the site, not the population,
   so the policy rewards exactly the change that produced the next round.
6. **The second model was lost three times.** Codex wedged three times, so neither round had a
   second vendor's reading.

---

## 9. What this report cannot see

- **Every instrument stops at `21cb228`.**
  - Proposal §4's "the moment it is recorded" (`95f6792`, 2026-09-22 19:33) and C11 (`341b4fb`,
    20:36) predate the window. The code that disagrees with them is in-window (`747f7fd`,
    `1ded24f`, `c745e30`), so the loop left its own trace here.
  - "Arbitrator" as verifier dates from today's `owner.md`, which is outside git.
- **Self-fix figures.**

  | instrument | what it counts | result |
  |---|---|---|
  | A | commits that modify existing code and touch a line written in this window | 7/8 (87.5%) |
  | B | the same, where most of the touched lines are in-window | 7/8 (87.5%) |
  | A' | A, counted over every commit in the window | 7/10 (70%) |

  Deletion-based attribution cannot see a fix that only adds a guard, so these are floors. Two
  commits are blind (`bdd1051`, `46eb224`), and 41 lines were attributed. Lines taken out and
  later put back: none. Prior records: 27 found.
- **Argued, not confirmed.**
  - That the payload-binding parts of the fold are sound.
  - That old builds tolerate the three new tables.
  - The owner's option set for P9: A–D are recorded nowhere and come only from the deposition's
    memory.
  - The build's internal passes, which are memory only.
- **Not re-run.** I did not re-run the deposition's mutation checks.
- **Not carried from the lenses.** Reader B's two-person sign-off credit (read, not run) and reader
  A's P10 sibling at the sign-off key.
- **Invented categories:** none, from either reader. Reader A's nearest candidate was "consumerless
  state", which is covered by the second-authority deletion test and §6.2.
- **Hypotheses I refuted.**
  - The closer-independence condition was put on the wrong role: no, it was deferred by plan.
  - A revert costs teammates a refold: no, nothing was pushed.
- **What noticed the loop.** The triage skill's mechanical fixes-on-fixes route, raised by the
  session: "the second round in a row". The owner chose Diagnose. Round 1 offered the same route
  and recommended against it.

---

## 10. Open questions

**Carried from the sort, verbatim, not arbitrated:**

1. **Q1's site count.** *Owner, or the plan author by running the command.*
   - A counted 4: `awaitsYou` on two paths, plus `wordsAwaitDecision` and `awaitingSettle`
     surviving supersession.
   - B counted 2: `awaitsYou` only.
   - Command: `grep -n 'awaitsYou\|state = "superseded"\|d.state = \|src.d.state' src/shared-decisions.ts`.
2. **Q4's group.** *Owner.*
   - A: group 1 (key leave-closed on the stamp, for any actor).
   - B: group 2. "Whether I8d's page answers write a stamp is not decided."
3. **Q5's site.** *Plan author.*
   - A: line 500.
   - B: the entry guard at `shared-standard.ts:485`, which "also covers the older reach in
     `reviewGap` (333, 341), which predates this range".
4. **Q7's group.** *Owner.*
   - A: group 2 ("no rule for a park combined with other picks").
   - B: group 3 (`picked.length === 1` "assumes a park is picked alone, and it predates the
     round").
   - The candidates: "the park wins; apply the rest and flag the park; free text; refuse park
     options on multi-select at post".
5. **F5's refutation kind.** *Owner.* A: *wrong*. B: *assumed*. Both call it invalid.

**The arbitration's "needed and not given" (T3, T4).** For the owner:

5a. Whether "settles only as refuted" means **refuse** an outcome-less settle, or **default** it
to refuted. This depends on question 6; ask it after.

5b. Whether the I8a rulings are to be committed somewhere citable. The recommendation is yes, at
the path the code already cites. What that covers up: the doc becomes a second source that must
track `owner.md`.

**Mine, answerable now:**

6. **Is closing a settled finding its own act, or does your answer close it?** *Owner.*
   - (i) Your answer is the ruling, and an agent later writes the close as a separate act. This is
     what is built, and it means there is a "ruled, not yet closed" period. Say whether that
     period is shown, and whether the finding is held back during it.
   - (ii) Your answer itself closes the findings it settles, as the proposal wrote. Nothing is
     written separately, and there is no in-between period.
   - No recommendation. (ii) matches the proposal and this codebase's "what can be derived is not
     written again", but it makes the findings record depend on the decisions record, which the
     build avoided on purpose. (i) keeps them apart, but then someone owns the in-between.
   - Either way, ruling (5) did not decide this.
7. **Which job is "arbitrator"?** *Owner.* (a) Sorting a finding's kind before a fix, (b) mapping
   your free text onto the options, or (c) acting on your ruling to close findings or authorise
   work. The other two get other names.
8. **How does a round's effect name a finding?** *Owner.* By the round's own number, with the
   round saying which codemap finding it is (if any), or by codemap's id only? Today two rounds
   that each have an F14 hold each other's back.
9. **Mark §5's four domain sentences** right or wrong. *Owner.*

---

## Appendix

### A. The deposition, verbatim

*A specimen of what the executor believed, written from inside the loop. Not findings.*

````markdown
# Deposition — the session that built I8a and both of its fix rounds

Written from my own context, before reading any evidence and before asking the owner anything.
Not revised afterwards.

## What I was asked for, and what I decided myself

**Asked.** "Let's implement .git/plan/2026-09-22-decision-rounds/plan.md". The plan was drafted in
an earlier session and ruled by the owner. After the worked-cases gate the owner said "Yes" to
building I8a: schema and fold for decision rounds, four event kinds, MATERIALIZER 26 → 27, and
teaching two existing folds to accept an agent's stamped event. Later:
- "Yes let's run codex and /code-review high" over the first round;
- "Record the settled items in owner and apply the fixes you listed" after the triage
  discussion;
- "Yes let's run codex and /code-review high over the fixes", which is this round.

**Decided myself, without anyone handing it to me:**
- **The fold's whole state model.** One mutable `FoldedDecision` per decision, with `state`
  assigned imperatively at many points: the answer arm, `apply`, the arbitration arm, and the
  supersession in the round-posted arm. Plus side-flags alongside it: `awaitingSettle`,
  `wordsAwaitDecision`, and later `awaitsYou`. Nobody specified a state machine. I wrote the
  states as a union and then set them wherever an event seemed to change something. I never
  wrote down which events may move which state, or who resets what.
- **The state names**, all mine: `partly-applied`, `awaiting-arbitration`, `readings-disagree`,
  `superseded`, `parked`. The plan's C-list named behaviours, not states.
- **The order of the arms.** Questions are pre-collected in a first pass; rounds, answers and
  arbitrations are processed in fold order, with `postedAt`/`supersededAt` positions. My call.
- **That the downstream folds check the stamp by presence only**, in the first draft. The plan's
  collision 3 said so, marked as the drafter's; R11 had superseded it and I did not notice.
  Round 1's arbitration found this.
- **That arbitrating onto ANOTHER decision (C2) pushes a copy of the answer object** into the
  target's answers. Invented on the spot.
- **"A dropped event changes nothing".** My own principle, written into a comment after the
  first read-back. Not the owner's.
- **What "unambiguous" means for a typed reply** (the whole message parses as `D2 yes` / `D2 B` /
  `D3 park date`). Recorded as my reading.
- **The flag conditions for an errant park** (unoffered date, or already past). Recorded as my
  reading of "if it is errant the system should probably flag it".
- **In this fix round:**
  - "`as` must be refuted or absent", where absent was allowed without anyone ruling it;
  - leave-closed keyed on the stamp inside the agent-only bypass;
  - `awaitsYou` cleared only in the answer arm;
  - the witness hash computed unconditionally.

## What I changed to make something pass

- **The first version of the fold had 27 scratch cases, all passing on the first run.** I
  mutation-checked them. The payload-match guard was vacuous, because my "paraphrased" case also
  changed the answer key. I added a case with a reworded option.
- **The garbage test was vacuous twice.** First the second guard caught the junk before the
  first; then my mutation only half-disabled the guard. I strengthened the junk each time.
- **The P4 test in this round was first written with two pointless round events.** I tidied it
  and re-confirmed it fails without the fix.
- **I changed the fixture `d1`'s effect from `as: "accepted"` to `as: "refuted"`** when removing
  "accepted". Its settle was in many existing cases, so this changed a fixture many tests rely
  on, to make them keep passing.
- **Fixtures `d2` and `d4` have settles with no `as`.** I did not touch them. That is exactly the
  as-less settle this round found. My fixtures exercised the case and my tests asserted it was
  fine: the verified settle tests check `applied` in the decisions fold, never that a finding
  would close.
- **The `db-migrate` pins** went from 26 to 27 with a new vocabulary pin. They were updated to
  pass, with nothing else changed to fit them.
- **The sharing-boundary test failed on the new `decisions/` scope,** and I added it to
  `SHARED_KINDS` with a reason. That test exists to make someone think about it. I thought about
  it for about a minute.

## Which tests I watched fail before the fix, and how

**Observed red, then green, by running `node --no-warnings dist/<file>.test.js`:**
- **This round:** P1, P3, P4 and the first P2 case; P7 (it threw); the accepted-refused case; the
  three new stamp expectations for P9/P10.
- **Not red first:** the second P2 case ("a later answer clears the flag") passed before the fix
  existed. I mutation-checked it afterwards, and removing the clear makes it fail.
- **I8a first round:** mostly written as scratch cases after the code. Red was never observed
  before the code existed; they were checked by mutation instead. The three regressions from
  Codex round 1 were checked the same way.

For the stamp tests (`decision-stamps.test.ts`), I mutation-checked five guards and ran a control
showing the ratify event was well-formed.

## The last point I know was good

I don't know one for the fold's behaviour: it has been wrong in some sequence at every review.
For the codebase generally, `21cb228` (before I8a), with the unit suite passing at 1698. I know
that only because the suite passed, and the suite never exercised any of this.

## What I'm unsure about, and what I was about to do next

- **Sure the state is the problem, unsure of the level.** I think the model of decision state is
  what keeps breaking. Every finding in both rounds is state left wrong on some path: stuck,
  stale, overwritten, un-superseded.
- **What I would have done next without being stopped:** fix Q1 by adding `delete d.awaitsYou`
  to `apply` and to supersession. That is the same kind of patch as the one that caused it.
- **The rules sit in two ends, and I keep patching one.** The finding-level truth ("is this
  finding settled?") lives in the findings fold; the decision-level truth ("was this answered
  and applied?") lives in the decisions fold. The stamp is the only bridge, and the rules about
  it are split across the ops (unbuilt), the decisions fold and the findings fold. This round
  found the settle-without-`as` gap exactly there: the decisions fold said applied, and the
  findings fold could never agree.
- **The decisions fold reports `applied` for things that are only intentions** until I8b writes
  the finding events. So `blockedBy` releasing a finding because a decision was "answered" is a
  claim about an act that has not happened.
- **I am unsure whether the codebase's rule ("acts enter the log; derivable things are
  projections") says the finding close should be derived** (option D in the discussion). The
  owner chose B for now, and I recommended B.

## The order things happened in

1. I8a first draft. My own read-back found three defects: a park superseding before its drop, an
   arbitration mapping elsewhere leaving the source stuck, and `blockedBy` too broad for
   partly-applied.
2. Codex round 1 found three:
   - the arbitrator identity taken from a caller field (my fix derived relayers from the
     evidence);
   - an arbitrated park recorded as answered (my fix added the `parkOption` block in `apply`);
   - a typed park date, left alone by ruling.

   The read-back also found the malformed-input throws.
3. Codex round 2 wedged after one finding (a null effect), which I fixed.
4. Committed `747f7fd`.
5. `/code-review high` found nine, and my read-back added one. Triage: two sorters and an
   arbitrator. The owner ruled in a discussion. I made nine fix commits.
6. `/code-review high` on those found ten. Codex wedged for the third time. This triage.

**Surprises:**
- **My fixes to Codex round 1 were where round 2 landed** (the relayers, the `parkOption` block).
  I expected fixes written with mutation checks to be solid; they were solid for the sequence I
  tested and wrong for the neighbouring one.
- **Codex wedging three times identically.**
- **The C-list and plan read as complete, and they were not.**
  - Nothing said what state a decision is in after an arbitration maps to another decision.
  - Nothing said what a settle without `as` is.
  - Nothing said what a multi-select park means.

  I filled each of those at the keyboard.

## Terms that mean two things

- **"answered".** A decision state (`answered`), and the English sense (the person answered).
  A decision can be answered in English and `awaiting-arbitration` or `partly-applied` in state.
- **"applied".** The decisions fold's `applied` list, meaning the effect was accepted in the
  decision record. It does not mean the finding changed: that needs a separate finding event
  that nobody writes yet.
- **"settle".** Sometimes "the decision says close this", sometimes "the finding is closed".
- **"verified".** For an answer, the transcript check passed (done by the op, trusted by the
  fold). For a stamp, "carries the right shape". I have used both.

## Asserted from memory, not read or run

- That `blockedBy` is what the page and the skills will use to show blocking.
- That the web page will render the flags. Nothing renders anything yet.
- That no stamped event exists anywhere. The arbitrator did check this one by grep.

## Where I think the problem is (a guess)

The fold computes decision state incrementally, event by event, mutating a record that several
arms each touch, and no invariant says what the state must be given the full event history. Each
fix adds a mutation on one arm. The missing level is a statement of what a decision's state IS,
as a function of the posted decision plus the set of answers and arbitrations and supersessions
that apply to it. The same missing level exists across the decisions/findings boundary: what
"this finding is settled by a decision" means, and which fold owns it.

**Beyond my own state model:** the plan's C-list is behaviour-level, and the owner ruled on
behaviours. Nobody, me included, stated the state model those behaviours live in. So each ruling
was implemented as a local patch.
````

### B. Commands that produced a number or a confirmation

All run at `c745e30`, clean tree, `dist/` built after the last source edit (23:51). The probes
import `dist/` read-only from the repository root.

1. Evidence pack: `.git/triage/2026-09-23-i8a-fix-round/evidence/` (self-fix, commits, surface).
2. Commit times: `git log --format='%h %ad %s' --date=iso 21cb228~9..c745e30`
3. Rulings absent from committed docs:
   `for p in "leave it closed" "awaits you" "just drop it" "R2[0-5]"; do grep -c -E "$p" docs/decision-rounds-worked-cases.md docs/PROPOSAL-decision-rounds.md; done` (all 0)
4. `git ls-files | grep -c owner.md` (0)
5. No reader or writer: `grep -rln "shared-decisions\|foldDecisions\|decisionsProjection" src web` (fold, projection, db, materialize comment, tests only; `blockedBy` hits in `git.ts` and `web/standard.js` are unrelated names) and
   `grep -rn "closeStampFor\|signOffStampFor\|postRoundEvent\|recordAnswerEvent\|recordArbitrationEvent\|logQuestionEvent" src --include=*.ts | grep -v '\.test\.ts'` (definitions and fold call sites only)
6. No test joins the two folds: `grep -ln foldDecisions src/*.test.ts | xargs grep -ln "foldFindings\|foldStandard"` (only `db-migrate.test.ts`, which pins vocabulary)
7. Unpushed: `git branch -r --contains 747f7fd` (empty); `git log -1 origin/main` (`161d754`, 2026-09-20)

Probes 1–3 (`node --no-warnings probe.mjs`, with `probe.mjs` saved at the repository root):

```js
import { foldDecisions, blockedBy, decisionHash } from "./dist/shared-decisions.js";
const P = { principal: "alice", actor: "alice" };
const A = { principal: "alice", actor: "agent", via: "claude" };
let n = 0;
const ev = (kind, data, actor = A) => ({ id: `e${++n}`, kind, data, actor, at: `2026-09-23T00:00:0${n % 10}Z` });
const mk = (id, round, ref, options, multi = false) => {
  const d = { id, round, ref, kind: "options", payload: { question: `Q ${id}?`, options: options.map((o) => ({ label: o.label })), multiSelect: multi }, options };
  return d;
};
// 1. as-less settle, verified via page (direct) by the person
{
  const d = mk("d2", "R1", "D2", [{ label: "Close it", effects: [{ findings: ["F10"], on: "settle" }] }, { label: "Keep", effects: [] }]);
  const evs = [ev("decision.round.posted", { round: { id: "R1", source: "x", universe: "u" }, decisions: [d] }), ev("decision.answer.recorded", { decision: "d2", hash: decisionHash(d), via: { kind: "direct", option: "Close it" } }, P)];
  const s = foldDecisions(evs);
  console.log("1 as-less settle:", s.decisions[0].state, JSON.stringify(s.decisions[0].applied), "blocked:", JSON.stringify([...blockedBy(s)]));
}
// 2. same round-local number in two rounds
{
  const da = mk("da", "R1", "D1", [{ label: "A", effects: [{ findings: ["F14"], on: "unblock" }] }]);
  const db = mk("db", "R2", "D1", [{ label: "A", effects: [{ findings: ["F14"], on: "unblock" }] }]);
  const s = foldDecisions([ev("decision.round.posted", { round: { id: "R1", source: "x", universe: "u", pr: "1" }, decisions: [da] }), ev("decision.round.posted", { round: { id: "R2", source: "y", universe: "u", pr: "2" }, decisions: [db] })]);
  console.log("2 cross-round F14:", JSON.stringify([...blockedBy(s)]));
}
// 3. ref as a one-item list, then an unverified reply
{
  const d = mk("d1", "R1", ["D1"], [{ label: "A", effects: [] }]);
  try {
    const s = foldDecisions([ev("decision.round.posted", { round: { id: "R1", source: "x", universe: "u" }, decisions: [d] }), ev("decision.answer.recorded", { decision: "d1", hash: decisionHash(d), via: { kind: "unverified", words: "D1 A" } })]);
    console.log("3 ref list: no throw", s.decisions.length);
  } catch (e) { console.log("3 ref list: THROWS", e.message); }
}
```

Expected: `1 as-less settle: answered [{"finding":"F10","on":"settle","answer":"e2"}] blocked: []`, `2 cross-round F14: [["F14",["da","db"]]]`, `3 ref list: THROWS d.ref.toUpperCase is not a function`.

Probe 4 (relayed park asymmetry):

```js
import { foldDecisions, decisionHash } from "./dist/shared-decisions.js";
const A = { principal: "alice", via: { kind: "agent", model: "m" } };
let n = 0;
const ev = (kind, data, actor = A) => ({ id: `e${++n}`, kind, data, actor, at: `2026-09-23T00:00:${String(n).padStart(2,"0")}Z` });
const d3 = { id: "d3", round: "R1", ref: "D3", kind: "options",
  payload: { question: "Park?", options: [{ label: "Park until 2026-10-15" }, { label: "Now" }] },
  options: [{ label: "Park until 2026-10-15", effects: [], park: "2026-10-15" }, { label: "Now", effects: [{ findings: ["F20"], on: "unblock" }] }] };
const post = () => ev("decision.round.posted", { round: { id: "R1", source: "x", universe: "u" }, decisions: [d3] });
// clear relayed reply
let s = foldDecisions([post(), ev("decision.answer.recorded", { decision: "d3", hash: decisionHash(d3), via: { kind: "unverified", words: "D3 A" }, relayedBy: "sess-A" })]);
console.log("clear 'D3 A':", s.decisions[0].state, "answers", s.decisions[0].answers.length, "awaitsYou", JSON.stringify(s.decisions[0].awaitsYou));
// vague words, arbitrated to park
const ans = ev("decision.answer.recorded", { decision: "d3", hash: decisionHash(d3), via: { kind: "unverified", words: "lets wait till mid october" }, relayedBy: "sess-A" });
const maps = [{ decision: "d3", option: "Park until 2026-10-15" }];
s = foldDecisions([post(), ans, ev("decision.arbitration.recorded", { answer: ans.id, arbitrator: { transcript: "agent-B", reading: "r", maps }, session: { reading: "r", maps } })]);
console.log("vague words:", s.decisions[0].state, "answers", s.decisions[0].answers.length, "awaitsYou", JSON.stringify(s.decisions[0].awaitsYou));
```

Expected: `clear 'D3 A': open answers 0 awaitsYou undefined`, `vague words: open answers 1 awaitsYou {"answer":"e3","park":"2026-10-15"}`.

### C. Checkpoint

`diagnose/20260923-042851-2026-09-23-i8a-fix-round` → `c745e306c453`, the state at the time of
writing. Return with `git switch -c recovery diagnose/20260923-042851-2026-09-23-i8a-fix-round`.
The last good point, owner-confirmed, is `21cb228`.

---

## 11. The owner's answers (2026-09-23)

Asked in session with `AskUserQuestion`. The question texts and option texts are the relaying
session's words; the answers are the owner's.

**Q (§3):** How do we proceed with the ten unpushed decision-round commits? (The default if nothing
is decided is another fix round.)
- **Answer:** the option labelled "Rule first (Recommended)". The option text below is the session's:
  "Leave all ten untouched and unpushed. You answer the questions below; then a fresh session
  writes out what a ruling and a close are, as cases you mark, and only then decides keep, rewrite
  or revert."

**Q (§10.6):** Is closing a settled finding its own act, or does your answer close it? (i) Your
answer is the ruling, and an agent later writes the close as a separate act. That is what is built,
and it creates a 'ruled, not yet closed' period. (ii) Your answer itself closes the findings it
settles, as the proposal wrote. Nothing is written separately and there is no in-between.
- **Answer:**
  > Agent closed is the expected primary means, it's possible a finding could be pre-staged to close
  > immediately on a ruling if it answers a specific multiple choice option, but I expect that to be
  > less common.

**Q (§10.7):** Which job does 'arbitrator' mean? (a) Sorting a finding's kind before any fix (the
proposal's use). (b) Mapping your free-text answer onto the offered options (the code's use). (c)
Acting on your ruling to close findings or authorise fix work (your answer today; the proposal calls
this the verifier). The other two get other names.
- **Answer:**
  > Arbitrator is part of /triage-review and resolves conflicts between the two sorting models. The
  > name for a model that verifies verdicts or fixes should be a verifier, an arbitrator would only
  > get pulled in on disagreement, my verbiage was sloppy.

**Q (§10.8):** How does a round's effect name a finding? Today a round names findings by its own
numbers (F14), a close compares against codemap's finding id, and two rounds on different pull
requests that each have an F14 block each other's findings.
- **Answer:**
  > Codemap ids. The round instrumentation would integrate with codemap for fix verification and
  > durable documentation of findings, so it would be a stronger store than .git/triage
