# Postmortem — the pre-merge review of `questionnaires-and-repair-verification` (2026-09-28)

Window `161d754497b7..126c56ac8048` (101 non-merge commits counted, one excluded as noise; all on this
machine, none pushed). Checkpoint `diagnose/20260928-213757-2026-09-28-pre-merge-review` → `126c56a`.
In-flight commit: none. Diagnosis only: nothing was changed except this file. Every command below
runs from the repository root.

---

## 1. Executive summary

**What was being built.** Two things that serve one goal the owner stated today: stop findings
lists from going stale (people either never close findings, or close them without looking) by
letting agents close a finding only after independent checking; and keep the owner's own decisions
in codemap durably, so agents can act on the owner's behalf.

**What happened.** Over seven days the decision-recording half was built, reviewed and diagnosed
twice. A second model then built a large extension on it: independent verification of repairs,
operation sign-off and several layers the owner never asked for. This morning a review of that work
became a recovery plan, the owner approved it, and one session carried it out in about four hours:
it removed the unwanted layers, rebuilt how a verifier is identified, and redesigned the
questionnaires, which the owner tried and liked. A five-reviewer review before merging then returned
64 findings. Fifty of the 53 that name a line sit in this week's own fixes.

**What it cost.** Seven days, about sixteen recorded review or planning rounds, and three diagnoses
including this one. Nothing is shared yet: the published main branch and the team's shared log do
not contain any of it, so the cost is time only.

**What kind of failure it was.**
- *What made the repairs wrong:* two words were each doing two jobs, and nobody separated them.
  "The fixer" means both *the agent that changed the code* and *whichever record codemap can see*:
  a person's account in one place, a live connection in another, a self-reported label in a third.
  So each repair picked a different thing to compare. The owner answered today that only the agent
  that edited the code is the fixer, and codemap has no record of who edited anything. Separately,
  the rule for a damaged entry in a teammate's log was ruled twice today, "skip it and report it"
  in the morning and "halt and report it" in the afternoon. The code follows the morning version,
  and when the damage is of a kind it did not anticipate it can drop a well-formed answer and name
  that answer as the damaged one.
- *What was available to settle it:* the owner, first. "Who is the fixer?" was never put to the
  owner until today; an earlier plan approved "rebuild the fixer/relayer rule" as one of eight
  bundled defaults. The project's own standing rule for a damaged shared log ("stop and say so
  rather than make it worse") was on file and was not cited when the skip rule was designed.
- *The conditions:* the pace (about 32,000 lines added in seven days; the recovery landed 23
  commits in four hours, one of them an identity rebuild of +1,060/−3,453 lines), and rulings taken as picks of
  a recommended option whose question already carried the code's own vocabulary.

**What is being asked for, and of whom.** A decision from the owner (§3), which depends on five
short questions only the owner can answer (§10, questions 1 to 5): who the fixer is and how codemap
can know it, what makes two agents the same, which of today's two damaged-log rulings stands, whose
name a confirmation carries, and which of the three guarantees named today this branch must meet
before it merges.

---

## 2. What doesn't add up

Two blind readers ran the six lenses. Both said the six lenses were enough and invented no category.
**Every lens found something** in at least one reading. No entry was flagged by one reader and
cleared by the other on the same artifact. Where both touched the same thing (the confirm question
quoting Alice's words, the fixer-launched subagent's weaker grade), both cleared it. Below the lens
line, `owner.md` carries no text, so no ruling reached me that the readers lacked. The readers
disagreed on one fact, and it is settled in entry 2.

**1. NOTICED: "the fixer" is one agent in the owner's answer and a different set in the code, and
"the same fixer" is judged three ways.** *Both readers* (A: N2, N3; B: 1). Lenses: vocabulary
drift, pairwise, cardinality, discriminator decay.
- The owner (node 15, today) says only the agent that edited the code is the fixer, and an agent
  that only recorded the evidence may verify. Codemap's fixer is whichever session calls itself one.
  Any session that calls itself a "relayer" is refused as well. The skill says to register "the
  session that fixes (or relays for) a repair". *Confirmed by reading:*
  `src/repair-verification.ts:62-66`, `skills/triage-review/references/codemap-workflow.md:45`.
- Sameness is judged three ways. In the sort check it is one person account, taken across every
  repair (`src/repair-records.ts:143-146`). In verification it is one connection, on this repair only
  (`src/repair-verification.ts:55,64`). A third check compares a sorter's self-reported session
  label against a connection's random id (`:146`), and those two can never match in real use.
  *Confirmed by running* (reader B): an agent registered as fixer on an unrelated repair caused the
  owner's own hand-written correction of a different repair to be held.
- **"Relayer" already had a meaning here, and the owner retired a guard built on it.** On 09-23 the
  owner ruled that the guard "the agent that relayed the words also reads them" be removed, along
  with "two smaller relayer guards" (`docs/decision-rounds-worked-cases.md:884-890, 941, 1004`,
  commit `6e6933f`). The removed guard "compares an agent id with session ids and can never fail",
  which is the same shape as the third check above. The repair work reintroduced a relayer
  exclusion on 09-26 (`c204796`), and it was rebuilt on 09-28 (`4acf497`).
- *Goes away if:* the owner intends "relayer" to be refused, and intends the sort check to cover the
  whole account on purpose.

**2. NOTICED: two rulings on a damaged teammate log, "skip it, and report it" and "halt and
report".** *Both readers* (A: N1; B: 4). Lenses: pairwise, discriminator decay.
- This morning's pick, "Skip it, and report it (Recommended)", was the answer to a question whose
  premise was "today it throws, blocking the whole scope" (`.git/plan/2026-09-28-codex-recovery/owner.md:27-30`).
  This afternoon's answer: "Nothing unreadable should get into the team log. If it does, codemap
  should halt and report", "as it may require a history rewrite".
- The code skips and carries on. When no specific check catches the problem, it removes whichever
  single event lets the most of the rest be read.
  - *Confirmed by running:* a well-formed later answer can be the one removed, and it is then
    labelled as the event "the fold could not read".
  - *Confirmed by running:* two independent bad events still throw.
- The six plain decision writes are not checked against the fold before they are appended
  (`src/shared-decisions.ts:2382-2442`). The repair writes are checked (`src/ops/repairs.ts:107-115`).
- The project's older rule for a damaged shard is to block and say so ("loud beats quiet here every
  time", CLAUDE.md, from `bc01850`, 09-01).
- *The one factual disagreement:* reader A says a tie drops the later event, "not necessarily the
  damaged one". Reader B says a tie usually drops the bad revision. My run settles it: the good
  answer is dropped by the size rule, not by the tie. It happens when a later good event depends on
  an earlier bad one.
- *Goes away if:* the owner says the two rulings are one rule (for example, "unreadable" means
  garbled bytes only, and a well-formed event of the wrong shape is skipped).

**3. NOTICED: a confirmation is Bob's in the owner's answer and Alice's in the record, and between
two people the later click wins.** *Both readers* (A: N4; B: 5). Lenses: cardinality, pairwise.
- The owner (Q3, today) says it would be Bob's confirmation of the action, with authority.
- The record works differently:
  - The question asks the person who answers it "As of when you typed it, is that what you meant?"
    (`src/shared-decisions.ts:444`).
  - The latest pick by anyone decides (`:1137`).
  - The resulting ruling is copied under Alice's name (`bind`, `:1142`).
  - So Bob's later Yes overrides Alice's own earlier "No, not what I meant".
- In the same fold, conflicting resolutions of a comparison by two different people are held for a
  human instead of being settled by time (`:1348-1351`).
- *Goes away if:* the ruling's author is shown as the confirmer somewhere neither reader read, and
  the owner accepts that time decides between two people on one confirmation.

**4. NOTICED: for a problem found in several places, the fix is checked at one place by the
verifier, and the fixer's own word stands for the rest.** *Both readers* (A: N5; B: 2). Lenses:
second authority, population.
- "Fixed" needs the verifier to see the check fail and then pass itself.
- "Every site covered" is read from the fixer's own list. That list is handed to the verifier,
  although the brief's comment says the brief carries "none of the fixer's conclusions", and the
  closure is gated on it (`src/repair-verification.ts:86-87`).
- The owner's bar is "other sites got fixed **or filed**". A filed site has no representation.
- *Confirmed by running* (reader B): a three-site problem closed as fixed on one check at one site
  plus the fixer's list.
- *Goes away if:* the owner considers the fixer's list plus the original sort enough.

**5. NOTICED: "fixed" and "refuted" have different bars for the same pinned check, and refuting has
an older, cheaper door.** *One reader* (B: 3). Reader A never examined the refutation path. Lenses:
population, second authority.
- To mark something fixed, the verifier must run every check the fixer pinned. To refute, any
  passing command at the old code is enough (`src/repair-verification.ts:101-103`).
  *Confirmed by running* (reader B): the command `true` refuted a finding whose pinned check fails
  on the old code.
- Since 08-25 (`74dc3c6`), any agent may also refute an unconfirmed finding that an agent filed,
  with no verification at all (`src/shared-findings.ts:583-592`).
- The owner today: the system "needs to verify refutations are made on a real basis".
- *Goes away if:* the owner says any passing check at the old code is a real basis, and that the
  August door is meant to stay.

---

## 3. Decision requested

The path has forked. Nothing is shared yet, so every option below is cheap to reverse.

| option | what it is | cost | what it forfeits |
|---|---|---|---|
| **Rule first** (recommended) | Touch no code. The owner answers §10 questions 1–5. A fresh session writes up the roles in a repair and the damaged-log rule as cases the owner can mark wrong. Then plan. Whether to take out the skip-and-carry-on net from `b87ea88` (keeping its per-shape guards and tests) follows from question 3. | one sitting of the owner's time, plus one session | merging today |
| **Split the pile** | Now, fix only the items that touch neither repair participants nor the decisions fold (the sort's clusters 3, 5, 6, 7). Hold clusters 1, 2 and 4 for the rulings. | one fix round now | cluster 1's "tool checks what the fold does not" gets fixed site by site a third time before anyone reads the owner's "nothing unreadable in the log" against it |
| **Fix all and merge** | What the stuck session was about to do: apply the findings one site at a time, then merge and push. | one large round | today's rulings go unimplemented: the evidence writer is refused, the log does not halt, Alice is credited, and bugs are not covered. A fourth diagnosis is the likely next step. |

**Recommendation: Rule first.** Every design and assumption item in the sort sits on one of the
five questions, and each question takes a sentence to answer. **Downside:** about twenty
implementation slips wait on questions most of them do not depend on.

**If nothing is decided:** the branch stays unmerged, and the published main branch (`161d754`) and
the team's shared log stay as they are. Local main has unpushed commits (`c76748a`, `b87ea88`,
`b251d03`) that the rulings may reverse, and the two copies of the skills keep drifting.

---

## 4. Timeline

Earlier round records exist (the evidence pack lists 58 files under `.git/triage` and `.git/plan`).
So this sequence comes from the record and not only from the deposition's memory. Commit dates are
author dates, and the rebase in the last round reordered them.

| # | when | what it was told (source) | what it changed | what came next |
|---|---|---|---|---|
| 0 | 09-21–22 | Close-audit research, then the decision-rounds proposal and worked cases, with owner rulings written verbatim (owner) | Docs only (`98785708`…`21cb228`). The proposal defines the fixer as the one who "changes code, and records the evidence" (`docs/PROPOSAL-decision-rounds.md:31`) | Build |
| 1 | 09-22/23 | Build the decision record on the owner's cases (plan `2026-09-22-decision-rounds`) | `11b030d`, `2f41138`… | Two fix rounds. **Diagnosis 1** (`2026-09-23-i8a-fix-round`): "settled" carried two meanings |
| 2 | 09-23–24 | Recovery plan, then four review/fix rounds (`decision-rounds-2-review`, `-impl-review`, `-impl-2-review`, `-impl-2-codex`), each with an owner file | Commits 26–56. Owner removes the dead "relayer" reader guard (`6e6933f`) | Codex-round review, then round-4 review |
| 3 | 09-24 | Round-4 review | none | **Diagnosis 2** (`2026-09-24-decision-rounds-2-round4-review`): possible and established conflict conflated. Rulings contract written (`56b1db9`) |
| 4 | 09-24–25 | Rounds five and six and the remaining work (four `/ez-plan` plans, owner files) | Commits 57–73, carrying no session trailer (see §9) | Remaining-decision-work plan |
| 5 | 09-26–28 02:26 | The remaining-decision-work plan, built by the second model | Repair verification and self-declared participants (`c204796`), sign-off (`bd880ed`), the second model's provenance (`a6ecdbe`, `9dd0b1b`), popups (`e5add77`) | Review of that range by another session, whose written input holds the owner's verbatim rulings |
| 6 | 09-28 12:29–16:38 | The `codex-recovery` plan, approved "as written", including bundled default B7 "the fixer/relayer-can't-verify rule … is rebuilt on the new verifier identity model" (owner, by pick) | Phase 1 on main (`c76748a`, `b87ea88`, `b251d03`); drops (`cf7e0ec`, `68e0852`, `f3b2574`); identity rebuild (`4acf497`, 13:28, +1,060/−3,453 lines); Phase 3 (`2ad3010`…`753d9cd`); questionnaires (`d86845b`, then `f33d5ef` after the owner tried them); skills; ids (`126c56a`) | Pre-merge review |
| 7 | 09-28 | Five reviewers, asked for by the owner | none | 64 findings, then the sort, then the owner picks "Diagnose" |

The criteria moved within the last round. The morning's skip ruling and the afternoon's halt ruling
fall on the same day. "Who is the fixer" was first put to the owner as a question after round 7.

---

## 5. Diagnosis

**The domain model this report assumes.** Mark any of these wrong; none needs the repository.
- *Your agent A edits the code that fixes a finding. Agent B, a separate session under your
  account, writes up the evidence and asks for verification.* This report assumes B may then fill
  one of the two verifier slots. Having read A's write-up does not disqualify B.
- *A teammate pulls a log with one entry codemap cannot make sense of.* This report assumes you
  want everyone who reads that universe's decisions stopped and shown the entry, rather than working
  on with it quietly left out. It assumes this holds whether the entry is garbled bytes or
  well-formed but wrong-shaped.
- *Alice types an ambiguous answer and Bob clicks "Yes, close it".* This report assumes the record
  should say Bob ruled, quoting Alice's words. It also assumes Bob's Yes stands even if Alice had
  already answered "No, not what I meant".

**Mechanism: concept conflation, in two terms. The op/fold recurrence is population underreach.**
- *"Fixer" and "session".* The rule the owner cares about is a fact about the work: who edited the
  code. The records codemap holds are facts about how an event arrived: principal, MCP connection,
  or a label the sorter wrote. Each repair derived the fixer from whichever of these was nearest:
  - the account, in the sort hold (`src/repair-records.ts:143-146`);
  - the connection, on this repair only, in verification (`src/repair-verification.ts:55-66`);
  - the reported label against the connection id (`:146`);
  - the requester, excluded separately (`src/repair-verification.ts:151`).

  The deposition lists five terms it "used for two things". The sort's design and assumption items
  cluster exactly here.
- *The smallest scenario where two defensible repairs demand different answers.* The owner runs A
  (edits) and B (writes the evidence and requests verification) under one account.
  - Repair X excludes by account. It refuses A, B and the owner's own hand-written correction
    (reader B ran this).
  - Repair Y excludes by connection. It refuses whichever of A or B registered itself, and it refuses
    B anyway as the requester.

  Neither can express "A, and only A", because nothing records A.
- *A value both repairs could read, and what I found.* Before settling on the scenario I looked for
  one. The fix commit is pinned in every verification request. 79 of the window's 102 commits carry
  a `Claude-Session:` trailer naming the session that committed them, and codemap reads no trailer
  anywhere (`git grep -n -i "claude-session\|trailer" 126c56a -- src` returns nothing). That is a
  partial candidate at best:
  - it names the session that committed, not the one that edited;
  - the other model's 23 commits carry none;
  - it lives in transcript-session space, and verifier identity lives in connection space: the third
    meaning of "session".

  So the scenario stands, weakened. *(CONFIRMED that the trailer exists and is unread. ARGUED that
  it cannot settle the scenario.)*
- *"Unreadable".* This is an unsettled contract more than a conflation: two rulings on the same day.
  The morning question framed blocking as the defect, and the answer was a pick of the recommended
  option. The afternoon answer, and the project's older rule for damaged shards, both say stop.
  `b87ea88` built a third thing that neither ruling describes: it chooses which event to lose by
  size, and it can lose the good one. *(CONFIRMED by running, §6.)*
- *The op/fold recurrence (sort cluster 1).* This is population underreach. The rule is that the
  log may hold only what the fold accepts. It governs every write to every folded scope. It was
  ruled site by site ("No, just fix each site (default)"), and this round found four more sites.
  - The six plain `emitEvent` decision writes (`src/shared-decisions.ts:2382-2442`) were never on
    the list.
  - The owner's "nothing unreadable should get into the team log" is this rule, stated at the top.
- *The sort's distribution, as evidence.* Deduplicated items by group:
  - implementation defect: 20 items, including two patterns (4 sites, and 11 sites that predate the
    window);
  - design defect: 7;
  - assumption: 3;
  - design suggestion: 6;
  - invalid: 6;
  - unresolved between groups: 7, four of them between design and assumption.

  The slips are spread across all seven clusters. The design and assumption items sit in repair
  participants (R-a, R-b, R-c, R-d, D-route) and in the decisions fold (D6, A5, F62). That is the
  signature of a rule nobody wrote down under otherwise ordinary slips. It describes the round that
  stopped the loop, not the whole week.

**Evidence access, per rule.**
- *Who the fixer is:* **available and unconsulted.** The owner answered it in one pick today, the
  first time it was asked. Before that it was approved inside a bundle of eight defaults (B7). The
  owner's 09-23 ruling retiring the relayer guard was also on file and was not cited.
- *What makes two agents the same:* **unavailable so far.** The owner was asked and did not answer
  that half (see the session note in `owner.md`). Codemap holds no record of who edited code. This
  is the question that needs a person.
- *Damaged log:* **available and unconsulted.** The standing rule for damaged shards in the
  project's own CLAUDE.md (block, refuse, "loud beats quiet") was not cited in the question or in
  `b87ea88`.
- *Confirm credit:* **available, consulted for the single-person case only.** The P3.2 ruling
  "latest pick decides" was framed about one "you".
- *The op/fold population:* **available and unconsulted.** A grep of the emit call sites (§6,
  entry 3) enumerates it.

**Kill conditions.** If this diagnosis is right, the recovery must not turn out to need these:
1. **Closing the fixer items with a guard at each site, with nobody writing down which roles exist in
   a repair and how codemap knows each one, and the next review finding nothing there.** If one
   notion of identity fixes all four sites, this was underreach, not conflation.
2. **The owner marking the first domain sentence wrong**: the evidence writer is excluded after all,
   for blindness or any other reason. That would mean the node-15 pick does not say what this report
   reads it as saying, and entry 1 shrinks to the relayer wording.
3. **The owner saying the two log rulings are one rule** (wrong-shaped entries are skipped; only
   garbled bytes halt). Then the log strand is not a moved contract, and `b87ea88` needs only its
   selection rule corrected, not taking out.

---

## 6. Believed versus actual

Addressed to the session that does the recovery.

**1. Believed:** `4acf497` "rebuilt the fixer/relayer rule on the new identity model", and it was
met because the fold refuses a run whose identity matches a recorded fixer. **Record:**
- The fixer is whoever registers itself, and a registered relayer is refused too
  (`src/repair-verification.ts:62-66`).
- The owner's case (2), B verifying the fix whose evidence it wrote, is refused a *second*,
  independent way: B asks for verification, which makes it the orchestrator, and the fold refuses
  the orchestrator filling a slot (`src/repair-verification.ts:151`).
- The request fold does not require a recorded fixer. Only the op does
  (`src/ops/repair-verification.ts:95`).

**The difference matters because** removing the relayer role alone would still refuse B. Whether
the orchestrator exclusion is about blindness (B has read the fixer's write-up) or about being the
fixer is a question the owner has not been asked (§10 Q1). *CONFIRMED.*
`git show 126c56a:src/repair-verification.ts | sed -n '62,66p;151p'`;
`git show 126c56a:src/ops/repair-verification.ts | sed -n 95p`.

**2. Believed:** the decisions fold is total and "never throws" (fuzzer: 0 throws), and the fallback
leaves out "what it cannot read". **Record:**
- The fallback rethrows when no single removal helps (`src/shared-decisions.ts:788`). Two
  independent unanticipated bad events therefore throw. The commit message of `b87ea88` says so
  itself.
- It chooses by size (`:786`). When a later well-formed answer depends on an earlier malformed
  record, the answer is removed and blamed.

Both results came from running the real `leaveOutUnreadable` from `dist/`, built from `126c56a` ten
seconds after the commit, on synthetic folds. Nothing was written. **The difference matters
because** the net meets neither ruling: it does not skip *the* bad entry, and it does not halt. The
test "does not block" in `src/decisions-total.test.ts` pins the behaviour the afternoon ruling
rejects. *CONFIRMED.* The script (a scratch file outside the repository, run with
`node --no-warnings`):

```js
import { leaveOutUnreadable } from "<repo>/dist/shared-decisions.js";
const size = (t) => t.n, E = (id, bad = false) => ({ id, kind: "k", bad });
const once = (evs) => { if (evs.some(e => e.bad)) throw new Error("boom"); return { n: evs.length }; };
leaveOutUnreadable(once, [E("a"), E("b", true), E("c", true)], size);          // throws "boom"
const once2 = (evs) => { const ids = evs.map(e => e.id);
  if (ids.includes("r") && ids.includes("x")) throw new Error("answer x dereferences malformed round r");
  return { n: ids.includes("r") ? ids.length + 3 : ids.length }; };      // r holds 3 questions
leaveOutUnreadable(once2, [E("r"), E("q"), E("x")], size);               // skipped: x (the good answer)
```

**3. Believed:** "the op re-folds a candidate and refuses what the fold refuses, so op and fold
cannot disagree", for decisions writes, and repair writes "do the same". **Record:**
- Repair record appends do fold the candidate (`src/ops/repairs.ts:107-115`).
- Decision withdrawals and revisions fold it too (`asFolded`, `src/shared-decisions.ts:2450`).
- Six decision write kinds append with plain `emitEvent`, with no candidate fold: round, confirm,
  question, answer, reading, comparison nomination (`src/shared-decisions.ts:2382-2442`).
- The withdrawal op still answers ok for what the fold refuses (sort P1, F3). So even where a
  candidate is folded, it does not fold the way the real event does.

**The difference matters because** the population of the owner's "nothing unreadable in the team
log" is every write, not the four sites P1 counted. *CONFIRMED.*
`grep -n "emitEvent(logRoot\|emitEventChecked(" src/shared-decisions.ts src/ops/*.ts`.

**4. Believed (implicitly, by the test's comment "A sorter as the skill's sort reports it, and a
fixer as the connection it worked on"):** the fixer-sort guard's session clause is covered.
**Record:** deleting the clause (`src/repair-records.ts:146`, the
`|| d.assessments.some(a => a.identity.session === p.input.identity.session)` line) leaves **all 56
repair tests passing**. The fixture sets both sides to `"s1"` (`src/repair-records.test.ts:16-19`),
an equality real data cannot produce. **The difference matters because** this fixture is the
changed-fixture suspect: it is where the two meanings of "session" were made to agree. Any fix to
R-d needs a check that fails first, and none exists. *CONFIRMED.* Isolation: a scratch worktree
(`git worktree add --detach <scratch> 126c56a`, `node_modules` symlinked), then the source mutated,
`npx tsc`, and
`node --no-warnings --test --test-isolation=none --test-concurrency=1 dist/repair-*.test.js` →
`tests 56, pass 56, fail 0`. The worktree was removed. `git status` was clean and HEAD was still
`126c56a` afterwards.

**5. Believed:** the order of events in the deposition's "Also" section. **Record:** it matches the
commit record (§4). Commit `f57c0a3`, which the deposition cites, is the one the evidence pack
excluded as noise (its subject begins "Merge"). It is not missing. This entry is recorded so nobody
re-checks it.

---

## 7. Recovery envelope

*For a teammate who was not here. This bounds the recovery; it is not a plan.*

**What is preserved and what is in question.**
- *Preserved*, because it rests on explicit owner rulings and nothing found here touches it:
  - the removed layers (`cf7e0ec`, `68e0852`, `f3b2574` and the drop half of `4acf497`);
  - verifier identity as a connection claim held in memory (`4acf497`);
  - the ruling-capsule collapse (`2ad3010`);
  - one canonical form (`753d9cd`);
  - the questionnaire redesign (`d86845b`, `f33d5ef`), which the owner tried and liked;
  - codemap-assigned ids (`126c56a`), with the open actor question F1.
- *Coverage to keep even if code goes*: the per-shape guards and the fuzz tests in `b87ea88`
  (`src/decisions-total.test.ts`, minus its "does not block" expectation, which pins the net), and
  the repair test suites.
- *In question*, pending §10:
  - the take-out-one-event net in `b87ea88`;
  - the self-declared participant model with its relayer role (`c204796`, kept unexamined by
    `4acf497`);
  - the sort-hold identity clauses and their fixture (`src/repair-records.ts:143-146`,
    `src/repair-records.test.ts:16-19`);
  - the orchestrator exclusion (`src/repair-verification.ts:151`);
  - confirm credit and ranking (`af773df`).

**Checkpoint.** `diagnose/20260928-213757-2026-09-28-pre-merge-review` → `126c56a`. To return:
`git switch -c <name> diagnose/20260928-213757-2026-09-28-pre-merge-review`. **Do not do these
first:** apply the review's findings, or push local main, whose Phase 1 commits the rulings may
reverse.

**The decision frontier.**
- *To settle before any plan:*
  - the roles in a repair: who edits, who writes the evidence, who requests, who verifies, who
    arbitrates, who applies. For each: observed by codemap, or declared by the agent (the owner has
    said mistakes, not adversaries);
  - what "the same agent" means;
  - which damaged-log ruling stands, and whether it covers well-formed entries of the wrong shape;
  - whose name a confirmation carries;
  - which of the owner's three guarantees (fixed, including sites fixed or filed; refutations on a
    real basis; decision closures logged), and bugs, belong to this merge.
- *Must not yet acquire* a helper name, a site count or a repair shape: "fixer identity", the
  write-admission rule for the log, and multi-site coverage. Each is still fogged.

**Premises the plan author must check before writing a step.** These are yours to check, not mine:
I have not written the steps.
- *Codemap can know who edited the code.* Source: the owner's pick. Cheapest falsifier: list what an
  editing agent calls in codemap while it edits (probably nothing), and ask the owner whether
  self-declaration is enough.
- *No event from this branch sits in any shared sidecar, so changing the log rule needs no
  migration.* Source: the owner's 09-28 measurement (no `decisions/` directory). Cheapest falsifier:
  re-run `grep -rhoE '"kind": ?"[A-Za-z._-]+"' /working/codemap-sidecar --include='*.ndjson' | sort -u`.
- *"Unreadable" in the owner's words includes a well-formed event of the wrong shape.* Source: my
  reading. Falsifier: the owner (§10 Q3).

**Gates the implementation owes.**
- Every rule's population is derived by two different kinds of instrument before the first patch,
  and the two are reconciled rather than made equal: for example, a static search of the write and
  guard sites against a run of the fold over events each op actually produces.
- Every rule names the oracle that settles it.
- Every rule ships a check observed failing at the parent. Entry 4 in §6 shows a clause with none.

**What counts as an oracle here.**
- Oracles: the owner's rulings, quoted verbatim; the real shared sidecar; CLAUDE.md's normative
  sidecar rules (a contract agreed earlier and elsewhere).
- Not oracles: this branch's tests (the same author wrote them and the code), and internal
  consistency between folds.

**One next observation.** The owner's answer to §10 Q1 and Q2. Nothing else moves the repair half.

**Who authors the plan.** A session that wrote neither this report nor the code. Brief it to
**author the missing level**: the roles in a repair and in a confirmation, which of them are stored,
and the single authority that answers for each. Give it:
- `owner.md` and the codex-recovery owner file, verbatim, questions included;
- the measured facts above, marked as measured;
- the two earlier postmortems, labelled as hearsay;
- permission to change anything.

What it writes goes back to the owner as cases to mark wrong, not as a design to ratify.

---

## 8. Process findings

- **Rate.**
  - About 32,000 lines were added in seven days (`git diff --shortstat 161d754 126c56a`).
  - The recovery's phases 2–5 landed 13 commits in about 96 minutes, including the +1,060/−3,453-line
    identity rebuild 37 minutes after the previous commit. Its tests were written with the new model and
    never seen failing (deposition).
  - Three diagnoses fell in six days, and each found a meaning the owner could have supplied.

  The rate predicts this pattern; it does not explain it. *Gate:* before a plan item is marked done,
  it names a check observed failing at its parent commit, and the executor records the command.
- **Rulings taken as picks of a recommended option whose question carries the code's vocabulary.**
  "Skip it, and report it (Recommended)" under the premise "today it throws, blocking the whole
  scope". Default B7 presupposing "fixer/relayer". "No, just fix each site (default)". *Gate:* at
  `/ez-plan`'s defaults batch, any default that uses a role or term the owner has not defined is
  split out as its own question before "approve all as written" is offered.
- **Rulings not checked against standing normative rules.** The skip design contradicts CLAUDE.md's
  damaged-shard rule, and the relayer exclusion contradicts the owner's 09-23 retirement of the
  relayer guard. *Gate:* before a ruling question is sent, the session greps the normative documents
  and earlier rulings for the terms in it, and quotes any conflict inside the question.
- **A per-site ruling on a pattern with an unenumerated population.** The owner ruled op/fold
  asymmetry "fix each site", and it recurred. *Gate:* before a second recurrence of a ruled-per-site
  pattern is fixed, the session enumerates the full population with a command and puts the count to
  the owner. That is the question the per-site ruling did not see.
- **The smallest-diff policy.** Plan item 3.5, "one predicate called by the op and the fold", was
  met by one well-designed helper (`asFolded`) at two of eight write kinds. That is the shape the
  pattern predicts. No separate gate: the population gate above covers it.

---

## 9. What this report cannot see

- **Instruments stop at the window base (`161d754`).** Anything older scores zero.
- **Ages of the §2 disagreements.**

  | entry | side | written |
  |---|---|---|
  | 1 | proposal's fixer | 09-22 |
  | 1 | relayer-guard retirement | 09-23 |
  | 1 | relayer exclusion | 09-26 and 09-28 |
  | 1 | owner's "only the code editor" | 09-28 |
  | 2 | CLAUDE.md block rule | 09-01, before the window |
  | 2 | skip ruling and `b87ea88` | 09-28 |
  | 2 | halt ruling | 09-28 |
  | 3 | "latest pick decides" | 09-23 (`af773df`) |
  | 3 | cross-principal hold | 09-24 (`3fac39c`) |
  | 3 | owner's Q3 | 09-28 |
  | 4 | worked case C02 and the code | 09-26 (`c204796`), same commit |
  | 5 | agent refute door | 08-25, before the window |
  | 5 | two-blind door | 09-26 |

  Most sides were written inside the window, so the loop left its own trace. Entries 2 and 5 each
  have one old side, so there the tree already disagreed before this week.
- **Self-fix figures,** each a floor. Deletion-based attribution cannot see a fix that only adds a
  guard, and 35 commits deleted nothing.

  | instrument | figure | percentage |
  |---|---|---|
  | A: modifying commits touching an in-window line | 62/66 | 93.9% |
  | B: the same, with most blamed lines in-window | 61/66 | 92.4% |
  | A′: A over every commit in the window | 62/101 | 61.4% |

  By day: 96.3% on 09-23, and 95.2% over the trailing three days.
- **Evidence pack status.** Prior records were found; none of its instruments reported
  `MEASURED NOTHING`, `NO PRIOR RECORDS FOUND` or `NO COMMITS IN WINDOW`.
- **ARGUED, not confirmed:**
  - that the 23 commits without a trailer are the second model's (they match the range the recovery
    input names, but by position, not by sha, because history was rewritten);
  - that the trailer cannot settle "who edited";
  - that the recommended option shaped the skip ruling. Only the owner can say.
- **Not run by me:** reader B's runs of the sort hold, the multi-site closure and the refutation by
  `true`. I checked the code lines they rest on.
- **Lenses:** all six found something. Neither reader invented a category.
- **Hypotheses I refuted while working:**
  - "The orchestrator exclusion is the fixer rule under another name." It is not: it is a separate
    check at `:151`.
  - "`f57c0a3` is missing from the record." It is not; see §6 entry 5.
- **What noticed the loop:** a review the owner asked for (five reviewers, 64 findings). The skill's
  mechanical trigger sent it to sorting, the sort routed it to diagnosis, and the owner chose to
  diagnose. The stuck session was about to apply the findings and merge.

---

## 10. Open questions

**From the sort, verbatim, with both readings.** All go to the owner.

1. **R-c** — "the principal-level hold catches the owner's own `owner-reviewed` correction when one
   person runs many agents (`src/repair-records.ts:144-146`); a `dual-sorted` correction is exempt
   (F44 narrows F17). Readings differed: A group 2 (inside its participant item), B group 3
   (assumption: a fixer's principal differs from the owner's). The arbitrator split it out and did
   not rule the group."
2. **R-d** — "a sorter's reported session is bound to nothing (`src/repair-sort-types.ts:5`) and
   compared with a connection id (`src/repair-records.ts:146`). Readings differed: A group 2, B group
   3."
3. **G8 / I14** — "anonymous item schemas (`src/mcp.ts:293,300`). Readings differed: A group 1, B
   group 4 (13 such arrays; the harm comes from `submit` holding without `resultError`,
   `src/ops/repair-verification.ts:212-224`, which a schema would not close). Carried."
4. **F62** — "withdrawing a confirm's Yes leaves the settlement it bound
   (`src/shared-decisions.ts:1296`). Readings differed: A group 1 (isolated), B group 2 (what the
   words become after is a dilemma the owner left unsettled). Carried."
5. **F4** — "an agent's questionnaire `submitted` is dropped without a diagnostic
   (`src/shared-decisions.ts:994`). Readings differed: A group 1 (the owner's "report it"), B group 4
   (the ruling covered wrong-shaped events; this one is well-shaped and unauthorized). Carried."
6. **F39** — "any GET marks the UI open (`src/serve.ts:255-258`). Readings differed: A group 1, B
   group 4 (follows the ratified "presence from the page's poll"). Carried."
7. **F43** — "`skills/codemap-audit/SKILL.md:17-18` requires two unshipped `docs/`. Readings
   differed: A group 3 (assumes it runs inside codemap), B group 2 (bundle the docs or point at them:
   a packaging choice). Carried."
8. **P1 site count** — "Readings differed: A counted 4, B counted 5 (adding the repair-application
   spend); **arbitrated (T4): the spend is its own isolated item**, so 4 sites." Command: "the shape
   cannot be grepped". (§6 entry 3 gives an enumeration the sort did not have.)
9. **P2** — "Command: `grep -n "?\.trim()" src/shared-standard.ts`, minus the `str()`-derived 672,
   971, 1061. Readings differed: A isolated (1 site), B pattern (12); **arbitrated (T9): pattern, 11
   sites (971 is safe)**; predates the range (9b2ce8f)."
10. **B12** — "Readings: A had it inside a group-2 capsule item; B group 1." Arbitrated (T8): its
    own isolated item.
11. **G3** — "A: invalid (assumed); B: suggestion; **arbitrated (T1): valid, group 4**."
12. **B15** — "B's caveat: a design question if the unread input file rules on what a correction may
    add (the session read it and found no such ruling)." Linked to this: "Gap in the blind sorter's
    inputs … its launch listed the nine runs' owner files and plans but not
    `.git/plan/2026-09-28-codex-recovery-input.md` … (it names B15, A1, A2 as possibly affected)."

**The triager's own questions.** Each is answerable now, by the owner.

**Q1. Who is refused as "the fixer", and how does codemap know?**
- You picked "only the code editor". Codemap never sees anyone edit code: its fixer is whichever
  session registers itself.
- In your own case, B (writes the evidence and asks for verification) is refused today in two ways:
  as a "relayer" if it registered, and as the requester in any case. Which is right?
- Is the requester's exclusion something you want for a different reason (B has read the fixer's
  write-up, so B is not blind), or should it go?
- Is an agent declaring "I edited this" enough, given that you guard against mistakes and not
  adversaries?
- Candidate clauses to argue with, not ratified:
  - *(a)* the fixer is the agent that edited the code, and it declares itself;
  - *(b)* whoever writes the evidence may verify;
  - *(c)* whoever requests verification may / may not verify (you choose);
  - *(d)* on 09-23 you retired the relayer-of-your-words guard, and it stays retired for repairs.
- *Recommendation:* (a) to (d), with (c) "may not" only if blindness is what you meant. *Covers up:*
  under (a) a fixer that forgets to declare itself is not excluded. That is honest about
  "mistakes, not adversaries", but it makes exclusion depend on the fixer remembering.

**Q2. What makes two agents the same?** This half was asked and not answered.
- The case: your agent registers as fixer on repair t1. Today that holds your own hand-written
  correction on an unrelated repair t2.
- Options: the same person account; the same Claude session; the same MCP connection. Also say
  whether it holds for this repair only or for every repair in the review.
- No recommendation. The answer depends on how you run agents, which only you know.

**Q3. A damaged entry in a teammate's log: which ruling stands?**
- This morning, for "parses but has the wrong shape", you picked "Skip it, and report it". This
  afternoon: "halt and report … may require a history rewrite".
- The code skips and carries on. For shapes nobody anticipated, it can drop your good answer and
  name it as the unreadable one.
- Does "halt" cover wrong-shaped but well-formed entries, or only garbled ones?
- And should codemap refuse to write anything its own fold would refuse? Today six kinds of decision
  write are appended unchecked.

**Q4. Bob confirms Alice's words: whose ruling is it on the record, and can it override Alice?**
- You said Bob's. The record names Alice, and the question asks Bob "is that what you meant, as of
  when you typed it?".
- If Alice already answered "No, not what I meant", does Bob's later Yes bind?
- Elsewhere, two people who disagree are held for a person to decide.

**Q5. Which guarantees must this branch meet before it merges?**
- You named three: fixes verified, including other sites "fixed or filed"; refutations on a real
  basis; decision-based closures logged. You also named bugs, "I think that never got implemented"
  (both readers confirm: repair verification covers findings only).
- Today, a refutation passes on any command that succeeds at the old code.
- Since August, an agent may refute an agent-filed unconfirmed finding with no verification at all.
- Which of these are this merge's bar, and which are follow-ups?
- And when a site is "filed", filed as what: a bug, or a finding?

---

## Appendix

### The deposition, verbatim

*A specimen of what the executor believed, written from memory before the evidence pack was read.
It is not findings.*

````markdown
# Deposition — the session that executed the codex recovery and then asked for this review

Written from memory at the diagnosis checkpoint (126c56a), before reading the evidence pack and before the
owner was asked anything about the artifact. Not checked against the code. Where I now doubt something I
believed, the belief stays and a doubt line follows it.

## What I was asked for, and what I decided myself

Asked: "Let's execute the plan .git/plan/2026-09-28-codex-recovery/". That plan came out of a triage of a
review of Codex's `codex/remaining-decision-work` branch, and its goal, which the owner approved as written,
was: "Bring codex/remaining-decision-work to a state you'd merge and push: remove the layers you didn't ask
for (Ed25519, Codex provenance, Codex Q&A receipts), fix the confirmed defects including those already on
local main, make questionnaires actually usable, and cut what the review found to be ceremony." The plan had
phases: 0 history rewrite, 1 critical fold fixes on main, 2 drops and verifier identity, 3 decisions/rulings
rework, 4 questionnaires, 5 trim. The owner's rulings are in owner.md and the input file it names. Later in
the same session the owner asked for: three questionnaire UI fixes, publishing the skills into codemap,
branch cleanup and a rename, fixing R6 (repair record ids) "if it has no undesirable consequences", and then
this five-reviewer pre-merge review.

Acceptance criteria I used, and where they came from:
- The owner's rulings (authored before and during planning, by the owner) — the real target.
- The plan's items — written by the ez-plan drafter from those rulings, approved as written by the owner.
- "Unit suite passes, e2e passes, no slower than 663s" — from the plan (Defaults B5). I later measured the
  suite at ~815–919s under the agent shell for both the old and new tips and called that noise.
- "The fold is total" — I operationalised that myself as "a fuzzer of malformed events produces 0 throws".
  That is my criterion, not the owner's. The owner's words were "Skip it, and report it".
- For repair verification, the owner rules I carried were: the fixer's own connection never verifies; a
  fixer-launched subagent may, at a weaker grade; two blind verifiers plus an arbitrator; claim held in memory
  per connection, no table, no permanent taint; the subagent's prompt must be the exact server brief.
  Everything about HOW a fixer is identified I decided myself, or kept from Codex's code without deciding.

Decisions I made that nobody handed me:
- The decisions fold's "leave out what it cannot read" mechanism (Phase 1.1, b87ea88): when folding throws,
  try leaving out each single event and keep the result that keeps the most records, record the left-out ids
  in a `decision_skipped` table and surface a non-blocking `malformed-event` diagnostic. I designed that. I
  also added per-arm guards for the shapes the fuzzer found (23 shapes → 0). I believed the net was a
  backstop and the guards were the real fix.
- Ops validate withdrawals and revisions by folding an `asFolded` candidate event with the real events and
  refusing what the fold refuses. I believed this satisfied plan item 3.5 ("one predicate … called by the op
  and the fold") for withdrawals AND revisions.
  - Doubt: the intent reviewer says `withdrawDecision` returns ok for a relayed withdrawal the fold then
    refuses. If that is true, either the candidate check is not on that path, or it is and the candidate
    folds differently from the real event. I do not know which.
- Repair verifier identity (Phase 2, 4acf497): `RepairConnection` per MCP process, held in memory, with
  `claim_verifier`; subagents verified from their own transcript with `readSubagentCall`. I replaced Codex's
  session/ledger machinery. I KEPT Codex's `record_repair_participant` as the way a fixer or relayer is named,
  i.e. voluntary self-declaration. I did not decide that deliberately; I rebuilt identity underneath it and
  left the participant record's shape and scoping as they were. I believed the plan's "fixer/relayer-can't-
  verify rule rebuilt on the new verifier identity model" was met because the verification fold refuses a run
  whose identity matches a recorded fixer.
  - Doubt: that is only true when a fixer is recorded, and the reviews say the request fold does not require
    one. I believed the op's requirement was enough; I did not put it in the fold.
- Sort corrections: I implemented "latest wins, competing corrections become a question to you" as a HOLD
  message ("competes with …: a question for the owner, answered by a correction of their own"). I did not
  post an actual question and did not check whether a person could post a sort at all.
  - Doubt: I now believe no person can post a sort (MCP only, actor is an agent), so the ruled settle path
    does not exist. I did not notice this while building it.
- Canonical form (753d9cd): one `canonical()` in `src/canonical.ts`, code-unit order for cross-clone keys,
  one materializer bump to 50 for Phases 2–3. The owner ruled the order change. I extracted canonical.ts to
  break an import cycle I had created by moving it into transcript.ts.
- Ruling capsule: collapsed `key`/`answerId`/`answerEvent` into `answerId` (2ad3010), as ruled.
- R6 today (126c56a): I chose content-derived ids (`rs_`/`re_`/`<finding>:c_`) computed in the op, refused a
  caller-supplied id, and made an identical re-post idempotent ("alreadyRecorded"). I chose "fold unchanged,
  so no materializer bump" as a feature of the design. I did not include the actor in the id; I found that
  during my own self-check after committing, while the reviews ran.
- Questionnaire UI: redesigned as a plain-DOM form (d86845b); then the owner's three fixes (f33d5ef):
  submitted answers kept read-only in their cards, form title changed from `<header>` to `<div>` because the
  app styles every header sticky, typing a correction auto-checks "Mark wrong". I left the separate
  "revise or withdraw" section in place, renamed.
- Skills: moved the skill edits onto a `codemap-publish` branch of /working/skills in a scratch worktree,
  applied the owner-approved publish sweep there (the Delegate Model etc.), copied into codemap `skills/`.

## What I changed to make something pass

- Phase 1.2: rewrote two existing tests that asserted a ruling is spent even when it closed nothing — the
  owner ruled the opposite ("spend only when a closure actually executes"). The tests were the detector of
  the old behaviour; I changed them to the ruled behaviour.
- Deleted the tests of the dropped layers (Ed25519, Codex Q&A receipts, measurement extractor, sorter role).
- `mcp-surface` treats backticked words in tool descriptions as tool names; I reworded descriptions to get
  past it rather than changing the test. Other tests pin description phrases ("one sound reader", "never
  approves framing"); I kept those phrases so the tests stayed green.
- f57c0a3: merged two subagent-verifier ops test files into one fixture, for suite time.
- 126c56a: changed `repair-ops.test.ts` — the old test asserted that posting the same sort twice is refused as
  a duplicate; I changed it to assert the second post is `alreadyRecorded` with the same id. That is changing
  an expected value to match my new behaviour. I also rewrote the repair tests and the repairs e2e to thread
  returned ids instead of literal ones.
- Questionnaire e2e (questionnaire-form, decisions-ui, popup): I changed selectors and flows to the redesigned
  form; in f33d5ef I removed a `Mark wrong` `.check()` call because typing now checks it, and changed the
  expected section heading text.
- A bug I hit and fixed in the `asFolded` candidate: it had no writer, so causality credited it with seeing
  nothing and withdrawals read as conflicts; I gave it `writer: "~candidate", writerPrev: GENESIS`. The tests
  that caught it were withdrawal tests; I fixed the candidate, not the tests.
- The repair fold rewrite in Phase 2 lost the application snapshot recheck; a test caught it and I restored it.

## Which tests I watched fail before the fix, and how

Observed red first:
- Phase 1.1: `src/decisions-total.test.ts` — 13 of its 16 tests failed at main in a scratch worktree before the
  fix. The fuzzer went 23 shapes → 0.
- Phase 1.3: six ruling tests failed at main before the key check.
- Phase 1.4: mutating both fold guards failed the new test; either alone did not.
- 126c56a: I mutated the caller-id refusal and the idempotency check in the source, one at a time, and the test
  failed each time.
- The skills tool-name sweep: I re-introduced `shared_sync` into a skill and the extended test failed.

Not observed red first:
- The Phase 2 verifier identity rebuild (4acf497) — I do not recall watching its tests fail on the pre-change
  code; they were written with the new model.
- The withdrawal rework (91560db) and the "already ruled" notice — I believe the tests were written alongside
  the code, not observed failing first.
- The questionnaire e2e assertions added in f33d5ef (answers persist, title not sticky, typing marks the item)
  — written after the fix, run green, never run against the old code.
- The op/fold "same predicate" claim for withdrawals — I relied on the `asFolded` design, not on a test that
  failed.

## The last point I know was good

I do not have one I can defend for the repair and decision code. My best candidates:
- `161d754` (origin/main, 2026-09-20) — the last pushed state, before any decision-rounds work.
- `b251d03` (local main after Phase 1) — I believed it good at the time: unit 2017/2017, fuzz 0 throws. But
  Phase 1's own "total fold" mechanism is now called into question, and much of the decisions fold that the
  reviewers flagged was already on main before Phase 1.
For the questionnaire UI, f33d5ef is good by the owner's trial ("Way better now!") of the version before it,
plus e2e; the owner has not re-tried f33d5ef.

## What I am unsure about, and what I was about to do next

- Unsure whether the repair participant model can be made sound by local fixes, or whether "who is the fixer"
  needs a definition first. I believe it needs a definition: the evidence writer, the code editor and the
  participant-record writer can be three different agents.
- Unsure whether the `asFolded` candidate approach is actually wired into every write whose fold has checks,
  or only some.
- Unsure whether my "fuzzer finds 0 throws" was ever a good proxy for "the fold is total and loses nothing".
- Unsure about the materializer: I believed one bump (50) covers Phases 2–3; I have not checked whether 126c56a
  or the pending fixes need another.
- About to do next, if nobody had stopped me: apply the round's findings myself — put the actor in the repair
  id, move the fixer requirement into the request fold, add `repair.verification-recorded` to the skip list,
  remove `repair_records` from the verifier allowlist, and so on down the list — then merge to main and push.

## Also

Order of events, roughly: Phase 0 rewrite → Phase 1 fold fixes on main (b87ea88, c76748a, b251d03) → rebase
the Codex branch onto main (conflicts in version numbers and the findings-closure arm, resolved by taking
Codex's 47/49 and keeping `decision_skipped`) → Phase 2 drops (68e0852, f3b2574) and identity rebuild
(4acf497) → Phase 3 ruling capsule, withdrawal rework, canonical (2ad3010, 05d66b6, 635916f, 91560db, 753d9cd)
→ Phase 4 questionnaire redesign, popup, presence (d86845b) → Phase 5 trim and docs (c1e7f7e, 2fb78db,
f95ffc2, f57c0a3) → owner trial → UI fixes (f33d5ef) → skills publish, branch cleanup → R6 fix (126c56a) →
this review.

A call I kept making that nobody handed me: "the op re-folds a candidate and refuses what the fold refuses, so
op and fold cannot disagree". I applied it to decisions writes and believed repair writes did the same. I
also kept making "the fold is unchanged, so no materializer bump" a reason to prefer an op-side design.

Terms I have used for two things:
- "fixer" — the agent that edited the code, the agent that recorded evidence, and whoever recorded a
  `fixer` participant record. I have used them interchangeably.
- "session" — a Claude session, an MCP connection (`RepairConnection.session` is a connection UUID), and a
  transcript/subagent id that a sort reports. I have used "session" for all three.
- "verified" — an answer verified from a transcript, and a repair verified by readers.
- "withdraw" — withdrawing an unanswered question vs retiring a ruling.
- "held" — a decision hold on a finding, and a sort held from eligibility.

Facts I asserted from memory rather than from something I read in this session: that 4acf497 "rebuilt the
fixer/relayer rule on the new identity model"; that plan 3.5 was met by `asFolded`; that the repair ops re-fold
candidates the same way the decisions ops do.

Surprised by: the first Astra round being ended by OpenAI's content filter; `/code-review` finding that a fixer
can verify its own repair through the fold; my own actor omission in 126c56a, one commit old.

Backed out: nothing this session in the code, apart from restoring the lost snapshot recheck and the
canonical.ts extraction after the import cycle.

Where I think the problem is now, as a guess: the recovery replaced WHO a verifier is (a connection) without
defining WHO a fixer is, and every participant-related rule was patched at its own site with its own notion
of identity. Separately, "the fold enforces what the op enforces" was treated as a per-site discipline, and
the decisions fold's recovery net was a mechanism I invented to meet "never throws" rather than "never loses
an answer".
````

### Every command that produced a number here

```sh
# window size, self-fix figures, by-day table, prior records: the evidence pack
cat .git/triage/2026-09-28-pre-merge-review/evidence/summary.md .git/triage/2026-09-28-pre-merge-review/evidence/selffix.md
git diff --shortstat 161d754 126c56a                                   # 183 files, +31897 -339
git show --stat 4acf497 | tail -1                                      # 52 files, +1060 -3453
git log --format='%ad %h %s' --date=format:'%m-%d %H:%M' 161d754..126c56a   # 12:45→14:21 = 13 commits
git log --format='%ad' --date=iso 161d754..126c56a | awk '$1=="2026-09-28" && $2>="12:00"' | wc -l   # 23
git log --format='%(trailers:key=Claude-Session,valueonly)' 161d754..126c56a | grep -c claude.ai    # 79
git grep -n -i "claude-session\|trailer" 126c56a -- src                # nothing: codemap reads no trailer
grep -n "emitEvent(logRoot" src/shared-decisions.ts | wc -l            # 6 unchecked decision writes
# mutation check (§6 entry 4), in a disposable worktree, never the tree
git worktree add --detach <scratch> 126c56a && ln -s "$PWD/node_modules" <scratch>/node_modules
#   delete the `|| d.assessments.some(a => a.identity.session === p.input.identity.session)` clause at src/repair-records.ts:146
( cd <scratch> && npx tsc && node --no-warnings --test --test-isolation=none --test-concurrency=1 dist/repair-*.test.js )   # 56 pass, 0 fail
rm <scratch>/node_modules && git worktree remove --force <scratch>
# sort distribution: counted by hand from .git/triage/2026-09-28-pre-merge-review/sort.md
```

### Checkpoint

`diagnose/20260928-213757-2026-09-28-pre-merge-review` → `126c56ac8048`. Return with
`git switch -c <name> diagnose/20260928-213757-2026-09-28-pre-merge-review`. The tree was clean
at `126c56a` before and after this diagnosis; the only file written is this one.

## 11. The owner's answers (node 18), verbatim

**Q (session, verbatim):** "How should the recovery proceed? Rule first: touch no code; you answer the questions about who the fixer is, what makes two agents the same, the damaged-log rule, whose name a confirmation carries and the merge bar; a fresh session writes the roles in a repair as cases you can mark wrong, then plans. Split the pile: fix now only what touches neither repair participants nor the decisions fold, hold the rest for rulings. Fix all and merge: apply every finding site by site, then merge and push."
**A:** picked "Rule first (Recommended)" — option text (session's): "One sitting of your time plus one planning session; forfeits merging today. Downside: about twenty ordinary slips (UI, schemas, leftovers) wait on questions most of them don't depend on."

**Q (session, verbatim):** "A teammate's log holds a decisions entry that parses as JSON but has the wrong shape (not garbled bytes). This morning you picked 'Skip it, and report it'; this afternoon you said 'halt and report ... may require a history rewrite'. Today the code skips and carries on, and for shapes nobody anticipated it can drop a good answer and blame it. Which rule stands, and should codemap also refuse to WRITE anything its own fold would refuse (six decision writes are appended unchecked today)?"
**A:** picked "Halt on any bad entry; refuse bad writes (Recommended)" — option text (session's): "Wrong-shaped or garbled, reads of that universe's decisions stop and show the entry; every write is checked against the fold first. Matches CLAUDE.md's 'loud beats quiet'. Cost: one bad entry stops the whole team's decisions until someone repairs the log."

**Q (session, verbatim):** "Alice types an ambiguous answer; codemap asks 'did you mean close it?'. You said Bob clicking Yes is Bob's confirmation, fine as long as Alice's words were shown. Two follow-ons: on the record, whose ruling is it, and if Alice had already answered 'No, not what I meant', does Bob's later Yes still bind?"
**A:** picked "Bob's; Alice's No holds it for a person (Recommended)" — option text (session's): "The ruling is recorded as Bob's, quoting Alice's words. If Alice and Bob disagree on the same confirm, it is held for a person to decide, as conflicting comparison resolutions already are. Cost: a disagreement stalls the finding until someone rules."

**Q (session, verbatim):** "You named three guarantees for this branch: fixes verified (including other sites of a multi-site problem 'fixed or filed'), refutations made on a real basis, and decision-based closures logged; plus bugs ('I think that never got implemented' - confirmed, repair verification covers findings only). Today a refutation passes on any command that succeeds at the old code, and since August an agent may refute an agent-filed unconfirmed finding with no verification. Which are this merge's bar?"
**A:** picked "Findings solid now; bugs follow-up (Recommended)" — option text (session's): "Before merge: real-basis refutations (verifier runs the pinned check), multi-site coverage checked by the verifier with 'filed' represented, and the August agent-refute door closed or routed through verification. Bugs become a planned follow-up. Cost: a bigger pre-merge round."

Not put as choices, left for the planning session as concrete cases (the report's recommendation): §10 Q1 (who is refused as the fixer, and how codemap knows) and Q2 (what makes two agents the same).
